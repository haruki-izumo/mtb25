/* =====================================================================
 * autofill/sites/ripplehire-autofill.js — RippleHire ATS
 * (<tenant>.ripplehire.com/candidate/?token=<T>#detail/job/<seq>).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/ripplehire/autofill.js. Per
 * BidHub's own live-inspection notes (UST tenant, 2026-09-30):
 *
 *   - A Backbone hash router renders the posting (#detail/job/<seq>,
 *     `#btn-apply`/`#mob-btn-apply` "Apply Now") and the application
 *     (#apply/job/<seq>) into the SAME document. Some tenants gate the
 *     form behind a privacy notice (`button#accept` "I Agree") and/or a
 *     duplicate-applicant pre-form that reuses the final form's own ids
 *     (`form#savecandidate` / `#btn-submit-app`) but labels its button
 *     "Continue" instead of "Submit Application" — so the real submit
 *     is recognised by LABEL, never by id alone.
 *   - Every question is a `div.form-group[.required][.hide]` with a
 *     `label.control-label` ("Label :" — the colon is markup) and the
 *     control(s) inside. `.hide` groups are revealed by a `.decider`
 *     radio (e.g. an Employee ID field after "worked here before?" =
 *     Yes) — they're skipped here and picked up by a later detect pass
 *     once the page un-hides them.
 *   - Per-widget quirks ported below: intl-tel-input phone (national
 *     digits only, dial code read off the selected flag), Google Places
 *     city autocomplete (a blur with no committed place clears the
 *     field; only the keyboard path — ArrowDown + Enter — actually
 *     commits a pick), uniform.js-wrapped radios/checkboxes (the native
 *     input underneath still takes the click), a Jasny fileinput résumé
 *     slot (3 MB limit, no upload XHR — the file posts with the form),
 *     bootstrap-datepicker, bootstrap-multiselect (lazy-loaded options),
 *     and jquery.tokeninput skills tags.
 *
 * OUT OF SCOPE (left to Big Banana's own existing systems, untouched):
 *   - Free-text screening-question ANSWER GENERATION and the
 *     embedding-similarity fallback BidHub's own findBestOption() used
 *     for a loose option match. findBestOption() below is deliberately
 *     exact/numeric/prefix/contains ONLY — same AI boundary lever.js and
 *     bamboohr.js keep. A field this can't place deterministically is
 *     left as-is rather than guessed or synthesized.
 *   - packages/job-parsers/shared/password-answer.js (masking a VALUE
 *     for a "create/confirm password" field for panel display) — that's
 *     answer-generation/display plumbing, not structural detection, and
 *     this file never synthesizes a password value.
 *   - packages/job-parsers/shared/dependent-question.js — BidHub tags
 *     each detected question with `dependsOnPrevious` purely so its own
 *     background can sequence/withhold an AI-generated answer for a
 *     follow-up question. Nothing here classifies a field's STRUCTURE
 *     any differently because of it, so it isn't ported.
 *   - CAPTCHA. Some tenants render a reCAPTCHA v2 checkbox
 *     (`#g-recaptcha`); BidHub's own captcha-shared.js solver is
 *     entirely unported. This file never looks for it — Submit is just
 *     clicked like any other button, same as lever.js's hCaptcha note.
 *   - Proxy/remote-CDP "real input" lanes — not present here either;
 *     every fill goes through window.ProactiveAutofillEngine's synthetic
 *     DOM path.
 *   - BidHub's own background calls for a résumé/cover-letter FILE
 *     (getResumeForAutofill/getCoverLetterForAutofill) — a caller here
 *     supplies the already-resolved `{type:"file", fileName, base64,
 *     mimeType}` object directly, same convention as lever.js/
 *     bamboohr.js.
 *   - BidHub throws on an unfillable required field (bad phone shape,
 *     no Places match, no datepicker match, oversize résumé, …) so its
 *     background can surface the failure. This file follows house
 *     style instead (lever.js/bamboohr.js never throw from fillField)
 *     and just leaves the control untouched on a miss.
 * ===================================================================== */
