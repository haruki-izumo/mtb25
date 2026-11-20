/* =====================================================================
 * autofill/sites/pinpointhq-autofill.js — Pinpoint (Pinpointhq) career
 * sites, application form at `#application-form`.
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/pinpointhq/autofill.js.
 * That file's own field-filling MECHANICS (react-safe value writes,
 * combobox opening/typing, file attach) are NOT re-implemented here —
 * they're exactly what autofill/engine/dom-interactions.js already
 * provides as window.ProactiveAutofillEngine, so this file calls into
 * that instead.
 *
 * OUT OF SCOPE (left to Big Banana's own existing systems, untouched):
 *   - Free-text screening-question ANSWER GENERATION
 *     (getAnswer()/ai-core/embedding-similarity matching). BidHub's own
 *     select-native/react-select-enum/react-select-search handlers
 *     fall back to an embedding-similarity match when no exact/prefix
 *     option matches — that fallback is NOT ported; a field this can't
 *     place deterministically is simply left unfilled for Big Banana's
 *     generic pipeline to try.
 *   - CAPTCHA / proxy-remote-CDP "real input" lanes — neither exists in
 *     this file.
 *   - BidHub's own answerTypeHandlers/metadata plumbing
 *     (getInputConstraints, dependent-question handling) — that's
 *     input INTO the AI-answer pipeline, not structural detection.
 * ==================================================================== */
