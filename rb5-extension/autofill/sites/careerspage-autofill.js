/* =====================================================================
 * autofill/sites/careerspage-autofill.js — careers-page.com (a.k.a.
 * "Career Page", Manatal) application forms: /<company>/job/<id>/apply.
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/careerspage/autofill.js.
 *
 * careers-page renders one flat Bootstrap form. Every logical question
 * is a single control whose question text lives EITHER in its
 * `placeholder` attribute OR (since ~2026-09, e.g. dautom) only in the
 * `.form-group`'s <label> ("Full Name: *") with an EMPTY placeholder —
 * the <label>'s `for` is empty/broken, so it is resolved by group, never
 * by id. Controls are identified by a stable per-posting id of the form
 * `field<number>`.
 *
 * The form is a Vue 2 app compiled from an in-DOM template
 * (`new Vue({ el: '#app' })`), mounted LATE after the page's own scripts
 * (flatpickr/select2) load. Three consequences this file has to account
 * for:
 *   - Pre-mount, `#app` is `display:none` and every `field<N>` id is
 *     still an unrendered `:id` binding — only the static
 *     `terms_and_condition` checkbox and the submit button exist.
 *     Detection gates on the form being VISIBLE, otherwise a caller
 *     would see a one-field snapshot of soon-to-be-dead nodes.
 *   - Post-mount the form is visible with the terms checkbox + Submit
 *     but no `field<N>` controls yet — the field list arrives from an
 *     API call. "No field controls" therefore also means "not loaded
 *     yet", not "this posting has no questions" (every Manatal form has
 *     at least Full Name/Email).
 *   - Mounting recreates the whole `#app` subtree, so any element cached
 *     at detection time can be dead by fill time — fill handlers
 *     re-resolve the live control from the fieldId (resolveLiveControl).
 *
 * Ported, structural-only:
 *   - field enumeration (placeholder/label text resolution, the required
 *     asterisk marker, resume/cover-letter slot detection)
 *   - value-filling per field kind: text/number/email inputs, a
 *     flatpickr date input, a select2-enhanced <select> (driven as its
 *     own widget, not the hidden native control), a native <select>, a
 *     lone Yes/No checkbox, a salary composite (amount + currency +
 *     period sub-selects grouped in one `.form-group`), and file upload
 *   - the terms-and-conditions consent checkbox (modeled the same way
 *     Lever's lone-checkbox consent question is: a binary Yes/No)
 *   - the posting→application-form "Apply for Position" advance step
 *
 * Explicitly NOT ported (BidHub's own AI-answer backend / CAPTCHA /
 * proxy — same boundary as every other port in this batch):
 *   - createBackendAnswerHandler / getAnswer() / getEmbeddingMatch — the
 *     free-text screening-question answer GENERATION and the embedding-
 *     similarity option-matching fallback. This file's own option
 *     matcher (getBestMatchingOption) stops at an exact or substring
 *     label match and returns null otherwise, leaving the field for Big
 *     Banana's existing generic AI-answer pipeline to try instead of
 *     guessing.
 *   - isDependentQuestion/dependsOnPrevious (BidHub's own sequencing hint
 *     for its AI-answer pipeline) — not meaningful without that pipeline,
 *     so it isn't carried over.
 * ===================================================================== */
