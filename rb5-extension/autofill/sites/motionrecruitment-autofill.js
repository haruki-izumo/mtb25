/* =====================================================================
 * autofill/sites/motionrecruitment-autofill.js — motionrecruitment.com
 * job-detail application form.
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/motionrecruitment/autofill.js.
 * That file's own field-filling MECHANICS are NOT re-implemented here —
 * they're exactly what autofill/engine/dom-interactions.js already
 * provides as window.ProactiveAutofillEngine, so this file calls into
 * that instead.
 *
 * motionrecruitment.com renders a single, fixed "simple job
 * application" form inline on the job-detail page once the primary
 * "Apply" button is pressed (no navigation, no iframe). The form lives
 * in `form.form__job-application` and always exposes the same five
 * logical fields:
 *   - First Name / Last Name / Email — plain text inputs.
 *   - Phone Number — a react-international-phone widget
 *     (`input[name="phone"][type="tel"]`, prefilled with the dial code,
 *     e.g. "+1 ") next to a country-selector button. The widget only
 *     keeps a value that STARTS WITH "+<dial code>": anything else
 *     ("(415) 555-2671", "4155552671") is silently reset back to the
 *     bare "+1 " prefill, so the phone handler below normalizes the
 *     answer to E.164 first (see formatPhoneAnswer/getPhoneDialCode).
 *   - Upload Your Resume — `input[type="file"]` (.doc/.docx/.pdf/.rtf/
 *     .odt/.html, ≤2 MB) inside a `.file-uploader` fieldset.
 * There are no screening questions, cover-letter field, or conditional
 * follow-ups on the postings this was ported from. Labels are clean
 * (`<label for="...">First Name:<span> *</span></label>`); the trailing
 * colon and required star are stripped for the question text.
 *
 * There is no further Next/Continue step once the form is open — the
 * only "advance" is the posting page's "Apply" button revealing this
 * same-URL inline form (sometimes inside a modal dialog).
 *
 * OUT OF SCOPE (left to Big Banana's own existing systems, untouched):
 *   - reCAPTCHA. Submit runs an invisible v3 check; a low score swaps in
 *     a v2 CHECKBOX fallback widget that disables Submit until solved.
 *     Clicking Submit is just clicking a button like any other — none
 *     of the v2 challenge detection/solving is ported.
 *   - Free-text ANSWER GENERATION — not needed here anyway, since every
 *     field on this form is a plain named field (name/email/phone/
 *     resume), not an open screening question.
 * ===================================================================== */
