/* =====================================================================
 * autofill/sites/hackajob-autofill.js — hackajob ("Archer from hackajob"),
 * the signed-in candidate app at user.hackajob.com.
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/hackajob/autofill.js.
 *
 * hackajob is a matching marketplace behind a candidate ACCOUNT, handled
 * like Indeed/ZipRecruiter: this drives ONLY the signed-in flow. It
 * never creates the account, never fills the sign-up/login forms, and
 * never walks the profile wizard (setup.hackajob.com) — that's the
 * candidate's own onboarding.
 *
 * Signed-in flow (user.hackajob.com):
 *   - the dashboard's welcome dialog walks the referral role ("Archer …
 *     will now check how well you fit the role") and ends in "You can
 *     apply to this role 🎉 → Apply to this role" (the ONLY final submit
 *     here — no further form), or in a terminal non-match/closed/
 *     handpicked state (see readHackajobBlocker).
 *   - matched roles also list under /apply as job-cards with a plain
 *     "Apply" (final) or "Apply faster with Archer" (opens a Kombo
 *     screening-questions dialog whose own submit is then the final
 *     one).
 *   - an "Additional information" profile dialog (radio + Submit) is a
 *     plain advance, not an application.
 *   - everything is gated by a one-time identity check ("Verify your
 *     identity to start applying"): until the candidate passes it, no
 *     role can be applied to. That gate, a non-match, a closed role, and
 *     an unlisted target role are reported as a single required
 *     'status' pseudo-field carrying the reason, instead of silently
 *     stalling.
 *
 * Ported, structural-only:
 *   - field enumeration for the Kombo screening dialog and the
 *     availability/notice dialog: text/textarea, a phone input, a
 *     salary/amount input, a native <select>, Angular Material's
 *     `mat-select` (options only exist once its overlay is opened —
 *     fetched live, not cached), `mat-autocomplete`, radio groups,
 *     checkboxes, and a résumé file upload
 *   - value-filling per field kind, including mat-select's open-overlay-
 *     then-click sequence and the autocomplete's type-and-pick sequence
 *   - the welcome-dialog / job-card / Kombo-dialog advance chain and the
 *     final-submit detector
 *   - the blocker/status reporting (identity check, closed, handpicked,
 *     not matched, not listed) as a single pseudo-field a caller can
 *     read and surface, rather than this module silently doing nothing
 *
 * Explicitly NOT ported (BidHub's own AI-answer backend / CAPTCHA /
 * proxy, and this platform's own account-creation boundary):
 *   - getAnswer() / getResumeForAutofill() / getEmbeddingMatch — free-
 *     text screening-question answer GENERATION, the résumé-file lookup
 *     from BidHub's own profile backend, and the embedding-similarity
 *     option-matching fallback. This port's matchOptionIndex stops at an
 *     exact, prefix, or substring match and returns -1 otherwise,
 *     leaving the field unfilled for Big Banana's existing generic
 *     AI-answer pipeline (which also supplies the résumé file object
 *     this module's 'resume' handler expects).
 *   - the sign-up/login forms and the profile wizard (setup.hackajob.com)
 *     — out of scope per BidHub's own source ("in-account situation
 *     only"), not merely the AI/CAPTCHA/proxy boundary.
 *   - no CAPTCHA or remote-CDP automation exists in BidHub's hackajob
 *     file at all; nothing of that kind was found to omit.
 * ===================================================================== */
