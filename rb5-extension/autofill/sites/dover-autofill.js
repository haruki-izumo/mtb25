/* =====================================================================
 * autofill/sites/dover-autofill.js — Dover (app.dover.io / app.dover.com)
 * application forms.
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/dover/autofill.js. That file's
 * own field-filling MECHANICS are NOT re-implemented here — they're
 * exactly what autofill/engine/dom-interactions.js already provides as
 * window.ProactiveAutofillEngine, so this file calls into that instead.
 *
 * OUT OF SCOPE (left to Big Banana's own existing systems, untouched):
 *   - Free-text screening-question ANSWER GENERATION (BidHub's
 *     getAnswer()/ai-core backend) and the per-field "constraints"
 *     metadata (maxLength/pattern/inputType/…) that only existed to feed
 *     that backend's prompting. detectFields() below only classifies
 *     each question's structural fieldKind and locates its control.
 *   - The embedding-similarity fallback in BidHub's own
 *     getBestMatchingOption() — only its exact-text/value match is
 *     ported; a looser miss is left for Big Banana's generic pipeline.
 *   - dependsOnPrevious / dependent-question sequencing — that only
 *     mattered for ordering AI-generated answers.
 *   - Cloudflare Turnstile. Dover gates submission behind an EXECUTE-mode
 *     Turnstile widget that fires on submit — this file clicks Submit
 *     like any other button and leaves whatever Turnstile does after
 *     that completely alone.
 * ===================================================================== */
