/* =====================================================================
 * autofill/sites/smartrecruiters-autofill.js — SmartRecruiters' "one
 * click" apply form (*.smartrecruiters.com/.../oneclick-ui/company/
 * <Company>/publication/<uuid>) and its posting page.
 * =====================================================================
 * Ported from BidHub's packages/job-parsers/content/platforms/
 * smartrecruiters/autofill.js.
 *
 * Two quirks drive almost everything here:
 *
 *  1. Two-URL flow. The server-rendered JD posting
 *     (jobs.smartrecruiters.com/<Company>/<id>) carries an "I'm
 *     interested" trigger (`a.js-oneclick[data-sr-track="apply"]`,
 *     repeated in several places on the page) that same-tab-navigates
 *     to the Angular "oneclick" form — a SEPARATE host/path
 *     (.../oneclick-ui/company/<Company>/publication/<uuid>). There is
 *     nothing to fill on the posting itself; advance()'s only job
 *     there is to click that trigger. A hidden sibling anchor
 *     (`a.js-smartr-oneclick[data-sr-track="applyWithSmartr"]`, → an
 *     entirely different smartr.me flow) is deliberately excluded by
 *     both its class token and its data-sr-track value.
 *
 *  2. Everything on the form is a web component (`spl-*`/`oc-*`)
 *     rendered into an OPEN shadow root — a plain querySelector from
 *     `document` never reaches any of it. Every lookup below goes
 *     through the shared engine's shadow-DOM-aware
 *     querySelectorDeep/querySelectorAllDeep/closestDeep.
 *
 * Ported, structural-only: contact-field detection (name/email/
 * location/phone/LinkedIn/etc.), the screening-question-container
 * scanner (radio/checkbox/textarea/select, including SmartRecruiters'
 * own "one container, several controls" compound EEO question),
 * consent checkboxes, resume upload, and the two-URL / footer-Next
 * advance flow.
 *
 * Explicitly NOT ported: the AI-answer backend (getAnswer() /
 * ANSWER_TYPE_HANDLERS' generateAnswer), the DataDome-evasion "remote
 * input" lane (real pointer/keyboard replay via the CDP-backed runner
 * — proxy/remote-automation, out of scope here), and the repeatable
 * Experience/Education profile-section-card editor (BidHub's
 * autofill-section-hierarchy.js — a generic multi-entry "Add" / open-
 * editor / Save flow shared across several ATSes, not a
 * SmartRecruiters-specific structural quirk, and well past plain
 * field-filling into full wizard automation). A form that needs those
 * sections filled falls through to Big Banana's existing generic
 * pipeline for whatever it can manage; the fields this module reports
 * are exactly the ones it can reliably fill structurally. ============
 * ===================================================================== */
