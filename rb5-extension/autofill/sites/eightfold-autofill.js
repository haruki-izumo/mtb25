/* =====================================================================
 * autofill/sites/eightfold-autofill.js — Eightfold.ai careers portal
 * (<tenant>.eightfold.ai/careers).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/eightfold/autofill.js. That
 * file's own field-filling MECHANICS are NOT re-implemented here —
 * they're exactly what autofill/engine/dom-interactions.js already
 * provides as window.ProactiveAutofillEngine, so this file calls into
 * that instead.
 *
 * Flow: posting (/careers/job/<id> or /careers?pid=<id>) → "Apply Now" →
 * a single-page application form (/careers/apply?pid=<id>) with
 * sections (Resume, Contact Information, screener Questions, EEO,
 * e-signature) and one final "Submit application" button. There is no
 * multi-step wizard — every field lives on the one page, so the only
 * "advance" is crossing the posting → form boundary.
 *
 * Every real form control carries a stable `data-test-id` (e.g.
 * `Contact_Information_firstname`, `Preliminary_Questions_country`).
 * For text inputs/checkboxes that id sits on the input itself; for the
 * custom select widget it sits on the wrapping
 * `div.select-module_select-wrapper` (the inner search input has a
 * volatile generated `input-N` id, so detection always keys off
 * `data-test-id`, never the input's own id).
 *
 * OUT OF SCOPE (left to Big Banana's own existing systems, untouched):
 *   - Free-text/long-select ANSWER GENERATION. BidHub resolves the
 *     address-country search select and every open-ended question
 *     through its own AI backend (getAnswer()/ai-core), with an
 *     embedding-similarity fallback when no option matches exactly.
 *     None of that is ported — detectFields() below only classifies
 *     each control's structural fieldKind and locates it; fillField()
 *     only matches an already-resolved answer against the field's own
 *     option text (exact match only, same AI boundary lever-autofill.js
 *     and dover-autofill.js keep).
 *   - CAPTCHA/proxy lanes. Eightfold's "Submit application" button is
 *     just clicked like any other button; whatever runs after that is
 *     not this file's concern.
 *   - registerAutofillHandlers/ANSWER_TYPE_HANDLERS and the
 *     waitForFieldId sequencing BidHub's own runtime used to hold every
 *     other field back until the resume field resolved — that ordering
 *     was the orchestration layer's job. The actual SITE quirk behind
 *     it (uploading a resume triggers a parse + popup that can clobber
 *     other fields) is real and worth keeping: fillField()'s 'resume'
 *     case still awaits the parse/popup settling before returning, the
 *     same way lever-autofill.js's 'resume' case awaits Lever's own
 *     résumé-parse state. A caller filling resume first (as BidHub's
 *     orchestration did) still gets the same protection; this file just
 *     doesn't enforce the ordering itself.
 * ===================================================================== */
