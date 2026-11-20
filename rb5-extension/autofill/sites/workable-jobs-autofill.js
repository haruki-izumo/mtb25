/* =====================================================================
 * autofill/sites/workable-jobs-autofill.js — Workable's public job BOARD
 * (jobs.workable.com — both /view/<id> and /search*), a DIFFERENT domain
 * from apply.workable.com (that one's own port is
 * autofill/sites/workable-autofill.js, registered as
 * window.ProactiveAutofillSites.workable — NOT touched by this file).
 * =====================================================================
 * Ported from BidHub's own bundle for this domain, which — per BidHub's
 * own code — reuses its content/platforms/workable/autofill.js module
 * VERBATIM: BidHub treats jobs.workable.com and apply.workable.com as the
 * exact same application-form widget. That module (not the older/simpler
 * apply.workable.com port already in this repo) is the ground truth this
 * file was ported from, so this is a fuller port than workable-autofill.js
 * — it adds the custom combobox dropdown and the first-row
 * education/experience handling that file explicitly left out.
 *
 * As with every other autofill/sites/*.js file, every actual DOM WRITE
 * (text value, select, click, file attach) goes through
 * window.ProactiveAutofillEngine instead of reimplementing those
 * mechanics here.
 *
 * Ported, structural-only:
 *   - field enumeration/classification: text, textarea, phone (Workable's
 *     own national-number-only validator), date (format inferred from the
 *     control's own placeholder/aria-label), native <select>, Workable's
 *     custom combobox (input[role="combobox"][aria-controls] + a
 *     portal'd [role="option"] listbox), checkbox/radio groups, and the
 *     résumé/cover-letter/photo native file-upload slots
 *   - value-filling per field kind, including Workable's phone/date
 *     reformatting quirks
 *   - the "Apply" control → reveal-form step
 *   - the FIRST always-rendered row only of the Education/Work-history
 *     profile sections (see the scope note on WORKABLE_PROFILE_SECTIONS
 *     below) — opening that one row's editor, filling its named inputs,
 *     and saving it
 *   - isAutofillAvailable()/getSubmitButton() equivalents
 *
 * Explicitly OUT OF SCOPE (left for Big Banana's own existing systems or
 * dropped outright):
 *   - Free-text screening-question ANSWER GENERATION. BidHub resolves
 *     almost everything through its own AI backend (getAnswer()/ai-core,
 *     embedding-similarity option matching). None of that is ported —
 *     detectQuestions() only CLASSIFIES a question's structural type and
 *     locates its control; fillField() only WRITES an answer the caller
 *     already resolved. A select/radio/checkbox/combobox match here is
 *     exact-or-prefix text only (see findMatchingOptionText /
 *     findMatchingWorkableOption) — a looser miss is left alone for Big
 *     Banana's own pipeline to pick up.
 *   - CAPTCHA (captcha-shared.js / Cloudflare Turnstile). BidHub's
 *     detectAutofillFields() appends a synthetic Turnstile field entry it
 *     solves via its own 2captcha-backed pipeline once Submit surfaces a
 *     challenge — none of that exists here. This file clicks Submit like
 *     any other button (see getSubmitButton) and leaves whatever
 *     Workable's widget does after that alone.
 *   - Repeatable profile-section rows beyond the first (education &
 *     experience's "Add another" flow, autofill-section-hierarchy.js).
 *     This file opens, fills, and saves ONLY the section's first entry —
 *     never clicks "Add" a second time, never clears/edits an
 *     already-committed row. See the comment on WORKABLE_PROFILE_SECTIONS.
 *   - Proxy/remote-CDP "real input" lanes (BidHub's useRemoteInput()
 *     branch). Every write here goes straight through
 *     window.ProactiveAutofillEngine's synthetic-event path.
 * ===================================================================== */
