/* =====================================================================
 * autofill/sites/gem-autofill.js — Gem apply form
 * (jobs.gem.com/<board>/<extId>), matches jobs.gem.com/*, all_frames.
 * =====================================================================
 * Ported from BidHub's own Gem autofill bundle. That bundle also carries
 * ~2500 lines of generic, platform-agnostic autofill RUNTIME (field-cache
 * bookkeeping, form-position ordinals, an abort-scope DOM mutex, password
 * masking, progress messaging, a background keep-alive ping, and —
 * crucially — AI-backend free-text answer GENERATION via getAnswer())
 * duplicated into every one of BidHub's per-ATS bundles the exact same way
 * dom-interactions.js is. None of that is Gem-specific, and none of it is
 * ported here.
 *
 * What IS Gem-specific (and is ported faithfully below) is:
 *   - locating Gem's apply form and classifying each question row by DOM
 *     shape (detectAutofillFields + its helpers);
 *   - Gem's own custom, non-native dropdown widget — it opens as a
 *     floating `[role="option"]` menu off a plain `<button type="button">`
 *     trigger, not a `<select>` (getDropdownButton, getVisibleDropdownItems,
 *     closeOpenDropdown, pickGemDropdownOption, readGemDropdownOptions);
 *   - Gem's "Apply" / "Apply without saving" submit button
 *     (getGemSubmitButton / detectGemSubmitButton);
 *   - WRITING an already-known answer into each field kind (the
 *     fieldKindHandlers dispatch below) — never generating one.
 *
 * OUT OF SCOPE, deliberately not ported: BidHub's AI-backend free-text
 * answer generation (getAnswer()/ai-core) and its embedding-based fuzzy
 * dropdown-option matcher (getEmbeddingMatch). Big Banana has its own
 * system for free-text AI answers. Where BidHub's code would fall through
 * into that pipeline — an open text question with no supplied answer, or
 * a dropdown answer with no exact-text match — this file reports "no
 * match" / does nothing and lets Big Banana's existing generic pipeline
 * take it from there, exactly as instructed.
 *
 * Gem's apply flow is a single page (fields + one "Ready to apply?" →
 * Apply button) — there is no multi-step "next" page to advance through,
 * so there's deliberately no step-advancement logic here beyond the one
 * submit button BidHub's own source also only ever detects.
 * ===================================================================== */
