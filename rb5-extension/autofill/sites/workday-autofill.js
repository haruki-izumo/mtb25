/* =====================================================================
 * autofill/sites/workday-autofill.js — Workday (*.myworkdayjobs.com).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/myworkdayjobs/autofill.js.
 * That file is ~4000 lines because it also drives BidHub's AI free-text
 * question answering, CAPTCHA handling and a remote-CDP automation lane
 * — none of which exists here. This file ports only the deterministic,
 * structural pieces, in the same detectFields()/fillField()/advance()
 * shape the other autofill/sites/*.js ports use: field DETECTION keyed
 * off Workday's own `data-automation-id` attribute (the one signal
 * that's stable across every tenant's skin), VALUE-FILLING for the
 * field types BidHub resolves without calling its AI backend (text,
 * Workday's own custom "select-custom" listbox dropdown, radio,
 * checkbox, resume/cover-letter upload), and the Next/Continue/Review/
 * Submit button regex classifier that drives multi-step advancement.
 * Every DOM write/click/type goes through window.ProactiveAutofillEngine
 * (dom-interactions.js) — this file never re-implements a React-safe
 * value write or a synthetic click sequence.
 *
 * Deliberately NOT ported (see the extension-wide AI-answer pipeline /
 * follow-up list instead):
 *   - Free-text screening-question answer generation (BidHub's
 *     `getAnswer()` / ai-core calls, and its "embedding match" fallback
 *     for an unmatched dropdown/radio option) — a field this file can't
 *     resolve deterministically (getBestMatchingOption finds nothing)
 *     is simply left alone for Big Banana's own generic AI-answer
 *     pipeline to pick up.
 *   - Workday's sign-in / create-account flow (email+password auth,
 *     verification-code challenges) — credential handling, out of scope.
 *   - Date fields, the repeatable multi-select typeahead, and the
 *     Education/Work-History row-adding section hierarchy — same
 *     "left for a follow-up" call the existing
 *     autofill/handlers/adapters/workday.js adapter already made for
 *     Education; nothing here fills them either.
 *   - CAPTCHA solving / proxy-CDP input — not applicable to a content
 *     script.
 * ===================================================================== */
