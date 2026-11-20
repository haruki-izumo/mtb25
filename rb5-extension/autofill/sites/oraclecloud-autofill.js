/* =====================================================================
 * autofill/sites/oraclecloud-autofill.js — Oracle Cloud Recruiting
 * (ORC) "Candidate Experience" apply flow (*.oraclecloud.com/hcmUI/
 * CandidateExperience/...).
 * =====================================================================
 * Ported from BidHub's packages/job-parsers/content/platforms/
 * oraclecloud/autofill.js.
 *
 * ORC is a multi-page Knockout SPA (`data-bind`) with a few React-
 * rendered widgets (`cx-select`, its own combobox web component)
 * embedded in it. The flow is:
 *   1. /job/<id>                 job posting          -> "Apply Now"
 *   2. /job/<id>/apply/email     email + legal gate    -> "Next"
 *   3. /job/<id>/apply/section/N application form(s)   -> "Continue"
 *      … -> "Submit"
 * All three live on the same origin and are reached by SPA route
 * changes, so this one file's detection covers all of them.
 *
 * Every radio/checkbox INPUT in ORC's markup is a visually-hidden
 * styled control — `isVisible()` on the input itself is always false,
 * so visibility is checked on its label/wrapping row instead
 * (isChoiceVisible). The cx-select combobox has NO native <select> —
 * it's a text input that opens a filterable grid-cell listbox on
 * click/focus (readComboOptions / selectComboOption).
 *
 * Ported, structural-only: email/legal pre-application gate fields,
 * the main form's field-by-field detection (text, the composite phone
 * control, cx-select combos, composite Month/Day/Year date rows, the
 * cascading address block, pill selectors, radio/checkbox groups,
 * resume/cover-letter upload), and the posting -> email-gate -> form
 * -> submit multi-page advance.
 *
 * Explicitly NOT ported: the AI-answer backend (getAnswer(), the
 * embedding-similarity fallback used when a local label match fails —
 * this file's option matching stops at exact/prefix/substring), and
 * the Work/Education repeatable tile-timeline editor (BidHub's
 * autofill-section-hierarchy.js — a generic multi-entry Add/modal/Save
 * flow shared across several ATSes, not an Oracle-specific structural
 * quirk). Skills (also a tile editor) is left alone for the same
 * reason. Forms needing those fall through to Big Banana's existing
 * generic pipeline for whatever it can manage. =======================
 * ===================================================================== */
