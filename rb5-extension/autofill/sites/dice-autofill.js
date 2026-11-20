/* =====================================================================
 * autofill/sites/dice-autofill.js — Dice (dice.com) apply-form autofill.
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/dice/autofill.js.
 *
 * Architecture note: in BidHub's own bundle this site file is a thin
 * registration (`registerAutofillHandlers({ detectFields, ... })`) against
 * a ~2200-line generic engine (packages/job-parsers/content/platforms/
 * autofill-shared.js) that owns message-port plumbing to its background,
 * an auto-apply driver, a cross-field "question bank", and the backend
 * free-text-answer loop (getAnswer()/getEmbeddingMatch() — AI-backend
 * calls, explicitly out of scope for this port, same as CAPTCHA-solving
 * and the remote-CDP/proxy lane). Big Banana has no equivalent generic
 * autofill-runtime engine yet — only the low-level DOM-primitive engine
 * (ProactiveAutofillEngine) is shared — so this file is self-contained:
 * it replicates BidHub's OWN orchestration shape (field detection +
 * caching, a message_type-keyed listener exactly like BidHub's own
 * ensureListener/onMessage, per-field-kind fill dispatch, and wizard
 * step advancement) at the single-site scope the task calls for, instead
 * of standing up a new shared engine file. Every DOM write/click
 * primitive still goes through window.ProactiveAutofillEngine.* — this
 * file only contains Dice-specific selectors/flow and that orchestration
 * shim.
 *
 * Fields whose value Big Banana itself decides via AI (free text,
 * single/multi-select "best answer") are detected and reported here, but
 * this file only ever WRITES a value when told one explicitly via
 * 'fillAutofillField' — generating the value is Big Banana's existing
 * generic pipeline's job, not this file's.
 * ==================================================================== */