(function () {
  "use strict";
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const { fillTextInput, fillFileInput, fillSelectInput, getCheckboxInputs, getTextarea, getTextInput, getNativeSelect, getFileInputInsideField, sleep } =
    engine;

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});

  async function waitFor(check, timeoutMs, pollMs = 60) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = check();
      if (result) return result;
      await sleep(pollMs);
    }
    return null;
  }

  const RESUME_PLACEHOLDER = /\b(resume|cv|curriculum vitae)\b/i;
  const COVER_LETTER_PLACEHOLDER = /cover\s*letter/i;
  const TERMS_CONSENT_FIELD_ID = "terms_and_condition";
  const TERMS_CONSENT_FALLBACK_QUESTION = "I agree to the terms and conditions and privacy policy";
  const DROPDOWN_WAIT_TIMEOUT_MS = 2500;
  const RESUME_FIELD_ID = "resume";
  const COVER_LETTER_FIELD_ID = "cover_letter";

  function normalizeText(value) {
    return String(value ?? "").replace(/\u00a0/g, " ").replace(/\*/g, "").replace(/\s+/g, " ").trim();
  }
  function normalizeComparison(value) {
    return normalizeText(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  }

  function isElementVisible(element) {
    if (!element?.isConnected) return false;
    // The pre-mount `display:none` lives on the `#app` ANCESTOR, not on
    // the form itself — walk up rather than checking just this element.
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      if (window.getComputedStyle(node).display === "none") return false;
    }
    if (window.getComputedStyle(element).visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // fieldIds are either the control's DOM id (`field<N>`) or its `name`
  // (`terms_and_condition`), so the live control can always be
  // re-resolved from the fieldId after a Vue re-render; fall back to the
  // cached node only when neither lookup hits.
  function resolveLiveControl(fieldId, fallback) {
    if (!fieldId) return fallback;
    const escaped = String(fieldId).replace(/["\\]/g, "\\$&");
    return document.getElementById(fieldId) || document.querySelector(`[name="${escaped}"]`) || fallback;
  }

  function triggerMouseEvent(element, type) {
    element?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }

  // The question text: the control's placeholder when the posting
  // carries one, else the enclosing `.form-group`'s <label> ("Full
  // Name: *" → "Full Name"). Newer postings ship EMPTY placeholders, so
  // the label is the only source there.
  function getFieldLabel(control) {
    const group = control?.closest?.(".form-group") || control?.closest?.("div");
    return group?.querySelector("label:not(.custom-file-label)") || null;
  }
  function getFieldQuestionText(control) {
    const placeholder = normalizeText(control?.getAttribute?.("placeholder") || "");
    if (placeholder) return placeholder;
    const label = getFieldLabel(control);
    const labelText = normalizeText(label?.textContent || "").replace(/\s*:\s*$/, "");
    if (labelText) return labelText;
    return normalizeText(control?.getAttribute?.("aria-label") || "");
  }
  // Matches an asterisk required marker (ASCII `*` or the heavy asterisk ✱).
  const REQUIRED_MARKER = /[✱*]/;
  function isFieldRequired(control) {
    if (control?.required || control?.getAttribute?.("aria-required") === "true") return true;
    const label = getFieldLabel(control);
    return label ? REQUIRED_MARKER.test(label.textContent || "") : false;
  }

  // careers-page renders date questions as a flatpickr-enhanced readonly text input.
  function isDateField(control) {
    if (control?.type === "date") return true;
    return /\b(flatpickr-input|datetimefield)\b/.test(control?.className || "");
  }
  // Coerce an answer into flatpickr's committed `YYYY-MM-DD` format.
  function toIsoDate(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const mdy = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) {
      return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
    }
    return text;
  }

  // ---- Salary composite -----------------------------------------------
  // Some salary questions render as three controls inside one
  // `.form-group`: a numeric amount (`field<N>`) plus a currency
  // <select> (`#expected_currency`) and a period <select>
  // (`#expected_frequency`). Neither sub-select has a `field*` id, so
  // they aren't separate questions — the trio is modeled as one field.
  function getSalaryCompositeParts(group) {
    if (!group) return null;
    const currency = group.querySelector('select#expected_currency, select[id*="currency" i]');
    const frequency = group.querySelector('select#expected_frequency, select[id*="frequency" i]');
    if (!currency && !frequency) return null;
    const amount = group.querySelector('input[type="number"], input[type="text"]');
    return { amount, currency, frequency };
  }
  // The amount comes from the caller's answer; the currency and period
  // are dictated by the question wording itself (e.g. "Salary
  // Expectation in USD per month"), so derive them from the prompt.
  const CURRENCY_CODE_TO_NAME = {
    USD: "us dollar", EUR: "euro", GBP: "pound sterling", JPY: "yen", CNY: "yuan", AUD: "australian dollar",
    CAD: "canadian dollar", CHF: "swiss franc", HKD: "hong kong dollar", SGD: "singapore dollar", NZD: "new zealand dollar",
    INR: "indian rupee", PHP: "philippine peso", IDR: "indonesian rupiah", MYR: "ringgit", THB: "baht", VND: "dong",
    KRW: "won", AED: "emirati", SAR: "saudi riyal", ZAR: "rand", BRL: "brazilian real", MXN: "mexican peso",
    PLN: "zloty", SEK: "swedish krona", NOK: "norwegian krone", DKK: "danish krone", PKR: "pakistani rupee",
  };
  const PERIOD_KEYWORDS = [
    { re: /\b(per\s*hour|hourly|\/\s*hr|\/\s*hour)\b/i, keys: ["hour", "hourly"] },
    { re: /\b(per\s*day|daily)\b/i, keys: ["day", "daily"] },
    { re: /\b(per\s*week|weekly)\b/i, keys: ["week", "weekly"] },
    { re: /\b(per\s*month|monthly|\/\s*mo)\b/i, keys: ["month", "monthly"] },
    { re: /\b(per\s*(year|annum)|yearly|annual|annually)\b/i, keys: ["year", "yearly"] },
  ];
  function selectOptionByKeys(select, keys) {
    const option = Array.from(select.options).find((candidate) => {
      const value = normalizeComparison(candidate.value);
      const text = normalizeComparison(candidate.textContent || candidate.label);
      return keys.includes(value) || keys.includes(text);
    });
    if (option) fillSelectInput(select, option.value);
  }
  function fillSalaryCurrency(select, question) {
    const codeMatch = String(question || "").match(/\b([A-Za-z]{3})\b/g) || [];
    const code = codeMatch.map((c) => c.toUpperCase()).find((c) => CURRENCY_CODE_TO_NAME[c]);
    const needle = code ? CURRENCY_CODE_TO_NAME[code] : null;
    if (!needle) return; // Only set when the currency is unambiguous; otherwise leave the default.
    const option = Array.from(select.options).find((candidate) => normalizeComparison(candidate.textContent || candidate.label).includes(needle));
    if (option) fillSelectInput(select, option.value);
  }
  function fillSalaryPeriod(select, question) {
    const hit = PERIOD_KEYWORDS.find((entry) => entry.re.test(String(question || "")));
    if (hit) selectOptionByKeys(select, hit.keys);
  }

  function isAffirmativeAnswer(answer) {
    if (typeof answer === "boolean") return answer;
    return /^(yes|true|1)$/i.test(normalizeComparison(answer));
  }
  function isPlaceholderSelectOption(option) {
    if (!option) return false;
    if (!option.value) return true;
    const text = normalizeComparison(option.textContent || option.label || option.value);
    return text === "" || text.startsWith("select ") || text === "no answer";
  }
  function readNativeSelectOptions(select) {
    if (!select) return [];
    return Array.from(select.options)
      .filter((option) => !isPlaceholderSelectOption(option))
      .map((option) => normalizeText(option.textContent || option.label || option.value))
      .filter(Boolean);
  }
  // Exact (normalized) match first, else substring either direction —
  // deliberately NOT BidHub's own embedding-similarity fallback (that's
  // the out-of-scope AI-answer backend). A looser-than-substring miss
  // returns null and the option is left unselected.
  function getBestMatchingOption(answer, optionTexts) {
    const normalizedAnswer = normalizeComparison(answer);
    if (!normalizedAnswer || !Array.isArray(optionTexts) || optionTexts.length === 0) return null;
    const exact = optionTexts.find((text) => normalizeComparison(text) === normalizedAnswer);
    if (exact) return exact;
    return optionTexts.find((text) => {
      const normalizedText = normalizeComparison(text);
      return normalizedText && (normalizedText.includes(normalizedAnswer) || normalizedAnswer.includes(normalizedText));
    }) ?? null;
  }

  // ---- select2 (the enhanced-<select> widget) ---------------------------
  // careers-page enhances some <select>s with select2 (jQuery). The
  // native <select> is aria-hidden and a sibling `.select2-container`
  // renders the interactive widget, so this drives the widget directly
  // (open → click option) rather than mutating the hidden select.
  function isSelect2Select(select) {
    if (!select) return false;
    if (select.classList?.contains("select2-hidden-accessible")) return true;
    if (select.classList?.contains("multiselect")) return true;
    return Boolean(getSelect2Container(select));
  }
  function getSelect2Container(select) {
    if (!select) return null;
    const sibling = select.nextElementSibling;
    if (sibling?.classList?.contains("select2-container")) return sibling;
    return select.parentElement?.querySelector(":scope > .select2-container") || null;
  }
  function isSelect2DropdownOpen() {
    return Boolean(document.querySelector(".select2-container--open"));
  }
  async function openSelect2Dropdown(select) {
    const container = getSelect2Container(select);
    const selection = container?.querySelector(".select2-selection");
    if (!selection) return null;
    // Idempotent: only toggle when closed — a blind toggle while a chip
    // removal (clearSelect2Selections) left the dropdown open would
    // close it again and the next pick would find no options.
    if (!isSelect2DropdownOpen()) {
      triggerMouseEvent(selection, "mousedown");
      triggerMouseEvent(selection, "mouseup");
      selection.click();
    }
    return waitFor(() => {
      const options = document.querySelectorAll(".select2-results__option");
      return options.length > 0 ? Array.from(options) : null;
    }, DROPDOWN_WAIT_TIMEOUT_MS);
  }
  // A multi-select select2 keeps one chip per selection, so re-running
  // the fill would stack a new answer onto the old one — remove existing
  // chips first. The chip list re-renders after each removal, detaching
  // the previous remove buttons, so re-query the first remaining button
  // every iteration instead of caching the list.
  async function clearSelect2Selections(select) {
    const container = getSelect2Container(select);
    if (!container) return;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const removeButton = container.querySelector(".select2-selection__choice__remove");
      if (!removeButton) return;
      triggerMouseEvent(removeButton, "mousedown");
      removeButton.click();
      await sleep(60);
    }
  }
  async function fillSelect2(select, answer) {
    const values = Array.isArray(answer) ? answer : [answer];
    await clearSelect2Selections(select);
    for (const value of values) {
      const normalized = normalizeText(value);
      if (!normalized) continue;
      const optionEls = await openSelect2Dropdown(select);
      if (!optionEls) {
        // No select2 widget (or it never opened) — fall back to the underlying native <select>.
        const match = readNativeSelectOptions(select).includes(normalized) ? normalized : null;
        if (match) {
          const option = Array.from(select.options).find((o) => normalizeComparison(o.textContent) === normalizeComparison(match));
          if (option) fillSelectInput(select, option.value);
        }
        continue;
      }
      const optionTexts = optionEls.map((el) => normalizeText(el.textContent));
      const matchedText = getBestMatchingOption(normalized, optionTexts);
      const chosen = matchedText ? optionEls.find((el) => normalizeComparison(el.textContent) === normalizeComparison(matchedText)) : null;
      if (!chosen) continue;
      // select2 commits a selection on the mouseup of a results option, not a plain click.
      triggerMouseEvent(chosen, "mousedown");
      triggerMouseEvent(chosen, "mouseup");
      await sleep(150);
    }
  }

  // ---- Form / submit / apply-button lookups ------------------------------

  function getFieldControls(form) {
    return Array.from(form?.querySelectorAll?.('[id^="field"]') ?? []);
  }
  function getCareerspageForm() {
    return (
      document.querySelector("#submit-id-submit")?.closest("form") ||
      Array.from(document.querySelectorAll("form")).find((f) => f.querySelector('[id^="field"]')) ||
      null
    );
  }
  function getSubmitButton() {
    return document.querySelector("#submit-id-submit") || document.querySelector('form button.btn-apply[type="submit"]') || document.querySelector('form button[type="submit"]');
  }
  function detectSubmitButton() {
    const submitButton = getSubmitButton();
    // Hidden = the Vue app hasn't mounted yet — the pre-mount snapshot
    // must be fully empty so nothing auto-starts on it.
    if (!submitButton || !isElementVisible(submitButton)) return { detected: false };
    // Visible but the field list hasn't loaded yet — wait for the
    // controls (same predicate as detectFields) rather than reporting a
    // Submit a caller might press on an empty form.
    if (!getFieldControls(submitButton.closest("form")).length) return { detected: false };
    const label = normalizeText(submitButton.textContent || submitButton.value || submitButton.getAttribute("aria-label") || "");
    if (!/\b(submit|apply|send)\b/i.test(label)) return { detected: false };
    return { detected: true, label, disabled: Boolean(submitButton.disabled || submitButton.getAttribute("aria-disabled") === "true") };
  }
  // careers-page applications span two pages under `*/job/*`: the job
  // posting (an "Apply for Position" control that opens the form) and
  // the `/apply` form itself.
  function getApplyButton() {
    const button = Array.from(document.querySelectorAll("button")).find(
      (el) => !el.closest("form") && /apply (for|now|to)\b|apply for position/i.test(normalizeText(el.textContent))
    );
    if (button) return button;
    return (
      Array.from(document.querySelectorAll('a[href*="/apply"]')).find(
        (el) => /\bapply\b/i.test(el.textContent || "") || /\/apply\/?$/.test(el.getAttribute("href") || "")
      ) ?? null
    );
  }
  // The only forward action once the application form is open is the
  // final submit, which this module never auto-clicks — advance() only
  // ever crosses the posting→form boundary.
  async function advance() {
    if (getSubmitButton()) return false;
    const applyButton = getApplyButton();
    if (!applyButton) return false;
    applyButton.click();
    return true;
  }

  // ---- field enumeration ---------------------------------------------------

  /** Enumerate every fillable field on the current (mounted) application
   *  form: {question, fieldId, fieldKind, field, control, options,
   *  required}. Returns [] before the Vue app has mounted or before its
   *  field list has loaded (see the header's pre/post-mount note) —
   *  never a partial snapshot of nodes about to be torn down. */
  function detectFields() {
    const form = getCareerspageForm();
    if (!form || !isElementVisible(form)) return [];
    const controls = getFieldControls(form);
    if (!controls.length) return [];

    const questions = [];
    let resumeAdded = false;
    let coverLetterAdded = false;

    for (const control of controls) {
      const tag = control.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") continue;
      if (control.type === "hidden" || control.disabled) continue;
      // flatpickr date inputs are intentionally `readonly` but still
      // fillable, so only skip readonly controls that aren't date pickers.
      if (control.readOnly && !isDateField(control)) continue;
      const question = getFieldQuestionText(control);
      if (!question) continue;
      const combined = `${question} ${control.id || ""} ${control.name || ""}`;
      const required = isFieldRequired(control);

      if (control.type === "file") {
        const isCoverLetter = COVER_LETTER_PLACEHOLDER.test(combined);
        if (isCoverLetter) {
          if (coverLetterAdded) continue;
          coverLetterAdded = true;
          questions.push({ question, fieldId: COVER_LETTER_FIELD_ID, fieldKind: "cover_letter", field: control, control, options: [], required });
        } else {
          if (resumeAdded || !RESUME_PLACEHOLDER.test(combined)) continue;
          resumeAdded = true;
          questions.push({ question, fieldId: RESUME_FIELD_ID, fieldKind: "resume", field: control, control, options: [], required });
        }
        continue;
      }

      // Lone checkbox → Yes/No acknowledgement question.
      if (control.type === "checkbox") {
        questions.push({ question, fieldId: control.id, fieldKind: "checkbox", field: control, control, options: ["Yes", "No"], required });
        continue;
      }

      if (tag === "INPUT" && isDateField(control)) {
        questions.push({ question, fieldId: control.id, fieldKind: "date", field: control, control, options: [], required });
        continue;
      }

      // Salary composite: a numeric amount grouped with currency +
      // period <select>s. Model the whole `.form-group` as one field.
      if (tag === "INPUT") {
        const salaryGroup = control.closest(".form-group");
        const salaryParts = getSalaryCompositeParts(salaryGroup);
        if (salaryParts && salaryParts.amount === control) {
          questions.push({ question, fieldId: control.id, fieldKind: "salary-composite", field: salaryGroup, control, options: [], required });
          continue;
        }
      }

      if (tag === "SELECT") {
        const select2 = isSelect2Select(control);
        questions.push({
          question,
          fieldId: control.id,
          fieldKind: select2 ? "select2" : "select-native",
          field: control,
          control,
          options: readNativeSelectOptions(control),
          required,
        });
        continue;
      }

      if (tag === "TEXTAREA") {
        if (COVER_LETTER_PLACEHOLDER.test(combined)) {
          if (coverLetterAdded) continue;
          coverLetterAdded = true;
          questions.push({ question, fieldId: COVER_LETTER_FIELD_ID, fieldKind: "cover_letter", field: control, control, options: [], required });
          continue;
        }
        questions.push({ question, fieldId: control.id, fieldKind: "textarea", field: control, control, options: [], required });
        continue;
      }

      // Default: text / number / email / tel inputs.
      questions.push({ question, fieldId: control.id, fieldKind: "text", field: control, control, options: [], required });
    }

    // Terms & conditions consent (see TERMS_CONSENT_FIELD_ID). Unlike the
    // question controls it has no `field<N>` id and no placeholder — it
    // is keyed by `name`, with its prompt in a sibling <span>. Appended
    // last: it is the final control before the submit.
    const termsCheckbox = form.querySelector(`input[type="checkbox"][name="${TERMS_CONSENT_FIELD_ID}"]`);
    if (termsCheckbox && !termsCheckbox.disabled) {
      const promptEl = termsCheckbox.closest("div")?.querySelector("span, label");
      const question = normalizeText(promptEl?.textContent) || TERMS_CONSENT_FALLBACK_QUESTION;
      questions.push({ question, fieldId: TERMS_CONSENT_FIELD_ID, fieldKind: "checkbox", field: termsCheckbox, control: termsCheckbox, options: ["Yes", "No"], required: true });
    }
    return questions;
  }

  // ---- filling ------------------------------------------------------------

  /** Write an already-resolved answer into a question returned by
   *  detectFields(). Re-resolves the live control from fieldId first
   *  (resolveLiveControl) since a Vue re-render can have replaced the
   *  cached node since detection ran.
   * @param {{fieldId:string, fieldKind:string, field:Element, control:Element}} entry
   * @param {*} answer - string for text/date/textarea/salary-composite's
   *   amount; string|string[] for select-native/select2; boolean|string
   *   for checkbox; {type:"file", fileName, base64, mimeType} for
   *   resume, or that object OR a plain string for cover_letter.
   */
  async function fillField(entry, answer) {
    if (!entry || answer == null) return;
    const { fieldId, fieldKind, question } = entry;
    const field = resolveLiveControl(fieldId, entry.field);

    switch (fieldKind) {
      case "text": {
        const input = getTextInput(field) || (field?.tagName === "INPUT" ? field : null);
        if (input) fillTextInput(input, String(answer));
        return;
      }
      case "date": {
        const input = getTextInput(field) || (field?.tagName === "INPUT" ? field : null);
        const iso = toIsoDate(answer);
        if (!input || !iso) return;
        // flatpickr inputs are readonly, but a programmatic value set
        // still sticks and is what the form submits — flatpickr doesn't
        // re-render from its own (empty) internal state here.
        input.value = iso;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }
      case "textarea": {
        const textarea = getTextarea(field);
        if (textarea && typeof answer === "string") fillTextInput(textarea, answer);
        return;
      }
      case "cover_letter": {
        if (typeof answer === "string") {
          const textarea = getTextarea(field);
          const input = getTextInput(field) || (field?.tagName === "INPUT" ? field : null);
          if (textarea) fillTextInput(textarea, answer);
          else if (input) fillTextInput(input, answer);
          return;
        }
        if (answer?.type === "file") {
          const input = getFileInputInsideField(field);
          if (input) fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        }
        return;
      }
      case "resume": {
        if (answer?.type !== "file") return;
        const input = getFileInputInsideField(field);
        if (input) fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        return;
      }
      case "salary-composite": {
        // `field` is the `.form-group` wrapping the amount input + currency/period selects.
        const parts = getSalaryCompositeParts(entry.field) || {};
        if (parts.amount) fillTextInput(parts.amount, String(answer));
        if (parts.currency) fillSalaryCurrency(parts.currency, question);
        if (parts.frequency) fillSalaryPeriod(parts.frequency, question);
        return;
      }
      case "select-native": {
        const select = getNativeSelect(field);
        if (!select) return;
        const options = Array.from(select.options).filter((option) => !isPlaceholderSelectOption(option));
        const matchedText = getBestMatchingOption(answer, options.map((option) => normalizeText(option.textContent || option.value)));
        if (!matchedText) return;
        const option = options.find((candidate) => normalizeComparison(candidate.textContent || candidate.value) === normalizeComparison(matchedText));
        if (option) fillSelectInput(select, option.value);
        return;
      }
      case "select2": {
        const select = field?.tagName === "SELECT" ? field : getNativeSelect(field);
        if (select) await fillSelect2(select, answer);
        return;
      }
      case "checkbox": {
        const checkbox = getCheckboxInputs(field)[0] || (field?.type === "checkbox" ? field : null);
        if (!checkbox) return;
        const shouldCheck = isAffirmativeAnswer(answer);
        if (checkbox.checked === shouldCheck) return; // idempotent: a re-fill never toggles the box back
        // Native activation fires the click/input/change sequence Vue's
        // v-model listens on — a bare `.checked =` plus a synthetic
        // change leaves the model unset.
        checkbox.click();
        return;
      }
      default:
        return;
    }
  }

  // The job-posting page has no form fields and no final submit — only
  // the "Apply for Position" control. Reported as available so a caller
  // treats the page as an actionable (field-less) step that advance()
  // can move past into the application form.
  function isAutofillAvailable() {
    const detected = detectFields();
    if (detected.length > 0) return true;
    if (detectSubmitButton().detected) return true;
    return Boolean(getApplyButton());
  }

  NS.careerspage = {
    isAutofillAvailable,
    advance,
    detectFields,
    fillField,
    getSubmitButton,
    detectSubmitButton,
  };
})();
