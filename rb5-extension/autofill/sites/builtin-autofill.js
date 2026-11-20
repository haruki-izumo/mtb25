// autofill/sites/builtin-autofill.js — Built In "Easy Apply" application
// form (builtin.com/apply/job/<slug>/<id> — NOT the /job/ posting page).
// Ported from BidHub's own builtin-autofill.js bundle (detectAutofillFields,
// FIELD_KIND_HANDLERS, isBuiltinAutofillAvailable, advanceBuiltinAutofillFlow).
//
// This is a SEPARATE, richer system from the existing generic adapter at
// autofill/handlers/adapters/builtin.js — that one only grabs
// #first-name/#last-name/#email/#phone/#fileData-resume element references
// for Big Banana's generic 15-step pipeline (ns.pipeline.registry) and is
// left untouched here. This file registers its own structural field-by-
// field logic on window.ProactiveAutofillSites, for whatever dispatcher the
// user wires up later.
//
// The form itself is rendered with Alpine.js: every control is bound
// through x-model and reacts to the native input/change/click events the
// shared dom-interactions helpers already dispatch, so no Alpine-specific
// write path is needed anywhere below.
//
// Two control families exist on the page:
//   1. Fixed profile fields — first/last name, email, phone, location,
//      resume, cover letter, education history. Stable ids.
//   2. Dynamic questions — "Additional Information" + demographic
//      questions. Every dynamic control is named "<questionId>_Answer",
//      which is the stable seam this file keys off of (demographic
//      question ids are bare numbers, e.g. "7309", so they're read via
//      getElementById/attribute selectors, never a bare CSS `#7309`).
//
// OUT OF SCOPE (left to Big Banana's own existing systems, deliberately not
// ported — see the top-level task's explicit exclusions):
//   - Free-text screening-question ANSWER GENERATION (BidHub's own
//     getAnswer(...)/createBackendAnswerHandler calls out to its AI
//     backend). A dynamic question here is only filled when the caller's
//     profileData already supplies a concrete value for it; anything else
//     is left untouched for Big Banana's generic pipeline to pick up.
//   - BidHub's getEmbeddingMatch(...) semantic-similarity fallback (also an
//     AI-backend call) used when a typeahead's typed value has no exact/
//     prefix match. This file falls back to the FIRST rendered suggestion
//     instead for the location + education typeaheads (matching BidHub's
//     own ultimate "never leave it half-typed" behavior for those two
//     widgets specifically) and otherwise just leaves the control alone.
//   - CAPTCHA-solving / proxy-CDP automation: Built In's Easy Apply form
//     doesn't exercise either in BidHub's own source, so there was nothing
//     to carry over.
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofillEngine) return;
  const dom = window.ProactiveAutofillEngine;

  const NEVER_ABORT = () => false;
  const FORM_ID = "easyApplyForm";
  const QUESTION_ANSWER_SUFFIX = "_Answer";
  const LOCATION_INPUT_ID = "locationDropdownInput-EasyApply";

  // Posting-page apply trigger can render up to ~1-2s after load (async "good
  // fit" widget + sticky apply bar); poll for it instead of giving up on the
  // first miss.
  const APPLY_TRIGGER_WAIT_MS = 8000;
  const APPLY_TRIGGER_POLL_MS = 250;

  // Bare profile inputs at the top of the form — same stable ids the simple
  // generic adapter already keys off of.
  const CONTACT_FIELD_TO_PROFILE_KEY = {
    "first-name": "first_name",
    "last-name": "last_name",
    email: "email",
    phone: "phone",
  };

  // ---- Label / requiredness -------------------------------------------

  function escapeAttributeValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  function getLabelElementFor(fieldId) {
    if (!fieldId) return null;
    return document.querySelector(`label[for="${escapeAttributeValue(fieldId)}"]`);
  }
  function getLabelTextFor(fieldId, fallback = "") {
    return dom.getInputLabelText(document.getElementById(fieldId), fallback);
  }

  // Built In marks required questions with a red-asterisk span
  // (`.text-lava`), which getInputLabelText's plain-text read already
  // stripped out of the question text — so requiredness has to be read off
  // the label separately rather than sniffed back out of the text.
  function hasRequiredMarker(labelEl) {
    if (!labelEl) return false;
    if (labelEl.querySelector?.(".text-lava")) return true;
    return /\*/.test(labelEl.textContent || "");
  }
  function isFieldRequired(control, labelEl) {
    const controlRequired = Boolean(control?.required || control?.getAttribute?.("aria-required") === "true");
    return controlRequired || hasRequiredMarker(labelEl);
  }

  // ---- Checkbox / select option text ------------------------------------

  // Built In prefixes custom checkbox-option labels with a decorative
  // ballot glyph ("☐ Platform reliability"). Strip it so the visible option
  // text matches what profileData's answers are keyed against.
  function getChoiceOptionLabel(choiceInput) {
    const label = choiceInput.closest("label");
    const text = label?.querySelector(".form-check-label")?.textContent ?? label?.textContent ?? "";
    return text.replace(/^[\s☐☑☒■□]+/, "").replace(/\s+/g, " ").trim();
  }
  function getChoiceGroupQuestion(wrapper, fallback) {
    if (!wrapper) return fallback;
    const heading = wrapper.querySelector("h1, h2, h3, h4, legend, label");
    return dom.getQuestionText(heading) || heading?.textContent?.trim() || fallback;
  }
  function getSelectOptionTexts(select) {
    return Array.from(select?.options ?? [])
      .filter((option) => option.value !== "" && !option.disabled)
      .map((option) => (option.innerText || option.textContent || "").trim())
      .filter(Boolean);
  }

  // Matches a native <select>'s option by exact text, then prefix, then raw
  // value, and commits it through the shared React-safe setter. Returns
  // whether anything matched.
  function selectNativeOptionByText(select, answer) {
    const normalized = String(answer ?? "").trim().toLowerCase();
    if (!select || !normalized) return false;
    const options = Array.from(select.options).filter((option) => option.value !== "" && !option.disabled);
    const textOf = (option) => (option.innerText || option.textContent || "").trim().toLowerCase();
    const match =
      options.find((option) => textOf(option) === normalized) ||
      options.find((option) => textOf(option).startsWith(normalized)) ||
      options.find((option) => String(option.value).trim().toLowerCase() === normalized);
    if (!match) return false;
    dom.fillSelectInput(select, match.value);
    return true;
  }

  // ---- Bootstrap-dropdown typeaheads (location + each education row) ----
  // Built In's location search AND every education row's School/Discipline/
  // Degree search are the same widget family: a plain text input whose
  // typing re-queries an async source and renders `.dropdown-menu
  // .list-group-item-action` rows into a sibling container. They are NOT
  // the react-select-shaped widget dom.fillComboboxByTyping targets, so
  // this file drives them directly instead of forcing that helper onto a
  // shape it wasn't built for.
  //
  // fillTextInputWithoutBlur (not fillTextInput) is used deliberately: all
  // of these dropdowns close themselves the moment the input blurs, which
  // would collapse the menu before a result could even be read — the same
  // reason BidHub's own source never uses its blur-driven text filler here.
  const DROPDOWN_OPTION_SELECTOR = ".dropdown-menu .list-group-item-action";
  const TYPEAHEAD_DROPDOWN_WAIT_MS = 3000;

  async function waitForDropdownOptions(menuRoot, { shouldAbort = NEVER_ABORT, timeoutMs = TYPEAHEAD_DROPDOWN_WAIT_MS } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (shouldAbort()) return [];
      const options = Array.from(menuRoot?.querySelectorAll(DROPDOWN_OPTION_SELECTOR) ?? []).filter((el) => {
        const text = (el.textContent || "").trim();
        return text && text.toLowerCase() !== "no results found";
      });
      if (options.length) return options;
      await dom.sleep(150);
    }
    return [];
  }

  // Types `searchTerm` into a dropdown input and clicks the option that best
  // matches `matchText` (defaults to searchTerm). `retryWithFirstWord`
  // covers Degree/Discipline's canonical-vocabulary quirk: a full profile
  // value ("Computer Science") sometimes yields no results where its first
  // word does. When something DID render, BidHub's own rule is to never
  // leave the dropdown half-typed — fall back to its first (closest)
  // suggestion rather than selecting nothing.
  async function fillBootstrapTypeahead(input, { searchTerm, matchText, retryWithFirstWord = false } = {}, { shouldAbort = NEVER_ABORT } = {}) {
    const term = String(searchTerm ?? "").trim();
    if (!input || !term || shouldAbort()) return false;
    const menuRoot = input.closest(".dropdown") || input.parentElement;
    await dom.clickLikeHuman(input, { shouldAbort }); // opens the dropdown the way focusing the field would
    dom.fillTextInputWithoutBlur(input, term);
    let options = await waitForDropdownOptions(menuRoot, { shouldAbort });
    if (!options.length && retryWithFirstWord) {
      const firstWord = term.split(/[\s,]+/)[0];
      if (firstWord && firstWord.toLowerCase() !== term.toLowerCase()) {
        dom.fillTextInputWithoutBlur(input, firstWord);
        options = await waitForDropdownOptions(menuRoot, { shouldAbort });
      }
    }
    if (!options.length || shouldAbort()) return false;
    const normalized = String(matchText ?? term).replace(/\s+/g, " ").trim().toLowerCase();
    const textOf = (el) => (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    const chosen =
      options.find((el) => textOf(el) === normalized) ||
      options.find((el) => textOf(el).startsWith(normalized)) ||
      options[0];
    await dom.clickLikeHuman(chosen, { shouldAbort });
    return true;
  }

  // City typeahead matches best on the city token alone ("San Francisco"),
  // but the rendered candidates are "City, State, Country" — so the clicked
  // option is matched against the FULL profile answer, not the search term,
  // to land on the right state/country when more than one city shares a name.
  function getLocationSearchTerm(answer) {
    const normalized = String(answer ?? "").trim();
    return normalized.split(",")[0]?.trim() || normalized;
  }

  // ---- Education history (repeatable profile section) -------------------
  // Built In renders an "Education *" section that starts EMPTY with an
  // "Add" button (Alpine `addEducation()`). Each added row carries a
  // `temp_id` and exposes School/Discipline/Degree typeahead inputs
  // (`<name>SearchInput-<tempId>`) plus Start/End Month & Year native
  // selects (`education[<tempId>].<start|end>_date.<month|year>`). Control
  // ids contain "[", "]" and "." so every lookup below MUST go through
  // getElementById — never a CSS selector.
  //
  // BidHub's own port uses a generic repeatable-section-hierarchy module
  // this file doesn't have (and the task scopes this port to the two shared
  // engine files only); addRow/fill-each-row below is a direct, simplified
  // equivalent of the same behavior rather than that generic machinery.
  const EDUCATION_SCHOOL_PREFIX = "schoolSearchInput-";
  const EDUCATION_DISCIPLINE_PREFIX = "disciplineSearchInput-";
  const EDUCATION_DEGREE_PREFIX = "degreeSearchInput-";

  function getAlpineClickAttr(el) {
    return el?.getAttribute?.("@click") || el?.getAttribute?.("x-on:click") || "";
  }
  function getAddEducationButton() {
    return (
      Array.from(document.querySelectorAll(`#${FORM_ID} button`)).find((button) => getAlpineClickAttr(button).includes("addEducation")) || null
    );
  }
  function getEducationRowTempIds() {
    return Array.from(document.querySelectorAll(`#${FORM_ID} [id^="${EDUCATION_SCHOOL_PREFIX}"]`))
      .map((input) => input.id.slice(EDUCATION_SCHOOL_PREFIX.length))
      .filter(Boolean);
  }

  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  // Accepts the handful of shapes a profile date is realistically stored
  // in ("2020-09[-01]", "09/2020", "September 2020", "2020"); unrecognized
  // input degrades to {month: null, year: null} rather than throwing.
  function parseEducationDate(value) {
    const str = String(value ?? "").trim();
    if (!str) return { month: null, year: null };
    let match = str.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
    if (match) return { year: match[1], month: MONTH_NAMES[Number(match[2]) - 1] ?? null };
    match = str.match(/^(\d{1,2})\/(?:\d{1,2}\/)?(\d{4})$/);
    if (match) return { year: match[2], month: MONTH_NAMES[Number(match[1]) - 1] ?? null };
    match = str.match(/^([A-Za-z]+)\.?\s+(\d{4})$/);
    if (match) {
      const needle = match[1].toLowerCase().slice(0, 3);
      const monthName = MONTH_NAMES.find((name) => name.toLowerCase().startsWith(needle));
      return { year: match[2], month: monthName ?? null };
    }
    match = str.match(/^(\d{4})$/);
    if (match) return { year: match[1], month: null };
    return { month: null, year: null };
  }

  async function fillEducationRow(tempId, entry, { shouldAbort = NEVER_ABORT } = {}) {
    if (shouldAbort() || !entry) return false;
    let touched = false;

    const start = parseEducationDate(entry.startDate);
    const end = parseEducationDate(entry.endDate);
    const dateSelects = [
      [`education[${tempId}].start_date.month`, start.month],
      [`education[${tempId}].start_date.year`, start.year],
      [`education[${tempId}].end_date.month`, end.month],
      [`education[${tempId}].end_date.year`, end.year],
    ];
    for (const [controlId, value] of dateSelects) {
      if (!value) continue;
      if (selectNativeOptionByText(document.getElementById(controlId), value)) touched = true;
    }

    const schoolInput = document.getElementById(`${EDUCATION_SCHOOL_PREFIX}${tempId}`);
    const schoolValue = entry.universityName || entry.schoolName;
    if (schoolInput && schoolValue) {
      touched = (await fillBootstrapTypeahead(schoolInput, { searchTerm: schoolValue, matchText: schoolValue, retryWithFirstWord: true }, { shouldAbort })) || touched;
    }

    const disciplineInput = document.getElementById(`${EDUCATION_DISCIPLINE_PREFIX}${tempId}`);
    const disciplineValue = entry.major || entry.fieldOfStudy || entry.discipline;
    if (disciplineInput && disciplineValue) {
      touched = (await fillBootstrapTypeahead(disciplineInput, { searchTerm: disciplineValue, matchText: disciplineValue, retryWithFirstWord: true }, { shouldAbort })) || touched;
    }

    const degreeInput = document.getElementById(`${EDUCATION_DEGREE_PREFIX}${tempId}`);
    if (degreeInput && entry.degree) {
      touched = (await fillBootstrapTypeahead(degreeInput, { searchTerm: entry.degree, matchText: entry.degree, retryWithFirstWord: true }, { shouldAbort })) || touched;
    }

    return touched;
  }

  // Adds one row per profile entry (Alpine always appends, so the newest
  // row's temp_id is whichever one wasn't in the list a moment ago) and
  // fills each as it lands.
  async function fillEducationSection(entries, { shouldAbort = NEVER_ABORT } = {}) {
    if (!Array.isArray(entries) || entries.length === 0) return false;
    const addButton = getAddEducationButton();
    if (!addButton) return false;
    let anyFilled = false;
    for (const entry of entries) {
      if (shouldAbort()) break;
      const beforeIds = new Set(getEducationRowTempIds());
      await dom.clickLikeHuman(addButton, { shouldAbort });
      await dom.sleep(150);
      const newTempId = getEducationRowTempIds().find((id) => !beforeIds.has(id));
      if (!newTempId) continue;
      anyFilled = (await fillEducationRow(newTempId, entry, { shouldAbort })) || anyFilled;
    }
    return anyFilled;
  }

  // ---- Detection ---------------------------------------------------------

  function detectFields() {
    const form = document.getElementById(FORM_ID);
    // No form on the job posting page — autofill availability there comes
    // from the Easy Apply trigger via isAutofillAvailable/advanceToApplyForm.
    if (!form) return [];

    const fields = [];
    const seen = new Set();
    const add = (entry) => {
      if (!entry || !entry.fieldId || seen.has(entry.fieldId)) return;
      seen.add(entry.fieldId);
      fields.push(entry);
    };

    // 1. Fixed contact text fields.
    for (const [fieldId, profileKey] of Object.entries(CONTACT_FIELD_TO_PROFILE_KEY)) {
      const input = form.querySelector(`#${fieldId}`);
      if (!input) continue;
      const labelEl = getLabelElementFor(fieldId);
      add({
        fieldId,
        profileKey,
        question: getLabelTextFor(fieldId, input.getAttribute("placeholder") || fieldId),
        kind: "text",
        field: input,
        required: isFieldRequired(input, labelEl),
      });
    }

    // 2. Location typeahead.
    const locationInput = form.querySelector(`#${LOCATION_INPUT_ID}`);
    if (locationInput) {
      add({
        fieldId: "location",
        profileKey: "location",
        question: getLabelTextFor(LOCATION_INPUT_ID, "Location (City)"),
        kind: "location-typeahead",
        field: locationInput,
        required: isFieldRequired(locationInput, getLabelElementFor(LOCATION_INPUT_ID)),
      });
    }

    // 3. Resume upload.
    const resumeFileInput = form.querySelector("#fileData-resume");
    if (resumeFileInput) {
      add({
        fieldId: "resume",
        profileKey: "__resumeFile",
        question: "Resume/CV",
        kind: "resume",
        field: resumeFileInput,
        accept: resumeFileInput.getAttribute("accept") || ".pdf,.docx",
      });
    }

    // 4. Cover letter (optional free-text textarea — still a plain profile
    //    value, not an AI-generated one, so it's in scope here).
    const coverLetter = form.querySelector("#cover-letter");
    if (coverLetter) {
      add({
        fieldId: "cover_letter",
        profileKey: "cover_letter",
        question: "Cover Letter",
        kind: "cover_letter",
        field: coverLetter,
      });
    }

    // Education history is handled by the dedicated section-hierarchy port
    // below (detectSections/fillSections) instead of as a generic field
    // here — listing it both ways would show it twice in the review list
    // (a plain "Education" question row AND the real grouped section card).

    // 6. Dynamic questions, grouped by their shared "<id>_Answer" name.
    const answerControls = Array.from(
      form.querySelectorAll(`input[name$="${QUESTION_ANSWER_SUFFIX}"], select[name$="${QUESTION_ANSWER_SUFFIX}"], textarea[name$="${QUESTION_ANSWER_SUFFIX}"]`)
    );
    const groups = new Map();
    for (const control of answerControls) {
      const name = control.getAttribute("name");
      if (!name) continue;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(control);
    }
    for (const [name, controls] of groups) {
      const fieldId = name.slice(0, -QUESTION_ANSWER_SUFFIX.length);
      const primary = controls[0];

      if (primary.type === "checkbox" || primary.type === "radio") {
        const listGroup = primary.closest(".list-group");
        const wrapper = listGroup?.parentElement || primary.closest("div");
        add({
          fieldId,
          question: getChoiceGroupQuestion(wrapper, fieldId),
          kind: primary.type === "checkbox" ? "checkbox-group" : "radio-group",
          field: wrapper || listGroup,
          options: controls.map(getChoiceOptionLabel).filter(Boolean),
          required: isFieldRequired(null, wrapper),
        });
        continue;
      }

      const question = getLabelTextFor(fieldId, fieldId);
      const labelEl = getLabelElementFor(fieldId);
      if (primary.tagName === "SELECT") {
        add({
          fieldId,
          question,
          kind: "select-native",
          field: primary,
          options: getSelectOptionTexts(primary),
          required: isFieldRequired(primary, labelEl),
        });
        continue;
      }
      if (primary.tagName === "TEXTAREA") {
        add({ fieldId, question, kind: "textarea", field: primary, required: isFieldRequired(primary, labelEl) });
        continue;
      }
      add({ fieldId, question, kind: "text", field: primary, required: isFieldRequired(primary, labelEl) });
    }

    return fields;
  }

  // ---- Filling ------------------------------------------------------------

  // Resolves the value for a detected field: fixed fields read their own
  // named profileData key; dynamic questions read profileData.answers[fieldId]
  // — the stable "<id>_Answer" seam, with the "_Answer" suffix stripped.
  // Anything not present there is left alone on purpose (see file header).
  function getFieldValue(descriptor, profileData) {
    if (descriptor.profileKey) return profileData?.[descriptor.profileKey];
    return profileData?.answers?.[descriptor.fieldId];
  }

  async function fillOneField(descriptor, profileData, { shouldAbort = NEVER_ABORT } = {}) {
    if (descriptor.kind === "education-section") {
      return fillEducationSection(getFieldValue(descriptor, profileData), { shouldAbort });
    }

    const answer = getFieldValue(descriptor, profileData);

    if (descriptor.kind === "resume") {
      if (!answer || typeof answer !== "object" || !answer.fileName || !answer.base64) return false;
      const fileInput = dom.getFileInputInsideField(descriptor.field) || descriptor.field;
      dom.fillFileInput(fileInput, answer.fileName, answer.base64, answer.mimeType || "application/pdf");
      await dom.sleep(200); // Built In ingests the upload asynchronously — give Alpine a tick to react.
      return true;
    }

    if (descriptor.kind === "cover_letter") {
      const text = typeof answer === "string" ? answer : answer?.text;
      if (typeof text !== "string" || !text) return false;
      dom.fillTextInput(dom.getTextarea(descriptor.field) || descriptor.field, text);
      return true;
    }

    if (descriptor.kind === "location-typeahead") {
      const searchTerm = getLocationSearchTerm(answer);
      if (!searchTerm) return false;
      return fillBootstrapTypeahead(descriptor.field, { searchTerm, matchText: answer }, { shouldAbort });
    }

    if (descriptor.kind === "select-native") {
      return selectNativeOptionByText(dom.getNativeSelect(descriptor.field), answer);
    }

    if (descriptor.kind === "checkbox-group" || descriptor.kind === "radio-group") {
      const choices = descriptor.kind === "checkbox-group" ? dom.getCheckboxInputs(descriptor.field) : dom.getRadioInputs(descriptor.field);
      if (choices.length === 0) return false;
      const selected = (Array.isArray(answer) ? answer : answer == null ? [] : [answer]).map((value) => String(value).trim().toLowerCase()).filter(Boolean);
      if (selected.length === 0) return false;
      let touched = false;
      for (const choice of choices) {
        if (shouldAbort()) break;
        const label = getChoiceOptionLabel(choice).toLowerCase();
        const value = String(choice.value ?? "").trim().toLowerCase();
        const shouldCheck = selected.includes(label) || selected.includes(value);
        if (choice.checked !== shouldCheck) {
          await dom.clickLikeHuman(choice, { shouldAbort });
          touched = true;
        }
      }
      return touched;
    }

    if (descriptor.kind === "textarea") {
      if (answer == null || answer === "") return false;
      const textarea = dom.getTextarea(descriptor.field) || descriptor.field;
      dom.fillTextInput(textarea, answer);
      return true;
    }

    // "text" — contact fields and plain dynamic text questions alike.
    if (answer == null || answer === "") return false;
    const input = dom.getTextInput(descriptor.field) || descriptor.field;
    dom.fillTextInput(input, answer);
    return true;
  }

  // ---- Advance (posting page -> Easy Apply form) -------------------------

  function hasApplyText(el) {
    return /apply/i.test((el?.textContent || "").replace(/\s+/g, " ").trim());
  }
  // On-site "Easy Apply" link -> navigates to Built In's own application
  // form at /apply/job/<id>.
  function getEasyApplyLink() {
    return Array.from(document.querySelectorAll('a[href*="/apply/job/"]')).find(hasApplyText) || null;
  }
  // External "Apply" link in the job's sticky apply bar that navigates to
  // the employer's ATS (e.g. Lever/Greenhouse) instead of Built In's own
  // Easy Apply form.
  function getExternalApplyLink() {
    return (
      Array.from(document.querySelectorAll("a.job-post-sticky-bar-btn[href]")).find(
        (link) => hasApplyText(link) && !(link.getAttribute("href") || "").includes("/apply/job/")
      ) || null
    );
  }
  // Prefer Built In's own Easy Apply form; fall back to the external ATS
  // link (that platform's own autofill, if any, takes over from there).
  function getApplyTrigger() {
    return getEasyApplyLink() || getExternalApplyLink();
  }

  // The posting page has no form at all — advancing means navigating to the
  // Easy Apply form (single-page; there is no in-form "Next" step to drive
  // afterward). Returns true only when it actually navigated.
  async function advanceToApplyForm({ shouldAbort = NEVER_ABORT } = {}) {
    if (document.getElementById(FORM_ID)) return false;

    // The posting page renders async — an "Am I A Good Fit?" AI widget and
    // the sticky apply bar shuffle the DOM for a second or two after load,
    // so the Easy Apply anchor is often not yet present on the very first
    // pass. Poll briefly rather than giving up immediately (BidHub hit this
    // live: a premature miss here leaves the run stuck reporting "ready" on
    // the posting page forever, since the empty-step advance is one-shot).
    let trigger = getApplyTrigger();
    const deadline = Date.now() + APPLY_TRIGGER_WAIT_MS;
    while (!trigger && Date.now() < deadline) {
      if (shouldAbort()) return false;
      await dom.sleep(APPLY_TRIGGER_POLL_MS);
      if (document.getElementById(FORM_ID)) return false; // form appeared under us (same-tab reveal)
      trigger = getApplyTrigger();
    }
    if (!trigger) return false;

    // Built In renders both apply links with target="_blank" — a plain
    // click() would open the form in a NEW tab while this tab stays
    // stranded on the posting page. Navigate THIS tab instead so the rest
    // of the flow follows the form.
    const href = trigger.getAttribute("href");
    if (href) window.location.assign(trigger.href);
    else trigger.click();
    return true;
  }

  // ---- Education History (shared section-hierarchy port) ----------------
  // A SEPARATE, parallel API from the fillEducationSection()/detectFields()
  // "education-section" entry above (that one stays untouched — it's
  // Big Banana's existing simple fill path). This block instead drives
  // the SAME Education block through the shared engine/section-
  // hierarchy.js root→group→leaf model, so the section shows up in the
  // review UI row-by-row, same as Greenhouse/Ashby's own ports. Ported
  // from BidHub's own Built In section descriptor.
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;

  // Built In's control ids contain literal "[", "]", "." characters
  // (e.g. "education[3].start_date.month") — CSS-unselectable without
  // heavy escaping, so every lookup below goes through getElementById,
  // never a CSS selector.
  function getBuiltinEducationRows() {
    // Row identity = each row's own School typeahead input, in DOM order
    // (Alpine always appends, so creation order already matches both DOM
    // order and profile-entry order). The input's own id carries the raw
    // Alpine temp_id suffix other controls in the same row share.
    return Array.from(document.querySelectorAll(`#${FORM_ID} [id^="${EDUCATION_SCHOOL_PREFIX}"]`));
  }
  function getBuiltinEducationRowTempId(rowEl) {
    return rowEl?.id?.slice(EDUCATION_SCHOOL_PREFIX.length) || null;
  }
  function getBuiltinEducationRowField(rowEl, mapping) {
    const tempId = getBuiltinEducationRowTempId(rowEl);
    if (!tempId) return null;
    switch (mapping.key) {
      case "school":
        return rowEl ? { field: rowEl } : null;
      case "discipline": {
        const el = document.getElementById(`${EDUCATION_DISCIPLINE_PREFIX}${tempId}`);
        return el ? { field: el } : null;
      }
      case "degree": {
        const el = document.getElementById(`${EDUCATION_DEGREE_PREFIX}${tempId}`);
        return el ? { field: el } : null;
      }
      case "startMonth": {
        const el = document.getElementById(`education[${tempId}].start_date.month`);
        return el ? { field: el } : null;
      }
      case "startYear": {
        const el = document.getElementById(`education[${tempId}].start_date.year`);
        return el ? { field: el } : null;
      }
      case "endMonth": {
        const el = document.getElementById(`education[${tempId}].end_date.month`);
        return el ? { field: el } : null;
      }
      case "endYear": {
        const el = document.getElementById(`education[${tempId}].end_date.year`);
        return el ? { field: el } : null;
      }
      default:
        return null;
    }
  }
  // Generic "click this button, give it a beat to render" add-row action
  // — same small local shape Greenhouse's own createClickAddRowAction uses.
  function createClickAddRowAction(findButton, waitMs = 150) {
    return async () => {
      const button = findButton();
      if (button) {
        await dom.clickLikeHuman(button);
        await dom.sleep(waitMs);
      }
    };
  }
  // best-effort: the real "remove education" control/text wasn't
  // available to verify directly, so this matches either a visible
  // button/link whose own text or aria-label says "remove education" (or
  // just "remove" scoped to a row) or an Alpine @click handler named
  // the mirror of getAddEducationButton's own "addEducation" check —
  // flagged for live verification.
  async function clearBuiltinEducationRows() {
    for (let attempt = 0; attempt < 12; attempt++) {
      const buttons = Array.from(document.querySelectorAll(`#${FORM_ID} button, #${FORM_ID} a[role="button"]`)).filter((button) => {
        const label = (button.getAttribute("aria-label") || button.textContent || "").trim();
        return /\bremove\s*education\b/i.test(label) || getAlpineClickAttr(button).includes("removeEducation");
      });
      if (!buttons.length) return;
      await dom.clickLikeHuman(buttons[buttons.length - 1]);
      await dom.sleep(150);
    }
  }

  const monthNameFromRaw = (raw) => parseEducationDate(raw).month;
  const yearFromRaw = (raw) => parseEducationDate(raw).year;

  const BUILTIN_EDUCATION_SECTION = {
    rootFieldId: "educationHistory",
    rootQuestion: "Education",
    profileSection: "education",
    rowLabel: (i) => `Education ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: () => document.getElementById(FORM_ID),
    getRows: getBuiltinEducationRows,
    getRowField: getBuiltinEducationRowField,
    addRow: createClickAddRowAction(getAddEducationButton, 150),
    clearRows: clearBuiltinEducationRows,
    mappings: [
      { key: "startMonth", question: "Start Month", fieldKind: "select", resolveValue: (e) => monthNameFromRaw(e?.start) },
      { key: "startYear", question: "Start Year", fieldKind: "select", resolveValue: (e) => yearFromRaw(e?.start) },
      { key: "endMonth", question: "End Month", fieldKind: "select", resolveValue: (e) => monthNameFromRaw(e?.end) },
      { key: "endYear", question: "End Year", fieldKind: "select", resolveValue: (e) => yearFromRaw(e?.end) },
      { key: "school", question: "School", fieldKind: "typeahead", profileKey: "school" },
      // No BCD Profile.education equivalent (school/degree/start/end
      // only, no field-of-study) — detected only, shown empty in review UI.
      { key: "discipline", question: "Discipline", fieldKind: "typeahead" },
      { key: "degree", question: "Degree", fieldKind: "typeahead", profileKey: "degree" },
    ],
  };

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections([BUILTIN_EDUCATION_SECTION], profileData);
  }

  async function fillSectionLeaf(field, mapping, value) {
    switch (mapping.fieldKind) {
      case "select":
        selectNativeOptionByText(field, value);
        return;
      case "typeahead":
        await fillBootstrapTypeahead(field, { searchTerm: value, matchText: value, retryWithFirstWord: true });
        return;
      default:
        return;
    }
  }

  async function fillSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    const entries = (profileData && profileData.education) || [];
    if (!entries.length) return [];
    const result = await SECTION_HIERARCHY.fillSection(BUILTIN_EDUCATION_SECTION, entries, fillSectionLeaf);
    return [{ rootFieldId: BUILTIN_EDUCATION_SECTION.rootFieldId, ...result }];
  }

  // ---- Public surface -----------------------------------------------------

  function isAutofillAvailable() {
    return Boolean(document.getElementById(FORM_ID) || getApplyTrigger());
  }

  // Fills every structurally-resolvable field on the CURRENT step.
  // Built In's Easy Apply form is single-page once reached, so `maxSteps`
  // only bounds the posting-page -> form advance (plus a little slack);
  // it never clicks the form's own Submit/Apply control — that's left to
  // the human on purpose.
  async function fill(profileData = {}, opts = {}) {
    const shouldAbort = opts.shouldAbort || NEVER_ABORT;
    const maxSteps = opts.maxSteps || 3;
    const filled = [];
    const skipped = [];

    for (let step = 0; step < maxSteps; step += 1) {
      if (shouldAbort()) break;
      if (!document.getElementById(FORM_ID)) {
        const advanced = await advanceToApplyForm({ shouldAbort });
        // A successful advance navigates the page away — this content
        // script's run is over; whatever re-runs after the new page loads
        // picks up the actual form fields from scratch.
        return { filled, skipped, advanced };
      }
      for (const descriptor of detectFields()) {
        if (shouldAbort()) break;
        const ok = await fillOneField(descriptor, profileData, { shouldAbort });
        (ok ? filled : skipped).push(descriptor.fieldId);
      }
      break; // single-page form — nothing further to advance to.
    }
    return { filled, skipped, advanced: false };
  }

  window.ProactiveAutofillSites = window.ProactiveAutofillSites || {};
  window.ProactiveAutofillSites.builtin = { isAutofillAvailable, detectFields, fill, detectSections, fillSections };
})();
