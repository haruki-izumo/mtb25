/* =====================================================================
 * autofill/sites/recruitee-autofill.js — Recruitee careers application
 * forms (<company>.recruitee.com/o/<slug>).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/recruitee/autofill.js.
 *
 * Recruitee's offer page is a tab set: an "Overview" tab and an "Apply"
 * tab. The application form (#offer-application-form) is ALWAYS present
 * in the DOM, just `display:none` until the Apply tab is selected — so
 * detection reports zero fields while the panel is collapsed (the same
 * "reveal the posting into a form first" shape as BambooHR's
 * posting→form step, except Recruitee never navigates: it's the same
 * document, just a hidden panel) and advance() clicks the Apply tab to
 * reveal it.
 *
 * Every control carries a stable `candidate.*` name attribute — the
 * id's trailing `-N` counter and the styled-components `sc-*` classes
 * are NOT stable across renders — so detection keys off `name` rather
 * than id/class, same anchoring strategy BambooHR's `data-fabric-
 * component` keying uses for the same reason.
 *
 * Ported, structural-only:
 *   - field enumeration keyed by `candidate.*` name (label/legend
 *     resolution, field-kind classification: text, textarea, radio
 *     group, a lone consent checkbox, the "preferred work location"
 *     checkbox group, and the résumé/cover-letter file slots)
 *   - value-filling per field kind, including the cover-letter file
 *     <-> textarea toggle ("Write it here instead")
 *   - the Apply-tab reveal step and the final Send button's detection
 *
 * OUT OF SCOPE (left to Big Banana's own existing systems, untouched):
 *   - Free-text / single-select / multi-select ANSWER GENERATION.
 *     BidHub resolves every open question (including the Yes/No flag
 *     radios and the lone consent checkbox) through its own AI backend
 *     (ANSWER_TYPE_HANDLERS → getAnswer()) — none of that is ported.
 *     detectFields() below only classifies each control's structural
 *     type and locates it; fillField() only writes an answer the
 *     caller already resolved.
 *   - CAPTCHA.
 *   - The dependent-question reordering (isDependentQuestion) that only
 *     mattered for sequencing AI answers.
 *   - Proxy/remote-CDP "real input" lanes and the shared DOM-task mutex
 *     BidHub's own background runner serializes fills through — none
 *     of that job-runner infrastructure exists here.
 *   - The final "Send" button is never clicked here — BidHub's own
 *     advanceFlow() explicitly refuses to touch it too ("the gated
 *     final submit … must never be auto-clicked"). getSubmitButton()
 *     below exists purely so a caller can detect/display it.
 * ===================================================================== */
