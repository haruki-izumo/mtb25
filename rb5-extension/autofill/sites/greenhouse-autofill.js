/* =====================================================================
 * autofill/sites/greenhouse-autofill.js — Greenhouse NEW UI
 * (job-boards.greenhouse.io / job-boards.eu.greenhouse.io).
 * =====================================================================
 * Ported from BidHub's own packages/job-parsers/content/platforms/
 * greenhouse/autofill.js — field DETECTION (exact selectors/structural
 * attributes) and the per-field-kind value-COMMIT mechanics only. Every
 * actual DOM write/click/type goes through window.ProactiveAutofillEngine
 * (engine/dom-interactions.js) instead of reimplementing it here.
 *
 * What this file does NOT do (left to Big Banana's own existing systems):
 *   - Decide WHAT value goes into a free-text screening question. BidHub
 *     routes every answerType (even "text") through its own AI backend's
 *     getAnswer(question, answerType, options, constraints, fieldId); that
 *     whole path is out of scope here. Callers of detectFields()/
 *     fillDetectedField() supply the value — Big Banana's own AI-answer
 *     pipeline (or profile data) picks the value, this file only commits
 *     it to the right control the right way.
 *   - Education / Work history row management (BidHub's SECTION_CONTAINER
 *     hierarchy, keyed to BidHub's own profile shape — universityName/
 *     degree/major/companyName/positionTitle/startDate/endDate). Those
 *     rows are simply NOT surfaced by detectFields() below (same skip
 *     BidHub's own addFieldEntry does for anything inside
 *     SECTION_CONTAINER_SELECTOR) — a generic fallback picks up any
 *     individual labelled control in there if one is ever needed.
 *   - CAPTCHA, proxy/remote-CDP, and the post-submit email-verification
 *     CODE's value (the digit-fill mechanic is ported; where the code
 *     itself comes from is not).
 * ===================================================================== */