(function () {
  "use strict";

  const Engine = window.ProactiveAutofillEngine;
  if (!Engine) return; // engine script loads first per manifest ordering; bail defensively if it didn't

  const APPLY_TRIGGER_SELECTOR = 'a[data-testid="apply-button"]';
  const SITE_CHROME_SELECTOR = 'header, nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]';
  const REQUIRED_MARKER_PATTERN = /[✱*]/g;
  const FIELD_KIND_UPLOAD = "upload";
  const FILE_INPUT_WAIT_TIMEOUT_MS = 3000;

  // ---- text helpers -----------------------------------------------------

  function normalizeDiceText(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(REQUIRED_MARKER_PATTERN, "")
      .replace(/\bOptional\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeComparisonText(value) {
    return normalizeDiceText(value)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
  }

  function slugifyFieldId(value) {
    return normalizeComparisonText(value)
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function isElementVisible(element, { allowHiddenInput = false } = {}) {
    if (!element?.isConnected) return false;
    // A radio/checkbox/file input is routinely visually hidden behind a
    // styled label (Dice's own custom-styled radio pills do this) — the
    // control itself being display:none doesn't mean the field isn't usable.
    if (allowHiddenInput && element.matches?.('input[type="file"], input[type="radio"], input[type="checkbox"]')) {
      return true;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ---- apply form / field-question resolution ---------------------------

  // Dice doesn't mark its apply form with a stable id/class — pick the
  // visible <form> that looks most like an application (most inputs, with
  // extra weight for radio groups / file inputs / a submit button, since a
  // lone search-box <form> elsewhere on the page would otherwise tie).
  function getDiceApplyForm() {
    const forms = Array.from(document.querySelectorAll("form")).filter((form) => {
      if (!isElementVisible(form)) return false;
      const score =
        form.querySelectorAll("input, select, textarea").length +
        form.querySelectorAll('[role="radiogroup"]').length * 4 +
        form.querySelectorAll('input[type="file"]').length * 5 +
        form.querySelectorAll('button[type="submit"]').length * 2;
      return score > 0;
    });
    return (
      forms
        .map((form) => ({ form, score: form.querySelectorAll("input, select, textarea, [role=\"radiogroup\"]").length }))
        .sort((left, right) => right.score - left.score)[0]?.form ?? null
    );
  }

  function ensureUniqueFieldId(fieldId, usedFieldIds) {
    if (!fieldId) return null;
    let nextFieldId = fieldId;
    let suffix = 2;
    while (usedFieldIds.has(nextFieldId)) {
      nextFieldId = `${fieldId}-${suffix}`;
      suffix += 1;
    }
    usedFieldIds.add(nextFieldId);
    return nextFieldId;
  }

  // A radiogroup's question text is often only reachable via
  // aria-labelledby pointing at one or more ids elsewhere in the document
  // (not a descendant) — concatenate whatever they resolve to.
  function getTopLevelTextFromIds(ids) {
    return String(ids ?? "")
      .split(/\s+/)
      .map((id) => normalizeDiceText(document.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(" ");
  }

  function getFieldQuestionText(field, control = null) {
    if (!field) return "";
    if (field.getAttribute("role") === "radiogroup") {
      const labelledText = getTopLevelTextFromIds(field.getAttribute("aria-labelledby"));
      if (labelledText) return labelledText;
    }
    if (control?.id) {
      const escapedId = window.CSS?.escape ? window.CSS.escape(control.id) : control.id;
      const linkedLabel = document.querySelector(`label[for="${escapedId}"]`);
      const linkedText = normalizeDiceText(linkedLabel?.textContent);
      if (linkedText) return linkedText;
    }
    // Dice's own question-row markup, newest-template classes first,
    // falling back to a plain <label>/<legend> and finally the control's
    // own associated <label> element (via the shared engine's resolver).
    const candidates = [
      field.querySelector('[slot="label"]'),
      field.querySelector(".inline.font-medium"),
      field.querySelector(".font-medium.text-zinc-900"),
      field.querySelector("label"),
      field.querySelector("legend"),
      control?.labels?.[0],
    ];
    for (const candidate of candidates) {
      const text = normalizeDiceText(candidate?.textContent);
      if (text) return text;
    }
    return normalizeDiceText(Engine.getInputLabelText(control));
  }

  function getChoiceInputLabelText(input, fallbackQuestion = "") {
    const labelText = normalizeDiceText(input?.closest("label")?.textContent);
    if (labelText) return labelText;
    return normalizeDiceText(input?.value || fallbackQuestion);
  }

  // answerType/fieldKind/options only — constraints (maxLength, pattern,
  // inferred input type) are dropped: BidHub only ever fed those to the
  // backend free-text-answer generator, which is out of scope here.
  function getFieldMetadataSync(question, field, control = null) {
    const radioInputs = Engine.getRadioInputs(field);
    if (radioInputs.length > 0) {
      return {
        answerType: "single-select",
        fieldKind: "radio",
        options: radioInputs.map((input) => getChoiceInputLabelText(input, question)).filter(Boolean),
      };
    }
    const checkboxInputs = Engine.getCheckboxInputs(field);
    if (checkboxInputs.length > 0) {
      return {
        answerType: checkboxInputs.length === 1 ? "single-select" : "multi-select",
        fieldKind: "checkbox",
        options: checkboxInputs.map((input) => getChoiceInputLabelText(input, question)).filter(Boolean),
      };
    }
    const textarea = Engine.getTextarea(field);
    if (textarea) return { answerType: "text", fieldKind: "textarea", options: [] };
    const select = Engine.getNativeSelect(field);
    if (select) {
      const options = Array.from(select.querySelectorAll("option"))
        .filter((option) => option.value)
        .map((option) => normalizeDiceText(option.textContent))
        .filter(Boolean);
      return { answerType: "single-select", fieldKind: "select-native", options };
    }
    if (control) return { answerType: "text", fieldKind: "text", options: [] };
    return { answerType: null, fieldKind: null, options: null };
  }

  // ---- resume / cover-letter upload cards --------------------------------

  function getUploadFieldKeyword(question) {
    const normalizedQuestion = normalizeComparisonText(question);
    if (/\b(resume|cv)\b/.test(normalizedQuestion)) return "resume";
    if (/cover\s*letter/.test(normalizedQuestion)) return "cover letter";
    return normalizedQuestion;
  }

  function getUploadFieldInput(field, question) {
    const directInput = Engine.getFileInputInsideField(field);
    if (directInput) return directInput;
    if (field?.nextElementSibling?.matches?.('input[type="file"]')) return field.nextElementSibling;
    const form = field?.closest("form");
    if (!form) return null;
    const keyword = getUploadFieldKeyword(question);
    const fileInputs = Array.from(form.querySelectorAll('input[type="file"]'));
    return fileInputs.find((input) => normalizeComparisonText(input.getAttribute("aria-describedby")).includes(keyword)) ?? null;
  }

  function getDeleteUploadMenuItem() {
    return (
      Array.from(document.querySelectorAll('[data-placement="bottom"] [role="menuitem"]')).find((item) =>
        normalizeComparisonText(item.textContent).includes("delete")
      ) ?? null
    );
  }

  async function waitForCondition(check, timeoutMs, intervalMs = 100) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const result = check();
      if (result) return result;
      if (Date.now() >= deadline) return null;
      await Engine.sleep(intervalMs);
    }
  }

  // Dice's upload widget has no bare "clear" — once a file is attached,
  // getting a fresh native <input type="file"> back means opening its
  // "File options" kebab menu and clicking "Delete" first, which Dice
  // re-renders as a brand new (empty) input.
  async function ensureUploadInput(field, question) {
    const existingInput = getUploadFieldInput(field, question);
    if (existingInput) return existingInput;
    const menuButton = field?.querySelector('button[aria-label="File options"]');
    if (!menuButton) return null;
    menuButton.click();
    const deleteMenuItem = await waitForCondition(() => getDeleteUploadMenuItem(), FILE_INPUT_WAIT_TIMEOUT_MS);
    if (!deleteMenuItem) return null;
    deleteMenuItem.click();
    return waitForCondition(() => getUploadFieldInput(field, question), FILE_INPUT_WAIT_TIMEOUT_MS);
  }

  function detectUploadFields(form, usedFieldIds) {
    const uploadCardCandidates = Array.from(form.querySelectorAll("div")).filter((element) => {
      if (!isElementVisible(element)) return false;
      if (!element.querySelector('button[aria-label="File options"], button[type="button"]')) return false;
      const normalizedQuestion = normalizeComparisonText(getFieldQuestionText(element));
      return /\b(resume|cv)\b/.test(normalizedQuestion) || /cover\s*letter/.test(normalizedQuestion);
    });
    // Dice nests the resume card and its "Cover letter" sibling inside a
    // shared outer container that would ALSO pass the check above — keep
    // only the innermost match so each upload slot is reported once.
    const uploadCards = uploadCardCandidates.filter(
      (element) => !uploadCardCandidates.some((candidate) => candidate !== element && candidate.contains(element))
    );

    const fields = [];
    for (const wrapper of uploadCards) {
      const input = getUploadFieldInput(wrapper, getFieldQuestionText(wrapper));
      const question = getFieldQuestionText(wrapper, input);
      if (!question) continue;
      const normalizedQuestion = normalizeComparisonText(question);
      const baseFieldId = /\b(resume|cv)\b/.test(normalizedQuestion)
        ? "resume"
        : /cover\s*letter/.test(normalizedQuestion)
          ? "cover_letter"
          : slugifyFieldId(question || input?.getAttribute("aria-describedby") || "upload");
      const fieldId = ensureUniqueFieldId(baseFieldId, usedFieldIds);
      if (!fieldId) continue;
      const answerType = baseFieldId === "resume" ? "resume" : baseFieldId === "cover_letter" ? "cover_letter" : "file";
      fields.push({ question, fieldId, answerType, fieldKind: FIELD_KIND_UPLOAD, field: wrapper, options: [] });
    }
    return fields;
  }

  // --- Autonext / autostart navigation ---
  //
  // Dice "Easy Apply" spans two URLs (a full navigation, not a same-document
  // SPA route): the job posting `/job-detail/<id>` carries an apply trigger
  // (`a[data-testid="apply-button"]`, labelled "Easy Apply" or, when the
  // candidate has a draft, "Continue Application") that links to the wizard
  // `/job-applications/<id>/wizard`. The wizard is a same-document
  // multi-step SPA: "Resume & Cover Letter" (a `<form>` with an "Easy
  // Apply"-style `Next` submit button) then "Review your application" (a
  // form-less step whose only forward control is the gated final `Submit`).
  //
  // isAutofillAvailable reports the apply trigger as an actionable step even
  // on the (field-less) posting page, so a caller's autonext loop fires
  // there too; advanceFlow then opens the wizard. Inside the wizard
  // advanceFlow clicks `Next` to move between steps and stops once the
  // review step's `Submit` appears — that click belongs to a gated
  // auto-submit path, never to advanceFlow itself.

  function isOnDiceWizard() {
    return window.location.pathname.includes("/job-applications/");
  }

  // Posting-page apply link that opens the wizard. Only present on `/job-detail/`.
  function getDiceApplyTrigger() {
    if (isOnDiceWizard()) return null;
    return Array.from(document.querySelectorAll(APPLY_TRIGGER_SELECTOR)).find((element) => isElementVisible(element)) ?? null;
  }

  // Visible wizard action buttons, excluding the persistent site header/
  // footer (Log Out, Career Resources, footer links) so text matching can't
  // pick them up.
  function getWizardActionButtons() {
    if (!isOnDiceWizard()) return [];
    return Array.from(document.querySelectorAll("button")).filter((button) => isElementVisible(button) && !button.closest(SITE_CHROME_SELECTOR));
  }

  // The wizard step-advance control ("Next"/"Continue") — NOT the final submit.
  function getDiceNextButton() {
    return (
      getWizardActionButtons().find((button) => {
        const text = normalizeComparisonText(button.textContent);
        return text === "next" || text === "continue" || text === "save and continue";
      }) ?? null
    );
  }

  // The wizard's terminal action on the review step. This is the gated
  // final submit — never auto-clicked by advanceFlow.
  function getDiceSubmitButton() {
    return (
      getWizardActionButtons().find((button) => {
        const text = normalizeComparisonText(button.textContent);
        return text === "submit" || text === "submit application";
      }) ?? null
    );
  }

  function detectSubmitButton() {
    const submitButton = getDiceSubmitButton();
    if (!submitButton) return { detected: false };
    return {
      detected: true,
      label: normalizeDiceText(submitButton.textContent) || submitButton.getAttribute("aria-label") || "",
      disabled: Boolean(submitButton.disabled || submitButton.getAttribute("aria-disabled") === "true"),
    };
  }

  // Always reports `false` — even on the branches that DO click something.
  // Ported exactly as BidHub's own source has it: this file doesn't use the
  // return value to mean "step advanced", just to perform the one click
  // appropriate for wherever the flow currently is.
  function advanceFlow() {
    // Review step exposes the final Submit — never auto-click it.
    if (getDiceSubmitButton()) return false;

    // Wizard form step -> advance to the next step.
    const nextButton = getDiceNextButton();
    if (nextButton) {
      nextButton.click();
      return false;
    }

    // Job posting -> open the application wizard (navigates to /job-applications).
    const applyTrigger = getDiceApplyTrigger();
    if (applyTrigger) {
      applyTrigger.click();
      return false;
    }
    return false;
  }

  // Field-less but actionable pages (the posting and the review step) must
  // still report as autofill-available so a caller's autonext fires on them.
  function isAutofillAvailable({ fieldCount, submitButton }) {
    if (fieldCount > 0) return true;
    if (submitButton?.detected) return true;
    return Boolean(getDiceNextButton() || getDiceApplyTrigger()) && !getDiceSubmitButton();
  }

  // ---- field detection ----------------------------------------------------

  function detectAutofillFields() {
    // The posting page (`/job-detail/`) has no application fields — only
    // the apply trigger, which isAutofillAvailable/advanceFlow handle.
    // Scoping detection to the wizard avoids the page's search/nav inputs
    // being treated as fields.
    if (!isOnDiceWizard()) return [];
    const form = getDiceApplyForm();
    if (!form) return [];

    const questions = [];
    const usedFieldIds = new Set();
    const handledControls = new Set();

    for (const uploadField of detectUploadFields(form, usedFieldIds)) {
      questions.push(uploadField);
      const uploadInput = getUploadFieldInput(uploadField.field, uploadField.question);
      if (uploadInput) handledControls.add(uploadInput);
    }

    const radioGroups = Array.from(form.querySelectorAll('[role="radiogroup"]')).filter((field) => isElementVisible(field));
    for (const field of radioGroups) {
      const question = getFieldQuestionText(field);
      if (!question) continue;
      const fieldId = ensureUniqueFieldId(field.id || Engine.getRadioInputs(field)[0]?.name || slugifyFieldId(question), usedFieldIds);
      if (!fieldId) continue;
      const metadata = getFieldMetadataSync(question, field);
      if (!metadata.answerType || !metadata.fieldKind) continue;
      Engine.getRadioInputs(field).forEach((input) => handledControls.add(input));
      questions.push({ question, fieldId, answerType: metadata.answerType, fieldKind: metadata.fieldKind, field, options: metadata.options });
    }

    const genericControls = Array.from(form.querySelectorAll("input, select, textarea"));
    for (const control of genericControls) {
      if (!control || handledControls.has(control) || control.disabled) continue;
      const type = (control.type ?? "").toLowerCase();
      if (type === "hidden" || type === "submit" || type === "reset" || type === "button" || type === "file") continue;
      if ((type === "radio" || type === "checkbox") && control.name) continue; // handled via its radiogroup/own loop pass, or has no group wrapper at all (skipped deliberately, same as BidHub's own source)
      if (!isElementVisible(control, { allowHiddenInput: type === "radio" || type === "checkbox" })) continue;
      const field = control.closest(".group.relative.flex.flex-col.gap-2") || control.closest("label") || control.parentElement;
      if (!field) continue;
      const question = getFieldQuestionText(field, control);
      if (!question) continue;
      const baseFieldId = control.id || control.name || slugifyFieldId(question);
      const fieldId = ensureUniqueFieldId(baseFieldId, usedFieldIds);
      if (!fieldId) continue;
      const metadata = getFieldMetadataSync(question, field, control);
      if (!metadata.answerType || !metadata.fieldKind) continue;
      questions.push({ question, fieldId, answerType: metadata.answerType, fieldKind: metadata.fieldKind, field, options: metadata.options });
    }

    return questions;
  }

  // ---- per-field-kind fill dispatch ---------------------------------------
  // Exact-match only (normalizeComparisonText equality) — BidHub's own
  // fallback for a non-exact answer was an AI embedding-similarity match
  // (getEmbeddingMatch(), backend call) that's out of scope here. When
  // nothing matches exactly, the field is left alone and falls through to
  // Big Banana's own generic autofill pipeline.
  function getBestMatchingOptionSync(answer, options) {
    if (!Array.isArray(options) || options.length === 0) return null;
    const normalizedAnswer = normalizeComparisonText(typeof answer === "boolean" ? (answer ? "Yes" : "No") : answer);
    if (!normalizedAnswer) return options[0] ?? null;
    return options.find((option) => normalizeComparisonText(option.text) === normalizedAnswer) ?? null;
  }

  function isTruthyCheckboxAnswer(answer) {
    if (typeof answer === "boolean") return answer;
    return ["yes", "true", "y", "agree", "accepted", "consent"].includes(normalizeComparisonText(answer));
  }

  // answer shapes: text/textarea -> string; select-native/radio -> string
  // label to match against the field's options; checkbox -> boolean |
  // string | string[]; upload -> { type: "file", fileName, base64, mimeType }
  // (anything else, e.g. { type: "skip" }, is a deliberate no-op).
  async function fillAutofillField(entry, answer) {
    if (!entry?.field?.isConnected) return false;
    switch (entry.fieldKind) {
      case "text": {
        const control = entry.field.matches?.("input") ? entry.field : entry.field.querySelector('input:not([type="hidden"]):not([type="file"])');
        if (!control) return false;
        Engine.fillTextInput(control, answer);
        return true;
      }
      case "textarea": {
        const textarea = Engine.getTextarea(entry.field);
        if (!textarea) return false;
        Engine.fillTextInput(textarea, answer);
        return true;
      }
      case "select-native": {
        const select = Engine.getNativeSelect(entry.field);
        if (!select) return false;
        const options = Array.from(select.options)
          .filter((option) => option.value)
          .map((option) => ({ value: option.value, text: normalizeDiceText(option.textContent) }))
          .filter((option) => option.text);
        const bestOption = getBestMatchingOptionSync(answer, options);
        if (!bestOption?.value) return false;
        Engine.fillSelectInput(select, bestOption.value);
        return true;
      }
      case "radio": {
        const options = Engine.getRadioInputs(entry.field)
          .map((input) => ({ input, text: getChoiceInputLabelText(input, entry.question) }))
          .filter((option) => option.text);
        const bestOption = getBestMatchingOptionSync(answer, options);
        if (!bestOption?.input) return false;
        bestOption.input.click();
        bestOption.input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      case "checkbox": {
        const checkboxes = Engine.getCheckboxInputs(entry.field);
        if (checkboxes.length === 0) return false;
        if (checkboxes.length === 1) {
          const checkbox = checkboxes[0];
          const shouldCheck =
            isTruthyCheckboxAnswer(answer) || normalizeComparisonText(answer) === normalizeComparisonText(getChoiceInputLabelText(checkbox, entry.question));
          if (checkbox.checked !== shouldCheck) {
            checkbox.click();
            checkbox.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return true;
        }
        const requestedAnswers = (Array.isArray(answer) ? answer : [answer]).map((value) => normalizeComparisonText(value)).filter(Boolean);
        for (const checkbox of checkboxes) {
          const label = normalizeComparisonText(getChoiceInputLabelText(checkbox, entry.question));
          const shouldCheck = requestedAnswers.some((value) => value === label || value.includes(label) || label.includes(value));
          if (checkbox.checked !== shouldCheck) {
            checkbox.click();
            checkbox.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        return true;
      }
      case FIELD_KIND_UPLOAD: {
        if (!answer || typeof answer !== "object" || answer.type !== "file") return false;
        const input = await ensureUploadInput(entry.field, entry.question);
        if (!input) return false;
        Engine.fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        return true;
      }
      default:
        return false;
    }
  }

  // ---- detection caching + change notification ----------------------------
  // Mirrors window.ProactiveJobDetect.parser's own algorithm (debounced
  // MutationObserver + popstate/hashchange + a 500ms location.href poll for
  // the pushState/replaceState navigation neither event fires) rather than
  // calling into it directly — that engine's contract is job-detect-shaped
  // (title/company/description), not field-list-shaped, so this is its own
  // small instance of the same pattern.

  let cachedFieldsById = new Map();
  let lastSnapshotJson = null;

  function buildDetectionSnapshot() {
    const fields = detectAutofillFields();
    cachedFieldsById = new Map(fields.map((field) => [field.fieldId, field]));
    const submitButton = detectSubmitButton();
    return {
      fields: fields.map(({ fieldId, question, answerType, fieldKind, options }) => ({ fieldId, question, answerType, fieldKind, options })),
      submitButton,
      autofillAvailable: isAutofillAvailable({ fieldCount: fields.length, submitButton }),
    };
  }

  function sendDetectionIfChanged() {
    let snapshot;
    try {
      snapshot = buildDetectionSnapshot();
    } catch {
      return; // mid-render DOM read failed — the next debounced pass picks it up once settled
    }
    const snapshotJson = JSON.stringify(snapshot);
    if (snapshotJson === lastSnapshotJson) return;
    lastSnapshotJson = snapshotJson;
    try {
      chrome.runtime
        .sendMessage({ __proactive: true, type: "autofill-detected", url: location.href, ...snapshot })
        .catch(() => {});
    } catch {
      /* no listener yet (panel not open) — fine, the next mutation retries */
    }
  }

  function startDetectionWatcher() {
    let debounceTimer = null;
    const debouncedRun = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(sendDetectionIfChanged, 250);
    };

    try {
      const observer = new MutationObserver(debouncedRun);
      observer.observe(document.documentElement, { childList: true, attributes: true, characterData: true, subtree: true });
    } catch {
      /* a page that blocks MutationObserver construction (rare, some CSP
         sandboxes) just never re-detects after the first pass */
    }

    let lastUrl = window.location.href;
    const handleUrlChange = () => {
      const newUrl = window.location.href;
      if (newUrl !== lastUrl) {
        lastUrl = newUrl;
        lastSnapshotJson = null; // force a re-send even if the new page's fields happen to hash the same
        debouncedRun();
      }
    };
    window.addEventListener("popstate", handleUrlChange);
    window.addEventListener("hashchange", handleUrlChange);
    // Catches the job-detail -> job-applications/wizard hop, and the
    // wizard's own step changes — both are same-document pushState/
    // replaceState navigations that fire neither event above.
    setInterval(handleUrlChange, 500);

    debouncedRun();
  }

  // ---- message handling ---------------------------------------------------
  // Ported from BidHub's own ensureListener/onMessage (autofill-shared.js):
  // a single chrome.runtime.onMessage listener dispatching by
  // `request.message_type` to whichever handler registered it. A promise
  // result keeps the message channel open until it settles; a handler
  // that isn't registered leaves the message unhandled (`return false`) so
  // another listener elsewhere in the extension can still answer it.

  const messageHandlers = new Map();
  let listenerRegistered = false;
  function ensureListener() {
    if (listenerRegistered) return;
    listenerRegistered = true;
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      const handler = messageHandlers.get(request?.message_type);
      if (!handler) return false;
      const result = handler(request);
      if (result && typeof result.then === "function") {
        result.then((data) => sendResponse(data)).catch(() => sendResponse(undefined));
        return true;
      }
      sendResponse(result);
      return false;
    });
  }
  function onMessage(messageType, handler) {
    ensureListener();
    messageHandlers.set(messageType, handler);
  }

  // Fill one already-detected field with a panel/background-supplied answer.
  onMessage("fillAutofillField", async (request) => {
    const entry = cachedFieldsById.get(request?.fieldId);
    if (!entry) return { filled: false };
    const filled = await fillAutofillField(entry, request?.answer);
    return { filled };
  });

  // Click whichever forward control the current page/step exposes (wizard
  // Next, or the posting page's apply trigger). Never clicks the gated
  // final Submit — that's a separate, explicit action.
  onMessage("advanceAutofillFlow", () => ({ advanced: advanceFlow() }));

  // On-demand snapshot (same shape pushed automatically on every DOM
  // change) for a caller that wants the current state without waiting for
  // the next debounced push.
  onMessage("getAutofillDetectionState", () => buildDetectionSnapshot());

  startDetectionWatcher();
})();
