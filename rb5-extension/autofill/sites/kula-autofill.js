/* =====================================================================
 * autofill/sites/kula-autofill.js — Kula ATS (careers.kula.ai/<account>/<id>-<slug>).
 * =====================================================================
 * Ported from BidHub's own packages/job-parsers/content/platforms/kula/
 * autofill.js. That file's own field-filling MECHANICS (React-safe value
 * writes, human-cadence typing/clicking, file attach) are NOT
 * re-implemented here — they're exactly what autofill/engine/
 * dom-interactions.js already provides as window.ProactiveAutofillEngine,
 * so this file calls into that instead.
 *
 * Kula quirks worth knowing before touching this file (BidHub
 * live-inspected the Phaidra tenant 2026-09-30):
 *   - the posting and the application form are ONE Next.js page: a Chakra
 *     Tabs widget ("Job details" / "Application form"). The form panel
 *     stays mounted with the `hidden` attribute while the details tab is
 *     showing — [data-testid="job-form"] exists in the DOM before it's
 *     visible, so detection gates on isShownInTabs(), not just presence;
 *   - the form is Formik + Chakra + react-select + react-datepicker +
 *     react-dropzone. Every question is a `.chakra-form-control`
 *     (`data-test-id` names its kind, a `label.chakra-form__label` holds
 *     the prompt). Native controls carry the Formik path as BOTH id and
 *     name (`info.first_name`, `additional_info._228473`) — names
 *     contain dots/brackets, so lookups use attribute selectors, never a
 *     bare `#id`;
 *   - Yes/No questions are Chakra radio groups with random input names;
 *   - selects are react-select comboboxes — options only exist in the DOM
 *     while the menu is open, scoped by the input's own `aria-controls`
 *     listbox id (NOT "whichever menu happens to be open" — fills chain
 *     back-to-back and the previous field's menu can still be closing
 *     while this one hasn't rendered yet);
 *   - the phone widget is a country button + `input[type=tel]` (which
 *     takes the NATIONAL number, not the full E.164 string — typing a
 *     "+44…" value does not switch the country, it just gets truncated);
 *   - files are react-dropzone inputs (.pdf/.docx only) that render
 *     "<filename>Uploaded" once the upload finishes, or an inline/toast
 *     rejection message.
 *
 * OUT OF SCOPE (left to Big Banana's own existing systems, untouched):
 *   - Free-text screening-question ANSWER GENERATION and the embedding-
 *     similarity fallback BidHub's findBestOption() used when no exact/
 *     prefix/substring option match exists. detectFields() below only
 *     CLASSIFIES each question's structural type and locates its
 *     control; fillField() only WRITES an answer the caller already
 *     resolved, same as every other port in this folder. A select/radio/
 *     checkbox group this file can't place deterministically (no exact,
 *     prefix, or substring match) is left untouched rather than guessed.
 *   - CAPTCHA / bot-scoring. Kula's submit runs a score-based reCAPTCHA
 *     v3 + FingerprintJS Pro — this file paces fills with a short
 *     per-field delay and presses Submit like a person would, and leaves
 *     whatever Kula's scorer does with that completely alone.
 *   - Proxy/remote-CDP "real input" lane. BidHub's own source branches
 *     every interaction through a `useRemoteInput()` check for a
 *     patchright-driven runner lane (remote-input.js); that lane doesn't
 *     exist here, so every fill below just goes straight through
 *     window.ProactiveAutofillEngine's synthetic-event path. This also
 *     drops the one react-select-specific quirk that lane cared about
 *     (commitOptionElement below still avoids engine's clickLikeHuman for
 *     the SAME reason BidHub's own synthetic path did — see its comment).
 *   - Repeatable "Add row" profile-section editors (Kula's own Education
 *     / Experience blocks under Profile, when a tenant enables them)
 *     beyond the FIRST always-rendered row. detectFields() below only
 *     widens the usual per-field scan to include row index 0's own
 *     controls (`profile.education[0].*` / `profile.experience[0].*`) —
 *     any later row, and the "Add"/"Remove" row buttons themselves, are
 *     never detected or clicked.
 * ==================================================================== */
