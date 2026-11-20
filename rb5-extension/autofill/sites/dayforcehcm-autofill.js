/* =====================================================================
 * autofill/sites/dayforcehcm-autofill.js — Dayforce HCM candidate portal
 * (jobs.dayforcehcm.com), a React + Ant Design application.
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/dayforcehcm/autofill.js, plus
 * the handful of shared helpers it leans on from
 * platforms/dom-interactions.js, platforms/date-utils.js and
 * platforms/autofill-shared.js that aren't already covered by this
 * codebase's own autofill/engine/dom-interactions.js (Ant Design's
 * portal-rendered dropdown needs its own open/read/close mechanics —
 * this file's equivalent of bamboohr-autofill.js's
 * getFabricSelectButton/openSelectMenu/clickSelectOption trio).
 *
 * Flow: posting (/jobs/<id>) → "Apply" → flow-selection
 * (?flowSelection=true) → "Apply without an Account" (guest) →
 * single-URL multi-tab application form (/apply/manualApplication):
 * Candidate Info → Questionnaire(s) → Submit. Every real form control
 * on the application form carries a stable id prefixed
 * `jobPostingApplication_`.
 *
 * OUT OF SCOPE (left to Big Banana's own existing systems, or dropped
 * entirely — see the porting brief):
 *   - Free-text screening-question ANSWER GENERATION and the embedding-
 *     similarity fallback BidHub's own AI backend uses when a searchable
 *     Ant Design select (country/state, the phone dial-code list) has no
 *     exact-or-substring match. detectFields() below only CLASSIFIES a
 *     question's structural type and locates its control; fillField()
 *     only WRITES an answer the caller already resolved, matching it
 *     against the live option list with the same exact-then-substring
 *     rule every other site file here uses. A field this can't place
 *     deterministically is left for Big Banana's existing generic/AI
 *     pipeline to pick up.
 *   - "Create/confirm a password" account-credential fields
 *     (shared/password-answer.js upstream). Dayforce's guest-apply flow
 *     doesn't create an account, so this never actually comes up here,
 *     but on the chance a tenant customization adds one: this file never
 *     synthesizes or writes a value into it itself.
 *   - The dependent-question reordering (shared/dependent-question.js)
 *     that only mattered for sequencing BidHub's own AI answers around a
 *     "please explain" follow-up — Big Banana's pipeline owns answer
 *     ordering on its own.
 *   - Repeatable "Add row" work-history/education-history entries beyond
 *     the FIRST, always-rendered row. BidHub's own source drives these
 *     through a whole shared multi-row profile-section-hierarchy module
 *     (clear every existing row, then click "Add" once per profile
 *     entry, re-resolving each record's fields live by DOM id since
 *     Dayforce reassigns non-contiguous record indices after a delete).
 *     None of that is ported. The first row's own fields (job title,
 *     company, dates, location, the "I currently work here" checkbox,
 *     …) are ordinary stable controls once nothing is adding/removing
 *     rows out from under them, so they're detected and filled exactly
 *     like any other labelled field below — see
 *     isWithinAutofilledHistoryRow().
 *   - CAPTCHA / proxy-"real input" lanes. Dayforce's guest-apply flow
 *     doesn't appear to gate behind either; nothing here does anything
 *     special for them.
 * ===================================================================== */
