/* =====================================================================
 * autofill/sites/personio-autofill.js — Personio careers sites
 * (*.jobs.personio.com).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/personio/autofill.js. Personio
 * renders a flat, single-step "DynamicForm": clicking "Apply for this
 * job" flips the URL to `?apply` and reveals the application form IN
 * PLACE on the same page — there's no separate application document, no
 * multi-step wizard, and no login gate.
 *
 * Personio's CSS module class names are content-hashed per deploy (e.g.
 * DynamicForm_textField__r9bZB), so detection below anchors on the
 * STABLE companion classes Personio also emits (name-group-container,
 * document-field-wrapper, career-submit-application-btn,
 * action-form-toggle) and on the stable element ids every control
 * carries (`#field-<key>` for an ordinary question, `#doc-input-<cat>`
 * for an upload slot).
 *
 * Ported, structural-only:
 *   - field enumeration: the first/last name group, every
 *     label[for="field-*"] control (text/email/tel/date/select/
 *     textarea), and the Documents section's CV / cover-letter file
 *     slots (other document categories — employment reference, other —
 *     have no profile source to fill them from and are left alone, same
 *     as BidHub's own DOCUMENT_ANSWER_TYPE allowlist)
 *   - value-filling per field kind, including the loose-date parser a
 *     native <input type="date"> needs (it only accepts an ISO
 *     yyyy-mm-dd value, but a caller-supplied answer may be free text
 *     like "January 2020")
 *   - the "Apply for this job" reveal-the-form toggle and final-submit
 *     detection
 *
 * SYSTEM_QUESTION below is BidHub's own mapping from Personio's stable,
 * language-independent `name` keys (first_name, email, ...) to clean
 * English question text — ported as-is since the careers site itself is
 * localized (German, etc.) but these keys never change, so a caller
 * matching by question text gets a stable label regardless of page
 * language.
 *
 * Explicitly NOT ported (same AI-answer/CAPTCHA boundary every other
 * autofill/sites/*.js port keeps):
 *   - BidHub's own free-text answer generation (getAnswer()) and its
 *     resume/cover-letter profile lookups (getResumeForAutofill(),
 *     getCoverLetterForAutofill()) — a caller of this file supplies the
 *     already-resolved answer; detectFields() only classifies each
 *     question's structural type, fillField() only writes it.
 *   - The embedding-similarity fallback BidHub falls back to when a
 *     <select> answer doesn't match any option by exact/prefix text —
 *     this file's own matching stops at exact/prefix, same boundary
 *     lever-autofill.js/bamboohr-autofill.js keep. An unmatched option is
 *     left for Big Banana's own generic AI-answer pipeline.
 *   - The dependent-question reordering (isDependentQuestion) that only
 *     mattered for sequencing AI answers.
 *   - CAPTCHA / proxy-CDP input lanes — not applicable here.
 * ===================================================================== */