(function () {
  "use strict";
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const { sleep, fillTextInput, writeReactTextValue, fillFileInput, clickLikeHuman } = engine;

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});

  async function waitFor(check, timeoutMs, pollMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = check();
      if (result) return result;
      await sleep(pollMs);
    }
    return null;
  }

  const FORM_SELECTOR = "form.apply-flow__content-form";
  const COMBO_INPUT_SELECTOR = 'input.cx-select-input[role="combobox"]';
  const DATEPICKER_ROW_SELECTOR = ".datepicker-row";
  const DROPDOWN_WAIT_TIMEOUT_MS = 2500;
  const ATTACHMENT_RESET_TIMEOUT_MS = 10000;
  const UPLOAD_COMPLETE_TIMEOUT_MS = 60000;
  // Address is a cascading dependent set: selecting a ZIP option (labelled
  // "ZIP, City, County, State") auto-fills city/county/state, so the block is
  // filled as ONE composite — country -> ZIP (pick the option whose city
  // matches) -> street — with direct city/state/county fills only as a no-ZIP
  // fallback. region2 = State, region1 = County.
  const ADDRESS_FIELD_NAMES = ["country", "postalCode", "region2", "region1", "city", "addressLine1", "addressLine2", "addressLine3"];
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function clean(value) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
  function stripRequiredMark(text) { return clean(text).replace(/\s*\*$/, "").trim(); }
  function isVisible(element) {
    if (!element || !(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (element.matches('input[type="file"]')) return true;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  // Radio/checkbox inputs are visually-hidden styled controls — isVisible() on
  // the input is always false. Visibility is determined via its label / row.
  function isChoiceVisible(input) {
    let label = null;
    if (input.id) { try { label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`); } catch { /* invalid selector */ } }
    return isVisible(label || input.closest('label, .input-row, [aria-labelledby$="-label"]:not(input)') || input);
  }
  function sectionTitle(element) {
    const block = element?.closest?.(".apply-flow-block");
    return clean(block?.querySelector(".apply-flow-block__title")?.textContent) || "";
  }

  // ---- label resolution (Knockout's label structure) ---------------------

  function getControlLabel(control, fallback = "") {
    if (!control) return fallback;
    const id = control.id;
    if (id) {
      const labelTextSpan = document.getElementById(`labelText-${id}`);
      if (clean(labelTextSpan?.textContent)) return stripRequiredMark(labelTextSpan.textContent);
      try {
        const explicitLabel = document.querySelector(`label[for="${CSS.escape(id)}"]`);
        if (clean(explicitLabel?.textContent)) return stripRequiredMark(explicitLabel.textContent);
      } catch { /* invalid selector */ }
    }
    const ariaLabel = clean(control.getAttribute?.("aria-label"));
    if (ariaLabel) return stripRequiredMark(ariaLabel);
    const labelledBy = control.getAttribute?.("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => clean(n.textContent)).filter(Boolean).join(" ");
      if (text) return stripRequiredMark(text);
    }
    return stripRequiredMark(control.getAttribute?.("placeholder") || control.getAttribute?.("name") || fallback);
  }
  // The QUESTION for a radio/checkbox group lives in the group wrapper's own
  // `#labelText-<id>` span — NOT in each option's own label ("Yes"/"No").
  function getGroupQuestionText(wrapper, name) {
    if (wrapper) {
      const span = wrapper.querySelector('[id^="labelText-"], .input-row__linebreak, .input-row__label-text');
      if (clean(span?.textContent)) return stripRequiredMark(span.textContent);
      const labelledBy = wrapper.getAttribute?.("aria-labelledby");
      if (labelledBy) {
        const target = document.getElementById(labelledBy.split(/\s+/)[0]);
        if (clean(target?.textContent)) return stripRequiredMark(target.textContent);
      }
    }
    if (name) {
      const byName = document.getElementById(`labelText-${name}`);
      if (clean(byName?.textContent)) return stripRequiredMark(byName.textContent);
    }
    return "";
  }
  const REQUIRED_MARKER_SELECTOR = '[class*="label--required"], [class*="title--required"], [class*="required-star"]';
  function isRequiredField(control, scope) {
    if (control && (control.required || control.getAttribute?.("aria-required") === "true" || control.getAttribute?.("required") != null)) return true;
    if (scope?.getAttribute?.("aria-required") === "true") return true;
    return Boolean(scope?.querySelector?.(REQUIRED_MARKER_SELECTOR));
  }

  // ---- email/legal pre-application gate -----------------------------------
  // The gate is a SEQUENCE of small verification steps rendered by the same
  // form-builder before the real form (email + legal ack, then sometimes an
  // identity check like "confirm your last name"). Detected generically —
  // every visible text input plus every acknowledgement checkbox — so any
  // gate step is filled, not just email.

  const GATE_TEXT_INPUT_SELECTOR = ['input.input-row__control', 'textarea.input-row__control', 'input[type="text"]', 'input[type="email"]', 'input[type="tel"]', 'input[type="number"]'].join(", ");
  const GATE_SKIP_INPUT_TYPES = new Set(["checkbox", "radio", "file", "hidden", "submit", "button", "image", "reset"]);
  // ORC keeps inactive steps' inputs in the DOM and hides them, sometimes via
  // `hidden`/`aria-hidden` rather than CSS display (which isVisible won't
  // catch on a zero-impact element).
  function isHiddenControl(input) {
    return input.hidden || input.getAttribute("aria-hidden") === "true" || Boolean(input.closest('[hidden], [aria-hidden="true"]'));
  }
  function detectEmailGateFields() {
    const scope = document.querySelector(".apply-flow__content") || document.querySelector("main#main") || document.body;
    const fields = [];
    const seen = new Set();
    const push = (entry) => { if (entry && !seen.has(entry.fieldId)) { seen.add(entry.fieldId); fields.push(entry); } };

    for (const input of scope.querySelectorAll(GATE_TEXT_INPUT_SELECTOR)) {
      const type = (input.getAttribute("type") || "text").toLowerCase();
      if (GATE_SKIP_INPUT_TYPES.has(type)) continue;
      if (isHiddenControl(input) || !isVisible(input)) continue;
      const name = input.getAttribute("name") || "";
      const isEmail = type === "email" || /email/i.test(input.id || "") || /email/i.test(name);
      const question = getControlLabel(input, isEmail ? "Email Address" : "");
      if (!question) continue;
      push({ question, fieldId: isEmail ? "orc-email" : name || input.id || `gate-${question}`, fieldKind: "text", field: input, control: input, options: null });
    }
    for (const checkbox of scope.querySelectorAll('input[type="checkbox"]')) {
      if (isHiddenControl(checkbox) || !isChoiceVisible(checkbox)) continue;
      const isLegal = checkbox.id === "legal-disclaimer-checkbox";
      const question = isLegal ? "Privacy Statement and Acknowledgement" : getControlLabel(checkbox) || clean(checkbox.closest("label, .input-row")?.textContent);
      if (!question) continue;
      push({ question, fieldId: isLegal ? "orc-legal-acknowledgement" : checkbox.id || checkbox.getAttribute("name") || `gate-ack-${question}`, fieldKind: "acknowledge", field: checkbox, control: checkbox, options: null });
    }
    return fields.length ? fields : null;
  }

  // ---- main application form field detection ------------------------------

  function detectComboField(input) {
    // Skip the phone country-code selector — the phone number is handled as
    // one composite field below.
    if (input.id?.startsWith("country-codes-dropdown") || input.getAttribute("name") === "phoneNumber") return null;
    const question = getControlLabel(input);
    if (!question) return null;
    // Auto-suggest controls (e.g. street Address Line 1) are free-text
    // typeaheads with no enumerable list.
    const isAutoSuggest = input.classList.contains("cx-select-input--auto-suggest");
    return { question, fieldId: input.getAttribute("name") || input.id, fieldKind: isAutoSuggest ? "text" : "combo", field: input, control: input, options: null };
  }

  // A "datepicker-row" is a composite date control: Month + (optional Day) +
  // Year cx-select combos sharing ONE `name`, distinguished only by an id
  // prefix. Detected as one logical field — left to the generic combo scan,
  // the three inputs collide on the shared name and only the month fills.
  function detectDateField(row) {
    const combos = Array.from(row.querySelectorAll(COMBO_INPUT_SELECTOR));
    if (!combos.length) return null;
    const name = combos[0].getAttribute("name") || combos[0].id;
    const question = getGroupQuestionText(row, name) || clean(row.getAttribute("aria-label")) || getControlLabel(combos[0]);
    if (!question || !name) return null;
    return { question, fieldId: name, fieldKind: "date", field: row, control: null, options: null };
  }

  function detectTextField(input) {
    const question = getControlLabel(input);
    if (!question) return null;
    return { question, fieldId: input.getAttribute("name") || input.id || `text-${question}`, fieldKind: "text", field: input, control: input, options: null };
  }

  // The address block is one composite field (cascade) when any known
  // address sub-control is present. Independent extras in the same block
  // (e.g. Tax District) are plain text fields, not part of the cascade.
  function detectAddressBlock(block, push) {
    const hasAddressControl = ADDRESS_FIELD_NAMES.some((name) => block.querySelector(`[name="${name}"]`));
    if (hasAddressControl) {
      push({ question: "Address", fieldId: "address", fieldKind: "address", field: block, control: null, options: null });
    }
    for (const input of block.querySelectorAll("input.input-row__control, textarea.input-row__control")) {
      if (!isVisible(input) || input.matches(COMBO_INPUT_SELECTOR)) continue;
      if (ADDRESS_FIELD_NAMES.includes(input.getAttribute("name"))) continue;
      push(detectTextField(input));
    }
  }

  function detectPillsField(pillsContainer) {
    const options = Array.from(pillsContainer.querySelectorAll(".cx-select-pill-name")).map((p) => clean(p.textContent)).filter(Boolean);
    if (!options.length) return null;
    const dataQaWrapper = pillsContainer.closest("[data-qa]");
    const question = clean(pillsContainer.getAttribute("aria-label")) || getControlLabel(dataQaWrapper) || sectionTitle(pillsContainer);
    const fieldId = dataQaWrapper?.getAttribute("data-qa") || `pills-${clean(pillsContainer.getAttribute("aria-label"))}`;
    if (!question || !fieldId) return null;
    const isMulti = pillsContainer.getAttribute("aria-multiselectable") === "true";
    return { question, fieldId, fieldKind: isMulti ? "pills-multi" : "pills", field: pillsContainer, control: null, options };
  }

  function detectRadioGroups(scope, seenFieldIds) {
    const entries = [];
    const groups = new Map();
    for (const radio of scope.querySelectorAll('input[type="radio"]')) {
      const name = radio.getAttribute("name");
      if (!name) continue;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(radio);
    }
    for (const [name, radios] of groups) {
      if (seenFieldIds.has(name)) continue;
      if (!radios.some(isChoiceVisible)) continue; // hidden group (other step / conditional)
      const wrapper = radios[0].closest('[role="radiogroup"], .input-row--radiogroup, .apply-flow-input-radio-group, .input-row') || radios[0].parentElement;
      const options = radios.map((r) => getControlLabel(r)).filter(Boolean);
      if (!options.length) continue;
      const question = getGroupQuestionText(wrapper, name) || sectionTitle(radios[0]) || options[0];
      entries.push({ question, fieldId: name, fieldKind: "radio", field: wrapper, control: null, options });
    }
    return entries;
  }

  // A lone checkbox is a Yes/No question (agreement / consent / self-id).
  function buildSingleCheckboxEntry(checkbox, fieldId, groupLabel = "") {
    const question = getControlLabel(checkbox) || groupLabel || clean(checkbox.closest("label, .input-row")?.textContent) || sectionTitle(checkbox);
    if (!question) return null;
    return {
      question, fieldId, fieldKind: "checkbox-single",
      // Scope to a clickable container: the input may be a hidden, id-less
      // control toggled by clicking its wrapping label.
      field: checkbox.closest("label.apply-flow-input-checkbox, label, .input-row") || checkbox,
      control: checkbox, options: ["Yes", "No"],
    };
  }

  function detectCheckboxGroups(scope, seenFieldIds) {
    const entries = [];
    const groups = new Map();
    const standalone = [];
    for (const checkbox of scope.querySelectorAll('input[type="checkbox"]')) {
      if (checkbox.id === "legal-disclaimer-checkbox") continue; // handled by the email-gate path
      if (!isChoiceVisible(checkbox)) continue;
      // ORC puts an aria-labelledby on every individual checkbox; the GROUP
      // wrapper's id ends in "-label". `:not(input)` skips the checkbox
      // itself (an id-less agreement opt-in carries its own
      // aria-labelledby pointing at its wrapping label, which would
      // otherwise self-match and mis-group it as its own wrapper).
      const groupWrapper = checkbox.closest('[aria-labelledby$="-label"]:not(input)');
      if (groupWrapper) {
        if (!groups.has(groupWrapper)) groups.set(groupWrapper, []);
        groups.get(groupWrapper).push(checkbox);
      } else {
        standalone.push(checkbox);
      }
    }
    const pushEntry = (entry) => { if (entry && !seenFieldIds.has(entry.fieldId)) entries.push(entry); };
    for (const [wrapper, checkboxes] of groups) {
      const labelledBy = wrapper.getAttribute?.("aria-labelledby");
      const baseId = labelledBy ? labelledBy.split(/\s+/)[0].replace(/-label$/, "") : null;
      const fieldId = baseId || checkboxes[0].id;
      if (!fieldId || seenFieldIds.has(fieldId)) continue;
      const groupLabel = baseId ? clean(document.getElementById(`${baseId}-label`)?.textContent) : "";
      if (checkboxes.length === 1) { pushEntry(buildSingleCheckboxEntry(checkboxes[0], fieldId, groupLabel)); continue; }
      const options = checkboxes.map((c) => getControlLabel(c)).filter(Boolean);
      if (!options.length) continue;
      const question = groupLabel || sectionTitle(checkboxes[0]) || "Please select";
      pushEntry({ question, fieldId, fieldKind: "checkbox-group", field: wrapper, control: null, options });
    }
    for (const checkbox of standalone) {
      if (!checkbox.id) continue; // need a stable id to key the field on
      pushEntry(buildSingleCheckboxEntry(checkbox, checkbox.id));
    }
    return entries;
  }

  // Stable per-type upload containers (Knockout components) — these persist
  // whether the slot is empty or already filled, unlike the drop-zone's own
  // text (which becomes the filename once uploaded).
  const DOCUMENT_UPLOAD_SECTION_SELECTOR = ".file-upload-wrapper__section, .file-form-element";
  const DOCUMENT_TYPE_CONTAINERS = [
    { fieldId: "resume", question: "Resume/CV", isResume: true, selector: "resume-upload-button, [params*=\"resumeUploadButtonViewModel\"], [params*=\"isResume\"]" },
    { fieldId: "cover_letter", question: "Cover Letter", isCoverLetter: true, selector: "cover-letter-upload-button, [params*=\"coverLetterUploadButtonViewModel\"], [params*=\"isCoverLetter\"]" },
  ];
  function classifyDocumentType(text) {
    const value = String(text ?? "").toLowerCase();
    if (/cover\s*letter/.test(value)) return { fieldId: "cover_letter", question: "Cover Letter", isCoverLetter: true };
    if (/\bresume\b|\bcv\b|curriculum/.test(value)) return { fieldId: "resume", question: "Resume/CV", isResume: true };
    return null;
  }
  // An upload is detected by its SECTION rather than the file <input>: once a
  // file is uploaded ORC swaps the input for an uploaded-file + Remove view,
  // so an input-only detector misses already-filled slots.
  function detectDocumentField(section) {
    return classifyDocumentType(section.textContent) || classifyDocumentType(getControlLabel(section.querySelector('input[type="file"]')));
  }
  function detectFileField(input) { return classifyDocumentType(getControlLabel(input)); }
  function documentAlreadyUploaded(container) {
    if (!container) return false;
    if (container.querySelector(".attachment-upload-button--filled, attachment-preuploaded")) return true;
    return Boolean(container.querySelector('[aria-label*="remove" i], [aria-label*="delete" i], [title*="remove" i], [title*="delete" i], .file-item, .attachment-item, .file-form-element__uploaded, .attachment-name, .file-name'));
  }

  // Blocks intentionally skipped: profile-import (an alternative "parse my
  // resume" uploader — the dedicated Resume slot is used instead) and the
  // repeatable tile/timeline editors (work/education history, skills) —
  // see the file header for why those are out of scope here.
  const SKIPPED_BLOCK_MODIFIERS = ["apply-flow-block--profile-import", "apply-flow-block--work-and-education-timeline", "apply-flow-block--tile-profile-items", "apply-flow-block--unique-tile-profile-items", "apply-flow-block--skill"];
  function isSkippedBlock(block) { return SKIPPED_BLOCK_MODIFIERS.some((m) => block.classList.contains(m)); }

  function detectMainFormFields(form) {
    const fields = [];
    const seenFieldIds = new Set();
    const push = (entry) => { if (!entry || seenFieldIds.has(entry.fieldId)) return; seenFieldIds.add(entry.fieldId); fields.push(entry); };
    const blocks = Array.from(form.querySelectorAll(".apply-flow-block"));
    const scopes = blocks.length ? blocks : [form];

    for (const block of scopes) {
      if (block.classList?.contains && isSkippedBlock(block)) continue;
      // Multi-step forms keep EVERY step's blocks in the DOM; only the
      // current step's are visible.
      if (block !== form && !isVisible(block)) continue;

      if (block.classList?.contains("apply-flow-block--personal-information-address-v2")) {
        detectAddressBlock(block, push);
        continue;
      }

      // Phone is a composite control: a country-code cx-select + a tel input.
      const telInput = block.querySelector("input.phone-row__input, input[type=\"tel\"]");
      if (telInput && isVisible(telInput)) {
        const phoneWrapper = telInput.closest(".phone-row") || telInput.closest(".input-row") || telInput.parentElement;
        const codeCombo = phoneWrapper?.querySelector('input.cx-select-input[role="combobox"]');
        const question = getControlLabel(codeCombo) || getControlLabel(telInput) || "Phone Number";
        push({ question, fieldId: "phoneNumber", fieldKind: "phone", field: phoneWrapper, control: null, options: null });
      }

      // Composite date pickers first, so their inner combos are skipped by
      // the generic combo scan below.
      for (const row of block.querySelectorAll(DATEPICKER_ROW_SELECTOR)) {
        if (!isVisible(row)) continue;
        push(detectDateField(row));
      }

      for (const combo of block.querySelectorAll(COMBO_INPUT_SELECTOR)) {
        if (!isVisible(combo)) continue;
        if (combo.closest(DATEPICKER_ROW_SELECTOR)) continue; // part of a composite date field
        push(detectComboField(combo));
      }
      for (const input of block.querySelectorAll("input.input-row__control, textarea.input-row__control")) {
        if (!isVisible(input)) continue;
        // The phone tel input also carries .input-row__control — handled above.
        if (input.matches(COMBO_INPUT_SELECTOR) || input.classList.contains("phone-row__input")) continue;
        push(detectTextField(input));
      }

      for (const pills of block.querySelectorAll("ul.cx-select-pills-container")) {
        if (!isVisible(pills)) continue;
        push(detectPillsField(pills));
      }
      for (const entry of detectRadioGroups(block, seenFieldIds)) push(entry);
      for (const entry of detectCheckboxGroups(block, seenFieldIds)) push(entry);

      // File uploads (resume / cover letter), found whether the slot is
      // empty or already holds a file. Three strategies, most stable first.
      const pushDocument = (meta, field) => {
        if (!meta || seenFieldIds.has(meta.fieldId) || !field) return;
        const accept = field.querySelector?.('input[type="file"]')?.getAttribute("accept") || field.getAttribute?.("accept") || "";
        push({ question: meta.question, fieldId: meta.fieldId, fieldKind: "file", field, control: null, options: null, isResume: meta.isResume, isCoverLetter: meta.isCoverLetter, accept });
      };
      for (const docType of DOCUMENT_TYPE_CONTAINERS) {
        if (seenFieldIds.has(docType.fieldId)) continue;
        const container = block.querySelector(docType.selector);
        if (container) pushDocument(docType, container);
      }
      for (const section of block.querySelectorAll(DOCUMENT_UPLOAD_SECTION_SELECTOR)) {
        if (!isVisible(section)) continue;
        pushDocument(detectDocumentField(section), section);
      }
      for (const input of block.querySelectorAll('input[type="file"]')) {
        if (input.closest(DOCUMENT_UPLOAD_SECTION_SELECTOR)) continue;
        pushDocument(detectFileField(input), input);
      }
    }
    return fields;
  }

  function detectFields() {
    const form = document.querySelector(FORM_SELECTOR);
    if (form && form.querySelector(".apply-flow-block")) return detectMainFormFields(form);
    // No application form yet — might be on the email/legal gate.
    const emailGate = detectEmailGateFields();
    if (emailGate) return emailGate;
    return []; // a field-less posting/landing page — advance() handles it
  }

  // ---- cx-select combobox mechanics ---------------------------------------

  function resolveControl(field, selector) {
    if (!field) return null;
    if (field.matches?.(selector)) return field;
    return field.querySelector?.(selector) ?? null;
  }
  function getComboListOptions(input) {
    const listboxId = input.getAttribute("aria-controls");
    const listbox = (listboxId && document.getElementById(listboxId)) || document.querySelector(".cx-select__list");
    if (!listbox) return null;
    const cells = listbox.querySelectorAll('[role="gridcell"], [role="option"]');
    if (!cells.length) return null;
    return Array.from(cells).map((cell) => ({ el: cell, text: clean(cell.querySelector(".cx-select__list-item--content")?.textContent || cell.textContent) })).filter((o) => o.text);
  }
  function closeComboDropdown(input) {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
  }
  function getComboDropdownArrow(input) {
    const container = input.closest(".cx-select-container") || input.closest(".input-field-container") || input.parentElement?.parentElement;
    return container?.querySelector(".icon-dropdown-arrow") ?? null;
  }

  // Open a cx-select, read its option labels, close it. Returns
  // {options, complete}: complete = the whole (small, enumerable) list was
  // read; a long list is capped and reported incomplete so the caller can
  // fall back to typing + filtering instead of scrolling thousands of rows
  // (city/ZIP/county).
  async function readComboOptions(field, max = 60) {
    const input = resolveControl(field, COMBO_INPUT_SELECTOR) || resolveControl(field, "input");
    if (!input) return { options: [], complete: false };
    input.scrollIntoView({ block: "center" });
    input.focus();
    const arrow = getComboDropdownArrow(input);
    if (arrow) arrow.click();
    else { input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); }
    const first = await waitFor(() => getComboListOptions(input), DROPDOWN_WAIT_TIMEOUT_MS, 80);
    if (!first) { closeComboDropdown(input); return { options: [], complete: false }; }
    const listboxId = input.getAttribute("aria-controls");
    const listbox = (listboxId && document.getElementById(listboxId)) || document.querySelector(".cx-select__list");
    const texts = new Set((getComboListOptions(input) || []).map((o) => o.text));
    const scrollable = listbox && listbox.scrollHeight > listbox.clientHeight + 4;
    let complete = !scrollable;
    if (scrollable) {
      let lastSize = -1, stable = 0;
      while (texts.size < max && stable < 2) {
        for (const o of getComboListOptions(input) || []) texts.add(o.text);
        if (texts.size === lastSize) stable += 1; else { stable = 0; lastSize = texts.size; }
        listbox.scrollTop = listbox.scrollHeight;
        await sleep(80);
      }
      complete = texts.size < max; // stabilized before the cap = whole list read
    }
    closeComboDropdown(input);
    return { options: Array.from(texts).slice(0, max), complete };
  }

  // Type to filter, then pick exact / prefix / substring. BidHub falls back
  // to an AI embedding-similarity match beyond that; out of scope here, so a
  // looser miss just leaves the typed free text in place (an auto-suggest
  // control with no enumerable list behaves the same way by construction).
  async function selectComboOption(input, value) {
    const target = clean(value);
    if (!target) return value;
    input.scrollIntoView({ block: "center" });
    input.focus();
    input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    writeReactTextValue(input, target); // type to filter, no blur yet
    const options = await waitFor(() => getComboListOptions(input), DROPDOWN_WAIT_TIMEOUT_MS, 80);
    if (!options?.length) {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      return target;
    }
    const lowered = target.toLowerCase();
    const chosen = options.find((o) => o.text.toLowerCase() === lowered)
      || options.find((o) => o.text.toLowerCase().startsWith(lowered))
      || options.find((o) => o.text.toLowerCase().includes(lowered));
    if (!chosen) {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return target;
    }
    await clickLikeHuman(chosen.el);
    return chosen.text;
  }

  // ZIP/postal combo: options are "ZIP, City, County, State"; selecting one
  // auto-fills city/county/state. Pick the option whose CITY part matches,
  // else the first option for the typed ZIP.
  async function selectPostalCodeOption(input, zip, city) {
    const zipText = clean(zip);
    if (!zipText) return false;
    input.scrollIntoView({ block: "center" });
    input.focus();
    input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    writeReactTextValue(input, zipText);
    const options = await waitFor(() => getComboListOptions(input), DROPDOWN_WAIT_TIMEOUT_MS, 80);
    if (!options?.length) { closeComboDropdown(input); return false; }
    const wantCity = clean(city).toLowerCase();
    const cityOf = (text) => clean(text.split(",")[1] || "").toLowerCase();
    const chosen = (wantCity && options.find((o) => cityOf(o.text) === wantCity)) || options.find((o) => o.text.startsWith(zipText)) || options[0];
    await clickLikeHuman(chosen.el);
    await sleep(250);
    return true;
  }

  const US_STATE_CODES = {
    alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
    colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
    florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
    indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
    maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
    mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
    oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
    virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
    "puerto rico": "PR", guam: "GU", "american samoa": "AS", "virgin islands": "VI", "northern mariana islands": "MP",
  };
  // All accepted spellings of a state value (lower-cased): original, 2-letter
  // code, and full name — whichever the original wasn't.
  function stateValueVariants(value) {
    const trimmed = clean(value);
    const variants = new Set();
    if (!trimmed) return variants;
    const lower = trimmed.toLowerCase();
    variants.add(lower);
    if (US_STATE_CODES[lower]) variants.add(US_STATE_CODES[lower].toLowerCase());
    const upper = trimmed.toUpperCase();
    if (/^[a-z]{2}$/i.test(trimmed)) {
      const name = Object.entries(US_STATE_CODES).find(([, code]) => code === upper)?.[0];
      if (name) variants.add(name);
    }
    return variants;
  }
  // The State (region2) list may carry full names OR just abbreviations, so
  // match the profile state against ANY spelling, then select that exact
  // option — falling back to selectComboOption's own fuzzy match otherwise.
  async function selectStateOption(input, value) {
    const target = clean(value);
    if (!target) return;
    const { options } = await readComboOptions(input);
    if (options.length) {
      const variants = stateValueVariants(target);
      const match = options.find((option) => {
        const label = clean(option).toLowerCase();
        if (variants.has(label)) return true;
        return label.split(" - ").some((part) => variants.has(part.trim()));
      });
      if (match) { await selectComboOption(input, match); return; }
    }
    await selectComboOption(input, target);
  }

  function pickBestMatchOption(value, options) {
    const lowered = clean(value).toLowerCase();
    if (!lowered || !Array.isArray(options) || !options.length) return null;
    const base = (option) => String(option).split(" - ")[0].trim().toLowerCase();
    return options.find((o) => String(o).toLowerCase() === lowered)
      || options.find((o) => base(o) === lowered)
      || options.find((o) => String(o).toLowerCase().startsWith(lowered))
      || options.find((o) => lowered.startsWith(base(o)))
      || options.find((o) => lowered.startsWith(String(o).toLowerCase()))
      || options.find((o) => String(o).toLowerCase().includes(lowered))
      || null;
  }

  function clickPill(field, value) {
    const buttons = Array.from(field.querySelectorAll(".cx-select-pill-section"));
    const names = buttons.map((b) => clean(b.querySelector(".cx-select-pill-name")?.textContent));
    const target = clean(value).toLowerCase();
    if (!target) return null;
    const index = names.findIndex((n) => n.toLowerCase() === target);
    const match = index >= 0 ? buttons[index] : buttons.find((_b, i) => names[i].toLowerCase().startsWith(target));
    if (match && match.getAttribute("aria-pressed") !== "true") match.click();
    return match ? clean(match.querySelector(".cx-select-pill-name")?.textContent) : null;
  }
  // Pills variant of the best-match logic above — pills are always
  // enumerable, so a loose match still commits a real option.
  function clickBestMatchingPill(field, value) {
    const buttons = Array.from(field.querySelectorAll(".cx-select-pill-section"));
    const names = buttons.map((b) => clean(b.querySelector(".cx-select-pill-name")?.textContent));
    const options = names.filter(Boolean);
    const best = pickBestMatchOption(value, options);
    if (!best) return null;
    const index = names.findIndex((n) => n === best);
    const button = buttons[index];
    if (button && button.getAttribute("aria-pressed") !== "true") button.click();
    return best;
  }

  function setChoiceByLabel(input, shouldCheck) {
    let label = null;
    if (input.id) { try { label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`); } catch { /* invalid selector */ } }
    // Hidden, id-less ORC checkboxes/radios are toggled by clicking their
    // wrapping label, not the visually-hidden input.
    const clickable = label || input.closest("label") || input;
    if (Boolean(input.checked) !== Boolean(shouldCheck)) clickable.click();
  }

  // ---- composite date (Month/Day/Year cx-select row) ----------------------

  function parseFreeformDate(value) {
    const v = String(value ?? "").trim();
    if (!v) return { month: null, day: null, year: null };
    const pad = (p) => (p ? String(p).padStart(2, "0") : null);
    let m = v.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:T.*)?$/);
    if (m) return { month: pad(m[2]), day: pad(m[3]), year: m[1] };
    m = v.match(/^(\d{1,2})[/-](\d{4})$/);
    if (m) return { month: m[1].padStart(2, "0"), day: null, year: m[2] };
    m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (m) return { month: m[1].padStart(2, "0"), day: m[2].padStart(2, "0"), year: m[3].length === 2 ? `20${m[3]}` : m[3] };
    m = v.match(/^([A-Za-z]+)\s+(?:(\d{1,2}),?\s+)?(\d{4})$/);
    if (m) {
      const idx = MONTH_NAMES.findIndex((n) => n.toLowerCase().startsWith(m[1].toLowerCase()));
      return { month: idx >= 0 ? String(idx + 1).padStart(2, "0") : null, day: pad(m[2]), year: m[3] };
    }
    if (/^\d{4}$/.test(v)) return { month: null, day: null, year: v };
    return { month: null, day: null, year: null };
  }
  function getMonthDisplay(monthNum) {
    if (!monthNum) return null;
    const idx = parseInt(monthNum, 10);
    return idx >= 1 && idx <= 12 ? MONTH_NAMES[idx - 1] : monthNum;
  }
  // Date combos (day/year) match numerically too, so a padded "01" option is
  // found for a "1" target.
  async function selectDateComboOption(input, displayValue) {
    const target = clean(displayValue);
    if (!input || !target) return;
    input.scrollIntoView({ block: "center" });
    input.focus();
    const arrow = getComboDropdownArrow(input);
    if (arrow) arrow.click();
    else { input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); input.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); }
    const options = await waitFor(() => (input.getAttribute("aria-expanded") === "true" ? getComboListOptions(input) : null), DROPDOWN_WAIT_TIMEOUT_MS, 80);
    if (!options) { closeComboDropdown(input); return; }
    const lowered = target.toLowerCase();
    const isNumeric = /^\d+$/.test(target);
    const matches = (opts) => opts.find((o) => o.text.toLowerCase() === lowered)
      || opts.find((o) => o.text.toLowerCase().startsWith(lowered))
      || (isNumeric ? opts.find((o) => /^\d+$/.test(o.text.trim()) && Number(o.text.trim()) === Number(target)) : undefined);
    let chosen = matches(options);
    // Defensive: scroll to load more rows if a (long) year list is virtualized.
    const listbox = document.getElementById(input.getAttribute("aria-controls"));
    let scrolls = 0;
    while (!chosen && listbox && listbox.scrollHeight > listbox.clientHeight + 4 && scrolls < 40) {
      listbox.scrollTop += listbox.clientHeight;
      await sleep(60);
      chosen = matches(getComboListOptions(input) || []);
      scrolls += 1;
    }
    if (chosen) await clickLikeHuman(chosen.el);
    else closeComboDropdown(input);
  }
  async function fillCompositeDate(row, value) {
    const parsed = parseFreeformDate(value);
    if (!parsed.month && !parsed.day && !parsed.year) return;
    const monthInput = row.querySelector(`${COMBO_INPUT_SELECTOR}[id^="month-"]`);
    const dayInput = row.querySelector(`${COMBO_INPUT_SELECTOR}[id^="day-"]`);
    const yearInput = row.querySelector(`${COMBO_INPUT_SELECTOR}[id^="year-"]`);
    if (monthInput && parsed.month) await selectDateComboOption(monthInput, getMonthDisplay(parsed.month) || String(parsed.month));
    if (dayInput && parsed.day) await selectDateComboOption(dayInput, String(Number(parsed.day)));
    if (yearInput && parsed.year) await selectDateComboOption(yearInput, String(parsed.year));
  }

  // ---- file upload (resume / cover letter) --------------------------------
  // ORC removes the <input> entirely while a file is attached — a direct
  // re-upload needs "Remove" clicked first so a fresh input re-renders.
  async function prepareUploadInput(container) {
    if (documentAlreadyUploaded(container)) {
      const removeButton = container.querySelector('[aria-label*="remove" i], [title*="remove" i], [aria-label*="delete" i], [title*="delete" i], button.attachment-upload-button__bottom-button');
      if (!removeButton) return null;
      removeButton.click();
      return waitFor(() => (documentAlreadyUploaded(container) ? null : container.querySelector('input[type="file"]')), ATTACHMENT_RESET_TIMEOUT_MS, 100);
    }
    return resolveControl(container, 'input[type="file"]');
  }
  async function waitForUploadComplete(container) {
    await waitFor(() => (documentAlreadyUploaded(container) ? true : null), UPLOAD_COMPLETE_TIMEOUT_MS, 150);
    await sleep(100);
  }

  // ---- multi-page advance (posting -> email gate -> form -> submit) ------

  function getFinalSubmitButton() {
    const direct = document.querySelector(".apply-flow-pagination__submit-button");
    if (direct && isVisible(direct)) return direct;
    return Array.from(document.querySelectorAll(".apply-flow-pagination__button")).find((b) => isVisible(b) && /\bsubmit\b/i.test(clean(b.textContent))) || null;
  }
  function getApplyNowButton() {
    const button = document.querySelector("button.apply-now-button");
    return button && isVisible(button) ? button : null;
  }
  function getForwardPaginationButton() {
    return Array.from(document.querySelectorAll(".apply-flow-pagination__button")).find((b) => {
      if (!isVisible(b)) return false;
      const text = clean(b.textContent);
      if (/\bsubmit\b/i.test(text)) return false;
      return /\b(next|continue|review)\b/i.test(text);
    }) || null;
  }
  function detectSubmitButton() {
    const submitButton = getFinalSubmitButton();
    if (!submitButton) return { detected: false };
    return { detected: true, label: clean(submitButton.textContent) || "Submit", disabled: Boolean(submitButton.disabled || submitButton.getAttribute("aria-disabled") === "true" || submitButton.classList.contains("oj-disabled")) };
  }
  function getSubmitButton() {
    const b = getFinalSubmitButton();
    return b && !b.disabled && b.getAttribute("aria-disabled") !== "true" && !b.classList.contains("oj-disabled") ? b : null;
  }
  /** On the final form step the only forward control is the gated Submit —
   *  never auto-clicked here. Returns true after clicking a Next/Continue or
   *  Apply Now control, false when there's nothing safe to advance with. */
  async function advance() {
    if (getFinalSubmitButton()) return false;
    const forward = getForwardPaginationButton();
    if (forward) { await clickLikeHuman(forward); return true; }
    const applyNow = getApplyNowButton();
    if (applyNow) { await clickLikeHuman(applyNow); return true; }
    return false;
  }
  function isAutofillAvailable() {
    if (detectFields().length) return true;
    if (detectSubmitButton().detected) return true;
    return Boolean(getApplyNowButton() || getForwardPaginationButton());
  }

  /** Write `answer` into a detected field entry. 'file' expects
   *  {fileName, base64, mimeType}; 'address' expects
   *  {country, postalCode, city, region2 (State), region1 (County),
   *  addressLine1..3}; 'checkbox-group'/'pills-multi' accept an array. */
  async function fillField(entry, answer) {
    if (!entry || answer == null) return false;
    const { fieldKind, field, control } = entry;
    switch (fieldKind) {
      case "text": {
        const input = control || resolveControl(field, "input, textarea");
        if (!input) return false;
        fillTextInput(input, String(answer));
        return true;
      }
      case "phone": {
        const value = clean(answer);
        if (!value) return false;
        const telInput = resolveControl(field, "input.phone-row__input") || resolveControl(field, 'input[type="tel"]');
        const codeCombo = field.querySelector?.('input.cx-select-input[role="combobox"]');
        // An international "+<cc> <national>" answer splits across the
        // country-code selector and the number input; a bare number just
        // fills the tel input and leaves the country code as-is.
        let national = value;
        const match = value.match(/^\+\s*(\d{1,4})[\s).-]*(.*)$/);
        if (match && codeCombo) {
          const rest = clean(match[2]);
          if (rest) national = rest;
          await selectComboOption(codeCombo, `+${match[1]}`);
        }
        if (telInput) fillTextInput(telInput, national);
        return true;
      }
      case "combo": {
        const input = control || resolveControl(field, COMBO_INPUT_SELECTOR) || resolveControl(field, "input");
        if (!input) return false;
        await selectComboOption(input, String(answer));
        return true;
      }
      case "date":
        await fillCompositeDate(field, clean(answer));
        return true;
      case "address": {
        if (!answer || typeof answer !== "object") return false;
        const get = (name) => field.querySelector(`input[name="${name}"]`);
        const filled = (name) => { const el = get(name); return el && clean(el.value); };
        if (answer.country && get("country")) await selectComboOption(get("country"), answer.country);
        if (answer.postalCode && get("postalCode")) await selectPostalCodeOption(get("postalCode"), answer.postalCode, answer.city);
        if (get("city") && !filled("city") && answer.city) await selectComboOption(get("city"), answer.city);
        if (get("region2") && !filled("region2") && (answer.region2 || answer.state)) await selectStateOption(get("region2"), answer.region2 || answer.state);
        if (get("region1") && !filled("region1") && answer.region1) await selectComboOption(get("region1"), answer.region1);
        for (const name of ["addressLine1", "addressLine2", "addressLine3"]) {
          const el = get(name);
          if (el && answer[name]) fillTextInput(el, answer[name]);
        }
        return true;
      }
      case "pills": {
        const applied = clickPill(field, String(answer)) || clickBestMatchingPill(field, String(answer));
        return Boolean(applied);
      }
      case "pills-multi": {
        const values = Array.isArray(answer) ? answer : [answer];
        let any = false;
        for (const value of values) if (clickPill(field, String(value)) || clickBestMatchingPill(field, String(value))) any = true;
        return any;
      }
      case "radio": {
        const radios = Array.from(field.querySelectorAll('input[type="radio"]'));
        const labels = radios.map((r) => getControlLabel(r));
        const target = clean(answer).toLowerCase();
        if (!target) return false;
        const index = labels.findIndex((l, i) => l.toLowerCase() === target || l.toLowerCase().startsWith(target) || String(radios[i].value).toLowerCase() === target);
        if (index < 0) return false;
        setChoiceByLabel(radios[index], true);
        return true;
      }
      case "checkbox-single": {
        const checkbox = control || (field.matches?.('input[type="checkbox"]') ? field : field.querySelector('input[type="checkbox"]'));
        if (!checkbox) return false;
        const affirmative = answer === true || /^(yes|true|agree|i agree|checked|on)$/i.test(clean(answer));
        setChoiceByLabel(checkbox, affirmative);
        return true;
      }
      case "checkbox-group": {
        const checkboxes = Array.from(field.querySelectorAll('input[type="checkbox"]'));
        const labels = checkboxes.map((c) => getControlLabel(c));
        const selected = (Array.isArray(answer) ? answer : [answer]).map((v) => clean(v).toLowerCase()).filter(Boolean);
        checkboxes.forEach((checkbox, i) => {
          const shouldCheck = selected.includes(labels[i].toLowerCase()) || selected.includes(String(checkbox.value).toLowerCase());
          setChoiceByLabel(checkbox, shouldCheck);
        });
        return true;
      }
      case "acknowledge": {
        const checkbox = control || resolveControl(field, 'input[type="checkbox"]');
        if (!checkbox) return false;
        setChoiceByLabel(checkbox, answer !== false);
        return true;
      }
      case "file": {
        if (!answer || typeof answer !== "object") return false;
        const input = await prepareUploadInput(field);
        if (!input) return false;
        fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        await waitForUploadComplete(field);
        return true;
      }
      default:
        return false;
    }
  }

  // ---- repeatable Work History / Education "timeline" sections ------------
  // Ported from BidHub's own Oracle Cloud section descriptors, driven by the
  // shared engine/section-hierarchy.js. These are exactly the blocks
  // detectMainFormFields() above deliberately SKIPS (SKIPPED_BLOCK_MODIFIERS)
  // — a tile-grid OR a "beautiful timeline" editor, both read/written here
  // instead of by the generic per-field scan.
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;

  function getBlockTitle(block) {
    return clean(block?.querySelector(".apply-flow-block__title")?.textContent);
  }
  // Oracle's own generic detector already knows these blocks by their
  // SKIPPED_BLOCK_MODIFIERS classes; reuse that same identification, keyed
  // to the block's own heading text to tell Work History from Education.
  function findProfileSectionBlock(kind) {
    const titlePattern = kind === "work" ? /\b(work\s*history|employment)\b/i : /\beducation\b/i;
    return (
      Array.from(document.querySelectorAll(".apply-flow-block")).find(
        (block) => isVisible(block) && SKIPPED_BLOCK_MODIFIERS.some((m) => block.classList.contains(m)) && titlePattern.test(getBlockTitle(block))
      ) || null
    );
  }

  function findAllExistingProfileItems(container, kind) {
    if (!container) return [];
    const tiles = Array.from(container.querySelectorAll(".apply-flow-profile-item-tile:not(.apply-flow-profile-item-tile__new-tile)")).filter(isVisible);
    if (tiles.length) return tiles;
    const kindToken = kind === "work" ? "experience" : "education";
    return Array.from(container.querySelectorAll(".beautiful-timeline-item")).filter(
      (item) => isVisible(item) && Array.from(item.classList).some((c) => c.toLowerCase().includes(kindToken))
    );
  }

  function getOracleSectionEditor(kind) {
    const probeSelector = kind === "work" ? '[name="employerName"], [name="jobTitle"]' : '[name="educationalEstablishment"], [name="major"], [name="gpa"]';
    return (
      Array.from(document.querySelectorAll(".standard-apply-flow-timeline-form, .standard-apply-flow-profile-item")).find(
        (form) => isVisible(form) && form.querySelector("input, select, textarea") && form.querySelector(".save-btn") && form.querySelector(probeSelector)
      ) || null
    );
  }

  // Oracle splits a date into month/year sub-inputs sharing ONE `name`,
  // distinguished only by an id prefix — for this port, just grab the FIRST
  // matching control and treat it as one composite date field (see
  // fillSectionLeaf's "date" case below for what gets written into it).
  function getOracleSectionRowField(rowEl, mapping) {
    if (!rowEl) return null;
    let field = rowEl.querySelector(`[name="${mapping.name}"]`);
    if (!field) field = rowEl.querySelector("ul.cx-select-pills-container") || rowEl.querySelector(COMBO_INPUT_SELECTOR);
    return field ? { field } : null;
  }

  async function addOracleSectionRow(kind) {
    let button = document.querySelector(kind === "work" ? ".timeline-work-add-button" : ".timeline-education-add-button");
    if (!button) button = document.querySelector(".apply-flow-profile-item-tile__new-tile");
    if (!button) {
      const block = findProfileSectionBlock(kind);
      button = Array.from(block?.querySelectorAll("button") ?? []).find((b) => isVisible(b) && /\badd\b/i.test(clean(b.textContent)));
    }
    if (button && isVisible(button)) await clickLikeHuman(button);
  }

  function getProfileItemDeleteIcon(item) {
    return (
      item.querySelector(".apply-flow-profile-item-tile__delete-icon, .beautiful-timeline-item__delete-icon") ||
      Array.from(item.querySelectorAll('[class*="delete" i]')).find(isVisible) ||
      null
    );
  }
  function getOpenProfileItemConfirmDialog() {
    const dialog = document.querySelector('.app-dialog, oj-dialog, [role="dialog"]');
    return dialog && isVisible(dialog) ? dialog : null;
  }
  // Batch-delete (Oracle's tiles take ~1s to disappear server-side, which is
  // fine to wait out) UNLESS a confirm dialog appears, in which case fall
  // back to one-at-a-time: click delete, click confirm, repeat.
  async function clearExistingProfileItems(container, kind) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const items = findAllExistingProfileItems(container, kind);
      if (!items.length) return;
      for (const item of items) {
        item.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        item.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        item.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      }
      await sleep(100);
      const deleteIcons = items.map(getProfileItemDeleteIcon).filter(Boolean);
      if (!deleteIcons.length) return;
      deleteIcons.forEach((icon) => icon.click());
      await sleep(200);
      if (getOpenProfileItemConfirmDialog()) {
        // One-at-a-time with confirm until nothing is left.
        for (let i = 0; i < items.length + 1; i++) {
          const remaining = findAllExistingProfileItems(container, kind);
          if (!remaining.length) return;
          const target = remaining[0];
          target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
          const icon = getProfileItemDeleteIcon(target);
          if (!icon) return;
          icon.click();
          await sleep(200);
          const dialog = getOpenProfileItemConfirmDialog();
          const confirmButton = dialog && Array.from(dialog.querySelectorAll("button")).find((b) => isVisible(b) && /^(delete|remove|yes|confirm|ok)\b/i.test(clean(b.textContent)));
          if (confirmButton) await clickLikeHuman(confirmButton);
          await sleep(400);
        }
        return;
      }
      await sleep(1000); // batched deletes settling server-side
    }
  }

  async function saveOracleSectionEntry(kind) {
    const editor = getOracleSectionEditor(kind);
    if (!editor) return;
    const saveButton = editor.querySelector(".save-btn");
    if (!saveButton) return;
    const enabledButton = await waitFor(() => (!saveButton.disabled && saveButton.getAttribute("aria-disabled") !== "true" ? saveButton : null), 5000, 100);
    if (!enabledButton) return;
    await clickLikeHuman(enabledButton);
    await waitFor(() => (getOracleSectionEditor(kind) ? null : true), 5000, 100);
  }

  // No `country`/`achievements`/`responsibilities` field exists on BCD's
  // Profile.experience schema — those leaves still detect (visible/editable
  // in the tile/timeline editor), they just have nothing to auto-fill from.
  const ORACLE_WORK_HISTORY_SECTION = {
    rootFieldId: "workHistory",
    rootQuestion: "Work History",
    profileSection: "experience",
    rowLabel: (i) => `Work History ${i + 1}`,
    rowGrowthTimeoutMs: 5000,
    maxEntries: 30,
    getContainer: () => findProfileSectionBlock("work"),
    getRows: (container) => findAllExistingProfileItems(container, "work"),
    getEditor: () => getOracleSectionEditor("work"),
    getRowField: getOracleSectionRowField,
    addRow: () => addOracleSectionRow("work"),
    clearRows: (container) => clearExistingProfileItems(container, "work"),
    saveEntry: () => saveOracleSectionEntry("work"),
    mappings: [
      { key: "employerName", name: "employerName", fieldKind: "text", question: "Employer", label: "Employer", profileKey: "company" },
      { key: "jobTitle", name: "jobTitle", fieldKind: "text", question: "Job Title", label: "Job Title", profileKey: "role" },
      { key: "startDate", name: "startDate", fieldKind: "date", question: "Start Date", label: "Start Date", profileKey: "start" },
      { key: "endDate", name: "endDate", fieldKind: "date", question: "End Date", label: "End Date", resolveValue: (e) => (String(e?.end || "").trim() ? e.end : null) },
      { key: "countryCode", name: "countryCode", fieldKind: "dropdown", question: "Country", label: "Country" },
      { key: "achievements", name: "achievements", fieldKind: "textarea", question: "Achievements", label: "Achievements" },
      { key: "responsibilities", name: "responsibilities", fieldKind: "textarea", question: "Responsibilities", label: "Responsibilities" },
    ],
  };
  const ORACLE_EDUCATION_SECTION = {
    rootFieldId: "educationHistory",
    rootQuestion: "Education",
    profileSection: "education",
    rowLabel: (i) => `Education ${i + 1}`,
    rowGrowthTimeoutMs: 5000,
    maxEntries: 30,
    getContainer: () => findProfileSectionBlock("education"),
    getRows: (container) => findAllExistingProfileItems(container, "education"),
    getEditor: () => getOracleSectionEditor("education"),
    getRowField: getOracleSectionRowField,
    addRow: () => addOracleSectionRow("education"),
    clearRows: (container) => clearExistingProfileItems(container, "education"),
    saveEntry: () => saveOracleSectionEntry("education"),
    mappings: [
      { key: "educationalEstablishment", name: "educationalEstablishment", fieldKind: "text", question: "School", label: "School", profileKey: "school" },
      { key: "contentItemId", name: "contentItemId", fieldKind: "dropdown", question: "Degree", label: "Degree", profileKey: "degree" },
      { key: "major", name: "major", fieldKind: "text", question: "Major", label: "Major" },
      { key: "startDate", name: "startDate", fieldKind: "date", question: "Start Date", label: "Start Date", profileKey: "start" },
      { key: "endDate", name: "endDate", fieldKind: "date", question: "End Date", label: "End Date", resolveValue: (e) => (String(e?.end || "").trim() ? e.end : null) },
      { key: "gpa", name: "gpa", fieldKind: "text", question: "GPA", label: "GPA" },
    ],
  };

  const SECTIONS = [ORACLE_EDUCATION_SECTION, ORACLE_WORK_HISTORY_SECTION];

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections(SECTIONS, profileData);
  }

  async function fillSectionLeaf(field, mapping, value) {
    switch (mapping.fieldKind) {
      case "text":
      case "date":
        // Awaited — the section loop's next step is often another
        // addRow()/saveEntry() click re-rendering the editor, which must
        // not race this value's commit. Oracle's date sub-control (see
        // getOracleSectionRowField) is a single month-or-year input; a
        // reasonably-formatted date string is written to it rather than
        // splitting it further, same simplification the research called for.
        await engine.fillTextInputReliably(field, String(value));
        return;
      case "textarea": {
        const textarea = field.tagName === "TEXTAREA" ? field : field.querySelector("textarea");
        if (textarea) fillTextInput(textarea, String(value));
        return;
      }
      case "dropdown": {
        if (field.matches?.(COMBO_INPUT_SELECTOR)) {
          await selectComboOption(field, String(value));
          return;
        }
        if (field.tagName === "SELECT") {
          const match = Array.from(field.querySelectorAll("option")).find((o) => (o.textContent || "").trim() === String(value));
          if (match) engine.fillSelectInput(field, match.value); // best-effort native fallback
          return;
        }
        if (field.matches?.("ul.cx-select-pills-container")) {
          clickPill(field, String(value)) || clickBestMatchingPill(field, String(value));
          return;
        }
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

  NS.oraclecloud = {
    isAutofillAvailable,
    detectFields,
    fillField,
    getSubmitButton,
    detectSubmitButton,
    advance,
    detectSections,
    fillSections,
  };
})();
