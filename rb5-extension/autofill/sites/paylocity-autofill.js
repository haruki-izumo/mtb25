/* =====================================================================
 * autofill/sites/paylocity-autofill.js — Paylocity recruiting
 * application flow (recruiting.paylocity.com/Recruiting/Jobs/Apply/
 * <id>).
 * =====================================================================
 * Ported from BidHub's packages/job-parsers/content/platforms/
 * paylocity/autofill.js.
 *
 * Multi-step application. Step 1 holds personal info, an address
 * autocomplete, screening dropdowns, a "how did you hear about us"
 * radio group, a skills tag input (react-tagsinput), a Resume upload
 * and a Cover Letter upload. Later steps add voluntary self-id
 * questions and the final "Submit Application".
 *
 * Resume-first contract: landing on the Apply page raises a mandatory
 * "Apply with resume" modal (#forceUploadResumeModal) whose only
 * action is uploading a resume; Paylocity then PARSES it and
 * re-renders the whole form. detectFields() reports whether a resume
 * is still being asked for (isResumeUploadPresent); a caller filling
 * the resume slot should wait for waitForResumeParseComplete() before
 * reading/filling anything else, since the parse replaces the DOM
 * nodes every other field would otherwise be holding a reference to.
 *
 * Several controls are react-widgets / react-select components with
 * no native `<select>`: the rw-dropdownlist (Yes/No, salary type,
 * degree level, …; its option list only exists once opened) and the
 * pcty-input-select typeahead (address country/state, identity
 * questions). The street-address field is a full autocomplete whose
 * suggestion auto-populates city/county/state/zip/country, so the
 * whole address block is filled as ONE composite question through
 * that single control. Date fields render a react-date-range calendar
 * in a flyout — setting the input's `.value` directly does NOT commit
 * (the component's internal date model stays empty and the display
 * reverts on the next re-render), so dates are committed through the
 * calendar's own month/year <select>s and a real click on the day
 * cell.
 *
 * Ported, structural-only: the full field scan (text, native select,
 * rw-dropdown, pcty-select typeahead, the address-autocomplete
 * composite, the min/max salary-range composite, radio groups,
 * checkbox / checkbox-group, the skills tags input, calendar dates,
 * resume/cover-letter upload with parse-wait), and the posting ->
 * application -> step-advance -> submit flow.
 *
 * Explicitly NOT ported: the AI-answer backend (getAnswer(), and the
 * embedding-similarity fallback this file's own option matching only
 * approximates with exact/prefix/substring), and the repeatable Work
 * History / Education / Reference row editor beyond each row's plain
 * fields (BidHub's autofill-section-hierarchy.js "Add row" flow is a
 * generic multi-entry editor shared across several ATSes, not a
 * Paylocity-specific structural quirk — rows already on the page are
 * detected like any other field; adding more is left to Big Banana's
 * existing generic pipeline). ========================================
 * ===================================================================== */