(function () {
  "use strict";

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    sleep,
    fillTextInput,
    fillTextInputReliably,
    fillTextInputLikeHuman,
    fillFileInput,
    fillSelectInput,
    clickLikeHuman,
    getCheckboxInputs,
    getRadioInputs,
  } = engine;

  // ---- selectors / constants --------------------------------------------

  const FORM_SELECTOR = "form#savecandidate";
  const SUBMIT_SELECTOR = "#btn-submit-app";
  const PRIVACY_ACCEPT_SELECTOR = "button#accept";
  const APPLY_BUTTON_SELECTOR = "#btn-apply, #mob-btn-apply";
  const FORM_GROUP_SELECTOR = ".form-group";
  const CONTROL_LABEL_SELECTOR = "label.control-label";
  const PHONE_INPUT_SELECTOR = '.intl-tel-input input:not([type="hidden"]), input.phone';
  const PLACES_INPUT_SELECTOR = "input.pac-target-input, input#currentLocation";
  const PAC_ITEM_SELECTOR = ".pac-container .pac-item";
  const DATE_INPUT_SELECTOR = "input.datepicker";
  const FILEINPUT_WIDGET_SELECTOR = '.fileinput[data-provides="fileinput"]';
  const MULTISELECT_WRAPPER_SELECTOR = ".multi-select";
  const TOKEN_INPUT_WRAPPER_SELECTOR = '[id$="-autocomplete"]';
  const TEXT_INPUT_SELECTOR =
    'input.form-control:not([type="hidden"]):not([type="file"]):not([type="radio"]):not([type="checkbox"]):not([type="submit"]):not([type="button"])';

  const CONTINUE_LABEL_PATTERN = /^continue$/i;
  const NUMERIC_FIELD_PATTERN = /ctc|billrate|bill_rate|salary|compensation|expectedpay|currentpay/i;
  const YES_NO_OPTIONS = ["Yes", "No"];
  const AFFIRMATIVE_ANSWERS = new Set(["yes", "y", "true", "on", "checked", "agree", "accept", "i agree", "1"]);
  const NEGATIVE_ANSWERS = new Set(["no", "n", "false", "off", "unchecked", "decline", "disagree", "none", "0"]);
  const PHONE_NATIONAL_PATTERN = /^\d{8,15}$/;
  const SHARED_DIAL_PREFERENCE = ["us", "ca", "gb", "in", "ru", "kz"];
  const MAX_RESUME_BYTES = 3 * 1024 * 1024; // the portal's own upload limit
  const DEFAULT_DATE_FORMAT = "dd-M-yyyy";
  const DATEPICKER_MAX_MONTH_STEPS = 36;
  const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MONTH_LONG = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  const ADVANCE_CHAIN_WAIT_MS = 5000;
  const WIDGET_SETTLE_MS = 150;
  const DROPDOWN_WAIT_TIMEOUT_MS = 5000;
  const PLACES_ATTACH_WAIT_MS = 8000;
  const PLACES_SUGGESTION_WAIT_MS = 5000;
  const PLACES_COMMIT_WAIT_MS = 4000;
  const PLACES_KEY_GAP_MS = 150;
  const PLACES_SETTLE_MS = 1500;
  const PLACES_BLUR_CHECK_MS = 400;
  const PLACES_TYPING_OPTIONS = { perCharDelayMs: 40, maxTotalTypingMs: 2500 };
  const FILE_SETTLE_WAIT_MS = 5000;

  // ---- small local polling helper (BidHub's waitForPositiveResultWithAbort,
  // trimmed the same way bamboohr-autofill.js's local waitFor() is — no
  // shouldAbort plumbing beyond what the caller passes straight through) ---
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

  // ---- text helpers -------------------------------------------------------

  function cleanText(value) {
    return String(value ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/[✱*]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function slugify(value) {
    return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function cssAttrValue(value) {
    return String(value ?? "").replace(/["\\[\]]/g, "\\$&");
  }
  // "Label :" / "Label:" → "Label".
  function stripLabelColon(text) {
    return cleanText(text).replace(/\s*:\s*$/, "");
  }
  function labelOf(button) {
    return cleanText(button?.textContent || button?.getAttribute?.("aria-label") || button?.value || "");
  }

  // ---- visibility / page model --------------------------------------------

  // Bootstrap's `.hide` class (decider-controlled groups, a closed country
  // list) plus a plain computed-style check.
  function isShown(element) {
    if (!element?.isConnected) return false;
    if (element.closest(".hide, [hidden]")) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }
  function getVisibleForm() {
    const form = document.querySelector(FORM_SELECTOR);
    return form && isShown(form) ? form : null;
  }
  function getPrivacyAcceptButton() {
    const button = document.querySelector(PRIVACY_ACCEPT_SELECTOR);
    return button && isShown(button) ? button : null;
  }
  function getApplyButton() {
    return Array.from(document.querySelectorAll(APPLY_BUTTON_SELECTOR)).find(isShown) || null;
  }
  // The duplicate-check pre-form reuses the submit button's id with a
  // "Continue" label — an advance step, not the final submit.
  function getFormSubmitControl() {
    const button = getVisibleForm()?.querySelector(SUBMIT_SELECTOR);
    return button && isShown(button) ? button : null;
  }
  function getContinueButton() {
    const button = getFormSubmitControl();
    return button && CONTINUE_LABEL_PATTERN.test(labelOf(button)) ? button : null;
  }
  function getRippleHireSubmitButton() {
    const button = getFormSubmitControl();
    return button && !CONTINUE_LABEL_PATTERN.test(labelOf(button)) ? button : null;
  }

  // Forward control, in order: the privacy gate's "I Agree", the duplicate
  // pre-form's "Continue", the posting's "Apply Now". Never the final
  // submit and never "I Don't Agree".
  function getAdvanceTarget() {
    if (getRippleHireSubmitButton()) return null;
    return getPrivacyAcceptButton() || getContinueButton() || getApplyButton();
  }

  // The hash-router nature the detection file's getRippleHireRoute() also
  // keys off: the application FORM only exists under #apply/job/<seq>
  // (getVisibleForm()); the privacy gate and the posting's own Apply button
  // are field-less but still actionable steps toward it.
  function isAutofillAvailable() {
    return Boolean(getVisibleForm() || getPrivacyAcceptButton() || getApplyButton());
  }

  function getSubmitButton() {
    return getRippleHireSubmitButton();
  }
  async function clickSubmitButton({ shouldAbort = () => false } = {}) {
    const button = getSubmitButton();
    if (!button || shouldAbort()) return false;
    await clickLikeHuman(button, { shouldAbort });
    return true;
  }

  // One logical advance step: posting → (privacy gate, same click-chain) →
  // form, OR the duplicate pre-form's "Continue" → form. Hash-only routing
  // keeps this content-script context alive across all of it, so a single
  // "Apply Now" press is chained straight into the gate when the tenant
  // shows one — otherwise nothing would ever accept it and the form would
  // never open. Never clicks the final Submit.
  async function advance({ shouldAbort = () => false } = {}) {
    const target = getAdvanceTarget();
    if (!target || shouldAbort()) return false;
    const wasApply = target.matches(APPLY_BUTTON_SELECTOR);
    await clickLikeHuman(target, { shouldAbort });
    if (wasApply) {
      const accept = await waitFor(
        () => getPrivacyAcceptButton() || (getVisibleForm() ? true : null),
        ADVANCE_CHAIN_WAIT_MS,
        shouldAbort
      );
      if (accept && accept !== true) await clickLikeHuman(accept, { shouldAbort });
    }
    return true;
  }

  // ---- group / label helpers ----------------------------------------------

  // Direct child only — a nested `.control-label` span sits inside checkbox
  // labels too, and a naive descendant query would grab that instead.
  function getGroupLabel(group) {
    const label = Array.from(group.children).find((child) => child.matches(CONTROL_LABEL_SELECTOR));
    return stripLabelColon(label?.textContent);
  }
  // A checkbox's own statement ("I have read and understood the EEO
  // statement.") rather than the input node's own (empty) text.
  function checkboxStatement(checkbox) {
    const label = checkbox.closest("label");
    return cleanText(label?.textContent || checkbox.labels?.[0]?.textContent || checkbox.value);
  }
  function radioOptionText(radio) {
    const label = radio.closest("label");
    return cleanText(label?.textContent) || cleanText(radio.value);
  }
  // Required = the group's own `.required` class, the control's `required`
  // class/property (the template stamps both), or a select's data-required="Y".
  function isRequiredControl(group, control = null) {
    if (group?.classList?.contains("required")) return true;
    if (!control) return false;
    return Boolean(control.classList?.contains("required") || control.required || control.getAttribute?.("data-required") === "Y");
  }
  function isNumericField(input) {
    return (
      input.getAttribute("inputmode") === "numeric" ||
      input.type === "number" ||
      NUMERIC_FIELD_PATTERN.test(input.name || input.id || "") ||
      /autonumeric|currency|numeric/i.test(input.className || "")
    );
  }
  // "Total experience" holds a Year select and a Month select under ONE
  // label — distinguish them by their own placeholder option ("Select
  // Year" → "Year") so the two don't collide as the same question.
  function selectQuestion(baseQuestion, select, siblingCount) {
    if (siblingCount < 2) return baseQuestion;
    const placeholder = cleanText(Array.from(select.options).find((o) => cleanText(o.value) === "")?.textContent);
    const unit = placeholder.replace(/^(select|choose)\s+/i, "");
    return unit && unit.length <= 30 ? `${baseQuestion} (${unit})` : baseQuestion;
  }
  // Native <select>: the placeholder option ("Select Year", "What is your
  // veteran status?") carries an empty value; everything else is real.
  function readSelectOptions(select) {
    return Array.from(select?.options ?? [])
      .filter((option) => !option.disabled && cleanText(option.value) !== "")
      .map((option) => ({ element: option, text: cleanText(option.textContent) || cleanText(option.value), value: option.value }))
      .filter((option) => option.text);
  }
  function isResumeField(question, control) {
    return /r[ée]sum[ée]|\bcv\b|curriculum/i.test(question) || /resume|\bcv\b/i.test(control?.name ?? "");
  }
  function isCoverLetterField(question, control) {
    return /cover\s*letter|covering letter|motivation letter/i.test(question) || /cover/i.test(control?.name ?? "");
  }

  // ---- live re-resolution --------------------------------------------------
  // The SPA re-renders the form (the dup-check step, a `.decider` toggle) —
  // a fill-time lookup never trusts the detection-time node when a live one
  // by the same `name` still exists.
  function getLiveControl(fieldId) {
    if (!fieldId) return null;
    return getVisibleForm()?.querySelector(`[name="${cssAttrValue(fieldId)}"]`) || null;
  }
  function getLiveControls(fieldId) {
    if (!fieldId) return [];
    return Array.from(getVisibleForm()?.querySelectorAll(`[name="${cssAttrValue(fieldId)}"]`) ?? []);
  }
  function getLiveGroup(fieldId, fallbackField) {
    return getLiveControl(fieldId)?.closest(FORM_GROUP_SELECTOR) || fallbackField;
  }

  // ---- option matching -----------------------------------------------------
  // Exact → numeric (an all-integer option list: "7 years" → 7) → prefix →
  // contains. Deliberately NOT BidHub's embedding/LLM fallback for anything
  // looser than that — same AI boundary lever.js/bamboohr.js keep. Returns
  // null (never guesses) when nothing fits.
  function isIntegerText(text) {
    return /^-?\d+$/.test(cleanText(text));
  }
  function findBestOption(answer, options) {
    const want = cleanText(answer).toLowerCase();
    if (!want || !options.length) return null;
    const exact = options.find((o) => o.text.toLowerCase() === want);
    if (exact) return exact;
    if (options.every((o) => isIntegerText(o.text))) {
      const number = want.match(/-?\d+(?:\.\d+)?/);
      if (number) {
        const wanted = Math.round(Number(number[0]));
        const numeric = options.find((o) => Number(o.text) === wanted);
        if (numeric) return numeric;
      }
    }
    return options.find((o) => o.text.toLowerCase().startsWith(want)) || options.find((o) => o.text.toLowerCase().includes(want)) || null;
  }
  function normalizeYesNo(answer, options) {
    const texts = options.map((o) => o.text.toLowerCase());
    if (!texts.includes("yes") || !texts.includes("no")) return answer;
    if (typeof answer === "boolean") return answer ? "Yes" : "No";
    const want = cleanText(answer).toLowerCase();
    if (AFFIRMATIVE_ANSWERS.has(want)) return "Yes";
    if (NEGATIVE_ANSWERS.has(want)) return "No";
    return answer;
  }
  function isAffirmativeAnswer(answer) {
    if (typeof answer === "boolean") return answer;
    const text = cleanText(answer).toLowerCase();
    return Boolean(text) && !NEGATIVE_ANSWERS.has(text);
  }

  // ---- field detection ------------------------------------------------------

  /**
   * Walk RippleHire's visible application form and return every question
   * this adapter knows how to fill deterministically. Anything it can't
   * classify (an unrecognized file slot) is left out entirely, per the
   * same "left alone for Big Banana's own pipeline" convention lever.js/
   * bamboohr.js use. Human-only widgets (live-photo capture, a DPDP
   * consent card, a CV-parser popup, skills pickers) and any reCAPTCHA are
   * never surfaced at all — out of scope per the file header.
   *
   * @returns {Array<{question:string, fieldId:string, fieldKind:string,
   *   field:Element, control:Element|null, options:string[]|null, required:boolean}>}
   */
  function detectFields() {
    const form = getVisibleForm();
    if (!form) return [];

    const usedFieldIds = new Set();
    const uniqueFieldId = (base) => {
      let candidate = base;
      let n = 2;
      while (usedFieldIds.has(candidate)) candidate = `${base}-${n++}`;
      usedFieldIds.add(candidate);
      return candidate;
    };
    const entries = [];
    const addEntry = (entry) => {
      if (!entry.question || !entry.field) return;
      entries.push({ options: null, ...entry, fieldId: uniqueFieldId(entry.fieldId || slugify(entry.question) || "question") });
    };

    // The template also stamps `form-group` on some checkbox INPUTS directly
    // — nested groups go through their parent; `.hide` groups wait for their
    // decider.
    const groups = Array.from(form.querySelectorAll(FORM_GROUP_SELECTOR)).filter(
      (group) => group.tagName === "DIV" && !group.parentElement?.closest(FORM_GROUP_SELECTOR) && isShown(group)
    );

    for (const group of groups) {
      const label = getGroupLabel(group);
      const slug = slugify(label) || "question";
      const required = (control) => isRequiredControl(group, control);

      // Résumé / cover letter / other document — Jasny fileinput around a
      // plain file input.
      const fileInput = group.querySelector('input[type="file"]');
      if (fileInput) {
        const isCoverLetter = isCoverLetterField(label, fileInput);
        const isResume = isResumeField(label, fileInput);
        addEntry({
          question: label || (isResume ? "Upload resume" : "Upload file"),
          fieldId: fileInput.getAttribute("name") || fileInput.id || `file:${slug}`,
          field: group,
          control: fileInput,
          fieldKind: isCoverLetter ? "cover_letter" : isResume ? "resume" : "file",
          required: required(fileInput),
        });
        continue;
      }

      // Phone — intl-tel-input: national digits only, dial code from the flag.
      const phoneInput = group.querySelector(PHONE_INPUT_SELECTOR);
      if (phoneInput) {
        addEntry({
          question: label || "Phone",
          fieldId: phoneInput.getAttribute("name") || phoneInput.id || `phone:${slug}`,
          field: group,
          control: phoneInput,
          fieldKind: "phone",
          required: required(phoneInput),
        });
        continue;
      }

      // City — Google Places autocomplete.
      const placesInput = group.querySelector(PLACES_INPUT_SELECTOR);
      if (placesInput) {
        addEntry({
          question: label || "City",
          fieldId: placesInput.getAttribute("name") || placesInput.id || `places:${slug}`,
          field: group,
          control: placesInput,
          fieldKind: "places",
          required: required(placesInput),
        });
        continue;
      }

      // bootstrap-datepicker.
      const dateInput = group.querySelector(DATE_INPUT_SELECTOR);
      if (dateInput) {
        addEntry({
          question: label || "Date",
          fieldId: dateInput.getAttribute("name") || dateInput.id || `date:${slug}`,
          field: group,
          control: dateInput,
          fieldKind: "datepicker",
          required: required(dateInput),
        });
        continue;
      }

      // Radio groups (uniform.js-wrapped) — one question per radio `name`.
      // A `.decider` toggles dependent groups; re-detection picks those up
      // once the page un-hides them.
      const radios = getRadioInputs(group);
      if (radios.length) {
        const byName = new Map();
        for (const radio of radios) {
          const name = radio.getAttribute("name") || `radio:${slug}`;
          if (!byName.has(name)) byName.set(name, []);
          byName.get(name).push(radio);
        }
        for (const [name, inputs] of byName) {
          const options = inputs.map(radioOptionText).filter(Boolean);
          addEntry({
            question: label || name,
            fieldId: name,
            field: group,
            control: inputs[0],
            fieldKind: "radio",
            options: options.length ? options : YES_NO_OPTIONS,
            required: required(inputs[0]),
          });
        }
        continue;
      }

      // Checkboxes (uniform.js-wrapped): a declaration/terms/lone consent
      // box is really a Yes/No question phrased as its own statement;
      // several boxes with distinct values are a genuine multi-select.
      const checkboxes = getCheckboxInputs(group);
      if (checkboxes.length) {
        const distinctValues = new Set(checkboxes.map((cb) => cb.value));
        const isDeclaration = Boolean(group.querySelector(".declaration")) || checkboxes.length === 1 || distinctValues.size < 2;
        if (isDeclaration) {
          for (const checkbox of checkboxes) {
            const statement = checkboxStatement(checkbox);
            const name = checkbox.getAttribute("name") || checkbox.id || `checkbox:${slug}`;
            addEntry({
              question: label && statement ? `${label}: ${statement}` : statement || label || name,
              fieldId: name,
              field: group,
              control: checkbox,
              fieldKind: "checkbox-single",
              options: YES_NO_OPTIONS,
              required: required(checkbox),
            });
          }
        } else {
          const name = checkboxes[0].getAttribute("name") || `checkboxes:${slug}`;
          addEntry({
            question: label || name,
            fieldId: name,
            field: group,
            control: checkboxes[0],
            fieldKind: "checkbox",
            options: checkboxes.map((cb) => checkboxStatement(cb) || cb.value).filter(Boolean),
            required: required(checkboxes[0]),
          });
        }
        continue;
      }

      // Native selects (one label may hold two — experience years + months)
      // and bootstrap-multiselect.
      const selects = Array.from(group.querySelectorAll("select"));
      if (selects.length) {
        for (const select of selects) {
          const name = select.getAttribute("name") || select.id || `select:${slug}`;
          const options = readSelectOptions(select).map((o) => o.text);
          if (select.closest(MULTISELECT_WRAPPER_SELECTOR) || select.multiple) {
            addEntry({
              question: label || name,
              fieldId: name,
              field: group,
              control: select,
              fieldKind: "multiselect",
              options: options.length ? options : null, // lazy-loaded — fetchMultiselectOptions() probes it
              required: required(select),
            });
          } else {
            addEntry({
              question: selectQuestion(label || name, select, selects.length),
              fieldId: name,
              field: group,
              control: select,
              fieldKind: "select-native",
              options,
              required: required(select),
            });
          }
        }
        continue;
      }

      const textarea = group.querySelector("textarea");
      if (textarea) {
        addEntry({
          question: label || textarea.getAttribute("name") || "Details",
          fieldId: textarea.getAttribute("name") || textarea.id || `textarea:${slug}`,
          field: group,
          control: textarea,
          fieldKind: "textarea",
          required: required(textarea),
        });
        continue;
      }

      // jquery.tokeninput skills: a hidden value input inside `#<name>-autocomplete`.
      const tokenWrapper = group.querySelector(TOKEN_INPUT_WRAPPER_SELECTOR);
      const tokenValue = tokenWrapper?.querySelector('input[type="hidden"][name]');
      if (tokenWrapper && tokenValue) {
        addEntry({
          question: label || tokenValue.getAttribute("name"),
          fieldId: tokenValue.getAttribute("name"),
          field: group,
          control: tokenValue,
          fieldKind: "tokeninput",
          required: required(tokenValue),
        });
        continue;
      }

      const input = group.querySelector(TEXT_INPUT_SELECTOR);
      if (input && label) {
        addEntry({
          question: label,
          fieldId: input.getAttribute("name") || input.id || `text:${slug}`,
          field: group,
          control: input,
          fieldKind: isNumericField(input) ? "numeric" : "text",
          required: required(input),
        });
      }
      // Label-only groups (privacy text, consent copy, the submit row) are
      // not questions — fall through with nothing added.
    }
    return entries;
  }

  // ---- fill primitives ------------------------------------------------------

  // jQuery/Backbone form: the React-safe writer still works fine here (it's
  // just a native setter + input/change/blur events, nothing React-specific
  // about it) — then an explicit `change` so the page's own validators and
  // stickit bindings see it, mirroring BidHub's own setNativeValue().
  async function fillAndNotify(control, value, { shouldAbort = () => false } = {}) {
    await fillTextInputReliably(control, value, { shouldAbort });
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function fillText(fieldId, field, answer, opts) {
    if (answer == null) return false;
    const group = getLiveGroup(fieldId, field);
    const control = getLiveControl(fieldId) || group?.querySelector(`${TEXT_INPUT_SELECTOR}, textarea`);
    if (!control) return false;
    await fillAndNotify(control, String(answer), opts);
    return true;
  }
  // autoNumeric currency/plain-numeric inputs on this ATS (CTC, bill rate,
  // salary, …) reject everything but digits and one dot.
  async function fillNumeric(fieldId, field, answer, opts) {
    const digits = String(answer ?? "").replace(/[^\d.]/g, "").replace(/^(\d*\.\d*).*$/, "$1");
    if (!digits) return false;
    const control = getLiveControl(fieldId) || getLiveGroup(fieldId, field)?.querySelector(TEXT_INPUT_SELECTOR);
    if (!control) return false;
    await fillAndNotify(control, digits, opts);
    return true;
  }

  async function fillSelectNative(fieldId, field, answer) {
    const want = cleanText(answer);
    const select = getLiveControl(fieldId) || getLiveGroup(fieldId, field)?.querySelector("select");
    if (!want || !select || select.tagName !== "SELECT") return false;
    const options = readSelectOptions(select);
    const chosen = findBestOption(normalizeYesNo(want, options), options);
    if (!chosen) return false; // no deterministic match — leave it for the generic pipeline
    if (select.value !== chosen.value) fillSelectInput(select, chosen.value);
    select.dispatchEvent(new Event("blur"));
    return true;
  }

  // ---- bootstrap-multiselect over a native <select> --------------------------
  // Options may load lazily on first open; the native option's `selected`
  // state is what the form actually posts, so the plugin's own checkbox is
  // clicked too only so its button label follows along.
  function getMultiselectContainer(select) {
    if (select.nextElementSibling?.classList?.contains("btn-group")) return select.nextElementSibling;
    const wrapper = select.closest(MULTISELECT_WRAPPER_SELECTOR) || select.parentElement;
    return wrapper?.querySelector(".btn-group") || null;
  }
  async function openMultiselect(select, shouldAbort) {
    const container = getMultiselectContainer(select);
    const button = container?.querySelector("button.multiselect, button.dropdown-toggle");
    if (!button) return null;
    if (!container.classList.contains("open")) {
      await clickLikeHuman(button, { shouldAbort });
      await sleep(WIDGET_SETTLE_MS);
    }
    return container;
  }
  async function closeMultiselect(select) {
    const container = getMultiselectContainer(select);
    if (container?.classList.contains("open")) container.querySelector("button.multiselect, button.dropdown-toggle")?.click();
  }
  /** The option list a bootstrap-multiselect field currently offers — for a
   *  caller that wants the real choices before resolving an answer (same
   *  role as bamboohr-autofill.js's fetchSelectOptions). */
  async function fetchMultiselectOptions(entry, { shouldAbort = () => false } = {}) {
    const select = getLiveControl(entry.fieldId) || getLiveGroup(entry.fieldId, entry.field)?.querySelector("select");
    if (!select) return entry.options;
    let options = readSelectOptions(select);
    if (!options.length) {
      await openMultiselect(select, shouldAbort);
      options = (await waitFor(() => {
        const found = readSelectOptions(select);
        return found.length ? found : null;
      }, DROPDOWN_WAIT_TIMEOUT_MS, shouldAbort)) || [];
      await closeMultiselect(select);
    }
    return options.length ? options.map((o) => o.text) : entry.options;
  }
  async function fillMultiselect(fieldId, field, answer, { shouldAbort = () => false } = {}) {
    const select = getLiveControl(fieldId) || getLiveGroup(fieldId, field)?.querySelector("select");
    if (!select) return false;
    // A single <select> behind the plugin takes ONE value; splitting a
    // free-text answer on commas would shred an option like "Asian (Not
    // Hispanic or Latino)", so only a real array answer is split.
    const listed = Array.isArray(answer) ? answer : select.multiple ? String(answer ?? "").split(/\s*[,;|]\s*/) : [String(answer ?? "")];
    const values = (select.multiple ? listed : listed.slice(0, 1)).map(cleanText).filter(Boolean);
    if (!values.length) return false;

    let options = readSelectOptions(select);
    if (!options.length) {
      await openMultiselect(select, shouldAbort);
      options = (await waitFor(() => {
        const found = readSelectOptions(select);
        return found.length ? found : null;
      }, DROPDOWN_WAIT_TIMEOUT_MS, shouldAbort)) || [];
    }
    let changed = false;
    for (const want of values) {
      if (shouldAbort()) return changed;
      const chosen = findBestOption(want, options);
      if (!chosen || chosen.element.selected) continue;
      const container = getMultiselectContainer(select);
      const pluginBox = container?.querySelector(`input[type="checkbox"][value="${cssAttrValue(chosen.value)}"]`);
      if (pluginBox) {
        if (!container.classList.contains("open")) await openMultiselect(select, shouldAbort);
        pluginBox.click();
      }
      if (!chosen.element.selected) chosen.element.selected = true;
      changed = true;
    }
    if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
    await closeMultiselect(select);
    return changed;
  }

  // uniform.js radios: the native input (inside `div.radio > span`) still
  // takes the click and fires `change`, which is what toggles any
  // decider-dependent groups.
  async function fillRadio(fieldId, field, answer, opts) {
    if (answer == null) return false;
    const liveRadios = getLiveControls(fieldId).filter((input) => input.type === "radio");
    const inputs = liveRadios.length ? liveRadios : getRadioInputs(getLiveGroup(fieldId, field));
    if (!inputs.length) return false;
    const options = inputs.map((input) => ({ element: input, text: radioOptionText(input), value: input.value }));
    const chosen = findBestOption(normalizeYesNo(answer, options), options);
    if (!chosen) return false;
    if (!chosen.element.checked) await clickLikeHuman(chosen.element, opts);
    return true;
  }

  // Declarations/terms/a lone consent box: a REQUIRED acknowledgement is
  // always checked (the form can't be submitted otherwise); an optional one
  // follows the resolved Yes/No answer.
  async function fillCheckboxSingle(fieldId, field, answer, opts) {
    const checkbox = getLiveControls(fieldId).find((input) => input.type === "checkbox") || getCheckboxInputs(getLiveGroup(fieldId, field))[0];
    if (!checkbox) return false;
    // A REQUIRED declaration/consent box is always checked (the form can't
    // be submitted otherwise), even if the resolved answer was "No" —
    // fillField()'s own null-answer guard already keeps this from firing on
    // a field nothing resolved an answer for at all.
    const required = isRequiredControl(checkbox.closest(FORM_GROUP_SELECTOR), checkbox);
    const shouldCheck = required ? true : isAffirmativeAnswer(answer);
    if (checkbox.checked !== shouldCheck) await clickLikeHuman(checkbox, opts);
    return true;
  }
  async function fillCheckbox(fieldId, field, answer, opts) {
    const values = (Array.isArray(answer) ? answer : String(answer ?? "").split(/\s*[,;|]\s*/)).map((v) => cleanText(v).toLowerCase()).filter(Boolean);
    const liveBoxes = getLiveControls(fieldId).filter((input) => input.type === "checkbox");
    const inputs = liveBoxes.length ? liveBoxes : getCheckboxInputs(getLiveGroup(fieldId, field));
    if (!inputs.length) return false;
    for (const checkbox of inputs) {
      const text = (checkboxStatement(checkbox) || checkbox.value).toLowerCase();
      const shouldCheck = values.some((v) => v === text || v === cleanText(checkbox.value).toLowerCase() || text.includes(v));
      if (checkbox.checked !== shouldCheck) await clickLikeHuman(checkbox, opts);
    }
    return true;
  }

  // ---- phone (intl-tel-input) ----------------------------------------------

  function parseCountryItem(item) {
    return {
      element: item,
      iso2: (item.getAttribute("data-country-code") || "").toLowerCase(),
      dial: item.getAttribute("data-dial-code") || "",
      name: cleanText(item.querySelector(".country-name")?.textContent),
    };
  }
  // The country whose dial code prefixes the digits: the longest code wins;
  // a code shared by several countries (+1, +7, +44) keeps the currently
  // selected one when it shares it, else a conventional default, else
  // whatever the widget itself flagged `.preferred`.
  function choosePhoneCountry(items, digits, currentIso2 = "") {
    const matching = items.filter((item) => item.dial && digits.startsWith(item.dial));
    if (!matching.length) return null;
    const longest = Math.max(...matching.map((item) => item.dial.length));
    const candidates = matching.filter((item) => item.dial.length === longest);
    return (
      candidates.find((item) => currentIso2 && item.iso2 === currentIso2) ||
      SHARED_DIAL_PREFERENCE.map((iso2) => candidates.find((item) => item.iso2 === iso2)).find(Boolean) ||
      candidates.find((item) => item.element.classList.contains("preferred")) ||
      candidates[0]
    );
  }
  async function fillPhone(fieldId, field, answer, opts) {
    const raw = cleanText(answer);
    const group = getLiveGroup(fieldId, field);
    const input = getLiveControl(fieldId) || group?.querySelector(PHONE_INPUT_SELECTOR);
    if (!raw || !input) return false;
    // "0044 …" is the same international shape as "+44 …" — normalize the
    // trunk prefix before matching against the dial codes.
    const normalized = raw.replace(/^00(?=\d)/, "+");
    const international = normalized.startsWith("+");
    const digits = normalized.replace(/\D/g, "");
    if (!digits) return false;

    const iti = input.closest(".intl-tel-input") || group?.querySelector(".intl-tel-input");
    let national = digits;
    if (international && iti) {
      const items = Array.from(iti.querySelectorAll("li.country")).map(parseCountryItem);
      const currentIso2 = (iti.querySelector("li.country.active")?.getAttribute("data-country-code") || "").toLowerCase();
      const chosen = choosePhoneCountry(items, digits, currentIso2);
      if (chosen) {
        national = digits.slice(chosen.dial.length);
        if (chosen.iso2 !== currentIso2) {
          const flag = iti.querySelector(".selected-flag");
          flag?.click();
          await sleep(WIDGET_SETTLE_MS);
          chosen.element.click();
          await sleep(WIDGET_SETTLE_MS);
          // The widget hides the list on a pick; still open means the click
          // above didn't register — try the flag toggle once more.
          const list = iti.querySelector(".country-list");
          if (list && !list.classList.contains("hide")) flag?.click();
        }
      }
    }
    if (!PHONE_NATIONAL_PATTERN.test(national)) return false; // not 8–15 national digits — leave it alone
    await fillAndNotify(input, national, opts);
    return true;
  }

  // ---- city (Google Places) ------------------------------------------------

  function isPacItemLaidOut(element) {
    if (!element?.isConnected) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const container = element.closest(".pac-container");
    return !container || window.getComputedStyle(container).display !== "none";
  }
  // Real keyboards fire keypress for Enter but not for the arrow keys; the
  // legacy keyCode/which are set because Google's own autocomplete JS still
  // reads them.
  function dispatchKey(target, key) {
    const keyCode = key === "Enter" ? 13 : key === "ArrowDown" ? 40 : 0;
    const types = key === "Enter" ? ["keydown", "keypress", "keyup"] : ["keydown", "keyup"];
    for (const type of types) {
      target.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true }));
    }
  }
  // The suggestion row that carries the answer's other parts ("Chicago, IL,
  // USA" → IL / USA), else the first row.
  function pickPlaceIndex(items, answer) {
    const rest = cleanText(answer).split(",").map((part) => cleanText(part).toLowerCase()).filter(Boolean).slice(1);
    if (!rest.length) return 0;
    const match = items.findIndex((item) => {
      const text = cleanText(item.textContent).toLowerCase();
      return rest.some((part) => text.includes(part));
    });
    return match >= 0 ? match : 0;
  }
  /**
   * Type the city, wait for Google's suggestions, move the highlight to the
   * wanted row and press Enter — the KEYBOARD path is what commits a real
   * pick (a synthetic click on `.pac-item` does not); an Enter dispatched in
   * the same tick as the arrow key only previews the row's text without
   * selecting it, so each step waits a beat. A value that doesn't survive
   * blur was never actually committed — the page clears an uncommitted City
   * on blur — so that's the fallback verification when the tenant carries
   * no other signal.
   */
  async function fillPlaces(fieldId, field, answer, { shouldAbort = () => false } = {}) {
    const want = cleanText(answer);
    const group = getLiveGroup(fieldId, field);
    const input = getLiveControl(fieldId) || group?.querySelector(PLACES_INPUT_SELECTOR);
    if (!want || !input) return false;
    const required = isRequiredControl(group, input);
    const city = cleanText(want.split(",")[0]);

    // Google's autocomplete attaches AFTER the form renders (the Maps
    // script loads asynchronously) — typing before it's listening would
    // post nothing.
    const isAttached = () => input.classList.contains("pac-target-input") || Boolean(document.querySelector(".pac-container"));
    await waitFor(() => (isAttached() ? true : null), PLACES_ATTACH_WAIT_MS, shouldAbort);
    if (shouldAbort()) return false;

    const typeCity = async () => {
      await clickLikeHuman(input, { shouldAbort });
      if (cleanText(input.value)) fillTextInput(input, "");
      await fillTextInputLikeHuman(input, city, { ...PLACES_TYPING_OPTIONS, blur: false, shouldAbort });
    };
    const findItems = () => {
      const found = Array.from(document.querySelectorAll(PAC_ITEM_SELECTOR)).filter(isPacItemLaidOut);
      return found.length ? found : null;
    };

    await typeCity();
    let items = await waitFor(findItems, PLACES_SUGGESTION_WAIT_MS, shouldAbort);
    if (!items && !shouldAbort()) {
      // One retry in case the widget only finished attaching mid-type.
      await typeCity();
      items = await waitFor(findItems, PLACES_SUGGESTION_WAIT_MS, shouldAbort);
    }
    if (shouldAbort()) return false;
    if (!items) {
      if (!required) fillTextInput(input, "");
      return false;
    }

    const index = pickPlaceIndex(items, want);
    await sleep(PLACES_KEY_GAP_MS);
    for (let step = 0; step <= index && !shouldAbort(); step++) {
      dispatchKey(input, "ArrowDown");
      await sleep(PLACES_KEY_GAP_MS);
    }
    dispatchKey(input, "Enter");

    const isPreviewText = (value) => !value || value.toLowerCase() === city.toLowerCase();
    await sleep(PLACES_SETTLE_MS);
    if (shouldAbort()) return false;
    let committedValue = cleanText(input.value);
    if (isPreviewText(committedValue)) {
      input.blur();
      await sleep(PLACES_BLUR_CHECK_MS);
      committedValue = cleanText(input.value);
    }
    if (isPreviewText(committedValue)) {
      if (!required) fillTextInput(input, "");
      return false;
    }
    return true;
  }

  // ---- dates (bootstrap-datepicker) ----------------------------------------

  function pad2(value) {
    return String(value).padStart(2, "0");
  }
  // Non-date answers ("N/A", "Immediately") parse to null and leave the
  // picker untouched rather than writing garbage into it.
  function parseAnswerDate(raw) {
    const value = cleanText(raw);
    const iso = value.match(/^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?/);
    if (iso) return { year: Number(iso[1]), month: Number(iso[2]) || 1, day: Number(iso[3]) || 1 };
    const numeric = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (numeric) {
      const year = numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3];
      return { year: Number(year), month: Number(numeric[1]), day: Number(numeric[2]) };
    }
    const named = value.match(/^([A-Za-z]+)\s+(?:(\d{1,2}),?\s+)?(\d{4})$/);
    if (named) {
      const monthIndex = MONTH_LONG.findIndex((m) => m.toLowerCase().startsWith(named[1].toLowerCase()));
      if (monthIndex >= 0) return { year: Number(named[3]), month: monthIndex + 1, day: Number(named[2]) || 1 };
    }
    if (/^\d{4}$/.test(value)) return { year: Number(value), month: 1, day: 1 };
    return null;
  }
  // bootstrap-datepicker tokens: d/dd day, m/mm month number, M/MM month name, yy/yyyy year.
  function formatDatepickerValue({ year, month, day }, format = DEFAULT_DATE_FORMAT) {
    const tokens = {
      yyyy: String(year), yy: String(year).slice(-2),
      MM: MONTH_LONG[month - 1], M: MONTH_SHORT[month - 1],
      mm: pad2(month), m: String(month),
      dd: pad2(day), d: String(day),
    };
    return format.replace(/yyyy|yy|MM|M|mm|m|dd|d/g, (token) => tokens[token] ?? token);
  }
  function datepickerFormat(input) {
    const explicit = input.getAttribute("data-date-format");
    if (explicit) return explicit;
    const placeholder = cleanText(input.placeholder);
    if (placeholder && /^[dmyDMY\s./-]+$/.test(placeholder) && /y/i.test(placeholder)) return placeholder.toLowerCase();
    return DEFAULT_DATE_FORMAT;
  }
  function parseCalendarHeader(text) {
    const clean = cleanText(text);
    const yearOnly = clean.match(/^(\d{4})$/);
    if (yearOnly) return { year: Number(yearOnly[1]), month: null };
    const parsed = new Date(`${clean} 1`);
    return Number.isNaN(parsed.getTime()) ? null : { year: parsed.getFullYear(), month: parsed.getMonth() + 1 };
  }
  async function fillDatepicker(fieldId, field, answer, { shouldAbort = () => false } = {}) {
    const raw = cleanText(answer);
    const group = getLiveGroup(fieldId, field);
    const input = getLiveControl(fieldId) || group?.querySelector(DATE_INPUT_SELECTOR);
    if (!raw || !input) return false;
    const date = parseAnswerDate(raw);
    if (!date?.year) return false;

    // (1) Value write in the widget's own format — the form posts the input
    // value as-is, so a direct write is tried first.
    const formatted = formatDatepickerValue(date, datepickerFormat(input));
    await fillAndNotify(input, formatted, { shouldAbort });
    await sleep(WIDGET_SETTLE_MS);
    if (cleanText(input.value) === formatted) return true;

    // (2) Otherwise drive the calendar popup through its icon button.
    const icon = group?.querySelector(".date-icon button") || input;
    await clickLikeHuman(icon, { shouldAbort });
    const calendar = await waitFor(() => Array.from(document.querySelectorAll(".datepicker-days")).find(isShown) || null, DROPDOWN_WAIT_TIMEOUT_MS, shouldAbort);
    if (!calendar) return false;

    for (let step = 0; step < DATEPICKER_MAX_MONTH_STEPS && !shouldAbort(); step++) {
      const shown = parseCalendarHeader(calendar.querySelector(".datepicker-switch")?.textContent);
      if (!shown) break;
      const diff = (date.year - shown.year) * 12 + (date.month - (shown.month ?? date.month));
      if (diff === 0) break;
      const nav = calendar.querySelector(diff > 0 ? ".next" : ".prev");
      if (!nav) break;
      nav.click();
      await sleep(60);
    }
    if (shouldAbort()) return false;

    const dayCell = Array.from(calendar.querySelectorAll("td.day")).find(
      (cell) => !cell.classList.contains("old") && !cell.classList.contains("new") && Number(cleanText(cell.textContent)) === date.day
    );
    if (!dayCell) return false;
    dayCell.click();
    await sleep(WIDGET_SETTLE_MS);
    return Boolean(cleanText(input.value));
  }

  // ---- files (Jasny fileinput) ----------------------------------------------

  // The portal rejects filenames with characters outside letters/digits/./_/- ;
  // keep the extension so the upload is still recognizable.
  function sanitizeFileName(fileName, fallback = "document.pdf") {
    const clean = String(fileName || "").trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    return clean && /\./.test(clean) ? clean : fallback;
  }
  function base64ByteLength(base64) {
    const clean = String(base64 || "").replace(/[^A-Za-z0-9+/=]/g, "");
    const padding = (clean.match(/=+$/) || [""])[0].length;
    return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
  }
  async function fillRippleHireFile(fieldId, field, answer, { shouldAbort = () => false } = {}) {
    if (!answer || typeof answer !== "object" || answer.type !== "file" || !answer.base64) return false;
    if (base64ByteLength(answer.base64) > MAX_RESUME_BYTES) return false; // exceeds the portal's 3 MB limit
    const group = getLiveGroup(fieldId, field);
    const input = (getLiveControl(fieldId)?.type === "file" ? getLiveControl(fieldId) : null) || group?.querySelector('input[type="file"]');
    if (!input) return false;
    const fileName = sanitizeFileName(answer.fileName, answer.mimeType === "application/pdf" ? "document.pdf" : "document.docx");
    fillFileInput(input, fileName, answer.base64, answer.mimeType);

    // Jasny swaps `.fileinput-new` for `.fileinput-exists` and shows the
    // name; without the widget the native input's own file list is the signal.
    const widget = input.closest(FILEINPUT_WIDGET_SELECTOR);
    const settled = await waitFor(() => {
      if (widget) {
        const shown = cleanText(widget.querySelector(".fileinput-filename")?.textContent);
        return widget.classList.contains("fileinput-exists") && shown ? shown : null;
      }
      return input.files?.length ? fileName : null;
    }, FILE_SETTLE_WAIT_MS, shouldAbort);
    return Boolean(settled);
  }

  // ---- skills (jquery.tokeninput) --------------------------------------------

  async function fillTokenInput(fieldId, field, answer, { shouldAbort = () => false } = {}) {
    const values = (Array.isArray(answer) ? answer : String(answer ?? "").split(/\s*[,;|]\s*/)).map(cleanText).filter(Boolean);
    const group = getLiveGroup(fieldId, field);
    const wrapper = group?.querySelector(TOKEN_INPUT_WRAPPER_SELECTOR) || group;
    const input = wrapper?.querySelector('.token-input-list input[type="text"], ul.token-input-list input');
    if (!input || !values.length) return false;
    for (const value of values) {
      if (shouldAbort()) return true;
      await clickLikeHuman(input, { shouldAbort });
      await fillTextInputLikeHuman(input, value, { blur: false, shouldAbort });
      const suggestion = await waitFor(
        () =>
          Array.from(document.querySelectorAll(".token-input-dropdown li")).find(
            (li) => !/token-input-searching|token-input-dropdown-item-notfound/i.test(li.className) && cleanText(li.textContent)
          ) || null,
        DROPDOWN_WAIT_TIMEOUT_MS,
        shouldAbort
      );
      if (suggestion) {
        suggestion.click();
        await sleep(WIDGET_SETTLE_MS);
      } else {
        dispatchKey(input, "Enter");
      }
    }
    return true;
  }

  // ---- dispatch ---------------------------------------------------------------

  /**
   * Write an already-resolved answer into a field returned by
   * detectFields(), dispatched by its fieldKind. The caller owns deciding
   * WHAT the answer is; this only owns getting it onto the page using
   * window.ProactiveAutofillEngine's primitives (plus the handful of
   * RippleHire-specific widget mechanics above). Returns true on an
   * apparent success, false when nothing was written (a miss is left for
   * Big Banana's own generic/AI pipeline rather than guessed at).
   *
   * @param {{fieldId:string, field:Element, fieldKind:string}} entry
   * @param {*} answer - string for text/textarea/numeric/select-native/
   *   radio/phone/places/datepicker; string|string[]|boolean for
   *   checkbox/checkbox-single/multiselect/tokeninput;
   *   {type:"file", fileName, base64, mimeType} for resume/cover_letter/file
   *   (cover_letter also accepts a plain string, written as text).
   */
  async function fillField(entry, answer, { shouldAbort = () => false } = {}) {
    if (!entry || answer == null) return false;
    const { fieldId, field, fieldKind } = entry;
    const opts = { shouldAbort };
    switch (fieldKind) {
      case "text":
        return fillText(fieldId, field, answer, opts);
      case "numeric":
        return fillNumeric(fieldId, field, answer, opts);
      case "textarea":
        return fillText(fieldId, field, answer, opts);
      case "select-native":
        return fillSelectNative(fieldId, field, answer);
      case "multiselect":
        return fillMultiselect(fieldId, field, answer, opts);
      case "radio":
        return fillRadio(fieldId, field, answer, opts);
      case "checkbox-single":
        return fillCheckboxSingle(fieldId, field, answer, opts);
      case "checkbox":
        return fillCheckbox(fieldId, field, answer, opts);
      case "phone":
        return fillPhone(fieldId, field, answer, opts);
      case "places":
        return fillPlaces(fieldId, field, answer, opts);
      case "datepicker":
        return fillDatepicker(fieldId, field, answer, opts);
      case "tokeninput":
        return fillTokenInput(fieldId, field, answer, opts);
      case "resume":
      case "file":
        return fillRippleHireFile(fieldId, field, answer, opts);
      case "cover_letter": {
        if (typeof answer === "string") return fillText(fieldId, field, answer, opts);
        return fillRippleHireFile(fieldId, field, answer, opts);
      }
      default:
        return false;
    }
  }

  NS.ripplehire = {
    isAutofillAvailable,
    advance,
    detectFields,
    fillField,
    fetchMultiselectOptions,
    getSubmitButton,
    clickSubmitButton,
  };
})();
