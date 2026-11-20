/* =====================================================================
 * autofill/sites/breezy-autofill.js — Breezy ATS careers application
 * forms (<tenant>.breezy.hr/p/<posting>/apply).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/breezy/autofill.js. Breezy is
 * a legacy AngularJS app (ng-controller/ng-model/ng-click — no React
 * anywhere on the page), so none of dom-interactions.js's React
 * _valueTracker plumbing matters here; a plain `input`/`change` event
 * is all Angular's ngModel directive needs, which fillTextInput()
 * already dispatches. This file just calls into that instead of
 * reimplementing a second write path.
 *
 * Ported, structural-only:
 *   - field enumeration/classification: text, textarea, native
 *     <select>, checkbox groups + lone consent boxes, radio groups
 *     (including the EEO veteran/disability survey), the résumé/cover
 *     letter file slots, the desired-salary number input, and a native
 *     `type="date"` input
 *   - value-filling per field kind using the engine's primitives
 *   - the posting-page "Apply to Position" → in-form "nextSection"
 *     Next-button advance flow
 *   - the FIRST row only of Breezy's own repeatable Work History /
 *     Education sections (see scope note below)
 *
 * OUT OF SCOPE (left to Big Banana's own existing systems, or simply
 * not ported):
 *   - Free-text screening-question ANSWER GENERATION, and the
 *     embedding-similarity fallback BidHub's own getBestMatchingOption
 *     used for an unmatched select/radio/checkbox option
 *     (getEmbeddingMatch()/getAnswer()/ai-core) — detectQuestions()
 *     below only CLASSIFIES each question's structural type and
 *     locates its control; fillField() only WRITES an answer the
 *     caller already resolved. A select/radio/checkbox this file can't
 *     match deterministically (exact text, then substring) is left
 *     untouched rather than guessed — same AI boundary
 *     lever-autofill.js and bamboohr-autofill.js keep. A caller with no
 *     answer for a given field simply never calls fillField for it,
 *     and Big Banana's existing generic AI-answer pipeline is free to
 *     pick that field up on its own pass. Also dropped: BidHub's
 *     dependent-question ("if you answered yes...") detector, which
 *     only ever existed to sequence those AI answers.
 *   - CAPTCHA / proxy-CDP "real input" lanes — neither is referenced
 *     anywhere in this bundle.
 *   - Breezy's own "Add Position" / "Add Education" repeater growth.
 *     BidHub's autofill-section-hierarchy.js grows these sections row
 *     by row from a parsed profile; this file only fills whichever
 *     FIRST row Breezy already renders by default (company/title/
 *     summary/dates, or school/field-of-study/summary/dates) — it
 *     never clicks "Add Position"/"Add Education", so a second
 *     work-history or education entry is left for whatever handles it
 *     next.
 *   - Breezy's own desired-salary FREQUENCY dropdown (the <select>
 *     next to the salary number). BidHub deliberately never fills it
 *     either — it only ever reads the dropdown's current selection as
 *     read-only context for the salary number's answer, so this file
 *     excludes it from detection entirely rather than guessing a
 *     frequency no one asked it to set.
 * ===================================================================== */
