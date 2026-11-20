/* =====================================================================
 * autofill/sites/comeet-autofill.js — Comeet ("Spark Hire Recruit")
 * careers postings.
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/comeet/autofill.js. That
 * file's own field-filling MECHANICS are NOT re-implemented here —
 * they're exactly what autofill/engine/dom-interactions.js already
 * provides as window.ProactiveAutofillEngine, so this file calls into
 * that instead.
 *
 * Comeet's job posting lives on
 * `www.comeet.com/jobs/<company>/<companyUid>/<slug>/<positionUid>`
 * but the actual application form is an AngularJS app served inside a
 * CROSS-ORIGIN iframe at
 * `https://www.comeet.co/jobs/<companyUid>/<positionUid>/apply` (note
 * the `.co`, not `.com`). Some embeds render that iframe inline at
 * load; others only create it after clicking an "Apply for this job"
 * button on the parent `.com` page. This single script is meant to run
 * in BOTH frames (all_frames: true) — in the parent `.com` frame
 * `#applyForm` is absent, so detectQuestions() finds nothing and
 * advanceFlow() clicks "Apply for this job" to reveal the iframe; in
 * the `.co` iframe the form fields are detected and filled.
 *
 * OUT OF SCOPE (left to Big Banana's own existing systems, untouched):
 *   - Free-text screening-question ANSWER GENERATION
 *     (getAnswer()/ai-core/embedding-similarity matching). BidHub's own
 *     comeet-dropdown handler falls back to an embedding-similarity
 *     match when no exact/prefix/substring option matches — that
 *     fallback is NOT ported; a dropdown this can't place
 *     deterministically is simply left unfilled for Big Banana's
 *     generic pipeline to try.
 *   - CAPTCHA / proxy-remote-CDP "real input" lanes — neither exists in
 *     this file, same as the rest of this batch.
 *   - BidHub's own answerTypeHandlers/metadata plumbing
 *     (getInputConstraints, password/dependent-question handling) —
 *     that's input INTO the AI-answer pipeline, not structural
 *     detection, so none of it is ported either.
 * ==================================================================== */