(function () {
  "use strict";

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    sleep,
    fillTextInput,
    fillTextInputReliably,
    fillTextInputWithoutBlur,
    fillFileInput,
    clickLikeHuman,
    getTextInput,
    getTextarea,
    getFileInputInsideField,
    getNativeSelect,
  } = engine;

  const NEVER_ABORT = () => false;
  const FIELD_ID_PREFIX = "jobPostingApplication_";
  const RESUME_FILE_ID = `${FIELD_ID_PREFIX}files_resume`;
  const COVER_LETTER_FILE_ID = `${FIELD_ID_PREFIX}files_coverLetter`;
  const WORK_RECORD_SELECTOR = 'form[test-id="workhistory-record"]';
  const EDUCATION_RECORD_SELECTOR = 'form[test-id="educationhistory-record"]';
  const FINAL_SUBMIT_SELECTOR = '[test-id="application-submit"]';
  const NEXT_STEP_SELECTOR = '[test-id="application-next-step"]';
  const APPLY_BUTTON_SELECTOR = '[test-id="apply-button"]';
  const GUEST_APPLY_SELECTOR = '[test-id="apply-without-account"]';

  // Long, searchable antd selects resolved by typing to filter + exact/substring match
  // against the (small, filtered) resulting list, instead of enumerating every option the
  // way a short closed select's options can just be read outright.
  const SEARCH_SELECT_SUFFIXES = ["countryCode", "stateCode"];
  const PHONE_FIELD_SUFFIX_PATTERN = /(?:^|_)(?:mobilePhone|homePhone|workPhone)$/;
  const DATE_FIELD_SUFFIX_PATTERN = /(?:^|_)(?:effectiveStart|effectiveEnd)$/;
  const PHONE_DIAL_COUNTRY = "United States of America";
  const YES_NO_OPTIONS = ["Yes", "No"];
  const NEGATIVE_ANSWERS = new Set(["no", "false", "n", "off", "unchecked", "decline", "disagree", "none", "0"]);

  const DROPDOWN_WAIT_TIMEOUT_MS = 5000;
  const ANTD_DROPDOWN_CLOSE_TIMEOUT_MS = 2000;
  const RECORD_SELECT_ENABLE_TIMEOUT_MS = 4000;
  const RESUME_PARSE_KICKOFF_MS = 1000;
  const RESUME_PARSE_TIMEOUT_MS = 30000;
  const FILE_UPLOAD_COMPLETE_TIMEOUT_MS = 60000;

  function normalizeText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  // Generic poll-until helper (BidHub's own waitForPositiveResultWithAbort) — not part of
  // this codebase's shared engine, so every site file that needs it (this one, bamboohr's
  // waitFor) keeps its own small local copy.
  async function waitFor(check, timeoutMs, { shouldAbort = NEVER_ABORT, pollMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (shouldAbort()) return null;
      const result = check();
      if (result) return result;
      await sleep(pollMs);
    }
    return null;
  }

  // A plain mousedown+mouseup at the element's center — what Ant Design's own React
  // handlers listen for to open/select, as distinct from a full human-cadence
  // clickLikeHuman() sequence (used below for ordinary buttons/checkboxes instead).
  function triggerMouseEvent(node, eventType) {
    if (!node?.dispatchEvent) return;
    const rect = node.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 };
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    const isPrimaryPress = eventType === "mousedown" || eventType === "mouseup" || eventType === "click";
    node.dispatchEvent(
      new MouseEvent(eventType, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        detail: eventType === "click" ? 1 : 0,
        button: isPrimaryPress ? 0 : -1,
        buttons: eventType === "mousedown" ? 1 : 0,
        clientX,
        clientY,
      })
    );
  }

  // ---- page/flow helpers --------------------------------------------------

  function getFinalSubmitButton() {
    return document.querySelector(FINAL_SUBMIT_SELECTOR);
  }
  // #application-form-shaped gate, Dayforce's way: the form only exists once either its
  // own Next or the final Submit is on the page.
  function isApplicationForm() {
    return Boolean(document.querySelector(`${NEXT_STEP_SELECTOR}, ${FINAL_SUBMIT_SELECTOR}`));
  }
  function getGuestApplyButton() {
    const guest = document.querySelector(GUEST_APPLY_SELECTOR);
    return guest && !guest.disabled ? guest : null;
  }
  // From a posting / flow-selection URL, derive the guest manual-application URL
  // (".../jobs/<id>/apply/manualApplication?applicationSource=Manual"). Direct navigation
  // there renders the guest form on guest-enabled portals.
  function getManualApplicationUrl() {
    const match = window.location.href.match(/^(.*\/jobs\/[^/?#]+)/);
    return match ? `${match[1]}/apply/manualApplication?applicationSource=Manual` : null;
  }
  // The forward-navigation control for the current page (posting Apply, guest "Apply
  // without an Account", or the wizard's own Next) — never the final Submit.
  function getAdvanceButton() {
    if (getFinalSubmitButton()) return null;
    const apply = document.querySelector(APPLY_BUTTON_SELECTOR);
    if (apply && !apply.disabled) return apply;
    const guest = getGuestApplyButton();
    if (guest) return guest;
    const next = document.querySelector(NEXT_STEP_SELECTOR);
    if (next && !next.disabled && next.getAttribute("aria-disabled") !== "true") return next;
    return null;
  }

  // Dayforce renders posting → flow-selection → form as same-document React transitions —
  // a plain click on the guest button would keep this page's own content-script context
  // (and whatever's mid-autofill-run in it) alive straight through the navigation. Forcing
  // a real page load here instead ends this run cleanly at the step boundary, and the
  // freshly-loaded form page starts its own autofill pass against it. (Guest-only:
  // login-only portals expose no guest button, so this just reports nothing to click rather
  // than navigate into a login wall.)
  async function advance({ shouldAbort = NEVER_ABORT } = {}) {
    if (getFinalSubmitButton() || shouldAbort()) return false;
    const guest = getGuestApplyButton();
    if (guest) {
      const manualUrl = getManualApplicationUrl();
      if (manualUrl) {
        window.location.assign(manualUrl);
        return true;
      }
    }
    const advanceButton = getAdvanceButton();
    if (!advanceButton) return false;
    await clickLikeHuman(advanceButton, { shouldAbort });
    return true;
  }

  function isAutofillAvailable() {
    return Boolean(detectFields().length || getAdvanceButton());
  }
  function getSubmitButton() {
    return getFinalSubmitButton();
  }

  // ---- Ant Design select interaction ---------------------------------------
  // Dayforce's own custom dropdowns, same open-menu/read-options/click-option shape as
  // bamboohr-autofill.js's Fabric select helpers — just antd's own markup underneath.

  function getAntdSelect(control) {
    if (!control) return null;
    return control.closest(".ant-select") || (control.classList?.contains("ant-select") ? control : null);
  }
  function isAntdSelectControl(control) {
    return (
      Boolean(control?.classList?.contains("ant-select-selection-search-input")) ||
      control?.getAttribute?.("role") === "combobox"
    );
  }
  function getComboboxInput(antdSelect) {
    return antdSelect.querySelector('input[role="combobox"], input.ant-select-selection-search-input');
  }
  // THIS select's own dropdown, resolved via its combobox input's aria-owns/aria-controls
  // id — never "whatever dropdown happens to be open". antd keeps a just-closed dropdown in
  // the DOM (sans the hidden class) for one animation frame, and a field filled right after
  // its predecessor would otherwise grab the WRONG one through a "any visible menu"
  // fallback.
  function getOwnAntdDropdownElement(antdSelect) {
    const input = getComboboxInput(antdSelect);
    const listId = input?.getAttribute("aria-owns") || input?.getAttribute("aria-controls");
    return listId ? document.getElementById(listId)?.closest(".ant-select-dropdown") || null : null;
  }
  function getOpenAntdDropdown(antdSelect) {
    const dropdown = getOwnAntdDropdownElement(antdSelect);
    return dropdown && !dropdown.classList.contains("ant-select-dropdown-hidden") ? dropdown : null;
  }
  function readAntdOptionElements(dropdown) {
    return Array.from(dropdown.querySelectorAll(".ant-select-item-option"))
      .filter((option) => !option.classList.contains("ant-select-item-option-disabled"))
      .map((option) => ({
        el: option,
        text: normalizeText(
          option.getAttribute("title") || option.querySelector(".ant-select-item-option-content")?.textContent || option.textContent
        ),
      }))
      .filter((option) => option.text);
  }
  async function openAntdSelect(antdSelect, shouldAbort = NEVER_ABORT) {
    const selector = antdSelect.querySelector(".ant-select-selector") || antdSelect;
    triggerMouseEvent(selector, "mousedown");
    triggerMouseEvent(selector, "mouseup");
    antdSelect.querySelector("input")?.focus();
    return waitFor(
      () => {
        const dropdown = getOpenAntdDropdown(antdSelect);
        const options = dropdown ? readAntdOptionElements(dropdown) : [];
        return options.length ? dropdown : null;
      },
      DROPDOWN_WAIT_TIMEOUT_MS,
      { shouldAbort, pollMs: 60 }
    );
  }
  // Resolves once THIS select's dropdown is fully closed (select drops `ant-select-open`
  // and its dropdown gains `ant-select-dropdown-hidden`) — see the "own dropdown" note
  // above for why the next field's open() would otherwise race it.
  async function waitForAntdDropdownClosed(antdSelect, shouldAbort = NEVER_ABORT) {
    await waitFor(
      () => {
        if (antdSelect.classList.contains("ant-select-open")) return null;
        const dropdown = getOwnAntdDropdownElement(antdSelect);
        if (dropdown && !dropdown.classList.contains("ant-select-dropdown-hidden")) return null;
        return true;
      },
      ANTD_DROPDOWN_CLOSE_TIMEOUT_MS,
      { shouldAbort, pollMs: 60 }
    );
  }
  async function closeAntdSelect(antdSelect, shouldAbort = NEVER_ABORT) {
    antdSelect
      .querySelector("input")
      ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    triggerMouseEvent(document.body, "mousedown");
    await waitForAntdDropdownClosed(antdSelect, shouldAbort);
  }
  function findAntdOptionMatch(options, wanted) {
    const lower = wanted.toLowerCase();
    return (
      options.find((o) => o.text.toLowerCase() === lower) ||
      options.find((o) => o.text.toLowerCase().includes(lower)) ||
      options.find((o) => lower.includes(o.text.toLowerCase())) ||
      null
    );
  }
  // A short, already-fully-rendered antd select: open → exact-then-substring match → click.
  async function selectAntdOptionByText(antdSelect, answer, shouldAbort = NEVER_ABORT) {
    const wanted = String(answer ?? "").trim();
    if (!wanted) return false;
    const dropdown = await openAntdSelect(antdSelect, shouldAbort);
    if (!dropdown || shouldAbort()) return false;
    const match = findAntdOptionMatch(readAntdOptionElements(dropdown), wanted);
    if (!match) {
      await closeAntdSelect(antdSelect, shouldAbort);
      return false;
    }
    triggerMouseEvent(match.el, "click");
    match.el.click();
    await waitForAntdDropdownClosed(antdSelect, shouldAbort);
    return true;
  }
  // A long searchable antd select (country/state, the phone dial-code list): type to
  // filter, then exact-then-substring match against the (now short) filtered list. BidHub's
  // own backend falls back to an embedding-similarity match here for anything looser than
  // that (e.g. disambiguating "United States" from "United States Minor Outlying Islands"
  // just because it sorts first) — that's the out-of-scope AI boundary, so a miss here
  // simply reports false and leaves the field for Big Banana's existing pipeline.
  async function selectAntdOptionBySearch(antdSelect, answer, shouldAbort = NEVER_ABORT) {
    const wanted = String(answer ?? "").trim();
    if (!wanted) return false;
    const dropdown = await openAntdSelect(antdSelect, shouldAbort);
    if (!dropdown || shouldAbort()) return false;
    const input = antdSelect.querySelector("input");
    if (input) fillTextInputWithoutBlur(input, wanted.slice(0, 30));
    const filtered = await waitFor(
      () => {
        const open = getOpenAntdDropdown(antdSelect);
        const options = open ? readAntdOptionElements(open) : [];
        return options.length ? open : null;
      },
      DROPDOWN_WAIT_TIMEOUT_MS,
      { shouldAbort, pollMs: 60 }
    );
    if (!filtered || shouldAbort()) return false;
    const match = findAntdOptionMatch(readAntdOptionElements(filtered), wanted);
    if (!match) {
      await closeAntdSelect(antdSelect, shouldAbort);
      return false;
    }
    triggerMouseEvent(match.el, "click");
    match.el.click();
    await waitForAntdDropdownClosed(antdSelect, shouldAbort);
    return true;
  }
  // A record's own location select (stateCode) stays `ant-select-disabled` until its
  // sibling countryCode is picked — wait for it rather than silently no-op filling a
  // disabled control. Re-resolves the live control by id each poll since Dayforce can
  // re-render the record around it (see liveControl below).
  async function waitUntilAntdSelectEnabled(fieldId, fallbackControl, timeoutMs, shouldAbort) {
    return waitFor(
      () => {
        const live = liveControl(fieldId, fallbackControl);
        if (!live || live.disabled) return null;
        const antdSelect = getAntdSelect(live);
        if (!antdSelect || antdSelect.classList.contains("ant-select-disabled")) return null;
        return antdSelect;
      },
      timeoutMs,
      { shouldAbort, pollMs: 100 }
    );
  }
  /** The option list a (short, already-rendered) antd select currently offers — opens,
   *  reads, closes. For a caller that needs to know the choices before picking one. */
  async function fetchSelectOptions(entry, shouldAbort = NEVER_ABORT) {
    const antdSelect = liveAntdSelect(entry?.fieldId, entry?.field);
    if (!antdSelect) return null;
    const dropdown = await openAntdSelect(antdSelect, shouldAbort);
    if (!dropdown) return null;
    const options = readAntdOptionElements(dropdown).map((o) => o.text);
    await closeAntdSelect(antdSelect, shouldAbort);
    return options;
  }

  // ---- loose date parsing (for the record "Start/End date" fields, which take a typed
  // yyyy-mm-dd rather than a native <input type="date">) ---------------------------------

  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  function parseLooseDate(value) {
    const text = String(value ?? "").trim();
    if (!text) return { month: null, day: null, year: null };
    const pad = (part) => (part ? String(part).padStart(2, "0") : null);
    const iso = text.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:T.*)?$/);
    if (iso) return { month: pad(iso[2]), day: pad(iso[3]), year: iso[1] };
    const numeric = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (numeric) {
      const year = numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3];
      return { month: numeric[1].padStart(2, "0"), day: numeric[2].padStart(2, "0"), year };
    }
    const monthYear = text.match(/^(\d{1,2})[/-](\d{4})$/);
    if (monthYear) return { month: monthYear[1].padStart(2, "0"), day: null, year: monthYear[2] };
    const named = text.match(/^([A-Za-z]+)\s+(?:(\d{1,2}),?\s+)?(\d{4})$/);
    if (named) {
      const monthIndex = MONTH_NAMES.findIndex((m) => m.toLowerCase().startsWith(named[1].toLowerCase()));
      return { month: monthIndex >= 0 ? String(monthIndex + 1).padStart(2, "0") : null, day: pad(named[2]), year: named[3] };
    }
    if (/^\d{4}$/.test(text)) return { month: null, day: null, year: text };
    return { month: null, day: null, year: null };
  }
  function toIsoDateString(value) {
    const { year, month, day } = parseLooseDate(value);
    if (!year) return null;
    return `${year}-${month || "01"}-${day || "01"}`;
  }

  // ---- phone (dial-code select + national digits) -------------------------

  // A phone field is an antd dial-code select (a long searchable list, e.g. "+1 United
  // States of America") sitting left of the digits input in an ant-space-compact group. The
  // answer carries no country, so default the dial code to the US when it's still empty —
  // the common case — then fill the national digits (dropping a leading country "1" when
  // the answer came through as 11 digits).
  async function fillPhoneField(textInput, answer, shouldAbort = NEVER_ABORT) {
    const group = textInput.closest(".ant-space-compact") || textInput.parentElement?.parentElement;
    const dialSelect = group?.querySelector(".ant-select");
    if (dialSelect) {
      const dialValue = dialSelect.querySelector(".ant-select-selection-item");
      if (!dialValue || !/\+\d/.test(dialValue.textContent || "")) {
        await selectAntdOptionBySearch(dialSelect, PHONE_DIAL_COUNTRY, shouldAbort).catch(() => false);
      }
    }
    let digits = String(answer ?? "").replace(/[^\d]/g, "");
    if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
    if (digits) fillTextInput(textInput, digits);
  }

  // ---- resume parsing + file-upload settling --------------------------------

  // Parsing is in flight while the resume upload-list item spins or the Import Resume
  // button shows its loading state. Every OTHER field fills only after this settles (by
  // filling resume first and awaiting it — see fillField's 'resume' case), so autofill never
  // races Dayforce's own parse-driven prefill of name/work-history/education.
  function isResumeParsing() {
    if (document.querySelector(".ant-upload-list-item-uploading")) return true;
    const importButton = document.querySelector('[test-id="import-resume-section-button"], [test-id="resume-upload-button"]');
    return Boolean(importButton?.classList.contains("ant-btn-loading"));
  }
  async function waitForResumeParseComplete(shouldAbort = NEVER_ABORT) {
    await sleep(RESUME_PARSE_KICKOFF_MS);
    if (shouldAbort()) return;
    await waitFor(() => (isResumeParsing() ? null : true), RESUME_PARSE_TIMEOUT_MS, { shouldAbort, pollMs: 250 });
  }
  // Dayforce shows the uploaded file name / a "remove" control once the upload round-trips.
  async function waitForUploadSettled(fileInput, shouldAbort = NEVER_ABORT) {
    await waitFor(
      () => {
        const chip = fileInput.closest("[test-id]")?.parentElement?.querySelector('[test-id*="remove"], [aria-label*="emove"]');
        return chip || (fileInput.files && fileInput.files.length === 0) ? true : null;
      },
      FILE_UPLOAD_COMPLETE_TIMEOUT_MS,
      { shouldAbort, pollMs: 150 }
    );
  }

  // ---- label / question-text resolution ------------------------------------

  // The visible label of an antd checkbox/radio option (its wrapping <label>'s text).
  function getChoiceInputLabel(input) {
    return normalizeText(input.closest("label")?.textContent);
  }
  const HEADING_SELECTOR = 'h1,h2,h3,h4,h5,legend,label,strong,[class*="title"],[class*="Title"]';
  // Best-effort question text for a choice GROUP (the disability self-identification survey
  // and similar): a matching label[for], else the nearest preceding heading/label in
  // document order (the group's option inputs carry no label[for] of their own).
  function getChoiceGroupQuestion(group) {
    if (group.id) {
      const linked = document.querySelector(`label[for="${CSS.escape(group.id)}"]`);
      const text = normalizeText(linked?.textContent);
      if (text) return text;
    }
    const scope = group.closest("form") || document.body;
    let best = null;
    for (const el of scope.querySelectorAll(HEADING_SELECTOR)) {
      if (group.contains(el)) continue;
      if (!(group.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING)) continue;
      const text = normalizeText(el.textContent);
      if (text && text.length >= 4 && text.length <= 200) best = text; // last preceding wins
    }
    return best;
  }
  function isControlRequired(control, label) {
    if (control?.getAttribute?.("aria-required") === "true" || control?.required) return true;
    return Boolean(label?.classList?.contains("ant-form-item-required"));
  }

  // ---- work/education history gating ------------------------------------

  // Used to let the first, always-rendered work-history/education-history row
  // through as plain flat fields (BidHub's own multi-row "Add row" machinery
  // was unported at the time). The dedicated section-hierarchy port below
  // (DAYFORCE_WORK_HISTORY_SECTION/DAYFORCE_EDUCATION_SECTION) now owns EVERY
  // row, including the first — so this excludes every history-record control
  // unconditionally instead, same as every other repeatable-section site,
  // rather than letting row 0 render twice (once here, once as the real
  // grouped section card).
  function isWithinAutofilledHistoryRow(control) {
    if (control.closest(WORK_RECORD_SELECTOR)) return false;
    if (control.closest(EDUCATION_RECORD_SELECTOR)) return false;
    return true; // not inside a history record at all
  }

  // ---- field-kind classification -------------------------------------------

  function fieldIdSuffix(fieldId) {
    const parts = String(fieldId || "").split("_");
    return parts[parts.length - 1];
  }
  function classifyControl(control, fieldId) {
    const suffix = fieldIdSuffix(fieldId);
    const type = (control.getAttribute("type") || control.type || "").toLowerCase();
    if (isAntdSelectControl(control)) {
      return SEARCH_SELECT_SUFFIXES.includes(suffix)
        ? { fieldKind: "antd-select-search", options: null }
        : { fieldKind: "antd-select", options: null };
    }
    if (control.tagName === "SELECT") {
      const options = Array.from(control.options)
        .filter((o) => o.value)
        .map((o) => normalizeText(o.innerText || o.textContent));
      return { fieldKind: "select-native", options };
    }
    if (control.tagName === "TEXTAREA") return { fieldKind: "textarea", options: [] };
    if (type === "checkbox") return { fieldKind: "checkbox-single", options: YES_NO_OPTIONS };
    if (type === "date" || DATE_FIELD_SUFFIX_PATTERN.test(fieldId)) return { fieldKind: "date", options: [] };
    if (PHONE_FIELD_SUFFIX_PATTERN.test(fieldId)) return { fieldKind: "phone", options: [] };
    return { fieldKind: "text", options: [] };
  }

  // ---- detection ------------------------------------------------------------

  /**
   * Walk Dayforce's application form and return every question this adapter knows how to
   * fill deterministically. Anything it can't place is left out entirely, which is how a
   * field is "left alone" for Big Banana's own generic/AI pipeline to pick up.
   *
   * @returns {Array<{question:string, fieldId:string, field:Element, control:Element,
   *   fieldKind:string, options:string[]|null, required:boolean}>}
   */
  function detectFields() {
    if (!isApplicationForm()) return [];
    const questions = [];
    const seen = new Set();

    // 1. Resume + cover-letter uploads (hidden file inputs, no label[for]).
    const resumeInput = document.getElementById(RESUME_FILE_ID);
    if (resumeInput) {
      questions.push({
        question: "Resume/CV", fieldId: "resume", fieldKind: "resume",
        field: resumeInput, control: resumeInput, options: null, required: false,
      });
      seen.add("resume");
    }
    const coverLetterInput = document.getElementById(COVER_LETTER_FILE_ID);
    if (coverLetterInput) {
      questions.push({
        question: "Cover Letter", fieldId: "cover_letter", fieldKind: "cover_letter",
        field: coverLetterInput, control: coverLetterInput, options: null, required: false,
      });
      seen.add("cover_letter");
    }

    // 2. Every labelled scalar control under the application form. The
    //    `jobPostingApplication_` prefix scopes this to the real form and excludes
    //    cookie/nav chrome; isWithinAutofilledHistoryRow keeps a work/education record's
    //    OWN fields in play only for that section's first, always-rendered row.
    for (const label of document.querySelectorAll(`label[for^="${FIELD_ID_PREFIX}"]`)) {
      const fieldId = label.getAttribute("for");
      if (!fieldId || seen.has(fieldId)) continue;
      if (fieldId === RESUME_FILE_ID || fieldId === COVER_LETTER_FILE_ID) continue;
      const control = document.getElementById(fieldId);
      if (!control || control.type === "hidden") continue;
      if (!isWithinAutofilledHistoryRow(control)) continue;
      // A choice-group container (the disability self-id status, etc.) carries the
      // questionnaire id on the wrapper div, not an input — handled by the dedicated scan
      // below.
      if (control.classList?.contains("ant-checkbox-group") || control.classList?.contains("ant-radio-group")) continue;
      // Never autofill a disabled control (e.g. the disability form's pre-computed
      // Name/Date/Employee ID) — EXCEPT a conditionally-disabled location select
      // (stateCode until its record's country is picked), which the fill handler itself
      // waits to become enabled.
      const suffix = fieldIdSuffix(fieldId);
      if (control.disabled && !SEARCH_SELECT_SUFFIXES.includes(suffix)) continue;
      const question = normalizeText(label.getAttribute("title") || label.textContent);
      if (!question) continue;
      seen.add(fieldId);
      const { fieldKind, options } = classifyControl(control, fieldId);
      const field = isAntdSelectControl(control) ? getAntdSelect(control) || control : control;
      questions.push({ question, fieldId, field, control, fieldKind, options, required: isControlRequired(control, label) });
    }

    // 3. Choice-group questionnaire questions (e.g. the disability self-id status). The
    //    questionnaire id lives on the `.ant-checkbox-group`/`.ant-radio-group` wrapper; the
    //    option inputs themselves have no id or label[for], so the scan above can't see them.
    for (const group of document.querySelectorAll(
      `.ant-checkbox-group[id^="${FIELD_ID_PREFIX}"], .ant-radio-group[id^="${FIELD_ID_PREFIX}"]`
    )) {
      const fieldId = group.id;
      if (!fieldId || seen.has(fieldId) || group.offsetParent === null) continue;
      const isRadio = group.classList.contains("ant-radio-group");
      const inputs = Array.from(
        group.querySelectorAll(isRadio ? 'input[type="radio"]' : 'input.ant-checkbox-input, input[type="checkbox"]')
      );
      if (!inputs.length || inputs.every((i) => i.disabled)) continue;
      const options = inputs.map(getChoiceInputLabel).filter(Boolean);
      if (!options.length) continue;
      const question = getChoiceGroupQuestion(group) || group.getAttribute("test-id") || fieldId;
      seen.add(fieldId);
      questions.push({
        question, fieldId, field: group, control: group,
        fieldKind: isRadio ? "radio-group" : "checkbox-group", options,
        required: group.querySelector("[aria-required='true']") != null,
      });
    }

    // 4. Lone consent/acknowledgement checkboxes (e.g. the Submit page's
    //    `jobPostingApplication_userAcknowledged`). These carry a prefixed id but no
    //    label[for] (the prompt is in the wrapping <label>) and aren't inside a checkbox
    //    group, so the scans above miss them. Modelled as Yes/No, same as Lever's lone
    //    consent checkbox.
    for (const checkbox of document.querySelectorAll(
      `input[type="checkbox"][id^="${FIELD_ID_PREFIX}"], input.ant-checkbox-input[id^="${FIELD_ID_PREFIX}"]`
    )) {
      const fieldId = checkbox.id;
      if (!fieldId || seen.has(fieldId)) continue;
      if (!isWithinAutofilledHistoryRow(checkbox)) continue;
      if (checkbox.closest(".ant-checkbox-group, .ant-radio-group")) continue; // handled as a group above
      if (checkbox.disabled || checkbox.offsetParent === null) continue;
      const question = getChoiceInputLabel(checkbox) || getChoiceGroupQuestion(checkbox) || fieldId;
      seen.add(fieldId);
      questions.push({
        question, fieldId, field: checkbox, control: checkbox, fieldKind: "checkbox-single",
        options: YES_NO_OPTIONS, required: checkbox.getAttribute("aria-required") === "true",
      });
    }

    return questions;
  }

  // ---- filling --------------------------------------------------------------

  function isAffirmativeAnswer(answer) {
    if (typeof answer === "boolean") return answer;
    const text = normalizeText(answer).toLowerCase();
    if (!text) return false;
    return !NEGATIVE_ANSWERS.has(text);
  }

  // Dayforce re-renders the form around a resume-parse prefill, so a node cached at
  // detection time can go stale — re-resolve a scalar control live by its (stable) id
  // before writing to it.
  function liveControl(fieldId, fallback) {
    return (fieldId && document.getElementById(fieldId)) || fallback;
  }
  function liveAntdSelect(fieldId, fallback) {
    const control = fieldId ? document.getElementById(fieldId) : null;
    return (control && getAntdSelect(control)) || getAntdSelect(fallback) || fallback;
  }

  /**
   * Write an already-resolved answer into a question returned by detectFields(),
   * dispatched by its fieldKind. The caller owns deciding WHAT the answer is — this only
   * owns getting it onto the page using window.ProactiveAutofillEngine's primitives (plus
   * this file's own Ant Design select mechanics).
   *
   * @param {{fieldId:string, field:Element, control:Element, fieldKind:string}} entry
   * @param {*} answer - string for text/textarea/date/phone/select-native/antd-select/
   *   antd-select-search/radio-group; string|string[]|boolean for checkbox-group/
   *   checkbox-single; {type:"file", fileName, base64, mimeType} for resume/cover_letter.
   */
  async function fillField(entry, answer, { shouldAbort = NEVER_ABORT } = {}) {
    if (!entry || answer == null || shouldAbort()) return;
    const { fieldId, field, control, fieldKind } = entry;

    switch (fieldKind) {
      case "text": {
        const live = liveControl(fieldId, control);
        const input = live?.tagName === "INPUT" ? live : getTextInput(live);
        if (input) fillTextInput(input, String(answer));
        return;
      }
      case "textarea": {
        const live = liveControl(fieldId, control);
        const input = live?.tagName === "TEXTAREA" ? live : getTextarea(live);
        if (input) fillTextInput(input, String(answer));
        return;
      }
      case "date": {
        const live = liveControl(fieldId, control);
        const input = live?.tagName === "INPUT" ? live : live?.querySelector('input[type="date"], input');
        if (!input) return;
        const text = String(answer);
        const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : toIsoDateString(answer);
        if (iso) fillTextInput(input, iso);
        return;
      }
      case "phone": {
        const live = liveControl(fieldId, control);
        const input = live?.tagName === "INPUT" ? live : getTextInput(live);
        if (input) await fillPhoneField(input, answer, shouldAbort);
        return;
      }
      case "select-native": {
        const live = liveControl(fieldId, control);
        const select = getNativeSelect(live);
        if (!select) return;
        const wanted = String(answer).trim().toLowerCase();
        const option = Array.from(select.options).find((o) => normalizeText(o.innerText || o.textContent).toLowerCase() === wanted);
        if (option) {
          select.value = option.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return;
      }
      case "antd-select": {
        const antdSelect = liveAntdSelect(fieldId, field);
        if (antdSelect) await selectAntdOptionByText(antdSelect, answer, shouldAbort);
        return;
      }
      case "antd-select-search": {
        const antdSelect = await waitUntilAntdSelectEnabled(fieldId, control, RECORD_SELECT_ENABLE_TIMEOUT_MS, shouldAbort);
        if (antdSelect && !shouldAbort()) await selectAntdOptionBySearch(antdSelect, answer, shouldAbort).catch(() => false);
        return;
      }
      case "checkbox-group": {
        const wanted = (Array.isArray(answer) ? answer : [answer]).filter((v) => v != null).map((v) => String(v).trim().toLowerCase());
        if (!wanted.length) return;
        const liveInputs = () =>
          Array.from((document.getElementById(fieldId) || field || document).querySelectorAll('input.ant-checkbox-input, input[type="checkbox"]'));
        const isWanted = (input) => {
          const label = getChoiceInputLabel(input).toLowerCase();
          return wanted.some((w) => w && (label === w || label.includes(w) || w.includes(label)));
        };
        // Single-select groups (the disability self-id) DISABLE every other option once one
        // is checked — uncheck a checked-but-unwanted box first so a target that was
        // disabled by the old selection can become pickable again. Re-queries the live
        // inputs every iteration: antd replaces the input nodes on every toggle.
        for (let guard = 0; guard < 6 && !shouldAbort(); guard++) {
          const stale = liveInputs().find((i) => i.checked && !isWanted(i));
          if (!stale) break;
          await clickLikeHuman(stale.closest("label") || stale, { shouldAbort });
          await sleep(250);
        }
        if (shouldAbort()) return;
        await waitFor(() => {
          const w = liveInputs().find(isWanted);
          return w && !w.disabled ? true : null;
        }, ANTD_DROPDOWN_CLOSE_TIMEOUT_MS, { shouldAbort });
        for (let guard = 0; guard < 6 && !shouldAbort(); guard++) {
          const target = liveInputs().find((i) => isWanted(i) && !i.checked && !i.disabled);
          if (!target) break;
          await clickLikeHuman(target.closest("label") || target, { shouldAbort });
          await sleep(250);
        }
        return;
      }
      case "checkbox-single": {
        const live = liveControl(fieldId, control);
        const checkbox = live?.type === "checkbox" ? live : live?.querySelector?.('input[type="checkbox"]');
        if (!checkbox || checkbox.disabled) return;
        const shouldCheck = isAffirmativeAnswer(answer);
        if (checkbox.checked !== shouldCheck) {
          await clickLikeHuman(checkbox.closest("label") || checkbox, { shouldAbort });
          checkbox.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return;
      }
      case "radio-group": {
        const group = document.getElementById(fieldId) || field;
        if (!group) return;
        const wanted = normalizeText(answer).toLowerCase();
        if (!wanted) return;
        const match = Array.from(group.querySelectorAll('input[type="radio"]')).find((input) => {
          if (input.disabled) return false;
          const label = getChoiceInputLabel(input).toLowerCase();
          return label === wanted || label.includes(wanted) || wanted.includes(label);
        });
        if (match && !match.checked) await clickLikeHuman(match.closest("label") || match, { shouldAbort });
        return;
      }
      case "resume": {
        if (answer?.type !== "file") return;
        const input = liveControl(fieldId, control);
        if (!input) return;
        fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        // Block here until Dayforce finishes parsing — every other field is re-resolved
        // live by id, so filling resume FIRST (and awaiting this) is what keeps the rest of
        // the form's fills from racing the parse-driven prefill.
        await waitForResumeParseComplete(shouldAbort);
        return;
      }
      case "cover_letter": {
        if (answer?.type !== "file") return;
        const input = getFileInputInsideField(liveControl(fieldId, control)) || liveControl(fieldId, control);
        if (!input) return;
        fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        await waitForUploadSettled(input, shouldAbort).catch(() => undefined);
        return;
      }
      default:
        return;
    }
  }

  // ---- repeatable Work History / Education History sections ---------------
  // Ported from BidHub's own Dayforce section descriptors (ROWS mode — every
  // record is an always-editable inline <form>, never a separate editor/
  // save step; confirmed against the real BidHub bundle's
  // DAYFORCE_WORK_HISTORY_SECTION/DAYFORCE_EDUCATION_SECTION). Driven by the
  // shared engine/section-hierarchy.js, same root→group→leaf model every
  // other ported site uses. isWithinAutofilledHistoryRow() above already
  // restricts the generic detectFields() scan to each section's FIRST,
  // always-rendered row, so these records are never double-detected by the
  // generic path.
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;

  const WORK_HISTORY_SECTION_SELECTOR = '[test-id="work-history"]';
  const ADD_WORK_HISTORY_RECORD_SELECTOR = '[test-id="add-workhistory-record"]';
  const WORK_HISTORY_DELETE_BUTTON_SELECTOR = '[test-id="workHistory-delete-button"]';
  const WORK_HISTORY_CANCEL_BUTTON_SELECTOR = '[test-id="workHistory-cancel-button"]';
  const EDUCATION_HISTORY_SECTION_SELECTOR = '[test-id="education-history"]';
  const ADD_EDUCATION_HISTORY_RECORD_SELECTOR = '[test-id="add-educationhistory-record"]';
  const EDUCATION_HISTORY_DELETE_BUTTON_SELECTOR = '[test-id="educationHistory-delete-button"]';
  const EDUCATION_HISTORY_CANCEL_BUTTON_SELECTOR = '[test-id="educationHistory-cancel-button"]';

  // Dayforce assigns each record <form>'s own DOM id a Dayforce-assigned,
  // non-contiguous-after-deletes trailing record index — derive it from the
  // row's own id rather than assuming it equals the hierarchy's row index,
  // then look the sub-field up by the stable
  // `<prefix>_<recordIndex>_<suffix>` id convention every record field uses.
  function getDayforceRecordIndex(rowEl) {
    const match = /-(\d+)$/.exec(rowEl?.id || "");
    return match ? Number(match[1]) : null;
  }
  function getDayforceRecordField(rowEl, mapping, prefix) {
    const recordIndex = getDayforceRecordIndex(rowEl);
    if (recordIndex == null) return null;
    const control = document.getElementById(`${prefix}_${recordIndex}_${mapping.suffix}`);
    return control ? { field: control } : null;
  }

  // A record's delete click opens an Ant Design confirm modal — wait for it,
  // then click its own Delete/Yes/Confirm button (never Cancel).
  async function confirmDayforceHistoryDeleteModal() {
    const button = await waitFor(() => {
      const dialog = Array.from(document.querySelectorAll('.ant-modal, .ant-modal-confirm, [role="dialog"]')).find(
        (modal) => modal.offsetParent !== null && /delete|remove/i.test(modal.textContent || "")
      );
      if (!dialog) return null;
      const buttons = Array.from(dialog.querySelectorAll("button"));
      return (
        buttons.find((b) => /\b(delete|remove|yes|confirm)\b/i.test((b.textContent || "").trim())) ||
        buttons.find((b) => !/cancel/i.test(b.textContent || "")) ||
        null
      );
    }, ANTD_DROPDOWN_CLOSE_TIMEOUT_MS);
    if (button) button.click();
  }

  // Deletes every existing record (confirming each delete's modal), re-
  // querying the section fresh on every pass — a record's DOM id index
  // isn't its on-screen position, so there's no single "last row" to
  // target directly. Falls back to the Cancel button for a stray
  // open-but-empty "Add" form (no Delete button yet), and bails once a
  // pass makes no progress. Capped at 25 iterations as a guard.
  async function clearDayforceHistoryRecords({ sectionSelector, recordSelector, deleteSelector, cancelSelector }) {
    let lastCount = Infinity;
    for (let guard = 0; guard < 25; guard++) {
      const sectionEl = document.querySelector(sectionSelector);
      if (!sectionEl) return;
      const count = sectionEl.querySelectorAll(recordSelector).length;
      if (count >= lastCount) return; // previous pass made no progress
      lastCount = count;
      const deleteButton = sectionEl.querySelector(deleteSelector);
      if (deleteButton) {
        deleteButton.click();
        await confirmDayforceHistoryDeleteModal();
        await sleep(700);
        continue;
      }
      const cancelButton = sectionEl.querySelector(cancelSelector);
      if (cancelButton) {
        cancelButton.click();
        await sleep(600);
        continue;
      }
      return; // nothing left to clear
    }
  }

  // A record's own Country/State selects are the same long, searchable Ant
  // Design widgets the top-level form uses (getAntdSelect/
  // selectAntdOptionBySearch above) — State stays `ant-select-disabled`
  // until Country is picked, so this waits for it live instead of no-op
  // filling a disabled control. In practice never reached today: BCD's
  // Profile.experience/.education carry no separate country/state (just a
  // free-text `location`, or nothing at all for education) — see the
  // mapping comments below — kept only so the leaf still detects/shows for
  // review, matching BidHub's own field set.
  async function fillDayforceRecordSearchSelect(control, value) {
    const deadline = Date.now() + RECORD_SELECT_ENABLE_TIMEOUT_MS;
    let antdSelect = null;
    while (Date.now() < deadline) {
      if (!control.disabled) {
        const candidate = getAntdSelect(control);
        if (candidate && !candidate.classList.contains("ant-select-disabled")) {
          antdSelect = candidate;
          break;
        }
      }
      await sleep(100);
    }
    if (antdSelect) await selectAntdOptionBySearch(antdSelect, value).catch(() => false);
  }

  const DAYFORCE_WORK_HISTORY_SECTION = {
    rootFieldId: "workHistory",
    rootQuestion: "Work History",
    profileSection: "experience",
    rowLabel: (i) => `Work history ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: () => document.querySelector(WORK_HISTORY_SECTION_SELECTOR),
    getRows: (container) => Array.from(container?.querySelectorAll(WORK_RECORD_SELECTOR) ?? []),
    getRowField: (rowEl, mapping) => getDayforceRecordField(rowEl, mapping, "jobPostingApplication_workHistory"),
    addRow: async () => {
      const btn = document.querySelector(ADD_WORK_HISTORY_RECORD_SELECTOR);
      if (btn) await clickLikeHuman(btn);
    },
    clearRows: () =>
      clearDayforceHistoryRecords({
        sectionSelector: WORK_HISTORY_SECTION_SELECTOR,
        recordSelector: WORK_RECORD_SELECTOR,
        deleteSelector: WORK_HISTORY_DELETE_BUTTON_SELECTOR,
        cancelSelector: WORK_HISTORY_CANCEL_BUTTON_SELECTOR,
      }),
    mappings: [
      { key: "title", suffix: "title", fieldKind: "text", question: "Job Title", label: "Job Title", profileKey: "role" },
      { key: "companyName", suffix: "companyName", fieldKind: "text", question: "Company", label: "Company", profileKey: "company" },
      { key: "effectiveStart", suffix: "effectiveStart", fieldKind: "date", question: "Start Date", label: "Start Date", profileKey: "start" },
      {
        key: "isCurrent",
        suffix: "isCurrent",
        fieldKind: "checkbox",
        question: "Current Role",
        label: "Current Role",
        resolveValue: (entry) => !String(entry?.end || "").trim(),
      },
      {
        key: "effectiveEnd",
        suffix: "effectiveEnd",
        fieldKind: "date",
        question: "End Date",
        label: "End Date",
        resolveValue: (entry) => (String(entry?.end || "").trim() ? entry.end : null),
      },
      { key: "city", suffix: "city", fieldKind: "text", question: "City", label: "City", profileKey: "location" },
      // No separate country/state on BCD's Profile.experience schema
      // (company/role/start/end/location only) — still detected (matching
      // BidHub's own field set), never auto-filled.
      { key: "countryCode", suffix: "countryCode", fieldKind: "antd-select-search", question: "Country", label: "Country" },
      { key: "stateCode", suffix: "stateCode", fieldKind: "antd-select-search", question: "State", label: "State" },
      // No BCD equivalent (reason-for-leaving / duties narrative) — detected only.
      { key: "reasonForLeaving", suffix: "reasonForLeaving", fieldKind: "text", question: "Reason for Leaving", label: "Reason for Leaving" },
      { key: "description", suffix: "description", fieldKind: "textarea", question: "Description", label: "Description" },
    ],
  };

  const DAYFORCE_EDUCATION_SECTION = {
    rootFieldId: "educationHistory",
    rootQuestion: "Education",
    profileSection: "education",
    rowLabel: (i) => `Education ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: () => document.querySelector(EDUCATION_HISTORY_SECTION_SELECTOR),
    getRows: (container) => Array.from(container?.querySelectorAll(EDUCATION_RECORD_SELECTOR) ?? []),
    getRowField: (rowEl, mapping) => getDayforceRecordField(rowEl, mapping, "jobPostingApplication_educationHistory"),
    addRow: async () => {
      const btn = document.querySelector(ADD_EDUCATION_HISTORY_RECORD_SELECTOR);
      if (btn) await clickLikeHuman(btn);
    },
    clearRows: () =>
      clearDayforceHistoryRecords({
        sectionSelector: EDUCATION_HISTORY_SECTION_SELECTOR,
        recordSelector: EDUCATION_RECORD_SELECTOR,
        deleteSelector: EDUCATION_HISTORY_DELETE_BUTTON_SELECTOR,
        cancelSelector: EDUCATION_HISTORY_CANCEL_BUTTON_SELECTOR,
      }),
    // Dayforce's own Education record has no Start/End date sub-fields at
    // all (confirmed against the real BidHub bundle — DAYFORCE_EDUCATION_
    // SECTION.mappings is degreeName/majorName/schoolName/city/stateCode
    // only) — ported as-is rather than inventing date leaves Dayforce
    // itself doesn't render.
    mappings: [
      { key: "degreeName", suffix: "degreeName", fieldKind: "text", question: "Degree", label: "Degree", profileKey: "degree" },
      // No `major`/discipline field on BCD's Profile.education schema
      // (school/degree/start/end only) — detected only, never auto-filled.
      { key: "majorName", suffix: "majorName", fieldKind: "text", question: "Major", label: "Major" },
      { key: "schoolName", suffix: "schoolName", fieldKind: "text", question: "School", label: "School", profileKey: "school" },
      // No `city` on BCD's Profile.education schema — detected only.
      { key: "city", suffix: "city", fieldKind: "text", question: "City", label: "City" },
      { key: "stateCode", suffix: "stateCode", fieldKind: "antd-select-search", question: "State", label: "State" },
    ],
  };

  const DAYFORCE_PROFILE_SECTIONS = [DAYFORCE_WORK_HISTORY_SECTION, DAYFORCE_EDUCATION_SECTION];

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections(DAYFORCE_PROFILE_SECTIONS, profileData);
  }

  async function fillSectionLeaf(field, mapping, value) {
    switch (mapping.fieldKind) {
      case "text":
      case "textarea":
        // Awaited (not the fire-and-forget fillTextInput) — the section
        // loop's next step is often another addRow() click that re-renders
        // the record list, which must not fire while this value's short
        // React-state-restore reassert window is still in flight.
        await fillTextInputReliably(field, value);
        return;
      case "date": {
        const text = String(value);
        const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : toIsoDateString(value);
        if (iso) await fillTextInputReliably(field, iso);
        return;
      }
      case "checkbox": {
        if (field.disabled) return;
        const shouldCheck = Boolean(value);
        if (field.checked !== shouldCheck) {
          await clickLikeHuman(field.closest("label") || field);
          field.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return;
      }
      case "antd-select-search":
        await fillDayforceRecordSearchSelect(field, value);
        return;
      default:
        return;
    }
  }

  async function fillSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    const results = [];
    for (const section of DAYFORCE_PROFILE_SECTIONS) {
      const entries = (profileData && profileData[section.profileSection]) || [];
      if (!entries.length) continue;
      const result = await SECTION_HIERARCHY.fillSection(section, entries, fillSectionLeaf);
      results.push({ rootFieldId: section.rootFieldId, ...result });
    }
    return results;
  }

  NS.dayforcehcm = {
    isAutofillAvailable,
    advance,
    detectFields,
    fillField,
    fetchSelectOptions,
    getSubmitButton,
    detectSections,
    fillSections,
  };
})();
