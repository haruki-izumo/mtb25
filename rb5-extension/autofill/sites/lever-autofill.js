/* =====================================================================
 * autofill/sites/lever-autofill.js — Lever (jobs.lever.co + EU mirrors).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/lever/autofill.js. That file's
 * own field-filling MECHANICS (React-safe value writes, human-cadence
 * typing/clicking, combobox typing, file attach) are NOT re-implemented
 * here — they're exactly what autofill/engine/dom-interactions.js
 * already provides as window.ProactiveAutofillEngine, so this file calls
 * into that instead.
 *
 * This supersedes/extends autofill/handlers/adapters/lever.js's simple
 * named-field grab (full_name/email/phone/linkedin/github/location) the
 * same way job-detect/sites/greenhouse.js supersedes its generic
 * adapters/index.js entry: that file stays in place (the old
 * pipeline/basic.js generic 15-step run still uses it for sites that
 * haven't been ported yet), this is the fuller, deterministic
 * replacement for Lever specifically.
 *
 * OUT OF SCOPE (left to Big Banana's own existing systems, untouched):
 *   - Free-text screening-question ANSWER GENERATION. BidHub resolves
 *     almost every non-file question (including a lone-checkbox
 *     "consent" field) through its own AI backend (getAnswer() /
 *     ai-core) — none of that is ported. detectQuestions() below only
 *     CLASSIFIES each question's structural type (text / select / combo
 *     / checkbox / radio / file) and locates its control; fillField()
 *     only WRITES an answer the caller already resolved. A caller that
 *     has no answer for a given field simply never calls fillField for
 *     it, and Big Banana's existing generic AI-answer pipeline is free
 *     to pick that field up on its own pass.
 *   - CAPTCHA. Lever gates its application form behind an hCaptcha
 *     Enterprise widget that runs its own challenge flow once the
 *     location field is focused or Submit is pressed — this file clicks
 *     Submit like any other button and leaves whatever Lever's widget
 *     does after that completely alone.
 *   - Proxy/remote-CDP "real input" lanes. BidHub's own source branches
 *     every interaction through a `useRemoteInput()` check for a
 *     patchright-driven runner lane; that lane doesn't exist here, so
 *     every fill below just goes straight through
 *     window.ProactiveAutofillEngine's synthetic-event path.
 * ==================================================================== */
