/* =====================================================================
 * autofill/sites/avature-autofill.js — Avature career sites
 * (<tenant>.avature.net/careers/...).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/avature/autofill.js. Avature
 * renders a server-side multi-step apply wizard:
 *
 *   1. Posting page (/careers/JobDetail/<id> or /careers/FolderDetail/
 *      <id>/) — an "Apply"/"Apply Now" link opens
 *      /careers/ApplicationMethods?jobId=<id>|folderId=<id>.
 *   2. Resume-select page (/careers/ApplicationMethods?...) — "From
 *      Device" / "Copy & Paste" / (sometimes) "Without Resume". The file
 *      input is #resumeFile; "From Device" is #methodButton--file, the
 *      continue button is #uploadFileResume/#uploadPasteResume.
 *   3. The application form (/careers/Register?...) — a single
 *      server-rendered <form class="tpt_wizard"> whose visible section
 *      is the CURRENT wizard step (personal info, compliance/voluntary
 *      disclosures, job-specific questions, optional password setup,
 *      review & submit). "Continue"/"Next"/"Save and Continue"
 *      (button.WizardButtonPrimary[name=next|save]) advance between
 *      steps; the final step shows a Submit/Finish primary button.
 *
 * Every field is wrapped in a `<div class="fieldSpec ..." id=
 * "fieldSpecContainer<N>">` where <N> is a numeric Avature field id —
 * stable within a tenant and unique on the page, but not semantic and
 * different between tenants, so detection below keys off label TEXT for
 * the question and only uses the numeric id as a stable fieldId.
 *
 * Control kinds ported: native <select> (SelectFormField), radio groups
 * (data-option-name carries each option's label), single
 * accept/consent checkboxes (AcceptCheckboxField), multi-checkbox
 * groups, select2 typeahead single/multi-selects
 * (AutocompleteSelectFieldUIWidget — both a static enumerable list like
 * Yes/No/clearance-type AND an AJAX tag list like Skills render through
 * this same widget), plain text/textarea, and in-form file inputs
 * (résumé/CV re-upload slots that appear directly on the wizard form,
 * separate from step 2's own upload page).
 *
 * Repeated "dataset" sections (.multipleDatasetWrapper — Work history /
 * Education, with an "Add another" link and unlimited row growth) are
 * BidHub's generic autofill-section-hierarchy.js machinery mapping
 * profile entries (company/title/dates/...) onto however many rows a
 * caller's profile has — that whole system is out of scope here (see
 * the port-wide note on repeatable profile sections). The FIRST row of
 * such a section is always server-rendered whether or not anyone clicks
 * "Add another", so its sub-questions are detected and filled like any
 * other plain question below; nothing here ever clicks the "add row"
 * link, so a second Work history/Education entry is never created.
 *
 * Explicitly NOT ported (left to Big Banana's own existing systems):
 *   - BidHub's own free-text answer generation (getAnswer()) and its
 *     embedding-similarity fallback for an unmatched select/radio/
 *     checkbox option or select2 result — this file's own option
 *     matching stops at exact/prefix text, same boundary lever-
 *     autofill.js/bamboohr-autofill.js keep. detectFields() only
 *     CLASSIFIES each question's structural type and locates its
 *     control; fillField() only WRITES an answer the caller already
 *     resolved. An unmatched/unresolved field is simply left for Big
 *     Banana's own generic AI-answer pipeline to pick up.
 *   - The numeric-field "constraint" inference (buildConstraints/
 *     isAvatureNumericInput/getInputConstraints) BidHub derives per
 *     field to steer its backend's answer format — purely an AI-answer
 *     concern, not needed once the caller supplies the value directly.
 *   - Repeatable dataset ROW GROWTH beyond the first row (see above).
 *   - CAPTCHA / proxy-CDP input lanes — not applicable here.
 * ===================================================================== */
