/* =====================================================================
 * autofill/sites/teamtailor-autofill.js — Teamtailor application forms
 * (<tenant>.teamtailor.com/jobs/<id>/<slug>/apply or inline on the
 * posting page itself — Teamtailor renders the whole application INSIDE
 * a `turbo-frame#application_form` that gets swapped in when the
 * visitor clicks "Apply"/"Apply for this job").
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/teamtailor/autofill.js.
 *
 * Structurally, Teamtailor's own application form is a SINGLE page, not
 * a multi-step wizard: there is no in-form "Next"/"Continue" between
 * field groups, just one `#job-application-form` with every field and
 * one final Submit button. The only "advance" this file ever has to do
 * is the posting -> form reveal (clicking "Apply"/"Apply for this job",
 * which Turbo swaps the real form into `turbo-frame#application_form`).
 *
 * Field kinds BidHub's own detector distinguishes (all Rails-rendered,
 * each driven by its own `data-controller="forms--inputs--..."`
 * Stimulus controller rather than a plain <select>/<input> convention):
 *   - plain text / textarea (name, email, free-text questions)
 *   - phone — an intl-tel-input widget (`.iti`), not a bare <input tel>
 *   - date — a text input whose placeholder/pattern/aria-label advertise
 *     a date format (MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD, MM/YYYY, YYYY)
 *   - location — a Stimulus "forms--inputs--location" typeahead combobox
 *     (types an address, picks the first geocoded suggestion, which
 *     populates hidden place_id/city/... inputs — never submits what was
 *     typed directly)
 *   - native <select>
 *   - radio / checkbox groups — rendered in a <fieldset>, and EITHER as
 *     plain visible boxes OR, for a tenant that turned on
 *     `data-forms--inputs--choice-show-as-dropdown-value="true"`, as a
 *     closed dropdown button + portal'd menu (selecting then means
 *     opening that menu and clicking the right `[data-value]` item, not
 *     clicking a hidden input)
 *   - resume — a file input with the FIXED, tenant-independent id
 *     `candidate_resume_remote_url` (see also the existing simple
 *     handlers/adapters/teamtailor.js adapter, which already grabs this
 *     same id + the cover-letter file's id for Big Banana's generic
 *     pipeline — ported here too for this module's own fill() to use)
 *   - cover letter — Teamtailor offers this as a FREE-TEXT textarea
 *     (an alternative to attaching a file); the fixed-id file input
 *     (`candidate_job_applications_attributes_0_cover_letter`) is a
 *     SEPARATE slot, handled the same deterministic way as resume
 *
 * Explicitly NOT ported (BidHub's own AI-answer backend / CAPTCHA /
 * proxy automation):
 *   - getAnswer(...)/getCoverLetterForAutofill()/getResumeForAutofill() —
 *     BidHub's backend calls that generate free-text screening-question
 *     answers and cover-letter copy. Big Banana's own existing generic
 *     pipeline already answers ordinary screening questions on its own;
 *     this file only hands it accurate field structure (detectFields)
 *     and a value-driven fill() — it never calls out to an AI backend.
 *   - getEmbeddingMatch(...) — BidHub's last-resort "fuzzy match this
 *     answer to one of these options" backend call used inside its own
 *     getBestMatchingOption(). This file's own getBestMatchingOption only
 *     does the exact/substring match that comes BEFORE that backend
 *     call — a select/radio/checkbox option that doesn't match even
 *     loosely is left unfilled for the generic pipeline to try.
 *   - reCAPTCHA / proxy / remote-CDP automation — Teamtailor's form
 *     carries none of BidHub's own captcha-handling hooks in the first
 *     place, so there was nothing to port here.
 * ===================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofillEngine) return;
  const dom = window.ProactiveAutofillEngine;
  const {
    sleep, fillTextInput, fillTextInputWithoutBlur, fillFileInput, fillSelectInput,
    clickLikeHuman, getCheckboxInputs, getRadioInputs, getTextarea, getTextInput,
    getFileInputInsideField,
  } = dom;

  // ---- constants ---------------------------------------------------------

  const FORM_SELECTOR = "#job-application-form";
  const APPLICATION_FRAME_SELECTOR = "turbo-frame#application_form";
  const APPLY_BUTTON_PATTERN = /^\s*apply(?:\s+for\s+this\s+job)?\s*$/i;
  // BidHub's own detector deliberately skips this slot too — an "Additional
  // files" upload accepts an arbitrary, open-ended set of attachments with
  // no fixed shape to fill reliably, so it's left for a human.
  const UNSUPPORTED_FILE_QUESTION_PATTERN = /\badditional\s+files?\b/i;
  const LOCATION_INPUT_SELECTOR =
    'input[data-forms--inputs--location-target="input"], input[role="combobox"][aria-controls$="-location-listbox"]';
  const LOCATION_AUTOCOMPLETE_TIMEOUT_MS = 5000;
  // Fixed, tenant-independent ids straight off the underlying
  // candidate/application record — see handlers/adapters/teamtailor.js for
  // the same ids used by Big Banana's existing generic pipeline.
  const RESUME_FILE_ID = "candidate_resume_remote_url";
  const COVER_LETTER_FILE_ID = "candidate_job_applications_attributes_0_cover_letter";
  const REQUIRED_MARKERS = /[✱*]/g;
  const TEXT_INPUT_SELECTOR = [
    'input[type="text"]', 'input[type="email"]', 'input[type="tel"]',
    'input[type="url"]', 'input[type="number"]', 'input[type="date"]',
    "input:not([type])",
  ].join(", ");

  // ---- text / label normalization ----------------------------------------

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(REQUIRED_MARKERS, " ")
      .replace(/\bRequired\.?\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function normalizeComparisonText(value) {
    return normalizeText(value).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }
  function slugifyFieldId(value) {
    return normalizeComparisonText(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }
  function escapeAttributeValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // A control can be display:none'd WITHOUT being unavailable: a file
  // input is only ever allowed to be styled invisible (its own "Choose
  // file" button sits on top of it), and a radio/checkbox whose real
  // <label> IS visible (just the native box itself hidden behind custom
  // styling) is still a field a person could pick.
  function isVisible(element, { allowHiddenFileInput = false, allowHiddenChoiceInput = false } = {}) {
    if (!element?.isConnected) return false;
    if (allowHiddenFileInput && element.matches?.('input[type="file"]')) return true;
    if (allowHiddenChoiceInput && element.matches?.('input[type="radio"], input[type="checkbox"]')) {
      const label = getChoiceInputLabelElement(element);
      if (label && isVisible(label)) return true;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
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

  // ---- form / frame lookup ------------------------------------------------

  function getForm() {
    return document.querySelector(FORM_SELECTOR);
  }
  function getApplicationFrame() {
    return document.querySelector(APPLICATION_FRAME_SELECTOR);
  }
  function getActionLabel(element) {
    return normalizeText(element?.textContent || element?.value || element?.getAttribute?.("aria-label") || "");
  }

  // ---- label resolution ---------------------------------------------------

  function getChoiceInputLabelElement(input) {
    if (!input) return null;
    if (input.id) {
      const explicit = document.querySelector(`label[for="${escapeAttributeValue(input.id)}"]`);
      if (explicit) return explicit;
    }
    return input.closest("label");
  }
  function getChoiceInputLabelText(input, fallback = "") {
    if (!input) return fallback;
    return normalizeText(
      getChoiceInputLabelElement(input)?.textContent || input.getAttribute?.("aria-label") || input.value || fallback
    );
  }

  // The label for a whole field wrapper (fieldset/legend for a radio or
  // checkbox GROUP, a plain <label> for everything else). Teamtailor's own
  // fieldset legend wraps its visible text in `span.block` (the rest of the
  // legend is a visually-hidden "Required" marker) — try that first so the
  // sr-only text doesn't leak into the question string.
  function getFieldQuestion(field, control = null) {
    if (!field && !control) return "";
    const legendText = normalizeText(
      field?.querySelector?.("legend span.block")?.textContent || field?.querySelector?.("legend")?.textContent
    );
    if (legendText) return legendText;
    const explicitLabelText = Array.from(control?.labels ?? []).map((l) => normalizeText(l.textContent)).find(Boolean);
    if (explicitLabelText) return explicitLabelText;
    if (control?.id) {
      const linkedLabel =
        field?.querySelector?.(`label[for="${escapeAttributeValue(control.id)}"]`) ||
        document.querySelector(`label[for="${escapeAttributeValue(control.id)}"]`);
      const linkedText = normalizeText(linkedLabel?.textContent);
      if (linkedText) return linkedText;
    }
    const ariaLabel = normalizeText(control?.getAttribute?.("aria-label"));
    if (ariaLabel) return ariaLabel;
    return normalizeText(field?.querySelector?.('label, [class*="label"], [class*="question"]')?.textContent);
  }

  // The field "wrapper" a control lives in — what carries its label and
  // (for a choice group) its sibling inputs.
  function getFieldWrapper(control) {
    if (!control) return null;
    if (control.type === "file") {
      return (
        control.closest('[data-controller~="forms--inputs--upload"]') ||
        control.closest("#upload_resume_field, #upload_file_field") ||
        control.closest("div, section, fieldset") ||
        control
      );
    }
    if (control.type === "checkbox" || control.type === "radio") {
      return control.closest('fieldset, [role="group"]') || control.closest("label") || control;
    }
    return control.closest('fieldset, [data-controller~="forms--inputs--text"], [id^="id_"], label, div') || control;
  }

  // ---- choice (radio/checkbox) groups --------------------------------

  // Classify a <fieldset>'s own group of inputs: radio takes priority over
  // checkbox (a fieldset never mixes the two); a SINGLE checkbox (no
  // sibling) is really a standalone yes/no toggle, not a multi-select
  // group — flagged distinctly so fill() treats it as one.
  function getChoiceGroupInputs(fieldset) {
    const radios = Array.from(fieldset.querySelectorAll('input[type="radio"]')).filter((i) => !i.disabled);
    if (radios.length > 0) return { inputs: radios, fieldKind: "radio" };
    const checkboxes = Array.from(fieldset.querySelectorAll('input[type="checkbox"]')).filter((i) => !i.disabled);
    if (checkboxes.length > 0) {
      return { inputs: checkboxes, fieldKind: checkboxes.length === 1 ? "checkbox-single" : "checkbox" };
    }
    return null;
  }

  // Some tenants render a choice group as a CLOSED dropdown button + a
  // portal'd menu (`data-forms--inputs--choice-show-as-dropdown-value`)
  // instead of visible boxes — selecting there means opening that menu and
  // clicking the matching `[data-value]` item; the underlying <input> is
  // just a hidden state mirror the dropdown writes to, not something a
  // click/label click can drive on its own.
  function getChoiceDropdownContainer(field) {
    return field?.querySelector?.(
      '[data-controller~="forms--inputs--choice"][data-forms--inputs--choice-show-as-dropdown-value="true"]'
    ) ?? null;
  }
  function getDropdownMenuItemForChoiceInput(field, input) {
    if (!field || !input?.value) return null;
    const value = escapeAttributeValue(input.value);
    return field.querySelector(
      `[data-common--dropdown-target="menuItem"][data-value="${value}"], [role="menuitem"][data-value="${value}"]`
    );
  }
  async function selectChoiceInputViaDropdown(field, input, shouldCheck) {
    const dropdownContainer = getChoiceDropdownContainer(field);
    if (!dropdownContainer) return false;
    const menuItem = getDropdownMenuItemForChoiceInput(field, input);
    if (!menuItem) return false;
    if (input.type === "checkbox" && input.checked === shouldCheck) return true;
    const dropdownRoot = menuItem.closest('[data-controller~="common--dropdown"]') || dropdownContainer;
    const dropdownButton = dropdownRoot.querySelector('[data-common--dropdown-target="button"], button[role="button"], button');
    if (!isVisible(menuItem) && dropdownButton) {
      dropdownButton.click();
      await sleep(100);
    }
    menuItem.scrollIntoView({ block: "nearest", inline: "nearest" });
    menuItem.click();
    await sleep(75);
    return true;
  }
  // Check/uncheck a radio or checkbox, going through the dropdown widget
  // first (when the field uses one) and falling back to a plain
  // label/input click otherwise.
  async function setChoiceInput(input, shouldCheck, field = null) {
    if (!input) return;
    if (field && (input.checked !== shouldCheck || (input.type === "radio" && shouldCheck))) {
      if (await selectChoiceInputViaDropdown(field, input, shouldCheck)) return;
    }
    if (input.checked === shouldCheck) return;
    const label = getChoiceInputLabelElement(input);
    if (label && isVisible(label)) await clickLikeHuman(label);
    else await clickLikeHuman(input);
    if (input.checked !== shouldCheck) {
      input.checked = shouldCheck;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // ---- phone (intl-tel-input widget) -------------------------------------

  function isPhoneControl(control) {
    if (!control?.matches?.('input[type="tel"]')) return false;
    return Boolean(control.closest('[data-controller~="phone-input"]') || control.closest(".iti"));
  }
  function getPhoneInput(field) {
    if (!field) return null;
    if (field.matches?.('input[type="tel"]')) return field;
    return field.querySelector?.('input[type="tel"]') ?? null;
  }
  // intl-tel-input renders its own country dropdown list in the DOM
  // (`.iti__country-list`) keyed by country NAME, not ISO code — resolve a
  // profile country name to its dial code by reading that list rather than
  // hardcoding a country->code table.
  function getPhoneDialCodeForCountry(countryName) {
    const target = normalizeComparisonText(countryName);
    if (!target) return null;
    const items = document.querySelectorAll('[id$="__country-listbox"] li[data-country-code], .iti__country-list li[data-country-code]');
    for (const item of items) {
      const name = normalizeComparisonText(item.querySelector(".iti__country-name")?.textContent);
      if (name && name === target) {
        const dial = item.getAttribute("data-dial-code");
        if (dial) return `+${String(dial).replace(/^\+/, "")}`;
      }
    }
    return null;
  }
  // intl-tel-input keeps a leading "+<code>" in the input and switches the
  // flag to match, so prefixing the dial code is enough — no separate
  // "select country" step needed.
  function buildInternationalPhone(number, dialCode) {
    const raw = String(number ?? "").trim();
    if (!raw || raw.startsWith("+") || !dialCode) return raw;
    const national = raw.replace(/^0+(?=\d)/, "");
    return `${dialCode} ${national}`;
  }

  // ---- location (Stimulus typeahead) -------------------------------------

  function isLocationAutocompleteControl(control) {
    return Boolean(control?.matches?.(LOCATION_INPUT_SELECTOR));
  }
  function getLocationAutocompleteInput(field) {
    if (!field) return null;
    if (isLocationAutocompleteControl(field)) return field;
    return field.querySelector?.(LOCATION_INPUT_SELECTOR) ?? null;
  }
  function getLocationSuggestionOptions(input) {
    const listboxId = input?.getAttribute?.("aria-controls");
    const listbox = listboxId ? document.getElementById(listboxId) : null;
    const scope = listbox || input?.closest?.('[data-controller~="forms--inputs--location"]');
    if (!scope) return [];
    return Array.from(scope.querySelectorAll('[role="option"]')).filter(isVisible);
  }
  // Types the address so the location controller's geocoder fetches
  // suggestions, then clicks the FIRST one — Teamtailor never submits
  // whatever text was typed directly, only what `selectSuggestion`
  // populates into the hidden place_id/address/city/... inputs once a
  // suggestion is clicked. A deliberate no-blur write (fillTextInputWithoutBlur):
  // blurring before a suggestion is picked discards the typed text and
  // those hidden fields stay empty.
  async function fillLocationAutocomplete(field, value) {
    const input = getLocationAutocompleteInput(field);
    const text = String(value ?? "").trim();
    if (!input || !text) return false;
    fillTextInputWithoutBlur(input, text);
    const options = await waitFor(() => {
      const found = getLocationSuggestionOptions(input);
      return found.length ? found : null;
    }, LOCATION_AUTOCOMPLETE_TIMEOUT_MS, 100);
    if (!options) {
      input.dispatchEvent(new Event("blur", { bubbles: true }));
      return false;
    }
    const firstOption = options[0];
    firstOption.scrollIntoView({ block: "nearest", inline: "nearest" });
    firstOption.click();
    await sleep(150);
    return true;
  }

  // ---- date format inference + formatting --------------------------------

  function normalizeDateFormatToken(value) {
    const normalized = normalizeText(value).toUpperCase().replace(/\s+/g, "");
    if (!normalized) return null;
    if (/^MM[/-]DD[/-](?:YYYY|YY)$/.test(normalized)) return "MM/DD/YYYY";
    if (/^DD[/-]MM[/-](?:YYYY|YY)$/.test(normalized)) return "DD/MM/YYYY";
    if (/^(?:YYYY|YY)[/-]MM[/-]DD$/.test(normalized)) return "YYYY-MM-DD";
    if (/^MM[/-](?:YYYY|YY)$/.test(normalized)) return "MM/YYYY";
    if (/^(?:YYYY|YY)$/.test(normalized)) return "YYYY";
    return null;
  }
  // A text input is a date field when its own type/placeholder/aria-label
  // advertises one of Teamtailor's date shapes — there's no dedicated
  // fieldKind in the markup itself to key off of otherwise.
  function inferDateFormat(question, control) {
    if (!control) return null;
    if (control.type === "date") return "YYYY-MM-DD";
    const placeholderFormat = normalizeDateFormatToken(control.getAttribute?.("placeholder"));
    if (placeholderFormat) return placeholderFormat;
    const ariaFormat = normalizeDateFormatToken(control.getAttribute?.("aria-label"));
    if (ariaFormat) return ariaFormat;
    const pattern = control.getAttribute?.("pattern");
    if (pattern) {
      const normalizedPattern = String(pattern).replace(/\\/g, "").toLowerCase();
      if (/(?:d\{4\}|\[0-9\]\{4\}).{0,8}(?:d\{1,2\}|\[0-9\]\{1,2\}).{0,8}(?:d\{1,2\}|\[0-9\]\{1,2\})/.test(normalizedPattern)) {
        return "YYYY-MM-DD";
      }
    }
    if (/\b(date|available|start working|start work)\b/i.test(question || "") && control.getAttribute?.("inputmode") === "numeric") {
      return "MM/DD/YYYY";
    }
    return null;
  }

  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  function padDatePart(value) {
    return String(value ?? "").padStart(2, "0");
  }
  function getMonthNumberFromName(value) {
    const normalized = normalizeComparisonText(value);
    if (!normalized) return null;
    const monthIndex = MONTH_NAMES.findIndex((m) => m.toLowerCase().startsWith(normalized));
    return monthIndex >= 0 ? padDatePart(monthIndex + 1) : null;
  }
  function normalizeYear(value) {
    const year = String(value ?? "").trim();
    return /^\d{2}$/.test(year) ? `20${year}` : year;
  }
  function toCanonicalDate(year, month = "01", day = "01") {
    const normalizedYear = normalizeYear(year);
    const normalizedMonth = padDatePart(month);
    const normalizedDay = padDatePart(day);
    const y = Number(normalizedYear), m = Number(normalizedMonth), d = Number(normalizedDay);
    if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const date = new Date(y, m - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
    return `${normalizedYear}-${normalizedMonth}-${normalizedDay}`;
  }
  // Loosely parses whatever shape a profile stores a date in ("2021",
  // "March 2021", "03/2021", "2021-03-15", ...) down to {year, month, day}
  // (month/day optional) — used as the last-resort path when the answer
  // isn't already in one of the exact shapes canonicalDateFromValue knows.
  function parseLooseProfileDate(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return { month: null, day: null, year: null };
    const isoMatch = raw.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?(?:T.*)?$/);
    if (isoMatch) return { year: isoMatch[1], month: padDatePart(isoMatch[2]) || null, day: padDatePart(isoMatch[3]) || null };
    const slashMatch = raw.match(/^(\d{1,2})[/-](\d{4})$/);
    if (slashMatch) return { year: slashMatch[2], month: padDatePart(slashMatch[1]), day: null };
    const nameMatch = raw.match(/^([A-Za-z]+)\s+(?:(\d{1,2}),?\s+)?(\d{4})$/);
    if (nameMatch) return { year: nameMatch[3], month: getMonthNumberFromName(nameMatch[1]), day: padDatePart(nameMatch[2]) || null };
    if (/^\d{4}$/.test(raw)) return { year: raw, month: null, day: null };
    return { month: null, day: null, year: null };
  }
  function canonicalDateFromValue(value, format = "MM/DD/YYYY") {
    const raw = String(value ?? "").trim();
    if (!raw) return null;
    const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/);
    if (isoMatch) return toCanonicalDate(isoMatch[1], isoMatch[2], isoMatch[3]);
    const slashMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (slashMatch) {
      const [, first, second, year] = slashMatch;
      const [month, day] = format === "DD/MM/YYYY" ? [second, first] : [first, second];
      return toCanonicalDate(year, month, day);
    }
    const namedMonthFirst = raw.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
    if (namedMonthFirst) {
      const month = getMonthNumberFromName(namedMonthFirst[1]);
      return month ? toCanonicalDate(namedMonthFirst[3], month, namedMonthFirst[2]) : null;
    }
    const namedDayFirst = raw.match(/^(\d{1,2})\s+([A-Za-z]+),?\s+(\d{4})$/);
    if (namedDayFirst) {
      const month = getMonthNumberFromName(namedDayFirst[2]);
      return month ? toCanonicalDate(namedDayFirst[3], month, namedDayFirst[1]) : null;
    }
    return null;
  }
  function clampCanonicalDateToConstraints(canonicalDate, { min, max } = {}) {
    if (!canonicalDate) return canonicalDate;
    const minDate = canonicalDateFromValue(min);
    if (minDate && canonicalDate < minDate) return minDate;
    const maxDate = canonicalDateFromValue(max);
    if (maxDate && canonicalDate > maxDate) return maxDate;
    return canonicalDate;
  }
  function formatCanonicalDate(canonicalDate, format) {
    if (!canonicalDate) return "";
    const [year, month, day] = canonicalDate.split("-");
    switch (format) {
      case "YYYY-MM-DD": return canonicalDate;
      case "MM/DD/YYYY": return `${month}/${day}/${year}`;
      case "DD/MM/YYYY": return `${day}/${month}/${year}`;
      case "MM/YYYY": return `${month}/${year}`;
      case "YYYY": return year;
      default: return canonicalDate;
    }
  }
  // answer -> the exact string shape this specific date field expects.
  // `today`/`asap`/... maps to the actual current date (clamped to the
  // field's own min/max, if it declares any) rather than being left as
  // literal text a Rails date-parser would reject.
  function formatDateAnswer(answer, format, constraints = {}) {
    const raw = String(answer ?? "").trim();
    if (!raw || !format) return raw;
    if (/\b(?:asap|as soon as possible|immediate(?:ly)?|now|today)\b/i.test(raw)) {
      const today = new Date();
      return formatCanonicalDate(clampCanonicalDateToConstraints(toCanonicalDate(today.getFullYear(), today.getMonth() + 1, today.getDate()), constraints), format);
    }
    const canonical = canonicalDateFromValue(raw, format);
    if (canonical) return formatCanonicalDate(clampCanonicalDateToConstraints(canonical, constraints), format);
    const loose = parseLooseProfileDate(raw);
    if (loose.year) return formatCanonicalDate(clampCanonicalDateToConstraints(toCanonicalDate(loose.year, loose.month || "01", loose.day || "01"), constraints), format);
    return raw;
  }

  // ---- resume / cover-letter file slots -----------------------------------

  function isResumeUpload(question, control) {
    return control?.type === "file" && (control.id === RESUME_FILE_ID || /\b(resume|cv)\b/i.test(`${question} ${control.accept ?? ""}`));
  }
  function isCoverLetterFileUpload(control) {
    return control?.type === "file" && control.id === COVER_LETTER_FILE_ID;
  }
  // The free-text cover-letter TEXTAREA Teamtailor offers as an
  // alternative to attaching a file — matched by label text or input name,
  // distinct from the fixed-id file upload above.
  function isCoverLetterTextField(question, control) {
    return /cover\s*letter/i.test(question) || /cover_letter/i.test(control?.name || "");
  }

  // ---- field enumeration ---------------------------------------------------

  function deriveFieldId(question, control, fallback) {
    return slugifyFieldId([question, control?.name, control?.id, fallback].filter(Boolean).join(" ")) || fallback;
  }
  function ensureUniqueFieldId(base, usedIds) {
    let candidate = base || "teamtailor_field";
    let suffix = 2;
    while (usedIds.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    usedIds.add(candidate);
    return candidate;
  }

  function isUnsupportedControl(control, detectedChoiceGroups) {
    if (!control || control.disabled) return true;
    if (["hidden", "submit", "button"].includes(control.type)) return true;
    // intl-tel-input's own little "search a country" box inside its
    // dropdown — not a real form field.
    if (control.type === "search" && (/^iti-\d+__search-input$/.test(control.id || "") || control.closest?.(".iti__dropdown-content"))) return true;
    if ((control.type === "radio" || control.type === "checkbox") && Array.from(detectedChoiceGroups).some((f) => f.contains(control))) return true;
    if (!control.id && !control.name && !Array.from(control.labels ?? []).length) return true;
    return false;
  }

  /** Enumerate every fillable field on the CURRENT view of the Teamtailor
   *  application form: {question, fieldId, fieldKind, field, control,
   *  options}. `options` carries each choice's label text for
   *  radio/checkbox/select; `control` is null for the two fixed-id file
   *  slots when Teamtailor has already unmounted their native input (a
   *  file already attached collapses the input into a "remove" chip). */
  function detectFields() {
    const form = getForm();
    if (!form) return [];
    const fields = [];
    const usedFieldIds = new Set();
    const detectedChoiceGroups = new Set();

    const addField = (entry) => {
      if (!entry.question || !entry.field || !entry.fieldKind) return;
      fields.push({ ...entry, fieldId: ensureUniqueFieldId(entry.fieldId, usedFieldIds) });
    };

    // Radio/checkbox groups first (keyed by <fieldset>) so the per-control
    // pass below can skip every input already accounted for here.
    for (const fieldset of form.querySelectorAll("fieldset")) {
      const group = getChoiceGroupInputs(fieldset);
      if (!group) continue;
      const question = getFieldQuestion(fieldset, group.inputs[0]);
      const options = group.inputs.map((input) => getChoiceInputLabelText(input, question)).filter(Boolean);
      if (!question || options.length === 0) continue;
      detectedChoiceGroups.add(fieldset);
      addField({
        question,
        fieldId: deriveFieldId(question, group.inputs[0], group.fieldKind),
        field: fieldset,
        control: group.inputs[0],
        fieldKind: group.fieldKind,
        // A lone checkbox has no sibling to read a real label from — it IS
        // the yes/no choice itself.
        options: group.fieldKind === "checkbox-single" ? ["Yes", "No"] : options,
      });
    }

    for (const control of form.querySelectorAll('input:not([type="hidden"]), textarea, select')) {
      if (isUnsupportedControl(control, detectedChoiceGroups)) continue;
      if (!isVisible(control, { allowHiddenFileInput: true, allowHiddenChoiceInput: true })) continue;
      const field = getFieldWrapper(control);
      const question = getFieldQuestion(field, control);
      if (!question || !field) continue;

      if (control.type === "file") {
        // Only the two fixed-id slots are structurally supported — an
        // "Additional files" upload (or any other stray file input) is
        // left untouched (see UNSUPPORTED_FILE_QUESTION_PATTERN).
        if (isResumeUpload(question, control) && !UNSUPPORTED_FILE_QUESTION_PATTERN.test(question)) {
          addField({ question, fieldId: "resume", field, control, fieldKind: "resume", options: [] });
        } else if (isCoverLetterFileUpload(control)) {
          addField({ question, fieldId: "cover_letter_file", field, control, fieldKind: "cover_letter_file", options: [] });
        }
        continue;
      }
      if (control.type === "checkbox") {
        addField({ question, fieldId: deriveFieldId(question, control, "checkbox"), field, control, fieldKind: "checkbox-single", options: ["Yes", "No"] });
        continue;
      }
      if (control.tagName === "SELECT") {
        const options = Array.from(control.querySelectorAll("option")).map((o) => normalizeText(o.textContent)).filter(Boolean);
        addField({ question, fieldId: deriveFieldId(question, control, "select"), field, control, fieldKind: "select", options });
        continue;
      }
      // Checked before the generic textarea case below: a free-text cover
      // letter box is still a <textarea>, but needs its own fieldKind so
      // fill() can route a `cover_letter` profile value to it specifically
      // rather than treating it as an arbitrary screening question.
      if (control.tagName === "TEXTAREA" && isCoverLetterTextField(question, control)) {
        addField({ question, fieldId: "cover_letter", field, control, fieldKind: "cover_letter", options: [] });
        continue;
      }
      if (control.tagName === "TEXTAREA") {
        addField({ question, fieldId: deriveFieldId(question, control, "textarea"), field, control, fieldKind: "textarea", options: [] });
        continue;
      }
      if (isPhoneControl(control)) {
        addField({ question, fieldId: deriveFieldId(question, control, "phone"), field, control, fieldKind: "phone", options: [] });
        continue;
      }
      if (isLocationAutocompleteControl(control)) {
        addField({ question, fieldId: deriveFieldId(question, control, "location"), field, control, fieldKind: "location", options: [] });
        continue;
      }
      const dateFormat = inferDateFormat(question, control);
      addField({
        question,
        fieldId: deriveFieldId(question, control, dateFormat ? "date" : "text"),
        field, control,
        fieldKind: dateFormat ? "date" : "text",
        options: [],
        dateFormat,
      });
    }

    // A fixed-id file slot whose native input Teamtailor has already
    // unmounted (file attached -> replaced by a "<name> [remove]" chip)
    // never shows up in the control loop above — surface it anyway so a
    // caller re-attaching a different file still has something to target
    // (fill()'s 'resume'/'cover_letter_file' handlers re-derive the live
    // input from the fixed id at write time regardless).
    for (const [id, fieldId, fieldKind] of [[RESUME_FILE_ID, "resume", "resume"], [COVER_LETTER_FILE_ID, "cover_letter_file", "cover_letter_file"]]) {
      if (usedFieldIds.has(fieldId)) continue;
      if (document.getElementById(id)) continue; // native input still present -> already added above
      const wrapper = document.querySelector("#upload_resume_field, #upload_file_field");
      if (!wrapper || !isVisible(wrapper)) continue;
      addField({ question: fieldKind === "resume" ? "Resume" : "Cover letter", fieldId, field: wrapper, control: null, fieldKind, options: [] });
    }

    return fields;
  }

  // ---- posting -> form reveal (the only "advance" this flow has) --------

  function getApplyButton() {
    if (getForm()) return null; // already revealed
    return (
      Array.from(document.querySelectorAll("button, a"))
        .filter(isVisible)
        .find((el) => !el.closest(FORM_SELECTOR) && !el.disabled && el.getAttribute("aria-disabled") !== "true" && APPLY_BUTTON_PATTERN.test(getActionLabel(el))) ?? null
    );
  }
  function getSubmitButton() {
    const form = getForm();
    if (!form) return null;
    return (
      Array.from(form.querySelectorAll('input[type="submit"], button[type="submit"]'))
        .filter(isVisible)
        .find((b) => /\bsubmit\b/i.test(getActionLabel(b))) ?? null
    );
  }

  /** Reveal the application form if it isn't already showing: click
   *  "Apply"/"Apply for this job" (Turbo then swaps the real form into
   *  `turbo-frame#application_form`), or just scroll an already-loading
   *  frame into view. Returns true if it did something a caller should
   *  wait on before re-detecting fields; false if the form was already up
   *  (or there was nothing to click). Never touches the final Submit
   *  button — same as BidHub's own flow, submission is left to the human. */
  async function revealApplicationForm() {
    if (getForm()) return false;
    const applyButton = getApplyButton();
    if (applyButton) {
      await clickLikeHuman(applyButton);
      await waitFor(getForm, 4000, 100);
      getApplicationFrame()?.scrollIntoView({ block: "center", inline: "nearest" });
      return true;
    }
    const frame = getApplicationFrame();
    if (frame && !getForm()) {
      frame.scrollIntoView({ block: "center", inline: "nearest" });
      await waitFor(getForm, 4000, 100);
      return true;
    }
    return false;
  }

  function isAutofillAvailable() {
    return Boolean(detectFields().length || getApplyButton() || (getApplicationFrame() && !getForm()));
  }

  // ---- option matching (exact / substring only — see file header) -------

  function getBestMatchingOption(answer, options) {
    const normalizedAnswer = normalizeComparisonText(Array.isArray(answer) ? answer[0] : answer);
    if (!normalizedAnswer || !options?.length) return null;
    const asText = (o) => (typeof o === "string" ? o : o.text);
    const exact = options.find((o) => normalizeComparisonText(asText(o)) === normalizedAnswer);
    if (exact) return exact;
    return options.find((o) => {
      const t = normalizeComparisonText(asText(o));
      return t && (t.startsWith(normalizedAnswer) || normalizedAnswer.startsWith(t));
    }) ?? null;
  }
  function toSelectionList(answer) {
    if (Array.isArray(answer)) return answer.map(normalizeComparisonText).filter(Boolean);
    if (typeof answer === "boolean") return [answer ? "yes" : "no"];
    return [normalizeComparisonText(answer)].filter(Boolean);
  }
  function isAffirmativeAnswer(answer) {
    if (answer === true) return true;
    return /^(?:yes|true|y|agree|agreed|accepted|checked|on|1)$/i.test(normalizeComparisonText(answer));
  }

  // ---- contact-field matching ---------------------------------------------
  // Teamtailor's own name/email fields carry no fixed id/name of their own
  // (Stimulus-driven, tenant-skinned) — BidHub's generic contact-field
  // detector (shared boilerplate, not part of this per-site file) resolves
  // them for its own pipeline; this module matches the same handful of
  // label patterns itself so `fill()` can be driven directly off profile
  // data without depending on that unported shared detector.
  const CONTACT_PATTERNS = [
    ["first_name", /\bfirst\s*name\b/i],
    ["last_name", /\b(last|sur)\s*name\b/i],
    ["full_name", /^\s*name\s*\*?\s*$/i],
    ["email", /\be-?mail\b/i],
  ];
  function matchContactKey(question) {
    const q = normalizeText(question);
    for (const [key, pattern] of CONTACT_PATTERNS) {
      if (pattern.test(q)) return key;
    }
    return null;
  }

  // ---- fill ---------------------------------------------------------------

  /** Write `answer` into one detected field entry (as returned by
   *  detectFields()), using the mechanism its fieldKind needs. Returns
   *  true on an apparent success. `answer` for 'resume'/'cover_letter_file'
   *  is `{fileName, base64, mimeType}`; for everything else it's a plain
   *  string/boolean/array matched against the field's own options where
   *  applicable. */
  async function fillField(entry, answer) {
    if (!entry || answer == null || answer === "") return false;
    const { fieldKind, field, control } = entry;
    switch (fieldKind) {
      case "text": {
        const input = control || getTextInput(field, TEXT_INPUT_SELECTOR);
        if (!input) return false;
        fillTextInput(input, String(answer));
        return true;
      }
      case "date": {
        const input = control || getTextInput(field, TEXT_INPUT_SELECTOR);
        if (!input) return false;
        fillTextInput(input, formatDateAnswer(answer, entry.dateFormat || inferDateFormat(entry.question, input)));
        return true;
      }
      case "textarea":
      case "cover_letter": {
        const textarea = control || getTextarea(field);
        if (!textarea) return false;
        fillTextInput(textarea, String(answer));
        return true;
      }
      case "phone": {
        const input = control || getPhoneInput(field);
        if (!input) return false;
        const phoneCountry = typeof answer === "object" ? answer.phoneCountry : undefined;
        const number = typeof answer === "object" ? answer.number : answer;
        fillTextInput(input, buildInternationalPhone(number, getPhoneDialCodeForCountry(phoneCountry)));
        return true;
      }
      case "location":
        return fillLocationAutocomplete(field, answer);
      case "select": {
        const select = control?.tagName === "SELECT" ? control : field.querySelector("select");
        if (!select) return false;
        const entries = Array.from(select.querySelectorAll("option")).filter((o) => o.value).map((o) => ({ value: o.value, text: normalizeText(o.textContent) }));
        const best = getBestMatchingOption(answer, entries);
        if (!best) return false;
        fillSelectInput(select, best.value);
        return true;
      }
      case "radio": {
        const options = getRadioInputs(field).map((input) => ({ input, text: getChoiceInputLabelText(input, entry.question) })).filter((o) => o.text);
        const normalizedSelections = toSelectionList(answer);
        const direct = options.find((o) => normalizedSelections.includes(normalizeComparisonText(o.text)) || normalizedSelections.includes(normalizeComparisonText(o.input.value)));
        const best = direct || getBestMatchingOption(answer, options);
        if (!best?.input) return false;
        await setChoiceInput(best.input, true, field);
        return true;
      }
      case "checkbox-single": {
        const checkbox = control || getCheckboxInputs(field)[0];
        if (!checkbox) return false;
        await setChoiceInput(checkbox, isAffirmativeAnswer(answer), field);
        return true;
      }
      case "checkbox": {
        const selected = toSelectionList(answer);
        for (const checkbox of getCheckboxInputs(field)) {
          const label = normalizeComparisonText(getChoiceInputLabelText(checkbox, entry.question));
          const shouldCheck = selected.includes(label) || selected.includes(normalizeComparisonText(checkbox.value));
          await setChoiceInput(checkbox, shouldCheck, field);
        }
        return true;
      }
      case "resume":
      case "cover_letter_file": {
        if (!answer || typeof answer !== "object") return false;
        // Re-derive the live input by its fixed id rather than trusting
        // entry.control — a file already attached unmounts the native
        // input, and the live DOM only grows a fresh one back once
        // Teamtailor's own "remove" control is clicked, which this module
        // doesn't do (no detected 'remove' affordance to drive safely
        // without risking discarding a file the applicant wants kept).
        const id = fieldKind === "resume" ? RESUME_FILE_ID : COVER_LETTER_FILE_ID;
        const input = document.getElementById(id) || getFileInputInsideField(field);
        if (!input) return false;
        fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        return true;
      }
      default:
        return false;
    }
  }

  /** Fill every field this module can resolve structurally from
   *  `profileData`:
   *    full_name | first_name/last_name, email, phone (a string, or
   *    {number, phoneCountry} for the intl-tel-input dial code),
   *    cover_letter (free-text), __resumeFile, __coverLetterFile (each
   *    {fileName, base64, mimeType}).
   *  Reveals the application form first if only the posting is showing.
   *  Any field this can't resolve (an arbitrary screening question with
   *  no matching profileData key) is left untouched for Big Banana's
   *  existing generic pipeline to pick up. Returns the filled fieldIds. */
  async function fill(profileData = {}, opts = {}) {
    const { maxReveals = 1 } = opts;
    for (let i = 0; i < maxReveals && !getForm(); i++) {
      if (!(await revealApplicationForm())) break;
    }
    const form = getForm();
    if (!form) return [];

    const filled = [];
    for (const entry of detectFields()) {
      let answer;
      if (entry.fieldKind === "resume") answer = profileData.__resumeFile;
      else if (entry.fieldKind === "cover_letter_file") answer = profileData.__coverLetterFile;
      else if (entry.fieldKind === "cover_letter") answer = profileData.cover_letter;
      else if (entry.fieldKind === "phone") answer = profileData.phone;
      else {
        const contactKey = matchContactKey(entry.question);
        if (contactKey === "full_name") answer = profileData.full_name || [profileData.first_name, profileData.last_name].filter(Boolean).join(" ") || null;
        else if (contactKey) answer = profileData[contactKey];
      }
      if (answer == null || answer === "") continue;
      if (await fillField(entry, answer)) filled.push(entry.fieldId);
    }
    return filled;
  }

  window.ProactiveAutofillSites = window.ProactiveAutofillSites || {};
  window.ProactiveAutofillSites.teamtailor = {
    isAutofillAvailable,
    detectFields,
    fillField,
    fill,
    getSubmitButton,
    revealApplicationForm,
  };
})();
