/* =====================================================================
 * autofill/sites/gusto-autofill.js — Gusto public application flow
 * (jobs.gusto.com / gusto-hiring.com).
 * =====================================================================
 * Ported from BidHub's packages/job-parsers/content/platforms/gusto/
 * autofill.js. The flow spans two URLs via a full navigation (NOT a
 * same-document SPA route):
 *
 *   1. Job posting   `/postings/<slug>` — description + an
 *      `<a href=".../applicants/new">Apply for <title></a>` trigger.
 *      No form yet.
 *   2. Application form `/postings/<slug>/applicants/new` — a
 *      server-rendered Rails form `#job-applicant-form` (action
 *      `/postings/<slug>/applicants`) with the candidate fields,
 *      employer questions, file uploads, and the final
 *      `input[type=submit][name=commit]` ("Submit your application").
 *
 * So "multi-step" here means exactly one forward hop (posting → form)
 * via a real link click, not an in-form wizard — the form itself is a
 * single page. isAutofillAvailable() reports true on the field-less
 * posting page too (so a caller's autonext loop fires) and advance()
 * clicks the apply trigger to cross that hop; on the form page the only
 * forward control is the gated final Submit, which this module never
 * touches.
 *
 * Employer questions are grouped by `...answers_attributes[N]`: each
 * block has a hidden `[N][question_type]` (single_choice | multiple_choice
 * | text), a question label (`label.font-medium`), and either option
 * radios/checkboxes named `[N][selected_option_uuids][]` or a free
 * `[N][text]` input/textarea.
 *
 * IMPORTANT difference from BidHub's own source: BidHub's Gusto module
 * never hardcodes which standard field is "first name" vs "email" — it
 * detects every visible `job_applicant[...]` control generically (by
 * label text) and hands ALL of them, verbatim, to its AI-answer backend
 * (`getAnswer`) to resolve. That backend call is explicitly out of scope
 * for this port (see the bottom of this file). To still let a caller fill
 * from a plain profile object the way Lever/BambooHR's adapters do, this
 * port adds ONE small thing BidHub's own code doesn't have:
 * `classifyProfileKey()`, a label/name heuristic that maps a detected
 * standard field to one of full_name/first_name/last_name/email/phone/
 * linkedin/location when it can, so `fill()` has something deterministic
 * to use. Anything it can't confidently classify (an employer's one-off
 * custom question, or a standard field whose label doesn't match a known
 * pattern) is left alone for Big Banana's existing generic pipeline, same
 * as BidHub's own "can't resolve it structurally" fields were left to its
 * AI backend.
 * ===================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofillEngine) return;
  const dom = window.ProactiveAutofillEngine;
  const { fillTextInput, fillFileInput, getTextInput, getTextarea, getFileInputInsideField, getCheckboxInputs, getRadioInputs, clickLikeHuman } = dom;

  const FORM_SELECTOR = "#job-applicant-form";
  const APPLY_TRIGGER_SELECTOR = 'a[href$="/applicants/new"]';
  const FIELD_KIND_UPLOAD = "upload";
  const FIELD_KIND_CHOICE = "gusto-choice";

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function normalizeComparisonText(value) {
    return normalizeText(value).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }

  // Strip the trailing "(optional)" hint Gusto appends to optional-field labels.
  function cleanQuestionText(value) {
    return normalizeText(value).replace(/\s*\(optional\)\s*$/i, "").trim();
  }

  // Gusto's resume/cover-letter uploads only accept PDF — a .txt/.docx would
  // be rejected by the widget itself, so never even try to attach one. The
  // file shape here is this port's own plain object ({fileName, base64,
  // mimeType}), not BidHub's `{type:'file', ...}` AI-backend answer wrapper.
  function isPdfFileAnswer(answer) {
    if (!answer || typeof answer !== "object") return false;
    const mimeType = String(answer.mimeType || "").toLowerCase();
    const fileName = String(answer.fileName || "").toLowerCase();
    return mimeType === "application/pdf" || fileName.endsWith(".pdf");
  }

  function isElementVisible(element, { allowHiddenInput = false } = {}) {
    if (!element?.isConnected) return false;
    if (allowHiddenInput && element.matches?.('input[type="file"], input[type="radio"], input[type="checkbox"]')) return true;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getGustoForm() {
    return document.querySelector(FORM_SELECTOR);
  }
  function isOnGustoApplyForm() {
    return Boolean(getGustoForm());
  }

  // Posting-page apply link that navigates to the form. Never present once
  // the form (`/applicants/new`) is rendered.
  function getApplyTrigger() {
    if (isOnGustoApplyForm()) return null;
    return Array.from(document.querySelectorAll(APPLY_TRIGGER_SELECTOR)).find(isElementVisible) ?? null;
  }

  // The form's terminal action. This is the gated final submit — never
  // auto-clicked by advance().
  function getFinalSubmitButton() {
    const form = getGustoForm();
    if (!form) return null;
    return form.querySelector('input[type="submit"][name="commit"], button[type="submit"], input[type="submit"]');
  }

  // Advance one hop: click "Apply for <title>" to cross from the posting
  // page to the application form. Returns true if that click happened
  // (caller should wait for the navigation and re-detect on the new page);
  // false if there's nothing safe to do — either already on the form page
  // (where the only forward control is the gated final Submit) or no
  // trigger found. Never clicks Submit.
  async function advance() {
    if (getFinalSubmitButton()) return false;
    const applyTrigger = getApplyTrigger();
    if (!applyTrigger) return false;
    await clickLikeHuman(applyTrigger);
    return true;
  }

  // The field-less posting page must still report as autofill-available so
  // a caller's auto-advance loop fires on it.
  function isAutofillAvailable() {
    if (detectFields().length > 0) return true;
    if (getFinalSubmitButton()) return true;
    return Boolean(getApplyTrigger());
  }

  // ---- Choice helpers (radios / checkboxes) --------------------------------

  function getChoiceInputLabelText(input, fallbackQuestion = "") {
    const labelText = normalizeText(input?.closest("label")?.textContent);
    if (labelText) return labelText;
    return normalizeText(input?.value || fallbackQuestion);
  }

  // Exact (normalized) match only — BidHub's own fallback here was an AI
  // embedding-similarity call (getEmbeddingMatch) against its backend; that's
  // the out-of-scope AI-answer path, so a looser-than-exact miss just
  // returns null and the field is left unfilled for the generic pipeline.
  function getBestMatchingOption(answer, options) {
    if (!Array.isArray(options) || options.length === 0) return null;
    const normalizedAnswer = normalizeComparisonText(typeof answer === "boolean" ? (answer ? "Yes" : "No") : answer);
    if (!normalizedAnswer) return null;
    return options.find((option) => normalizeComparisonText(option.text) === normalizedAnswer) ?? null;
  }

  function isTruthyCheckboxAnswer(answer) {
    if (typeof answer === "boolean") return answer;
    return ["yes", "true", "y", "agree", "accepted", "consent"].includes(normalizeComparisonText(answer));
  }

  // ---- Standard candidate fields -------------------------------------------

  function getStandardFieldKind(control) {
    const tag = control.tagName.toLowerCase();
    const type = (control.getAttribute("type") || "").toLowerCase();
    if (type === "file") return FIELD_KIND_UPLOAD;
    if (tag === "textarea") return "textarea";
    return "text";
  }

  function getStandardAnswerType(control) {
    const name = (control.getAttribute("name") || "").toLowerCase();
    if ((control.getAttribute("type") || "").toLowerCase() === "file") {
      if (name.includes("resume") || name.includes("cv")) return "resume";
      if (name.includes("cover_letter")) return "cover_letter";
      return "file";
    }
    return "text";
  }

  function getStandardFieldQuestion(control) {
    if (control.id) {
      const escapedId = window.CSS?.escape?.(control.id) ?? control.id;
      const linkedLabel = document.querySelector(`label[for="${escapedId}"]`);
      const linkedText = cleanQuestionText(linkedLabel?.textContent);
      if (linkedText) return linkedText;
    }
    const wrappedLabel = control.closest("label");
    const wrappedText = cleanQuestionText(wrappedLabel?.textContent);
    if (wrappedText) return wrappedText;
    return "";
  }

  // Big Banana addition (not in BidHub's own source — see file header):
  // best-effort label/name heuristic so a plain profile object has
  // somewhere deterministic to land. Anything that doesn't match one of
  // these falls through to `null` and is left for the generic pipeline,
  // same as BidHub leaves every field for its AI backend.
  function classifyProfileKey(question, control) {
    const name = (control.getAttribute("name") || "").toLowerCase();
    const probe = `${normalizeComparisonText(question)} ${name}`;
    if (/\bfirst\s*name\b/.test(probe)) return "first_name";
    if (/\blast\s*name\b/.test(probe)) return "last_name";
    if (/\bfull\s*name\b/.test(probe) || /^name$/.test(normalizeComparisonText(question))) return "full_name";
    if (/e[-\s]?mail/.test(probe)) return "email";
    if (/phone/.test(probe)) return "phone";
    if (/linkedin/.test(probe)) return "linkedin";
    if (/\b(location|city|address)\b/.test(probe)) return "location";
    return null;
  }

  function detectStandardFields(form, usedFieldIds) {
    const fields = [];
    const controls = Array.from(form.querySelectorAll("input, textarea, select"));
    for (const control of controls) {
      const name = control.getAttribute("name") || "";
      const type = (control.getAttribute("type") || "").toLowerCase();
      if (!name.startsWith("job_applicant[")) continue;
      if (name.includes("custom_form_response_attributes")) continue;
      if (["hidden", "submit", "reset", "button"].includes(type)) continue;
      if (type !== "file" && !isElementVisible(control)) continue;

      const fieldKind = getStandardFieldKind(control);
      const answerType = getStandardAnswerType(control);

      // Resume/cover-letter slots are keyed on these exact fieldIds (same
      // contract BidHub's other platform adapters use) so a caller's
      // file-answer lookup doesn't depend on Gusto's own input id/name.
      const fieldId = answerType === "resume" ? "resume" : answerType === "cover_letter" ? "cover_letter" : control.id || name;
      if (!fieldId || usedFieldIds.has(fieldId)) continue;

      // Upload labels are the verbose dropzone copy ("Click or drag over to
      // replace the file…") — use canonical names instead for anything
      // that reads this field's `question`.
      const question = answerType === "resume" ? "Resume/CV" : answerType === "cover_letter" ? "Cover Letter" : getStandardFieldQuestion(control);
      if (!question) continue;

      usedFieldIds.add(fieldId);
      fields.push({
        question,
        fieldId,
        answerType,
        fieldKind,
        profileKey: classifyProfileKey(question, control),
        field: control,
        options: [],
        required: Boolean(control.required || control.getAttribute("aria-required") === "true"),
      });
    }
    return fields;
  }

  // ---- Employer (custom) questions -----------------------------------------

  function getCustomQuestionBlock(typeInput) {
    return typeInput.closest("div.sm\\:col-span-6") || typeInput.closest("div") || typeInput.parentElement;
  }
  function getCustomQuestionText(block, fallback) {
    // The question label carries class `font-medium`; option labels use `block mb-2`.
    const questionLabel = Array.from(block.querySelectorAll("label")).find((label) => /font-medium/.test(label.className || ""));
    return cleanQuestionText(questionLabel?.textContent) || fallback;
  }
  function getCustomQuestionFieldId(block, index, usedFieldIds) {
    const uuidInput = block.querySelector('input[name$="[question_uuid]"]');
    const uuid = normalizeText(uuidInput?.value);
    const baseFieldId = uuid ? `custom_${uuid}` : `custom_${index}`;
    let fieldId = baseFieldId;
    let suffix = 2;
    while (usedFieldIds.has(fieldId)) {
      fieldId = `${baseFieldId}-${suffix}`;
      suffix += 1;
    }
    usedFieldIds.add(fieldId);
    return fieldId;
  }

  function detectCustomQuestions(form, usedFieldIds) {
    const fields = [];
    const typeInputs = Array.from(form.querySelectorAll('input[type="hidden"][name$="[question_type]"]'));
    typeInputs.forEach((typeInput, index) => {
      const block = getCustomQuestionBlock(typeInput);
      if (!block) return;
      const questionType = normalizeComparisonText(typeInput.value);
      const question = getCustomQuestionText(block, `Question ${index + 1}`);
      if (!question) return;
      const fieldId = getCustomQuestionFieldId(block, index, usedFieldIds);

      if (questionType === "multiple_choice") {
        const checkboxes = getCheckboxInputs(block);
        fields.push({
          question, fieldId, answerType: "multi-select", fieldKind: FIELD_KIND_CHOICE,
          profileKey: null, field: block,
          options: checkboxes.map((input) => getChoiceInputLabelText(input, question)).filter(Boolean),
          required: checkboxes.some((input) => input.required),
        });
        return;
      }
      if (questionType === "single_choice") {
        const radios = getRadioInputs(block);
        fields.push({
          question, fieldId, answerType: "single-select", fieldKind: FIELD_KIND_CHOICE,
          profileKey: null, field: block,
          options: radios.map((input) => getChoiceInputLabelText(input, question)).filter(Boolean),
          required: radios.some((input) => input.required),
        });
        return;
      }

      // Free-text employer question (question_type === 'text'). The control
      // is the block's own `[N][text]` input/textarea.
      const textarea = getTextarea(block);
      const control = textarea || getTextInput(block);
      if (!control) return;
      fields.push({
        question, fieldId, answerType: "text", fieldKind: textarea ? "textarea" : "text",
        profileKey: null, field: block, options: [],
        required: Boolean(control.required || control.getAttribute("aria-required") === "true"),
      });
    });
    return fields;
  }

  /** Enumerate every fillable field on the current page's application form:
   *  {question, fieldId, answerType, fieldKind, profileKey, field, options,
   *  required}. Returns [] on the field-less posting page (the caller should
   *  check isAutofillAvailable()/call advance() instead). */
  function detectFields() {
    const form = getGustoForm();
    if (!form) return [];
    const usedFieldIds = new Set();
    return [...detectStandardFields(form, usedFieldIds), ...detectCustomQuestions(form, usedFieldIds)];
  }

  // ---- Value resolution from a plain profile object ------------------------
  // This is this port's bridge in place of BidHub's AI-answer backend (see
  // file header) — deterministic cases only. Everything else returns null
  // and that field is left untouched.
  function resolveProfileValue(entry, profileData) {
    switch (entry.profileKey) {
      case "full_name":
        return profileData.full_name || [profileData.first_name, profileData.last_name].filter(Boolean).join(" ").trim() || null;
      case "first_name":
        return profileData.first_name || profileData.full_name?.split(" ")[0] || null;
      case "last_name":
        return profileData.last_name || (profileData.full_name ? profileData.full_name.split(" ").slice(1).join(" ") : null) || null;
      case "email":
        return profileData.email || null;
      case "phone":
        return profileData.phone || null;
      case "linkedin":
        return profileData.linkedin || null;
      case "location":
        return profileData.location || null;
      default:
        return null;
    }
  }

  // ---- Field-kind fillers (ported from FIELD_KIND_HANDLERS) ----------------

  function fillTextField(field, answer) {
    const input = getTextInput(field);
    if (input) fillTextInput(input, answer);
  }
  function fillTextareaField(field, answer) {
    const textarea = getTextarea(field);
    if (textarea) fillTextInput(textarea, answer);
  }

  async function fillChoiceField(field, question, answer) {
    const radios = getRadioInputs(field);
    const checkboxes = getCheckboxInputs(field);

    // Single choice (radios).
    if (radios.length > 0) {
      const options = radios.map((input) => ({ input, text: getChoiceInputLabelText(input, question) })).filter((o) => o.text);
      const best = getBestMatchingOption(answer, options);
      if (!best?.input) return false;
      if (!best.input.checked) {
        await clickLikeHuman(best.input);
        best.input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return true;
    }

    if (checkboxes.length === 0) return false;

    // A lone checkbox is usually a yes/no consent toggle, not a multi-pick
    // list — any truthy answer (or one that happens to match its own label)
    // checks it.
    if (checkboxes.length === 1) {
      const checkbox = checkboxes[0];
      const shouldCheck = isTruthyCheckboxAnswer(answer) || normalizeComparisonText(answer) === normalizeComparisonText(getChoiceInputLabelText(checkbox, question));
      if (checkbox.checked !== shouldCheck) {
        await clickLikeHuman(checkbox);
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return true;
    }

    // Multiple checkboxes — answer may be a single value or an array; check
    // every option whose label matches (loosely, either direction contains).
    const requested = (Array.isArray(answer) ? answer : [answer]).map(normalizeComparisonText).filter(Boolean);
    const options = checkboxes.map((input) => ({ input, text: getChoiceInputLabelText(input, question) })).filter((o) => o.text);
    for (const option of options) {
      const label = normalizeComparisonText(option.text);
      const shouldCheck = requested.some((value) => value === label || value.includes(label) || label.includes(value));
      if (option.input.checked !== shouldCheck) {
        await clickLikeHuman(option.input);
        option.input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    return true;
  }

  async function fillUploadField(field, answer) {
    if (!isPdfFileAnswer(answer)) return false;
    const input = getFileInputInsideField(field);
    if (!input) return false;
    fillFileInput(input, answer.fileName, answer.base64, answer.mimeType || "application/pdf");
    // Gusto's Stimulus `file-upload` controller binds to the file input's
    // DEFAULT event, which for `<input>` is `input` — not `change`.
    // `fillFileInput` only dispatches `change`, so without this the
    // controller never registers the file (no preview, required-validation
    // stays unsatisfied). Verified live by BidHub: a `change`-only dispatch
    // leaves the dropzone empty; an `input` dispatch makes it show the
    // filename.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  /** Fill every structurally-resolvable field on the current form from
   *  `profileData` ({full_name|first_name/last_name, email, phone,
   *  linkedin, location, __resumeFile, __coverLetterFile}) and, optionally,
   *  `opts.answers` ({[fieldId]: value}) for employer custom questions a
   *  caller already has an answer for. Never clicks the final Submit. A
   *  field this can't resolve is left untouched for the generic pipeline —
   *  same policy as BidHub's own AI-backend fields that came back empty.
   *  Returns the fieldIds it actually wrote. */
  async function fill(profileData = {}, opts = {}) {
    const { answers = {} } = opts;
    const entries = detectFields();
    const filled = [];

    for (const entry of entries) {
      try {
        if (entry.fieldKind === FIELD_KIND_UPLOAD) {
          const fileAnswer = entry.answerType === "resume" ? profileData.__resumeFile : entry.answerType === "cover_letter" ? profileData.__coverLetterFile : null;
          if (fileAnswer && (await fillUploadField(entry.field, fileAnswer))) filled.push(entry.fieldId);
          continue;
        }
        if (entry.fieldKind === FIELD_KIND_CHOICE) {
          const answer = answers[entry.fieldId];
          if (answer == null) continue; // no profile-level signal for a one-off employer question
          if (await fillChoiceField(entry.field, entry.question, answer)) filled.push(entry.fieldId);
          continue;
        }
        const value = answers[entry.fieldId] ?? resolveProfileValue(entry, profileData);
        if (value == null || value === "") continue;
        if (entry.fieldKind === "textarea") fillTextareaField(entry.field, value);
        else fillTextField(entry.field, value);
        filled.push(entry.fieldId);
      } catch {
        // One field's quirk shouldn't abort the whole pass — move on, the
        // generic pipeline (or the human) can still handle it.
      }
    }
    return filled;
  }

  window.ProactiveAutofillSites = window.ProactiveAutofillSites || {};
  window.ProactiveAutofillSites.gusto = {
    isAutofillAvailable,
    detectFields,
    fill,
    advance,
    getFinalSubmitButton,
  };

  // ---------------------------------------------------------------------
  // Explicitly OUT OF SCOPE (not ported):
  //   - BidHub's ANSWER_TYPE_HANDLERS / createBackendAnswerHandler / getAnswer
  //     — the AI free-text/single-select/multi-select answer-generation
  //     backend call for employer custom questions. Big Banana's own
  //     existing generic pipeline already does this; a custom question this
  //     file can't resolve is simply left unfilled above.
  //   - getEmbeddingMatch — the AI embedding-similarity fallback used when an
  //     answer didn't exactly match any option's label. Dropped along with
  //     the backend; getBestMatchingOption() here only does the exact-match
  //     half of BidHub's original.
  //   - isDependentQuestion / dependent-question reordering — only mattered
  //     for sequencing AI-generated answers so a later question could see an
  //     earlier one's answer. Not needed once the AI step itself is gone.
  //   - CAPTCHA solving and proxy/remote-CDP automation — Gusto's own form
  //     never appeared to involve either in BidHub's source; nothing of that
  //     kind existed here to port in the first place.
  // ---------------------------------------------------------------------
})();