(function () {
  "use strict";

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    sleep,
    fillTextInput,
    fillTextInputWithoutBlur,
    fillSelectInput,
    fillFileInput,
    clickLikeHuman,
    getCheckboxInputs,
    getRadioInputs,
    getNativeSelect,
    getFileInputInsideField,
  } = engine;

  // ---- constants ----------------------------------------------------------

  const APPLICATION_FORM_SELECTOR = "form.tpt_wizard";
  const FIELD_SPEC_SELECTOR = '[id^="fieldSpecContainer"]';
  const TOP_LEVEL_FIELD_SPEC_PATTERN = /^fieldSpecContainer\d+$/;
  const RESUME_FILE_INPUT_SELECTOR = "#resumeFile";
  const RESUME_METHOD_FILE_TRIGGER = "#methodButton--file";
  const RESUME_METHOD_FILE_FIELDSET_SELECTOR = "#methodButton--fileFieldSetContainer";
  const RESUME_METHOD_EXTRA_SELECTOR = ".manualRegisterMethodExtra";
  const RESUME_METHOD_CONTINUE_SELECTOR = "#uploadFileResume, #uploadPasteResume";
  const RESUME_METHOD_FILE_READY_WAIT_MS = 5000;
  const ADVANCE_LABEL_PATTERN = /\b(next|continue|save and continue|review|proceed)\b/i;
  const SUBMIT_LABEL_PATTERN = /\b(submit|finish|complete)\b|send (your )?application/i;
  const DATASET_WRAPPER_SELECTOR = '.multipleDatasetWrapper, .datasetcontent, [id^="multipleDatasetRowsContainer_"], [id^="datasetField__row--"]';
  const SKILLS_QUESTION_PATTERN = /\bskills?\b/i;
  const ACCEPT_QUESTION_PATTERN = /\b(i agree|i accept|i acknowledge|i certify|i authorize|consent|terms of (service|use))\b/i;
  const TEXT_INPUT_SELECTOR =
    'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input[type="date"], input[type="month"], input[type="search"], input[data-hiddentype]:not([data-hiddentype="password"]), input:not([type])';
  const DROPDOWN_OPTION_WAIT_MS = 5000;
  const SELECT2_SEARCH_FIELD_WAIT_MS = 1000;

  // ---- text / DOM helpers ---------------------------------------------

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(/[*✱]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function normalizeComparison(value) {
    return normalizeText(value)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
  }
  function escapeAttributeValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // Avature keeps a file input's real type attribute off (no type="file"
  // sometimes) and several "visible" choice inputs are styled with
  // width/height:0 behind a custom-looking label — allowHiddenChoiceInput
  // lets a radio/checkbox still count as fillable in that case.
  function isElementVisible(element, { allowHiddenChoiceInput = false } = {}) {
    if (!element?.isConnected) return false;
    if (element.matches?.('input[type="file"]')) return true;
    if (element.matches?.('input[data-hiddentype]:not([data-hiddentype="password"])')) return true;
    if (allowHiddenChoiceInput && element.matches?.('input[type="radio"], input[type="checkbox"]')) return true;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }
  function getActionLabel(element) {
    return normalizeText(element?.textContent || element?.value || element?.getAttribute?.("aria-label") || "");
  }
  async function waitFor(check, timeoutMs, shouldAbort = () => false, pollMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (shouldAbort()) return null;
      const result = check();
      if (result) return result;
      await sleep(pollMs);
    }
    return null;
  }

  function getApplicationForm() {
    return document.querySelector(APPLICATION_FORM_SELECTOR) || Array.from(document.querySelectorAll("form")).find((form) => form.querySelector(FIELD_SPEC_SELECTOR)) || null;
  }
  // #resumeFile exists on BOTH the resume-select page and (sometimes) the
  // wizard form itself; only treat it as the step-2 resume-method field
  // when the wizard form hasn't loaded yet.
  function getResumeMethodInput() {
    const input = document.querySelector(RESUME_FILE_INPUT_SELECTOR);
    return input && !getApplicationForm() ? input : null;
  }

  // ---- resume-method page (step 2: /careers/ApplicationMethods) --------

  function dispatchValueChange(element, previousValue) {
    if (!element) return;
    element._valueTracker?.setValue(previousValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Selects the "From Device" upload method WITHOUT clicking its own
  // trigger button — that click is wired to the native OS file picker on
  // Avature, which a content script can't drive. Instead this directly
  // flips the hidden method-radio value and reveals the file fieldset the
  // trigger would otherwise reveal, mirroring what Avature's own click
  // handler does besides opening the picker.
  function prepareResumeFileMethod() {
    const input = document.querySelector(RESUME_FILE_INPUT_SELECTOR);
    const trigger = document.querySelector(RESUME_METHOD_FILE_TRIGGER);
    const fileFieldset = document.querySelector(RESUME_METHOD_FILE_FIELDSET_SELECTOR);
    const form = input?.closest("form") || fileFieldset?.closest("form") || document.getElementById("manualRegisterMethodsForm");
    if (trigger) {
      document.querySelectorAll(".methodButton").forEach((button) => button.classList.toggle("manualRegisterMethodSelected", button === trigger));
    }
    const method = trigger?.getAttribute("data-registermethod") || "file";
    const methodInput =
      form?.querySelector('input.resumeRegistrationFileMode[name="radio"], input[name="radio"].resumeRegistrationFileMode') ||
      document.querySelector('input.resumeRegistrationFileMode[name="radio"], input[name="radio"].resumeRegistrationFileMode');
    if (methodInput) {
      const previousValue = methodInput.value;
      methodInput.value = method;
      methodInput.defaultValue = method;
      methodInput.setAttribute("value", method);
      if (previousValue !== method) dispatchValueChange(methodInput, previousValue);
    }
    document.querySelectorAll(RESUME_METHOD_EXTRA_SELECTOR).forEach((section) => {
      if (section === fileFieldset) {
        section.style.display = "block";
        section.removeAttribute("hidden");
        section.removeAttribute("aria-hidden");
      } else {
        section.style.display = "none";
      }
    });
    return input;
  }
  function getResumeMethodSelectedFileName() {
    return normalizeText(document.getElementById("fileNameContainer")?.textContent);
  }
  function hasResumeMethodSelectedFile() {
    const selectedFileName = getResumeMethodSelectedFileName();
    if (selectedFileName && !/no file selected/i.test(selectedFileName)) return true;
    const input = document.querySelector(RESUME_FILE_INPUT_SELECTOR);
    return Boolean(input?.files?.length);
  }
  async function waitForResumeMethodSelectedFile(expectedFileName, shouldAbort = () => false) {
    const expected = normalizeComparison(expectedFileName);
    return waitFor(
      () => {
        const selectedFileName = getResumeMethodSelectedFileName();
        if (selectedFileName && !/no file selected/i.test(selectedFileName)) {
          if (!expected) return true;
          const selected = normalizeComparison(selectedFileName);
          return selected === expected || selected.includes(expected) || expected.includes(selected);
        }
        const input = document.querySelector(RESUME_FILE_INPUT_SELECTOR);
        if (!document.getElementById("fileNameContainer") && input?.files?.length) return true;
        return false;
      },
      RESUME_METHOD_FILE_READY_WAIT_MS,
      shouldAbort,
      100
    );
  }

  // ---- question text / required -----------------------------------------

  // Numeric Avature field id embedded in the fieldSpec wrapper id.
  function getFieldSpecId(wrapper) {
    const raw = wrapper?.id?.replace(/^fieldSpecContainer/, "") ?? "";
    return raw || null;
  }
  function getFieldLabelElement(wrapper, fieldId) {
    if (fieldId) {
      const byId = document.getElementById(`${fieldId}-label`);
      if (byId) return byId;
    }
    return wrapper?.querySelector("legend, label.WizardFieldLabel, .WizardFieldLabel, .datasetField__label, label") ?? null;
  }
  function getLabelQuestionText(labelElement) {
    if (!labelElement) return "";
    const clone = labelElement.cloneNode(true);
    clone.querySelectorAll('.labelRequiredIcon, [id$="-labelValue"], .screenReaderVisibility[aria-hidden="true"]').forEach((el) => el.remove());
    return normalizeText(clone.textContent);
  }
  // Accept/consent checkboxes carry an EMPTY label; their prompt is the
  // description text instead ("By checking this box, you agree to the
  // Terms of Service").
  function getFieldQuestion(wrapper, fieldId, control = null) {
    const labelText = getLabelQuestionText(getFieldLabelElement(wrapper, fieldId));
    if (labelText) return labelText;
    const descriptionText = normalizeText(document.getElementById(`${fieldId}-description`)?.textContent);
    if (descriptionText) return descriptionText;
    const ariaLabel = normalizeText(control?.getAttribute?.("aria-label"));
    if (ariaLabel) return ariaLabel;
    return normalizeText(control?.getAttribute?.("placeholder") || control?.name || "");
  }
  function isFieldRequired(wrapper, fieldId, control) {
    if (control?.required || control?.getAttribute?.("aria-required") === "true") return true;
    if (control?.getAttribute?.("data-required") === "true") return true;
    if (wrapper?.classList?.contains("isRequired")) return true;
    const label = getFieldLabelElement(wrapper, fieldId);
    if (label?.classList?.contains("requiredField")) return true;
    if (label?.querySelector(".labelRequiredIcon")) return true;
    return false;
  }

  // ---- option helpers (native select + select2 + radio/checkbox) --------

  function isPlaceholderOption(text, value) {
    if (!value) return true;
    return /^(select|choose|please select|not required|-+)\b/i.test(normalizeText(text));
  }
  function getNativeSelectOptions(select) {
    if (!select) return [];
    return Array.from(select.options)
      .map((option) => ({ value: option.value, text: normalizeText(option.textContent || option.value) }))
      .filter((option) => option.text && !isPlaceholderOption(option.text, option.value));
  }
  function getRadioOptionEntries(wrapper) {
    return getRadioInputs(wrapper)
      .map((input) => ({
        input,
        value: input.value,
        text: normalizeText(input.getAttribute("data-option-name") || document.querySelector(`label[for="${escapeAttributeValue(input.id)}"]`)?.textContent || input.value),
      }))
      .filter((option) => option.text);
  }
  function getCheckboxOptionEntries(checkboxes) {
    return checkboxes.map((cb) => ({
      input: cb,
      value: cb.value,
      text: normalizeText(document.querySelector(`label[for="${escapeAttributeValue(cb.id)}"]`)?.textContent || cb.value),
    }));
  }
  // Exact-or-prefix text/value match only — deliberately NOT the embedding/
  // LLM fuzzy match BidHub's own resolveBestOption() falls back to (see the
  // file-header AI-answer boundary). `options` may be plain strings or
  // {text, value, ...} entries.
  function findMatchingOption(answer, options) {
    const normalizedAnswer = normalizeComparison(answer);
    if (!normalizedAnswer || !Array.isArray(options) || !options.length) return null;
    const exact = options.find((option) => normalizeComparison(option.text ?? option) === normalizedAnswer || normalizeComparison(option.value) === normalizedAnswer);
    if (exact) return exact;
    return (
      options.find((option) => {
        const text = normalizeComparison(option.text ?? option);
        return text && (text.startsWith(normalizedAnswer) || normalizedAnswer.startsWith(text));
      }) ?? null
    );
  }
  function isAffirmativeAnswer(answer) {
    if (answer === true) return true;
    return /^(?:yes|true|y|agree|agreed|accept(?:ed)?|i agree|i accept|checked|on|1)$/i.test(normalizeComparison(answer));
  }
  function toSelectionList(answer) {
    if (Array.isArray(answer)) return answer.map((item) => normalizeText(item)).filter(Boolean);
    return String(answer ?? "")
      .split(/[,;\n]/)
      .map((item) => normalizeText(item))
      .filter(Boolean);
  }

  // ---- field classification --------------------------------------------

  function isSelect2Widget(wrapper) {
    return Boolean(wrapper.querySelector('.AutocompleteSelectFieldUIWidget, select.select2-hidden-accessible, .AutoCompleteField, [id^="ui-widget_"], .select2-selection'));
  }
  function getSelect2HiddenSelect(wrapper) {
    return wrapper.querySelector(".AutocompleteSelectFieldUIWidget select, select.AutoCompleteField, select.select2-hidden-accessible, select");
  }
  function isDatasetBlock(wrapper) {
    return Boolean(wrapper.querySelector(DATASET_WRAPPER_SELECTOR)) || /dataset/i.test(wrapper.className);
  }

  // Returns {fieldKind, options, control, isAccept} or null when the
  // wrapper holds nothing this file knows how to fill (or only a password
  // input, left for the caller/Big Banana's own password handling).
  function classifyField(wrapper, fieldId) {
    if (isDatasetBlock(wrapper)) return null; // handled by detectDatasetFirstRowFields

    if (isSelect2Widget(wrapper)) {
      // Avature renders both searchable single-selects AND tag
      // multi-selects as select2. The hidden <select> carries enumerable
      // options for a static list (Yes/No, clearance type); AJAX tag
      // lists (Skills, Languages) leave it empty.
      const hidden = getSelect2HiddenSelect(wrapper);
      const question = getFieldQuestion(wrapper, fieldId, hidden);
      if (SKILLS_QUESTION_PATTERN.test(question)) {
        // Skills only accepts an option the AJAX search actually offered
        // (no "create a new tag from whatever was typed" fallback).
        return { fieldKind: "select2-skills", options: null, control: wrapper.querySelector('input[type="search"]') || hidden };
      }
      const options = getNativeSelectOptions(hidden);
      if (options.length) {
        return {
          fieldKind: hidden?.multiple ? "select2-multi" : "select2-single",
          // Select2 often leaves only the current selection in the hidden
          // <select> until the menu opens — treat a one-option list as
          // incomplete metadata rather than the real option set.
          options: options.length > 1 ? options.map((o) => o.text) : null,
          control: hidden,
        };
      }
      return { fieldKind: "select2-multi", options: null, control: wrapper.querySelector('input[type="search"]') || hidden };
    }

    const fileInput = wrapper.querySelector('input[type="file"]');
    if (fileInput) return { fieldKind: "file", options: [], control: fileInput };

    const radios = getRadioInputs(wrapper);
    if (radios.length) {
      return { fieldKind: "radio", options: getRadioOptionEntries(wrapper).map((o) => o.text), control: radios[0] };
    }

    const checkboxes = getCheckboxInputs(wrapper).filter((cb) => cb.id && !/_unselectedIndicator$/.test(cb.id));
    if (checkboxes.length === 1) {
      // Accept/consent/acknowledgement checkboxes (AcceptCheckboxField) are
      // affirmations — isAccept just flags that for the caller; it's still
      // modelled as an ordinary Yes/No single checkbox to fill.
      const question = getFieldQuestion(wrapper, fieldId, checkboxes[0]);
      const isAccept = /AcceptCheckbox/i.test(wrapper.className) || ACCEPT_QUESTION_PATTERN.test(question);
      return { fieldKind: "checkbox-single", options: ["Yes", "No"], control: checkboxes[0], isAccept };
    }
    if (checkboxes.length > 1) {
      return { fieldKind: "checkbox", options: getCheckboxOptionEntries(checkboxes).map((o) => o.text).filter(Boolean), control: checkboxes[0] };
    }

    const select = getNativeSelect(wrapper);
    if (select) {
      const options = getNativeSelectOptions(select);
      return { fieldKind: "select-native", options: options.length ? options.map((o) => o.text) : null, control: select };
    }

    const textarea = wrapper.querySelector("textarea");
    if (textarea) return { fieldKind: "textarea", options: [], control: textarea };

    const textInput = wrapper.querySelector(TEXT_INPUT_SELECTOR);
    if (textInput) {
      if (textInput.id && /-search__field$/.test(textInput.id)) return null; // the select2 search box itself
      return { fieldKind: "text", options: [], control: textInput };
    }
    return null; // password-only or non-fillable wrapper
  }

  // ---- select2 combobox mechanics ---------------------------------------
  // Avature's select2 widget opens a results list that's appended OUTSIDE
  // the field (`.select2-results__option` elsewhere in the document), so
  // this can't just reuse the engine's generic fillComboboxByTyping() the
  // way lever-autofill.js's own single-site location widget does — it
  // needs its own open/type/match/close sequence, same shape BidHub's own
  // source uses.

  function getSelect2Selection(field) {
    return field?.querySelector?.(".select2-selection--multiple, .select2-selection") ?? null;
  }
  function getVisibleSelect2ResultOptions() {
    return Array.from(document.querySelectorAll(".select2-results__option"))
      .filter(
        (option) =>
          isElementVisible(option) &&
          option.getAttribute("role") === "option" &&
          !option.querySelector(".select2-results__option") &&
          option.getAttribute("aria-disabled") !== "true" &&
          !/enter text to search|searching|no results/i.test(normalizeText(option.textContent))
      )
      .map((option) => ({ element: option, text: normalizeText(option.textContent) }))
      .filter((option) => option.text);
  }
  function closeSelect2Dropdown() {
    const searchField = document.querySelector(".select2-search--dropdown input.select2-search__field");
    searchField?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
    searchField?.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", keyCode: 27, bubbles: true }));
  }
  async function openSelect2Dropdown(field, shouldAbort = () => false) {
    const selection = getSelect2Selection(field);
    if (!selection) return [];
    closeSelect2Dropdown();
    if (shouldAbort()) return [];
    if (selection.getAttribute("aria-expanded") !== "true") await clickLikeHuman(selection, { shouldAbort });
    const options = await waitFor(
      () => {
        const found = getVisibleSelect2ResultOptions();
        return found.length ? found : null;
      },
      DROPDOWN_OPTION_WAIT_MS,
      shouldAbort,
      150
    );
    return options || [];
  }
  function getSelect2SearchField(field, hiddenSelect = null) {
    return (
      field.querySelector("input.select2-search__field") ||
      document.querySelector("input.select2-search__field") ||
      (hiddenSelect?.id ? document.querySelector(`#${CSS.escape(hiddenSelect.id)}-search__field`) : null)
    );
  }
  function typeIntoSelect2Search(searchField, value) {
    if (!searchField) return;
    searchField.focus();
    fillTextInputWithoutBlur(searchField, value);
    searchField.dispatchEvent(new KeyboardEvent("keyup", { key: value.slice(-1) || " ", bubbles: true }));
  }
  function getSelect2ChoiceText(choice) {
    const title = normalizeText(choice?.getAttribute?.("title"));
    if (title) return title;
    const clone = choice?.cloneNode?.(true);
    clone?.querySelectorAll?.('.select2-selection__choice__remove, button, [aria-label^="Remove"]').forEach((el) => el.remove());
    return normalizeText(clone?.textContent || choice?.textContent || "")
      .replace(/^×\s*/, "")
      .replace(/\s*×$/, "");
  }
  function getSelectedSelect2Entries(field) {
    const chips = Array.from(field.querySelectorAll(".select2-selection__choice"))
      .map((chip) => ({ text: getSelect2ChoiceText(chip), removeButton: chip.querySelector('.select2-selection__choice__remove, [aria-label^="Remove"]') }))
      .filter((entry) => entry.text);
    if (chips.length) return chips;
    const hiddenSelect = field.querySelector("select");
    return Array.from(hiddenSelect?.selectedOptions || [])
      .map((option) => ({ text: normalizeText(option.textContent || option.value), option }))
      .filter((entry) => entry.text && !isPlaceholderOption(entry.text, entry.option?.value));
  }
  function getSelectedSelect2Keys(field) {
    return new Set(getSelectedSelect2Entries(field).map((entry) => normalizeComparison(entry.text)).filter(Boolean));
  }
  // Untick/remove whatever's currently selected but no longer wanted —
  // mirrors the answer set exactly, same "mirror, don't just add" rule
  // lever-autofill.js's checkbox fill follows.
  async function removeUnwantedSelect2Selections(field, desiredSet, shouldAbort = () => false) {
    const hiddenSelect = field.querySelector("select");
    for (let guard = 0; guard < 100 && !shouldAbort(); guard++) {
      const stale = getSelectedSelect2Entries(field).find((entry) => !desiredSet.has(normalizeComparison(entry.text)));
      if (!stale) return;
      if (stale.removeButton) await clickLikeHuman(stale.removeButton, { shouldAbort });
      else if (stale.option) {
        stale.option.selected = false;
        hiddenSelect?.dispatchEvent(new Event("change", { bubbles: true }));
      } else return;
      await sleep(120);
    }
  }
  // Open the dropdown, type `token`, and either click the matching
  // AJAX-loaded result or (when allowCreate) press Enter to commit the
  // typed text as a new tag — select2's own "create option from search
  // text" behaviour, not a fuzzy guess: it commits exactly what the caller
  // supplied. Returns the committed option's text, or false if nothing was
  // selected.
  async function addSelect2Token(field, token, shouldAbort = () => false, { allowCreate = true } = {}) {
    const hiddenSelect = field.querySelector("select");
    const previousSelectedKeys = getSelectedSelect2Keys(field);
    await openSelect2Dropdown(field, shouldAbort);
    const searchField = await waitFor(() => getSelect2SearchField(field, hiddenSelect), SELECT2_SEARCH_FIELD_WAIT_MS, shouldAbort, 50);
    if (searchField) typeIntoSelect2Search(searchField, token);

    const results = await waitFor(
      () => {
        const found = getVisibleSelect2ResultOptions();
        return found.length ? found : null;
      },
      DROPDOWN_OPTION_WAIT_MS,
      shouldAbort,
      150
    );

    if (results?.length) {
      const target = findMatchingOption(token, results);
      if (!target) return false;
      await clickLikeHuman(target.element, { shouldAbort });
      const selected = await waitFor(
        () => {
          const entries = getSelectedSelect2Entries(field);
          return (
            entries.find((entry) => normalizeComparison(entry.text) === normalizeComparison(target.text)) ??
            entries.find((entry) => {
              const key = normalizeComparison(entry.text);
              return key && !previousSelectedKeys.has(key);
            }) ??
            null
          );
        },
        DROPDOWN_OPTION_WAIT_MS,
        shouldAbort,
        100
      );
      return selected?.text || false;
    }

    if (!allowCreate || !searchField) return false;
    searchField.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
    searchField.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", keyCode: 13, bubbles: true }));
    const created = await waitFor(
      () => {
        const entries = getSelectedSelect2Entries(field);
        return (
          entries.find((entry) => {
            const key = normalizeComparison(entry.text);
            return key && !previousSelectedKeys.has(key);
          }) ?? null
        );
      },
      DROPDOWN_OPTION_WAIT_MS,
      shouldAbort,
      100
    );
    return created?.text || false;
  }
  // Multi-value select2 (ordinary multi-selects AND Skills): split the
  // answer into tokens, remove stale selections, then add each missing
  // token in turn.
  async function fillSelect2Multi(field, answer, shouldAbort = () => false, { allowCreate = true } = {}) {
    const tokens = toSelectionList(answer);
    if (!tokens.length) return;
    const desiredSet = new Set(tokens.map(normalizeComparison));
    try {
      await removeUnwantedSelect2Selections(field, desiredSet, shouldAbort);
      if (shouldAbort()) return;
      const existingSet = new Set(getSelectedSelect2Entries(field).map((entry) => normalizeComparison(entry.text)).filter(Boolean));
      for (const token of tokens) {
        if (shouldAbort()) return;
        const key = normalizeComparison(token);
        if (!key || existingSet.has(key)) continue;
        const selectedText = await addSelect2Token(field, token, shouldAbort, { allowCreate });
        if (selectedText) {
          existingSet.add(key);
          existingSet.add(normalizeComparison(selectedText));
        }
      }
    } finally {
      closeSelect2Dropdown();
    }
  }
  // Single-value select2: type the answer and pick the one best-matching
  // filtered option. Never splits on commas and never creates a tag — a
  // single-select holds exactly one value from its enumerable list.
  async function fillSelect2Single(field, answer, shouldAbort = () => false) {
    const value = normalizeText(Array.isArray(answer) ? answer.find((item) => item != null && item !== "") : answer);
    if (!value) return;
    try {
      await addSelect2Token(field, value, shouldAbort, { allowCreate: false });
    } finally {
      closeSelect2Dropdown();
    }
  }

  // ---- dataset first-row detection (see file header) --------------------

  function getDatasetId(wrapper) {
    return getFieldSpecId(wrapper);
  }
  // Datasets render two ways across tenants: `.multipleDatasetWrapper` +
  // `#multipleDatasetRowsContainer_<id>` or `.datasetField` + `.datasetcontent`
  // with `.datasetField__row--<id>-<n>` rows.
  function getDatasetRows(datasetId) {
    const escaped = CSS.escape(datasetId);
    const rows = [
      ...document.querySelectorAll(`[id^="multipleDatasetEntry_${escaped}_"]`),
      ...document.querySelectorAll(`[id^="datasetField__row--${escaped}-"], [id^="datasetField__row--${escaped}_"]`),
    ];
    return rows.filter((row) => !/(_|-)sample$/.test(row.id) && !/rowOffset$/.test(row.id) && row.getAttribute("aria-hidden") !== "true" && !row.hasAttribute("hidden"));
  }
  // The dataset's first row's own `[id^="fieldSpecContainer"]` sub-wrappers
  // are ordinary questions structurally — classify and fill them exactly
  // like any top-level field. No "add row" click, no mapping of rows 2+.
  function detectDatasetFirstRowFields(wrapper, fieldId) {
    const rows = getDatasetRows(getDatasetId(wrapper) || fieldId);
    const firstRow = rows[0];
    if (!firstRow) return [];
    const entries = [];
    for (const subWrapper of firstRow.querySelectorAll(FIELD_SPEC_SELECTOR)) {
      const subFieldId = getFieldSpecId(subWrapper);
      if (!subFieldId) continue;
      const classified = classifyField(subWrapper, subFieldId);
      if (!classified) continue;
      const control = classified.control;
      if (control?.matches?.('input[type="password"]')) continue;
      if (control && !isElementVisible(control, { allowHiddenChoiceInput: true })) continue;
      const question = getFieldQuestion(subWrapper, subFieldId, control);
      if (!question) continue;
      entries.push({
        question,
        fieldId: subFieldId,
        fieldKind: classified.fieldKind,
        field: subWrapper,
        control,
        options: classified.options,
        required: isFieldRequired(subWrapper, subFieldId, control),
        isAccept: Boolean(classified.isAccept),
      });
    }
    return entries;
  }

  // ---- detection ---------------------------------------------------------

  function detectResumeMethodFields() {
    const input = getResumeMethodInput();
    if (!input) return [];
    return [{ question: "Resume", fieldId: "resume", fieldKind: "avature-resume-method", field: input, control: input, options: [], required: true }];
  }

  // Job-specific question groups (e.g. screening questions) wrap each
  // question in a nested `.formfieldSpec[id="fieldSpecContainer<N>-<M>"]`
  // inside a `.formContainer`/`.schemaFieldContainer`. The outer numeric
  // container only carries a job-title header (its own <h3> label), so
  // classifying it directly would read that header as the question and
  // miss every sibling question — descend to the inner wrappers instead.
  function getNestedFormFieldWrappers(wrapper) {
    return Array.from(wrapper.querySelectorAll('.formfieldSpec[id^="fieldSpecContainer"]'));
  }

  /**
   * Walk Avature's application form and return every question this
   * adapter knows how to fill deterministically. Anything classifyField()
   * can't place (or a field with no derivable question text) is left out
   * entirely, for Big Banana's own generic/AI pipeline to pick up per the
   * scope note at the top of this file.
   *
   * @returns {Array<{question:string, fieldId:string, field:Element,
   *   control:Element, fieldKind:string, options:string[]|null,
   *   required:boolean, isAccept:boolean}>}
   */
  function detectFields() {
    const form = getApplicationForm();
    if (!form) return detectResumeMethodFields();

    const entries = [];
    const usedFieldIds = new Set();
    // Education/Work-history rows are now owned by the dedicated section-hierarchy port below — skip their dataset containers here to avoid showing every field twice in the review list (the first, server-rendered row is detected by BOTH detectDatasetFirstRowFields below AND detectSections()'s own getRows()).
    const sectionDatasetContainers = [getDatasetSectionContainer(/work|employment|experience/i), getDatasetSectionContainer(/education/i)].filter(Boolean);

    const wrappers = Array.from(form.querySelectorAll(FIELD_SPEC_SELECTOR))
      .filter((wrapper) => TOP_LEVEL_FIELD_SPEC_PATTERN.test(wrapper.id))
      .flatMap((wrapper) => {
        if (isDatasetBlock(wrapper)) return [wrapper]; // never expand a dataset's own sub-ids here
        const nested = getNestedFormFieldWrappers(wrapper);
        return nested.length ? nested : [wrapper];
      });

    for (const wrapper of wrappers) {
      const fieldId = getFieldSpecId(wrapper);
      if (!fieldId || usedFieldIds.has(fieldId)) continue;
      // Conditionally-hidden fields re-render visible once their
      // controlling answer is set; they'll be picked up on the next
      // detection pass instead of being guessed at now.
      if (wrapper.hasAttribute("hidden") || wrapper.getAttribute("data-displayconditionallyhidden") === "1") continue;

      if (isDatasetBlock(wrapper)) {
        usedFieldIds.add(fieldId);
        if (sectionDatasetContainers.includes(wrapper)) continue;
        for (const entry of detectDatasetFirstRowFields(wrapper, fieldId)) {
          if (usedFieldIds.has(entry.fieldId)) continue;
          usedFieldIds.add(entry.fieldId);
          entries.push(entry);
        }
        continue;
      }

      const classified = classifyField(wrapper, fieldId);
      if (!classified) continue;
      const control = classified.control;
      if (control?.matches?.('input[type="password"]')) continue; // left to the caller's own password handling
      if (control && !isElementVisible(control, { allowHiddenChoiceInput: true })) continue;
      const question = getFieldQuestion(wrapper, fieldId, control);
      if (!question) continue;
      usedFieldIds.add(fieldId);
      entries.push({
        question,
        fieldId,
        fieldKind: classified.fieldKind,
        field: wrapper,
        control,
        options: classified.options,
        required: isFieldRequired(wrapper, fieldId, control),
        isAccept: Boolean(classified.isAccept),
      });
    }
    return entries;
  }

  // ---- submit / flow advance ---------------------------------------------

  function getPrimaryFormButtons() {
    const form = getApplicationForm();
    if (!form) return [];
    return Array.from(form.querySelectorAll('button.WizardButtonPrimary, button[name="next"], button[name="save"], button[type="submit"]')).filter((button) => isElementVisible(button));
  }
  function getFinalSubmitButton() {
    return (
      getPrimaryFormButtons().find((button) => {
        const label = getActionLabel(button) || normalizeText(button.value);
        return SUBMIT_LABEL_PATTERN.test(label) && !ADVANCE_LABEL_PATTERN.test(label);
      }) ?? null
    );
  }
  // Posting page: the "Apply" link that opens the application-methods page.
  function getApplyPostingLink() {
    if (getApplicationForm() || getResumeMethodInput()) return null;
    return (
      Array.from(document.querySelectorAll('a[href*="/careers/ApplicationMethods"]'))
        .filter((link) => isElementVisible(link) && link.getAttribute("aria-disabled") !== "true")
        .sort((a, b) => Number(b.classList.contains("button--primary")) - Number(a.classList.contains("button--primary")))[0] ?? null
    );
  }
  // Resume-select page: the Continue button that moves to the application form.
  function getResumeContinueButton() {
    if (!getResumeMethodInput()) return null;
    const explicit = Array.from(document.querySelectorAll(RESUME_METHOD_CONTINUE_SELECTOR)).find((button) => isElementVisible(button) && !button.disabled);
    if (explicit) {
      if (explicit.id === "uploadFileResume" && !hasResumeMethodSelectedFile()) return null;
      return explicit;
    }
    return (
      Array.from(document.querySelectorAll('button.button--primary[type="submit"], button.button--primary')).find(
        (button) => isElementVisible(button) && !button.disabled && /continue/i.test(getActionLabel(button) || normalizeText(button.value))
      ) ?? null
    );
  }
  // Application form: the Next/Continue/Save button between wizard steps.
  function getFormAdvanceButton() {
    return (
      getPrimaryFormButtons().find((button) => {
        const label = getActionLabel(button) || normalizeText(button.value);
        return ADVANCE_LABEL_PATTERN.test(label) && !SUBMIT_LABEL_PATTERN.test(label);
      }) ?? null
    );
  }
  // One step of Avature's posting -> resume-method -> wizard-form flow.
  // Never clicks the final Submit/Finish button — that's clickSubmitButton()'s
  // job, a separate explicit call (same split lever-autofill.js/
  // bamboohr-autofill.js use).
  async function advance({ shouldAbort = () => false } = {}) {
    if (getFinalSubmitButton()) return false;
    const target = getApplyPostingLink() || getResumeContinueButton() || getFormAdvanceButton();
    if (!target || shouldAbort()) return false;
    await clickLikeHuman(target, { shouldAbort });
    return true;
  }
  // Clicking Submit is a user-equivalent action (same call lever-autofill.js
  // and bamboohr-autofill.js make) — Avature's own wizard has no CAPTCHA on
  // its final step for this to bypass.
  async function clickSubmitButton({ shouldAbort = () => false } = {}) {
    const button = getFinalSubmitButton();
    if (!button || shouldAbort()) return false;
    await clickLikeHuman(button, { shouldAbort });
    return true;
  }
  function isAutofillAvailable() {
    return Boolean(detectFields().length || getFinalSubmitButton() || getApplyPostingLink() || getResumeContinueButton() || getFormAdvanceButton());
  }

  // ---- filling ------------------------------------------------------------

  async function setChoiceInput(input, shouldBeChecked, { shouldAbort = () => false } = {}) {
    if (!input || input.checked === shouldBeChecked) return;
    await clickLikeHuman(input, { shouldAbort });
    if (input.checked !== shouldBeChecked) {
      input.checked = shouldBeChecked;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  /**
   * Write an already-resolved answer into a question returned by
   * detectFields(), dispatched by its fieldKind. The caller owns deciding
   * WHAT the answer is — this only owns getting it onto the page using
   * window.ProactiveAutofillEngine's primitives (plus this file's own
   * select2/resume-method mechanics).
   *
   * @param {{field:Element, control:Element, fieldKind:string}} question
   * @param {*} answer - string for text/textarea/select-native/radio;
   *   string|string[]|boolean for checkbox/checkbox-single;
   *   string|string[] for select2-single/select2-multi/select2-skills;
   *   {type:"file", fileName, base64, mimeType} for file/avature-resume-method.
   */
  async function fillField(question, answer, { shouldAbort = () => false } = {}) {
    const { field, control, fieldKind } = question;
    if (answer == null || shouldAbort()) return;

    switch (fieldKind) {
      case "text":
      case "textarea": {
        fillTextInput(control, String(answer));
        return;
      }
      case "select-native": {
        const select = control?.tagName === "SELECT" ? control : getNativeSelect(field);
        if (!select) return;
        const matched = findMatchingOption(answer, getNativeSelectOptions(select));
        if (matched?.value != null) fillSelectInput(select, matched.value);
        return;
      }
      case "radio": {
        const options = getRadioOptionEntries(field);
        const selections = toSelectionList(answer).map(normalizeComparison);
        const direct = options.find((option) => selections.includes(normalizeComparison(option.text)) || selections.includes(normalizeComparison(option.value)));
        const matched = direct || findMatchingOption(answer, options);
        if (matched?.input) await setChoiceInput(matched.input, true, { shouldAbort });
        return;
      }
      case "checkbox-single": {
        const checkbox = getCheckboxInputs(field).find((cb) => !/_unselectedIndicator$/.test(cb.id || ""));
        if (checkbox) await setChoiceInput(checkbox, isAffirmativeAnswer(answer), { shouldAbort });
        return;
      }
      case "checkbox": {
        const selections = toSelectionList(answer).map(normalizeComparison);
        for (const checkbox of getCheckboxInputs(field)) {
          if (/_unselectedIndicator$/.test(checkbox.id || "")) continue;
          const label = normalizeComparison(document.querySelector(`label[for="${escapeAttributeValue(checkbox.id)}"]`)?.textContent || checkbox.value);
          const shouldCheck = selections.includes(label) || selections.includes(normalizeComparison(checkbox.value));
          await setChoiceInput(checkbox, shouldCheck, { shouldAbort });
        }
        return;
      }
      case "select2-single": {
        if (answer) await fillSelect2Single(field, answer, shouldAbort);
        return;
      }
      case "select2-multi": {
        if (answer) await fillSelect2Multi(field, answer, shouldAbort);
        return;
      }
      case "select2-skills": {
        if (answer) await fillSelect2Multi(field, answer, shouldAbort, { allowCreate: false });
        return;
      }
      case "file": {
        if (!answer || typeof answer !== "object" || answer.type !== "file") return;
        const input = getFileInputInsideField(field) || control;
        if (input) fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        return;
      }
      case "avature-resume-method": {
        if (!answer || typeof answer !== "object" || answer.type !== "file") return;
        const preparedInput = prepareResumeFileMethod();
        await sleep(50);
        if (shouldAbort()) return;
        const input = preparedInput || (control?.matches?.('input[type="file"]') ? control : document.querySelector(RESUME_FILE_INPUT_SELECTOR));
        if (!input) return;
        fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        // Some tenants reset the file-method hidden value inside their own
        // file-input change handler — re-assert it so the Continue button
        // stays clickable afterwards.
        prepareResumeFileMethod();
        const ready = await waitForResumeMethodSelectedFile(answer.fileName, shouldAbort);
        if (!ready && !shouldAbort()) throw new Error("Resume upload did not appear selected");
        return;
      }
      default:
        return;
    }
  }

  // ---- repeatable Work History / Education dataset sections -------------
  // A SEPARATE, parallel API from detectDatasetFirstRowFields() above
  // (that one stays untouched — it only ever surfaces a dataset's FIRST,
  // always-server-rendered row as plain top-level questions, and never
  // grows a section). This block instead drives the SAME dataset blocks
  // through the shared engine/section-hierarchy.js root→group→leaf model
  // so BOTH sections show up in the review UI row-by-row and actually
  // grow to match the profile's entry count, same as Greenhouse/Ashby/
  // Workday's own ports. Ported from BidHub's own Avature dataset
  // descriptors. Avature datasets only ever APPEND rows — there is no
  // delete control to drive, so (matching BidHub's own explicit choice)
  // no clearRows is defined for either section below.
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;

  function getDatasetAddControl(container) {
    return Array.from(container?.querySelectorAll?.("a, button") ?? []).find(
      (el) => isElementVisible(el) && /^add\b/i.test(getActionLabel(el))
    );
  }
  // Picks the top-level fieldSpec container that both names this section
  // (its own text matches `namePattern` — the section heading lives
  // inside it) and genuinely looks like a repeatable dataset block (has
  // its own dataset markers AND a visible "Add ..." control) — same two
  // conditions BidHub's own getDatasetSectionContainer checks.
  function getDatasetSectionContainer(namePattern) {
    return (
      Array.from(document.querySelectorAll(FIELD_SPEC_SELECTOR))
        .filter((wrapper) => TOP_LEVEL_FIELD_SPEC_PATTERN.test(wrapper.id))
        .find((wrapper) => isDatasetBlock(wrapper) && namePattern.test(wrapper.textContent || "") && getDatasetAddControl(wrapper)) || null
    );
  }
  function getAvatureDatasetRows(container) {
    const datasetId = container && getDatasetId(container);
    return datasetId ? getDatasetRows(datasetId) : [];
  }
  // Click the dataset's own "addRowFor_<id>" control when the numeric
  // dataset id resolves to one; otherwise (tenant markup variance) fall
  // back to any visible "Add ..." link/button inside the container —
  // best-effort, flagged for live verification.
  async function addAvatureDatasetRow(container) {
    const datasetId = container && getDatasetId(container);
    let addControl = datasetId ? document.getElementById(`addRowFor_${datasetId}`) : null;
    if (!addControl || !isElementVisible(addControl)) addControl = getDatasetAddControl(container);
    if (addControl) await clickLikeHuman(addControl);
  }
  // Each mapping carries a `pattern` tested against a row sub-wrapper's
  // own question label; matching walks the WHOLE mapping array in order
  // and a sub-wrapper is claimed by the FIRST mapping (in array order)
  // whose pattern matches it — a mapping later in the array can never
  // steal a sub-wrapper an earlier, narrower mapping already claimed.
  // Recomputed fresh on every call (cheap — a handful of sub-wrappers per
  // row) rather than cached, so it stays correct however many times the
  // caller asks about this row across different mappings.
  function getDatasetRowField(mappings, rowEl, mapping) {
    const subWrappers = Array.from(rowEl.querySelectorAll(FIELD_SPEC_SELECTOR)).filter((w) => w.querySelector("label"));
    const claimed = new Set();
    let resolvedWrapper = null;
    for (const candidate of mappings) {
      const subWrapper = subWrappers.find((w) => !claimed.has(w) && candidate.pattern?.test(getFieldQuestion(w, getFieldSpecId(w))));
      if (!subWrapper) continue;
      claimed.add(subWrapper);
      if (candidate === mapping) resolvedWrapper = subWrapper;
    }
    if (!resolvedWrapper) return null;
    const classified = classifyField(resolvedWrapper, getFieldSpecId(resolvedWrapper));
    return classified?.control ? { field: classified.control } : null;
  }

  const AVATURE_WORK_HISTORY_SECTION = {
    rootFieldId: "workHistory",
    rootQuestion: "Work History",
    profileSection: "experience",
    rowLabel: (i) => `Work History ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: () => getDatasetSectionContainer(/work|employment|experience/i),
    getRows: getAvatureDatasetRows,
    getRowField: (rowEl, mapping) => getDatasetRowField(AVATURE_WORK_HISTORY_SECTION.mappings, rowEl, mapping),
    addRow: addAvatureDatasetRow,
    // No clearRows — Avature work-history dataset rows only append.
    mappings: [
      { key: "current", question: "Current", fieldKind: "checkbox", pattern: /\b(?:is\s+)?current(?:\s+position)?\??\b|currently\s+work|present/i, resolveValue: (e) => !String(e?.end || "").trim() },
      { key: "company", question: "Company", fieldKind: "text", profileKey: "company", pattern: /\bcompany\b|employer/i },
      // No BCD Profile.experience equivalent — detected only, shown empty in review UI.
      { key: "duties", question: "Duties", fieldKind: "textarea", pattern: /duties|responsibilities/i },
      { key: "position", question: "Position", fieldKind: "text", profileKey: "role", pattern: /\bposition\b|title/i },
      { key: "location", question: "Location", fieldKind: "text", profileKey: "location", pattern: /location/i },
      { key: "start", question: "Start", fieldKind: "date", profileKey: "start", pattern: /\bstart\b/i },
      { key: "end", question: "End", fieldKind: "date", profileKey: "end", pattern: /\bend\b/i },
    ],
  };

  const AVATURE_EDUCATION_SECTION = {
    rootFieldId: "educationHistory",
    rootQuestion: "Education",
    profileSection: "education",
    rowLabel: (i) => `Education ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: () => getDatasetSectionContainer(/education/i),
    getRows: getAvatureDatasetRows,
    getRowField: (rowEl, mapping) => getDatasetRowField(AVATURE_EDUCATION_SECTION.mappings, rowEl, mapping),
    addRow: addAvatureDatasetRow,
    // No clearRows — Avature education dataset rows only append.
    mappings: [
      { key: "inProgress", question: "In Progress", fieldKind: "checkbox", pattern: /in\s*progress|currently|present/i, resolveValue: (e) => !String(e?.end || "").trim() },
      // No BCD Profile.education equivalent (school/degree/start/end only,
      // no field-of-study) — detected only, shown empty in review UI.
      { key: "major", question: "Major", fieldKind: "text", pattern: /major|field of study/i },
      { key: "school", question: "School", fieldKind: "text", profileKey: "school", pattern: /\bschool\b|institution/i },
      { key: "degree", question: "Degree", fieldKind: "select", profileKey: "degree", pattern: /\bdegree\b/i },
      { key: "location", question: "Location", fieldKind: "text", pattern: /location/i },
      // No BCD Profile.education equivalent — detected only.
      { key: "gpa", question: "GPA", fieldKind: "text", pattern: /\bgpa\b/i },
      { key: "start", question: "Start", fieldKind: "date", profileKey: "start", pattern: /\bstart\b/i },
      { key: "end", question: "End", fieldKind: "date", profileKey: "end", pattern: /\bend\b/i },
    ],
  };

  const SECTIONS = [AVATURE_WORK_HISTORY_SECTION, AVATURE_EDUCATION_SECTION];

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections(SECTIONS, profileData);
  }

  // BCD's Profile.experience/.education store dates as a raw month-input
  // string ("2022-01", no day). The dataset row's actual date control
  // shape varies by tenant (classifyField's TEXT_INPUT_SELECTOR covers
  // input[type="date"]/[type="month"]/plain text alike) — adapt the
  // written value to whichever one this row actually has rather than
  // assuming one shape for every tenant.
  function formatAvatureDateValue(control, raw) {
    const match = /^(\d{4})-(\d{1,2})$/.exec(String(raw || "").trim());
    if (!match) return String(raw ?? "");
    const [, year, month] = match;
    const paddedMonth = month.padStart(2, "0");
    const type = (control?.type || "").toLowerCase();
    if (type === "month") return `${year}-${paddedMonth}`;
    if (type === "date") return `${year}-${paddedMonth}-01`; // best-effort — no day value exists in BCD's profile, defaults to the 1st
    return `${paddedMonth}/01/${year}`; // best-effort — plain text date input, MM/DD/YYYY
  }

  async function fillSectionLeaf(control, mapping, value) {
    switch (mapping.fieldKind) {
      case "text":
        fillTextInput(control, String(value ?? ""));
        return;
      case "date":
        fillTextInput(control, formatAvatureDateValue(control, value));
        return;
      case "textarea":
        fillTextInput(control, String(value ?? ""));
        return;
      case "checkbox": {
        const input = control?.matches?.('input[type="checkbox"]') ? control : control?.querySelector?.('input[type="checkbox"]');
        if (input) await setChoiceInput(input, Boolean(value));
        return;
      }
      case "select": {
        const select = control?.tagName === "SELECT" ? control : getNativeSelect(control);
        if (!select) return;
        const matched = findMatchingOption(value, getNativeSelectOptions(select));
        if (matched?.value != null) fillSelectInput(select, matched.value);
        return;
      }
      default:
        return;
    }
  }

  async function fillSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    const results = [];
    for (const section of SECTIONS) {
      const entries = (profileData && profileData[section.profileSection]) || [];
      if (!entries.length) continue;
      const result = await SECTION_HIERARCHY.fillSection(section, entries, fillSectionLeaf);
      results.push({ rootFieldId: section.rootFieldId, ...result });
    }
    return results;
  }

  NS.avature = {
    isAutofillAvailable,
    advance,
    detectFields,
    fillField,
    getSubmitButton: getFinalSubmitButton,
    clickSubmitButton,
    detectSections,
    fillSections,
  };
})();