(function () {
  "use strict";

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const { sleep, fillTextInput, fillFileInput, clickLikeHuman, getFileInputInsideField } = engine;

  const APPLICATION_FORM_SELECTOR = 'form.form__job-application, form[class*="job-application" i]';
  const SUBMIT_BUTTON_SELECTOR = "#submit-job-application";
  const SUBMIT_BUTTON_ID = "submit-job-application";
  const OPEN_APPLICATION_RE = /^apply\b/i;
  const FILE_REMOVE_WAIT_TIMEOUT_MS = 2500;

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/"/g, '\\"');
  }
  // `\s` already covers the non-breaking spaces these labels use.
  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\*/g, "")
      .replace(/\s+/g, " ")
      .replace(/:\s*$/, "")
      .trim();
  }

  function getApplicationForm() {
    const form = document.querySelector(APPLICATION_FORM_SELECTOR);
    if (form) return form;
    // Fall back to whichever form actually owns the submit control.
    return document.querySelector(SUBMIT_BUTTON_SELECTOR)?.closest("form") || null;
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

  function isElementVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  // Returns the label element for a given control/wrapper pair — the
  // same element used by both getQuestionText (visible text) and
  // isRequired (the asterisk marker).
  function getLabelElement(control, wrapper) {
    return wrapper?.querySelector(".Form_module_label, label") || (control.id ? document.querySelector(`label[for="${cssEscape(control.id)}"]`) : null);
  }

  // Required fields are marked with a `<span> *</span>` inside the
  // label. The native `required` attribute may or may not be set —
  // check both.
  function isRequired(control, wrapper) {
    if (control.required || control.getAttribute("aria-required") === "true") return true;
    const label = getLabelElement(control, wrapper);
    return label ? /\*/.test(label.textContent || "") : false;
  }

  // The visible question text lives in the wrapper's `.Form_module_label`
  // (file fields keep the same label markup inside their `.file-uploader`
  // fieldset, which is why detection always resolves the wrapper to that
  // fieldset first — the resume's bare `<input>` loses its label once a
  // file is uploaded and the box switches to its "uploaded" view). Falls
  // back to the input's own aria-label/placeholder so this survives minor
  // markup changes.
  function getQuestionText(control, wrapper) {
    const label = getLabelElement(control, wrapper);
    const fromLabel = normalizeText(label?.textContent || "");
    if (fromLabel) return fromLabel;
    return normalizeText(control.getAttribute("aria-label") || control.getAttribute("placeholder") || "");
  }

  // react-international-phone prefills the input with the dial code
  // (e.g. "+1 "). Treat the whole control as a phone field so the
  // fillField handler can reset that prefill before injecting the answer.
  function isPhoneControl(control) {
    return control.type === "tel" || control.classList.contains("react-international-phone-input") || control.name === "phone";
  }

  // react-international-phone accepts ONLY a value that starts with
  // "+<dial code>": it re-parses the typed string against the selected
  // country and silently drops anything without the leading "+"
  // ("(415) 555-2671" and "4155552671" both collapse back to the "+1 "
  // prefill; "+14155552671" and "+1 415 555 2671" both stick as
  // "+1 (415) 555-2671"). Normalize the answer to E.164:
  //   - an explicit "+" prefix is kept (digits only after it);
  //   - under +1 (the board's default country): a <=10-digit national
  //     number gets the +1 prefix, an 11-digit number with a leading 1
  //     already carries it, anything longer is assumed to include its
  //     own country code;
  //   - under another selected country: the national trunk "0" is
  //     dropped and the dial code prefixed.
  // Non-string answers (skip/file objects) pass through untouched.
  function formatPhoneAnswer(answer, dialCode = "1") {
    if (answer && typeof answer === "object") return answer;
    const value = String(answer ?? "").trim();
    if (!value) return "";
    const digits = value.replace(/\D/g, "");
    if (!digits) return "";
    const code = String(dialCode ?? "").replace(/\D/g, "") || "1";
    if (value.startsWith("+")) return `+${digits}`;
    if (code === "1") {
      if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
      if (digits.length <= 10) return `+1${digits}`;
      return `+${digits}`;
    }
    return `+${code}${digits.startsWith("0") ? digits.slice(1) : digits}`;
  }

  // The dial code the widget is currently set to: the "+1 " prefill on
  // the input itself, else the selected country option's dial-code
  // span, else +1 (US board default).
  function getPhoneDialCode(input) {
    const prefill = String(input?.value ?? "").match(/^\+\s*(\d{1,3})/);
    if (prefill) return prefill[1];
    const container = input?.closest(".react-international-phone-input-container") || document;
    const selected = container.querySelector(
      '.react-international-phone-country-selector-dropdown [aria-selected="true"] .react-international-phone-country-selector-dropdown__list-item-dial-code'
    );
    const fromOption = String(selected?.textContent ?? "").replace(/\D/g, "");
    return fromOption || "1";
  }

  // ---- detection ------------------------------------------------------------

  function detectFields() {
    const form = getApplicationForm();
    if (!form) return [];
    const entries = [];
    const seen = new Set();

    for (const control of form.querySelectorAll("input, textarea, select")) {
      if (control.type === "hidden" || control.disabled || control.readOnly) continue;
      const fieldId = control.name || control.id;
      if (!fieldId || seen.has(fieldId)) continue;
      const wrapper = control.closest(".Form_module_inputWrapper, .file-uploader, fieldset") || control.closest("div");
      const question = getQuestionText(control, wrapper);
      if (!question) continue;
      const required = isRequired(control, wrapper);

      // Resume upload (file input inside the `.file-uploader` fieldset).
      if (control.type === "file") {
        const fileWrapper = control.closest(".file-uploader, fieldset") || control.parentElement;
        entries.push({ question, fieldId, fieldKind: "resume", field: fileWrapper || control, control, options: [], required });
        seen.add(fieldId);
        continue;
      }
      if (isPhoneControl(control)) {
        entries.push({ question, fieldId, fieldKind: "phone", field: control, control, options: [], required });
        seen.add(fieldId);
        continue;
      }
      if (control.tagName === "TEXTAREA") {
        entries.push({ question, fieldId, fieldKind: "textarea", field: control, control, options: [], required });
        seen.add(fieldId);
        continue;
      }
      // First Name / Last Name / Email and any other plain text-like inputs.
      entries.push({ question, fieldId, fieldKind: "text", field: control, control, options: [], required });
      seen.add(fieldId);
    }
    return entries;
  }

  // ---- submit / flow advance -------------------------------------------------

  function getSubmitButton() {
    return document.querySelector(SUBMIT_BUTTON_SELECTOR) || document.querySelector(`${APPLICATION_FORM_SELECTOR} button[type="submit"]`);
  }
  function isApplicationFormOpen() {
    return Boolean(getSubmitButton() || document.querySelector(APPLICATION_FORM_SELECTOR));
  }

  // Any visible modal/dialog popup — the application form itself can
  // render inside one (`#job-view-application-modal` /
  // `.Modal_module_modalWrapper`). The posting's "Apply" button stays in
  // the DOM behind such a popup, so treat a popup as "do not look for
  // the open-application button".
  function isApplicationPopupOpen() {
    const overlays = document.querySelectorAll('#job-view-application-modal, [class*="modalWrapper" i], dialog[open], [aria-modal="true"], [role="dialog"]');
    for (const overlay of overlays) {
      if (isElementVisible(overlay)) return true;
    }
    return false;
  }

  // The posting's primary "Apply" button opens the inline form. It is a
  // plain navigation button, not the in-form final submit — exclude
  // `#submit-job-application` and any control inside the form so this
  // can never return submit. When a popup is open, the Apply button is
  // just sitting behind it — ignore it so this doesn't try to re-open an
  // already-open form.
  function getOpenApplicationButton() {
    if (isApplicationFormOpen() || isApplicationPopupOpen()) return null;
    for (const element of document.querySelectorAll('button, a[role="button"], a')) {
      if (element.id === SUBMIT_BUTTON_ID) continue;
      if (element.type === "submit") continue;
      if (element.closest(APPLICATION_FORM_SELECTOR)) continue;
      const label = normalizeText(element.getAttribute("aria-label") || element.textContent || "");
      if (!OPEN_APPLICATION_RE.test(label)) continue;
      if (!isElementVisible(element)) continue;
      return element;
    }
    return null;
  }

  // The only "step": open the inline application form from the posting.
  // There's nothing further to advance once it's open.
  async function advance({ shouldAbort = () => false } = {}) {
    if (isApplicationFormOpen() || shouldAbort()) return false;
    const openButton = getOpenApplicationButton();
    if (!openButton) return false;
    await clickLikeHuman(openButton, { shouldAbort });
    return true;
  }

  function isAutofillAvailable() {
    return Boolean(isApplicationFormOpen() || getOpenApplicationButton());
  }

  // ---- filling ----------------------------------------------------------------

  /** Write an already-resolved answer into a question returned by
   *  detectFields(), dispatched by its fieldKind.
   *  @param {{field:Element, control:Element, fieldKind:string}} question
   *  @param {*} answer - string for text/textarea/phone;
   *    {type:"file", fileName, base64, mimeType} for resume.
   */
  async function fillField(question, answer, { shouldAbort = () => false } = {}) {
    const { field, control, fieldKind } = question;
    if (answer == null || shouldAbort()) return;

    switch (fieldKind) {
      case "text": {
        const input = control?.tagName === "INPUT" ? control : field?.querySelector?.("input");
        if (input) fillTextInput(input, String(answer ?? ""));
        return;
      }
      case "textarea": {
        const textarea = control?.tagName === "TEXTAREA" ? control : field?.querySelector?.("textarea");
        if (textarea && typeof answer === "string") fillTextInput(textarea, answer);
        return;
      }
      case "phone": {
        const input = control?.tagName === "INPUT" ? control : field?.querySelector?.("input");
        if (!input) return;
        // E.164 with the widget's own dial code — a value without the
        // leading "+<code>" is discarded by react-international-phone.
        const phone = formatPhoneAnswer(answer, getPhoneDialCode(input));
        if (typeof phone !== "string" || !phone) return;
        // Clear the dial-code prefill first so react-international-phone
        // re-parses the full answer instead of appending it after the
        // existing "+1 ". The widget re-renders the value in its own
        // display format ("+1 (415) 555-2671"), which fillTextInput's
        // re-assert then sees as a different non-empty value and leaves
        // alone.
        input.focus();
        fillTextInput(input, "");
        fillTextInput(input, phone);
        return;
      }
      case "resume": {
        if (!answer || typeof answer !== "object" || answer.type !== "file") return;
        let input = getFileInputInsideField(field);
        if (!input) return;
        if (input.files && input.files.length > 0) {
          const removeButton = field?.querySelector?.('[aria-label="Remove file"], .file-uploader__file-actions_remove');
          if (removeButton) {
            removeButton.click();
            const emptyInput = await waitFor(() => {
              const next = getFileInputInsideField(field);
              return next && (!next.files || next.files.length === 0) ? next : null;
            }, FILE_REMOVE_WAIT_TIMEOUT_MS, shouldAbort);
            if (shouldAbort()) return;
            if (emptyInput) input = emptyInput;
          }
        }
        fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        return;
      }
      default:
        return;
    }
  }

  NS.motionrecruitment = {
    isAutofillAvailable,
    advance,
    detectFields,
    fillField,
    getSubmitButton,
  };
})();