(function () {
  "use strict";

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const { sleep, fillTextInput, fillSelectInput, fillFileInput, clickLikeHuman, getNativeSelect, getTextarea, getFileInputInsideField } = engine;

  // ---- text helpers -------------------------------------------------------

  function cleanText(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Strip the required asterisk span + the sr-only "(required)"/"(erforderlich)"/
  // "(optional)"/"(Pflichtfeld)" suffix so the question is the bare prompt text.
  function cleanLabelText(label) {
    if (!label) return "";
    const text = cleanText(label.textContent).replace(/\*/g, "");
    return cleanText(text.replace(/\s*\((?:required|erforderlich|optional|pflichtfeld)\)\s*$/i, ""));
  }

  // Required is signalled by the aria-hidden asterisk span (or the sr-only
  // "(required)"/"(erforderlich)" text) rather than always being mirrored onto
  // the control's own `required` attribute.
  function isFieldRequired(label, control) {
    const asterisk = label?.querySelector('span[aria-hidden="true"]');
    if (asterisk && cleanText(asterisk.textContent).includes("*")) return true;
    if (label && /\((?:required|erforderlich|pflichtfeld)\)/i.test(label.textContent || "")) return true;
    return Boolean(control?.required);
  }

  function answerToText(answer) {
    if (answer == null || typeof answer === "object") return "";
    return cleanText(answer);
  }

  // Personio's own stable system-field keys -> clean, language-independent
  // question text (see file header).
  const SYSTEM_QUESTION = {
    first_name: "First name",
    last_name: "Last name",
    email: "Email address",
    phone: "Phone number",
    location: "Location (city)",
    available_from: "Earliest date available to start",
    salary_expectations: "Expected salary",
    birthday: "Date of birth",
    gender: "Gender",
  };

  // Document category (from `#doc-input-<category>`) -> this file's own
  // stable fieldId. Only cv/cover-letter map to something fillable.
  const DOCUMENT_FIELD_ID = { cv: "resume", "cover-letter": "cover_letter" };

  function questionFor(control, label) {
    return SYSTEM_QUESTION[control.name] || cleanLabelText(label) || cleanText(control.getAttribute("placeholder")) || control.name || "";
  }

  // ---- form / control lookup ----------------------------------------------

  // The DynamicForm only exists once "Apply for this job" has been clicked;
  // every field control carries a `#field-<key>` id, so one's presence also
  // doubles as the "is the form open" signal.
  function getForm() {
    const control = document.querySelector('input[id^="field-"], select[id^="field-"], textarea[id^="field-"]');
    if (!control) return null;
    return control.closest("form") || document.querySelector("form");
  }

  function labelForControl(control) {
    if (!control?.id) return null;
    return document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
  }

  // ---- loose date parsing ---------------------------------------------
  // Native <input type="date"> only accepts an ISO yyyy-mm-dd value, but a
  // caller-supplied answer (profile data, an AI-resolved string, ...) may be
  // loose free text like "January 2020" or "03/2020" — same parser BidHub's
  // own date-utils.js module uses, trimmed to just what this field needs.

  const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  function parseLooseDate(value) {
    const text = String(value ?? "").trim();
    if (!text) return null;
    let match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
    match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (match) {
      const year = match[3].length === 2 ? `20${match[3]}` : match[3];
      return `${year}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
    }
    match = text.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
    if (match) {
      const monthIndex = MONTH_NAMES.findIndex((name) => name.startsWith(match[1].toLowerCase()));
      if (monthIndex >= 0) return `${match[3]}-${String(monthIndex + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}`;
    }
    return null;
  }

  // ---- detection ------------------------------------------------------

  /**
   * Walk Personio's DynamicForm and return every question this adapter
   * knows how to fill deterministically: the name group, every labelled
   * text/email/tel/date/select/textarea control, and the CV / cover-letter
   * document slots. Anything else (an unmapped document category, or a
   * control with no derivable question) is left out entirely, for Big
   * Banana's own generic/AI pipeline to pick up per the scope note above.
   *
   * @returns {Array<{question:string, fieldId:string, field:Element,
   *   control:Element, fieldKind:string, options:string[]|null,
   *   required:boolean}>}
   */
  function detectFields() {
    const form = getForm();
    if (!form) return [];
    const entries = [];
    const usedFieldIds = new Set();
    const handledControls = new Set();

    function addEntry(entry) {
      if (!entry.question || !entry.fieldId || !entry.field) return;
      if (usedFieldIds.has(entry.fieldId)) return;
      usedFieldIds.add(entry.fieldId);
      if (entry.field instanceof Element) handledControls.add(entry.field);
      entries.push({ options: null, required: false, ...entry });
    }

    // First/last name group: two inputs under one "Name" label. The
    // sub-input sr-only labels ("First"/"Last") are weak, so map via
    // SYSTEM_QUESTION; the group label carries the shared required marker.
    function addNameGroup(groupContainer) {
      const groupLabel =
        groupContainer.querySelector('[id$="name-group-label"], .form-label') ||
        document.getElementById(groupContainer.getAttribute("aria-labelledby") || "");
      for (const input of groupContainer.querySelectorAll('input[id^="field-"]')) {
        addEntry({
          question: questionFor(input, labelForControl(input)),
          fieldId: input.id,
          fieldKind: "text",
          field: input,
          control: input,
          required: isFieldRequired(groupLabel, input),
        });
      }
    }

    // A standard labelled field: label[for="field-<key>"] + a control.
    // Dispatch by control kind (select / date / textarea / text|email|tel|...).
    function addLabelledField(label) {
      const fieldId = label.getAttribute("for");
      if (!fieldId || usedFieldIds.has(fieldId)) return;
      const control = document.getElementById(fieldId);
      if (!control || handledControls.has(control)) return;
      const question = questionFor(control, label);
      if (!question) return;
      const required = isFieldRequired(label, control);

      if (control.tagName === "SELECT") {
        // Native dropdown. Options come from the live <option> list
        // (excluding the empty "Please select" placeholder). Custom
        // custom_attribute_* selects carry localized option text.
        const options = Array.from(control.options)
          .filter((option) => option.value !== "")
          .map((option) => cleanText(option.textContent))
          .filter(Boolean);
        addEntry({ question, fieldId, fieldKind: "select-native", field: control, control, options, required });
        return;
      }
      if (control.tagName === "TEXTAREA") {
        addEntry({ question, fieldId, fieldKind: "textarea", field: control, control, required });
        return;
      }
      if (control.tagName === "INPUT") {
        const type = (control.getAttribute("type") || "text").toLowerCase();
        if (["hidden", "file", "submit", "button", "reset", "checkbox", "radio"].includes(type)) return;
        addEntry({ question, fieldId, fieldKind: type === "date" ? "date" : "text", field: control, control, required });
      }
    }

    // Documents section: each category wraps a hidden multi-file input.
    // Map only the categories a caller could plausibly have a file for.
    function addDocumentField(wrapper) {
      const fileInput = wrapper.querySelector('input[type="file"][id^="doc-input-"]');
      if (!fileInput) return;
      const category = fileInput.id.replace(/^doc-input-/, "");
      const fieldId = DOCUMENT_FIELD_ID[category];
      if (!fieldId) return; // employment-reference / other: no mapped source
      const labelNode =
        document.getElementById(wrapper.getAttribute("aria-labelledby") || "") || wrapper.querySelector('[class*="documentCategoryLabel"]');
      addEntry({
        question: cleanLabelText(labelNode) || (fieldId === "resume" ? "CV / Résumé" : "Cover letter"),
        fieldId,
        fieldKind: "document",
        field: wrapper,
        control: fileInput,
        required: false,
      });
    }

    // Single document-order walk so a caller sees questions in visual order.
    const anchors = form.querySelectorAll('.name-group-container, label[for^="field-"], .document-field-wrapper');
    for (const node of anchors) {
      if (node.matches(".name-group-container")) addNameGroup(node);
      else if (node.matches(".document-field-wrapper")) addDocumentField(node);
      else addLabelledField(node);
    }
    return entries;
  }

  // ---- submit / advance -------------------------------------------------

  function getSubmitButton() {
    const form = getForm();
    const root = form || document;
    return (
      root.querySelector('button[type="submit"].career-submit-application-btn') ||
      root.querySelector("button.career-submit-application-btn") ||
      (form ? form.querySelector('button[type="submit"]') : null)
    );
  }

  // The posting page's only forward action: the "Apply for this job" toggle
  // that flips the URL to `?apply` and reveals the inline form. Once the
  // form is open there's no further in-page navigation — only the gated
  // final submit at the bottom.
  function getApplyToggle() {
    if (getForm()) return null;
    const candidates = Array.from(document.querySelectorAll('a.action-form-toggle, a[href*="?apply"], button.career-btn-primary, a.career-btn-primary'));
    return candidates.find((el) => /apply|bewerb/i.test(el.textContent || "")) || candidates[0] || null;
  }

  // One step of Personio's posting -> form flow. Never clicks the final
  // Submit button — that's clickSubmitButton()'s job, a separate explicit
  // call (same split lever-autofill.js/bamboohr-autofill.js use).
  async function advance({ shouldAbort = () => false } = {}) {
    if (getSubmitButton()) return false;
    const toggle = getApplyToggle();
    if (!toggle || shouldAbort()) return false;
    await clickLikeHuman(toggle, { shouldAbort });
    return true;
  }

  // Clicking Submit is a user-equivalent action (same call lever-autofill.js
  // and bamboohr-autofill.js make) — it isn't bypassing anything Personio
  // itself gates.
  async function clickSubmitButton({ shouldAbort = () => false } = {}) {
    const button = getSubmitButton();
    if (!button || shouldAbort()) return false;
    await clickLikeHuman(button, { shouldAbort });
    return true;
  }

  function isAutofillAvailable() {
    return Boolean(getForm() || getApplyToggle());
  }

  // ---- filling ----------------------------------------------------------

  function findMatchingOption(select, want) {
    const options = Array.from(select.options).filter((option) => option.value !== "");
    const norm = (value) => cleanText(value).toLowerCase();
    const wantNorm = norm(want);
    return (
      options.find((option) => norm(option.textContent) === wantNorm || norm(option.value) === wantNorm) ||
      options.find((option) => norm(option.textContent).startsWith(wantNorm) || wantNorm.startsWith(norm(option.textContent))) ||
      null
    );
  }

  function encodeTextAsBase64(text) {
    const bytes = new TextEncoder().encode(String(text ?? ""));
    let binary = "";
    bytes.forEach((byte) => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary);
  }

  // Personio's cover-letter slot is FILE-ONLY (no inline textbox) — a plain
  // string answer still has to land as an attachment, so wrap it as a .txt
  // file rather than silently dropping it.
  function wrapTextAsFile(text, fileName) {
    return { type: "file", fileName, mimeType: "text/plain", base64: encodeTextAsBase64(text) };
  }

  /**
   * Write an already-resolved answer into a question returned by
   * detectFields(), dispatched by its fieldKind.
   *
   * @param {{fieldKind:string, field:Element, control:Element}} entry
   * @param {*} answer - string for text/textarea/date/select-native;
   *   {type:"file", fileName, base64, mimeType} for document (a plain
   *   string is also accepted for the cover-letter slot and wrapped as a
   *   .txt attachment, since that slot has no text box of its own).
   * @returns {Promise<boolean>} true if something was written.
   */
  async function fillField(entry, answer) {
    if (!entry || answer == null) return false;
    const { fieldKind, control } = entry;
    switch (fieldKind) {
      case "text": {
        const value = answerToText(answer);
        if (!value || control?.tagName !== "INPUT") return false;
        fillTextInput(control, value);
        return true;
      }
      case "textarea": {
        const value = answerToText(answer);
        if (!value) return false;
        const textarea = control?.tagName === "TEXTAREA" ? control : getTextarea(control);
        if (!textarea) return false;
        fillTextInput(textarea, value);
        return true;
      }
      case "date": {
        const raw = answerToText(answer);
        if (!raw || control?.tagName !== "INPUT") return false;
        fillTextInput(control, parseLooseDate(raw) || raw);
        return true;
      }
      case "select-native": {
        const want = answerToText(answer);
        if (!want) return false;
        const select = control?.tagName === "SELECT" ? control : getNativeSelect(control);
        if (!select) return false;
        const chosen = findMatchingOption(select, want);
        if (!chosen) return false;
        fillSelectInput(select, chosen.value);
        return true;
      }
      case "document": {
        let fileAnswer = answer;
        if (typeof fileAnswer === "string") fileAnswer = wrapTextAsFile(fileAnswer, "cover-letter.txt");
        if (!fileAnswer || typeof fileAnswer !== "object" || fileAnswer.type !== "file") return false;
        const fileInput = control || getFileInputInsideField(entry.field);
        if (!fileInput) return false;
        fillFileInput(fileInput, fileAnswer.fileName, fileAnswer.base64, fileAnswer.mimeType);
        await sleep(150);
        return true;
      }
      default:
        return false;
    }
  }

  NS.personio = {
    isAutofillAvailable,
    advance,
    detectFields,
    fillField,
    getSubmitButton,
    clickSubmitButton,
  };
})();