(function () {
  "use strict";

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    fillTextInputReliably,
    fillSelectInput,
    fillFileInput,
    fillComboboxByTyping,
    clickLikeHuman,
    getCheckboxInputs,
    getRadioInputs,
    getQuestionText,
    getNativeSelect,
    getTextarea,
    getTextInput,
    getFileInputInsideField,
    sleep,
  } = engine;

  // ---- small text helpers ------------------------------------------------

  // Lever marks a required question with a leading/trailing ✱ or * glyph
  // right in the label text — strip it before matching/comparing so
  // "Phone ✱" and "Phone" resolve to the same question.
  const REQUIRED_MARKER_PATTERN = /[✱*]/g;
  function normalizeLeverText(value) {
    return String(value ?? "")
      .replace(REQUIRED_MARKER_PATTERN, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isElementVisible(element) {
    if (!element?.isConnected) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ---- question text resolution ------------------------------------------

  function getQuestionLabel(questionItem) {
    return (
      questionItem?.querySelector(".application-label .text") ||
      questionItem?.querySelector(".application-label") ||
      null
    );
  }

  // Consent / agreement questions (the GDPR-style "I agree to..." tickbox)
  // render with NO `.application-label` at all — their prompt lives in a
  // `.consent-required` span, the wrapping <label> of the lone checkbox, or
  // elsewhere inside the `.application-field`. Only treat a field this way
  // when it's a LONE checkbox: a multi-checkbox group always carries a real
  // `.application-label`, so more than one checkbox here means this isn't
  // actually a consent question.
  function getConsentQuestionText(questionItem) {
    const consentSpan = questionItem?.querySelector(".consent-required");
    if (consentSpan) {
      const text = normalizeLeverText(getQuestionText(consentSpan) || consentSpan.textContent);
      if (text) return text;
    }
    const checkboxes = questionItem?.querySelectorAll?.('input[type="checkbox"]') ?? [];
    if (checkboxes.length !== 1) return "";
    for (const source of [
      checkboxes[0].closest("label"),
      questionItem.querySelector(".application-field"),
      questionItem,
    ]) {
      if (!source) continue;
      const text = normalizeLeverText(getQuestionText(source) || source.textContent);
      if (text) return text;
    }
    // A REQUIRED lone checkbox with no derivable prompt must still be
    // surfaced — an unticked required box silently blocks native submit.
    // An OPTIONAL one with no derivable text is left alone so nothing ever
    // auto-ticks a mystery opt-in.
    return checkboxes[0].required ? "Consent" : "";
  }

  function getLeverQuestionText(questionItem) {
    const label = getQuestionLabel(questionItem);
    if (label) return normalizeLeverText(getQuestionText(label) || label.textContent);
    return getConsentQuestionText(questionItem);
  }

  function getQuestionField(questionItem) {
    return questionItem?.querySelector(".application-field") || questionItem || null;
  }

  // A choice input's own label text — a plain checkbox/radio's <label>
  // sometimes wraps the option text in its own span
  // (.application-answer-alternative); fall back to the label's full text,
  // then the control's `value` attribute.
  function getChoiceInputLabelText(input, fallbackText = "") {
    if (!input) return normalizeLeverText(fallbackText);
    const wrappedLabel = input.closest("label");
    const optionLabel = wrappedLabel?.querySelector(".application-answer-alternative") || wrappedLabel;
    return normalizeLeverText(
      getQuestionText(optionLabel) || optionLabel?.textContent || input.value || fallbackText
    );
  }

  function getSelectOptionEntries(field) {
    const select = getNativeSelect(field);
    if (!select) return [];
    return Array.from(select.querySelectorAll("option"))
      .filter((option) => option.value)
      .map((option) => ({ value: option.value, text: normalizeLeverText(option.textContent) }))
      .filter((option) => option.text);
  }

  function isQuestionMarkedRequired(questionItem, control) {
    if (control?.required) return true;
    return Boolean(
      questionItem?.matches?.(".required-field") ||
        questionItem?.querySelector?.(".application-label .required") ||
        questionItem?.querySelector?.(".application-field.required-field") ||
        questionItem?.querySelector?.(".required-field")
    );
  }

  // ---- field-kind classification -----------------------------------------

  function isResumeField(question, control) {
    const normalizedQuestion = question.toLowerCase();
    const controlName = control?.name?.toLowerCase() ?? "";
    return controlName === "resume" || /resume|cv/.test(normalizedQuestion);
  }
  function isCoverLetterField(question, control) {
    const normalizedQuestion = question.toLowerCase();
    const controlName = control?.name?.toLowerCase() ?? "";
    return /cover\s*letter/.test(normalizedQuestion) || /cover_?letter/.test(controlName);
  }
  // Lever's own location typeahead — NOT a react-select: it keeps its
  // match list in a sibling `.dropdown-container` with no [role="option"]
  // markup, so it needs its own menuSelector when it's run through the
  // shared fillComboboxByTyping() below rather than the engine's default.
  function isLocationAutocompleteField(field) {
    if (!field) return false;
    return Boolean(
      field.querySelector('input.location-input, input[name="location"]') &&
        field.querySelector(".dropdown-container")
    );
  }
  function getLocationInput(field) {
    return field?.querySelector('input.location-input, input[name="location"]') || null;
  }

  // Lever's résumé parse (and the location widget's own option-pick) write
  // the resolved place into this hidden input — a non-empty value here
  // means the visible location text is already a real, resolved Lever
  // location, not just whatever the applicant/profile text happens to say.
  function getSelectedLocationInput(field) {
    const scope = field?.closest?.("form") || document;
    return scope.querySelector('input[name="selectedLocation"], #selected-location');
  }
  // Lever's dropdown options are canonical "City, State, Country" strings —
  // compare the whole string first, then just the city segment, so
  // "Austin" and "Austin, TX, United States" are recognized as the same
  // place instead of forcing a re-type over a value the résumé parse
  // already resolved correctly.
  function isSameLeverLocation(currentText, answer) {
    const current = normalizeLeverText(currentText).toLowerCase();
    const wanted = normalizeLeverText(answer).toLowerCase();
    if (!current || !wanted) return false;
    if (current === wanted) return true;
    const cityOf = (text) => text.split(",")[0].trim();
    return Boolean(cityOf(current)) && cityOf(current) === cityOf(wanted);
  }
  function isLeverLocationPrefilled(field, input, answer) {
    const selected = getSelectedLocationInput(field)?.value?.trim() || "";
    if (!selected || selected === "null" || selected === "undefined") return false;
    return isSameLeverLocation(input?.value, answer);
  }

  // Demographic/EEO survey questions are pre-rendered per the posting's
  // targeted country but gated behind a `.hidden` ancestor
  // (`div[id*='countrySurvey']` / `[id*='eeoSurvey']`) — Lever's own
  // hideAndShowSurveys.js only strips that class once the location
  // question is answered. They exist in the DOM before they're shown or
  // even applicable, so detecting/filling them early would surface
  // questions the candidate never saw and answer a survey for a country
  // they didn't select. Filling the location field (below) dispatches a
  // change event, which flips that class and brings these into the next
  // detectQuestions() pass once they're genuinely visible.
  function isHiddenConditionalQuestion(questionItem) {
    return Boolean(questionItem?.closest?.(".hidden"));
  }

  function classifyLeverField(questionItem, question, field) {
    const checkboxInputs = getCheckboxInputs(field);
    if (checkboxInputs.length === 1) {
      // A lone checkbox (consent / agreement / opt-in) is inherently
      // yes/no: ticking it means "yes" — model it as a binary single-select
      // instead of a one-option list whose only option is the whole
      // consent sentence.
      return { fieldKind: "checkbox-single", options: ["Yes", "No"], control: checkboxInputs[0] };
    }
    if (checkboxInputs.length > 0) {
      return {
        fieldKind: "checkbox",
        options: checkboxInputs.map((cb) => getChoiceInputLabelText(cb)).filter(Boolean),
        control: checkboxInputs[0],
      };
    }
    const radioInputs = getRadioInputs(field);
    if (radioInputs.length > 0) {
      return {
        fieldKind: "radio",
        options: radioInputs.map((radio) => getChoiceInputLabelText(radio)).filter(Boolean),
        control: radioInputs[0],
      };
    }
    const fileInput = getFileInputInsideField(field);
    if (fileInput) {
      if (isResumeField(question, fileInput)) return { fieldKind: "resume", options: [], control: fileInput };
      if (isCoverLetterField(question, fileInput)) return { fieldKind: "cover_letter", options: [], control: fileInput };
      return null; // an unrecognized file slot — leave it to the generic pipeline
    }
    const select = getNativeSelect(field);
    if (select) {
      return { fieldKind: "select-native", options: getSelectOptionEntries(field).map((o) => o.text), control: select };
    }
    const textarea = getTextarea(field);
    if (textarea) {
      const isCoverLetter = isCoverLetterField(question, textarea);
      return { fieldKind: isCoverLetter ? "cover_letter" : "textarea", options: [], control: textarea };
    }
    if (isLocationAutocompleteField(field)) {
      return { fieldKind: "location-autocomplete", options: [], control: getLocationInput(field) };
    }
    const input = getTextInput(field);
    if (input) {
      const isCoverLetter = isCoverLetterField(question, input);
      return { fieldKind: isCoverLetter ? "cover_letter" : "text", options: [], control: input };
    }
    return null;
  }

  // ---- detection ----------------------------------------------------------

  /**
   * Walk Lever's application form and return every question this adapter
   * knows how to fill deterministically — text/textarea, native <select>,
   * checkbox/radio groups, the location combobox, and the resume/cover
   * letter file slots. Anything else (a question classifyLeverField()
   * can't place, or a field with no derivable question text at all) is
   * left out of the list entirely, which is how a field is "left alone" for
   * Big Banana's own generic/AI pipeline to pick up per the scope note at
   * the top of this file.
   *
   * @returns {Array<{question:string, field:Element, control:Element,
   *   fieldKind:string, options:string[], required:boolean}>}
   */
  function detectQuestions() {
    const form = document.querySelector("#application-form");
    if (!form) return [];

    // One combined document-order query, NOT one query per wrapper shape:
    // the EEO/demographic survey sections render `div.application-question
    // > label` instead of `li`, and a revealed countrySurvey's `li`
    // questions must stay in their real on-page position relative to those
    // label-wrapped ones rather than all sorting after them.
    const questionWrappers = Array.from(form.querySelectorAll("li.application-question, label")).filter((el) => {
      if (el.matches("li.application-question")) return true;
      // An option label inside an `li` question never carries its own
      // .application-label — only count a label as its OWN question when
      // it's not nested inside one.
      if (el.closest("li.application-question")) return false;
      return Boolean(el.querySelector(".application-label") && el.querySelector(".application-field"));
    });

    const questions = [];
    for (const questionItem of questionWrappers) {
      if (questionItem.classList.contains("awli-application-row")) continue;
      if (isHiddenConditionalQuestion(questionItem)) continue;
      const question = getLeverQuestionText(questionItem);
      const field = getQuestionField(questionItem);
      if (!question || !field) continue;
      const classified = classifyLeverField(questionItem, question, field);
      if (!classified) continue;
      questions.push({
        question,
        field,
        control: classified.control,
        fieldKind: classified.fieldKind,
        options: classified.options,
        required: isQuestionMarkedRequired(questionItem, classified.control),
      });
    }
    return questions;
  }

  // Lever's posting page and its application form are two different
  // documents (the "Apply" link navigates there) — #application-form is
  // simply absent until that one-step hop happens. Mirrors BidHub's own
  // isLeverAutofillAvailable().
  function isAutofillAvailable() {
    return Boolean(document.querySelector("#application-form") || getApplyLink());
  }

  function getApplyLink() {
    return (
      Array.from(document.querySelectorAll('a.postings-btn, a[href$="/apply"]')).find((link) => {
        const href = link?.href ?? "";
        const text = normalizeLeverText(link?.textContent).toLowerCase();
        return href.includes("/apply") && /apply/.test(text);
      }) ?? null
    );
  }

  // Lever's one and only "step": the posting page's Apply button, which
  // navigates to the actual `#application-form` page. There's no further
  // in-page pagination beyond that — the whole application is one long
  // scrolling form ending in Submit.
  async function advanceToApplicationForm({ shouldAbort = () => false } = {}) {
    const applyLink = getApplyLink();
    if (!applyLink || shouldAbort()) return false;
    await clickLikeHuman(applyLink, { shouldAbort });
    return true;
  }

  function getSubmitButton() {
    return document.querySelector("#application-form")?.querySelector("button#btn-submit") || null;
  }

  // Clicking Submit is NOT solving Lever's hCaptcha — Lever's own click
  // handler on #btn-submit is what triggers the widget (and, when a token
  // is already sitting in its hidden response input from a challenge the
  // visitor solved themselves, submits straight through). This just
  // presses the button a person would press; whatever Lever's widget does
  // next is outside this file's job.
  async function clickSubmitButton({ shouldAbort = () => false } = {}) {
    const button = getSubmitButton();
    if (!button || shouldAbort()) return false;
    await clickLikeHuman(button, { shouldAbort });
    return true;
  }

  // ---- filling ------------------------------------------------------------

  // Affirmative/negative detection for a lone-checkbox "consent" question
  // once it's been reduced to a Yes/No single-select answer by whatever
  // resolved it — stays lenient for free-text affirmatives ("Yes, I
  // agree", "I consent") while an explicit negative ("No", "I do not
  // agree") still declines.
  const NEGATIVE_ANSWER_PATTERN = /^(?:no|nope|n|false|none)\b|\b(?:decline[ds]?|disagree[ds]?|do(?:es)?\s*n['’o]?t|opt[ -]?out)\b/i;
  const AFFIRMATIVE_ANSWER_PATTERN = /\b(?:y|yes|yeah|yep|true|agree[ds]?|accept(?:ed|s)?|acknowledge[ds]?|consent(?:ed|s)?|certif(?:y|ied|ies)|authoriz\w*|opt[ -]?in|checked|on)\b/i;
  function isAffirmativeAnswer(answer) {
    if (typeof answer === "boolean") return answer;
    const text = normalizeLeverText(answer);
    if (!text) return false;
    if (NEGATIVE_ANSWER_PATTERN.test(text)) return false;
    return AFFIRMATIVE_ANSWER_PATTERN.test(text);
  }

  // Exact-or-prefix text match only — deliberately NOT the embedding/LLM
  // fuzzy match BidHub's own getBestMatchingOption() falls back to for an
  // option list with no clean match. A select/radio/checkbox group this
  // can't place deterministically is left untouched rather than guessed,
  // same AI-boundary this whole file keeps elsewhere.
  function findMatchingOptionText(answer, optionTexts) {
    const normalizedAnswer = normalizeLeverText(answer).toLowerCase();
    if (!normalizedAnswer) return null;
    return (
      optionTexts.find((text) => text.toLowerCase() === normalizedAnswer) ||
      optionTexts.find((text) => text.toLowerCase().startsWith(normalizedAnswer)) ||
      null
    );
  }

  const RESUME_PARSE_START_TIMEOUT_MS = 3000;
  const RESUME_PARSE_COMPLETE_TIMEOUT_MS = 30000;

  // Lever parses an uploaded résumé (parseResume.js) and uses it to
  // prefill name/email/phone/location — those widgets then re-render with
  // their own `.resume-upload-working/-success/-failure` state markers
  // right next to the file input. Filling the REST of the form before
  // that settles races the prefill (whichever write lands last wins), so
  // fillField() for 'resume' awaits this before resolving.
  function getResumeParsingState(field) {
    if (!field) return "idle";
    if (isElementVisible(field.querySelector(".resume-upload-working"))) return "working";
    if (isElementVisible(field.querySelector(".resume-upload-success"))) return "success";
    if (isElementVisible(field.querySelector(".resume-upload-failure"))) return "failure";
    const oversize = field.closest(".application-question")?.querySelector(".resume-upload-oversize");
    if (isElementVisible(oversize)) return "failure";
    return "idle";
  }
  async function waitForResumeParsing(field, shouldAbort = () => false) {
    const deadlineStart = Date.now() + RESUME_PARSE_START_TIMEOUT_MS;
    let state = "idle";
    while (Date.now() < deadlineStart && !shouldAbort()) {
      state = getResumeParsingState(field);
      if (state !== "idle") break;
      await sleep(100);
    }
    if (shouldAbort() || state !== "working") return;
    const deadlineComplete = Date.now() + RESUME_PARSE_COMPLETE_TIMEOUT_MS;
    while (Date.now() < deadlineComplete && !shouldAbort()) {
      if (getResumeParsingState(field) !== "working") return;
      await sleep(250);
    }
  }

  async function setLeverChoice(input, shouldBeChecked, { shouldAbort = () => false } = {}) {
    if (Boolean(input.checked) === Boolean(shouldBeChecked)) return;
    await clickLikeHuman(input, { shouldAbort });
  }

  /**
   * Write an already-resolved answer into a question returned by
   * detectQuestions(), dispatched by its fieldKind. The caller owns
   * deciding WHAT the answer is (profile value, a matched screening
   * preset, an AI-resolved string, …) — this only owns getting it onto
   * the page using window.ProactiveAutofillEngine's primitives.
   *
   * @param {{field:Element, control:Element, fieldKind:string}} question
   * @param {*} answer - string for text/textarea/select/radio/location;
   *   string|string[]|boolean for checkbox/checkbox-single;
   *   {type:"file", fileName, base64, mimeType} for resume/cover_letter
   *   (cover_letter also accepts a plain string, written as text).
   */
  async function fillField(question, answer, { shouldAbort = () => false } = {}) {
    const { field, control, fieldKind } = question;
    if (answer == null || shouldAbort()) return;

    switch (fieldKind) {
      case "text": {
        await fillTextInputReliably(control, answer, { shouldAbort });
        return;
      }
      case "textarea": {
        await fillTextInputReliably(control, answer, { shouldAbort });
        return;
      }
      case "cover_letter": {
        if (typeof answer === "string") {
          await fillTextInputReliably(control, answer, { shouldAbort });
        } else if (answer?.type === "file") {
          const input = getFileInputInsideField(field);
          if (input) fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        }
        return;
      }
      case "resume": {
        if (answer?.type !== "file") return;
        const input = getFileInputInsideField(field);
        if (!input) return;
        fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        await waitForResumeParsing(field, shouldAbort);
        return;
      }
      case "select-native": {
        const select = getNativeSelect(field);
        if (!select) return;
        const matchedText = findMatchingOptionText(answer, getSelectOptionEntries(field).map((o) => o.text));
        if (!matchedText) return;
        const matchedOption = getSelectOptionEntries(field).find((o) => o.text === matchedText);
        if (matchedOption) fillSelectInput(select, matchedOption.value);
        return;
      }
      case "checkbox-single": {
        const checkbox = getCheckboxInputs(field)[0];
        if (!checkbox) return;
        if (isAffirmativeAnswer(answer) && !checkbox.checked) await setLeverChoice(checkbox, true, { shouldAbort });
        return;
      }
      case "checkbox": {
        const checkboxInputs = getCheckboxInputs(field);
        const selectedValues = Array.isArray(answer)
          ? answer.map((v) => normalizeLeverText(v))
          : typeof answer === "boolean"
          ? []
          : [normalizeLeverText(answer)];
        for (const checkbox of checkboxInputs) {
          const label = getChoiceInputLabelText(checkbox);
          const shouldCheck =
            typeof answer === "boolean"
              ? answer
              : selectedValues.includes(label) || selectedValues.includes(normalizeLeverText(checkbox.value));
          // Multi-select: mirror the answer set exactly — untick a
          // previously-checked box that's no longer selected too, not just
          // tick newly-selected ones.
          if (checkbox.checked !== shouldCheck) await setLeverChoice(checkbox, shouldCheck, { shouldAbort });
        }
        return;
      }
      case "radio": {
        const selectedValue = normalizeLeverText(answer);
        for (const radio of getRadioInputs(field)) {
          const label = getChoiceInputLabelText(radio);
          if (selectedValue === label || selectedValue === normalizeLeverText(radio.value)) {
            if (!radio.checked) await setLeverChoice(radio, true, { shouldAbort });
            return;
          }
        }
        return;
      }
      case "location-autocomplete": {
        const input = getLocationInput(field);
        if (!input) return;
        if (isLeverLocationPrefilled(field, input, answer)) return; // résumé parse already resolved it
        // Lever's own typeahead, not a react-select — point the shared
        // combobox helper at its actual result-list markup
        // (.dropdown-results, no [role="option"]) instead of the engine's
        // react-select-shaped default, and don't let it fall back to
        // typing "Other" into a place-name field when nothing matches.
        await fillComboboxByTyping(input, answer, {
          menuSelector: "#application-form .dropdown-container .dropdown-results > *",
          fallback: null,
          shouldAbort,
        });
        return;
      }
      default:
        return;
    }
  }

  NS.lever = {
    isAutofillAvailable,
    advanceToApplicationForm,
    detectQuestions,
    fillField,
    getSubmitButton,
    clickSubmitButton,
  };
})();