(function () {
  "use strict";

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    fillTextInput,
    fillFileInput,
    clickLikeHuman,
    getRadioInputs,
    getFileInputInsideField,
    sleep,
  } = engine;

  const FORM_SELECTOR = "#applyForm";
  const SUBMIT_SELECTOR = "button.applyButton";
  const ADVANCE_TEXT_PATTERN = /apply for this job|apply for this position|apply now/i;
  const ADVANCE_EXCLUDE_PATTERN = /already applied|how to apply|sign ?in|log ?in|register|share/i;

  // ---- text helpers --------------------------------------------------------

  function cleanText(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .replace(/\*/g, "")
      .trim();
  }

  // Comeet's uploads only accept PDF — a generated plain-text cover letter
  // would be silently rejected by the widget, so only a genuinely-PDF file
  // answer is attached to the cover-letter slot.
  function isPdfFileAnswer(answer) {
    if (!answer || typeof answer !== "object" || answer.type !== "file") return false;
    const mimeType = String(answer.mimeType || "").toLowerCase();
    const fileName = String(answer.fileName || "").toLowerCase();
    return mimeType === "application/pdf" || fileName.endsWith(".pdf");
  }

  // The answer backend can return "N/A" for a field it can't answer — fine as
  // free text, but Comeet's `type="url"` inputs reject it as an invalid
  // address (ng-invalid-url) and block submission, so a placeholder answer on
  // a URL field is treated as "leave empty" instead.
  function isPlaceholderAnswer(value) {
    const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return !normalized || normalized === "na" || normalized === "notapplicable" || normalized === "none";
  }

  // Custom-question prompt = the fieldset's <legend class="question-title">.
  function getFieldsetQuestion(fieldset) {
    return cleanText(fieldset.querySelector(".question-title")?.textContent);
  }
  function isFieldsetRequired(fieldset) {
    return Boolean(fieldset.querySelector(".question-title .required-asterisk"));
  }

  // Standard field labels are <label for="<id>">; the visible prompt is the
  // label text minus the required asterisk.
  function labelTextForId(id) {
    if (!id) return "";
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    return cleanText(label?.textContent);
  }
  function isControlRequired(control, label) {
    if (!control) return false;
    if (control.required || control.getAttribute("aria-required") === "true") return true;
    return Boolean(label?.querySelector(".required-asterisk"));
  }

  // Per-option label for a radio/checkbox inside a `ul.options` list.
  function optionTitle(input) {
    if (!input) return "";
    const linked = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
    const fromLinked = cleanText(linked?.querySelector(".option-title")?.textContent || linked?.textContent);
    if (fromLinked) return fromLinked;
    const wrapped = input.closest("li")?.querySelector(".option-title");
    return cleanText(wrapped?.textContent);
  }
  function findOptionAnchorByText(anchors, value) {
    const want = cleanText(value).toLowerCase();
    if (!want) return null;
    const titleOf = (a) => cleanText(a.querySelector(".option-title")?.textContent || a.textContent).toLowerCase();
    return (
      anchors.find((a) => titleOf(a) === want) ||
      anchors.find((a) => titleOf(a).startsWith(want)) ||
      anchors.find((a) => titleOf(a).includes(want)) ||
      null
    );
  }

  // ---- field detection ------------------------------------------------------

  // Maps the native file inputs to a question fieldKind. Portfolio (a third
  // upload slot Comeet sometimes renders) is intentionally left out — there's
  // no profile-backed source for it, same as BidHub's own source.
  const FILE_FIELD_KINDS = new Map([
    ["cv", "resume"],
    ["coverLetter", "cover_letter"],
  ]);

  function detectQuestions() {
    const form = document.querySelector(FORM_SELECTOR);
    if (!form) return [];

    const questions = [];
    const usedFieldIds = new Set();
    function addEntry(entry) {
      if (!entry.question || !entry.fieldId || !entry.field) return;
      if (usedFieldIds.has(entry.fieldId)) return;
      usedFieldIds.add(entry.fieldId);
      questions.push({ options: null, required: false, ...entry });
    }

    // Standard fields live in `.form-group.field-*` blocks keyed by label[for].
    function handleStandardGroup(group) {
      const label = group.querySelector("label[for]");
      const id = label?.getAttribute("for");
      if (!id) return;
      const control = document.getElementById(id);
      if (!control) return;
      // Radio/option controls belong to fieldset questions, not standard fields.
      if (control.type === "radio") return;
      const question = labelTextForId(id);
      if (!question) return;

      if (control.type === "file") {
        const fieldKind = FILE_FIELD_KINDS.get(id);
        if (!fieldKind) return; // skip portfolio / unrecognized uploads
        addEntry({ question, fieldId: fieldKind, field: control, control, fieldKind, required: isControlRequired(control, label) });
        return;
      }
      if (control.type === "checkbox") {
        // GDPR / data-retention consent — a lone checkbox, modeled as
        // Yes/No so an unresolved answer can decline it rather than
        // auto-ticking a mystery opt-in.
        addEntry({
          question,
          fieldId: id,
          field: control,
          control,
          fieldKind: "checkbox-single",
          options: ["Yes", "No"],
          required: isControlRequired(control, label),
        });
        return;
      }
      const fieldKind = control.type === "url" ? "url" : control.tagName === "TEXTAREA" ? "textarea" : "text";
      addEntry({ question, fieldId: id, field: control, control, fieldKind, required: isControlRequired(control, label) });
    }

    // Custom questions: each is a `<fieldset class="fieldset">` rendering one
    // control type (TEXT / TEXT_AREA / RADIO_LIST / DROPDOWN / checkbox MULTIPLE).
    function handleFieldset(fieldset) {
      const question = getFieldsetQuestion(fieldset);
      if (!question) return;
      const fieldId = question; // legend text is stable + unique per posting
      if (usedFieldIds.has(fieldId)) return;
      const required = isFieldsetRequired(fieldset);
      const dropdownToggle = fieldset.querySelector("a.dropdown-toggle");
      const textarea = fieldset.querySelector("textarea");
      const radios = getRadioInputs(fieldset);
      const checkboxes = Array.from(fieldset.querySelectorAll('ul.options input[type="checkbox"]'));
      const textInput = fieldset.querySelector('input[type="text"]');

      if (dropdownToggle) {
        // Options are already in the DOM (`ul.dropdown-menu li .option-title`).
        const options = Array.from(fieldset.querySelectorAll(".dropdown-menu .option-title")).map((n) => cleanText(n.textContent)).filter(Boolean);
        addEntry({ question, fieldId, field: fieldset, control: dropdownToggle, fieldKind: "comeet-dropdown", options: options.length ? options : null, required });
        return;
      }
      if (radios.length) {
        addEntry({ question, fieldId, field: fieldset, control: radios[0], fieldKind: "comeet-radio", options: radios.map(optionTitle).filter(Boolean), required });
        return;
      }
      if (checkboxes.length) {
        addEntry({ question, fieldId, field: fieldset, control: checkboxes[0], fieldKind: "comeet-checkbox-list", options: checkboxes.map(optionTitle).filter(Boolean), required });
        return;
      }
      if (textarea) {
        addEntry({ question, fieldId, field: textarea, control: textarea, fieldKind: "textarea", required });
        return;
      }
      if (textInput) {
        addEntry({ question, fieldId, field: textInput, control: textInput, fieldKind: "text", required });
      }
    }

    // Walk standard groups and custom-question fieldsets in DOM order so the
    // resulting list mirrors the form (e.g. a consent checkbox renders last,
    // after the questionnaires). The `.form-group-questionnaires` wrapper
    // nests the fieldsets, so skip any `.form-group` that contains one.
    for (const node of form.querySelectorAll(".form-group, fieldset.fieldset")) {
      if (node.matches("fieldset.fieldset")) {
        handleFieldset(node);
      } else if (!node.querySelector("fieldset.fieldset")) {
        handleStandardGroup(node);
      }
    }
    return questions;
  }

  // ---- submit + advance ------------------------------------------------------

  function getSubmitButton() {
    const form = document.querySelector(FORM_SELECTOR);
    if (!form) return null;
    return form.querySelector(SUBMIT_SELECTOR) || form.querySelector('button[type="submit"]');
  }

  // On the parent `.com` page the only forward action is the "Apply for this
  // job" button that creates the form iframe. Never present once the form
  // frame itself is running this script.
  function getApplyButton() {
    if (document.querySelector(FORM_SELECTOR)) return null;
    return (
      Array.from(document.querySelectorAll('button, a, [role="button"]')).find((el) => {
        const text = cleanText(el.textContent || el.value || el.getAttribute("aria-label"));
        if (!text || ADVANCE_EXCLUDE_PATTERN.test(text)) return false;
        return ADVANCE_TEXT_PATTERN.test(text);
      }) ?? null
    );
  }

  // The form frame's only forward control is the gated final submit —
  // never auto-click it here. This only crosses the parent-page → iframe
  // boundary.
  async function advanceToApplicationForm({ shouldAbort = () => false } = {}) {
    if (getSubmitButton()) return false;
    const applyButton = getApplyButton();
    if (!applyButton || shouldAbort()) return false;
    await clickLikeHuman(applyButton, { shouldAbort });
    return true;
  }

  async function clickSubmitButton({ shouldAbort = () => false } = {}) {
    const button = getSubmitButton();
    if (!button || shouldAbort()) return false;
    await clickLikeHuman(button, { shouldAbort });
    return true;
  }

  function isAutofillAvailable() {
    return Boolean(document.querySelector(FORM_SELECTOR) || getApplyButton());
  }

  // ---- filling ---------------------------------------------------------------

  async function setChoice(input, shouldBeChecked, { shouldAbort = () => false } = {}) {
    if (Boolean(input.checked) === Boolean(shouldBeChecked)) return;
    await clickLikeHuman(input, { shouldAbort });
  }

  // Exact-or-prefix-or-substring text match only — deliberately NOT the
  // embedding-similarity fallback BidHub's own comeet-dropdown handler uses
  // for a miss here. A dropdown this can't place deterministically is left
  // untouched rather than guessed.
  function findMatchingOptionText(answer, optionTexts) {
    const want = cleanText(answer).toLowerCase();
    if (!want) return null;
    return (
      optionTexts.find((t) => t.toLowerCase() === want) ||
      optionTexts.find((t) => t.toLowerCase().startsWith(want)) ||
      optionTexts.find((t) => t.toLowerCase().includes(want)) ||
      null
    );
  }

  async function fillComeetDropdown(field, answer, { shouldAbort = () => false } = {}) {
    const want = cleanText(answer);
    if (!want || shouldAbort()) return;
    const toggle = field.querySelector("a.dropdown-toggle");
    if (!toggle) return;
    await clickLikeHuman(toggle, { shouldAbort }); // open the menu
    await sleep(80);
    const anchors = Array.from(field.querySelectorAll(".dropdown-menu li a"));
    const chosen = findOptionAnchorByText(anchors, want);
    if (!chosen) {
      // Close the menu again rather than leaving it open with nothing picked.
      if (toggle.getAttribute("aria-expanded") === "true") await clickLikeHuman(toggle, { shouldAbort });
      return;
    }
    await clickLikeHuman(chosen, { shouldAbort });
  }

  function fillFile(answer, field) {
    if (!answer || typeof answer !== "object" || answer.type !== "file") return;
    const fileInput = field?.type === "file" ? field : getFileInputInsideField(field);
    if (!fileInput) return;
    fillFileInput(fileInput, answer.fileName, answer.base64, answer.mimeType);
  }

  /**
   * Write an already-resolved answer into a question returned by
   * detectQuestions(), dispatched by its fieldKind.
   */
  async function fillField(question, answer, { shouldAbort = () => false } = {}) {
    const { field, fieldKind } = question;
    if (answer == null || shouldAbort()) return;

    switch (fieldKind) {
      case "text": {
        const input = field.tagName === "INPUT" ? field : field.querySelector("input");
        if (input) fillTextInput(input, String(answer));
        return;
      }
      case "url": {
        // A placeholder answer like "N/A" is an invalid address on this
        // input type — fill empty instead of a value the widget will
        // reject.
        const input = field.tagName === "INPUT" ? field : field.querySelector("input");
        if (input) fillTextInput(input, isPlaceholderAnswer(answer) ? "" : String(answer));
        return;
      }
      case "textarea": {
        const textarea = field.tagName === "TEXTAREA" ? field : field.querySelector("textarea");
        if (textarea) fillTextInput(textarea, String(answer));
        return;
      }
      case "checkbox-single": {
        // Lone consent checkbox: tick on an affirmative, untick on No.
        const checkbox = field.type === "checkbox" ? field : field.querySelector('input[type="checkbox"]');
        if (!checkbox) return;
        const text = String(answer ?? "").trim().toLowerCase();
        const shouldCheck = answer === true || text === "yes" || text === "true" || text === "agree";
        await setChoice(checkbox, shouldCheck, { shouldAbort });
        return;
      }
      case "comeet-radio": {
        // RADIO_LIST custom question (incl. Yes/No booleans).
        const matchedText = findMatchingOptionText(answer, getRadioInputs(field).map((r) => optionTitle(r)));
        if (!matchedText) return;
        for (const radio of getRadioInputs(field)) {
          if (optionTitle(radio) === matchedText) {
            await setChoice(radio, true, { shouldAbort });
            return;
          }
        }
        return;
      }
      case "comeet-checkbox-list": {
        // MULTIPLE custom question rendered as checkboxes.
        const wanted = (Array.isArray(answer) ? answer : [answer]).map((v) => cleanText(v).toLowerCase()).filter(Boolean);
        if (!wanted.length) return;
        for (const checkbox of field.querySelectorAll('ul.options input[type="checkbox"]')) {
          if (shouldAbort()) return;
          const title = optionTitle(checkbox).toLowerCase();
          const shouldCheck = wanted.some((value) => title === value || title.startsWith(value) || title.includes(value));
          if (shouldCheck) await setChoice(checkbox, true, { shouldAbort });
        }
        return;
      }
      case "comeet-dropdown": {
        await fillComeetDropdown(field, answer, { shouldAbort });
        return;
      }
      case "resume": {
        fillFile(answer, field);
        return;
      }
      case "cover_letter": {
        // Comeet only accepts PDF uploads — attach the cover letter only
        // when it's a genuine PDF; a plain-text answer is skipped rather
        // than attached as a .txt the widget would reject.
        if (isPdfFileAnswer(answer)) fillFile(answer, field);
        return;
      }
      default:
        return;
    }
  }

  NS.comeet = {
    isAutofillAvailable,
    advanceToApplicationForm,
    detectQuestions,
    fillField,
    getSubmitButton,
    clickSubmitButton,
  };
})();