(function () {
  "use strict";

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    fillTextInput,
    fillFileInput,
    fillSelectInput,
    fillComboboxByTyping,
    clickLikeHuman,
    getRadioInputs,
    getFileInputInsideField,
    sleep,
  } = engine;

  const FORM_SELECTOR = "#application-form";
  const ADDRESS_COMPONENT_SELECTOR = '[id^="Shared::Form::Address-react-component"]';
  // Résumé/CV upload widget. Anchor on the React wrapper (stable), not the
  // file input: once a file is attached Pinpoint REMOVES the
  // `input[type=file]` and renders a success tag + "Remove" button, so
  // anchoring on the input would lose the field after upload.
  const RESUME_COMPONENT_SELECTOR = '[id^="Shared::Form::Filefield-react-component"]';
  // Phone widget = intl-tel-input. The visible `type=tel` input holds the
  // national number; the country lives in a hidden `phone_iso2` input
  // (`#phone-country-code-dropdown`) driven by the flag dropdown —
  // selecting a country there is what actually sets it.
  const PHONE_COMPONENT_SELECTOR = '[id^="Shared::Form::Phonenumberinput-react-component"]';
  const PHONE_ISO2_INPUT_ID = "phone-country-code-dropdown";
  const CONSENT_SELECTOR = '#application_process_information, input[type="checkbox"][name="application[process_information]"]';
  const NEGATIVE_ANSWERS = new Set(["no", "false", "n", "off", "unchecked", "decline", "disagree", "none", "0"]);
  const REACT_SELECT_MENU_SELECTOR = ".react-select__menu .react-select__option, .react-select__option, [role=\"option\"]";
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  // ---- text helpers ---------------------------------------------------------

  function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").replace(/\*/g, "").trim();
  }

  // Interpret a Yes/No (or boolean/string) answer for a checkbox: anything
  // not explicitly negative or empty means "check it".
  function isAffirmativeAnswer(answer) {
    if (typeof answer === "boolean") return answer;
    const text = cleanText(answer).toLowerCase();
    if (!text) return false;
    return !NEGATIVE_ANSWERS.has(text);
  }

  // Match an intl-tel-input country `<li>` from a free-text answer: an
  // ISO2 ("US"), a country name ("United States"), or a dial code
  // ("+1"/"1"). Name/ISO2 win over dial code, which is ambiguous (e.g. +1
  // is shared by US/CA) so it's only a last resort.
  function matchPhoneCountryItem(items, value) {
    const want = cleanText(value).toLowerCase();
    if (!want) return null;
    const nameOf = (li) => cleanText(li.querySelector(".country-name")?.textContent).toLowerCase();
    const isoOf = (li) => (li.getAttribute("data-country-code") || "").toLowerCase();
    const dialOf = (li) => li.getAttribute("data-dial-code") || "";
    return (
      items.find((li) => isoOf(li) === want) ||
      items.find((li) => nameOf(li) === want) ||
      items.find((li) => nameOf(li) && (nameOf(li).startsWith(want) || want.startsWith(nameOf(li)))) ||
      (/^\+?\d+$/.test(want) ? items.find((li) => dialOf(li) === want.replace(/[^\d]/g, "")) : null) ||
      null
    );
  }

  // Question wrappers carry the prompt either on a
  // `.external-form__label--title` span (custom questions) or directly on
  // the label text (standard fields).
  function getQuestionFromLabel(label) {
    if (!label) return "";
    const title = label.querySelector(".external-form__label--title");
    return cleanText((title || label).textContent);
  }
  // Required is signalled by the `external-form__label--required` class on
  // the label or its title span.
  function isLabelRequired(label) {
    if (!label) return false;
    return Boolean(label.classList?.contains("external-form__label--required") || label.querySelector(".external-form__label--required"));
  }
  function radioOptionLabel(radio) {
    if (!radio) return "";
    const wrapped = radio.closest(".checkable-input")?.querySelector(".checkable-input__label");
    return cleanText(wrapped?.textContent) || cleanText(radio.value);
  }
  function labelTextForControl(control) {
    if (!control) return "";
    if (control.id) {
      const linked = document.querySelector(`label[for="${CSS.escape(control.id)}"]`);
      const text = cleanText(linked?.textContent);
      if (text) return text;
    }
    const wrapped = control.closest("label");
    return wrapped ? cleanText(wrapped.textContent) : "";
  }

  // A minimal date parser for an already-resolved profile answer string
  // ("1990-05-02", "05/02/1990", "May 2, 1990", "1990") — never fabricates
  // a birthdate, just normalizes whatever text the caller already gave.
  function parseProfileDate(dateStr) {
    const empty = { month: null, day: null, year: null };
    if (!dateStr || typeof dateStr !== "string") return empty;
    const value = dateStr.trim();
    if (!value) return empty;
    const pad = (part) => (part ? String(part).padStart(2, "0") : null);
    const isoMatch = value.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:T.*)?$/);
    if (isoMatch) return { month: pad(isoMatch[2]), day: pad(isoMatch[3]), year: isoMatch[1] };
    const numericDateMatch = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (numericDateMatch) {
      const year = numericDateMatch[3].length === 2 ? `20${numericDateMatch[3]}` : numericDateMatch[3];
      return { month: numericDateMatch[1].padStart(2, "0"), day: numericDateMatch[2].padStart(2, "0"), year };
    }
    const nameMatch = value.match(/^([A-Za-z]+)\s+(?:(\d{1,2}),?\s+)?(\d{4})$/);
    if (nameMatch) {
      const monthIndex = MONTH_NAMES.findIndex((m) => m.toLowerCase().startsWith(nameMatch[1].toLowerCase()));
      return { month: monthIndex >= 0 ? String(monthIndex + 1).padStart(2, "0") : null, day: pad(nameMatch[2]), year: nameMatch[3] };
    }
    if (/^\d{4}$/.test(value)) return { month: null, day: null, year: value };
    return empty;
  }

  // ---- react-select (default `react-select__` classNamePrefix) --------------

  function reactSelectContainer(input) {
    return input?.closest(".react-select") || input?.parentElement?.closest(".react-select") || input?.parentElement || null;
  }
  function isReactSelectField(field) {
    return Boolean(field?.classList?.contains("react-select__input") || field?.closest?.(".react-select"));
  }
  function readReactSelectOptions(container) {
    let nodes = container?.querySelectorAll(".react-select__option");
    if (!nodes?.length) nodes = document.querySelectorAll(".react-select__menu .react-select__option");
    if (!nodes?.length) nodes = (container || document).querySelectorAll('[role="option"]');
    return Array.from(nodes || []);
  }

  // Placeholder rows are the empty-value option ("Day"/"Month"/"Year",
  // "Select...") and the Tsselect fallback's literal `blank` value.
  function selectableOptionElements(select) {
    return Array.from(select?.querySelectorAll("option") ?? []).filter((o) => {
      const value = o.getAttribute("value") ?? "";
      return value !== "" && value !== "blank";
    });
  }
  function readNativeSelectOptions(select) {
    return selectableOptionElements(select).map((o) => cleanText(o.textContent)).filter(Boolean);
  }

  // ---- field detection --------------------------------------------------------

  function detectQuestions() {
    const form = document.querySelector(FORM_SELECTOR);
    if (!form) return [];
    const questions = [];
    const usedFieldIds = new Set();
    const handledControls = new Set();

    function addEntry(entry) {
      if (!entry.question || !entry.fieldId || !entry.field) return;
      if (usedFieldIds.has(entry.fieldId)) return;
      usedFieldIds.add(entry.fieldId);
      if (entry.field instanceof Element) handledControls.add(entry.field);
      questions.push({ options: null, required: false, ...entry });
    }

    // Résumé/CV upload (only the first Filefield widget is the résumé).
    function addResumeField(cvWrapper) {
      addEntry({ question: "Résumé / CV", fieldId: "resume", field: cvWrapper, control: cvWrapper, fieldKind: "resume" });
    }

    // Address React component (labels here have no `for` attribute). Walk
    // its `.col-1-1` sub-fields in order: Country/State are react-select,
    // the rest are plain text inputs.
    function addAddressFields(addressComponent) {
      for (const sub of addressComponent.querySelectorAll(".col-1-1")) {
        const label = sub.querySelector(":scope > label, :scope label");
        const question = getQuestionFromLabel(label);
        if (!question) continue;
        const reactSelectInput = sub.querySelector(".react-select__input");
        if (reactSelectInput?.id && !usedFieldIds.has(reactSelectInput.id)) {
          addEntry({
            question,
            fieldId: reactSelectInput.id,
            field: reactSelectInput,
            control: reactSelectInput,
            fieldKind: "react-select-search",
            required: isLabelRequired(label),
          });
          continue;
        }
        const textInput = sub.querySelector('input:not([type="hidden"]):not(.react-select__input)');
        if (textInput && (textInput.id || textInput.name)) {
          addEntry({
            question,
            fieldId: textInput.id || textInput.name,
            field: textInput,
            control: textInput,
            fieldKind: "text",
            required: isLabelRequired(label),
          });
        }
      }
    }

    // Data-processing consent checkbox (required to submit).
    function addConsentField(consent) {
      const consentLabel = labelTextForControl(consent) || "Allow us to process your personal information.";
      addEntry({
        question: consentLabel,
        fieldId: consent.id || "process_information",
        field: consent,
        control: consent,
        fieldKind: "checkbox-single",
        options: ["Yes", "No"],
        required: true,
      });
    }

    // Standard fields + custom questions, keyed off `label[for]`.
    function addLabelField(label) {
      // Per-option radio/checkbox labels (e.g. the "Yes"/"No" of a boolean
      // group) are handled when the group itself is detected, not here.
      if (label.matches(".checkable-input__label")) return;
      const fieldId = label.getAttribute("for");
      if (!fieldId || usedFieldIds.has(fieldId)) return;
      const question = getQuestionFromLabel(label);
      if (!question) return;
      const control = document.getElementById(fieldId);

      // Boolean question: the label's `for` points at
      // `<name>_boolean_answer`, which has no element — the real controls
      // are the Yes/No radios nearby. A Rails date_select (e.g. Date of
      // Birth) has the same shape: `for` names a synthesized id and the
      // real controls are the day/month/year selects in a `.date-select`
      // wrapper.
      if (!control) {
        const container = label.closest(".pad-v-3") || label.parentElement;
        const dateGroup = container?.querySelector(".date-select");
        if (dateGroup?.querySelector("select")) {
          addEntry({ question, fieldId, field: dateGroup, control: dateGroup, fieldKind: "date-select", required: isLabelRequired(label) });
          return;
        }
        const radios = container ? getRadioInputs(container) : [];
        if (radios.length) {
          addEntry({
            question,
            fieldId,
            field: container,
            control: radios[0],
            fieldKind: "radio",
            options: radios.map(radioOptionLabel).filter(Boolean),
            required: isLabelRequired(label),
          });
        }
        return;
      }
      if (handledControls.has(control)) return;

      // Phone country code: the label points at the hidden `phone_iso2`
      // input, but the real control is the intl-tel-input flag dropdown.
      // Detect it as its own question (field = the iti widget) so the
      // dropdown — and thus the hidden iso2 — actually gets set. Must
      // come before the hidden-type skip below.
      if (control.id === PHONE_ISO2_INPUT_ID) {
        const widget = control.closest(PHONE_COMPONENT_SELECTOR) || control.parentElement;
        const itiRoot = widget?.querySelector(".intl-tel-input");
        if (itiRoot) {
          addEntry({ question, fieldId, field: itiRoot, control: itiRoot, fieldKind: "phone-country", required: isLabelRequired(label) });
        }
        return;
      }

      // Skip non-text controls handled elsewhere or not fillable as free
      // text.
      if (["file", "radio", "hidden", "button", "submit", "reset"].includes(control.type)) return;

      // A lone checkbox is a Yes/No question (multi-checkbox groups are
      // left to Big Banana's generic pipeline — BidHub itself only
      // special-cased the single-checkbox case too).
      if (control.type === "checkbox") {
        const container = label.closest(".pad-v-3") || control.closest(".pad-v-3") || label.parentElement;
        const checkboxCount = container ? container.querySelectorAll('input[type="checkbox"]').length : 1;
        if (checkboxCount === 1) {
          addEntry({ question, fieldId, field: control, control, fieldKind: "checkbox-single", options: ["Yes", "No"], required: isLabelRequired(label) });
        }
        return;
      }

      // Standalone native <select> — options readable synchronously.
      if (control.tagName === "SELECT") {
        addEntry({ question, fieldId, field: control, control, fieldKind: "select-native", options: readNativeSelectOptions(control), required: isLabelRequired(label) });
        return;
      }

      // react-select custom question. Searchable inputs carry
      // `react-select__input`; the Tsselect dummy input doesn't, so also
      // key on the `.react-select` container (must run before the plain
      // INPUT branch, which would otherwise swallow the dummy input as a
      // free-text field). Multi-selects are marked by the
      // `--is-multi` value container.
      const reactSelectWrap = control.closest(".react-select");
      if (control.classList?.contains("react-select__input") || reactSelectWrap) {
        const isMulti = Boolean(reactSelectWrap?.querySelector(".react-select__value-container--is-multi"));
        addEntry({
          question,
          fieldId,
          field: control,
          control,
          fieldKind: isMulti ? "react-select-multi" : "react-select-enum",
          required: isLabelRequired(label),
        });
        return;
      }
      if (control.tagName === "TEXTAREA") {
        addEntry({ question, fieldId, field: control, control, fieldKind: "textarea", required: isLabelRequired(label) });
        return;
      }
      if (control.tagName === "INPUT") {
        addEntry({ question, fieldId, field: control, control, fieldKind: "text", required: isLabelRequired(label) });
      }
    }

    // Single document-ordered pass so the result mirrors the form's
    // visual order. Each anchor type dispatches to its own detector; the
    // address component is a container processed as a block at its own
    // position.
    const ANCHOR_SELECTOR = [ADDRESS_COMPONENT_SELECTOR, RESUME_COMPONENT_SELECTOR, CONSENT_SELECTOR, "label[for]"].join(", ");
    for (const el of form.querySelectorAll(ANCHOR_SELECTOR)) {
      if (el.matches(ADDRESS_COMPONENT_SELECTOR)) addAddressFields(el);
      else if (el.matches(RESUME_COMPONENT_SELECTOR)) addResumeField(el);
      else if (el.matches(CONSENT_SELECTOR)) addConsentField(el);
      else addLabelField(el);
    }
    return questions;
  }

  // ---- submit + advance -------------------------------------------------------

  function getSubmitButton() {
    const form = document.querySelector(FORM_SELECTOR);
    if (!form) return null;
    return form.querySelector('button[type="submit"], input[type="submit"]');
  }

  // The posting page's only forward action is an "Apply Now" link to the form.
  function getApplyLink() {
    if (document.querySelector(FORM_SELECTOR)) return null; // form already open
    const links = Array.from(document.querySelectorAll('a[href*="/applications/new"]'));
    return links.find((a) => /apply/i.test(a.textContent || "")) || links[0] || null;
  }

  // Pinpoint navigates posting → application form via Turbo (same-document
  // swap). A plain click keeps this content-script context alive across
  // that navigation, which would let an in-flight fill run bleed across
  // the posting→form boundary — force a full page load instead so the
  // freshly-revealed form is always a fresh run.
  async function advanceToApplicationForm({ shouldAbort = () => false } = {}) {
    if (getSubmitButton() || shouldAbort()) return false;
    const applyLink = getApplyLink();
    if (!applyLink) return false;
    const href = applyLink.getAttribute("href");
    if (href) window.location.assign(applyLink.href);
    else await clickLikeHuman(applyLink, { shouldAbort });
    return true;
  }

  async function clickSubmitButton({ shouldAbort = () => false } = {}) {
    const button = getSubmitButton();
    if (!button || shouldAbort()) return false;
    await clickLikeHuman(button, { shouldAbort });
    return true;
  }

  function isAutofillAvailable() {
    return Boolean(document.querySelector(FORM_SELECTOR) || getApplyLink());
  }

  // ---- filling ------------------------------------------------------------

  async function setChoice(input, shouldBeChecked, { shouldAbort = () => false } = {}) {
    if (Boolean(input.checked) === Boolean(shouldBeChecked)) return;
    await clickLikeHuman(input, { shouldAbort });
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
        if (field?.tagName === "INPUT") fillTextInput(field, String(answer));
        return;
      }
      case "textarea": {
        const textarea = field?.tagName === "TEXTAREA" ? field : field?.querySelector("textarea");
        if (textarea) fillTextInput(textarea, String(answer));
        return;
      }
      case "radio": {
        const want = cleanText(answer).toLowerCase();
        for (const radio of getRadioInputs(field)) {
          if (shouldAbort()) return;
          const label = radioOptionLabel(radio).toLowerCase();
          if (label === want || cleanText(radio.value).toLowerCase() === want) {
            await setChoice(radio, true, { shouldAbort });
            return;
          }
        }
        return;
      }
      case "checkbox-single": {
        const checkbox = field?.type === "checkbox" ? field : field?.querySelector('input[type="checkbox"]');
        if (!checkbox) return;
        await setChoice(checkbox, isAffirmativeAnswer(answer), { shouldAbort });
        return;
      }
      case "select-native": {
        const want = cleanText(answer);
        if (!want) return;
        const select = field?.tagName === "SELECT" ? field : field?.querySelector("select");
        if (!select) return;
        const optionEls = selectableOptionElements(select);
        const texts = optionEls.map((o) => cleanText(o.textContent));
        let index = texts.findIndex((t) => t.toLowerCase() === want.toLowerCase());
        if (index < 0) index = texts.findIndex((t) => t.toLowerCase().startsWith(want.toLowerCase()));
        if (shouldAbort() || index < 0) return;
        fillSelectInput(select, optionEls[index].getAttribute("value"));
        return;
      }
      case "date-select": {
        // Rails date_select triplet: `(3i)`=day, `(2i)`=month, `(1i)`=year
        // native selects with unpadded numeric values (day/month) and the
        // full year. A non-date answer (the profile has no DOB, so the
        // backend replies "N/A") parses to all-null and leaves the selects
        // untouched — never fill a fabricated birthdate.
        const raw = cleanText(answer);
        if (!raw || !field) return;
        const { year, month, day } = parseProfileDate(raw);
        const setPart = (select, part) => {
          if (!select || !part) return;
          const value = String(parseInt(part, 10));
          if (Array.from(select.options).some((o) => o.value === value)) fillSelectInput(select, value);
        };
        setPart(field.querySelector('select[name*="(3i)"], select.day'), day);
        setPart(field.querySelector('select[name*="(2i)"], select.month'), month);
        setPart(field.querySelector('select[name*="(1i)"], select.year'), year);
        return;
      }
      case "react-select-enum":
      case "react-select-search": {
        // Custom single-select rendered as a react-select, either with an
        // enumerable option list (react-select-enum) or a search-as-you-type
        // list with no fixed options (react-select-search, e.g. Country/
        // State address pickers). No `fallback` here (unlike the engine
        // default's "Other") — neither variant has a guaranteed catch-all
        // option, so forcing a click on one would risk picking the wrong
        // value outright; a miss is left for Big Banana's generic pipeline.
        await fillComboboxByTyping(field, String(answer), { menuSelector: REACT_SELECT_MENU_SELECTOR, fallback: null, shouldAbort });
        return;
      }
      case "react-select-multi": {
        // The menu stays open across selections (closeMenuOnSelect=false)
        // and an already-picked option leaves the list, so the menu is
        // only (re)opened when it's actually closed — a click on an open
        // control toggles it SHUT and the wanted option would never be
        // found. Selected values show as `.react-select__multi-value` chips.
        const values = (Array.isArray(answer) ? answer : [answer]).map(cleanText).filter(Boolean);
        if (!values.length) return;
        const container = reactSelectContainer(field);
        const isMenuOpen = () => Boolean(container?.querySelector(".react-select__menu"));
        const selectedTexts = () => Array.from(container?.querySelectorAll(".react-select__multi-value__label") ?? []).map((n) => cleanText(n.textContent).toLowerCase());
        for (const want of values) {
          if (shouldAbort()) return;
          if (selectedTexts().includes(want.toLowerCase())) continue;
          if (!isMenuOpen()) await clickLikeHuman(field, { shouldAbort });
          const options = readReactSelectOptions(container);
          const chosen = options.find((o) => cleanText(o.textContent).toLowerCase() === want.toLowerCase());
          if (!chosen) continue;
          await clickLikeHuman(chosen, { shouldAbort });
          await sleep(150);
        }
        // Toggle the menu shut so it doesn't cover the fields below.
        if (isMenuOpen()) await clickLikeHuman(field, { shouldAbort });
        field.blur?.();
        return;
      }
      case "phone-country": {
        // intl-tel-input flag dropdown — open the flag, click the matching
        // country `<li>` (which updates the flag AND the hidden
        // phone_iso2 input the form actually submits).
        const want = cleanText(answer);
        if (!want) return;
        const itiRoot = field?.classList?.contains("intl-tel-input") ? field : field?.querySelector(".intl-tel-input");
        if (!itiRoot) return;
        const items = Array.from(itiRoot.querySelectorAll("li.country"));
        const target = matchPhoneCountryItem(items, want);
        if (!target) return;
        const flag = itiRoot.querySelector(".selected-flag");
        if (flag) {
          await clickLikeHuman(flag, { shouldAbort });
          await sleep(50);
        }
        if (shouldAbort()) return;
        await clickLikeHuman(target, { shouldAbort });
        return;
      }
      case "resume": {
        if (!answer || typeof answer !== "object" || answer.type !== "file") return;
        let fileInput = getFileInputInsideField(field);
        if (!fileInput) {
          // A résumé is already attached: Pinpoint removed the file input
          // and shows a success tag with a "Remove" button. Click Remove
          // to restore the input, then attach the replacement — a direct
          // files overwrite is ignored while the uploaded tag is present.
          const removeButton = field?.querySelector?.('button[aria-label="Remove"], .bp3-tag-remove');
          if (!removeButton) return;
          await clickLikeHuman(removeButton, { shouldAbort });
          for (let attempt = 0; attempt < 30 && !fileInput && !shouldAbort(); attempt++) {
            fileInput = getFileInputInsideField(field);
            if (!fileInput) await sleep(100);
          }
        }
        if (!fileInput) return;
        fillFileInput(fileInput, answer.fileName, answer.base64, answer.mimeType);
        return;
      }
      default:
        return;
    }
  }

  NS.pinpointhq = {
    isAutofillAvailable,
    advanceToApplicationForm,
    detectQuestions,
    fillField,
    getSubmitButton,
    clickSubmitButton,
  };
})();
