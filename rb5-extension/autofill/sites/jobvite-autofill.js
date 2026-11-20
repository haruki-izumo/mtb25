/* =====================================================================
 * autofill/sites/jobvite-autofill.js — Jobvite career sites
 * (jobs.jobvite.com/<company>/job/<id>).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/jobvite/autofill.js. That
 * file's own field-filling MECHANICS are NOT re-implemented here —
 * they're exactly what autofill/engine/dom-interactions.js already
 * provides as window.ProactiveAutofillEngine, so this file calls into
 * that instead.
 *
 * Jobvite renders an AngularJS single-page application. The apply flow is:
 *   1. Job posting (/job/<id>) — an "Apply" link opens the application.
 *   2. Consent gate (/job/<id>/apply) — a `consentForm` asks for
 *      "Location of Residence and Language" then shows a data-processing
 *      policy with an "I Accept"/"I Decline" choice.
 *   3. The real application form `form[name="scopeData.applyForm"]` — a
 *      single scrolling page with sections: Add Resume, Personal
 *      Information, custom screening questions, Social Profile,
 *      Additional Files.
 *
 * All controls carry stable `jv-field-<token>` ids (unique within a
 * posting, but they change between postings, so field ids here are
 * derived from the question text instead). Custom questions render
 * through an Angular `ng-switch`, so a radio group is a
 * `<fieldset class="jv-input-group" ng-switch-when="radio">`, a select
 * is a native `<select>`, etc. Resume/Cover-Letter/Portfolio uploads
 * share ONE `#attachmentDropdown` overlay whose file input is bound to
 * whichever attachment button was last clicked.
 *
 * OUT OF SCOPE (left to Big Banana's own existing systems, untouched):
 *   - Free-text/fuzzy ANSWER GENERATION (BidHub's getAnswer()/ai-core
 *     backend, and the embedding-similarity fallback in its own
 *     getBestMatchingOption()). detectFields() below only classifies
 *     each question's structural fieldKind and locates its control;
 *     fillField() only matches an already-resolved answer against the
 *     field's own option text — exact-or-prefix match only, same AI
 *     boundary lever-autofill.js and dover-autofill.js keep.
 *   - `g-recaptcha-response` / the hidden `jv-edit-resume-textarea` /
 *     `jv-paste-resume-textarea` controls are still skipped during
 *     detection (never treated as fillable questions) — CAPTCHA itself
 *     is out of scope, and those textareas are Jobvite's own internal
 *     scratch controls for its "paste resume text" affordance, not a
 *     real question.
 *   - dependsOnPrevious / dependent-question sequencing — that only
 *     mattered for ordering AI-generated answers.
 * ===================================================================== */
