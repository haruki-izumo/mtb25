/* =====================================================================
 * autofill/sites/workable-autofill.js — Workable application-form
 * autofill (apply.workable.com). Ported from BidHub's own
 * packages/job-parsers/content/platforms/workable/autofill.js —
 * detection (label/aria/structural-attribute matching) AND value-filling,
 * with every value WRITE (text, select, combobox, click, file) going
 * through the shared window.ProactiveAutofillEngine instead of
 * reimplementing those mechanics here. The SEARCH/listing host
 * (jobs.workable.com) has its own separate, unrelated BidHub files and is
 * not part of this port.
 *
 * Scope: structural/deterministic fields only — text inputs, Workable's
 * native <select>, its custom combobox-style dropdown, checkbox/radio
 * groups, résumé/cover-letter/photo uploads, and the one "advance" step
 * Workable's flow has (clicking "Apply" to reveal the form). BidHub's
 * free-text AI-answer generation, its CAPTCHA handling, and its
 * education/experience profile-section row editor are NOT ported — any
 * field that would have fallen through to BidHub's AI path (e.g. a
 * freeform cover-letter textarea, rather than a file upload) is left
 * alone here too, for Big Banana's own existing AI-answer pipeline to
 * pick up.
 *
 * Exposes window.ProactiveAutofillSites.workable — there's no shared
 * "run a site's autofill" engine call the way job-detect/engine/parser.js
 * provides for detection, so this file publishes its own detect/fill
 * surface for whatever orchestrates per-site autofill to call into.
 * ===================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofillEngine) return;
  var engine = window.ProactiveAutofillEngine;

  // ---- Workable-specific text/label cleanup ------------------------------
  // Workable's own label/option text carries a required-field glyph, a
  // stray "(Optional)" suffix, an SVG-fallback string, and a "Choose file"
  // button caption all run together in textContent — strip those before
  // using the text as a question/option label or a comparison key.
  var REQUIRED_MARKERS = /[✱*]/g;

  function normalizeWorkableText(value) {
    return String(value !== null && value !== void 0 ? value : "")
      .replace(/ /g, " ")
      .replace(REQUIRED_MARKERS, "")
      .replace(/SVGs not supported by this browser\.?/gi, "")
      .replace(/\bChoose file\b/gi, "")
      .replace(/\(Optional\)/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Diacritic/case/whitespace-insensitive form, for matching an answer
  // against an option's label rather than displaying it.
  function normalizeComparisonText(value) {
    return normalizeWorkableText(value)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
  }

  function escapeAttr(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function slugifyFieldId(value) {
    return normalizeComparisonText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  // ---- Visibility ---------------------------------------------------------

  function isElementVisible(element) {
    if (!element || !element.isConnected) return false;
    // A native file input is legitimately 0×0/visually hidden behind a
    // styled dropzone — still a real, fillable control.
    if (element.matches && element.matches('input[type="file"]')) return true;
    var style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    var rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ---- The application form + the "Apply" control that reveals it -------

  function getWorkableForm() {
    return document.querySelector('form[data-ui="application-form"]');
  }

  function getWorkableActionLabel(element) {
    return normalizeWorkableText(
      (element && element.textContent) ||
        (element && element.value) ||
        (element && element.getAttribute && element.getAttribute("aria-label")) ||
        ""
    );
  }

  // Workable's job page shows an "Apply"/"Apply for this job" control
  // BEFORE the application form exists in the DOM at all — clicking it
  // either reveals a same-page form or navigates to the form's own
  // /apply/ URL. That's the ONE "advance the flow" step Workable has;
  // once the form is showing there's no further multi-page pagination
  // inside it to click through.
  function getWorkableApplyControl() {
    var candidates = Array.from(
      document.querySelectorAll(
        [
          'a[data-ui="apply-button"]',
          'button[data-ui="overview-apply-now"]',
          'button[data-ui="sticky-apply-now"]',
          'a[href$="/apply/"]',
          'a[href*="/apply/"]',
        ].join(",")
      )
    ).filter(isElementVisible);
    var found = candidates.find(function (control) {
      return /\bapply\b/i.test(getWorkableActionLabel(control));
    });
    return found || null;
  }

  function isWorkableAutofillAvailable() {
    return Boolean(getWorkableForm() || getWorkableApplyControl());
  }

  // Returns true when it actually clicked an advance control (the form
  // wasn't up yet); false when the form is already showing, so a caller
  // knows whether anything happened.
  async function advanceWorkableAutofillFlow() {
    if (getWorkableForm()) return false;
    var applyControl = getWorkableApplyControl();
    if (!applyControl) return false;
    await engine.clickLikeHuman(applyControl);
    return true;
  }

  function getWorkableSubmitButton() {
    var form = getWorkableForm();
    if (!form) return null;
    var buttons = Array.from(
      form.querySelectorAll('button[data-ui="apply-button"], button[type="submit"], input[type="submit"]')
    ).filter(isElementVisible);
    var found = buttons.find(function (button) {
      return /\b(submit|apply)\b/i.test(getWorkableActionLabel(button));
    });
    return found || null;
  }

  // ---- Label resolution ---------------------------------------------
  // Workable's own markup convention: a control's accessible name is
  // either an aria-labelledby pointing at one or more ids ending in
  // "_label", or a <label> ancestor, or (for a choice-group) a sibling
  // "_label"-id element the WRAPPER (not the input) is labelled by. The
  // shared engine.getInputLabelText only knows the generic label[for]/
  // closest-label chain — not this aria-labelledby convention — so label
  // resolution stays Workable-specific rather than swapped for it.
  function getAriaLabelledText(control) {
    var ids = String((control && control.getAttribute && control.getAttribute("aria-labelledby")) || "").split(/\s+/);
    return ids
      .map(function (id) {
        var el = document.getElementById(id);
        return normalizeWorkableText(el && el.textContent);
      })
      .filter(Boolean)
      .join(" ");
  }

  function isChoiceControl(control) {
    return !!control && (control.type === "checkbox" || control.type === "radio");
  }

  function getChoiceControlWrapper(control) {
    if (!isChoiceControl(control)) return null;
    return control.closest('[role="checkbox"], [role="radio"], [data-ui="option"], label');
  }

  function hasVisibleChoiceControlWrapper(control) {
    var wrapper = getChoiceControlWrapper(control);
    return Boolean(wrapper) && isElementVisible(wrapper);
  }

  function getControlLabelText(control, field) {
    if (!control) return "";
    if (isChoiceControl(control)) {
      var groupText = getAriaLabelledText(field);
      if (groupText) return normalizeWorkableText(groupText);
    }
    var ariaText = getAriaLabelledText(control);
    if (ariaText) return normalizeWorkableText(ariaText);
    var stableId = control.id || control.name || control.getAttribute("data-ui");
    if (stableId) {
      var linkedLabel = document.getElementById(stableId + "_label");
      var linkedText = normalizeWorkableText(linkedLabel && linkedLabel.textContent);
      if (linkedText) return linkedText;
    }
    var label = control.closest("label");
    var labelTextSource = label && (label.querySelector('[id$="_label"], [id$="-label"], [id$="label"]') || label);
    var labelText = normalizeWorkableText(labelTextSource && labelTextSource.textContent);
    if (labelText) return labelText;
    return normalizeWorkableText(control.getAttribute("aria-label") || control.name || control.id);
  }

  // A checkbox/radio's OWN option text (as opposed to the whole group's
  // question) — its aria-labelledby id carries "label_" distinctly from
  // the group's id, which is what lets this tell "this option" from "the
  // question all these options belong to" apart.
  function getChoiceInputLabelText(input, fallbackQuestion) {
    var wrapper = getChoiceControlWrapper(input);
    var wrapperLabelTexts = String((wrapper && wrapper.getAttribute && wrapper.getAttribute("aria-labelledby")) || "")
      .split(/\s+/)
      .map(function (id) {
        var el = document.getElementById(id);
        return { id: id, text: normalizeWorkableText(el && el.textContent) };
      })
      .filter(function (entry) {
        return entry.text;
      });
    var optionLabel = wrapperLabelTexts.find(function (entry) {
      return /(?:^|_)label_/i.test(entry.id);
    });
    if (optionLabel && optionLabel.text) return optionLabel.text;
    var wrappedLabel = input && input.closest && input.closest("label");
    var wrappedTarget =
      wrappedLabel &&
      (wrappedLabel.querySelector('[id^="radio_label_"], [id^="checkbox_label_"], [id$="_label"], [id$="-label"], [id$="label"]') ||
        wrappedLabel);
    var labelText = normalizeWorkableText(wrappedTarget && wrappedTarget.textContent);
    if (labelText) return labelText;
    return normalizeWorkableText((input && input.value) || fallbackQuestion || "");
  }

  // ---- Custom (Workable-shaped) combobox ---------------------------------
  // Workable's own dropdown control is `input[role="combobox"]
  // [aria-controls]` inside a `[data-ui][data-input-type="select"]`
  // wrapper — NOT the `.select-shell`/`.select__menu` shape
  // fillComboboxByTyping defaults its menuSelector to, so the menu
  // selector passed to it is built from THIS control's own
  // aria-controls/aria-owns id instead.
  function getWorkableCustomSelectContainer(control) {
    return (control && control.closest && control.closest('[data-ui][data-input-type="select"]')) || null;
  }

  function isWorkableCustomSelectControl(control) {
    return Boolean(
      control &&
        control.matches &&
        control.matches('input[role="combobox"][aria-controls]') &&
        getWorkableCustomSelectContainer(control)
    );
  }

  function getWorkableCustomSelectInput(field) {
    if (!field) return null;
    if (isWorkableCustomSelectControl(field)) return field;
    return (field.querySelector && field.querySelector('input[role="combobox"][aria-controls]')) || null;
  }

  function getWorkableCustomSelectMenuSelector(control) {
    var listId =
      (control && control.getAttribute && (control.getAttribute("aria-controls") || control.getAttribute("aria-owns"))) || "";
    return listId ? "#" + escapeAttr(listId) + ' [role="option"]' : '[role="option"]';
  }

  function hasVisibleCustomSelectContainer(control) {
    if (!isWorkableCustomSelectControl(control)) return false;
    var container = getWorkableCustomSelectContainer(control);
    return Boolean(container) && isElementVisible(container);
  }

  // ---- Field-wrapper resolution -------------------------------------
  // A checkbox/radio group (shared `name`) collapses to its ONE containing
  // fieldset/group/row so the group is detected as a single question, not
  // one entry per option.
  function getChoiceGroupField(control) {
    if (!control || !isChoiceControl(control) || !control.name) return null;
    var form = getWorkableForm();
    var scopedGroup = control.closest('fieldset, [role="group"], [role="radiogroup"]');
    var scopedGroupInputs = Array.from((scopedGroup && scopedGroup.querySelectorAll('input[type="' + control.type + '"]')) || []);
    if (scopedGroupInputs.length > 1) return scopedGroup;
    var sameNameInputs = Array.from(
      (form && form.querySelectorAll('input[type="' + control.type + '"][name="' + escapeAttr(control.name) + '"]')) || []
    );
    if (sameNameInputs.length <= 1) return null;
    var containsEveryInput = function (candidate) {
      return Boolean(candidate) && sameNameInputs.every(function (input) { return candidate.contains(input); });
    };
    if (containsEveryInput(scopedGroup)) return scopedGroup;
    var candidate = control.parentElement;
    while (candidate && candidate !== form) {
      if (containsEveryInput(candidate)) return candidate;
      candidate = candidate.parentElement;
    }
    return null;
  }

  function getQuestionField(control) {
    if (!control) return null;
    var choiceGroup = getChoiceGroupField(control);
    if (choiceGroup) return choiceGroup;
    if (isWorkableCustomSelectControl(control)) {
      return getWorkableCustomSelectContainer(control) || control.closest("label") || control;
    }
    if (control.type === "file") {
      return control.closest('[data-role="dropzone"]') || control.closest("section, label, div") || control;
    }
    return control.closest('label, fieldset, [role="group"]') || control;
  }

  function isInsideWorkableProfileBlock(control) {
    // Education/experience are their own dynamic row-editor widgets (an
    // "Add" button opens a fresh set of inputs per entry, committed rows
    // re-render as summary text) — out of scope for this port (not one of
    // the structural field types ported here), so controls inside them
    // are skipped entirely rather than half-detected by the scan below.
    return Boolean(control && control.closest && control.closest('[data-ui="education"], [data-ui="experience"]'));
  }

  function shouldSkipControl(control) {
    if (!control) return true;
    if (control.type === "hidden") return true;
    // A control can be aria-hidden / visually collapsed on its OWN element
    // while still being a real, fillable field — Workable renders both a
    // choice input and a custom-select's backing input invisibly behind
    // their styled, visible host element.
    var hasVisibleHost = hasVisibleChoiceControlWrapper(control) || hasVisibleCustomSelectContainer(control);
    if (control.getAttribute("aria-hidden") === "true" && !hasVisibleHost) return true;
    if (!isElementVisible(control) && !hasVisibleHost) return true;
    return false;
  }

  function compareElementsByDocumentOrder(left, right) {
    if (left === right) return 0;
    if (!left || !right || !left.compareDocumentPosition) return 0;
    var position = left.compareDocumentPosition(right);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  // ---- Phone (Workable's national-number-only widget quirk) -------------

  function isPhoneField(question, control) {
    var normalizedQuestion = normalizeComparisonText(question);
    var name = normalizeComparisonText(control && control.name);
    return name === "phone" || normalizedQuestion.indexOf("phone") !== -1 || (control && control.type) === "tel";
  }

  // Workable's phone widget owns the dial code (the flag/country selector
  // beside the input) — the text input itself takes the NATIONAL number
  // ONLY, and its validator accepts exactly "xxx xxx xxxx". A verbatim
  // profile value ("+1 555-123-4567", "(555) 123-4567"…) fails "Phone
  // number is invalid" on submit, so the country code is stripped and the
  // remaining digits reformatted before the write.
  function formatWorkablePhoneAnswer(answer) {
    var value = String(answer !== null && answer !== void 0 ? answer : "").trim();
    if (!value) return "";
    var digits = value.replace(/\D/g, "");
    if (value.startsWith("+")) {
      var delimited = value.match(/^\+\s*(\d{1,3})(?=[\s().-])/);
      var codeLength = delimited ? delimited[1].length : Math.min(3, Math.max(0, digits.length - 10));
      digits = digits.slice(codeLength);
    } else if (digits.length === 11 && digits.startsWith("1")) {
      digits = digits.slice(1);
    }
    if (digits.length !== 10) return digits;
    return digits.slice(0, 3) + " " + digits.slice(3, 6) + " " + digits.slice(6);
  }

  // ---- File uploads (résumé / cover letter / photo) ----------------------
  // Workable tags each of its up-to-three native file inputs with its own
  // `data-ui` ("resume" / "cover-letter" or "cover_letter" / "avatar") —
  // target those directly rather than "the first file input on the page",
  // which on a form ordering Photo before Résumé would silently attach the
  // wrong file into the wrong slot.
  var WORKABLE_RESUME_DATA_UI = ["resume"];
  var WORKABLE_COVER_LETTER_DATA_UI = ["cover-letter", "cover_letter"];
  var WORKABLE_PHOTO_DATA_UI = ["avatar", "photo"];

  function isResumeField(question, control) {
    var normalizedQuestion = normalizeComparisonText(question);
    var dataUi = normalizeComparisonText(control && control.getAttribute && control.getAttribute("data-ui"));
    var name = normalizeComparisonText(control && control.name);
    return dataUi === "resume" || name === "resume" || /\b(resume|cv)\b/.test(normalizedQuestion);
  }

  function isCoverLetterField(question, control) {
    var normalizedQuestion = normalizeComparisonText(question);
    var dataUi = normalizeComparisonText(control && control.getAttribute && control.getAttribute("data-ui"));
    var name = normalizeComparisonText(control && control.name);
    return (
      dataUi === "cover-letter" ||
      dataUi === "cover_letter" ||
      name === "cover-letter" ||
      name === "cover_letter" ||
      /cover\s*letter/.test(normalizedQuestion)
    );
  }

  // Workable's default "Photo" field (application-form key `avatar`);
  // employers can mark it mandatory. Filled from a profile photo when one
  // is supplied; otherwise left alone.
  function isPhotoField(question, control) {
    var normalizedQuestion = normalizeComparisonText(question);
    var dataUi = normalizeComparisonText(control && control.getAttribute && control.getAttribute("data-ui"));
    var name = normalizeComparisonText(control && control.name);
    return (
      dataUi === "avatar" ||
      dataUi === "photo" ||
      name === "avatar" ||
      name === "photo" ||
      /\b(photo|picture|headshot|avatar)\b/.test(normalizedQuestion)
    );
  }

  function isUnsupportedFileField(question, control) {
    if (!control || control.type !== "file") return false;
    return !(isResumeField(question, control) || isCoverLetterField(question, control) || isPhotoField(question, control));
  }

  function getWorkableFileDeleteButton(field) {
    var buttons = (field && field.querySelectorAll && field.querySelectorAll('button, [role="button"]')) || [];
    var found = Array.from(buttons).find(function (button) {
      var label = normalizeWorkableText(button.getAttribute("aria-label") || button.textContent);
      return /\b(delete|remove)\b/i.test(label) && isElementVisible(button);
    });
    return found || null;
  }

  function getLiveWorkableFileUploadField(dataUiCandidates, fallbackField) {
    var form = getWorkableForm();
    var liveInput = null;
    for (var i = 0; i < dataUiCandidates.length; i++) {
      liveInput = form && form.querySelector('input[type="file"][data-ui="' + escapeAttr(dataUiCandidates[i]) + '"]');
      if (liveInput) break;
    }
    if (liveInput) return liveInput.closest('[data-role="dropzone"]') || liveInput;
    return fallbackField && fallbackField.isConnected ? fallbackField : null;
  }

  function waitFor(check, timeoutMs, intervalMs) {
    return new Promise(function (resolve) {
      var elapsed = 0;
      (async function poll() {
        while (elapsed <= timeoutMs) {
          var result = check();
          if (result) return resolve(result);
          await engine.sleep(intervalMs);
          elapsed += intervalMs;
        }
        resolve(null);
      })();
    });
  }

  // Resolves the live file input of a Workable upload slot, first clicking
  // any already-attached file's "Delete"/"Remove" button. Re-attaching a
  // new File object directly over an existing one is a no-op for
  // Workable's own onChange, so a re-run of autofill (switching résumés,
  // say) would otherwise silently keep the stale file in place.
  async function ensureWorkableFileInput(dataUiCandidates, label, fallbackField) {
    var resolveField = function () {
      return getLiveWorkableFileUploadField(dataUiCandidates, fallbackField);
    };
    var deleteButton = getWorkableFileDeleteButton(resolveField());
    if (deleteButton) {
      deleteButton.click();
      var nextInput = await waitFor(
        function () {
          var refreshed = resolveField();
          return !getWorkableFileDeleteButton(refreshed) ? engine.getFileInputInsideField(refreshed) : null;
        },
        5000,
        100
      );
      if (nextInput) return nextInput;
      throw new Error(label + " upload input did not reappear after deleting existing file");
    }
    var input = engine.getFileInputInsideField(resolveField());
    if (input) return input;
    throw new Error(label + " upload input not found");
  }

  // ---- Native <select> option matching -----------------------------------

  function getSelectOptionEntries(field) {
    var select = engine.getNativeSelect(field);
    if (!select) return [];
    return Array.from(select.querySelectorAll("option"))
      .filter(function (option) { return option.value; })
      .map(function (option) { return { value: option.value, text: normalizeWorkableText(option.textContent) }; })
      .filter(function (option) { return option.text; });
  }

  // Exact (case/diacritic/whitespace-insensitive) match first, then a
  // starts-with/contains fallback, so a profile value like "United
  // States" still lands on an option literally labeled "United States of
  // America".
  function findBestMatchingOption(answer, options) {
    if (!Array.isArray(options) || options.length === 0) return null;
    var normalizedAnswer = normalizeComparisonText(typeof answer === "boolean" ? (answer ? "Yes" : "No") : answer);
    if (!normalizedAnswer) return null;
    var exact = options.find(function (option) { return normalizeComparisonText(option.text) === normalizedAnswer; });
    if (exact) return exact;
    var partial = options.find(function (option) {
      var normalizedOption = normalizeComparisonText(option.text);
      return normalizedOption.startsWith(normalizedAnswer) || normalizedAnswer.startsWith(normalizedOption);
    });
    return partial || null;
  }

  // ---- Field detection ----------------------------------------------

  function getWorkableFormControls() {
    var form = getWorkableForm();
    if (!form) return [];
    return Array.from(form.querySelectorAll('input:not([type="hidden"]), textarea, select'))
      .filter(function (control) { return !isInsideWorkableProfileBlock(control); })
      .filter(function (control) { return !shouldSkipControl(control); });
  }

  // fieldKind classification. A plain <textarea> that happens to be a
  // "cover letter" question (as opposed to the file-upload slot) is left
  // as a generic "textarea" — filling that freeform text is BidHub's
  // AI-answer territory, not ported here; Big Banana's own AI pipeline
  // picks it up same as any other open-ended question.
  function classifyWorkableField(question, field, control) {
    if (control.type === "file") {
      if (isResumeField(question, control)) return "file-resume";
      if (isCoverLetterField(question, control)) return "file-cover-letter";
      if (isPhotoField(question, control)) return "file-photo";
      return null;
    }
    if (engine.getCheckboxInputs(field).length > 0) return "checkbox";
    if (engine.getRadioInputs(field).length > 0) return "radio";
    if (engine.getNativeSelect(field)) return "select-native";
    if (isWorkableCustomSelectControl(control)) return "select-custom";
    if (engine.getTextarea(field)) return "textarea";
    if (isPhoneField(question, control)) return "phone";
    return "text";
  }

  function deriveFieldId(question, control) {
    if (isResumeField(question, control)) return "resume";
    if (isCoverLetterField(question, control)) return "cover_letter";
    if (isPhotoField(question, control)) return "photo";
    var customSelectContainer = getWorkableCustomSelectContainer(control);
    var customSelectId = customSelectContainer && customSelectContainer.getAttribute("data-ui");
    if (customSelectId) return customSelectId;
    var choiceGroup = getChoiceGroupField(control);
    var choiceGroupId = choiceGroup && (choiceGroup.getAttribute("data-ui") || choiceGroup.id);
    if (choiceGroupId) return choiceGroupId;
    return (
      (control && control.name) ||
      (control && control.getAttribute && control.getAttribute("data-ui")) ||
      (control && control.id) ||
      slugifyFieldId(question) ||
      null
    );
  }

  function ensureUniqueFieldId(fieldId, usedFieldIds) {
    if (!fieldId) return null;
    if (!usedFieldIds.has(fieldId)) {
      usedFieldIds.add(fieldId);
      return fieldId;
    }
    var suffix = 2;
    while (usedFieldIds.has(fieldId + "-" + suffix)) suffix += 1;
    var unique = fieldId + "-" + suffix;
    usedFieldIds.add(unique);
    return unique;
  }

  // Finds every fillable field on the current (single-page) application
  // form. Returns one entry per logical QUESTION, not per <input> — a
  // checkbox/radio group collapses to its shared wrapper so a multi-option
  // question is one entry, not one per option.
  function detectWorkableFields() {
    var controls = getWorkableFormControls();
    if (controls.length === 0) return [];
    var fields = [];
    var usedFieldIds = new Set();
    var seenChoiceFields = new Set();
    for (var i = 0; i < controls.length; i++) {
      var control = controls[i];
      var field = getQuestionField(control);
      var question = getControlLabelText(control, field);
      if (!question || !field) continue;
      if (isUnsupportedFileField(question, control)) continue;
      if (isChoiceControl(control)) {
        if (seenChoiceFields.has(field)) continue;
        seenChoiceFields.add(field);
      }
      var fieldKind = classifyWorkableField(question, field, control);
      if (!fieldKind) continue;
      var fieldId = ensureUniqueFieldId(deriveFieldId(question, control), usedFieldIds);
      if (!fieldId) continue;
      var options = null;
      if (fieldKind === "checkbox") {
        options = engine.getCheckboxInputs(field).map(function (c) { return getChoiceInputLabelText(c, question); }).filter(Boolean);
      } else if (fieldKind === "radio") {
        options = engine.getRadioInputs(field).map(function (c) { return getChoiceInputLabelText(c, question); }).filter(Boolean);
      } else if (fieldKind === "select-native") {
        options = getSelectOptionEntries(field).map(function (o) { return o.text; });
      }
      fields.push({ fieldId: fieldId, question: question, fieldKind: fieldKind, field: field, control: control, options: options });
    }
    fields.sort(function (a, b) { return compareElementsByDocumentOrder(a.field, b.field); });
    return fields;
  }

  // ---- Value filling ------------------------------------------------

  async function fillWorkableFile(field, dataUiCandidates, label, fileValue) {
    if (!fileValue || !fileValue.base64 || !fileValue.fileName) return false;
    var input = await ensureWorkableFileInput(dataUiCandidates, label, field);
    engine.fillFileInput(input, fileValue.fileName, fileValue.base64, fileValue.mimeType || "application/pdf");
    return true;
  }

  // Checkbox groups: `value` may be a single string/boolean or an array
  // (multi-select); every option whose label matches gets a human-like
  // click. Radio groups: same matching, naturally only one ever clicks.
  async function fillWorkableChoice(inputs, question, value) {
    if (!inputs.length) return false;
    var wanted = Array.isArray(value) ? value : [value];
    var normalizedWanted = wanted
      .map(function (v) { return normalizeComparisonText(typeof v === "boolean" ? (v ? "yes" : "no") : v); })
      .filter(Boolean);
    if (!normalizedWanted.length) return false;
    var clickedAny = false;
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      var label = normalizeComparisonText(getChoiceInputLabelText(input, question));
      var isMatch = normalizedWanted.some(function (w) { return label === w || label.startsWith(w) || w.startsWith(label); });
      if (isMatch && !input.checked) {
        await engine.clickLikeHuman(input);
        clickedAny = true;
      }
    }
    return clickedAny;
  }

  // Fills one field from detectWorkableFields() with `value`. Returns
  // true if something was actually written/clicked, false if there was
  // nothing to do (e.g. no option matched a select).
  async function fillWorkableField(entry, value) {
    if (!entry) return false;
    var fieldKind = entry.fieldKind;
    var field = entry.field;
    var control = entry.control;
    if (fieldKind === "file-resume") return fillWorkableFile(field, WORKABLE_RESUME_DATA_UI, "Resume", value);
    if (fieldKind === "file-cover-letter") return fillWorkableFile(field, WORKABLE_COVER_LETTER_DATA_UI, "Cover letter", value);
    if (fieldKind === "file-photo") return fillWorkableFile(field, WORKABLE_PHOTO_DATA_UI, "Photo", value);
    if (fieldKind === "checkbox") return fillWorkableChoice(engine.getCheckboxInputs(field), entry.question, value);
    if (fieldKind === "radio") return fillWorkableChoice(engine.getRadioInputs(field), entry.question, value);
    if (fieldKind === "select-native") {
      var options = getSelectOptionEntries(field);
      var match = findBestMatchingOption(value, options);
      if (!match) return false;
      engine.fillSelectInput(engine.getNativeSelect(field), match.value);
      return true;
    }
    if (fieldKind === "select-custom") {
      var comboInput = getWorkableCustomSelectInput(field) || control;
      // No `fallback` option here (unlike the engine default's "Other"):
      // Workable's dropdowns are live-filtered suggestion lists (country,
      // school, …) with no guaranteed catch-all option, so forcing a click
      // on one would risk selecting the wrong thing outright.
      await engine.fillComboboxByTyping(comboInput, value, {
        menuSelector: getWorkableCustomSelectMenuSelector(comboInput),
        fallback: null,
      });
      return true;
    }
    if (fieldKind === "phone") {
      await engine.fillTextInputReliably(control, formatWorkablePhoneAnswer(value));
      return true;
    }
    // "textarea" / "text" — plain write.
    await engine.fillTextInputReliably(control, value);
    return true;
  }

  // ---- repeatable Education/Work-history sections (ALL entries) ---------
  // Ported from BidHub's own Workable section descriptors — identical
  // config between apply.workable.com and jobs.workable.com per BidHub
  // (see workable-jobs-autofill.js's own copy of this same block). Driven
  // by the shared engine/section-hierarchy.js
  // (window.ProactiveSectionHierarchy). Workable commits one entry at a
  // time: "Add" opens a [data-ui="editor"] of named inputs, "Save" commits
  // it into a read-only `ul > li [data-ui="group"]` summary card — this is
  // SEPARATE from isInsideWorkableProfileBlock's skip above (which still
  // keeps these controls out of the plain generic-question scan).
  var SECTION_HIERARCHY = window.ProactiveSectionHierarchy;

  function getWorkableSectionEditor(section) {
    return (section && section.querySelector && section.querySelector('[data-ui="editor"]')) || null;
  }
  function getWorkableSectionCommittedRows(section) {
    return Array.from((section && section.querySelectorAll && section.querySelectorAll('ul > li [data-ui="group"]')) || []).map(function (group) {
      return group.closest("li") || group;
    });
  }
  // Committed rows plus the currently-open (not-yet-saved) editor, so
  // ensureRow()'s getRows()[index] lookup finds a freshly-added entry
  // before it's ever saved.
  function getWorkableSectionRows(section) {
    var committed = getWorkableSectionCommittedRows(section);
    var editor = getWorkableSectionEditor(section);
    return editor ? committed.concat([editor]) : committed;
  }
  // Named inputs only really exist while the editor is open — a committed
  // (collapsed) row has none in the DOM, so this naturally returns null
  // for a closed row (detected-but-no-leaf, same tradeoff this port's
  // other editor-mode sites accept).
  function getWorkableSectionRowField(rowEl, mapping) {
    if (!rowEl || !rowEl.querySelector) return null;
    var selector = 'input[name="' + escapeAttr(mapping.controlName) + '"], textarea[name="' + escapeAttr(mapping.controlName) + '"]';
    var field = rowEl.querySelector(selector);
    return field ? { field: field } : null;
  }
  async function addWorkableSectionRow(section) {
    var button = section && section.querySelector && section.querySelector('button[data-ui="add-section"]:not([disabled]):not([aria-disabled="true"])');
    if (!button) return;
    button.scrollIntoView({ block: "center", inline: "nearest" });
    await engine.clickLikeHuman(button);
  }
  // Removes every committed entry in reverse order (removing one can shift
  // later rows' indices) — up to 3 passes, same retry shape
  // greenhouse-autofill.js's own clearSectionRows uses.
  async function clearWorkableSectionRows(section) {
    for (var attempt = 0; attempt < 3; attempt++) {
      var buttons = Array.from((section && section.querySelectorAll && section.querySelectorAll('[data-ui="remove-section"]')) || []);
      if (!buttons.length) return;
      for (var i = buttons.length - 1; i >= 0; i--) {
        await engine.clickLikeHuman(buttons[i]);
        await engine.sleep(150);
      }
    }
  }
  async function saveWorkableSectionEntry(section) {
    var editor = getWorkableSectionEditor(section);
    var saveButton = editor && editor.querySelector && editor.querySelector('button[data-ui="save-section"]');
    if (!saveButton) return;
    var previousRowCount = getWorkableSectionCommittedRows(section).length;
    await engine.clickLikeHuman(saveButton);
    await waitFor(
      function () {
        return !getWorkableSectionEditor(section) && getWorkableSectionCommittedRows(section).length > previousRowCount ? true : null;
      },
      2000,
      100
    );
  }

  function createWorkableProfileSection(config) {
    return {
      rootFieldId: config.rootFieldId,
      rootQuestion: config.rootQuestion,
      profileSection: config.profileSection,
      rowLabel: function (i) { return config.rootQuestion + " " + (i + 1); },
      rowGrowthTimeoutMs: 3000,
      getContainer: function () { return document.querySelector('[data-ui="' + config.sectionType + '"]'); },
      getRows: getWorkableSectionRows,
      getEditor: getWorkableSectionEditor,
      getRowField: getWorkableSectionRowField,
      addRow: addWorkableSectionRow,
      clearRows: clearWorkableSectionRows,
      saveEntry: saveWorkableSectionEntry,
      mappings: config.mappings,
    };
  }

  // BCD's Profile.education/.experience (school/degree/start/end and
  // company/role/start/end/location) has no field_of_study/summary —
  // those leaves still detect (visible in the review list) but carry no
  // profileKey/resolveValue.
  var WORKABLE_EDUCATION_SECTION = createWorkableProfileSection({
    sectionType: "education",
    rootFieldId: "educationHistory",
    rootQuestion: "Education",
    profileSection: "education",
    mappings: [
      { key: "school", controlName: "school", fieldKind: "text", question: "School", profileKey: "school" },
      { key: "field_of_study", controlName: "field_of_study", fieldKind: "text", question: "Field of Study" },
      { key: "degree", controlName: "degree", fieldKind: "text", question: "Degree", profileKey: "degree" },
      { key: "start_date", controlName: "start_date", fieldKind: "date", question: "Start Date", profileKey: "start" },
      { key: "end_date", controlName: "end_date", fieldKind: "date", question: "End Date", resolveValue: function (e) { return e && String(e.end || "").trim() ? e.end : null; } },
    ],
  });
  var WORKABLE_WORK_HISTORY_SECTION = createWorkableProfileSection({
    sectionType: "experience",
    rootFieldId: "workHistory",
    rootQuestion: "Work history",
    profileSection: "experience",
    mappings: [
      { key: "title", controlName: "title", fieldKind: "text", question: "Title", profileKey: "role" },
      { key: "company", controlName: "company", fieldKind: "text", question: "Company", profileKey: "company" },
      { key: "summary", controlName: "summary", fieldKind: "textarea", question: "Summary" },
      { key: "start_date", controlName: "start_date", fieldKind: "date", question: "Start Date", profileKey: "start" },
      { key: "current", controlName: "current", fieldKind: "checkbox", question: "Current", resolveValue: function (e) { return !String((e && e.end) || "").trim(); } },
      { key: "end_date", controlName: "end_date", fieldKind: "date", question: "End Date", resolveValue: function (e) { return e && String(e.end || "").trim() ? e.end : null; } },
    ],
  });
  var WORKABLE_PROFILE_SECTIONS_V2 = [WORKABLE_EDUCATION_SECTION, WORKABLE_WORK_HISTORY_SECTION];

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections(WORKABLE_PROFILE_SECTIONS_V2, profileData);
  }

  async function fillSectionLeaf(field, mapping, value) {
    switch (mapping.fieldKind) {
      case "text":
      case "date":
      case "textarea":
        await engine.fillTextInputReliably(field, value);
        return;
      case "checkbox": {
        var shouldCheck = Boolean(value);
        if (Boolean(field.checked) !== shouldCheck) await engine.clickLikeHuman(field);
        return;
      }
      default:
        return;
    }
  }

  async function fillSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    var results = [];
    for (var i = 0; i < WORKABLE_PROFILE_SECTIONS_V2.length; i++) {
      var section = WORKABLE_PROFILE_SECTIONS_V2[i];
      var entries = (profileData && profileData[section.profileSection]) || [];
      if (!entries.length) continue;
      var result = await SECTION_HIERARCHY.fillSection(section, entries, fillSectionLeaf);
      results.push(Object.assign({ rootFieldId: section.rootFieldId }, result));
    }
    return results;
  }

  window.ProactiveAutofillSites = window.ProactiveAutofillSites || {};
  window.ProactiveAutofillSites.workable = {
    isAvailable: isWorkableAutofillAvailable,
    advance: advanceWorkableAutofillFlow,
    detectFields: detectWorkableFields,
    fillField: fillWorkableField,
    getSubmitButton: getWorkableSubmitButton,
    detectSections: detectSections,
    fillSections: fillSections,
  };
})();