(function () {
  "use strict";
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const { sleep, fillTextInput, fillTextInputWithoutBlur, fillFileInput, fillSelectInput, getInputLabelText } = engine;

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});

  async function waitFor(check, timeoutMs, pollMs = 150) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = check();
      if (result) return result;
      await sleep(pollMs);
    }
    return null;
  }

  const ROOT_DOMAIN = "hackajob.com";
  const APP_APPLY_URL = "https://user.hackajob.com/apply";
  const RESUME_FIELD_ID = "resume";
  const STATUS_FIELD_ID = "hackajob-status";
  const SESSION_COOKIE = "hackajob_app";
  const TARGET_TITLE_COOKIE = "bigbanana_hj_target_title";
  const JD_MARKER_SELECTOR = 'form.job-apply[data-job-apply], h1.job-refresh__title, .job-refresh__description';
  const WELCOME_DIALOG_SELECTOR = "mat-dialog-container welcome-dialog, welcome-dialog";
  const VERIFICATION_SELECTOR = "account-verification-dialog, verify-to-go-live-onboarding, require-verification-cta, .verify-identity-banner";
  const KOMBO_DIALOG_SELECTOR = "external-job-ai-apply-dialog";
  const NOTICE_DIALOG_SELECTOR = "mat-dialog-container notice-period-form";
  const EXCLUDED_SCOPE_SELECTOR = "app-navbar, nav, header, footer, .mat-select-panel, .mat-autocomplete-panel, .jobs-list .filters, .facets, .panel-filters";
  const WELCOME_PROGRESS_PATTERN = /^(let.?s go|let.?s get started!?|great,? what.?s next\??|great,? what.?s else can i do\??|ok,? what.?s next\??|great!?|got it|continue|next|skip for now|refresh matches)$/i;
  const FINAL_APPLY_PATTERN = /^apply to this role$/i;
  const CARD_APPLY_PATTERN = /^apply( for job| to this role| now)?$/i;
  const KOMBO_SUBMIT_PATTERN = /^(submit( application)?|send( application)?|apply( now)?|confirm( and apply)?)$/i;
  const OPTIONS_WAIT_MS = 3000;
  const SUGGESTION_WAIT_MS = 6000;
  const ROUTE_WAIT_MS = 8000;
  const NAVIGATE_SETTLE_MS = 1500;

  // ---- text / DOM helpers --------------------------------------------------

  function cleanText(value) {
    return String(value ?? "").replace(/[\u200b\u00a0]/g, " ").replace(/\s+/g, " ").trim();
  }
  // Text without Material's icon ligatures ("arrow_right") or <style>/<script> bodies.
  function textOf(element) {
    if (!element) return "";
    const clone = element.cloneNode(true);
    clone.querySelectorAll('style, script, .hj-icon, mat-icon, .mat-icon, [aria-hidden="true"]').forEach((node) => node.remove());
    return cleanText(clone.textContent);
  }
  function cleanQuestion(value) {
    return cleanText(value).replace(/\s*[*:]+\s*$/, "").replace(/^[*:]+\s*/, "").trim();
  }
  function normalizeComparisonText(value) {
    return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }
  function isElementVisible(element) {
    if (!element?.isConnected) return false;
    if (element.hidden || element.closest("[hidden]")) return false;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  // Material hides the native input and styles a sibling — judge by the wrapper.
  function isControlVisible(control) {
    if (!control?.isConnected) return false;
    if (isElementVisible(control)) return true;
    const wrapper = control.closest("label, mat-checkbox, mat-radio-button, chip, checkbox, .mat-form-field, mat-form-field");
    return Boolean(wrapper && isElementVisible(wrapper));
  }
  function isEnabled(button) {
    return Boolean(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true" && !button.hasAttribute("data-loading");
  }
  function findButton(scope, pattern) {
    if (!scope) return null;
    return (
      Array.from(scope.querySelectorAll('button, a[role="button"], a.btn, a[mat-raised-button], a[mat-stroked-button]'))
        .filter(isElementVisible)
        .find((button) => pattern.test(textOf(button))) ?? null
    );
  }
  function readCookie(name) {
    const prefix = `${name}=`;
    for (const part of String(document.cookie || "").split(";")) {
      const trimmed = part.trim();
      if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
    }
    return null;
  }
  function writeDomainCookie(name, value) {
    try {
      const onPlatform = new RegExp(`(^|\\.)${ROOT_DOMAIN.replace(".", "\\.")}$`, "i").test(window.location.hostname);
      const scope = onPlatform ? `; domain=.${ROOT_DOMAIN}; Secure` : "";
      document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${60 * 60 * 24 * 7}; SameSite=Lax${scope}`;
    } catch {
      // cookies disabled — the title fallback simply stays unavailable
    }
  }
  function isCandidateSignedIn() {
    const match = String(document.cookie || "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SESSION_COOKIE}=`));
    if (!match) return false;
    try {
      return JSON.parse(decodeURIComponent(match.slice(SESSION_COOKIE.length + 1)))?.user_type === "candidate";
    } catch {
      return false;
    }
  }

  // ---- page kinds -----------------------------------------------------------
  // 'app' = the candidate app; 'jd' = a posting on hackajob.com. Sign-up/
  // login pages and the profile wizard are deliberately not kinds of ours.
  function detectHackajobPageKind(doc = document, loc = window.location) {
    const host = String(loc.hostname || "").toLowerCase();
    if (host === "user.hackajob.com") return "app";
    if (host === "hackajob.com" || host === "www.hackajob.com") {
      if (/^\/(?:en-us\/)?job\/[0-9a-f-]{36}/i.test(loc.pathname || "") || doc.querySelector(JD_MARKER_SELECTOR)) return "jd";
    }
    return null;
  }
  const getPageKind = () => detectHackajobPageKind();
  const isApplyListPath = () => /^\/apply\/?$/.test(window.location.pathname);

  // ---- target job (title) ----------------------------------------------------
  // The posting and the welcome dialog both name the referral role — a
  // title mirrored via a domain cookie is what lets /apply's job-card
  // list (on a different host) pick the right card.
  function rememberTargetTitle(title) {
    const clean = cleanText(title);
    if (clean) writeDomainCookie(TARGET_TITLE_COOKIE, clean);
  }
  function readTargetTitleFromText(text) {
    const clean = cleanText(text);
    const patterns = [
      /You.re here about the (.+?) at (.+?), who.ve partnered/i,
      /You.re here about the (.+?) at ([^.]+?)\./i,
      /checking how (?:well )?the (.+?) role at (.+?) fits what you/i,
      /checking how (?:well )?the (.+?) fits what you/i,
      /Unfortunately the (.+?) role at (.+?) is no longer/i,
    ];
    for (const pattern of patterns) {
      const match = clean.match(pattern);
      if (match) return cleanText(match[1]);
    }
    return null;
  }
  function getTargetTitle() {
    const raw = readCookie(TARGET_TITLE_COOKIE);
    if (!raw) return null;
    try {
      return cleanText(decodeURIComponent(raw));
    } catch {
      return cleanText(raw);
    }
  }
  function captureTargetTitleFromPage() {
    const kind = getPageKind();
    if (kind === "jd") {
      const title = textOf(document.querySelector("h1.job-refresh__title, .apply-card__title"));
      if (title) rememberTargetTitle(title);
      return;
    }
    if (kind === "app") {
      const dialog = getWelcomeDialog();
      const title = dialog ? readTargetTitleFromText(dialog.textContent) : null;
      if (title) rememberTargetTitle(title);
    }
  }

  // ---- app (user.hackajob.com) state -----------------------------------------

  function getWelcomeDialog() {
    return (
      Array.from(document.querySelectorAll(WELCOME_DIALOG_SELECTOR)).find(isElementVisible) ||
      Array.from(document.querySelectorAll("mat-dialog-container")).find(
        (dialog) =>
          isElementVisible(dialog) &&
          /You.re here about the|check how well you fit|fits what you.re looking for|It.s a match|doesn.t match your profile|no longer accepting applications|don.t need to apply|You can apply to this role|Meet Archer/i.test(
            cleanText(dialog.textContent)
          )
      ) ||
      null
    );
  }
  function getNoticeDialog() {
    const form = Array.from(document.querySelectorAll(NOTICE_DIALOG_SELECTOR)).find(isElementVisible);
    return form ? form.closest("mat-dialog-container") || form : null;
  }
  function getKomboDialog() {
    return Array.from(document.querySelectorAll(KOMBO_DIALOG_SELECTOR)).find(isElementVisible) || null;
  }

  // Terminal states of the referral role — each becomes a single required
  // 'status' pseudo-field a caller reads the reason off, instead of a
  // silent stall.
  function readHackajobBlocker() {
    const identity = (element) => ({
      code: "identity_verification",
      element,
      message: 'hackajob requires a one-time identity verification (Veriff: government ID + live selfie) before a profile goes live and can apply — only the candidate can complete "Verify now".',
    });
    const dialog = getWelcomeDialog();
    const text = cleanText(dialog?.textContent || "");
    if (dialog) {
      // While the welcome dialog walks the referral role, only ITS verdict
      // counts — the dashboard behind it may already carry verification
      // badges that aren't this dialog's current step.
      if (/Verify your identity|one more step to stand out|verify now/i.test(text) && findButton(dialog, /^(verify now|start (id )?verification)$/i)) return identity(dialog);
    } else {
      const verification =
        Array.from(document.querySelectorAll(VERIFICATION_SELECTOR)).find(isElementVisible) ||
        Array.from(document.querySelectorAll("h4, h3, h2, p")).find((node) => isElementVisible(node) && /Verify your identity to start applying|one more step to stand out/i.test(cleanText(node.textContent))) ||
        Array.from(document.querySelectorAll("button")).find((button) => isElementVisible(button) && /^(verify now|start id verification)$/i.test(textOf(button)));
      if (verification) return identity(verification);
    }
    if (dialog && /no longer accepting applications/i.test(text)) {
      return { code: "closed", element: dialog, message: "hackajob reports this role is no longer accepting applications." };
    }
    if (dialog && /don.t need to apply for this role|handpicking candidates/i.test(text)) {
      return { code: "handpicked", element: dialog, message: "This company handpicks candidates on hackajob instead of taking applications — there is nothing to submit; they contact matching profiles directly." };
    }
    if (dialog && /doesn.t match your profile/i.test(text)) {
      return { code: "not_matched", element: dialog, message: "hackajob's matching did not match this profile to the role, and hackajob only accepts applications for matched roles (\"Apply anyway\" leads to the company's own site)." };
    }
    return null;
  }

  // ---- job cards on /apply ----------------------------------------------------

  function getCardTitle(card) {
    return cleanText(card.querySelector("h3, .card-header h3, h2")?.textContent);
  }
  function getCardApplyButton(card) {
    return (
      Array.from(card.querySelectorAll(".actions button, .actions a, .view-actions-group button, button, a"))
        .filter(isElementVisible)
        .find((button) => CARD_APPLY_PATTERN.test(textOf(button)) && !button.classList.contains("external-job-ai-apply-btn")) ?? null
    );
  }
  function getCardAiApplyButton(card) {
    return Array.from(card.querySelectorAll("button.external-job-ai-apply-btn, .external-job-ai-apply-btn")).find(isElementVisible) || null;
  }
  function isCardApplied(card) {
    return /\bApplied\b/.test(cleanText(card.querySelector(".badges")?.textContent || "")) && !/Not applied/i.test(cleanText(card.textContent));
  }
  function findTargetJobCard() {
    const targetTitle = getTargetTitle();
    const cards = Array.from(document.querySelectorAll("job-card")).filter(isElementVisible).filter((card) => !isCardApplied(card));
    if (cards.length === 0) return null;
    if (targetTitle) {
      const wanted = normalizeComparisonText(targetTitle);
      return (
        cards.find((card) => normalizeComparisonText(getCardTitle(card)) === wanted) ||
        cards.find((card) => {
          const title = normalizeComparisonText(getCardTitle(card));
          return title.length >= 8 && (title.includes(wanted) || wanted.includes(title));
        }) ||
        null
      );
    }
    const applicable = cards.filter((card) => getCardApplyButton(card) || getCardAiApplyButton(card));
    return applicable.length === 1 ? applicable[0] : null;
  }
  function hasMatchesLoaded() {
    return (
      Boolean(document.querySelector("job-card")) ||
      /roles matched to your profile|Your matched roles will appear here|Archer didn.t find specific matches|Nothing here yet/i.test(
        cleanText(document.querySelector("jobs-list, active-matches")?.textContent || "")
      )
    );
  }

  // ---- questions (the Kombo screening dialog + the availability dialog) -----

  function getLinkedLabel(control) {
    if (!control?.id) return null;
    const escaped = window.CSS?.escape ? window.CSS.escape(control.id) : String(control.id).replace(/["\\]/g, "\\$&");
    return document.querySelector(`label[for="${escaped}"]`);
  }
  const GROUP_SELECTOR = ".form-group, .field, mat-form-field, .mat-form-field, .question, .form-row, .kombo-field, [data-question]";
  function getControlQuestion(control) {
    const own = (label) => {
      if (!label) return "";
      const clone = label.cloneNode(true);
      clone.querySelectorAll("input, select, textarea, button, .hj-icon, mat-icon, .label-required, sup").forEach((node) => node.remove());
      return cleanQuestion(clone.textContent);
    };
    const linkedText = own(getLinkedLabel(control));
    if (linkedText) return linkedText;
    const aria = cleanQuestion(control.getAttribute("aria-label"));
    if (aria && !/^select an option$/i.test(aria)) return aria;
    const wrapping = own(control.closest("label"));
    if (wrapping) return wrapping;
    // Walk up through the control's wrappers (mat-form-field → the
    // form-group) and take the first label that isn't another control's own.
    let ancestor = control.parentElement;
    while (ancestor && ancestor !== document.body && !ancestor.matches("form, mat-dialog-container, .dialog-content")) {
      if (ancestor.matches(GROUP_SELECTOR)) {
        const labels = Array.from(ancestor.querySelectorAll("mat-label, label, legend, .label")).filter(
          (label) => !label.querySelector("input, select, textarea, mat-select") && !label.matches(".mat-radio-label, .mat-checkbox-layout")
        );
        const text = own(labels[0]);
        if (text) return text;
      }
      ancestor = ancestor.parentElement;
    }
    return cleanQuestion(control.getAttribute("placeholder"));
  }
  function isRequiredControl(control) {
    if (control.required || control.getAttribute("aria-required") === "true") return true;
    const label = getLinkedLabel(control) || control.closest("label") || control.closest("mat-form-field, .form-group")?.querySelector("mat-label, label");
    return Boolean(label && (label.querySelector(".label-required, sup") || /\*\s*$/.test(cleanText(label.textContent))));
  }
  function controlFieldId(control, fallback) {
    return control.getAttribute("formcontrolname") || control.getAttribute("name") || control.id || fallback;
  }
  function isExcluded(element, scope) {
    let node = element;
    while (node && node !== scope && node !== document.body) {
      if (node.matches?.(EXCLUDED_SCOPE_SELECTOR)) return true;
      node = node.parentElement;
    }
    return false;
  }

  const TEXT_INPUT_TYPES = new Set(["text", "email", "tel", "number", "url", "search", ""]);
  function buildTextEntry(input, index) {
    if (input.readOnly || input.disabled) return null;
    const type = (input.getAttribute("type") || "").toLowerCase();
    const isTextarea = input.tagName === "TEXTAREA";
    if (!isTextarea && !TEXT_INPUT_TYPES.has(type)) return null;
    const fieldId = controlFieldId(input, `hackajob-text-${index}`);
    const question = getControlQuestion(input);
    if (!question) return null;
    const isPhone = type === "tel" || input.getAttribute("inputmode") === "tel";
    const common = { question, fieldId, field: input, control: input, options: [], required: isRequiredControl(input) };
    if (isPhone) return { ...common, fieldKind: "phone" };
    if (input.classList.contains("mat-autocomplete-trigger") || input.getAttribute("aria-autocomplete") === "list" || input.getAttribute("role") === "combobox") {
      return { ...common, fieldKind: "mat-autocomplete" };
    }
    if (/salary|compensation|\brate\b/i.test(`${fieldId} ${question}`)) return { ...common, fieldKind: "amount" };
    if (isTextarea) return { ...common, fieldKind: "textarea" };
    return { ...common, fieldKind: "text" };
  }
  function buildNativeSelectEntry(select, index) {
    if (select.disabled) return null;
    const question = getControlQuestion(select);
    const options = Array.from(select.options).map((option) => cleanText(option.textContent)).filter(Boolean);
    if (!question || options.length === 0) return null;
    return { question, fieldId: controlFieldId(select, `hackajob-select-${index}`), fieldKind: "select-native", field: select, control: select, options, required: isRequiredControl(select) };
  }
  // mat-select renders its options in an overlay only while open — detection
  // stays side-effect free; the options are read live at fill time.
  function buildMatSelectEntry(select, index) {
    if (select.getAttribute("aria-disabled") === "true") return null;
    const question = getControlQuestion(select) || cleanQuestion(select.getAttribute("placeholder"));
    if (!question) return null;
    const multiple = select.hasAttribute("multiple") || select.getAttribute("aria-multiselectable") === "true";
    return { question, fieldId: controlFieldId(select, `hackajob-mat-select-${index}`), fieldKind: "mat-select", field: select, control: select, options: [], required: isRequiredControl(select), multiple };
  }
  function getRadioLabel(radio) {
    const matLabel = radio.closest("mat-radio-button")?.querySelector(".mat-radio-label-content");
    if (matLabel) return cleanText(matLabel.textContent);
    const linked = getLinkedLabel(radio) || radio.closest("label");
    return cleanText(linked?.textContent) || cleanText(radio.value);
  }
  function getRadioGroupPrompt(group) {
    const container = group.closest(".form-group, .field, form, mat-dialog-container") || group.parentElement;
    const label = container?.querySelector('label:not(.mat-radio-label):not([for^="mat-radio"]), legend, p.question');
    const text = cleanQuestion(textOf(label));
    if (text && !/^select an option$/i.test(text)) return text;
    const aria = cleanQuestion(group.getAttribute("aria-label"));
    if (aria && !/^select an option$/i.test(aria)) return aria;
    return cleanQuestion(textOf(container?.querySelector("h1, h2, h3")));
  }
  function buildRadioGroupEntry(group, index) {
    const radios = Array.from(group.querySelectorAll('input[type="radio"]'));
    if (radios.length === 0) return null;
    const options = radios.map(getRadioLabel).filter(Boolean);
    const question = getRadioGroupPrompt(group);
    if (!question || options.length === 0) return null;
    const name = radios[0].getAttribute("name") || "";
    const required = group.getAttribute("aria-required") === "true" || radios.some((radio) => radio.required);
    return { question, fieldId: group.getAttribute("formcontrolname") || group.getAttribute("name") || name || `hackajob-radio-${index}`, fieldKind: "radio", field: group, control: group, options, required };
  }
  function getCheckboxLabelText(checkbox) {
    const linked = getLinkedLabel(checkbox) || checkbox.closest("label");
    const clone = linked ? linked.cloneNode(true) : null;
    clone?.querySelectorAll("input, .hj-icon, mat-icon").forEach((node) => node.remove());
    return cleanQuestion(clone?.textContent) || cleanQuestion(checkbox.getAttribute("aria-label")) || cleanQuestion(checkbox.closest("mat-checkbox")?.textContent);
  }
  function buildCheckboxEntry(checkbox, index) {
    const label = getCheckboxLabelText(checkbox);
    if (!label) return null;
    return { question: label, fieldId: controlFieldId(checkbox, `hackajob-checkbox-${index}`), fieldKind: "checkbox", field: checkbox, control: checkbox, options: ["Yes", "No"], required: isRequiredControl(checkbox) };
  }
  function buildFileEntry(input) {
    const accept = input.getAttribute("accept") || "";
    const question = getControlQuestion(input) || "Resume";
    return {
      question: /resume|cv/i.test(question) ? question : `Resume (${question})`,
      fieldId: RESUME_FIELD_ID,
      fieldKind: "resume",
      field: input,
      control: input,
      options: [],
      required: true,
      accept,
    };
  }
  function buildStatusEntry(blocker) {
    return { question: "hackajob status", fieldId: STATUS_FIELD_ID, fieldKind: "status", field: blocker.element, control: null, options: [], required: true, statusCode: blocker.code, statusMessage: blocker.message };
  }

  function scanControls(scope) {
    if (!scope) return [];
    const entries = [];
    const seen = new Set();
    const push = (entry) => {
      if (!entry || seen.has(entry.fieldId)) return;
      seen.add(entry.fieldId);
      entries.push(entry);
    };

    const fileInput = Array.from(scope.querySelectorAll('input[type="file"]')).find((input) => input.isConnected && !isExcluded(input, scope));
    if (fileInput) push(buildFileEntry(fileInput));

    const radioGroups = Array.from(scope.querySelectorAll('mat-radio-group, [role="radiogroup"]')).filter((group) => isElementVisible(group) && !isExcluded(group, scope));
    radioGroups.forEach((group, index) => push(buildRadioGroupEntry(group, index + 1)));
    const grouped = new Set(radioGroups.flatMap((group) => Array.from(group.querySelectorAll('input[type="radio"]'))));
    const looseRadios = Array.from(scope.querySelectorAll('input[type="radio"]')).filter((radio) => !grouped.has(radio) && isControlVisible(radio) && !isExcluded(radio, scope));
    const byName = new Map();
    looseRadios.forEach((radio) => {
      const name = radio.getAttribute("name") || "";
      if (!byName.has(name)) byName.set(name, radio.closest(".form-group, fieldset, form") || radio.parentElement);
    });
    let radioIndex = radioGroups.length;
    byName.forEach((container) => {
      radioIndex += 1;
      push(buildRadioGroupEntry(container, radioIndex));
    });

    Array.from(scope.querySelectorAll('input[type="checkbox"]'))
      .filter((checkbox) => !checkbox.disabled && isControlVisible(checkbox) && !isExcluded(checkbox, scope) && !checkbox.closest(".facets, .filters, .panel-filters, .mat-select-panel"))
      .forEach((checkbox, index) => push(buildCheckboxEntry(checkbox, index + 1)));

    Array.from(scope.querySelectorAll("select")).filter((select) => isControlVisible(select) && !isExcluded(select, scope)).forEach((select, index) => push(buildNativeSelectEntry(select, index + 1)));

    Array.from(scope.querySelectorAll("mat-select"))
      .filter((select) => isElementVisible(select) && !isExcluded(select, scope) && select.id !== "list-sort-select")
      .forEach((select, index) => push(buildMatSelectEntry(select, index + 1)));

    Array.from(scope.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea'))
      .filter((input) => isControlVisible(input) && !isExcluded(input, scope))
      .forEach((input, index) => push(buildTextEntry(input, index + 1)));

    return entries;
  }

  function detectAppFields() {
    const blocker = readHackajobBlocker();
    const entries = [];
    const notice = getNoticeDialog();
    if (notice) entries.push(...scanControls(notice));
    const kombo = getKomboDialog();
    if (kombo) entries.push(...scanControls(kombo));
    if (blocker) {
      entries.push(buildStatusEntry(blocker));
      return entries;
    }
    if (!getWelcomeDialog() && !kombo && isApplyListPath() && hasMatchesLoaded() && getTargetTitle() && !findTargetJobCard()) {
      const list = document.querySelector("jobs-list, active-matches") || document.body;
      entries.push(
        buildStatusEntry({
          code: "not_listed",
          element: list,
          message: `hackajob has not matched this profile to "${getTargetTitle()}" — the role is not in Apply → Active Matches, and hackajob only takes applications for matched roles.`,
        })
      );
    }
    return entries;
  }

  // A posting page has nothing to fill: signed in, advance() moves on to
  // the candidate app; signed out, the person signs in themselves.
  function detectFields() {
    captureTargetTitleFromPage();
    return getPageKind() === "app" ? detectAppFields() : [];
  }

  // ---- live lookups -----------------------------------------------------------

  function liveControl(fieldId, fallback = null) {
    if (fallback?.isConnected) return fallback;
    const escaped = window.CSS?.escape ? window.CSS.escape(fieldId) : String(fieldId).replace(/["\\]/g, "\\$&");
    return document.querySelector(`[formcontrolname="${escaped}"]`) || document.getElementById(fieldId) || document.querySelector(`[name="${escaped}"]`) || fallback;
  }

  // ---- fills --------------------------------------------------------------

  function isFileAnswer(answer) {
    return Boolean(answer) && typeof answer === "object" && typeof answer.base64 === "string" && typeof answer.fileName === "string";
  }
  function isAffirmative(answer) {
    return answer === true || /^(yes|true|y|agree|accept|on|1)$/i.test(cleanText(typeof answer === "boolean" ? String(answer) : answer));
  }
  function normalizePhoneDigits(answer) {
    const text = cleanText(answer);
    if (!text) return "";
    const plus = text.trim().startsWith("+");
    let digits = text.replace(/\D/g, "");
    if (!digits) return "";
    if (plus && digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1); // US/CA national form for a +1 number
    return plus ? `+${digits}` : digits;
  }
  function normalizeAmount(answer) {
    const text = cleanText(answer);
    const match = text.replace(/,/g, "").match(/(\d+(?:\.\d+)?)\s*(k)?/i);
    if (!match) return "";
    const value = Math.round(parseFloat(match[1]) * (match[2] ? 1000 : 1));
    return Number.isFinite(value) && value > 0 ? String(value) : "";
  }
  // Exact (normalized) match first, then a prefix match, then a substring
  // match — deliberately NOT BidHub's own embedding-similarity fallback
  // (the out-of-scope AI-answer backend). -1 = nothing close enough;
  // leave the control unfilled.
  function matchOptionIndex(texts, answer) {
    const wanted = normalizeComparisonText(typeof answer === "boolean" ? (answer ? "Yes" : "No") : answer);
    if (!wanted) return -1;
    const normalized = texts.map(normalizeComparisonText);
    const exact = normalized.findIndex((text) => text === wanted);
    if (exact >= 0) return exact;
    const prefix = normalized.findIndex((text) => text.length >= 3 && (text.startsWith(wanted) || wanted.startsWith(text)));
    if (prefix >= 0) return prefix;
    return normalized.findIndex((text) => wanted.length >= 4 && text.includes(wanted));
  }
  function answerList(answer) {
    return (Array.isArray(answer) ? answer : String(answer ?? "").split(/\s*[,;|]\s*|\s+and\s+/i)).map(cleanText).filter(Boolean);
  }
  function setCheckbox(checkbox, desired) {
    if (!checkbox || checkbox.checked === desired) return;
    (checkbox.closest("label") || checkbox).click();
    if (checkbox.checked !== desired) checkbox.click();
    if (checkbox.checked !== desired) {
      checkbox.checked = desired;
      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }
  function chooseRadio(group, answer) {
    const radios = Array.from(group?.querySelectorAll?.('input[type="radio"]') ?? []);
    if (radios.length === 0 || answer == null) return;
    const index = matchOptionIndex(radios.map(getRadioLabel), answer);
    if (index < 0) return;
    const radio = radios[index];
    if (radio.checked) return;
    (radio.closest("label") || radio.closest("mat-radio-button")?.querySelector("label") || radio).click();
    if (!radio.checked) radio.click();
  }

  function getOpenOverlayOptions(selector) {
    return Array.from(document.querySelectorAll(selector)).filter(isElementVisible);
  }
  async function openMatSelect(select) {
    const trigger = select.querySelector(".mat-select-trigger") || select;
    trigger.click();
    const options = await waitFor(() => {
      const found = getOpenOverlayOptions(".mat-select-panel mat-option, .cdk-overlay-container mat-option");
      return found.length > 0 ? found : null;
    }, OPTIONS_WAIT_MS, 150);
    return options || [];
  }
  function closeOverlay() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.querySelector(".cdk-overlay-backdrop")?.click();
  }
  function matOptionText(option) {
    return cleanText(option.querySelector(".mat-option-text")?.textContent || option.textContent);
  }
  async function fillMatSelect(select, answer, { multiple = false } = {}) {
    if (!select || answer == null) return;
    const options = await openMatSelect(select);
    if (options.length === 0) return;
    const texts = options.map(matOptionText);
    const wanted = multiple ? answerList(answer) : [answer];
    for (const value of wanted) {
      const index = matchOptionIndex(texts, value);
      if (index >= 0) {
        options[index].click();
        await sleep(150);
      }
      if (!multiple) break;
    }
    if (multiple || getOpenOverlayOptions(".mat-select-panel mat-option").length > 0) closeOverlay();
  }

  // Type like a keyboard would (keydown/input/keyup of the last
  // character) so Material's autocomplete issues its suggestion request.
  function typeForSuggestions(input, text) {
    input.focus();
    fillTextInputWithoutBlur(input, text);
    const key = text.slice(-1);
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  }
  async function typeAndPick(input, answer, { optionSelector, shouldAbort = () => false } = {}) {
    const text = cleanText(answer);
    if (!input || !text) return false;
    let options = null;
    for (let attempt = 0; attempt < 2 && !options; attempt += 1) {
      if (shouldAbort()) return false;
      typeForSuggestions(input, text);
      const found = await waitFor(() => {
        const visible = getOpenOverlayOptions(optionSelector);
        return visible.length > 0 ? visible : null;
      }, SUGGESTION_WAIT_MS, 150);
      if (found && found.length > 0) options = found;
    }
    if (!options) return false;
    const texts = options.map((option) => cleanText(option.textContent));
    const index = matchOptionIndex(texts, text);
    const pick = options[index >= 0 ? index : 0];
    ["mousedown", "mouseup", "click"].forEach((type) => pick.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true })));
    await sleep(300);
    return true;
  }
  async function fillAutocomplete(input, answer, { shouldAbort = () => false } = {}) {
    if (answer == null) return;
    for (const value of answerList(answer).slice(0, 5)) {
      await typeAndPick(input, value, { optionSelector: ".mat-autocomplete-panel mat-option, .cdk-overlay-container mat-option", shouldAbort });
      if (shouldAbort()) return;
    }
  }

  // Minimal `<input accept>` gating — the one piece of BidHub's shared
  // file-accept.js this module needs (a `.doc,.docx,.pdf`-style upload
  // silently drops anything else), kept local rather than pulled in
  // whole since nothing else here needs the rest of that module.
  function fileMatchesAccept(fileName, accept) {
    const tokens = String(accept ?? "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (tokens.length === 0) return true;
    const extensionMatch = /\.[^./\\\s]+$/.exec(String(fileName ?? "").trim().toLowerCase());
    const extension = extensionMatch ? extensionMatch[0] : "";
    return tokens.some((token) => token === "*" || token === "*/*" || (token.startsWith(".") && extension === token));
  }
  function fillResume(entry, answer) {
    const input = liveControl(entry.fieldId, entry.field?.isConnected ? entry.field : document.querySelector('input[type="file"]'));
    if (!input || input.type !== "file") throw new Error("hackajob: upload control not found");
    if (!isFileAnswer(answer)) throw new Error("hackajob: no résumé file to upload");
    const accept = input.getAttribute("accept") || "";
    if (!fileMatchesAccept(answer.fileName, accept)) throw new Error(`hackajob: this upload only accepts ${accept} — "${answer.fileName}" cannot be attached`);
    fillFileInput(input, answer.fileName, answer.base64, answer.mimeType);
  }

  /** Write an already-resolved answer into a question returned by
   *  detectFields(), dispatched by its fieldKind. 'status' has no fill —
   *  it's informational only (entry.statusCode/statusMessage carry the
   *  reason for a caller to surface).
   */
  async function fillField(entry, answer) {
    if (!entry) return;
    const { fieldId, fieldKind, field } = entry;
    switch (fieldKind) {
      case "text":
      case "textarea": {
        const input = liveControl(fieldId, field);
        if (input && answer != null) fillTextInput(input, String(answer));
        return;
      }
      case "phone": {
        const input = liveControl(fieldId, field);
        const digits = normalizePhoneDigits(answer);
        if (input && digits) fillTextInput(input, digits);
        return;
      }
      case "amount": {
        const input = liveControl(fieldId, field);
        const amount = normalizeAmount(answer);
        if (input && amount) fillTextInput(input, amount);
        return;
      }
      case "select-native": {
        const select = liveControl(fieldId, field);
        if (!select || answer == null) return;
        const options = Array.from(select.options).filter((option) => cleanText(option.textContent));
        const index = matchOptionIndex(options.map((option) => cleanText(option.textContent)), answer);
        if (index >= 0 && select.value !== options[index].value) fillSelectInput(select, options[index].value);
        return;
      }
      case "mat-select": {
        const select = liveControl(fieldId, field);
        if (select) await fillMatSelect(select, answer, { multiple: select.hasAttribute("multiple") });
        return;
      }
      case "radio": {
        chooseRadio(liveControl(fieldId, field), answer);
        return;
      }
      case "checkbox": {
        const checkbox = liveControl(fieldId, field);
        if (checkbox?.type === "checkbox") setCheckbox(checkbox, isAffirmative(answer));
        return;
      }
      case "mat-autocomplete": {
        await fillAutocomplete(liveControl(fieldId, field), answer);
        return;
      }
      case "resume": {
        fillResume(entry, answer);
        return;
      }
      default:
        return;
    }
  }

  // ---- submit / advance -------------------------------------------------------

  function describeButton(button) {
    return button ? { detected: true, label: textOf(button) || button.getAttribute("aria-label") || "", disabled: !isEnabled(button) } : { detected: false };
  }
  // The ONLY final submits: "Apply to this role" in the welcome dialog, a
  // matched card's plain Apply, or the Kombo screening dialog's submit.
  function getSubmitButton() {
    if (getPageKind() !== "app") return null;
    if (readHackajobBlocker()) return null;
    const welcome = getWelcomeDialog();
    if (welcome) return findButton(welcome, FINAL_APPLY_PATTERN);
    const kombo = getKomboDialog();
    if (kombo) return findButton(kombo, KOMBO_SUBMIT_PATTERN);
    const card = findTargetJobCard();
    return card ? getCardApplyButton(card) : null;
  }
  function detectSubmitButton() {
    return describeButton(getSubmitButton());
  }

  // A virtual control for "open the candidate app" so a caller can label the step.
  const NAVIGATE_CONTROL = { virtual: true, label: "Open hackajob dashboard" };
  function getAdvanceControl() {
    const kind = getPageKind();
    if (kind === "jd") return isCandidateSignedIn() ? NAVIGATE_CONTROL : null;
    if (kind !== "app") return null;
    if (readHackajobBlocker()) return null;
    const notice = getNoticeDialog();
    if (notice) return findButton(notice, /^submit$/i);
    const welcome = getWelcomeDialog();
    if (welcome) return findButton(welcome, WELCOME_PROGRESS_PATTERN);
    if (getKomboDialog()) return null;
    if (!isApplyListPath()) return NAVIGATE_CONTROL;
    const card = findTargetJobCard();
    if (card && !getCardApplyButton(card)) return getCardAiApplyButton(card);
    return null;
  }
  function detectAdvanceButton() {
    const control = getAdvanceControl();
    if (control === NAVIGATE_CONTROL) return { detected: true, label: NAVIGATE_CONTROL.label, disabled: false };
    return describeButton(control);
  }
  function isAutofillAvailable() {
    return Boolean(detectFields().length || detectSubmitButton().detected || getAdvanceControl());
  }

  async function clickAndSettle(button) {
    if (!button || !isEnabled(button)) return false;
    button.click();
    await sleep(NAVIGATE_SETTLE_MS);
    return true;
  }
  function dismissAppBanners() {
    const keep = Array.from(document.querySelectorAll("button")).find((button) => isElementVisible(button) && /keep my current settings/i.test(textOf(button)));
    keep?.click();
  }
  async function advanceApp() {
    dismissAppBanners();
    if (readHackajobBlocker()) return false;
    const notice = getNoticeDialog();
    if (notice) return clickAndSettle(findButton(notice, /^submit$/i));
    const welcome = getWelcomeDialog();
    if (welcome) {
      const button = findButton(welcome, WELCOME_PROGRESS_PATTERN);
      if (!button) return false;
      const before = cleanText(welcome.textContent);
      button.click();
      await waitFor(() => (cleanText(getWelcomeDialog()?.textContent || "") !== before ? true : null), ROUTE_WAIT_MS, 150);
      return true;
    }
    if (getKomboDialog()) return false;
    if (!isApplyListPath()) {
      window.location.assign(APP_APPLY_URL);
      return true;
    }
    const card = findTargetJobCard();
    if (card && !getCardApplyButton(card)) {
      const ai = getCardAiApplyButton(card);
      if (ai) {
        ai.click();
        await waitFor(() => getKomboDialog() || null, ROUTE_WAIT_MS, 150);
        return true;
      }
    }
    return false;
  }
  async function advance() {
    const kind = getPageKind();
    if (kind === "jd") {
      if (!isCandidateSignedIn()) return false;
      window.location.assign(APP_APPLY_URL);
      return true;
    }
    if (kind === "app") return advanceApp();
    return false;
  }
  function beforeStart() {
    if (getPageKind() === "app") dismissAppBanners();
    captureTargetTitleFromPage();
  }

  NS.hackajob = {
    isAutofillAvailable,
    beforeStart,
    advance,
    detectFields,
    fillField,
    getSubmitButton,
    detectSubmitButton,
    detectAdvanceButton,
  };
})();