(function () {
  "use strict";

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const { sleep, fillTextInput, fillFileInput, fillSelectInput, clickLikeHuman, getCheckboxInputs, getRadioInputs, getNativeSelect, getTextarea } = engine;

  // ---- constants ------------------------------------------------------------

  const FORM_SELECTOR = 'form[name="scopeData.applyForm"]';
  const CONSENT_FORM_SELECTOR = 'form[name="consentForm"], #jv-country-select';
  const CONSENT_SELECT_SELECTOR = "#jv-country-select";
  const CONSENT_FIELD_ID = "consent_location";
  const RESUME_WIDGET_SELECTOR = "#attachResume";
  const ATTACHMENT_BUTTON_SELECTOR = "button[jv-add-attachment]";
  const ATTACHMENT_DROPDOWN_SELECTOR = "#attachmentDropdown";
  const APPLY_BUTTON_PATTERN = /^\s*apply(?:\s+now)?(?:\s+for\s+this\s+(?:job|position))?\s*$/i;
  const SUBMIT_BUTTON_PATTERN = /\b(send|submit)\b/i;
  // Hidden Angular textareas that must never be treated as fillable questions.
  const IGNORED_CONTROL_IDS = new Set(["g-recaptcha-response"]);
  const IGNORED_CONTROL_ID_PATTERN = /^jv-(edit|paste)-resume-textarea/;
  const CONSENT_ACCEPT_WAIT_TIMEOUT_MS = 4500;
  const RESUME_DROPDOWN_WAIT_TIMEOUT_MS = 3000;

  function normalizeJobviteText(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(/[*✱]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function normalizeComparisonText(value) {
    return normalizeJobviteText(value).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }
  function slugifyFieldId(value) {
    return normalizeComparisonText(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }
  function escapeAttributeValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // Jobvite styles radio/checkbox inputs off-screen and renders a custom
  // icon, so the native input is "invisible" while its label row is
  // clickable — callers that specifically need the choice input itself
  // (not a generic visibility check) pass allowHiddenChoiceInput.
  function isElementVisible(element, { allowHiddenChoiceInput = false } = {}) {
    if (!element?.isConnected) return false;
    if (allowHiddenChoiceInput && element.matches?.('input[type="radio"], input[type="checkbox"]')) return true;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  async function waitFor(check, timeoutMs, shouldAbort = () => false) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (shouldAbort()) return null;
      const result = check();
      if (result) return result;
      await sleep(120);
    }
    return null;
  }

  function getApplyForm() {
    return document.querySelector(FORM_SELECTOR);
  }
  function getConsentForm() {
    return document.querySelector(CONSENT_FORM_SELECTOR);
  }
  function getConsentSelect() {
    return document.querySelector(CONSENT_SELECT_SELECTOR);
  }
  function getActionLabel(element) {
    return normalizeJobviteText(element?.textContent || element?.value || element?.getAttribute?.("aria-label") || "");
  }
  function getLabelElementForControl(control) {
    if (!control) return null;
    if (control.id) {
      const linked = document.querySelector(`label[for="${escapeAttributeValue(control.id)}"]`);
      if (linked) return linked;
    }
    return control.closest("label");
  }

  // Resolve a question's prompt text, trying (in order): a wrapping
  // fieldset's <legend>, the control's own <label>, a sibling <span>
  // (standalone checkboxes like the LinkedIn opt-in carry their text
  // that way, not via label[for]), aria-label, then any label-ish
  // descendant of the field.
  function getFieldQuestion(field, control = null) {
    const legendText = normalizeJobviteText(field?.querySelector?.("legend")?.textContent);
    if (legendText) return legendText;
    const labelText = normalizeJobviteText(getLabelElementForControl(control)?.textContent);
    if (labelText) return labelText;
    if (control?.type === "checkbox") {
      const siblingText = normalizeJobviteText(control.nextElementSibling?.textContent);
      if (siblingText) return siblingText;
      const wrapperText = normalizeJobviteText(control.closest("div")?.textContent);
      if (wrapperText) return wrapperText;
    }
    const ariaLabel = normalizeJobviteText(control?.getAttribute?.("aria-label"));
    if (ariaLabel) return ariaLabel;
    return normalizeJobviteText(field?.querySelector?.('label, [class*="label"]')?.textContent);
  }

  function isRequiredField(field, control) {
    if (control?.required || control?.getAttribute?.("aria-required") === "true") return true;
    if (field?.querySelector?.(".jv-required-label")) return true;
    return false;
  }

  // Jobvite's own text-input selector deliberately excludes
  // input[type=password] (there's no password field on an application
  // form) but includes date — the engine's own getTextInput default
  // selector isn't quite the right shape here, so this is kept as its
  // own small selector rather than reusing it.
  const JOBVITE_TEXT_INPUT_SELECTOR = [
    'input[type="text"]',
    'input[type="email"]',
    'input[type="tel"]',
    'input[type="url"]',
    'input[type="number"]',
    'input[type="date"]',
    "input:not([type])",
  ].join(", ");
  function getJobviteTextInput(field) {
    if (!field) return null;
    if (field.matches?.("input") && !["hidden", "file", "checkbox", "radio", "submit", "button"].includes(field.type)) return field;
    return field.querySelector?.(JOBVITE_TEXT_INPUT_SELECTOR) ?? null;
  }
  function getSelectOptionEntries(field) {
    const select = getNativeSelect(field);
    if (!select) return [];
    return Array.from(select.querySelectorAll("option"))
      .filter((option) => option.value)
      .map((option) => ({ value: option.value, text: normalizeJobviteText(option.textContent || option.value) }))
      .filter((option) => option.text);
  }
  function getChoiceOptionEntries(field, inputType, fallbackQuestion) {
    const inputs = inputType === "radio" ? getRadioInputs(field) : getCheckboxInputs(field);
    return inputs
      .map((input) => ({
        input,
        value: input.value,
        text: normalizeJobviteText(getLabelElementForControl(input)?.textContent || input.value || fallbackQuestion),
      }))
      .filter((option) => option.text);
  }

  // Exact-or-prefix text/value match only — deliberately NOT BidHub's own
  // embedding fallback. An option list this can't place deterministically
  // is left untouched for the generic pipeline to try.
  function findMatchingOption(answer, options) {
    if (!Array.isArray(options) || options.length === 0) return null;
    const normalizedAnswer = normalizeComparisonText(typeof answer === "boolean" ? (answer ? "Yes" : "No") : answer);
    if (!normalizedAnswer) return null;
    return (
      options.find((o) => normalizeComparisonText(o.text) === normalizedAnswer || normalizeComparisonText(o.value) === normalizedAnswer) ??
      options.find((o) => {
        const text = normalizeComparisonText(o.text);
        return text && (text.startsWith(normalizedAnswer) || normalizedAnswer.startsWith(text));
      }) ??
      null
    );
  }
  function toSelectionList(answer) {
    if (Array.isArray(answer)) return answer.map(normalizeComparisonText).filter(Boolean);
    if (typeof answer === "boolean") return [answer ? "yes" : "no"];
    return [normalizeComparisonText(answer)].filter(Boolean);
  }
  function isAffirmativeAnswer(answer) {
    if (answer === true) return true;
    return /^(?:yes|true|y|agree|agreed|accept(?:ed)?|checked|on|1)$/i.test(normalizeComparisonText(answer));
  }

  function ensureUniqueFieldId(baseFieldId, usedFieldIds, fallbackPrefix = "jobvite_field") {
    const base = slugifyFieldId(baseFieldId) || fallbackPrefix;
    let candidate = base;
    let suffix = 2;
    while (usedFieldIds.has(candidate)) candidate = `${base}_${suffix++}`;
    usedFieldIds.add(candidate);
    return candidate;
  }

  function isResumeWidgetPresent() {
    return Boolean(document.querySelector(`${RESUME_WIDGET_SELECTOR} ${ATTACHMENT_BUTTON_SELECTOR}`));
  }

  // ---- detection --------------------------------------------------------------

  // The consent gate (step 1) only has the "Location of Residence and
  // Language" select. Surfacing it for autofill lets the right
  // data-processing policy load before the user makes their own
  // explicit "I Accept"/"I Decline" choice.
  function detectConsentFields() {
    const select = getConsentSelect();
    if (!select || !isElementVisible(select)) return [];
    const optionEntries = getSelectOptionEntries(select);
    if (optionEntries.length === 0) return [];
    const question = getFieldQuestion(select.closest("div, form") || select, select) || "Location of Residence and Language";
    return [
      {
        question,
        fieldId: CONSENT_FIELD_ID,
        fieldKind: "select-native",
        field: select,
        control: select,
        options: optionEntries.map((o) => o.text),
        required: isRequiredField(null, select),
      },
    ];
  }

  /** Walk Jobvite's application form (or, before it opens, the consent
   *  gate's residence select) and return every question this adapter
   *  can fill deterministically.
   *  @returns {Array<{question, fieldId, field, control, fieldKind, options, required}>}
   */
  function detectFields() {
    const form = getApplyForm();
    if (!form) return detectConsentFields();

    const entries = [];
    const usedFieldIds = new Set();
    const detectedChoiceFieldsets = new Set();
    const addField = ({ question, fieldIdBase, field, control, fieldKind, options = [], required = false }) => {
      if (!question || !field || !fieldKind) return;
      const fieldId = ensureUniqueFieldId(fieldIdBase, usedFieldIds);
      entries.push({ question, fieldId, field, control, fieldKind, options, required });
    };

    // Resume upload (the only required attachment) comes first.
    if (isResumeWidgetPresent()) {
      const widget = document.querySelector(RESUME_WIDGET_SELECTOR);
      addField({ question: "Resume", fieldIdBase: "resume", field: widget, control: widget, fieldKind: "resume", required: true });
    }

    // Radio/checkbox groups rendered as fieldsets (custom screening questions).
    for (const fieldset of form.querySelectorAll("fieldset.jv-input-group, fieldset")) {
      const radios = getRadioInputs(fieldset);
      const checkboxes = getCheckboxInputs(fieldset);
      const inputType = radios.length ? "radio" : checkboxes.length ? "checkbox" : null;
      if (!inputType) continue;
      const primary = radios[0] || checkboxes[0];
      const question = getFieldQuestion(fieldset, primary);
      const optionEntries = getChoiceOptionEntries(fieldset, inputType, question);
      if (!question || optionEntries.length === 0) continue;
      detectedChoiceFieldsets.add(fieldset);
      const isMulti = inputType === "checkbox" && optionEntries.length > 1;
      addField({
        question,
        fieldIdBase: question,
        field: fieldset,
        control: primary,
        fieldKind: inputType === "radio" ? "radio" : isMulti ? "checkbox" : "checkbox-single",
        options: optionEntries.map((o) => o.text),
        required: isRequiredField(fieldset, primary),
      });
    }

    // Remaining native controls.
    for (const control of form.querySelectorAll('input:not([type="hidden"]), textarea, select')) {
      if (control.disabled) continue;
      if (["submit", "button", "file", "search"].includes(control.type)) continue;
      if (control.id && (IGNORED_CONTROL_IDS.has(control.id) || IGNORED_CONTROL_ID_PATTERN.test(control.id))) continue;
      if (control.name && IGNORED_CONTROL_IDS.has(control.name)) continue;
      if ((control.type === "radio" || control.type === "checkbox") && Array.from(detectedChoiceFieldsets).some((fs) => fs.contains(control))) continue;
      if (!isElementVisible(control, { allowHiddenChoiceInput: true })) continue;
      const question = getFieldQuestion(control.closest("fieldset, .jv-input-group, div") || control, control);
      if (!question) continue;

      if (control.tagName === "SELECT") {
        addField({
          question,
          fieldIdBase: question,
          field: control,
          control,
          fieldKind: "select-native",
          options: getSelectOptionEntries(control).map((o) => o.text),
          required: isRequiredField(null, control),
        });
        continue;
      }
      if (control.tagName === "TEXTAREA") {
        addField({ question, fieldIdBase: question, field: control, control, fieldKind: "textarea", required: isRequiredField(null, control) });
        continue;
      }
      if (control.type === "checkbox") {
        // Standalone checkbox (e.g. LinkedIn visibility opt-in).
        addField({
          question,
          fieldIdBase: question,
          field: control.closest("div") || control,
          control,
          fieldKind: "checkbox-single",
          options: ["Yes", "No"],
          required: isRequiredField(null, control),
        });
        continue;
      }
      addField({ question, fieldIdBase: question, field: control, control, fieldKind: "text", required: isRequiredField(null, control) });
    }
    return entries;
  }

  // ---- submit / flow advance ---------------------------------------------

  function getFinalSubmitButton() {
    const form = getApplyForm();
    if (!form) return null;
    return (
      Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]'))
        .filter((button) => isElementVisible(button))
        .find((button) => SUBMIT_BUTTON_PATTERN.test(getActionLabel(button))) ?? null
    );
  }
  function getSubmitButton() {
    return getFinalSubmitButton();
  }
  // Only meaningful on the job posting page, before the application is opened.
  function getApplyButton() {
    if (getApplyForm() || getConsentForm()) return null;
    return (
      Array.from(document.querySelectorAll("a.jv-button-apply, a.jv-button, button"))
        .filter((element) => isElementVisible(element))
        .find((element) => {
          if (element.disabled || element.getAttribute("aria-disabled") === "true") return false;
          return APPLY_BUTTON_PATTERN.test(getActionLabel(element));
        }) ?? null
    );
  }
  function getConsentAcceptButton() {
    const form = document.querySelector('form[name="consentForm"]') || document;
    return (
      Array.from(form.querySelectorAll("button, a"))
        .filter((element) => isElementVisible(element) && !(element.disabled || element.getAttribute("aria-disabled") === "true"))
        .find((element) => /^\s*i\s+accept\b/i.test(getActionLabel(element))) ?? null
    );
  }

  /** Advance one step across the posting → consent → form boundary:
   *  - On the posting page, clicks "Apply"/"Apply Now" to open the consent
   *    gate or application form.
   *  - On the consent gate, clicks "I Accept" once the residence/language
   *    select has a value — the select is filled by a caller's own
   *    detectFields()+fillField() pass against the 'select-native'
   *    consent_location entry; this only waits for that value to be
   *    present (never picks or forces one itself) before proceeding past
   *    the legal attestation.
   *  Returns false once the real application form (or its final submit
   *  button) is already on screen — there's nothing left to advance. */
  async function advance({ shouldAbort = () => false } = {}) {
    if (getFinalSubmitButton() || getApplyForm() || shouldAbort()) return false;
    if (getConsentForm()) {
      const select = getConsentSelect();
      if (!select || !select.value) return false;
      const acceptButton = await waitFor(() => getConsentAcceptButton(), CONSENT_ACCEPT_WAIT_TIMEOUT_MS, shouldAbort);
      if (!acceptButton || shouldAbort()) return false;
      await clickLikeHuman(acceptButton, { shouldAbort });
      return true;
    }
    const applyButton = getApplyButton();
    if (!applyButton || shouldAbort()) return false;
    await clickLikeHuman(applyButton, { shouldAbort });
    return true;
  }

  function isAutofillAvailable() {
    return Boolean(getApplyForm() || getConsentForm() || getApplyButton());
  }

  // ---- filling ----------------------------------------------------------------

  async function setChoiceInput(input, shouldCheck, shouldAbort = () => false) {
    if (!input || input.checked === shouldCheck) return;
    const label = getLabelElementForControl(input);
    // Jobvite styles the native radio/checkbox off-screen with a custom
    // icon — the label row is what's actually clickable.
    await clickLikeHuman(label && isElementVisible(label) ? label : input, { shouldAbort });
    // AngularJS's ng-model listens for the change event; clicking the
    // label fires it, but force the state directly if the click didn't
    // take (e.g. a custom widget intercepted it).
    if (input.checked !== shouldCheck) {
      input.checked = shouldCheck;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // Resume/Cover-Letter/Portfolio share ONE file input, bound to
  // whichever attachment button opened #attachmentDropdown last — open
  // the Resume button's dropdown before looking for it.
  async function resolveResumeFileInput(shouldAbort) {
    const widgetButton = document.querySelector(`${RESUME_WIDGET_SELECTOR} ${ATTACHMENT_BUTTON_SELECTOR}`);
    if (!widgetButton || shouldAbort()) return null;
    await clickLikeHuman(widgetButton, { shouldAbort });
    return waitFor(() => {
      const dropdown = document.querySelector(ATTACHMENT_DROPDOWN_SELECTOR);
      if (!dropdown || !isElementVisible(dropdown)) return null;
      return dropdown.querySelector('input[type="file"]') || null;
    }, RESUME_DROPDOWN_WAIT_TIMEOUT_MS, shouldAbort);
  }

  /** Write an already-resolved answer into a question returned by
   *  detectFields(), dispatched by its fieldKind.
   *  @param {{question:string, field:Element, control:Element, fieldKind:string}} question
   *  @param {*} answer - string for text/textarea/select-native; string|
   *    string[]|boolean for radio/checkbox/checkbox-single;
   *    {type:"file", fileName, base64, mimeType} for resume.
   */
  async function fillField(question, answer, { shouldAbort = () => false } = {}) {
    const { field, control, fieldKind } = question;
    if (answer == null || shouldAbort()) return;

    switch (fieldKind) {
      case "text": {
        const input = getJobviteTextInput(control || field);
        if (input) fillTextInput(input, String(answer ?? ""));
        return;
      }
      case "textarea": {
        const textarea = getTextarea(control || field) || (control?.tagName === "TEXTAREA" ? control : null);
        if (textarea) fillTextInput(textarea, String(answer ?? ""));
        return;
      }
      case "select-native": {
        const select = getNativeSelect(control || field);
        if (!select) return;
        const match = findMatchingOption(answer, getSelectOptionEntries(field));
        if (match) fillSelectInput(select, match.value);
        return;
      }
      case "radio": {
        const match = findMatchingOption(answer, getChoiceOptionEntries(field, "radio", question.question));
        if (match?.input) await setChoiceInput(match.input, true, shouldAbort);
        return;
      }
      case "checkbox-single": {
        const checkbox = getCheckboxInputs(field)[0];
        if (checkbox) await setChoiceInput(checkbox, isAffirmativeAnswer(answer), shouldAbort);
        return;
      }
      case "checkbox": {
        const selections = toSelectionList(answer);
        for (const option of getChoiceOptionEntries(field, "checkbox", question.question)) {
          const shouldCheck = selections.includes(normalizeComparisonText(option.text)) || selections.includes(normalizeComparisonText(option.value));
          await setChoiceInput(option.input, shouldCheck, shouldAbort);
        }
        return;
      }
      case "resume": {
        if (!answer || typeof answer !== "object" || answer.type !== "file" || shouldAbort()) return;
        const fileInput = await resolveResumeFileInput(shouldAbort);
        if (fileInput && !shouldAbort()) fillFileInput(fileInput, answer.fileName, answer.base64, answer.mimeType);
        return;
      }
      default:
        return;
    }
  }

  NS.jobvite = {
    isAutofillAvailable,
    advance,
    detectFields,
    fillField,
    getSubmitButton,
  };
})();
