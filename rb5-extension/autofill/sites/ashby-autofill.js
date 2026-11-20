/* =====================================================================
 * autofill/sites/ashby-autofill.js — Ashby application forms
 * (jobs.ashbyhq.com/{org}/{postingId}/application).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/ashbyhq/autofill.js — the
 * deterministic, structural half of that file only: field detection +
 * value-filling for text inputs, native <select>s, the custom
 * react-select-style combobox, radio/checkbox/button-group choices, and
 * resume/cover-letter file uploads, plus the one-step "advance from the
 * Overview tab to the Application tab" navigation Ashby's flow needs.
 *
 * Deliberately NOT ported (BidHub's own file does all of this, but it's
 * out of scope for this port):
 *   - getAnswer() / the AI-backend free-text-answer pipeline for custom
 *     screening questions. Big Banana already has its own generic
 *     AI-answer system for exactly that; a question this file doesn't
 *     recognise as one of the structural kinds below is left untouched
 *     so that existing pipeline can pick it up, same as every other
 *     ported site.
 *   - the reCAPTCHA v3 "flagged as possible spam" wall and any
 *     CAPTCHA-solving.
 *   - the "remote input" lane (BidHub's useRemoteInput/remoteClick/
 *     remoteTypeInto/... — a patchright/CDP replay path that only
 *     exists on BidHub's own hosted runner). Every interaction below
 *     always goes through the synthetic window.ProactiveAutofillEngine
 *     path (clickLikeHuman / fillTextInputLikeHuman / ...), same as
 *     every other Big Banana site adapter.
 *   - the repeatable "Education History" block (add/remove row buttons,
 *     per-row school/degree/date sub-fields). That's BidHub's generic
 *     profile-section-hierarchy machinery (shared with Greenhouse,
 *     Workday, ...), not something Ashby-specific worth porting
 *     standalone — a page that has one is simply skipped by
 *     detectAshbyFields() below, same as any other field kind this file
 *     doesn't recognise.
 * ===================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofillEngine) return;
  const engine = window.ProactiveAutofillEngine;
  const {
    fillTextInputLikeHuman,
    fillSelectInput,
    fillFileInput,
    getCheckboxInputs,
    getRadioInputs,
    getInputLabelText,
    getTextarea,
    getTextInput,
    getFileInputInsideField,
    clickLikeHuman,
    fillComboboxByTyping,
    sleep,
  } = engine;

  // Ashby renders each question inside a CSS-module wrapper whose class name carries a
  // build-specific hash (e.g. `_fieldEntry_1e3gg_28`), so the hash cannot be hardcoded. Match the
  // stable `_fieldEntry_` CSS-module prefix instead. The legacy `.ashby-application-form-field-entry`
  // companion class is present on most entries, but single/multi-select questions (radio and
  // checkbox groups) are wrapped in an extra `_container_<hash>_<n> _fieldEntry_<hash>_<n>` element
  // that lacks it — keeping both selectors ensures those select questions are detected too.
  const ASHBY_FIELD_ENTRY_SELECTOR = '[class*="_fieldEntry_"], .ashby-application-form-field-entry';
  const ASHBY_REQUIRED_CLASS_PATTERN = /(^|\s)_required_/;
  // Ashby's radio/checkbox options are React-controlled custom widgets. When an option is
  // selected, its label + circle container get a hash-suffixed `_checked_<hash>` class. Native
  // `.checked` is set after a real click but isn't reliable for options selected by React
  // default/restore — so the class is the ground truth alongside it.
  const ASHBY_CHECKED_CLASS_PATTERN = /(^|\s)_checked_/;
  const ASHBY_ACTIVE_CLASS_PATTERN = /(^|\s)_active_/;
  // Ashby renders BOTH of its dropdown flavours as the same `input[role="combobox"]` autocomplete:
  // a FIXED list (posting-defined options — ArrowDown on the empty input opens the whole list) and
  // an async SEARCH (geo location / school lookup — options only appear for a typed query).
  // Nothing in the markup tells them apart; fillComboboxByTyping's click-then-type-then-wait
  // handles both the same way, so no fixed/search branch is needed here.
  const ASHBY_COMBOBOX_SELECTOR = 'input[role="combobox"], input[aria-autocomplete="list"]';
  const ASHBY_COMBOBOX_OPTION_SELECTOR = '[role="listbox"] [role="option"]';
  // react-datepicker text input ("Pick a date"): only a typed `MM/DD/YYYY` + Enter commits.
  const ASHBY_DATE_INPUT_SELECTOR = ".ashby-application-form-input-date";
  const DEFAULT_START_DATE_OFFSET_DAYS = 14;
  // Ashby's FileInput keeps the hidden `input[type=file]` mounted and, once a file is picked,
  // renders a `_file_` row for it right away — so a filled input / the "Replace" button say
  // nothing about the upload. While `isUploading` (presigned S3 POST + the set-value GraphQL
  // mutation) the row shows a spinner and NO remove button; the icon-only remove button
  // (`title="Delete file"`, class `_removeButton_`) is rendered only after both finish. Submitting
  // before it appears posts the form without the resume, so the fill waits on it.
  const ASHBY_FILE_REMOVE_BUTTON_SELECTOR = 'button[title="Delete file"], button[class*="_removeButton_"]';
  const ASHBY_FILE_UPLOADING_SELECTOR = '[class*="_loadingIcon_"], .loadingSvg';
  const ASHBY_TOAST_SELECTOR = '[class*="_toast_"], [role="alert"]';
  const ASHBY_UPLOAD_FAILED_TOAST_PATTERN = /failed to upload/i;
  const FILE_UPLOAD_COMPLETE_TIMEOUT_MS = 60000;
  const FILE_UPLOAD_COMPLETE_POLL_MS = 200;
  const ASHBY_APPLICATION_PATH_PATTERN = /\/application\/?$/i;
  // Ashby's repeatable "Education History" block — recognised ONLY so detectAshbyFields() can
  // skip it (see the file-level comment above); no fill support is ported for it.
  const ASHBY_EDUCATION_ENTRY_SELECTOR = '[class*="_repeatableEducationEntry_"]';
  const ASHBY_EDUCATION_ADD_BUTTON_SELECTOR = '[class*="_repeatableEducationAddButton_"]';
  // Human-like pacing for Ashby's bot detection. The realism comes from the interaction *shape*
  // (discrete keystrokes/pointer events, movement path, jitter — all inside the engine's
  // fillTextInputLikeHuman/clickLikeHuman), but Ashby is bot-sensitive so this also keeps the
  // tempo a little unhurried: a calmer per-character typing cadence, still budget-capped so a
  // long cover letter can't stall the run.
  const ASHBY_HUMAN_TYPING_OPTIONS = { perCharDelayMs: 22, maxTotalTypingMs: 4500 };
  const COMBOBOX_COMMIT_SETTLE_MS = 250;

  function normalizeAshbyText(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(/[✱*]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isElementVisible(element) {
    if (!element?.isConnected) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getAshbyForm() {
    return document.querySelector("#form");
  }

  function getAshbyActionLabel(element) {
    return normalizeAshbyText(element?.textContent || element?.value || element?.getAttribute?.("aria-label") || "");
  }

  // The link from the Overview tab into the actual application FORM (the "Application" tab) —
  // Ashby's only multi-step/paginated advancement: one hop, not a wizard. Rejects the current
  // page's own URL so this is a no-op once already on the form.
  function getAshbyApplicationLink() {
    return (
      Array.from(document.querySelectorAll("a[href]")).find((link) => {
        const href = link?.href ?? "";
        let linkUrl;
        try {
          linkUrl = new URL(href, window.location.href);
        } catch {
          return false;
        }
        if (!ASHBY_APPLICATION_PATH_PATTERN.test(linkUrl.pathname)) return false;
        if (linkUrl.href === new URL(window.location.href).href) return false;
        return /\b(application|apply)\b/.test(getAshbyActionLabel(link).toLowerCase());
      }) ?? null
    );
  }

  function getFieldWrappers() {
    const form = getAshbyForm();
    return form ? Array.from(form.querySelectorAll(ASHBY_FIELD_ENTRY_SELECTOR)) : [];
  }

  function isEducationSectionField(field) {
    return Boolean(field.querySelector(ASHBY_EDUCATION_ENTRY_SELECTOR) || field.querySelector(ASHBY_EDUCATION_ADD_BUTTON_SELECTOR));
  }

  function getQuestionLabel(field) {
    return field.querySelector(".ashby-application-form-question-title") || field.querySelector("label") || null;
  }

  // label[for]=id, else [name=] — same priority chain the engine's own getInputLabelText uses,
  // but scoped to the one id Ashby actually wires up here.
  function getQuestionLabeledControl(field) {
    const labelFor = getQuestionLabel(field)?.getAttribute("for");
    if (!labelFor) return null;
    const controlById = document.getElementById(labelFor);
    if (controlById && field.contains(controlById)) return controlById;
    const escaped = window.CSS?.escape ? window.CSS.escape(labelFor) : labelFor;
    return field.querySelector(`[name="${escaped}"]`) || null;
  }

  // The single checkbox of a boolean (consent / opt-in) entry, or null for groups / other controls.
  function getLoneCheckbox(field) {
    const inputs = getCheckboxInputs(field);
    return inputs.length === 1 ? inputs[0] : null;
  }

  function getAshbyQuestionText(field) {
    const label = getQuestionLabel(field);
    const labelText = normalizeAshbyText(label?.textContent || "");
    if (labelText) return labelText;
    const description = field.querySelector(".ashby-application-form-question-description");
    const descriptionText = normalizeAshbyText(description?.textContent || "");
    if (descriptionText) return descriptionText;
    // Consent / opt-in checkbox whose question title is ONLY the required asterisk ("*"): the
    // statement the candidate agrees to lives in the checkbox's own <label>, not the title.
    // normalizeAshbyText strips the asterisk to '', so without this fallback the entry would be
    // dropped entirely and the box never ticked.
    const loneCheckbox = getLoneCheckbox(field);
    if (loneCheckbox) {
      const checkboxLabelText = normalizeAshbyText(getInputLabelText(loneCheckbox));
      if (checkboxLabelText) return checkboxLabelText;
      const optionWrapper = loneCheckbox.closest('[class*="_option_"]') || field;
      const wrapperText = normalizeAshbyText(optionWrapper.textContent || "");
      if (wrapperText) return wrapperText;
    }
    return null;
  }

  function isQuestionMarkedRequired(field, control) {
    if (control?.required) return true;
    const label = getQuestionLabel(field);
    if (ASHBY_REQUIRED_CLASS_PATTERN.test(label?.className ?? "")) return true;
    // A title that is nothing but the required marker (consent checkbox entries — see
    // getAshbyQuestionText) is required even when Ashby omits the `_required_` class.
    const rawLabelText = String(label?.textContent ?? "").replace(/\s+/g, "");
    return rawLabelText.length > 0 && /^[✱*]+$/.test(rawLabelText);
  }

  function getChoiceButtons(field) {
    return Array.from(field.querySelectorAll("button"))
      .map((button) => ({ button, text: normalizeAshbyText(button.textContent) }))
      .filter((option) => option.text);
  }

  function getComboboxInput(field) {
    return field.querySelector(ASHBY_COMBOBOX_SELECTOR) || null;
  }
  function getDateInput(field) {
    return field.querySelector(ASHBY_DATE_INPUT_SELECTOR) || null;
  }

  function isResumeField(question, control) {
    const normalizedQuestion = normalizeAshbyText(question).toLowerCase();
    const controlName = (control?.name ?? "").toLowerCase();
    const controlId = (control?.id ?? "").toLowerCase();
    return /resume|cv/.test(normalizedQuestion) || /resume|cv/.test(controlName) || /resume|cv/.test(controlId);
  }
  function isCoverLetterField(question, control) {
    const normalizedQuestion = normalizeAshbyText(question).toLowerCase();
    const controlName = (control?.name ?? "").toLowerCase();
    const controlId = (control?.id ?? "").toLowerCase();
    return /cover\s*letter/.test(normalizedQuestion) || /cover_?letter/.test(controlName) || /cover_?letter/.test(controlId);
  }

  function getElementClassName(element) {
    const className = element?.className;
    if (typeof className === "string") return className;
    return className?.baseVal ?? "";
  }

  // Whether a radio/checkbox option is already selected. Ashby toggles an option OFF when the
  // already-selected one is clicked again, so a fill must never re-click a selected option — it
  // would deselect the candidate's (or a prior fill's) choice. Native `.checked` is checked
  // first, then the `_checked_` class on the option's label / `_option_` wrapper subtree (the
  // React-owned source of truth), so options selected without a native click are still recognised.
  function isAshbyChoiceSelected(input, label = null) {
    if (input?.checked) return true;
    const optionLabel = label || input?.labels?.[0] || null;
    if (ASHBY_CHECKED_CLASS_PATTERN.test(getElementClassName(optionLabel))) return true;
    const optionWrapper = input?.closest?.('[class*="_option_"]') || optionLabel?.closest?.('[class*="_option_"]');
    if (!optionWrapper) return false;
    if (ASHBY_CHECKED_CLASS_PATTERN.test(getElementClassName(optionWrapper))) return true;
    return Array.from(optionWrapper.querySelectorAll("[class]")).some((el) => ASHBY_CHECKED_CLASS_PATTERN.test(getElementClassName(el)));
  }
  function isButtonActive(button) {
    return ASHBY_ACTIVE_CLASS_PATTERN.test(button?.className ?? "");
  }

  // ---- field classification -------------------------------------------
  // Priority order mirrors BidHub's own getFieldMetadataSync: a file input wins outright (only
  // resume/cover-letter are recognised; any other file question is left to the generic/AI path),
  // then a label[for]-linked control, then button-group / radio / checkbox groups, then the
  // plain textarea / combobox / date / text controls a label[for] didn't already resolve.

  function classifyAshbyField(field) {
    const question = getAshbyQuestionText(field);
    if (!question) return null;

    const fileInput = getFileInputInsideField(field);
    if (fileInput) {
      if (isResumeField(question, fileInput)) return { kind: "resume", question, control: fileInput };
      if (isCoverLetterField(question, fileInput)) return { kind: "cover_letter", question, control: fileInput };
      return null; // an unrecognised file question — left alone
    }

    const labeledControl = getQuestionLabeledControl(field);
    if (labeledControl?.matches?.("textarea")) return { kind: "textarea", question, control: labeledControl };
    if (labeledControl?.matches?.(ASHBY_COMBOBOX_SELECTOR)) return { kind: "combobox", question, control: labeledControl };
    if (labeledControl?.matches?.(ASHBY_DATE_INPUT_SELECTOR)) return { kind: "date", question, control: labeledControl };
    if (
      labeledControl?.matches?.("input") &&
      !["hidden", "file", "checkbox", "radio"].includes(labeledControl.type)
    ) {
      return { kind: "text", question, control: labeledControl };
    }

    // `options` (plain label-text array) — same convention every other
    // ported site's choice-kind fields already use (see e.g.
    // greenhouse-autofill.js's own classify helper), read by the
    // dispatcher's normalizeEntry/classify and surfaced to the Apply tab's
    // review list so it can show the actual choices under a button-
    // group/radio/checkbox question instead of routing it into the
    // free-text AI-answer pipeline, which can't sensibly answer a fixed-
    // choice question (confirmed real complaint: Ashby's "How did you hear
    // about X?" button-group question showed only the bare question text,
    // then "Couldn't generate an answer" when the review list tried to AI-
    // answer it anyway).
    const buttonOptions = getChoiceButtons(field);
    if (buttonOptions.length > 0) {
      return { kind: "button-group", question, control: field, options: buttonOptions.map((o) => o.text) };
    }

    const radioInputs = getRadioInputs(field);
    if (radioInputs.length > 0) {
      return {
        kind: "radio",
        question,
        control: field,
        options: radioInputs.map((input) => normalizeAshbyText(getInputLabelText(input))).filter(Boolean),
      };
    }

    const checkboxInputs = getCheckboxInputs(field);
    if (checkboxInputs.length > 0) {
      return {
        kind: "checkbox",
        question,
        control: field,
        options: checkboxInputs.map((input) => normalizeAshbyText(getInputLabelText(input))).filter(Boolean),
      };
    }

    const textarea = getTextarea(field);
    if (textarea) return { kind: "textarea", question, control: textarea };

    const combobox = getComboboxInput(field);
    if (combobox) return { kind: "combobox", question, control: combobox };

    const dateInput = getDateInput(field);
    if (dateInput) return { kind: "date", question, control: dateInput };

    const textInput = getTextInput(field);
    if (textInput) return { kind: "text", question, control: textInput };

    return null;
  }

  // Enumerate the form's deterministically-fillable questions. The Education History block (and
  // anything else this classifier doesn't recognise) is skipped here, not errored — Big Banana's
  // own generic/AI pipeline is what picks up whatever this file leaves alone.
  function detectAshbyFields() {
    const fields = [];
    for (const field of getFieldWrappers()) {
      if (isEducationSectionField(field)) continue;
      const classified = classifyAshbyField(field);
      if (!classified) continue;
      fields.push({
        field,
        question: classified.question,
        kind: classified.kind,
        control: classified.control,
        options: classified.options || [],
        required: isQuestionMarkedRequired(field, classified.control instanceof HTMLElement ? classified.control : null),
      });
    }
    return fields;
  }

  // ---- value fill per field kind ---------------------------------------

  async function fillAshbyText(control, value, { shouldAbort = () => false } = {}) {
    if (!control || value == null) return;
    await clickLikeHuman(control, { shouldAbort });
    await fillTextInputLikeHuman(control, String(value), { ...ASHBY_HUMAN_TYPING_OPTIONS, shouldAbort });
  }

  // Ashby drops free text on blur if nothing was actually picked from the list, so a phantom
  // value would never submit anyway — blurring here just makes that happen immediately instead
  // of leaving stray typed text sitting in the input.
  async function fillAshbyCombobox(control, value, { shouldAbort = () => false } = {}) {
    if (!control || value == null) return;
    await fillComboboxByTyping(control, String(value), {
      menuSelector: ASHBY_COMBOBOX_OPTION_SELECTOR,
      fallback: null,
      shouldAbort,
    });
    await sleep(COMBOBOX_COMMIT_SETTLE_MS);
    control.blur?.();
  }

  // Normalize the answer (ISO / US / long-form dates, "immediately", "2 weeks") to Ashby's
  // react-datepicker input shape, or null when it isn't a date at all.
  function formatAshbyDateAnswer(answer, today = new Date()) {
    const text = normalizeAshbyText(answer);
    if (!text) return null;
    const pad = (value) => String(value).padStart(2, "0");
    const format = (date) => `${pad(date.getMonth() + 1)}/${pad(date.getDate())}/${date.getFullYear()}`;
    const isPlausible = (date) => !Number.isNaN(date.getTime()) && date.getFullYear() >= 1900 && date.getFullYear() <= 2100;
    const addDays = (days) => {
      const date = new Date(today.getTime());
      date.setDate(date.getDate() + days);
      return date;
    };

    const us = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (us) return `${pad(us[1])}/${pad(us[2])}/${us[3]}`;
    const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
    if (iso) return `${pad(iso[2])}/${pad(iso[3])}/${iso[1]}`;
    if (/\d{4}/.test(text)) {
      const parsed = new Date(text);
      if (isPlausible(parsed)) return format(parsed);
    }
    if (/\b(immediately|asap|as soon as possible|right away|available now|now|flexible|negotiable)\b/i.test(text)) {
      return format(addDays(DEFAULT_START_DATE_OFFSET_DAYS));
    }
    const words = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
    const relative = text.match(/\b(\d+|a|one|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(day|week|month)s?\b/i);
    if (relative) {
      const amount = /^\d+$/.test(relative[1]) ? parseInt(relative[1], 10) : words[relative[1].toLowerCase()];
      const unit = relative[2].toLowerCase();
      const days = unit === "day" ? amount : unit === "week" ? amount * 7 : amount * 30;
      return format(addDays(days));
    }
    return null;
  }

  // Enter commits the typed date in react-datepicker; a value write alone never does.
  function dispatchEnterKey(element) {
    const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
    element.dispatchEvent(new KeyboardEvent("keydown", init));
    element.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  async function fillAshbyDateInput(control, value, { shouldAbort = () => false } = {}) {
    if (!control) return;
    const formatted = formatAshbyDateAnswer(value);
    if (!formatted) return;
    await clickLikeHuman(control, { shouldAbort });
    await fillTextInputLikeHuman(control, formatted, { ...ASHBY_HUMAN_TYPING_OPTIONS, blur: false, shouldAbort });
    dispatchEnterKey(control);
    await sleep(COMBOBOX_COMMIT_SETTLE_MS);
    control.blur?.();
  }

  // fieldOrSelect may be a plain native <select> (BidHub's fillAshbyNativeSelect) — matches a
  // candidate against either the option's value OR its visible text, since Ashby's own
  // month/year option values and labels don't always agree on format.
  function fillAshbyNativeSelect(select, candidates) {
    if (!select) return;
    const normalized = (Array.isArray(candidates) ? candidates : [candidates]).map((c) => normalizeAshbyText(c).toLowerCase()).filter(Boolean);
    if (normalized.length === 0) return;
    const match = Array.from(select.options)
      .filter((option) => option.value !== "" && !option.disabled)
      .find((option) => normalized.includes(normalizeAshbyText(option.value).toLowerCase()) || normalized.includes(normalizeAshbyText(option.textContent).toLowerCase()));
    if (!match) return;
    fillSelectInput(select, match.value);
  }

  async function fillAshbyButtonGroup(field, value, { shouldAbort = () => false } = {}) {
    const text = normalizeAshbyText(value).toLowerCase();
    if (!text) return;
    const options = getChoiceButtons(field);
    const selected = options.find((option) => option.text.toLowerCase() === text) || options.find((option) => option.text.toLowerCase().includes(text));
    if (!selected || isButtonActive(selected.button)) return;
    await clickLikeHuman(selected.button, { shouldAbort });
    await sleep(COMBOBOX_COMMIT_SETTLE_MS);
    if (!isButtonActive(selected.button)) throw new Error(`Option "${selected.text}" did not activate after a real click`);
  }

  async function fillAshbyRadio(field, value, { shouldAbort = () => false } = {}) {
    const text = normalizeAshbyText(value).toLowerCase();
    if (!text) return;
    const options = getRadioInputs(field).map((input) => ({ input, label: input.labels?.[0] || null, text: normalizeAshbyText(getInputLabelText(input)) }));
    const selected =
      options.find((option) => option.text.toLowerCase() === text) || options.find((option) => option.text.toLowerCase().includes(text));
    if (!selected || isAshbyChoiceSelected(selected.input, selected.label)) return;
    await clickLikeHuman(selected.label || selected.input, { shouldAbort });
  }

  // A group of checkboxes is a multi-select; a lone checkbox is a boolean (consent / opt-in).
  // `value` can be a boolean (lone box), a string (one label to tick) or a string[] (explicit
  // multi-select) — mirroring the shapes BidHub's own checkbox handler accepts. An explicit,
  // non-empty array ALSO unticks any box not in it; anything else never clears a box the
  // candidate already ticked.
  async function fillAshbyCheckbox(field, value, { shouldAbort = () => false } = {}) {
    const checkboxInputs = getCheckboxInputs(field);
    if (checkboxInputs.length === 0) return;
    const isMultiSelectGroup = checkboxInputs.length > 1;
    const normalizedSelections = (Array.isArray(value) ? value.map(normalizeAshbyText) : typeof value === "boolean" ? [] : [normalizeAshbyText(value)])
      .map((v) => v.toLowerCase())
      .filter(Boolean);
    const answerSelects = (v) => normalizedSelections.includes(normalizeAshbyText(v).toLowerCase());
    const isExplicitMultiSelection = Array.isArray(value) && value.length > 0;

    for (const checkbox of checkboxInputs) {
      const label = checkbox.labels?.[0] || null;
      const labelText = getInputLabelText(checkbox);
      const shouldCheck =
        typeof value === "boolean" ? value : answerSelects(labelText) || answerSelects(checkbox.value) || (checkboxInputs.length === 1 && (answerSelects("yes") || answerSelects("true")));
      const isSelected = isAshbyChoiceSelected(checkbox, label);
      if (shouldCheck && !isSelected) {
        await clickLikeHuman(label || checkbox, { shouldAbort });
      } else if (isMultiSelectGroup && isExplicitMultiSelection && !shouldCheck && isSelected) {
        await clickLikeHuman(label || checkbox, { shouldAbort });
      }
    }
  }

  // ---- resume / cover letter file upload --------------------------------

  function getAshbyRemoveButtons(field) {
    return Array.from(field?.querySelectorAll(ASHBY_FILE_REMOVE_BUTTON_SELECTOR) ?? []);
  }

  // The upload has settled when the field is no longer spinning and shows a remove button that
  // was NOT there before the file was attached — a previously-attached file (a re-run) already
  // has one, and React unmounts it for the duration of the replacement upload.
  function isAshbyFileUploadSettled(field, previousRemoveButtons) {
    if (!field) return false;
    if (field.querySelector(ASHBY_FILE_UPLOADING_SELECTOR)) return false;
    return getAshbyRemoveButtons(field).some((button) => !previousRemoveButtons.has(button));
  }

  // Ashby reports a rejected S3 POST / set-value mutation only through a toast ("<name> failed to
  // upload") — the file row still renders as if it were attached, so the toast is the only signal.
  function findAshbyUploadFailedToast(fileName) {
    const normalizedFileName = normalizeAshbyText(fileName);
    return (
      Array.from(document.querySelectorAll(ASHBY_TOAST_SELECTOR)).find((toast) => {
        const text = normalizeAshbyText(toast.textContent);
        return ASHBY_UPLOAD_FAILED_TOAST_PATTERN.test(text) && (!normalizedFileName || text.includes(normalizedFileName));
      }) ?? null
    );
  }

  // Remove whatever is already attached first (if the field shows a "Replace"/remove button —
  // Ashby keeps the hidden <input type=file> itself mounted either way, so no removal usually
  // means no re-click is needed at all).
  async function ensureAshbyFileInput(field, { shouldAbort = () => false } = {}) {
    const existingInput = getFileInputInsideField(field);
    if (existingInput) return existingInput;
    const removeButton =
      field?.querySelector(ASHBY_FILE_REMOVE_BUTTON_SELECTOR) ||
      Array.from(field?.querySelectorAll("button") ?? []).find((button) => /remove|delete/i.test(normalizeAshbyText(button.textContent || button.getAttribute("aria-label") || button.getAttribute("title"))));
    if (!removeButton) throw new Error("File upload input not found");
    await clickLikeHuman(removeButton, { shouldAbort });
    for (let waited = 0; waited < 5000; waited += 100) {
      if (shouldAbort()) return null;
      const next = getFileInputInsideField(field);
      if (next) return next;
      await sleep(100);
    }
    throw new Error("File upload input did not reappear after removing the existing file");
  }

  // Attach `file` to the field's file input and block until Ashby has actually finished
  // uploading it (see ASHBY_FILE_REMOVE_BUTTON_SELECTOR). Throws when the upload is rejected or
  // never settles, rather than reporting a silent "filled".
  async function fillAshbyFile(field, file, { shouldAbort = () => false } = {}) {
    const input = await ensureAshbyFileInput(field, { shouldAbort });
    if (!input || shouldAbort()) return;
    const previousRemoveButtons = new Set(getAshbyRemoveButtons(field));
    fillFileInput(input, file.fileName, file.base64, file.mimeType);

    let failedToast = null;
    let settled = false;
    const deadline = Date.now() + FILE_UPLOAD_COMPLETE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (shouldAbort()) return;
      failedToast = findAshbyUploadFailedToast(file.fileName);
      if (failedToast) break;
      if (isAshbyFileUploadSettled(field, previousRemoveButtons)) {
        settled = true;
        break;
      }
      await sleep(FILE_UPLOAD_COMPLETE_POLL_MS);
    }
    if (failedToast) throw new Error(`File upload rejected: ${normalizeAshbyText(failedToast.textContent)}`);
    if (!settled) throw new Error(`File upload did not finish within ${FILE_UPLOAD_COMPLETE_TIMEOUT_MS / 1000}s (no remove button appeared)`);
  }

  // ---- dispatcher + step navigation + submit ----------------------------

  // Fills one field detected by detectAshbyFields(). `value` shape depends on `detected.kind`:
  // string for text/textarea/combobox/date/radio/button-group, boolean|string|string[] for
  // checkbox, and { fileName, base64, mimeType } for resume/cover_letter.
  async function fillAshbyField(detected, value, options = {}) {
    if (!detected || value == null) return;
    switch (detected.kind) {
      case "text":
      case "textarea":
        return fillAshbyText(detected.control, value, options);
      case "combobox":
        return fillAshbyCombobox(detected.control, value, options);
      case "date":
        return fillAshbyDateInput(detected.control, value, options);
      case "button-group":
        return fillAshbyButtonGroup(detected.field, value, options);
      case "radio":
        return fillAshbyRadio(detected.field, value, options);
      case "checkbox":
        return fillAshbyCheckbox(detected.field, value, options);
      case "resume":
      case "cover_letter":
        return fillAshbyFile(detected.field, value, options);
      default:
        return undefined;
    }
  }

  // One-step advance from the Overview tab to the Application tab (Ashby's only "multi-step"
  // navigation outside the form itself) — a no-op once already on the form.
  async function advanceToApplicationForm({ shouldAbort = () => false } = {}) {
    const link = getAshbyApplicationLink();
    if (!link) return false;
    await clickLikeHuman(link, { shouldAbort });
    return true;
  }

  function getAshbySubmitButton() {
    const form = getAshbyForm();
    if (!form) return null;
    const candidates = [
      ...form.querySelectorAll('button[type="submit"], input[type="submit"], button, [role="button"]'),
      ...document.querySelectorAll('button[form="form"], input[type="submit"][form="form"], [role="button"][form="form"]'),
    ];
    return (
      candidates.filter((button, index) => candidates.indexOf(button) === index).filter(isElementVisible).find((button) => /\b(submit|apply)\b/i.test(getAshbyActionLabel(button))) || null
    );
  }

  async function clickAshbySubmitButton({ shouldAbort = () => false } = {}) {
    const button = getAshbySubmitButton();
    if (!button) return false;
    await clickLikeHuman(button, { shouldAbort });
    return true;
  }

  // ---- repeatable Education History section ------------------------------
  // Ashby's own "Education History" question (see isEducationSectionField
  // above, which detectAshbyFields() uses to SKIP this block from the flat
  // field list) is a repeatable block — ported here via the shared
  // engine/section-hierarchy.js, same root→group→leaf model BidHub's own
  // Ashby adapter uses. No Work History equivalent exists on Ashby.
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;

  // Per-row "Delete" button: `_repeatableEducationButton_` + `_negative_`.
  // The "+ Add Education" button shares the base `_repeatableEducationButton_`
  // class but lacks `_negative_`, so this qualifier excludes it.
  const ASHBY_EDUCATION_REMOVE_BUTTON_SELECTOR = '[class*="_repeatableEducationButton_"][class*="_negative_"]';

  // Education's container is the Education question's own field wrapper,
  // not a fixed element — re-resolved live on every call (not cached)
  // because Ashby re-renders this block on add/select, same as BidHub's
  // own getLiveEducationField.
  function getLiveEducationField() {
    return getFieldWrappers().find(isEducationSectionField) || null;
  }
  function getEducationEntries(field) {
    return Array.from(field?.querySelectorAll?.(ASHBY_EDUCATION_ENTRY_SELECTOR) ?? []);
  }
  function getAshbyEducationAddButton(field) {
    return field?.querySelector(ASHBY_EDUCATION_ADD_BUTTON_SELECTOR) || null;
  }

  async function addAshbyEducationRow() {
    const field = getLiveEducationField();
    const button = getAshbyEducationAddButton(field);
    if (button) await clickLikeHuman(button);
  }
  async function clearAshbyEducationRows() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const field = getLiveEducationField();
      const rows = getEducationEntries(field);
      if (rows.length === 0) return;
      // Reverse order — Ashby re-renders the whole block on each removal,
      // so indices below a removed row would otherwise shift mid-loop.
      for (let i = rows.length - 1; i >= 0; i--) {
        const removeBtn = rows[i].querySelector(ASHBY_EDUCATION_REMOVE_BUTTON_SELECTOR);
        if (removeBtn) await clickLikeHuman(removeBtn);
      }
      await sleep(250);
    }
  }
  // Ids are DUPLICATED across rows (Ashby reuses the same field-name
  // suffix per row), so every lookup must be scoped to the one row element —
  // never a document-wide id/name query the way most other sites' row
  // lookups work.
  function getAshbyEducationRowField(rowEl, mapping) {
    const field = rowEl.querySelector(mapping.controlSelector);
    return field ? { field } : null;
  }

  const ASHBY_EDUCATION_SECTION = {
    rootFieldId: "educationHistory",
    rootQuestion: "Education History",
    profileSection: "education",
    rowLabel: (i) => `Education ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: getLiveEducationField,
    getRows: () => getEducationEntries(getLiveEducationField()),
    getRowField: getAshbyEducationRowField,
    addRow: addAshbyEducationRow,
    clearRows: clearAshbyEducationRows,
    // No `major`/`discipline` (Field of Study) field exists on BCD's
    // Profile.education schema (school/degree/start/end only) — that leaf
    // still detects and shows in the review list, it just has nothing to
    // auto-fill from.
    mappings: [
      { key: "degree", question: "Degree", profileKey: "degree", fieldKind: "ashby-text", label: "Degree", controlSelector: 'input[id$="-degree"]' },
      { key: "major", question: "Field of Study", fieldKind: "ashby-text", label: "Field of Study", controlSelector: 'input[id$="-major"]' },
      { key: "startDate", question: "Start Date", fieldKind: "ashby-date", label: "Start Date", controlSelector: '[id$="-startDate"]', resolveValue: (entry) => formatAshbyDateAnswer(entry?.start) },
      {
        key: "isCurrent",
        question: "Still Student?",
        fieldKind: "ashby-checkbox",
        label: "Still Student?",
        controlSelector: 'input[id$="-isCurrent"]',
        resolveValue: (entry) => !String(entry?.end || "").trim(),
      },
      { key: "endDate", question: "End Date", fieldKind: "ashby-date", label: "End Date", controlSelector: '[id$="-endDate"]', resolveValue: (entry) => formatAshbyDateAnswer(entry?.end) },
      // Kept LAST — the school field is an async-search autocomplete
      // (fillAshbyCombobox), slower than the plain text/date leaves above.
      { key: "school", question: "School", fieldKind: "ashby-combobox", label: "School", controlSelector: 'input[role="combobox"], input[aria-autocomplete="list"]', resolveValue: (entry) => entry?.school },
    ],
  };

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections([ASHBY_EDUCATION_SECTION], profileData);
  }

  async function fillSectionLeaf(field, mapping, value) {
    switch (mapping.fieldKind) {
      case "ashby-text":
        return fillAshbyText(field, value);
      case "ashby-date":
        return fillAshbyDateInput(field, value);
      case "ashby-checkbox": {
        const shouldCheck = Boolean(value);
        if (field.checked !== shouldCheck) await clickLikeHuman(field.labels?.[0] || field);
        return;
      }
      case "ashby-combobox":
        return fillAshbyCombobox(field, value);
      default:
        return;
    }
  }

  async function fillSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    const entries = (profileData && profileData.education) || [];
    if (!entries.length) return [];
    const result = await SECTION_HIERARCHY.fillSection(ASHBY_EDUCATION_SECTION, entries, fillSectionLeaf);
    return [{ rootFieldId: ASHBY_EDUCATION_SECTION.rootFieldId, ...result }];
  }

  Object.assign((window.ProactiveAutofillSites = window.ProactiveAutofillSites || {}), {
    ashby: {
      isAshbyApplicationForm: () => Boolean(getAshbyForm()),
      detectFields: detectAshbyFields,
      fillField: fillAshbyField,
      advanceToApplicationForm,
      getSubmitButton: getAshbySubmitButton,
      clickSubmitButton: clickAshbySubmitButton,
      detectSections,
      fillSections,
      // Exposed individually for tests / callers that already have the control in hand.
      fillText: fillAshbyText,
      fillCombobox: fillAshbyCombobox,
      fillDateInput: fillAshbyDateInput,
      fillNativeSelect: fillAshbyNativeSelect,
      fillButtonGroup: fillAshbyButtonGroup,
      fillRadio: fillAshbyRadio,
      fillCheckbox: fillAshbyCheckbox,
      fillFile: fillAshbyFile,
      formatDateAnswer: formatAshbyDateAnswer,
    },
  });
})();
