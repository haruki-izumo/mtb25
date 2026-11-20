/* =====================================================================
 * autofill/sites/indeed-autofill.js — Indeed's own apply flow
 * (indeed.com/beta/indeedapply/...). NOT smartapply.indeed.com — that host
 * carries no fillable form (see job-detect/sites/indeed-smartapply.js); it
 * is detection-only in BidHub's own source too.
 * =====================================================================
 * Ported from BidHub's packages/job-parsers/content/platforms/indeed/
 * autofill.js. Indeed's apply form has no stable name/id scheme at all —
 * every question is a generic `[data-testid$="-label"]`/div-soup wrapper, so
 * the bulk of this file is LABEL RESOLUTION (which element is the question
 * text vs. an option's own text vs. page chrome) and FIELD-KIND
 * CLASSIFICATION (plain input vs. a custom button-group acting as a radio
 * vs. a combobox), not value generation.
 *
 * Ported, structural-only:
 *   - apply-root detection (the question container ranks candidates by how
 *     many real fields they contain, since Indeed doesn't mark the form
 *     root itself)
 *   - field enumeration: label resolution, button-group/radio/checkbox
 *     grouping, resume/cover-letter slot detection, numeric-input
 *     constraints
 *   - value-filling per field kind (text, textarea, native select, radio,
 *     checkbox, custom button-group, autocomplete combobox, file upload)
 *   - the Next/Continue advance-button classifier for Indeed's multi-step
 *     apply flow
 *
 * Explicitly NOT ported (BidHub's own AI-answer backend / CAPTCHA / proxy /
 * password handling — same boundary as the bamboohr port):
 *   - the answerType -> getAnswer() routing (resume/cover-letter CONTENT
 *     generation, free-text screening-question answers, the embedding-
 *     similarity option matcher) — Big Banana's existing generic autofill
 *     pipeline already answers ordinary screening questions on its own;
 *     this file only hands it accurate field structure and writes whatever
 *     VALUE a caller supplies for a detected field.
 *   - the education-history REPEATABLE-SECTION hierarchy (BidHub's
 *     add-row/open-editor/save-per-entry iterator keyed off how many
 *     entries exist in BidHub's OWN profile backend, via
 *     getProfileSectionData() — a system this extension doesn't have).
 *     Indeed's education "Add another" append form is a perfectly ordinary
 *     labelled form underneath that iterator, though, so the plain field
 *     walk below detects its inputs (school, field of study, dates, …) the
 *     same way it detects everything else on the page — a caller fills one
 *     open entry at a time and clicks "Add another"/"Save and continue"
 *     through the generic advance()/button pipeline like any other step.
 *     No per-entry orchestration is attempted here.
 *   - detectSubmitButton/getSubmitButton: BidHub's own Indeed source never
 *     passes these to its generic engine either (only detectFields +
 *     advanceFlow) — Indeed's submit step rides the same Next/Continue
 *     advance-button detection as every other step, not a dedicated submit
 *     classifier.
 * ===================================================================== */