(function () {
  "use strict";

  const Engine = window.ProactiveAutofillEngine;
  if (!Engine) return; // engine not loaded in this frame yet — nothing to do

  // ---- small local utilities (generic glue, not promoted into the shared
  // engine — BidHub bundles these the same way per site) -------------------

  function normalizeText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function sleep(ms) {
    return Engine.sleep(ms);
  }

  const NEVER_ABORT = () => false;

  // Polls `check` until it returns a truthy value or `timeoutMs` elapses /
  // `shouldAbort()` goes true — same shape as BidHub's own
  // waitForPositiveResultWithAbort, needed by the dropdown + file-upload
  // helpers below (not part of the shared engine's primitive roster).
  async function waitForPositiveResult(check, timeoutMs, shouldAbort = NEVER_ABORT) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (shouldAbort()) return null;
      const result = check();
      if (result) return result;
      await sleep(80);
    }
    return null;
  }

  // One retry on failure — Gem's dropdown occasionally doesn't open on the
  // first click (a re-render racing the click); BidHub's own source wraps
  // the open+read/open+pick step in exactly this.
  async function withRetry(fn, attempts = 2) {
    let lastError;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  function encodeTextAsBase64(text) {
    const bytes = new TextEncoder().encode(String(text ?? ""));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function toTxtFileName(fileName, fallbackBaseName = "generated-text") {
    const normalized = String(fileName ?? "").trim();
    if (!normalized) return `${fallbackBaseName}.txt`;
    if (normalized.toLowerCase().endsWith(".txt")) return normalized;
    const withoutExtension = normalized.replace(/\.[^.]+$/, "");
    return `${withoutExtension || fallbackBaseName}.txt`;
  }

  // Wraps a plain string answer (e.g. a cover letter the panel already
  // generated) into the { type:'file', fileName, mimeType, base64 } shape
  // fillGemFileInput expects — a file-prep utility, not AI generation.
  function createPlainTextFileAnswer(text, { fileName = "generated-text.txt", mimeType = "text/plain" } = {}) {
    if (typeof text !== "string") return null;
    return { type: "file", fileName: toTxtFileName(fileName), mimeType, base64: encodeTextAsBase64(text) };
  }

  // Compact structural check for a "depends on the previous answer"
  // question (follow-ups like "if so, please explain", or a pronoun
  // standing in for a person named in the prior answer) — used only to
  // flag such fields in the detected-field payload so whatever consumes it
  // (Big Banana's own answer pipeline) knows not to treat them as
  // independent. Trimmed down from BidHub's shared dependent-question.js;
  // the Gem-only addition is the leading "if" test below.
  const DEPENDENT_QUESTION_PATTERN =
    /\b(?:if\s+you\s+(?:answered|selected|chose|checked|picked|indicated|marked|said)|if\b[^.?!\n]*\babove\b|if\s+so|if\s+not|if\s+yes|if\s+no|if\s+applicable|previous\s+question|please\s+explain|please\s+specify|explain\s+why|explain\s+how|in\s+that\s+case)\b|\bwhat(?:'s|\s+is|\s+are|\s+was|\s+were)?\s+(?:their|his|her|its)\b|\bwho\s+(?:is|are|was|were)\s+(?:they|he|she|it)\b|\b(?:this|that)\s+(?:person|individual|employee|referrer)\b|\bwho\s+referred\s+you\b/i;

  function isGemDependentQuestion(question) {
    const normalized = normalizeText(question);
    return DEPENDENT_QUESTION_PATTERN.test(normalized) || /^if\b/i.test(normalized);
  }

  // ---- Gem's form shape ---------------------------------------------------

  function hasClassPrefix(element, prefix) {
    return Array.from(element?.classList ?? []).some((className) => className.startsWith(prefix));
  }

  function getQuestionLabelElement(scope) {
    return scope?.querySelector?.('[class*="bodyImportant"]') ?? null;
  }

  function stripRequiredMarker(text) {
    return normalizeText(text).replace(/\*\s*$/, "").trim();
  }

  function getQuestionFromScope(scope) {
    return stripRequiredMarker(getQuestionLabelElement(scope)?.textContent);
  }

  function isRequiredScope(scope) {
    const label = getQuestionLabelElement(scope);
    return Boolean(
      label?.querySelector?.('[class*="requiredAsterisk"]') || /\*\s*$/.test(normalizeText(label?.textContent))
    );
  }

  // Gem has no stable form/container id — the one anchor that survives
  // their hashed class names is the "Ready to apply?" heading that always
  // precedes the form. Walking up from it to the nearest
  // `[class*="formLayout"]` ancestor is how BidHub's own parser locates
  // the form, kept exactly.
  function getGemFormLayout() {
    const readyHeader = Array.from(document.querySelectorAll("div")).find(
      (element) => normalizeText(element.textContent) === "Ready to apply?"
    );
    return readyHeader?.closest('div[class*="formLayout"]') ?? null;
  }

  // Within the layout, the actual question list is the one child
  // `div[class^="form-…"]` that both holds a native input/textarea AND has
  // at least one child row with a question label — that's what tells it
  // apart from sibling layout chrome (the header, the submit-button row)
  // that also loosely matches a "form-" class prefix.
  function getPrimaryApplicationForm() {
    const layout = getGemFormLayout();
    if (!layout) return null;
    return (
      Array.from(layout.querySelectorAll("div")).find(
        (element) =>
          hasClassPrefix(element, "form-") &&
          element.querySelector("input, textarea") &&
          Array.from(element.children).some((child) => Boolean(getQuestionFromScope(child)))
      ) ?? null
    );
  }

  function slugify(value, fallback = "field") {
    const slug = normalizeText(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    return slug || fallback;
  }

  function getRadioGroupId(radios, question) {
    const ids = radios.map((radio) => radio.id).filter(Boolean);
    if (ids.length > 0) {
      const prefixes = ids.map((id) => id.replace(/-[^-]+$/, ""));
      if (prefixes.every((prefix) => prefix === prefixes[0])) return prefixes[0];
    }
    return slugify(question, "radio_group");
  }

  function getFieldId(question, control, fallbackPrefix) {
    const id = control?.id || control?.name;
    if (id) return id;
    return slugify(question, fallbackPrefix);
  }

  function makeUniqueFieldId(baseId, usedFieldIds) {
    const normalizedBaseId = baseId || "field";
    if (!usedFieldIds.has(normalizedBaseId)) {
      usedFieldIds.add(normalizedBaseId);
      return normalizedBaseId;
    }
    let suffix = 2;
    while (usedFieldIds.has(`${normalizedBaseId}_${suffix}`)) suffix += 1;
    const fieldId = `${normalizedBaseId}_${suffix}`;
    usedFieldIds.add(fieldId);
    return fieldId;
  }

  function addRequiredConstraint(constraints, scope) {
    return isRequiredScope(scope) ? { ...constraints, required: true } : constraints;
  }

  // Gem's choice-input labels nest the visible text in a `[class*="body-"]`
  // span alongside other chrome (a description, a sub-label) — without
  // narrowing to that descendant, getInputLabelText's full-label fallback
  // would pull in that extra text too.
  function getOptionLabel(input, fallbackText = "") {
    return normalizeText(Engine.getInputLabelText(input, fallbackText, { descendantSelector: '[class*="body-"]' }));
  }

  function getChoiceOptions(inputs) {
    return inputs.map((input) => getOptionLabel(input)).filter(Boolean);
  }

  function isCaptchaControl(control) {
    const name = control?.name || "";
    const id = control?.id || "";
    return /captcha/i.test(name) || /captcha/i.test(id);
  }

  // Same priority as BidHub's own: a real text/email/tel/... input first,
  // explicitly excluding the non-text input types a bare querySelector
  // could still hand back, then a textarea.
  function getVisibleTextControl(scope) {
    const input = Engine.getTextInput(scope);
    if (input && !["hidden", "file", "radio", "checkbox", "submit", "button"].includes(input.type)) {
      return input;
    }
    return Engine.getTextarea(scope);
  }

  function isResumeQuestion(question) {
    return /\b(resume|cv)\b/i.test(question);
  }
  function isCoverLetterQuestion(question) {
    return /cover\s*letter/i.test(question);
  }

  // required / maxLength / pattern / accept / min / max / step — the
  // constraints BidHub's own getInputConstraints reports structurally.
  // Not ported: its "characters left" live-counter scan and its
  // AI-answer-formatting inputType classifier — both exist purely to feed
  // the AI-backend answer generator this port excludes.
  function getInputConstraints(control) {
    if (!control) return {};
    const constraints = {};
    if (control.required) constraints.required = true;
    if (control.getAttribute?.("aria-required") === "true") constraints.required = true;
    for (const attribute of ["data-val-length-max", "data-maxlength", "maxlength"]) {
      const parsed = Number.parseInt(control.getAttribute?.(attribute) ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        constraints.maxLength = parsed;
        break;
      }
    }
    const pattern = control.getAttribute?.("pattern");
    if (pattern) constraints.pattern = pattern;
    const accept = control.getAttribute?.("accept");
    if (accept) constraints.accept = accept;
    const min = control.getAttribute?.("min");
    if (min != null && min !== "") constraints.min = min;
    const max = control.getAttribute?.("max");
    if (max != null && max !== "") constraints.max = max;
    const step = control.getAttribute?.("step");
    if (step != null && step !== "") constraints.step = step;
    return constraints;
  }

  // Fall-through case: a question row with no native input/textarea/
  // radio/checkbox but a plain trigger button is Gem's custom dropdown
  // (e.g. "Do you require work sponsorship?"). Detected structurally
  // rather than by placeholder text/wrapper class, both of which Gem
  // changes without notice.
  function getGemSelectTrigger(scope) {
    if (!scope?.querySelectorAll) return null;
    return Array.from(scope.querySelectorAll('button[type="button"]')).find((button) => !isCaptchaControl(button)) ?? null;
  }

  // Synchronous, read-only detection pass over the apply form. Returns one
  // entry per question row, each carrying the live `field` element (the
  // row wrapper) so a later fill can re-resolve the actual control itself
  // — Gem re-renders rows on state changes, so anything more specific than
  // the row would go stale.
  function detectAutofillFields() {
    const form = getPrimaryApplicationForm();
    if (!form) return [];
    const questions = [];
    const usedFieldIds = new Set();
    const addFieldEntry = ({
      question,
      fieldId,
      field,
      // The specific, real <input>/<textarea> inside `field` when one
      // exists (text/textarea rows) — `field` itself is the whole question
      // ROW (checkbox/radio groups and the fill handlers below are written
      // to re-find the actual control inside it), but dispatcher.js's
      // contact-field matcher (bestMatchFor) needs the real control, not a
      // wrapper div with no name/type/id of its own to go on. Left
      // undefined for row-level kinds (checkbox/radio/dropdown/file) where
      // there's no single control to point at anyway.
      control,
      answerType,
      fieldKind,
      options = [],
      constraints = {},
      dependsOnPrevious = isGemDependentQuestion(question),
    }) => {
      if (!question || !fieldId || !field || !answerType || !fieldKind) return;
      questions.push({
        question,
        fieldId: makeUniqueFieldId(fieldId, usedFieldIds),
        answerType,
        fieldKind,
        dependsOnPrevious,
        field,
        control,
        options,
        constraints,
      });
    };

    for (const row of Array.from(form.children)) {
      const question = getQuestionFromScope(row);
      if (!question) continue;

      const fileInput = Engine.getFileInputInsideField(row);
      if (fileInput) {
        const constraints = addRequiredConstraint(getInputConstraints(fileInput), row);
        if (isResumeQuestion(question)) {
          addFieldEntry({ question: "Resume/CV", fieldId: "resume", answerType: "resume", fieldKind: "file", field: row, options: null, constraints });
          continue;
        }
        if (isCoverLetterQuestion(question)) {
          addFieldEntry({ question: "Cover Letter", fieldId: "cover_letter", answerType: "cover_letter", fieldKind: "file", field: row, options: null, constraints });
          continue;
        }
      }

      const checkboxes = Engine.getCheckboxInputs(row);
      if (checkboxes.length > 0) {
        addFieldEntry({
          question,
          fieldId: slugify(question, "checkbox_group"),
          answerType: "multi-select",
          fieldKind: "checkbox-group",
          field: row,
          options: getChoiceOptions(checkboxes),
          constraints: addRequiredConstraint(getInputConstraints(checkboxes[0]), row),
        });
        continue;
      }

      const radios = Engine.getRadioInputs(row);
      if (radios.length > 0) {
        addFieldEntry({
          question,
          fieldId: getRadioGroupId(radios, question),
          answerType: "single-select",
          fieldKind: "radio-group",
          field: row,
          options: getChoiceOptions(radios),
          constraints: addRequiredConstraint(getInputConstraints(radios[0]), row),
        });
        continue;
      }

      const textControl = getVisibleTextControl(row);
      if (textControl && !isCaptchaControl(textControl)) {
        addFieldEntry({
          question,
          fieldId: getFieldId(question, textControl, "text_field"),
          answerType: "text",
          fieldKind: textControl.tagName === "TEXTAREA" ? "textarea" : "text",
          field: row,
          control: textControl,
          options: [],
          constraints: addRequiredConstraint(getInputConstraints(textControl), row),
        });
        continue;
      }

      const selectTrigger = getGemSelectTrigger(row);
      if (selectTrigger) {
        addFieldEntry({
          question,
          fieldId: slugify(question, "dropdown"),
          answerType: "single-select",
          fieldKind: "gem-dropdown",
          field: row,
          options: null,
          constraints: addRequiredConstraint({}, row),
          dependsOnPrevious: false,
        });
      }
    }
    return questions;
  }

  // ---- Gem's "Apply" / "Apply without saving" submit button --------------

  function getGemSubmitButton() {
    const layout = getGemFormLayout();
    if (!layout) return null;
    const submitButtons = Array.from(layout.querySelectorAll('button[type="submit"]'));
    return (
      submitButtons.find((button) => /apply\s+without\s+saving/i.test(normalizeText(button.textContent))) ??
      submitButtons.find((button) => /\bapply\b/i.test(normalizeText(button.textContent))) ??
      null
    );
  }

  function detectGemSubmitButton() {
    const submitButton = getGemSubmitButton();
    if (!submitButton) return { detected: false };
    return {
      detected: true,
      label: normalizeText(submitButton.textContent) || submitButton.getAttribute("aria-label") || "",
      disabled: Boolean(submitButton.disabled || submitButton.getAttribute("aria-disabled") === "true"),
    };
  }

  // ---- Gem's custom dropdown widget ---------------------------------------
  // Not a <select> — a `<button type="button">` trigger that, on click,
  // renders a floating menu of `[role="option"]` items elsewhere in the
  // document (not necessarily inside the field row), which is why these
  // read from `document`, not from the field scope.

  const DROPDOWN_WAIT_TIMEOUT_MS = 5000;
  const DROPDOWN_CLOSE_DELAY_MS = 150;

  function getDropdownButton(field) {
    return field?.querySelector?.('button[type="button"]') ?? null;
  }

  function getVisibleDropdownItems() {
    return Array.from(document.querySelectorAll('[role="option"], li[role="menuitem"]')).filter((item) => {
      const style = window.getComputedStyle(item);
      const rect = item.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        rect.width > 0 &&
        rect.height > 0 &&
        item.getAttribute("aria-disabled") !== "true"
      );
    });
  }

  async function closeOpenDropdown() {
    document.activeElement?.dispatchEvent?.(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true })
    );
    document.body.click();
    await sleep(DROPDOWN_CLOSE_DELAY_MS);
  }

  function findOptionByText(options, value) {
    const normalizedValue = normalizeText(value).toLowerCase();
    if (!normalizedValue) return null;
    return options.find((option) => normalizeText(option).toLowerCase() === normalizedValue) ?? null;
  }

  // Opens the dropdown, reads its visible option text, and closes it again
  // — used to answer a "what are this field's choices?" request from the
  // panel (the field's `options` come back null from detection since
  // reading them requires actually opening the menu).
  async function readGemDropdownOptions(field, shouldAbort = NEVER_ABORT) {
    const button = getDropdownButton(field);
    if (!button) return [];
    await withRetry(async () => {
      if (shouldAbort()) return;
      await Engine.clickLikeHuman(button, { shouldAbort });
      const menuItems = await waitForPositiveResult(() => {
        const items = getVisibleDropdownItems();
        return items.length > 0 ? items : null;
      }, DROPDOWN_WAIT_TIMEOUT_MS, shouldAbort);
      if (!menuItems && !shouldAbort()) throw new Error("Gem dropdown did not open");
    });
    const options = getVisibleDropdownItems()
      .map((item) => normalizeText(item.textContent))
      .filter(Boolean);
    await closeOpenDropdown();
    return Array.from(new Set(options));
  }

  // Opens the dropdown and clicks the option whose text EXACTLY matches
  // `answer` (case-insensitive). BidHub's own source falls back to an
  // embedding-based fuzzy match (getEmbeddingMatch) when there's no exact
  // hit — that's the AI-backend path this port excludes, so a non-exact
  // answer here just reports no match instead, same as any other
  // AI-dependent branch, and Big Banana's own pipeline is left to handle
  // it from there.
  async function pickGemDropdownOption(field, answer, shouldAbort = NEVER_ABORT) {
    const button = getDropdownButton(field);
    if (!button || answer == null) return false;
    let picked = false;
    await withRetry(async () => {
      if (shouldAbort()) return;
      await Engine.clickLikeHuman(button, { shouldAbort });
      const menuItems = await waitForPositiveResult(() => {
        const items = getVisibleDropdownItems();
        return items.length > 0 ? items : null;
      }, DROPDOWN_WAIT_TIMEOUT_MS, shouldAbort);
      if (!menuItems) {
        if (shouldAbort()) return;
        throw new Error("Gem dropdown menu did not open");
      }
      const options = Array.from(menuItems)
        .map((item) => ({ item, text: normalizeText(item.textContent) }))
        .filter((option) => option.text);
      const matchedText = findOptionByText(options.map((option) => option.text), answer);
      const matchedOption = matchedText ? options.find((option) => option.text === matchedText) : null;
      if (!matchedOption) {
        await closeOpenDropdown();
        return; // no exact match — leave `picked` false, don't throw/retry for this
      }
      await Engine.clickLikeHuman(matchedOption.item, { shouldAbort });
      await waitForPositiveResult(() => (getVisibleDropdownItems().length === 0 ? true : null), DROPDOWN_WAIT_TIMEOUT_MS, shouldAbort);
      picked = true;
    });
    return picked;
  }

  // ---- file upload (resume / cover letter) --------------------------------

  const UPLOAD_COMPLETE_TIMEOUT_MS = 30000;

  async function fillGemFileInput(answer, field, fallbackFileName, shouldAbort = NEVER_ABORT) {
    if (shouldAbort()) return;
    let uploadAnswer = answer;
    if (typeof uploadAnswer === "string") {
      uploadAnswer = createPlainTextFileAnswer(uploadAnswer, { fileName: fallbackFileName });
    }
    if (!uploadAnswer || typeof uploadAnswer !== "object" || uploadAnswer.type !== "file") return;
    const input = Engine.getFileInputInsideField(field);
    if (!input || shouldAbort()) return;
    Engine.fillFileInput(input, uploadAnswer.fileName, uploadAnswer.base64, uploadAnswer.mimeType);
    await waitForPositiveResult(() => (input.files?.length > 0 ? true : null), UPLOAD_COMPLETE_TIMEOUT_MS, shouldAbort);
  }

  // ---- per-field-kind fill dispatch ---------------------------------------
  // Writes an ALREADY-KNOWN answer into the DOM. Never generates one —
  // that's Big Banana's own pipeline's job, same split BidHub's own
  // fieldKindHandlers/answerTypeHandlers maps draw.

  function normalizeAnswerList(answer) {
    if (Array.isArray(answer)) return answer.map((value) => normalizeText(value)).filter(Boolean);
    const normalized = normalizeText(answer);
    return normalized ? [normalized] : [];
  }

  function answerMatchesOption(answerValues, option) {
    const normalizedOption = normalizeText(option).toLowerCase();
    return answerValues.some((value) => normalizeText(value).toLowerCase() === normalizedOption);
  }

  async function fillCheckboxGroup(field, answer, shouldAbort) {
    const answerValues = normalizeAnswerList(answer);
    for (const checkbox of Engine.getCheckboxInputs(field)) {
      if (shouldAbort()) return;
      const shouldCheck = answerMatchesOption(answerValues, getOptionLabel(checkbox));
      if (checkbox.checked !== shouldCheck) await Engine.clickLikeHuman(checkbox, { shouldAbort });
    }
  }

  async function fillRadioGroup(field, answer, shouldAbort) {
    const answerValues = normalizeAnswerList(answer);
    for (const radio of Engine.getRadioInputs(field)) {
      if (shouldAbort()) return;
      if (answerMatchesOption(answerValues, getOptionLabel(radio))) {
        await Engine.clickLikeHuman(radio, { shouldAbort });
        return;
      }
    }
  }

  // fieldKind -> async (field, answer, fieldId, shouldAbort) => { filled }
  const FIELD_KIND_HANDLERS = new Map([
    [
      "text",
      async (field, answer) => {
        const input = Engine.getTextInput(field);
        if (!input) return { filled: false, reason: "no_control" };
        Engine.fillTextInput(input, answer);
        return { filled: true };
      },
    ],
    [
      "textarea",
      async (field, answer) => {
        const textarea = Engine.getTextarea(field);
        if (!textarea) return { filled: false, reason: "no_control" };
        Engine.fillTextInput(textarea, answer);
        return { filled: true };
      },
    ],
    [
      "checkbox-group",
      async (field, answer, _fieldId, shouldAbort) => {
        await fillCheckboxGroup(field, answer, shouldAbort);
        return { filled: true };
      },
    ],
    [
      "radio-group",
      async (field, answer, _fieldId, shouldAbort) => {
        await fillRadioGroup(field, answer, shouldAbort);
        return { filled: true };
      },
    ],
    [
      "gem-dropdown",
      async (field, answer, _fieldId, shouldAbort) => {
        const picked = await pickGemDropdownOption(field, answer, shouldAbort);
        return picked ? { filled: true } : { filled: false, reason: "no_match" };
      },
    ],
    [
      "file",
      async (field, answer, fieldId, shouldAbort) => {
        const fallbackFileName = fieldId === "cover_letter" ? "cover-letter.txt" : "resume.pdf";
        await fillGemFileInput(answer, field, fallbackFileName, shouldAbort);
        return { filled: true };
      },
    ],
  ]);

  // ---- detection caching ---------------------------------------------------
  // fieldId -> { field, fieldKind } — the live element is kept here, out of
  // the message payload (which only needs to be JSON-serialisable), since
  // a fill request can arrive well after the detection pass that found it.

  const fieldCache = new Map();

  function detectAndCacheFields() {
    const form = getPrimaryApplicationForm();
    if (!form) return null;
    const detected = detectAutofillFields();
    fieldCache.clear();
    const fields = detected.map((entry) => {
      fieldCache.set(entry.fieldId, { field: entry.field, fieldKind: entry.fieldKind });
      return {
        fieldId: entry.fieldId,
        question: entry.question,
        answerType: entry.answerType,
        fieldKind: entry.fieldKind,
        options: entry.options,
        constraints: entry.constraints,
        dependsOnPrevious: entry.dependsOnPrevious,
      };
    });
    return { fields, submitButton: detectGemSubmitButton() };
  }

  // Reuses ProactiveJobDetect's own MutationObserver/debounce/SPA-url-watch
  // engine rather than re-implementing it — the exact same algorithm a
  // field-detection loop needs, just pointed at a distinct message `type`
  // so it can never be mistaken for (or overwrite) this tab's job-detect
  // result on the panel side.
  function sendGemAutofillMessage(payload) {
    try {
      chrome.runtime
        .sendMessage({ __proactive: true, type: "gem-autofill-detected", url: location.href, result: payload.data })
        .catch(() => {});
    } catch {
      /* no listener yet (panel not open) — fine, next mutation retries */
    }
  }
  window.ProactiveJobDetect?.parser(detectAndCacheFields, "gemAutofillFieldsDetected", 400, sendGemAutofillMessage);

  // ---- fill / submit entry points ----------------------------------------

  async function clickGemSubmitButton(shouldAbort = NEVER_ABORT) {
    const button = getGemSubmitButton();
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") {
      return { clicked: false };
    }
    await Engine.clickLikeHuman(button, { shouldAbort });
    return { clicked: true };
  }

  // ---- standard per-site registration (autofill/dispatcher.js) ----------
  // Gem was originally ported with its own bespoke message protocol (a
  // `__proactiveAutofillGem`-flagged chrome.runtime listener answering
  // "fill-field"/"get-dropdown-options"/"click-submit") instead of this —
  // but nothing on the side-panel side ever sent a message shaped like
  // that (confirmed: no reference anywhere outside this file). dispatcher.js
  // only ever looks for a site registered on window.ProactiveAutofillSites
  // and calls its methods as plain in-frame function calls (no messaging/
  // serialization involved, so passing the real `field` DOM element through
  // is fine) — same contract every other ported site uses. Gem registering
  // under its own protocol instead meant dispatcher.js's getSiteModule()
  // always came back empty here, so AUTOFILL_DETECT/REVIEW/FILL all
  // answered "no_site_module" and the panel never saw a single Gem field.
  async function isAutofillAvailable() {
    return Boolean(getPrimaryApplicationForm());
  }

  // detectAutofillFields() already returns entries carrying the real
  // `field` element — no need for the old fieldCache indirection (that
  // existed only to survive a chrome.runtime message's serialization
  // boundary, which a direct function call never crosses).
  async function fillField(entry, answer, shouldAbort = NEVER_ABORT) {
    const handler = FIELD_KIND_HANDLERS.get(entry?.fieldKind);
    if (!handler) throw new Error(`Unsupported Gem field kind: ${entry?.fieldKind}`);
    const result = await handler(entry.field, answer, entry.fieldId, shouldAbort);
    if (!result || result.filled !== true) {
      throw new Error((result && result.reason) || "fill_failed");
    }
    return result;
  }

  window.ProactiveAutofillSites = window.ProactiveAutofillSites || {};
  window.ProactiveAutofillSites.gem = {
    isAutofillAvailable,
    detectFields: detectAutofillFields,
    fillField,
    getSubmitButton: getGemSubmitButton,
    clickSubmitButton: clickGemSubmitButton,
  };
})();