(function () {
  "use strict";

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    sleep,
    fillTextInput,
    fillFileInput,
    clickLikeHuman,
    getCheckboxInputs,
    getRadioInputs,
    getTextarea,
    getTextInput,
    getFileInputInsideField,
  } = engine;

  const FILE_INPUT_WAIT_TIMEOUT_MS = 3000;
  const REQUIRED_MARKER_PATTERN = /\*/g;

  // Dover's "First Name"/"Last Name"/etc. standard fields render with no
  // derivable label text next to the control at all (the visible copy is
  // MUI placeholder-only) — key off the control's own `name` instead.
  const STANDARD_FIELD_QUESTIONS = {
    firstName: "First Name",
    lastName: "Last Name",
    email: "Email",
    linkedinUrl: "LinkedIn Profile URL",
    phoneNumber: "Phone Number",
  };

  function normalizeDoverText(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(/[​﻿]/g, "")
      .replace(REQUIRED_MARKER_PATTERN, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function normalizeComparisonText(value) {
    return normalizeDoverText(value).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }
  function slugifyFieldId(value) {
    return normalizeComparisonText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function isElementVisible(element, { allowHiddenInput = false } = {}) {
    if (!element?.isConnected) return false;
    if (allowHiddenInput && element.matches?.('input[type="file"], input[type="radio"], input[type="checkbox"]')) {
      return true;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Dover's form picker — the application form is usually the ONLY form
  // on the page, but score by field density anyway (a file input counts
  // for 4, a submit button for 2) in case a tenant renders an extra
  // (e.g. newsletter signup) form alongside it.
  function getDoverForm() {
    const forms = Array.from(document.querySelectorAll("form"))
      .filter((form) => isElementVisible(form))
      .map((form) => ({
        form,
        score:
          form.querySelectorAll('input:not([type="hidden"]), textarea, select, [role="radiogroup"]').length +
          form.querySelectorAll('input[type="file"]').length * 4 +
          form.querySelectorAll('button[type="submit"]').length * 2,
      }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score);
    return forms[0]?.form ?? null;
  }

  // Dover renders an "Autofill from resume" convenience widget (a drop
  // zone that pre-fills the whole application) above the real questions.
  // It carries a file input just like the actual "Resume" attachment
  // field, so without this guard it gets detected as a second resume
  // question and the uploaded résumé can be routed into the widget
  // instead of the real field.
  function isAutofillFromResumeBlock(block) {
    return normalizeComparisonText(block?.textContent).includes("autofill");
  }

  function getFieldBlocks() {
    return Array.from(getDoverForm()?.querySelectorAll(":scope > div") ?? [])
      .filter((block) => isElementVisible(block))
      .filter((block) => !isAutofillFromResumeBlock(block));
  }

  function getBlockQuestionText(block) {
    if (!block) return "";
    const directLabel = normalizeDoverText(block.firstElementChild?.textContent);
    if (directLabel) return directLabel;
    const clone = block.cloneNode(true);
    clone.querySelectorAll('input, textarea, select, button, [role="radiogroup"], label').forEach((node) => node.remove());
    return normalizeDoverText(clone.textContent);
  }

  function getControlQuestionText(block, control) {
    const controlName = control?.name;
    if (controlName && STANDARD_FIELD_QUESTIONS[controlName]) return STANDARD_FIELD_QUESTIONS[controlName];
    const blockQuestion = getBlockQuestionText(block);
    if (blockQuestion) return blockQuestion;
    return normalizeDoverText(control?.getAttribute?.("aria-label") || control?.name || control?.id);
  }

  function getChoiceInputLabel(input, fallbackQuestion = "") {
    return normalizeDoverText(input?.closest("label")?.textContent || input?.value || fallbackQuestion);
  }
  function getChoiceOptions(inputs, fallbackQuestion = "") {
    return inputs.map((input) => getChoiceInputLabel(input, fallbackQuestion)).filter(Boolean);
  }
  function getChoiceOptionsForField(field, inputType, fallbackQuestion) {
    return Array.from(field?.querySelectorAll(`input[type="${inputType}"]`) ?? [])
      .map((input) => ({ input, text: getChoiceInputLabel(input, fallbackQuestion), value: input.value }))
      .filter((option) => option.text || option.value);
  }

  // A field "block" can hold either plain controls or a `[role=radiogroup]`
  // wrapper around a set of radios — collect both, excluding any plain
  // control that's actually nested inside one of those groups so it isn't
  // double-counted as its own question.
  function getVisibleControls(block) {
    const controls = Array.from(block?.querySelectorAll('input:not([type="hidden"]), textarea, select') ?? []).filter((control) => {
      if (control.disabled || control.readOnly) return false;
      if (control.getAttribute("aria-hidden") === "true") return false;
      if (control.tagName === "TEXTAREA" && !control.name && !control.id) return false;
      if (["submit", "button", "reset"].includes(control.type)) return false;
      return isElementVisible(control, { allowHiddenInput: true });
    });
    const radioGroups = Array.from(block?.querySelectorAll('[role="radiogroup"]') ?? []).filter((group) => isElementVisible(group));
    return [...radioGroups, ...controls.filter((control) => !radioGroups.some((group) => group.contains(control)))];
  }

  function getRemoveUploadButton(field) {
    return (
      Array.from(field?.querySelectorAll?.("button, [role=\"button\"]") ?? []).find((button) => {
        const label = normalizeComparisonText(button.getAttribute("aria-label") || button.getAttribute("title") || button.textContent);
        return label.includes("remove") || label.includes("delete") || Boolean(button.querySelector?.('[data-testid="ClearIcon"]'));
      }) ?? null
    );
  }
  function isUploadedDocumentBlock(block) {
    const question = getBlockQuestionText(block);
    if (!question || !getRemoveUploadButton(block)) return false;
    return isResumeQuestion(question, null) || isCoverLetterQuestion(question, null);
  }

  function getPrimaryControl(field) {
    return getFileInputInsideField(field) || getTextarea(field) || getTextInput(field) || getRadioInputs(field)[0] || getCheckboxInputs(field)[0] || null;
  }

  function isResumeQuestion(question, control) {
    const combined = `${question} ${control?.name ?? ""} ${control?.id ?? ""}`.toLowerCase();
    return /\b(resume|cv)\b/.test(combined);
  }
  function isCoverLetterQuestion(question, control) {
    const combined = `${question} ${control?.name ?? ""} ${control?.id ?? ""}`.toLowerCase();
    return /cover\s*letter|cover_?letter/.test(combined);
  }

  // Classify a block/control pair into the fieldKind this adapter knows
  // how to fill. radio/checkbox take the whole group ("field"); file/
  // textarea/text take the single control, further split into
  // resume/cover_letter when the question/control identifies one.
  function classifyField(question, field, control) {
    const radioInputs = getRadioInputs(field);
    if (radioInputs.length > 0) {
      return { fieldKind: "radio", options: getChoiceOptions(radioInputs, question), control: radioInputs[0] };
    }
    const checkboxInputs = getCheckboxInputs(field);
    if (checkboxInputs.length > 0) {
      return { fieldKind: "checkbox", options: getChoiceOptions(checkboxInputs, question), control: checkboxInputs[0] };
    }
    if (control?.type === "file") {
      const fieldKind = isCoverLetterQuestion(question, control) ? "cover_letter" : isResumeQuestion(question, control) ? "resume" : "file";
      return { fieldKind, options: [], control };
    }
    const textarea = control?.tagName === "TEXTAREA" ? control : getTextarea(field);
    if (textarea) {
      return { fieldKind: isCoverLetterQuestion(question, textarea) ? "cover_letter" : "textarea", options: [], control: textarea };
    }
    const textInput = control?.tagName === "INPUT" ? control : getTextInput(field);
    if (textInput) {
      return { fieldKind: isCoverLetterQuestion(question, textInput) ? "cover_letter" : "text", options: [], control: textInput };
    }
    return null;
  }

  function getBaseFieldId(question, control, classified) {
    if (classified.fieldKind === "resume") return "resume";
    if (classified.fieldKind === "cover_letter") return "cover_letter";
    const choiceInput = getRadioInputs(control)[0] || getCheckboxInputs(control)[0];
    return control?.name || control?.id || choiceInput?.name || choiceInput?.id || slugifyFieldId(question);
  }

  /** Walk Dover's application form and return every question this adapter
   *  can fill deterministically: {question, fieldId, field, control,
   *  fieldKind, options}. */
  function detectFields() {
    const entries = [];
    const usedFieldIds = new Set();
    const addEntry = (question, field, control, classified) => {
      if (!question || !classified) return;
      let fieldId = getBaseFieldId(question, control, classified);
      let suffix = 2;
      while (usedFieldIds.has(fieldId)) {
        fieldId = `${getBaseFieldId(question, control, classified)}-${suffix++}`;
      }
      usedFieldIds.add(fieldId);
      entries.push({ question, fieldId, field, control: classified.control, fieldKind: classified.fieldKind, options: classified.options });
    };

    for (const block of getFieldBlocks()) {
      const controls = getVisibleControls(block);
      // An already-uploaded document (file input unmounted, replaced by a
      // "<name> [remove]" chip) has no control for the loop below to find.
      if (controls.length === 0 && isUploadedDocumentBlock(block)) {
        const question = getBlockQuestionText(block);
        addEntry(question, block, null, classifyField(question, block, null));
        continue;
      }
      for (const control of controls) {
        const isChoiceGroup = control.getAttribute?.("role") === "radiogroup";
        const primaryControl = isChoiceGroup ? getPrimaryControl(control) : control;
        const question = getControlQuestionText(block, primaryControl);
        if (!question) continue;
        const classified = classifyField(question, control, primaryControl);
        const field = classified?.fieldKind === "file" || classified?.fieldKind === "resume" || classified?.fieldKind === "cover_letter" ? block : control;
        addEntry(question, field, primaryControl, classified);
      }
    }
    return entries;
  }

  // ---- submit ------------------------------------------------------------

  function getActionLabel(element) {
    return normalizeComparisonText(element?.textContent || element?.value || element?.getAttribute?.("aria-label") || "");
  }
  function getSubmitButton() {
    const form = getDoverForm();
    if (!form) return null;
    const candidates = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"], button, [role="button"]'))
      .filter((button, index, all) => all.indexOf(button) === index)
      .filter((button) => isElementVisible(button))
      // Exclude the "Autofill from resume" widget's own controls (drop
      // zone + "Upload file" button).
      .filter((button) => !isAutofillFromResumeBlock(button.closest("form > div")));
    return candidates.find((button) => button.type === "submit") || candidates.find((button) => /\b(submit|apply)\b/.test(getActionLabel(button))) || null;
  }
  function isSubmitButtonDisabled(button) {
    return Boolean(button?.disabled || button?.getAttribute?.("aria-disabled") === "true");
  }

  // ---- filling -------------------------------------------------------------

  async function waitFor(check, timeoutMs, pollMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = check();
      if (result) return result;
      await sleep(pollMs);
    }
    return null;
  }

  // Exact-or-value match only — deliberately NOT BidHub's own embedding
  // fallback. A radio/checkbox group this can't place deterministically
  // is left untouched for the generic pipeline to try.
  function findMatchingOption(answer, options) {
    if (!Array.isArray(options) || options.length === 0) return null;
    const normalizedAnswer = normalizeComparisonText(typeof answer === "boolean" ? (answer ? "Yes" : "No") : answer);
    if (!normalizedAnswer) return options.length === 1 ? options[0] : null;
    return (
      options.find((option) => normalizeComparisonText(option.text) === normalizedAnswer) ||
      options.find((option) => normalizeComparisonText(option.value) === normalizedAnswer) ||
      null
    );
  }

  // A résumé/cover-letter block whose file is already attached unmounts
  // its own `input[type=file]` (replaced by a "<name> [remove]" chip) —
  // click "remove" and wait for the real input to come back before a
  // re-attach has anything to drive.
  function resolveLiveFileField(field, question) {
    if (field?.isConnected) {
      const fieldBlock = field.matches?.("form > div") ? field : field.closest?.("form > div");
      if (fieldBlock && (getFileInputInsideField(fieldBlock) || getRemoveUploadButton(fieldBlock))) return fieldBlock;
    }
    const normalizedQuestion = normalizeComparisonText(question);
    return (
      getFieldBlocks().find((block) => {
        if (!getFileInputInsideField(block) && !getRemoveUploadButton(block)) return false;
        const normalizedBlockQuestion = normalizeComparisonText(getBlockQuestionText(block));
        if (normalizedBlockQuestion && normalizedBlockQuestion === normalizedQuestion) return true;
        if (isResumeQuestion(question, null)) return isResumeQuestion(getBlockQuestionText(block), null);
        if (isCoverLetterQuestion(question, null)) return isCoverLetterQuestion(getBlockQuestionText(block), null);
        return false;
      }) ?? field
    );
  }
  async function ensureFileInputForUpload(field, question, shouldAbort = () => false) {
    const liveField = resolveLiveFileField(field, question);
    if (!liveField || shouldAbort()) return null;
    const existingInput = getFileInputInsideField(liveField);
    if (existingInput) return existingInput;
    const removeButton = getRemoveUploadButton(liveField);
    if (!removeButton) return null;
    removeButton.click();
    return waitFor(() => getFileInputInsideField(resolveLiveFileField(liveField, question)), FILE_INPUT_WAIT_TIMEOUT_MS, 100);
  }

  /** Write an already-resolved answer into a question returned by
   *  detectFields(), dispatched by its fieldKind. `answer` is a string
   *  for text/textarea/cover_letter(text)/radio; string|string[]|boolean
   *  for checkbox; {type:"file", fileName, base64, mimeType} for
   *  resume/cover_letter(file)/file. */
  async function fillField(question, answer, { shouldAbort = () => false } = {}) {
    const { field, control, fieldKind } = question;
    if (answer == null || shouldAbort()) return;

    switch (fieldKind) {
      case "text": {
        const input = control?.tagName === "INPUT" ? control : getTextInput(field);
        if (input) fillTextInput(input, answer);
        return;
      }
      case "textarea": {
        const textarea = control?.tagName === "TEXTAREA" ? control : getTextarea(field);
        if (textarea) fillTextInput(textarea, answer);
        return;
      }
      case "cover_letter": {
        if (typeof answer === "string") {
          const control2 = getTextarea(field) || getTextInput(field);
          if (control2) fillTextInput(control2, answer);
        } else if (answer?.type === "file") {
          const fileInput = await ensureFileInputForUpload(field, question.question, shouldAbort);
          if (fileInput && !shouldAbort()) fillFileInput(fileInput, answer.fileName, answer.base64, answer.mimeType);
        }
        return;
      }
      case "resume":
      case "file": {
        if (!answer || typeof answer !== "object" || answer.type !== "file") return;
        const fileInput = await ensureFileInputForUpload(field, question.question, shouldAbort);
        if (fileInput && !shouldAbort()) fillFileInput(fileInput, answer.fileName, answer.base64, answer.mimeType);
        return;
      }
      case "radio": {
        const options = getChoiceOptionsForField(field, "radio", question.question);
        const option = findMatchingOption(answer, options);
        if (!option?.input) return;
        if (!option.input.checked) await clickLikeHuman(option.input, { shouldAbort });
        return;
      }
      case "checkbox": {
        const options = getChoiceOptionsForField(field, "checkbox", question.question);
        const selectedValues = Array.isArray(answer) ? answer.map(normalizeComparisonText) : [normalizeComparisonText(answer)];
        for (const option of options) {
          const shouldCheck =
            typeof answer === "boolean"
              ? answer
              : selectedValues.includes(normalizeComparisonText(option.text)) || selectedValues.includes(normalizeComparisonText(option.value));
          if (option.input.checked !== shouldCheck) await clickLikeHuman(option.input, { shouldAbort });
        }
        return;
      }
      default:
        return;
    }
  }

  function isAutofillAvailable() {
    return Boolean(getDoverForm());
  }

  NS.dover = {
    isAutofillAvailable,
    detectFields,
    fillField,
    getSubmitButton,
    isSubmitButtonDisabled,
  };
})();
