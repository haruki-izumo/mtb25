/* =====================================================================
 * autofill/sites/applytojob-autofill.js — ApplyToJob / Resumator
 * application forms (<company>.applytojob.com).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/applytojob/autofill.js.
 * Resumator's form is a single page/step — BidHub's own registration for
 * this site passes a detectSubmitButton but no detectAdvanceButton, so
 * there's no multi-step "advance" loop to port here (unlike, say,
 * BambooHR's posting → form → form's-own-Next flow).
 *
 * Resumator-specific quirks ported here (structural, not AI-related):
 *   - Required fields are marked with an asterisk INSIDE the label
 *     (`<i class="asterisk">*</i>` on the modern theme, a trailing literal
 *     "*" in the legacy theme's label text) rather than the HTML
 *     `required` attribute.
 *   - A questionnaire checkbox group's real submitted value lives in a
 *     hidden `input.resumator-questionnaire-checkbox-answer` sibling that
 *     Resumator's own JS keeps in sync with which boxes are ticked — our
 *     checkbox fillers must update that hidden mirror too, or the
 *     checked boxes look right on screen but submit empty.
 *   - `<select>` fields render an unselected sentinel option (e.g.
 *     "-- No answer --") that must never be treated as a real choice.
 *   - Date questions render as a jQuery UI datepicker text input
 *     (`.resumator-datepicker.hasDatepicker`); writing the value doesn't
 *     dismiss the picker popup by itself, so it's explicitly closed after.
 *   - The EEO Veteran/Disability questions are two fixed radio groups
 *     (`#resumator-eeo-new-veteran`, `input[name="resumator-eeoc_disability-value"]`)
 *     with no visible `<label>` naming them — their question text is
 *     hardcoded the same way BidHub's own source hardcodes it.
 *   - Address/City/State/Postal render as four separate text inputs under
 *     one `#resumator-address` wrapper, where only the group's own
 *     "Address" label carries the required asterisk.
 *   - Resumator lets the applicant pick between an "Upload" and a
 *     "Type/Paste" method for both the Resume and the Cover Letter, and
 *     renders only the chosen method's widget — the real
 *     `input[type=file]` stays behind a `.none`-classed wrapper until a
 *     "switch to upload"/"choose-upload" toggle link is clicked. Both
 *     toggles are clicked up front in detectFields() (same reasoning
 *     Big Banana's existing simpler generic ApplyToJob adapter already
 *     uses) so the real file inputs exist in the DOM to be detected,
 *     rather than BidHub's own lazier per-field reveal-on-fill — fillField
 *     below still re-checks/re-reveals defensively in case a field is
 *     re-rendered between detection and fill.
 *
 * Explicitly NOT ported (BidHub's own AI-answer backend / CAPTCHA / proxy
 * automation — out of scope for this port):
 *   - The answerType -> getAnswer() backend call and its embedding-
 *     similarity fallback for a free-text screening question with no
 *     exact/substring option match. chooseBestOption() below stops at the
 *     substring fallback; anything looser is left unmatched so the field
 *     stays untouched for Big Banana's own existing generic pipeline.
 *   - The `#resumator-recaptcha` wrapper's reCAPTCHA widget detection.
 *     detectFields() below skips that wrapper entirely — it is never
 *     surfaced as a fillable field at all.
 *   - Post-submit server-validation-message recovery
 *     (inferConstraintsFromValidationMessage) — that only ever fed
 *     constraints back into the AI-answer backend's retry; with no
 *     backend call here there's nothing for it to feed.
 * ===================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofillEngine) return;
  const dom = window.ProactiveAutofillEngine;

  // ---- small local helpers (mirrors BidHub's own normalize/escape pair) ---

  const REQUIRED_MARKERS = /[✱*]/g;
  function normalizeText(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(REQUIRED_MARKERS, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function normalizeComparisonText(value) {
    return normalizeText(value).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }
  function escapeAttributeValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  function isVisible(element) {
    if (!element?.isConnected) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ---- form / wrapper resolution ----------------------------------------

  function getApplyToJobForm() {
    return document.querySelector("#form_submit_new_resume");
  }

  function getFieldWrappers(form) {
    // Modern theme: each field is a `.form-group` inside `.job-form-fields`.
    const modernWrappers = Array.from(form.querySelectorAll(".job-form-fields > .form-group, .job-form-fields > #eeoc-fields"));
    // Legacy theme: no `.job-form-fields`/`.form-group` — fields are
    // `.resumator-field-wrapper` elements (e.g. `#resumator-firstname`)
    // anywhere under the form, with `.resumator-label` divs instead of
    // `label.control-label`.
    const legacyWrappers = Array.from(form.querySelectorAll(":scope .resumator-field-wrapper, :scope #eeoc-fields"));
    // A single form can mix both themes (e.g. modern profile fields plus
    // legacy custom questions) — merge both lists, preserving DOM order and
    // de-duping any wrapper matched by both selectors (a shared `#eeoc-fields`).
    const merged = Array.from(new Set([...modernWrappers, ...legacyWrappers]));
    return merged.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  function getVisibleFieldControls(field) {
    return Array.from(field?.querySelectorAll("input, textarea, select") ?? []).filter((control) => {
      if (control.type === "hidden") return false;
      if (control.id === "g-recaptcha-response") return false;
      if (control.id === "resumator-detect-mobile") return false;
      if (control.disabled || control.readOnly) return false;
      return control.type !== "submit" && control.type !== "button" && control.type !== "reset";
    });
  }

  // ---- required-field + label resolution ---------------------------------

  function getDirectQuestionLabel(field) {
    return field?.querySelector(":scope > label.control-label, :scope > .resumator-label, .resumator-field-wrapper > .resumator-label") ?? null;
  }

  function labelHasRequiredMarker(label) {
    if (!label) return false;
    if (label.querySelector(".asterisk")) return true;
    return /[✱*]\s*$/.test(label.textContent || "");
  }

  function isApplyToJobFieldRequired(field, control = null) {
    if (control?.required || control?.getAttribute?.("aria-required") === "true") return true;
    if (labelHasRequiredMarker(getDirectQuestionLabel(field))) return true;
    if (control?.id) {
      const linkedLabel = document.querySelector(`label[for="${escapeAttributeValue(control.id)}"]`);
      if (labelHasRequiredMarker(linkedLabel)) return true;
    }
    return Boolean(field?.querySelector?.(".control-label .asterisk, .resumator-label .asterisk"));
  }

  function getLabelTextWithoutControls(label) {
    if (!label) return "";
    const clone = label.cloneNode(true);
    clone.querySelectorAll("input, textarea, select, option, optgroup").forEach((node) => node.remove());
    return normalizeText(clone.textContent);
  }

  function getFieldQuestionText(field, control = null) {
    const directLabelText = normalizeText(getDirectQuestionLabel(field)?.textContent);
    if (directLabelText) return directLabelText;
    if (control?.id) {
      const linkedLabel = document.querySelector(`label[for="${escapeAttributeValue(control.id)}"]`);
      const linkedLabelText = getLabelTextWithoutControls(linkedLabel);
      if (linkedLabelText) return linkedLabelText;
    }
    const labelText = getLabelTextWithoutControls(field?.querySelector("label"));
    if (labelText) return labelText;
    return normalizeText(control?.getAttribute?.("aria-label") || control?.name || control?.id);
  }

  function getChoiceQuestionText(field, inputs) {
    const hiddenQuestion = field?.querySelector('input.resumator-questionnaire-checkbox-answer[type="hidden"]');
    if (hiddenQuestion?.id) {
      const label = document.querySelector(`label[for="${escapeAttributeValue(hiddenQuestion.id)}"]`);
      const text = normalizeText(label?.textContent);
      if (text) return text;
    }
    const firstInput = inputs[0] ?? null;
    // The EEO Veteran/Disability radio groups carry these two fixed
    // `name`s with no visible question label anywhere near them — the
    // label text lives in surrounding page copy, not a `<label for>`.
    if (firstInput?.name === "resumator-eeoc_veteran-value") return "Veteran status";
    if (firstInput?.name === "resumator-eeoc_disability-value") return "Disability status";
    return getFieldQuestionText(field, firstInput);
  }

  function getChoiceInputText(input, fallbackQuestion = "") {
    return normalizeText(dom.getInputLabelText(input, fallbackQuestion) || input?.value || fallbackQuestion);
  }

  function getChoiceOptions(inputs, fallbackQuestion = "") {
    return inputs.map((input) => getChoiceInputText(input, fallbackQuestion)).filter(Boolean);
  }

  // ApplyToJob renders an unselected sentinel in `<select>` fields (e.g.
  // "-- No answer --"). It is not a real choice, so it's excluded from the
  // option list and never selected — leaving it chosen means "not answered".
  function isPlaceholderSelectOption(option) {
    if (!option) return false;
    const text = normalizeComparisonText(option.textContent || option.label || option.value).replace(/^[\s\-–—]+|[\s\-–—]+$/g, "");
    return text === "" || text === "no answer";
  }
  function getNativeSelectOptions(select) {
    return Array.from(select?.options ?? [])
      .filter((option) => !isPlaceholderSelectOption(option))
      .map((option) => normalizeText(option.textContent || option.label || option.value))
      .filter(Boolean);
  }

  function buildFieldId(field, control, fallbackQuestion) {
    const questionnaireInput = field?.querySelector?.('input.resumator-questionnaire-checkbox-answer[type="hidden"]');
    return (
      questionnaireInput?.id ||
      control?.id ||
      control?.name ||
      field?.id ||
      normalizeComparisonText(fallbackQuestion).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    );
  }

  function isResumeQuestion(question, control) {
    const combined = `${question} ${control?.id ?? ""} ${control?.name ?? ""}`.toLowerCase();
    return /\bresume\b|\bcv\b|curriculum vitae/.test(combined);
  }
  function isCoverLetterQuestion(question, control) {
    const combined = `${question} ${control?.id ?? ""} ${control?.name ?? ""}`.toLowerCase();
    return /cover\s*letter|cover_?letter/.test(combined);
  }

  // ---- jQuery UI datepicker (date questions) -----------------------------

  function isApplyToJobDatePickerControl(control) {
    if (!control) return false;
    if (control.type === "date") return true;
    return /\b(resumator-datepicker|hasDatepicker)\b/.test(control.className || "");
  }
  function isApplyToJobDatePickerVisible() {
    const picker = document.querySelector("#ui-datepicker-div");
    if (!picker) return false;
    const style = window.getComputedStyle(picker);
    const rect = picker.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }
  // Writing the value directly into a jQuery UI datepicker input doesn't
  // dismiss its popup calendar by itself (no real click landed on a day
  // cell) — close it explicitly so it doesn't keep covering the next field.
  function closeApplyToJobDatePicker(input) {
    const jquery = window.jQuery;
    if (typeof jquery === "function") {
      try {
        jquery(input).datepicker("hide");
      } catch {
        /* datepicker not initialized on this particular input */
      }
      try {
        jquery.datepicker?._hideDatepicker?.();
      } catch {
        /* older jQuery UI build without this internal */
      }
    }
    input?.blur?.();
    if (isApplyToJobDatePickerVisible()) {
      document.body?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      document.body?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      document.body?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    }
  }

  // ---- Upload vs Type/Paste toggle (resume + cover letter) ---------------

  const UPLOAD_TOGGLE_SELECTOR = ['#resumator-choose-upload', '#resumator-resume-switch-upload', 'a[id*="choose-upload"]', 'a[id*="switch-upload"]'].join(", ");
  const UPLOAD_WRAPPER_SELECTOR = ['#resumator-resume-upload-wrapper', '[id*="cover"][id*="upload-wrapper"]', '[id*="cover"][id*="upload"]'].join(", ");

  function isHiddenByApplyToJobClass(element) {
    return Boolean(element?.classList?.contains("none"));
  }

  // Click every visible "switch to upload" toggle up front so BOTH the
  // Resume's and the Cover Letter's real `input[type=file]` exist in the
  // DOM for detectFields() to find — same reasoning Big Banana's existing
  // simpler generic ApplyToJob adapter already uses. Skips a toggle whose
  // upload widget is already showing (clicking it again would flip the UI
  // BACK to the Type/Paste method instead).
  async function revealUploadToggles(form) {
    for (const toggle of Array.from(form.querySelectorAll(UPLOAD_TOGGLE_SELECTOR))) {
      if (!isVisible(toggle)) continue;
      const wrapper = toggle.closest(".form-group, .resumator-field-wrapper") || form;
      const uploadWrapper = wrapper.querySelector(UPLOAD_WRAPPER_SELECTOR);
      if (uploadWrapper && !isHiddenByApplyToJobClass(uploadWrapper) && dom.getFileInputInsideField(wrapper)) continue;
      await dom.clickLikeHuman(toggle);
      await dom.sleep(100);
    }
  }

  // Lazy per-field fallback (BidHub's own original timing) in case a field
  // got re-rendered between detectFields() and fillField() and lost its
  // revealed state.
  async function revealFileInput(field) {
    if (!field?.querySelector) return dom.getFileInputInsideField(field);
    const uploadWrapper = field.querySelector(UPLOAD_WRAPPER_SELECTOR);
    if (!isHiddenByApplyToJobClass(uploadWrapper) && dom.getFileInputInsideField(field)) {
      return dom.getFileInputInsideField(field);
    }
    const uploadTrigger = field.querySelector(UPLOAD_TOGGLE_SELECTOR);
    if (uploadTrigger) await dom.clickLikeHuman(uploadTrigger);
    await dom.sleep(100);
    return dom.getFileInputInsideField(field);
  }

  // ---- field-kind classification -----------------------------------------

  function detectFieldMetadata(field, question, control) {
    if (control?.type === "file") {
      const isCoverLetter = isCoverLetterQuestion(question, control);
      const isResume = !isCoverLetter && isResumeQuestion(question, control);
      return {
        fieldKind: "file",
        options: null,
        isResume,
        isCoverLetter,
        fieldId: isCoverLetter ? "cover_letter" : isResume ? "resume" : null,
      };
    }
    const radioInputs = dom.getRadioInputs(field);
    if (radioInputs.length > 0) {
      return { fieldKind: "radio", options: getChoiceOptions(radioInputs, question) };
    }
    const checkboxInputs = dom.getCheckboxInputs(field);
    if (checkboxInputs.length > 0) {
      // A lone checkbox (e.g. a consent/agreement box) is inherently a
      // yes/no: ticking it means "yes" — present it as Yes/No rather than a
      // multi-select over its single option.
      if (checkboxInputs.length === 1) {
        return { fieldKind: "checkbox-single", options: ["Yes", "No"] };
      }
      return { fieldKind: "checkbox-multi", options: getChoiceOptions(checkboxInputs, question) };
    }
    const select = dom.getNativeSelect(field);
    if (select) return { fieldKind: "select-native", options: getNativeSelectOptions(select) };
    const textarea = dom.getTextarea(field);
    if (textarea) return { fieldKind: "textarea", options: null };
    const textInput = control || dom.getTextInput(field);
    if (textInput) {
      if (isApplyToJobDatePickerControl(textInput)) return { fieldKind: "date", options: null };
      return { fieldKind: "text", options: null };
    }
    return null;
  }

  function pushEntry(entries, seenFieldIds, entry) {
    if (!entry.fieldId || seenFieldIds.has(entry.fieldId)) return;
    seenFieldIds.add(entry.fieldId);
    entries.push(entry);
  }

  // Address / City / State / Postal render as four separate text inputs
  // under one `#resumator-address` wrapper, but only the group's own
  // "Address" label carries the required asterisk — if the group is
  // required, every sub-field inherits that.
  function collectAddressFields(wrapper, entries, seenFieldIds) {
    const addressControls = Array.from(
      wrapper.querySelectorAll(["#resumator-address-value", "#resumator-city-value", "#resumator-state-value", "#resumator-postal-value"].join(", "))
    );
    const addressGroup = wrapper.querySelector("#resumator-address") || wrapper;
    const addressRequired = isApplyToJobFieldRequired(addressGroup);
    for (const control of addressControls) {
      const question =
        control.id === "resumator-address-value"
          ? getFieldQuestionText(wrapper, control)
          : normalizeText(control.placeholder) || getFieldQuestionText(wrapper, control);
      const fieldId = buildFieldId(wrapper, control, question);
      pushEntry(entries, seenFieldIds, {
        question,
        fieldId,
        fieldKind: "text",
        field: control,
        control,
        options: null,
        required: addressRequired || isApplyToJobFieldRequired(wrapper, control),
        isResume: false,
        isCoverLetter: false,
      });
    }
  }

  function addChoiceGroupEntry(entries, seenFieldIds, { field, inputs, question, fieldKind = "radio" }) {
    if (!field || !inputs.length) return;
    const fieldId = inputs[0]?.name || inputs[0]?.id;
    pushEntry(entries, seenFieldIds, {
      question,
      fieldId,
      fieldKind,
      field,
      control: inputs[0],
      options: getChoiceOptions(inputs, question),
      required: isApplyToJobFieldRequired(field),
      isResume: false,
      isCoverLetter: false,
    });
  }

  // The EEO Veteran/Disability self-identification block: two fixed radio
  // groups plus (when Disability is answered) a signature name + date pair.
  function collectEeocFields(wrapper, entries, seenFieldIds) {
    const veteranField = wrapper.querySelector("#resumator-eeo-new-veteran");
    const veteranInputs = Array.from(veteranField?.querySelectorAll('input[type="radio"]') ?? []);
    if (veteranInputs.length > 0) {
      addChoiceGroupEntry(entries, seenFieldIds, { field: veteranField, inputs: veteranInputs, question: "Veteran status" });
    }
    const disabilityInputs = Array.from(wrapper.querySelectorAll('input[name="resumator-eeoc_disability-value"]'));
    const disabilityField = disabilityInputs[0]?.closest(".form-group") || wrapper.querySelector("#disability-input-area") || wrapper;
    if (disabilityInputs.length > 0) {
      addChoiceGroupEntry(entries, seenFieldIds, { field: disabilityField, inputs: disabilityInputs, question: "Disability status" });
    }
    for (const [selector, question, fieldKind] of [
      ["#resumator-eeoc_disability_signature-value", "Disability signature name", "text"],
      ["#resumator-eeoc_disability_date-value", "Disability signature date", "date"],
    ]) {
      const control = wrapper.querySelector(selector);
      if (!control) continue;
      pushEntry(entries, seenFieldIds, {
        question,
        fieldId: control.id,
        fieldKind,
        field: control,
        control,
        options: null,
        required: isApplyToJobFieldRequired(wrapper, control),
        isResume: false,
        isCoverLetter: false,
      });
    }
  }

  /** Enumerate every fillable field on the current ApplyToJob application
   *  form: {question, fieldId, fieldKind, field, control, options, required,
   *  isResume, isCoverLetter}. Clicks the Upload-method toggles first (see
   *  revealUploadToggles) so file fields are actually present to detect. */
  async function detectFields() {
    const form = getApplyToJobForm();
    if (!form) return [];
    await revealUploadToggles(form);

    const entries = [];
    const seenFieldIds = new Set();
    const seenRadioNames = new Set();

    for (const wrapper of getFieldWrappers(form)) {
      if (wrapper.id === "resumator-submit") continue;
      // CAPTCHA — explicitly out of scope; never surfaced as a field at all.
      if (wrapper.id === "resumator-recaptcha") continue;
      if (wrapper.id === "eeoc-fields") {
        collectEeocFields(wrapper, entries, seenFieldIds);
        continue;
      }
      if (wrapper.id === "resumator-address") {
        collectAddressFields(wrapper, entries, seenFieldIds);
        continue;
      }

      const controls = getVisibleFieldControls(wrapper);
      if (controls.length === 0) continue;
      const firstControl = controls[0];
      const radioInputs = dom.getRadioInputs(wrapper);
      const checkboxInputs = dom.getCheckboxInputs(wrapper);
      const control = radioInputs[0] || checkboxInputs[0] || firstControl;

      if (radioInputs.length > 0 && control?.name) {
        if (seenRadioNames.has(control.name)) continue;
        seenRadioNames.add(control.name);
      }

      const question =
        radioInputs.length > 0 || checkboxInputs.length > 0
          ? getChoiceQuestionText(wrapper, radioInputs.length > 0 ? radioInputs : checkboxInputs)
          : getFieldQuestionText(wrapper, control);

      const metadata = detectFieldMetadata(wrapper, question, control);
      if (!metadata) continue;
      const fieldId = metadata.fieldId || buildFieldId(wrapper, control, question);
      pushEntry(entries, seenFieldIds, {
        question,
        fieldId,
        fieldKind: metadata.fieldKind,
        field: wrapper,
        control,
        options: metadata.options,
        required: isApplyToJobFieldRequired(wrapper, control),
        isResume: metadata.isResume || false,
        isCoverLetter: metadata.isCoverLetter || false,
      });
    }
    return entries;
  }

  function isAutofillAvailable() {
    return Boolean(getApplyToJobForm());
  }

  // Submit button is surfaced for informational use only (e.g. a caller
  // wanting to know whether the form is otherwise ready) — this module
  // never clicks it. Actual submission stays a human action.
  function getSubmitButton() {
    return document.querySelector("#resumator-submit-resume");
  }

  // ---- value matching (no AI backend) ------------------------------------

  // Best match for `rawValue` among `options`: exact (normalized) match
  // first, else the first option whose text contains — or is contained
  // by — the value. BidHub's own fallback below this point called its AI
  // embedding-similarity backend; that's the out-of-scope AI-answer
  // generation, so a looser-than-substring miss here simply returns null
  // and the field is left untouched for Big Banana's generic pipeline.
  function chooseBestOption(rawValue, options) {
    const value = normalizeText(rawValue);
    if (!value || !Array.isArray(options) || options.length === 0) return null;
    const exact = options.find((option) => normalizeComparisonText(option) === normalizeComparisonText(value));
    if (exact) return exact;
    const normalizedValue = normalizeComparisonText(value);
    return (
      options.find((option) => {
        const text = normalizeComparisonText(option);
        return text && (text.includes(normalizedValue) || normalizedValue.includes(text));
      }) ?? null
    );
  }
  function isAffirmative(value) {
    return value === true || normalizeComparisonText(value) === "yes";
  }

  // A questionnaire checkbox group's real submitted value lives in this
  // hidden sibling input, which Resumator's own JS keeps in sync with
  // which boxes are ticked — update it too, or the on-screen checked state
  // never reaches the server.
  function syncQuestionnaireCheckboxValue(field, selectedOptions) {
    const hiddenInput = field?.querySelector?.('input.resumator-questionnaire-checkbox-answer[type="hidden"]');
    if (!hiddenInput) return;
    hiddenInput.value = selectedOptions.join(", ");
    hiddenInput.dispatchEvent(new Event("input", { bubbles: true }));
    hiddenInput.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** Write `value` into a detected field entry, using the mechanism its
   *  fieldKind needs. For 'radio'/'checkbox-single'/'checkbox-multi'/
   *  'select-native', `value` is matched against the field's own option
   *  text (see chooseBestOption) rather than written verbatim. For 'file',
   *  `value` is `{fileName, base64, mimeType}`. Returns true on an
   *  apparent success. */
  async function fillField(entry, value, { shouldAbort = () => false } = {}) {
    if (!entry || value == null || shouldAbort()) return false;
    switch (entry.fieldKind) {
      case "text": {
        const input = entry.control || dom.getTextInput(entry.field);
        if (!input) return false;
        dom.fillTextInput(input, value);
        return true;
      }
      case "textarea": {
        const textarea = dom.getTextarea(entry.field) || entry.control;
        if (!textarea) return false;
        dom.fillTextInput(textarea, value);
        return true;
      }
      case "date": {
        const input = dom.getTextInput(entry.field) || (entry.field?.tagName === "INPUT" ? entry.field : null);
        if (!input) return false;
        dom.fillTextInput(input, value);
        closeApplyToJobDatePicker(input);
        return true;
      }
      case "select-native": {
        const select = dom.getNativeSelect(entry.field);
        if (!select) return false;
        const options = Array.from(select.options)
          .filter((option) => !isPlaceholderSelectOption(option))
          .map((option) => ({ label: normalizeText(option.textContent || option.label || option.value), value: option.value }))
          .filter((option) => option.label);
        const best = chooseBestOption(value, options.map((option) => option.label));
        if (!best) return false;
        const option = options.find((candidate) => normalizeComparisonText(candidate.label) === normalizeComparisonText(best));
        if (!option) return false;
        dom.fillSelectInput(select, option.value);
        return true;
      }
      case "checkbox-single": {
        const inputs = dom.getCheckboxInputs(entry.field);
        if (inputs.length === 0) return false;
        if (inputs.length === 1) {
          const shouldCheck = isAffirmative(value);
          if (inputs[0].checked !== shouldCheck) await dom.clickLikeHuman(inputs[0], { shouldAbort });
          syncQuestionnaireCheckboxValue(entry.field, shouldCheck ? [getChoiceInputText(inputs[0])] : []);
          return true;
        }
        const options = getChoiceOptions(inputs);
        const best = chooseBestOption(value, options);
        if (!best) return false;
        for (const input of inputs) {
          const shouldCheck = normalizeComparisonText(getChoiceInputText(input)) === normalizeComparisonText(best);
          if (input.checked !== shouldCheck) await dom.clickLikeHuman(input, { shouldAbort });
        }
        syncQuestionnaireCheckboxValue(entry.field, [best]);
        return true;
      }
      case "checkbox-multi": {
        const inputs = dom.getCheckboxInputs(entry.field);
        const requestedAnswers = (Array.isArray(value) ? value : String(value).split(/[\n,;]/)).map(normalizeText).filter(Boolean);
        if (requestedAnswers.length === 0) return false;
        const options = getChoiceOptions(inputs);
        const matchedOptions = requestedAnswers.map((answer) => chooseBestOption(answer, options)).filter(Boolean);
        const normalizedMatched = matchedOptions.map(normalizeComparisonText);
        for (const input of inputs) {
          const shouldCheck = normalizedMatched.includes(normalizeComparisonText(getChoiceInputText(input)));
          if (input.checked !== shouldCheck) await dom.clickLikeHuman(input, { shouldAbort });
        }
        syncQuestionnaireCheckboxValue(entry.field, matchedOptions);
        return true;
      }
      case "radio": {
        const inputs = dom.getRadioInputs(entry.field);
        const options = getChoiceOptions(inputs);
        const best = chooseBestOption(value, options);
        if (!best) return false;
        const input = inputs.find((candidate) => normalizeComparisonText(getChoiceInputText(candidate)) === normalizeComparisonText(best));
        if (!input) return false;
        if (!input.checked) await dom.clickLikeHuman(input, { shouldAbort });
        return true;
      }
      case "file": {
        if (!value || typeof value !== "object") return false;
        const input = await revealFileInput(entry.field);
        if (!input) return false;
        dom.fillFileInput(input, value.fileName, value.base64, value.mimeType);
        return true;
      }
      default:
        return false;
    }
  }

  // ---- profileData -> detected-field mapping -----------------------------

  function splitFullName(fullName) {
    const parts = normalizeText(fullName).split(/\s+/).filter(Boolean);
    if (!parts.length) return { first: null, last: null };
    return { first: parts[0], last: parts.length > 1 ? parts.slice(1).join(" ") : null };
  }
  function joinFullName(profileData) {
    return [profileData.first_name, profileData.last_name].filter(Boolean).join(" ") || null;
  }

  // Structural contact-field matchers, tried in order against the field's
  // normalized question text. Anything that doesn't match one of these
  // (every per-employer screening question) is deliberately left alone —
  // Big Banana's existing generic pipeline resolves those from here.
  const STRUCTURAL_TEXT_MATCHERS = [
    { test: (q) => /\bfirst\s*name\b/i.test(q), pick: (p) => p.first_name || splitFullName(p.full_name).first },
    { test: (q) => /\blast\s*name\b/i.test(q), pick: (p) => p.last_name || splitFullName(p.full_name).last },
    { test: (q) => /\bfull\s*name\b/i.test(q) || /^name$/i.test(q), pick: (p) => p.full_name || joinFullName(p) },
    { test: (q) => /\be-?mail\b/i.test(q), pick: (p) => p.email },
    { test: (q) => /\bphone\b|\bmobile\b|\btelephone\b/i.test(q), pick: (p) => p.phone },
    { test: (q) => /\blinkedin\b/i.test(q), pick: (p) => p.linkedin },
    { test: (q) => /\baddress\b/i.test(q) && !/\be-?mail\b/i.test(q), pick: (p) => p.address || p.street_address },
    { test: (q) => /\bcity\b/i.test(q), pick: (p) => p.city },
    { test: (q) => /\bstate\b|\bprovince\b/i.test(q), pick: (p) => p.state },
    { test: (q) => /\b(zip|postal)\b/i.test(q), pick: (p) => p.zip || p.postal_code },
  ];

  function resolveStructuralValue(entry, profileData) {
    if (entry.fieldKind === "file") {
      if (entry.isResume) return profileData.__resumeFile || null;
      if (entry.isCoverLetter) return profileData.__coverLetterFile || null;
      return null;
    }
    if (entry.fieldKind !== "text" && entry.fieldKind !== "textarea" && entry.fieldKind !== "date") return null;
    const matcher = STRUCTURAL_TEXT_MATCHERS.find((candidate) => candidate.test(entry.question));
    if (!matcher) return null;
    return matcher.pick(profileData) || null;
  }

  /** Fill every structurally-resolvable field on the current ApplyToJob
   *  form from `profileData` (full_name or first_name/last_name, email,
   *  phone, linkedin, address/city/state/zip, __resumeFile,
   *  __coverLetterFile). Returns the fieldIds it actually wrote. Any
   *  field it can't structurally resolve (every per-employer screening
   *  question, EEO demographic questions, etc.) is left untouched so Big
   *  Banana's existing generic pipeline can pick it up afterward — this
   *  never throws or stubs a fake answer for those. Never clicks the
   *  Submit button; that stays a human action. */
  async function fill(profileData = {}, opts = {}) {
    const { shouldAbort = () => false } = opts;
    if (!isAutofillAvailable()) return [];
    const fields = await detectFields();
    const filledFieldIds = [];
    for (const entry of fields) {
      if (shouldAbort()) break;
      const value = resolveStructuralValue(entry, profileData);
      if (value == null) continue;
      const ok = await fillField(entry, value, { shouldAbort });
      if (ok) filledFieldIds.push(entry.fieldId);
    }
    return filledFieldIds;
  }

  window.ProactiveAutofillSites = window.ProactiveAutofillSites || {};
  window.ProactiveAutofillSites.applytojob = {
    isAutofillAvailable,
    detectFields,
    fill,
    fillField,
    getSubmitButton,
  };
})();