(function () {
  "use strict";
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    sleep, fillTextInput, fillTextInputWithoutBlur, fillFileInput, fillSelectInput, clickLikeHuman,
    getCheckboxInputs, getRadioInputs, getNativeSelect, getTextarea, getFileInputInsideField,
    getInputLabelText, getQuestionText, DEFAULT_TEXT_INPUT_SELECTOR,
  } = engine;

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});

  // ---- small local polling helper (BidHub's waitForPositiveResultWithAbort,
  // trimmed exactly like the bamboohr port — no shouldAbort plumbing since
  // this file never runs a cancellable background job the way BidHub's
  // auto-apply driver does) ----
  async function waitFor(check, timeoutMs, pollMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = check();
      if (result) return result;
      await sleep(pollMs);
    }
    return null;
  }

  const AUTOCOMPLETE_WAIT_TIMEOUT_MS = 3000;
  const FILE_UPLOAD_WAIT_TIMEOUT_MS = 5000;
  const AUTOFILL_ADVANCE_WAIT_MS = 1500;
  const MAX_BUTTON_GROUP_OPTIONS = 6;
  const REQUIRED_MARKER_PATTERN = /[✱*]/g;
  const BUTTON_GROUP_SELECTOR = 'button, [role="radio"], [role="option"]';
  const ADVANCE_BUTTON_TEXT_PATTERN = /^(continue|next)$/i;
  const TEXT_INPUT_TYPES = new Set(["text", "email", "tel", "url", "number", "search", "date", ""]);
  const IGNORED_OPTION_BUTTON_TEXT_PATTERN =
    /^(continue|next|back|submit|review|apply|cancel|skip|save|close|done|upload|browse|choose file|choose resume|attach|remove|delete|edit|add|previous)$/i;
  // The one page-chrome heading Indeed renders inside the question list
  // itself ("Current page") — everything else under .ia-Questions-item IS a
  // real question.
  const IGNORED_QUESTION_TEXT_PATTERN = /^(current page)$/i;
  const QUESTION_ITEM_SELECTOR = '.ia-Questions-item, [id^="q_"]';
  // Indeed's own question-prompt containers, tried before any generic
  // label/legend walk — these carry the actual question text even when the
  // field has no <label for> relationship to its control at all.
  const PROMPT_TEXT_SELECTORS = [
    '[data-testid$="-label"] [data-testid="safe-markup"]',
    '[data-testid$="-label"]',
    'label[id^="single-select-question-label"] [data-testid="safe-markup"]',
    'label[id^="single-select-question-label"]',
    'label[for^="rich-text-question-input"] [data-testid="safe-markup"]',
    'label[for^="rich-text-question-input"]',
  ];

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(REQUIRED_MARKER_PATTERN, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function slugifyFieldId(value) {
    return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  // Indeed's field identifiers are mostly cryptic testid/name strings
  // ("qualificationFields.0.name") rather than words — turned into a
  // readable fallback label when no real question text was found anywhere.
  function humanizeFieldIdentifier(identifier) {
    const normalized = String(identifier ?? "")
      .replace(/\[[^\]]+\]/g, " ")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_./-]+/g, " ");
    return normalizeText(normalized);
  }
  function cssEscapeValue(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // ---- visibility / control gating --------------------------------------

  function isElementVisible(element, { allowHiddenFileInput = false } = {}) {
    if (!element?.isConnected) return false;
    if (allowHiddenFileInput && element.tagName === "INPUT" && element.type === "file") return true;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function isControlDisabled(control) {
    return Boolean(control?.disabled) || control?.getAttribute?.("aria-disabled") === "true" || Boolean(control?.hasAttribute?.("disabled"));
  }
  function getControlLabel(control) {
    return normalizeText(control?.textContent || control?.value || control?.getAttribute?.("aria-label"));
  }
  // A Next/Continue button that EXISTS but sits under a closed accordion or
  // behind a sticky footer overlay is not actually clickable — this is the
  // same "is it really the thing under the pointer" check clickLikeHuman's
  // own scroll step assumes has already been satisfied, so advance button
  // candidates are ranked by it before any click is attempted.
  function isElementTopmostAtCenter(element) {
    if (!element?.isConnected) return false;
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    if (centerX < 0 || centerY < 0 || centerX > window.innerWidth || centerY > window.innerHeight) return false;
    return document.elementsFromPoint(centerX, centerY).some((hit) => hit === element || element.contains(hit));
  }

  function isApplyPage() {
    const { hostname, pathname } = window.location;
    const title = (document.title || "").toLowerCase();
    return hostname.includes("smartapply.indeed.com") || pathname.includes("/applystart") || pathname.includes("/beta/indeedapply") || title.includes("indeed apply");
  }

  function isOptionButtonControl(control) {
    if (!control) return false;
    // A button that OPENS a menu/listbox (a real combobox toggle) is not a
    // button-GROUP option — only a button that itself IS one of several
    // toggleable choices counts.
    if (control.getAttribute("aria-haspopup") === "listbox") return false;
    if (control.getAttribute("aria-expanded") && control.matches("button")) return false;
    const type = (control.getAttribute("type") || "").toLowerCase();
    if (type === "submit" || type === "reset") return false;
    const text = normalizeText(control.textContent || control.getAttribute("aria-label"));
    if (!text || IGNORED_OPTION_BUTTON_TEXT_PATTERN.test(text)) return false;
    return control.matches('[role="radio"], button[aria-pressed], button[aria-checked], button[role="radio"], button[role="option"]');
  }
  function isAutofillEligibleControl(control) {
    if (!control || control.disabled) return false;
    if (control.matches("select, textarea")) return isElementVisible(control);
    if (control.matches("input")) {
      const type = (control.type || "").toLowerCase();
      if (type === "hidden") return false;
      if (["submit", "reset", "button", "image"].includes(type)) return false;
      return isElementVisible(control, { allowHiddenFileInput: type === "file" });
    }
    if (isOptionButtonControl(control)) return isElementVisible(control);
    return false;
  }
  const AUTOFILL_CONTROL_SELECTOR = 'input, select, textarea, button[aria-pressed], button[aria-checked], [role="radio"], button[role="option"]';

  function getRootScore(root) {
    const controls = Array.from(root.querySelectorAll(AUTOFILL_CONTROL_SELECTOR)).filter(isAutofillEligibleControl);
    return controls.length + (root.tagName === "FORM" ? 50 : 0);
  }
  // Indeed's apply form carries no stable id/class of its own — rank every
  // plausible container by how many REAL fields it contains (a <form> gets
  // a flat bonus so it wins ties against a wrapper that happens to contain
  // the same controls) rather than guessing a single selector.
  function getApplyRoot() {
    if (!isApplyPage()) return null;
    const candidates = Array.from(new Set(document.querySelectorAll("main form, [role=\"main\"] form, form, [role=\"main\"], main"))).filter(isElementVisible);
    const ranked = candidates
      .map((root) => ({ root, score: getRootScore(root) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);
    return ranked[0]?.root ?? null;
  }

  // ---- advance (Next/Continue) -------------------------------------------

  function getAdvanceButtonCandidates() {
    const root = getApplyRoot();
    if (!root) return [];
    return Array.from(root.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]'))
      .filter((button) => isElementVisible(button) && !isControlDisabled(button))
      .filter((button) => ADVANCE_BUTTON_TEXT_PATTERN.test(getControlLabel(button)))
      .sort((left, right) => {
        const leftTopmost = isElementTopmostAtCenter(left) ? 1 : 0;
        const rightTopmost = isElementTopmostAtCenter(right) ? 1 : 0;
        if (leftTopmost !== rightTopmost) return rightTopmost - leftTopmost;
        const lr = left.getBoundingClientRect(), rr = right.getBoundingClientRect();
        return rr.top + rr.left - (lr.top + lr.left);
      });
  }
  async function clickCandidateButton(button) {
    if (!(button instanceof Element) || !isElementVisible(button) || isControlDisabled(button)) return false;
    button.scrollIntoView?.({ block: "center", inline: "nearest" });
    if (!isElementTopmostAtCenter(button)) return false;
    await clickLikeHuman(button);
    return true;
  }
  /** Click the first clickable Next/Continue candidate on the page. Never
   *  touches Submit/Apply/Review/etc — ADVANCE_BUTTON_TEXT_PATTERN only
   *  matches the literal words "Continue"/"Next", same gate BidHub's own
   *  source uses. Returns whether anything was actually clicked. */
  async function advance() {
    for (const button of getAdvanceButtonCandidates()) {
      if (await clickCandidateButton(button)) {
        await sleep(0); // let the click's own handlers run before the caller re-detects
        return true;
      }
    }
    return false;
  }

  // ---- label / question-text resolution ----------------------------------

  function getComboboxInput(field) {
    if (!field) return null;
    if (field.matches?.('input[role="combobox"], input[aria-autocomplete="list"]')) return field;
    return field.querySelector('input[role="combobox"], input[aria-autocomplete="list"]');
  }
  function getIndeedTextInput(field) {
    if (!field) return null;
    if (field.tagName === "INPUT") {
      const type = (field.type || "").toLowerCase();
      return TEXT_INPUT_TYPES.has(type) ? field : null;
    }
    return field.querySelector(DEFAULT_TEXT_INPUT_SELECTOR);
  }
  function getChoiceInputLabelText(input, fallbackQuestion = "") {
    return normalizeText(
      getInputLabelText(input, fallbackQuestion) || input?.labels?.[0]?.textContent || input?.value || fallbackQuestion
    );
  }
  function getButtonOptions(field) {
    const buttonElements = field?.matches?.(BUTTON_GROUP_SELECTOR) ? [field] : Array.from(field?.querySelectorAll?.(BUTTON_GROUP_SELECTOR) ?? []);
    return buttonElements
      .filter((button) => isOptionButtonControl(button) && isElementVisible(button))
      .map((button) => ({ button, text: normalizeText(button.textContent || button.getAttribute("aria-label")) }))
      .filter((option) => option.text);
  }
  function getAriaLabelledText(element) {
    const labelledBy = element?.getAttribute?.("aria-labelledby");
    if (!labelledBy) return "";
    return normalizeText(labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
  }
  function getQuestionItem(element) {
    return element?.closest?.(QUESTION_ITEM_SELECTOR) ?? null;
  }
  function getQuestionPromptText(field, optionTexts = []) {
    const scope = getQuestionItem(field) || field;
    const normalizedOptionTexts = new Set(optionTexts.map((text) => normalizeText(text).toLowerCase()));
    for (const selector of PROMPT_TEXT_SELECTORS) {
      const promptElement = scope?.querySelector?.(selector);
      const promptText = normalizeText(promptElement?.textContent);
      if (promptText && !normalizedOptionTexts.has(promptText.toLowerCase())) return promptText;
    }
    return "";
  }
  function getQuestionTextFromElement(element) {
    if (!element) return "";
    return normalizeText(getQuestionText(element) || element.textContent);
  }
  // Single-control question text, tried in the same priority order BidHub's
  // own source uses: explicit ARIA naming first (most reliable when
  // present), then Indeed's own prompt containers, then a placeholder, and
  // only as a last resort a slugified name/id/testid.
  function getControlQuestionText(control) {
    const ariaLabel = normalizeText(control?.getAttribute?.("aria-label"));
    if (ariaLabel) return ariaLabel;
    const labelledBy = getAriaLabelledText(control);
    if (labelledBy) return labelledBy;
    const labelText = normalizeText(getInputLabelText(control));
    if (labelText) return labelText;
    const promptText = getQuestionPromptText(control);
    if (promptText) return promptText;
    const placeholder = normalizeText(control?.getAttribute?.("placeholder"));
    if (placeholder) return placeholder;
    return humanizeFieldIdentifier(control?.name || control?.id || control?.getAttribute?.("data-testid"));
  }
  function isQuestionCandidateElement(element, normalizedOptionTexts) {
    if (!isElementVisible(element)) return false;
    const text = getQuestionTextFromElement(element);
    if (!text || normalizedOptionTexts.has(text.toLowerCase()) || text.length > 120) return false;
    // A wrapper that itself contains interactive controls is the GROUP, not
    // its label — unless it's the tag that's allowed to BE the label
    // (<label>/<legend> wrapping its own control, a normal HTML pattern).
    const containsInteractiveDescendants = Boolean(element.querySelector('input, select, textarea, button, [role="radio"]'));
    return !containsInteractiveDescendants || element.matches("label, legend");
  }
  // Question text for a GROUP of controls (radio set, checkbox set, button
  // group): ARIA naming, then Indeed's prompt containers, then a <legend>,
  // then the first plausible label-ish element that isn't one of the
  // option's own texts, then (last resort) the first control's own label.
  function getGroupQuestionText(field, optionTexts = []) {
    const ariaLabel = normalizeText(field?.getAttribute?.("aria-label"));
    if (ariaLabel) return ariaLabel;
    const labelledBy = getAriaLabelledText(field);
    if (labelledBy) return labelledBy;
    const promptText = getQuestionPromptText(field, optionTexts);
    if (promptText) return promptText;
    const legendText = getQuestionTextFromElement(field?.querySelector?.("legend"));
    if (legendText) return legendText;
    const normalizedOptionTexts = new Set(optionTexts.map((text) => normalizeText(text).toLowerCase()));
    const candidates = Array.from(field?.querySelectorAll?.('label, [role="heading"], h1, h2, h3, h4, h5, h6, p, span, div') ?? []);
    const candidate = candidates.find((element) => isQuestionCandidateElement(element, normalizedOptionTexts));
    if (candidate) return getQuestionTextFromElement(candidate);
    const fallbackControl = getCheckboxInputs(field)[0] || getRadioInputs(field)[0];
    return fallbackControl ? getControlQuestionText(fallbackControl) : "";
  }
  function isIgnoredQuestionText(question) {
    return IGNORED_QUESTION_TEXT_PATTERN.test(normalizeText(question));
  }

  // ---- numeric text inputs -----------------------------------------------

  function isIndeedNumericInput(input) {
    if (!input?.matches?.("input")) return false;
    const type = (input.type || "").toLowerCase();
    const inputMode = (input.getAttribute?.("inputmode") || "").toLowerCase();
    return type === "number" || ["numeric", "decimal"].includes(inputMode) || input.hasAttribute?.("min") || input.hasAttribute?.("max");
  }
  function clampNumberToInputRange(value, input) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return value;
    const min = Number(input?.getAttribute?.("min"));
    const max = Number(input?.getAttribute?.("max"));
    let clamped = numericValue;
    if (Number.isFinite(min)) clamped = Math.max(clamped, min);
    if (Number.isFinite(max)) clamped = Math.min(clamped, max);
    return String(clamped);
  }
  function fillIndeedTextInput(input, answer) {
    if (!input) return;
    if (!isIndeedNumericInput(input)) {
      fillTextInput(input, answer);
      return;
    }
    const rawValue = normalizeText(answer);
    const numericMatch = rawValue.match(/-?\d+(?:\.\d+)?/);
    fillTextInput(input, numericMatch ? clampNumberToInputRange(numericMatch[0], input) : rawValue);
  }

  // ---- resume / cover-letter slot detection --------------------------------

  function isResumeField(question, control) {
    const normalizedQuestion = normalizeText(question).toLowerCase();
    const controlName = (control?.name || "").toLowerCase();
    const controlId = (control?.id || "").toLowerCase();
    return /resume|cv/.test(normalizedQuestion) || /resume|cv/.test(controlName) || /resume|cv/.test(controlId);
  }
  function isCoverLetterField(question, control) {
    const normalizedQuestion = normalizeText(question).toLowerCase();
    const controlName = (control?.name || "").toLowerCase();
    const controlId = (control?.id || "").toLowerCase();
    return /cover\s*letter/.test(normalizedQuestion) || /cover_?letter/.test(controlName) || /cover_?letter/.test(controlId);
  }

  // ---- per-control field-kind classification ------------------------------
  // Trimmed version of BidHub's getFieldMetadataSync: drops the
  // answerType/constraints the AI backend wanted and keeps only what a
  // caller needs to know HOW to write a value — the field's shape.

  function classifyField(field, question) {
    const fileInput = getFileInputInsideField(field);
    if (fileInput) {
      if (isResumeField(question, fileInput)) return { fieldKind: "resume", control: fileInput, options: null };
      if (isCoverLetterField(question, fileInput)) return { fieldKind: "cover_letter", control: fileInput, options: null };
      return null;
    }
    const buttonOptions = getButtonOptions(field);
    if (buttonOptions.length >= 2 && buttonOptions.length <= MAX_BUTTON_GROUP_OPTIONS) {
      return { fieldKind: "button-group", control: buttonOptions[0]?.button ?? null, options: buttonOptions.map((o) => o.text) };
    }
    const radioInputs = getRadioInputs(field);
    if (radioInputs.length > 0) {
      return { fieldKind: "radio", control: radioInputs[0], options: radioInputs.map((input) => getChoiceInputLabelText(input, question)).filter(Boolean) };
    }
    const checkboxInputs = getCheckboxInputs(field);
    if (checkboxInputs.length > 0) {
      const options = checkboxInputs.map((input) => getChoiceInputLabelText(input, question)).filter(Boolean);
      return { fieldKind: "checkbox", control: checkboxInputs[0], options: checkboxInputs.length === 1 ? ["Yes"] : options };
    }
    const select = getNativeSelect(field);
    if (select) {
      const options = Array.from(select.querySelectorAll("option")).filter((o) => o.value).map((o) => normalizeText(o.textContent)).filter(Boolean);
      return { fieldKind: "select-native", control: select, options };
    }
    const textarea = getTextarea(field);
    if (textarea) {
      return { fieldKind: isCoverLetterField(question, textarea) ? "cover_letter" : "textarea", control: textarea, options: [] };
    }
    const combobox = getComboboxInput(field);
    if (combobox) {
      return { fieldKind: "combobox", control: combobox, options: [] };
    }
    const textInput = getIndeedTextInput(field);
    if (textInput) {
      return { fieldKind: isCoverLetterField(question, textInput) ? "cover_letter" : "text", control: textInput, options: [] };
    }
    return null;
  }

  // ---- grouping a loose control into its question's FIELD element --------

  function findCommonAncestor(elements, root) {
    const nodes = elements.filter(Boolean);
    if (nodes.length === 0) return null;
    if (nodes.length === 1) return nodes[0];
    let current = nodes[0]?.parentElement ?? null;
    while (current && current !== root.parentElement) {
      if (nodes.every((node) => current.contains(node))) return current;
      current = current.parentElement;
    }
    return root;
  }
  function hasUnrelatedAutofillControls(container, groupedControls) {
    const groupedSet = new Set(groupedControls);
    return Array.from(container?.querySelectorAll?.(AUTOFILL_CONTROL_SELECTOR) ?? [])
      .filter(isAutofillEligibleControl)
      .some((candidate) => !groupedSet.has(candidate));
  }
  // Indeed doesn't wrap most radio/checkbox groups in a <fieldset> — walk up
  // from the control until a <fieldset> is found, or a container that (a)
  // holds every input sharing this control's name and (b) nothing else
  // fillable, and (c) has its own distinct question text (not just the
  // option labels repeated back).
  function getChoiceGroupField(root, control) {
    const fieldset = control.closest("fieldset");
    if (fieldset && isElementVisible(fieldset)) return fieldset;
    const type = (control.type || "").toLowerCase();
    const name = control.name?.trim?.();
    const groupedControls = name
      ? Array.from(root.querySelectorAll(`input[type="${type}"][name="${cssEscapeValue(name)}"]`)).filter(isAutofillEligibleControl)
      : [control];
    const optionTexts = groupedControls.map((input) => getChoiceInputLabelText(input)).filter(Boolean);
    const normalizedOptionTexts = new Set(optionTexts.map((text) => normalizeText(text).toLowerCase()));
    let current = groupedControls.length > 1 ? findCommonAncestor(groupedControls, root) || control : control;
    while (current && current !== root.parentElement) {
      if (hasUnrelatedAutofillControls(current, groupedControls)) break;
      const questionText = getGroupQuestionText(current, optionTexts);
      if (questionText && !normalizedOptionTexts.has(normalizeText(questionText).toLowerCase())) return current;
      if (current === root) break;
      current = current.parentElement;
    }
    return groupedControls.length > 1 ? findCommonAncestor(groupedControls, root) || control : control;
  }
  // A custom button-group's "field" is its nearest ancestor that contains
  // ONLY choice-like controls (2-6 option buttons, no stray text/select
  // inputs) — distinguishes an actual single-select button row from a
  // toolbar that merely happens to contain a couple of buttons.
  function getButtonGroupContainer(control, root) {
    let current = control.parentElement;
    while (current && current !== root) {
      const buttonOptions = getButtonOptions(current);
      const onlyChoiceLikeControls = current.querySelectorAll('input:not([type="radio"]):not([type="checkbox"]), select, textarea').length === 0;
      if (onlyChoiceLikeControls && buttonOptions.length >= 2 && buttonOptions.length <= MAX_BUTTON_GROUP_OPTIONS) return current;
      current = current.parentElement;
    }
    return null;
  }

  function getVisibleAutofillControls(root) {
    return Array.from(root.querySelectorAll(AUTOFILL_CONTROL_SELECTOR)).filter(isAutofillEligibleControl);
  }

  // ---- field enumeration ---------------------------------------------------

  /** Enumerate every fillable field on the current Indeed apply step:
   *  {question, fieldId, fieldKind, field, control, options, isResume,
   *  isCoverLetter}. Grouped controls (radio/checkbox/button-group) collapse
   *  to ONE entry each; a resume/cover-letter file input gets a STABLE
   *  fieldId ('resume'/'cover_letter') since Indeed can re-render the
   *  upload widget between detection passes. */
  function detectFields() {
    const root = getApplyRoot();
    if (!root) return [];
    const entries = [];
    const usedFieldIds = new Set();
    const processedControls = new WeakSet();
    // The education append-form/review-page IS a plain `form`/container with
    // ordinary labelled inputs, so it legitimately wins getApplyRoot()'s own
    // scoring while that step is showing — its rows are now owned by the
    // dedicated section-hierarchy port below (same
    // getIndeedEducationReviewPage()/getIndeedEducationAppendForm() helpers
    // INDEED_EDUCATION_SECTION's own getContainer() uses), so skip them here
    // to avoid showing every field twice in the review list.
    const educationSectionContainer = getIndeedEducationReviewPage() || getIndeedEducationAppendForm();

    for (const control of getVisibleAutofillControls(root)) {
      if (educationSectionContainer?.contains(control)) continue;
      if (processedControls.has(control)) continue;
      let field = control;
      let question = "";

      if (isOptionButtonControl(control)) {
        const buttonGroupField = getButtonGroupContainer(control, root);
        if (!buttonGroupField) continue;
        const options = getButtonOptions(buttonGroupField);
        options.forEach(({ button }) => processedControls.add(button));
        field = buttonGroupField;
        question = getGroupQuestionText(field, options.map((o) => o.text));
      } else if (control.tagName === "INPUT" && ["radio", "checkbox"].includes((control.type || "").toLowerCase())) {
        field = getChoiceGroupField(root, control);
        const groupControls = control.type === "radio" ? getRadioInputs(field) : getCheckboxInputs(field);
        groupControls.forEach((input) => processedControls.add(input));
        question = getGroupQuestionText(field, groupControls.map((input) => getChoiceInputLabelText(input))) || getControlQuestionText(control);
      } else {
        processedControls.add(control);
        question = getControlQuestionText(control);
      }

      if (isIgnoredQuestionText(question)) continue;
      const classified = classifyField(field, question);
      if (!classified) continue;

      const stableDocumentFieldId = classified.fieldKind === "resume" ? "resume" : classified.fieldKind === "cover_letter" && getFileInputInsideField(field) ? "cover_letter" : null;
      if (stableDocumentFieldId) {
        if (usedFieldIds.has(stableDocumentFieldId)) continue;
        const fileInput = getFileInputInsideField(field);
        if (fileInput) processedControls.add(fileInput);
      }

      const resolvedQuestion =
        stableDocumentFieldId === "resume" ? "Resume/CV"
        : stableDocumentFieldId === "cover_letter" ? "Cover Letter"
        : question || humanizeFieldIdentifier(classified.control?.name || classified.control?.id || field.id);
      if (!resolvedQuestion) continue;

      let fieldId = stableDocumentFieldId;
      if (stableDocumentFieldId) {
        usedFieldIds.add(stableDocumentFieldId);
      } else {
        const baseFieldId = classified.control?.name || classified.control?.id || field.id || slugifyFieldId(resolvedQuestion);
        if (!baseFieldId) continue;
        fieldId = baseFieldId;
        if (usedFieldIds.has(fieldId)) {
          let suffix = 2;
          while (usedFieldIds.has(`${baseFieldId}-${suffix}`)) suffix += 1;
          fieldId = `${baseFieldId}-${suffix}`;
        }
        usedFieldIds.add(fieldId);
      }

      entries.push({
        question: resolvedQuestion,
        fieldId,
        fieldKind: classified.fieldKind,
        field,
        control: classified.control,
        options: classified.options,
        isResume: classified.fieldKind === "resume",
        isCoverLetter: classified.fieldKind === "cover_letter",
      });
    }
    return entries;
  }

  // ---- option matching -----------------------------------------------------

  function getSelectOptionEntries(field) {
    const select = getNativeSelect(field);
    if (!select) return [];
    return Array.from(select.querySelectorAll("option"))
      .filter((option) => option.value)
      .map((option) => ({ value: option.value, text: normalizeText(option.textContent) }))
      .filter((option) => option.text);
  }
  function getComboboxOptions() {
    return Array.from(document.querySelectorAll('[role="listbox"] [role="option"], [role="listbox"] button, [role="option"]'))
      .filter(isElementVisible)
      .map((option) => ({ element: option, text: normalizeText(option.textContent || option.getAttribute("aria-label")) }))
      .filter((option) => option.text);
  }
  // Exact (normalized) match first, else substring either direction. BidHub's
  // own fallback beyond this point was an AI embedding-similarity call —
  // that's the out-of-scope AI-answer backend (see header comment), so a
  // looser-than-substring miss here returns null and leaves the field for
  // Big Banana's existing generic pipeline to try instead of guessing.
  function getBestMatchingOption(answer, options) {
    if (!Array.isArray(options) || options.length === 0) return null;
    const normalizedAnswer = normalizeText(Array.isArray(answer) ? answer[0] : answer).toLowerCase();
    if (!normalizedAnswer) return null;
    const exact = options.find((option) => option.text.toLowerCase() === normalizedAnswer);
    if (exact) return exact;
    return options.find((option) => {
      const text = option.text.toLowerCase();
      return text && (text.includes(normalizedAnswer) || normalizedAnswer.includes(text));
    }) ?? null;
  }

  // ---- custom autocomplete combobox (typeahead + listbox) -----------------

  /** Type into Indeed's custom combobox, wait for its listbox to render, and
   *  click the best-matching option; falls back to just committing the typed
   *  text (blur) when no option list ever appears or nothing matches. */
  async function fillCombobox(input, answer) {
    if (!input || answer == null || answer === "") return;
    fillTextInputWithoutBlur(input, String(answer));
    const options = await waitFor(() => {
      const liveOptions = getComboboxOptions();
      return liveOptions.length ? liveOptions : null;
    }, AUTOCOMPLETE_WAIT_TIMEOUT_MS, 100);
    const selected = options ? getBestMatchingOption(answer, options) : null;
    if (selected?.element) {
      selected.element.click();
    } else {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
    }
  }

  // ---- file upload (resume / cover letter) ---------------------------------

  function getFileFieldScope(field) {
    return field?.closest?.("fieldset, label, li, section, article, div") || field?.parentElement || field;
  }
  /** Re-expose a resume/cover-letter slot's native `<input type=file>` —
   *  Indeed swaps the upload control for a "<filename> [Remove]" chip once a
   *  file is attached, so re-attaching needs that chip's Remove button
   *  clicked first before the input exists to drive again. */
  async function ensureFileInput(field) {
    const existing = getFileInputInsideField(field) || getFileInputInsideField(getFileFieldScope(field));
    if (existing) return existing;
    const scope = getFileFieldScope(field);
    const removeButton = Array.from(scope?.querySelectorAll?.('button, [role="button"]') ?? []).find((button) =>
      /\b(remove|replace|delete)\b/i.test(normalizeText(button.textContent || button.getAttribute("aria-label")))
    );
    if (!removeButton) return null;
    removeButton.click();
    return waitFor(() => getFileInputInsideField(scope) || getFileInputInsideField(field), FILE_UPLOAD_WAIT_TIMEOUT_MS, 100);
  }
  function isButtonActive(button) {
    return (
      button?.getAttribute?.("aria-pressed") === "true" ||
      button?.getAttribute?.("aria-checked") === "true" ||
      button?.getAttribute?.("aria-selected") === "true" ||
      /\b(active|selected|checked)\b/i.test(button?.className ?? "")
    );
  }

  /** Write `answer` into a detected field entry, using the mechanism its
   *  fieldKind needs. For 'radio'/'checkbox'/'select-native'/'button-group',
   *  `answer` is matched against the field's own option text (see
   *  getBestMatchingOption) rather than written verbatim. For 'resume', and
   *  for 'cover_letter' when the answer is an object, `answer` is
   *  `{fileName, base64, mimeType}`; a 'cover_letter' STRING answer fills
   *  whatever text control (textarea or plain input) the slot actually is.
   *  Returns true on an apparent success. */
  async function fillField(entry, answer) {
    if (!entry || answer == null) return false;
    const { fieldKind, field, control } = entry;
    switch (fieldKind) {
      case "text": {
        const input = control || getIndeedTextInput(field);
        if (!input) return false;
        fillIndeedTextInput(input, answer);
        return true;
      }
      case "textarea": {
        const textarea = control || getTextarea(field);
        if (!textarea) return false;
        fillTextInput(textarea, answer);
        return true;
      }
      case "select-native": {
        const select = control || getNativeSelect(field);
        if (!select) return false;
        const best = getBestMatchingOption(answer, getSelectOptionEntries(field));
        if (!best) return false;
        fillSelectInput(select, best.value);
        return true;
      }
      case "radio": {
        const options = getRadioInputs(field).map((input) => ({ input, text: getChoiceInputLabelText(input) })).filter((o) => o.text);
        const best = getBestMatchingOption(answer, options);
        if (!best?.input) return false;
        const label = best.input.labels?.[0];
        if (label) {
          await clickLikeHuman(label);
        } else if (!best.input.checked) {
          await clickLikeHuman(best.input);
        }
        best.input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      case "checkbox": {
        const requested = (Array.isArray(answer) ? answer : [answer]).map((v) => normalizeText(v).toLowerCase()).filter(Boolean);
        if (!requested.length) return false;
        const checkboxInputs = getCheckboxInputs(field);
        for (const checkbox of checkboxInputs) {
          const label = getChoiceInputLabelText(checkbox).toLowerCase();
          const value = normalizeText(checkbox.value).toLowerCase();
          const shouldCheck = typeof answer === "boolean" ? answer : requested.includes(label) || requested.includes(value) || (checkboxInputs.length === 1 && requested.includes("yes"));
          if (checkbox.checked !== shouldCheck) {
            await clickLikeHuman(checkbox);
            checkbox.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        return true;
      }
      case "button-group": {
        const best = getBestMatchingOption(answer, getButtonOptions(field));
        if (!best?.button) return false;
        if (!isButtonActive(best.button)) await clickLikeHuman(best.button);
        return true;
      }
      case "combobox": {
        const input = control || getComboboxInput(field);
        if (!input) return false;
        await fillCombobox(input, answer);
        return true;
      }
      case "resume": {
        if (!answer || typeof answer !== "object") return false;
        const input = await ensureFileInput(field);
        if (!input) return false;
        fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        return true;
      }
      case "cover_letter": {
        if (typeof answer === "string") {
          const textarea = getTextarea(field);
          const textInput = getIndeedTextInput(field);
          if (textarea) fillTextInput(textarea, answer);
          else if (textInput) fillIndeedTextInput(textInput, answer);
          else return false;
          return true;
        }
        if (typeof answer !== "object") return false;
        const input = await ensureFileInput(field);
        if (!input) return false;
        fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        return true;
      }
      default:
        return false;
    }
  }

  function isAutofillAvailable() {
    return Boolean(getApplyRoot() && detectFields().length);
  }

  // ---- repeatable Education-history section (editor mode) -----------------
  // Indeed's apply flow has no work-history section at all — education only.
  // Ported from BidHub's own Indeed section descriptor, driven by the shared
  // engine/section-hierarchy.js (root->group->leaf model). detectFields()
  // above knows nothing about this block — Indeed's education page is a
  // dedicated step (either a review list of saved cards, or the "add
  // another" append form), not interleaved with ordinary questions, so there
  // is no double-detection risk to guard against the way Greenhouse/Ashby
  // need to.
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  // BCD's Profile.education stores dates as a raw month-input string
  // ("2022-01") or empty for ongoing — split into month/year parts the way
  // greenhouse-autofill.js's own parseMonthYear does.
  function parseIndeedMonthYear(raw) {
    const s = String(raw || "").trim();
    const m = /^(\d{4})-(\d{1,2})$/.exec(s);
    if (m) return { year: m[1], month: String(parseInt(m[2], 10)) };
    const d = s ? new Date(s) : null;
    if (d && !Number.isNaN(d.getTime())) return { year: String(d.getFullYear()), month: String(d.getMonth() + 1) };
    return { year: "", month: "" };
  }
  const monthFromRaw = (raw) => parseIndeedMonthYear(raw).month;
  const yearFromRaw = (raw) => parseIndeedMonthYear(raw).year;
  function monthNumToName(monthNum) {
    const idx = parseInt(monthNum, 10);
    return idx >= 1 && idx <= 12 ? MONTH_NAMES[idx - 1] : "";
  }

  function getIndeedEducationCards() {
    return Array.from(document.querySelectorAll('[data-testid="education-card-delete-btn"]'))
      .map((button) => button.closest("li"))
      .filter(Boolean);
  }

  function getIndeedEducationReviewPage() {
    return document.querySelector('[data-testid="education-page-review"]');
  }
  function getIndeedEducationAppendForm() {
    return document.querySelector('form[data-testid="education-page-append"]');
  }

  async function addIndeedEducationRow(container) {
    const scopes = [container, getIndeedEducationReviewPage(), document].filter(Boolean);
    for (const scope of scopes) {
      const button = Array.from(scope.querySelectorAll("button")).find((b) => /^add another$/i.test((b.textContent || "").trim()));
      if (button) {
        await clickLikeHuman(button);
        return;
      }
    }
  }

  // Deletes every existing education card one at a time (delete -> confirm
  // dialog -> wait) — Indeed gates each delete behind a confirm dialog, so a
  // batch delete (click every delete button first) isn't safe here.
  async function clearIndeedEducationCards() {
    for (let attempt = 0; attempt < 20; attempt++) {
      const deleteButton = document.querySelector('[data-testid="education-card-delete-btn"]');
      if (!deleteButton) return;
      await clickLikeHuman(deleteButton);
      await sleep(250);
      const dialog = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).find((d) => isElementVisible(d));
      const confirmButton = Array.from(dialog?.querySelectorAll("button, [role=\"button\"]") ?? []).find(
        (b) => isElementVisible(b) && /\b(delete|remove|yes|confirm)\b/i.test((b.textContent || "").trim())
      );
      if (confirmButton) await clickLikeHuman(confirmButton);
      await sleep(250);
    }
  }

  async function saveIndeedEducationForm(container) {
    const form = container && container.matches?.('form[data-testid="education-page-append"]') ? container : getIndeedEducationAppendForm() || container;
    if (!form) return;
    const saveButton =
      form.querySelector?.('[data-testid="education-page-append-save-button"]') ||
      Array.from(form.querySelectorAll?.("button") ?? []).find((b) => /\bsave\b/i.test((b.textContent || "").trim()));
    if (!saveButton) return;
    await clickLikeHuman(saveButton);
    await waitFor(() => !getIndeedEducationAppendForm() || getIndeedEducationReviewPage(), 5000, 150);
  }

  // No `major`/`discipline`/`location` field exists on BCD's
  // Profile.education schema (school/degree/start/end only) — Field of
  // Study/Location still detect (visible/editable in the review list), they
  // just have nothing to auto-fill from.
  const INDEED_EDUCATION_SECTION = {
    rootFieldId: "educationHistory",
    rootQuestion: "Education history",
    profileSection: "education",
    rowLabel: (i) => `Education ${i + 1}`,
    rowGrowthTimeoutMs: 5000,
    maxEntries: 5,
    getContainer: () => getIndeedEducationReviewPage() || getIndeedEducationAppendForm(),
    getRows: getIndeedEducationCards,
    getEditor: getIndeedEducationAppendForm,
    getRowField: (rowEl, mapping) => {
      const field = rowEl.querySelector(`[data-testid="${mapping.testId}"]`);
      return field ? { field } : null;
    },
    addRow: addIndeedEducationRow,
    clearRows: clearIndeedEducationCards,
    saveEntry: (container, row) => saveIndeedEducationForm(container || row),
    mappings: [
      { key: "level", testId: "education-qualification-fields-level-of-education-input", fieldKind: "text", question: "Level of Education", label: "Level of Education", profileKey: "degree" },
      { key: "fieldOfStudy", testId: "education-qualification-fields-field-of-study-input", fieldKind: "text", question: "Field of Study", label: "Field of Study" },
      { key: "school", testId: "education-qualification-fields-school-input", fieldKind: "text", question: "School", label: "School", profileKey: "school" },
      { key: "location", testId: "education-qualification-fields-location-locality-input", fieldKind: "text", question: "Location", label: "Location" },
      { key: "fromMonth", testId: "education-qualification-fields-date-from-month", fieldKind: "dropdown", question: "From Month", label: "From Month", resolveValue: (e) => monthNumToName(monthFromRaw(e?.start)) || null },
      { key: "fromYear", testId: "education-qualification-fields-date-from-year", fieldKind: "dropdown", question: "From Year", label: "From Year", resolveValue: (e) => yearFromRaw(e?.start) || null },
      { key: "toMonth", testId: "education-qualification-fields-date-to-month", fieldKind: "dropdown", question: "To Month", label: "To Month", resolveValue: (e) => monthNumToName(monthFromRaw(e?.end)) || null },
      { key: "toYear", testId: "education-qualification-fields-date-to-year", fieldKind: "dropdown", question: "To Year", label: "To Year", resolveValue: (e) => yearFromRaw(e?.end) || null },
    ],
  };

  const SECTIONS = [INDEED_EDUCATION_SECTION];

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections(SECTIONS, profileData);
  }

  async function fillSectionLeaf(field, mapping, value) {
    switch (mapping.fieldKind) {
      case "text":
        // Awaited (not fire-and-forget) — the next step in the fill loop is
        // often another addRow()/saveEntry() click that re-renders the
        // form, which must not fire while this value's short React-state-
        // restore reassert window is still in flight.
        await engine.fillTextInputReliably(field, value);
        return;
      case "dropdown": {
        if (field.tagName === "SELECT") {
          const match = Array.from(field.querySelectorAll("option"))
            .filter((o) => o.value)
            .find((o) => (o.innerText || o.textContent).trim() === value);
          if (match) fillSelectInput(field, match.getAttribute("value"));
          return;
        }
        // Not a native <select> — Indeed's own custom listbox widget;
        // typed-search + option click, same mechanic as the generic
        // combobox fields elsewhere in this file.
        await fillCombobox(field, value);
        return;
      }
      default:
        return;
    }
  }

  async function fillSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    const results = [];
    for (const section of SECTIONS) {
      const entries = (profileData && profileData[section.profileSection]) || [];
      if (!entries.length) continue;
      const result = await SECTION_HIERARCHY.fillSection(section, entries, fillSectionLeaf);
      results.push({ rootFieldId: section.rootFieldId, ...result });
    }
    return results;
  }

  NS.indeed = {
    isApplyPage,
    isAutofillAvailable,
    detectFields,
    fillField,
    advance,
    detectSections,
    fillSections,
  };
})();