(function () {
  "use strict";

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const { sleep, fillTextInput, fillTextInputWithoutBlur, fillFileInput, clickLikeHuman } = engine;

  // ---- constants ----------------------------------------------------------

  // Eightfold uses CSS-module hashed class names (e.g.
  // `select-module_select-wrapper__SyQtt`), so anchor on the stable
  // un-hashed prefix with a substring attribute selector rather than an
  // exact class.
  const SELECT_WRAPPER_CLASS = "select-module_select-wrapper";
  const SELECT_WRAPPER_SELECTOR = `[class*="${SELECT_WRAPPER_CLASS}"]`;
  const OPTION_SELECTOR = 'button[role="option"]';
  const RESUME_DROPZONE_SELECTOR = '.upload-resume-dropzone input[type="file"], input[type="file"][accept*=".pdf"]';
  const SUBMIT_TEXT_RE = /^submit application$/i;
  const APPLY_TEXT_RE = /\bapply\b/i;

  // Address country (`_country`) is a long type-to-filter search select
  // whose panel doesn't enumerate its options up front.
  const SEARCH_SELECT_RE = /_country$/i;

  // The phone dial-code select (`*phone-country-code`) is an ordinary
  // single-select (a "legacy dropdown") rather than a type-to-filter
  // search: it renders all ~254 options on open. Its only "label" is the
  // placeholder "Select country code", which is too ambiguous to ask —
  // override the question to ask for the phone's country instead.
  const PHONE_COUNTRY_CODE_RE = /phone-country-code$/i;
  const PHONE_NUMBER_RE = /_phone$/i;
  const PHONE_COUNTRY_QUESTION = "Phone number country";
  const DROPDOWN_WAIT_TIMEOUT_MS = 2500;
  const ANTD_DROPDOWN_CLOSE_TIMEOUT_MS = 2000;
  const RESUME_PARSE_KICKOFF_MS = 1200;
  const RESUME_PARSE_TIMEOUT_MS = 45000;
  const RESUME_POPUP_WAIT_MS = 6000;
  const PARSE_SPINNER_SELECTOR = [
    '[class*="upload"][class*="loading"]',
    '[class*="upload"][class*="uploading"]',
    '[class*="spinner"]',
    '[class*="Spinner"]',
    '[class*="progress-bar"]',
    '[class*="parsing"]',
    '[class*="Parsing"]',
    '[aria-busy="true"]',
  ].join(", ");
  const MODAL_SELECTOR = '[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"], [class*="popup"], [class*="Popup"]';
  const NEGATIVE_ANSWERS = new Set(["no", "false", "n", "off", "unchecked", "decline", "disagree", "none", "0"]);

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/"/g, '\\"');
  }

  // A file input is only ever ALLOWED to be visually hidden (styled
  // width/height:0) — never skip it on that basis.
  function isElementVisible(el) {
    if (!el) return false;
    if (el.type === "file") return true;
    return el.offsetParent !== null || (el.getClientRects && el.getClientRects().length > 0);
  }

  async function waitFor(check, timeoutMs, shouldAbort = () => false) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (shouldAbort()) return null;
      const result = check();
      if (result) return result;
      await sleep(80);
    }
    return null;
  }

  // ---- page / flow helpers -------------------------------------------------

  function isApplicationForm() {
    return Boolean(document.querySelector('[data-test-id="Contact_Information_email"], [data-test-id^="Contact_Information_"]'));
  }
  function getFinalSubmitButton() {
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]'));
    return buttons.find((b) => SUBMIT_TEXT_RE.test((b.textContent || b.value || "").replace(/\s+/g, " ").trim()) && isElementVisible(b)) ?? null;
  }
  // The forward-navigation control: the posting's "Apply Now"/"Apply
  // for…" that opens the application form. Never the final submit,
  // never "Add to Job Cart".
  function getAdvanceButton() {
    if (getFinalSubmitButton()) return null;
    const buttons = Array.from(document.querySelectorAll('button, a[role="button"], a, [role="button"]'));
    return (
      buttons.find((b) => {
        if (!isElementVisible(b) || b.disabled || b.getAttribute("aria-disabled") === "true") return false;
        const text = (b.textContent || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 40) return false;
        if (/job cart|upload|login|sign in|save/i.test(text)) return false;
        return APPLY_TEXT_RE.test(text);
      }) ?? null
    );
  }
  async function advance({ shouldAbort = () => false } = {}) {
    if (getFinalSubmitButton() || shouldAbort()) return false;
    const advanceButton = getAdvanceButton();
    if (!advanceButton) return false;
    await clickLikeHuman(advanceButton, { shouldAbort });
    return true;
  }
  function isAutofillAvailable() {
    return Boolean(isApplicationForm() || getAdvanceButton());
  }
  function getSubmitButton() {
    return getFinalSubmitButton();
  }

  // ---- Eightfold select widget helpers -------------------------------------
  // A button+portal'd listbox (same shape BambooHR's Fabric "Select"
  // widget uses): a wrapper div carries the data-test-id, a click opens
  // a floating `button[role="option"]` list, and dismissing is an
  // Escape keypress or a click outside.

  function hasSelectClass(el) {
    return Boolean(el?.className && String(el.className).includes(SELECT_WRAPPER_CLASS));
  }
  function isSelectControl(el) {
    return hasSelectClass(el) || Boolean(el?.closest?.(SELECT_WRAPPER_SELECTOR));
  }
  function getSelectWrapper(fieldId, field) {
    if (fieldId) {
      const byId = document.querySelector(`[data-test-id="${cssEscape(fieldId)}"]`);
      if (byId) return hasSelectClass(byId) ? byId : byId.closest(SELECT_WRAPPER_SELECTOR) || byId;
    }
    if (field) return hasSelectClass(field) ? field : field.closest?.(SELECT_WRAPPER_SELECTOR) || field;
    return null;
  }
  function readSelectOptions(wrapper) {
    return Array.from(wrapper.querySelectorAll(OPTION_SELECTOR))
      .filter((o) => !o.disabled && o.getAttribute("aria-disabled") !== "true")
      .map((o) => ({ el: o, text: (o.getAttribute("title") || o.textContent || "").replace(/\s+/g, " ").trim() }))
      .filter((o) => o.text);
  }
  function isSelectOpen(wrapper) {
    const expandable = wrapper.querySelector("[aria-expanded]");
    if (expandable) return expandable.getAttribute("aria-expanded") === "true";
    return wrapper.querySelectorAll(OPTION_SELECTOR).length > 0;
  }
  async function openSelect(wrapper, shouldAbort = () => false) {
    const control = wrapper.querySelector('[role="combobox"], [class*="select-control"], [class*="select-display"]') || wrapper;
    wrapper.scrollIntoView?.({ block: "center" });
    control.click();
    wrapper.querySelector("input")?.focus?.();
    return waitFor(() => (readSelectOptions(wrapper).length > 0 ? wrapper : null), DROPDOWN_WAIT_TIMEOUT_MS, shouldAbort);
  }
  async function closeSelect(wrapper, shouldAbort = () => false) {
    wrapper.querySelector("input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await waitFor(() => (isSelectOpen(wrapper) ? null : true), ANTD_DROPDOWN_CLOSE_TIMEOUT_MS, shouldAbort);
  }
  // Exact-text match only — deliberately NOT BidHub's own embedding
  // fallback (its search-select handler calls getEmbeddingMatch() when
  // no option matches exactly). A list this can't place deterministically
  // is left closed/untouched for the generic pipeline to try.
  function findMatchingSelectOption(answer, options) {
    const wanted = String(answer ?? "").trim().toLowerCase();
    if (!wanted) return null;
    return options.find((o) => o.text.toLowerCase() === wanted) ?? null;
  }
  async function fillSelectField(wrapper, answer, shouldAbort) {
    const opened = await openSelect(wrapper, shouldAbort);
    if (!opened || shouldAbort()) return false;
    const match = findMatchingSelectOption(answer, readSelectOptions(wrapper));
    if (!match) {
      await closeSelect(wrapper, shouldAbort);
      return false;
    }
    match.el.click();
    await waitFor(() => (isSelectOpen(wrapper) ? null : true), ANTD_DROPDOWN_CLOSE_TIMEOUT_MS, shouldAbort);
    return true;
  }
  // The long type-to-filter search select (address country): type into
  // its inner input to narrow the list, then require an exact match on
  // the (now short) filtered list.
  async function fillSelectSearchField(wrapper, answer, shouldAbort) {
    const wanted = String(answer ?? "").trim();
    if (!wanted) return false;
    const opened = await openSelect(wrapper, shouldAbort);
    if (!opened || shouldAbort()) return false;
    const input = wrapper.querySelector("input");
    if (input) fillTextInputWithoutBlur(input, wanted.slice(0, 30));
    const ready = await waitFor(() => (readSelectOptions(wrapper).length > 0 ? wrapper : null), DROPDOWN_WAIT_TIMEOUT_MS, shouldAbort);
    if (!ready || shouldAbort()) return false;
    const match = findMatchingSelectOption(wanted, readSelectOptions(wrapper));
    if (!match) {
      await closeSelect(wrapper, shouldAbort);
      return false;
    }
    match.el.click();
    await waitFor(() => (isSelectOpen(wrapper) ? null : true), ANTD_DROPDOWN_CLOSE_TIMEOUT_MS, shouldAbort);
    return true;
  }

  // The country code lives in the separate dial-code select, so the
  // phone number field takes only the national number — reduce to
  // digits and drop a leading NANP "1".
  function stripDialCode(answer) {
    let digits = String(answer ?? "").replace(/\D/g, "");
    if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
    return digits;
  }

  // ---- field detection ------------------------------------------------------

  // Date controls are readonly comboboxes (aria-haspopup="dialog") that
  // Eightfold pre-fills with today's date for the e-signature — leave
  // them alone.
  function isPrefilledDate(el) {
    return el?.getAttribute?.("aria-haspopup") === "dialog" || Boolean(el?.readOnly && el?.getAttribute?.("role") === "combobox");
  }
  function isRequired(el, labelEl) {
    if (el?.required || el?.getAttribute?.("aria-required") === "true") return true;
    if (el?.querySelector?.('[aria-required="true"], [required]')) return true;
    if (labelEl?.classList?.contains("required") || /\*$/.test((labelEl?.textContent || "").trim())) return true;
    return false;
  }

  // Resolve user-facing question text for a control identified by data-test-id.
  function getQuestionText(el, fieldId) {
    // aria-labelledby on the combobox input points at the question text element.
    const labelledBy = el.querySelector?.("[aria-labelledby]")?.getAttribute("aria-labelledby") || el.getAttribute?.("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent)
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) return text;
    }
    const labelFor = document.querySelector(`label[for="${cssEscape(fieldId)}"]`);
    if (labelFor?.textContent) return labelFor.textContent.replace(/\s+/g, " ").trim();
    const ariaLabel = el.getAttribute?.("aria-label") || el.querySelector?.("input")?.getAttribute("aria-label");
    if (ariaLabel && !/^select(\s+date)?$/i.test(ariaLabel.trim())) return ariaLabel.replace(/\s+/g, " ").trim();
    const wrapLabel = el.closest?.("label")?.textContent;
    if (wrapLabel) return wrapLabel.replace(/\s+/g, " ").trim();
    const sourceEl = el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? el : el.querySelector?.("input,textarea");
    const placeholder = sourceEl?.getAttribute?.("placeholder");
    if (placeholder && !/^select$/i.test(placeholder.trim())) return placeholder.replace(/\s+/g, " ").trim();
    return fieldId;
  }

  // Build a question entry for a single control element, or null if it
  // should be skipped. One document-order pass over every candidate so
  // the detected questions follow the form's visual top-to-bottom order
  // (Resume → Contact → screener Questions → EEO → e-signature) instead
  // of being grouped by type.
  function buildFieldEntry(el, seen) {
    // Custom select widget (Yes/No screeners, EEO, country, dial code, …).
    if (hasSelectClass(el) && el.getAttribute("data-test-id")) {
      const fieldId = el.getAttribute("data-test-id");
      if (seen.has(fieldId) || !isElementVisible(el)) return null;
      seen.add(fieldId);
      const isPhoneCountry = PHONE_COUNTRY_CODE_RE.test(fieldId);
      const isSearch = SEARCH_SELECT_RE.test(fieldId);
      const question = isPhoneCountry ? PHONE_COUNTRY_QUESTION : getQuestionText(el, fieldId);
      return {
        question,
        fieldId,
        fieldKind: isSearch ? "select-search" : "select",
        field: el,
        control: el,
        options: [], // read live on open
        required: isRequired(el),
      };
    }

    // Resume upload (hidden file input in the dropzone).
    if (el.tagName === "INPUT" && el.type === "file") {
      if (seen.has("resume")) return null;
      seen.add("resume");
      return { question: "Resume/CV", fieldId: "resume", fieldKind: "resume", field: el, control: el, options: [], required: false };
    }

    // Consent/acknowledgement checkboxes (e.g. the e-signature "Agree"
    // box). Modelled Yes/No, checked unless the answer is explicitly
    // negative. The data-test-id usually sits on a wrapper, not the
    // input, so resolve via closest().
    if (el.tagName === "INPUT" && el.type === "checkbox") {
      const holder = el.getAttribute("data-test-id") ? el : el.closest("[data-test-id]");
      const fieldId = holder?.getAttribute("data-test-id");
      if (!fieldId || seen.has(fieldId) || el.disabled || !isElementVisible(el)) return null;
      // Only accept a field-level holder that scopes exactly this
      // checkbox — never a broad section wrapper containing several.
      if (holder !== el && holder.querySelectorAll('input[type="checkbox"]').length !== 1) return null;
      const question = getQuestionText(el, fieldId);
      // Skip the "Save my answers for future applications" convenience toggle.
      if (/save\s+(my\s+)?answers/i.test(question)) return null;
      seen.add(fieldId);
      return {
        question,
        fieldId,
        fieldKind: "checkbox-single",
        field: el,
        control: el,
        options: ["Yes", "No"],
        required: Boolean(el.required || el.getAttribute("aria-required") === "true"),
      };
    }

    // Text inputs/textareas with a stable data-test-id. Skip the select
    // widgets' inner search inputs and the prefilled e-signature date.
    if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.getAttribute("data-test-id")) {
      const fieldId = el.getAttribute("data-test-id");
      if (seen.has(fieldId)) return null;
      if (el.type === "hidden" || el.type === "radio") return null;
      if (isSelectControl(el)) return null; // inner search input of a select
      if (isPrefilledDate(el)) return null;
      if (el.disabled || !isElementVisible(el)) return null;
      seen.add(fieldId);
      const labelEl = document.querySelector(`label[for="${cssEscape(fieldId)}"]`);
      const question = getQuestionText(el, fieldId);
      return {
        question,
        fieldId,
        // The phone number field sits next to the dial-code select, so
        // it takes only the national number — see stripDialCode().
        fieldKind: el.tagName === "TEXTAREA" ? "textarea" : PHONE_NUMBER_RE.test(fieldId) ? "phone" : "text",
        field: el,
        control: el,
        options: [],
        required: isRequired(el, labelEl),
      };
    }
    return null;
  }

  function detectFields() {
    if (!isApplicationForm()) return [];
    const seen = new Set();
    const entries = [];
    const candidates = document.querySelectorAll(
      [`${SELECT_WRAPPER_SELECTOR}[data-test-id]`, 'input[type="file"]', 'input[type="checkbox"]', "input[data-test-id]", "textarea[data-test-id]"].join(
        ", "
      )
    );
    for (const el of candidates) {
      const entry = buildFieldEntry(el, seen);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  function isAffirmativeAnswer(answer) {
    if (typeof answer === "boolean") return answer;
    const text = String(answer ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!text) return false;
    return !NEGATIVE_ANSWERS.has(text);
  }

  // A select's data-test-id is on the wrapper, but a plain text/checkbox
  // field's data-test-id is on the input itself — re-resolve against
  // the live DOM in case React re-rendered the field between detection
  // and fill.
  function liveControl(fieldId, field) {
    if (fieldId) {
      const byId = document.querySelector(`[data-test-id="${cssEscape(fieldId)}"]`);
      if (byId) return byId;
    }
    return field;
  }
  function resolveTextInput(fieldId, field) {
    const el = liveControl(fieldId, field);
    if (!el) return null;
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") return el;
    return el.querySelector?.("input, textarea") || null;
  }

  // ---- resume upload + parse settle ----------------------------------------

  function getVisibleResumePopup() {
    return (
      Array.from(document.querySelectorAll(MODAL_SELECTOR)).find((m) => {
        if (m.offsetParent === null) return false;
        if (/hidden|closed/i.test(String(m.className || ""))) return false;
        return m.getBoundingClientRect().width > 0;
      }) ?? null
    );
  }
  // Eightfold parses an uploaded résumé and opens a popup during/after
  // the upload while it auto-fills the form. Prefer an explicit
  // confirm/close control; fall back to Escape. Never clicks the final
  // "Submit application" control even if it happens to match a loose
  // button-text scan.
  async function closeResumePopup(shouldAbort = () => false) {
    const popup = await waitFor(() => getVisibleResumePopup(), RESUME_POPUP_WAIT_MS, shouldAbort);
    if (!popup || shouldAbort()) return;
    const buttons = Array.from(popup.querySelectorAll('button, [role="button"], a[role="button"]')).filter(
      (b) => b.offsetParent !== null && !b.disabled && b.getAttribute("aria-disabled") !== "true"
    );
    const text = (b) => (b.textContent || "").replace(/\s+/g, " ").trim();
    const isSubmit = (b) => SUBMIT_TEXT_RE.test(text(b));
    const confirm = buttons.find((b) => !isSubmit(b) && /^(save|done|continue|ok|okay|confirm|got it|use this|accept|yes|next|finish)\b/i.test(text(b)));
    const close = buttons.find((b) => /close|dismiss|cancel/i.test(`${b.getAttribute("aria-label") || ""} ${b.className || ""} ${text(b)}`));
    const target = confirm || close;
    if (target) target.click();
    else document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    // Let the popup animate out so it can't intercept later field clicks.
    await waitFor(() => (getVisibleResumePopup() ? null : true), ANTD_DROPDOWN_CLOSE_TIMEOUT_MS, shouldAbort);
  }
  // Holds fillField's 'resume' case until the parse settles, so a caller
  // that fills other fields right after this resolves isn't racing
  // Eightfold's own prefill of name/email/location from the résumé.
  async function waitForResumeUploadComplete(shouldAbort = () => false) {
    await sleep(RESUME_PARSE_KICKOFF_MS);
    if (shouldAbort()) return;
    await closeResumePopup(shouldAbort);
    await waitFor(() => (document.querySelector(PARSE_SPINNER_SELECTOR) ? null : true), RESUME_PARSE_TIMEOUT_MS, shouldAbort);
    await waitFor(() => {
      const firstName = document.querySelector('[data-test-id="Contact_Information_firstname"]')?.value;
      const email = document.querySelector('[data-test-id="Contact_Information_email"]')?.value;
      return firstName || email ? true : null;
    }, RESUME_PARSE_TIMEOUT_MS, shouldAbort);
    await closeResumePopup(shouldAbort);
  }

  // ---- filling --------------------------------------------------------------

  /** Write an already-resolved answer into a question returned by
   *  detectFields(), dispatched by its fieldKind.
   *  @param {{fieldId:string, fieldKind:string, field:Element, control:Element}} question
   *  @param {*} answer - string for text/textarea/phone/select/select-search;
   *    string|boolean for checkbox-single; {type:"file", fileName, base64,
   *    mimeType} for resume.
   */
  async function fillField(question, answer, { shouldAbort = () => false } = {}) {
    const { fieldId, fieldKind, field, control } = question;
    if (answer == null || shouldAbort()) return;

    switch (fieldKind) {
      case "text":
      case "textarea": {
        const input = resolveTextInput(fieldId, field);
        if (input) fillTextInput(input, String(answer ?? ""));
        return;
      }
      case "phone": {
        const input = resolveTextInput(fieldId, field);
        const digits = stripDialCode(answer);
        if (input && digits) fillTextInput(input, digits);
        return;
      }
      case "select": {
        const wrapper = getSelectWrapper(fieldId, field);
        if (wrapper) await fillSelectField(wrapper, answer, shouldAbort);
        return;
      }
      case "select-search": {
        const wrapper = getSelectWrapper(fieldId, field);
        if (wrapper) await fillSelectSearchField(wrapper, answer, shouldAbort);
        return;
      }
      case "checkbox-single": {
        const liveEl = liveControl(fieldId, field);
        const checkbox = liveEl?.type === "checkbox" ? liveEl : liveEl?.querySelector?.('input[type="checkbox"]');
        if (!checkbox || checkbox.disabled) return;
        const shouldCheck = isAffirmativeAnswer(answer);
        if (checkbox.checked !== shouldCheck) await clickLikeHuman(checkbox.closest("label") || checkbox, { shouldAbort });
        return;
      }
      case "resume": {
        if (!answer || typeof answer !== "object" || answer.type !== "file") return;
        const input = control?.type === "file" ? control : document.querySelector(RESUME_DROPZONE_SELECTOR);
        if (!input || shouldAbort()) return;
        fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        await waitForResumeUploadComplete(shouldAbort);
        return;
      }
      default:
        return;
    }
  }

  NS.eightfold = {
    isAutofillAvailable,
    advance,
    detectFields,
    fillField,
    getSubmitButton,
  };
})();
