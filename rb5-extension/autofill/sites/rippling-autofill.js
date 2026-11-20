/* =====================================================================
 * autofill/sites/rippling-autofill.js — Rippling ATS application flow
 * (ats.rippling.com/<company>/apply...).
 * =====================================================================
 * Ported from BidHub's packages/job-parsers/content/platforms/
 * rippling/autofill.js.
 *
 * Every question on the form is wrapped in a generic
 * `[data-testid="field"]` container with no other structural
 * convention — the actual control inside varies (plain input, phone,
 * a Google-Places-style location autocomplete, a custom combobox with
 * no native `<select>`, a `[role="radiogroup"]`, individual
 * `[role="radio"]`/`[role="checkbox"]` elements, a file input, or a
 * textarea). getVisiblePrimaryControl() resolves which ONE control a
 * wrapper actually represents, in the same fixed priority order
 * BidHub uses: file > radio-group > radio > checkbox > textarea >
 * phone > location > custom-combobox-input > custom-combobox-button >
 * plain text.
 *
 * The custom combobox has no native `<select>` — it's an
 * input/button with `aria-expanded`/`aria-controls` that opens a
 * `[role="listbox"]` of `[role="option"]` elements; reading its real
 * option list requires actually opening it (openSelectControl).
 *
 * Ported, structural-only: the field-wrapper scan + primary-control
 * resolution, label resolution (own label / preceding sibling text /
 * parent text fallback), fieldId derivation (reserved ids for
 * resume/cover_letter/phone_number, else a stable descendant
 * data-testid, else control id/name), the custom-select open/read/
 * close mechanics, the location autocomplete, resume/cover-letter
 * upload (with Rippling's own accept-list + "did it actually take the
 * file" counter verification), and the posting -> application-form ->
 * submit advance.
 *
 * Explicitly NOT ported: the AI-answer backend (getAnswer(), the
 * embedding-similarity fallback this file's own option matching only
 * approximates with an exact match), and Cloudflare Turnstile
 * (detection/solving — out of scope; this file never looks for it).
 * ===================================================================== */
