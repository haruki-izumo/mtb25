/* =====================================================================
 * autofill/sites/freshteam-autofill.js — Freshteam
 * (<tenant>.freshteam.com/jobs/...) application forms.
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/freshteam/autofill.js. That
 * file's own field-filling MECHANICS are NOT re-implemented here —
 * they're exactly what autofill/engine/dom-interactions.js already
 * provides as window.ProactiveAutofillEngine, so this file calls into
 * that instead.
 *
 * OUT OF SCOPE (left to Big Banana's own existing systems, untouched):
 *   - Free-text answer GENERATION (BidHub's getAnswer()/ai-core) and
 *     the embedding-similarity option-match fallback — only an exact
 *     (normalized) option-text match is ported; a looser miss is left
 *     for Big Banana's own generic pipeline.
 *   - Work history / Education / "Social Network and Web Links" are
 *     BidHub's own repeatable "+ Add Employer"/"+ Add Education"/"+ Add"
 *     profile-section hierarchy (root → per-row group → leaf, with its
 *     own row-growth/max-entries/event-driven sync machinery in
 *     ../autofill-section-hierarchy.js). None of that iterator is
 *     ported — this file only looks at whichever ONE row of each
 *     section is already rendered (if any) and fills its plain fields
 *     like any other question; it never clicks "+ Add ..." and never
 *     creates/removes a row. A section with zero rows rendered yet is
 *     left alone entirely.
 *   - A visible reCAPTCHA v2 checkbox Freshteam renders in the form
 *     (auto-apply build only in BidHub) — not ported at all.
 * ===================================================================== */
