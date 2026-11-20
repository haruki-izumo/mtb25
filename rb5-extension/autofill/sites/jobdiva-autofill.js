/* =====================================================================
 * autofill/sites/jobdiva-autofill.js — JobDiva candidate-portal
 * "Quick Apply (No Account)" flow.
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/jobdiva/autofill.js. That
 * file's own field-filling MECHANICS (React-safe value writes,
 * human-cadence clicking, file attach) are NOT re-implemented here —
 * they're exactly what autofill/engine/dom-interactions.js already
 * provides as window.ProactiveAutofillEngine, so this file calls into
 * that instead.
 *
 * Navigation (advance() drives these): job posting "Apply Now" ->
 * chooser modal "Quick Apply (No Account)" -> application form
 * (modal-lg). After the candidate (or a caller's gated auto-submit)
 * clicks "Submit Application" the app is FILED, a "You've applied!"
 * confirmation shows a body "Next", and a final EEO voluntary
 * self-identification step (Sex/Race radios or selects) renders with
 * its own "Next".
 *
 * DOM notes:
 * - The application wizard is a `.modal-dialog.modal-lg`. Its body is
 *   `.modal-body-main`/`.job-app-main`; its terminal action button
 *   lives in `.job-app-btns` ("Submit Application" on the form step,
 *   "Next" on the EEO step).
 * - Form inputs carry NO id/name — only `label.jd-label` text + class
 *   `jd-form`. Fields are keyed off their `.job-app-text-field`
 *   wrapper + label text.
 * - The chooser `.modal-dialog.modal-sm` and the page-header
 *   "Apply Now" stay mounted/visible behind the wizard, so navigation
 *   lookups must be scoped to the currently-visible modal.
 *
 * OUT OF SCOPE (left to Big Banana's own existing systems, untouched):
 *   - Free-text screening-question ANSWER GENERATION. BidHub resolves
 *     almost every question (including the single-checkbox consent
 *     questions and the EEO radios/selects) through its own AI backend
 *     (getAnswer()/ai-core) — none of that is ported. detectQuestions()
 *     below only CLASSIFIES each question's structural type and
 *     locates its control/options; fillField() only WRITES an answer
 *     the caller already resolved. A caller with no answer for a given
 *     field simply never calls fillField for it, and Big Banana's
 *     existing generic AI-answer pipeline is free to pick that field up
 *     on its own pass.
 *   - Account-credential "create/confirm a password" VALUE generation
 *     (BidHub's own shared/password-answer.js). Not applicable here
 *     anyway: this file only ports JobDiva's "No Account" Quick Apply
 *     flow, which never renders a password field — detectContactFields()
 *     below only matches text/tel/email inputs, deliberately excluding
 *     type="password". If a tenant customization ever did add one, it
 *     would simply fall through undetected to Big Banana's existing
 *     pipeline rather than have a value synthesized for it here.
 *   - CAPTCHA and proxy/remote-CDP "real input" lanes — JobDiva's own
 *     quick-apply flow doesn't gate behind either, and this file never
 *     branches through BidHub's `useRemoteInput()` lane; every
 *     interaction goes straight through window.ProactiveAutofillEngine's
 *     synthetic-event path.
 *   - BidHub's dependent-question REORDERING (only used to sequence AI
 *     answers around a prior one). The underlying DETECTION — flagging
 *     a question whose correct answer depends on an earlier answer on
 *     the page — is purely structural (a regex over the question text)
 *     and is ported below as `dependsOnPrevious` on each detected
 *     question, so a caller's own answer pipeline can choose not to
 *     treat it like an ordinary standalone question.
 * ==================================================================== */
