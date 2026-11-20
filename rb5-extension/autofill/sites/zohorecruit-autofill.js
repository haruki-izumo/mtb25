/* =====================================================================
 * autofill/sites/zohorecruit-autofill.js — Zoho Recruit's own hosted
 * careers-page application forms (candidate-facing postings; NOT the
 * recruiter-facing Zoho Recruit CRM app).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/zohorecruit/autofill.js.
 *
 * Zoho's form (`.crc-form-wrapper`) is built from Zoho's own "Lyte" web
 * components (`lyte-dropdown`, `crux-country-droplist`, …) rather than
 * plain HTML controls, so a lot of this file is about locating the
 * REAL control and its label inside those wrappers (getZohoQuestionLabel/
 * getPrimaryZohoControl) and driving their custom dropdowns by click
 * sequence (openZohoDropdown) rather than a native <select>.
 *
 * Ported, structural-only:
 *   - field enumeration: label resolution (row label / previous-sibling
 *     label / direct label / linked label / the standard-field-id → label
 *     map Zoho ships no visible label for), resume/cover-letter/photo
 *     upload-slot detection (a SEPARATE `.crc-other-upload` area outside
 *     the main `.crc-form-field` list), checkbox/radio groups, Zoho's own
 *     combobox-style dropdown, a plain text field, a textarea
 *   - the phone field's split country-code dropdown + national-number
 *     text input (Zoho's crux-country-droplist component)
 *   - the address-autocomplete widget (`.crc-form-autocomplete`, used for
 *     both a free address field and the standard City/State/Zip trio)
 *   - the Skill Set chips widget (type → wait for a matching suggestion →
 *     click it; free text never commits without picking a suggestion)
 *   - value-filling per field kind, including Zoho's own dropdown/
 *     typeahead click sequence and file upload
 *   - the "I'm interested" → application-form reveal step, and the final
 *     Submit-button detector
 *
 * Explicitly NOT ported (BidHub's own AI-answer backend / CAPTCHA /
 * proxy, and this batch's repeatable-section boundary):
 *   - createBackendAnswerHandler / getAnswer() / getEmbeddingMatch — free-
 *     text screening-question answer GENERATION and the embedding-
 *     similarity fallback inside BidHub's own option matcher. This port's
 *     getBestOptionMatch stops at an exact or substring label match.
 *   - Zoho's own image-text CAPTCHA (rec-captcha-component /
 *     GenerateCAPTCHA). BidHub's own manual-extension build already
 *     dead-strips this (buildZohoCaptchaEntry is `if (true) return null`
 *     in that build) — a captcha field is simply left for the user to
 *     type, same as here.
 *   - the education/work-history TABULAR sections' "Add row" multi-entry
 *     iterator (BidHub's shared profile-section-hierarchy machinery).
 *     Per this port's own scope, only the first always-rendered row of
 *     such a section is handled, and it needs no special-casing at all —
 *     its controls are ordinary `.crc-form-field`s that the ordinary walk
 *     below already detects and fills like any other field.
 * ===================================================================== */