(function () {
  "use strict";

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    sleep,
    fillTextInput,
    fillTextInputLikeHuman,
    fillFileInput,
    fillSelectInput,
    clickLikeHuman,
    getCheckboxInputs,
    getRadioInputs,
    getTextarea,
    getFileInputInsideField,
  } = engine;

  const FORM_SELECTOR = '[data-testid="job-form"]';
  const SUBMIT_SELECTOR = '[data-testid="apply-button"]';
  const FORM_CONTROL_SELECTOR = ".chakra-form-control";
  const LABEL_SELECTOR = "label.chakra-form__label, label";
  const REQUIRED_INDICATOR_SELECTOR = ".chakra-form__required-indicator";
  const RESUME_PARSER_SELECTOR = '[data-testid="resume-upload-button"], [data-testid="resume-upload-input"]';
  const COMBOBOX_SELECTOR = 'input[role="combobox"], input[aria-autocomplete="list"]';
  const OPTION_SELECTOR = '[role="option"]';
  const MULTI_VALUE_SELECTOR = '[class*="multiValue"], [class*="multi-value"]';
  const DATE_INPUT_SELECTOR =
    ".kula-date-field-input-trigger, .react-datepicker__input-container input, .react-datepicker-wrapper input";
  const TEXT_INPUT_SELECTOR =
    'input:not([type="hidden"]):not([type="file"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"]):not([type="tel"]):not([role="combobox"]):not([aria-autocomplete])';
  // Repeatable education/experience rows (`profile.education[0].institution`, …) — only row index 0
  // is in scope (see the file header); any other index is skipped entirely.
  const SECTION_ROW_PATTERN = /^profile\.(?:education|experience)\[(\d+)\]/;
  // EEOC selects render their prompt as plain text, not a FormLabel — map the wrapper's test id.
  const EEOC_QUESTIONS = {
    "eeoc-race": "Race or ethnicity",
    "eeoc-gender": "Gender",
    "eeoc-veteran-status": "Veteran status",
    "eeoc-disability-status": "Disability status",
    office: "Office / location",
  };
  const YES_NO_OPTIONS = ["Yes", "No"];
  const AFFIRMATIVE_ANSWERS = new Set(["yes", "y", "true", "on", "checked", "agree", "accept", "1"]);
  const NEGATIVE_ANSWERS = new Set(["no", "n", "false", "off", "unchecked", "decline", "disagree", "none", "0"]);

  // Human-like pacing for Kula's bot scoring (reCAPTCHA v3 + FingerprintJS Pro).
  const KULA_TYPING_OPTIONS = { perCharDelayMs: 22, maxTotalTypingMs: 4500 };
  const REACT_SELECT_SETTLE_MS = 150;
  const REACT_SELECT_POLL_MS = 100;
  const DROPDOWN_WAIT_TIMEOUT_MS = 5000;
  const FILE_UPLOAD_COMPLETE_TIMEOUT_MS = 60000;
  const FILE_UPLOAD_COMPLETE_POLL_MS = 200;
  // The uploaded row renders "<filename>Uploaded" with no whitespace around the status word, so no
  // word boundaries; case-sensitive so the prompt's "click to upload"/"Uploading..." never match.
  const UPLOADED_TEXT_PATTERN = /Uploaded/;
  const UPLOAD_FAILED_PATTERN = /failed to upload|file type not supported|invalid format|only pdf or docx|exceeds the .* limit|error validating/i;
  const DATEPICKER_MAX_MONTH_STEPS = 36;
  const DATEPICKER_NAV_SETTLE_MS = 60;
  // Repeatable Education/Experience row block mechanics (below).
  const ROW_ADD_BUTTON_PATTERN = /^add\b/i;
  const ROW_REMOVE_BUTTON_PATTERN = /^remove\b/i;
  const ROW_APPEAR_TIMEOUT_MS = 3000;
  const PHONE_COUNTRY_BUTTON_SELECTOR = 'button[aria-label^="Select country"], button';
  const PHONE_COUNTRY_SEARCH_SELECTOR = 'input[aria-label="Search countries"], input[placeholder*="Search countries" i]';
  const PHONE_DIAL_PATTERN = /\+(\d{1,4})\s*$/;
  const PHONE_COUNTRY_WAIT_MS = 3000;
  const SHARED_DIAL_PREFERENCE = ["United States", "Canada", "United Kingdom", "Russia", "Kazakhstan"];
  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  // ---- small text/wait helpers --------------------------------------------

  function cleanText(value) {
    return String(value ?? "").replace(/\u00a0/g, " ").replace(/[✱*]/g, "").replace(/\s+/g, " ").trim();
  }
  function slugify(value) {
    return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  // Formik paths carry dots and brackets (`profile.education[0].summary`) — escape for use inside a
  // quoted attribute selector.
  function cssAttrValue(value) {
    return String(value ?? "").replace(/["\\[\]]/g, "\\$&");
  }

  async function waitForWithAbort(check, timeoutMs, shouldAbort = () => false, pollMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (shouldAbort()) return null;
      const result = check();
      if (result) return result;
      await sleep(pollMs);
    }
    return null;
  }

  // Retries an async operation a few times with backoff — used around the react-select commit path,
  // which can occasionally race Formik's own re-render.
  async function withRetry(fn, maxAttempts = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) await sleep(500 * attempt);
      }
    }
    throw lastErr;
  }

  function pressEscapeOn(target) {
    if (!target) return;
    const init = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true, composed: true };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
  }

  // ---- form / tab state -----------------------------------------------------

  function getForm() {
    return document.querySelector(FORM_SELECTOR);
  }
  // Chakra keeps the non-selected TabPanel mounted with `hidden` — that attribute (plus inline
  // display) is the real visibility signal here, not offsetParent.
  function isShownInTabs(element) {
    if (!element?.isConnected) return false;
    if (element.closest("[hidden]")) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }
  function getVisibleForm() {
    const form = getForm();
    return form && isShownInTabs(form) ? form : null;
  }

  function getSubmitButton() {
    return getVisibleForm()?.querySelector(SUBMIT_SELECTOR) || null;
  }
  // Chakra's `isLoading` (reCAPTCHA "Verifying...") sets data-loading + disabled — pressing Submit
  // while it runs would double-submit (err_application_already_exists).
  function isSubmitButtonDisabled(button) {
    if (!button) return true;
    const label = cleanText(button.textContent || button.getAttribute?.("aria-label") || button.value || "");
    return Boolean(
      button.disabled || button.getAttribute("aria-disabled") === "true" || button.hasAttribute("data-loading") || /verifying/i.test(label)
    );
  }
  async function clickSubmitButton({ shouldAbort = () => false } = {}) {
    const button = getSubmitButton();
    if (!button || shouldAbort()) return false;
    await clickLikeHuman(button, { shouldAbort });
    return true;
  }

  // The forward control on the details tab: the "Application form" tab, else the details panel's
  // own "Apply for this position" button (outside the form — the in-form one is the final submit).
  function getAdvanceTarget() {
    if (getVisibleForm()) return null;
    const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((candidate) =>
      /application form/i.test(cleanText(candidate.textContent))
    );
    if (tab) return tab;
    return (
      Array.from(document.querySelectorAll("button, a[href]")).find(
        (candidate) => /apply for this position/i.test(cleanText(candidate.textContent)) && !candidate.closest(FORM_SELECTOR)
      ) || null
    );
  }
  // …/<account>/<id>-<slug> → …/<account>/<id>-<slug>/apply (query kept: jr_id is the tenant's own
  // attribution). Null when the current url isn't a posting.
  function buildApplyUrl(location = window.location) {
    const segments = location.pathname.split("/").filter(Boolean);
    if (segments.length !== 2 || !/^\d+(?:-|$)/.test(segments[1])) return null;
    return `${location.origin}/${segments[0]}/${segments[1]}/apply${location.search || ""}`;
  }
  // Advance one step: prefer a FULL navigation to the /apply route over the in-document tab switch
  // when the current URL supports it — a same-document tab switch would otherwise reveal the form
  // under THIS content-script run even when the user only meant to advance. Returns true if a step
  // was taken (caller should re-detect); false if there's nothing to advance.
  async function advance({ shouldAbort = () => false } = {}) {
    if (getVisibleForm()) return false;
    const target = getAdvanceTarget();
    if (!target || shouldAbort()) return false;
    const applyUrl = buildApplyUrl();
    if (applyUrl && applyUrl !== window.location.href) {
      window.location.assign(applyUrl);
      return true;
    }
    await clickLikeHuman(target, { shouldAbort });
    return true;
  }

  function isAutofillAvailable() {
    return Boolean(detectFields().length || getSubmitButton() || getAdvanceTarget());
  }

  // ---- question wrappers -----------------------------------------------------

  function getLabelText(formControl) {
    return cleanText(formControl?.querySelector(LABEL_SELECTOR)?.textContent);
  }
  function isRequiredQuestion(formControl, control = null) {
    if (control?.required || control?.getAttribute?.("aria-required") === "true") return true;
    if (formControl?.getAttribute?.("aria-required") === "true") return true;
    if (formControl?.hasAttribute?.("data-required")) return true;
    return Boolean(formControl?.querySelector(REQUIRED_INDICATOR_SELECTOR));
  }
  function getComboboxInput(field) {
    if (!field) return null;
    return field.matches?.(COMBOBOX_SELECTOR) ? field : field.querySelector(COMBOBOX_SELECTOR);
  }
  function getTextControl(field) {
    if (!field) return null;
    if (field.tagName === "INPUT" || field.tagName === "TEXTAREA") return field;
    return field.querySelector("textarea") || field.querySelector(TEXT_INPUT_SELECTOR) || null;
  }
  function isNumericInput(input) {
    return input?.getAttribute("inputmode") === "numeric" || /^\[0-9\]/.test(input?.getAttribute("pattern") || "") || input?.type === "number";
  }

  // Re-resolve a question wrapper by its Formik control: Formik re-renders (office change, a resume-
  // parser prefill, the form's own "has been updated" refresh) remount controls, so fill-time lookups
  // never trust the detection-time node when a live one can be found.
  function getLiveFormControl(fieldId, fallback) {
    if (fieldId) {
      const escaped = cssAttrValue(fieldId);
      const control = document.querySelector(`${FORM_SELECTOR} [name="${escaped}"], ${FORM_SELECTOR} [id="${escaped}"]`);
      const wrapper = control?.closest(FORM_CONTROL_SELECTOR);
      if (wrapper) return wrapper;
    }
    return fallback;
  }

  // ---- field detection -------------------------------------------------------

  /**
   * Walk Kula's visible application form and return every question this
   * adapter knows how to fill deterministically. Anything else (a question
   * classification can't place, or one with no derivable question text) is
   * left out entirely, for Big Banana's own generic/AI pipeline to pick up
   * per the scope note at the top of this file.
   *
   * @returns {Array<{question:string, fieldId:string, field:Element,
   *   fieldKind:string, options:string[]|null, required:boolean,
   *   isResume?:boolean, isCoverLetter?:boolean}>}
   */
  function detectFields() {
    const form = getVisibleForm();
    if (!form) return [];

    const entries = [];
    const usedFieldIds = new Set();
    const uniqueFieldId = (base) => {
      let candidate = base;
      let n = 2;
      while (usedFieldIds.has(candidate)) candidate = `${base}-${n++}`;
      return candidate;
    };
    const addEntry = (entry) => {
      if (!entry.question || !entry.fieldId || !entry.field) return;
      const fieldId = uniqueFieldId(entry.fieldId);
      usedFieldIds.add(fieldId);
      entries.push({ options: null, ...entry, fieldId });
    };

    for (const formControl of Array.from(form.querySelectorAll(FORM_CONTROL_SELECTOR))) {
      // Nested wrappers (a control group inside another) are handled through their parent.
      if (formControl.parentElement?.closest(FORM_CONTROL_SELECTOR)) continue;
      // Kula's own "Autofill from resume" widget is not a question.
      if (formControl.closest(RESUME_PARSER_SELECTOR) || formControl.querySelector(RESUME_PARSER_SELECTOR)) continue;

      const namedControl = formControl.querySelector("[name], [id]");
      const formikName = namedControl?.getAttribute("name") || namedControl?.id || "";
      const rowMatch = formikName.match(SECTION_ROW_PATTERN);
      // Repeatable education/experience rows are owned by the shared profile-section hierarchy
      // (detectSections/fillSections below) — skip every row here, same as Greenhouse/Ashby's own
      // SECTION_CONTAINER_SELECTOR guard, so a row's controls are never double-detected.
      if (rowMatch) continue;

      const testId = formControl.getAttribute("data-test-id") || "";
      const label = getLabelText(formControl);
      const question = label || EEOC_QUESTIONS[testId] || "";
      if (!question) continue;
      const slug = slugify(question) || slugify(testId) || "question";

      // Résumé/cover-letter/custom file questions — react-dropzone; the field is the wrapper so it
      // stays resolvable after the input is swapped for the "Uploaded" row.
      const fileInput = getFileInputInsideField(formControl);
      if (fileInput) {
        const isCoverLetter = /cover\s*letter|covering letter|motivation letter/i.test(question) || fileInput.id === "cover_letter";
        const isResume = /r[ée]sum[ée]|\bcv\b|curriculum/i.test(question) || fileInput.id === "resume";
        addEntry({
          question,
          fieldId: fileInput.id || `file:${slug}`,
          field: formControl,
          fieldKind: "file",
          isResume,
          isCoverLetter,
          required: isRequiredQuestion(formControl, fileInput),
        });
        continue;
      }

      // Phone: country button + visible tel input + the hidden e164 value the form submits.
      const telInput = formControl.querySelector('input[type="tel"]');
      if (telInput) {
        const e164 = formControl.querySelector('input[type="hidden"][name$="-phone-e164"], input[type="hidden"][name*="phone"]');
        addEntry({
          question,
          fieldId: e164?.getAttribute("name") || telInput.id || `phone:${slug}`,
          field: formControl,
          fieldKind: "phone",
          required: isRequiredQuestion(formControl, telInput),
        });
        continue;
      }

      // Yes/No (enum_boolean) — Chakra radio group; the radios' names are random per render, so the
      // id is the question itself.
      const radios = getRadioInputs(formControl);
      if (radios.length) {
        const options = radios
          .map((radio) => cleanText(radio.closest("label")?.textContent || radio.labels?.[0]?.textContent || radio.value))
          .filter(Boolean);
        addEntry({
          question,
          fieldId: `boolean:${slug}`,
          field: formControl,
          fieldKind: "radio",
          options: options.length ? options : YES_NO_OPTIONS,
          required: isRequiredQuestion(formControl, radios[0]),
        });
        continue;
      }

      // react-select (custom select/multiselect, EEOC, office): options only exist while open.
      const combobox = getComboboxInput(formControl);
      if (combobox) {
        const isMulti =
          testId === "multiselect" || combobox.getAttribute("aria-multiselectable") === "true" || Boolean(formControl.querySelector(MULTI_VALUE_SELECTOR));
        addEntry({
          question,
          fieldId: `${testId || "select"}:${slug}`,
          field: formControl,
          fieldKind: isMulti ? "react-select-multi" : "react-select",
          required: isRequiredQuestion(formControl, combobox),
        });
        continue;
      }

      // react-datepicker (keyboard input blocked by the widget).
      const dateInput = formControl.querySelector(DATE_INPUT_SELECTOR);
      if (dateInput) {
        addEntry({
          question,
          fieldId: dateInput.getAttribute("name") || dateInput.id || `date:${slug}`,
          field: formControl,
          fieldKind: "datepicker",
          required: isRequiredQuestion(formControl, dateInput),
        });
        continue;
      }

      const textarea = getTextarea(formControl);
      if (textarea) {
        addEntry({
          question,
          fieldId: textarea.getAttribute("name") || textarea.id || `textarea:${slug}`,
          field: formControl,
          fieldKind: "textarea",
          required: isRequiredQuestion(formControl, textarea),
        });
        continue;
      }

      const input = formControl.querySelector(TEXT_INPUT_SELECTOR);
      if (input) {
        addEntry({
          question,
          fieldId: input.getAttribute("name") || input.id || `text:${slug}`,
          field: formControl,
          fieldKind: isNumericInput(input) ? "numeric" : "text",
          required: isRequiredQuestion(formControl, input),
        });
        continue;
      }

      // A lone checkbox (a consent variant) is a Yes/No question.
      const checkboxes = getCheckboxInputs(formControl);
      if (checkboxes.length === 1) {
        addEntry({
          question,
          fieldId: checkboxes[0].getAttribute("name") || checkboxes[0].id || `checkbox:${slug}`,
          field: formControl,
          fieldKind: "checkbox",
          options: YES_NO_OPTIONS,
          required: isRequiredQuestion(formControl, checkboxes[0]),
        });
      }
    }
    return entries;
  }

  // ---- option matching --------------------------------------------------------

  function normalizeYesNo(answer, options) {
    const texts = options.map((option) => option.text.toLowerCase());
    if (!texts.includes("yes") || !texts.includes("no")) return answer;
    if (typeof answer === "boolean") return answer ? "Yes" : "No";
    const want = cleanText(answer).toLowerCase();
    if (AFFIRMATIVE_ANSWERS.has(want)) return "Yes";
    if (NEGATIVE_ANSWERS.has(want)) return "No";
    return answer;
  }

  // Exact → option starts with the answer → option contains it; null when nothing fits.
  // Deliberately NOT BidHub's embedding-similarity fallback for a looser miss — that's the
  // out-of-scope AI-answer backend (see the file header), so a field this can't place
  // deterministically is left untouched for Big Banana's generic pipeline to try.
  function findBestOption(answer, options) {
    const want = cleanText(answer).toLowerCase();
    if (!want || !options?.length) return null;
    return (
      options.find((option) => option.text.toLowerCase() === want) ||
      options.find((option) => option.text.toLowerCase().startsWith(want)) ||
      options.find((option) => option.text.toLowerCase().includes(want)) ||
      null
    );
  }

  function isAffirmativeAnswer(answer) {
    if (typeof answer === "boolean") return answer;
    const text = cleanText(answer).toLowerCase();
    if (!text) return false;
    return !NEGATIVE_ANSWERS.has(text);
  }

  // ---- react-select -----------------------------------------------------------

  function getSelectControl(input) {
    return input?.closest('[class*="-control"]') || input?.parentElement?.parentElement || input;
  }
  function getListbox(input) {
    const id = input?.getAttribute("aria-controls") || input?.getAttribute("aria-owns");
    return id ? document.getElementById(id) : null;
  }
  function isMenuOpen(input) {
    return input?.getAttribute("aria-expanded") === "true" || Boolean(getListbox(input));
  }
  // Non-searchable lists render a `dummyInput` (react-select `isSearchable: false`); searchable ones
  // (more options, async lookups) take typed filters.
  function isSearchable(input) {
    return Boolean(input) && !/dummyInput/i.test(input.className || "") && !input.readOnly;
  }
  // Scoped to the input's own `aria-controls` listbox id when there is one — never "whatever menu
  // happens to be open": fills chain back-to-back and the previous field's menu can still be
  // closing while this field's hasn't rendered yet.
  function readOptions(input) {
    const listbox = getListbox(input);
    const prefix = (input?.id || "").replace(/-input$/, "");
    const nodes = Array.from((listbox || document).querySelectorAll(OPTION_SELECTOR)).filter(
      (node) => listbox || !prefix || (node.id || "").startsWith(prefix)
    );
    return nodes.map((element) => ({ element, text: cleanText(element.textContent) })).filter((option) => option.text);
  }
  async function openSelect(input, { shouldAbort = () => false } = {}) {
    if (isMenuOpen(input)) return;
    await clickLikeHuman(getSelectControl(input), { shouldAbort });
  }
  async function closeSelect(input) {
    if (!input) return;
    if (isMenuOpen(input)) pressEscapeOn(input);
    input.blur?.();
  }
  function waitForOptions(input, shouldAbort) {
    return waitForWithAbort(() => {
      const options = readOptions(input);
      return options.length ? options : null;
    }, DROPDOWN_WAIT_TIMEOUT_MS, shouldAbort, REACT_SELECT_POLL_MS);
  }
  /** The option list a react-select field currently offers (opens the menu, reads it, closes it
   *  again) — for a caller that needs the choices before picking one. */
  async function fetchSelectOptions(field, { shouldAbort = () => false } = {}) {
    const input = getComboboxInput(field);
    if (!input) return null;
    await openSelect(input, { shouldAbort });
    const options = await waitForOptions(input, shouldAbort);
    await closeSelect(input);
    return options ? options.map((option) => option.text) : null;
  }

  // Commit a menu option (react-select, the phone country list). The shared clickLikeHuman is NOT
  // used here: it calls element.focus() between mousedown and click, which blurs the combobox input
  // — react-select then closes/unmounts its menu and the click lands on a detached node
  // (live-verified against BidHub's own notes: plain/pointer-sequence/real clicks all commit, the
  // focus-then-click path never does).
  async function commitOptionElement(element, shouldAbort = () => false) {
    if (!element || shouldAbort()) return;
    const rect = element.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      clientX: Math.round(rect.left + Math.min(rect.width / 2, 12)),
      clientY: Math.round(rect.top + Math.min(rect.height / 2, 12)),
    };
    const pointer = (type, buttons) =>
      typeof PointerEvent === "function" ? new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons }) : null;
    const dispatch = (event) => event && element.dispatchEvent(event);
    dispatch(pointer("pointerdown", 1));
    dispatch(new MouseEvent("mousedown", { ...init, buttons: 1 }));
    dispatch(pointer("pointerup", 0));
    dispatch(new MouseEvent("mouseup", init));
    element.click();
  }

  async function pickReactSelectOption(input, want, shouldAbort) {
    await openSelect(input, { shouldAbort });
    let options = (await waitForOptions(input, shouldAbort)) || [];
    let chosen = findBestOption(want, options);
    if (!chosen && isSearchable(input)) {
      await fillTextInputLikeHuman(input, want, { ...KULA_TYPING_OPTIONS, blur: false, shouldAbort });
      await openSelect(input, { shouldAbort });
      options = (await waitForOptions(input, shouldAbort)) || [];
      chosen = findBestOption(want, options);
    }
    if (!chosen) {
      await closeSelect(input);
      throw new Error(`kula: no select option matched "${want}"`);
    }
    await commitOptionElement(chosen.element, shouldAbort);
    await sleep(REACT_SELECT_SETTLE_MS);
    return chosen;
  }

  async function fillReactSelect(field, answer, { shouldAbort = () => false } = {}) {
    const want = cleanText(answer);
    const input = getComboboxInput(field);
    if (!want || !input) return;
    await withRetry(() => pickReactSelectOption(input, want, shouldAbort));
  }

  async function fillReactSelectMulti(field, answer, { shouldAbort = () => false } = {}) {
    const values = (Array.isArray(answer) ? answer : [answer]).map(cleanText).filter(Boolean);
    const input = getComboboxInput(field);
    if (!input || !values.length) return;
    const selectedTexts = () =>
      Array.from(field.querySelectorAll(MULTI_VALUE_SELECTOR)).map((node) => cleanText(node.textContent).toLowerCase());
    for (const want of values) {
      if (shouldAbort()) return;
      if (selectedTexts().includes(want.toLowerCase())) continue;
      await openSelect(input, { shouldAbort });
      const options = ((await waitForOptions(input, shouldAbort)) || []).filter((option) => !selectedTexts().includes(option.text.toLowerCase()));
      const chosen = findBestOption(want, options);
      if (!chosen) continue;
      await commitOptionElement(chosen.element, shouldAbort);
      await sleep(REACT_SELECT_SETTLE_MS);
    }
    await closeSelect(input);
  }

  // ---- radios / checkboxes ------------------------------------------------------

  async function fillRadio(field, answer, { shouldAbort = () => false } = {}) {
    const radios = getRadioInputs(field);
    if (!radios.length) return;
    const options = radios
      .map((input) => {
        const label = input.closest("label") || input.labels?.[0] || null;
        return { input, label, text: cleanText(label?.textContent || input.value) };
      })
      .filter((option) => option.text);
    const chosen = findBestOption(normalizeYesNo(answer, options), options);
    if (!chosen || chosen.input.checked) return;
    await clickLikeHuman(chosen.label || chosen.input, { shouldAbort });
    if (!chosen.input.checked) chosen.input.click();
  }

  async function fillCheckbox(field, answer, { shouldAbort = () => false } = {}) {
    const checkbox = field?.type === "checkbox" ? field : field?.querySelector('input[type="checkbox"]');
    if (!checkbox) return;
    const shouldCheck = isAffirmativeAnswer(answer);
    if (checkbox.checked === shouldCheck) return;
    await clickLikeHuman(checkbox.closest("label") || checkbox, { shouldAbort });
    if (checkbox.checked !== shouldCheck) checkbox.click();
  }

  // ---- dates ------------------------------------------------------------------------

  const pad2 = (value) => String(value).padStart(2, "0");

  function parseKulaDate(value) {
    const text = String(value ?? "").trim();
    if (!text) return null;
    const iso = text.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/);
    if (iso) return { year: Number(iso[1]), month: iso[2] ? Number(iso[2]) : null, day: iso[3] ? Number(iso[3]) : null };
    const numeric = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (numeric) {
      const year = numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3];
      return { year: Number(year), month: Number(numeric[1]), day: Number(numeric[2]) };
    }
    const monthYear = text.match(/^(\d{1,2})[/-](\d{4})$/);
    if (monthYear) return { year: Number(monthYear[2]), month: Number(monthYear[1]), day: null };
    const named = text.match(/^([A-Za-z]+)\s+(?:(\d{1,2}),?\s+)?(\d{4})$/);
    if (named) {
      const monthIndex = MONTH_NAMES.findIndex((month) => month.toLowerCase().startsWith(named[1].toLowerCase()));
      return { year: Number(named[3]), month: monthIndex >= 0 ? monthIndex + 1 : null, day: named[2] ? Number(named[2]) : null };
    }
    if (/^\d{4}$/.test(text)) return { year: Number(text), month: null, day: null };
    return null; // not a recognizable date — leaves the picker untouched ("N/A", "Immediately", …)
  }

  function parseCalendarHeader(text) {
    const clean = cleanText(text);
    const yearOnly = clean.match(/^(\d{4})$/);
    if (yearOnly) return { year: Number(yearOnly[1]), month: null };
    const parsed = new Date(`${clean} 1`);
    if (Number.isNaN(parsed.getTime())) return null;
    return { year: parsed.getFullYear(), month: parsed.getMonth() + 1 };
  }

  // react-datepicker calendar: month/year <select>s when the picker renders them, else prev/next
  // navigation until the header shows the wanted month; then the day cell (or the month cell of a
  // month-year-only picker).
  async function pickCalendarDate({ year, month, day }, shouldAbort = () => false) {
    const calendar = await waitForWithAbort(() => document.querySelector(".react-datepicker"), DROPDOWN_WAIT_TIMEOUT_MS, shouldAbort, REACT_SELECT_POLL_MS);
    if (!calendar) return false;

    const monthSelect = calendar.querySelector(".react-datepicker__month-select");
    const yearSelect = calendar.querySelector(".react-datepicker__year-select");
    if (monthSelect && yearSelect) {
      fillSelectInput(yearSelect, String(year));
      fillSelectInput(monthSelect, String(month - 1));
    } else {
      for (let step = 0; step < DATEPICKER_MAX_MONTH_STEPS; step++) {
        if (shouldAbort()) return false;
        const shown = parseCalendarHeader(calendar.querySelector(".react-datepicker__current-month, .react-datepicker-year-header")?.textContent);
        if (!shown) break;
        const diff = shown.month == null ? (year - shown.year) * 12 : (year - shown.year) * 12 + (month - shown.month);
        if (diff === 0) break;
        const nav = calendar.querySelector(diff > 0 ? ".react-datepicker__navigation--next" : ".react-datepicker__navigation--previous");
        if (!nav) break;
        await clickLikeHuman(nav, { shouldAbort });
        await sleep(DATEPICKER_NAV_SETTLE_MS);
      }
    }

    const dayCell = Array.from(calendar.querySelectorAll(".react-datepicker__day")).find(
      (cell) => !cell.classList.contains("react-datepicker__day--outside-month") && Number(cleanText(cell.textContent)) === (day || 1)
    );
    const target = dayCell || calendar.querySelector(`.react-datepicker__month-${month - 1}`);
    if (!target) return false;
    await clickLikeHuman(target, { shouldAbort });
    return true;
  }

  async function fillDatepicker(field, answer, { shouldAbort = () => false } = {}) {
    const input = field?.querySelector(DATE_INPUT_SELECTOR) || field?.querySelector("input");
    const raw = cleanText(answer);
    if (!input || !raw) return;
    const parsed = parseKulaDate(raw);
    if (!parsed?.year) return; // a non-date answer ("N/A", "Immediately") leaves the picker untouched
    const year = parsed.year;
    const month = parsed.month || 1;
    const day = parsed.day || 1;

    // The widget blocks keystrokes (onKeyDown preventDefault) but not a React-safe value write +
    // change event, which react-datepicker's onChangeRaw parses in its own display format.
    fillTextInput(input, `${year}-${pad2(month)}-${pad2(day)}`);
    await sleep(REACT_SELECT_SETTLE_MS);
    if (cleanText(input.value)) return; // the raw write stuck — no need to drive the calendar UI

    await clickLikeHuman(input, { shouldAbort });
    const picked = await pickCalendarDate({ year, month, day }, shouldAbort);
    if (!picked) throw new Error(`kula: could not set the date "${raw}"`);
  }

  // ---- phone ----------------------------------------------------------------------
  // The phone widget is a country button ("🇺🇸+1") + a tel input that takes the NATIONAL number
  // under that country + a hidden `*-phone-e164` value. Typing an international "+44…" string does
  // NOT switch the country — the widget keeps the current dial code and truncates — so an answer
  // with a country code is applied by picking the country from the button's searchable listbox
  // ("🇬🇧United Kingdom+44") and typing the national digits.

  function parsePhoneCountryOption(element) {
    const text = cleanText(element.textContent);
    const dial = text.match(PHONE_DIAL_PATTERN);
    if (!dial) return null;
    const name = text.slice(0, dial.index).replace(/(?:\uD83C[\uDDE6-\uDDFF])/g, "").trim();
    return { element, name, dial: dial[1], text };
  }
  function readPhoneCountryOptions() {
    return Array.from(document.querySelectorAll('[role="listbox"] [role="option"], [role="option"]'))
      .map(parsePhoneCountryOption)
      .filter(Boolean);
  }
  // Pick the country whose dial code prefixes the E.164 digits: the longest matching code wins; a
  // code shared by several countries (+1, +7, +44) keeps the currently selected one when it shares
  // it, else the conventional owner.
  function choosePhoneCountry(options, digits, currentName = "") {
    const matching = options.filter((option) => digits.startsWith(option.dial));
    if (!matching.length) return null;
    const longest = Math.max(...matching.map((option) => option.dial.length));
    const candidates = matching.filter((option) => option.dial.length === longest);
    return (
      candidates.find((option) => currentName && option.name.toLowerCase() === currentName.toLowerCase()) ||
      SHARED_DIAL_PREFERENCE.map((name) => candidates.find((option) => option.name.toLowerCase() === name.toLowerCase())).find(Boolean) ||
      candidates[0]
    );
  }
  async function selectPhoneCountry(formControl, digits, shouldAbort = () => false) {
    const button = formControl?.querySelector(PHONE_COUNTRY_BUTTON_SELECTOR);
    if (!button) return null;
    const currentDial = (cleanText(button.textContent).match(/\+(\d{1,4})/) || [])[1] || "";
    const currentName = (button.getAttribute("aria-label") || "").replace(/^select country\.?\s*currently\s*/i, "").trim();
    await clickLikeHuman(button, { shouldAbort });
    const options = await waitForWithAbort(
      () => {
        const found = readPhoneCountryOptions();
        return found.length ? found : null;
      },
      PHONE_COUNTRY_WAIT_MS,
      shouldAbort,
      REACT_SELECT_POLL_MS
    );
    if (!options) return null;
    const chosen = choosePhoneCountry(options, digits, currentName);
    if (!chosen) {
      pressEscapeOn(document.activeElement);
      return null;
    }
    if (chosen.dial === currentDial && (!currentName || chosen.name.toLowerCase() === currentName.toLowerCase())) {
      pressEscapeOn(document.activeElement);
      return chosen;
    }
    // Narrow the (long) list through its search box when there is one, then commit the option.
    const search = document.querySelector(PHONE_COUNTRY_SEARCH_SELECTOR);
    let target = chosen.element;
    if (search) {
      await fillTextInputLikeHuman(search, chosen.name, { ...KULA_TYPING_OPTIONS, blur: false, shouldAbort });
      const filtered = await waitForWithAbort(
        () => readPhoneCountryOptions().find((option) => option.name.toLowerCase() === chosen.name.toLowerCase()) || null,
        PHONE_COUNTRY_WAIT_MS,
        shouldAbort,
        REACT_SELECT_POLL_MS
      );
      if (filtered) target = filtered.element;
    }
    await commitOptionElement(target, shouldAbort);
    await sleep(REACT_SELECT_SETTLE_MS);
    return chosen;
  }
  async function fillPhone(formControl, answer, { shouldAbort = () => false } = {}) {
    const raw = cleanText(answer);
    const tel = formControl?.querySelector('input[type="tel"]');
    if (!raw || !tel) return;
    const international = raw.replace(/^00/, "+").startsWith("+");
    const digits = raw.replace(/\D/g, "");
    if (!digits) return;
    let national = digits;
    if (international) {
      const country = await selectPhoneCountry(formControl, digits, shouldAbort);
      if (country) {
        national = digits.slice(country.dial.length);
      } else {
        // No country list: fall back to typing the national part under the shown dial code.
        const currentDial = (cleanText(formControl.querySelector(PHONE_COUNTRY_BUTTON_SELECTOR)?.textContent).match(/\+(\d{1,4})/) || [])[1];
        if (currentDial && digits.startsWith(currentDial)) national = digits.slice(currentDial.length);
      }
    }
    if (!national) return;
    await fillTextInputLikeHuman(tel, national, { ...KULA_TYPING_OPTIONS, shouldAbort });
  }

  // ---- files ----------------------------------------------------------------------

  const isFileAnswer = (answer) => Boolean(answer) && typeof answer === "object" && answer.type === "file" && Boolean(answer.base64);

  /** Upload a file into a detected 'file' entry and wait for Kula's own dropzone to settle
   *  (it renders "<filename>Uploaded" once PUT /api/upload-file returns, or an inline/toast
   *  rejection). `answer` must already be a resolved {fileName, base64, mimeType} — a plain-text
   *  cover letter would need BidHub's PDF-rendering backend to become uploadable, which is out of
   *  scope here (see the file header), so a string answer is simply left for the generic pipeline. */
  async function fillFileField(entry, answer, { shouldAbort = () => false } = {}) {
    if (!isFileAnswer(answer) || shouldAbort()) return;
    const wrapper = getLiveFormControl(entry.fieldId, entry.field) || entry.field;
    const input = getFileInputInsideField(wrapper);
    if (!input) throw new Error(`kula: file input for ${entry.fieldId} not found`);

    // Baseline BEFORE the fill: the wrapper's own label can contain the file's name ("Cover Letter"
    // vs a letter named "Cover Letter"), so the filename only counts as progress when it's NEW text.
    const baselineText = cleanText(wrapper.textContent);
    const baselineHadUploaded = UPLOADED_TEXT_PATTERN.test(baselineText);
    fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);

    let failure = null;
    const settled = await waitForWithAbort(
      () => {
        const liveWrapper = getLiveFormControl(entry.fieldId, wrapper) || wrapper;
        const text = cleanText(liveWrapper.textContent);
        const toast = Array.from(document.querySelectorAll('[role="alert"], [role="status"]'))
          .map((node) => cleanText(node.textContent))
          .find((message) => UPLOAD_FAILED_PATTERN.test(message));
        if (toast || UPLOAD_FAILED_PATTERN.test(text)) {
          failure = toast || text;
          return true;
        }
        if (/uploading/i.test(text)) return null;
        const fileNameShown = Boolean(answer.fileName) && text.includes(answer.fileName) && !baselineText.includes(answer.fileName);
        if (UPLOADED_TEXT_PATTERN.test(text) && (fileNameShown || !baselineHadUploaded)) return true;
        return null;
      },
      FILE_UPLOAD_COMPLETE_TIMEOUT_MS,
      shouldAbort,
      FILE_UPLOAD_COMPLETE_POLL_MS
    );
    if (shouldAbort()) return;
    if (failure) throw new Error(`kula: file upload rejected — ${failure.slice(0, 160)}`);
    if (!settled) throw new Error(`kula: file upload did not finish within ${FILE_UPLOAD_COMPLETE_TIMEOUT_MS / 1000}s`);
  }

  // ---- filling ------------------------------------------------------------------

  /**
   * Write an already-resolved answer into a question returned by detectFields(), dispatched by its
   * fieldKind. The caller owns deciding WHAT the answer is — this only owns getting it onto the page
   * using window.ProactiveAutofillEngine's primitives (plus Kula's own react-select/datepicker/phone
   * widgets, which the engine has no generic primitive for).
   *
   * @param {{field:Element, fieldId:string, fieldKind:string}} entry
   * @param {*} answer - string for text/textarea/numeric/phone/datepicker/react-select;
   *   string|string[] for react-select-multi; string|boolean for radio/checkbox;
   *   {type:"file", fileName, base64, mimeType} for file.
   */
  async function fillField(entry, answer, { shouldAbort = () => false } = {}) {
    if (!entry || answer == null || shouldAbort()) return;
    const liveField = getLiveFormControl(entry.fieldId, entry.field) || entry.field;

    switch (entry.fieldKind) {
      case "text": {
        const control = getTextControl(liveField);
        if (control) await fillTextInputLikeHuman(control, String(answer), { ...KULA_TYPING_OPTIONS, shouldAbort });
        return;
      }
      case "numeric": {
        // Numeric/currency inputs reject everything but digits and one dot.
        const digits = String(answer ?? "").replace(/[^\d.]/g, "").replace(/^(\d*\.\d*).*$/, "$1");
        const control = getTextControl(liveField);
        if (digits && control) await fillTextInputLikeHuman(control, digits, { ...KULA_TYPING_OPTIONS, shouldAbort });
        return;
      }
      case "textarea": {
        const control = getTextarea(liveField);
        if (control) await fillTextInputLikeHuman(control, String(answer), { ...KULA_TYPING_OPTIONS, shouldAbort });
        return;
      }
      case "phone":
        await fillPhone(liveField, answer, { shouldAbort });
        return;
      case "radio":
        await fillRadio(liveField, answer, { shouldAbort });
        return;
      case "checkbox":
        await fillCheckbox(liveField, answer, { shouldAbort });
        return;
      case "react-select":
        await fillReactSelect(liveField, answer, { shouldAbort });
        return;
      case "react-select-multi":
        await fillReactSelectMulti(liveField, answer, { shouldAbort });
        return;
      case "datepicker":
        await fillDatepicker(liveField, answer, { shouldAbort });
        return;
      case "file":
        await fillFileField({ ...entry, field: liveField }, answer, { shouldAbort });
        return;
      default:
        return;
    }
  }

  // ---- repeatable Education / Experience row sections ---------------------
  // Ported from BidHub's own Kula section descriptors (createKulaRowSection,
  // rowControlsFor/rowIndicesFor/findRowSectionContainer/findRowElement/
  // findRowControl/clickRowAdd/clearRowsIn) — every control's name/id follows
  // Formik's `${prefix}[${rowIndex}].${mappingKey}` convention, so a row's own
  // fields are found by that path first, falling back to matching the row's
  // visible label text (react-select widgets often carry a random id instead).
  // Driven by the shared engine/section-hierarchy.js, same root→group→leaf
  // model Greenhouse/Ashby use. detectFields() above already skips every
  // `profile.education[n].*`/`profile.experience[n].*` control so these rows
  // are never double-detected by the generic path.
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;
  const EDUCATION_ROW_PREFIX = "profile.education";
  const EXPERIENCE_ROW_PREFIX = "profile.experience";
  const EDUCATION_SECTION_PATTERN = /\beducation\b/i;
  const EXPERIENCE_SECTION_PATTERN = /\b(experience|work history|employment)\b/i;

  // Every control whose name/id starts with `${prefix}[` (all rows), or `${prefix}[${index}]`
  // (one row) — Formik paths carry brackets/dots, so this always goes through an attribute
  // selector, never a bare id lookup.
  function rowControlsFor(prefix, index = null) {
    const scope = cssAttrValue(index == null ? `${prefix}[` : `${prefix}[${index}]`);
    return Array.from(document.querySelectorAll(`${FORM_SELECTOR} [name^="${scope}"], ${FORM_SELECTOR} [id^="${scope}"]`));
  }
  // The distinct row indices actually present on the page right now (Formik re-renders this
  // block on add/remove, so this is always re-derived live, never cached).
  function rowIndicesFor(prefix) {
    const indices = new Set();
    for (const control of rowControlsFor(prefix)) {
      const match = (control.getAttribute("name") || control.id || "").match(/\[(\d+)\]/);
      if (match) indices.add(Number(match[1]));
    }
    return Array.from(indices).sort((a, b) => a - b);
  }
  function findRowAddButton(scope) {
    return Array.from(scope?.querySelectorAll?.("button") ?? []).find((button) => ROW_ADD_BUTTON_PATTERN.test(cleanText(button.textContent))) || null;
  }
  function findRowRemoveButtons(scope) {
    return Array.from(scope?.querySelectorAll?.("button") ?? []).filter((button) => ROW_REMOVE_BUTTON_PATTERN.test(cleanText(button.textContent)));
  }
  // The smallest ancestor of a row control (or of the section's own Add button) that both shows
  // the section heading AND holds an Add button — i.e. the whole repeatable block.
  function findRowSectionContainer(prefix, sectionPattern) {
    const form = getVisibleForm();
    if (!form) return null;
    const anchor =
      rowControlsFor(prefix)[0] ||
      Array.from(form.querySelectorAll("button")).find(
        (button) =>
          ROW_ADD_BUTTON_PATTERN.test(cleanText(button.textContent)) &&
          sectionPattern.test(cleanText(button.closest(".chakra-stack")?.textContent || button.parentElement?.textContent))
      );
    let node = anchor || null;
    while (node && node !== form) {
      const hasHeading = Array.from(node.querySelectorAll("p, h1, h2, h3, h4, label")).some((heading) => {
        const text = cleanText(heading.textContent);
        return text.length <= 40 && sectionPattern.test(text);
      });
      if (hasHeading && findRowAddButton(node)) return node;
      node = node.parentElement;
    }
    return null;
  }
  // The row element = the widest ancestor of the row's own controls that holds no OTHER row's
  // control and not the block's Add button.
  function findRowElement(prefix, index, container) {
    const controls = rowControlsFor(prefix, index);
    if (!controls.length) return null;
    const others = rowControlsFor(prefix).filter((control) => !controls.includes(control));
    const addButton = findRowAddButton(container);
    let node = controls[0].closest(FORM_CONTROL_SELECTOR) || controls[0];
    while (node.parentElement && node.parentElement !== container) {
      const parent = node.parentElement;
      if (others.some((control) => parent.contains(control))) break;
      if (addButton && parent.contains(addButton)) break;
      if (parent.matches(FORM_SELECTOR)) break;
      node = parent;
    }
    return node;
  }
  // Derives a row's own hierarchy index from one of its controls' Formik path — the shared
  // engine never passes the row index into getRowField, so it has to be read back off the row
  // element itself.
  function getKulaRowIndex(rowEl, prefix) {
    const scope = cssAttrValue(`${prefix}[`);
    const control = rowEl?.querySelector(`[name^="${scope}"], [id^="${scope}"]`);
    const match = (control?.getAttribute("name") || control?.id || "").match(/\[(\d+)\]/);
    return match ? Number(match[1]) : null;
  }
  // Row control by Formik path first, by the row's own visible label text second (react-select
  // inputs carry a random id, not the path).
  function findRowControl(rowEl, prefix, index, mapping) {
    const path = `${prefix}[${index}].${mapping.key}`;
    const escaped = cssAttrValue(path);
    const byPath = rowEl?.querySelector(`[name="${escaped}"], [id="${escaped}"]`);
    if (byPath) return byPath.closest(FORM_CONTROL_SELECTOR) || byPath;
    const question = mapping.question || mapping.label;
    const wrapper = Array.from(rowEl?.querySelectorAll?.(FORM_CONTROL_SELECTOR) ?? []).find(
      (formControl) => cleanText(getLabelText(formControl)).toLowerCase() === cleanText(question).toLowerCase()
    );
    return wrapper || null;
  }
  async function clickRowAdd(container, { shouldAbort = () => false } = {}) {
    const addButton = findRowAddButton(container);
    if (!addButton || shouldAbort()) return;
    await clickLikeHuman(addButton, { shouldAbort });
  }
  // Delete every row, end-first (the last row's own Remove button); bounded, and bails once a
  // delete stops making progress.
  async function clearRowsIn(prefix, container, { shouldAbort = () => false } = {}) {
    let count = rowIndicesFor(prefix).length;
    let guard = count + 4;
    while (count > 0 && guard > 0) {
      if (shouldAbort()) return;
      const removeButton = findRowRemoveButtons(container).pop();
      if (!removeButton?.isConnected) return;
      const before = count;
      await clickLikeHuman(removeButton, { shouldAbort });
      await waitForWithAbort(() => (rowIndicesFor(prefix).length < before ? true : null), ROW_APPEAR_TIMEOUT_MS, shouldAbort, REACT_SELECT_POLL_MS);
      count = rowIndicesFor(prefix).length;
      if (count >= before) return; // no progress
      guard -= 1;
    }
  }

  function createKulaRowSection({ rootFieldId, rootQuestion, profileSection, prefix, sectionPattern, rowLabel, mappings }) {
    const section = {
      rootFieldId,
      rootQuestion,
      profileSection,
      rowLabel,
      rowGrowthTimeoutMs: ROW_APPEAR_TIMEOUT_MS,
      // LIVE lookups throughout — Formik re-renders this block on every add/remove and select commit.
      getContainer: () => findRowSectionContainer(prefix, sectionPattern),
      getRows: (container) =>
        rowIndicesFor(prefix)
          .map((index) => findRowElement(prefix, index, container || section.getContainer()))
          .filter(Boolean),
      getRowField: (rowEl, mapping) => {
        const rowIndex = getKulaRowIndex(rowEl, prefix);
        if (rowIndex == null) return null;
        const control = findRowControl(rowEl, prefix, rowIndex, mapping);
        return control ? { field: control } : null;
      },
      addRow: (container) => clickRowAdd(container || section.getContainer()),
      clearRows: (container) => clearRowsIn(prefix, container || section.getContainer()),
      mappings,
    };
    return section;
  }

  const KULA_EDUCATION_SECTION = createKulaRowSection({
    rootFieldId: "educationHistory",
    rootQuestion: "Education",
    profileSection: "education",
    prefix: EDUCATION_ROW_PREFIX,
    sectionPattern: EDUCATION_SECTION_PATTERN,
    rowLabel: (rowIndex) => `Education ${rowIndex + 1}`,
    mappings: [
      { key: "degree", question: "Degree", label: "Degree", fieldKind: "dropdown", profileKey: "degree" },
      // No `discipline`/field-of-study on BCD's Profile.education schema
      // (school/degree/start/end only) — still detected (shows in the
      // review list), it just has nothing to auto-fill from.
      { key: "discipline", question: "Discipline", label: "Discipline", fieldKind: "dropdown" },
      { key: "start_date", question: "Start Date", label: "Start Date", fieldKind: "date", profileKey: "start" },
      { key: "end_date", question: "End Date", label: "End Date", fieldKind: "date", profileKey: "end" },
      // No BCD equivalent — detected only.
      { key: "summary", question: "Summary", label: "Summary", fieldKind: "textarea" },
      // Kept LAST — Kula's real Institution widget is an async creatable
      // react-select lookup, slower than this row's other, synchronous fields.
      { key: "institution", question: "Institution", label: "Institution", fieldKind: "dropdown", resolveValue: (entry) => entry?.school },
    ],
  });

  const KULA_EXPERIENCE_SECTION = createKulaRowSection({
    rootFieldId: "workHistory",
    rootQuestion: "Experience",
    profileSection: "experience",
    prefix: EXPERIENCE_ROW_PREFIX,
    sectionPattern: EXPERIENCE_SECTION_PATTERN,
    rowLabel: (rowIndex) => `Experience ${rowIndex + 1}`,
    mappings: [
      { key: "title", question: "Title", label: "Title", fieldKind: "text", profileKey: "role" },
      // No BCD equivalent — detected only.
      { key: "industry", question: "Industry", label: "Industry", fieldKind: "dropdown" },
      { key: "start_date", question: "Start Date", label: "Start Date", fieldKind: "date", profileKey: "start" },
      { key: "end_date", question: "End Date", label: "End Date", fieldKind: "date", profileKey: "end" },
      // No BCD equivalent — detected only.
      { key: "summary", question: "Summary", label: "Summary", fieldKind: "textarea" },
      { key: "location", question: "Location", label: "Location", fieldKind: "dropdown", profileKey: "location" },
      { key: "company", question: "Company", label: "Company", fieldKind: "dropdown", profileKey: "company" },
    ],
  });

  const KULA_SECTIONS = [KULA_EDUCATION_SECTION, KULA_EXPERIENCE_SECTION];

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections(KULA_SECTIONS, profileData);
  }

  // Reuses this file's own generic per-field-kind fillers (fillReactSelect/fillDatepicker/
  // getTextControl+fillTextInputLikeHuman/getTextarea+fillTextInputLikeHuman) — a row's own field
  // is always the same widget shape as its top-level counterpart, just resolved by Formik path.
  async function fillSectionLeaf(field, mapping, value) {
    switch (mapping.fieldKind) {
      case "text": {
        const control = getTextControl(field);
        if (control) await fillTextInputLikeHuman(control, String(value), KULA_TYPING_OPTIONS);
        return;
      }
      case "textarea": {
        const control = getTextarea(field);
        if (control) await fillTextInputLikeHuman(control, String(value), KULA_TYPING_OPTIONS);
        return;
      }
      case "date":
        await fillDatepicker(field, value);
        return;
      case "dropdown":
        await fillReactSelect(field, value);
        return;
      default:
        return;
    }
  }

  async function fillSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    const results = [];
    for (const section of KULA_SECTIONS) {
      const entries = (profileData && profileData[section.profileSection]) || [];
      if (!entries.length) continue;
      const result = await SECTION_HIERARCHY.fillSection(section, entries, fillSectionLeaf);
      results.push({ rootFieldId: section.rootFieldId, ...result });
    }
    return results;
  }

  NS.kula = {
    isAutofillAvailable,
    advance,
    detectFields,
    fillField,
    fetchSelectOptions,
    getSubmitButton,
    isSubmitButtonDisabled,
    clickSubmitButton,
    detectSections,
    fillSections,
  };
})();
