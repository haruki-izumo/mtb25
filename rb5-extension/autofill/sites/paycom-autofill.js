/* =====================================================================
 * autofill/sites/paycom-autofill.js — Paycom career portal application
 * flow (*.paycomonline.net/v4/ats/web.php/portal/<clientkey>/...).
 * =====================================================================
 * Ported from BidHub's packages/job-parsers/content/platforms/paycom/
 * autofill.js.
 *
 * Flow (verified live on a real tenant by BidHub, 2026-10-07):
 *   1. Posting page (/portal/<key>/jobs/<id>): "Apply" opens the
 *      "Getting You Started" MODAL — a per-tenant candidate ACCOUNT
 *      form (legal name, email + confirm, phone, SMS consent) gated by
 *      an invisible hCaptcha on "Continue To Application". A link in
 *      the modal switches to the Sign In modal (email + password) and
 *      back.
 *   2. Application page: ONE long page (side nav = sections) —
 *      Personal Information (Resume/CV + Cover Letter dropzones, legal
 *      name, phone + type, SMS consent, address with a Country MODAL
 *      picker, referral source), Education/Employment/References
 *      (repeatable rows), Voluntary Information (EEO), the
 *      Authorization acknowledgement, then Submit. A "Start
 *      Application" modal (Autofill with Resume/CV | Apply Manually)
 *      opens on first load.
 *
 * DOM contract (Paycom's "uiLib" design system): every control carries
 * a deterministic id/name — `personal-information-<field>-field`,
 * `<section>-<field>-field-<row>` for repeatable rows, radio names =
 * the field id, checkbox `input.uiLibCheckboxInput` mirrored by a
 * presentational `button#CheckboxOuterID-<id>` (the hidden input is
 * what actually toggles), native `select.uiLibNativeSelect`, dates = a
 * `[role=textbox][aria-label]` root with MM/DD/YYYY sub-inputs, the
 * country picker = a `.uiLibCountryList` button that opens a MODAL
 * (`input#search` + `li[data-testid="country-list-item-<Name>"]`), the
 * institution name field = an autocomplete whose suggestions render in
 * a floating `[data-popper-placement]` popper.
 *
 * Ported, structural-only: the signup/signin/start/country/resume-
 * parse modal classifier, the main application-page field scan (text,
 * phone, native select, radio group, checkbox, composite date, the
 * country MODAL picker, the institution autocomplete, resume/cover-
 * letter dropzones), and the posting -> account-modal -> application
 * -> submit advance flow (including the structural, non-AI "account
 * already exists -> switch to sign-in" retry).
 *
 * Explicitly NOT ported: the AI-answer backend (getAnswer(), the
 * embedding-similarity fallback this file's own matching only
 * approximates with exact/prefix/substring), the invisible-hCaptcha
 * SOLVING itself (we only click the gated button same as BidHub does —
 * neither file attempts to solve the challenge), and the repeatable
 * Education/Employment/Reference row editor beyond detecting each
 * row's plain fields (BidHub's autofill-section-hierarchy.js "Add
 * row" flow is a generic multi-entry editor shared across several
 * ATSes, not a Paycom-specific structural quirk). Rows already
 * rendered on the page (row 1, always present) are detected and filled
 * like any other field; adding additional rows is left to Big Banana's
 * existing generic pipeline. =========================================
 * ===================================================================== */