(function () {
  "use strict";

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    sleep,
    fillTextInput,
    fillSelectInput,
    fillFileInput,
    clickLikeHuman,
    getCheckboxInputs,
    getRadioInputs,
    getInputLabelText,
    getNativeSelect,
    getTextarea,
    getTextInput,
    getFileInputInsideField,
  } = engine;

  // A broader "plain text control" selector than the engine's own default (which omits
  // `type="date"`) — Breezy's date-of-birth/expected-start-date questions are real native date
  // inputs, and getFieldId()/classifyBreezyField() both need to see them.
  const TEXT_LIKE_INPUT_SELECTOR =
    'input:not([type="hidden"]):not([type="file"]):not([type="checkbox"]):not([type="radio"])';

  const REQUIRED_MARKER_PATTERN = /[✱*]/g;
  const SAFE_ADVANCE_BUTTON_TEXT_PATTERN = /\b(apply\s+to\s+position|continue|next)\b/i;
  const UNSAFE_ADVANCE_BUTTON_TEXT_PATTERN = /\b(submit|linkedin|indeed|resume|upload|job openings|company website)\b/i;
  const SUBMIT_BUTTON_TEXT_PATTERN = /\b(submit\s+application|submit|send\s+application)\b/i;
  const ADVANCE_WAIT_MS = 8000;
  const RESUME_UPLOAD_START_TIMEOUT_MS = 5000;
  const RESUME_AUTOFILL_SETTLE_TIMEOUT_MS = 15000;

  // ---- small text helpers -------------------------------------------------

  // Breezy's required-field glyph and its own inline validation copy ("A resume is required",
  // "The file attachment is limited to 50MB") render right inside the same wrapper a question's
  // text is read from — strip both out before anything compares/matches on that text.
  function normalizeBreezyText(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(REQUIRED_MARKER_PATTERN, "")
      .replace(/\bA (?:resume|cover letter) is required\b/gi, "")
      .replace(/\bThe file attachment is limited to 50MB\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function normalizeComparisonText(value) {
    return normalizeBreezyText(value)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
  }
  function slugifyFieldId(value) {
    return normalizeComparisonText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function escapeAttributeValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function isElementVisible(element) {
    if (!element?.isConnected) return false;
    if (element.matches?.('input[type="file"]')) {
      // Breezy's own upload widget keeps the native file input permanently hidden/zero-size —
      // check the wrapping upload row/button for real visibility instead.
      const wrapper = element.closest?.(".file-input-container, .apply-button, li, .apply-container");
      return wrapper ? isElementVisible(wrapper) : false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getForm() {
    return document.querySelector('form[ng-controller*="FormWithQuestionnaireCtrl"], form[name="form"]');
  }
  function getHeadingText(field) {
    const heading = field?.querySelector?.("h3, legend, .section-header h2, .section-header h3");
    return normalizeBreezyText(heading?.textContent);
  }

  // ---- question text + wrapper resolution --------------------------------

  // A handful of Breezy's own named fields need special-cased question text/wrappers — their
  // markup gives no clean generic label to read (cSalary/cLocation sit inside multi-control
  // rows; gdprAgreement/smsConsent are bare consent checkboxes with no heading at all).
  function getControlQuestionText(control, field) {
    if (control?.name === "cSalary") return "Desired Salary";
    if (control?.name === "cSummary") return "Experience Summary";
    if (control?.name === "cLocation") return "Which location are you applying for";
    if (control?.type === "checkbox") {
      // Checkbox GROUPS ("How did you hear about us?" with N options) carry their prompt in the
      // question's <h3>; the wrapper's own textContent would otherwise be prompt + every option
      // label + the hidden "A response is required" error. Lone consent checkboxes (smsConsent,
      // gdpr) have no heading and ARE their wrapper's text.
      const groupHeading = getHeadingText(field);
      if (groupHeading) return groupHeading;
      const fieldText = normalizeBreezyText(field?.textContent);
      if (fieldText) return fieldText;
    }
    const headingText = getHeadingText(field);
    if (headingText) return headingText;
    const placeholder = normalizeBreezyText(control?.getAttribute?.("placeholder"));
    if (placeholder) return placeholder;
    const labelText = normalizeBreezyText(getInputLabelText(control));
    if (labelText) return labelText;
    return normalizeBreezyText(control?.name || control?.id);
  }

  function getQuestionWrapper(control) {
    if (!control) return null;
    if (control.name === "cSalary") return control.closest(".desired-salary") || control;
    if (control.name === "cLocation") return control.closest(".preferred-location");
    if (control.name === "gdprAgreement") return control.closest(".gdpr-accept");
    if (control.name === "smsConsent") return control.closest(".option, label, .section");
    if (control.name === "cSummary") return control;
    if (control.name === "cCoverLetter") return control.closest(".section");
    if (control.closest("li.question")) return control.closest("li.question");
    if (control.closest(".multiplechoice")) return control.closest(".multiplechoice");
    return control;
  }

  // The hidden "please leave this blank" trap Breezy ships against scripted submissions, plus a
  // tabIndex=-1 control (same pattern) — never touch either.
  function isHoneypotControl(control) {
    return Boolean(
      control?.closest?.(".apply-field-extra") ||
        control?.tabIndex === -1 ||
        /^hp_/i.test(control?.name || control?.id || "")
    );
  }

  // Angular repeater rows for Work History / Education — handled separately (first row only,
  // see the section helpers below), so the generic field loop must skip them entirely.
  function isRepeaterControl(control) {
    const model = control?.getAttribute?.("ng-model") || "";
    return /^candidate(?:Position|School)\./.test(model);
  }

  function getSelectOptionEntries(field) {
    const select = getNativeSelect(field);
    if (!select) return [];
    return Array.from(select.querySelectorAll("option"))
      .filter((option) => option.value && !/undefined:\s*undefined|\?$/.test(option.value))
      .map((option) => ({ value: option.value, text: normalizeBreezyText(option.textContent) }))
      .filter((option) => option.text);
  }

  // Questionnaire CHECKBOX options render as `<li class="option"><input type="checkbox"><span>
  // Indeed</span></li>` — no <label> at all, so the shared getInputLabelText() finds nothing and
  // falls through to `input.value`, which is the meaningless "on" for every box. Read the option
  // row's own text first. A plain RADIO option does sit inside a <label>, so getInputLabelText
  // resolves those on its own.
  function getChoiceInputLabelText(input, fallbackQuestion = "") {
    const labelText = normalizeBreezyText(getInputLabelText(input));
    if (labelText) return labelText;
    const optionRow = input?.closest?.("li.option, .option");
    const optionText = normalizeBreezyText(optionRow?.textContent);
    if (optionText) return optionText;
    const value = normalizeBreezyText(input?.value);
    if (value && value.toLowerCase() !== "on") return value;
    return normalizeBreezyText(fallbackQuestion);
  }

  function getSyncSelectableOptions(field) {
    const checkboxInputs = getCheckboxInputs(field);
    if (checkboxInputs.length > 0) {
      // A lone checkbox (consent/agreement/opt-in) is inherently yes/no — model it as a binary
      // choice instead of a one-option list whose only option is the whole consent sentence.
      if (checkboxInputs.length === 1) return ["Yes", "No"];
      return checkboxInputs.map((checkbox) => getChoiceInputLabelText(checkbox)).filter(Boolean);
    }
    const radioInputs = getRadioInputs(field);
    if (radioInputs.length > 0) {
      return radioInputs.map((radio) => getChoiceInputLabelText(radio)).filter(Boolean);
    }
    const selectOptions = getSelectOptionEntries(field).map((option) => option.text);
    return selectOptions.length > 0 ? selectOptions : null;
  }

  function isResumeField(question, control) {
    const normalizedQuestion = normalizeComparisonText(question);
    const normalizedName = normalizeComparisonText(control?.name || control?.id || control?.getAttribute?.("ng-model"));
    return /\b(resume|cv|curriculum vitae)\b/.test(normalizedQuestion) || /\b(cresume|resume|cv)\b/.test(normalizedName);
  }
  function isCoverLetterField(question, control) {
    const normalizedQuestion = normalizeComparisonText(question);
    const normalizedName = normalizeComparisonText(control?.name || control?.id || control?.getAttribute?.("ng-model"));
    return (
      /cover\s*letter/.test(normalizedQuestion) || /\bcover[_\s-]*letter\b/.test(normalizedName) || normalizedName === "ccoverletter"
    );
  }

  // Breezy's résumé field only counts once the upload WIDGET (the "Attach Resume" button next
  // to the hidden input) is actually on the page and visible — the input itself always exists in
  // the DOM even when the posting's application section is collapsed/hidden.
  function getResumeField(form) {
    const input = form?.querySelector('input[type="file"][name="cResume"]');
    if (!input) return null;
    const applicationSection = input.closest('[data-section="application"]');
    if (applicationSection && !isElementVisible(applicationSection)) return null;
    const uploadButton =
      applicationSection?.querySelector("a.button.resume, a.resume") || form.querySelector("a.button.resume, a.resume");
    if (!uploadButton || !isElementVisible(uploadButton)) return null;
    return applicationSection || input.closest(".file-input-container") || input;
  }

  function getCoverLetterField(form) {
    const textarea = form?.querySelector('textarea[name="cCoverLetter"]');
    const fileInput = Array.from(form?.querySelectorAll('input[type="file"]') ?? []).find(
      (input) => isElementVisible(input) && isCoverLetterField(getControlQuestionText(input, getQuestionWrapper(input)), input)
    );
    const field = textarea?.closest(".section") || getQuestionWrapper(fileInput) || fileInput || null;
    return field && isElementVisible(field) ? field : null;
  }

  // ---- field-kind classification -----------------------------------------

  function classifyBreezyField(question, field) {
    const fileInput = getFileInputInsideField(field);
    if (fileInput) {
      if (isResumeField(question, fileInput)) return { fieldKind: "resume", options: null, control: fileInput };
      if (isCoverLetterField(question, fileInput)) return { fieldKind: "cover_letter", options: null, control: fileInput };
      return null; // an unrecognized file slot — leave it to the generic pipeline
    }
    const salaryInput = field?.matches?.('input[name="cSalary"]') ? field : field?.querySelector?.('input[name="cSalary"]');
    if (salaryInput) return { fieldKind: "salary", options: null, control: salaryInput };

    const checkboxInputs = getCheckboxInputs(field);
    if (checkboxInputs.length > 0) {
      return { fieldKind: "checkbox", options: getSyncSelectableOptions(field), control: checkboxInputs[0] };
    }
    const radioInputs = getRadioInputs(field);
    if (radioInputs.length > 0) {
      return { fieldKind: "radio", options: getSyncSelectableOptions(field), control: radioInputs[0] };
    }
    const select = getNativeSelect(field);
    if (select) {
      return { fieldKind: "select-native", options: getSyncSelectableOptions(field), control: select };
    }
    const textarea = getTextarea(field);
    if (textarea) {
      const isCoverLetter = textarea.name === "cCoverLetter" || /cover\s*letter/i.test(question);
      return { fieldKind: isCoverLetter ? "cover_letter" : "textarea", options: null, control: textarea };
    }
    const input = getTextInput(field, TEXT_LIKE_INPUT_SELECTOR);
    if (input) {
      return { fieldKind: input.type === "date" ? "date" : "text", options: null, control: input };
    }
    return null;
  }

  function getFieldId(question, control, usedFieldIds) {
    const baseFieldId =
      control?.name || control?.id || control?.getAttribute?.("ng-model") || slugifyFieldId(question);
    if (!baseFieldId) return null;
    if (!usedFieldIds.has(baseFieldId)) return baseFieldId;
    let suffix = 2;
    while (usedFieldIds.has(`${baseFieldId}-${suffix}`)) suffix += 1;
    return `${baseFieldId}-${suffix}`;
  }

  function addFieldEntry(questions, usedFieldIds, question, field) {
    if (!question || !field) return;
    const classified = classifyBreezyField(question, field);
    if (!classified) return;
    const fieldId =
      classified.fieldKind === "resume"
        ? "resume"
        : classified.fieldKind === "cover_letter"
        ? "cover_letter"
        : classified.fieldKind === "salary"
        ? "cSalary"
        : getFieldId(question, classified.control, usedFieldIds);
    if (!fieldId || usedFieldIds.has(fieldId)) return;
    usedFieldIds.add(fieldId);
    questions.push({
      question,
      fieldId,
      fieldKind: classified.fieldKind,
      field,
      control: classified.control,
      options: classified.options,
    });
  }

  // Radio groups are detected in their own pass (by `name`, across the whole form) rather than
  // from the generic control loop below — a group's individual <input>s don't reliably share one
  // question wrapper the way a checkbox group's do, so the main loop skips `type="radio"`
  // entirely and leaves it to this.
  function detectChoiceGroups(form, questions, usedFieldIds) {
    const handledNames = new Set();
    for (const radio of Array.from(form.querySelectorAll('input[type="radio"]'))) {
      if (!isElementVisible(radio) || handledNames.has(radio.name)) continue;
      const field = radio.closest(".multiplechoice") || radio.closest("ul") || radio.closest("li.question, .section.questions");
      const groupInputs = field
        ? Array.from(field.querySelectorAll(`input[type="radio"][name="${escapeAttributeValue(radio.name)}"]`))
        : Array.from(form.querySelectorAll(`input[type="radio"][name="${escapeAttributeValue(radio.name)}"]`));
      if (groupInputs.length === 0) continue;
      handledNames.add(radio.name);
      const groupField = groupInputs[0].closest(".multiplechoice") || field || form;
      const question = getHeadingText(groupField) || getRadioGroupQuestionText(radio.name);
      addFieldEntry(questions, usedFieldIds, question, groupField);
    }
  }
  // Breezy's own EEO survey radio groups carry no visible heading at all — their `name` attribute
  // is the only thing identifying them.
  function getRadioGroupQuestionText(name) {
    if (name === "eeoc.veteran_status") return "Veteran status";
    if (name === "eeoc.disability_status") return "Disability status";
    return slugifyFieldId(name);
  }

  // ---- Work History / Education — FIRST ROW ONLY -------------------------
  // Breezy renders one row of each section by default; growing a second row means clicking
  // "Add Position"/"Add Education", which is explicitly out of scope here (see header). These
  // helpers only ever look at the first Angular repeater row already on the page.

  const BREEZY_SECTIONS = [
    {
      markerSelector: 'a[ng-click*="addPosition"], input#work_required',
      modelPrefix: "candidatePosition",
      rowLabel: "Work history 1",
      mappings: [
        { modelSuffix: "company_name", label: "Company" },
        { modelSuffix: "title", label: "Title" },
        { modelSuffix: "summary", label: "Summary" },
        { modelSuffix: "date_start", label: "Start date" },
        { modelSuffix: "date_end", label: "End date" },
      ],
    },
    {
      markerSelector: 'a[ng-click*="addEducation"], input#education_required',
      modelPrefix: "candidateSchool",
      rowLabel: "Education 1",
      mappings: [
        { modelSuffix: "school_name", label: "School" },
        { modelSuffix: "field_of_study", label: "Field of study" },
        { modelSuffix: "summary", label: "Summary" },
        { modelSuffix: "date_start", label: "Start date" },
        { modelSuffix: "date_end", label: "End date" },
      ],
    },
  ];

  function getSectionContainer(markerSelector) {
    const marker = getForm()?.querySelector(markerSelector);
    const section = marker?.closest(".section") || null;
    return section && isElementVisible(section) ? section : null;
  }
  function getFirstRepeaterRow(container, modelPrefix) {
    const control = container?.querySelector(`[ng-model^="${modelPrefix}."]`);
    return control?.closest("li, .experience.ng-scope, .ng-scope") || null;
  }
  function getRowControl(row, modelSuffix) {
    return row?.querySelector(`[ng-model$=".${modelSuffix}"]`) || null;
  }

  function addSectionFirstRowEntries(questions, usedFieldIds, section) {
    const container = getSectionContainer(section.markerSelector);
    if (!container) return;
    const row = getFirstRepeaterRow(container, section.modelPrefix);
    if (!row) return;
    for (const mapping of section.mappings) {
      const control = getRowControl(row, mapping.modelSuffix);
      if (!control || !isElementVisible(control)) continue;
      const fieldId = control.getAttribute("ng-model") || control.id;
      if (!fieldId || usedFieldIds.has(fieldId)) continue;
      usedFieldIds.add(fieldId);
      questions.push({
        question: `${section.rowLabel} — ${mapping.label}`,
        fieldId,
        fieldKind: "text",
        field: control,
        control,
        options: null,
      });
    }
  }

  // ---- detection ------------------------------------------------------------

  /**
   * Walk the current Breezy application form and return every question this adapter knows how
   * to fill deterministically. Anything classifyBreezyField() can't place (or a field with no
   * derivable question text) is left out entirely, which is how a field is "left alone" for Big
   * Banana's own generic/AI pipeline to pick up per the scope note at the top of this file.
   *
   * @returns {Array<{question:string, fieldId:string, fieldKind:string, field:Element,
   *   control:Element, options:string[]|null}>}
   */
  function detectQuestions() {
    const form = getForm();
    if (!form) return [];
    const questions = [];
    const usedFieldIds = new Set();

    const resumeField = getResumeField(form);
    if (resumeField) addFieldEntry(questions, usedFieldIds, "Resume/CV", resumeField);

    // Work History / Education's first row used to be surfaced here as
    // flat "Work history 1 — Company"-style questions (addSectionFirstRowEntries,
    // above) — now fully superseded by the dedicated section-hierarchy port
    // (BREEZY_WORK_HISTORY_SECTION/BREEZY_EDUCATION_SECTION below), which
    // covers every row including the first. Calling both would show the
    // first row's fields twice.

    const handledCheckboxWrappers = new Set();
    for (const control of Array.from(form.querySelectorAll('input:not([type="hidden"]), textarea, select'))) {
      if (!isElementVisible(control) || isHoneypotControl(control) || isRepeaterControl(control)) continue;
      if (control.type === "radio") continue; // handled by detectChoiceGroups below
      if (control.type === "file" && control.name === "cResume") continue; // handled above
      if (control.closest(".desired-salary") && control.tagName === "SELECT") continue; // see header scope note
      const field = getQuestionWrapper(control);
      if (!field) continue;
      if (control.type === "checkbox") {
        // A checkbox GROUP shares one wrapper across its N inputs — emit it once.
        if (handledCheckboxWrappers.has(field)) continue;
        handledCheckboxWrappers.add(field);
      }
      const question = getControlQuestionText(control, field);
      if (!question) continue;
      addFieldEntry(questions, usedFieldIds, question, field);
    }

    detectChoiceGroups(form, questions, usedFieldIds);

    const coverLetterField = getCoverLetterField(form);
    if (coverLetterField && !questions.some((entry) => entry.fieldId === "cover_letter")) {
      addFieldEntry(questions, usedFieldIds, "Cover Letter", coverLetterField);
    }
    return questions;
  }

  // ---- submit / advance ----------------------------------------------------

  function getActionLabel(element) {
    return normalizeBreezyText(
      element?.textContent || element?.value || element?.getAttribute?.("aria-label") || element?.getAttribute?.("title")
    );
  }
  function isActionDisabled(element) {
    return Boolean(
      element?.disabled || element?.getAttribute?.("aria-disabled") === "true" || element?.classList?.contains("disabled")
    );
  }
  function isVisibleActionControl(element) {
    return Boolean(element && isElementVisible(element) && element.matches?.('a, button, input[type="button"], input[type="submit"]'));
  }

  function getSubmitButton() {
    const form = getForm();
    if (!form) return null;
    return (
      Array.from(form.querySelectorAll('button[ng-click*="apply"], button[type="submit"], input[type="submit"], button')).find(
        (button) => isVisibleActionControl(button) && SUBMIT_BUTTON_TEXT_PATTERN.test(getActionLabel(button))
      ) ?? null
    );
  }

  function isSafeAdvanceButton(element) {
    if (!isVisibleActionControl(element) || isActionDisabled(element)) return false;
    const label = getActionLabel(element);
    if (!label || !SAFE_ADVANCE_BUTTON_TEXT_PATTERN.test(label)) return false;
    if (UNSAFE_ADVANCE_BUTTON_TEXT_PATTERN.test(label)) return false;
    // Never treat Breezy's "Apply with LinkedIn"/"Apply with Indeed" shortcuts as a safe
    // in-form Next — they carry generic-looking labels but hand the application off entirely.
    const href = element.href || element.getAttribute?.("href") || "";
    if (/linkedin|indeed|api\/apply/i.test(href)) return false;
    return true;
  }
  // The posting page's own "Apply to Position" link — the one-step hop onto the real
  // #application form, same role Lever's postings-btn/apply link plays.
  function getApplyControl() {
    return (
      Array.from(document.querySelectorAll('a.apply, a[href$="/apply"], a[href*="/apply"], button.apply')).find(
        (element) => isSafeAdvanceButton(element) && /\bapply\s+to\s+position\b/i.test(getActionLabel(element))
      ) ?? null
    );
  }
  function getSafeAdvanceButton() {
    const form = getForm();
    if (!form) return null;
    return (
      Array.from(
        form.querySelectorAll('button[ng-click*="nextSection"], button[type="button"], button, input[type="button"], a.button')
      ).find(isSafeAdvanceButton) ?? null
    );
  }

  function isAutofillAvailable() {
    return Boolean(detectQuestions().length || getApplyControl() || getSubmitButton());
  }

  async function waitFor(check, timeoutMs, pollMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = check();
      if (result) return result;
      await sleep(pollMs);
    }
    return null;
  }

  /**
   * Advance one step: click the posting page's "Apply to Position" link to reveal the
   * application form, or click the form's own safe "nextSection" Next button. Returns true if an
   * in-form Next was clicked (caller should re-detect and keep filling); false if the posting→
   * form boundary was crossed (nothing left to fill on THIS page) or there's nothing safe to
   * click. Never clicks Submit — isSafeAdvanceButton's own UNSAFE pattern excludes it.
   */
  async function advance() {
    const applyControl = getApplyControl();
    if (applyControl) {
      await clickLikeHuman(applyControl);
      await waitFor(() => getForm() || getSafeAdvanceButton() || getSubmitButton(), ADVANCE_WAIT_MS);
      return false;
    }
    const advanceButton = await waitFor(getSafeAdvanceButton, ADVANCE_WAIT_MS);
    if (!advanceButton) return false;
    await clickLikeHuman(advanceButton);
    return true;
  }

  // ---- filling --------------------------------------------------------------

  function normalizeSalaryAnswer(answer) {
    const rawValue = Array.isArray(answer) ? answer[0] : answer;
    const normalizedValue = String(rawValue ?? "").replace(/,/g, "");
    const firstNumericValue = normalizedValue.match(/\d+(?:\.\d+)?/)?.[0] || "";
    if (!firstNumericValue) return "";
    const parsedValue = Number(firstNumericValue);
    return Number.isFinite(parsedValue) ? String(Math.round(parsedValue)) : firstNumericValue;
  }

  // Breezy's date inputs are plain `type="date"` fields expecting yyyy-mm-dd — accept whatever
  // shape the caller's answer comes in (an ISO timestamp, M/D/YYYY, or anything else Date.parse
  // can read) and reformat it instead of silently failing to fill on a mismatched format.
  function formatDateAnswerForBreezyInput(answer) {
    const rawValue = String(answer ?? "").trim();
    if (!rawValue) return "";
    const isoMatch = rawValue.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2].padStart(2, "0")}-${isoMatch[3].padStart(2, "0")}`;
    const numericDateMatch = rawValue.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (numericDateMatch) {
      const year = numericDateMatch[3].length === 2 ? `20${numericDateMatch[3]}` : numericDateMatch[3];
      return `${year}-${numericDateMatch[1].padStart(2, "0")}-${numericDateMatch[2].padStart(2, "0")}`;
    }
    const parsedTimestamp = Date.parse(rawValue);
    if (!Number.isNaN(parsedTimestamp)) {
      const date = new Date(parsedTimestamp);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }
    return rawValue;
  }

  // Exact-or-substring text match only — deliberately NOT the embedding/LLM fuzzy match BidHub's
  // own getBestMatchingOption() falls back to. A select/radio/checkbox this can't place
  // deterministically is left untouched, same AI boundary this whole file keeps elsewhere.
  function getBestMatchingOption(answer, optionEntries) {
    if (!Array.isArray(optionEntries) || optionEntries.length === 0) return null;
    const normalizedAnswer = normalizeComparisonText(typeof answer === "boolean" ? (answer ? "Yes" : "No") : answer);
    if (!normalizedAnswer) return null;
    return (
      optionEntries.find((option) => normalizeComparisonText(option.text) === normalizedAnswer) ||
      optionEntries.find((option) => {
        const text = normalizeComparisonText(option.text);
        return text && (text.includes(normalizedAnswer) || normalizedAnswer.includes(text));
      }) ||
      null
    );
  }

  // Breezy uploads and parses the résumé server-side, surfacing progress right on the upload
  // button's own text ("Uploading resume..." → "<filename> attached") — await that before
  // resolving so a caller filling the rest of the form doesn't race the server round-trip.
  async function waitForResumeAutofillSettlement(field) {
    const input = getFileInputInsideField(field) || document.querySelector('input[type="file"][name="cResume"]');
    const button =
      input?.closest(".apply-button, li, .apply-container")?.querySelector("a.button.resume, a.resume") ||
      document.querySelector("a.button.resume, a.resume");
    const getUploadText = () => normalizeBreezyText(button?.textContent || field?.textContent);
    await waitFor(() => /uploading resume/i.test(getUploadText()), RESUME_UPLOAD_START_TIMEOUT_MS);
    await waitFor(() => /attached/i.test(getUploadText()), RESUME_AUTOFILL_SETTLE_TIMEOUT_MS);
  }

  /**
   * Write an already-resolved answer into a question returned by detectQuestions(), dispatched
   * by its fieldKind. The caller owns deciding WHAT the answer is — this only owns getting it
   * onto the page using window.ProactiveAutofillEngine's primitives.
   *
   * @param {{field:Element, control:Element, fieldKind:string, question:string}} question
   * @param {*} answer - string for text/textarea/date/salary/select-native/radio;
   *   string|string[]|boolean for checkbox; {type:"file", fileName, base64, mimeType} for resume
   *   (cover_letter also accepts a plain string, written to its textarea).
   */
  async function fillField(question, answer) {
    if (!question || answer == null) return;
    const { field, control, fieldKind } = question;

    switch (fieldKind) {
      case "text":
      case "textarea": {
        if (control) fillTextInput(control, String(answer));
        return;
      }
      case "date": {
        if (control) fillTextInput(control, formatDateAnswerForBreezyInput(answer));
        return;
      }
      case "salary": {
        if (control) fillTextInput(control, normalizeSalaryAnswer(answer));
        return;
      }
      case "select-native": {
        const select = getNativeSelect(field) || control;
        if (!select) return;
        const matched = getBestMatchingOption(answer, getSelectOptionEntries(field));
        if (matched) fillSelectInput(select, matched.value);
        return;
      }
      case "checkbox": {
        const checkboxInputs = getCheckboxInputs(field);
        const selectedValues = Array.isArray(answer)
          ? answer.map((value) => normalizeComparisonText(value))
          : typeof answer === "boolean"
          ? []
          : [normalizeComparisonText(answer)];
        for (const checkbox of checkboxInputs) {
          const label = normalizeComparisonText(getChoiceInputLabelText(checkbox, question.question));
          const value = normalizeComparisonText(checkbox.value);
          // A lone consent checkbox's `options` is the synthetic ["Yes","No"] pair (see
          // getSyncSelectableOptions) — its real label is the whole consent sentence, not
          // "yes", so a plain "Yes"/"true" answer needs this literal fallback to ever tick it.
          const shouldCheck =
            typeof answer === "boolean"
              ? answer
              : selectedValues.includes(label) ||
                selectedValues.includes(value) ||
                selectedValues.includes("yes") ||
                selectedValues.includes("true");
          if (checkbox.checked !== shouldCheck) await clickLikeHuman(checkbox);
        }
        return;
      }
      case "radio": {
        const selectedValue = normalizeComparisonText(answer);
        for (const radio of getRadioInputs(field)) {
          const label = normalizeComparisonText(getChoiceInputLabelText(radio, question.question));
          if (selectedValue === label || selectedValue === normalizeComparisonText(radio.value)) {
            if (!radio.checked) await clickLikeHuman(radio);
            return;
          }
        }
        return;
      }
      case "resume": {
        if (answer?.type !== "file") return;
        const input = getFileInputInsideField(field) || document.querySelector('input[type="file"][name="cResume"]');
        if (!input) return;
        fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        await waitForResumeAutofillSettlement(field);
        return;
      }
      case "cover_letter": {
        if (typeof answer === "string") {
          const textarea = getTextarea(field) || document.querySelector('textarea[name="cCoverLetter"]');
          if (textarea) fillTextInput(textarea, answer);
          return;
        }
        if (answer?.type === "file") {
          const fileInput = getFileInputInsideField(field);
          if (fileInput) fillFileInput(fileInput, answer.fileName, answer.base64, answer.mimeType);
        }
        return;
      }
      default:
        return;
    }
  }

  // ---- repeatable Education/Work-history sections (section-hierarchy) ----
  // Ported from BidHub's own Breezy section descriptors — unlike the
  // FIRST-ROW-ONLY generic handling above (addSectionFirstRowEntries/
  // BREEZY_SECTIONS), this drives window.ProactiveSectionHierarchy so every
  // row the profile has gets grown and filled, not just whichever row
  // Breezy already rendered by default. Grow-only: Breezy's Angular
  // repeater rows cannot be deleted programmatically, so these descriptors
  // omit `clearRows` entirely (the shared engine skips the clear step when
  // it's absent) and just grow/fill on top of whatever's already there.
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;

  // All controls for one repeater row share an `ng-model` prefix
  // ("candidatePosition[2].company_name") — find every control under that
  // prefix and map each one to its own row ancestor, de-duplicating since
  // several controls (company/title/summary/dates) resolve to the same row.
  function getRepeaterRows(container, modelPrefix) {
    if (!container) return [];
    const rows = [];
    for (const control of Array.from(container.querySelectorAll(`[ng-model^="${modelPrefix}."]`))) {
      const row = control.closest("li, .experience.ng-scope, .ng-scope");
      if (row && !rows.includes(row)) rows.push(row);
    }
    return rows;
  }
  function getBreezySectionContainer(markerSelector) {
    return getForm()?.querySelector(markerSelector)?.closest(".section") ?? null;
  }
  function getBreezySectionRowField(rowEl, mapping) {
    const field = rowEl?.querySelector(`[ng-model$=".${mapping.modelSuffix}"]`);
    return field ? { field } : null;
  }
  function createBreezyAddRowAction(addPattern) {
    return async (container) => {
      const button = Array.from(container?.querySelectorAll("a, button") ?? []).find((el) =>
        addPattern.test(normalizeBreezyText(el.textContent))
      );
      if (button) {
        await clickLikeHuman(button);
        await sleep(100);
      }
    };
  }

  // No `fieldOfStudy`/`major` concept exists on BCD's Profile.education
  // schema (school/degree/start/end only) — that leaf still detects (so it
  // shows in the review list) but has no profileKey, so it's never
  // auto-filled. Same for Breezy's free-text "Summary" question on the
  // work-history side (no BCD equivalent); Breezy's own Degree/Summary
  // textarea doubles for BCD's `degree` field on the education side.
  const BREEZY_WORK_HISTORY_SECTION = {
    rootFieldId: "workHistory",
    rootQuestion: "Work History",
    profileSection: "experience",
    rowLabel: (i) => `Work history ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    maxEntries: 5,
    getContainer: () => getBreezySectionContainer('a[ng-click*="addPosition"], input#work_required'),
    getRows: (container) => getRepeaterRows(container, "candidatePosition"),
    getRowField: getBreezySectionRowField,
    addRow: createBreezyAddRowAction(/add position/i),
    // NO clearRows — Breezy repeater rows cannot be deleted programmatically.
    mappings: [
      { key: "company", modelSuffix: "company_name", fieldKind: "text", question: "Company", profileKey: "company" },
      { key: "title", modelSuffix: "title", fieldKind: "text", question: "Title", profileKey: "role" },
      { key: "summary", modelSuffix: "summary", fieldKind: "textarea", question: "Summary" },
      { key: "dateStart", modelSuffix: "date_start", fieldKind: "text", question: "Start Date", profileKey: "start" },
      { key: "dateEnd", modelSuffix: "date_end", fieldKind: "text", question: "End Date", profileKey: "end" },
    ],
  };
  const BREEZY_EDUCATION_SECTION = {
    rootFieldId: "educationHistory",
    rootQuestion: "Education",
    profileSection: "education",
    rowLabel: (i) => `Education ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    maxEntries: 5,
    getContainer: () => getBreezySectionContainer('a[ng-click*="addEducation"], input#education_required'),
    getRows: (container) => getRepeaterRows(container, "candidateSchool"),
    getRowField: getBreezySectionRowField,
    addRow: createBreezyAddRowAction(/add education/i),
    mappings: [
      { key: "school", modelSuffix: "school_name", fieldKind: "text", question: "School", profileKey: "school" },
      { key: "fieldOfStudy", modelSuffix: "field_of_study", fieldKind: "text", question: "Field of Study" },
      { key: "summary", modelSuffix: "summary", fieldKind: "textarea", question: "Degree / Summary", profileKey: "degree" },
      { key: "dateStart", modelSuffix: "date_start", fieldKind: "text", question: "Start Date", profileKey: "start" },
      { key: "dateEnd", modelSuffix: "date_end", fieldKind: "text", question: "End Date", profileKey: "end" },
    ],
  };
  const BREEZY_PROFILE_SECTIONS = [BREEZY_EDUCATION_SECTION, BREEZY_WORK_HISTORY_SECTION];

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections(BREEZY_PROFILE_SECTIONS, profileData);
  }

  async function fillSectionLeaf(field, mapping, value) {
    switch (mapping.fieldKind) {
      case "text":
      case "textarea":
        // Awaited (not the fire-and-forget fillTextInput) — a later
        // addRow() click re-renders the repeater, which must not fire
        // while this value's reassert window is still in flight.
        await engine.fillTextInputReliably(field, value);
        return;
      default:
        return;
    }
  }

  async function fillSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    const results = [];
    for (const section of BREEZY_PROFILE_SECTIONS) {
      const entries = (profileData && profileData[section.profileSection]) || [];
      if (!entries.length) continue;
      const result = await SECTION_HIERARCHY.fillSection(section, entries, fillSectionLeaf);
      results.push({ rootFieldId: section.rootFieldId, ...result });
    }
    return results;
  }

  NS.breezy = {
    isAutofillAvailable,
    advance,
    detectQuestions,
    fillField,
    getSubmitButton,
    detectSections,
    fillSections,
  };
})();
