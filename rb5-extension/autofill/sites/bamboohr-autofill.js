/* =====================================================================
 * autofill/sites/bamboohr-autofill.js — BambooHR careers application
 * forms (<tenant>.bamboohr.com/careers/...).
 * =====================================================================
 * Ported from BidHub's packages/job-parsers/content/platforms/bamboohr/
 * autofill.js. BambooHR builds its form on the "Fabric" design system —
 * every field wrapper, every custom dropdown, and the file-upload
 * widget carry a `data-fabric-component="..."` attribute instead of a
 * stable id/name, so the detection below keys off THOSE component
 * names rather than CSS classes (Fabric's hashed class names are not
 * stable across releases; the component attribute is).
 *
 * Ported, structural-only:
 *   - field enumeration (label resolution, field-kind classification,
 *     resume/cover-letter slot detection)
 *   - value-filling per field kind (text, textarea, Fabric's own
 *     custom "select" combobox, radio, checkbox, file upload)
 *   - the Next/Continue button classifier for BambooHR's multi-step
 *     application flow (posting → in-page "reveal the form" → the
 *     form's own internal steps, if the tenant customized it that way)
 *
 * Explicitly NOT ported (BidHub's own AI-answer backend / CAPTCHA /
 * proxy — see job-detect-engine PR description): the answerType →
 * getAnswer() routing, reCAPTCHA detection/solving, and the dependent-
 * question reordering that only mattered for sequencing AI answers.
 * Big Banana's existing generic autofill pipeline already answers
 * ordinary screening questions (Yes/No presets, EEO, salary, …) on its
 * own — this file only needs to hand it accurate field structure, not
 * decide what to type into every field itself. A caller supplies the
 * VALUE for a detected field (from the profile, from the existing
 * preset pipeline, or anything else) and this module's fillField()
 * writes it using the correct mechanism for that field's widget.
 * ===================================================================== */
