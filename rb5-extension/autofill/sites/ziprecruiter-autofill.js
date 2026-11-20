/* =====================================================================
 * autofill/sites/ziprecruiter-autofill.js — ZipRecruiter's own Quick
 * Apply flow (the apply dialog on the jobs-search SPA, and its legacy
 * standalone-page equivalent).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/ziprecruiter/autofill.js.
 *
 * ZipRecruiter actually runs TWO generations of this flow side by side —
 * a newer one (role="dialog" with its own React "Select"/button-radio
 * widgets) and a legacy one (plain <form class="ContactPostParse">/
 * <form class="question_form"> with real <input type=radio/checkbox>) —
 * and an employer's posting can land on either. Every helper below that
 * branches on "buttons vs. native inputs" is the new-vs-legacy split,
 * not two unrelated code paths.
 *
 * Ported, structural-only:
 *   - locating the live apply flow (dialog vs. legacy inline page) and
 *     refusing to touch a dialog left open over a DIFFERENT job
 *   - field enumeration for all three of ZR's own steps: the contact
 *     form (name/email/phone/location/resume), the screener-question
 *     step (text/textarea/date/radio/checkbox/combobox/file), and the
 *     resume-start step ("Upload a Resume")
 *   - value-filling per field kind, including ZR's own location
 *     autocomplete and its two file-upload mechanisms (a plain
 *     <input type=file>, and a transient OS-picker input ZR appends to
 *     <body> only after a button press)
 *   - the Next/Continue/reveal-apply advance chain, and the (never
 *     clicked) final-submit detector
 *
 * Explicitly NOT ported (BidHub's own AI-answer backend / CAPTCHA /
 * proxy automation):
 *   - ANSWER_TYPE_HANDLERS and createBackendAnswerHandler — the
 *     getAnswer()-backed free-text/single-select/multi-select answer
 *     GENERATION for screener questions BidHub can't resolve
 *     structurally. This file only classifies and fills a field once a
 *     VALUE already exists; Big Banana's own existing AI-answer pipeline
 *     covers the rest, same contract as the bamboohr-autofill.js port.
 *   - the embedding-similarity fallback inside BidHub's own
 *     getBestMatchingOption (an AI call against getEmbeddingMatch). This
 *     port's getBestMatchingOption stops at an exact or substring label
 *     match and returns null otherwise, leaving the field untouched
 *     rather than guessing.
 *   - getResumeForAutofill()/getCoverLetterForAutofill() — BidHub's own
 *     background calls that produce a resume/cover-letter FILE from a
 *     stored profile. This module's fill() instead takes an
 *     already-prepared {fileName, base64, mimeType} straight from the
 *     caller (profileData.__resumeFile / __coverLetterFile), same
 *     convention the simple generic adapters use.
 *   - no CAPTCHA-solving or remote-CDP automation exists in BidHub's
 *     ZipRecruiter file at all; nothing of that kind was found to omit.
 * ===================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofillEngine) return;
  const dom = window.ProactiveAutofillEngine;

  // ---- small local helpers (not in the shared engine) --------------------

  async function waitFor(check, timeoutMs, shouldAbort = () => false, pollMs = 100) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (shouldAbort()) return null;
      const result = check();
      if (result) return result;
      await dom.sleep(pollMs);
    }
    return null;
  }

  const REQUIRED_MARKERS = /[✱*]/g;
  function normalizeZipRecruiterText(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(/​/g, "")
      .replace(REQUIRED_MARKERS, "")
      .replace(/\boptional\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function normalizeComparisonText(value) {
    return normalizeZipRecruiterText(value).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }
  function slugifyFieldId(value) {
    return normalizeComparisonText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function escapeAttributeValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // ZR's own markup carries no `hidden`/aria-expanded="false" cleanup on a
  // field that scripted logic has hidden (only display:none/zero-size) —
  // same visibility test BidHub uses throughout this file.
  function isElementVisible(element, { allowHiddenFileInput = false } = {}) {
    if (!element?.isConnected) return false;
    if (allowHiddenFileInput && element.matches?.('input[type="file"]')) return true;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function getButtonLabel(button) {
    return normalizeZipRecruiterText(button?.getAttribute?.("aria-label") || button?.textContent || button?.value || "");
  }
  function isDisabledControl(control) {
    return Boolean(control?.disabled || control?.getAttribute?.("aria-disabled") === "true");
  }

  // ---- Constants -----------------------------------------------------------

  const APPLY_DIALOG_SELECTOR = '[role="dialog"][data-testid="apply-dialog-content"]';
  const LEGACY_APPLY_MODAL_SELECTOR = '[role="dialog"][data-zds-component="modal"]';
  // Sentinel root: an apply dialog for a DIFFERENT job covers the page — nothing may be filled or clicked.
  const FOREIGN_MODAL = Symbol("foreign-apply-modal");
  const LEGACY_FLOW_MARKER_SELECTOR = [
    ".ApplyFlowApp",
    ".apply_flow_screen",
    ".UploadResumeOrCreateProfile",
    "form.question_form",
    "form.ContactPostParse",
  ].join(", ");
  const QUESTION_FIELD_SELECTOR = '[data-testid^="QuestionField-"], fieldset[name^="QuestionField-"]';
  const JOB_DETAILS_SELECTOR = 'div[data-testid="job-details-scroll-container"]';
  const CONTACT_ANCHOR_SELECTOR = [
    "#contact-post-parse-first-name",
    "#contact-post-parse-phone",
    "#contact-first-name",
    "#contact-phone",
  ].join(", ");
  // OPEN_APPLY_FLOW: opens the dialog, never sends.
  const APPLY_REVEAL_LABEL = /^quick apply$/i;
  // ONE_CLICK_APPLY (and a saved draft's resume): may send the application outright.
  const ONE_CLICK_LABEL = /^(1-(click|tap) apply|continue( application)?)$/i;
  const APPLY_TRIGGER_LABEL = /^(quick apply|1-(click|tap) apply|continue( application)?)$/i;
  const PRIMARY_ACTION_LABEL = /^(continue|next|submit( application)?|save (and|&) continue)$/i;
  const FINAL_SUBMIT_LABEL = /^submit( application)?$/i;
  const RESUME_START_LABEL = /^upload a resume$/i;
  const RESUME_BOX_LABEL = /^(attach a resume file|replace)$/i;
  const UPLOAD_BUTTON_LABEL = /upload a file|^(replace|upload)$/i;
  const CLOSE_BUTTON_LABEL = /^close$/i;
  const OPTIONAL_TEXT = /^\s*optional\b/i;
  const UPLOAD_ERROR_TEXT = /error uploading|failed to upload|invalid (file )?type|too large|not supported/i;
  const FILE_NAME_TEXT = /\S+\.(pdf|docx?|txt|rtf|odt)$/i;
  const RESUME_FIELD_ID = "resume";
  const COVER_LETTER_FIELD_ID = "cover_letter";
  const LOCATION_FIELD_KIND = "location-autocomplete";

  const COMBOBOX_WAIT_TIMEOUT_MS = 2500;
  const LOCATION_OPTIONS_WAIT_TIMEOUT_MS = 2500;
  const RESUME_REMOVE_TIMEOUT_MS = 5000;
  const RESUME_START_ADVANCE_TIMEOUT_MS = 8000;
  const RESUME_REPLACE_SETTLE_TIMEOUT_MS = 8000;
  const RESUME_REPLACE_SETTLE_MS = 250;
  const TRANSIENT_PICKER_WAIT_MS = 3000;
  const USER_ACTIVATION_LAPSE_TIMEOUT_MS = 6000;
  const UPLOAD_SETTLE_TIMEOUT_MS = 20000;
  const STEP_ADVANCE_WAIT_MS = 1500;

  // ---- Flow roots ---------------------------------------------------------

  function getDialogJobTitle(dialog) {
    return normalizeComparisonText(dialog.querySelector(".job_title")?.textContent || dialog.querySelector("h2")?.textContent);
  }

  // The dialog header names the job it applies to. Selecting another job in
  // the search list leaves the dialog open over the NEW job's details, and ZR
  // re-opens a saved draft application on page load — a dialog whose title
  // disagrees with the details pane belongs to ANOTHER job: filling it would
  // apply the wrong posting under this session, and clicking the header
  // apply button behind it is undefined.
  function isForeignApplyModal(modal) {
    const detailsTitle = normalizeComparisonText(document.querySelector(`${JOB_DETAILS_SELECTOR} h2`)?.textContent);
    const modalTitle = getDialogJobTitle(modal);
    return Boolean(detailsTitle && modalTitle && detailsTitle !== modalTitle);
  }
  function isLegacyFlowModal(modal) {
    return modal.matches(LEGACY_APPLY_MODAL_SELECTOR) && Boolean(modal.querySelector(LEGACY_FLOW_MARKER_SELECTOR));
  }
  function getApplyFlowRoot() {
    const dialogs = Array.from(document.querySelectorAll(`${APPLY_DIALOG_SELECTOR}, ${LEGACY_APPLY_MODAL_SELECTOR}`))
      .filter((dialog) => isElementVisible(dialog))
      .filter((dialog) => dialog.matches(APPLY_DIALOG_SELECTOR) || isLegacyFlowModal(dialog));
    if (dialogs.length > 0) {
      const dialog = dialogs[dialogs.length - 1];
      return isForeignApplyModal(dialog) ? FOREIGN_MODAL : dialog;
    }
    // Legacy flow rendered without the modal chrome at all (a direct, standalone apply page).
    const inlineMarker = document.querySelector(LEGACY_FLOW_MARKER_SELECTOR);
    if (!inlineMarker) return null;
    return inlineMarker.closest(".ApplyFlowApp") || document.body;
  }
  function isFlowElement(root) {
    return Boolean(root) && root !== FOREIGN_MODAL;
  }
  function getVisibleButtons(root) {
    return Array.from(root?.querySelectorAll?.('button, [role="button"]') ?? []).filter((button) => isElementVisible(button));
  }
  function findButtonByLabel(root, labelPattern) {
    return getVisibleButtons(root).find((button) => labelPattern.test(getButtonLabel(button))) ?? null;
  }

  // Legacy step 1: the bare "Upload a Resume" file input.
  function getLegacyResumeStartInput(root) {
    if (!isFlowElement(root)) return null;
    return root.querySelector('.UploadResumeOrCreateProfile input[type="file"][name="ResumeUpload"]') ?? null;
  }
  // New profile builder start ("Choose how you'd like to apply." → "Upload a Resume" opens ZR's picker).
  function getResumeStartButton(root) {
    if (!isFlowElement(root) || getContactForm(root) || getScreenerFields(root).length > 0) return null;
    return findButtonByLabel(root, RESUME_START_LABEL);
  }
  function getContactForm(root) {
    if (!isFlowElement(root)) return null;
    const legacyForm = root.querySelector("form.ContactPostParse");
    if (legacyForm) return isElementVisible(legacyForm) ? legacyForm : null;
    const anchor = root.querySelector(CONTACT_ANCHOR_SELECTOR);
    if (!anchor || !isElementVisible(anchor)) return null;
    return anchor.closest("form") || root;
  }
  function isLegacyContactForm(form) {
    return Boolean(form?.matches?.("form.ContactPostParse"));
  }
  function getLegacyQuestionForm(root) {
    if (!isFlowElement(root)) return null;
    const form = root.querySelector("form.question_form");
    return form && isElementVisible(form) ? form : null;
  }
  // Job-details header button that opens (or sends outright) the application.
  // Scoped to the details pane on the search SPA; a standalone job page
  // carries the same aria-labelled button.
  function getApplyTrigger() {
    const scope = document.querySelector(JOB_DETAILS_SELECTOR) || document;
    return (
      Array.from(scope.querySelectorAll('button[aria-label], a[role="button"][aria-label]'))
        .filter((button) => isElementVisible(button))
        .find((button) => APPLY_TRIGGER_LABEL.test(getButtonLabel(button))) ?? null
    );
  }

  // ---- Screeners ------------------------------------------------------------

  function getScreenerFields(root) {
    if (!isFlowElement(root)) return [];
    return Array.from(root.querySelectorAll(QUESTION_FIELD_SELECTOR))
      .filter((field) => isElementVisible(field))
      .filter((field) => !field.parentElement?.closest?.(QUESTION_FIELD_SELECTOR));
  }
  function getQuestionFieldKey(field) {
    const raw = field?.getAttribute?.("data-testid") || field?.getAttribute?.("name") || "";
    return raw.replace(/^QuestionField-/, "");
  }
  function getVisibleTextInput(field) {
    return (
      Array.from(field?.querySelectorAll("input") ?? []).find((input) => {
        const type = (input.getAttribute("type") || input.type || "").toLowerCase();
        if (["hidden", "file", "radio", "checkbox"].includes(type)) return false;
        if (input.getAttribute("role") === "combobox") return false;
        return isElementVisible(input);
      }) ?? null
    );
  }
  // Button-style comboboxes only — the location autocomplete is its own
  // `input[role="combobox"]` and is handled as its own field kind.
  function getComboboxButton(field) {
    const button = Array.from(field?.querySelectorAll('[role="combobox"]') ?? []).find((node) => node.tagName !== "INPUT");
    return isElementVisible(button) ? button : null;
  }
  // New-flow choice widgets: `button[role=radio|checkbox]` carries the option
  // label; the native input next to it is aria-hidden/inert. Legacy flow:
  // real `<input type=radio|checkbox>`s wrapped in `<label>`s.
  function getChoiceButtons(field, role) {
    return Array.from(field?.querySelectorAll(`[role="${role}"]`) ?? [])
      .filter((node) => node.tagName !== "INPUT")
      .filter((node) => isElementVisible(node));
  }
  // The option label sits OUTSIDE the [role=radio|checkbox] control (a
  // sibling span it points to through aria-labelledby); the aria-hidden
  // native input beside it carries the same text as its value.
  function getChoiceButtonText(button) {
    const labelledBy = button?.getAttribute?.("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => normalizeZipRecruiterText(document.getElementById(id)?.textContent))
        .filter(Boolean)
        .join(" ");
      if (text) return text;
    }
    const ownText = normalizeZipRecruiterText(button?.getAttribute?.("aria-label") || button?.textContent);
    if (ownText) return ownText;
    const nativeInput = button?.parentElement?.querySelector?.('input[type="radio"], input[type="checkbox"]');
    return normalizeZipRecruiterText(nativeInput?.value);
  }
  function isChoiceButtonChecked(button) {
    return button?.getAttribute?.("aria-checked") === "true";
  }
  // The UPLOAD screener's own button ("<question> Click here to upload a
  // file", or "Replace" once a file is on it) — pressing it opens ZR's
  // transient file picker.
  function getScreenerUploadButton(field) {
    return getVisibleButtons(field).find((button) => UPLOAD_BUTTON_LABEL.test(getButtonLabel(button))) ?? null;
  }
  function hasChoiceControls(field) {
    return (
      getChoiceButtons(field, "radio").length > 0 ||
      getChoiceButtons(field, "checkbox").length > 0 ||
      dom.getRadioInputs(field).length > 0 ||
      dom.getCheckboxInputs(field).length > 0
    );
  }
  function getFieldQuestionText(field) {
    if (!field) return "";
    // Choice groups: the GROUP label (legend / a group-level aria-label),
    // never an option's own label — those belong to individual radios.
    if (hasChoiceControls(field)) {
      const group = field.querySelector('[role="radiogroup"], [role="group"]');
      const groupCandidates = [
        ...Array.from(field.querySelectorAll("legend")).map((n) => n.textContent),
        ...Array.from(field.querySelectorAll("label:not([for])")).map((n) => n.textContent),
        group?.getAttribute("aria-label"),
        ...String(group?.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent),
      ];
      const groupText = groupCandidates.map(normalizeZipRecruiterText).find(Boolean);
      if (groupText) return groupText;
    }
    const candidates = hasChoiceControls(field)
      ? Array.from(field.querySelectorAll('[id$="-label"]'))
      : [
          ...field.querySelectorAll("label[for]"),
          ...field.querySelectorAll("label"),
          ...field.querySelectorAll("legend"),
          ...field.querySelectorAll('[id$="-label"]'),
        ];
    const labelText = candidates.map((n) => normalizeZipRecruiterText(n.textContent)).find(Boolean);
    if (labelText) return labelText;

    // No visible label: ZR puts the prompt on the control itself as aria-label.
    const control = field.querySelector(
      'input:not([type="hidden"]), textarea, [role="combobox"], [role="radiogroup"], [role="group"], button'
    );
    const ariaLabel = normalizeZipRecruiterText(control?.getAttribute?.("aria-label"))
      .replace(/\s*click here to upload a file$/i, "")
      .trim();
    if (ariaLabel) return ariaLabel;

    // Prompt-only block (an HTML prompt above the control, or an INFO-only question).
    return normalizeZipRecruiterText(field.firstElementChild?.textContent);
  }
  function cleanStableFieldId(rawValue) {
    const value = String(rawValue ?? "").trim();
    if (!value) return null;
    const stripped = value
      .replace(/^\[['"]?/, "")
      .replace(/['"]?\]$/, "")
      .replace(/\[['"]?(.+?)['"]?\]/g, "$1");
    return stripped || value;
  }
  function deriveStableFieldId(field, question) {
    const textInput = getVisibleTextInput(field);
    const textarea = dom.getTextarea(field);
    const fileInput = dom.getFileInputInsideField(field);
    const choiceInput = dom.getRadioInputs(field)[0] || dom.getCheckboxInputs(field)[0];
    const combobox = getComboboxButton(field);
    const primaryControl = fileInput || textInput || textarea || choiceInput || combobox;
    if (fileInput || getScreenerUploadButton(field)) {
      if (/cover\s*letter/i.test(question)) return COVER_LETTER_FIELD_ID;
      if (/\b(resume|cv)\b/i.test(question)) return RESUME_FIELD_ID;
    }
    // The wrapper carries the employer's own question key
    // (data-testid="QuestionField-<uuid|question_NNN|camelKey>"); the
    // controls only repeat it as `name="['<key>']"`, and their ids are
    // per-render (React-generated, e.g. "_r_22_-toggle-button") — never
    // stable across sessions. Fall back to a slug of the question text
    // when nothing else is stable.
    const candidates = [
      cleanStableFieldId(getQuestionFieldKey(field)),
      cleanStableFieldId(primaryControl?.getAttribute?.("name") || primaryControl?.name),
      cleanStableFieldId(primaryControl?.id),
      slugifyFieldId(question),
    ];
    return candidates.find(Boolean) || null;
  }
  function ensureUniqueFieldId(fieldId, usedFieldIds) {
    if (!fieldId) return null;
    if (!usedFieldIds.has(fieldId)) {
      usedFieldIds.add(fieldId);
      return fieldId;
    }
    let suffix = 2;
    while (usedFieldIds.has(`${fieldId}-${suffix}`)) suffix += 1;
    const uniqueFieldId = `${fieldId}-${suffix}`;
    usedFieldIds.add(uniqueFieldId);
    return uniqueFieldId;
  }
  function isCountryField(question, fieldId = "") {
    return /\bcountry\b/i.test(`${question} ${fieldId}`);
  }
  function isStateField(question, fieldId = "") {
    return /\b(state|province|region)\b/i.test(`${question} ${fieldId}`);
  }
  // Detects a question whose answer only makes sense alongside a PRECEDING
  // one ("if you answered yes...", "what's their name" referring to a
  // person the previous question named). Purely informational here — Big
  // Banana's own AI-answer pipeline (not this module) is what actually
  // needs it, to keep a static profile-template answer away from these.
  const DEPENDENT_QUESTION_PATTERN = new RegExp(
    [
      String.raw`\b(?:if\s+you\s+(?:answered|selected|chose|checked|picked|indicated|marked|said)|if\b[^.?!\n]*\babove\b|if\s+so|if\s+not|if\s+yes|if\s+no|if\s+applicable|previous\s+question|please\s+explain|please\s+specify|explain\s+why|explain\s+how|in\s+that\s+case)\b`,
      String.raw`\bwhat(?:'s|\s+is|\s+are|\s+was|\s+were)?\s+(?:their|his|her|its)\b`,
      String.raw`\bwho\s+(?:is|are|was|were)\s+(?:they|he|she|it)\b`,
      String.raw`\b(?:their|his|her)(?:\s+or\s+(?:her|his))?\s+(?:full\s+|first\s+|last\s+|work\s+|job\s+)?(?:name|e-?mail(?:\s+address)?|phone(?:\s+number)?|contact(?:\s+information|\s+info|\s+details)?|title|position|role|relationship|company|department|employee\s+(?:id|number)|id)\b`,
      String.raw`\b(?:this|that)\s+(?:person|individual|employee|referrer)\b`,
      String.raw`\bwho\s+referred\s+you\b`,
      String.raw`\bthe\s+(?:person|employee|individual|colleague)\s+(?:who|that)\s+referred\b`,
    ].join("|"),
    "i"
  );
  function isDependentQuestion(questionText) {
    return DEPENDENT_QUESTION_PATTERN.test(String(questionText ?? "").trim());
  }
  // A "State" screener right after a "Country" one only has the right
  // options once the country is actually set — move it to directly follow
  // its country field (if the two are out of DOM order) so fill() handles
  // country first.
  function reorderDependentFields(questions) {
    const ordered = [...questions];
    for (let index = 0; index < ordered.length; index += 1) {
      const entry = ordered[index];
      if (!isStateField(entry?.question, entry?.fieldId)) continue;
      const countryIndex = ordered.findIndex(
        (candidate, candidateIndex) => candidateIndex > index && isCountryField(candidate?.question, candidate?.fieldId)
      );
      if (countryIndex === -1) continue;
      const [countryEntry] = ordered.splice(countryIndex, 1);
      ordered.splice(index, 0, countryEntry);
      index += 1;
    }
    return ordered.map((entry, index) => ({
      ...entry,
      dependsOnPrevious:
        isDependentQuestion(entry?.question) ||
        (isStateField(entry?.question, entry?.fieldId) && isCountryField(ordered[index - 1]?.question, ordered[index - 1]?.fieldId)),
    }));
  }

  // ---- Dates ----------------------------------------------------------------

  function isDateLikeField(question, control) {
    if (control?.getAttribute?.("aria-haspopup") === "dialog") return true;
    const combined = normalizeComparisonText(
      [question, control?.getAttribute?.("placeholder"), control?.getAttribute?.("aria-label"), control?.name, control?.id]
        .filter(Boolean)
        .join(" ")
    );
    if (/\b(date|available|start date|end date|from date|to date)\b/.test(combined)) return true;
    return Boolean(control?.parentElement?.querySelector?.('button[aria-label*="date" i], button[aria-label*="calendar" i]'));
  }
  // A placeholder spelling the mask (MM/DD/YYYY, MM-DD-YYYY, DD.MM.YYYY,
  // MM/YYYY, YYYY) wins; a date-like field without one gets the US default
  // ZR's own picker uses.
  function inferDateFormat(question, control) {
    const placeholder = String(control?.getAttribute?.("placeholder") ?? "").trim().toUpperCase();
    if (/^(MM|DD|YYYY)(?:[/.-](MM|DD|YYYY)){0,2}$/.test(placeholder)) return placeholder;
    if (isDateLikeField(question, control)) return "MM/DD/YYYY";
    return null;
  }
  function buildFieldConstraints(question, control) {
    const constraints = {};
    if (control?.required || control?.getAttribute?.("aria-required") === "true") constraints.required = true;
    const placeholder = control?.getAttribute?.("placeholder");
    if (placeholder) constraints.placeholder = placeholder;
    const format = inferDateFormat(question, control);
    if (format) {
      constraints.inputType = "date";
      constraints.format = format;
    }
    return constraints;
  }
  function padNumber(value) {
    return String(value).padStart(2, "0");
  }
  function parseAnswerDate(rawValue) {
    const isoMatch = rawValue.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (isoMatch) return { year: isoMatch[1], month: Number(isoMatch[2]), day: Number(isoMatch[3]) };
    // Numeric M/D/Y — the common US-form shape a caller's own answer might already be in.
    const numericMatch = rawValue.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (numericMatch) return { year: numericMatch[3], month: Number(numericMatch[1]), day: Number(numericMatch[2]) };
    return null;
  }
  function formatDateForField(answer, constraints = {}) {
    const rawValue = String(answer ?? "").trim();
    if (!rawValue || !constraints.format) return rawValue;
    const parsed = parseAnswerDate(rawValue);
    if (!parsed) return rawValue;
    const tokens = constraints.format.split(/[/.-]/);
    if (tokens.includes("DD") && !parsed.day) return rawValue;
    if (tokens.includes("MM") && !parsed.month) return parsed.year;
    const separator = constraints.format.match(/[/.-]/)?.[0] ?? "/";
    return tokens
      .map((token) => (token === "YYYY" ? parsed.year : token === "MM" ? padNumber(parsed.month) : token === "DD" ? padNumber(parsed.day) : token))
      .join(separator);
  }

  // ---- Screener field classification -----------------------------------------

  function getUploadAcceptFromDescription(field) {
    // "PDF, DOC, DOCX files are supported. Maximum file size is 5MB."
    const match = normalizeZipRecruiterText(field?.textContent).match(
      /((?:[A-Z]{2,5}(?:,\s*|\s*(?:and|or)\s*))*[A-Z]{2,5}) files? (?:are|is) supported/i
    );
    if (!match) return null;
    const extensions = match[1]
      .split(/,\s*|\s+(?:and|or)\s+/)
      .map((ext) => ext.trim().toLowerCase())
      .filter(Boolean);
    return extensions.length > 0 ? extensions.map((ext) => `.${ext}`).join(",") : null;
  }
  function getFileFieldMetadata(question, field, control) {
    const constraints = control ? buildFieldConstraints(question, control) : {};
    const accept = control?.getAttribute?.("accept") || getUploadAcceptFromDescription(field);
    if (accept) constraints.accept = accept;
    const isCoverLetter = /cover\s*letter/i.test(question);
    const isResume = !isCoverLetter && /\b(resume|cv)\b/i.test(question);
    if (!isCoverLetter && !isResume) return { fieldKind: null, options: null, constraints };
    return { fieldKind: "file", options: [], constraints, isResume, isCoverLetter };
  }
  function hasOptionalMarker(field) {
    return Array.from(field.querySelectorAll("*")).some((node) => node.children.length === 0 && OPTIONAL_TEXT.test(node.textContent || ""));
  }
  // New flow: `required`/`aria-required` on the control or its group is
  // authoritative. Legacy flow: ZR marked an optional screener with an
  // "Optional" helper line; everything else was required and blocked
  // Continue — surfacing that keeps a caller from treating it as skippable.
  function isScreenerFieldRequired(field) {
    if (field.querySelector('[required], [aria-required="true"]')) return true;
    if (hasOptionalMarker(field)) return false;
    return field.tagName === "FIELDSET";
  }
  function getFieldMetadataSync(question, field) {
    const fileInput = dom.getFileInputInsideField(field);
    if (fileInput || getScreenerUploadButton(field)) return getFileFieldMetadata(question, field, fileInput);

    const radioButtons = getChoiceButtons(field, "radio");
    const radioInputs = radioButtons.length > 0 ? [] : dom.getRadioInputs(field);
    if (radioButtons.length > 0 || radioInputs.length > 0) {
      const options = (radioButtons.length > 0 ? radioButtons.map(getChoiceButtonText) : radioInputs.map((input) => dom.getInputLabelText(input, question))).filter(
        Boolean
      );
      return { fieldKind: "radio", options, constraints: {} };
    }

    const checkboxButtons = getChoiceButtons(field, "checkbox");
    const checkboxInputs = checkboxButtons.length > 0 ? [] : dom.getCheckboxInputs(field);
    if (checkboxButtons.length > 0 || checkboxInputs.length > 0) {
      const options = (
        checkboxButtons.length > 0 ? checkboxButtons.map(getChoiceButtonText) : checkboxInputs.map((input) => dom.getInputLabelText(input, question))
      ).filter(Boolean);
      return { fieldKind: "checkbox", options, constraints: {} };
    }

    if (getComboboxButton(field)) return { fieldKind: "combobox", options: null, constraints: {} };

    const textarea = dom.getTextarea(field);
    if (textarea) return { fieldKind: "textarea", options: [], constraints: buildFieldConstraints(question, textarea) };

    const textInput = getVisibleTextInput(field);
    if (textInput) {
      const constraints = buildFieldConstraints(question, textInput);
      return { fieldKind: constraints.inputType === "date" ? "date" : "text", options: [], constraints };
    }
    return { fieldKind: null, options: null, constraints: {} };
  }
  function detectScreenerQuestions(root) {
    const fields = getScreenerFields(root);
    if (fields.length === 0) return [];
    const questions = [];
    const usedFieldIds = new Set();
    for (const field of fields) {
      const question = getFieldQuestionText(field);
      if (!question) continue;
      const metadata = getFieldMetadataSync(question, field);
      if (!metadata.fieldKind) continue;
      const baseFieldId = deriveStableFieldId(field, question);
      const fieldId = ensureUniqueFieldId(baseFieldId, usedFieldIds);
      if (!fieldId) continue;
      const constraints = { ...metadata.constraints };
      if (isScreenerFieldRequired(field)) constraints.required = true;
      questions.push({
        question,
        fieldId,
        fieldKind: metadata.fieldKind,
        dependsOnPrevious: isDependentQuestion(question),
        field,
        options: metadata.options,
        constraints,
      });
    }
    return reorderDependentFields(questions);
  }

  // ---- Resume start, contact + location ---------------------------------------

  function buildResumeQuestion(control, field, fieldId = RESUME_FIELD_ID, question = "Resume") {
    return {
      question,
      fieldId,
      fieldKind: "file",
      dependsOnPrevious: false,
      field,
      options: [],
      constraints: control?.matches?.("input") ? buildFieldConstraints(question, control) : {},
    };
  }
  function getWidgetContainer(button, levels = 3) {
    let node = button;
    for (let index = 0; index < levels && node?.parentElement; index += 1) node = node.parentElement;
    return node || button;
  }
  function detectResumeStartQuestions(root) {
    const legacyInput = getLegacyResumeStartInput(root);
    if (legacyInput) {
      const field = legacyInput.closest(".UploadResumeOrCreateProfile") || legacyInput.parentElement;
      return [buildResumeQuestion(legacyInput, field)];
    }
    const startButton = getResumeStartButton(root);
    if (!startButton) return [];
    return [buildResumeQuestion(startButton, getWidgetContainer(startButton))];
  }
  function getLabelForControl(control, scope) {
    if (!control) return null;
    const labelledBy = control.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelled =
        scope.querySelector(`#${escapeAttributeValue(labelledBy).replace(/([^\w-])/g, "\\$1")}`) || document.getElementById(labelledBy);
      if (labelled) return labelled;
    }
    if (control.id) {
      const linked = scope.querySelector(`label[for="${escapeAttributeValue(control.id)}"]`);
      if (linked) return linked;
    }
    return control.closest("label") || null;
  }
  // Smallest ancestor wrapping both the control and its label — this is the
  // "field" entry a fill handler receives.
  function getFieldWrapper(control, label, stopAt) {
    let node = control.parentElement;
    while (node && node !== stopAt) {
      if (!label || node.contains(label)) return node;
      node = node.parentElement;
    }
    return control.parentElement || control;
  }
  function isLocationAutocompleteInput(input) {
    return input?.tagName === "INPUT" && input.getAttribute("role") === "combobox" && input.getAttribute("aria-autocomplete") === "list";
  }
  // The contact step's resume box: "Attach a resume file" (nothing picked yet) or "<file name> Replace Remove".
  function getResumeBoxButton(scope) {
    return findButtonByLabel(scope, RESUME_BOX_LABEL);
  }
  function detectContactQuestions(root) {
    const form = getContactForm(root);
    if (!form) return [];
    const questions = [];
    const usedFieldIds = new Set();

    // The resume goes FIRST: replacing it triggers ZR's server-side parse,
    // which re-prefills the contact inputs — filling it after them would
    // overwrite the fills this module just made.
    const fileInput = form.querySelector('input[type="file"]');
    const resumeButton = fileInput ? null : getResumeBoxButton(form);
    if (fileInput) {
      usedFieldIds.add(RESUME_FIELD_ID);
      questions.push(buildResumeQuestion(fileInput, fileInput.closest(".ApplyResumeUpload") || fileInput.parentElement));
    } else if (resumeButton) {
      usedFieldIds.add(RESUME_FIELD_ID);
      questions.push(buildResumeQuestion(resumeButton, getWidgetContainer(resumeButton)));
    }

    const controls = Array.from(form.querySelectorAll("input, textarea"))
      .filter((control) => !["hidden", "file", "radio", "checkbox", "submit", "button"].includes((control.getAttribute("type") || control.type || "").toLowerCase()))
      .filter((control) => isElementVisible(control));
    for (const control of controls) {
      const label = getLabelForControl(control, form);
      const question = normalizeZipRecruiterText(label?.textContent) || normalizeZipRecruiterText(control.getAttribute("aria-label") || control.getAttribute("placeholder"));
      if (!question) continue;
      const field = getFieldWrapper(control, label, form);
      const baseFieldId = cleanStableFieldId(control.name) || cleanStableFieldId(control.id) || slugifyFieldId(question);
      const fieldId = ensureUniqueFieldId(baseFieldId, usedFieldIds);
      if (!fieldId) continue;
      if (isLocationAutocompleteInput(control)) {
        questions.push({
          question,
          fieldId,
          fieldKind: LOCATION_FIELD_KIND,
          dependsOnPrevious: false,
          field,
          options: [],
          constraints: buildFieldConstraints(question, control),
        });
        continue;
      }
      const isTextarea = control.tagName === "TEXTAREA";
      const constraints = buildFieldConstraints(question, control);
      const isDate = !isTextarea && constraints.inputType === "date";
      questions.push({
        question,
        fieldId,
        fieldKind: isTextarea ? "textarea" : isDate ? "date" : "text",
        dependsOnPrevious: false,
        field,
        options: [],
        constraints,
      });
    }
    return questions;
  }

  // Enumerate every fillable field on the CURRENT step: the contact form if
  // it's showing, else the screener-question step, else the bare
  // resume-start control. ZR only ever shows one of these three at a time.
  function detectFields() {
    const root = getApplyFlowRoot();
    if (!isFlowElement(root)) return [];
    const contactQuestions = detectContactQuestions(root);
    if (contactQuestions.length > 0) return contactQuestions;
    const screenerQuestions = detectScreenerQuestions(root);
    if (screenerQuestions.length > 0) return screenerQuestions;
    return detectResumeStartQuestions(root);
  }

  // ---- Advance / submit -----------------------------------------------------

  // The only in-dialog control known NOT to send the application: the legacy
  // contact form's own Continue (a review step always followed it on a live
  // apply, verified 2026-09-10).
  function getStepAdvanceButton(root = getApplyFlowRoot()) {
    if (!isFlowElement(root)) return null;
    const contactForm = getContactForm(root);
    if (!isLegacyContactForm(contactForm)) return null;
    const submit = contactForm.querySelector('button[type="submit"]');
    return submit && isElementVisible(submit) ? submit : null;
  }
  // The dialog's primary action (footer Submit / Continue / Save and
  // Continue) — never a control inside a question, never the Close control.
  function getPrimaryActionButton(root) {
    const candidates = getVisibleButtons(root)
      .filter((button) => !button.closest(QUESTION_FIELD_SELECTOR))
      .filter((button) => !CLOSE_BUTTON_LABEL.test(getButtonLabel(button)) && !CLOSE_BUTTON_LABEL.test(button.getAttribute("title") || ""));
    // The footer lives OUTSIDE the step's <form> (new dialog and legacy
    // footer alike); an in-form "Continue" is the legacy screener form's
    // own display:none submit — only a last resort.
    const ordered = [...candidates.filter((button) => !button.closest("form")), ...candidates.filter((button) => button.closest("form"))];
    return ordered.find((button) => FINAL_SUBMIT_LABEL.test(getButtonLabel(button))) || ordered.find((button) => PRIMARY_ACTION_LABEL.test(getButtonLabel(button))) || null;
  }
  // Legacy screener form: the in-form submit is display:none but still submits when clicked programmatically.
  function getLegacyScreenerSubmit(root) {
    return getLegacyQuestionForm(root)?.querySelector('button[type="submit"]') ?? null;
  }
  // The control that would SEND the application: the dialog's primary
  // action, or — with no dialog open — the header 1-Click Apply / Continue
  // Application button, which sends outright for a step-less employer.
  // Exposed so a caller can show/gate on it; fill() itself never clicks it.
  function getFinalSubmitButton(root = getApplyFlowRoot()) {
    if (root === FOREIGN_MODAL) return null;
    if (root) {
      if (getStepAdvanceButton(root)) return null;
      return getPrimaryActionButton(root) || getLegacyScreenerSubmit(root);
    }
    const trigger = getApplyTrigger();
    return trigger && ONE_CLICK_LABEL.test(getButtonLabel(trigger)) ? trigger : null;
  }
  function getRevealTrigger() {
    const trigger = getApplyTrigger();
    return trigger && APPLY_REVEAL_LABEL.test(getButtonLabel(trigger)) ? trigger : null;
  }

  // Field-less but actionable pages (the job details with only an apply
  // button, a review step, the profile builder's start screen) must still
  // report as autofill-available so a caller offers the next action.
  function isAutofillAvailable() {
    const root = getApplyFlowRoot();
    if (root === FOREIGN_MODAL) return false;
    if (detectFields().length > 0) return true;
    if (getFinalSubmitButton(root)) return true;
    if (root) return Boolean(getStepAdvanceButton(root)) || Boolean(getResumeStartButton(root)) || Boolean(getLegacyResumeStartInput(root));
    return Boolean(getRevealTrigger());
  }

  // Advance one step: click the legacy contact form's Continue, the dialog's
  // own step-advance button, or (with no dialog open yet) the header's Quick
  // Apply reveal trigger. Returns true if something was clicked (the caller
  // should re-detect and keep filling); false if there's nothing safe to
  // click. Never clicks a final-submit-shaped control — that's
  // getFinalSubmitButton's job to report, not this function's job to press.
  async function advance(shouldAbort = () => false) {
    const root = getApplyFlowRoot();
    if (root === FOREIGN_MODAL) return false;
    if (root) {
      const stepButton = getStepAdvanceButton(root);
      if (!stepButton || isDisabledControl(stepButton)) return false;
      await dom.clickLikeHuman(stepButton, { shouldAbort });
      await waitFor(() => true, STEP_ADVANCE_WAIT_MS, shouldAbort, STEP_ADVANCE_WAIT_MS);
      return true;
    }
    const trigger = getRevealTrigger();
    if (!trigger) return false;
    await dom.clickLikeHuman(trigger, { shouldAbort });
    await waitFor(() => getApplyFlowRoot(), STEP_ADVANCE_WAIT_MS, shouldAbort, 100);
    return true;
  }

  // ---- Option menus (ZR's own React "Select") --------------------------------

  function getComboboxListbox(button) {
    if (!button) return null;
    const controlsId = button.getAttribute("aria-controls");
    if (controlsId) {
      const listbox = document.getElementById(controlsId);
      if (listbox) return listbox;
    }
    const sibling = button.parentElement?.querySelector('[role="listbox"]');
    if (sibling) return sibling;
    // The new Select portals its listbox to the dialog root.
    const dialog = button.closest(`${APPLY_DIALOG_SELECTOR}, ${LEGACY_APPLY_MODAL_SELECTOR}`);
    return Array.from(dialog?.querySelectorAll('[role="listbox"]') ?? []).find((node) => isElementVisible(node)) ?? null;
  }
  function getComboboxOptionEntries(listbox) {
    if (!listbox) return [];
    return Array.from(listbox.querySelectorAll('[role="option"], li, button'))
      .filter((node) => isElementVisible(node))
      .filter((node) => normalizeZipRecruiterText(node.textContent))
      .map((element) => ({ element, text: normalizeZipRecruiterText(element.textContent) }));
  }
  async function openComboboxMenu(field, shouldAbort = () => false) {
    const button = getComboboxButton(field);
    if (!button) return null;
    if (button.getAttribute("aria-expanded") !== "true") button.click();
    return waitFor(
      () => {
        const liveButton = getComboboxButton(field);
        const liveListbox = getComboboxListbox(liveButton);
        if (!liveListbox || !isElementVisible(liveListbox)) return null;
        const options = getComboboxOptionEntries(liveListbox);
        return options.length > 0 ? { button: liveButton, listbox: liveListbox, options } : null;
      },
      COMBOBOX_WAIT_TIMEOUT_MS,
      shouldAbort,
      100
    );
  }
  function closeComboboxMenu(field) {
    const button = getComboboxButton(field);
    if (!button) return;
    // The new Select closes itself on a pick — a second press would reopen it.
    if (button.getAttribute("aria-expanded") === "false") return;
    button.click();
  }

  // Best match for `answer` among `options` ([{text}, ...] or [string, ...]):
  // an exact (normalized) match first, else the first option whose text
  // contains — or is contained by — the answer. BidHub's own fallback for
  // anything looser than that was an AI embedding-similarity call; that's
  // the out-of-scope AI-answer backend, so a looser-than-substring miss here
  // simply returns null and the field is left for the generic pipeline.
  function getBestMatchingOption(answer, options) {
    if (!Array.isArray(options) || options.length === 0) return null;
    const answerText = Array.isArray(answer) ? answer.join(", ") : answer;
    const normalizedAnswer = normalizeComparisonText(typeof answerText === "boolean" ? (answerText ? "Yes" : "No") : answerText);
    if (!normalizedAnswer) return null;
    const asEntry = (option) => (typeof option === "string" ? { text: option } : option);
    const entries = options.map(asEntry);
    const exact = entries.find((option) => normalizeComparisonText(option.text) === normalizedAnswer);
    if (exact) return exact;
    return (
      entries.find((option) => {
        const text = normalizeComparisonText(option.text);
        return text && (text.includes(normalizedAnswer) || normalizedAnswer.includes(text));
      }) ?? null
    );
  }

  async function fillComboboxField(field, answer, shouldAbort = () => false) {
    const menuState = await openComboboxMenu(field, shouldAbort);
    if (!menuState || shouldAbort()) return false;
    const best = getBestMatchingOption(answer, menuState.options);
    if (!best) {
      closeComboboxMenu(field);
      return false;
    }
    best.element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    await dom.clickLikeHuman(best.element, { shouldAbort });
    await dom.sleep(100);
    closeComboboxMenu(field);
    return true;
  }

  // ---- Location autocomplete --------------------------------------------------

  function getLocationInput(field) {
    return Array.from(field?.querySelectorAll("input") ?? []).find(isLocationAutocompleteInput) || (isLocationAutocompleteInput(field) ? field : null);
  }
  function getLocationListbox(input) {
    const controlsId = input?.getAttribute("aria-controls");
    return (controlsId && document.getElementById(controlsId)) || input?.closest('form, [role="dialog"]')?.querySelector('[role="listbox"]') || null;
  }
  function getLocationOptions(input) {
    const listbox = getLocationListbox(input);
    if (!listbox) return [];
    return Array.from(listbox.querySelectorAll('[role="option"]'))
      .filter((node) => isElementVisible(node) && node.getAttribute("aria-disabled") !== "true")
      .map((element) => ({ element, text: normalizeZipRecruiterText(element.textContent) }))
      .filter((option) => option.text);
  }
  function typeLocationSearch(input, value) {
    input.focus();
    dom.fillTextInput(input, value);
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: value.slice(-1) || " " }));
  }
  // The new autocomplete commits on pointerdown/mousedown (the option is
  // gone from the DOM by the time a plain click would land); the legacy
  // list commits on click. Fire the whole sequence so either one works.
  function selectLocationOption(element) {
    if (typeof PointerEvent === "function") {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "mouse", isPrimary: true }));
    }
    ["mousedown", "mouseup", "click"].forEach((type) => element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })));
  }
  function waitForLocationOptions(input, shouldAbort) {
    return waitFor(
      () => {
        const options = getLocationOptions(input);
        return options.length > 0 ? options : null;
      },
      LOCATION_OPTIONS_WAIT_TIMEOUT_MS,
      shouldAbort,
      100
    );
  }
  // Type the answer, wait for ZR's suggestions, pick the best one. Retries
  // with the leading segment ("New York" from "New York, NY, USA") when the
  // full string yields nothing — the geocoder suggests zip-level rows for a
  // bare city, so the full answer normally matches on the first try.
  async function fillLocationAutocomplete(field, answer, shouldAbort = () => false) {
    const input = getLocationInput(field);
    const answerText = normalizeZipRecruiterText(answer);
    if (!input || !answerText || shouldAbort()) return false;
    const leadingSegment = answerText.split(",")[0]?.trim();
    const searchTerms = leadingSegment && leadingSegment !== answerText ? [answerText, leadingSegment] : [answerText];
    for (const term of searchTerms) {
      typeLocationSearch(input, term);
      const options = await waitForLocationOptions(input, shouldAbort);
      if (shouldAbort()) return false;
      if (!options || options.length === 0) continue;
      const best = getBestMatchingOption(answerText, options);
      if (best?.element) {
        selectLocationOption(best.element);
        await dom.sleep(100);
        return true;
      }
    }
    return false; // no suggestion matched the answer or its leading segment — leave it typed, unresolved
  }

  // ---- File uploads -----------------------------------------------------------

  // The displayed name can be ZR's own truncated form ("my-long-resume-na....pdf").
  function displayedNameMatches(displayed, fileName) {
    const shown = normalizeZipRecruiterText(displayed);
    const wanted = normalizeZipRecruiterText(fileName);
    if (!shown || !wanted) return false;
    if (shown === wanted) return true;
    const ellipsis = shown.indexOf("...");
    if (ellipsis === -1) return false;
    return wanted.startsWith(shown.slice(0, ellipsis)) && wanted.endsWith(shown.slice(ellipsis + 3));
  }
  // Legacy widget: `.uploaded_resume .file_name_text`. New widgets: the file
  // name is a bare text node next to the Replace/Remove (or Replace/Delete)
  // buttons — the only token in the widget that looks like a file.
  function getPickedFileName(widget) {
    const legacyName = normalizeZipRecruiterText(widget?.querySelector(".uploaded_resume .file_name_text")?.textContent);
    if (legacyName) return legacyName;
    const leaves = Array.from(widget?.querySelectorAll("span, div, p") ?? []).filter((node) => node.children.length === 0 && !node.closest("button"));
    const token = leaves.map((node) => normalizeZipRecruiterText(node.textContent)).find((text) => FILE_NAME_TEXT.test(text) || /\.{3}\w+$/.test(text));
    return token || "";
  }
  function getPickedResumeFileName(input) {
    const widget = input?.closest(".ApplyResumeUpload") || input?.parentElement;
    return getPickedFileName(widget);
  }
  function hasUploadInFlight(scope) {
    return Boolean(scope?.querySelector('[class*="loading" i], [class*="uploading" i], [class*="spinner" i], [role="progressbar"], [aria-busy="true"]'));
  }
  function getUploadError(scope) {
    return (
      Array.from(scope?.querySelectorAll('[id$="-error"], [role="alert"]') ?? [])
        .map((node) => normalizeZipRecruiterText(node.textContent))
        .find((text) => UPLOAD_ERROR_TEXT.test(text)) ?? null
    );
  }
  async function ensureFileInput(field, shouldAbort) {
    return dom.getFileInputInsideField(field) || waitFor(() => dom.getFileInputInsideField(field), 1000, shouldAbort, 100);
  }
  // Legacy step 2 fallback: some dropzones ignore a change event while a file
  // is already picked — clear it with ZR's own Remove button, then attach
  // again on the (possibly re-mounted) input.
  async function removePickedResume(input, shouldAbort) {
    const removeButton = input.closest(".ApplyResumeUpload")?.querySelector(".remove_button");
    if (!removeButton || !isElementVisible(removeButton)) return false;
    removeButton.click();
    return Boolean(await waitFor(() => (getPickedResumeFileName(input) ? null : true), RESUME_REMOVE_TIMEOUT_MS, shouldAbort, 200));
  }
  // Step 1 auto-advances to the contact form once ZR has parsed the file;
  // step 2's Replace re-parses in place. Either way this must not resolve
  // while the upload/parse is still in flight, or a caller would move on to
  // a contact form still being rewritten underneath it.
  async function waitForResumeUploadSettled(input, fileName, shouldAbort) {
    if (input.name === "ResumeUpload") {
      const advanced = await waitFor(
        () => (!input.isConnected || getContactForm(getApplyFlowRoot()) || getScreenerFields(getApplyFlowRoot()).length > 0 ? true : null),
        RESUME_START_ADVANCE_TIMEOUT_MS,
        shouldAbort,
        200
      );
      return Boolean(advanced);
    }
    const settled = await waitFor(
      () => (!hasUploadInFlight(input.closest(".ApplyResumeUpload") || input.parentElement) && displayedNameMatches(getPickedResumeFileName(input), fileName) ? true : null),
      RESUME_REPLACE_SETTLE_TIMEOUT_MS,
      shouldAbort,
      200
    );
    if (settled) await dom.sleep(RESUME_REPLACE_SETTLE_MS);
    return Boolean(settled);
  }
  async function fillLegacyFileInput(field, answer, shouldAbort) {
    let input = await ensureFileInput(field, shouldAbort);
    if (!input || shouldAbort()) return false;
    if (displayedNameMatches(getPickedResumeFileName(input), answer.fileName)) return true; // already our file
    dom.fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
    if (await waitForResumeUploadSettled(input, answer.fileName, shouldAbort)) return true;
    if (shouldAbort() || input.name === "ResumeUpload") return false;
    if (!(await removePickedResume(input, shouldAbort)) || shouldAbort()) return false;
    input = (await ensureFileInput(field, shouldAbort)) || input;
    dom.fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
    return waitForResumeUploadSettled(input, answer.fileName, shouldAbort);
  }
  // A programmatic `.click()` on a file-opening button opens the OS file
  // dialog only while the page holds transient user activation (a real
  // click within the last ~5s — e.g. the panel's own Autofill press);
  // without it Chrome silently refuses the dialog and the input just sits
  // there, never receiving a change event. Wait any stale activation out
  // before pressing ZR's own upload button.
  async function waitForUserActivationToLapse(shouldAbort) {
    const activation = typeof navigator !== "undefined" ? navigator.userActivation : null;
    if (!activation) return;
    const deadline = Date.now() + USER_ACTIVATION_LAPSE_TIMEOUT_MS;
    while (activation.isActive && Date.now() < deadline && !shouldAbort()) await dom.sleep(250);
  }
  function getTransientFileInputs() {
    return Array.from(document.body?.querySelectorAll(':scope > input[type="file"]') ?? []);
  }
  // Press ZR's upload button, grab the hidden file input its own picker
  // appends to <body>, hand it the file.
  async function attachViaTransientPicker(button, answer, shouldAbort) {
    await waitForUserActivationToLapse(shouldAbort);
    if (shouldAbort()) return false;
    const before = new Set(getTransientFileInputs());
    button.click();
    const input = await waitFor(() => getTransientFileInputs().find((candidate) => !before.has(candidate)) || null, TRANSIENT_PICKER_WAIT_MS, shouldAbort, 50);
    if (!input) throw new Error("ZipRecruiter did not open its file picker");
    dom.fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
    return true;
  }
  function getUploadButton(field) {
    const scoped = getScreenerUploadButton(field) || getResumeBoxButton(field);
    if (scoped) return scoped;
    const root = getApplyFlowRoot();
    if (!isFlowElement(root)) return null;
    return getResumeStartButton(root) || getResumeBoxButton(getContactForm(root) || root) || null;
  }
  async function waitForTransientUploadSettled(field, button, fileName, shouldAbort) {
    const root = getApplyFlowRoot();
    const startedOnResumeStart = isFlowElement(root) && RESUME_START_LABEL.test(getButtonLabel(button));
    if (startedOnResumeStart) {
      const advanced = await waitFor(
        () => {
          const liveRoot = getApplyFlowRoot();
          if (!isFlowElement(liveRoot)) return null;
          return !button.isConnected || getContactForm(liveRoot) || getScreenerFields(liveRoot).length > 0 ? true : null;
        },
        RESUME_START_ADVANCE_TIMEOUT_MS,
        shouldAbort,
        200
      );
      if (!advanced) throw new Error("ZipRecruiter did not accept the uploaded resume");
      return;
    }
    let failure = null;
    const settled = await waitFor(
      () => {
        const widget = field?.isConnected ? field : getUploadButton(field) && getWidgetContainer(getUploadButton(field));
        failure = getUploadError(widget);
        if (failure) return true;
        if (hasUploadInFlight(widget)) return null;
        return displayedNameMatches(getPickedFileName(widget), fileName) ? true : null;
      },
      UPLOAD_SETTLE_TIMEOUT_MS,
      shouldAbort,
      200
    );
    if (failure) throw new Error(`ZipRecruiter rejected the file: ${failure}`);
    if (!settled && !shouldAbort()) throw new Error("ZipRecruiter did not show the uploaded file");
    if (settled) await dom.sleep(RESUME_REPLACE_SETTLE_MS);
  }
  async function fillFileField(fieldId, field, answer, shouldAbort = () => false) {
    if (!answer || typeof answer !== "object" || !answer.base64) return false; // not a {fileName, base64, mimeType} payload — nothing to attach
    if (dom.getFileInputInsideField(field)) {
      await fillLegacyFileInput(field, answer, shouldAbort);
      return true;
    }
    const button = getUploadButton(field);
    if (!button) throw new Error(`ZipRecruiter: upload control for ${fieldId} not found`);
    // Already showing our file (a resumed draft, or the resume step 1 just parsed) → nothing to do.
    const widget = field?.isConnected && field.contains(button) ? field : getWidgetContainer(button);
    if (!RESUME_START_LABEL.test(getButtonLabel(button)) && displayedNameMatches(getPickedFileName(widget), answer.fileName)) return true;
    const opened = await attachViaTransientPicker(button, answer, shouldAbort);
    if (!opened) return false;
    await waitForTransientUploadSettled(widget, button, answer.fileName, shouldAbort);
    return true;
  }

  // ---- Choice fields (radio / checkbox) ---------------------------------------

  function isTruthyCheckboxAnswer(answer) {
    if (typeof answer === "boolean") return answer;
    return ["yes", "true", "y", "agree", "accepted", "consent"].includes(normalizeComparisonText(answer));
  }
  async function fillRadioField(field, answer, shouldAbort) {
    const buttons = getChoiceButtons(field, "radio");
    if (buttons.length > 0) {
      const options = buttons.map((element) => ({ element, text: getChoiceButtonText(element) })).filter((option) => option.text);
      const best = getBestMatchingOption(answer, options);
      if (!best || isChoiceButtonChecked(best.element)) return Boolean(best);
      await dom.clickLikeHuman(best.element, { shouldAbort });
      return true;
    }
    const inputs = dom.getRadioInputs(field);
    const options = inputs.map((input) => ({ input, text: dom.getInputLabelText(input) })).filter((option) => option.text);
    const best = getBestMatchingOption(answer, options);
    if (!best || best.input.checked) return Boolean(best);
    await dom.clickLikeHuman(best.input, { shouldAbort });
    best.input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  async function fillCheckboxField(field, answer, shouldAbort) {
    const buttons = getChoiceButtons(field, "checkbox");
    const inputs = buttons.length > 0 ? [] : dom.getCheckboxInputs(field);
    const controls =
      buttons.length > 0
        ? buttons.map((element) => ({
            text: getChoiceButtonText(element),
            checked: isChoiceButtonChecked(element),
            toggle: () => dom.clickLikeHuman(element, { shouldAbort }),
          }))
        : inputs.map((input) => ({
            text: dom.getInputLabelText(input),
            checked: input.checked,
            toggle: async () => {
              await dom.clickLikeHuman(input, { shouldAbort });
              input.dispatchEvent(new Event("change", { bubbles: true }));
            },
          }));
    if (controls.length === 0) return false;
    if (controls.length === 1) {
      const [control] = controls;
      const shouldCheck = isTruthyCheckboxAnswer(answer) || normalizeComparisonText(answer) === normalizeComparisonText(control.text);
      if (control.checked !== shouldCheck) await control.toggle();
      return true;
    }
    // ZR renders some yes/no screeners as a single checkbox pair rather than
    // radios — a multi-select answer there would check BOTH; match each
    // option against the requested answer(s) individually instead.
    const requested = (Array.isArray(answer) ? answer : [answer]).map(normalizeComparisonText).filter(Boolean);
    for (const control of controls) {
      const label = normalizeComparisonText(control.text);
      const shouldCheck = requested.some((r) => r === label || label.includes(r) || r.includes(label));
      if (control.checked !== shouldCheck) await control.toggle();
    }
    return true;
  }

  // ---- Field-kind dispatch -----------------------------------------------------

  async function fillField(entry, value, shouldAbort = () => false) {
    const { fieldKind, field, fieldId, constraints } = entry;
    switch (fieldKind) {
      case "text": {
        const input = getVisibleTextInput(field);
        if (!input) return false;
        dom.fillTextInput(input, value);
        return true;
      }
      case "textarea": {
        const textarea = dom.getTextarea(field);
        if (!textarea) return false;
        dom.fillTextInput(textarea, value);
        return true;
      }
      case "date": {
        const input = getVisibleTextInput(field);
        if (!input) return false;
        dom.fillTextInput(input, formatDateForField(value, constraints));
        return true;
      }
      case LOCATION_FIELD_KIND:
        return fillLocationAutocomplete(field, value, shouldAbort);
      case "radio":
        if (value == null) return false;
        return fillRadioField(field, value, shouldAbort);
      case "checkbox":
        return fillCheckboxField(field, value, shouldAbort);
      case "combobox":
        return fillComboboxField(field, value, shouldAbort);
      case "file":
        return fillFileField(fieldId, field, value, shouldAbort);
      default:
        return false;
    }
  }

  // ---- profileData → field value resolution -----------------------------------

  function splitFullName(fullName) {
    const trimmed = String(fullName ?? "").trim();
    if (!trimmed) return { first: null, last: null };
    const parts = trimmed.split(/\s+/);
    return { first: parts[0], last: parts.length > 1 ? parts.slice(1).join(" ") : null };
  }
  function joinName(first, last) {
    return [first, last].filter(Boolean).join(" ").trim() || null;
  }
  // Maps a detected field's own question text to the conventional profile
  // key the existing simple adapters already use (full_name/first_name/
  // last_name/email/phone/linkedin/github/location) — ZipRecruiter's own
  // contact form splits first/last name, so both single- and split-name
  // callers are supported via splitFullName/joinName below.
  function classifySemanticKey(fieldId, question) {
    if (fieldId === RESUME_FIELD_ID) return "resume";
    if (fieldId === COVER_LETTER_FIELD_ID) return "cover_letter";
    const q = normalizeComparisonText(question);
    if (/\bfirst\s*name\b/.test(q)) return "first_name";
    if (/\blast\s*name\b/.test(q)) return "last_name";
    if (/\bfull\s*name\b/.test(q) || /^name\b/.test(q)) return "full_name";
    if (/\be[-]?mail\b/.test(q)) return "email";
    if (/\bphone\b/.test(q)) return "phone";
    if (/\blinkedin\b/.test(q)) return "linkedin";
    if (/\bgithub\b/.test(q)) return "github";
    if (/\b(location|city|zip|postal)\b/.test(q)) return "location";
    return null;
  }
  function resolveFieldValue(entry, profileData) {
    const key = classifySemanticKey(entry.fieldId, entry.question);
    switch (key) {
      case "resume":
        return profileData.__resumeFile ?? null;
      case "cover_letter":
        return profileData.__coverLetterFile ?? null;
      case "first_name":
        return profileData.first_name ?? splitFullName(profileData.full_name).first ?? null;
      case "last_name":
        return profileData.last_name ?? splitFullName(profileData.full_name).last ?? null;
      case "full_name":
        return profileData.full_name ?? joinName(profileData.first_name, profileData.last_name);
      case "email":
        return profileData.email ?? null;
      case "phone":
        return profileData.phone ?? null;
      case "linkedin":
        return profileData.linkedin ?? null;
      case "github":
        return profileData.github ?? null;
      case "location":
        return profileData.location ?? null;
      default:
        // An arbitrary employer screening question (radio/checkbox/combobox/
        // free text ZR itself defines) has no conventional key — only fill it
        // if the caller already resolved an answer keyed by OUR derived
        // fieldId (e.g. Big Banana's own answer store/UI). A free-text
        // question with no such answer is left untouched for the existing
        // AI-answer pipeline to pick up later.
        return Object.prototype.hasOwnProperty.call(profileData, entry.fieldId) ? profileData[entry.fieldId] : null;
    }
  }

  // ---- Public entry point -------------------------------------------------------

  // Fills every resolvable field on the CURRENT step, advances, and repeats
  // — bounded by maxSteps so a flow this module can't make progress on
  // (nothing left to fill, nothing safe to click) can't spin forever. Never
  // clicks the final Submit/Apply control; that's left for the human (or a
  // caller's own explicit, separately-gated submit step).
  async function fill(profileData = {}, opts = {}) {
    const { maxSteps = 25, shouldAbort = () => false } = opts;
    const results = [];
    for (let step = 0; step < maxSteps; step += 1) {
      if (shouldAbort()) break;
      if (getApplyFlowRoot() === FOREIGN_MODAL) break; // a different job's dialog covers the page
      const entries = detectFields();
      let filledAny = false;
      for (const entry of entries) {
        if (shouldAbort()) break;
        const value = resolveFieldValue(entry, profileData);
        if (value == null || value === "") continue;
        try {
          const didFill = await fillField(entry, value, shouldAbort);
          if (didFill) filledAny = true;
          results.push({ fieldId: entry.fieldId, question: entry.question, fieldKind: entry.fieldKind, filled: Boolean(didFill) });
        } catch (err) {
          results.push({ fieldId: entry.fieldId, question: entry.question, fieldKind: entry.fieldKind, filled: false, error: String(err?.message || err) });
        }
      }
      if (shouldAbort()) break;
      const advanced = await advance(shouldAbort);
      if (!advanced && !filledAny) break; // nothing happened this round — stuck (or done)
    }
    return results;
  }

  window.ProactiveAutofillSites = window.ProactiveAutofillSites || {};
  window.ProactiveAutofillSites.ziprecruiter = {
    isAutofillAvailable,
    detectFields,
    fill,
    getSubmitButton: getFinalSubmitButton,
    advance,
  };
})();