(function () {
  "use strict";
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    sleep,
    fillTextInputReliably,
    clickLikeHuman,
    fillFileInput,
    getFileInputInsideField,
    getTextarea,
    getRadioInputs,
    getCheckboxInputs,
    getInputLabelText,
  } = engine;

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});

  // ---- small local polling helper (BidHub's waitForPositiveResultWithAbort,
  // trimmed — no shouldAbort plumbing since this file never runs a
  // cancellable background job the way BidHub's auto-apply pipeline does) ---
  async function waitFor(check, timeoutMs, pollMs = 80) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = check();
      if (result) return result;
      await sleep(pollMs);
    }
    return null;
  }

  const LISTBOX_WAIT_TIMEOUT_MS = 3000;
  const LISTBOX_CLOSE_WAIT_TIMEOUT_MS = 5000;
  const SELECT_COMMIT_WAIT_TIMEOUT_MS = 10000;
  const FILE_UPLOAD_WAIT_TIMEOUT_MS = 5000;
  const AUTOFILL_ADVANCE_WAIT_MS = 1500;
  const SAFE_ADVANCE_BUTTON_TEXT_PATTERN = /\b(next|continue|review|preview)\b/i;
  const UNSAFE_ADVANCE_BUTTON_TEXT_PATTERN = /\b(submit|apply|complete|finish|done|send)\b/i;
  const NON_ADVANCE_BUTTON_TEXT_PATTERN = /\b(back|previous|cancel|close|delete|remove|upload|browse|choose|skip)\b/i;
  const COVER_LETTER_QUESTION_PATTERN = /cover\s*letter/i;

  // ---- text normalization ------------------------------------------------
  // Workday pads labels with non-breaking spaces and repeats a trailing
  // "*" for required fields in more than one place — collapse both
  // before any text comparison, same as BidHub's own normalizeWorkdayText.
  function normalizeText(value) {
    return String(value ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  }
  function normalizeComparisonText(value) {
    return normalizeText(value).toLowerCase();
  }
  // Question/label cleanup: strips the required-asterisk and the
  // "Current value is …" suffix Workday appends to some field legends.
  function cleanQuestionText(value) {
    return normalizeText(value)
      .replace(/\s*\*+\s*/g, " ")
      .replace(/\bcurrent value is\b.*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ---- apply-flow page / step structure -----------------------------------
  function getApplyPage() {
    return document.querySelector('[data-automation-id="applyFlowPage"]');
  }
  // True on the job detail/listing page, before "Apply" has been
  // clicked — distinguishes it from a page already inside the apply flow.
  function isDetailPage() {
    return Boolean(document.querySelector('[data-automation-id="jobPostingHeader"]')) && !getApplyPage();
  }

  // ---- field discovery -----------------------------------------------
  // Every real question on a Workday step is wrapped in a
  // `[data-automation-id^="formField-"]` div — this is Workday's one
  // stable field-boundary marker, equivalent to a <label>+<input>
  // pairing on a hand-written form. Only top-level wrappers (not one
  // nested inside another, e.g. a radio-group's own per-option wrapper)
  // count as a field.
  function getVisibleFieldWrappers(root = getApplyPage() || document) {
    if (!root) return [];
    return Array.from(root.querySelectorAll('[data-automation-id^="formField-"]'))
      .filter((field) => isVisible(field))
      .filter((field) => !field.parentElement?.closest('[data-automation-id^="formField-"]'));
  }

  function getQuestionNode(field) {
    const candidates = [
      ...field.querySelectorAll('legend [data-automation-id="richText"]'),
      ...field.querySelectorAll("legend label"),
      ...field.querySelectorAll("legend"),
      ...field.querySelectorAll(":scope > label"),
      ...field.querySelectorAll("label"),
      ...field.querySelectorAll('[data-automation-id="richText"]'),
    ];
    return candidates.find((node) => cleanQuestionText(node.textContent || node.innerText));
  }

  function isResumeUploadField(field) {
    return Boolean(field?.querySelector?.('[data-automation-id="resumeUpload"]'));
  }

  function getUploadedFileItems(field) {
    return Array.from(field?.querySelectorAll?.('[data-automation-id="file-upload-item"]') ?? []).filter(isVisible);
  }

  // A questionnaire file-drop slot asking for the cover letter (e.g.
  // "Please upload a cover letter"). Workday gives it no stable
  // automation id of its own — only its question text tells it apart
  // from the resume drop zone and from any other upload (writing
  // sample, transcript) — so match on the label. Recognised with
  // either the empty-slot file input present OR an already-uploaded
  // file item, so it's still found after a file has been attached.
  function isCoverLetterUploadField(field) {
    if (!(field instanceof Element) || isResumeUploadField(field)) return false;
    if (!getFileInputInsideField(field) && getUploadedFileItems(field).length === 0) return false;
    return COVER_LETTER_QUESTION_PATTERN.test(getFieldQuestionText(field));
  }
  function findCoverLetterUploadField(root = getApplyPage() || document) {
    return (
      Array.from(root?.querySelectorAll?.('[data-automation-id^="formField-"]') ?? []).find(
        (field) => isVisible(field) && isCoverLetterUploadField(field)
      ) || null
    );
  }

  function getFieldQuestionText(field) {
    const node = getQuestionNode(field);
    const text = cleanQuestionText(node?.textContent || node?.innerText || "");
    if (text) return text;
    if (isResumeUploadField(field)) return "Resume/CV";
    return "";
  }

  // Stable-ish field identity: Workday's own `data-fkit-id` when it has
  // one (not the generic "--null" stamp some re-renders give every
  // field alike), else the primary control's id/name, else a slug of
  // the automation-id + question text.
  function getFieldId(field, question, control) {
    if (isResumeUploadField(field)) return "resume";
    if (isCoverLetterUploadField(field)) return "cover_letter";
    const fkitId = field?.getAttribute?.("data-fkit-id");
    if (fkitId && !fkitId.endsWith("--null")) return fkitId;
    if (control?.id) return control.id;
    if (control?.name) return control.name;
    const automationId = field?.getAttribute?.("data-automation-id");
    if (automationId) return `${automationId}-${question}`.replace(/\s+/g, "-").toLowerCase();
    return String(question || "").replace(/\s+/g, "-").toLowerCase();
  }

  // ---- control getters -----------------------------------------------
  // Workday's single-select is never a native <select> — it's a button
  // that opens a role="listbox" popup (see the listbox helpers below).
  function getSelectButton(field) {
    if (field?.matches?.('button[aria-haspopup="listbox"]')) return field;
    return field?.querySelector?.('button[aria-haspopup="listbox"]') || null;
  }

  // A plain text input, excluding the hidden/file/radio/checkbox control
  // types and the spinbutton date segments and multiselect's own search
  // input — same exclusion list BidHub's getVisibleTextInput uses, since
  // the engine's generic getTextInput doesn't know about Workday's
  // date/listbox-button markup and would otherwise mis-pick one of
  // those as the field's text input.
  function getVisibleTextInput(field) {
    const isVisibleTextInput = (input) => {
      const type = (input.type || "").toLowerCase();
      if (type === "hidden" || type === "file" || type === "radio" || type === "checkbox") return false;
      if (input.getAttribute("role") === "spinbutton") return false;
      if (input.closest('[data-automation-id="multiSelectContainer"]')) return false;
      if (field?.querySelector?.('button[aria-haspopup="listbox"]')) return false;
      return isVisible(input);
    };
    if (field?.tagName === "INPUT" && isVisibleTextInput(field)) return field;
    return Array.from(field?.querySelectorAll?.("input") ?? []).find(isVisibleTextInput) || null;
  }

  function getChoiceInputLabelText(input, fallback = "") {
    return getInputLabelText(input, fallback);
  }
  function getChoiceOptions(field, inputType) {
    return (inputType === "radio" ? getRadioInputs(field) : getCheckboxInputs(field))
      .map((input) => getChoiceInputLabelText(input))
      .filter(Boolean);
  }

  // Classifies a formField-* wrapper's primary control — same priority
  // order BidHub's getFieldMetadataSync checks in (file slot >
  // select-custom > radio > checkbox > textarea > plain text), minus
  // the date/multiselect/free-text-question branches this file doesn't
  // handle (those fall through to `null`, left for the generic pipeline).
  function classifyFieldKind(field) {
    if (isResumeUploadField(field) || isCoverLetterUploadField(field) || getFileInputInsideField(field)) return "file";
    if (getSelectButton(field)) return "select-custom";
    if (getRadioInputs(field).length > 0) return "radio";
    if (getCheckboxInputs(field).length > 0) return "checkbox";
    if (getTextarea(field)) return "textarea";
    if (getVisibleTextInput(field)) return "text";
    return null;
  }
  function getControlFor(field, fieldKind) {
    switch (fieldKind) {
      case "file":
        return getFileInputInsideField(field);
      case "select-custom":
        return getSelectButton(field);
      case "radio":
        return getRadioInputs(field)[0] || null;
      case "checkbox":
        return getCheckboxInputs(field)[0] || null;
      case "textarea":
        return getTextarea(field);
      case "text":
        return getVisibleTextInput(field);
      default:
        return null;
    }
  }

  /** Enumerate every fillable field on the current Workday apply-flow
   *  step: {question, fieldId, fieldKind, field, control, options,
   *  isResume, isCoverLetter}. `options` is populated for radio/
   *  checkbox; a select-custom's options only exist once its listbox is
   *  opened (fetchSelectOptions). */
  function detectFields(root = getApplyPage() || document) {
    const entries = [];
    const seenFieldIds = new Set();
    // Education/Work-history rows are now owned by the dedicated section-hierarchy port below — skip them here to avoid showing every field twice in the review list.
    const sectionContainers = [getWorkExperienceSection(), getEducationSection()].filter(Boolean);
    for (const field of getVisibleFieldWrappers(root)) {
      if (sectionContainers.some((container) => container.contains(field))) continue;
      const fieldKind = classifyFieldKind(field);
      if (!fieldKind) continue;
      const question = getFieldQuestionText(field);
      const control = getControlFor(field, fieldKind);
      const fieldId = getFieldId(field, question, control);
      if (!fieldId || seenFieldIds.has(fieldId)) continue;
      seenFieldIds.add(fieldId);
      entries.push({
        question,
        fieldId,
        fieldKind,
        field,
        control,
        options:
          fieldKind === "radio" ? getChoiceOptions(field, "radio") : fieldKind === "checkbox" ? getChoiceOptions(field, "checkbox") : null,
        isResume: fieldKind === "file" && isResumeUploadField(field),
        isCoverLetter: fieldKind === "file" && isCoverLetterUploadField(field),
      });
    }
    return entries;
  }

  function isAutofillAvailable() {
    return Boolean(detectFields().length || getAdvanceCandidate());
  }

  // ---- Workday's custom "select-custom" listbox dropdown -----------------
  function getListboxOptionText(option) {
    const promptOption = option?.querySelector?.('[data-automation-id="promptOption"]');
    return normalizeText(
      promptOption?.getAttribute("data-automation-label") ||
        promptOption?.textContent ||
        option?.getAttribute?.("aria-label")?.replace(/\s+(not\s+)?checked$/i, "") ||
        option?.textContent
    );
  }
  function isEmptyListboxOption(option) {
    return normalizeComparisonText(getListboxOptionText(option)).replace(/\.$/, "") === "no items";
  }
  // Each entry carries its own clickTarget: some tenants wrap the
  // clickable text in a nested promptOption/promptLeafNode span rather
  // than making the [role="option"] itself the hit target.
  function getListboxOptionEntries(listbox) {
    if (!listbox) return [];
    return Array.from(listbox.querySelectorAll('[role="option"]'))
      .filter((option) => isVisible(option) && option.getAttribute("aria-disabled") !== "true")
      .filter((option) => !isEmptyListboxOption(option))
      .map((option) => ({
        element: option,
        clickTarget:
          option.querySelector('[data-automation-id="promptOption"]') ||
          option.querySelector('[data-automation-id="promptLeafNode"]') ||
          option,
        text: getListboxOptionText(option),
      }))
      .filter((option) => option.text);
  }
  // A visible listbox can be "ready" (options rendered) or "empty" (the
  // "No Items" placeholder — a real, valid state, not a transient one).
  function getVisibleInteractiveListboxState() {
    const visibleListboxes = Array.from(document.querySelectorAll('[role="listbox"]'))
      .filter(isVisible)
      .filter((listbox) => listbox.getAttribute("data-automation-id") !== "selectedItemList");
    const readyListbox = visibleListboxes.find((listbox) => getListboxOptionEntries(listbox).length > 0);
    if (readyListbox) return { type: "ready", listbox: readyListbox };
    const emptyListbox = visibleListboxes.find((listbox) => Array.from(listbox.querySelectorAll('[role="option"]')).some(isEmptyListboxOption));
    if (emptyListbox) return { type: "empty", listbox: emptyListbox };
    return null;
  }
  function getVisibleInteractivePopup() {
    return (
      document.querySelector('[data-behavior-click-outside-close="always"]') ||
      document.querySelector('[data-behavior-click-outside-close="topmost"]')
    );
  }
  function dispatchEscapeKey(target) {
    if (!target?.dispatchEvent) return;
    for (const type of ["keydown", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, composed: true }));
    }
  }
  function dispatchClickAtPoint(x, y) {
    const target = document.elementFromPoint(x, y);
    if (!target?.dispatchEvent) return;
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, composed: true }));
    }
  }
  async function waitForListboxToClose(timeoutMs = LISTBOX_CLOSE_WAIT_TIMEOUT_MS) {
    return Boolean(await waitFor(() => (!getVisibleInteractivePopup() ? true : null), timeoutMs, 50));
  }
  // Escape first (cheap, no coordinate guessing); falls back to
  // clicking just outside the popup's own bounding box, then the page
  // corner — same fallback points BidHub's own closeOpenListbox tries,
  // for the rare popup that swallows Escape.
  async function closeOpenListbox() {
    const popup = getVisibleInteractivePopup();
    if (!popup) return;
    dispatchEscapeKey(document.activeElement);
    if (await waitForListboxToClose(400)) return;
    const rect = popup.getBoundingClientRect();
    const points = [
      { x: Math.max(8, Math.floor(rect.left) - 12), y: Math.max(8, Math.floor(rect.top) - 12) },
      { x: 8, y: 8 },
    ];
    for (const point of points) {
      dispatchClickAtPoint(point.x, point.y);
      if (await waitForListboxToClose()) return;
    }
    document.activeElement?.blur?.();
    await waitForListboxToClose();
  }
  function clickWorkdayOption(option) {
    const target = option?.clickTarget || option?.element;
    if (!(target instanceof Element)) return false;
    target.click();
    return true;
  }
  function selectButtonShowsOption(button, optionText) {
    const normalized = normalizeComparisonText(optionText);
    return Boolean(button) && Boolean(normalized) && normalizeComparisonText(button.textContent) === normalized;
  }
  // Workday commits the selection asynchronously (re-render + hidden
  // input write) — moving on the instant the popup closes can race the
  // commit and leave the button visually unset.
  async function waitForSelectCommit(button, optionText, timeoutMs = SELECT_COMMIT_WAIT_TIMEOUT_MS) {
    return Boolean(await waitFor(() => (selectButtonShowsOption(button, optionText) ? true : null), timeoutMs, 50));
  }
  /** The option list a select-custom field currently offers (opens the
   *  listbox, reads it, closes it again) — for a caller that needs to
   *  know the choices before picking one (e.g. Big Banana's existing
   *  preset pipeline resolving "Yes"/"No" against whatever this
   *  particular field actually calls its options). */
  async function fetchSelectOptions(field) {
    const button = getSelectButton(field);
    if (!button) return null;
    await clickLikeHuman(button);
    const state = await waitFor(() => {
      const s = getVisibleInteractiveListboxState();
      return s?.type === "ready" || s?.type === "empty" ? s : null;
    }, LISTBOX_WAIT_TIMEOUT_MS, 100);
    const options = state?.type === "ready" ? getListboxOptionEntries(state.listbox).map((o) => o.text) : [];
    await closeOpenListbox();
    return options;
  }

  // Best match for `answer` among `options` ([{text,...}] or
  // [string]): exact (normalized) match first, else the same
  // startsWith rule the engine's own findOptionElementByText uses for
  // a react-select combobox — applied here directly against each
  // entry's label TEXT rather than an element's own textContent, since
  // a radio/checkbox entry's "element" is the <input> itself (no
  // readable textContent of its own). NOT BidHub's AI "embedding
  // match" fallback; an option that misses both of these is left
  // unselected for Big Banana's own AI-answer pipeline.
  function getBestMatchingOption(answer, options) {
    if (!Array.isArray(options) || options.length === 0) return null;
    const answerText = Array.isArray(answer) ? answer[0] : answer;
    const normalizedAnswer = normalizeComparisonText(answerText);
    if (!normalizedAnswer) return null;
    const asEntry = (o) => (typeof o === "string" ? { text: o } : o);
    const entries = options.map(asEntry);
    const exact = entries.find((o) => normalizeComparisonText(o.text) === normalizedAnswer);
    if (exact) return exact;
    return entries.find((o) => normalizeComparisonText(o.text).startsWith(normalizedAnswer)) ?? null;
  }

  // ---- value fillers -------------------------------------------------
  // Workday single-line text inputs commit to the application model the
  // same way its textareas do (see the textarea branch below): the
  // `input` event only updates the widget's own visible React state,
  // while the model write happens on a REAL focusout. A synthetic
  // non-bubbling `blur` event (what fillTextInput dispatches) never
  // reaches React's root listener, so a write without a genuine
  // focus()→blur() pair leaves the field SHOWING the value while
  // Workday's save-validation still rejects it as empty. Verified
  // quirk, not a guess — same sequence BidHub's fillWorkdayTextInput uses.
  async function fillTextField(input, value) {
    if (!input) return false;
    input.focus();
    await fillTextInputReliably(input, String(value ?? ""), { blur: false });
    input.blur();
    return true;
  }

  // Workday validates multi-line text against a fixed illegal-character
  // set (`< > [ ] { } \ "` — its own "Contains illegal characters"
  // inline error). Substitute rather than strip so the content survives
  // ("<1s" → "under 1s", not "1s"); newlines are kept, only intra-line
  // whitespace runs collapse.
  const WORKDAY_ILLEGAL_TEXT_CHARS_PATTERN = /[<>[\]{}\\"]/;
  function sanitizeWorkdayTextareaValue(value) {
    const text = String(value ?? "");
    if (!WORKDAY_ILLEGAL_TEXT_CHARS_PATTERN.test(text)) return text;
    return text
      .split("\n")
      .map((line) =>
        line
          .replace(/(?:->|=>)/g, " to ")
          .replace(/<=\s*(?=\d)/g, "at most ")
          .replace(/>=\s*(?=\d)/g, "at least ")
          .replace(/<\s*(?=\d)/g, "under ")
          .replace(/>\s*(?=\d)/g, "over ")
          .replace(/[<>]/g, "")
          .replace(/"/g, "'")
          .replace(/[[{]/g, "(")
          .replace(/[\]}]/g, ")")
          .replace(/\\/g, "/")
          .replace(/[ \t ]{2,}/g, " ")
          .trim()
      )
      .join("\n");
  }
  async function fillTextareaField(textarea, value) {
    const text = sanitizeWorkdayTextareaValue(value);
    if (!textarea || !text) return false;
    textarea.focus();
    await fillTextInputReliably(textarea, text, { blur: false });
    textarea.blur();
    return true;
  }

  // Click the button to open the listbox, wait for it to render, pick
  // the best-matching option, confirm the button's own text updated
  // (Workday's async commit), then make sure the popup actually closed.
  async function fillSelectCustomField(field, answer) {
    const button = getSelectButton(field);
    const text = String(Array.isArray(answer) ? answer[0] : answer ?? "").trim();
    if (!button || !text) return false;
    const currentText = normalizeComparisonText(button.textContent);
    if (currentText && currentText === normalizeComparisonText(text) && currentText !== "select one") return true;
    await clickLikeHuman(button);
    const listboxState = await waitFor(() => {
      const state = getVisibleInteractiveListboxState();
      return state?.type === "ready" || state?.type === "empty" ? state : null;
    }, LISTBOX_WAIT_TIMEOUT_MS, 100);
    if (!listboxState || listboxState.type !== "ready") {
      await closeOpenListbox();
      return false;
    }
    const options = getListboxOptionEntries(listboxState.listbox);
    const selected = getBestMatchingOption(text, options);
    if (!selected?.element) {
      await closeOpenListbox();
      return false;
    }
    clickWorkdayOption(selected);
    const committed = await waitForSelectCommit(button, selected.text);
    await waitForListboxToClose();
    return committed;
  }

  async function fillRadioField(field, answer) {
    const options = getRadioInputs(field)
      .map((input) => ({ input, text: getChoiceInputLabelText(input) }))
      .filter((option) => option.text);
    const best = getBestMatchingOption(answer, options.map((o) => ({ element: o.input, text: o.text })));
    const match = best && options.find((option) => option.input === best.element);
    if (!match?.input) return false;
    if (!match.input.checked) await clickLikeHuman(match.input);
    return true;
  }

  async function fillCheckboxField(field, answer) {
    const inputs = getCheckboxInputs(field);
    if (inputs.length === 0) return false;
    const selections = (Array.isArray(answer) ? answer : [answer]).map(normalizeComparisonText);
    for (const input of inputs) {
      const labelText = normalizeComparisonText(getChoiceInputLabelText(input));
      const shouldCheck =
        inputs.length === 1
          ? selections.includes("yes") || selections.includes("true")
          : selections.includes(labelText) || selections.includes(normalizeComparisonText(input.value));
      if (input.checked !== shouldCheck) await clickLikeHuman(input);
    }
    return true;
  }

  // Some tenants keep the old File on the native input even after their
  // own "Remove file" control is clicked — re-attaching the same/new
  // file would then be a no-op for the framework's onChange. Click any
  // visible delete/remove control first and wait for either the file
  // list to shrink or a fresh empty file input to appear before attaching.
  async function ensureEmptyFileInput(field, timeoutMs = FILE_UPLOAD_WAIT_TIMEOUT_MS) {
    const existingItems = getUploadedFileItems(field);
    const deleteButton = existingItems
      .map(
        (item) =>
          item.querySelector('[data-automation-id="delete-file"]') ||
          Array.from(item.querySelectorAll("button")).find((button) =>
            /\b(delete|remove)\b/i.test(normalizeText(button.textContent || button.getAttribute("aria-label")))
          )
      )
      .find((button) => button && isVisible(button));
    if (deleteButton) {
      deleteButton.click();
      await waitFor(() => (getUploadedFileItems(field).length < existingItems.length ? true : null), timeoutMs, 100);
    }
    const existingInput = getFileInputInsideField(field);
    if (existingInput) return existingInput;
    const removeButton = Array.from(field?.querySelectorAll?.("button") ?? []).find((button) =>
      /\b(remove|delete|replace)\b/i.test(normalizeText(button.textContent || button.getAttribute("aria-label")))
    );
    if (!removeButton) return null;
    removeButton.click();
    return waitFor(() => getFileInputInsideField(field), timeoutMs, 100);
  }

  async function fillFileField(field, answer) {
    if (!answer || typeof answer !== "object" || !answer.fileName || !answer.base64) return false;
    const input = await ensureEmptyFileInput(field);
    if (!input) return false;
    fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
    return true;
  }

  /** Write `answer` into a detected field entry, using the mechanism its
   *  fieldKind needs. For 'radio'/'checkbox'/'select-custom', `answer`
   *  is matched against the field's own option text (getBestMatchingOption)
   *  rather than written verbatim. For 'file', `answer` is
   *  `{fileName, base64, mimeType}`. Returns true on an apparent success. */
  async function fillField(entry, answer) {
    if (!entry || answer == null) return false;
    const { fieldKind, field, control } = entry;
    switch (fieldKind) {
      case "text":
        return fillTextField(control || getVisibleTextInput(field), answer);
      case "textarea":
        return fillTextareaField(control || getTextarea(field), answer);
      case "select-custom":
        return fillSelectCustomField(field, answer);
      case "radio":
        return fillRadioField(field, answer);
      case "checkbox":
        return fillCheckboxField(field, answer);
      case "file":
        return fillFileField(field, answer);
      default:
        return false;
    }
  }

  // ---- Next/Continue/Review/Submit button classifier ----------------------
  // The one piece BidHub leans on hardest for Workday: its multi-step
  // flow has no single "Next button" automation-id that's stable across
  // every step shape (the apply-method dialog, the job-detail page, the
  // plain footer, a step mid-save with its Continue disabled) — so a
  // button is classified by a SAFE/UNSAFE/NON-ADVANCE regex triage over
  // its own text + automation-id, not matched by a fixed selector.
  // Faithfully ported: loosening these patterns risks the opposite
  // failure modes (clicking Submit a step early, or never clicking a
  // real Continue).
  function getButtonText(button) {
    return normalizeText(
      button?.getAttribute?.("aria-label") || button?.getAttribute?.("data-automation-label") || button?.textContent || button?.innerText || ""
    );
  }
  function isButtonDisabled(button) {
    return Boolean(button?.disabled || button?.getAttribute?.("aria-disabled") === "true");
  }
  // allowDisabled: used by getBusyAdvanceButton, which specifically
  // wants the safe-advance target WHILE it's disabled (Workday's "step
  // save in flight" state — see getBusyAdvanceButton below).
  function isSafeAdvanceButton(button, { allowDisabled = false } = {}) {
    if (!(button instanceof Element) || !isVisible(button)) return false;
    if (!allowDisabled && isButtonDisabled(button)) return false;
    const buttonText = getButtonText(button);
    const automationId = normalizeComparisonText(button.getAttribute("data-automation-id"));
    const searchableText = normalizeText(`${buttonText} ${automationId}`);
    const hasSafeAutomationId = /next|continue|review|preview/.test(automationId);
    const hasUnsafeAutomationId = /submit|apply|complete|finish|done|send/.test(automationId);
    const hasNonAdvanceAutomationId = /back|previous|cancel|close|delete|remove|upload|browse|choose|skip/.test(automationId);
    if (!hasSafeAutomationId && !SAFE_ADVANCE_BUTTON_TEXT_PATTERN.test(searchableText)) return false;
    if (hasUnsafeAutomationId || UNSAFE_ADVANCE_BUTTON_TEXT_PATTERN.test(searchableText)) return false;
    if (hasNonAdvanceAutomationId || NON_ADVANCE_BUTTON_TEXT_PATTERN.test(searchableText)) return false;
    return true;
  }
  // Picks the single best advance candidate on the page: ranked
  // next/continue-over-review, then (same rank) the visually LOWER/
  // RIGHTER button, since a footer's real forward button sits after
  // any secondary "Save for later" link in reading order.
  function getSafeAdvanceButton() {
    const page = getApplyPage() || document;
    const rank = (button) => {
      const automationId = normalizeComparisonText(button.getAttribute("data-automation-id"));
      const text = normalizeComparisonText(getButtonText(button));
      if (/next|continue/.test(automationId) || /\b(next|continue)\b/.test(text)) return 0;
      if (/review|preview/.test(automationId) || /\b(review|preview)\b/.test(text)) return 1;
      return 2;
    };
    return (
      Array.from(page.querySelectorAll('button, [role="button"]'))
        .filter((button) => isSafeAdvanceButton(button))
        .sort((left, right) => {
          const rankDelta = rank(left) - rank(right);
          if (rankDelta !== 0) return rankDelta;
          const leftRect = left.getBoundingClientRect();
          const rightRect = right.getBoundingClientRect();
          return rightRect.top + rightRect.left - (leftRect.top + leftRect.left);
        })[0] || null
    );
  }
  // The footer Next/Continue that WOULD be the safe-advance target
  // except it's currently disabled — Workday's "step save in flight"
  // state: disabled for the whole Save-and-Continue round trip with NO
  // other visible signal (no spinner, no aria-busy). Surfaced so a
  // caller can tell "present, not clickable yet" apart from "nothing to
  // click at all" and keep waiting instead of giving up on the step.
  function getBusyAdvanceButton() {
    const page = getApplyPage() || document;
    return (
      Array.from(page.querySelectorAll('button, [role="button"]')).find(
        (button) => isSafeAdvanceButton(button, { allowDisabled: true }) && isButtonDisabled(button)
      ) || null
    );
  }
  // The job-detail page's primary Apply button — only resolved when NOT
  // already inside the apply flow, so a Submit/Next button mid-form is
  // never mistaken for it.
  function getDetailApplyButton() {
    if (!isDetailPage()) return null;
    const byAutomationId = document.querySelector('[data-automation-id="applyButton"]');
    if (byAutomationId && isVisible(byAutomationId)) return byAutomationId;
    return (
      Array.from(document.querySelectorAll('button, a[role="button"]')).find((el) => {
        if (!isVisible(el)) return false;
        const text = normalizeText(el.getAttribute("aria-label") || el.textContent || "");
        // Bare "Apply"/"Apply Now"/"Apply for Job" — not "Applied" or
        // "Apply with LinkedIn" (an alternate, non-manual apply route).
        return /^apply(\s+(now|for\s+\w+))?$/i.test(text);
      }) || null
    );
  }
  function isApplyDialogOpen() {
    return Array.from(document.querySelectorAll('[data-automation-id="applyManually"], [role="dialog"], dialog[open], [aria-modal="true"]')).some(
      (el) => isVisible(el)
    );
  }
  // The "Apply Manually" option inside the apply-method chooser dialog
  // (vs. "Apply with LinkedIn"/SSO) — only the manual route is ever
  // clicked here.
  function getApplyManuallyButton() {
    if (!isApplyDialogOpen()) return null;
    for (const id of ["applyManually", "manualApplyButton", "apply-manually"]) {
      const el = document.querySelector(`[data-automation-id="${id}"]`);
      if (el && isVisible(el)) return el;
    }
    for (const dialog of document.querySelectorAll('[role="dialog"], dialog[open], [aria-modal="true"]')) {
      if (!isVisible(dialog)) continue;
      for (const button of dialog.querySelectorAll('button, a[role="button"], a')) {
        if (!isVisible(button)) continue;
        const text = normalizeText(button.getAttribute("aria-label") || button.textContent || "");
        if (/\bapply\s+manually\b/i.test(text)) return button;
      }
    }
    return null;
  }
  // The final footer Submit — Workday reuses the SAME
  // `pageFooterNextButton` automation-id for every footer action across
  // the whole flow (Next, Review, Submit all share it); only its LABEL
  // tells the final step apart, hence the UNSAFE-pattern check here
  // rather than a dedicated submit automation-id.
  function getSubmitButton() {
    const button = document.querySelector('[data-automation-id="pageFooterNextButton"]');
    if (!button || !isVisible(button)) return null;
    return UNSAFE_ADVANCE_BUTTON_TEXT_PATTERN.test(getButtonText(button)) ? button : null;
  }
  // Any of the boundary-crossing OR in-form controls advance() would
  // click — used by isAutofillAvailable() to tell "nothing to do yet"
  // apart from "a button is available even though there are 0 fields"
  // (e.g. a field-less interstitial step).
  function getAdvanceCandidate() {
    return getApplyManuallyButton() || getDetailApplyButton() || getSafeAdvanceButton() || getBusyAdvanceButton();
  }

  // Resolves the interactive click target for a button Workday renders
  // as an aria-hidden element with a sibling `[data-automation-id=
  // "click_filter"]` div as the ACTUAL React-handled click target (seen
  // on the footer Next/Submit and some auth buttons) — click the
  // click_filter when present, never the hidden button itself.
  function getClickTarget(button) {
    if (!(button instanceof Element)) return null;
    const clickFilter = button.parentElement?.querySelector('[data-automation-id="click_filter"]');
    if (clickFilter && isVisible(clickFilter)) return clickFilter;
    return isVisible(button) ? button : null;
  }
  async function clickWorkdayButton(button) {
    const target = getClickTarget(button);
    if (!target) return false;
    await clickLikeHuman(target);
    return true;
  }

  /** Advance one step: click the apply-method dialog's "Apply Manually",
   *  or the job-detail page's "Apply", or the form's own safe
   *  Next/Continue/Review. Returns true if an IN-FORM Next was clicked
   *  (caller should re-detect and keep filling); false if only a
   *  posting→form-style boundary was crossed (nothing left to fill on
   *  THIS page — the revealed form is a fresh detection) or there's
   *  nothing safe to click yet (e.g. getBusyAdvanceButton — still
   *  saving). Never clicks Submit — see clickSubmit for the final step. */
  async function advance() {
    const applyManually = getApplyManuallyButton();
    if (applyManually) {
      await clickWorkdayButton(applyManually);
      return false;
    }
    const detailApply = getDetailApplyButton();
    if (detailApply) {
      await clickWorkdayButton(detailApply);
      return false;
    }
    const button = await waitFor(getSafeAdvanceButton, AUTOFILL_ADVANCE_WAIT_MS);
    if (!button) return false;
    await clickWorkdayButton(button);
    return true;
  }
  // Clicks the final footer Submit. Kept separate from advance() so a
  // caller only ever submits the application deliberately.
  async function clickSubmit() {
    const button = getSubmitButton();
    if (!button || isButtonDisabled(button)) return false;
    return clickWorkdayButton(button);
  }

  // ---- repeatable Education History / Work Experience sections ---------
  // Ported from BidHub's own Workday section descriptors (Work-Experience-
  // section / Education-section), driven by the shared
  // engine/section-hierarchy.js root→group→leaf model. Every row-level
  // write reuses this file's OWN generic field fillers (fillTextField,
  // fillTextareaField, fillSelectCustomField) rather than reimplementing
  // them — same mechanics the non-section fields above already rely on.
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;

  function getSectionGroupByHeadingId(sectionId) {
    return document.getElementById(sectionId)?.closest('[role="group"][aria-labelledby]') || null;
  }
  function getWorkExperienceSection() {
    return getSectionGroupByHeadingId("Work-Experience-section");
  }
  function getEducationSection() {
    return getSectionGroupByHeadingId("Education-section");
  }
  // Each row is a `[role="group"][aria-labelledby]` wrapper identified by
  // its own `h5[id$="-panel"]` heading — Workday gives these rows no
  // dedicated automation-id of their own, same structural marker BidHub's
  // own getBlockRows keys off of.
  function getBlockRows(section) {
    if (!section) return [];
    return Array.from(section.querySelectorAll('h5[id$="-panel"]'))
      .map((heading) => heading.closest('[role="group"][aria-labelledby]'))
      .filter(Boolean);
  }
  // Workday reuses `data-automation-id="add-button"` on more than one
  // button inside a section — take the LAST visible one, same rule
  // BidHub's own clickSectionAddButton follows.
  async function clickSectionAddButton(container) {
    const buttons = Array.from(container?.querySelectorAll?.('button[data-automation-id="add-button"]') ?? []).filter(isVisible);
    const button = buttons[buttons.length - 1];
    if (button) await clickLikeHuman(button);
  }
  // Deletes rows in REVERSE order (removing one can shift later rows'
  // indices) by finding a delete-labelled button inside each row — same
  // strategy BidHub's own clearBlockRows uses.
  async function clearBlockRows(container) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = getBlockRows(container);
      if (rows.length === 0) return;
      for (let i = rows.length - 1; i >= 0; i--) {
        const deleteBtn = Array.from(rows[i].querySelectorAll("button")).find((b) =>
          /\bdelete\b/i.test(normalizeText(b.getAttribute("aria-label") || b.textContent))
        );
        if (deleteBtn) await clickLikeHuman(deleteBtn);
      }
      await sleep(180);
    }
  }
  function getRowFieldByNameOrIdSuffix(rowEl, key) {
    return rowEl.querySelector(`input[name="${key}"]`) || rowEl.querySelector(`[id$="--${key}"]`) || null;
  }
  // Date wrapper: `[data-automation-id="dateInputWrapper"][id$="--<key>"]`
  // with the actual typed-date text input nested inside it.
  function getDateWrapperInput(rowEl, key) {
    const wrapper = rowEl.querySelector(`[data-automation-id="dateInputWrapper"][id$="--${key}"]`);
    if (!wrapper) return null;
    return wrapper.querySelector('input[type="text"]') || wrapper;
  }
  function getWorkHistoryRowField(rowEl, mapping) {
    switch (mapping.key) {
      case "jobTitle":
      case "companyName":
      case "location":
      case "currentlyWorkHere": {
        const input = getRowFieldByNameOrIdSuffix(rowEl, mapping.key);
        return input ? { field: input } : null;
      }
      case "startDate":
      case "endDate": {
        const input = getDateWrapperInput(rowEl, mapping.key);
        return input ? { field: input } : null;
      }
      case "roleDescription": {
        const textarea = rowEl.querySelector('textarea[id$="--roleDescription"]');
        return textarea ? { field: textarea } : null;
      }
      default:
        return null;
    }
  }
  function getEducationRowField(rowEl, mapping) {
    switch (mapping.key) {
      case "firstYearAttended":
      case "lastYearAttended": {
        const input = getDateWrapperInput(rowEl, mapping.key);
        return input ? { field: input } : null;
      }
      case "school":
      case "degree":
      case "fieldOfStudy":
      case "gradeAverage": {
        // best-effort: Degree/Field of Study can render as either a plain
        // named input or Workday's own custom listbox button — resolve
        // whichever this row actually has, scoped by the key's own id/name
        // suffix; fillSectionLeaf's 'dropdown' case decides how to write it.
        const wrapper = rowEl.querySelector(`[id$="--${mapping.key}"]`);
        const button =
          (wrapper?.matches?.('button[aria-haspopup="listbox"]') && wrapper) ||
          wrapper?.querySelector?.('button[aria-haspopup="listbox"]');
        if (button) return { field: button };
        const input = getRowFieldByNameOrIdSuffix(rowEl, mapping.key);
        return input ? { field: input } : null;
      }
      default:
        return null;
    }
  }

  // BCD's Profile.experience/.education store dates as a raw month-input
  // string ("2022-01", no day) — Work Experience's From/To fields are a
  // single typed-date text input expecting a full date; the day segment
  // defaults to the 1st (best-effort — no day value exists in BCD's
  // profile to carry over; Workday's own calendar picker would normally
  // supply it).
  function formatWorkdayFullDate(raw) {
    const s = String(raw || "").trim();
    const m = /^(\d{4})-(\d{1,2})$/.exec(s);
    if (!m) return "";
    return `${m[2].padStart(2, "0")}/01/${m[1]}`;
  }
  // Education's "From Year"/"To Year" fields are year-only.
  function formatWorkdayYear(raw) {
    const s = String(raw || "").trim();
    const m = /^(\d{4})(?:-\d{1,2})?$/.exec(s);
    return m ? m[1] : "";
  }
  const stillOngoing = (entry) => !String(entry?.end || "").trim();

  const WORKDAY_WORK_HISTORY_SECTION = {
    rootFieldId: "workHistory",
    rootQuestion: "Work Experience",
    profileSection: "experience",
    rowLabel: (i) => `Work Experience ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: getWorkExperienceSection,
    getRows: getBlockRows,
    getRowField: getWorkHistoryRowField,
    addRow: clickSectionAddButton,
    clearRows: clearBlockRows,
    mappings: [
      { key: "jobTitle", profileKey: "role", question: "Job Title", fieldKind: "text" },
      { key: "companyName", profileKey: "company", question: "Company", fieldKind: "text" },
      { key: "location", profileKey: "location", question: "Location", fieldKind: "text" },
      { key: "currentlyWorkHere", question: "I currently work here", fieldKind: "checkbox", resolveValue: stillOngoing },
      { key: "startDate", question: "From", fieldKind: "date", resolveValue: (entry) => formatWorkdayFullDate(entry?.start) },
      {
        key: "endDate",
        question: "To",
        fieldKind: "date",
        resolveValue: (entry) => (stillOngoing(entry) ? null : formatWorkdayFullDate(entry?.end)),
      },
      // No BCD Profile.experience equivalent (no free-text role summary
      // field) — detected only, shown empty in the review UI.
      { key: "roleDescription", question: "Role Description", fieldKind: "textarea" },
    ],
  };

  const WORKDAY_EDUCATION_SECTION = {
    rootFieldId: "educationHistory",
    rootQuestion: "Education",
    profileSection: "education",
    rowLabel: (i) => `Education ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: getEducationSection,
    getRows: getBlockRows,
    getRowField: getEducationRowField,
    addRow: clickSectionAddButton,
    clearRows: clearBlockRows,
    mappings: [
      { key: "school", profileKey: "school", question: "School", fieldKind: "text" },
      // best-effort — Workday's own custom listbox widget; see
      // fillSectionLeaf's 'dropdown' case.
      { key: "degree", profileKey: "degree", question: "Degree", fieldKind: "dropdown" },
      // No BCD Profile.education equivalent (school/degree/start/end
      // only, no field-of-study) — detected only.
      { key: "fieldOfStudy", question: "Field of Study", fieldKind: "dropdown" },
      // No BCD Profile.education equivalent — detected only.
      { key: "gradeAverage", question: "Grade Average", fieldKind: "text" },
      { key: "firstYearAttended", question: "From Year", fieldKind: "date", resolveValue: (entry) => formatWorkdayYear(entry?.start) },
      {
        key: "lastYearAttended",
        question: "To Year",
        fieldKind: "date",
        resolveValue: (entry) => (stillOngoing(entry) ? null : formatWorkdayYear(entry?.end)),
      },
    ],
  };

  const SECTIONS = [WORKDAY_WORK_HISTORY_SECTION, WORKDAY_EDUCATION_SECTION];

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections(SECTIONS, profileData);
  }

  async function fillSectionLeaf(field, mapping, value) {
    switch (mapping.fieldKind) {
      case "text":
      case "date":
        // Reuses this file's own fillTextField (the documented genuine
        // focus()->blur() dance Workday's model-commit needs — a plain
        // dispatched blur event alone doesn't reach React's listener here).
        await fillTextField(field, value);
        return;
      case "textarea":
        await fillTextareaField(field, value);
        return;
      case "dropdown": {
        const isListboxButton = field?.matches?.('button[aria-haspopup="listbox"]');
        if (isListboxButton) {
          // Reuses the generic listbox-select mechanics already defined
          // above (getSelectButton accepts the button element directly).
          await fillSelectCustomField(field, value);
          return;
        }
        // best-effort fallback — this row rendered a plain input instead
        // of the listbox widget; typed-search is a reasonable
        // approximation of the same combobox-shaped control.
        await engine.fillComboboxByTyping(field, value);
        return;
      }
      case "checkbox": {
        const input = field?.tagName === "INPUT" ? field : field?.querySelector?.('input[type="checkbox"]');
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
    for (const section of SECTIONS) {
      const entries = (profileData && profileData[section.profileSection]) || [];
      if (!entries.length) continue;
      const result = await SECTION_HIERARCHY.fillSection(section, entries, fillSectionLeaf);
      results.push({ rootFieldId: section.rootFieldId, ...result });
    }
    return results;
  }

  NS.workday = {
    isDetailPage,
    isAutofillAvailable,
    detectFields,
    fillField,
    fetchSelectOptions,
    getSubmitButton,
    isButtonDisabled,
    advance,
    clickSubmit,
    findCoverLetterUploadField,
    detectSections,
    fillSections,
  };
})();