(function () {
  "use strict";
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const { sleep, fillTextInput, writeReactTextValue, fillSelectInput, fillFileInput, clickLikeHuman } = engine;

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});

  async function waitFor(check, timeoutMs, pollMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = check();
      if (result) return result;
      await sleep(pollMs);
    }
    return null;
  }

  const RESUME_FIELD_ID = "resume";
  const COVER_LETTER_FIELD_ID = "cover_letter";
  const SALARY_RANGE_FIELD_ID = "salaryRange";
  const ADDRESS_FIELD_ID = "address";
  const ADDRESS_FIELD_PREFIX = "public-site-address-";
  const ADDRESS_LINE_1_ID = "public-site-address-address-1";
  const ADDRESS_AUTOCOMPLETE_LIST_ID = "public-site-address-address-1-autocomplete-list";
  const ADDRESS_CITY_ID = "public-site-address-city";
  const ADDRESS_ZIP_ID = "public-site-address-zip";
  const RESUME_INPUT_ID = "btn-resume";
  const FORCE_RESUME_INPUT_ID = "btn-forceResume";
  const COVER_LETTER_INPUT_ID = "btn-coverLetter";
  const RESUME_FILL_TOGGLE_ID = "useAttachedResumeToFillOutApplication"; // UI toggle, not a question
  const SALARY_MIN_INPUT_ID = "info.minimumDesiredSalary";
  const SALARY_MAX_INPUT_ID = "info.maximumDesiredSalary";
  const SALARY_INPUT_IDS = new Set([SALARY_MIN_INPUT_ID, SALARY_MAX_INPUT_ID]);
  const RESUME_PARSE_LOADER_SELECTOR = ".ie-file-upload-loader, .ie-file-upload-loading-animation";
  const RESUME_PARSE_TIMEOUT_MS = 90000;
  const RESUME_UPLOAD_KICKOFF_MS = 2000;
  const DROPDOWN_WAIT_TIMEOUT_MS = 2500;
  const RW_CLOSE_WAIT_MS = 1000;
  const HOW_DID_YOU_HEAR_NAME = "info.howDidYouHearAboutUs";

  // Address fields use aria-labels that concatenate the current value, so
  // map by id suffix instead.
  const ADDRESS_QUESTION_BY_ID = {
    "public-site-address-address-1": "Address Line 1", "public-site-address-address-2": "Address Line 2",
    "public-site-address-city": "City", "public-site-address-county": "County",
    "public-site-address-zip": "Zip Code", "public-site-address-country": "Country", "public-site-address-us-state": "State",
  };
  const ADDRESS_PCTY_SELECT_IDS = new Set(["public-site-address-country", "public-site-address-us-state"]);

  function cleanQuestion(text) { return String(text ?? "").replace(/\(required\)/gi, "").replace(/\(optional\)/gi, "").replace(/\*/g, "").replace(/\s+/g, " ").trim(); }
  function isInsideSectionBlock(element) {
    return Boolean(element.closest?.("[data-pcty-section], .work-history, .education"))
      // "education" (not "educationHistory") matches the real row-field id
      // prefix the Education section descriptor below reads/writes
      // (`education.<idKey>.<rowIndex>`, see getPaylocitySectionRowField) —
      // those rows are now owned by the dedicated section-hierarchy port,
      // so skip them here to avoid showing every field twice in the review list.
      || /^(workHistory|education|educationHistory|references|txt-workHistory|txt-educationHistory)[.-]/.test(element.id || "")
      // Per-reference / per-work-history address smarty blocks: duplicated ids
      // across rows with no row index, and no per-row/per-employer address
      // data in the profile anyway — stays unfilled, owned by the section.
      || (element.id || "").startsWith("public-site-reference-")
      || (element.id || "").startsWith("public-candidate-work-history-address-");
  }

  function getControlQuestion(control) {
    const dataFor = control.getAttribute("data-for");
    if (dataFor) return cleanQuestion(dataFor);
    if (ADDRESS_QUESTION_BY_ID[control.id]) return ADDRESS_QUESTION_BY_ID[control.id];
    const labelledBy = control.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(" ");
      if (text) return cleanQuestion(text);
    }
    const ariaLabel = control.getAttribute("aria-label");
    if (ariaLabel) return cleanQuestion(ariaLabel);
    if (control.id) {
      const linked = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
      if (linked?.textContent) return cleanQuestion(linked.textContent);
    }
    const wrapped = control.closest("label");
    if (wrapped?.textContent) return cleanQuestion(wrapped.textContent);
    // Some controls (e.g. the "Available to Start" date input, whose
    // calendar button has no label) carry their question only as a label
    // element inside the `.form-group` wrapper.
    const formGroup = control.closest(".form-group");
    if (formGroup) {
      const labelEl = formGroup.querySelector('label, legend, .control-label, .type-semibold, [class*="label"], p');
      const text = cleanQuestion(labelEl?.textContent || "");
      if (text) return text;
    }
    // pcty-input-select fields with no associated label at all — derive a
    // readable question from the field id.
    if (isPctySelectControl(control) && control.id) return humanizeFieldId(control.id);
    return "";
  }
  function isPctySelectControl(control) {
    return Boolean(control.closest?.('[id$="-select-wrapper"], .pcty-input-select-full-container'));
  }
  // react-date-range calendar text inputs, recognized structurally (a
  // `<id>-button`/`<id>-flyout` pair, or a pure date-mask placeholder) so a
  // tenant-custom date field isn't classified as plain text just because
  // its id isn't the common one.
  function isCalendarDateControl(control, fieldId) {
    if (control.tagName !== "INPUT") return false;
    if (fieldId === "info.dateAvailableToStart") return true;
    if (document.getElementById(`${fieldId}-button`) && document.getElementById(`${fieldId}-flyout`)) return true;
    const placeholder = (control.getAttribute("placeholder") || "").trim();
    return /^[MDY\s/.-]+$/.test(placeholder) && /MM|YYYY/.test(placeholder);
  }
  function humanizeFieldId(fieldId) {
    return String(fieldId || "").replace(/^(info|expandedIdentityQuestions|acknowledgements)\./, "").replace(/\.\d+$/, "").replace(/(Options?|Id)$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\w/, (c) => c.toUpperCase());
  }
  function isRequiredControl(control) {
    if (control.required || control.getAttribute("aria-required") === "true") return true;
    if (control.closest(".form-required")) return true;
    const wrapper = control.closest(".form-group, fieldset");
    if (wrapper && /\(required\)/i.test(wrapper.textContent || "")) return true;
    const labelText = control.closest("label")?.textContent
      || (control.id ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)?.textContent : "")
      || wrapper?.querySelector("label, legend, .control-label, .type-semibold")?.textContent || "";
    return /\(required\)/i.test(labelText) || /\*/.test(labelText);
  }
  function liveControl(fieldId) {
    // Paylocity field ids ARE element ids; re-resolve live since the form
    // re-renders after the resume parse.
    return document.getElementById(fieldId);
  }
  function getRadioGroup(name) { return Array.from(document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`)); }
  function getCheckboxGroup(name) { return Array.from(getFormRoot().querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`)); }
  function getRadioLabel(radio) {
    // Paylocity radios carry their option text on a `label` attribute (and
    // matching `value`); a wrapping <label> spans the whole group, so
    // prefer the per-input attribute/value.
    const labelAttr = radio.getAttribute("label");
    if (labelAttr?.trim()) return cleanQuestion(labelAttr);
    if (radio.value && radio.value !== "on") return cleanQuestion(radio.value);
    if (radio.id) {
      const linked = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
      if (linked?.textContent?.trim()) return cleanQuestion(linked.textContent);
    }
    const sibling = radio.nextElementSibling;
    if (sibling?.textContent?.trim()) return cleanQuestion(sibling.textContent);
    return "";
  }
  function getRadioGroupQuestion(name, firstRadio, optionLabels = []) {
    const container = firstRadio?.closest(".form-group, fieldset");
    if (container) {
      const direct = container.querySelector(".type-semibold, legend, .control-label");
      const directText = cleanQuestion(direct?.textContent || "");
      if (directText && !optionLabels.some((o) => o.toLowerCase() === directText.toLowerCase())) return directText;
      let text = cleanQuestion(container.textContent || "");
      for (const option of optionLabels) if (option) text = text.split(option).join(" ");
      text = cleanQuestion(text);
      if (text) return text;
    }
    if (name === HOW_DID_YOU_HEAR_NAME) return "How did you hear about us?";
    return cleanQuestion(name.replace(/^info\./, "").replace(/([A-Z])/g, " $1"));
  }

  // ---- detection -----------------------------------------------------

  // Only fields inside the application container — never the cookie banner,
  // the force-upload modal, or other page chrome.
  function getFormRoot() { return document.querySelector(".container.body-content") || document.getElementById("applicant-tracking") || document.body; }
  function isApplyFormPresent() {
    if (document.getElementById(RESUME_INPUT_ID) || document.getElementById(FORCE_RESUME_INPUT_ID)) return true;
    if (document.querySelector('input[id^="info."], [id^="public-site-address-"], [name^="multiQuestionAnswer"]')) return true;
    const root = document.getElementById("applicant-tracking") || document.getElementById("app");
    return Boolean(root && (getAdvanceControl() || getFinalSubmitButton()));
  }
  function isForceResumeModalOpen() {
    const modal = document.getElementById("forceUploadResumeModal");
    if (!modal) return false;
    if (modal.getAttribute("aria-hidden") === "true") return false;
    return modal.getBoundingClientRect().height > 0;
  }
  // Does the form still ASK for a resume? The in-form "Select Resume to
  // Upload" input is removed from the DOM once a resume is attached, while
  // the force-upload modal's (hidden) markup stays mounted at body level
  // for the rest of the session — it only counts while actually open.
  function isResumeUploadPresent() {
    if (document.getElementById(RESUME_INPUT_ID)) return true;
    return Boolean(document.getElementById(FORCE_RESUME_INPUT_ID)) && isForceResumeModalOpen();
  }
  function isUploadBlockRequired(input, labelPattern) {
    for (let node = input?.parentElement, depth = 0; node && depth < 6; node = node.parentElement, depth += 1) {
      const label = Array.from(node.querySelectorAll("label")).find((c) => labelPattern.test(c.textContent || ""));
      if (label) return /\(required\)|\*/.test(label.textContent || "");
    }
    return false;
  }
  // requireResume tenants gate the whole form behind the force-upload
  // modal — its presence IS the required signal.
  function isResumeUploadRequired() {
    if (isForceResumeModalOpen()) return true;
    const input = document.getElementById(RESUME_INPUT_ID);
    return Boolean(input) && isUploadBlockRequired(input, /resume/i);
  }
  function compareElementsByDocumentOrder(left, right) {
    if (left === right) return 0;
    if (!left?.compareDocumentPosition || !right?.compareDocumentPosition) return 0;
    const position = left.compareDocumentPosition(right);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function buildControlEntry(control, fieldId) {
    const question = getControlQuestion(control);
    if (!question) return null;
    const common = { question, fieldId, field: control, control, options: null };
    if (control.type === "checkbox") {
      const group = control.name ? getCheckboxGroup(control.name) : [control];
      // A lone checkbox is a Yes/No question.
      if (group.length <= 1) return { ...common, fieldKind: "checkbox", options: ["Yes", "No"] };
      // A real checkbox group is a multi-select over the per-box labels —
      // emit once, on the first box.
      if (control !== group[0]) return null;
      const options = group.map((box) => getRadioLabel(box)).filter(Boolean);
      const groupQuestion = getRadioGroupQuestion(control.name, control, options);
      return { ...common, question: groupQuestion, fieldId: control.name, fieldKind: "checkbox-group", options };
    }
    if (control.matches(".rw-dropdownlist")) return { ...common, fieldKind: "rw-dropdown", options: null }; // options require opening
    if (control.tagName === "SELECT") {
      const options = Array.from(control.options).filter((o) => o.value).map((o) => (o.textContent || "").trim()).filter(Boolean);
      return { ...common, fieldKind: "select-native", options };
    }
    if (fieldId === "info.skills") return { ...common, fieldKind: "tags", options: null };
    if (isCalendarDateControl(control, fieldId)) return { ...common, fieldKind: "date-text", options: null };
    // pcty-input-select react-select typeaheads — address country/state AND
    // later-step identity questions (ethnicity/pronoun/orientation). No
    // enumerable list is read up front; the option is resolved in the DOM
    // at fill time.
    if (ADDRESS_PCTY_SELECT_IDS.has(fieldId) || isPctySelectControl(control)) return { ...common, fieldKind: "pcty-select", options: null };
    return { ...common, fieldKind: "text", options: null };
  }

  function detectFields() {
    if (!isApplyFormPresent()) return [];
    const fields = [];
    const seen = new Set();
    const push = (entry) => { if (!entry?.fieldId || seen.has(entry.fieldId)) return; seen.add(entry.fieldId); fields.push(entry); };

    // Resume first: every other field is best filled only once the
    // resume's upload+parse has settled (see waitForResumeParseComplete).
    if (isResumeUploadPresent()) {
      push({ question: "Resume/CV", fieldId: RESUME_FIELD_ID, fieldKind: "file", field: document.body, control: null, options: null, isResume: true, required: isResumeUploadRequired() });
    }
    const coverLetterInput = document.getElementById(COVER_LETTER_INPUT_ID);
    if (coverLetterInput) {
      push({ question: "Cover Letter", fieldId: COVER_LETTER_FIELD_ID, fieldKind: "file", field: document.body, control: null, options: null, isCoverLetter: true, required: isUploadBlockRequired(coverLetterInput, /cover\s*letter/i) });
    }

    const scanSelector = [
      'input[id^="info."]', 'input[id^="public-site-address-"]', 'input[role="combobox"][id^="public-site-address-"]',
      "div.rw-dropdownlist", "select", "input[data-for]", "textarea",
      '[id$="-select-wrapper"] input:not([type="hidden"])', 'input[type="checkbox"]',
    ].join(", ");
    const formRoot = getFormRoot();
    for (const control of formRoot.querySelectorAll(scanSelector)) {
      if (isInsideSectionBlock(control)) continue;
      if (control.type === "hidden") continue;
      if (control.id === RESUME_FILL_TOGGLE_ID) continue; // resume-fill toggle, not a question
      const fieldId = control.id;
      if (!fieldId || seen.has(fieldId)) continue;

      // The whole address block collapses into one logical question, filled
      // through the Address Line 1 autocomplete.
      if (fieldId.startsWith(ADDRESS_FIELD_PREFIX)) {
        push({ question: "Full mailing address including street, city, state, and ZIP code", fieldId: ADDRESS_FIELD_ID, fieldKind: "address", field: control, control: null, options: null, required: isRequiredControl(control) });
        continue;
      }
      // Min/Max desired salary collapse into one logical "range" question.
      if (SALARY_INPUT_IDS.has(fieldId)) {
        push({ question: "Desired Salary Range", fieldId: SALARY_RANGE_FIELD_ID, fieldKind: "salary-range", field: control, control: null, options: null, required: isRequiredControl(control) });
        continue;
      }
      const entry = buildControlEntry(control, fieldId);
      if (entry) push(entry);
    }

    // Every radio group -> one single-select question (step-1 "How did you
    // hear about us?" and any step-2+ custom screening question alike).
    const radioGroups = new Map();
    for (const radio of formRoot.querySelectorAll('input[type="radio"]')) {
      const groupName = radio.name;
      if (!groupName || isInsideSectionBlock(radio)) continue;
      if (!radioGroups.has(groupName)) radioGroups.set(groupName, []);
      radioGroups.get(groupName).push(radio);
    }
    for (const [groupName, radios] of radioGroups) {
      if (seen.has(groupName)) continue;
      const options = radios.map((r) => getRadioLabel(r)).filter(Boolean);
      const question = getRadioGroupQuestion(groupName, radios[0], options);
      push({ question, fieldId: groupName, fieldKind: "radio", field: radios[0], control: null, options, required: radios.some((r) => isRequiredControl(r)) });
    }
    // Radio groups were collected in a separate pass — restore document
    // order (dependent "If you answered Yes above, …" questions take their
    // reference from whatever was emitted immediately before them).
    fields.sort((left, right) => compareElementsByDocumentOrder(left.field, right.field));
    return fields;
  }

  // ---- submit / advance ------------------------------------------------

  function getFinalSubmitButton() {
    return Array.from(document.querySelectorAll('button, input[type="submit"]')).find((b) => {
      const label = (b.textContent || b.value || "").trim();
      return label && /\bsubmit\b/i.test(label);
    }) || null;
  }
  function getAdvanceControl() {
    // Decide posting-vs-form by URL: the job-posting page's only forward
    // action is the link that opens the application; the application page
    // uses the Next/Continue control.
    const onApplyForm = /\/Recruiting\/Jobs\/Apply\//i.test(window.location.href);
    if (!onApplyForm) {
      const applyLink = document.querySelector('a[href*="/Apply/"]');
      if (applyLink) return applyLink;
      return Array.from(document.querySelectorAll('button, a[role="button"], a')).find((c) => {
        const label = (c.textContent || "").trim();
        return label && /\bapply\b/i.test(label) && !/\bapplied\b/i.test(label);
      }) || null;
    }
    // Multi-step form: Next / Continue / Review — never the final submit.
    return Array.from(document.querySelectorAll('button, a[role="button"]')).find((b) => {
      const label = (b.textContent || "").trim();
      if (!label || /\bsubmit\b/i.test(label)) return false;
      return /\b(next step|next|continue|review|save and continue)\b/i.test(label);
    }) || null;
  }
  function detectSubmitButton() {
    const submitButton = getFinalSubmitButton();
    if (!submitButton) return { detected: false };
    return { detected: true, label: (submitButton.textContent || submitButton.value || "").trim(), disabled: Boolean(submitButton.disabled || submitButton.getAttribute("aria-disabled") === "true") };
  }
  function isAutofillAvailable() {
    if (detectFields().length) return true;
    if (detectSubmitButton().detected) return true;
    return Boolean(getAdvanceControl());
  }
  async function advance() {
    const control = getAdvanceControl();
    if (!control) return false;
    await clickLikeHuman(control);
    return true;
  }

  // ---- resume / cover letter upload ------------------------------------

  // Both uploads accept .doc/.docx/.pdf ONLY — a text/plain cover-letter
  // fallback (or inline text-output text) must never be attached.
  function isAcceptedUploadFileAnswer(answer) {
    if (!answer || typeof answer !== "object" || answer.type !== "file") return false;
    if (/\.(pdf|docx?)$/.test(String(answer.fileName || "").toLowerCase())) return true;
    return ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(String(answer.mimeType || "").toLowerCase());
  }
  function getResumeUploadInput() {
    if (isForceResumeModalOpen()) return document.getElementById(FORCE_RESUME_INPUT_ID) || document.getElementById(RESUME_INPUT_ID);
    return document.getElementById(RESUME_INPUT_ID) || document.getElementById(FORCE_RESUME_INPUT_ID);
  }
  function isResumeParseComplete() {
    return document.querySelectorAll(RESUME_PARSE_LOADER_SELECTOR).length === 0 && !isForceResumeModalOpen() && !document.body.classList.contains("modal-open");
  }
  async function waitForResumeParseComplete() {
    await sleep(RESUME_UPLOAD_KICKOFF_MS);
    await waitFor(() => (isResumeParseComplete() ? true : null), RESUME_PARSE_TIMEOUT_MS, 200);
  }

  // ---- react-widgets dropdown (rw-dropdownlist) -------------------------

  function getRwListbox(widget) {
    const listboxId = widget.getAttribute("aria-owns") || widget.getAttribute("aria-controls");
    if (listboxId) { const byId = document.getElementById(listboxId); if (byId) return byId; }
    return widget.id ? document.getElementById(`${widget.id}__listbox`) : null;
  }
  function readRwOptions(listbox) {
    if (!listbox) return [];
    return Array.from(listbox.querySelectorAll('.rw-list-option, li[role="option"], [role="option"]')).map((o) => (o.textContent || "").trim()).filter((t) => t && t !== "--");
  }
  async function openRwDropdown(widget) {
    await clickLikeHuman(widget);
    return waitFor(() => { const live = getRwListbox(widget); return live && readRwOptions(live).length ? live : null; }, DROPDOWN_WAIT_TIMEOUT_MS, 80);
  }
  async function closeRwDropdown(widget) {
    const isOpen = () => widget.getAttribute("aria-expanded") === "true";
    if (!isOpen()) return;
    // react-widgets toggles ONLY in its click handler — mousedown/mouseup
    // alone never fires it, so the popup stays open overlaying the fields
    // below unless a real click is dispatched.
    await clickLikeHuman(widget);
    await waitFor(() => (isOpen() ? null : true), RW_CLOSE_WAIT_MS, 80);
  }
  // Paylocity's US state typeahead lists 2-letter codes, not full names, so
  // map the profile value to a code before filtering.
  const US_STATE_CODES = {
    alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
    colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
    florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
    indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
    maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
    mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
    oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
    virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
    "puerto rico": "PR",
  };
  // Match exact / prefix / reverse-prefix only — BidHub falls back to an AI
  // embedding-similarity match beyond this; out of scope here.
  async function fillRwDropdown(widget, answer) {
    const value = String(answer ?? "").trim();
    if (!widget || !value) return;
    const listbox = await openRwDropdown(widget);
    if (!listbox) throw new Error("rw-dropdown did not open");
    const optionEls = Array.from(listbox.querySelectorAll('.rw-list-option, li[role="option"], [role="option"]')).filter((o) => (o.textContent || "").trim() && (o.textContent || "").trim() !== "--");
    const normalized = value.toLowerCase();
    const optText = (o) => (o.textContent || "").trim().toLowerCase();
    const chosen = optionEls.find((o) => optText(o) === normalized)
      || optionEls.find((o) => optText(o).startsWith(normalized))
      // reverse prefix: answer "Bachelor's Degree" -> option "Bachelor"
      // (degree levels); length-guarded so tiny options don't match greedily.
      || optionEls.find((o) => optText(o).length >= 3 && normalized.startsWith(optText(o)));
    if (!chosen) { await closeRwDropdown(widget); return; }
    await clickLikeHuman(chosen);
  }

  // ---- pcty-input-select (react-select typeahead) ------------------------

  function resolvePctySearchValue(fieldId, value) {
    if (fieldId === "public-site-address-us-state") {
      const trimmed = value.trim();
      if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();
      const code = US_STATE_CODES[trimmed.toLowerCase()];
      if (code) return code;
    }
    return value;
  }
  function getPctyCurrentValue(fieldId) {
    const wrapper = document.getElementById(`${fieldId}-select-wrapper`);
    return (wrapper?.querySelector(".input-select-input-single-value")?.textContent || "").trim();
  }
  async function fillPctySelect(fieldId, answer) {
    const value = String(answer ?? "").trim();
    if (!value) return;
    const input = liveControl(fieldId);
    if (!input) return;
    const searchValue = resolvePctySearchValue(fieldId, value);
    // Already showing the desired value (e.g. Country defaults to "United States").
    const current = getPctyCurrentValue(fieldId).toLowerCase();
    if (current === value.toLowerCase() || current === searchValue.toLowerCase()) return;
    await clickLikeHuman(input);
    input.focus();
    await sleep(150);
    writeReactTextValue(input, searchValue); // tracker-dance input -> react-select filters
    const containerId = `${fieldId}-dropdown-list-container`;
    const options = await waitFor(() => {
      const container = document.getElementById(containerId);
      if (!container) return null;
      const items = Array.from(container.querySelectorAll('.pcty-input-select__menu-list [class*="ListItem"], [class*="ListItem"], [role="option"]')).filter((item) => {
        const text = (item.textContent || "").trim();
        return text && !/no results/i.test(text);
      });
      return items.length ? items : null;
    }, DROPDOWN_WAIT_TIMEOUT_MS, 100);
    if (!options) return;
    const normalized = searchValue.toLowerCase();
    const chosen = options.find((item) => (item.textContent || "").trim().toLowerCase() === normalized)
      || options.find((item) => (item.textContent || "").trim().toLowerCase().startsWith(normalized))
      || options[0]; // leave default selection; best-effort for unmatched values
    await clickLikeHuman(chosen);
  }

  // ---- address (Address Line 1 autocomplete drives the whole block) -----

  async function fillPaylocityAddress(answer) {
    const full = String(answer ?? "").trim();
    if (!full) return;
    const addressLine1 = liveControl(ADDRESS_LINE_1_ID);
    if (!addressLine1) return;
    const street = full.split(",")[0].trim();
    const zip5 = (full.match(/\b(\d{5})(?:-\d{4})?\b/) || [])[1] || null;
    if (!street) return;
    let selected = false;
    try {
      writeReactTextValue(addressLine1, street); // tracker-dance input event triggers suggestions
      const options = await waitFor(() => {
        const list = document.getElementById(ADDRESS_AUTOCOMPLETE_LIST_ID);
        const opts = list ? Array.from(list.querySelectorAll('[role="option"]')) : [];
        return opts.length ? opts : null;
      }, DROPDOWN_WAIT_TIMEOUT_MS, 100);
      if (!options) throw new Error("Address autocomplete returned no suggestions");
      const chosen = (zip5 && options.find((o) => (o.textContent || "").includes(zip5))) || options.find((o) => (o.textContent || "").toLowerCase().includes(street.toLowerCase())) || options[0];
      await clickLikeHuman(chosen);
      selected = true;
    } catch { selected = false; }
    if (selected) {
      await waitFor(() => ((liveControl(ADDRESS_CITY_ID)?.value || "").trim() ? true : null), DROPDOWN_WAIT_TIMEOUT_MS, 100);
      return;
    }
    // Fallback: no usable suggestion (e.g. PO box / unrecognized address).
    // Fill what parses cleanly.
    fillTextInput(addressLine1, street);
    if (zip5) { const zipInput = liveControl(ADDRESS_ZIP_ID); if (zipInput) fillTextInput(zipInput, zip5); }
  }

  // ---- skills tag input (react-tagsinput) --------------------------------

  function getSkillTagText(tag) {
    // The remove control (`a.react-tagsinput-remove`) is empty, so
    // textContent is the skill name.
    return (tag.textContent || "").replace(/\s*[×✕✖]\s*$/, "").trim();
  }
  function dispatchEnterKey(input) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      input.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }
  }
  async function fillSkillsTagInput(fieldId, answer) {
    const input = liveControl(fieldId);
    if (!input) return;
    const container = input.closest(".react-tagsinput") || input.parentElement;
    const desired = (Array.isArray(answer) ? answer : String(answer ?? "").split(/[,\n;]+/)).map((s) => String(s ?? "").trim()).filter(Boolean);
    const desiredLower = new Set(desired.map((s) => s.toLowerCase()));
    // Remove tags already in the DOM (e.g. populated by the resume parse)
    // that are NOT in the new list. react-tagsinput re-renders every tag on
    // each removal, detaching prior node refs — re-find the next stale tag
    // each pass instead of iterating a stale snapshot.
    const findStaleTag = () => Array.from(container?.querySelectorAll(".react-tagsinput-tag") || []).find((tag) => {
      const text = getSkillTagText(tag);
      return text && !desiredLower.has(text.toLowerCase());
    });
    for (let guard = 0; guard < 100; guard++) {
      const tag = findStaleTag();
      const removeButton = tag?.querySelector(".react-tagsinput-remove");
      if (!removeButton) break;
      removeButton.click();
      await sleep(80);
    }
    const existingLower = new Set(Array.from(container?.querySelectorAll(".react-tagsinput-tag") || []).map((t) => getSkillTagText(t).toLowerCase()).filter(Boolean));
    for (const skill of desired) {
      if (existingLower.has(skill.toLowerCase())) continue;
      writeReactTextValue(input, skill);
      dispatchEnterKey(input);
      existingLower.add(skill.toLowerCase());
      await sleep(80);
    }
  }

  // ---- date text input (react-date-range calendar flyout) ---------------

  function formatDateMMDDYYYY(rawValue) {
    const value = String(rawValue ?? "").trim();
    if (!value) return null;
    let m = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[2].padStart(2, "0")}/${m[3].padStart(2, "0")}/${m[1]}`;
    m = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (m) { const year = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}/${year}`; }
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime()) && /\d{4}/.test(value) && /[A-Za-z]/.test(value)) {
      return `${String(parsed.getMonth() + 1).padStart(2, "0")}/${String(parsed.getDate()).padStart(2, "0")}/${parsed.getFullYear()}`;
    }
    // Month/year-only profile value -> first of month.
    m = value.match(/^(\d{4})$/);
    const yearOnly = m ? m[1] : null;
    if (yearOnly) return `01/01/${yearOnly}`;
    return null;
  }
  // Set one of react-date-range's month/year <select>s and confirm it
  // stuck. The widget re-renders (replacing the <select> node) on each
  // change, and the FIRST change right after the flyout opens is often
  // dropped while it settles — re-query the live select and retry.
  async function setCalendarSelect(flyoutId, selector, value) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const select = document.getElementById(flyoutId)?.querySelector(selector);
      if (!select) return;
      if (String(select.value) === String(value)) return;
      fillSelectInput(select, String(value));
      await sleep(150);
    }
  }
  async function commitCalendarDate(buttonId, flyoutId, verifyInputId, answer) {
    const formatted = formatDateMMDDYYYY(answer);
    if (!formatted) return false;
    const [mm, dd, yyyy] = formatted.split("/");
    const monthIndex = String(parseInt(mm, 10) - 1); // react-date-range months are 0-indexed
    const dayNumber = String(parseInt(dd, 10));
    const button = document.getElementById(buttonId);
    if (!button) return false;
    await clickLikeHuman(button);
    const flyout = await waitFor(() => { const live = document.getElementById(flyoutId); return live?.querySelector(".rdrMonthPicker select") ? live : null; }, DROPDOWN_WAIT_TIMEOUT_MS, 80);
    if (!flyout) throw new Error("Date calendar flyout did not open");
    await setCalendarSelect(flyoutId, ".rdrYearPicker select", yyyy);
    await setCalendarSelect(flyoutId, ".rdrMonthPicker select", monthIndex);
    await sleep(150);
    const liveFlyout = document.getElementById(flyoutId);
    const dayButton = await waitFor(() => Array.from(liveFlyout?.querySelectorAll("button.rdrDay:not(.rdrDayPassive)") || []).find((cell) => (cell.querySelector(".rdrDayNumber")?.textContent || "").trim() === dayNumber) || null, DROPDOWN_WAIT_TIMEOUT_MS, 80);
    if (!dayButton) throw new Error("Date day cell not found");
    await clickLikeHuman(dayButton);
    await sleep(200);
    if (verifyInputId) {
      const committed = document.getElementById(verifyInputId)?.value || "";
      if (!committed) throw new Error("Date did not commit after calendar selection");
      if (!committed.includes(yyyy)) throw new Error(`Date committed wrong year: ${committed} (wanted ${yyyy})`);
    }
    return true;
  }
  async function fillPaylocityDateField(fieldId, answer) {
    const committed = await commitCalendarDate(`${fieldId}-button`, `${fieldId}-flyout`, fieldId, answer);
    if (!committed) {
      const input = liveControl(fieldId);
      const formatted = formatDateMMDDYYYY(answer);
      if (input && formatted) fillTextInput(input, formatted);
    }
  }

  // ---- salary range (grouped min/max, digits only) -----------------------

  function extractSalaryNumbers(answer) {
    const matches = String(answer ?? "").match(/\d[\d,]*/g) || [];
    return matches.map((m) => m.replace(/[^0-9]/g, "")).filter(Boolean);
  }
  function fillNumericInput(fieldId, value) {
    const input = liveControl(fieldId);
    const digits = String(value ?? "").replace(/[^0-9]/g, "");
    if (input && digits) fillTextInput(input, digits);
  }
  function fillSalaryRange(answer) {
    const numbers = extractSalaryNumbers(answer);
    if (!numbers.length) return;
    fillNumericInput(SALARY_MIN_INPUT_ID, numbers[0]);
    fillNumericInput(SALARY_MAX_INPUT_ID, numbers[1] || numbers[0]);
  }

  /** Write `answer` into a detected field entry. 'file' expects
   *  {fileName, base64, mimeType} and is only accepted for .pdf/.doc/.docx
   *  (Paylocity's upload slots take nothing else). After filling the
   *  'file' resume entry, callers should await waitForResumeParseComplete()
   *  before filling anything else — the parse replaces the form's DOM. */
  async function fillField(entry, answer) {
    if (!entry || answer == null) return false;
    const { fieldKind, fieldId, field } = entry;
    switch (fieldKind) {
      case "text": {
        const control = liveControl(fieldId);
        if (!control) return false;
        fillTextInput(control, String(answer ?? ""));
        return true;
      }
      case "select-native": {
        const select = liveControl(fieldId);
        const value = String(answer ?? "").trim().toLowerCase();
        if (!select || !value) return false;
        const options = Array.from(select.options).filter((o) => o.value);
        const match = options.find((o) => (o.textContent || "").trim().toLowerCase() === value) || options.find((o) => (o.textContent || "").trim().toLowerCase().startsWith(value));
        if (match) fillSelectInput(select, match.value);
        return Boolean(match);
      }
      case "date-text":
        await fillPaylocityDateField(fieldId, answer);
        return true;
      case "salary-range":
        fillSalaryRange(answer);
        return true;
      case "address":
        await fillPaylocityAddress(answer);
        return true;
      case "rw-dropdown": {
        const widget = liveControl(fieldId);
        if (!widget?.matches(".rw-dropdownlist")) return false;
        await fillRwDropdown(widget, answer);
        return true;
      }
      case "radio": {
        const radios = getRadioGroup(fieldId);
        const value = String(answer ?? "").trim().toLowerCase();
        if (!value) return false;
        const chosen = radios.find((r) => getRadioLabel(r).toLowerCase() === value) || radios.find((r) => getRadioLabel(r).toLowerCase().startsWith(value));
        if (chosen && !chosen.checked) await clickLikeHuman(chosen);
        return Boolean(chosen);
      }
      case "checkbox": {
        const checkbox = liveControl(fieldId);
        if (!checkbox || checkbox.type !== "checkbox") return false;
        // Yes/No question: check on an affirmative answer, uncheck on an
        // explicit negative/skip.
        const value = String(answer ?? "").trim().toLowerCase();
        const negative = answer === false || ["no", "false", "0", "unchecked", "decline"].includes(value);
        const shouldCheck = answer != null && value !== "" && !negative;
        if (checkbox.checked !== shouldCheck) await clickLikeHuman(checkbox);
        return true;
      }
      case "checkbox-group": {
        const boxes = getCheckboxGroup(fieldId);
        const selected = (Array.isArray(answer) ? answer : [answer]).map((v) => String(v ?? "").trim().toLowerCase()).filter(Boolean);
        for (const box of boxes) {
          const shouldCheck = selected.includes(getRadioLabel(box).toLowerCase());
          if (box.checked !== shouldCheck) await clickLikeHuman(box);
        }
        return true;
      }
      case "pcty-select":
        await fillPctySelect(fieldId, answer);
        return true;
      case "tags":
        await fillSkillsTagInput(fieldId, answer);
        return true;
      case "file": {
        if (!isAcceptedUploadFileAnswer(answer)) return false;
        if (entry.isResume) {
          const input = getResumeUploadInput();
          if (!input) return false;
          fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
          // Block here until upload + parse finishes — every other field is
          // best filled against the post-parse DOM.
          await waitForResumeParseComplete();
          return true;
        }
        if (entry.isCoverLetter) {
          const input = document.getElementById(COVER_LETTER_INPUT_ID);
          if (!input) return false;
          fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
          await waitFor(() => (document.querySelectorAll(RESUME_PARSE_LOADER_SELECTOR).length === 0 ? true : null), RESUME_PARSE_TIMEOUT_MS, 200);
          return true;
        }
        const input = engine.getFileInputInsideField(field);
        if (!input) return false;
        fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        return true;
      }
      default:
        return false;
    }
  }

  // ---- repeatable Education/Work-history sections (section-hierarchy) ---
  // Ported from BidHub's own Paylocity section descriptors. Explicitly NO
  // clearRows — the resume parse pre-populates rows, and leaves just
  // overwrite in place. Row ids follow a deterministic global scheme
  // (`${sectionPrefix}.${idKey}.${rowIndex}`, e.g. "workHistory.companyName.0")
  // rather than nested DOM containers, so getRows() returns one anchor
  // element per row (the row's own companyName/name field) and getRowField
  // re-derives the row index from that anchor's own id suffix instead of
  // tracking it separately — section-hierarchy.js only ever calls
  // getRowField(rowEl, mapping), never with a row index.
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;

  function getSectionRowAnchors(anchorPrefix) {
    return Array.from(document.querySelectorAll(`[id^="${anchorPrefix}"]`)).sort((a, b) => {
      const ai = parseInt((/\.(\d+)$/.exec(a.id) || [])[1] ?? "0", 10);
      const bi = parseInt((/\.(\d+)$/.exec(b.id) || [])[1] ?? "0", 10);
      return ai - bi;
    });
  }
  function getPaylocitySectionRowField(sectionPrefix, mapping, rowEl) {
    const rowIndex = (/\.(\d+)$/.exec(rowEl?.id || "") || [])[1];
    if (rowIndex == null) return null;
    const field = document.getElementById(`${sectionPrefix}.${mapping.idKey}.${rowIndex}`);
    return field ? { field } : null;
  }
  function findAddSectionButton(sectionLabel) {
    const pattern = new RegExp(`add\\s+${sectionLabel}`, "i");
    return (
      Array.from(document.querySelectorAll('button, a[role="button"]')).find((el) =>
        pattern.test((el.textContent || "").trim())
      ) ?? null
    );
  }

  // `responsibilities`/`areaOfStudy` have no BCD Profile equivalent — those
  // leaves still detect (so they show in the review list) but have no
  // profileKey/resolveValue, so they're never auto-filled.
  const PAYLOCITY_WORK_HISTORY_SECTION = {
    rootFieldId: "workHistory",
    rootQuestion: "Work History",
    profileSection: "experience",
    rowLabel: (i) => `Work history ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: () => {
      const root = document.querySelector("form") || document;
      return root.querySelector('[id^="workHistory."]') ? root : null;
    },
    getRows: () => getSectionRowAnchors("workHistory.companyName."),
    getRowField: (rowEl, mapping) => getPaylocitySectionRowField("workHistory", mapping, rowEl),
    // NO clearRows.
    addRow: async () => {
      const addButton = findAddSectionButton("Work History");
      if (addButton) await clickLikeHuman(addButton);
    },
    mappings: [
      { key: "companyName", idKey: "companyName", fieldKind: "text", question: "Company", profileKey: "company" },
      { key: "position", idKey: "position", fieldKind: "text", question: "Position", profileKey: "role" },
      { key: "responsibilities", idKey: "responsibilities", fieldKind: "textarea", question: "Responsibilities" },
      { key: "startDate", idKey: "startDate", fieldKind: "text", question: "Start Date", profileKey: "start" },
      {
        key: "currentlyWorkingHere",
        idKey: "currentlyWorkingHere",
        fieldKind: "checkbox",
        question: "Currently working here",
        resolveValue: (entry) => !String(entry?.end || "").trim(),
      },
      {
        key: "endDate",
        idKey: "endDate",
        fieldKind: "text",
        question: "End Date",
        resolveValue: (entry) => (String(entry?.end || "").trim() ? entry.end : null),
      },
    ],
  };
  const PAYLOCITY_EDUCATION_SECTION = {
    rootFieldId: "educationHistory",
    rootQuestion: "Education",
    profileSection: "education",
    rowLabel: (i) => `Education ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: () => {
      const root = document.querySelector("form") || document;
      return root.querySelector('[id^="education."]') ? root : null;
    },
    getRows: () => getSectionRowAnchors("education.name."),
    getRowField: (rowEl, mapping) => getPaylocitySectionRowField("education", mapping, rowEl),
    addRow: async () => {
      const addButton = findAddSectionButton("Education");
      if (addButton) await clickLikeHuman(addButton);
    },
    mappings: [
      { key: "name", idKey: "name", fieldKind: "text", question: "School", profileKey: "school" },
      { key: "areaOfStudy", idKey: "areaOfStudy", fieldKind: "text", question: "Area of Study" },
      { key: "degreeId", idKey: "degreeId", fieldKind: "dropdown", question: "Degree", profileKey: "degree" },
      { key: "graduationDate", idKey: "graduationDate", fieldKind: "text", question: "Graduation Date", profileKey: "end" },
    ],
  };
  const PAYLOCITY_PROFILE_SECTIONS = [PAYLOCITY_EDUCATION_SECTION, PAYLOCITY_WORK_HISTORY_SECTION];

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections(PAYLOCITY_PROFILE_SECTIONS, profileData);
  }

  async function fillSectionLeaf(field, mapping, value) {
    switch (mapping.fieldKind) {
      case "text":
      case "textarea":
        // Awaited (not the fire-and-forget fillTextInput) — a later
        // addRow() click re-renders the section, which must not fire while
        // this value's reassert window is still in flight.
        await engine.fillTextInputReliably(field, value);
        return;
      case "checkbox": {
        const input = field.tagName === "INPUT" ? field : field.querySelector('input[type="checkbox"]');
        if (input && input.checked !== Boolean(value)) await clickLikeHuman(input);
        return;
      }
      case "dropdown": {
        // Reuse the generic rw-dropdownlist helper already defined above
        // for this file's other react-widgets dropdowns (degree level, etc).
        if (field?.matches?.(".rw-dropdownlist")) {
          await fillRwDropdown(field, value);
          return;
        }
        if (field?.tagName === "SELECT") {
          const match = Array.from(field.options)
            .filter((o) => o.value)
            .find((o) => (o.textContent || "").trim().toLowerCase() === String(value).trim().toLowerCase());
          if (match) fillSelectInput(field, match.value);
        }
        return;
      }
      default:
        return;
    }
  }

  async function fillSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    const results = [];
    for (const section of PAYLOCITY_PROFILE_SECTIONS) {
      const entries = (profileData && profileData[section.profileSection]) || [];
      if (!entries.length) continue;
      const result = await SECTION_HIERARCHY.fillSection(section, entries, fillSectionLeaf);
      results.push({ rootFieldId: section.rootFieldId, ...result });
    }
    return results;
  }

  NS.paylocity = {
    isAutofillAvailable,
    detectFields,
    fillField,
    getSubmitButton: getFinalSubmitButton,
    detectSubmitButton,
    advance,
    waitForResumeParseComplete,
    detectSections,
    fillSections,
  };
})();