(function () {
  "use strict";

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    sleep,
    fillTextInputReliably,
    setReactInputValue,
    fillSelectInput,
    fillFileInput,
    clickLikeHuman,
    getCheckboxInputs,
    getRadioInputs,
    getNativeSelect,
    getTextarea,
    getTextInput,
    getFileInputInsideField,
  } = engine;

  const SECTION_ROW_WAIT_TIMEOUT_MS = 3000;
  const SELECT_MENU_WAIT_TIMEOUT_MS = 5000;
  const FILE_UPLOAD_WAIT_TIMEOUT_MS = 5000;
  const DATE_POPOVER_CLOSE_WAIT_MS = 1000;

  // ---- small local polling helper (BidHub's waitForPositiveResultWithAbort,
  // trimmed to this file's own needs) --------------------------------------
  async function waitFor(check, timeoutMs, shouldAbort = () => false, pollMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (shouldAbort()) return null;
      const result = check();
      if (result) return result;
      await sleep(pollMs);
    }
    return null;
  }

  // ---- small text helpers -------------------------------------------------

  // Workable's own label/option text carries a required-field glyph, a
  // stray "(Optional)" suffix, an SVG-fallback string, and a "Choose file"
  // button caption all run together in textContent — strip those before
  // using the text as a question/option label or a comparison key.
  const REQUIRED_MARKERS = /[✱*]/g;
  function normalizeWorkableText(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(REQUIRED_MARKERS, "")
      .replace(/SVGs not supported by this browser\.?/gi, "")
      .replace(/\bChoose file\b/gi, "")
      .replace(/\(Optional\)/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function normalizeComparisonText(value) {
    return normalizeWorkableText(value).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }
  function escapeAttributeValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  function padDatePart(value) {
    return String(value ?? "").padStart(2, "0");
  }

  function isElementVisible(element) {
    if (!element?.isConnected) return false;
    if (element.matches?.('input[type="file"]')) return true;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function compareElementsByDocumentOrder(left, right) {
    if (left === right) return 0;
    if (!left?.compareDocumentPosition || !right?.compareDocumentPosition) return 0;
    const position = left.compareDocumentPosition(right);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }
  function sortQuestionsByDocumentOrder(questions) {
    return questions.sort((left, right) => compareElementsByDocumentOrder(left.field, right.field));
  }

  // ---- form / apply-control lookup -----------------------------------------

  function getWorkableForm() {
    return document.querySelector('form[data-ui="application-form"]');
  }
  function getWorkableActionLabel(element) {
    return normalizeWorkableText(element?.textContent || element?.value || element?.getAttribute?.("aria-label") || "");
  }
  function getWorkableApplyControl() {
    return (
      Array.from(
        document.querySelectorAll(
          [
            'a[data-ui="apply-button"]',
            'button[data-ui="overview-apply-now"]',
            'button[data-ui="sticky-apply-now"]',
            'a[href$="/apply/"]',
            'a[href*="/apply/"]',
          ].join(",")
        )
      )
        .filter(isElementVisible)
        .find((control) => /\bapply\b/i.test(getWorkableActionLabel(control))) ?? null
    );
  }

  // ---- aria-labelled / choice-group label resolution -----------------------

  function getAriaLabelledText(control) {
    return String(control?.getAttribute?.("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => normalizeWorkableText(document.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(" ");
  }
  function isChoiceControl(control) {
    return ["checkbox", "radio"].includes(control?.type);
  }
  function getChoiceControlWrapper(control) {
    if (!isChoiceControl(control)) return null;
    return control.closest('[role="checkbox"], [role="radio"], [data-ui="option"], label');
  }
  function hasVisibleChoiceControlWrapper(control) {
    const wrapper = getChoiceControlWrapper(control);
    return Boolean(wrapper) && isElementVisible(wrapper);
  }

  // ---- Workable's custom combobox (input[role="combobox"] + portal'd listbox) --

  function getWorkableCustomSelectContainer(control) {
    return control?.closest?.('[data-ui][data-input-type="select"]') ?? null;
  }
  function isWorkableCustomSelectControl(control) {
    return Boolean(control?.matches?.('input[role="combobox"][aria-controls]') && getWorkableCustomSelectContainer(control));
  }
  function getWorkableCustomSelectInput(field) {
    if (!field) return null;
    if (isWorkableCustomSelectControl(field)) return field;
    return field.querySelector?.('input[role="combobox"][aria-controls]') ?? null;
  }
  function getWorkableCustomSelectList(input) {
    const listId = input?.getAttribute?.("aria-controls") || input?.getAttribute?.("aria-owns");
    return listId ? document.getElementById(listId) : null;
  }
  function isWorkableCustomSelectOpen(input) {
    if (!input) return false;
    return input.getAttribute("aria-expanded") === "true" || getWorkableCustomSelectContainer(input)?.getAttribute("data-open") === "true";
  }
  function getWorkableCustomSelectOptionEntries(field) {
    const input = getWorkableCustomSelectInput(field);
    const list = getWorkableCustomSelectList(input);
    if (!list || !isWorkableCustomSelectOpen(input)) return [];
    return Array.from(list.querySelectorAll('[role="option"]'))
      .filter(isElementVisible)
      .map((option) => ({ text: normalizeWorkableText(option.textContent), element: option }))
      .filter((option) => option.text);
  }

  // A Workable custom-select renders its real input[role="combobox"] visually
  // hidden (opacity:0 / 1px) behind a styled container that shows the
  // selected value — the bare input fails isElementVisible, so detect it off
  // its VISIBLE container instead (same rescue hasVisibleChoiceControlWrapper
  // does for radio/checkbox). Restricted to the combobox control only: the
  // same container also holds an aria-hidden value-backing input[required]
  // that would otherwise surface as a duplicate, mis-typed text field.
  function hasVisibleCustomSelectContainer(control) {
    if (!isWorkableCustomSelectControl(control)) return false;
    const container = getWorkableCustomSelectContainer(control);
    return Boolean(container) && isElementVisible(container);
  }

  function dispatchOutsideClick() {
    const fire = (type, buttons) =>
      document.body.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, clientX: 5, clientY: 5, button: 0, buttons })
      );
    fire("mousedown", 1);
    fire("mouseup", 0);
    fire("click", 0);
  }

  async function openWorkableCustomSelect(field, shouldAbort = () => false) {
    const input = getWorkableCustomSelectInput(field);
    if (!input || shouldAbort()) return null;
    const liveList = getWorkableCustomSelectList(input);
    if (liveList && isWorkableCustomSelectOpen(input)) return liveList;
    input.scrollIntoView({ block: "center", inline: "nearest" });
    input.focus();
    input.click();
    return waitFor(
      () => {
        const list = getWorkableCustomSelectList(input);
        return list && isWorkableCustomSelectOpen(input) ? list : null;
      },
      SELECT_MENU_WAIT_TIMEOUT_MS,
      shouldAbort,
      100
    );
  }
  async function closeWorkableCustomSelect(field, shouldAbort = () => false) {
    const input = getWorkableCustomSelectInput(field);
    if (!input || !isWorkableCustomSelectOpen(input)) return;
    dispatchOutsideClick();
    await waitFor(() => !isWorkableCustomSelectOpen(input), SELECT_MENU_WAIT_TIMEOUT_MS, shouldAbort, 50);
  }

  // Exact-or-prefix text match only, same AI-boundary every other ported
  // site keeps: BidHub's own getBestMatchingOption() falls back to an
  // embedding-similarity call for anything looser — that's the out-of-scope
  // AI-answer backend, so a looser-than-prefix miss here returns null and
  // leaves the field alone for Big Banana's generic pipeline to try.
  function findMatchingWorkableOption(answer, entries) {
    const normalizedAnswer = normalizeComparisonText(answer);
    if (!normalizedAnswer) return null;
    return (
      entries.find((entry) => normalizeComparisonText(entry.text) === normalizedAnswer) ||
      entries.find((entry) => normalizeComparisonText(entry.text).startsWith(normalizedAnswer)) ||
      null
    );
  }

  async function fillWorkableCustomSelect(field, answer, { shouldAbort = () => false } = {}) {
    const text = String(answer ?? "").trim();
    if (!text || shouldAbort()) return;
    const list = await openWorkableCustomSelect(field, shouldAbort);
    if (!list || shouldAbort()) return;
    const match = findMatchingWorkableOption(text, getWorkableCustomSelectOptionEntries(field));
    if (!match) {
      await closeWorkableCustomSelect(field, shouldAbort);
      return;
    }
    await clickLikeHuman(match.element, { shouldAbort });
  }

  // ---- label resolution (text fields, choice groups) -----------------------

  function getChoiceGroupField(control) {
    if (!control || !["checkbox", "radio"].includes(control.type) || !control.name) return null;
    const form = getWorkableForm();
    const scopedGroup = control.closest('fieldset, [role="group"], [role="radiogroup"]');
    const scopedGroupInputs = Array.from(scopedGroup?.querySelectorAll?.(`input[type="${control.type}"]`) ?? []);
    if (scopedGroupInputs.length > 1) return scopedGroup;
    const sameNameInputs = Array.from(form?.querySelectorAll(`input[type="${control.type}"][name="${escapeAttributeValue(control.name)}"]`) ?? []);
    if (sameNameInputs.length <= 1) return null;
    const containsEveryInput = (candidate) => Boolean(candidate) && sameNameInputs.every((input) => candidate.contains(input));
    if (containsEveryInput(scopedGroup)) return scopedGroup;
    let candidate = control.parentElement;
    while (candidate && candidate !== form) {
      if (containsEveryInput(candidate)) return candidate;
      candidate = candidate.parentElement;
    }
    return null;
  }

  function getQuestionField(control) {
    if (!control) return null;
    const choiceGroup = getChoiceGroupField(control);
    if (choiceGroup) return choiceGroup;
    if (isWorkableCustomSelectControl(control)) return getWorkableCustomSelectContainer(control) || control.closest("label") || control;
    if (control.type === "file") return control.closest('[data-role="dropzone"]') || control.closest("section, label, div") || control;
    return control.closest('label, fieldset, [role="group"]') || control;
  }

  function getControlLabelText(control, field = null) {
    if (!control) return "";
    if (isChoiceControl(control)) {
      const groupText = getAriaLabelledText(field);
      if (groupText) return normalizeWorkableText(groupText);
    }
    const ariaText = getAriaLabelledText(control);
    if (ariaText) return normalizeWorkableText(ariaText);
    const stableId = control.id || control.name || control.getAttribute("data-ui");
    if (stableId) {
      const linkedText = normalizeWorkableText(document.getElementById(`${stableId}_label`)?.textContent);
      if (linkedText) return linkedText;
    }
    const label = control.closest("label");
    const labelText = normalizeWorkableText(label?.querySelector('[id$="_label"], [id$="-label"], [id$="label"]')?.textContent || label?.textContent);
    if (labelText) return labelText;
    return normalizeWorkableText(control.getAttribute("aria-label") || control.name || control.id);
  }

  function getChoiceInputLabelText(input, fallbackQuestion = "") {
    const wrapper = getChoiceControlWrapper(input);
    const wrapperLabelTexts = String(wrapper?.getAttribute?.("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => ({ id, text: normalizeWorkableText(document.getElementById(id)?.textContent) }))
      .filter((entry) => entry.text);
    const optionLabel = wrapperLabelTexts.find((entry) => /(?:^|_)label_/i.test(entry.id));
    if (optionLabel?.text) return optionLabel.text;
    const wrappedLabel = input?.closest?.("label");
    const labelText = normalizeWorkableText(
      wrappedLabel?.querySelector('[id^="radio_label_"], [id^="checkbox_label_"], [id$="_label"], [id$="-label"], [id$="label"]')?.textContent ||
        wrappedLabel?.textContent
    );
    if (labelText) return labelText;
    return normalizeWorkableText(input?.value || fallbackQuestion);
  }

  function isAriaRequired(control) {
    return Boolean(control?.required) || control?.getAttribute?.("aria-required") === "true";
  }
  // A required custom-select keeps its OWN required-ness on a hidden,
  // aria-hidden value-backing input rather than the visible combobox input
  // — check that too so a required dropdown isn't reported as optional.
  function isWorkableFieldRequired(control, field) {
    if (isAriaRequired(control)) return true;
    const hiddenRequired =
      getWorkableCustomSelectContainer(control)?.querySelector('input[aria-hidden="true"][required], input[tabindex="-1"][required]') ||
      field?.querySelector?.('input[aria-hidden="true"][required], input[tabindex="-1"][required]');
    return Boolean(hiddenRequired);
  }

  function shouldSkipControl(control) {
    if (!control) return true;
    if (control.type === "hidden") return true;
    const hasVisibleHost = hasVisibleChoiceControlWrapper(control) || hasVisibleCustomSelectContainer(control);
    if (control.getAttribute("aria-hidden") === "true" && !hasVisibleHost) return true;
    if (!isElementVisible(control) && !hasVisibleHost) return true;
    return false;
  }

  function isInsideWorkableProfileBlock(control) {
    return Boolean(control?.closest?.('[data-ui="education"], [data-ui="experience"]'));
  }

  // ---- field-kind classification -------------------------------------------

  function isPhoneField(question, control) {
    const name = normalizeComparisonText(control?.name);
    return name === "phone" || normalizeComparisonText(question).includes("phone") || control?.type === "tel";
  }
  function isResumeField(question, control) {
    const dataUi = normalizeComparisonText(control?.getAttribute?.("data-ui"));
    const name = normalizeComparisonText(control?.name);
    return dataUi === "resume" || name === "resume" || /\b(resume|cv)\b/.test(normalizeComparisonText(question));
  }
  function isCoverLetterField(question, control) {
    const dataUi = normalizeComparisonText(control?.getAttribute?.("data-ui"));
    const name = normalizeComparisonText(control?.name);
    return dataUi === "cover-letter" || dataUi === "cover_letter" || name === "cover-letter" || name === "cover_letter" || /cover\s*letter/.test(normalizeComparisonText(question));
  }
  // Workable's default "Photo" field (application-form key `avatar`;
  // employers can set it Mandatory). Filled from a profile photo; skipped
  // when the caller has none to offer.
  function isPhotoField(question, control) {
    const dataUi = normalizeComparisonText(control?.getAttribute?.("data-ui"));
    const name = normalizeComparisonText(control?.name);
    return dataUi === "avatar" || dataUi === "photo" || name === "avatar" || name === "photo" || /\b(photo|picture|headshot|avatar)\b/.test(normalizeComparisonText(question));
  }
  function isUnsupportedFileField(question, control) {
    if (control?.type !== "file") return false;
    return !(isResumeField(question, control) || isCoverLetterField(question, control) || isPhotoField(question, control));
  }

  function normalizeWorkableDateFormat(value) {
    const normalized = normalizeWorkableText(value).toUpperCase();
    if (!normalized) return null;
    if (/^MM[/-]DD[/-]YYYY$/.test(normalized)) return "MM/DD/YYYY";
    if (/^DD[/-]MM[/-]YYYY$/.test(normalized)) return "DD/MM/YYYY";
    if (/^YYYY[/-]MM[/-]DD$/.test(normalized)) return "YYYY-MM-DD";
    if (/^MM[/-]YYYY$/.test(normalized)) return "MM/YYYY";
    if (/^YYYY$/.test(normalized)) return "YYYY";
    return null;
  }
  // Workable never marks a plain text input as type="date" on this board —
  // the format has to be inferred from whatever hint the control itself
  // carries (its placeholder, its aria-label, or — for the numeric-keypad
  // "when can you start" style question — its inputmode plus the question
  // text itself).
  function inferWorkableDateFormat(question, control) {
    if (!control) return null;
    if (control.type === "date") return "YYYY-MM-DD";
    const placeholderFormat = normalizeWorkableDateFormat(control.getAttribute?.("placeholder"));
    if (placeholderFormat) return placeholderFormat;
    const ariaFormat = normalizeWorkableDateFormat(control.getAttribute?.("aria-label"));
    if (ariaFormat) return ariaFormat;
    if (control.getAttribute?.("inputmode") === "tel" && /\b(date|available|start working|start work)\b/i.test(question || "")) {
      return "MM/DD/YYYY";
    }
    return null;
  }

  function getSelectOptionEntries(field) {
    const select = getNativeSelect(field);
    if (!select) return [];
    return Array.from(select.querySelectorAll("option"))
      .filter((option) => option.value)
      .map((option) => ({ value: option.value, text: normalizeWorkableText(option.textContent) }))
      .filter((option) => option.text);
  }

  function classifyWorkableField(question, field, control) {
    if (control.type === "file") {
      if (isResumeField(question, control)) return { fieldKind: "resume", options: [], control };
      if (isCoverLetterField(question, control)) return { fieldKind: "cover_letter", options: [], control };
      if (isPhotoField(question, control)) return { fieldKind: "photo", options: [], control };
      return null; // an unrecognized file slot — leave it to the generic pipeline
    }
    const checkboxInputs = getCheckboxInputs(field);
    if (checkboxInputs.length === 1) {
      // A lone checkbox (consent / agreement / opt-in) is inherently yes/no.
      return { fieldKind: "checkbox-single", options: ["Yes", "No"], control: checkboxInputs[0] };
    }
    if (checkboxInputs.length > 0) {
      return {
        fieldKind: "checkbox",
        options: checkboxInputs.map((cb) => getChoiceInputLabelText(cb, question)).filter(Boolean),
        control: checkboxInputs[0],
      };
    }
    const radioInputs = getRadioInputs(field);
    if (radioInputs.length > 0) {
      return {
        fieldKind: "radio",
        options: radioInputs.map((radio) => getChoiceInputLabelText(radio, question)).filter(Boolean),
        control: radioInputs[0],
      };
    }
    const select = getNativeSelect(field);
    if (select) {
      return { fieldKind: "select-native", options: getSelectOptionEntries(field).map((o) => o.text), control: select };
    }
    if (isWorkableCustomSelectControl(control)) {
      // Options only exist once the menu is opened — fillField's
      // 'select-custom' handler opens it on demand instead of relying on
      // whatever was (or wasn't) populated here.
      return { fieldKind: "select-custom", options: [], control };
    }
    const textarea = getTextarea(field);
    if (textarea) {
      const isCoverLetter = isCoverLetterField(question, textarea);
      return { fieldKind: isCoverLetter ? "cover_letter" : "textarea", options: [], control: textarea };
    }
    if (isPhoneField(question, control)) {
      return { fieldKind: "phone", options: [], control };
    }
    const dateFormat = inferWorkableDateFormat(question, control);
    if (dateFormat) {
      return { fieldKind: "date", options: [], control, dateFormat };
    }
    const input = getTextInput(field);
    if (input) {
      return { fieldKind: "text", options: [], control: input };
    }
    return null;
  }

  // ---- profile-section (education / work-history) FIRST ROW ONLY ----------
  //
  // Workable commits one education/work-history entry at a time: an
  // "Add"-button click opens a fresh [data-ui="editor"] of named inputs,
  // and a "Save" click inside it commits the entry into a read-only
  // summary card (ul > li [data-ui="group"]) — repeatable for as many
  // entries as the applicant wants. BidHub's own autofill-section-
  // hierarchy.js drives that whole repeatable add/fill/save/add-again
  // loop; per this port's scope, NONE of that repeatable machinery is
  // ported. This file only ever opens, fills, and saves the section's
  // FIRST entry (and only when the section has no committed entry yet —
  // e.g. one Workable's own résumé-parse prefill already created) — it
  // never clicks "Add" a second time and never edits an existing card.
  const WORKABLE_EDUCATION_SECTION = {
    sectionType: "education",
    rootQuestion: "Education",
    fieldKind: "profile-section-education",
    fields: [
      { key: "school", domName: "school", kind: "text" },
      { key: "fieldOfStudy", domName: "field_of_study", kind: "text" },
      { key: "degree", domName: "degree", kind: "text" },
      { key: "startDate", domName: "start_date", kind: "date" },
      { key: "endDate", domName: "end_date", kind: "date" },
    ],
  };
  const WORKABLE_WORK_HISTORY_SECTION = {
    sectionType: "experience",
    rootQuestion: "Work history",
    fieldKind: "profile-section-experience",
    fields: [
      { key: "title", domName: "title", kind: "text" },
      { key: "company", domName: "company", kind: "text" },
      { key: "summary", domName: "summary", kind: "text" },
      { key: "startDate", domName: "start_date", kind: "date" },
      // "Current role" is checked first: Workable removes the End-date
      // input the moment it's ticked, so End-date (next in this list)
      // simply finds no control and is skipped — same as any other field
      // that disappears between detection passes.
      { key: "current", domName: "current", kind: "checkbox" },
      { key: "endDate", domName: "end_date", kind: "date" },
    ],
  };
  const WORKABLE_PROFILE_SECTIONS = [WORKABLE_EDUCATION_SECTION, WORKABLE_WORK_HISTORY_SECTION];

  function getWorkableProfileSection(sectionType) {
    const section = document.querySelector(`[data-ui="${escapeAttributeValue(sectionType)}"]`);
    return isElementVisible(section) ? section : null;
  }
  function getSectionEditor(section) {
    return section?.querySelector?.('[data-ui="editor"]') ?? null;
  }
  function getSectionSavedRows(section) {
    return Array.from(section?.querySelectorAll?.("ul > li [data-ui=\"group\"]") ?? []).map((group) => group.closest("li") || group);
  }
  function getSectionAddButton(section) {
    return section?.querySelector?.('button[data-ui="add-section"]:not([disabled]):not([aria-disabled="true"])') ?? null;
  }
  function getSectionEditorControl(editor, name) {
    if (!editor || !name) return null;
    return editor.querySelector(`input[name="${escapeAttributeValue(name)}"], textarea[name="${escapeAttributeValue(name)}"]`);
  }

  async function closeWorkableDatePopover(control, shouldAbort = () => false) {
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape", code: "Escape", keyCode: 27, which: 27 }));
    control.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, key: "Escape", code: "Escape", keyCode: 27, which: 27 }));
    control.blur();
    dispatchOutsideClick();
    await waitFor(() => document.activeElement !== control, DATE_POPOVER_CLOSE_WAIT_MS, shouldAbort, 50);
  }

  // Workable's section-row date inputs (start_date/end_date) pop open a
  // calendar on focus — a bare value write never engages the control's own
  // mask (the typed text never visually replaces the placeholder), so a
  // throwaway keydown wakes the mask up first, and the popover is explicitly
  // dismissed afterward (Escape + an outside click) so it isn't left open
  // blocking the section's own Save button underneath it.
  async function fillWorkableSectionDateInput(control, value, { shouldAbort = () => false } = {}) {
    const text = String(value ?? "").trim();
    if (!text || !control || shouldAbort()) return;
    control.focus();
    control.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "0", code: "Digit0", keyCode: 48, which: 48 }));
    setReactInputValue(control, text);
    control.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: text.at(-1) || null, inputType: "insertText" }));
    control.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    await closeWorkableDatePopover(control, shouldAbort);
  }

  async function fillWorkableProfileSectionFirstRow(sectionDef, answer, { shouldAbort = () => false } = {}) {
    if (!answer || typeof answer !== "object") return;
    const section = getWorkableProfileSection(sectionDef.sectionType);
    if (!section || shouldAbort()) return;
    // Never touch a section that already has a committed entry — the scope
    // here is strictly the first always-rendered row; an existing row (e.g.
    // from Workable's own résumé-parse prefill) means this section's job is
    // already done.
    if (getSectionSavedRows(section).length > 0) return;

    let editor = getSectionEditor(section);
    if (!editor) {
      const addButton = getSectionAddButton(section);
      if (!addButton) return;
      await clickLikeHuman(addButton, { shouldAbort });
      editor = await waitFor(() => getSectionEditor(section), SECTION_ROW_WAIT_TIMEOUT_MS, shouldAbort, 100);
      if (!editor) return;
    }

    for (const fieldDef of sectionDef.fields) {
      if (shouldAbort()) return;
      const value = answer[fieldDef.key];
      if (value == null || value === "") continue;
      const control = getSectionEditorControl(editor, fieldDef.domName);
      if (!control || shouldSkipControl(control)) continue;
      if (fieldDef.kind === "checkbox") {
        const shouldCheck = isAffirmativeAnswer(value);
        if (control.checked !== shouldCheck) await clickLikeHuman(control, { shouldAbort });
      } else if (fieldDef.kind === "date") {
        await fillWorkableSectionDateInput(control, formatWorkableDateAnswer(value, { format: "MM/YYYY" }), { shouldAbort });
      } else {
        await fillTextInputReliably(control, value, { shouldAbort });
      }
    }

    const saveButton = editor.querySelector('button[data-ui="save-section"]');
    if (!saveButton || shouldAbort()) return;
    const previousRowCount = getSectionSavedRows(section).length;
    await clickLikeHuman(saveButton, { shouldAbort });
    // Committed = the editor unmounts AND the saved-row count grew. An empty
    // required field just keeps the editor open (Workable blocks the save) —
    // left as-is rather than retried, same as BidHub's own warn-and-move-on.
    await waitFor(
      () => (!getSectionEditor(section) && getSectionSavedRows(section).length > previousRowCount ? true : null),
      SECTION_ROW_WAIT_TIMEOUT_MS,
      shouldAbort,
      100
    );
  }

  // ---- detection ------------------------------------------------------------

  /**
   * Walk Workable's application form and return every question this
   * adapter knows how to fill deterministically. Anything classifyWorkableField
   * can't place, or a field with no derivable question text, is left out —
   * which is how it's "left alone" for Big Banana's own generic/AI pipeline
   * per the scope note at the top of this file.
   *
   * @returns {Array<{question:string, field:Element, control:Element,
   *   fieldKind:string, options:string[], required:boolean, dateFormat?:string}>}
   */
  function detectQuestions() {
    const form = getWorkableForm();
    if (!form) return [];

    const questions = [];
    const seenChoiceFields = new Set();
    const controls = Array.from(form.querySelectorAll('input:not([type="hidden"]), textarea, select'))
      .filter((control) => !isInsideWorkableProfileBlock(control))
      .filter((control) => !shouldSkipControl(control));

    for (const control of controls) {
      const field = getQuestionField(control);
      const question = getControlLabelText(control, field);
      if (!question || !field) continue;
      if (isUnsupportedFileField(question, control)) continue;
      if (isChoiceControl(control)) {
        if (seenChoiceFields.has(field)) continue;
        seenChoiceFields.add(field);
      }
      const classified = classifyWorkableField(question, field, control);
      if (!classified) continue;
      questions.push({
        question,
        field,
        control: classified.control,
        fieldKind: classified.fieldKind,
        options: classified.options,
        required: isWorkableFieldRequired(classified.control, field),
        ...(classified.dateFormat ? { dateFormat: classified.dateFormat } : {}),
      });
    }

    // The two profile sections used to surface here as one synthetic
    // "first row only" question each (see WORKABLE_PROFILE_SECTIONS above)
    // when empty — now fully superseded by the dedicated section-hierarchy
    // port below (detectSections/fillSections), which covers every row
    // including an empty one (shown as a real "Education"/"Work history"
    // card with a 0 entry count). Leaving this block in would show each
    // section twice — a flat synthetic question AND the real grouped card
    // — whenever a section had no rows yet.

    return sortQuestionsByDocumentOrder(questions);
  }

  // Workable's posting page and its application form are the same
  // document — the "Apply" button just reveals form[data-ui="application-
  // form"] in place (no navigation). Mirrors BidHub's own
  // isWorkableAutofillAvailable(), and works the same whether the page is
  // a direct /view/<id> posting or the /search two-pane detail view, since
  // both render the identical application-form widget once Apply is open.
  function isAutofillAvailable() {
    return Boolean(getWorkableForm() || getWorkableApplyControl());
  }

  function getSubmitButton() {
    const form = getWorkableForm();
    if (!form) return null;
    return (
      Array.from(form.querySelectorAll(['button[data-ui="apply-button"]', 'button[type="submit"]', 'input[type="submit"]'].join(",")))
        .filter(isElementVisible)
        .find((button) => /\b(submit|apply)\b/i.test(getWorkableActionLabel(button))) ?? null
    );
  }

  // Workable's one and only page-level "step" per BidHub's own module: the
  // posting's Apply control, which reveals the application form in place.
  // BidHub's workable/autofill.js has no further in-form Next/Continue
  // button classifier beyond that — like Lever, this is one long scrolling
  // form ending in Submit.
  async function advance({ shouldAbort = () => false } = {}) {
    if (getWorkableForm()) return false;
    const applyControl = getWorkableApplyControl();
    if (!applyControl || shouldAbort()) return false;
    await clickLikeHuman(applyControl, { shouldAbort });
    return true;
  }

  // Clicking Submit is NOT solving whatever CAPTCHA/Turnstile challenge
  // Workable's own widget runs next (out of scope per the top-of-file
  // note) — this just presses the button a person would press.
  async function clickSubmitButton({ shouldAbort = () => false } = {}) {
    const button = getSubmitButton();
    if (!button || shouldAbort()) return false;
    await clickLikeHuman(button, { shouldAbort });
    return true;
  }

  // ---- filling --------------------------------------------------------------

  const NEGATIVE_ANSWER_PATTERN = /^(?:no|nope|n|false|none)\b|\b(?:decline[ds]?|disagree[ds]?|do(?:es)?\s*n['’o]?t|opt[ -]?out)\b/i;
  const AFFIRMATIVE_ANSWER_PATTERN = /\b(?:y|yes|yeah|yep|true|agree[ds]?|accept(?:ed|s)?|acknowledge[ds]?|consent(?:ed|s)?|certif(?:y|ied|ies)|authoriz\w*|opt[ -]?in|checked|on)\b/i;
  function isAffirmativeAnswer(answer) {
    if (typeof answer === "boolean") return answer;
    const text = normalizeWorkableText(answer);
    if (!text) return false;
    if (NEGATIVE_ANSWER_PATTERN.test(text)) return false;
    return AFFIRMATIVE_ANSWER_PATTERN.test(text);
  }

  function findMatchingOptionText(answer, optionTexts) {
    const normalizedAnswer = normalizeComparisonText(answer);
    if (!normalizedAnswer) return null;
    return (
      optionTexts.find((text) => normalizeComparisonText(text) === normalizedAnswer) ||
      optionTexts.find((text) => normalizeComparisonText(text).startsWith(normalizedAnswer)) ||
      null
    );
  }

  async function setWorkableChoice(input, shouldBeChecked, { shouldAbort = () => false } = {}) {
    if (Boolean(input.checked) === Boolean(shouldBeChecked)) return;
    await clickLikeHuman(input, { shouldAbort });
  }

  // Workable owns the dial code (the flag/country selector beside the
  // input), so the text field itself takes the NATIONAL number only, and
  // its validator accepts exactly `xxx xxx xxxx` — a verbatim profile value
  // ("(555) 123-4567", "+1 555 123 4567") fails "Phone number is invalid"
  // on submit. An explicit "+CC" is always dropped (separator-delimited →
  // the leading group; compact "+15551234567" → assume a 10-digit national
  // number); a bare NANP "1" is dropped only when 11 digits remain; a
  // ≤10-digit number is never touched. A 10-digit national number is
  // rendered `xxx xxx xxxx`; anything else falls back to the bare digits.
  function formatWorkablePhoneAnswer(answer) {
    if (answer && typeof answer === "object") return answer;
    const value = String(answer ?? "").trim();
    if (!value) return "";
    let digits = value.replace(/\D/g, "");
    if (value.startsWith("+")) {
      const delimited = value.match(/^\+\s*(\d{1,3})(?=[\s().-])/);
      const codeLength = delimited ? delimited[1].length : Math.min(3, Math.max(0, digits.length - 10));
      digits = digits.slice(codeLength);
    } else if (digits.length === 11 && digits.startsWith("1")) {
      digits = digits.slice(1);
    }
    if (digits.length !== 10) return digits;
    return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
  }

  // Reformats `answer` into whatever date format the control itself was
  // inferred to want (constraints.format from inferWorkableDateFormat /
  // the fixed "MM/YYYY" the profile-section start/end-date inputs always
  // use). Falls back to the raw value when it can't be parsed at all —
  // never blocks a fill over an unrecognized date shape.
  function formatWorkableDateAnswer(answer, { format } = {}) {
    const rawValue = String(answer ?? "").trim();
    if (!rawValue || !format) return rawValue;

    const isoFullMatch = rawValue.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/);
    if (isoFullMatch) {
      const [, year, month, day] = isoFullMatch;
      if (format === "YYYY-MM-DD") return `${year}-${padDatePart(month)}-${padDatePart(day)}`;
      if (format === "MM/DD/YYYY") return `${padDatePart(month)}/${padDatePart(day)}/${year}`;
      if (format === "DD/MM/YYYY") return `${padDatePart(day)}/${padDatePart(month)}/${year}`;
    }
    const slashFullMatch = rawValue.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (slashFullMatch) {
      const [, first, second, rawYear] = slashFullMatch;
      const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
      if (format === "YYYY-MM-DD") return `${year}-${padDatePart(first)}-${padDatePart(second)}`;
      if (format === "MM/DD/YYYY") return `${padDatePart(first)}/${padDatePart(second)}/${year}`;
      if (format === "DD/MM/YYYY") return `${padDatePart(second)}/${padDatePart(first)}/${year}`;
    }
    const namedFullMatch = rawValue.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
    if (namedFullMatch) {
      const [, monthName, day, year] = namedFullMatch;
      const monthIndex = [
        "january", "february", "march", "april", "may", "june",
        "july", "august", "september", "october", "november", "december",
      ].findIndex((month) => month.startsWith(monthName.toLowerCase()));
      if (monthIndex >= 0) {
        const month = padDatePart(monthIndex + 1);
        if (format === "YYYY-MM-DD") return `${year}-${month}-${padDatePart(day)}`;
        if (format === "MM/DD/YYYY") return `${month}/${padDatePart(day)}/${year}`;
        if (format === "DD/MM/YYYY") return `${padDatePart(day)}/${month}/${year}`;
      }
    }
    const parsed = parseWorkableProfileDate(rawValue);
    if (parsed.year && format === "YYYY") return parsed.year;
    if (parsed.year && format === "MM/YYYY") return parsed.month ? `${parsed.month}/${parsed.year}` : parsed.year;
    if (parsed.year && format === "YYYY-MM-DD") return `${parsed.year}-${parsed.month || "01"}-01`;
    if (parsed.year && format === "MM/DD/YYYY") return `${parsed.month || "01"}/01/${parsed.year}`;
    if (parsed.year && format === "DD/MM/YYYY") return `01/${parsed.month || "01"}/${parsed.year}`;
    return rawValue;
  }

  // Trimmed copy of BidHub's shared date-utils.js parseProfileDate — only
  // the piece formatWorkableDateAnswer's fallback branch needs (ISO/slash/
  // named-month/bare-year parsing into {month, day, year}).
  const WORKABLE_MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  function parseWorkableProfileDate(dateStr) {
    const value = String(dateStr ?? "").trim();
    if (!value) return { month: null, day: null, year: null };
    const pad = (part) => (part ? String(part).padStart(2, "0") : null);
    const isoMatch = value.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:T.*)?$/);
    if (isoMatch) return { month: pad(isoMatch[2]), day: pad(isoMatch[3]), year: isoMatch[1] };
    const monthYearMatch = value.match(/^(\d{1,2})[/-](\d{4})$/);
    if (monthYearMatch) return { month: monthYearMatch[1].padStart(2, "0"), day: null, year: monthYearMatch[2] };
    const numericDateMatch = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (numericDateMatch) {
      const year = numericDateMatch[3].length === 2 ? `20${numericDateMatch[3]}` : numericDateMatch[3];
      return { month: numericDateMatch[1].padStart(2, "0"), day: numericDateMatch[2].padStart(2, "0"), year };
    }
    const nameMatch = value.match(/^([A-Za-z]+)\s+(?:(\d{1,2}),?\s+)?(\d{4})$/);
    if (nameMatch) {
      const monthIndex = WORKABLE_MONTH_NAMES.findIndex((month) => month.toLowerCase().startsWith(nameMatch[1].toLowerCase()));
      return { month: monthIndex >= 0 ? String(monthIndex + 1).padStart(2, "0") : null, day: pad(nameMatch[2]), year: nameMatch[3] };
    }
    if (/^\d{4}$/.test(value)) return { month: null, day: null, year: value };
    return { month: null, day: null, year: null };
  }

  function getLiveWorkableFileUploadField(dataUi, fallbackField) {
    const liveInput = document.querySelector(`form[data-ui="application-form"] input[type="file"][data-ui="${escapeAttributeValue(dataUi)}"]`);
    return liveInput?.closest('[data-role="dropzone"]') || liveInput || (fallbackField?.isConnected ? fallbackField : null);
  }
  function getWorkableFileDeleteButton(field) {
    return (
      Array.from(field?.querySelectorAll?.('button, [role="button"]') ?? []).find((button) => {
        const label = normalizeWorkableText(button.getAttribute("aria-label") || button.textContent);
        return /\b(delete|remove)\b/i.test(label) && isElementVisible(button);
      }) ?? null
    );
  }
  // Resolves the live file input of a Workable upload field, first removing
  // an already-attached file so the new one registers as a change (re-runs
  // must replace, not no-op).
  async function ensureWorkableFileInput(field, dataUi, shouldAbort = () => false) {
    const resolveField = () => getLiveWorkableFileUploadField(dataUi, field);
    if (shouldAbort()) return null;
    const deleteButton = getWorkableFileDeleteButton(resolveField());
    if (deleteButton) {
      await clickLikeHuman(deleteButton, { shouldAbort });
      return waitFor(
        () => {
          const refreshed = resolveField();
          return !getWorkableFileDeleteButton(refreshed) ? getFileInputInsideField(refreshed) : null;
        },
        FILE_UPLOAD_WAIT_TIMEOUT_MS,
        shouldAbort,
        100
      );
    }
    return getFileInputInsideField(resolveField());
  }

  /**
   * Write an already-resolved answer into a question returned by
   * detectQuestions(), dispatched by its fieldKind. The caller owns
   * deciding WHAT the answer is — this only owns getting it onto the page
   * using window.ProactiveAutofillEngine's primitives.
   *
   * @param {{field:Element, control:Element, fieldKind:string, dateFormat?:string}} question
   * @param {*} answer - string for text/textarea/phone/date/select-native/
   *   select-custom/radio; string|string[]|boolean for checkbox/
   *   checkbox-single; {type:"file", fileName, base64, mimeType} for
   *   resume/cover_letter/photo (cover_letter also accepts a plain string,
   *   written as text); a plain object keyed by each field's `key` (see
   *   WORKABLE_EDUCATION_SECTION/WORKABLE_WORK_HISTORY_SECTION) for
   *   profile-section-education/profile-section-experience.
   */
  async function fillField(question, answer, { shouldAbort = () => false } = {}) {
    const { field, control, fieldKind, dateFormat } = question;
    if (answer == null || shouldAbort()) return;

    switch (fieldKind) {
      case "text":
      case "textarea": {
        await fillTextInputReliably(control, answer, { shouldAbort });
        return;
      }
      case "phone": {
        const formatted = formatWorkablePhoneAnswer(answer);
        if (typeof formatted === "string" && formatted) await fillTextInputReliably(control, formatted, { shouldAbort });
        return;
      }
      case "date": {
        const formatted = formatWorkableDateAnswer(answer, { format: dateFormat });
        if (formatted) await fillTextInputReliably(control, formatted, { shouldAbort });
        return;
      }
      case "cover_letter": {
        if (typeof answer === "string") {
          await fillTextInputReliably(control, answer, { shouldAbort });
        } else if (answer?.type === "file") {
          const input = getFileInputInsideField(field) || (control?.type === "file" ? control : null);
          if (input) fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        }
        return;
      }
      case "resume": {
        if (answer?.type !== "file") return;
        const input = await ensureWorkableFileInput(field, "resume", shouldAbort);
        if (input) fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        return;
      }
      case "photo": {
        if (answer?.type !== "file") return;
        const input = await ensureWorkableFileInput(field, "avatar", shouldAbort);
        if (input) fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        return;
      }
      case "select-native": {
        const select = getNativeSelect(field);
        if (!select) return;
        const entries = getSelectOptionEntries(field);
        const matchedText = findMatchingOptionText(answer, entries.map((o) => o.text));
        if (!matchedText) return;
        const matchedOption = entries.find((o) => o.text === matchedText);
        if (matchedOption) fillSelectInput(select, matchedOption.value);
        return;
      }
      case "select-custom": {
        await fillWorkableCustomSelect(field, answer, { shouldAbort });
        return;
      }
      case "checkbox-single": {
        const checkbox = getCheckboxInputs(field)[0];
        if (!checkbox) return;
        if (isAffirmativeAnswer(answer) && !checkbox.checked) await setWorkableChoice(checkbox, true, { shouldAbort });
        return;
      }
      case "checkbox": {
        const checkboxInputs = getCheckboxInputs(field);
        const selectedValues = Array.isArray(answer)
          ? answer.map((v) => normalizeWorkableText(v))
          : typeof answer === "boolean"
          ? []
          : [normalizeWorkableText(answer)];
        for (const checkbox of checkboxInputs) {
          const label = getChoiceInputLabelText(checkbox);
          const shouldCheck =
            typeof answer === "boolean" ? answer : selectedValues.includes(label) || selectedValues.includes(normalizeWorkableText(checkbox.value));
          if (checkbox.checked !== shouldCheck) await setWorkableChoice(checkbox, shouldCheck, { shouldAbort });
        }
        return;
      }
      case "radio": {
        const selectedValue = normalizeWorkableText(answer);
        for (const radio of getRadioInputs(field)) {
          const label = getChoiceInputLabelText(radio);
          if (selectedValue === label || selectedValue === normalizeWorkableText(radio.value)) {
            if (!radio.checked) await setWorkableChoice(radio, true, { shouldAbort });
            return;
          }
        }
        return;
      }
      case "profile-section-education": {
        await fillWorkableProfileSectionFirstRow(WORKABLE_EDUCATION_SECTION, answer, { shouldAbort });
        return;
      }
      case "profile-section-experience": {
        await fillWorkableProfileSectionFirstRow(WORKABLE_WORK_HISTORY_SECTION, answer, { shouldAbort });
        return;
      }
      default:
        return;
    }
  }

  // ---- repeatable Education/Work-history sections (ALL entries) ---------
  // WORKABLE_PROFILE_SECTIONS/fillWorkableProfileSectionFirstRow above
  // (and detectQuestions()'s "profile-section-education"/"-experience"
  // entries) are BidHub's own FIRST-ROW-ONLY port — left untouched. This
  // is the separate, newer multi-row engine
  // (window.ProactiveSectionHierarchy) wired up alongside it: same
  // Workable editor mechanics (Add → [data-ui="editor"] → named inputs →
  // Save → collapses into `ul > li [data-ui="group"]`), but repeats for
  // every profile entry instead of stopping after the first — identical
  // config to apply.workable.com's own copy in workable-autofill.js.
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;

  function getWorkableSectionCommittedRows(section) {
    return getSectionSavedRows(section);
  }
  // Committed rows plus the currently-open (not-yet-saved) editor, so
  // ensureRow()'s getRows()[index] lookup finds a freshly-added entry
  // before it's ever saved.
  function getWorkableSectionRows(section) {
    const committed = getWorkableSectionCommittedRows(section);
    const editor = getSectionEditor(section);
    return editor ? [...committed, editor] : committed;
  }
  // Named inputs only really exist while the editor is open — a committed
  // (collapsed) row has none in the DOM, so this naturally returns null
  // for a closed row (detected-but-no-leaf, same tradeoff the first-row
  // port above and this port's other editor-mode sites accept).
  function getWorkableSectionRowField(rowEl, mapping) {
    const field = getSectionEditorControl(rowEl, mapping.controlName);
    return field ? { field } : null;
  }
  async function addWorkableSectionRow(section) {
    const button = getSectionAddButton(section);
    if (!button) return;
    await clickLikeHuman(button);
  }
  // Removes every committed entry in reverse order (removing one can shift
  // later rows' indices) — up to 3 passes.
  async function clearWorkableSectionRows(section) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const buttons = Array.from(section?.querySelectorAll?.('[data-ui="remove-section"]') ?? []);
      if (!buttons.length) return;
      for (let i = buttons.length - 1; i >= 0; i--) {
        await clickLikeHuman(buttons[i]);
        await sleep(150);
      }
    }
  }
  async function saveWorkableSectionEntry(section) {
    const editor = getSectionEditor(section);
    const saveButton = editor?.querySelector('button[data-ui="save-section"]');
    if (!saveButton) return;
    const previousRowCount = getWorkableSectionCommittedRows(section).length;
    await clickLikeHuman(saveButton);
    await waitFor(
      () => (!getSectionEditor(section) && getWorkableSectionCommittedRows(section).length > previousRowCount ? true : null),
      SECTION_ROW_WAIT_TIMEOUT_MS,
      () => false,
      100
    );
  }
  function createWorkableSectionDescriptor({ sectionType, rootFieldId, rootQuestion, profileSection, mappings }) {
    return {
      rootFieldId,
      rootQuestion,
      profileSection,
      rowLabel: (i) => `${rootQuestion} ${i + 1}`,
      rowGrowthTimeoutMs: SECTION_ROW_WAIT_TIMEOUT_MS,
      getContainer: () => getWorkableProfileSection(sectionType),
      getRows: getWorkableSectionRows,
      getEditor: getSectionEditor,
      getRowField: getWorkableSectionRowField,
      addRow: addWorkableSectionRow,
      clearRows: clearWorkableSectionRows,
      saveEntry: saveWorkableSectionEntry,
      mappings,
    };
  }

  // BCD's Profile.education/.experience (school/degree/start/end and
  // company/role/start/end/location) has no field_of_study/summary —
  // those leaves still detect (visible in the review list) but carry no
  // profileKey/resolveValue.
  const WORKABLE_EDUCATION_SECTION_V2 = createWorkableSectionDescriptor({
    sectionType: "education",
    rootFieldId: "educationHistory",
    rootQuestion: "Education",
    profileSection: "education",
    mappings: [
      { key: "school", controlName: "school", fieldKind: "text", question: "School", profileKey: "school" },
      { key: "field_of_study", controlName: "field_of_study", fieldKind: "text", question: "Field of Study" },
      { key: "degree", controlName: "degree", fieldKind: "text", question: "Degree", profileKey: "degree" },
      { key: "start_date", controlName: "start_date", fieldKind: "date", question: "Start Date", profileKey: "start" },
      { key: "end_date", controlName: "end_date", fieldKind: "date", question: "End Date", resolveValue: (e) => (String(e?.end || "").trim() ? e.end : null) },
    ],
  });
  const WORKABLE_WORK_HISTORY_SECTION_V2 = createWorkableSectionDescriptor({
    sectionType: "experience",
    rootFieldId: "workHistory",
    rootQuestion: "Work history",
    profileSection: "experience",
    mappings: [
      { key: "title", controlName: "title", fieldKind: "text", question: "Title", profileKey: "role" },
      { key: "company", controlName: "company", fieldKind: "text", question: "Company", profileKey: "company" },
      { key: "summary", controlName: "summary", fieldKind: "textarea", question: "Summary" },
      { key: "start_date", controlName: "start_date", fieldKind: "date", question: "Start Date", profileKey: "start" },
      { key: "current", controlName: "current", fieldKind: "checkbox", question: "Current", resolveValue: (e) => !String(e?.end || "").trim() },
      { key: "end_date", controlName: "end_date", fieldKind: "date", question: "End Date", resolveValue: (e) => (String(e?.end || "").trim() ? e.end : null) },
    ],
  });
  const WORKABLE_PROFILE_SECTIONS_V2 = [WORKABLE_EDUCATION_SECTION_V2, WORKABLE_WORK_HISTORY_SECTION_V2];

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections(WORKABLE_PROFILE_SECTIONS_V2, profileData);
  }

  async function fillSectionLeaf(field, mapping, value) {
    switch (mapping.fieldKind) {
      case "text":
      case "textarea":
        await fillTextInputReliably(field, value);
        return;
      case "date":
        // Reuses this file's own date-mask-aware writer (a bare value
        // write never engages Workable's calendar-popover input mask) —
        // formatted into the fixed MM/YYYY shape the section's own
        // start/end-date inputs use, same as the first-row port above.
        await fillWorkableSectionDateInput(field, formatWorkableDateAnswer(value, { format: "MM/YYYY" }));
        return;
      case "checkbox": {
        const shouldCheck = isAffirmativeAnswer(value);
        if (Boolean(field.checked) !== shouldCheck) await clickLikeHuman(field);
        return;
      }
      default:
        return;
    }
  }

  async function fillSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    const results = [];
    for (const section of WORKABLE_PROFILE_SECTIONS_V2) {
      const entries = profileData?.[section.profileSection] ?? [];
      if (!entries.length) continue;
      const result = await SECTION_HIERARCHY.fillSection(section, entries, fillSectionLeaf);
      results.push({ rootFieldId: section.rootFieldId, ...result });
    }
    return results;
  }

  NS.workablejobs = {
    isAutofillAvailable,
    advance,
    detectQuestions,
    fillField,
    getSubmitButton,
    clickSubmitButton,
    detectSections,
    fillSections,
  };
})();