(function () {
  "use strict";
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const { sleep, fillTextInput, writeReactTextValue, fillSelectInput, fillFileInput, clickLikeHuman, getRadioInputs } = engine;

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});

  async function waitFor(check, timeoutMs, pollMs = 150) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = check();
      if (result) return result;
      await sleep(pollMs);
    }
    return null;
  }

  const RESUME_FIELD_ID = "resume";
  const COVER_LETTER_FIELD_ID = "cover_letter";
  const MIDDLE_NAME_FIELD_ID = "personal-information-legal-middle-name-field";
  const NO_MIDDLE_NAME_CHECKBOX_NAME = "i-do-not-have-a-middle-name";
  const ACKNOWLEDGEMENT_CHECKBOX_NAME = "authorization-acknowledge-disclosure-field";
  const UPDATE_ACCOUNT_CHECKBOX_NAME = "update-my-account-checkbox";
  const WOTC_OPT_IN_CHECKBOX_NAME = "tax-credit-opt-in-questionnaire";
  const SIGNUP_EMAIL_ID = "email";
  const SIGNUP_CONFIRM_EMAIL_ID = "confirmEmail";
  const OPEN_MODAL_SELECTOR = ".uiLibModal.ui-modal-open";
  const APPLY_BUTTON_SELECTOR = '[data-testid="Apply-loadingbutton"]';
  const SIGNUP_CONTINUE_SELECTOR = '[data-testid="createAccountNextButton-loadingbutton"]';
  const SIGNIN_SUBMIT_SELECTOR = '[data-testid="signInSubmitButton-loadingbutton"]';
  const SIGNIN_LINK_SELECTOR = '[data-testid="signInClickableText"]';
  const CREATE_ACCOUNT_LINK_SELECTOR = '[data-testid="createAccountClickableText"]';
  const COUNTRY_LIST_ITEM_SELECTOR = 'li[data-testid^="country-list-item-"]';
  const COUNTRY_SEARCH_SELECTOR = 'input#search, input[data-testid="searchsearchinput"], input[type="search"]';
  const INSTITUTION_SUGGESTION_SELECTOR = '[data-popper-placement] [tabindex="0"]';
  const EXCLUDED_SCOPE_SELECTOR = '.uiLibModal, nav, [data-testid="sideNavContainer"], footer, [id*="tax-credit"]';
  const SECTION_CONTROL_PATTERN = /^(education|employment|reference)-.*-(field|checkbox)-\d+(?:-(?:month|day|year))?$/i;
  const MODAL_WAIT_MS = 3000;
  const MODAL_CLOSE_WAIT_MS = 2500;
  const COUNTRY_ITEM_WAIT_MS = 3000;
  const SUGGESTION_WAIT_MS = 3000;
  const UPLOAD_SETTLE_MS = 20000;
  const APPLY_REVEAL_WAIT_MS = 4000;
  const POLL_MS = 150;
  const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function cssEscape(value) {
    return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&");
  }
  function cleanText(value) { return String(value ?? "").replace(/\u200b/g, "").replace(/\s+/g, " ").trim(); }
  // Text of an element WITHOUT its <style>/<script> children — the SMS-
  // consent paragraph carries an inline <style> for its links, which
  // textContent would otherwise hand back as part of the question.
  function textOf(element) {
    if (!element) return "";
    if (!element.querySelector?.("style, script")) return element.textContent ?? "";
    const clone = element.cloneNode(true);
    clone.querySelectorAll("style, script").forEach((n) => n.remove());
    return clone.textContent ?? "";
  }
  // Paycom appends " *" to required labels and " N of M." to radio aria-labels.
  const cleanQuestion = (value) => cleanText(value).replace(/\s*\*\s*$/, "").replace(/\s*\d+\s+of\s+\d+\.?\s*$/i, "").trim();
  const normalizeComparisonText = (value) => cleanText(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const isAffirmative = (answer) => {
    if (typeof answer === "boolean") return answer;
    const value = cleanText(answer).toLowerCase();
    if (!value) return false;
    return !["no", "false", "0", "n", "unchecked", "decline", "none", "off"].includes(value);
  };
  function normalizePhoneDigits(answer) {
    const digits = String(answer ?? "").replace(/\D/g, "");
    // The field carries its own country-code button (+1 default) — hand
    // over the national number.
    if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
    return digits;
  }
  function parseFreeformDate(value) {
    const v = cleanText(value);
    if (!v) return null;
    const pad = (p) => (p ? String(p).padStart(2, "0") : null);
    let m = v.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:T.*)?$/);
    let parsed = null;
    if (m) parsed = { month: pad(m[2]), day: pad(m[3]), year: m[1] };
    if (!parsed) { m = v.match(/^(\d{1,2})[/-](\d{4})$/); if (m) parsed = { month: m[1].padStart(2, "0"), day: null, year: m[2] }; }
    if (!parsed) { m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/); if (m) parsed = { month: m[1].padStart(2, "0"), day: m[2].padStart(2, "0"), year: m[3].length === 2 ? `20${m[3]}` : m[3] }; }
    if (!parsed) {
      m = v.match(/^([A-Za-z]+)\s+(?:(\d{1,2}),?\s+)?(\d{4})$/);
      if (m) { const idx = MONTH_NAMES.findIndex((n) => n.toLowerCase().startsWith(m[1].toLowerCase())); parsed = { month: idx >= 0 ? String(idx + 1).padStart(2, "0") : null, day: pad(m[2]), year: m[3] }; }
    }
    if (!parsed && /^\d{4}$/.test(v)) parsed = { month: null, day: null, year: v };
    if (!parsed || !parsed.year) return null;
    return { month: parsed.month || "01", day: parsed.day || "01", year: parsed.year };
  }
  // Paycom's country list spells the US "United States of America (USA)";
  // map the usual profile spellings onto what the search box will match.
  const COUNTRY_ALIASES = [
    [/^(usa?|u\.s\.a?\.?|united states( of america)?( \(usa\))?)$/i, "United States of America"],
    [/^(uk|u\.k\.|great britain|britain|england)$/i, "United Kingdom"],
    [/^(uae|u\.a\.e\.)$/i, "United Arab Emirates"],
  ];
  function normalizeCountryName(answer) {
    const value = cleanText(answer);
    if (!value) return "";
    const alias = COUNTRY_ALIASES.find(([pattern]) => pattern.test(value));
    return alias ? alias[1] : value;
  }
  function isElementVisible(element) {
    if (!element?.isConnected) return false;
    if (element.hidden) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }
  // uiLib checkboxes keep the native input display:none and render a
  // `button#CheckboxOuterID-<id>` as the visible control.
  function isCheckboxVisible(input) {
    if (!input?.isConnected) return false;
    const button = input.id ? document.getElementById(`CheckboxOuterID-${input.id}`) : null;
    const label = (input.id && document.querySelector(`label[for="${cssEscape(input.id)}"]`)) || input.closest("label");
    return isElementVisible(button || label || input);
  }

  // ---- page / modal state --------------------------------------------

  const isJobPage = () => /\/portal\/[^/]+\/jobs\/\d+/i.test(window.location.pathname);
  const isApplicationPage = () => /\/portal\/[^/]+\/applications(?:\/|$)/i.test(window.location.pathname);
  function getOpenModal() {
    const modals = Array.from(document.querySelectorAll(OPEN_MODAL_SELECTOR)).filter(isElementVisible);
    return modals[modals.length - 1] || null; // topmost
  }
  function getModalTitle(modal) { return cleanText(modal?.querySelector("h2, h1")?.textContent); }
  // 'signup' (Getting You Started) | 'signin' | 'start' (Start
  // Application) | 'country' (picker) | 'resume-parse' | 'other' | null.
  function getModalKind(modal) {
    if (!modal) return null;
    const title = getModalTitle(modal);
    if (modal.querySelector(SIGNUP_CONTINUE_SELECTOR) || /getting you started/i.test(title)) return "signup";
    if (modal.querySelector(SIGNIN_SUBMIT_SELECTOR) || (/sign in/i.test(title) && modal.querySelector('input[type="password"]'))) return "signin";
    if (/start application/i.test(title)) return "start";
    if (modal.querySelector(COUNTRY_LIST_ITEM_SELECTOR) || modal.querySelector(COUNTRY_SEARCH_SELECTOR)) return "country";
    if (/resume\/?cv uploaded|use this resume|replace all existing entries/i.test(cleanText(modal.textContent))) return "resume-parse";
    return "other";
  }
  function findModalButton(modal, pattern) {
    return Array.from(modal?.querySelectorAll('button, [role="button"]') ?? []).filter(isElementVisible).find((b) => pattern.test(cleanText(b.textContent))) || null;
  }
  function waitForModalClosed(timeoutMs = MODAL_CLOSE_WAIT_MS) {
    return waitFor(() => (getOpenModal() ? null : true), timeoutMs, POLL_MS);
  }
  function isSectionRowControl(element) {
    const id = element?.id || "";
    const name = element?.getAttribute?.("name") || "";
    return SECTION_CONTROL_PATTERN.test(id) || SECTION_CONTROL_PATTERN.test(name) || /^education-country-field-\d+$/i.test(id);
  }
  function isExcludedFromScan(element, scope) {
    let node = element;
    while (node && node !== scope && node !== document.body) {
      if (node.matches?.(EXCLUDED_SCOPE_SELECTOR)) return true;
      node = node.parentElement;
    }
    return false;
  }

  // ---- labels / requiredness ------------------------------------------

  function getLinkedLabel(control) {
    if (!control?.id) return null;
    return document.querySelector(`label[for="${cssEscape(control.id)}"]`);
  }
  function getControlQuestion(control) {
    const linked = getLinkedLabel(control);
    if (linked) { const text = cleanQuestion(textOf(linked)); if (text) return text; } // label wraps the control — its text IS the question
    const ariaLabel = cleanQuestion(control.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    const wrappedLabel = control.closest("label");
    if (wrappedLabel) { const text = cleanQuestion(textOf(wrappedLabel)); if (text) return text; }
    const wrapperLabel = control.closest(".uiLibInput, .uiLibNativeSelectBase")?.parentElement?.querySelector("label");
    if (wrapperLabel) { const text = cleanQuestion(textOf(wrapperLabel)); if (text) return text; }
    const placeholder = cleanQuestion(control.getAttribute("placeholder"));
    if (placeholder) return placeholder;
    const testId = control.getAttribute("data-testid") || "";
    if (/-select$/.test(testId)) return cleanQuestion(testId.replace(/-select$/, ""));
    return "";
  }
  function isRequiredControl(control) {
    if (control.required || control.getAttribute("aria-required") === "true") return true;
    if (control.closest(".ui-input-required, .ui-native-select-required, .ui-countrylist-required")) return true;
    const label = getLinkedLabel(control) || control.closest("label");
    return /\*\s*$/.test(cleanText(textOf(label)));
  }
  function compareDocumentOrder(left, right) {
    if (left === right || !left?.compareDocumentPosition) return 0;
    const position = left.compareDocumentPosition(right);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  // ---- detection: controls -> field entries ----------------------------

  function getRadioLabel(radio) {
    const fromLabel = cleanQuestion(textOf(getLinkedLabel(radio)));
    if (fromLabel) return fromLabel;
    const fromAria = cleanQuestion(radio.getAttribute("aria-label"));
    if (fromAria) return fromAria;
    return cleanQuestion(radio.value);
  }
  function getRadiosByName(name) {
    if (!name) return [];
    return Array.from(document.querySelectorAll(`input[type="radio"][name="${cssEscape(name)}"]`));
  }
  // The group's prompt: the paragraph Paycom renders right before the field
  // wrapper (e.g. the SMS-consent text) beats the terse aria-label that
  // only names the control. Followed by an inline <style> for its links —
  // step back over that.
  function getRadioGroupPrompt(group, name) {
    const wrapper = document.getElementById(name) || group.closest("div[id]");
    let prompt = wrapper?.previousElementSibling ?? null;
    while (prompt && prompt.matches("style, script")) prompt = prompt.previousElementSibling;
    if (!prompt || prompt.querySelector("input, select, textarea")) return null;
    return prompt;
  }
  function getRadioGroupQuestion(group, name) {
    const prompt = getRadioGroupPrompt(group, name);
    const promptText = prompt ? cleanQuestion(textOf(prompt)) : "";
    if (promptText && promptText.length > 3) return promptText;
    const legend = cleanQuestion(textOf(group.closest("fieldset")?.querySelector("legend")));
    if (legend) return legend;
    return cleanQuestion(group.getAttribute("aria-label")) || cleanQuestion(name.replace(/^[a-z-]+-information-/, "").replace(/-field$/, "").replace(/-/g, " "));
  }
  function getDateParts(root) {
    return {
      month: root?.querySelector('input[id$="-month"], input[placeholder="MM"]') || null,
      day: root?.querySelector('input[id$="-day"], input[placeholder="DD"]') || null,
      year: root?.querySelector('input[id$="-year"], input[placeholder="YYYY"]') || null,
    };
  }
  const isDateRoot = (element) => Boolean(element?.querySelector?.('.uiLibDateInput, input[placeholder="MM"]')) && !element.matches?.(".uiLibDateInput");
  function isDatePrefilled(root) {
    const parts = getDateParts(root);
    return Boolean(cleanText(parts.month?.value) && cleanText(parts.day?.value) && cleanText(parts.year?.value));
  }
  function getCountryWrapper(element) {
    if (!element) return null;
    if (element.matches?.(".uiLibCountryList")) return element;
    return element.querySelector?.(".uiLibCountryList") || element.closest?.(".uiLibCountryList") || null;
  }
  function getCountryButton(element) { return getCountryWrapper(element)?.querySelector("button") || null; }
  function readSelectedCountry(button) {
    const match = /country combo box,?\s*(.*?)\s*selected/i.exec(button?.getAttribute("aria-label") || "");
    return cleanText(match?.[1]);
  }
  function getDropzoneKind(label) {
    if (/resume|\bcv\b|curriculum/i.test(label)) return "resume";
    if (/cover\s*letter/i.test(label)) return "cover_letter";
    return "file";
  }
  function getDropzones(scope) {
    return Array.from(scope.querySelectorAll('[role="button"][aria-label]')).filter((el) => el.querySelector('input[type="file"]') && !isExcludedFromScan(el, scope));
  }
  function buildDropzoneEntry(dropzone, index) {
    const label = cleanQuestion(dropzone.getAttribute("aria-label"));
    const kind = getDropzoneKind(label);
    if (kind === "resume") return { question: label || "Resume/CV", fieldId: RESUME_FIELD_ID, fieldKind: "file", field: dropzone, control: null, options: null, isResume: true };
    if (kind === "cover_letter") return { question: label || "Cover Letter", fieldId: COVER_LETTER_FIELD_ID, fieldKind: "file", field: dropzone, control: null, options: null, isCoverLetter: true };
    return { question: label || `Document upload ${index + 1}`, fieldId: dropzone.id || `paycom-file-${index}`, fieldKind: "file", field: dropzone, control: null, options: null };
  }

  const TEXT_INPUT_TYPES = new Set(["text", "email", "tel", "number", "url", ""]);
  function buildTextEntry(control, { modal = false } = {}) {
    const fieldId = control.id || control.getAttribute("name") || control.getAttribute("data-testid") || "";
    if (!fieldId) return null;
    const question = getControlQuestion(control);
    if (!question) return null;
    if (/social.?security|\bssn\b/i.test(`${fieldId} ${question}`)) return null; // never
    const isTextarea = control.tagName === "TEXTAREA";
    const isPhone = /internationalphonenumbers$/i.test(control.getAttribute("data-testid") || "") || control.getAttribute("inputmode") === "tel" || control.type === "tel";
    const common = { question, fieldId, field: control, control, options: null };
    if (fieldId === MIDDLE_NAME_FIELD_ID) {
      // Required unless "I do not have a middle name" is ticked — one
      // logical question; a profile without a middle name ticks the box
      // instead of leaving a required input empty.
      return { ...common, fieldKind: "middle-name" };
    }
    if (modal && fieldId === SIGNUP_CONFIRM_EMAIL_ID) {
      // Repeat the email just typed into the signup email field rather
      // than asking the caller to supply it twice.
      return { ...common, fieldKind: "confirm-email" };
    }
    if (/-institution-name-field-/i.test(fieldId)) return { ...common, fieldKind: "institution" };
    if (isPhone) return { ...common, fieldKind: "phone" };
    if (isTextarea) return { ...common, fieldKind: "textarea" };
    return { ...common, fieldKind: "text" };
  }
  function buildSelectEntry(select) {
    const fieldId = select.id || select.getAttribute("name") || (select.getAttribute("data-testid") || "").replace(/-select$/, "");
    if (!fieldId) return null;
    const question = getControlQuestion(select) || cleanQuestion(select.closest('[role="listbox"]')?.getAttribute("aria-label"));
    if (!question) return null;
    const options = Array.from(select.options).map((o) => cleanText(o.textContent)).filter(Boolean);
    if (!options.length) return null;
    return { question, fieldId, fieldKind: "select-native", field: select, control: select, options };
  }
  function buildRadioGroupEntry(group) {
    const radios = Array.from(group.querySelectorAll('input[type="radio"]'));
    const name = radios[0]?.getAttribute("name") || "";
    if (!name) return null;
    const options = radios.map((r) => getRadioLabel(r)).filter(Boolean);
    if (!options.length) return null;
    const question = getRadioGroupQuestion(group, name);
    return { question, fieldId: name, fieldKind: "radio", field: group, control: null, options };
  }
  function buildCheckboxEntry(checkbox) {
    const fieldId = checkbox.id || checkbox.getAttribute("name") || "";
    const name = checkbox.getAttribute("name") || checkbox.id || "";
    if (!fieldId) return null;
    const question = getControlQuestion(checkbox);
    if (!question) return null;
    if (name === ACKNOWLEDGEMENT_CHECKBOX_NAME) {
      // The application can't be submitted without this acknowledgement; it
      // carries no profile data — always "Yes", and re-affirmed right
      // before the final Submit click (see clickSubmitButton below), since
      // Paycom un-ticks it on any later edit.
      return { question, fieldId, fieldKind: "checkbox", field: checkbox, control: checkbox, options: ["Yes", "No"], fillLast: true, fixedAnswer: true };
    }
    return { question, fieldId, fieldKind: "checkbox", field: checkbox, control: checkbox, options: ["Yes", "No"] };
  }
  function buildDateEntry(root) {
    const fieldId = root.id || "";
    if (!fieldId || isDatePrefilled(root)) return null;
    const question = cleanQuestion(root.getAttribute("aria-label")) || cleanQuestion(root.querySelector(".uiLibDateInputLabel")?.textContent);
    if (!question) return null;
    return { question, fieldId, fieldKind: "date", field: root, control: null, options: null };
  }
  function buildCountryEntry(wrapper) {
    const host = wrapper.closest("span[id], div[id]");
    const fieldId = host?.id || "country";
    const question = cleanQuestion(wrapper.querySelector("label")?.textContent) || "Country";
    return { question, fieldId, fieldKind: "country", field: host || wrapper, control: null, options: null };
  }

  // Generic scan of a scope (the application page, or one auth modal).
  // Repeatable-row controls are skipped (isSectionRowControl) — adding
  // ADDITIONAL rows is out of scope (see file header); row 1, always
  // rendered, is picked up like any other plain field.
  function scanControls(scope, { modal = false } = {}) {
    const fields = [];
    const seen = new Set();
    const push = (entry) => { if (!entry?.fieldId || seen.has(entry.fieldId)) return; seen.add(entry.fieldId); fields.push(entry); };
    const skip = (element) => !isElementVisible(element) || (!modal && isExcludedFromScan(element, scope)) || isSectionRowControl(element);

    getDropzones(scope).forEach((dropzone, index) => { if (!skip(dropzone)) push(buildDropzoneEntry(dropzone, index)); });
    Array.from(scope.querySelectorAll("input, textarea")).forEach((control) => {
      if (skip(control)) return;
      const type = (control.getAttribute("type") || "").toLowerCase();
      if (control.tagName === "INPUT" && !TEXT_INPUT_TYPES.has(type)) return;
      if (type === "search" || control.matches(COUNTRY_SEARCH_SELECTOR)) return;
      if (control.closest(".uiLibDateInput, .uiLibCountryList")) return;
      if (control.getAttribute("name") === NO_MIDDLE_NAME_CHECKBOX_NAME) return;
      if (/^(search-by-keyword|select-location-input|Rows per page)/i.test(control.id || control.getAttribute("name") || "")) return;
      push(buildTextEntry(control, { modal }));
    });
    Array.from(scope.querySelectorAll("select")).forEach((select) => { if (!skip(select)) push(buildSelectEntry(select)); });
    Array.from(scope.querySelectorAll('[role="radiogroup"]')).forEach((group) => {
      if (skip(group)) return;
      const radios = group.querySelectorAll('input[type="radio"]');
      if (!radios.length || Array.from(radios).some(isSectionRowControl)) return;
      push(buildRadioGroupEntry(group));
    });
    Array.from(scope.querySelectorAll('input[type="checkbox"]')).forEach((checkbox) => {
      if (!isCheckboxVisible(checkbox) || (!modal && isExcludedFromScan(checkbox, scope)) || isSectionRowControl(checkbox)) return;
      const name = checkbox.getAttribute("name") || checkbox.id || "";
      if ([NO_MIDDLE_NAME_CHECKBOX_NAME, UPDATE_ACCOUNT_CHECKBOX_NAME, WOTC_OPT_IN_CHECKBOX_NAME].includes(name)) return;
      push(buildCheckboxEntry(checkbox));
    });
    Array.from(scope.querySelectorAll('[role="textbox"][aria-label], [id][aria-label]')).forEach((root) => { if (isDateRoot(root) && !skip(root)) push(buildDateEntry(root)); });
    Array.from(scope.querySelectorAll(".uiLibCountryList")).forEach((wrapper) => {
      if (skip(wrapper) || isSectionRowControl(wrapper.closest("span[id], div[id]"))) return;
      push(buildCountryEntry(wrapper));
    });
    fields.sort((left, right) => compareDocumentOrder(left.field, right.field));
    return fields;
  }

  function detectApplicationFields() {
    const fields = scanControls(document.body);
    // Work Opportunity Tax Credit questionnaire (tenant-toggled, asks
    // SSN/DOB/benefit history): always decline rather than answer it — the
    // questionnaire is voluntary and never application data.
    const wotcOptIn = document.querySelector(`input[type="checkbox"][name="${WOTC_OPT_IN_CHECKBOX_NAME}"]`);
    if (wotcOptIn && isCheckboxVisible(wotcOptIn)) {
      fields.push({ question: "I would like to complete the Tax Credit Questionnaire", fieldId: "tax-credit-questionnaire-opt-out", fieldKind: "checkbox", field: wotcOptIn, control: wotcOptIn, options: ["Yes", "No"], fixedAnswer: false });
    }
    return fields;
  }
  function detectAuthModalFields(modal) {
    return scanControls(modal, { modal: true });
  }
  function detectFields() {
    const modal = getOpenModal();
    const kind = getModalKind(modal);
    if (kind === "signup" || kind === "signin") return detectAuthModalFields(modal);
    if (isApplicationPage()) return detectApplicationFields();
    return [];
  }

  // ---- live control resolution (a field's control can be replaced by a
  // re-render between detect and fill) ---------------------------------

  function liveControl(fieldId, fallback = null) {
    if (fieldId) {
      const byId = document.getElementById(fieldId);
      if (byId) return byId;
      const byName = document.querySelector(`[name="${cssEscape(fieldId)}"]`);
      if (byName) return byName;
      const byTestId = document.querySelector(`select[data-testid="${cssEscape(`${fieldId}-select`)}"], [data-testid="${cssEscape(fieldId)}"]`);
      if (byTestId) return byTestId;
    }
    return fallback;
  }
  function liveDropzone(fieldId, fallback) {
    if (fieldId === RESUME_FIELD_ID || fieldId === COVER_LETTER_FIELD_ID) {
      const kind = fieldId === RESUME_FIELD_ID ? "resume" : "cover_letter";
      const match = getDropzones(document.body).find((zone) => getDropzoneKind(cleanQuestion(zone.getAttribute("aria-label"))) === kind);
      if (match) return match;
    }
    return liveControl(fieldId, fallback);
  }

  // ---- fills -----------------------------------------------------------

  // Exact/prefix/substring match only — BidHub falls back to an AI
  // embedding-similarity match beyond this; out of scope here, so a
  // looser miss just skips the field (left for the generic pipeline).
  function matchOptionIndex(texts, answer) {
    const wanted = normalizeComparisonText(typeof answer === "boolean" ? (answer ? "Yes" : "No") : answer);
    if (!wanted) return -1;
    const normalized = texts.map(normalizeComparisonText);
    let i = normalized.findIndex((t) => t === wanted);
    if (i >= 0) return i;
    i = normalized.findIndex((t) => t.length >= 3 && (t.startsWith(wanted) || wanted.startsWith(t)));
    if (i >= 0) return i;
    i = normalized.findIndex((t) => wanted.length >= 4 && t.includes(wanted));
    return i;
  }
  // A controlled <select>/checkbox can be wiped back by React's state-
  // restore when the write lands right after the component (re)renders —
  // re-write on later ticks until it holds; never fight a real change.
  const SELECT_REASSERT_DELAYS_MS = [20, 60, 150, 350, 700];
  async function commitSelectValue(select, value) {
    const before = select.value;
    fillSelectInput(select, value);
    for (const delay of SELECT_REASSERT_DELAYS_MS) {
      await sleep(delay);
      if (!select.isConnected || select.value === value) return;
      if (select.value !== before && select.value !== "") return; // someone else set a real value
      fillSelectInput(select, value);
    }
  }
  async function fillNativeSelect(select, answer) {
    if (!select || answer == null) return;
    const options = Array.from(select.options).filter((o) => cleanText(o.textContent));
    const index = matchOptionIndex(options.map((o) => cleanText(o.textContent)), answer);
    if (index < 0) return;
    if (select.value !== options[index].value) await commitSelectValue(select, options[index].value);
  }
  async function chooseRadio(radios, answer) {
    if (!radios.length || answer == null) return;
    const index = matchOptionIndex(radios.map((r) => getRadioLabel(r)), answer);
    if (index < 0) return;
    const radio = radios[index];
    if (!radio.checked) await clickLikeHuman(radio);
  }
  function isCheckboxChecked(input) {
    const button = input?.id ? document.getElementById(`CheckboxOuterID-${input.id}`) : null;
    if (button?.hasAttribute("aria-checked")) return button.getAttribute("aria-checked") === "true";
    return Boolean(input?.checked);
  }
  function setCheckbox(input, desired) {
    if (!input) return;
    if (isCheckboxChecked(input) !== desired) input.click(); // uiLib toggles on the hidden input's own click
  }
  // Click, then confirm the state held across the next few ticks (a
  // re-render can swallow the toggle).
  const CHECKBOX_REASSERT_DELAYS_MS = [60, 200, 500];
  async function commitCheckbox(input, desired) {
    if (!input) return;
    setCheckbox(input, desired);
    for (const delay of CHECKBOX_REASSERT_DELAYS_MS) {
      await sleep(delay);
      if (!input.isConnected || isCheckboxChecked(input) === desired) return;
      setCheckbox(input, desired);
    }
  }
  // Paycom blocks Submit while the acknowledgement is un-ticked and resets
  // it on later edits, so the submit click re-affirms it first.
  async function ensureAcknowledged() {
    const input = document.querySelector(`input[type="checkbox"][name="${ACKNOWLEDGEMENT_CHECKBOX_NAME}"]`);
    if (!input || isCheckboxChecked(input)) return;
    await commitCheckbox(input, true);
  }
  function fillDateRoot(root, answer) {
    const parts = parseFreeformDate(answer);
    const inputs = getDateParts(root);
    if (!parts || !inputs.month || !inputs.year) return;
    for (const [input, value] of [[inputs.month, parts.month], [inputs.day, parts.day], [inputs.year, parts.year]]) {
      if (!input) continue;
      fillTextInput(input, value);
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  function findCountryItem(modal, desired) {
    const wanted = normalizeComparisonText(desired);
    const items = Array.from(modal.querySelectorAll(COUNTRY_LIST_ITEM_SELECTOR)).filter(isElementVisible);
    if (!items.length || !wanted) return null;
    const texts = items.map((i) => normalizeComparisonText(i.textContent));
    let i = texts.findIndex((t) => t === wanted);
    if (i >= 0) return items[i];
    i = texts.findIndex((t) => t.startsWith(wanted));
    if (i >= 0) return items[i];
    i = texts.findIndex((t) => t.endsWith(wanted) || t.includes(wanted));
    return i >= 0 ? items[i] : null;
  }
  async function fillCountryPicker(host, answer) {
    const button = getCountryButton(host);
    const desired = normalizeCountryName(answer);
    if (!button || !desired) return;
    const current = readSelectedCountry(button);
    if (current && (normalizeComparisonText(current) === normalizeComparisonText(desired) || normalizeComparisonText(current).startsWith(normalizeComparisonText(desired)))) return;
    await clickLikeHuman(button);
    const modal = await waitFor(() => { const open = getOpenModal(); return getModalKind(open) === "country" ? open : null; }, MODAL_WAIT_MS, POLL_MS);
    if (!modal) return;
    const search = modal.querySelector(COUNTRY_SEARCH_SELECTOR);
    if (search) writeReactTextValue(search, desired);
    const item = await waitFor(() => findCountryItem(modal, desired), COUNTRY_ITEM_WAIT_MS, POLL_MS);
    if (item) {
      await clickLikeHuman(item);
      await waitForModalClosed();
      return;
    }
    // Nothing matched — leave the selection as it was and close the picker.
    const back = findModalButton(modal, /^back$|^close$|^cancel$/i);
    if (back) back.click();
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    await waitForModalClosed();
  }
  function findInstitutionSuggestion(name) {
    const wanted = normalizeComparisonText(name);
    const scored = Array.from(document.querySelectorAll(INSTITUTION_SUGGESTION_SELECTOR)).filter(isElementVisible)
      .map((item) => ({ item, school: normalizeComparisonText(cleanText(item.textContent).split("|")[0]) }))
      .filter((o) => o.school);
    return scored.find((o) => o.school === wanted)?.item || scored.find((o) => o.school.startsWith(wanted) || wanted.startsWith(o.school))?.item || null;
  }
  // The institution name is an autocomplete (the tenant's own suggestions
  // API, as you type); picking a suggestion pre-populates the row's
  // country/city/state. Type the school, take the matching suggestion when
  // one comes back, otherwise keep the typed text.
  async function fillInstitutionName(input, answer) {
    const name = cleanText(answer);
    if (!input || !name) return;
    writeReactTextValue(input, name);
    const suggestion = await waitFor(() => findInstitutionSuggestion(name), SUGGESTION_WAIT_MS, POLL_MS);
    if (suggestion) {
      await clickLikeHuman(suggestion);
      await sleep(300);
      if (!cleanText(input.value)) fillTextInput(input, name);
      return;
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur?.();
  }
  function dropzoneShowsFile(zone, fileName) {
    if (!zone) return false;
    const text = cleanText(zone.textContent);
    if (fileName && text.toLowerCase().includes(String(fileName).toLowerCase())) return true;
    if (zone.querySelector('[aria-label*="remove" i], [aria-label*="delete" i], [data-testid*="remove" i], [data-testid*="delete" i]')) return true;
    return !zone.querySelector('input[type="file"]') && !/upload a file/i.test(text);
  }
  function dismissResumeParseModal() {
    const modal = getOpenModal();
    if (getModalKind(modal) !== "resume-parse") return false;
    const decline = findModalButton(modal, /only attach|^no\b/i) || findModalButton(modal, /^cancel$|^close$/i);
    if (!decline) return false;
    decline.click();
    return true;
  }
  // Paycom posts the file to its upload store and re-renders the dropzone
  // with the file; a parse prompt ("use this resume/CV to fill out the
  // application?") may pop — decline it so the profile stays the source
  // of truth.
  async function fillDocumentDropzone(fieldId, field, answer) {
    const zone = liveDropzone(fieldId, field);
    const input = engine.getFileInputInsideField(zone);
    if (!input || !answer || typeof answer !== "object") return false;
    fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
    const deadline = Date.now() + UPLOAD_SETTLE_MS;
    while (Date.now() < deadline) {
      dismissResumeParseModal();
      if (dropzoneShowsFile(liveDropzone(fieldId, field), answer.fileName)) return true;
      await sleep(250);
    }
    return true;
  }

  /** Write `answer` into a detected field entry. 'file' expects
   *  {fileName, base64, mimeType}. 'checkbox'/'radio'/'select-native'
   *  entries with `fixedAnswer` set ignore the caller's answer — the
   *  acknowledgement is always ticked, WOTC opt-in is always declined. */
  async function fillField(entry, answer) {
    if (!entry) return false;
    const { fieldKind, field, fieldId } = entry;
    if (entry.fixedAnswer !== undefined) answer = entry.fixedAnswer;
    if (answer == null && fieldKind !== "middle-name") return false;
    switch (fieldKind) {
      case "text":
      case "textarea": {
        const input = liveControl(fieldId, field);
        if (!input) return false;
        fillTextInput(input, String(answer ?? ""));
        return true;
      }
      case "phone": {
        const input = liveControl(fieldId, field);
        const digits = normalizePhoneDigits(answer);
        if (!input || !digits) return false;
        fillTextInput(input, digits);
        return true;
      }
      case "select-native":
        await fillNativeSelect(liveControl(fieldId, field), answer);
        return true;
      case "radio":
        await chooseRadio(getRadiosByName(fieldId), answer);
        return true;
      case "checkbox": {
        const input = liveControl(fieldId, field);
        if (input?.type !== "checkbox") return false;
        await commitCheckbox(input, isAffirmative(answer));
        return true;
      }
      case "middle-name": {
        const input = document.getElementById(MIDDLE_NAME_FIELD_ID);
        const optOut = document.querySelector(`input[type="checkbox"][name="${NO_MIDDLE_NAME_CHECKBOX_NAME}"]`);
        const text = answer === false ? "" : cleanText(answer);
        if (!text) { await commitCheckbox(optOut, true); return true; }
        await commitCheckbox(optOut, false);
        if (input) fillTextInput(input, text);
        return true;
      }
      case "confirm-email": {
        // Repeats whatever the signup email field currently holds, rather
        // than asking the caller for the same value twice.
        const emailInput = document.getElementById(SIGNUP_EMAIL_ID);
        const input = liveControl(fieldId, field);
        if (input && emailInput) fillTextInput(input, emailInput.value || String(answer ?? ""));
        return true;
      }
      case "date":
        fillDateRoot(liveControl(fieldId, field), answer);
        return true;
      case "country":
        await fillCountryPicker(liveControl(fieldId, field), answer);
        return true;
      case "institution":
        await fillInstitutionName(liveControl(fieldId, field), answer);
        return true;
      case "file":
        return fillDocumentDropzone(fieldId, field, answer);
      default:
        return false;
    }
  }

  // ---- submit / advance --------------------------------------------------

  function getApplyButton() {
    return Array.from(document.querySelectorAll(`${APPLY_BUTTON_SELECTOR}, button`)).filter((b) => isElementVisible(b) && !b.closest(".uiLibModal"))
      .find((b) => b.matches(APPLY_BUTTON_SELECTOR) || /^apply$/i.test(cleanText(b.textContent))) || null;
  }
  function getSubmitButton() {
    if (!isApplicationPage()) return null;
    return Array.from(document.querySelectorAll("button")).filter((b) => isElementVisible(b) && !b.closest(".uiLibModal"))
      .find((b) => /^submit( application)?$/i.test(cleanText(b.textContent))) || null;
  }
  const describeButton = (button) => (button ? { detected: true, label: cleanText(button.textContent) || button.getAttribute("aria-label") || "", disabled: Boolean(button.disabled || button.getAttribute("aria-disabled") === "true") } : { detected: false });
  function detectSubmitButton() { return describeButton(getSubmitButton()); }
  // The NON-final forward control for the current state (never the gated Submit).
  function getAdvanceControl() {
    const modal = getOpenModal();
    const kind = getModalKind(modal);
    if (kind === "start") return findModalButton(modal, /^apply manually$/i);
    if (kind === "signup") return modal.querySelector(SIGNUP_CONTINUE_SELECTOR);
    if (kind === "signin") return modal.querySelector(SIGNIN_SUBMIT_SELECTOR);
    if (kind === "resume-parse") return findModalButton(modal, /only attach|^no\b/i);
    if (modal) return null;
    if (isJobPage()) return getApplyButton();
    return null;
  }
  function isAutofillAvailable() {
    if (detectFields().length) return true;
    if (detectSubmitButton().detected) return true;
    return Boolean(getAdvanceControl());
  }

  // Visible server-side rejection inside the auth modal (or a page-level
  // alert). Client validation ("Field is required") never counts — only a
  // round-trip error changes the advancer's course.
  function readAuthError(modal) {
    const scopes = [modal, ...Array.from(document.querySelectorAll('[role="alert"], .uiLibSnackbar, [class*="Snackbar"]'))].filter(Boolean);
    const isErrorNode = (el) => /(^|[\s-])error([\s-]|$)/i.test(el.className || "") && !/noerror/i.test(el.className || "");
    const texts = scopes.flatMap((scope) =>
      Array.from(scope.querySelectorAll('[role="alert"], [class*="rror"]')).concat(scope.matches?.('[role="alert"]') ? [scope] : [])
        .filter((el) => el.matches('[role="alert"]') || isErrorNode(el)).filter(isElementVisible).map((el) => cleanText(textOf(el)))
        .filter((t) => t && !/required|invalid email|must match|do not match/i.test(t)));
    return texts[0] || null;
  }
  async function clickModalControl(selector) {
    const modal = getOpenModal();
    const control = modal?.querySelector(selector);
    if (!control || !isElementVisible(control)) return false;
    await clickLikeHuman(control);
    await sleep(300);
    return true;
  }
  // Escalate (switch sign-up <-> sign-in) at most once per loaded page.
  let authFallbackHref = null;
  function authFallbackUsed() { return authFallbackHref === window.location.href; }
  function markAuthFallbackUsed() { authFallbackHref = window.location.href; }
  async function advanceAuthModal(kind) {
    const modal = getOpenModal();
    const message = readAuthError(modal);
    if (kind === "signup" && message && /already|exist|registered|in use/i.test(message)) {
      if (!authFallbackUsed()) { markAuthFallbackUsed(); return clickModalControl(SIGNIN_LINK_SELECTOR); }
      console.warn("[proactive][paycom] sign-up says account exists — manual handling needed");
      return false;
    }
    if (kind === "signin" && message && /incorrect|invalid|unable|not match|does not|doesn't|failed|try again|locked|not found/i.test(message)) {
      if (!authFallbackUsed()) { markAuthFallbackUsed(); return clickModalControl(CREATE_ACCOUNT_LINK_SELECTOR); }
      console.warn("[proactive][paycom] sign-in failed — manual handling needed");
      return false;
    }
    return clickModalControl(kind === "signup" ? SIGNUP_CONTINUE_SELECTOR : SIGNIN_SUBMIT_SELECTOR);
  }
  /** Advance one step through posting -> account modal -> application ->
   *  submit. The "Start Application" prompt (Autofill with Resume/CV |
   *  Apply Manually) always takes "Apply Manually" so the profile, not
   *  Paycom's résumé parse, fills the form. Never clicks the final,
   *  gated Submit — use getSubmitButton()/clickSubmitButton() for that. */
  async function advance() {
    const modal = getOpenModal();
    const kind = getModalKind(modal);
    if (kind === "start") {
      const button = findModalButton(modal, /^apply manually$/i);
      if (!button) return false;
      await clickLikeHuman(button);
      await waitForModalClosed();
      return true;
    }
    if (kind === "resume-parse") return dismissResumeParseModal();
    if (kind === "signup" || kind === "signin") return advanceAuthModal(kind);
    if (modal) return false;
    if (isJobPage()) {
      const apply = getApplyButton();
      if (!apply) return false;
      // Posting -> account modal boundary. "Apply" reveals the "Getting
      // You Started" modal in place (or, for a signed-in candidate,
      // navigates straight to the application) — click, then report
      // false: the revealed step is a fresh detection with its own field
      // signature.
      await clickLikeHuman(apply);
      await waitFor(() => (getOpenModal() || isApplicationPage() ? true : null), APPLY_REVEAL_WAIT_MS, POLL_MS);
      return false;
    }
    return false;
  }
  /** Final submit: re-affirm the acknowledgement (Paycom resets it on any
   *  edit since it was last ticked), then click. */
  async function clickSubmitButton(button) {
    await ensureAcknowledged();
    await sleep(300);
    await clickLikeHuman(button);
  }

  // ---- repeatable Education / Employment sections --------------------------
  // Ported from BidHub's own Paycom section descriptors (confirmed against
  // BidHub's packages/job-parsers/content/platforms/paycom/autofill.js
  // createPaycomSection/EDUCATION_SECTION/EMPLOYMENT_SECTION — idKey literals
  // below are the real ones, not a guess), driven by the shared
  // engine/section-hierarchy.js. Effectively grow-only: Paycom's own
  // clearRows is a no-op-ish "uncheck a stale opt-out checkbox" (no real
  // per-row delete exists), so it's omitted entirely here — rows already on
  // the page are reused and new ones are only added, never cleared first.
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;

  function getPaycomRowSuffix(rowEl) {
    if (!rowEl) return null;
    const direct = rowEl.id && /-(\d+)$/.exec(rowEl.id);
    if (direct) return direct[1];
    const child = rowEl.querySelector?.("[id]");
    const match = child && /-(\d+)$/.exec(child.id || "");
    return match ? match[1] : null;
  }
  function getPaycomSectionAnchors(prefix) {
    return Array.from(document.querySelectorAll(`[id^="${cssEscape(prefix)}"]`))
      .map((element) => ({ element, index: Number((element.id.match(/-(\d+)$/) || [])[1]) }))
      .filter((entry) => Number.isInteger(entry.index) && entry.index >= 0)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.element);
  }
  // The row's own wrapper: the ancestor whose direct children carry exactly
  // one "# N" row-number heading — same walk BidHub's own findRowElement
  // uses — falling back to the nearest card/parent.
  function findPaycomRowElement(anchor) {
    if (!anchor) return null;
    let node = anchor.parentElement;
    while (node && node !== document.body) {
      const rowHeadings = Array.from(node.querySelectorAll("h3")).filter((h) => /#\s*\d+/.test(h.textContent || ""));
      if (rowHeadings.length === 1) return node;
      if (rowHeadings.length > 1) break;
      node = node.parentElement;
    }
    return anchor.closest(".uiLibBasicCard") || anchor.parentElement || anchor;
  }
  function findPaycomSectionContainer(firstFieldPrefix, addButtonPattern) {
    const anchor = document.querySelector(`[id^="${cssEscape(firstFieldPrefix)}"]`);
    if (anchor) return anchor.closest('[id$="-section"]') || anchor.closest(".uiLibBasicCard")?.parentElement || document.body;
    // No row on the page yet — fall back to the "Add X" button's own
    // section ancestor so addRow() still has somewhere to click from.
    const addButton = addButtonPattern && Array.from(document.querySelectorAll("button")).find((b) => addButtonPattern.test(cleanText(b.textContent)));
    return addButton ? addButton.closest('[id$="-section"]') || addButton.parentElement : null;
  }
  // Deterministic per-row id: `${sectionPrefix}-${mapping.idKey}-field-${suffix}`.
  // A radio-backed mapping (graduated/currentEmployer — real Paycom controls,
  // confirmed against BidHub's own controlKind: 'radio') resolves by
  // `input[type="radio"][name="<id>"]` instead, since no single element
  // carries that id.
  function getPaycomRowField(sectionPrefix, rowEl, mapping) {
    const suffix = getPaycomRowSuffix(rowEl);
    if (!suffix) return null;
    const id = `${sectionPrefix}-${mapping.idKey}-field-${suffix}`;
    if (mapping.fieldKind === "radio") {
      const radio = document.querySelector(`input[type="radio"][name="${cssEscape(id)}"]`);
      if (!radio) return null;
      return { field: radio.closest('[role="radiogroup"]') || radio };
    }
    const control = document.getElementById(id);
    if (!control) return null;
    return { field: control };
  }

  const PAYCOM_EDUCATION_SECTION = {
    rootFieldId: "educationHistory",
    rootQuestion: "Education",
    profileSection: "education",
    rowLabel: (i) => `Education ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: () => findPaycomSectionContainer("education-institution-type-field-", /^add institution$/i),
    getRows: () => getPaycomSectionAnchors("education-institution-type-field-").map(findPaycomRowElement),
    getRowField: (rowEl, mapping) => getPaycomRowField("education", rowEl, mapping),
    addRow: async (container) => {
      const button = Array.from((container || document).querySelectorAll("button")).find((b) => /^add institution$/i.test((b.textContent || "").trim()));
      if (button) await clickLikeHuman(button);
    },
    // No clearRows — see file-top comment; grow-only for this port.
    // `major` has no BCD equivalent (Profile.education is school/degree/
    // start/end only) — still detects (visible/editable), never auto-filled.
    mappings: [
      { key: "institutionName", idKey: "institution-name", fieldKind: "institution", question: "Institution Name", label: "Institution Name", profileKey: "school" },
      { key: "degree", idKey: "degree", fieldKind: "dropdown", question: "Degree", label: "Degree", profileKey: "degree" },
      { key: "major", idKey: "major", fieldKind: "text", question: "Major", label: "Major" },
      { key: "startDate", idKey: "start-date", fieldKind: "date", question: "Start Date", label: "Start Date", profileKey: "start" },
      { key: "endDate", idKey: "end-date", fieldKind: "date", question: "End Date", label: "End Date", resolveValue: (e) => (cleanText(e?.end).trim() ? e.end : null) },
      { key: "graduated", idKey: "graduated", fieldKind: "radio", question: "Graduated", label: "Graduated", resolveValue: (e) => (cleanText(e?.end).trim() ? "Yes" : "No") },
    ],
  };
  const PAYCOM_EMPLOYMENT_SECTION = {
    rootFieldId: "workHistory",
    rootQuestion: "Employment",
    profileSection: "experience",
    rowLabel: (i) => `Employment ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: () => findPaycomSectionContainer("employment-employer-name-field-", /^add employer$/i),
    getRows: () => getPaycomSectionAnchors("employment-employer-name-field-").map(findPaycomRowElement),
    getRowField: (rowEl, mapping) => getPaycomRowField("employment", rowEl, mapping),
    addRow: async (container) => {
      const button = Array.from((container || document).querySelectorAll("button")).find((b) => /^add employer$/i.test((b.textContent || "").trim()));
      if (button) await clickLikeHuman(button);
    },
    // No clearRows — grow-only for this port (see file-top comment).
    mappings: [
      { key: "employerName", idKey: "employer-name", fieldKind: "text", question: "Employer Name", label: "Employer Name", profileKey: "company" },
      { key: "jobTitle", idKey: "job-title", fieldKind: "text", question: "Job Title", label: "Job Title", profileKey: "role" },
      { key: "city", idKey: "city", fieldKind: "text", question: "City", label: "City", profileKey: "location" },
      { key: "startDate", idKey: "start-date", fieldKind: "date", question: "Start Date", label: "Start Date", profileKey: "start" },
      { key: "endDate", idKey: "end-date", fieldKind: "date", question: "End Date", label: "End Date", resolveValue: (e) => (cleanText(e?.end).trim() ? e.end : null) },
      { key: "currentEmployer", idKey: "current-employer", fieldKind: "radio", question: "Current Employer", label: "Current Employer", resolveValue: (e) => (cleanText(e?.end).trim() ? "No" : "Yes") },
    ],
  };

  const SECTIONS = [PAYCOM_EDUCATION_SECTION, PAYCOM_EMPLOYMENT_SECTION];

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections(SECTIONS, profileData);
  }

  // Reuses this file's OWN existing per-widget fill helpers (fillNativeSelect,
  // fillDateRoot, chooseRadio via getRadioInputs, fillInstitutionName) rather
  // than reimplementing them — same widgets the generic single-row scan
  // above already knows how to drive.
  async function fillSectionLeaf(field, mapping, value) {
    switch (mapping.fieldKind) {
      case "text":
        await engine.fillTextInputReliably(field, String(value ?? ""));
        return;
      case "institution":
        await fillInstitutionName(field, value);
        return;
      case "dropdown": {
        if (field.tagName === "SELECT") {
          await fillNativeSelect(field, value);
          return;
        }
        // Not a native <select> on this tenant's build — fall back to a
        // plain text commit rather than guessing at a custom widget.
        fillTextInput(field, String(value ?? ""));
        return;
      }
      case "date":
        fillDateRoot(field, value);
        return;
      case "radio": {
        const radios = getRadioInputs(field);
        await chooseRadio(radios, value);
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

  NS.paycom = {
    isAutofillAvailable,
    detectFields,
    fillField,
    getSubmitButton,
    detectSubmitButton,
    clickSubmitButton,
    advance,
    detectSections,
    fillSections,
  };
})();