(function () {
  "use strict";
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    sleep, fillTextInput, fillFileInput, clickLikeHuman,
    querySelectorDeep, querySelectorAllDeep, closestDeep,
  } = engine;

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

  const MANUAL_ENTRY_OPTION_PATTERN = /cannot find|fill in manually|enter (it )?manually/i;
  const MENU_WAIT_TIMEOUT_MS = 2500;
  const AUTOCOMPLETE_OPTIONS_SETTLE_MS = 500;
  const AUTOCOMPLETE_MATCH_MIN_WAIT_MS = 1000;
  const AUTO_ADVANCE_WAIT_TIMEOUT_MS = 5000;
  const SAFE_ADVANCE_BUTTON_TEXT_PATTERN = /\b(next|continue|review|preview)\b/i;
  const UNSAFE_ADVANCE_BUTTON_TEXT_PATTERN = /\b(submit|apply|complete|finish|done|send)\b/i;

  function normalizeText(value) {
    return String(value ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  }
  function normalizeQuestion(value) {
    return normalizeText(value).replace(/\s*\*/g, "").trim();
  }
  function normalizeComparisonText(value) {
    return normalizeText(value).toLowerCase();
  }
  function uniqueValues(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
      const n = normalizeText(value);
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  }
  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  // Shadow-DOM-aware "visible text of this node and everything it hosts /
  // slots in" — needed because a spl-* component's own label/value text
  // frequently lives inside ITS shadow root, several levels past the
  // querySelectorAllDeep hit.
  function getDeepText(element) {
    if (!element) return "";
    const chunks = [];
    const visited = new Set();
    const visit = (node) => {
      if (!node || visited.has(node)) return;
      visited.add(node);
      if (node.nodeType === Node.TEXT_NODE) { chunks.push(node.textContent); return; }
      if (!(node instanceof Element || node instanceof DocumentFragment)) return;
      if (node instanceof HTMLSlotElement) {
        const assigned = node.assignedNodes?.({ flatten: true }) ?? [];
        if (assigned.length) { assigned.forEach(visit); return; }
      }
      if (node instanceof Element) {
        const label = node.getAttribute("label") || node.getAttribute("aria-label") || node.getAttribute("title");
        if (label) chunks.push(label);
      }
      Array.from(node.childNodes).forEach(visit);
      if (node instanceof Element && node.shadowRoot) Array.from(node.shadowRoot.childNodes).forEach(visit);
    };
    visit(element);
    return normalizeText(chunks.join(" "));
  }

  function getFieldControl(field, selector = 'input:not([type="hidden"]):not([type="file"]), textarea, select, [role="radio"], input[type="checkbox"]') {
    if (!field) return null;
    if (field.matches?.(selector)) return field;
    return querySelectorDeep(selector, field);
  }
  function getFieldTextInput(field) {
    return getFieldControl(field, ['input[type="text"]', 'input[type="email"]', 'input[type="tel"]', 'input[type="url"]', 'input[type="number"]', "input:not([type])"].join(", "));
  }

  function isOnOneClickForm() {
    return /\/oneclick-ui\//.test(window.location.pathname);
  }
  function getFirstPageRoot() {
    return querySelectorDeep("oc-oneclick-form, oc-oneclick-form-root, main") || document.body;
  }
  function getPersonalInfoRoot() {
    return querySelectorDeep('[data-test="personal-information"]') || getFirstPageRoot();
  }
  function getWebProfilesRoot() {
    return querySelectorDeep('[data-test="web"]') || getFirstPageRoot();
  }

  // ---- contact fields ----------------------------------------------------

  function addKnownTextField(fields, { fieldId, question, selector, root = getFirstPageRoot(), fieldKind = "text" }) {
    const field = querySelectorDeep(selector, root);
    const control = getFieldControl(field);
    if (!field || !control || !isVisible(control)) return;
    fields.push({ question, fieldId, fieldKind, field, control, options: null });
  }

  function addFirstPageFields(fields) {
    const personalInfoRoot = getPersonalInfoRoot();
    const webProfilesRoot = getWebProfilesRoot();
    addKnownTextField(fields, { fieldId: "firstName", question: "First name", selector: 'oc-input[data-test="personal-info-first-name-input"], spl-input#first-name-input', root: personalInfoRoot });
    addKnownTextField(fields, { fieldId: "lastName", question: "Last name", selector: 'oc-input[data-test="personal-info-last-name-input"], spl-input#last-name-input', root: personalInfoRoot });
    addKnownTextField(fields, { fieldId: "email", question: "Email", selector: 'oc-input[data-test="personal-info-email-input"], spl-input#email-input', root: personalInfoRoot });
    addKnownTextField(fields, { fieldId: "confirmEmail", question: "Confirm your email", selector: 'oc-input[data-test="personal-info-email-confirm-input"], spl-input#confirm-email-input', root: personalInfoRoot });

    const locationField = querySelectorDeep("oc-location", personalInfoRoot)
      || querySelectorDeep('spl-autocomplete[data-test="location-autocomplete"]', personalInfoRoot)
      || querySelectorDeep('spl-autocomplete[data-test="manual-location-country"]', personalInfoRoot);
    if (locationField) fields.push({ question: "City", fieldId: "location", fieldKind: "location", field: locationField, control: null, options: null });

    const phoneField = querySelectorDeep("oc-phone-number", personalInfoRoot);
    if (phoneField) fields.push({ question: "Phone number", fieldId: "phoneNumber", fieldKind: "phone", field: phoneField, control: null, options: null });

    addKnownTextField(fields, { fieldId: "linkedIn", question: "LinkedIn", selector: 'oc-input[data-test="web-profiles-linkedin"], spl-input#linkedin-input', root: webProfilesRoot });
    addKnownTextField(fields, { fieldId: "facebook", question: "Facebook", selector: 'oc-input[data-test="web-profiles-facebook"], spl-input#facebook-input', root: webProfilesRoot });
    addKnownTextField(fields, { fieldId: "twitter", question: "X (fka Twitter)", selector: 'oc-input[data-test="web-profiles-twitter"], spl-input#twitter-input', root: webProfilesRoot });
    addKnownTextField(fields, { fieldId: "website", question: "Website", selector: 'oc-input[data-test="web-profiles-website"], spl-input#website-input', root: webProfilesRoot });

    const resumeField = querySelectorDeep('spl-dropzone[data-test="resume-upload"]');
    if (resumeField) {
      fields.push({ question: "Resume", fieldId: "resume", fieldKind: "file", field: resumeField, control: null, options: null, isResume: true });
    }
    addKnownTextField(fields, { fieldId: "hiringManagerMessage", question: "Message to the Hiring Team", selector: 'oc-textarea[data-test="hiring-manager-message-text"], spl-textarea#hiring-manager-message-input', fieldKind: "textarea" });
  }

  // ---- screening questions (one container per question; containers can
  // nest a conditionally-revealed follow-up container inside themselves) --

  const SCREENING_QUESTION_SELECTOR = '[data-test="question-container"]';
  const SCREENING_INPUT_SELECTOR = 'input:not([type="hidden"]):not([type="file"])';
  const SCREENING_AUTOCOMPLETE_HOST_SELECTOR = "spl-autocomplete, oc-autocomplete";
  const SCREENING_INPUT_HOST_SELECTOR = "spl-input, oc-input, spl-select, oc-select";

  // A container only "owns" an element whose NEAREST question-container
  // ancestor is itself — otherwise a parent's whole-container scan would
  // swallow a nested, conditionally-revealed follow-up question (e.g.
  // relocating "Yes" reveals "…relocate at your own expense?").
  function screeningContainerOwns(container, element) {
    return closestDeep(element, SCREENING_QUESTION_SELECTOR) === container;
  }
  function getOwnScreeningElements(selector, container) {
    return querySelectorAllDeep(selector, container).filter((el) => screeningContainerOwns(container, el));
  }
  function getOwnScreeningElement(selector, container) {
    return getOwnScreeningElements(selector, container)[0] ?? null;
  }
  // Light-DOM text of the container with any nested question-container
  // pruned out, so a parent's question never merges with its revealed
  // follow-up's.
  function getScreeningContainerOwnText(container) {
    if (!container) return "";
    const chunks = [];
    const walk = (node) => {
      node.childNodes.forEach((child) => {
        if (child.nodeType === Node.TEXT_NODE) { chunks.push(child.textContent); return; }
        if (child.nodeType !== Node.ELEMENT_NODE) return;
        if (child !== container && child.matches?.(SCREENING_QUESTION_SELECTOR)) return;
        walk(child);
      });
    };
    walk(container);
    return normalizeText(chunks.join(" "));
  }
  function getScreeningQuestionText(container) {
    const text = normalizeQuestion(getScreeningContainerOwnText(container));
    if (text) return text;
    const labelled = getOwnScreeningElement("label, legend, spl-typography-body, spl-typography-title", container);
    return normalizeQuestion(getDeepText(labelled));
  }
  function getCustomRadioOptions(container) {
    return getOwnScreeningElements('[role="radio"], spl-radio', container).filter(isVisible)
      .map((radio) => radio.getAttribute("label") || radio.getAttribute("aria-label") || radio.textContent)
      .filter(Boolean).map(normalizeText);
  }
  // A control's OWN name inside a question-container — needed for a
  // compound question (the US EEO "Gender, Race and Ethnicity" question
  // renders a "Gender" select and a "Race/Ethnicity" select side by side
  // under ONE label; the placeholder/aria-label is the only per-control
  // text on the page).
  function getScreeningControlLabel(control, host = null) {
    const candidates = [
      control?.getAttribute?.("placeholder"), control?.getAttribute?.("aria-label"),
      host?.getAttribute?.("label"), host?.getAttribute?.("placeholder"), host?.getAttribute?.("aria-label"),
    ];
    for (const candidate of candidates) {
      const label = normalizeQuestion(candidate);
      if (label) return label;
    }
    return "";
  }
  function getScreeningControlHost(control, container) {
    return closestDeep(control, SCREENING_AUTOCOMPLETE_HOST_SELECTOR, container) || closestDeep(control, SCREENING_INPUT_HOST_SELECTOR, container) || control;
  }
  function getScreeningSubQuestion(question, control, host, ordinal) {
    const label = getScreeningControlLabel(control, host);
    if (label && normalizeComparisonText(label) !== normalizeComparisonText(question)) return `${question}: ${label}`;
    return `${question} (${ordinal})`;
  }

  function getQuestionFieldId(question, fallback) {
    const slug = normalizeComparisonText(question).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
    return slug || fallback;
  }
  // Identically-worded controls (a screening step repeating the same consent
  // sentence for three separate boxes) would otherwise collide on one slug.
  function uniqueFieldId(fields, fieldId, index) {
    if (!fields.some((entry) => entry.fieldId === fieldId)) return fieldId;
    return `${fieldId}-${index}`;
  }

  function addScreeningFields(fields) {
    const containers = querySelectorAllDeep(SCREENING_QUESTION_SELECTOR).filter(isVisible);
    containers.forEach((container, index) => {
      let question = getScreeningQuestionText(container);
      if (!question) {
        // A container with no text of its own (its control is rendered
        // apart from a label shared with a sibling container) is still a
        // field — the control's own name becomes the question.
        const control = getOwnScreeningElements(`${SCREENING_INPUT_SELECTOR}, textarea`, container).filter(isVisible)[0];
        question = control ? getScreeningControlLabel(control, getScreeningControlHost(control, container)) : "";
      }
      if (!question) return;

      const radios = getOwnScreeningElements('[role="radio"], spl-radio', container).filter(isVisible);
      if (radios.length) {
        fields.push({
          question, fieldId: uniqueFieldId(fields, getQuestionFieldId(question, radios[0].id || `screening-radio-${index}`), index),
          fieldKind: "radio-custom", field: container, control: null, options: getCustomRadioOptions(container),
        });
        return;
      }
      const checkbox = getOwnScreeningElement('input[type="checkbox"], [role="checkbox"]', container);
      if (checkbox) {
        fields.push({
          question, fieldId: uniqueFieldId(fields, getQuestionFieldId(question, checkbox.id || `screening-checkbox-${index}`), index),
          fieldKind: "checkbox", field: container, control: checkbox, options: ["Yes", "No"],
        });
        return;
      }
      const textarea = getOwnScreeningElement("textarea", container);
      if (textarea) {
        fields.push({
          question, fieldId: uniqueFieldId(fields, textarea.id || getQuestionFieldId(question, `screening-textarea-${index}`), index),
          fieldKind: "textarea", field: container, control: textarea, options: null,
        });
        return;
      }
      const inputs = getOwnScreeningElements(SCREENING_INPUT_SELECTOR, container);
      const visibleInputs = inputs.filter(isVisible);
      // Compound question: several controls under ONE label. One entry per
      // control, each bound to its own widget host — a single merged entry
      // would only ever fill the first control, leaving a required second
      // one (e.g. Race/Ethnicity) empty and blocking Submit.
      if (visibleInputs.length > 1) {
        visibleInputs.forEach((input, subIndex) => {
          const host = getScreeningControlHost(input, container);
          const subQuestion = getScreeningSubQuestion(question, input, host, subIndex + 1);
          const isAutocomplete = input.getAttribute("role") === "combobox";
          fields.push({
            question: subQuestion,
            fieldId: uniqueFieldId(fields, input.id || getQuestionFieldId(subQuestion, `screening-input-${index}-${subIndex}`), `${index}-${subIndex}`),
            fieldKind: isAutocomplete ? "autocomplete" : "text", field: host, control: input,
            options: isAutocomplete ? null : [],
          });
        });
        return;
      }
      const input = visibleInputs[0] ?? inputs[0];
      if (input) {
        const isAutocomplete = input.getAttribute("role") === "combobox";
        fields.push({
          question, fieldId: uniqueFieldId(fields, input.id || getQuestionFieldId(question, `screening-input-${index}`), index),
          fieldKind: isAutocomplete ? "autocomplete" : "text", field: container, control: input,
          options: isAutocomplete ? null : [],
        });
      }
    });
  }

  function getConsentQuestionText(consentField) {
    const label = querySelectorDeep('[slot="label-content"], label, spl-typography-label', consentField);
    return normalizeQuestion(getDeepText(label)) || normalizeQuestion(getDeepText(consentField)) || "Privacy notice consent";
  }
  function addConsentFields(fields) {
    const seen = new Set();
    const consentFields = ['oc-checkbox[data-test="consent-box"]', 'oc-consent spl-checkbox[required]', "oc-consent spl-checkbox", '[data-test="consent"] spl-checkbox[required]', '[data-test="consent"] spl-checkbox']
      .flatMap((selector) => querySelectorAllDeep(selector))
      .filter((field) => field instanceof Element)
      .filter((field) => { if (seen.has(field)) return false; seen.add(field); return true; })
      .filter(isVisible);
    consentFields.forEach((consentField, index) => {
      const consentInput = querySelectorDeep('input[type="checkbox"]', consentField);
      if (!consentInput) return;
      const question = getConsentQuestionText(consentField);
      fields.push({
        question, fieldId: uniqueFieldId(fields, index === 0 ? "privacyConsent" : getQuestionFieldId(question, `privacyConsent-${index}`), index),
        fieldKind: "checkbox", field: consentField, control: consentInput, options: ["Yes", "No"],
      });
    });
  }

  function detectFields() {
    if (!isOnOneClickForm()) return [];
    // A CAPTCHA-walled form has nothing safe to fill structurally — solving
    // it is explicitly out of scope for this module.
    if (querySelectorDeep('iframe[title*="CAPTCHA"], iframe[src*="captcha-delivery"]')) return [];
    const fields = [];
    addFirstPageFields(fields);
    addScreeningFields(fields);
    addConsentFields(fields);
    return fields;
  }

  // ---- the listbox-driven autocomplete widgets (location, screening) ----

  function getControlledListboxes(input) {
    const controlledIds = normalizeText(input?.getAttribute?.("aria-controls")).split(/\s+/).filter(Boolean);
    const controlled = controlledIds.map((id) => querySelectorDeep(`#${CSS.escape(id)}`)).filter((lb) => lb && isVisible(lb));
    const visible = querySelectorAllDeep('[role="listbox"]').filter(isVisible);
    return Array.from(new Set([...controlled, ...visible]));
  }
  function getListboxOptionText(option) {
    const host = option?.getRootNode?.()?.host;
    return normalizeText(
      option?.getAttribute?.("label") || option?.getAttribute?.("aria-label") || option?.getAttribute?.("title")
      || getDeepText(host) || getDeepText(option) || option?.textContent
    );
  }
  function getVisibleListboxOptionElements(input = null) {
    const options = [];
    for (const listbox of getControlledListboxes(input)) {
      options.push(...querySelectorAllDeep('[role="option"]', listbox).filter((o) => isVisible(o) && o.getAttribute("aria-disabled") !== "true"));
    }
    return Array.from(new Set(options));
  }
  function getVisibleListboxOptionEntries(input = null) {
    return getVisibleListboxOptionElements(input).map((element) => ({ element, text: getListboxOptionText(element) })).filter((o) => o.text);
  }
  function getVisibleListboxOptions(input = null) {
    return uniqueValues(getVisibleListboxOptionEntries(input).map((o) => o.text));
  }
  // Listbox entries a value can legitimately land on: the manual-entry item
  // only when it's the ONLY thing the search returned.
  function getSelectableListboxOptionEntries(input) {
    const entries = getVisibleListboxOptionEntries(input);
    const real = entries.filter((e) => !MANUAL_ENTRY_OPTION_PATTERN.test(e.text));
    return real.length ? real : entries;
  }
  function getDirectMatchingOptionEntry(answer, options) {
    const normalizedAnswer = normalizeComparisonText(typeof answer === "boolean" ? (answer ? "Yes" : "No") : answer);
    if (!normalizedAnswer) return options[0] ?? null;
    return options.find((o) => normalizeComparisonText(o.text) === normalizedAnswer) ?? null;
  }
  // BidHub falls back to an AI embedding-similarity match for anything
  // looser than a direct match; that's the out-of-scope AI-answer backend,
  // so the loosest this goes is "contains" — anything short of that is left
  // unfilled for the generic pipeline to try its own matching on.
  function getBestMatchingOptionEntry(answer, options) {
    if (!Array.isArray(options) || !options.length) return null;
    const direct = getDirectMatchingOptionEntry(answer, options);
    if (direct) return direct;
    const normalizedAnswer = normalizeComparisonText(answer);
    return options.find((o) => {
      const t = normalizeComparisonText(o.text);
      return t && (t.includes(normalizedAnswer) || normalizedAnswer.includes(t));
    }) ?? options[0] ?? null;
  }

  function getAutocompleteInput(field) {
    return querySelectorDeep([
      'spl-autocomplete input[role="combobox"]', 'oc-autocomplete input[role="combobox"]',
      'input[role="combobox"]', "input[aria-autocomplete]", 'input:not([type="hidden"]):not([type="file"])',
    ].join(", "), field);
  }

  async function waitForAutocompleteOptions(input) {
    return waitFor(() => { const v = getVisibleListboxOptions(input); return v.length ? v : null; }, MENU_WAIT_TIMEOUT_MS, 100);
  }
  async function openAutocompleteOptions(input) {
    if (!input) return [];
    const alreadyOpen = getVisibleListboxOptions(input);
    if (alreadyOpen.length) return alreadyOpen;
    await clickLikeHuman(input);
    return (await waitForAutocompleteOptions(input)) ?? [];
  }
  function closeAutocompleteOptions(input) {
    if (!input) return;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
  }

  // The option to click after typing: an exact-text match the moment it
  // shows, else null once the search result list has held steady for a
  // beat (same real options for AUTOCOMPLETE_OPTIONS_SETTLE_MS, past
  // AUTOCOMPLETE_MATCH_MIN_WAIT_MS so an in-flight search can still land) —
  // the caller then takes the best visible option instead.
  async function waitForAutocompleteMatch(input, requestedValue) {
    const startedAt = Date.now();
    let lastSignature = null;
    let stableSince = startedAt;
    const result = await waitFor(() => {
      const options = getSelectableListboxOptionEntries(input);
      if (!options.length) { lastSignature = null; return null; }
      const direct = getDirectMatchingOptionEntry(requestedValue, options);
      if (direct) return { option: direct };
      if (options.every((o) => MANUAL_ENTRY_OPTION_PATTERN.test(o.text))) return null;
      const now = Date.now();
      const signature = options.map((o) => o.text).join("\n");
      if (signature !== lastSignature) { lastSignature = signature; stableSince = now; return null; }
      const settled = now - stableSince >= AUTOCOMPLETE_OPTIONS_SETTLE_MS && now - startedAt >= AUTOCOMPLETE_MATCH_MIN_WAIT_MS;
      return settled ? { option: null } : null;
    }, MENU_WAIT_TIMEOUT_MS, 100);
    return result?.option ?? null;
  }

  // A typed value only reaches submission as a CLICKED option — spl-
  // autocomplete discards free text on Escape and ignores Enter/Tab, so
  // typing alone is never enough.
  async function fillAutocompleteInput(input, value) {
    if (!input || value == null) return;
    const requestedValue = String(value);
    await engine.fillTextInputLikeHuman(input, requestedValue, { clearFirst: true });
    const matchingOption = await waitForAutocompleteMatch(input, requestedValue);
    const selectedOption = matchingOption ?? await getBestMatchingOptionEntry(requestedValue, getSelectableListboxOptionEntries(input));
    if (selectedOption?.element) {
      await clickLikeHuman(selectedOption.element);
      input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
      return;
    }
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    await sleep(150);
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
  }

  function getLocationParts(answer) {
    const value = normalizeText(answer);
    const parts = value.split(",").map(normalizeText).filter(Boolean);
    const hasUsSignal = /\b(us|usa|united states|ma|ny|ca|tx|fl|wa|il|pa|va|ga)\b/i.test(value);
    return {
      city: parts[0] || value,
      country: /canada/i.test(value) ? "Canada" : hasUsSignal ? "United States" : parts[parts.length - 1] || "",
    };
  }
  async function fillLocationField(answer, field) {
    const value = normalizeText(answer);
    if (!value) return;
    const autocompleteInput = querySelectorDeep('spl-autocomplete[data-test="location-autocomplete"] input[role="combobox"], input[role="combobox"]', field);
    if (autocompleteInput && isVisible(autocompleteInput)) {
      await fillAutocompleteInput(autocompleteInput, value);
      await sleep(500);
    }
    const { city, country } = getLocationParts(value);
    // The autocomplete may have bailed out to a manual country+city pair
    // (its own "Cannot find your city? Fill in manually" fallback option).
    const manualCountryInput = querySelectorDeep('spl-autocomplete[data-test="manual-location-country"] input[role="combobox"], input[data-sr-id="location-autocomplete-country-search-input"]');
    if (manualCountryInput && isVisible(manualCountryInput) && country) await fillAutocompleteInput(manualCountryInput, country);
    const manualCityInput = querySelectorDeep('spl-input[data-test="manual-location-city"] input, input[data-sr-id="location-autocomplete-city-input"]');
    if (manualCityInput && isVisible(manualCityInput) && city) fillTextInput(manualCityInput, city);
  }

  // spl-radio has no native input — selection is the `aria-checked`
  // attribute (mirrored by a plain `checked` attribute).
  function isRadioSelected(radio) {
    return radio?.getAttribute?.("aria-checked") === "true" || Boolean(radio?.hasAttribute?.("checked")) || radio?.checked === true;
  }
  function isTruthyCheckboxAnswer(answer) {
    if (typeof answer === "boolean") return answer;
    const n = normalizeComparisonText(answer);
    return ["yes", "true", "y", "agree", "accepted", "consent", "read and understand"].some((v) => n.includes(v));
  }
  async function setCheckbox(checkbox, shouldCheck) {
    if (!checkbox || checkbox.checked === shouldCheck) return;
    await clickLikeHuman(checkbox);
    checkbox.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  // ---- multi-step advance (posting → form, and the form's own Next) -----

  const APPLY_TRIGGER_SELECTOR = 'a.js-oneclick[data-sr-track="apply"]';
  function getSmartButtonControl(field) { return querySelectorDeep("button", field) || field; }
  function getSectionButtons(dataTest, root = document) {
    return querySelectorAllDeep(`oc-button[data-test="${dataTest}"], spl-button[data-test="${dataTest}"]`, root).map(getSmartButtonControl).filter(Boolean);
  }
  function getSectionButton(dataTest, root = document) { return getSectionButtons(dataTest, root)[0] ?? null; }
  function getButtonHost(button) { return closestDeep(button, "oc-button, spl-button") || button; }
  function getButtonText(button) {
    const host = getButtonHost(button);
    return normalizeText(button?.getAttribute?.("aria-label") || host?.getAttribute?.("aria-label") || getDeepText(host) || getDeepText(button) || button?.textContent);
  }
  function isButtonDisabled(button) {
    const host = getButtonHost(button);
    return Boolean(button?.disabled || button?.getAttribute?.("aria-disabled") === "true" || button?.hasAttribute?.("disabled")
      || host?.getAttribute?.("aria-disabled") === "true" || host?.hasAttribute?.("disabled"));
  }
  function getSafeNextButton() {
    const nextButton = getSectionButton("footer-next");
    if (!nextButton || !isVisible(nextButton) || isButtonDisabled(nextButton)) return null;
    const text = getButtonText(nextButton);
    if (!text || UNSAFE_ADVANCE_BUTTON_TEXT_PATTERN.test(text) || !SAFE_ADVANCE_BUTTON_TEXT_PATTERN.test(text)) return null;
    return nextButton;
  }
  // A footer/terminal CTA is a submit when its visible label is a terminal
  // action and NOT a safe advance — complementary-by-construction with
  // getSafeNextButton, so advance() and the submit button can never target
  // the same reused footer CTA.
  function isSubmitLabel(button) {
    if (!button || !isVisible(button)) return false;
    const text = getButtonText(button);
    return Boolean(text) && !SAFE_ADVANCE_BUTTON_TEXT_PATTERN.test(text) && UNSAFE_ADVANCE_BUTTON_TEXT_PATTERN.test(text);
  }
  function findSubmitControl() {
    if (!isOnOneClickForm()) return null;
    const footerControl = querySelectorAllDeep('oc-button[data-test^="footer-"], spl-button[data-test^="footer-"]').map(getSmartButtonControl).filter(Boolean).find(isSubmitLabel);
    if (footerControl) return footerControl;
    return querySelectorAllDeep("oc-button, spl-button").map(getSmartButtonControl).filter(Boolean).find(isSubmitLabel) ?? null;
  }
  function getSubmitButton() {
    const control = findSubmitControl();
    return control && isVisible(control) && !isButtonDisabled(control) ? control : null;
  }
  function detectSubmitButton() {
    const control = findSubmitControl();
    return control ? { detected: true, label: getButtonText(control), disabled: isButtonDisabled(control) } : { detected: false };
  }

  // The posting renders the "I'm interested" trigger in several places
  // (header / aside / bottom); rank the aside copy first — the header one
  // sits aria-hidden inside a collapsed sticky bar.
  function getApplyTriggers() {
    if (isOnOneClickForm()) return [];
    const triggers = querySelectorAllDeep(APPLY_TRIGGER_SELECTOR).filter((el) =>
      el instanceof HTMLElement && !el.classList.contains("js-smartr-oneclick")
      && el.getAttribute("data-sr-track") !== "applyWithSmartr" && isVisible(el));
    const rank = (el) => (el.id === "st-apply" || el.getAttribute("data-sr-track-position") === "aside" ? 0 : el.getAttribute("aria-hidden") === "true" ? 2 : 1);
    return triggers.sort((a, b) => rank(a) - rank(b));
  }

  /** Advance one step. Returns false when nothing safe to click was found,
   *  OR when the posting→form boundary was just crossed (navigates away —
   *  nothing left to fill on THIS page). Returns true after clicking the
   *  form's own in-page Next. Never clicks a terminal Submit/Apply —
   *  findSubmitControl() short-circuits first exactly so this can't. */
  async function advance() {
    if (findSubmitControl()) return false;
    const applyTriggers = getApplyTriggers();
    if (applyTriggers.length) {
      await clickLikeHuman(applyTriggers[0]);
      return false;
    }
    const nextButton = await waitFor(getSafeNextButton, AUTO_ADVANCE_WAIT_TIMEOUT_MS, 100);
    if (!nextButton) return false;
    await clickLikeHuman(nextButton);
    return true;
  }
  function isAutofillAvailable() {
    if (detectFields().length) return true;
    if (detectSubmitButton().detected) return true;
    return Boolean(getApplyTriggers().length || getSafeNextButton());
  }

  /** Write `answer` into a detected field entry. See fillField's switch for
   *  the value shapes each fieldKind expects — same conventions as
   *  bamboohr-autofill.js and the engine's own fillFileInput signature for
   *  'file' ({fileName, base64, mimeType}). */
  async function fillField(entry, answer) {
    if (!entry || answer == null) return false;
    const { fieldKind, field, control } = entry;
    switch (fieldKind) {
      case "text": {
        const input = control || getFieldTextInput(field);
        if (!input) return false;
        await engine.fillTextInputReliably(input, answer);
        return true;
      }
      case "textarea": {
        const textarea = control || querySelectorDeep("textarea", field);
        if (!textarea) return false;
        await engine.fillTextInputReliably(textarea, answer);
        return true;
      }
      case "phone": {
        // spl-phone-field reformats the national number and flips its own
        // country-code select from the dial code — never fed a value with
        // anything but digits/punctuation, and never read back/verified.
        const input = querySelectorDeep('input[type="tel"], input[aria-label="Phone number"]', field);
        if (!input) return false;
        fillTextInput(input, String(answer ?? "").replace(/[^\d()+\-\s]/g, ""));
        return true;
      }
      case "location":
        await fillLocationField(answer, field);
        return true;
      case "autocomplete": {
        const input = control || querySelectorDeep('input[role="combobox"], input', field);
        await fillAutocompleteInput(input, answer);
        return true;
      }
      case "radio-custom": {
        const radios = querySelectorAllDeep('[role="radio"], spl-radio', field).filter(isVisible);
        const options = radios.map((radio) => radio.getAttribute("label") || getDeepText(radio) || radio.getAttribute("value"));
        const match = getDirectMatchingOptionEntry(answer, options.map((text) => ({ text })))?.text
          ?? options.find((o) => normalizeComparisonText(o).includes(normalizeComparisonText(answer)));
        const index = options.findIndex((o) => o === match);
        const radio = index >= 0 ? radios[index] : radios[0];
        if (!radio || isRadioSelected(radio)) return Boolean(radio);
        await clickLikeHuman(radio);
        radio.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        return true;
      }
      case "checkbox": {
        const checkboxes = control ? [control] : querySelectorAllDeep('input[type="checkbox"]', field);
        if (!checkboxes.length) return false;
        if (checkboxes.length === 1) {
          const shouldCheck = isTruthyCheckboxAnswer(answer)
            || normalizeComparisonText(entry.question).includes("privacy notice")
            || normalizeComparisonText(entry.question).includes("read and understand");
          await setCheckbox(checkboxes[0], shouldCheck);
          return true;
        }
        const requested = (Array.isArray(answer) ? answer : [answer]).map(normalizeComparisonText).filter(Boolean);
        for (const checkbox of checkboxes) {
          const label = normalizeComparisonText(getDeepText(closestDeep(checkbox, "label") || checkbox));
          const shouldCheck = requested.some((v) => v === label || v.includes(label) || label.includes(v));
          await setCheckbox(checkbox, shouldCheck);
        }
        return true;
      }
      case "file": {
        if (!answer || typeof answer !== "object") return false;
        const input = querySelectorDeep('input[type="file"]', field);
        if (!input) return false;
        fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        return true;
      }
      default:
        return false;
    }
  }

  // ---- repeatable Education/Work-history sections ------------------------
  // Ported from BidHub's own SmartRecruiters section descriptors — driven
  // by the shared engine/section-hierarchy.js (window.ProactiveSectionHierarchy).
  // BCD's Profile.education/.experience (school/degree/start/end and
  // company/role/start/end/location — see server/src/models/Profile.js)
  // has no major/discipline and no description field — those leaves still
  // detect (visible/editable in the review list) but carry no
  // profileKey/resolveValue, same "detected but unfillable" pattern
  // greenhouse-autofill.js's Discipline leaf uses.
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;

  function getSmartSectionRowField(rowEl, mapping) {
    if (!rowEl) return null;
    let field = rowEl.querySelector ? rowEl.querySelector(mapping.selector) : null;
    if (!field) field = querySelectorDeep(mapping.selector, rowEl);
    return field ? { field } : null;
  }

  // The section container itself acts as the "editor" — a visible Save
  // button inside it means an entry is currently open for editing.
  function getSmartSectionEditor(container, saveButtonTest) {
    if (!container) return null;
    const saveButton = querySelectorDeep(`[data-test="${saveButtonTest}"]`, container);
    return saveButton && isVisible(saveButton) ? container : null;
  }

  // One row per delete button — present for BOTH a committed entry and one
  // still being edited (SmartRecruiters renders Delete alongside Save on
  // an open card), so this also doubles as the "find the just-opened
  // entry" lookup ensureRow()'s getRows()[index] polling needs.
  function getSmartSectionCommittedRows(container, deleteButtonTest) {
    if (!container) return [];
    return querySelectorAllDeep(`[data-test="${deleteButtonTest}"]`, container)
      .map((button) => closestDeep(button, "li"))
      .filter(Boolean);
  }

  async function addSmartSectionRow(container, addButtonTest) {
    const button = querySelectorDeep(`oc-button[data-test="${addButtonTest}"], spl-button[data-test="${addButtonTest}"]`, container);
    if (button) await clickLikeHuman(getSmartButtonControl(button));
  }

  async function saveSmartSectionEntry(container, saveButtonTest) {
    const button = querySelectorDeep(`[data-test="${saveButtonTest}"]`, container);
    if (button) await clickLikeHuman(getSmartButtonControl(button));
    await sleep(400);
  }

  async function clearSectionEntries(container, { deleteButtonTest, cancelButtonTest }) {
    if (!container) return;
    const cancelButtons = querySelectorAllDeep(`[data-test="${cancelButtonTest}"]`, container).filter(isVisible);
    for (const cancelButton of cancelButtons) await clickLikeHuman(getSmartButtonControl(cancelButton));
    for (let attempt = 0; attempt < 10; attempt++) {
      const deleteButton = querySelectorDeep(`[data-test="${deleteButtonTest}"]`, container);
      if (!deleteButton) break;
      await clickLikeHuman(getSmartButtonControl(deleteButton));
      const confirmDialog = await waitFor(() => {
        const dialogs = querySelectorAllDeep('[role="dialog"], spl-dialog[open]').filter(isVisible);
        if (!dialogs.length) return null;
        return dialogs.find((d) => /delete this entry/i.test(getDeepText(d))) || dialogs[0];
      }, 2000);
      if (confirmDialog) {
        const confirmButton = querySelectorAllDeep("button", confirmDialog).find((b) => /\b(delete|yes)\b/i.test(getButtonText(b)));
        if (confirmButton) await clickLikeHuman(confirmButton);
      }
      await sleep(200);
    }
  }

  const SMART_EDUCATION_SECTION = {
    rootFieldId: "educationHistory",
    rootQuestion: "Education",
    profileSection: "education",
    rowLabel: (i) => `Education ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    maxEntries: 3,
    getContainer: () => document.querySelector('[data-test="education"]'),
    getRows: (container) => getSmartSectionCommittedRows(container, "education-entry-delete"),
    getEditor: (container) => getSmartSectionEditor(container, "education-save"),
    getRowField: getSmartSectionRowField,
    addRow: (container) => addSmartSectionRow(container, "add-education"),
    clearRows: (container) => clearSectionEntries(container, { deleteButtonTest: "education-entry-delete", cancelButtonTest: "education-cancel" }),
    saveEntry: (container) => saveSmartSectionEntry(container, "education-save"),
    mappings: [
      { key: "institution", selector: '[data-test="institution-autocomplete"]', fieldKind: "text", question: "Institution", label: "Institution", profileKey: "school" },
      { key: "major", selector: '[data-test="education-major"]', fieldKind: "text", question: "Major", label: "Major" },
      { key: "degree", selector: '[data-test="education-degree"]', fieldKind: "text", question: "Degree", label: "Degree", profileKey: "degree" },
      { key: "location", selector: '[data-test="education-location"]', fieldKind: "text", question: "Location", label: "Location" },
      { key: "description", selector: '[data-test="education-description"]', fieldKind: "textarea", question: "Description", label: "Description" },
      { key: "startDate", selector: '[data-test="education-date-from"]', fieldKind: "date", question: "Start Date", label: "Start Date", profileKey: "start" },
      { key: "current", selector: '[data-test="education-current"]', fieldKind: "checkbox", question: "Current", label: "Current", resolveValue: (e) => !String(e?.end || "").trim() },
      { key: "endDate", selector: '[data-test="education-date-to"]', fieldKind: "date", question: "End Date", label: "End Date", resolveValue: (e) => (String(e?.end || "").trim() ? e.end : null) },
    ],
  };

  const SMART_WORK_HISTORY_SECTION = {
    rootFieldId: "workHistory",
    rootQuestion: "Work history",
    profileSection: "experience",
    rowLabel: (i) => `Work history ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    maxEntries: 3,
    getContainer: () => document.querySelector('[data-test="experience"]'),
    getRows: (container) => getSmartSectionCommittedRows(container, "experience-entry-delete"),
    getEditor: (container) => getSmartSectionEditor(container, "experience-save"),
    getRowField: getSmartSectionRowField,
    addRow: (container) => addSmartSectionRow(container, "add-experience"),
    clearRows: (container) => clearSectionEntries(container, { deleteButtonTest: "experience-entry-delete", cancelButtonTest: "experience-cancel" }),
    saveEntry: (container) => saveSmartSectionEntry(container, "experience-save"),
    mappings: [
      { key: "jobTitle", selector: '[data-test="job-title-autocomplete"]', fieldKind: "text", question: "Job Title", label: "Job Title", profileKey: "role" },
      { key: "company", selector: '[data-test="company-autocomplete"]', fieldKind: "text", question: "Company", label: "Company", profileKey: "company" },
      { key: "location", selector: '[data-test="location-autocomplete"]', fieldKind: "text", question: "Location", label: "Location", profileKey: "location" },
      { key: "description", selector: '[data-test="experience-description"]', fieldKind: "textarea", question: "Description", label: "Description" },
      { key: "startDate", selector: '[data-test="experience-date-from"]', fieldKind: "date", question: "Start Date", label: "Start Date", profileKey: "start" },
      { key: "current", selector: '[data-test="experience-current"]', fieldKind: "checkbox", question: "Current", label: "Current", resolveValue: (e) => !String(e?.end || "").trim() },
      { key: "endDate", selector: '[data-test="experience-date-to"]', fieldKind: "date", question: "End Date", label: "End Date", resolveValue: (e) => (String(e?.end || "").trim() ? e.end : null) },
    ],
  };

  const SMART_SECTIONS = [SMART_EDUCATION_SECTION, SMART_WORK_HISTORY_SECTION];

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections(SMART_SECTIONS, profileData);
  }

  async function fillSectionLeaf(field, mapping, value) {
    switch (mapping.fieldKind) {
      case "text":
      case "date":
      case "textarea":
        await engine.fillTextInputReliably(field, value);
        return;
      case "checkbox": {
        const input = field.matches?.('input[type="checkbox"]') ? field : querySelectorDeep('input[type="checkbox"]', field) || field;
        const checked = input?.checked === true || input?.getAttribute?.("aria-checked") === "true";
        if (Boolean(checked) !== Boolean(value)) await clickLikeHuman(input);
        return;
      }
      default:
        return;
    }
  }

  async function fillSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    const results = [];
    for (const section of SMART_SECTIONS) {
      const entries = (profileData && profileData[section.profileSection]) || [];
      if (!entries.length) continue;
      const result = await SECTION_HIERARCHY.fillSection(section, entries, fillSectionLeaf);
      results.push({ rootFieldId: section.rootFieldId, ...result });
    }
    return results;
  }

  NS.smartrecruiters = {
    isOnOneClickForm,
    isAutofillAvailable,
    detectFields,
    fillField,
    getSubmitButton,
    detectSubmitButton,
    isButtonDisabled,
    advance,
    detectSections,
    fillSections,
  };
})();
