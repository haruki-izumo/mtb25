/* =====================================================================
 * autofill/sites/ultipro-autofill.js — UltiPro (UKG Pro Recruiting)
 * opportunity pages (*.ultipro.com/.../JobBoard/.../OpportunityDetail...
 * and .../OpportunityApply...).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/ultipro/autofill.js. That
 * file's own field-filling MECHANICS are NOT re-implemented here —
 * they're exactly what autofill/engine/dom-interactions.js already
 * provides as window.ProactiveAutofillEngine (including its shadow-DOM-
 * piercing querySelectorDeep/querySelectorAllDeep, which UltiPro's own
 * UKG-Ignite web components need), so this file calls into that instead.
 *
 * OUT OF SCOPE (left to Big Banana's own existing systems, untouched —
 * UltiPro's own module is unusually large because it does ALL of the
 * following itself; none of it is ported):
 *   - Free-text answer GENERATION and the embedding-similarity option
 *     match fallback — only an exact (normalized) option-text match is
 *     ported.
 *   - The Work Experience / Education panels' own "add → open editor →
 *     fill → Save, committed entry collapses to a read-only card" EDITOR
 *     machinery (BidHub's root → group → leaf profile-section hierarchy
 *     in ../autofill-section-hierarchy.js). There is no plain, always-
 *     rendered row to fall back to here the way Dover/Freshteam have —
 *     every entry requires opening and saving an editor — so per the
 *     task's "don't touch repeatable sections beyond the first
 *     always-rendered row" rule, these two panels are left alone
 *     entirely; they are excluded from the generic scan below exactly
 *     like BidHub's own GENERIC_SCAN_SKIPPED_PANEL_TITLES does.
 *   - The Skills / Behaviors / Motivations chip-multi-select panels —
 *     also editor-based (open panel, type/pick chips, Save) with no
 *     plain control to detect; left alone for the same reason.
 *   - The Licenses and Certifications / Links panels — BidHub itself
 *     only excludes these from the generic scan; it implements no
 *     dedicated handler for them either (they're simply unautofilled in
 *     the source), so neither does this port.
 *   - The custom split month/day/year "Available start date" calendar
 *     widget (`#applicationAvailability` / `[data-automation^="day-
 *     interval-"]`) — a bespoke availability-calendar control, excluded
 *     from the generic scan (so its internal inputs are never
 *     mis-classified as plain text fields) with no replacement handler.
 *   - The entire sign-in/sign-up AUTH WALL (Auth0 Universal Login, the
 *     legacy UKG SSO app, and the tenant-local Register/AuthCode pages)
 *     — BidHub drives an error-driven sign-in ↔ sign-up steering loop
 *     there (../auth-driver-shared.js) with session-storage fallback
 *     tracking. That's orchestration, not structural field detection;
 *     this adapter simply reports nothing on any page that isn't the
 *     job posting or the application form itself.
 *   - CAPTCHA / proxy / remote-CDP lanes — not present in this module at
 *     all, so nothing to leave out.
 * ===================================================================== */