(function () {
  "use strict";

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    sleep,
    fillTextInputReliably,
    fillSelectInput,
    fillFileInput,
    clearFileInput,
    clickLikeHuman,
    getFileInputInsideField,
  } = engine;

  const NEVER_ABORT = () => false;

  // ---- small text/visibility helpers -------------------------------------

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Ported exactly as BidHub wrote it — note this is `||`, not `&&`: a
  // zero-width-but-tall (or zero-height-but-wide) element still counts as
  // visible for JobDiva's own modal/dropzone markup.
  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  // Poll `check` until it returns a truthy value, the timeout elapses, or
  // shouldAbort() goes true — ported from BidHub's shared
  // waitForPositiveResultWithAbort(), trimmed to this file's own needs.
  async function waitForPositiveResult(check, timeoutMs, { shouldAbort = NEVER_ABORT, intervalMs = 100 } = {}) {
    let remaining = timeoutMs ?? Number.MAX_VALUE;
    while (remaining >= 0) {
      if (shouldAbort()) return null;
      const result = check();
      if (result) return result;
      await sleep(intervalMs);
      remaining -= intervalMs;
    }
    return null;
  }

  // Flags a question whose correct answer depends on CONTEXT from a prior
  // answer — ported from BidHub's shared/dependent-question.js. Covers
  // "if so/if yes, please explain" follow-ups, conditional references to an
  // earlier choice, and pronoun references to a person introduced in a
  // previous question ("what's their email address?"). Detection only —
  // see the OUT OF SCOPE note above for why the reordering/AI side of this
  // isn't ported.
  const DEPENDENT_QUESTION_PATTERN =
    /\b(?:if\s+you\s+(?:answered|selected|chose|checked|picked|indicated|marked|said)|if\b[^.?!\n]*\babove\b|if\s+so|if\s+not|if\s+yes|if\s+no|if\s+applicable|previous\s+question|please\s+explain|please\s+specify|explain\s+why|explain\s+how|in\s+that\s+case)\b|\bwhat(?:'s|\s+is|\s+are|\s+was|\s+were)?\s+(?:their|his|her|its)\b|\bwho\s+(?:is|are|was|were)\s+(?:they|he|she|it)\b|\b(?:their|his|her)(?:\s+or\s+(?:her|his))?\s+(?:full\s+|first\s+|last\s+|work\s+|job\s+)?(?:name|e-?mail(?:\s+address)?|phone(?:\s+number)?|contact(?:\s+information|\s+info|\s+details)?|title|position|role|relationship|company|department|employee\s+(?:id|number)|id)\b|\b(?:this|that)\s+(?:person|individual|employee|referrer)\b|\bwho\s+referred\s+you\b|\bthe\s+(?:person|employee|individual|colleague)\s+(?:who|that)\s+referred\b/i;
  function isDependentQuestion(questionText) {
    return DEPENDENT_QUESTION_PATTERN.test(String(questionText ?? "").trim());
  }

  // ---- DOM scoping (modal lookups) ---------------------------------------

  const APP_MODAL_SELECTOR = ".modal-dialog.modal-lg";
  const CHOOSER_MODAL_SELECTOR = ".modal-dialog.modal-sm";
  const PRIMARY_ACTION_SELECTOR = ".job-app-btns button";

  // Visible application wizard (modal-lg) content node, or null when the
  // form is closed.
  function getAppModalContent() {
    for (const dialog of document.querySelectorAll(APP_MODAL_SELECTOR)) {
      if (!isVisible(dialog)) continue;
      const content = dialog.querySelector(".modal-content") || dialog;
      if (content.querySelector(".modal-body-main, .job-app-main")) return content;
    }
    return null;
  }
  function getAppModalBody(modal = getAppModalContent()) {
    if (!modal) return null;
    return modal.querySelector(".modal-body-main") || modal.querySelector(".job-app-main") || modal;
  }

  // The wizard's terminal action button: "Submit Application" (form step)
  // or "Next" (EEO step). This is the gated FINAL submit — never
  // auto-clicked by advance(). `.job-app-btns` also holds a "Cancel"
  // (.jd-btn-outline); pick the primary action.
  function getSubmitButton() {
    const modal = getAppModalContent();
    if (!modal) return null;
    const buttons = Array.from(modal.querySelectorAll(PRIMARY_ACTION_SELECTOR)).filter(isVisible);
    return (
      buttons.find((button) => !button.classList.contains("jd-btn-outline") && !/\bcancel\b/i.test(normalizeText(button.textContent))) ?? null
    );
  }

  // The post-submit confirmation advance ("Next" in the modal body, NOT in
  // `.job-app-btns`).
  function getConfirmationNextButton() {
    const body = getAppModalBody();
    if (!body) return null;
    return (
      Array.from(body.querySelectorAll("button")).find(
        (button) => !button.closest(".job-app-btns") && isVisible(button) && /^(next|continue)$/i.test(normalizeText(button.textContent))
      ) ?? null
    );
  }

  // "Quick Apply (No Account)" inside the visible chooser modal-sm.
  function getQuickApplyButton() {
    for (const dialog of document.querySelectorAll(CHOOSER_MODAL_SELECTOR)) {
      if (!isVisible(dialog)) continue;
      const button = Array.from(dialog.querySelectorAll("button")).find(
        (candidate) => isVisible(candidate) && /\b(quick apply|no account)\b/i.test(normalizeText(candidate.textContent))
      );
      if (button) return button;
    }
    return null;
  }

  // Page-header "Apply Now" that opens the chooser (only when no modal is
  // open yet).
  function getApplyNowButton() {
    return (
      Array.from(document.querySelectorAll('button, a, [role="button"]')).find(
        (candidate) => !candidate.closest(".modal") && isVisible(candidate) && /\bapply now\b/i.test(normalizeText(candidate.textContent))
      ) ?? null
    );
  }

  // ---- field detection ----------------------------------------------------

  function cleanLabel(labelElement) {
    if (!labelElement) return "";
    // Drop the trailing required-marker asterisk ("First Name*" -> "First Name").
    return normalizeText(labelElement.textContent).replace(/\s*\*\s*$/, "").trim();
  }
  function slugify(text) {
    return normalizeText(text).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }

  // Consent checkboxes carry no stable id/name (the DOM id is a
  // per-render UUID), and a single form can show several similar
  // phone/SMS/terms consents. Derive a stable, unique id from the (fixed)
  // label text; callers add an index tiebreaker on collision.
  function getConsentFieldId(labelText) {
    const slug = slugify(labelText).slice(0, 48);
    return `consent_${slug || "checkbox"}`;
  }

  function detectContactFields(body, questions, seenFieldIds) {
    for (const wrapper of body.querySelectorAll(".job-app-text-field")) {
      const layout = wrapper.querySelector(".jd-form-layout");
      if (!layout) continue;
      const label = layout.querySelector("label.jd-label");
      const input = layout.querySelector('input.jd-form, input.form-control, input[type="text"], input[type="tel"], input[type="email"]');
      if (!label || !input) continue;
      if (["file", "checkbox", "radio", "hidden"].includes(input.type)) continue;
      const question = cleanLabel(label);
      if (!question) continue;
      const fieldId = slugify(question) || `field_${questions.length + 1}`;
      if (seenFieldIds.has(fieldId)) continue;
      seenFieldIds.add(fieldId);
      questions.push({
        question,
        fieldId,
        fieldKind: "text",
        field: wrapper,
        control: input,
        options: [],
        required: Boolean(label.querySelector(".jd-text-red")),
        dependsOnPrevious: isDependentQuestion(question),
      });
    }
  }

  // The resume control re-renders after JobDiva parses the upload, so a
  // cached field reference can go stale. Resolve the LIVE resume container
  // (the `.jd-form-layout` holding BOTH the dropzone and, once uploaded,
  // the sibling `.jd-dropzone-filecard`).
  function getLiveResumeContainer(field) {
    if (field?.isConnected && field.querySelector?.(".jd-dropzone, .jd-dropzone-filecard")) return field;
    const anchor = getAppModalBody()?.querySelector(".jd-dropzone, .jd-dropzone-filecard");
    return anchor?.closest(".jd-form-layout") || anchor?.parentElement || null;
  }

  // Uploaded resume signal: JobDiva adds a `.jd-dropzone-filecard` as a
  // SIBLING of `.jd-dropzone` (NOT inside it), and swaps in a fresh empty
  // file input — so check the filecard at the container level, not inside
  // the dropzone or via input.files.
  function isResumeAlreadyUploaded(field) {
    return Boolean(getLiveResumeContainer(field)?.querySelector(".jd-dropzone-filecard"));
  }

  // The filecard's remove control is the child element wrapping the (X)
  // svg icon (no aria-label/title — the React handler is bound to the
  // span/svg).
  function getResumeRemoveControl(container) {
    const filecard = container?.querySelector(".jd-dropzone-filecard");
    if (!filecard) return null;
    const spanWithSvg = Array.from(filecard.querySelectorAll("span")).find((span) => span.querySelector("svg"));
    return spanWithSvg || filecard.querySelector("svg") || null;
  }

  const RESUME_REMOVE_TIMEOUT_MS = 5000;
  const RESUME_UPLOAD_COMPLETE_TIMEOUT_MS = 60000;

  // Remove an already-uploaded resume: click the filecard's X and wait for
  // it to clear. The native input's own stale File is cleared separately
  // (see fillResumeField's clearFileInput() call) — clicking "remove" here
  // only clears JobDiva's own UI state.
  async function removeExistingResume(field, shouldAbort) {
    const removeControl = getResumeRemoveControl(getLiveResumeContainer(field));
    if (!removeControl) return;
    await clickLikeHuman(removeControl, { shouldAbort });
    await waitForPositiveResult(() => (isResumeAlreadyUploaded(field) ? null : true), RESUME_REMOVE_TIMEOUT_MS, { shouldAbort });
  }

  function detectResumeField(body, questions, seenFieldIds) {
    // Anchor on the dropzone OR an already-uploaded filecard, so the resume
    // field is detected (and re-uploadable/replaceable) in both the empty
    // and uploaded states.
    const anchor = body.querySelector(".jd-dropzone, .jd-dropzone-filecard");
    if (!anchor || seenFieldIds.has("resume")) return;
    const layout = anchor.closest(".jd-form-layout") || anchor.parentElement;
    if (!getFileInputInsideField(layout) && !layout?.querySelector(".jd-dropzone-filecard")) return;
    seenFieldIds.add("resume");
    questions.push({
      question: "Resume/CV",
      fieldId: "resume",
      fieldKind: "resume",
      field: layout || anchor,
      control: getFileInputInsideField(layout || anchor),
      options: null,
      required: false,
      dependsOnPrevious: false,
    });
  }

  function detectConsentFields(body, questions, seenFieldIds) {
    for (const checkbox of body.querySelectorAll('label.jd-checkbox input[type="checkbox"]')) {
      const wrapper = checkbox.closest("label.jd-checkbox");
      if (!wrapper) continue;
      let labelText = "";
      if (checkbox.id) {
        const linked = wrapper.querySelector(`label[for="${CSS.escape(checkbox.id)}"]`);
        labelText = normalizeText(linked?.textContent);
      }
      if (!labelText) labelText = normalizeText(wrapper.textContent);
      if (!labelText) continue;

      // Keep the id unique when multiple consents share a label prefix.
      let fieldId = getConsentFieldId(labelText);
      if (seenFieldIds.has(fieldId)) {
        let suffix = 2;
        while (seenFieldIds.has(`${fieldId}_${suffix}`)) suffix += 1;
        fieldId = `${fieldId}_${suffix}`;
      }
      seenFieldIds.add(fieldId);
      const required = Boolean(
        checkbox.required ||
          checkbox.getAttribute("aria-required") === "true" ||
          wrapper.closest(".jd-form-layout")?.querySelector(".jd-text-red, .eeo-label-mandatory")
      );

      // A standalone single checkbox is a yes/no question — fillField
      // treats it as a binary single-select rather than echoing the
      // (often long) consent sentence as the only option.
      questions.push({
        question: labelText,
        fieldId,
        fieldKind: "checkbox-single",
        field: wrapper,
        control: checkbox,
        options: ["Yes", "No"],
        required,
        dependsOnPrevious: false,
      });
    }
  }

  function detectEeoFields(eeoBody, questions, seenFieldIds) {
    // Radio groups (Sex, Race, ...). Option label is the sibling
    // `.radio-buttons-label`.
    for (const group of eeoBody.querySelectorAll(".radio-buttons-div")) {
      const radios = Array.from(group.querySelectorAll('input[type="radio"]'));
      const select = group.querySelector("select");
      const labelEl = group.querySelector(".eeo-label");
      const question = cleanLabel(labelEl) || `EEO question ${questions.length + 1}`;
      const required = Boolean(labelEl?.querySelector(".eeo-label-mandatory"));

      if (radios.length > 0) {
        const fieldId = `eeo_${radios[0].name || slugify(question)}`;
        if (seenFieldIds.has(fieldId)) continue;
        seenFieldIds.add(fieldId);
        const options = Array.from(group.querySelectorAll(".radio-buttons-label"))
          .map((el) => normalizeText(el.textContent))
          .filter(Boolean);
        questions.push({
          question,
          fieldId,
          fieldKind: "eeo-radio",
          field: group,
          control: radios[0],
          options,
          required,
          dependsOnPrevious: false,
        });
      } else if (select) {
        const fieldId = `eeo_${select.name || slugify(question)}`;
        if (seenFieldIds.has(fieldId)) continue;
        seenFieldIds.add(fieldId);
        const options = Array.from(select.querySelectorAll("option"))
          .filter((option) => option.value)
          .map((option) => normalizeText(option.textContent))
          .filter(Boolean);
        questions.push({
          question,
          fieldId,
          fieldKind: "eeo-select",
          field: group,
          control: select,
          options,
          required,
          dependsOnPrevious: false,
        });
      }
    }
  }

  /**
   * Walk JobDiva's currently-open application wizard and return every
   * question this adapter knows how to fill deterministically. The EEO
   * step renders ONLY its own radio/select questions (contact/resume/
   * consent fields never coexist with it), so that step short-circuits
   * the rest of detection the same way JobDiva itself only shows it after
   * the main form is submitted.
   *
   * @returns {Array<{question:string, fieldId:string, field:Element,
   *   control:Element|null, fieldKind:string, options:string[]|null,
   *   required:boolean, dependsOnPrevious:boolean}>}
   */
  function detectQuestions() {
    const modal = getAppModalContent();
    if (!modal) return [];
    const body = getAppModalBody(modal);
    if (!body) return [];

    const questions = [];
    const seenFieldIds = new Set();

    const eeoBody = body.querySelector(".eeo-body");
    if (eeoBody) {
      detectEeoFields(eeoBody, questions, seenFieldIds);
      return questions;
    }
    detectContactFields(body, questions, seenFieldIds);
    detectResumeField(body, questions, seenFieldIds);
    detectConsentFields(body, questions, seenFieldIds);
    return questions;
  }

  function isAutofillAvailable() {
    return Boolean(detectQuestions().length || getSubmitButton() || getConfirmationNextButton() || getQuickApplyButton() || getApplyNowButton());
  }

  // ---- multi-step advance (posting -> chooser -> form -> confirmation -> EEO) --

  const ADVANCE_CHAIN_WAIT_MS = 5000;

  /** Advance one field-less step of the wizard. Returns true when a step
   *  was clicked (caller should re-detect and keep filling), false when
   *  there's nothing safe to click — most importantly, this NEVER clicks
   *  the gated final "Submit Application"/EEO "Next" button
   *  (getSubmitButton()); that's left for the caller to click explicitly
   *  once it's actually ready to file the application. */
  async function advance({ shouldAbort = NEVER_ABORT } = {}) {
    if (getSubmitButton()) return false;

    // Post-submit confirmation -> EEO step.
    const confirmationNext = getConfirmationNextButton();
    if (confirmationNext) {
      await clickLikeHuman(confirmationNext, { shouldAbort });
      return true;
    }

    // Chooser modal -> open the no-account application form.
    const quickApply = getQuickApplyButton();
    if (quickApply) {
      await clickLikeHuman(quickApply, { shouldAbort });
      return true;
    }

    // Job posting -> open the chooser, then immediately pick "Quick Apply
    // (No Account)". This whole sequence is ONE logical "open the
    // application" advance: every field-less step (posting + chooser)
    // collapses into a single empty detection, so a caller that only
    // advances once per empty detection would otherwise click "Apply Now"
    // and never get to "Quick Apply". Chaining lands us on the real form,
    // whose field signature then re-triggers the caller's own fill pass.
    const applyNow = getApplyNowButton();
    if (applyNow) {
      await clickLikeHuman(applyNow, { shouldAbort });
      const quick = await waitForPositiveResult(() => getQuickApplyButton(), ADVANCE_CHAIN_WAIT_MS, {
        // Stop waiting if the form already opened some other way.
        shouldAbort: () => shouldAbort() || Boolean(getSubmitButton()),
        intervalMs: 100,
      });
      if (quick) await clickLikeHuman(quick, { shouldAbort });
      return true;
    }

    return false;
  }

  // ---- filling --------------------------------------------------------

  // Exact-or-prefix text match only — deliberately NOT the embedding/LLM
  // fuzzy match BidHub's own getBestMatchingOption() falls back to for an
  // option list with no clean match. An option this can't place
  // deterministically is left untouched rather than guessed.
  function matchOptionByText(entries, answer) {
    const normalizedAnswer = normalizeText(answer).toLowerCase();
    if (!normalizedAnswer) return null;
    return (
      entries.find((entry) => {
        const text = normalizeText(entry.text).toLowerCase();
        return text === normalizedAnswer || text.startsWith(normalizedAnswer) || normalizedAnswer.startsWith(text);
      }) ?? null
    );
  }

  // Re-entrancy lock for the resume replace (remove + re-upload). A caller
  // is expected to process each field once per run; this just guards
  // against a re-detection firing the handler again WHILE a replace is
  // mid-flight, which would otherwise loop the upload.
  let resumeReplaceInFlight = false;

  async function fillResumeField(question, answer, shouldAbort) {
    if (!answer || typeof answer !== "object" || answer.type !== "file") return;
    if (resumeReplaceInFlight) return;
    resumeReplaceInFlight = true;
    try {
      if (isResumeAlreadyUploaded(question.field)) {
        await removeExistingResume(question.field, shouldAbort);
        if (shouldAbort()) return;
      }
      const fileInput = getFileInputInsideField(getLiveResumeContainer(question.field) || question.field);
      if (!fileInput) return;
      // JobDiva's dropzone keeps the old File on the native input even
      // after its own "remove" UI click clears the filecard — re-attaching
      // the same/new file would then be a no-op for React's onChange.
      // Reset the input + its value tracker first, as dom-interactions.js's
      // own clearFileInput() comment calls out JobDiva specifically for.
      clearFileInput(fileInput);
      fillFileInput(fileInput, answer.fileName, answer.base64, answer.mimeType);
      // Wait for the upload+parse to finish: a `.jd-dropzone-filecard` appears.
      await waitForPositiveResult(() => (isResumeAlreadyUploaded(question.field) ? true : null), RESUME_UPLOAD_COMPLETE_TIMEOUT_MS, {
        shouldAbort,
      });
      await sleep(200);
    } finally {
      resumeReplaceInFlight = false;
    }
  }

  /**
   * Write an already-resolved answer into a question returned by
   * detectQuestions(), dispatched by its fieldKind. The caller owns
   * deciding WHAT the answer is — this only owns getting it onto the page
   * using window.ProactiveAutofillEngine's primitives.
   *
   * @param {{field:Element, control:Element|null, fieldKind:string}} question
   * @param {*} answer - string for text; string|boolean for
   *   checkbox-single/eeo-radio/eeo-select (matched against the field's
   *   own option text); {type:"file", fileName, base64, mimeType} for resume.
   */
  async function fillField(question, answer, { shouldAbort = NEVER_ABORT } = {}) {
    if (!question || answer == null || shouldAbort()) return;
    const { field, control, fieldKind } = question;

    switch (fieldKind) {
      case "text": {
        if (!control) return;
        await fillTextInputReliably(control, answer, { shouldAbort });
        return;
      }
      case "checkbox-single": {
        if (!control) return;
        const normalizedAnswer = normalizeText(answer);
        const shouldCheck = typeof answer === "boolean" ? answer : Boolean(normalizedAnswer) && !/^(no|false|skip|none)$/i.test(normalizedAnswer);
        if (control.checked !== shouldCheck) {
          await clickLikeHuman(control, { shouldAbort });
          control.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return;
      }
      case "eeo-radio": {
        const rows = Array.from(field.querySelectorAll(".radio-button"))
          .map((row) => ({ input: row.querySelector('input[type="radio"]'), text: normalizeText(row.querySelector(".radio-buttons-label")?.textContent) }))
          .filter((row) => row.input);
        // Fall back to the standard EEO "decline to self-identify" option
        // when nothing matched — a required EEO radio group still needs
        // SOME selection to let the wizard advance.
        const chosen = matchOptionByText(rows, answer) ?? rows.find((row) => /do not wish to provide/i.test(row.text)) ?? null;
        if (chosen && !chosen.input.checked) {
          await clickLikeHuman(chosen.input, { shouldAbort });
          chosen.input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return;
      }
      case "eeo-select": {
        const select = field.querySelector("select");
        if (!select) return;
        const normalizedAnswer = normalizeText(answer).toLowerCase();
        const option = Array.from(select.querySelectorAll("option")).find((candidate) => {
          const text = normalizeText(candidate.textContent).toLowerCase();
          const value = String(candidate.value ?? "").trim().toLowerCase();
          return text === normalizedAnswer || value === normalizedAnswer || text.startsWith(normalizedAnswer);
        });
        if (option) fillSelectInput(select, option.value);
        return;
      }
      case "resume": {
        await fillResumeField(question, answer, shouldAbort);
        return;
      }
      default:
        return;
    }
  }

  NS.jobdiva = {
    isAutofillAvailable,
    detectQuestions,
    fillField,
    getSubmitButton,
    advance,
  };
})();