(function () {
  "use strict";

  const ENGINE = window.ProactiveAutofillEngine;
  if (!ENGINE) return; // engine script not loaded yet — manifest ordering issue, fail closed

  // Narrower than ENGINE.DEFAULT_TEXT_INPUT_SELECTOR (no tel/url/password) —
  // kept exactly as BidHub's own selector so plain-text classification/fill
  // matches its behavior field-for-field.
  const TEXT_INPUT_SELECTOR = 'input[type="text"], input[type="number"], input[type="email"], input:not([type])';
  // "Long list" react-select comboboxes get typed-search treatment (open,
  // type, pick a match) rather than the short-list's plain click-through —
  // same two question labels BidHub singles out.
  const LONG_LIST_CANDIDATES = ["Location (City)", "School"];
  const SECTION_CONTAINER_SELECTOR = ".education--container, .employment--container";
  const COVER_LETTER_UPLOAD_TEXT_PATTERN = /\bcover\s*letter/i;
  const RESUME_UPLOAD_WAIT_TIMEOUT_MS = 5000;
  const RESUME_UPLOAD_COMPLETE_TIMEOUT_MS = 60000;

  // ---- tiny local poller -------------------------------------------------
  // dom-interactions.js has its own internal waitForCondition but doesn't
  // export it — this is just plumbing to call the engine's primitives on a
  // schedule, not a reimplementation of anything the engine already does.
  function waitFor(check, timeoutMs, intervalMs = 100) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let result;
        try { result = check(); } catch { result = null; }
        if (result) return resolve(result);
        if (Date.now() - start >= timeoutMs) return resolve(null);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  // ---- hydration gate -----------------------------------------------------
  // job-boards.greenhouse.io server-renders #application-form and React then
  // REPLACES the whole form subtree on hydration (every node detached,
  // anything typed into the SSR inputs discarded). Emotion's SSR
  // <style data-emotion> tags sit inline next to each react-select until
  // hydration hoists them to <head>, so their presence inside the form means
  // this is still the pre-hydration DOM — report nothing until that tag is
  // gone (BidHub prod incident 2026-09-08: a fill that started on the SSR
  // nodes lost first/last/email and every select timed out).
  function getHydratedApplicationForm() {
    const form = document.querySelector("#application-form");
    if (!form || form.querySelector("style[data-emotion]")) return null;
    return form;
  }

  // ---- file-upload field helpers ------------------------------------------

  function getUploadFieldText(field) {
    return (field?.textContent || "").replace(/\s+/g, " ").trim();
  }
  function isFileUploadField(field) {
    return Boolean(ENGINE.getFileInputInsideField(field));
  }
  function hasUploadedFileControl(field) {
    return Boolean(field?.querySelector?.('button[aria-label="Remove file"]'));
  }
  function isFileUploadOrUploadedField(field) {
    return isFileUploadField(field) || hasUploadedFileControl(field);
  }
  function findFileUploadFieldByText(pattern) {
    const root = document.querySelector("#application-form") || document;
    return (
      Array.from(root.querySelectorAll(".field-wrapper, .file-upload")).find(
        (field) => isFileUploadOrUploadedField(field) && pattern.test(getUploadFieldText(field))
      ) || null
    );
  }
  function getCoverLetterUploadField() {
    return (
      document.querySelector('[aria-labelledby="upload-label-cover_letter"]') ||
      findFileUploadFieldByText(COVER_LETTER_UPLOAD_TEXT_PATTERN)
    );
  }
  function isCoverLetterUploadField(field) {
    return Boolean(
      field?.querySelector?.('div[aria-labelledby="upload-label-cover_letter"]') ||
        (isFileUploadOrUploadedField(field) && COVER_LETTER_UPLOAD_TEXT_PATTERN.test(getUploadFieldText(field)))
    );
  }

  // Resume/cover-letter slots that already hold a file show a "Remove file"
  // chip instead of the <input type=file> — some upload widgets keep the
  // OLD File object on the native input even after their own UI "remove",
  // so re-attaching is a no-op for the framework's onChange. Click Remove
  // first and wait for a fresh input to mount before attaching.
  async function ensureFileInput(getLiveField, fallbackField, label) {
    const liveField = getLiveField() || fallbackField;
    const removeButton = liveField?.querySelector('button[aria-label="Remove file"]');
    if (removeButton) {
      removeButton.click();
      const nextInput = await waitFor(
        () => ENGINE.getFileInputInsideField(getLiveField() || fallbackField),
        RESUME_UPLOAD_WAIT_TIMEOUT_MS
      );
      if (!nextInput) throw new Error(`${label} upload input did not reappear after removing existing file`);
      return nextInput;
    }
    const existingInput = ENGINE.getFileInputInsideField(liveField);
    if (existingInput) return existingInput;
    throw new Error(`${label} upload input not found`);
  }
  const ensureResumeFileInput = (field) =>
    ensureFileInput(() => document.querySelector('[aria-labelledby="upload-label-resume"]'), field, "Resume");
  const ensureCoverLetterFileInput = (field) => ensureFileInput(getCoverLetterUploadField, field, "Cover letter");

  function toTxtFileName(fileName, fallbackBaseName = "cover-letter") {
    const normalized = String(fileName ?? "").trim();
    if (!normalized) return `${fallbackBaseName}.txt`;
    if (normalized.toLowerCase().endsWith(".txt")) return normalized;
    return `${normalized.replace(/\.[^.]+$/, "") || fallbackBaseName}.txt`;
  }
  function encodeTextAsBase64(text) {
    // btoa needs a Latin1 string — escape/encodeURIComponent round-trip
    // handles non-ASCII cover-letter text the same way BidHub's own
    // byte-by-byte TextEncoder loop does.
    return btoa(unescape(encodeURIComponent(String(text ?? ""))));
  }

  // ---- checkbox/radio group (fieldset+legend) wrapper ---------------------

  function getChoiceGroupFieldEntry(wrapper) {
    if (!wrapper) return null;
    const fieldset = wrapper.querySelector("fieldset");
    if (!fieldset) return null;
    const choiceInputs = Array.from(fieldset.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
    if (choiceInputs.length === 0) return null;
    const question = ENGINE.getQuestionText(fieldset.querySelector("legend"));
    if (!question) return null;
    const fieldId = fieldset.id || choiceInputs[0]?.name || choiceInputs[0]?.id;
    if (!fieldId) return null;
    return { question, fieldId, field: fieldset };
  }

  // ---- field-kind classification (structural only — no AI metadata) ------
  // Mirrors BidHub's getFieldMetadataSync, minus the required/maxLength/
  // pattern/accept constraint computation — that machinery exists only to
  // brief the AI-answer backend, which this file never calls.

  function classifyField(question, field) {
    const checkboxInputs = ENGINE.getCheckboxInputs(field);
    if (checkboxInputs.length > 0) {
      const options = checkboxInputs.map((cb) => ENGINE.getInputLabelText(cb, question)).filter(Boolean);
      return { fieldKind: "checkbox", options };
    }
    const radioInputs = ENGINE.getRadioInputs(field);
    if (radioInputs.length > 0) {
      const options = radioInputs.map((r) => ENGINE.getInputLabelText(r, question)).filter(Boolean);
      return { fieldKind: "radio", options };
    }
    // React-select (Greenhouse's own "select-shell" widget) — options only
    // readable by opening the dropdown, so left null until fill time.
    if (field.classList?.contains("select__input")) {
      return LONG_LIST_CANDIDATES.includes(question)
        ? { fieldKind: "select-react-long", options: null }
        : { fieldKind: "select-react-short", options: null };
    }
    const selectEl = field.tagName === "SELECT" ? field : field.querySelector("select");
    if (selectEl) {
      const options = Array.from(selectEl.querySelectorAll("option"))
        .filter((o) => o.value)
        .map((o) => (o.innerText || o.textContent).trim());
      return { fieldKind: "select-native", options };
    }
    if (field.querySelector("auto-complete")) return { fieldKind: "auto-complete", options: null };
    if (question === "Start Date" || question === "End Date") return { fieldKind: "date", options: [] };
    const textarea = field.tagName === "TEXTAREA" ? field : field.querySelector("textarea");
    if (textarea) return { fieldKind: "textarea", options: [] };
    const textInputs = field.tagName === "INPUT" ? [field] : Array.from(field.querySelectorAll(TEXT_INPUT_SELECTOR));
    if (textInputs.length > 0) return { fieldKind: "text", options: [] };
    return { fieldKind: null, options: null };
  }

  // ---- field detection ------------------------------------------------
  // Mirrors BidHub's detectAutofillFields(): scans every `.field-wrapper`
  // and top-level `label[for]` under the (hydrated) form. Returns null
  // before hydration so a caller's MutationObserver-driven retry picks the
  // form up once it has actually settled.

  function detectFields() {
    const form = getHydratedApplicationForm();
    if (!form) return null;
    const fields = [];
    let resumeAdded = false;
    let coverLetterAdded = false;

    const addField = (fieldId, question, field, extra = {}) => {
      if (!fieldId || !field) return;
      // Education/Work-history rows are owned by BidHub's profile-section
      // hierarchy, which this port deliberately leaves out (see file-top
      // comment) — skip anything inside those containers.
      if (field.closest?.(SECTION_CONTAINER_SELECTOR)) return;
      fields.push({ fieldId, question, field, ...extra });
    };

    for (const element of form.querySelectorAll(`${SECTION_CONTAINER_SELECTOR}, .field-wrapper, label[for]`)) {
      if (element.matches(SECTION_CONTAINER_SELECTOR)) continue; // see addField's guard above
      if (element.matches(".field-wrapper")) {
        if (element.querySelector('div[aria-labelledby="upload-label-resume"]')) {
          if (!resumeAdded) {
            addField("resume", "Resume/CV", element, { fieldKind: "resume" });
            resumeAdded = true;
          }
        } else if (isCoverLetterUploadField(element)) {
          if (!coverLetterAdded) {
            addField("cover_letter", "Cover Letter", element, { fieldKind: "cover_letter" });
            coverLetterAdded = true;
          }
        } else {
          const group = getChoiceGroupFieldEntry(element);
          if (group) addField(group.fieldId, group.question, group.field, classifyField(group.question, group.field));
        }
        continue;
      }
      const label = element;
      if (label.getAttribute("id") === "email-verification-label") {
        const field = label.parentElement?.querySelector(".email-verification__wrapper");
        addField("verification_code", "Security code", field, { fieldKind: "verification_code" });
        continue;
      }
      const fieldId = label.getAttribute("for");
      if (!fieldId) continue;
      const field = document.getElementById(fieldId) || document.querySelector(`[name="${fieldId}"]`);
      if (!field) continue;
      const fieldWrapper = label.closest(".field-wrapper");
      if (fieldWrapper && isFileUploadOrUploadedField(fieldWrapper)) continue;
      if (fieldWrapper?.querySelector('div[aria-labelledby="upload-label-resume"]')) continue;
      if (isCoverLetterUploadField(fieldWrapper)) continue;
      const group = getChoiceGroupFieldEntry(fieldWrapper);
      if (group?.field?.contains(field) && (field.type === "checkbox" || field.type === "radio")) continue;
      const question = ENGINE.getQuestionText(label);
      if (!question) continue;
      addField(fieldId, question, field, classifyField(question, field));
    }
    return fields;
  }

  // ---- value commit, per field kind ---------------------------------------
  // "Location (City)" only searches on the part before the first comma
  // ("Austin, TX" -> "Austin") — the long-list combobox's own suggestions
  // are city-only, so searching the full string never matches.
  function getLongSelectSearchText(question, answer) {
    const normalized = answer == null ? "" : String(answer).trim();
    if (!normalized) return normalized;
    if (question === "Location (City)") return normalized.split(",")[0]?.trim() || normalized;
    return normalized;
  }

  /**
   * Commit `answer` into a field detectFields() returned, using the
   * mechanics matching its fieldKind. Caller decides the VALUE; this only
   * decides HOW to write it for this control shape.
   */
  async function fillDetectedField(entry, answer) {
    const { fieldKind, field, question } = entry;
    switch (fieldKind) {
      case "text": {
        const input = field.tagName === "INPUT" ? field : field.querySelector(TEXT_INPUT_SELECTOR);
        if (input) ENGINE.fillTextInput(input, answer);
        return;
      }
      case "textarea": {
        const textarea = field.tagName === "TEXTAREA" ? field : field.querySelector("textarea");
        if (textarea) ENGINE.fillTextInput(textarea, answer);
        return;
      }
      case "checkbox": {
        const selected = Array.isArray(answer) ? answer.map(String) : answer == null ? [] : [String(answer)];
        for (const cb of ENGINE.getCheckboxInputs(field)) {
          const label = ENGINE.getInputLabelText(cb, question);
          const shouldCheck =
            typeof answer === "boolean" ? answer : selected.includes(label) || selected.includes(String(cb.value));
          if (cb.checked !== shouldCheck) await ENGINE.clickLikeHuman(cb);
        }
        return;
      }
      case "radio": {
        const selectedValue = answer == null ? null : String(answer);
        for (const radio of ENGINE.getRadioInputs(field)) {
          const label = ENGINE.getInputLabelText(radio, question);
          const shouldCheck = selectedValue != null && (selectedValue === label || selectedValue === String(radio.value));
          if (shouldCheck && !radio.checked) { await ENGINE.clickLikeHuman(radio); return; }
        }
        return;
      }
      case "select-native": {
        const selectEl = field.tagName === "SELECT" ? field : field.querySelector("select");
        if (!selectEl) return;
        const matching = Array.from(selectEl.querySelectorAll("option"))
          .filter((o) => o.value)
          .find((o) => (o.innerText || o.textContent).trim() === answer);
        if (matching) ENGINE.fillSelectInput(selectEl, matching.getAttribute("value"));
        return;
      }
      // Greenhouse's react-select widget — the engine's default
      // menuSelector ('.select-shell .select__menu div[role="option"]')
      // already matches this exact markup, and its "Other" no-match
      // fallback mirrors the fallbackValue='Other' BidHub itself falls
      // back to for these same long/short select-react fields.
      case "select-react-short":
        await ENGINE.fillComboboxByTyping(field, answer);
        return;
      case "select-react-long":
        await ENGINE.fillComboboxByTyping(field, getLongSelectSearchText(question, answer));
        return;
      case "auto-complete": {
        const input = field.querySelector("auto-complete")?.querySelector("input");
        if (input) await ENGINE.fillComboboxByTyping(input, answer);
        return;
      }
      case "date": {
        // "Start Date"/"End Date" wrapper: one input = year only, two
        // inputs = month then year. Answer is "D/M/Y"-shaped; the day
        // segment is unused — Greenhouse's own date picker here has no
        // day control, same as BidHub's own handler.
        const inputs = field.querySelectorAll("input");
        const [, month, year] = String(answer ?? "").split("/");
        if (inputs.length === 1) ENGINE.fillTextInput(inputs[0], year);
        else if (inputs.length >= 2) { ENGINE.fillTextInput(inputs[0], month); ENGINE.fillTextInput(inputs[1], year); }
        return;
      }
      case "verification_code": {
        if (answer == null) return;
        const inputs = Array.from(field.querySelectorAll("input"));
        inputs.forEach((input, i) => ENGINE.fillTextInput(input, answer[i] ?? ""));
        return;
      }
      default:
        return;
    }
  }

  /** Resume upload — handles the already-has-a-file "Remove file" dance,
   *  attaches, then waits for Greenhouse's own upload to finish (the
   *  "Remove file" chip only appears once the server upload completes). */
  async function fillResume(field, fileName, base64, mimeType = "application/pdf") {
    const fileInput = await ensureResumeFileInput(field);
    ENGINE.fillFileInput(fileInput, fileName, base64, mimeType);
    await waitFor(
      () => (document.querySelector('[aria-labelledby="upload-label-resume"]') || field)?.querySelector(
        'button[aria-label="Remove file"]'
      ),
      RESUME_UPLOAD_COMPLETE_TIMEOUT_MS
    );
  }

  /** Cover letter — Greenhouse offers up to three UI shapes on top of the
   *  same field: a plain textarea-like `#cover_letter_text` input, a "Enter
   *  manually" button that mounts one, or a file upload. Pass `text` for
   *  the first two; `base64`/`fileName`/`mimeType` for a real file. Passing
   *  only `text` with neither UI shape present uploads it as a plain .txt
   *  (same trick BidHub uses — Greenhouse's upload slot accepts it). */
  async function fillCoverLetter(field, { text, fileName, base64, mimeType } = {}) {
    if (!field) return;
    if (text) {
      const existingTextField = field.querySelector("#cover_letter_text");
      if (existingTextField) { ENGINE.fillTextInput(existingTextField, text); return; }
      const enterManuallyButton = field.querySelector('button[data-testid="cover_letter-text"]');
      if (enterManuallyButton) {
        enterManuallyButton.click();
        const textField = await waitFor(() => field.querySelector("#cover_letter_text"), 1500);
        if (!textField) throw new Error("Cover letter text input did not appear");
        ENGINE.fillTextInput(textField, text);
        return;
      }
      if (!base64) {
        base64 = encodeTextAsBase64(text);
        fileName = toTxtFileName(fileName);
        mimeType = "text/plain";
      }
    }
    if (!base64) return;
    const fileInput = await ensureCoverLetterFileInput(field);
    ENGINE.fillFileInput(fileInput, fileName || "cover-letter.pdf", base64, mimeType || "application/pdf");
    await waitFor(
      () => (getCoverLetterUploadField() || field)?.querySelector('button[aria-label="Remove file"]'),
      RESUME_UPLOAD_COMPLETE_TIMEOUT_MS
    );
  }

  // ---- multi-step advancement ---------------------------------------------
  // Greenhouse's new UI keeps ONE button for both "advance" and "submit" —
  // same element, different label/state depending which step you're on.

  function getSubmitButton() {
    const form = getHydratedApplicationForm();
    if (!form) return null;
    return form.querySelector('.application--submit button[type="submit"], button[type="submit"]');
  }

  function detectSubmitButton() {
    const button = getSubmitButton();
    if (!button) return { detected: false };
    const label = (button.textContent || button.getAttribute("aria-label") || "").trim();
    return { detected: true, label, disabled: Boolean(button.disabled || button.getAttribute("aria-disabled") === "true") };
  }

  /** Clicks the Next/Continue/Review/Preview button if that's what's
   *  currently showing; returns false (and never clicks) on a page whose
   *  button already reads Submit/Apply — that's the terminal step, left to
   *  Big Banana's own submit flow. */
  async function advanceFlow() {
    const button = document.querySelector(".application--submit button");
    if (!button) return false;
    const label = (button.textContent || "").trim();
    if (!label) return false;
    if (/\b(submit|apply)\b/i.test(label)) return false;
    if (!/\b(next|continue|review|preview)\b/i.test(label)) return false;
    await ENGINE.clickLikeHuman(button);
    return true;
  }

  // ---- repeatable Education/Work-history sections -----------------------
  // Ported from BidHub's own Greenhouse section descriptors (plain
  // class-name selectors, unlike Ashby's CSS-module hashes) — driven by
  // the shared engine/section-hierarchy.js, same root→group→leaf model
  // BidHub's own uses. detectFields() above already skips anything inside
  // SECTION_CONTAINER_SELECTOR so these rows are never double-detected by
  // the generic path.
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;

  function getSectionRowElements(container, rowSelector) {
    return Array.from(container.querySelectorAll(rowSelector)).filter((rowEl) => rowEl.querySelector("label[for]"));
  }

  // Matches a row's control by its own VISIBLE label text, not an id
  // convention — Greenhouse's per-row ids aren't predictable across rows.
  function findRowFieldByLabel(rowEl, labelText) {
    for (const label of rowEl.querySelectorAll("label[for]")) {
      const text = (label.innerText || label.textContent || "").split("\n")[0].replace(/\*/g, "").trim();
      if (text !== labelText) continue;
      const fieldId = label.getAttribute("for");
      const field =
        rowEl.querySelector(`[id="${CSS.escape(fieldId)}"]`) ||
        rowEl.querySelector(`[name="${CSS.escape(fieldId)}"]`) ||
        document.getElementById(fieldId);
      if (field) return { field, fieldId };
    }
    return null;
  }

  function createClickAddRowAction(findButton) {
    return async (container) => {
      const button = findButton(container);
      if (button) await ENGINE.clickLikeHuman(button);
    };
  }

  // Deletes existing rows in REVERSE order (removing row N can shift later
  // rows' DOM/indices) so the fill engine can rebuild exactly as many rows
  // as the profile has, rather than reconciling with whatever was already
  // there — same strategy BidHub's own clearSectionRows uses.
  async function clearSectionRows(container, rowSelector) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = getSectionRowElements(container, rowSelector);
      if (rows.length === 0) return;
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        const deleteBtn = Array.from(row.querySelectorAll('button, [role="button"]')).find((b) => {
          if (b.classList?.contains("add-another-button")) return false;
          const label = (b.getAttribute("aria-label") || b.getAttribute("title") || b.textContent || "").trim();
          return /\b(delete|remove)\b/i.test(label);
        });
        if (deleteBtn) await ENGINE.clickLikeHuman(deleteBtn);
      }
      await ENGINE.sleep(150);
    }
  }

  // BCD's Profile.education/.experience store dates as a raw month-input
  // string ("2022-01", see server/src/models/Profile.js) — split into the
  // separate month/year leaves Greenhouse's own date widget uses.
  function parseMonthYear(raw) {
    const s = String(raw || "").trim();
    const m = /^(\d{4})-(\d{1,2})$/.exec(s);
    if (m) return { year: m[1], month: String(parseInt(m[2], 10)) };
    const d = s ? new Date(s) : null;
    if (d && !Number.isNaN(d.getTime())) return { year: String(d.getFullYear()), month: String(d.getMonth() + 1) };
    return { year: "", month: "" };
  }
  const dateResolver = (profileKey, part) => (entry) => parseMonthYear(entry?.[profileKey])[part];

  const EDUCATION_ROW_SELECTOR = ".education--form, .education-form";
  const EMPLOYMENT_ROW_SELECTOR = ".employment--form, .employment-form";

  const EDUCATION_SECTION = {
    rootFieldId: "educationHistory",
    rootQuestion: "Education",
    profileSection: "education",
    rowLabel: (i) => `Education ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: () => document.querySelector(".education--container"),
    getRows: (container) => getSectionRowElements(container, EDUCATION_ROW_SELECTOR),
    getRowField: (rowEl, mapping) => findRowFieldByLabel(rowEl, mapping.question),
    addRow: createClickAddRowAction((container) => container?.querySelector("button.add-another-button")),
    clearRows: (container) => clearSectionRows(container, EDUCATION_ROW_SELECTOR),
    // No `major`/`discipline` field exists on BCD's Profile.education
    // schema (school/degree/start/end only) — the Discipline leaf still
    // detects and shows in the review list (so it's visible/editable like
    // any other unmapped question), it just has nothing to auto-fill from.
    mappings: [
      { key: "universityName", profileKey: "school", question: "School", fieldKind: "text", label: "School" },
      { key: "degree", profileKey: "degree", question: "Degree", fieldKind: "dropdown", label: "Degree" },
      { key: "major", question: "Discipline", fieldKind: "dropdown", label: "Discipline" },
      { key: "startDateMonth", question: "Start date month", fieldKind: "date", resolveValue: dateResolver("start", "month"), label: "Start date month" },
      { key: "startDateYear", question: "Start date year", fieldKind: "date", resolveValue: dateResolver("start", "year"), label: "Start date year" },
      { key: "endDateMonth", question: "End date month", fieldKind: "date", resolveValue: dateResolver("end", "month"), label: "End date month" },
      { key: "endDateYear", question: "End date year", fieldKind: "date", resolveValue: dateResolver("end", "year"), label: "End date year" },
    ],
  };

  const WORK_HISTORY_SECTION = {
    rootFieldId: "workHistory",
    rootQuestion: "Work history",
    profileSection: "experience",
    rowLabel: (i) => `Work history ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: () => document.querySelector(".employment--container"),
    getRows: (container) => getSectionRowElements(container, EMPLOYMENT_ROW_SELECTOR),
    getRowField: (rowEl, mapping) => findRowFieldByLabel(rowEl, mapping.question),
    addRow: createClickAddRowAction((container) => container?.querySelector("button.add-another-button")),
    clearRows: (container) => clearSectionRows(container, EMPLOYMENT_ROW_SELECTOR),
    mappings: [
      { key: "companyName", profileKey: "company", question: "Company name", fieldKind: "text", label: "Company name" },
      { key: "positionTitle", profileKey: "role", question: "Title", fieldKind: "text", label: "Title" },
      { key: "startDateMonth", question: "Start date month", fieldKind: "date", resolveValue: dateResolver("start", "month"), label: "Start date month" },
      { key: "startDateYear", question: "Start date year", fieldKind: "date", resolveValue: dateResolver("start", "year"), label: "Start date year" },
      { key: "endDateMonth", question: "End date month", fieldKind: "date", resolveValue: dateResolver("end", "month"), label: "End date month" },
      { key: "endDateYear", question: "End date year", fieldKind: "date", resolveValue: dateResolver("end", "year"), label: "End date year" },
      {
        key: "currentRole",
        question: "Current role",
        fieldKind: "checkbox",
        label: "Current role",
        resolveValue: (entry) => !String(entry?.end || "").trim(),
      },
    ],
  };

  const SECTIONS = [EDUCATION_SECTION, WORK_HISTORY_SECTION];

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections(SECTIONS, profileData);
  }

  async function fillSectionLeaf(field, mapping, value) {
    switch (mapping.fieldKind) {
      case "text":
      case "date":
        // Awaited (not the fire-and-forget fillTextInput) — the section
        // loop's next step is often another addRow() click that re-renders
        // the whole list; that must not fire while this value's short
        // React-state-restore reassert window is still in flight, or the
        // just-written value can get wiped before it's confirmed to stick.
        await ENGINE.fillTextInputReliably(field, value);
        return;
      case "dropdown": {
        if (field.tagName === "SELECT") {
          const match = Array.from(field.querySelectorAll("option"))
            .filter((o) => o.value)
            .find((o) => (o.innerText || o.textContent).trim() === value);
          if (match) ENGINE.fillSelectInput(field, match.getAttribute("value"));
          return;
        }
        await ENGINE.fillComboboxByTyping(field, value);
        return;
      }
      case "checkbox": {
        const input = field.tagName === "INPUT" ? field : field.querySelector('input[type="checkbox"]');
        if (input && input.checked !== Boolean(value)) await ENGINE.clickLikeHuman(input);
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

  window.ProactiveAutofillSites = window.ProactiveAutofillSites || {};
  window.ProactiveAutofillSites.greenhouse = {
    getHydratedApplicationForm,
    detectFields,
    fillDetectedField,
    fillResume,
    fillCoverLetter,
    getSubmitButton,
    detectSubmitButton,
    advanceFlow,
    detectSections,
    fillSections,
  };
})();