(function () {
  "use strict";
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    sleep, fillTextInput, writeReactTextValue, fillFileInput, clickLikeHuman,
    getCheckboxInputs, getRadioInputs, getTextarea, getFileInputInsideField,
  } = engine;

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});

  async function waitFor(check, timeoutMs, pollMs = 50) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = check();
      if (result) return result;
      await sleep(pollMs);
    }
    return null;
  }

  const RIPPLING_FIELD_SELECTOR = '[data-testid="field"]';
  const SELECT_OPTION_WAIT_TIMEOUT_MS = 1000;
  const LOCATION_OPTION_WAIT_TIMEOUT_MS = 2500;
  const SELECT_WAIT_INTERVAL_MS = 50;
  const AUTOFILL_ADVANCE_WAIT_MS = 1500;
  // The uploader's screen-reader counter ("Total N file selected") is the
  // one signal that Rippling's React handler actually TOOK a file — a
  // dropped one (a type outside the input's own accept list) leaves the
  // native input populated but the counter at 0 and the form state empty.
  const FILE_COUNTER_SELECTOR = '[data-testid="screen-reader-only"][id^="file-input"]';
  const FILE_ACCEPTED_WAIT_MS = 2000;
  const FILE_ACCEPTED_POLL_MS = 100;
  const GENERIC_TEST_IDS = new Set(["field", "screen-reader-only", "select-controller", "select-search-input", "test_button", "Add comment", "Clear selection"]);

  function normalizeText(value) { return String(value ?? "").replace(/ /g, " ").replace(/[✱*]/g, "").replace(/\s+/g, " ").trim(); }
  function normalizeComparisonText(value) { return normalizeText(value).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase(); }
  function cleanQuestionText(value) {
    return normalizeText(value).replace(/\bAdd comment\b/gi, "").replace(/\bClear selection\b/gi, "").replace(/\bSelect\.\.\.$/i, "")
      .replace(/\bSelect$/i, "").replace(/\bSearch$/i, "").replace(/\b\d+\s*\/\s*\d+\b/g, "").replace(/\s+/g, " ").trim();
  }
  function isVisible(element) {
    if (!element?.isConnected) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) return true;
    if (element.matches('input[type="file"]')) {
      const wrapper = element.closest("label, div");
      return wrapper ? isVisible(wrapper) : false;
    }
    return false;
  }
  function isAriaRequired(control) { return Boolean(control?.required) || control?.getAttribute?.("aria-required") === "true"; }
  function getForm() { return document.querySelector("form"); }

  // ---- label resolution --------------------------------------------------

  function getQuestionLabel(field) {
    return Array.from(field?.querySelectorAll('span[id$="-label"], legend, label') ?? []).find((el) => cleanQuestionText(el.textContent));
  }
  function getChoiceInputLabelText(input, fallback = "") {
    const roleOption = input?.closest?.('[role="radio"], [role="checkbox"]');
    const fromRole = cleanQuestionText(roleOption?.textContent);
    if (fromRole) return fromRole;
    const fromLabel = cleanQuestionText(input?.labels?.[0]?.textContent);
    if (fromLabel) return fromLabel;
    const wrappedLabel = cleanQuestionText(input?.closest?.("label")?.textContent);
    if (wrappedLabel) return wrappedLabel;
    const fromValue = cleanQuestionText(input?.value);
    if (fromValue) return fromValue;
    return cleanQuestionText(fallback);
  }
  function getSiblingQuestionText(field) {
    let current = field?.previousElementSibling ?? null;
    while (current) {
      if (current.matches?.(RIPPLING_FIELD_SELECTOR)) return "";
      const text = cleanQuestionText(current.textContent);
      if (text) return text;
      current = current.previousElementSibling;
    }
    return "";
  }
  function getFieldQuestionText(field) {
    const label = getQuestionLabel(field);
    const labelText = cleanQuestionText(label?.textContent);
    if (labelText) return labelText;
    const siblingText = getSiblingQuestionText(field);
    if (siblingText) return siblingText;
    return cleanQuestionText(field?.parentElement?.textContent ?? "");
  }

  // ---- control resolution -------------------------------------------------

  function getPhoneInput(field) { return field?.querySelector('input[data-input="phone_number"], input[data-testid="input-phone_number"]') || null; }
  function getLocationInput(field) { return field?.querySelector('div[data-testid="location"] input') || null; }
  function getComboboxInput(field) { return field?.querySelector('input[role="combobox"]') || null; }
  function getComboboxButton(field) { return Array.from(field?.querySelectorAll('[role="combobox"]') ?? []).find((el) => el.tagName !== "INPUT") || null; }
  function getPlainTextInput(field) {
    return Array.from(field?.querySelectorAll("input") ?? []).find((input) =>
      input.type !== "hidden" && input.type !== "file" && input.type !== "checkbox" && input.type !== "radio"
      && input.getAttribute("role") !== "combobox" && input.getAttribute("data-input") !== "select-search-input"
      && input.getAttribute("data-testid") !== "input-select-search-input"
      && !input.closest('[data-testid="phone_number-code"]') && !input.closest('[data-testid="location"]')
    ) || null;
  }
  function getRadioGroup(field) { return field?.querySelector('[role="radiogroup"]') || null; }
  function isPhoneField(question, field) { return normalizeComparisonText(question).includes("phone") || Boolean(getPhoneInput(field)); }
  function isLocationField(question, field) { return normalizeComparisonText(question) === "location" || Boolean(field?.querySelector('[data-testid="location"]')); }

  function getVisiblePrimaryControl(field, question = "") {
    const fileInput = getFileInputInsideField(field);
    if (fileInput) return fileInput;
    const radioGroup = getRadioGroup(field);
    if (radioGroup) return radioGroup;
    const radio = getRadioInputs(field)[0];
    if (radio) return radio;
    const checkbox = getCheckboxInputs(field)[0];
    if (checkbox) return checkbox;
    const textarea = getTextarea(field);
    if (textarea) return textarea;
    if (isPhoneField(question, field)) return getPhoneInput(field);
    if (isLocationField(question, field)) return getLocationInput(field);
    const comboboxInput = getComboboxInput(field);
    if (comboboxInput) return comboboxInput;
    const comboboxButton = getComboboxButton(field);
    if (comboboxButton) return comboboxButton;
    return getPlainTextInput(field);
  }
  function hasLogicalControl(field) { return Boolean(getVisiblePrimaryControl(field, getFieldQuestionText(field))); }
  function getFieldWrappers() {
    const form = getForm();
    if (!form) return [];
    return Array.from(form.querySelectorAll(RIPPLING_FIELD_SELECTOR))
      .filter((field) => !field.parentElement?.closest?.(RIPPLING_FIELD_SELECTOR))
      .filter(hasLogicalControl);
  }

  function getStableDescendantTestId(field) {
    const candidateIds = Array.from(field?.querySelectorAll("[data-testid]") ?? [])
      .map((el) => el.getAttribute("data-testid"))
      .filter((testId) => Boolean(testId) && !GENERIC_TEST_IDS.has(testId) && !testId.startsWith("input-"));
    const preferredId = candidateIds.find((testId) =>
      testId === "resume" || testId === "cover_letter" || testId === "phone_number" || testId === "location"
      || testId === "pronouns_strategy" || testId.startsWith("customQuestions.") || testId.startsWith("eeoc."));
    return preferredId || candidateIds[0] || null;
  }
  function isResumeField(question, field, control) {
    const normalizedQuestion = normalizeComparisonText(question);
    const stableId = normalizeComparisonText(getStableDescendantTestId(field));
    const controlTestId = normalizeComparisonText(control?.getAttribute?.("data-testid"));
    return /resume|cv/.test(normalizedQuestion) || /resume|cv/.test(stableId) || /resume|cv/.test(controlTestId);
  }
  function isCoverLetterField(question, field, control) {
    const normalizedQuestion = normalizeComparisonText(question);
    const stableId = normalizeComparisonText(getStableDescendantTestId(field));
    const controlTestId = normalizeComparisonText(control?.getAttribute?.("data-testid"));
    return /cover\s*letter/.test(normalizedQuestion) || /cover_?letter/.test(stableId) || /cover_?letter/.test(controlTestId);
  }
  function deriveFieldId(field, question, control) {
    // 'resume' / 'cover_letter' / 'phone_number' are reserved ids, gated on
    // the field genuinely HAVING that control — isResumeField/
    // isCoverLetterField also match on question TEXT, so a screening
    // question that merely mentions one of these words would otherwise
    // collide with the real field under the same reserved id.
    const hasFileControl = control?.type === "file" || Boolean(getFileInputInsideField(field));
    if (hasFileControl && isResumeField(question, field, control)) return "resume";
    if (hasFileControl && isCoverLetterField(question, field, control)) return "cover_letter";
    if (getPhoneInput(field)) return "phone_number";
    const stableTestId = getStableDescendantTestId(field);
    if (stableTestId) return stableTestId;
    if (control?.id) return control.id;
    const roleGroupId = getRadioGroup(field)?.id;
    if (roleGroupId) return roleGroupId;
    const radioName = getRadioInputs(field)[0]?.name;
    if (radioName) return radioName;
    const checkboxName = getCheckboxInputs(field)[0]?.name;
    if (checkboxName) return checkboxName;
    return null;
  }

  // ---- option reading (radio/checkbox groups, custom select) ------------

  function getRoleOptions(field, roleName) {
    return Array.from(field?.querySelectorAll(`[role="${roleName}"]`) ?? [])
      .filter((el) => { const input = el.querySelector("input"); return isVisible(el) || Boolean(input); })
      .map((el) => {
        const input = el.querySelector("input");
        const text = cleanQuestionText(el.textContent) || cleanQuestionText(el.getAttribute("data-value")) || cleanQuestionText(input?.value);
        return { element: el, input, text };
      }).filter((o) => o.text);
  }
  function getRipplingRadioOptions(field, question = "") {
    const roleOptions = getRoleOptions(field, "radio");
    if (roleOptions.length) return roleOptions;
    return getRadioInputs(field).map((input) => ({ input, element: input.labels?.[0] || input.closest("label") || input, text: getChoiceInputLabelText(input, question) })).filter((o) => o.text);
  }
  function getRipplingCheckboxOptions(field, question = "") {
    const roleOptions = getRoleOptions(field, "checkbox");
    if (roleOptions.length) return roleOptions;
    return getCheckboxInputs(field).map((input) => ({ input, element: input.labels?.[0] || input.closest("label") || input, text: getChoiceInputLabelText(input, question) })).filter((o) => o.text);
  }

  function classifyField(question, field) {
    const control = getVisiblePrimaryControl(field, question);
    if (!control) return null;
    if (control.type === "file") {
      if (isResumeField(question, field, control)) return { fieldKind: "file", isResume: true };
      if (isCoverLetterField(question, field, control)) return { fieldKind: "file", isCoverLetter: true };
      return { fieldKind: "file" };
    }
    const radioOptions = getRipplingRadioOptions(field, question);
    if (radioOptions.length) return { fieldKind: "radio", options: radioOptions.map((o) => o.text) };
    const checkboxOptions = getRipplingCheckboxOptions(field, question);
    if (checkboxOptions.length) return { fieldKind: "checkbox", options: checkboxOptions.map((o) => o.text) };
    if (getTextarea(field)) return { fieldKind: "textarea" };
    if (isPhoneField(question, field)) return { fieldKind: "phone" };
    if (isLocationField(question, field)) return { fieldKind: "location-autocomplete" };
    if (getComboboxInput(field) || getComboboxButton(field)) return { fieldKind: "select-custom" };
    if (getPlainTextInput(field)) return { fieldKind: "text" };
    return null;
  }

  function detectFields() {
    const fields = getFieldWrappers().map((field) => {
      const question = getFieldQuestionText(field);
      const control = getVisiblePrimaryControl(field, question);
      const fieldId = deriveFieldId(field, question, control);
      if (!question || !fieldId || !control) return null;
      const meta = classifyField(question, field);
      if (!meta) return null;
      return { question, fieldId, fieldKind: meta.fieldKind, field, control, options: meta.options ?? null, isResume: meta.isResume, isCoverLetter: meta.isCoverLetter };
    }).filter(Boolean);
    return fields;
  }
  function getLiveFieldById(fieldId, fallbackField) {
    const matching = getFieldWrappers().find((field) => {
      const question = getFieldQuestionText(field);
      const control = getVisiblePrimaryControl(field, question);
      return deriveFieldId(field, question, control) === fieldId;
    });
    return matching || fallbackField;
  }

  // ---- custom select (combobox + listbox) --------------------------------

  function getSelectControl(field) { return getComboboxInput(field) || getComboboxButton(field); }
  function isSelectOpen(control) { return control?.getAttribute?.("aria-expanded") === "true"; }
  function getSelectListbox(control) {
    if (!control) return Array.from(document.querySelectorAll('[role="listbox"]')).find(isVisible) || null;
    const controlledListId = control.getAttribute?.("aria-controls");
    if (controlledListId) {
      const controlled = document.getElementById(controlledListId);
      if (controlled?.getAttribute?.("role") === "listbox" && isVisible(controlled)) return controlled;
    }
    if (control.id) {
      const derived = document.getElementById(`${control.id}-list`);
      if (derived?.getAttribute?.("role") === "listbox" && isVisible(derived)) return derived;
      const labelled = Array.from(document.querySelectorAll('[role="listbox"]')).find((el) => el.getAttribute("aria-labelledby") === `${control.id}-label` && isVisible(el));
      if (labelled) return labelled;
    }
    return Array.from(document.querySelectorAll('[role="listbox"]')).find(isVisible) || null;
  }
  function getVisibleListboxOptions(control) {
    const listbox = getSelectListbox(control);
    if (!listbox) return [];
    const seen = new Set();
    return Array.from(listbox.querySelectorAll('[role="option"]'))
      .filter((o) => isVisible(o) || o.getAttribute("aria-selected") === "true")
      .map((o) => ({ element: o, text: cleanQuestionText(o.textContent) }))
      .filter((o) => { if (!o.text || seen.has(o.text)) return false; seen.add(o.text); return true; });
  }
  function getOpenSelectOptions(control) {
    if (!isSelectOpen(control)) return null;
    const options = getVisibleListboxOptions(control);
    return options.length ? options : null;
  }
  function dispatchKey(element, key) {
    if (!element) return;
    element.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, which: key === "ArrowDown" ? 40 : 27, keyCode: key === "ArrowDown" ? 40 : 27, bubbles: true }));
  }
  async function openSelectControl(control) {
    if (!control) return [];
    const existing = getOpenSelectOptions(control);
    if (existing) return existing;
    control.focus?.();
    const attempts = [
      () => control.click?.(),
      () => { control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); control.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); },
      () => dispatchKey(control, "ArrowDown"),
    ];
    for (const attempt of attempts) {
      attempt();
      const options = await waitFor(() => getOpenSelectOptions(control), SELECT_OPTION_WAIT_TIMEOUT_MS, SELECT_WAIT_INTERVAL_MS);
      if (options?.length) return options;
    }
    return [];
  }
  async function getLiveSelectOptions(fieldId, fallbackField, { searchTerm = null } = {}) {
    const liveField = getLiveFieldById(fieldId, fallbackField);
    const control = getSelectControl(liveField);
    if (!control) return [];
    let options = await openSelectControl(control);
    if (control.tagName === "INPUT" && searchTerm != null) {
      writeReactTextValue(control, String(searchTerm));
      options = await waitFor(() => { const live = getVisibleListboxOptions(control); return live.length ? live : null; }, SELECT_OPTION_WAIT_TIMEOUT_MS, SELECT_WAIT_INTERVAL_MS) || options;
    }
    return options || [];
  }
  function closeSelectControl(fieldId, fallbackField) {
    const liveField = getLiveFieldById(fieldId, fallbackField);
    const control = getSelectControl(liveField);
    if (!control) return;
    if (isSelectOpen(control)) dispatchKey(control, "Escape");
    control.blur?.();
  }
  // Exact match only — BidHub falls back to an AI embedding-similarity
  // match beyond this; out of scope here, so an unmatched answer falls
  // back to the first option (same final fallback BidHub's own helper
  // used once its embedding call came up empty).
  function getBestMatchingOption(answer, options) {
    if (!Array.isArray(options) || !options.length) return null;
    const normalizedAnswer = normalizeComparisonText(typeof answer === "boolean" ? (answer ? "Yes" : "No") : answer);
    if (!normalizedAnswer) return options[0] ?? null;
    return options.find((o) => normalizeComparisonText(o.text) === normalizedAnswer) ?? options[0] ?? null;
  }

  // ---- file upload (resume / cover letter) --------------------------------

  function readSelectedFileCount(field) {
    const counter = field?.querySelector?.(FILE_COUNTER_SELECTOR);
    if (!counter) return null;
    const match = /total\s+(\d+)\s+files?\s+selected/i.exec(counter.textContent || "");
    return match ? Number(match[1]) : null;
  }
  function fileMatchesAccept(answer, accept) {
    const tokens = String(accept ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (!tokens.length) return true;
    const name = String(answer?.fileName ?? "").toLowerCase();
    const ext = (name.match(/\.[^./\\\s]+$/) || [""])[0];
    const mime = String(answer?.mimeType ?? "").toLowerCase();
    return tokens.some((token) => (token.startsWith(".") ? ext === token : mime === token || mime.startsWith(token.replace(/\*$/, ""))));
  }
  function describeAcceptList(accept) {
    const tokens = String(accept ?? "").split(",").map((t) => t.trim()).filter(Boolean);
    return tokens.length ? tokens.join(" / ") : "a document";
  }
  /** Fill a resume/cover-letter/generic file slot, verifying Rippling's
   *  React handler actually took the file (via its own screen-reader
   *  file-counter) when that counter exists on the slot. Throws with a
   *  descriptive message on a mismatched accept list or an untaken file —
   *  mirrors BidHub's own behavior so a caller sees exactly why a given
   *  upload didn't stick instead of a silent no-op. */
  async function fillRipplingFileField(fieldId, answer, field) {
    const liveField = getLiveFieldById(fieldId, field);
    const input = getFileInputInsideField(liveField);
    if (!input) throw new Error(`rippling: file input for ${fieldId} not found`);
    const accept = input.getAttribute("accept") || "";
    if (!answer || typeof answer !== "object" || answer.type !== "file") {
      throw new Error(`rippling: no file to upload for ${fieldId}`);
    }
    if (!fileMatchesAccept(answer, accept)) {
      throw new Error(`rippling: this field only accepts ${describeAcceptList(accept)} — "${answer.fileName}" cannot be attached`);
    }
    const hasCounter = readSelectedFileCount(liveField) !== null;
    fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
    if (!hasCounter) return;
    const accepted = await waitFor(() => (readSelectedFileCount(liveField) > 0 ? true : null), FILE_ACCEPTED_WAIT_MS, FILE_ACCEPTED_POLL_MS);
    if (!accepted) throw new Error(`rippling: the form did not take "${answer.fileName}" — it accepts ${describeAcceptList(accept)}`);
  }

  // ---- submit detection + advance -----------------------------------------

  // The posting page has no form; its only forward action is "Apply now",
  // which reveals the application form.
  function getApplyControl() {
    if (getForm()) return null;
    return Array.from(document.querySelectorAll('button, [role="button"], a')).filter(isVisible).find((control) => {
      const testId = control.getAttribute("data-testid") || "";
      const label = cleanQuestionText(control.textContent) || testId;
      return /\bapply\b/i.test(testId) || /\bapply\b/i.test(label);
    }) || null;
  }
  // Restrict to submit-typed controls so sibling type="button" controls
  // (file uploads, "Add comment", "Clear selection", "Exit to job board")
  // are never mistaken for the submit button.
  function getSubmitButton() {
    const form = getForm();
    if (!form) return null;
    return Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]')).filter(isVisible).find((button) => {
      const testId = button.getAttribute("data-testid") || "";
      const label = cleanQuestionText(button.textContent) || testId;
      return /\b(apply|submit)\b/i.test(label);
    }) || null;
  }
  function detectSubmitButton() {
    const submitButton = getSubmitButton();
    if (!submitButton) return { detected: false };
    return {
      detected: true,
      label: cleanQuestionText(submitButton.textContent) || submitButton.getAttribute("data-testid") || "",
      // Rippling gates the submit button via aria-disabled (not the native
      // disabled attribute) until every required field is filled.
      disabled: Boolean(submitButton.disabled || submitButton.getAttribute("aria-disabled") === "true"),
    };
  }
  function isAutofillAvailable() {
    if (detectFields().length) return true;
    if (detectSubmitButton().detected) return true;
    return Boolean(getApplyControl());
  }
  /** Advance one step. Returns false when the final submit is already
   *  present (nothing to advance), after clicking "Apply now" (the
   *  posting -> form transition is a same-document SPA route change, so
   *  there's no new document to navigate to — the revealed form is a
   *  fresh detection), or when there's nothing safe to click. */
  async function advance() {
    if (getSubmitButton()) return false;
    const applyControl = getApplyControl();
    if (!applyControl) return false;
    await clickLikeHuman(applyControl);
    await waitFor(() => (getForm() || getSubmitButton()), AUTOFILL_ADVANCE_WAIT_MS, 50);
    return false;
  }

  /** Write `answer` into a detected field entry. 'file' expects
   *  {fileName, base64, mimeType} and throws (rather than silently no-op
   *  ing) when the slot's accept list rejects it or the upload doesn't
   *  visibly register — see fillRipplingFileField. */
  async function fillField(entry, answer) {
    if (!entry) return false;
    const { fieldKind, fieldId, question, field } = entry;
    if (fieldKind !== "file" && answer == null) return false;
    switch (fieldKind) {
      case "text": {
        const liveField = getLiveFieldById(fieldId, field);
        const input = getPlainTextInput(liveField);
        if (!input) return false;
        fillTextInput(input, String(answer ?? ""));
        return true;
      }
      case "phone": {
        const liveField = getLiveFieldById(fieldId, field);
        const input = getPhoneInput(liveField);
        if (!input) return false;
        fillTextInput(input, String(answer ?? ""));
        return true;
      }
      case "textarea": {
        const liveField = getLiveFieldById(fieldId, field);
        const textarea = getTextarea(liveField);
        if (!textarea) return false;
        fillTextInput(textarea, String(answer ?? ""));
        return true;
      }
      case "radio": {
        const liveField = getLiveFieldById(fieldId, field);
        const options = getRipplingRadioOptions(liveField, question);
        const selected = getBestMatchingOption(answer, options);
        const clickable = selected?.element || selected?.input;
        if (!clickable) return false;
        await clickLikeHuman(clickable);
        return true;
      }
      case "checkbox": {
        const liveField = getLiveFieldById(fieldId, field);
        const options = getRipplingCheckboxOptions(liveField, question);
        const selectedAnswers = Array.isArray(answer) ? answer.map(normalizeComparisonText) : typeof answer === "boolean" ? [] : [normalizeComparisonText(answer)];
        for (const option of options) {
          const shouldCheck = typeof answer === "boolean" ? answer : selectedAnswers.includes(normalizeComparisonText(option.text));
          if (option.input && option.input.checked !== shouldCheck) await clickLikeHuman(option.element || option.input);
        }
        return true;
      }
      case "select-custom": {
        const options = await getLiveSelectOptions(fieldId, field, { searchTerm: answer });
        const selected = getBestMatchingOption(answer, options);
        if (selected?.element) { await clickLikeHuman(selected.element); return true; }
        const liveField = getLiveFieldById(fieldId, field);
        const control = getComboboxInput(liveField);
        if (control) { control.dispatchEvent(new Event("change", { bubbles: true })); control.blur(); }
        return false;
      }
      case "location-autocomplete": {
        const liveField = getLiveFieldById(fieldId, field);
        const input = getLocationInput(liveField);
        if (!input) return false;
        writeReactTextValue(input, String(answer));
        const options = await waitFor(() => { const live = getVisibleListboxOptions(); return live.length ? live : null; }, LOCATION_OPTION_WAIT_TIMEOUT_MS, 100);
        if (!options?.length) { input.dispatchEvent(new Event("change", { bubbles: true })); input.blur(); return false; }
        const selected = getBestMatchingOption(answer, options);
        if (selected?.element) await clickLikeHuman(selected.element);
        else { input.dispatchEvent(new Event("change", { bubbles: true })); input.blur(); }
        return true;
      }
      case "file":
        await fillRipplingFileField(fieldId, answer, field);
        return true;
      default:
        return false;
    }
  }

  NS.rippling = {
    isAutofillAvailable,
    detectFields,
    fillField,
    getSubmitButton,
    detectSubmitButton,
    advance,
    closeSelectControl,
  };
})();