(function () {
  "use strict";
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const { sleep, fillTextInput, fillFileInput, getCheckboxInputs, getRadioInputs, getTextarea, getFileInputInsideField, getInputLabelText, writeReactTextValue } = engine;

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
  // One retry: Zoho's dropdown can render a stale option list the instant
  // it opens (still animating in) — a single re-open-and-retry is what
  // BidHub's own withRetry gave this call in practice.
  async function withOneRetry(action) {
    try {
      return await action();
    } catch {
      return action();
    }
  }
  function triggerMouseEvent(element, type) {
    element?.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }

  const DROPDOWN_WAIT_TIMEOUT_MS = 1800;
  const SKILL_SUGGESTION_WAIT_MS = 3000;
  const SKILL_CHIP_WAIT_MS = 1500;
  // The Zoho Recruit Skill Set widget stops accepting entries at 50 chips (verified manually).
  const MAX_SKILL_CHIPS = 50;
  const OPTION_SKIP_VALUES = new Set(["", "-none-", "none", "loading", "no results found"]);
  // Zoho's own standard contact-field ids (lt-prop/name suffixes) carry no
  // visible <label> at all on some templates — this is the only way to
  // name them.
  const STANDARD_FIELD_LABELS = new Map([
    ["063542", "First Name"], ["063544", "Last Name"], ["063548", "Email"], ["063554", "Mobile"],
    ["063560", "Street"], ["063568", "Country"], ["063570", "Current Employer"], ["063574", "Current Job Title"],
    ["063580", "Experience in Years"], ["498001", "LinkedIn"], ["498002", "Facebook"], ["063610", "Twitter"],
  ]);
  const STANDARD_ADDRESS_LABELS = ["Zip/Postal Code", "City", "State/Province"];
  const RESUME_FIELD_ID = "resume";
  const COVER_LETTER_FIELD_ID = "cover_letter";

  function normalizeZohoText(value) {
    return String(value ?? "").replace(/ /g, " ").replace(/\s+/g, " ").replace(/\s+\*/g, " *").trim();
  }
  function slugifyFieldId(value) {
    return normalizeZohoText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function isElementVisible(element) {
    if (!element?.isConnected) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }
  function cleanQuestion(question) {
    return normalizeZohoText(question).replace(/\s*\*$/, "").trim();
  }
  function getStandardFieldSuffix(control) {
    const name = control?.name || "";
    const match = name.match(/(?:rec-form_)?\d*(063542|063544|063548|063554|063560|063568|063570|063574|063580|498001|498002|063610)(?:_file)?$/);
    return match?.[1] ?? null;
  }

  // ---- control / label resolution ---------------------------------------

  function getVisibleTextInput(field) {
    if (!field) return null;
    if (field.tagName === "INPUT" && field.type !== "hidden" && field.type !== "file" && isElementVisible(field)) return field;
    return Array.from(field.querySelectorAll('input:not([type="hidden"]):not([type="file"])')).find(isElementVisible) ?? null;
  }
  // The single control a `.crc-form-field` wrapper actually represents,
  // tried in Zoho's own priority order — file > textarea > checkbox >
  // radio > a visible plain text input > a combobox fallback.
  function getPrimaryZohoControl(field) {
    if (!field) return null;
    const fileInput = getFileInputInsideField(field);
    if (fileInput) return fileInput;
    const textarea = getTextarea(field);
    if (textarea) return textarea;
    const checkbox = getCheckboxInputs(field)[0];
    if (checkbox) return checkbox;
    const radio = getRadioInputs(field)[0];
    if (radio) return radio;
    const visibleTextInput = getVisibleTextInput(field);
    if (visibleTextInput) return visibleTextInput;
    return field.querySelector('[role="combobox"]') || null;
  }
  function getZohoDropdown(field) {
    if (!field) return null;
    if (field.tagName === "LYTE-DROPDOWN") return field;
    return field.querySelector("lyte-dropdown");
  }

  function getZohoQuestionLabel(fieldWrapper) {
    const primaryControl = getPrimaryZohoControl(fieldWrapper);
    if (primaryControl?.id === "addSkills" || primaryControl?.name === "-add-skills") return "Skill Set";
    const rowLabel = normalizeZohoText(
      fieldWrapper?.closest?.(".crc-form-row")?.querySelector(":scope > label.crm-from-label, :scope > label")?.textContent
    );
    if (rowLabel && rowLabel !== "@") return rowLabel;
    const previousLabel =
      fieldWrapper?.previousElementSibling?.matches?.("label") ? normalizeZohoText(fieldWrapper.previousElementSibling.textContent) : "";
    if (previousLabel && previousLabel !== "@") return previousLabel;
    const directLabel = Array.from(fieldWrapper?.querySelectorAll?.(".cxElementLabel, .crc-form-label, label") ?? [])
      .map((element) => normalizeZohoText(element.textContent))
      .find(Boolean);
    if (directLabel && directLabel !== "@") return directLabel;
    const linkedLabel = getInputLabelText(primaryControl, "");
    if (linkedLabel && normalizeZohoText(linkedLabel) !== "@") return normalizeZohoText(linkedLabel);
    const suffix = getStandardFieldSuffix(primaryControl);
    if (suffix && STANDARD_FIELD_LABELS.has(suffix)) return STANDARD_FIELD_LABELS.get(suffix);
    if (directLabel) return directLabel;
    if (fieldWrapper?.classList?.contains("crc-form-autocomplete")) {
      // The standard address trio (City/State/Zip) renders as three
      // unlabeled autocomplete fields in DOM order within the section.
      const addressFields = Array.from(fieldWrapper.closest(".crc-form-sec")?.querySelectorAll(".crc-form-field.crc-form-autocomplete") ?? []);
      const addressIndex = addressFields.indexOf(fieldWrapper);
      if (addressIndex >= 0) return STANDARD_ADDRESS_LABELS[addressIndex] ?? "";
    }
    const sectionText = normalizeZohoText(fieldWrapper?.closest?.(".crc-form-sec")?.textContent);
    if (/Professional Details/i.test(sectionText) && getZohoDropdown(fieldWrapper)) return "Current Job Title";
    return "";
  }

  function getZohoFieldId(field, question, usedFieldIds) {
    const primaryControl = getPrimaryZohoControl(field);
    const rawId = primaryControl?.name || primaryControl?.id || primaryControl?.getAttribute?.("lt-prop-user-value") || slugifyFieldId(question);
    const baseFieldId = rawId || slugifyFieldId(question);
    if (!baseFieldId) return null;
    if (!usedFieldIds.has(baseFieldId)) {
      usedFieldIds.add(baseFieldId);
      return baseFieldId;
    }
    let suffix = 2;
    while (usedFieldIds.has(`${baseFieldId}-${suffix}`)) suffix += 1;
    const uniqueFieldId = `${baseFieldId}-${suffix}`;
    usedFieldIds.add(uniqueFieldId);
    return uniqueFieldId;
  }

  // Zoho marks a mandatory field with an asterisk span inside the row
  // label — never `required`/`aria-required` on the input itself.
  function isZohoFieldRequired(field) {
    const label = field?.closest?.(".crc-form-row")?.querySelector(":scope > label") ?? (field?.previousElementSibling?.matches?.("label") ? field.previousElementSibling : null);
    return /\*\s*$/.test(normalizeZohoText(label?.textContent));
  }

  // Zoho's own country-code-split phone component.
  function isZohoPhoneField(question, field) {
    return (
      /^mobile$|^phone( number)?$/i.test(cleanQuestion(question)) &&
      Boolean(field?.classList?.contains("crux-country-droplist")) &&
      Boolean(getZohoDropdown(field)) &&
      Boolean(getVisibleTextInput(field))
    );
  }
  function isZohoAddressAutocompleteField(question, field) {
    if (!field?.classList?.contains("crc-form-autocomplete")) return false;
    return /\b(address|street|city|state|province|zip|postal|country)\b/i.test(cleanQuestion(question));
  }

  // Zoho's crux-phone-component owns the dial code (its own "Phone
  // Country Code" dropdown), so the text input takes the NATIONAL number
  // only. Rules: an explicit "+CC" is always dropped (separator-delimited
  // → the leading group; a compact "+17242817026" → assume a 10-digit
  // national number); a bare NANP "1" is dropped only when 11 digits
  // remain; a ≤10-digit number is never touched. Digits only — the one
  // shape Zoho is proven to accept.
  function stripPhoneCountryCode(answer) {
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
    return digits;
  }

  // Zoho's standard Twitter (063610) / Facebook (498002) contact fields
  // render as <crux-twitter-component>/<crux-facebook-component> and
  // validate as a handle or profile URL — never free text.
  const ZOHO_SOCIAL_HANDLE_SUFFIXES = new Set(["063610", "498002"]);
  const ZOHO_SOCIAL_HANDLE_QUESTION = /^(x \(formerly twitter\)|twitter(\s*\/\s*x)?|x\s*\/\s*twitter|facebook)(\s+(url|handle|username|profile))?$/i;
  function isZohoSocialHandleField(question, field) {
    if (field?.querySelector?.("crux-twitter-component, crux-facebook-component")) return true;
    const suffix = getStandardFieldSuffix(getPrimaryZohoControl(field));
    if (suffix && ZOHO_SOCIAL_HANDLE_SUFFIXES.has(suffix)) return true;
    return ZOHO_SOCIAL_HANDLE_QUESTION.test(cleanQuestion(question));
  }
  // What Zoho accepts in those fields: a bare handle (optionally
  // @-prefixed) or a profile URL on the matching host. Anything with
  // whitespace or prose is rejected client-side — write nothing for it.
  const SOCIAL_HANDLE_RE = /^@?[A-Za-z0-9_.]{1,50}$/;
  const SOCIAL_PROFILE_URL_RE = /^https?:\/\/(www\.|m\.|mobile\.)?(x\.com|twitter\.com|facebook\.com|fb\.com)\/[^\s]+$/i;
  function normalizeSocialHandleAnswer(answer) {
    const value = normalizeZohoText(answer);
    if (!value) return "";
    if (SOCIAL_PROFILE_URL_RE.test(value) || SOCIAL_HANDLE_RE.test(value)) return value;
    return "";
  }

  // ---- dropdown option reading --------------------------------------------

  function getDropdownOptionsFromText(text) {
    // "-None-" starts with a non-word char, so a leading \b never matches
    // at string start — guard it as its own split point too, or
    // "-None- Loading" survives as one fused "option".
    const values = normalizeZohoText(text)
      .replace(/^Loading\s+/i, "")
      .split(/\s{2,}|(?<=\b(?:Mr\.|Mrs\.|Ms\.|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{4})|-None-)\s+/)
      .map(normalizeZohoText)
      .filter((value) => value && !OPTION_SKIP_VALUES.has(value.toLowerCase()));
    return Array.from(new Set(values));
  }
  function getDropdownOptions(field) {
    const dropdown = getZohoDropdown(field);
    const items = Array.from(dropdown?.querySelectorAll?.('lyte-drop-item, lyte-dropdown-item, [role="option"]') ?? [])
      .map((option) => normalizeZohoText(option.textContent))
      .filter((value) => value && !OPTION_SKIP_VALUES.has(value.toLowerCase()));
    if (items.length > 0) return Array.from(new Set(items));
    return getDropdownOptionsFromText(dropdown?.textContent || field?.textContent);
  }
  function getChoiceOptions(field, question) {
    const checkboxInputs = getCheckboxInputs(field);
    if (checkboxInputs.length > 0) return checkboxInputs.map((input) => getInputLabelText(input, question)).filter(Boolean);
    const radioInputs = getRadioInputs(field);
    if (radioInputs.length > 0) return radioInputs.map((input) => getInputLabelText(input, question)).filter(Boolean);
    return [];
  }

  // Exact (normalized) match first, else substring either direction —
  // deliberately NOT BidHub's own embedding-similarity fallback (the
  // out-of-scope AI-answer backend).
  function getBestOptionMatch(answer, optionTexts) {
    const normalizedAnswer = normalizeZohoText(answer).toLowerCase();
    if (!Array.isArray(optionTexts) || optionTexts.length === 0) return null;
    if (!normalizedAnswer) return null;
    const exact = optionTexts.find((option) => normalizeZohoText(option).toLowerCase() === normalizedAnswer);
    if (exact) return exact;
    return optionTexts.find((option) => {
      const text = normalizeZohoText(option).toLowerCase();
      return text && (text.includes(normalizedAnswer) || normalizedAnswer.includes(text));
    }) ?? null;
  }
  // Zoho's own dropdowns are frequently mandatory selects with no blank
  // option — leaving one at its default when an answer doesn't cleanly
  // match still beats a validation-blocked submit, so (matching BidHub's
  // own resolveBestOption) a miss falls back to the FIRST real option
  // rather than nothing.
  function getBestOptionMatchOrFirst(answer, optionTexts) {
    if (!Array.isArray(optionTexts) || optionTexts.length === 0) return null;
    return getBestOptionMatch(answer, optionTexts) ?? optionTexts[0];
  }

  // ---- field-kind classification -----------------------------------------

  function classifyZohoField(field, question) {
    const primaryControl = getPrimaryZohoControl(field);
    if (primaryControl?.type === "file") {
      const lowerQuestion = question.toLowerCase();
      if (/resume|cv/.test(lowerQuestion) || /072325|easyresume/.test(primaryControl.name || "")) return { fieldKind: "resume", options: [] };
      if (/cover\s*letter/.test(lowerQuestion)) return { fieldKind: "cover_letter", options: [] };
      return null;
    }
    const checkboxInputs = getCheckboxInputs(field);
    if (checkboxInputs.length > 0) return { fieldKind: "checkbox", options: getChoiceOptions(field, question) };
    const radioInputs = getRadioInputs(field);
    if (radioInputs.length > 0) return { fieldKind: "radio", options: getChoiceOptions(field, question) };
    if (field.classList?.contains("sugg_skills_pop_origin_class")) return { fieldKind: "skills", options: [] };
    if (field.classList?.contains("crc-form-autocomplete")) {
      return { fieldKind: isZohoAddressAutocompleteField(question, field) ? "address-typeahead" : "typeahead", options: [] };
    }
    if (isZohoSocialHandleField(question, field)) {
      // Optional → nothing grounds a guess, so the field is left out of
      // detection entirely (never auto-filled); required → still
      // surfaced, with the question reworded so a caller/human knows
      // exactly what's wanted instead of composing prose that Zoho's own
      // validator would reject anyway.
      if (!isZohoFieldRequired(field)) return null;
      return { fieldKind: "social-handle", options: [], questionOverride: `${question} profile URL or handle` };
    }
    if (getVisibleTextInput(field)) return { fieldKind: "text", options: [] };
    if (getZohoDropdown(field)) return { fieldKind: "dropdown", options: getDropdownOptions(field) };
    if (getTextarea(field)) return { fieldKind: "textarea", options: [] };
    return null;
  }

  function getUploadFieldId(question) {
    if (/resume|cv/i.test(question)) return RESUME_FIELD_ID;
    if (/cover\s*letter/i.test(question)) return COVER_LETTER_FIELD_ID;
    if (/photo/i.test(question)) return "photo";
    return slugifyFieldId(question);
  }
  // Resume/cover-letter/photo upload slots live in their OWN
  // `.crc-other-upload` widgets, outside the `.crc-form-field` list the
  // main walk below enumerates.
  function detectUploadFields(usedFieldIds) {
    return Array.from(document.querySelectorAll('.crc-other-upload input[type="file"]'))
      .map((input) => {
        if (!input.closest(".crc-form-sec")) return null;
        const uploadWrapper = input.closest(".crc-other-upload");
        const row = uploadWrapper?.closest(".crc-form-field, .crc-form-row, .crc-form-sec") || uploadWrapper;
        const name = input.name || "";
        const text = normalizeZohoText(row?.textContent);
        const question = /072325|easyresume/i.test(name) || /resume|cv/i.test(text) ? "Resume" : /cover\s*letter/i.test(text) ? "Cover Letter" : /photo/i.test(text) ? "Photo" : "";
        if (!question) return null;
        const fieldId = getUploadFieldId(question);
        if (!fieldId || usedFieldIds.has(fieldId)) return null;
        usedFieldIds.add(fieldId);
        const fieldKind = fieldId === RESUME_FIELD_ID ? "resume" : fieldId === COVER_LETTER_FIELD_ID ? "cover_letter" : null;
        if (!fieldKind) return null; // a "photo" upload: no fieldKind handler ported for it — left for the generic pipeline
        return { question, fieldId, fieldKind, field: uploadWrapper, control: input, options: [], required: false };
      })
      .filter(Boolean);
  }

  /** Walk Zoho's application form and return every question this adapter
   *  knows how to fill deterministically. A field this module can't
   *  classify, or whose question text can't be derived at all, is left
   *  out entirely for Big Banana's own generic/AI pipeline to pick up.
   *  @returns {Array<{question, fieldId, field, control, fieldKind, options, required}>}
   */
  function detectFields() {
    const form = document.querySelector(".crc-form-wrapper, .crc-form-container, form, .cw-apply-form, body");
    if (!form) return [];
    const questions = [];
    const usedFieldIds = new Set();

    for (const field of form.querySelectorAll(".crc-form-field")) {
      // Education/Work-history tabular rows (`.tabular-main-div`, every row — not just the
      // first) are owned by detectSections()/fillSections() below, driven by the shared
      // engine/section-hierarchy.js — skip them here so a row is never double-detected by
      // both paths, same as Greenhouse/Ashby/Kula's own SECTION_CONTAINER_SELECTOR guard.
      if (field.closest(".tabular-main-div")) continue;
      const question = cleanQuestion(getZohoQuestionLabel(field));
      if (!question) continue;

      if (isZohoPhoneField(question, field)) {
        if (!usedFieldIds.has("phone_country_code")) {
          usedFieldIds.add("phone_country_code");
          questions.push({ question: "Phone Country Code", fieldId: "phone_country_code", field, control: field, fieldKind: "phone-country-code", options: getDropdownOptions(field), required: false });
        }
        if (!usedFieldIds.has("phone_number")) {
          usedFieldIds.add("phone_number");
          questions.push({ question: "Phone Number", fieldId: "phone_number", field, control: getVisibleTextInput(field), fieldKind: "phone", options: [], required: false });
        }
        continue;
      }

      const classified = classifyZohoField(field, question);
      if (!classified) continue;
      const fieldId = getZohoFieldId(field, question, usedFieldIds);
      if (!fieldId) continue;
      questions.push({
        question: classified.questionOverride ?? question,
        fieldId,
        field,
        control: getPrimaryZohoControl(field),
        fieldKind: classified.fieldKind,
        options: classified.options,
        required: isZohoFieldRequired(field),
      });
    }

    questions.push(...detectUploadFields(usedFieldIds));
    return questions;
  }

  // ---- Zoho's own dropdown (click-open, click-option) --------------------

  async function openZohoDropdown(field, { shouldAbort = () => false } = {}) {
    const dropdown = getZohoDropdown(field);
    const combo = field.querySelector('[role="combobox"]') || dropdown;
    if (!combo || shouldAbort()) return [];
    triggerMouseEvent(combo, "mousedown");
    triggerMouseEvent(combo, "mouseup");
    triggerMouseEvent(combo, "click");
    const options = await waitFor(() => {
      const visibleDropBoxes = Array.from(document.querySelectorAll("lyte-drop-box:not(.lyteDropdownHidden), lyte-drop-box")).filter(isElementVisible);
      const liveOptions = visibleDropBoxes.flatMap((box) =>
        Array.from(box.querySelectorAll('lyte-drop-item, lyte-dropdown-item, [role="option"]'))
          .filter(isElementVisible)
          .map((item) => ({ element: item, text: normalizeZohoText(item.textContent) }))
          .filter((item) => item.text && !OPTION_SKIP_VALUES.has(item.text.toLowerCase()))
      );
      return liveOptions.length > 0 ? liveOptions : null;
    }, DROPDOWN_WAIT_TIMEOUT_MS, 100);
    return options ?? [];
  }

  async function fillZohoDropdown(answer, field, { shouldAbort = () => false } = {}) {
    await withOneRetry(async () => {
      if (shouldAbort()) return;
      const liveOptions = await openZohoDropdown(field, { shouldAbort });
      if (shouldAbort()) return;
      const optionText = getBestOptionMatchOrFirst(answer, liveOptions.map((option) => option.text));
      const option = liveOptions.find((item) => item.text === optionText);
      if (!option) throw new Error("Zoho dropdown did not provide a matching option");
      option.element.click();
    });
  }

  async function fillZohoTypeahead(answer, field, { shouldAbort = () => false } = {}) {
    const input = getVisibleTextInput(field);
    if (!input || answer == null || shouldAbort()) return;
    fillTextInput(input, String(answer));
    await sleep(300);
    const liveOptions = await openZohoDropdown(field, { shouldAbort });
    if (shouldAbort() || liveOptions.length === 0) return;
    const optionText = getBestOptionMatch(answer, liveOptions.map((option) => option.text));
    const option = liveOptions.find((item) => item.text === optionText);
    option?.element?.click();
  }

  function closeZohoTypeaheadSuggestions(input) {
    if (!input) return;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
  }

  // Zoho's address-autocomplete widget accepts whatever text is typed
  // (it doesn't require picking a suggestion like the Skill Set widget
  // does) — type it, let the component settle, then dismiss the
  // suggestion popover so it doesn't cover the next field.
  async function fillZohoAddressTypeahead(answer, field, { shouldAbort = () => false } = {}) {
    const input = getVisibleTextInput(field);
    if (!input || answer == null || shouldAbort()) return;
    fillTextInput(input, String(answer));
    await sleep(150);
    if (shouldAbort()) return;
    closeZohoTypeaheadSuggestions(input);
  }

  // ---- Skill Set chips widget (skills-tag / #addSkills) ------------------
  // The input's Enter key maps to "select first suggestion" and the
  // component disables extra values, so a skill ONLY commits by picking
  // an entry from the async suggestion search
  // (ul#competencySkillsSuggestedList) — free text never becomes a chip.
  // Each skill: raw-write the text (writeReactTextValue, NOT fillTextInput
  // — its reassert recovery would re-type the input after the widget
  // clears it on chip commit), wait for the suggestion list to refresh
  // for THIS query, click the best-matching item, confirm the chip
  // appeared.
  function comparableSkill(value) {
    return normalizeZohoText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
  }
  function parseZohoSkills(answer) {
    const values = String(answer ?? "")
      .replace(/\([^)]*\)/g, " ") // "CI/CD (GitHub Actions, Jenkins…)" → "CI/CD", not 3 junk fragments
      .split(/[,;\n]/)
      .map((value) => normalizeZohoText(value).replace(/\s*\.$/, "").trim())
      .filter(Boolean);
    const seen = new Set();
    return values.filter((value) => {
      const key = comparableSkill(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, MAX_SKILL_CHIPS);
  }
  function getZohoSkillChipKeys(field) {
    return new Set(
      Array.from(field.querySelectorAll(".skl-selected-skill-li")).map((chip) => comparableSkill(chip.querySelector("span")?.textContent ?? chip.textContent)).filter(Boolean)
    );
  }
  function getVisibleSkillSuggestions() {
    return Array.from(document.querySelectorAll('#competencySkillsSuggestedList li[role="button"]'))
      .filter(isElementVisible)
      .map((item) => ({ element: item, key: comparableSkill(item.textContent) }))
      .filter((item) => item.key);
  }
  async function fillZohoSkills(answer, field, { shouldAbort = () => false } = {}) {
    const input = getVisibleTextInput(field);
    if (!input || answer == null || shouldAbort()) return;
    for (const skill of parseZohoSkills(answer)) {
      if (shouldAbort()) break;
      const skillKey = comparableSkill(skill);
      if (getZohoSkillChipKeys(field).has(skillKey)) continue;
      writeReactTextValue(input, skill);
      // The list refreshes from a server-side search and otherwise shows
      // stale default suggestions — only a suggestion MATCHING the typed
      // skill may ever be clicked, and a partial match is trusted only
      // after the exact-match wait expires (a partial can hit the stale
      // default list before the search for this query lands).
      const exact = await waitFor(() => getVisibleSkillSuggestions().find((item) => item.key === skillKey) ?? null, SKILL_SUGGESTION_WAIT_MS, 100);
      if (shouldAbort()) break;
      const suggestion =
        exact ??
        getVisibleSkillSuggestions()
          .filter((item) => item.key.includes(skillKey) || skillKey.includes(item.key))
          .sort((a, b) => b.key.length - a.key.length)[0];
      if (!suggestion) continue;
      if (getZohoSkillChipKeys(field).has(suggestion.key)) continue;
      const suggestionKey = suggestion.key; // the <li> detaches on the post-click list refresh
      suggestion.element.click();
      await waitFor(() => (getZohoSkillChipKeys(field).has(suggestionKey) ? true : null), SKILL_CHIP_WAIT_MS, 100);
    }
    // Leftover query text from a skipped skill would sit in the input
    // (and can trip the form's own validation) — always leave it empty.
    if (input.isConnected && input.value) writeReactTextValue(input, "");
  }

  // ---- filling --------------------------------------------------------------

  /** Write an already-resolved answer into a question returned by
   *  detectFields(), dispatched by its fieldKind.
   * @param {{field:Element, control:Element, fieldKind:string, question:string}} entry
   * @param {*} answer - string for text/textarea/dropdown/typeahead/
   *   phone/social-handle; string|string[]|boolean for checkbox/radio;
   *   string for skills (comma/semicolon/newline separated);
   *   {type:"file", fileName, base64, mimeType} for resume/cover_letter.
   */
  async function fillField(entry, answer, { shouldAbort = () => false } = {}) {
    const { field, fieldKind, question } = entry;
    if (answer == null || shouldAbort()) return;

    switch (fieldKind) {
      case "text": {
        const input = getVisibleTextInput(field);
        if (input) fillTextInput(input, String(answer));
        return;
      }
      case "textarea": {
        const textarea = getTextarea(field);
        if (textarea) fillTextInput(textarea, String(answer));
        return;
      }
      case "dropdown":
      case "phone-country-code": {
        await fillZohoDropdown(answer, field, { shouldAbort });
        return;
      }
      case "typeahead": {
        await fillZohoTypeahead(answer, field, { shouldAbort });
        return;
      }
      case "address-typeahead": {
        await fillZohoAddressTypeahead(answer, field, { shouldAbort });
        return;
      }
      case "phone": {
        const input = getVisibleTextInput(field);
        if (input) fillTextInput(input, stripPhoneCountryCode(answer));
        return;
      }
      case "social-handle": {
        const value = normalizeSocialHandleAnswer(answer);
        if (!value) return; // prose never reaches the input — Zoho's own validator would reject it
        const input = getVisibleTextInput(field);
        if (input) fillTextInput(input, value);
        return;
      }
      case "skills": {
        await fillZohoSkills(answer, field, { shouldAbort });
        return;
      }
      case "checkbox": {
        const selectedValues = Array.isArray(answer) ? answer.map(normalizeZohoText) : [normalizeZohoText(answer)];
        for (const checkbox of getCheckboxInputs(field)) {
          const label = normalizeZohoText(getInputLabelText(checkbox, question));
          const shouldCheck = typeof answer === "boolean" ? answer : selectedValues.includes(label) || selectedValues.includes(normalizeZohoText(checkbox.value));
          if (checkbox.checked !== shouldCheck) checkbox.click();
        }
        return;
      }
      case "radio": {
        const selectedValue = normalizeZohoText(answer);
        for (const radio of getRadioInputs(field)) {
          const label = normalizeZohoText(getInputLabelText(radio, question));
          if (selectedValue === label || selectedValue === normalizeZohoText(radio.value)) {
            if (!radio.checked) radio.click();
            return;
          }
        }
        return;
      }
      case "resume": {
        if (answer?.type !== "file") return;
        const input = getFileInputInsideField(field);
        if (input) fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        return;
      }
      case "cover_letter": {
        if (answer?.type !== "file") return;
        const input = getFileInputInsideField(field);
        if (input) fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        return;
      }
      default:
        return;
    }
  }

  // ---- detection / advance / submit --------------------------------------

  function getZohoInterestedButton() {
    return Array.from(document.querySelectorAll('button, input[type="button"]')).find((button) => /i['’]?m interested|easy apply/i.test(button.value || button.textContent || "")) ?? null;
  }
  // Final submit: the revealed form's button[type="submit"] ("Submit
  // Application"). The posting page has no visible submit control, so
  // this doubles as the "is the form actually open" marker for advance().
  function getSubmitButton() {
    return (
      Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]'))
        .filter(isElementVisible)
        .find((button) => /submit/i.test(normalizeZohoText(button.value || button.textContent))) ?? null
    );
  }
  function detectSubmitButton() {
    const submitButton = getSubmitButton();
    if (!submitButton) return { detected: false };
    return {
      detected: true,
      label: normalizeZohoText(submitButton.value || submitButton.textContent),
      disabled: Boolean(submitButton.disabled || submitButton.getAttribute("aria-disabled") === "true"),
    };
  }
  function isAutofillAvailable() {
    return Boolean(detectFields().length || detectSubmitButton().detected || getZohoInterestedButton());
  }

  // Zoho reveals the application form INLINE on the SAME url ("I'm
  // interested" is a state flip, not a navigation) — click to reveal and
  // wait for the form to actually render before returning.
  async function advance({ shouldAbort = () => false } = {}) {
    if (getSubmitButton()) return false;
    const interestedButton = getZohoInterestedButton();
    if (!interestedButton || document.querySelector(".crc-form-field") || shouldAbort()) return false;
    interestedButton.click();
    await waitFor(() => document.querySelector(".crc-form-field"), 5000);
    return false;
  }

  // ---- repeatable Education/Work-history TABULAR sections ----------------
  // Ported from BidHub's own Zoho section descriptors (createZohoTabularSection,
  // findTabularSectionContainer/getTabularRows/getTabularRowField/addTabularRow) — grow-only:
  // Zoho's tabular rows cannot be deleted programmatically, so unlike every other ported site
  // there is no clearRows at all (the engine's fillSection already treats a missing clearRows
  // as "skip the clear step, grow/fill from whatever's already there"). Driven by the shared
  // engine/section-hierarchy.js, same root→group→leaf model every other ported site uses.
  // detectFields() above already skips anything inside `.tabular-main-div` so these rows are
  // never double-detected by the generic path.
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;
  const TABULAR_DATE_DROPDOWN_IDS = ["from_month", "from_year", "to_month", "to_year"];

  function getTabularDropdownId(dropdown) {
    return dropdown?.id || dropdown?.querySelector?.("input")?.id || "";
  }
  function isTabularDateDropdown(dropdown) {
    const id = getTabularDropdownId(dropdown);
    return TABULAR_DATE_DROPDOWN_IDS.some((part) => id.includes(part));
  }
  function findTabularSectionContainer(titlePattern) {
    return Array.from(document.querySelectorAll(".crc-form-sec")).find((section) => titlePattern.test(normalizeZohoText(section.textContent))) ?? null;
  }
  function getTabularRows(section) {
    return Array.from(section?.querySelectorAll?.(".tabular-main-div") ?? []).filter((row) =>
      row.querySelector('input:not([type="hidden"]), textarea, lyte-dropdown, [role="combobox"]')
    );
  }
  // Locates the live row control for a mapping: a date mapping matches a `lyte-dropdown` by id
  // substring (`dateId`, e.g. "from_month"); everything else matches the row's own
  // `.crc-form-tabularrow` sub-field by its <label> text against `labelPattern`.
  function getTabularRowField(rowEl, mapping) {
    for (const field of Array.from(rowEl?.querySelectorAll?.(".crc-form-tabularrow") ?? [])) {
      const dropdowns = Array.from(field.querySelectorAll("lyte-dropdown"));
      if (mapping.dateId) {
        const dropdown = dropdowns.find((item) => getTabularDropdownId(item).includes(mapping.dateId));
        if (dropdown) return { field: dropdown };
        continue;
      }
      const label = normalizeZohoText(field.querySelector("label")?.textContent);
      if (!mapping.labelPattern?.test(label)) continue;
      if (dropdowns.length > 0) {
        const dropdown = dropdowns.find((item) => !isTabularDateDropdown(item));
        if (dropdown) return { field: dropdown };
        continue;
      }
      if (!getPrimaryZohoControl(field)) continue;
      return { field };
    }
    return null;
  }
  async function addTabularRow(container) {
    const addButton = container?.querySelector?.("button.tabular-group-add, .crc-tabular-add button, button.crc-tabular-add");
    if (!addButton) return;
    triggerMouseEvent(addButton, "mousedown");
    triggerMouseEvent(addButton, "mouseup");
    addButton.click();
    await sleep(600);
  }

  const SECTION_DATE_MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  // BCD stores Profile.education/.experience dates as a raw month-input string ("2022-01"), or
  // "" for ongoing — split into the separate month/year leaves Zoho's own date dropdowns use.
  function parseSectionDate(raw) {
    const text = String(raw || "").trim();
    const match = /^(\d{4})-(\d{1,2})$/.exec(text);
    if (!match) return { year: "", month: "" };
    return { year: match[1], month: String(parseInt(match[2], 10)) };
  }
  const monthFromRaw = (raw) => parseSectionDate(raw).month;
  const yearFromRaw = (raw) => parseSectionDate(raw).year;
  // Zoho's own month dropdown options are 3-letter abbreviations ("Jan", "Feb", …) — confirmed
  // against BidHub's own getZohoMonthDisplay (MONTH_NAMES[i].slice(0, 3)), not full month
  // names, despite this being a guess worth flagging if Zoho's real markup differs.
  function monthNumToName(monthNum) {
    const index = parseInt(monthNum, 10);
    return index >= 1 && index <= 12 ? SECTION_DATE_MONTH_NAMES[index - 1].slice(0, 3) : "";
  }

  function createZohoTabularSection({ rootFieldId, rootQuestion, profileSection, titlePattern, rowLabel, mappings }) {
    return {
      rootFieldId,
      rootQuestion,
      profileSection,
      rowLabel,
      maxEntries: 10,
      rowGrowthTimeoutMs: 800,
      getContainer: () => findTabularSectionContainer(titlePattern),
      getRows: getTabularRows,
      getRowField: getTabularRowField,
      addRow: addTabularRow,
      // NO clearRows — Zoho's tabular rows can't be deleted programmatically.
      mappings,
    };
  }

  const ZOHO_EDUCATION_SECTION = createZohoTabularSection({
    rootFieldId: "educationHistory",
    rootQuestion: "Education",
    profileSection: "education",
    titlePattern: /Educational Details/i,
    rowLabel: (rowIndex) => `Education ${rowIndex + 1}`,
    mappings: [
      { key: "school", labelPattern: /institute|school/i, fieldKind: "text", question: "Institute", label: "Institute", profileKey: "school" },
      // No `major` field on BCD's Profile.education schema (school/degree/start/end only) —
      // still detected (shows in the review list), it just has nothing to auto-fill from.
      { key: "major", labelPattern: /major|department|discipline/i, fieldKind: "text", question: "Major", label: "Major" },
      { key: "degree", labelPattern: /degree/i, fieldKind: "text", question: "Degree", label: "Degree", profileKey: "degree" },
      { key: "fromMonth", dateId: "from_month", fieldKind: "dropdown", question: "From Month", label: "From Month", resolveValue: (entry) => monthNumToName(monthFromRaw(entry?.start)) },
      { key: "fromYear", dateId: "from_year", fieldKind: "dropdown", question: "From Year", label: "From Year", resolveValue: (entry) => yearFromRaw(entry?.start) },
      { key: "toMonth", dateId: "to_month", fieldKind: "dropdown", question: "To Month", label: "To Month", resolveValue: (entry) => monthNumToName(monthFromRaw(entry?.end)) },
      { key: "toYear", dateId: "to_year", fieldKind: "dropdown", question: "To Year", label: "To Year", resolveValue: (entry) => yearFromRaw(entry?.end) },
      {
        key: "current",
        labelPattern: /currently|pursuing|present/i,
        fieldKind: "checkbox",
        question: "Currently pursuing",
        label: "Currently pursuing",
        resolveValue: (entry) => !String(entry?.end || "").trim(),
      },
    ],
  });

  const ZOHO_WORK_HISTORY_SECTION = createZohoTabularSection({
    rootFieldId: "workHistory",
    rootQuestion: "Work History",
    profileSection: "experience",
    titlePattern: /Experience Details/i,
    rowLabel: (rowIndex) => `Work history ${rowIndex + 1}`,
    mappings: [
      { key: "title", labelPattern: /occupation|title/i, fieldKind: "text", question: "Title", label: "Title", profileKey: "role" },
      { key: "company", labelPattern: /company|employer/i, fieldKind: "text", question: "Company", label: "Company", profileKey: "company" },
      // No BCD equivalent (summary/description narrative) — detected only.
      { key: "summary", labelPattern: /summary|description|responsibilities/i, fieldKind: "textarea", question: "Summary", label: "Summary" },
      { key: "fromMonth", dateId: "from_month", fieldKind: "dropdown", question: "From Month", label: "From Month", resolveValue: (entry) => monthNumToName(monthFromRaw(entry?.start)) },
      { key: "fromYear", dateId: "from_year", fieldKind: "dropdown", question: "From Year", label: "From Year", resolveValue: (entry) => yearFromRaw(entry?.start) },
      { key: "toMonth", dateId: "to_month", fieldKind: "dropdown", question: "To Month", label: "To Month", resolveValue: (entry) => monthNumToName(monthFromRaw(entry?.end)) },
      { key: "toYear", dateId: "to_year", fieldKind: "dropdown", question: "To Year", label: "To Year", resolveValue: (entry) => yearFromRaw(entry?.end) },
      {
        key: "current",
        labelPattern: /currently|present|current/i,
        fieldKind: "checkbox",
        question: "Current",
        label: "Current",
        resolveValue: (entry) => !String(entry?.end || "").trim(),
      },
    ],
  });

  const ZOHO_TABULAR_SECTIONS = [ZOHO_EDUCATION_SECTION, ZOHO_WORK_HISTORY_SECTION];

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections(ZOHO_TABULAR_SECTIONS, profileData);
  }

  // Reuses this file's own generic per-field-kind fillers (fillTextInput/getTextarea/
  // fillZohoDropdown/getCheckboxInputs) — a row's own field is the same widget shape as its
  // top-level counterpart, just resolved by label text / dropdown id instead of a stable id.
  async function fillSectionLeaf(field, mapping, value) {
    switch (mapping.fieldKind) {
      case "text": {
        const input = getVisibleTextInput(field);
        if (input) fillTextInput(input, String(value));
        return;
      }
      case "textarea": {
        const textarea = getTextarea(field);
        if (textarea) fillTextInput(textarea, String(value));
        return;
      }
      case "dropdown":
        await fillZohoDropdown(value, field);
        return;
      case "checkbox": {
        const checkbox = getCheckboxInputs(field)[0];
        if (checkbox && checkbox.checked !== Boolean(value)) checkbox.click();
        return;
      }
      default:
        return;
    }
  }

  async function fillSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    const results = [];
    for (const section of ZOHO_TABULAR_SECTIONS) {
      const entries = (profileData && profileData[section.profileSection]) || [];
      if (!entries.length) continue;
      const result = await SECTION_HIERARCHY.fillSection(section, entries, fillSectionLeaf);
      results.push({ rootFieldId: section.rootFieldId, ...result });
    }
    return results;
  }

  NS.zohorecruit = {
    isAutofillAvailable,
    advance,
    detectFields,
    fillField,
    getSubmitButton,
    detectSubmitButton,
    detectSections,
    fillSections,
  };
})();