(function () {
  "use strict";
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    sleep,
    fillTextInput,
    fillFileInput,
    clickLikeHuman,
    getCheckboxInputs,
    getRadioInputs,
    getTextarea,
    getFileInputInsideField,
  } = engine;

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});

  const FORM_SELECTOR = "#offer-application-form";
  const SUBMIT_SELECTOR = 'button[data-testid="submit-application-form-button"]';
  // The Apply tab reveal control: the header tab and the "Apply" CTA both select it.
  const APPLY_TAB_SELECTOR = '[data-cy="apply-button-nav"], [data-cy="apply-button"]';
  const RESUME_FIELD = "candidate.cv";
  const COVER_LETTER_FIELD = "candidate.coverLetterFile";
  // Cover letter has two modes sharing one <section>: a file upload (candidate.coverLetterFile)
  // and, behind the "Write it here instead" toggle, a plain textarea (candidate.coverLetter).
  const COVER_LETTER_TEXT_FIELD = "candidate.coverLetter";
  const COVER_LETTER_TEXT_SELECTOR = 'textarea[data-cy="candidate.coverLetterText"], textarea[name="candidate.coverLetter"]';
  const COVER_LETTER_SWITCH_SELECTOR = 'button[data-cy="cover-letter-switch-button"]';
  const LOCATIONS_FIELD = "candidate.locations.value";
  const YES_NO_OPTIONS = ["Yes", "No"];
  const NEGATIVE_ANSWERS = new Set(["no", "false", "n", "off", "unchecked", "decline", "disagree", "none", "0"]);
  const COVER_LETTER_SWITCH_WAIT_TIMEOUT_MS = 5000;

  // ---- small text helpers -------------------------------------------------

  function cleanText(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .replace(/\*/g, "")
      .trim();
  }
  function cssEscape(value) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(String(value));
    return String(value).replace(/["\\]/g, "\\$&");
  }
  function isAffirmativeAnswer(answer) {
    if (typeof answer === "boolean") return answer;
    const text = cleanText(answer).toLowerCase();
    if (!text) return false;
    return !NEGATIVE_ANSWERS.has(text);
  }

  async function waitFor(check, timeoutMs, pollMs = 100, shouldAbort = () => false) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (shouldAbort()) return null;
      const result = check();
      if (result) return result;
      await sleep(pollMs);
    }
    return null;
  }

  // The form panel only gets a real layout once its tab is selected — zero client rects is
  // exactly the `display:none` collapsed state (a plain offsetParent/visibility check would
  // miss this the same way).
  function isFormVisible() {
    const form = document.querySelector(FORM_SELECTOR);
    return Boolean(form && form.getClientRects().length > 0);
  }

  // Required is signalled by the native `required` attribute, `aria-required`, AND/OR an
  // asterisk span (`span[title*="required"]`) inside the question's label/legend.
  function questionIsRequired(control, questionEl) {
    if (control?.required || control?.getAttribute?.("aria-required") === "true") return true;
    return Boolean(questionEl?.querySelector?.('span[title*="required" i]'));
  }

  // The user-facing prompt for a control. Order matters: a consent checkbox points its
  // `aria-labelledby` at the consent paragraph; grouped radios/checkboxes take their own
  // fieldset's legend; everything else uses `label[for]` / a wrapping label.
  function questionElementFor(control) {
    const labelledBy = control.getAttribute("aria-labelledby");
    if (labelledBy) {
      const el = document.getElementById(labelledBy.split(/\s+/)[0]);
      if (el) return el;
    }
    if (control.type === "radio" || control.type === "checkbox") {
      const legend = control.closest("fieldset")?.querySelector(":scope > legend");
      if (legend) return legend;
    }
    if (control.id) {
      const linked = document.querySelector(`label[for="${cssEscape(control.id)}"]`);
      if (linked) return linked;
    }
    return control.closest("label") || null;
  }
  function questionTextFor(control) {
    const text = cleanText(questionElementFor(control)?.textContent);
    if (text) return text;
    return cleanText(control.getAttribute("placeholder") || control.getAttribute("aria-label"));
  }

  // The per-option label for a radio/checkbox (e.g. "Yes", "Beginner (A1–A2)", "Remote
  // (Dallas…)").
  function optionLabelFor(input) {
    if (input.id) {
      const text = cleanText(document.querySelector(`label[for="${cssEscape(input.id)}"]`)?.textContent);
      if (text) return text;
    }
    return cleanText(input.value);
  }

  // ---- field detection ------------------------------------------------------

  /**
   * Walk Recruitee's application form and return every question this adapter knows how to
   * fill deterministically. Reports nothing while the Apply tab's panel is still collapsed,
   * so a caller sees "no fields yet" and reveals the form via advance() first — same shape as
   * BambooHR's posting→form boundary.
   *
   * @returns {Array<{question:string, fieldId:string, field:Element, fieldKind:string,
   *   options:string[]|null, required:boolean}>}
   */
  function detectFields() {
    const form = document.querySelector(FORM_SELECTOR);
    if (!form || !isFormVisible()) return [];

    const entries = [];
    const seen = new Set();
    const add = (entry) => {
      if (!entry.question || !entry.fieldId || !entry.field) return;
      if (seen.has(entry.fieldId)) return;
      seen.add(entry.fieldId);
      entries.push({ options: null, required: false, ...entry });
    };

    // Document order, so the list reads as the questions appear visually.
    for (const control of form.querySelectorAll('input:not([type="hidden"]), textarea, select')) {
      const name = control.getAttribute("name");
      if (!name || seen.has(name)) continue;
      const type = (control.getAttribute("type") || control.tagName).toLowerCase();

      // File uploads: only the résumé and cover letter map to a profile asset. Skip
      // candidate.photo and anything else — there's nothing to fill them with.
      if (type === "file") {
        if (name === RESUME_FIELD) {
          add({ question: questionTextFor(control) || "CV or resume", fieldId: "resume", field: control, fieldKind: "file", required: true });
        } else if (name === COVER_LETTER_FIELD) {
          // `field` is the whole <section>, not the file input itself: fillField's cover_letter
          // handler may toggle to text mode, which unmounts the file input and mounts a
          // textarea in the same section.
          add({
            question: questionTextFor(control) || "Cover letter",
            fieldId: "cover_letter",
            field: control.closest("section") || control.parentElement || control,
            fieldKind: "cover_letter",
          });
        }
        continue;
      }

      const questionEl = questionElementFor(control);
      const question = questionTextFor(control);
      if (!question) continue;
      const required = questionIsRequired(control, questionEl);

      // Preferred work location: a checkbox group (multi-select), scoped to its own fieldset.
      if (name === LOCATIONS_FIELD) {
        const fieldset = control.closest("fieldset");
        const boxes = Array.from((fieldset || form).querySelectorAll(`input[type="checkbox"][name="${cssEscape(name)}"]`));
        add({ question, fieldId: name, field: fieldset || control, fieldKind: "checkbox-multi", options: boxes.map(optionLabelFor).filter(Boolean), required });
        continue;
      }

      // Radio group: an open-question single-select (value === option text) OR a Yes/No flag.
      if (type === "radio") {
        const fieldset = control.closest("fieldset");
        const radios = Array.from((fieldset || form).querySelectorAll(`input[type="radio"][name="${cssEscape(name)}"]`));
        add({ question, fieldId: name, field: fieldset || control, fieldKind: "radio", options: radios.map(optionLabelFor).filter(Boolean), required });
        continue;
      }

      // A lone checkbox: a legal/consent agreement, modelled as a Yes/No question (same
      // convention as Lever's lone-checkbox consent field).
      if (type === "checkbox") {
        add({ question, fieldId: name, field: control, fieldKind: "checkbox", options: YES_NO_OPTIONS, required });
        continue;
      }

      if (control.tagName === "TEXTAREA") {
        // Cover letter already toggled to text mode before autofill ran — treat it as the
        // cover_letter asset, not a generic free-text question.
        if (name === COVER_LETTER_TEXT_FIELD) {
          add({
            question: question || "Cover letter",
            fieldId: "cover_letter",
            field: control.closest("section") || control.parentElement || control,
            fieldKind: "cover_letter",
          });
          continue;
        }
        add({ question, fieldId: name, field: control, fieldKind: "textarea", required });
        continue;
      }

      // Plain text/email/tel/number/date inputs, including name/email/phone. Phone is a
      // react-phone-number-input control: filling the `tel` input with a dial-code-prefixed
      // value ("+1 415…") makes the widget set its own country-calling-code selector as a side
      // effect of the text itself — no separate country control to drive.
      add({ question, fieldId: name, field: control, fieldKind: "text", required });
    }
    return entries;
  }

  // ---- submit detection + reveal --------------------------------------------

  // The Send button is present in the DOM even while the panel is collapsed — but it must
  // never be reported while hidden: "zero fields + an enabled submit" reads as a field-less
  // terminal step, which would make a caller settle on the collapsed POSTING panel instead of
  // revealing the form first.
  function getSubmitButton() {
    if (!isFormVisible()) return null;
    const form = document.querySelector(FORM_SELECTOR);
    return form?.querySelector(SUBMIT_SELECTOR) || form?.querySelector('button[type="submit"]') || null;
  }

  // The Apply tab is the only forward control while the form panel is collapsed.
  function getAdvanceButton() {
    if (isFormVisible()) return null; // already revealed — nothing to advance
    return document.querySelector(APPLY_TAB_SELECTOR);
  }

  // Reveals the form by selecting the Apply tab. Once the form is visible the only remaining
  // forward action is the gated final Send button, which this never reaches — advance() is a
  // no-op the moment isFormVisible() is true.
  async function advance({ shouldAbort = () => false } = {}) {
    if (isFormVisible()) return false;
    const advanceButton = getAdvanceButton();
    if (!advanceButton || shouldAbort()) return false;
    await clickLikeHuman(advanceButton, { shouldAbort });
    return true;
  }

  function isAutofillAvailable() {
    return Boolean(detectFields().length || getSubmitButton() || getAdvanceButton());
  }

  // ---- filling ----------------------------------------------------------------

  // Minimal base64 text encoder for the cover-letter .txt fallback below — handles non-ASCII
  // safely the same way BidHub's own encodeTextAsBase64 does.
  function encodeTextAsBase64(text) {
    return btoa(unescape(encodeURIComponent(text)));
  }

  // Writes `text` into the cover-letter textarea, flipping Recruitee's own "Write it here
  // instead" toggle first if the form is still in file-upload mode. Returns false only when
  // this posting has no such toggle at all (an older/custom form layout), so the caller can
  // fall back to attaching the text as a file instead.
  async function fillCoverLetterText(scope, text, { shouldAbort = () => false } = {}) {
    const existingTextarea = scope.querySelector?.(COVER_LETTER_TEXT_SELECTOR);
    if (existingTextarea) {
      fillTextInput(existingTextarea, text);
      return true;
    }
    const switchButton = scope.querySelector?.(COVER_LETTER_SWITCH_SELECTOR);
    if (!switchButton) return false;
    await clickLikeHuman(switchButton, { shouldAbort });
    const textarea = await waitFor(() => scope.querySelector?.(COVER_LETTER_TEXT_SELECTOR) ?? null, COVER_LETTER_SWITCH_WAIT_TIMEOUT_MS, 60, shouldAbort);
    if (!textarea) return false;
    fillTextInput(textarea, text);
    return true;
  }

  /**
   * Write an already-resolved answer into a question returned by detectFields(), dispatched
   * by its fieldKind. The caller owns deciding WHAT the answer is; this only owns getting it
   * onto the page using window.ProactiveAutofillEngine's primitives.
   *
   * @param {{field:Element, fieldKind:string}} entry
   * @param {*} answer - string for text/textarea; string|string[]|boolean for
   *   checkbox/checkbox-multi/radio; string or {type:"file", fileName, base64, mimeType} for
   *   cover_letter; {type:"file", fileName, base64, mimeType} for 'file' (résumé).
   */
  async function fillField(entry, answer, { shouldAbort = () => false } = {}) {
    if (!entry || answer == null || shouldAbort()) return;
    const { field, fieldKind } = entry;

    switch (fieldKind) {
      case "text": {
        if (field?.tagName === "INPUT") fillTextInput(field, String(answer));
        return;
      }
      case "textarea": {
        const textarea = field?.tagName === "TEXTAREA" ? field : getTextarea(field);
        if (textarea) fillTextInput(textarea, String(answer));
        return;
      }
      case "radio": {
        // Matches on the option LABEL (handles a Yes/No flag group whose radio value is
        // "true"/"false" but whose visible label is "Yes"/"No").
        const want = cleanText(answer).toLowerCase();
        if (!want) return;
        const radios = getRadioInputs(field);
        const pick =
          radios.find((r) => optionLabelFor(r).toLowerCase() === want || cleanText(r.value).toLowerCase() === want) ||
          radios.find((r) => optionLabelFor(r).toLowerCase().startsWith(want)) ||
          radios.find((r) => optionLabelFor(r).toLowerCase().includes(want));
        if (!pick || pick.checked) return;
        await clickLikeHuman(pick, { shouldAbort });
        return;
      }
      case "checkbox": {
        // Single consent/legal checkbox: check on an affirmative answer, leave it alone
        // (never forcibly untick) otherwise.
        const checkbox = field?.type === "checkbox" ? field : field?.querySelector('input[type="checkbox"]');
        if (!checkbox) return;
        const shouldCheck = isAffirmativeAnswer(answer);
        if (checkbox.checked !== shouldCheck) await clickLikeHuman(checkbox, { shouldAbort });
        return;
      }
      case "checkbox-multi": {
        // "Preferred work location" group: check every box whose label matches a wanted
        // value; leave the rest as-is.
        const wanted = (Array.isArray(answer) ? answer : [answer]).map((v) => cleanText(v).toLowerCase()).filter(Boolean);
        if (!wanted.length) return;
        for (const box of getCheckboxInputs(field)) {
          if (shouldAbort()) return;
          const label = optionLabelFor(box).toLowerCase();
          const shouldCheck = wanted.some((value) => label === value || label.startsWith(value) || label.includes(value));
          if (shouldCheck && !box.checked) {
            await clickLikeHuman(box, { shouldAbort });
            await sleep(40);
          }
        }
        return;
      }
      case "file": {
        if (typeof answer !== "object" || answer.type !== "file") return;
        const input = field?.type === "file" ? field : getFileInputInsideField(field);
        if (input) fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        return;
      }
      case "cover_letter": {
        // `answer` is either a file object (a generated/uploaded PDF) or a plain string when
        // there's no file — for a string, flip "Write it here instead" and type it in.
        const scope = field || document.querySelector(FORM_SELECTOR) || document;
        if (typeof answer === "string") {
          const text = answer.trim();
          if (!text) return;
          if (await fillCoverLetterText(scope, text, { shouldAbort })) return;
          // No toggle available on this posting — fall back to attaching the text as a .txt file.
          answer = { type: "file", fileName: "cover-letter.txt", mimeType: "text/plain", base64: encodeTextAsBase64(text) };
        }
        if (typeof answer !== "object" || answer.type !== "file") return;
        const input = scope.querySelector?.('input[type="file"]');
        if (input) fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        return;
      }
      default:
        return;
    }
  }

  NS.recruitee = {
    isAutofillAvailable,
    detectFields,
    fillField,
    getSubmitButton,
    advance,
  };
})();