(function () {
  "use strict";
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const {
    sleep, fillTextInput, fillFileInput, clickLikeHuman,
    getCheckboxInputs, getRadioInputs, getTextInput, getTextarea,
    getFileInputInsideField,
  } = engine;

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});

  // ---- small local polling helper (BidHub's waitForPositiveResultWithAbort,
  // trimmed — no shouldAbort plumbing since this file never runs a
  // cancellable background job the way BidHub's auto-apply pipeline does) ---
  async function waitFor(check, timeoutMs, pollMs = 100) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = check();
      if (result) return result;
      await sleep(pollMs);
    }
    return null;
  }

  const SELECT_MENU_WAIT_TIMEOUT_MS = 3000;
  const SELECT_COMMIT_WAIT_TIMEOUT_MS = 1500;
  const SELECT_COMMIT_POLL_MS = 50;
  const FILE_UPLOAD_WAIT_TIMEOUT_MS = 5000;
  const AUTOFILL_ADVANCE_WAIT_MS = 1500;
  const SAFE_ADVANCE_BUTTON_TEXT_PATTERN = /\b(next|continue|review|preview)\b/i;
  const UNSAFE_ADVANCE_BUTTON_TEXT_PATTERN = /\b(submit|apply|complete|finish|done|send)\b/i;
  const NON_ADVANCE_BUTTON_TEXT_PATTERN = /\b(back|previous|cancel|close|delete|remove|upload|browse|choose|skip)\b/i;
  const REQUIRED_MARKER_PATTERN = /[ *]/g;

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(/​/g, "")
      .replace(REQUIRED_MARKER_PATTERN, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function normalizeComparisonText(value) {
    return normalizeText(value).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }
  function slugifyFieldId(value) {
    return normalizeComparisonText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function escapeAttributeValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  // Fabric hides a field (instead of removing it) for a lot of conditional
  // logic, and a FileUpload's native input is only ALLOWED to be hidden —
  // Fabric styles it with width/height:0 permanently, visible or not.
  function isVisible(element, { allowHiddenFileInput = false } = {}) {
    if (!element?.isConnected) return false;
    if (allowHiddenFileInput && element.matches?.('input[type="file"]')) return true;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function closestFabricComponent(element, componentName) {
    let current = element;
    while (current && current !== document.body) {
      if (current.getAttribute?.("data-fabric-component") === componentName) return current;
      current = current.parentElement;
    }
    return null;
  }

  function getForm() {
    return document.querySelector("form#job-application-form");
  }
  function getActionLabel(element) {
    return normalizeText(element?.textContent || element?.value || element?.getAttribute?.("aria-label") || "");
  }
  function isCareersPage() {
    return /\.bamboohr\.com$/i.test(window.location.hostname) && /\/careers\/[^/]+/i.test(window.location.pathname);
  }

  // A hidden "please leave this field blank" nickname trap — BambooHR's
  // own honeypot against scripted submissions. Never touch it.
  function isHoneypotControl(control) {
    const identifier = `${control?.id ?? ""} ${control?.name ?? ""}`;
    if (/nickname/i.test(identifier)) return true;
    const field = getQuestionField(control);
    return /please\s+leave\s+this\s+field\s+blank/i.test(normalizeText(field?.textContent));
  }

  function isAutofillEligibleControl(control) {
    if (!control || control.disabled || isHoneypotControl(control)) return false;
    if (control.readOnly) return false;
    const type = (control.getAttribute("type") || control.type || "").toLowerCase();
    if (["hidden", "submit", "button", "reset"].includes(type)) return false;
    if (type === "file") {
      const fileUpload = closestFabricComponent(control, "FileUpload") || control.closest('[data-fabric-component="FileUploadInput"]');
      return isVisible(fileUpload || control, { allowHiddenFileInput: true });
    }
    if (control.tagName === "SELECT") {
      const field = closestFabricComponent(control, "SelectField InputWrapper") || control.closest(".MuiFormControl-root");
      return isVisible(field || control);
    }
    if (type === "radio" || type === "checkbox") {
      return isVisible(control.closest("fieldset") || control.closest("label") || control);
    }
    return isVisible(control);
  }

  // The field "wrapper" a control lives in — Fabric nests every control in
  // its own component shell (fieldset for a radio group, a DatePicker
  // shell, a TextField InputWrapper, …); this is what carries the label.
  function getQuestionField(control) {
    if (!control) return null;
    const type = (control.getAttribute("type") || control.type || "").toLowerCase();
    if (type === "radio" || type === "checkbox") {
      return control.closest("fieldset") || closestFabricComponent(control, "RadioGroup") || control.closest('[role="radiogroup"], [role="group"], label') || control;
    }
    if (type === "file") {
      const fileUpload = closestFabricComponent(control, "FileUpload") || closestFabricComponent(control, "FileUploadInput");
      return fileUpload?.closest('[data-fabric-component="Flex"]') || fileUpload || control;
    }
    if (control.tagName === "SELECT") {
      return closestFabricComponent(control, "SelectField InputWrapper") || control.closest(".MuiFormControl-root") || control;
    }
    const datePicker = closestFabricComponent(control, "DatePicker");
    if (datePicker) return datePicker;
    return closestFabricComponent(control, "TextField InputWrapper") || control.closest(".MuiFormControl-root, label, fieldset") || control;
  }

  function getFieldLabelText(field, control) {
    if (!field) return "";
    const labelText = normalizeText(
      field.querySelector?.("legend, label")?.textContent ||
      field.querySelector?.('[class*="labelWrapper"]')?.textContent || ""
    );
    if (labelText) return labelText;
    if (control?.id) {
      const linkedLabel = document.querySelector(`label[for="${escapeAttributeValue(control.id)}"]`);
      const linkedText = normalizeText(linkedLabel?.textContent);
      if (linkedText) return linkedText;
    }
    if (control?.getAttribute?.("aria-labelledby")) {
      const ariaText = control.getAttribute("aria-labelledby").split(/\s+/)
        .map((id) => normalizeText(document.getElementById(id)?.textContent))
        .filter(Boolean).join(" ");
      if (ariaText) return ariaText;
    }
    // FileUpload's "label" is a plain paragraph next to the widget, not a
    // <label> — skip its own idle-state copy ("Choose file"/"No file
    // selected") so that doesn't get mistaken for the field's name.
    const fileLabel = normalizeText(field.querySelector?.('[data-fabric-component="BodyText"], p')?.textContent);
    if (fileLabel && !/choose\s+file|no\s+file\s+selected/i.test(fileLabel)) return fileLabel;
    const ariaLabel = normalizeText(control?.getAttribute?.("aria-label"));
    if (ariaLabel) return ariaLabel;
    return normalizeText(control?.placeholder || control?.name || control?.id);
  }

  function getChoiceInputLabelText(input, fallback = "") {
    if (!input) return fallback;
    const labelText = Array.from(input.labels ?? []).map((l) => normalizeText(l.textContent)).find(Boolean);
    if (labelText) return labelText;
    const wrappedText = normalizeText(input.closest("label")?.textContent);
    if (wrappedText) return wrappedText;
    return normalizeText(input.value || fallback);
  }
  function getChoiceOptions(field, inputType) {
    return (inputType === "radio" ? getRadioInputs(field) : getCheckboxInputs(field))
      .map((input) => getChoiceInputLabelText(input)).filter(Boolean);
  }

  function isResumeField(question, control) {
    const combined = `${question} ${control?.name ?? ""} ${control?.id ?? ""} ${control?.getAttribute?.("accept") ?? ""}`;
    return /\b(resume|cv)\b/i.test(combined);
  }
  function isCoverLetterField(question, control) {
    const combined = `${question} ${control?.name ?? ""} ${control?.id ?? ""}`;
    return /cover\s*letter/i.test(combined);
  }

  function getStableFieldId(control, question) {
    const type = (control.getAttribute("type") || control.type || "").toLowerCase();
    const name = normalizeText(control.name);
    if (type === "file") return /cover\s*letter/i.test(question) ? "cover_letter" : "resume";
    // React's auto-generated `:rN:` ids are useless as a stable key —
    // fall back to a label slug (or the DOM id) instead.
    if (name && !/^:r\d+:$/i.test(name)) return name;
    return slugifyFieldId(question) || normalizeText(control.id) || name;
  }

  function classifyFieldKind(control) {
    const type = (control.getAttribute("type") || control.type || "").toLowerCase();
    if (type === "file") return "file";
    if (type === "radio") return "radio";
    if (type === "checkbox") return "checkbox";
    if (control.tagName === "SELECT") return "fabric-select";
    if (control.tagName === "TEXTAREA") return "textarea";
    return "text";
  }

  /** Enumerate every fillable field on the current BambooHR application
   *  form: {question, fieldId, fieldKind, field, control, options}.
   *  `options` is populated for radio/checkbox; a Fabric select's options
   *  only exist once its menu is opened (fetchFabricSelectOptions). */
  function detectFields() {
    if (!isCareersPage()) return [];
    const form = getForm();
    if (!form) return [];
    const entries = [];
    const seenFieldIds = new Set();
    const seenChoiceGroups = new Set();

    for (const control of Array.from(form.querySelectorAll("input, textarea, select")).filter(isAutofillEligibleControl)) {
      const type = (control.getAttribute("type") || control.type || "").toLowerCase();
      const field = getQuestionField(control);
      if (!field) continue;
      if ((type === "radio" || type === "checkbox") && control.name) {
        const groupKey = `${type}:${control.name}`;
        if (seenChoiceGroups.has(groupKey)) continue;
        seenChoiceGroups.add(groupKey);
      }
      const question = getFieldLabelText(field, control);
      const fieldId = getStableFieldId(control, question);
      if (!question || !fieldId || seenFieldIds.has(fieldId)) continue;
      seenFieldIds.add(fieldId);
      const fieldKind = classifyFieldKind(control);
      entries.push({
        question, fieldId, fieldKind, field, control,
        options: fieldKind === "radio" ? getChoiceOptions(field, "radio")
          : fieldKind === "checkbox" ? getChoiceOptions(field, "checkbox")
          : null,
        isResume: type === "file" && isResumeField(question, control),
        isCoverLetter: type === "file" && isCoverLetterField(question, control),
      });
    }

    // A FileUpload whose file is ALREADY attached unmounts its own
    // `input[type=file]` entirely (replaced by a "<filename> [remove
    // file]" chip) — no control for the loop above to find. Surface the
    // slot anyway so a caller re-attaching a different file can still
    // find it (fillField's 'file' handler clicks "remove file" to bring
    // the input back).
    for (const fileUpload of Array.from(form.querySelectorAll('[data-fabric-component="FileUpload"]'))) {
      if (fileUpload.querySelector('input[type="file"]')) continue;
      if (!isVisible(fileUpload)) continue;
      const field = fileUpload.closest('[data-fabric-component="Flex"]') || fileUpload;
      const question = getFieldLabelText(field, null);
      if (!question) continue;
      const fieldId = isCoverLetterField(question, null) ? "cover_letter" : "resume";
      if (seenFieldIds.has(fieldId)) continue;
      seenFieldIds.add(fieldId);
      entries.push({
        question, fieldId, fieldKind: "file", field, control: null,
        options: null, isResume: fieldId === "resume", isCoverLetter: fieldId === "cover_letter",
      });
    }
    return entries;
  }

  // ---- multi-step advance (posting → form, and the form's own Next) -----

  function getApplyControl() {
    if (getForm()) return null; // already revealed — no "Apply for This Job" button to click
    return Array.from(document.querySelectorAll(
      'button[data-fabric-component="Button"], button, a[href*="/careers/"][data-fabric-component="Button"], a[href*="/careers/"]'
    )).filter(isVisible).find((control) => /\bapply\s+for\s+this\s+job\b/i.test(getActionLabel(control))) ?? null;
  }
  function getSubmitButton() {
    const form = getForm();
    if (!form) return null;
    const candidates = [
      ...form.querySelectorAll('button[data-fabric-component="Button"], button[type="submit"], input[type="submit"], button'),
      ...document.querySelectorAll('button[form="job-application-form"], input[type="submit"][form="job-application-form"]'),
    ];
    return candidates.filter((b, i) => candidates.indexOf(b) === i).filter(isVisible)
      .find((b) => /\b(submit|apply)\b/i.test(getActionLabel(b))) ?? null;
  }
  function isButtonDisabled(button) {
    return Boolean(button?.disabled || button?.getAttribute?.("aria-disabled") === "true" || button?.hasAttribute?.("disabled"));
  }
  function isSafeAdvanceButton(button) {
    if (!(button instanceof Element) || !isVisible(button) || isButtonDisabled(button)) return false;
    const label = normalizeComparisonText(getActionLabel(button));
    if (!label) return false;
    return SAFE_ADVANCE_BUTTON_TEXT_PATTERN.test(label)
      && !UNSAFE_ADVANCE_BUTTON_TEXT_PATTERN.test(label)
      && !NON_ADVANCE_BUTTON_TEXT_PATTERN.test(label);
  }
  function getSafeAdvanceButton() {
    const form = getForm();
    if (!form) return null;
    const buttons = Array.from(form.querySelectorAll('button[data-fabric-component="Button"], button[type="submit"], button, [role="button"]'))
      .filter(isSafeAdvanceButton)
      .sort((left, right) => {
        const leftLabel = normalizeComparisonText(getActionLabel(left));
        const rightLabel = normalizeComparisonText(getActionLabel(right));
        const leftRank = /\b(next|continue)\b/.test(leftLabel) ? 0 : 1;
        const rightRank = /\b(next|continue)\b/.test(rightLabel) ? 0 : 1;
        if (leftRank !== rightRank) return leftRank - rightRank;
        const lr = left.getBoundingClientRect(), rr = right.getBoundingClientRect();
        return (rr.top + rr.left) - (lr.top + lr.left);
      });
    return buttons[0] ?? null;
  }

  /** Advance one step: click "Apply for This Job" to reveal the form, or
   *  click the form's own safe Next/Continue button. Returns true if an
   *  in-form Next was clicked (caller should re-detect and keep filling);
   *  false if the posting→form boundary was crossed (nothing left to fill
   *  on THIS page — the revealed form is a fresh detection) or there's
   *  nothing safe to click. Never clicks Submit/Apply/Finish — only this
   *  module's own isSafeAdvanceButton gate, which explicitly excludes
   *  those labels. */
  async function advance() {
    const applyControl = getApplyControl();
    if (applyControl) {
      applyControl.click();
      await waitFor(() => getForm() || getSafeAdvanceButton(), AUTOFILL_ADVANCE_WAIT_MS);
      return false;
    }
    const advanceButton = await waitFor(getSafeAdvanceButton, AUTOFILL_ADVANCE_WAIT_MS);
    if (!advanceButton) return false;
    await clickLikeHuman(advanceButton);
    return true;
  }

  // ---- Fabric's custom "select" combobox (button + portal'd menu) -------

  function getFabricSelectButton(field) {
    if (!field) return null;
    const scopedSelect = field.querySelector('[data-fabric-component="Select"]');
    const searchRoot = scopedSelect || field;
    return searchRoot.querySelector('button.fab-SelectToggle[data-menu-id], button[data-menu-id][aria-haspopup="true"], button.fab-SelectToggle') || null;
  }
  function getOpenSelectMenu() {
    const menus = Array.from(document.querySelectorAll('[data-fabric-component="Menu"], [role="menu"]')).filter(isVisible);
    return menus[menus.length - 1] ?? null;
  }
  // A toggle that NAMES its menu (data-menu-id) only ever gets THAT menu —
  // never "whatever menu happens to be open". Fills chain back-to-back: the
  // previous field's menu can still be on screen (closing) while this
  // field's hasn't rendered yet, and the old "any visible menu" fallback
  // handed a field the WRONG menu's options in that race.
  function getMenuForButton(button) {
    if (!button) return null;
    const menuId = button.getAttribute("data-menu-id");
    if (menuId) {
      const linkedMenu = document.getElementById(menuId);
      return linkedMenu && isVisible(linkedMenu) ? linkedMenu : null;
    }
    return getOpenSelectMenu();
  }
  function isSelectMenuOpen(button) {
    if (!button) return false;
    if (button.getAttribute("aria-expanded") === "true") return true;
    const menuId = button.getAttribute("data-menu-id");
    if (menuId) return isVisible(document.getElementById(menuId));
    return Boolean(getOpenSelectMenu());
  }

  async function openSelectMenu(field) {
    let button = getFabricSelectButton(field);
    if (!button) return null;
    const readOpenOptions = () => {
      // The row can be re-instantiated while we wait (e.g. BambooHR
      // re-renders the form after a Country change) — a detached toggle
      // never reports aria-expanded, so re-resolve and re-click the live
      // one instead of timing out on a stale node.
      if (!button.isConnected) {
        button = getFabricSelectButton(field);
        if (!button) return null;
        button.click();
        return null;
      }
      const menu = getMenuForButton(button);
      const options = menu
        ? Array.from(menu.querySelectorAll('.fab-MenuOption[role="menuitem"], [role="menuitem"].fab-MenuOption'))
            .filter(isVisible)
            .map((element) => ({ element, text: normalizeText(element.textContent) }))
            .filter((o) => o.text)
        : [];
      if (button.getAttribute("aria-expanded") !== "true" && options.length === 0) return null;
      return options.length ? options : null;
    };
    button.scrollIntoView({ block: "center", inline: "nearest" });
    button.focus?.();
    button.click();
    return waitFor(readOpenOptions, SELECT_MENU_WAIT_TIMEOUT_MS, 60);
  }
  async function closeSelectMenu(field) {
    const button = getFabricSelectButton(field);
    if (!button || !isSelectMenuOpen(button)) return;
    button.scrollIntoView({ block: "center", inline: "nearest" });
    button.focus?.();
    button.click();
    await waitFor(() => {
      const liveButton = getFabricSelectButton(field);
      return !liveButton || !isSelectMenuOpen(liveButton);
    }, SELECT_MENU_WAIT_TIMEOUT_MS, 60);
  }
  function readSelectedOptionText(field) {
    const toggleText = normalizeComparisonText(getFabricSelectButton(field)?.textContent);
    if (toggleText) return toggleText;
    const select = field.querySelector("select");
    return normalizeComparisonText(select?.selectedOptions?.[0]?.textContent);
  }
  // Reopen the menu and click the option whose label matches. null = the
  // menu never opened; false = no matching option in the (fresh) menu;
  // true = clicked.
  async function clickSelectOption(field, optionText) {
    const freshEntries = await openSelectMenu(field);
    if (!freshEntries) return null;
    const expected = normalizeComparisonText(optionText);
    const target = freshEntries.find((o) => normalizeComparisonText(o.text) === expected);
    if (!target) {
      await closeSelectMenu(field);
      return false;
    }
    target.element.scrollIntoView({ block: "nearest", inline: "nearest" });
    target.element.click();
    return true;
  }
  async function waitForSelectCommit(field, optionText) {
    const expected = normalizeComparisonText(optionText);
    const committed = await waitFor(() => {
      const liveButton = getFabricSelectButton(field);
      if (liveButton && isSelectMenuOpen(liveButton)) return false;
      return readSelectedOptionText(field) === expected;
    }, SELECT_COMMIT_WAIT_TIMEOUT_MS, SELECT_COMMIT_POLL_MS);
    return Boolean(committed);
  }
  /** The option list a Fabric select currently offers (opens the menu,
   *  reads it, closes it again) — for a caller that needs to know the
   *  choices before picking one (e.g. Big Banana's existing preset
   *  pipeline resolving "Yes"/"No" against whatever this form actually
   *  calls its options). */
  async function fetchSelectOptions(field) {
    const entries = await openSelectMenu(field);
    if (!entries) return null;
    const options = entries.map((o) => o.text);
    await closeSelectMenu(field);
    return options;
  }

  // Best match for `answer` among `options` ([{text, ...}] or [string]):
  // exact (normalized) match first, else the first option whose text
  // contains — or is contained by — the answer. BidHub's own fallback used
  // an AI embedding-similarity call for anything looser than that; that's
  // the out-of-scope AI-answer backend, so a looser-than-substring miss
  // here simply returns null and the field is left for the generic
  // pipeline to try.
  function getBestMatchingOption(answer, options) {
    if (!Array.isArray(options) || options.length === 0) return null;
    const answerText = Array.isArray(answer) ? answer[0] : answer;
    const normalizedAnswer = normalizeComparisonText(answerText);
    if (!normalizedAnswer) return null;
    const asEntry = (o) => (typeof o === "string" ? { text: o } : o);
    const entries = options.map(asEntry);
    const exact = entries.find((o) => normalizeComparisonText(o.text) === normalizedAnswer);
    if (exact) return exact;
    return entries.find((o) => {
      const t = normalizeComparisonText(o.text);
      return t && (t.includes(normalizedAnswer) || normalizedAnswer.includes(t));
    }) ?? null;
  }

  // Re-displays a FileUpload's native `<input type="file">`: Fabric
  // UNMOUNTS it completely once a file is attached (replaced by a
  // "<filename> [remove file]" chip), so a re-attach has nothing to drive
  // until "remove file" is clicked.
  async function ensureFileInput(field) {
    const fileUpload = field?.querySelector('[data-fabric-component="FileUpload"]') || closestFabricComponent(field, "FileUpload");
    const scope = fileUpload || field;
    const removeButton = scope?.querySelector('button[aria-label="remove file"]');
    if (!removeButton) return getFileInputInsideField(scope) || getFileInputInsideField(field);
    removeButton.click();
    return waitFor(() => getFileInputInsideField(scope) || getFileInputInsideField(field), FILE_UPLOAD_WAIT_TIMEOUT_MS, 60);
  }

  /** Write `answer` into a detected field entry, using the mechanism its
   *  fieldKind needs. For 'radio'/'checkbox'/'fabric-select', `answer` is
   *  matched against the field's own option text (see
   *  getBestMatchingOption) rather than written verbatim. For 'file',
   *  `answer` is `{fileName, base64, mimeType}`. Returns true on an
   *  apparent success (BambooHR gave no stronger signal to check for
   *  radio/checkbox/text; 'fabric-select' and 'file' verify). */
  async function fillField(entry, answer) {
    if (!entry || answer == null) return false;
    const { fieldKind, field, control } = entry;
    switch (fieldKind) {
      case "text": {
        const input = control || getTextInput(field);
        if (!input) return false;
        fillTextInput(input, answer);
        return true;
      }
      case "textarea": {
        const textarea = control || getTextarea(field);
        if (!textarea) return false;
        fillTextInput(textarea, answer);
        return true;
      }
      case "fabric-select": {
        let options = entry.options;
        if (!Array.isArray(options)) options = await fetchSelectOptions(field);
        const best = getBestMatchingOption(answer, options);
        if (!best) return false;
        for (let attempt = 0; attempt < 2; attempt++) {
          const clicked = await clickSelectOption(field, best.text ?? best);
          if (clicked === null) throw new Error("Select menu did not open");
          if (clicked === false) continue; // menu refreshed with different options — retry once
          if (await waitForSelectCommit(field, best.text ?? best)) return true;
          await closeSelectMenu(field);
        }
        return false;
      }
      case "radio": {
        const options = getRadioInputs(field).map((input) => ({ input, text: getChoiceInputLabelText(input) })).filter((o) => o.text);
        const best = getBestMatchingOption(answer, options);
        if (!best?.input) return false;
        if (!best.input.checked) {
          await clickLikeHuman(best.input);
          best.input.dispatchEvent(new Event("change", { bubbles: true }));
        }
        return true;
      }
      case "checkbox": {
        const requested = (Array.isArray(answer) ? answer : [answer]).map(normalizeComparisonText).filter(Boolean);
        if (!requested.length) return false;
        for (const checkbox of getCheckboxInputs(field)) {
          const label = normalizeComparisonText(getChoiceInputLabelText(checkbox));
          const shouldCheck = requested.some((r) => r === label || label.includes(r) || r.includes(label));
          if (checkbox.checked !== shouldCheck) {
            await clickLikeHuman(checkbox);
            checkbox.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }
        return true;
      }
      case "file": {
        if (!answer || typeof answer !== "object") return false;
        const input = await ensureFileInput(field);
        if (!input) return false;
        fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
        return true;
      }
      default:
        return false;
    }
  }

  function isAutofillAvailable() {
    return Boolean(detectFields().length || getApplyControl());
  }

  NS.bamboohr = {
    isCareersPage,
    isAutofillAvailable,
    detectFields,
    fillField,
    fetchSelectOptions,
    getSubmitButton,
    isButtonDisabled,
    advance,
  };
})();