(function () {
  "use strict";

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    sleep,
    fillTextInput,
    fillSelectInput,
    fillFileInput,
    clickLikeHuman,
    getCheckboxInputs,
    getRadioInputs,
    getNativeSelect,
    getTextarea,
    getTextInput,
    getFileInputInsideField,
    querySelectorDeep,
    querySelectorAllDeep,
  } = engine;

  const REQUIRED_MARKERS = /[✱*]/g;
  const PANEL_WAIT_TIMEOUT_MS = 5000;
  const PANEL_SAVE_WAIT_TIMEOUT_MS = 8000;
  const DOCUMENT_UPLOAD_WAIT_TIMEOUT_MS = 30000;
  const SUBMIT_CONFIRM_WAIT_MS = 4000;
  const DOCUMENT_TYPE_RESUME = "Resume";
  const DOCUMENT_TYPE_COVER_LETTER = "Cover Letter";

  // Panels with their own add→editor→Save flow (profile-section hierarchy or
  // chip-multi-select) plus Documents (handled by dedicated fields below) —
  // excluded from the generic scan so none of their internal controls are
  // mis-detected as plain questions.
  const GENERIC_SCAN_SKIPPED_PANEL_TITLES = new Set([
    "Work Experience",
    "Education",
    "Skills",
    "Behaviors",
    "Motivations",
    "Licenses and Certifications",
    "Links",
    "Documents",
  ]);

  function normalizeUltiproText(value) {
    return String(value ?? "").replace(/ /g, " ").replace(REQUIRED_MARKERS, "").replace(/\s+/g, " ").trim();
  }
  function normalizeComparisonText(value) {
    return normalizeUltiproText(value).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }
  function slugifyFieldId(value) {
    return normalizeComparisonText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  function isElementVisible(element, { allowHiddenFileInput = false } = {}) {
    if (!element?.isConnected) return false;
    if (allowHiddenFileInput && element.matches?.('input[type="file"]')) return true;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }
  // A possibly-shadow-hosted button/element is "visible" the same way, via
  // the engine's shadow-piercing query helpers for lookup.
  function isVisibleDeep(element) {
    return Boolean(element) && isElementVisible(element);
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

  // ---- page-kind routing -----------------------------------------------
  // UltiPro's own autofill covers three very different page shapes under
  // one content script; only the posting (click Apply) and the actual
  // application form are in scope here — see the file banner for the
  // auth-wall carve-out.

  const JD_URL_PATTERN = /\/JobBoard\/[^/]+\/OpportunityDetail/i;
  function getApplyRoot() {
    return document.querySelector("#OpportunityApply");
  }
  function getPageKind() {
    if (getApplyRoot()) return "apply-form";
    if (JD_URL_PATTERN.test(window.location.pathname)) return "jd";
    return "auth"; // Auth0 / legacy SSO / tenant-local Register pages — out of scope.
  }

  // ---- panel / field lookups ---------------------------------------------

  function getPanelTitle(panel) {
    return normalizeUltiproText(panel?.querySelector?.('[data-automation="panel-title"]')?.textContent);
  }
  function getClosestPanel(control) {
    return control?.closest?.('[role="region"].panel') || null;
  }
  // The Documents panel's heading is an <h2> inside `#applicationDocumentsection`
  // (NOT a `[data-automation="panel-title"]` like the profile panels), so
  // resolve the panel container by walking up from that title node.
  function getDocumentsPanel() {
    const title = document.querySelector("#applicationDocumentsection");
    if (!title) return null;
    return title.closest('[role="region"].panel') || title.closest(".panel") || title.parentElement;
  }

  function getFieldQuestionText(field, control) {
    if (!field) return "";
    const linkedLabelText = normalizeUltiproText(control?.id ? document.querySelector(`label[for="${control.id}"]`)?.textContent : "");
    if (linkedLabelText) return linkedLabelText;
    const fieldAriaLabelledBy = String(field.getAttribute?.("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => normalizeUltiproText(document.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(" ");
    if (fieldAriaLabelledBy) return fieldAriaLabelledBy;
    const fieldLabelText = normalizeUltiproText(field.querySelector('.control-label, legend, h3, h4, p, [data-automation$="-label"]')?.textContent);
    if (fieldLabelText) return fieldLabelText;
    const ariaLabelledBy = String(control?.getAttribute?.("aria-labelledby") || "")
      .split(/\s+/)
      .map((id) => normalizeUltiproText(document.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(" ");
    if (ariaLabelledBy) return ariaLabelledBy;
    return normalizeUltiproText(control?.getAttribute?.("aria-label") || control?.name || control?.id);
  }
  function getQuestionField(control) {
    if (!control) return null;
    if (control.type === "radio") return control.closest('[role="radiogroup"]') || control.closest(".form-group, fieldset") || control;
    if (control.type === "checkbox") return control.closest('.form-group, [role="group"], fieldset') || control.closest(".checkbox") || control;
    if (control.tagName === "SELECT" || control.tagName === "TEXTAREA" || control.tagName === "INPUT") return control.closest(".form-group, fieldset") || control;
    return control.closest('.form-group, fieldset, [role="group"]') || control;
  }
  function getChoiceInputLabelText(input, fallbackQuestion = "") {
    if (!input) return fallbackQuestion;
    const wrappedLabelText = normalizeUltiproText(input.closest("label")?.textContent);
    if (wrappedLabelText) return wrappedLabelText;
    return normalizeUltiproText(input.value || fallbackQuestion);
  }
  function getVisibleOptionTexts(select) {
    return Array.from(select?.options ?? [])
      .map((option) => normalizeUltiproText(option.textContent || option.innerText))
      .filter((option) => option && !/^choose/i.test(option));
  }
  function buildOptionsWithDecline(select, field) {
    const options = getVisibleOptionTexts(select);
    const declineCheckbox = field?.querySelector('input[type="checkbox"]');
    const declineLabel = declineCheckbox ? getChoiceInputLabelText(declineCheckbox) : "";
    if (declineLabel) options.push(declineLabel);
    return options;
  }

  // The top "Upload a resume to autofill" control (`#ResumeParsingUploader`)
  // runs UKG's OWN parse-and-prefill pipeline, which re-renders the whole
  // form and conflicts with our autofill. Never touch it — resume/cover
  // letter go through the Documents section instead.
  function isResumeUploadControl(control) {
    return Boolean(control?.closest?.("#ResumeParsingUploader"));
  }
  function shouldSkipControl(control) {
    if (!control || control.disabled || control.readOnly) return true;
    if (["hidden", "submit", "button", "reset"].includes(control.type)) return true;
    const panelTitle = getPanelTitle(getClosestPanel(control));
    if (panelTitle && GENERIC_SCAN_SKIPPED_PANEL_TITLES.has(panelTitle)) return true;
    const documentsPanel = getDocumentsPanel();
    if (documentsPanel && documentsPanel.contains(control)) return true;
    if (isResumeUploadControl(control)) return true;
    if (control.closest('[data-automation="available-start-date-datepicker"]')) return true;
    if (control.closest("#applicationAvailability")) return true;
    if (control.closest('[data-automation^="day-interval-"]')) return true;
    if (control.getAttribute("data-automation") === "availability-note") return true;
    if (/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(start|end)\s+time/i.test(control.getAttribute("aria-label") || "")) return true;
    if (control.id === "notes") return true;
    return false;
  }

  // Number-only inputs (screening "How many years…" / salary questions) are
  // plain type="text" inputs bound with Knockout autoNumeric
  // (data-automation="numeric-response") — a generic text fill would hand
  // them prose ("12 years.") the autoNumeric binding rejects at save, so
  // they get their own fieldKind.
  function isUltiproNumericInput(input) {
    if (!input || input.tagName !== "INPUT") return false;
    if (input.getAttribute("data-automation") === "numeric-response") return true;
    if (input.type === "number") return true;
    return /\bautoNumeric\b/.test(input.getAttribute("data-bind") || "");
  }
  function getNumericBounds(input) {
    const dataBind = input?.getAttribute?.("data-bind") || "";
    return { min: dataBind.match(/vMin:\s*(-?\d+(?:\.\d+)?)/)?.[1], max: dataBind.match(/vMax:\s*(-?\d+(?:\.\d+)?)/)?.[1] };
  }
  // First number in a possibly-prose answer ("12 years.", "$110,000 –
  // $170,000" → 110000), comma groups stripped, clamped to the binding's
  // vMin/vMax, rounded to a whole number (the binding accepts only whole
  // numbers). Null when the answer holds no number at all — better an
  // empty field than prose the save rejects.
  function toWholeNumberAnswer(answer, input) {
    const match = String(answer ?? "").match(/-?\d[\d,]*(?:\.\d+)?/);
    if (!match) return null;
    let number = Number(match[0].replace(/,/g, ""));
    if (!Number.isFinite(number)) return null;
    const { min, max } = getNumericBounds(input);
    if (min !== undefined) number = Math.max(number, Number(min));
    if (max !== undefined) number = Math.min(number, Number(max));
    return String(Math.round(number));
  }

  // Classify a (field, control) pair into the fieldKind the generic scan
  // can fill. A LONE radio or LONE checkbox (length === 1, not > 1) falls
  // through to no match here — same as BidHub's own source — and is left
  // for Big Banana's existing generic pipeline rather than guessed at.
  function detectGenericFieldMetadata(question, field, control) {
    const radioInputs = getRadioInputs(field);
    if (radioInputs.length > 1) {
      return { fieldKind: "radio", options: radioInputs.map((input) => getChoiceInputLabelText(input, question)).filter(Boolean) };
    }
    const checkboxInputs = getCheckboxInputs(field);
    if (checkboxInputs.length > 1) {
      return { fieldKind: "checkbox", options: checkboxInputs.map((input) => getChoiceInputLabelText(input, question)).filter(Boolean) };
    }
    const select = getNativeSelect(field);
    if (select) {
      const hasDeclineCheckbox = checkboxInputs.length === 1 && /decline/i.test(getChoiceInputLabelText(checkboxInputs[0]));
      return {
        fieldKind: hasDeclineCheckbox ? "select-or-decline" : "select-native",
        options: hasDeclineCheckbox ? buildOptionsWithDecline(select, field) : getVisibleOptionTexts(select),
      };
    }
    const textarea = getTextarea(field);
    if (textarea) return { fieldKind: "textarea", options: [] };
    const textInput = getTextInput(field);
    if (textInput) return { fieldKind: isUltiproNumericInput(textInput) ? "numeric" : "text", options: [] };
    return null;
  }
  function buildFieldId(control, question) {
    return control?.id || control?.name || slugifyFieldId(question);
  }

  function addDocumentFieldEntries(questions, documentsPanel) {
    if (!documentsPanel) return;
    // Canonical 'resume'/'cover_letter' fieldIds — the panel's own document
    // card (type select / attach) keys on these exact fieldIds.
    questions.push({ question: "Resume/CV", fieldId: "resume", field: documentsPanel, control: null, fieldKind: "resume", options: [] });
    questions.push({ question: "Cover Letter", fieldId: "cover_letter", field: documentsPanel, control: null, fieldKind: "cover_letter", options: [] });
  }

  function collectGenericFields(root, questions, usedFieldIds, seenChoiceGroups) {
    const controls = Array.from(root.querySelectorAll('input:not([type="hidden"]), textarea, select'))
      .filter((control) => isElementVisible(control, { allowHiddenFileInput: true }))
      .filter((control) => !shouldSkipControl(control));
    for (const control of controls) {
      if (control.type === "file") continue;
      const field = getQuestionField(control);
      if (!field) continue;
      if ((control.type === "radio" || control.type === "checkbox") && control.name) {
        if (seenChoiceGroups.has(control.name)) continue;
        seenChoiceGroups.add(control.name);
      }
      const question = getFieldQuestionText(field, control);
      if (!question) continue;
      const fieldId = buildFieldId(control, question);
      if (!fieldId || usedFieldIds.has(fieldId)) continue;
      const metadata = detectGenericFieldMetadata(question, field, control);
      if (!metadata) continue;
      usedFieldIds.add(fieldId);
      questions.push({ question, fieldId, field, control, fieldKind: metadata.fieldKind, options: metadata.options });
    }
  }

  /** Walk UltiPro's application form and return every question this
   *  adapter can fill deterministically: {question, fieldId, field,
   *  control, fieldKind, options}. See the file banner for everything
   *  deliberately excluded (profile-section editors, chip panels,
   *  availability calendar, auth pages). */
  function detectFields() {
    const root = getApplyRoot();
    if (!root) return [];
    const questions = [];
    const usedFieldIds = new Set();
    addDocumentFieldEntries(questions, getDocumentsPanel());
    collectGenericFields(root, questions, usedFieldIds, new Set());
    return questions;
  }

  // ---- "jd" posting page → apply form -------------------------------------

  // The one navigational step this adapter drives: the posting page's
  // "Apply Now" button, which (per tenant) either reveals #OpportunityApply
  // directly or routes through the (out-of-scope) auth wall first.
  async function advance({ shouldAbort = () => false } = {}) {
    if (getPageKind() !== "jd") return false;
    const applyButton = querySelectorDeep('[data-automation="apply-now-button"]');
    if (!isVisibleDeep(applyButton) || shouldAbort()) return false;
    await clickLikeHuman(applyButton, { shouldAbort });
    return true;
  }

  // ---- filling --------------------------------------------------------------

  // Exact (normalized) option-text match only — deliberately NOT BidHub's
  // own embedding-similarity fallback. A looser miss is left for Big
  // Banana's existing generic pipeline.
  function findMatchingOptionText(answer, options) {
    const normalizedAnswer = normalizeComparisonText(answer);
    if (!normalizedAnswer || !Array.isArray(options) || options.length === 0) return null;
    return options.find((option) => normalizeComparisonText(option) === normalizedAnswer) ?? null;
  }
  function normalizeAnswerList(answer) {
    if (Array.isArray(answer)) return answer.map(normalizeUltiproText).filter(Boolean);
    return String(answer ?? "").split(/[\n,;]/).map(normalizeUltiproText).filter(Boolean);
  }
  // Knockout-bound text inputs need an explicit `change` dispatch on top of
  // the engine's own React-safe write/blur (fillTextInput doesn't fire
  // `change`, which is what the KO binding listens for).
  function fillKnockoutTextInput(input, value) {
    if (!input) return;
    fillTextInput(input, String(value ?? ""));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  async function fillRadioGroup(field, answer, shouldAbort) {
    const normalizedAnswer = normalizeComparisonText(answer);
    const input = getRadioInputs(field).find((option) => normalizeComparisonText(getChoiceInputLabelText(option)) === normalizedAnswer);
    if (input && !input.checked) await clickLikeHuman(input, { shouldAbort });
  }
  async function fillCheckboxGroup(field, answer, shouldAbort) {
    const answers = new Set(normalizeAnswerList(answer).map(normalizeComparisonText));
    for (const input of getCheckboxInputs(field)) {
      const shouldCheck = answers.has(normalizeComparisonText(getChoiceInputLabelText(input)));
      if (input.checked !== shouldCheck) await clickLikeHuman(input, { shouldAbort });
    }
  }
  function chooseSelectOption(select, rawValue) {
    const normalizedValue = normalizeUltiproText(rawValue);
    if (!select || !normalizedValue) return false;
    const matchedOption = findMatchingOptionText(normalizedValue, getVisibleOptionTexts(select));
    if (!matchedOption) return false;
    const optionNode = Array.from(select.options).find((option) => normalizeComparisonText(option.textContent || option.innerText) === normalizeComparisonText(matchedOption));
    if (!optionNode) return false;
    fillSelectInput(select, optionNode.value);
    return true;
  }
  async function fillSelectOrDecline(field, answer, shouldAbort) {
    const normalizedAnswer = normalizeComparisonText(answer);
    const checkbox = field.querySelector('input[type="checkbox"]');
    if (checkbox && normalizedAnswer.includes("decline")) {
      if (!checkbox.checked) await clickLikeHuman(checkbox, { shouldAbort });
      return;
    }
    if (checkbox?.checked) await clickLikeHuman(checkbox, { shouldAbort });
    chooseSelectOption(getNativeSelect(field), answer);
  }

  // ---- Documents panel (resume / cover letter upload) ---------------------

  function getDocumentFileRows(panel) {
    return Array.from(panel?.querySelectorAll('[data-automation="file-row"]') || []).filter((row) => row.isConnected);
  }
  function getDocumentRowFileName(row) {
    const node =
      row?.querySelector('[data-automation="file-name"] span[id^="FileName"]') || row?.querySelector('[data-automation="file-link"]') || row?.querySelector('[data-automation="file-name"]');
    return normalizeUltiproText(node?.textContent);
  }
  function getDocumentRowType(row) {
    const select = row?.querySelector('[data-automation="file-type"]');
    if (!select) return "";
    return normalizeUltiproText(select.options?.[select.selectedIndex]?.textContent);
  }
  // The Documents uploader exposes a fresh empty `upload-file-input` per
  // pending file; pick the one that has no file attached yet.
  function getActiveDocumentUploadInput(panel) {
    const inputs = Array.from(panel?.querySelectorAll('input[type="file"][data-automation="upload-file-input"]') || []).filter((input) => input.isConnected);
    return [...inputs].reverse().find((input) => !input.files || input.files.length === 0) || inputs[0] || null;
  }
  // Rows are deleted via their `delete-file-link` anchor (immediate, no
  // confirm dialog) — used when re-attaching a DIFFERENT file of the same
  // document type.
  async function removeDocumentRow(panel, row, shouldAbort) {
    const deleteLink = row?.querySelector('[data-automation="delete-file-link"]');
    if (!deleteLink) return false;
    const priorCount = getDocumentFileRows(panel).length;
    deleteLink.click();
    const removed = await waitFor(() => (getDocumentFileRows(panel).length < priorCount ? true : null), PANEL_SAVE_WAIT_TIMEOUT_MS);
    return Boolean(removed);
  }
  async function uploadDocument(answer, docType, shouldAbort = () => false) {
    if (!answer || typeof answer !== "object" || answer.type !== "file") return;
    const panel = getDocumentsPanel();
    if (!panel || shouldAbort()) return;

    // Replace any existing row of this type — a re-attach from the panel
    // means a new/tailored file, which can carry the SAME fileName as the
    // original, so no filename-based skip.
    const existingRow = getDocumentFileRows(panel).find((row) => normalizeComparisonText(getDocumentRowType(row)) === normalizeComparisonText(docType));
    if (existingRow) {
      const removed = await removeDocumentRow(panel, existingRow, shouldAbort);
      if (!removed) return;
    }
    const input = getActiveDocumentUploadInput(panel);
    if (!input) return;
    const priorCount = getDocumentFileRows(panel).length;
    fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
    const newRow = await waitFor(() => {
      if (shouldAbort()) return null;
      const rows = getDocumentFileRows(panel);
      if (rows.length <= priorCount) return null;
      return rows.find((row) => getDocumentRowFileName(row) === normalizeUltiproText(answer.fileName)) || rows[rows.length - 1] || null;
    }, DOCUMENT_UPLOAD_WAIT_TIMEOUT_MS);
    if (!newRow || shouldAbort()) return;

    const typeSelect = await waitFor(() => {
      const select = newRow.querySelector('[data-automation="file-type"]');
      return select?.options?.length > 1 ? select : null;
    }, PANEL_WAIT_TIMEOUT_MS);
    if (!typeSelect) return;
    chooseSelectOption(typeSelect, docType);
    if (normalizeComparisonText(getDocumentRowType(newRow)) !== normalizeComparisonText(docType)) {
      await sleep(150);
      chooseSelectOption(newRow.querySelector('[data-automation="file-type"]') || typeSelect, docType);
    }
    await sleep(150);
  }

  /** Write an already-resolved answer into a question returned by
   *  detectFields(), dispatched by its fieldKind. `answer` is a string for
   *  text/numeric/textarea/select-native/select-or-decline/radio;
   *  string|string[] for checkbox; {type:"file", fileName, base64,
   *  mimeType} for resume/cover_letter. */
  async function fillField(question, answer, { shouldAbort = () => false } = {}) {
    const { field, control, fieldKind } = question;
    if (answer == null || shouldAbort()) return;

    switch (fieldKind) {
      case "text": {
        const input = getTextInput(field);
        if (input) fillKnockoutTextInput(input, answer);
        return;
      }
      case "numeric": {
        const input = getTextInput(field);
        if (!input) return;
        const value = toWholeNumberAnswer(answer, input);
        if (value != null) fillKnockoutTextInput(input, value);
        return;
      }
      case "textarea": {
        const textarea = getTextarea(field);
        if (textarea) fillKnockoutTextInput(textarea, answer);
        return;
      }
      case "select-native": {
        chooseSelectOption(getNativeSelect(field), answer);
        return;
      }
      case "select-or-decline": {
        await fillSelectOrDecline(field, answer, shouldAbort);
        return;
      }
      case "radio": {
        await fillRadioGroup(field, answer, shouldAbort);
        return;
      }
      case "checkbox": {
        await fillCheckboxGroup(field, answer, shouldAbort);
        return;
      }
      case "resume": {
        await uploadDocument(answer, DOCUMENT_TYPE_RESUME, shouldAbort);
        return;
      }
      case "cover_letter": {
        await uploadDocument(answer, DOCUMENT_TYPE_COVER_LETTER, shouldAbort);
        return;
      }
      default: {
        // Unported fieldKinds never reach here — detectFields() only ever
        // emits the kinds handled above.
        void control;
        return;
      }
    }
  }

  // ---- submit ---------------------------------------------------------------

  function getSubmitButton() {
    if (!getApplyRoot()) return null;
    const button =
      document.querySelector('ukg-button[data-automation="btn-submit"], [data-automation="btn-submit"]') ||
      querySelectorDeep('ukg-button[data-automation="submit-application-button"]') ||
      Array.from(document.querySelectorAll("ukg-button"))
        .map((host) => host.shadowRoot?.querySelector('button[aria-label="Submit"], button[type="submit"]'))
        .find(Boolean) ||
      querySelectorDeep('button[aria-label="Submit"]');
    return isVisibleDeep(button) ? button : null;
  }
  function isSubmitButtonDisabled(button) {
    return Boolean(button?.disabled || button?.getAttribute?.("aria-disabled") === "true");
  }

  // Clicking Submit can be interrupted by `#AttachmentsChangedModal` —
  // "You've made changes to your documents. Would you like to save these
  // changes to your presence?" — which fires on effectively every
  // autofilled submit (autofill always changes the Documents panel). Click
  // its "Yes" to continue, or fall back to any other visible confirm
  // dialog's affirmative button.
  function findSubmitConfirmButton() {
    const attachmentsYes = document.querySelector('#AttachmentsChangedModal [data-automation="attachments-modal-yes"]');
    if (attachmentsYes && isElementVisible(attachmentsYes)) return attachmentsYes;
    const candidates = Array.from(document.querySelectorAll('.modal, [role="dialog"], [role="alertdialog"], [aria-modal="true"]'));
    for (const host of document.querySelectorAll("ukg-ignite-shell, ukg-button, [class*=\"modal\"]")) {
      if (host.shadowRoot) candidates.push(...host.shadowRoot.querySelectorAll('.modal, [role="dialog"], [role="alertdialog"], [aria-modal="true"]'));
    }
    for (const dialog of candidates) {
      if (!isElementVisible(dialog)) continue;
      if (dialog.contains(getApplyRoot())) continue;
      const buttons = Array.from(dialog.querySelectorAll('button, ukg-button, a.btn, [role="button"]')).filter((button) => isElementVisible(button));
      const affirmative =
        buttons.find((button) => /^yes\b/i.test(normalizeUltiproText(button.getAttribute("aria-label") || button.textContent))) ||
        buttons.find((button) => /^(save|ok|confirm|submit)\b/i.test(normalizeUltiproText(button.getAttribute("aria-label") || button.textContent)));
      if (affirmative) return affirmative;
    }
    return null;
  }
  async function clickSubmitButton({ shouldAbort = () => false } = {}) {
    const button = getSubmitButton();
    if (!button || shouldAbort()) return false;
    await clickLikeHuman(button, { shouldAbort });
    const confirmButton = await waitFor(() => findSubmitConfirmButton(), SUBMIT_CONFIRM_WAIT_MS);
    if (confirmButton) confirmButton.click();
    return true;
  }

  function isAutofillAvailable() {
    const kind = getPageKind();
    if (kind === "jd") return Boolean(querySelectorDeep('[data-automation="apply-now-button"]'));
    if (kind === "apply-form") return detectFields().length > 0 || Boolean(getSubmitButton());
    return false;
  }

  // ---- repeatable Work Experience/Education panels (ALL entries) --------
  // Ported from BidHub's own UltiPro section descriptors — driven by the
  // shared engine/section-hierarchy.js (window.ProactiveSectionHierarchy).
  // Deliberately separate from GENERIC_SCAN_SKIPPED_PANEL_TITLES above
  // (still excludes these two panels from the plain generic-question scan
  // — unchanged): this implements the dedicated multi-entry editor flow
  // the file banner called out of scope for the generic path. Every panel
  // item is either a read-only summary card or (while being added/edited)
  // an open editor exposing named data-automation inputs —
  // getUltiproSectionRows below folds the one currently-open item in at
  // the end so ensureRow()'s index lookup can find a just-added,
  // not-yet-saved entry.
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;

  function getPanelByTitle(title) {
    return Array.from(document.querySelectorAll('[role="region"].panel')).find((panel) => getPanelTitle(panel) === title) || null;
  }
  function getUltiproPanelItems(panel) {
    return Array.from(panel?.querySelectorAll?.('[data-automation="panel-list-item"]') ?? []);
  }
  // An item is "editing" once its editor's own hydration-probe control (a
  // field only the OPEN editor renders) is actually visible inside it.
  function isUltiproPanelItemEditing(item) {
    const probe = item?.querySelector?.('[data-automation="job-title-textbox"], [data-automation="school-textbox"]');
    return Boolean(probe) && isElementVisible(probe);
  }
  // "Committed" rows (closed, read-only cards) — the one item currently
  // being edited (if any) is appended at the end so a fill pass can still
  // resolve it by index via getRows()[index], same tradeoff this port's
  // other editor-mode sites (Workable) accept.
  function getUltiproSectionRows(panel) {
    const items = getUltiproPanelItems(panel);
    const committed = items.filter((item) => !isUltiproPanelItemEditing(item));
    const editingItem = items.find((item) => isUltiproPanelItemEditing(item));
    return editingItem ? [...committed, editingItem] : committed;
  }
  function getUltiproSectionEditor(panel) {
    return getUltiproPanelItems(panel).find((item) => isUltiproPanelItemEditing(item)) || null;
  }
  function getUltiproSectionRowField(rowEl, mapping) {
    const field = rowEl?.querySelector?.(mapping.selector);
    return field ? { field } : null;
  }
  async function addUltiproSectionRow(panel) {
    const button = Array.from(panel?.querySelectorAll?.('[data-automation="primary-action-button"]') ?? [])
      .filter((b) => isElementVisible(b))
      .find((b) => /\badd\b/i.test(normalizeUltiproText(b.textContent || b.getAttribute("aria-label"))));
    if (button) await clickLikeHuman(button);
  }
  // Repeatedly removes the first panel item — opening its editor first (to
  // reveal the remove control) when it isn't already showing one — until
  // none remain.
  async function removeAllPanelItems(panel) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const items = getUltiproPanelItems(panel);
      if (!items.length) return;
      const item = items[0];
      const findRemoveButton = () =>
        Array.from(item.querySelectorAll('[data-automation="remove-button"]')).find(
          (b) => isElementVisible(b) && /\b(delete|remove)\b/i.test(normalizeUltiproText(b.textContent || b.getAttribute("aria-label")))
        );
      let removeButton = findRemoveButton();
      if (!removeButton) {
        await clickLikeHuman(item);
        removeButton = await waitFor(() => findRemoveButton() || null, PANEL_WAIT_TIMEOUT_MS);
      }
      if (!removeButton) return;
      const priorCount = getUltiproPanelItems(panel).length;
      await clickLikeHuman(removeButton);
      await waitFor(() => (getUltiproPanelItems(panel).length < priorCount ? true : null), PANEL_SAVE_WAIT_TIMEOUT_MS);
      await sleep(200);
    }
  }
  async function savePanelEditor(panel) {
    const editingItem = getUltiproSectionEditor(panel);
    const scope = editingItem || panel;
    const saveButton = Array.from(scope?.querySelectorAll?.('[data-automation="save-button"]') ?? []).find(isElementVisible);
    if (saveButton) await clickLikeHuman(saveButton);
    if (editingItem) await waitFor(() => (!isUltiproPanelItemEditing(editingItem) ? true : null), PANEL_SAVE_WAIT_TIMEOUT_MS);
    else await sleep(300);
  }
  // Knockout-bound (same as fillKnockoutTextInput above) — dispatches
  // `change` on top of the engine's React-safe write/blur.
  async function fillUltiproSectionTextInput(field, value) {
    await engine.fillTextInputReliably(field, value);
    field.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // BCD's Profile.education/.experience (school/degree/start/end and
  // company/role/start/end/location — see server/src/models/Profile.js)
  // has no major/minor/field-of-study and no month/day split the way
  // UltiPro's own From/To Month+Year dropdown pair wants — those leaves
  // still detect (visible in the review list) but carry no
  // profileKey/resolveValue.
  const ULTIPRO_MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function parseUltiproMonthYear(raw) {
    const m = /^(\d{4})-(\d{1,2})$/.exec(String(raw || "").trim());
    return m ? { year: m[1], month: parseInt(m[2], 10) } : { year: "", month: null };
  }
  function monthFromRaw(raw) { return parseUltiproMonthYear(raw).month; }
  function yearFromRaw(raw) { return parseUltiproMonthYear(raw).year; }
  function monthNumToName(num) { return num >= 1 && num <= 12 ? ULTIPRO_MONTH_NAMES[num - 1] : null; }

  const ULTIPRO_WORK_HISTORY_SECTION = {
    rootFieldId: "workHistory",
    rootQuestion: "Work Experience",
    profileSection: "experience",
    panelTitle: "Work Experience",
    rowLabel: (i) => `Work Experience ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: () => getPanelByTitle("Work Experience"),
    getRows: getUltiproSectionRows,
    getEditor: getUltiproSectionEditor,
    getRowField: getUltiproSectionRowField,
    addRow: addUltiproSectionRow,
    clearRows: (panel) => removeAllPanelItems(panel),
    saveEntry: (panel) => savePanelEditor(panel),
    mappings: [
      { key: "title", selector: '[data-automation="job-title-textbox"]', fieldKind: "text", question: "Job Title", profileKey: "role" },
      { key: "company", selector: '[data-automation="company-textbox"]', fieldKind: "text", question: "Company", profileKey: "company" },
      { key: "location", selector: '[data-automation="location-textbox"]', fieldKind: "text", question: "Location", profileKey: "location" },
      { key: "fromMonth", selector: '[data-automation="from-month-dropdown"]', fieldKind: "dropdown", question: "From Month", resolveValue: (e) => monthNumToName(monthFromRaw(e?.start)) },
      { key: "fromYear", selector: '[data-automation="from-year-textbox"]', fieldKind: "text", question: "From Year", resolveValue: (e) => yearFromRaw(e?.start) || null },
      { key: "toMonth", selector: '[data-automation="to-month-dropdown"]', fieldKind: "dropdown", question: "To Month", resolveValue: (e) => monthNumToName(monthFromRaw(e?.end)) },
      { key: "toYear", selector: '[data-automation="to-year-textbox"]', fieldKind: "text", question: "To Year", resolveValue: (e) => yearFromRaw(e?.end) || null },
      { key: "description", selector: '[data-automation="description-textarea"]', fieldKind: "textarea", question: "Description" },
    ],
  };
  const ULTIPRO_EDUCATION_SECTION = {
    rootFieldId: "educationHistory",
    rootQuestion: "Education",
    profileSection: "education",
    panelTitle: "Education",
    rowLabel: (i) => `Education ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: () => getPanelByTitle("Education"),
    getRows: getUltiproSectionRows,
    getEditor: getUltiproSectionEditor,
    getRowField: getUltiproSectionRowField,
    addRow: addUltiproSectionRow,
    clearRows: (panel) => removeAllPanelItems(panel),
    saveEntry: (panel) => savePanelEditor(panel),
    mappings: [
      { key: "school", selector: '[data-automation="school-textbox"]', fieldKind: "text", question: "School", profileKey: "school" },
      { key: "degree", selector: '[data-automation="degree-textbox"]', fieldKind: "text", question: "Degree", profileKey: "degree" },
      { key: "major", selector: '[data-automation="major-dropdown"]', fieldKind: "dropdown", question: "Major" },
      { key: "minor", selector: '[data-automation="minor-dropdown"]', fieldKind: "dropdown", question: "Minor" },
    ],
  };
  const ULTIPRO_SECTIONS = [ULTIPRO_EDUCATION_SECTION, ULTIPRO_WORK_HISTORY_SECTION];

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections(ULTIPRO_SECTIONS, profileData);
  }

  async function fillSectionLeaf(field, mapping, value) {
    switch (mapping.fieldKind) {
      case "text":
      case "textarea":
        await fillUltiproSectionTextInput(field, value);
        return;
      case "dropdown": {
        if (field.tagName === "SELECT") {
          chooseSelectOption(field, value);
          return;
        }
        await engine.fillComboboxByTyping(field, value);
        return;
      }
      default:
        return;
    }
  }

  async function fillSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    const results = [];
    for (const section of ULTIPRO_SECTIONS) {
      const entries = profileData?.[section.profileSection] ?? [];
      if (!entries.length) continue;
      const result = await SECTION_HIERARCHY.fillSection(section, entries, fillSectionLeaf);
      results.push({ rootFieldId: section.rootFieldId, ...result });
    }
    return results;
  }

  NS.ultipro = {
    isAutofillAvailable,
    advance,
    detectFields,
    fillField,
    getSubmitButton,
    isSubmitButtonDisabled,
    clickSubmitButton,
    detectSections,
    fillSections,
  };
})();