(function () {
  "use strict";

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    sleep,
    fillTextInput,
    fillSelectInput,
    fillFileInput,
    clickLikeHuman,
    getCheckboxInputs,
    getRadioInputs,
    getInputLabelText,
    getNativeSelect,
    getTextarea,
    getTextInput,
    getFileInputInsideField,
  } = engine;

  const REQUIRED_MARKERS = /[*]/g;
  const APPLY_FORM_WAIT_MS = 800;
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function normalizeFreshteamText(value) {
    return String(value ?? "").replace(/ /g, " ").replace(REQUIRED_MARKERS, "").replace(/\s+/g, " ").trim();
  }
  function normalizeComparisonText(value) {
    return normalizeFreshteamText(value).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }
  function slugifyFieldId(value) {
    return normalizeComparisonText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function getFreshteamForm() {
    return document.querySelector('form[name="applicant_form"]');
  }

  function isElementVisible(element, { allowHiddenFileInput = false } = {}) {
    if (!element?.isConnected) return false;
    if (allowHiddenFileInput && element.matches?.('input[type="file"]')) return true;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Freshteam's job page and its application form are the same document,
  // but the form (and its own already-rendered controls) only become
  // visible after "Apply Now" is clicked.
  function isApplicationFormVisible() {
    const form = getFreshteamForm();
    if (!form) return false;
    if (isElementVisible(form)) return true;
    return Array.from(form.querySelectorAll('input:not([type="hidden"]):not([type="file"]), textarea, select')).some((control) =>
      isElementVisible(control)
    );
  }
  function findApplyNowButton() {
    return Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]')).find((element) => {
      if (!isElementVisible(element)) return false;
      const label = normalizeFreshteamText(element.textContent || element.value || element.getAttribute("aria-label"));
      return /^apply\s+now$/i.test(label) || /^apply$/i.test(label);
    });
  }
  // The one "step" this adapter advances: reveal the form by clicking
  // "Apply Now", same as Lever's posting→form hop. No further in-page
  // pagination beyond that.
  async function advance({ shouldAbort = () => false } = {}) {
    if (isApplicationFormVisible()) return false;
    const applyButton = findApplyNowButton();
    if (!applyButton || shouldAbort()) return false;
    await clickLikeHuman(applyButton, { shouldAbort });
    await sleep(APPLY_FORM_WAIT_MS);
    return true;
  }

  function getSubmitButton() {
    const form = getFreshteamForm();
    if (!form) return null;
    return (
      Array.from(form.querySelectorAll(['#submit-button', 'input[type="submit"][name="commit"]', 'button[type="submit"]', 'input[type="submit"]'].join(","))).find(
        (button) => {
          if (!isElementVisible(button)) return false;
          const label = normalizeFreshteamText(button.value || button.textContent || button.getAttribute("aria-label"));
          return /\b(submit|apply)\b/i.test(label);
        }
      ) || null
    );
  }
  function isSubmitButtonDisabled(button) {
    return Boolean(button?.disabled || button?.getAttribute?.("aria-disabled") === "true");
  }

  // ---- question text / option text resolution ----------------------------

  function getQuestionLabel(field) {
    return field?.querySelector(":scope > label:not(.vertical-align), :scope > .link-label, :scope > div:first-child");
  }
  function getFieldQuestionText(field, control = null) {
    const label = getQuestionLabel(field);
    const labelText = normalizeFreshteamText(label?.textContent);
    // A "+ Add ..." trigger's own text looks like a label on the first
    // querySelector match — never treat that as the question.
    if (labelText && !/^\+\s*(add\s+)?$/i.test(labelText)) return labelText;
    const linkedText = normalizeFreshteamText(getInputLabelText(control, ""));
    if (linkedText && linkedText !== normalizeFreshteamText(field?.textContent)) return linkedText;
    const placeholder = normalizeFreshteamText(control?.placeholder);
    if (placeholder) return placeholder;
    return normalizeFreshteamText(control?.getAttribute?.("data-label") || control?.name || control?.id);
  }
  function getChoiceInputText(input, fallbackQuestion = "") {
    const text = normalizeFreshteamText(getInputLabelText(input, fallbackQuestion) || input?.value);
    if (!text) return normalizeFreshteamText(fallbackQuestion);
    // Freshteam sometimes wraps a radio/checkbox's <label> around BOTH the
    // shared question text and the option text ("Are you able to relocate?
    // Yes") — strip a leading repeat of the question so the option text
    // alone is what gets compared/displayed.
    const question = normalizeFreshteamText(fallbackQuestion);
    if (question && text.startsWith(question)) {
      const withoutQuestion = normalizeFreshteamText(text.slice(question.length));
      if (withoutQuestion) return withoutQuestion;
    }
    return text;
  }
  function getChoiceOptions(inputs, fallbackQuestion = "") {
    return inputs.map((input) => getChoiceInputText(input, fallbackQuestion)).filter(Boolean);
  }
  function getSelectOptions(select) {
    return Array.from(select?.options ?? [])
      .map((option) => normalizeFreshteamText(option.textContent || option.label || option.value))
      .filter((option) => option && !/^--\s*choose\s*--$/i.test(option));
  }

  function buildFieldId(field, control, question) {
    if (control?.id) return control.id;
    if (control?.name) return control.name;
    if (field?.id) return field.id;
    return slugifyFieldId(question);
  }

  function isResumeQuestion(question, control) {
    const combined = `${question} ${control?.id ?? ""} ${control?.name ?? ""}`.toLowerCase();
    return /\bresume\b|\bcv\b/.test(combined) || control?.id === "uploadFile";
  }
  function isCoverLetterQuestion(question, control) {
    const combined = `${question} ${control?.id ?? ""} ${control?.name ?? ""}`.toLowerCase();
    return /cover\s*letter|cover_?letter/.test(combined) || control?.id === "uploadCoverLetter";
  }
  function isSkippableControl(control) {
    if (!control || control.disabled) return true;
    const type = (control.getAttribute("type") || control.type || "").toLowerCase();
    if (["hidden", "submit", "button", "reset"].includes(type)) return true;
    if (control.id === "g-recaptcha-response" || control.name === "g-recaptcha-response") return true;
    return false;
  }

  function isProfileSectionWrapper(field) {
    return Boolean(field?.querySelector?.(".employer-group, .education-group"));
  }
  function isProfileLinksWrapper(field) {
    return (
      Boolean(field?.querySelector?.('input[name="applicant[lead_attributes][profile_links][][url]"]')) &&
      /social network|web links|linkedin|profile url|links/i.test(field.textContent ?? "")
    );
  }

  function getFieldWrappers() {
    const form = getFreshteamForm();
    if (!form) return [];
    return Array.from(form.querySelectorAll([".resume-upload", ".file-field", ".form-group"].join(", "))).filter((field) => {
      if (field.classList.contains("section-group") && field.querySelector(":scope > .form-group:not(.link-group)")) return false;
      if (field.closest(".employer-group, .education-group")) return false;
      if (field.classList.contains("link-group")) return false;
      if (field.parentElement?.classList?.contains("link-group")) return false;
      return field.querySelector("input, textarea, select, button");
    });
  }
  function getFieldControls(field) {
    return Array.from(field?.querySelectorAll("input, textarea, select") ?? []).filter((control) => !isSkippableControl(control));
  }

  // ---- date-picker fields --------------------------------------------------

  function normalizeDateFormat(format) {
    const normalizedFormat = normalizeFreshteamText(format);
    if (!normalizedFormat) return "";
    if (/^MM dd, yyyy$/i.test(normalizedFormat)) return "MMMM dd, yyyy";
    if (/^mm\/dd\/yyyy$/i.test(normalizedFormat)) return "MM/DD/YYYY";
    if (/^dd\/mm\/yyyy$/i.test(normalizedFormat)) return "DD/MM/YYYY";
    return normalizedFormat;
  }
  function isDatePicker(control) {
    return Boolean(
      control?.getAttribute?.("data-provide") === "datepicker" ||
        control?.classList?.contains("datepicker_popover") ||
        control?.classList?.contains("datepicker") ||
        control?.getAttribute?.("data-date-format")
    );
  }
  function getDateFormat(control) {
    return normalizeDateFormat(control?.getAttribute?.("data-date-format")) || "MMMM dd, yyyy";
  }
  function getMonthDisplay(monthNum) {
    if (!monthNum) return null;
    const monthIndex = parseInt(monthNum, 10);
    return monthIndex >= 1 && monthIndex <= 12 ? MONTH_NAMES[monthIndex - 1] : monthNum;
  }
  function padDatePart(value) {
    return String(value ?? "").padStart(2, "0");
  }
  // Rewrites an answer (ISO "2024-03-15", "03/15/2024", or a bare year)
  // into whatever date-text format this specific date-picker input
  // declares via `data-date-format` — a plain fillTextInputReliably would
  // otherwise write a string the picker's own JS mask rejects.
  function formatDateAnswer(answer, format) {
    const rawValue = String(answer ?? "").trim();
    if (!rawValue || !format) return rawValue;
    const isoMatch = rawValue.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    const slashMatch = rawValue.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    let year, month, day;
    if (isoMatch) [, year, month, day] = isoMatch;
    else if (slashMatch) [, month, day, year] = slashMatch;
    if (year) {
      if (format === "MM dd, yyyy" || format === "MMMM dd, yyyy") return `${getMonthDisplay(padDatePart(month))} ${padDatePart(day)}, ${year}`;
      if (format === "MM/DD/YYYY") return `${padDatePart(month)}/${padDatePart(day)}/${year}`;
      if (format === "DD/MM/YYYY") return `${padDatePart(day)}/${padDatePart(month)}/${year}`;
    }
    return rawValue;
  }

  // ---- field classification -----------------------------------------------

  // Classify a (field, control) pair into the fieldKind this adapter can
  // fill: resume/cover_letter/file split off a file control; radio/
  // checkbox-single/checkbox-multi take the whole group; select-native,
  // textarea, date, and plain text fall out of the remaining single
  // control.
  function classifyField(field, question, control) {
    if (control?.type === "file") {
      const fieldKind = isCoverLetterQuestion(question, control) ? "cover_letter" : isResumeQuestion(question, control) ? "resume" : "file";
      return { fieldKind, options: [], control };
    }
    const radioInputs = getRadioInputs(field);
    if (radioInputs.length > 0) return { fieldKind: "radio", options: getChoiceOptions(radioInputs, question), control: radioInputs[0] };
    const checkboxInputs = getCheckboxInputs(field);
    if (checkboxInputs.length > 0) {
      return {
        fieldKind: checkboxInputs.length === 1 ? "checkbox-single" : "checkbox-multi",
        options: getChoiceOptions(checkboxInputs, question),
        control: checkboxInputs[0],
      };
    }
    const select = getNativeSelect(field);
    if (select) return { fieldKind: "select-native", options: getSelectOptions(select), control: select };
    const textarea = getTextarea(field);
    if (textarea) return { fieldKind: "textarea", options: [], control: textarea };
    const textInput = control?.tagName === "INPUT" ? control : getTextInput(field);
    if (textInput) return { fieldKind: isDatePicker(textInput) ? "date" : "text", options: [], control: textInput };
    return null;
  }

  // ---- first-row-only profile-section handling ----------------------------
  // See the file banner: a repeatable section's "+ Add ..." row-growth is
  // never driven here — only whichever single row is already rendered
  // (if any) is surfaced, as ordinary flat fields.

  const WORK_HISTORY_MAPPINGS = [
    { key: "title", label: "Title", nameSuffix: "[title]" },
    { key: "company", label: "Company", nameSuffix: "[company]" },
    { key: "startDate", label: "Start date", nameSuffix: "[start_date]" },
    { key: "endDate", label: "End date", nameSuffix: "[end_date]" },
    { key: "isCurrent", label: "Current", nameSuffix: "[is_current]" },
    { key: "summary", label: "Summary", nameSuffix: "[summary]" },
  ];
  const EDUCATION_MAPPINGS = [
    { key: "degree", label: "Degree", nameSuffix: "[degree]" },
    { key: "fieldOfStudy", label: "Field of study", nameSuffix: "[field_of_study]" },
    { key: "schoolName", label: "School", nameSuffix: "[school_name]" },
    { key: "startDate", label: "Start date", nameSuffix: "[start_date]" },
    { key: "endDate", label: "End date", nameSuffix: "[end_date]" },
    { key: "isCurrent", label: "Current", nameSuffix: "[is_current]" },
    { key: "grade", label: "Grade", nameSuffix: "[grade]" },
  ];

  function getRowControl(row, nameSuffix) {
    return row?.querySelector(`[name$="${nameSuffix}"]`);
  }

  function detectFirstRowFields(entries, usedFieldIds, { rootFieldId, rootLabel, rowSelector, mappings }) {
    const form = getFreshteamForm();
    const row = form?.querySelector(rowSelector);
    if (!row) return; // no row rendered yet — leave the whole section alone
    for (const mapping of mappings) {
      const control = getRowControl(row, mapping.nameSuffix);
      if (!control || isSkippableControl(control)) continue;
      const fieldId = `${rootFieldId}-${mapping.key}`;
      if (usedFieldIds.has(fieldId)) continue;
      usedFieldIds.add(fieldId);
      const fieldKind = mapping.key === "isCurrent" ? "checkbox-single" : isDatePicker(control) ? "date" : "text";
      entries.push({ question: `${rootLabel} - ${mapping.label}`, fieldId, field: control, control, fieldKind, options: [] });
    }
  }

  function getFirstProfileLinkRow() {
    const form = getFreshteamForm();
    if (!form) return null;
    return (
      Array.from(form.querySelectorAll(".link-group > .form-group, .link-group .form-group")).find((row) =>
        row.querySelector('input[name="applicant[lead_attributes][profile_links][][url]"]')
      ) ?? null
    );
  }
  function detectFirstProfileLinkFields(entries, usedFieldIds) {
    const row = getFirstProfileLinkRow();
    if (!row) return;
    for (const [key, label, nameKey] of [
      ["profileLinks-url", "Social Network and Web Links - URL", "url"],
      ["profileLinks-label", "Social Network and Web Links - Label", "name"],
    ]) {
      const control = row.querySelector(`input[name="applicant[lead_attributes][profile_links][][${nameKey}]"]`);
      if (!control || usedFieldIds.has(key)) continue;
      usedFieldIds.add(key);
      entries.push({ question: label, fieldId: key, field: control, control, fieldKind: "text", options: [] });
    }
  }

  /** Walk Freshteam's application form and return every question this
   *  adapter can fill deterministically: {question, fieldId, field,
   *  control, fieldKind, options}. */
  function detectFields() {
    const form = getFreshteamForm();
    if (!form) return [];
    const entries = [];
    const usedFieldIds = new Set();
    const seenRadioNames = new Set();

    for (const field of getFieldWrappers()) {
      if (isProfileLinksWrapper(field)) {
        if (!usedFieldIds.has("profileLinks-url")) detectFirstProfileLinkFields(entries, usedFieldIds);
        continue;
      }
      if (isProfileSectionWrapper(field) || /add employer|add education/i.test(field.textContent ?? "")) {
        if (/add employer/i.test(field.textContent ?? "") || field.querySelector(".employer-group")) {
          detectFirstRowFields(entries, usedFieldIds, {
            rootFieldId: "workHistory",
            rootLabel: "Work history",
            rowSelector: ".employer-group",
            mappings: WORK_HISTORY_MAPPINGS,
          });
        }
        if (/add education/i.test(field.textContent ?? "") || field.querySelector(".education-group")) {
          detectFirstRowFields(entries, usedFieldIds, {
            rootFieldId: "educationHistory",
            rootLabel: "Education",
            rowSelector: ".education-group",
            mappings: EDUCATION_MAPPINGS,
          });
        }
        continue;
      }

      const controls = getFieldControls(field);
      if (controls.length === 0) continue;
      const radioInputs = getRadioInputs(field);
      const checkboxInputs = getCheckboxInputs(field);
      const control = radioInputs[0] || checkboxInputs[0] || controls[0];
      if (radioInputs.length > 0 && control?.name) {
        if (seenRadioNames.has(control.name)) continue;
        seenRadioNames.add(control.name);
      }
      const question = isResumeQuestion("", control) ? "Resume/CV" : isCoverLetterQuestion("", control) ? "Cover Letter" : getFieldQuestionText(field, control);
      if (!question) continue;
      const classified = classifyField(field, question, control);
      if (!classified) continue;
      const documentFieldId = classified.fieldKind === "resume" ? "resume" : classified.fieldKind === "cover_letter" ? "cover_letter" : null;
      const fieldId = documentFieldId || buildFieldId(field, classified.control, question);
      if (usedFieldIds.has(fieldId)) continue;
      usedFieldIds.add(fieldId);
      entries.push({ question, fieldId, field, control: classified.control, fieldKind: classified.fieldKind, options: classified.options });
    }
    return entries;
  }

  // ---- filling --------------------------------------------------------------

  // Exact (normalized) option-text match only — deliberately NOT BidHub's
  // own embedding-similarity fallback. A looser miss is left for Big
  // Banana's existing generic pipeline.
  function findMatchingOption(answer, options) {
    const normalizedAnswer = normalizeComparisonText(answer);
    if (!normalizedAnswer || !Array.isArray(options) || options.length === 0) return null;
    return options.find((option) => normalizeComparisonText(option) === normalizedAnswer) ?? null;
  }
  function normalizeAnswerList(answer) {
    if (Array.isArray(answer)) return answer.map(normalizeFreshteamText).filter(Boolean);
    return String(answer ?? "").split(/[\n,;]/).map(normalizeFreshteamText).filter(Boolean);
  }
  function setChoiceChecked(input, checked) {
    if (!input || input.checked === checked) return;
    input.checked = checked;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const AFFIRMATIVE_PATTERN = /^(yes|true|1|checked|selected)$/i;

  /** Write an already-resolved answer into a question returned by
   *  detectFields(), dispatched by its fieldKind. `answer` is a string for
   *  text/textarea/date/select-native/radio; string|string[]|boolean for
   *  checkbox-single/checkbox-multi; {type:"file", fileName, base64,
   *  mimeType} for resume/cover_letter/file. */
  async function fillField(question, answer, { shouldAbort = () => false } = {}) {
    const { field, control, fieldKind } = question;
    if (answer == null || shouldAbort()) return;

    switch (fieldKind) {
      case "text": {
        const input = getTextInput(field) || (field?.tagName === "INPUT" ? field : null);
        if (input) fillTextInput(input, answer);
        return;
      }
      case "textarea": {
        const textarea = getTextarea(field);
        if (textarea) fillTextInput(textarea, answer);
        return;
      }
      case "date": {
        const input = getTextInput(field) || (field?.tagName === "INPUT" ? field : null);
        if (!input) return;
        fillTextInput(input, formatDateAnswer(answer, getDateFormat(input)));
        return;
      }
      case "select-native": {
        const select = getNativeSelect(field);
        if (!select) return;
        const options = getSelectOptions(select);
        const matchedLabel = findMatchingOption(answer, options);
        if (!matchedLabel) return;
        const option = Array.from(select.options).find((o) => normalizeComparisonText(o.textContent || o.label || o.value) === normalizeComparisonText(matchedLabel));
        if (option) fillSelectInput(select, option.value);
        return;
      }
      case "radio": {
        const inputs = getRadioInputs(field);
        const matchedLabel = findMatchingOption(answer, getChoiceOptions(inputs, question.question));
        if (!matchedLabel) return;
        const input = inputs.find((candidate) => normalizeComparisonText(getChoiceInputText(candidate)) === normalizeComparisonText(matchedLabel));
        if (input && !input.checked) await clickLikeHuman(input, { shouldAbort });
        return;
      }
      case "checkbox-single": {
        const input = getCheckboxInputs(field)[0] || (field?.matches?.('input[type="checkbox"]') ? field : null);
        if (!input) return;
        const normalizedAnswer = normalizeComparisonText(Array.isArray(answer) ? answer[0] : answer);
        const shouldCheck = typeof answer === "boolean" ? answer : AFFIRMATIVE_PATTERN.test(normalizedAnswer);
        if (input.checked !== shouldCheck) await clickLikeHuman(input, { shouldAbort });
        return;
      }
      case "checkbox-multi": {
        const inputs = getCheckboxInputs(field);
        const requested = normalizeAnswerList(answer);
        if (requested.length === 0) return;
        const options = getChoiceOptions(inputs);
        const matched = requested.map((value) => findMatchingOption(value, options)).filter(Boolean).map(normalizeComparisonText);
        for (const input of inputs) {
          const shouldCheck = matched.includes(normalizeComparisonText(getChoiceInputText(input)));
          if (input.checked !== shouldCheck) await clickLikeHuman(input, { shouldAbort });
        }
        return;
      }
      case "resume":
      case "cover_letter":
      case "file": {
        if (!answer || typeof answer !== "object" || answer.type !== "file") return;
        const input = getFileInputInsideField(field);
        if (input) fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        return;
      }
      default:
        return;
    }
  }

  function isAutofillAvailable() {
    return isApplicationFormVisible() || Boolean(findApplyNowButton());
  }

  // ---- repeatable Education/Work-history sections (section-hierarchy) ----
  // Ported from BidHub's own Freshteam section descriptors — unlike the
  // FIRST-ROW-ONLY generic handling above (detectFirstRowFields), this
  // drives window.ProactiveSectionHierarchy so every row the profile has
  // gets grown and filled. Grow-only: Freshteam section rows cannot be
  // deleted programmatically, so these descriptors omit `clearRows`
  // entirely (the shared engine skips the clear step when it's absent).
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;

  // Scans the form's .form-group/.section-group wrappers for the one that
  // either already contains a rendered row matching rowSelector, or whose
  // own text matches the section's "+ Add ..." button pattern — same
  // container-finding BidHub's own descriptor uses.
  function findFreshteamSectionContainer(rowSelector, addPattern) {
    const form = getFreshteamForm();
    if (!form) return null;
    const candidates = Array.from(form.querySelectorAll(".form-group, .section-group"));
    for (const candidate of candidates) {
      if (candidate.querySelector(rowSelector)) return candidate;
    }
    for (const candidate of candidates) {
      if (addPattern.test(normalizeFreshteamText(candidate.textContent))) return candidate;
    }
    return null;
  }
  // mapping.nameSuffix carries its own literal brackets (e.g. "[title]"),
  // matching a real attribute like
  // name="applicant[lead_attributes][experiences_attributes][0][title]".
  function getFreshteamSectionRowField(rowEl, mapping) {
    const field = rowEl?.querySelector(`[name$="${mapping.nameSuffix}"]`);
    return field ? { field } : null;
  }
  function findSectionAddButton(container, addPattern) {
    return (
      Array.from(container?.querySelectorAll("button, a") ?? []).find((el) =>
        addPattern.test(normalizeFreshteamText(el.textContent))
      ) ?? null
    );
  }
  function createClickAddRowAction(findButton) {
    return async (container) => {
      const btn = findButton(container);
      if (btn) {
        await clickLikeHuman(btn);
        await sleep(250);
      }
    };
  }

  // `grade`/`fieldOfStudy`/`summary` have no BCD Profile equivalent — those
  // leaves still detect (so they show in the review list) but have no
  // profileKey/resolveValue, so they're never auto-filled.
  const FRESHTEAM_WORK_HISTORY_SECTION = {
    rootFieldId: "workHistory",
    rootQuestion: "Work History",
    profileSection: "experience",
    rowLabel: (i) => `Work history ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    maxEntries: 5,
    getContainer: () => findFreshteamSectionContainer(".employer-group", /add employer/i),
    getRows: (container) => Array.from(container?.querySelectorAll(".employer-group") ?? []),
    getRowField: getFreshteamSectionRowField,
    // NO clearRows — Freshteam section rows cannot be deleted programmatically.
    addRow: createClickAddRowAction((container) => findSectionAddButton(container, /add employer/i)),
    mappings: [
      { key: "title", nameSuffix: "[title]", fieldKind: "text", question: "Title", profileKey: "role" },
      { key: "company", nameSuffix: "[company]", fieldKind: "text", question: "Company", profileKey: "company" },
      { key: "startDate", nameSuffix: "[start_date]", fieldKind: "text", question: "Start Date", profileKey: "start" },
      { key: "endDate", nameSuffix: "[end_date]", fieldKind: "text", question: "End Date", profileKey: "end" },
      {
        key: "isCurrent",
        nameSuffix: "[is_current]",
        fieldKind: "checkbox",
        question: "Currently work here",
        resolveValue: (entry) => !String(entry?.end || "").trim(),
      },
      { key: "summary", nameSuffix: "[summary]", fieldKind: "textarea", question: "Summary" },
    ],
  };
  const FRESHTEAM_EDUCATION_SECTION = {
    rootFieldId: "educationHistory",
    rootQuestion: "Education",
    profileSection: "education",
    rowLabel: (i) => `Education ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    maxEntries: 5,
    getContainer: () => findFreshteamSectionContainer(".education-group", /add education/i),
    getRows: (container) => Array.from(container?.querySelectorAll(".education-group") ?? []),
    getRowField: getFreshteamSectionRowField,
    addRow: createClickAddRowAction((container) => findSectionAddButton(container, /add education/i)),
    mappings: [
      { key: "degree", nameSuffix: "[degree]", fieldKind: "text", question: "Degree", profileKey: "degree" },
      { key: "fieldOfStudy", nameSuffix: "[field_of_study]", fieldKind: "text", question: "Field of Study" },
      { key: "schoolName", nameSuffix: "[school_name]", fieldKind: "text", question: "School", profileKey: "school" },
      { key: "startDate", nameSuffix: "[start_date]", fieldKind: "text", question: "Start Date", profileKey: "start" },
      { key: "endDate", nameSuffix: "[end_date]", fieldKind: "text", question: "End Date", profileKey: "end" },
      {
        key: "isCurrent",
        nameSuffix: "[is_current]",
        fieldKind: "checkbox",
        question: "Currently studying",
        resolveValue: (entry) => !String(entry?.end || "").trim(),
      },
      { key: "grade", nameSuffix: "[grade]", fieldKind: "text", question: "Grade" },
    ],
  };
  const FRESHTEAM_PROFILE_SECTIONS = [FRESHTEAM_EDUCATION_SECTION, FRESHTEAM_WORK_HISTORY_SECTION];

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections(FRESHTEAM_PROFILE_SECTIONS, profileData);
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
      default:
        return;
    }
  }

  async function fillSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    const results = [];
    for (const section of FRESHTEAM_PROFILE_SECTIONS) {
      const entries = (profileData && profileData[section.profileSection]) || [];
      if (!entries.length) continue;
      const result = await SECTION_HIERARCHY.fillSection(section, entries, fillSectionLeaf);
      results.push({ rootFieldId: section.rootFieldId, ...result });
    }
    return results;
  }

  NS.freshteam = {
    isAutofillAvailable,
    advance,
    detectFields,
    fillField,
    getSubmitButton,
    isSubmitButtonDisabled,
    detectSections,
    fillSections,
  };
})();
