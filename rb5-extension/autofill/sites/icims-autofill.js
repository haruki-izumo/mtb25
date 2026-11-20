/* =====================================================================
 * autofill/sites/icims-autofill.js — iCIMS candidate-application autofill.
 * =====================================================================
 * Ported from BidHub Copilot's own
 * packages/job-parsers/content/platforms/icims/autofill.js — the
 * iCIMS-specific field-detection and value-filling logic ONLY. All the
 * mechanical value-setting/typing/clicking BidHub's own bundler
 * duplicated into every site file now lives in the one shared
 * autofill/engine/dom-interactions.js module (window.ProactiveAutofillEngine)
 * — this file calls into that instead of reimplementing it.
 *
 * iCIMS ("<tenant>.icims.com") themes its careersite per tenant, but
 * keeps every field identifiable by STRUCTURAL `.iCIMS_*` classes and a
 * handful of stable id/name conventions, regardless of tenant theming:
 *   - `.iCIMS_TableRow` / `fieldset` — one question's wrapper.
 *   - `<select id="X">` paired with a sibling `#X_icimsDropdown` —
 *     iCIMS's own searchable/fixed custom dropdown widget wrapping a
 *     real (but hidden) native <select>.
 *   - a hidden text input + sibling `a.dropdown-select[aria-controls]` —
 *     iCIMS's OTHER custom widget, a combobox (seen on the login-step
 *     phone country code).
 *   - `input[type="file"]` whose id/name/label mentions "resume" / "cv"
 *     or "cover letter" — the two document-upload slots.
 *   - `.iCIMS_Steps` — the Candidate Portal's step indicator, needed to
 *     tell an intermediate "Submit" (saves + advances) from the terminal
 *     one (files the application) — see isOnFinalIcimsStep below.
 * Visible label TEXT is localized per tenant; CONTROL ROUTING is not —
 * so detection here keys off class/id structure first, falling back to
 * label text only to read the human-facing QUESTION, never to find the
 * control itself.
 *
 * OUT OF SCOPE (left to Big Banana's own, separate systems — not ported):
 *   - Free-text screening-question answer generation (BidHub's
 *     getAnswer()/ai-core calls). A field this file doesn't classify
 *     deterministically is simply never returned by detectFields(), so
 *     Big Banana's existing generic AI-answer pipeline picks it up.
 *   - CAPTCHA solving.
 *   - Proxy / remote-CDP automation.
 *   - The repeatable Education / Work-experience / Address / Phones
 *     `.iCIMS_CollectionContainer` sections and the Forms-module EEO/
 *     Veteran/Disability "packet" self-ID sub-forms. Both are tied to
 *     BidHub's own structured-profile data model (getProfileSectionData)
 *     that has no equivalent here; their controls are explicitly
 *     excluded below rather than detected generically against the wrong
 *     row, and — like a free-text question — are left for the generic
 *     pipeline rather than answered with a guess.
 *   - The résumé-upload "wait for iCIMS to finish parsing before filling
 *     the rest of the step" handoff state machine (incl. the
 *     sessionStorage continuation for tenants that full-reload after
 *     upload). That's a BidHub-background-driver orchestration concern;
 *     isResumeParsing() is ported so a caller CAN wait on it, but the
 *     full handoff/continuation machinery is not.
 * ===================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofillEngine) return;
  const engine = window.ProactiveAutofillEngine;

  // --- constants ---------------------------------------------------------

  const DROPDOWN_WAIT_MS = 2500;
  const DROPDOWN_LOADING_GRACE_MS = 500;
  const DROPDOWN_SCROLL_MAX_OPTIONS = 300;

  // Candidate Portal step-advance (NEVER the terminal submit) — beyond the
  // generic Next/Continue, iCIMS's own step button (#cp_form_submit_i /
  // name="profileButton") changes label per step ("Update Profile" /
  // "Submit Profile" / "Create Profile" on the account+profile page,
  // "Continue" / "Save & Continue" later). Each SAVES the step and moves
  // forward; none finalizes the application.
  const ADVANCE_LABEL_PATTERN =
    /^(?:next|continue|save (?:and|&) continue|save (?:and|&) finish later|proceed|review|(?:update|submit|save|create) profile|create account|register)$/i;
  // The terminal submit. CRUCIAL iCIMS quirk: the multi-step Candidate
  // Portal labels the step-ADVANCE button "Submit" on EVERY step (e.g.
  // "Candidate Questions" -> next step) — identical to the terminal
  // submit's label. So "Submit" is only ever treated as terminal when the
  // step indicator says we're on the LAST step (isOnFinalIcimsStep); on
  // any earlier step it's an advance (see getApplicationAdvanceButton).
  const FINAL_SUBMIT_LABEL_PATTERN = /^submit(?:\s+(?:your\s+)?application)?$/i;
  const APPLY_ANCHOR_SELECTOR = [
    "a.iCIMS_ApplyOnlineButton",
    'a[href*="mode=apply"][href*="apply=yes"]',
    'a[href*="mode=apply"]',
  ].join(", ");

  // Tenant-hosted login (email + password on the tenant's own host):
  // varies its wrapper markup per tenant but reuses these input names and
  // form ids everywhere.
  const LOGIN_FORM_SELECTOR = [
    'form#enterEmailForm',
    'form[name="enterEmailForm"]',
    'form#enterPasswordForm',
    'form[name="enterPasswordForm"]',
    ".iCIMS_LoginPage",
  ].join(", ");
  const LOGIN_ADVANCE_SELECTOR = "#enterEmailSubmitButton, #enterPasswordSubmitButton";

  // Auth0 Universal Login (login.icims.com) — a distinct host, distinct
  // (hashed-CSS) markup. The manifest match list includes this host, so
  // it has to be handled here too, not just the tenant's own login form.
  const AUTH0_LOGIN_HOST = "login.icims.com";
  const AUTH0_USERNAME_SELECTOR = 'input#username[name="username"], input[name="username"][autocomplete="email"]';
  const AUTH0_ADVANCE_SELECTOR = [
    'button[type="submit"][data-action-button-primary="true"]',
    "button._button-login-id",
    "button._button-login-password",
  ].join(", ");
  // Post-login Auth0 interstitials (e.g. "Log In Faster on This Device"):
  // an automated run must never enroll a passkey — its "Continue" would
  // pop the OS biometric dialog and wedge the run. Decline instead,
  // preferring the permanent "Not on this device" over "Remind me later"
  // so the prompt doesn't keep coming back. Checked BEFORE the advance
  // selector below.
  const AUTH0_ENROLLMENT_DECLINE_SELECTORS = [
    'button[type="submit"][name="action"][value="refuse-add-device"]',
    'button[type="submit"][name="action"][value="snooze-enrollment"]',
  ];

  const IGNORED_INPUT_TYPES = new Set(["button", "hidden", "image", "reset", "submit"]);
  const DASHES = "[-\\u2010-\\u2015\\u2212]";
  const PLACEHOLDER_OPTION_PATTERN = new RegExp(
    `^(?:${DASHES}+\\s*)?(?:make a selection|type to search|no results|please select a country|select)(?:\\s*${DASHES}+)?$`,
    "i"
  );
  const GENERIC_FILE_SOURCE_PATTERN = /^(?:my computer|google drive|dropbox|onedrive)(?:\s*\(opens new window\))?$/i;

  // Controls inside one of these are owned by a repeatable-section /
  // self-ID-packet system this port doesn't implement (see header) —
  // excluded rather than detected generically against the wrong instance.
  const EXCLUDED_CONTAINER_SELECTOR = ".iCIMS_CollectionContainer, .icims_group_loop, form[name=\"icims_form\"]";

  // --- text helpers --------------------------------------------------------

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(/[*]/g, "")
      .replace(/\brequired\.?/gi, "")
      .replace(/^\s*error:\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function comparableText(value) {
    return normalizeText(value)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
  }
  function escapeAttr(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  function firstText(...values) {
    for (const value of values.flat()) {
      const text = normalizeText(value);
      if (text) return text;
    }
    return "";
  }
  // Turn an iCIMS field id/name into a human-ish question when no label
  // exists at all (e.g. `PersonProfileFields.PhoneNumber` -> "Phone Number").
  function humanizeIdentifier(identifier) {
    return normalizeText(
      String(identifier ?? "")
        .replace(/^-\d+_/, "")
        .replace(/^icims_f_/i, "")
        .replace(/(?:Person|Portal|Cand)ProfileFields\./g, "")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_.-]+/g, " ")
    );
  }
  function isPlaceholderOption(text) {
    return !text || PLACEHOLDER_OPTION_PATTERN.test(normalizeText(text));
  }

  // --- visibility / page context -------------------------------------------

  function isVisible(element, { allowHiddenFileInput = false, allowHiddenSelect = false } = {}) {
    if (!element?.isConnected) return false;
    if (allowHiddenFileInput && element.matches?.('input[type="file"]')) return true;
    if (allowHiddenSelect && element.matches?.("select.dropdown-hide")) return true;
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isIcimsJobsPage() {
    const hasJobIdQuery = new URLSearchParams(window.location.search).has("jobid");
    return (
      /\.icims\.com$/i.test(window.location.hostname) &&
      (/\/jobs\/\d+(?:\/|$)/i.test(window.location.pathname) ||
        /\/jobs\/[^/]+\/login(?:\/|$)?/i.test(window.location.pathname) ||
        (/\/jobs\/login(?:\/|$)?/i.test(window.location.pathname) && hasJobIdQuery))
    );
  }

  // The scope a detection pass should search within: the careersite's
  // Candidate Portal content, or (on the apply/login step) the login
  // form — whichever is present and actually hosts form controls.
  function getIcimsRoot() {
    if (!isIcimsJobsPage()) return null;
    const roots = Array.from(
      document.querySelectorAll([".iCIMS_CenteredPageContent", "form#questions", 'form[name="questions"]', LOGIN_FORM_SELECTOR].join(", "))
    ).filter((root) => root.querySelector(".iCIMS_Forms_Global, .iCIMS_TableRow, input, select, textarea"));
    return roots[0] ?? null;
  }

  // --- tenant-hosted login context -----------------------------------------

  function getLoginForm() {
    if (!isIcimsJobsPage()) return null;
    const known = document.querySelector(LOGIN_FORM_SELECTOR);
    if (known) return known.matches("form") ? known : known.querySelector("form") ?? known;
    const loginInput = document.querySelector('input[name="css_loginName"], input[name="css_password"]');
    return loginInput?.closest("form") ?? null;
  }
  function isLoginContext() {
    return Boolean(getLoginForm()) || isAuth0LoginPage();
  }

  // --- Auth0 Universal Login (login.icims.com) -----------------------------

  function getAuth0UsernameInput() {
    if (window.location.hostname !== AUTH0_LOGIN_HOST) return null;
    const input = document.querySelector(AUTH0_USERNAME_SELECTOR);
    return input && !input.disabled && isVisible(input) ? input : null;
  }
  function getAuth0PasswordInput() {
    if (window.location.hostname !== AUTH0_LOGIN_HOST) return null;
    return Array.from(document.querySelectorAll('input[type="password"]')).find((input) => !input.disabled && isVisible(input)) ?? null;
  }
  function getAuth0AdvanceButton() {
    if (window.location.hostname !== AUTH0_LOGIN_HOST) return null;
    const clickable = (button) => isVisible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true";
    // Checked one at a time (not comma-joined) so "Not on this device"
    // wins over "Remind me later" regardless of DOM order.
    for (const selector of [...AUTH0_ENROLLMENT_DECLINE_SELECTORS, AUTH0_ADVANCE_SELECTOR]) {
      const match = Array.from(document.querySelectorAll(selector)).find(clickable);
      if (match) return match;
    }
    return null;
  }
  function isAuth0LoginPage() {
    if (window.location.hostname !== AUTH0_LOGIN_HOST) return false;
    return Boolean(getAuth0UsernameInput() || getAuth0PasswordInput() || getAuth0AdvanceButton());
  }

  // --- "Show More" collapsed field groups ----------------------------------
  // iCIMS collapses optional field groups behind "Show More" toggles
  // (`name="icims_gsi_<Group>"`) — a field hidden behind one is invisible
  // to detection until the toggle is clicked. Expand every one up front.
  function expandCollapsedToggles(root = document) {
    root.querySelectorAll('[name^="icims_gsi_"], button[name^="icims_gsi_"], a[name^="icims_gsi_"]').forEach((el) => {
      if (isVisible(el)) el.click();
    });
  }

  // --- control eligibility --------------------------------------------------

  function isEligibleControl(control) {
    if (!control || control.disabled) return false;
    if (control.closest(".dropdown-container")) return false;
    if (control.matches("select")) {
      return isVisible(control, { allowHiddenSelect: true }) || Boolean(getDropdownAnchor(control));
    }
    if (control.matches("textarea")) return isVisible(control);
    if (!control.matches("input")) return false;
    const type = (control.type ?? "").toLowerCase();
    if (IGNORED_INPUT_TYPES.has(type)) return false;
    if (type === "file") return isVisible(control, { allowHiddenFileInput: true });
    // The hidden value input of a searchable combobox (e.g. the login-step
    // phone country code) is the canonical control even though it's
    // display:none — its visible half is the `a.dropdown-select` anchor.
    if (getComboboxAnchor(control)) return true;
    return isVisible(control);
  }
  function getLogicalControls(root) {
    return Array.from(root.querySelectorAll("input, select, textarea"))
      .filter((control) => !control.closest(EXCLUDED_CONTAINER_SELECTOR))
      .filter(isEligibleControl);
  }

  // --- question / label resolution ------------------------------------------

  function getAriaLabelledText(control) {
    return String(control?.getAttribute?.("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => normalizeText(document.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(" ");
  }
  function getDescribedByText(control) {
    return String(control?.getAttribute?.("aria-describedby") ?? "")
      .split(/\s+/)
      .map((id) => normalizeText(document.getElementById(id)?.textContent))
      .filter(Boolean)
      .join(" ");
  }
  function getLinkedLabelText(control) {
    if (!control?.id) return "";
    const labels = Array.from(document.querySelectorAll(`label[for="${escapeAttr(control.id)}"]`));
    const texts = labels
      .flatMap((label) => [engine.getQuestionText(label), label.textContent])
      .map((value) => normalizeText(value))
      .filter(Boolean);
    // A file input's <label> is frequently the generic "My Computer /
    // Google Drive / Dropbox" source-picker text, not the actual question
    // ("Resume") — skip it in favour of another label candidate when one
    // exists.
    return texts.find((text) => !GENERIC_FILE_SOURCE_PATTERN.test(text)) || texts[0] || "";
  }
  function getFieldLabelText(field) {
    return firstText(
      field?.querySelector?.(".iCIMS_InfoField label")?.textContent,
      field?.querySelector?.("legend .iCIMS_LabelText, legend")?.textContent,
      field?.querySelector?.("label")?.textContent
    );
  }

  // A phone-NUMBER control's visible label is frequently just "Number"
  // (the "Phone" heading sits above the group) — qualify it so a caller
  // resolving an answer doesn't see a bare "Number" and guess nonsense.
  function isPhoneNumberField(control) {
    return /phone\W*number/i.test(`${control?.id ?? ""} ${control?.name ?? ""}`);
  }

  // The user-facing question for a control: label -> aria -> data-label ->
  // aria-describedby -> humanized field id. Structural, not stylistic —
  // this is read-only; it never decides which control to use.
  function getControlQuestion(control) {
    const raw = firstText(
      getLinkedLabelText(control),
      engine.getInputLabelText(control),
      getAriaLabelledText(control),
      control.getAttribute("aria-label"),
      control.getAttribute("data-label"),
      getDescribedByText(control),
      humanizeIdentifier(control.name || control.id)
    );
    if (isPhoneNumberField(control) && !/\bphone\b/.test(comparableText(raw))) {
      return raw ? `Phone ${raw}` : "Phone number";
    }
    return raw;
  }
  function getChoiceLabel(input, fallbackQuestion = "") {
    return normalizeText(engine.getInputLabelText(input) || input?.labels?.[0]?.textContent || input?.value || fallbackQuestion);
  }

  // The question wrapper for a control — used both to scope sibling
  // choice/option queries and as the detected field's "field" handle.
  function getQuestionField(control) {
    if (!control) return null;
    if (control.type === "file") {
      return control.closest(".iCIMS_TableRow") || control.closest("fieldset") || control.closest(".iCIMS_ResumeContentDiv") || control.parentElement || control;
    }
    if (control.type === "radio" || control.type === "checkbox") {
      return control.closest("fieldset, .iCIMS_TableRow") || control;
    }
    if (getComboboxAnchor(control)) {
      return (
        control.closest(".iCIMS_TableRow, fieldset") ||
        getComboboxAnchor(control).closest(".iCIMS_InfoData")?.parentElement ||
        control.closest(".iCIMS_InfoData") ||
        control
      );
    }
    return control.closest(".iCIMS_TableRow, fieldset") || control;
  }

  // --- iCIMS custom searchable <select> (id + companion _icimsDropdown) ----
  // iCIMS pairs a REAL (but visually hidden) `<select id="X">` with a
  // widget rendered as `#X_icimsDropdown` (an `a.dropdown-select` anchor) +
  // `#X_icimsDropdown_ctnr` (the open listbox) + `#X_dropdown-results`
  // (the `<li>` options) + optionally `input.dropdown-search` (present
  // only when the list is a server-filtered typeahead rather than a short
  // fixed list iCIMS marks `dropdown-invisible`).

  function getDropdownAnchor(select) {
    return select?.id ? document.getElementById(`${select.id}_icimsDropdown`) : null;
  }
  function getDropdownContainer(select) {
    return select?.id ? document.getElementById(`${select.id}_icimsDropdown_ctnr`) : null;
  }
  function getDropdownResults(select) {
    return select?.id ? document.getElementById(`${select.id}_dropdown-results`) : null;
  }
  function getDropdownSearchInput(select) {
    return getDropdownContainer(select)?.querySelector?.("input.dropdown-search") ?? null;
  }
  function isDropdownSearchable(select) {
    const search = getDropdownSearchInput(select);
    return Boolean(search && !search.classList.contains("dropdown-invisible"));
  }
  function getDropdownLoadingElement(select) {
    return getDropdownContainer(select)?.querySelector?.(".dropdown-loading") ?? null;
  }
  function isCustomDropdown(select) {
    return Boolean(select?.tagName === "SELECT" && (select.classList.contains("dropdown-hide") || getDropdownAnchor(select)));
  }
  function isDropdownOpen(select) {
    const container = getDropdownContainer(select);
    const anchor = getDropdownAnchor(select);
    return Boolean(container && !container.classList.contains("dropdown-invisible") && anchor?.getAttribute("aria-expanded") === "true");
  }
  function isDropdownLoading(select) {
    const el = getDropdownLoadingElement(select);
    if (!el) return false;
    if (el.hidden || ["hide", "hidden", "iCIMS_NoDisplay", "dropdown-invisible"].some((c) => el.classList.contains(c)) || el.getAttribute("aria-hidden") === "true") {
      return false;
    }
    return isVisible(el);
  }
  function getDropdownSelectedText(select) {
    const anchor = getDropdownAnchor(select);
    return normalizeText(anchor?.querySelector?.(".dropdown-text")?.textContent || select?.selectedOptions?.[0]?.textContent || "");
  }
  function getSelectOptionEntries(field) {
    const select = engine.getNativeSelect(field);
    if (!select) return [];
    return Array.from(select.querySelectorAll("option"))
      .filter((option) => option.value && !isPlaceholderOption(option.textContent))
      .map((option) => ({ value: option.value, text: normalizeText(option.textContent || option.getAttribute("title")) }))
      .filter((option) => option.text);
  }
  function getDropdownOptionEntries(field) {
    const select = engine.getNativeSelect(field);
    if (!select || !isCustomDropdown(select)) return [];
    const results = getDropdownResults(select);
    const entries = Array.from(results?.querySelectorAll?.('li.dropdown-result, [role="option"]') ?? [])
      .map((element) => ({ element, text: normalizeText(element.getAttribute("title") || element.getAttribute("aria-label") || element.textContent) }))
      .filter((option) => option.text && !isPlaceholderOption(option.text));
    return entries.length > 0 ? entries : getSelectOptionEntries(field);
  }

  // --- iCIMS searchable combobox (hidden value input + a.dropdown-select) --
  // Seen on the login-step phone country code: a hidden text input holds
  // the ISO code, a sibling `a.dropdown-select` triggers a
  // `.dropdown-container` listbox — same open/select shape as the
  // dropdown widget above, just without the backing native <select>.

  function getComboboxAnchor(control) {
    if (!control?.matches?.("input")) return null;
    if (control.closest(".dropdown-container")) return null;
    if (isVisible(control)) return null;
    const wrapper = control.closest(".iCIMS_InfoData") || control.parentElement;
    return wrapper?.querySelector?.('a.dropdown-select[aria-controls], a.dropdown-select[role="combobox"]') ?? null;
  }
  function getComboboxWidget(control) {
    const anchor = getComboboxAnchor(control);
    if (!anchor) return null;
    const containerId = anchor.getAttribute("aria-controls");
    const container = (containerId && document.getElementById(containerId)) || anchor.parentElement?.querySelector?.(".dropdown-container") || null;
    if (!container) return null;
    return { anchor, container, results: container.querySelector('.dropdown-results, [role="listbox"]') };
  }
  function getComboboxOptionEntries(widget) {
    if (!widget?.results) return [];
    return Array.from(widget.results.querySelectorAll('li.dropdown-result, [role="option"]'))
      .map((element) => ({
        element,
        value: element.getAttribute("value") || element.getAttribute("dropdown-result") || "",
        text: normalizeText(element.getAttribute("aria-label") || element.getAttribute("title") || element.textContent),
      }))
      .filter((option) => option.text && !isPlaceholderOption(option.text));
  }
  function isComboboxOpen(widget) {
    const { anchor, container } = widget ?? {};
    if (!anchor || !container) return false;
    return anchor.getAttribute("aria-expanded") === "true" && !container.classList.contains("hidden") && !container.classList.contains("dropdown-invisible");
  }

  // --- small async polling helper ------------------------------------------
  // Generic "wait until check() is truthy" used by the open/close/search
  // steps below — kept local since it's control flow, not a DOM-write
  // primitive the shared engine owns.
  async function waitFor(check, timeoutMs, intervalMs = 50, shouldAbort = () => false) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (shouldAbort()) return null;
      const result = check();
      if (result) return result;
      await engine.sleep(intervalMs);
    }
    return null;
  }
  function findOptionByText(options, value) {
    const want = comparableText(value);
    if (!want) return null;
    return options.find((option) => comparableText(option.text) === want) || options.find((option) => comparableText(option.text).startsWith(want)) || null;
  }

  // --- dropdown open / read / select ---------------------------------------

  async function openDropdown(select, shouldAbort = () => false) {
    const anchor = getDropdownAnchor(select);
    if (!anchor || isDropdownOpen(select)) return;
    await engine.clickLikeHuman(anchor, { shouldAbort });
    await waitFor(() => isDropdownOpen(select), DROPDOWN_WAIT_MS, 50, shouldAbort);
  }
  async function closeDropdown(select, shouldAbort = () => false) {
    const anchor = getDropdownAnchor(select);
    if (!anchor || !isDropdownOpen(select)) return;
    await engine.clickLikeHuman(anchor, { shouldAbort });
    await waitFor(() => !isDropdownOpen(select), DROPDOWN_WAIT_MS, 50, shouldAbort);
  }
  async function waitDropdownLoadingToSettle(select, shouldAbort = () => false) {
    const started = await waitFor(() => isDropdownLoading(select), DROPDOWN_LOADING_GRACE_MS, 50, shouldAbort);
    if (!started && !isDropdownLoading(select)) return;
    await waitFor(() => !isDropdownLoading(select), DROPDOWN_WAIT_MS, 100, shouldAbort);
  }
  async function waitDropdownResults(field, select, shouldAbort = () => false) {
    const options = await waitFor(
      () => {
        if (isDropdownLoading(select)) return null;
        const entries = getDropdownOptionEntries(field);
        return entries.length > 0 ? entries : null;
      },
      DROPDOWN_WAIT_MS,
      100,
      shouldAbort
    );
    return options ?? getDropdownOptionEntries(field);
  }

  // Read EVERY option of an already-open, non-searchable dropdown. iCIMS
  // renders a fixed list lazily — rows below the fold aren't in the DOM
  // until scrolled into view — so the results container is scrolled to
  // the bottom repeatedly (waiting out any loading spinner) until the
  // option count stabilizes, deduping by text while preserving DOM order.
  async function readAllDropdownOptions(select, field, shouldAbort = () => false) {
    await waitDropdownLoadingToSettle(select, shouldAbort);
    if (shouldAbort()) return [];
    const seen = new Map();
    const collect = () => {
      for (const entry of getDropdownOptionEntries(field)) {
        if (entry.text && !seen.has(entry.text)) seen.set(entry.text, entry);
      }
    };
    collect();
    const scroller = getDropdownResults(select) ?? getDropdownContainer(select);
    const isScrollable = (el) => Boolean(el) && el.scrollHeight > el.clientHeight + 4;
    if (isScrollable(scroller)) {
      let lastSize = -1;
      let stable = 0;
      while (seen.size < DROPDOWN_SCROLL_MAX_OPTIONS && stable < 2 && !shouldAbort()) {
        scroller.scrollTop = scroller.scrollHeight;
        await engine.sleep(80);
        if (isDropdownLoading(select)) await waitDropdownLoadingToSettle(select, shouldAbort);
        collect();
        if (seen.size === lastSize) stable += 1;
        else {
          stable = 0;
          lastSize = seen.size;
        }
      }
    }
    return Array.from(seen.values());
  }

  async function selectDropdownOption(field, select, option, shouldAbort = () => false) {
    if (option?.element?.isConnected) {
      option.element.scrollIntoView?.({ block: "nearest" });
      await engine.clickLikeHuman(option.element, { shouldAbort });
      await waitFor(() => (shouldAbort() || !isDropdownOpen(select) ? true : comparableText(getDropdownSelectedText(select)) === comparableText(option.text) ? true : null), DROPDOWN_WAIT_MS, 100, shouldAbort);
      return;
    }
    if (option?.value != null) {
      engine.fillSelectInput(select, option.value);
      await waitDropdownResults(field, select, shouldAbort);
    }
  }

  async function openCombobox(widget, shouldAbort = () => false) {
    if (!widget?.anchor || isComboboxOpen(widget)) return;
    await engine.clickLikeHuman(widget.anchor, { shouldAbort });
    await waitFor(() => isComboboxOpen(widget), DROPDOWN_WAIT_MS, 50, shouldAbort);
  }
  async function selectComboboxOption(widget, option, shouldAbort = () => false) {
    if (!option?.element?.isConnected) return;
    option.element.scrollIntoView?.({ block: "nearest" });
    await engine.clickLikeHuman(option.element, { shouldAbort });
    await waitFor(() => {
      if (shouldAbort() || !isComboboxOpen(widget)) return true;
      const text = normalizeText(widget.anchor.querySelector(".dropdown-text")?.textContent || "");
      return text && comparableText(text) === comparableText(option.text) ? true : null;
    }, DROPDOWN_WAIT_MS, 100, shouldAbort);
  }

  // --- option enumeration (checkbox / radio / select / custom dropdown) ----

  const CONSENT_CHECKBOX_PATTERN =
    /\bi\s+(?:accept|agree|consent|acknowledge|certif|authoriz|attest|declare|understand|have\s+read)|\b(?:agree|consent)\s+to\b|\bterms\b|\bprivacy\s+(?:policy|notice|statement)\b/i;
  const BINARY_QUESTION_CHECKBOX_PATTERN =
    /^if\b|\bare (?:you|your)\b|\bdo you\b|\bdid you\b|\bhave you\b|\bwould you\b|\bwill you\b|\bcan you\b|\bis your\b|\?|\bresident\b|\bciti(?:zen|zenship)\b|\bsponsorship\b|\bwork (?:visa|permit|authoriz)|\beligible\b|\brelocat/i;
  // A lone checkbox is usually a forced "Yes" consent/acknowledgment
  // (nothing to decline). But a lone checkbox PHRASED as a yes/no
  // question (e.g. iCIMS's "If you are an EU/UK resident, check this
  // box") is genuinely binary and must stay declinable — offer both.
  function isBinaryQuestionCheckbox(label) {
    const text = comparableText(label);
    if (!text || CONSENT_CHECKBOX_PATTERN.test(text)) return false;
    return BINARY_QUESTION_CHECKBOX_PATTERN.test(text);
  }
  function getSyncOptions(field) {
    const checkboxes = engine.getCheckboxInputs(field);
    if (checkboxes.length > 0) {
      if (checkboxes.length === 1) {
        const label = getChoiceLabel(checkboxes[0]);
        if (/^acknowledged\b/i.test(label)) return ["Acknowledged"];
        return isBinaryQuestionCheckbox(label) ? ["Yes", "No"] : ["Yes"];
      }
      return checkboxes.map((checkbox) => getChoiceLabel(checkbox)).filter(Boolean);
    }
    const radios = engine.getRadioInputs(field);
    if (radios.length > 0) return radios.map((radio) => getChoiceLabel(radio)).filter(Boolean);
    const select = engine.getNativeSelect(field);
    if (isCustomDropdown(select)) {
      const options = getDropdownOptionEntries(field).map((option) => option.text);
      return options.length > 0 ? options : null;
    }
    const options = getSelectOptionEntries(field).map((option) => option.text);
    return options.length > 0 ? options : null;
  }

  // --- field classification -------------------------------------------------

  function isResumeField(question, control) {
    const q = comparableText(question);
    const id = comparableText(`${control?.id ?? ""} ${control?.name ?? ""}`);
    return /\b(resume|cv)\b/.test(q) || /\bresume\b/.test(id);
  }
  function isCoverLetterField(question, control) {
    const q = comparableText(question);
    const id = comparableText(`${control?.id ?? ""} ${control?.name ?? ""}`);
    return /cover\s*letter/.test(q) || /cover\s*letter/.test(id);
  }
  function getFileBaseId(control) {
    return String(control?.id || control?.name || "").replace(/_File$/, "");
  }
  function isClassHidden(element) {
    return Boolean(element?.classList?.contains("iCIMS_NoDisplay") || element?.classList?.contains("NoDisplay"));
  }
  // iCIMS marks an already-uploaded file several ways depending on
  // tenant/step: a sibling hidden "true" flag, a filename echo input, or
  // a visible filename label.
  function isFileAlreadyUploaded(control) {
    const baseId = getFileBaseId(control);
    if (!baseId) return false;
    if (document.getElementById(baseId)?.value === "true") return true;
    if (normalizeText(document.getElementById(`${baseId}_FileName`)?.value)) return true;
    const label = document.getElementById(`${baseId}_FileNameLabel`);
    return Boolean(label && !isClassHidden(label) && normalizeText(label.textContent));
  }

  function emptyMetadata() {
    return { fieldKind: null, question: "", options: null };
  }

  // Per-control classification: which fill path a detected control needs.
  // Mirrors BidHub's getFieldMetadata, minus the answerType/constraints
  // bookkeeping that only its (unported) backend answer-resolution engine
  // consumed.
  function getFieldMetadata(question, field, control) {
    if (control?.type === "file") {
      if (isFileAlreadyUploaded(control)) return emptyMetadata();
      if (isResumeField(question, control)) return { fieldKind: "resume", question, options: [] };
      if (isCoverLetterField(question, control)) return { fieldKind: "cover_letter", question, options: [] };
      return emptyMetadata();
    }
    if (getComboboxAnchor(control)) return { fieldKind: "icims-combobox", question, options: [] };
    const checkboxes = engine.getCheckboxInputs(field);
    if (checkboxes.length > 0) return { fieldKind: "checkbox", question, options: getSyncOptions(field) };
    const radios = engine.getRadioInputs(field);
    if (radios.length > 0) return { fieldKind: "radio", question, options: getSyncOptions(field) };
    const select = engine.getNativeSelect(field);
    if (select) {
      if (isCustomDropdown(select)) return { fieldKind: "icims-dropdown", question, options: null };
      return { fieldKind: "select-native", question, options: getSyncOptions(field) };
    }
    const textarea = engine.getTextarea(field);
    if (textarea) {
      const cover = isCoverLetterField(question, textarea);
      return { fieldKind: cover ? "cover_letter" : "textarea", question, options: [] };
    }
    const textInput = engine.getTextInput(field);
    if (textInput) {
      const cover = isCoverLetterField(question, textInput);
      return { fieldKind: cover ? "cover_letter" : "text", question, options: [] };
    }
    return emptyMetadata();
  }
  function deriveFieldId(question, control) {
    if (isResumeField(question, control)) return "resume";
    if (isCoverLetterField(question, control)) return "cover_letter";
    return control?.name || control?.id || control?.getAttribute?.("data-label") || null;
  }
  function uniqueFieldId(fieldId, usedIds) {
    if (!fieldId) return null;
    if (!usedIds.has(fieldId)) {
      usedIds.add(fieldId);
      return fieldId;
    }
    let suffix = 2;
    while (usedIds.has(`${fieldId}-${suffix}`)) suffix += 1;
    const unique = `${fieldId}-${suffix}`;
    usedIds.add(unique);
    return unique;
  }
  function getChoiceGroupKey(control) {
    if (!control || !["checkbox", "radio"].includes(control.type) || !control.name) return null;
    return `${control.type}:${control.name}`;
  }
  function compareDocOrder(a, b) {
    if (a === b || !a?.compareDocumentPosition || !b?.compareDocumentPosition) return 0;
    const position = a.compareDocumentPosition(b);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  // --- résumé upload state (lightweight — see header for what's NOT ported) -

  function getResumeFileInput() {
    const known = document.getElementById("PortalProfileFields.Resume_File");
    if (known?.matches?.('input[type="file"]')) return known;
    return Array.from(document.querySelectorAll('input[type="file"]')).find((input) => isResumeField(getControlQuestion(input), input)) ?? null;
  }
  // True while iCIMS shows its "Parsing résumé…" indicator. Ported as a
  // simple readiness check a caller can poll — NOT the full BidHub
  // handoff/continuation state machine (see header).
  function isResumeParsing() {
    return Array.from(document.querySelectorAll('.iCIMS_loadingImageResumeText, #PortalProfileFields\\.Resume_Loading')).some((element) => {
      const target = element.closest?.('#PortalProfileFields\\.Resume_Loading') || element;
      const text = normalizeText(element.textContent || target.textContent);
      return /parsing resume/i.test(text) && isVisible(target);
    });
  }

  // --- detection -------------------------------------------------------------

  // Auth0 Universal Login surfaces just the username field (the password
  // step is a plain visible password input the generic per-field pass
  // below already handles fine); advanceFlow clicks Continue/Log In.
  function detectAuth0LoginFields() {
    const usernameInput = getAuth0PasswordInput() ? null : getAuth0UsernameInput();
    if (!usernameInput) return [];
    return [
      {
        question: "Email",
        fieldId: "username",
        fieldKind: "text",
        field: usernameInput,
        control: usernameInput,
        options: [],
      },
    ];
  }

  // Returns one entry per detected field:
  //   { question, fieldId, fieldKind, field, control, options }
  // `control` is the actual input/select/textarea/checkbox/radio to act
  // on; `field` is its question wrapper (used for sibling lookups, e.g.
  // the rest of a checkbox/radio group). Caller resolves what VALUE goes
  // into each one and calls fillField(entry, value) below — this module
  // never resolves answers itself.
  function detectFields() {
    if (isAuth0LoginPage()) return detectAuth0LoginFields();
    const root = getIcimsRoot();
    if (!root) return [];
    expandCollapsedToggles(root);

    const questions = [];
    const usedIds = new Set();
    const seenChoiceGroups = new Set();
    for (const control of getLogicalControls(root)) {
      const groupKey = getChoiceGroupKey(control);
      if (groupKey && seenChoiceGroups.has(groupKey)) continue;
      if (groupKey) seenChoiceGroups.add(groupKey);

      const field = getQuestionField(control);
      const question = getControlQuestion(control);
      if (!field || !question) continue;

      const metadata = getFieldMetadata(question, field, control);
      if (!metadata.fieldKind) continue;
      const fieldId = uniqueFieldId(deriveFieldId(question, control), usedIds);
      if (!fieldId) continue;

      questions.push({ question, fieldId, fieldKind: metadata.fieldKind, field, control, options: metadata.options });
    }
    return questions.sort((a, b) => compareDocOrder(a.field, b.field));
  }

  // --- fill dispatch ---------------------------------------------------------
  // Mechanical writes all go through window.ProactiveAutofillEngine; this
  // only decides WHICH engine call a given iCIMS field kind needs. Plain
  // text/select/checkbox/radio need no iCIMS-specific handling at all —
  // iCIMS's markup there is just plain HTML the shared engine already
  // covers — so only the two custom widgets get bespoke fill functions.

  async function fillResumeOrCoverLetterFile(entry, file, { shouldAbort = () => false } = {}) {
    if (!file?.base64 || !file?.fileName) return false;
    if (isFileAlreadyUploaded(entry.control)) engine.clearFileInput(entry.control);
    if (shouldAbort()) return false;
    engine.fillFileInput(entry.control, file.fileName, file.base64, file.mimeType);
    return true;
  }

  async function fillIcimsDropdown(entry, value, { shouldAbort = () => false } = {}) {
    const select = engine.getNativeSelect(entry.field) || (entry.control.tagName === "SELECT" ? entry.control : null);
    if (!select || !isCustomDropdown(select)) return false;
    await openDropdown(select, shouldAbort);
    if (shouldAbort()) return false;

    if (isDropdownSearchable(select)) {
      const searchInput = getDropdownSearchInput(select);
      await engine.fillTextInputReliably(searchInput, value, { blur: false, shouldAbort });
      await waitDropdownLoadingToSettle(select, shouldAbort);
      const options = await waitDropdownResults(entry.field, select, shouldAbort);
      const match = findOptionByText(options, value);
      if (!match) return false;
      await selectDropdownOption(entry.field, select, match, shouldAbort);
      return true;
    }

    const options = await readAllDropdownOptions(select, entry.field, shouldAbort);
    const match = findOptionByText(options, value);
    if (!match) {
      await closeDropdown(select, shouldAbort);
      return false;
    }
    await selectDropdownOption(entry.field, select, match, shouldAbort);
    return true;
  }

  async function fillIcimsCombobox(entry, value, { shouldAbort = () => false } = {}) {
    const widget = getComboboxWidget(entry.control);
    if (!widget) return false;
    await openCombobox(widget, shouldAbort);
    if (shouldAbort()) return false;
    const match = findOptionByText(getComboboxOptionEntries(widget), value);
    if (!match) return false;
    await selectComboboxOption(widget, match, shouldAbort);
    return true;
  }

  async function fillCheckboxGroup(entry, value) {
    const checkboxes = engine.getCheckboxInputs(entry.field);
    if (checkboxes.length === 0) return false;
    const wanted = (Array.isArray(value) ? value : [value]).map((v) => comparableText(v));
    let changed = false;
    for (const checkbox of checkboxes) {
      const shouldCheck = checkboxes.length === 1 ? wanted.includes("yes") || wanted.includes(comparableText(getChoiceLabel(checkbox))) : wanted.includes(comparableText(getChoiceLabel(checkbox)));
      if (checkbox.checked !== shouldCheck) {
        await engine.clickLikeHuman(checkbox);
        changed = true;
      }
    }
    return changed;
  }

  async function fillRadioGroup(entry, value) {
    const radios = engine.getRadioInputs(entry.field);
    const want = comparableText(value);
    const match = radios.find((radio) => comparableText(getChoiceLabel(radio)) === want) || radios.find((radio) => comparableText(getChoiceLabel(radio)).startsWith(want));
    if (!match) return false;
    await engine.clickLikeHuman(match);
    return true;
  }

  function fillNativeSelectField(entry, value) {
    const select = engine.getNativeSelect(entry.field) || entry.control;
    const match = findOptionByText(getSelectOptionEntries(entry.field), value);
    if (!match) return false;
    engine.fillSelectInput(select, match.value);
    return true;
  }

  // The one entry point a caller needs: resolve `entry` (from
  // detectFields()) + whatever value it wants filled in, and this routes
  // to the right engine primitive. Returns a Promise<boolean> (false =
  // nothing matched / nothing to do, never throws for a bad match).
  async function fillField(entry, value, opts = {}) {
    if (!entry?.control) return false;
    switch (entry.fieldKind) {
      case "resume":
      case "cover_letter":
        return fillResumeOrCoverLetterFile(entry, value, opts);
      case "icims-dropdown":
        return fillIcimsDropdown(entry, value, opts);
      case "icims-combobox":
        return fillIcimsCombobox(entry, value, opts);
      case "select-native":
        return fillNativeSelectField(entry, value);
      case "checkbox":
        return fillCheckboxGroup(entry, value);
      case "radio":
        return fillRadioGroup(entry, value);
      case "textarea":
      case "text":
      default:
        await engine.fillTextInputReliably(entry.control, value, opts);
        return true;
    }
  }

  // --- step navigation ---------------------------------------------------

  function getControlLabel(control) {
    if (!control) return "";
    return normalizeText(control.value || control.textContent || control.getAttribute?.("aria-label") || control.getAttribute?.("title"));
  }
  function getApplyAnchor() {
    return Array.from(document.querySelectorAll(APPLY_ANCHOR_SELECTOR)).find((anchor) => isVisible(anchor)) ?? null;
  }
  // The tenant login "Next" submit; null while disabled (e.g. a GDPR
  // consent checkbox not yet checked) so a caller waits for the fill pass
  // to enable it rather than clicking a dead button.
  function getLoginAdvanceButton() {
    const loginForm = getLoginForm();
    if (!loginForm) return null;
    const root = loginForm.matches("form") ? loginForm : loginForm.closest("form") ?? document;
    const candidate = document.querySelector(LOGIN_ADVANCE_SELECTOR) || root.querySelector('input[type="submit"], button[type="submit"], button:not([type])');
    if (!candidate || !isVisible(candidate)) return null;
    if (candidate.disabled || candidate.getAttribute("aria-disabled") === "true") return null;
    return candidate;
  }
  function getApplicationActionControls() {
    const root = getIcimsRoot() || document;
    return Array.from(root.querySelectorAll('input[type="submit"], input[type="button"], button, a.iCIMS_Button, a[role="button"], a.iCIMS_Anchor')).filter(
      (control) => control && isVisible(control) && !control.disabled && control.getAttribute("aria-disabled") !== "true"
    );
  }
  // The Candidate Portal step indicator: a `.iCIMS_Steps` list of `<li>`
  // steps, the active one carrying `.iCIMS_Steps_Current`.
  function getIcimsStepItems() {
    const steps = document.querySelector(".iCIMS_Steps");
    return steps ? Array.from(steps.querySelectorAll("li")) : [];
  }
  // True on the LAST step (where a "Submit" files the application) or
  // when there's no step indicator at all (a single-step application,
  // whose lone "Submit" is terminal by definition).
  function isOnFinalIcimsStep() {
    const items = getIcimsStepItems();
    if (items.length === 0) return true;
    const currentIndex = items.findIndex((item) => item.classList.contains("iCIMS_Steps_Current"));
    return currentIndex === -1 || currentIndex === items.length - 1;
  }
  // The terminal Submit — absent in a login context, and (because iCIMS
  // reuses the "Submit" label on every step's advance button) only ever
  // recognised on the final step.
  function getFinalSubmitButton() {
    if (isLoginContext() || !getIcimsRoot()) return null;
    if (!isOnFinalIcimsStep()) return null;
    return getApplicationActionControls().find((control) => FINAL_SUBMIT_LABEL_PATTERN.test(getControlLabel(control))) ?? null;
  }
  function getApplicationAdvanceButton() {
    if (isLoginContext() || !getIcimsRoot()) return null;
    const controls = getApplicationActionControls();
    const advance = controls.find((control) => ADVANCE_LABEL_PATTERN.test(getControlLabel(control)));
    if (advance) return advance;
    // On a non-final step iCIMS's own step button is labeled "Submit" too
    // (it saves the step and moves on) — treat it as an advance; the
    // terminal-submit guard above only fires on the LAST step.
    if (!isOnFinalIcimsStep()) {
      return controls.find((control) => FINAL_SUBMIT_LABEL_PATTERN.test(getControlLabel(control))) ?? null;
    }
    return null;
  }
  // The single forward control for the current step (posting apply ->
  // login submit -> Auth0 continue -> application Next). Never the gated
  // terminal submit.
  function getAdvanceButton() {
    return getApplyAnchor() || getAuth0AdvanceButton() || getLoginAdvanceButton() || getApplicationAdvanceButton();
  }
  // Clicks the current step's forward control. Returns false (and clicks
  // nothing) when the only control left is the terminal submit — that
  // click is for a human/caller to make deliberately, never automatic.
  async function advanceFlow(opts = {}) {
    if (getFinalSubmitButton()) return false;
    const control = getAdvanceButton();
    if (!control) return false;
    await engine.clickLikeHuman(control, opts);
    return true;
  }

  // --- public API ------------------------------------------------------------

  // ---- repeatable Education / Work-experience sections ----------------------
  // Ported from BidHub's own iCIMS section descriptors, driven by the shared
  // engine/section-hierarchy.js. EDUCATION + WORK HISTORY ONLY — iCIMS's
  // address/phone/reference repeatable sections (also inside
  // EXCLUDED_CONTAINER_SELECTOR, see file header) have no BCD-profile
  // equivalent and are out of scope for this port. No clearRows — confirmed
  // no per-row delete exists; the iterator only grows + fills from profile.
  const SECTION_HIERARCHY = window.ProactiveSectionHierarchy;
  const MULTIGROUP_NAME_BY_KIND = { education: "Education", work: "WorkExperience" };

  function getMultigroupShowMoreInput(kind) {
    return document.querySelector(`input[name="icims_gsi_${MULTIGROUP_NAME_BY_KIND[kind]}"]`);
  }
  // iCIMS localizes visible label text per tenant — found by a loose
  // pattern over the page's own headings/legends/field labels, same
  // "structure first, label text only to confirm" rule the rest of this
  // file follows.
  function findSectionHeading(kind) {
    const pattern = kind === "education" ? /\beducation\b/i : /\bwork\s*(experience|history)\b|\bemployment\b/i;
    return (
      Array.from(document.querySelectorAll("h1, h2, h3, h4, legend, .iCIMS_Header, .iCIMS_InfoField label")).find(
        (el) => isVisible(el) && pattern.test(normalizeText(el.textContent))
      ) || null
    );
  }
  function getSectionContainerByKind(kind) {
    const anchor = getMultigroupShowMoreInput(kind) || findSectionHeading(kind);
    if (!anchor) return null;
    return anchor.closest(".iCIMS_Forms_Global") || anchor.closest("fieldset") || anchor.closest(".iCIMS_TableRow")?.parentElement || anchor.closest("form") || document.body;
  }
  function getSectionInstancesByKind(kind) {
    const container = getSectionContainerByKind(kind);
    if (!container) return [];
    const groupLoops = Array.from(container.querySelectorAll(".icims_group_loop")).filter(isVisible);
    if (groupLoops.length) return groupLoops;
    // Plain field-row layout (no MultiGroup loop instances rendered) — the
    // page shows one implicit row; the container itself is scoped as that
    // row so label-text matching below has something to search within.
    return [container];
  }
  // Path (1): `.icims_group_loop` MultiGroup rows — the control sits behind
  // a stable `.iCIMS_Forms_Q<stem>` class. Path (2) fallback: plain
  // field-row layout — match the row whose visible label text matches
  // `mapping.match` (and not `mapping.exclude`, if given).
  function getSectionRowField(rowEl, mapping) {
    if (!rowEl) return null;
    if (rowEl.matches?.(".icims_group_loop")) {
      const stemControl = rowEl.querySelector(`.iCIMS_Forms_Q${mapping.stem}`);
      const input = stemControl && (stemControl.matches("input, select, textarea") ? stemControl : stemControl.querySelector("input, select, textarea"));
      if (input) return { field: input };
    }
    const fieldRows = Array.from(rowEl.querySelectorAll(".iCIMS_TableRow, fieldset"));
    for (const fieldRow of fieldRows.length ? fieldRows : [rowEl]) {
      const labelText = normalizeText(fieldRow.querySelector(".iCIMS_InfoField label, legend, label")?.textContent);
      if (!labelText || !mapping.match.test(labelText)) continue;
      if (mapping.exclude && mapping.exclude.test(labelText)) continue;
      const input = fieldRow.querySelector("input, select, textarea");
      if (input) return { field: input };
    }
    return null;
  }
  // MultiGroup sections add a row via the section's own "Show More" submit
  // button; a non-MultiGroup section instead has each existing instance's
  // own add-another anchor — click the LAST one (closest to the row that
  // would be added next).
  function createSectionAddRow(kind) {
    return async (container) => {
      const showMore = getMultigroupShowMoreInput(kind);
      if (showMore && isVisible(showMore)) {
        await engine.clickLikeHuman(showMore);
        return;
      }
      const scope = container || getSectionContainerByKind(kind) || document;
      const addAnchor = Array.from(scope.querySelectorAll('.iCIMS_CollectionButtonsRow a[onclick*="showGroup"], a.iCIMS_Anchor[role="button"]')).filter(isVisible).pop();
      if (addAnchor) await engine.clickLikeHuman(addAnchor);
    };
  }

  // `major`/`description` have no BCD equivalent (Profile.education is
  // school/degree/start/end only; Profile.experience is company/role/start/
  // end/location only) — those leaves still detect (visible/editable),
  // never auto-filled.
  const EDUCATION_SECTION = {
    rootFieldId: "educationHistory",
    rootQuestion: "Education",
    profileSection: "education",
    rowLabel: (i) => `Education ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: () => getSectionContainerByKind("education"),
    getRows: () => getSectionInstancesByKind("education"),
    getRowField: (rowEl, mapping) => getSectionRowField(rowEl, mapping),
    addRow: createSectionAddRow("education"),
    // No clearRows — see section header comment.
    mappings: [
      { key: "universityName", match: /\bschool\b/i, exclude: /other/i, stem: "School", fieldKind: "text", question: "School", label: "School", profileKey: "school" },
      { key: "degree", match: /degree/i, stem: "Degree", fieldKind: "text", question: "Degree", label: "Degree", profileKey: "degree" },
      { key: "major", match: /major|field of study|concentration/i, stem: "Major", fieldKind: "text", question: "Major", label: "Major" },
      { key: "graduated", match: /graduate/i, stem: "IsGraduated", fieldKind: "dropdown", question: "Graduated", label: "Graduated", resolveValue: (e) => (String(e?.end || "").trim() ? "Yes" : "No") },
      { key: "startDate", match: /start date/i, stem: "EducationStartDate", fieldKind: "text", question: "Start Date", label: "Start Date", profileKey: "start" },
      { key: "endDate", match: /(end|graduation) date/i, stem: "GraduationDate", fieldKind: "text", question: "End/Graduation Date", label: "End/Graduation Date", resolveValue: (e) => (String(e?.end || "").trim() ? e.end : null) },
    ],
  };
  const WORK_HISTORY_SECTION = {
    rootFieldId: "workHistory",
    rootQuestion: "Work History",
    profileSection: "experience",
    rowLabel: (i) => `Work History ${i + 1}`,
    rowGrowthTimeoutMs: 3000,
    getContainer: () => getSectionContainerByKind("work"),
    getRows: () => getSectionInstancesByKind("work"),
    getRowField: (rowEl, mapping) => getSectionRowField(rowEl, mapping),
    addRow: createSectionAddRow("work"),
    // No clearRows — see section header comment.
    mappings: [
      { key: "companyName", match: /employer|company/i, stem: "EmpName", fieldKind: "text", question: "Employer", label: "Employer", profileKey: "company" },
      { key: "positionTitle", match: /\btitle\b|position/i, stem: "EmpTitle", fieldKind: "text", question: "Title", label: "Title", profileKey: "role" },
      { key: "city", match: /\bcity\b/i, stem: "EmpCity", fieldKind: "text", question: "City", label: "City", profileKey: "location" },
      { key: "startDate", match: /start date/i, stem: "EmpStart", fieldKind: "text", question: "Start Date", label: "Start Date", profileKey: "start" },
      { key: "endDate", match: /end date/i, stem: "EmpEnd", fieldKind: "text", question: "End Date", label: "End Date", resolveValue: (e) => (String(e?.end || "").trim() ? e.end : null) },
      { key: "description", match: /description/i, stem: "EmpDescription", fieldKind: "textarea", question: "Description", label: "Description" },
    ],
  };

  const SECTIONS = [EDUCATION_SECTION, WORK_HISTORY_SECTION];

  function detectSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    return SECTION_HIERARCHY.detectSections(SECTIONS, profileData);
  }

  // Plain text/select mappings need no iCIMS-specific handling (same as the
  // generic fillField dispatch above) — only the custom dropdown widget
  // (reused via the existing fillIcimsDropdown) gets special treatment.
  async function fillSectionLeaf(field, mapping, value) {
    switch (mapping.fieldKind) {
      case "text":
        await engine.fillTextInputReliably(field, String(value ?? ""));
        return;
      case "textarea": {
        const textarea = field.tagName === "TEXTAREA" ? field : field.querySelector("textarea");
        if (textarea) await engine.fillTextInputReliably(textarea, String(value ?? ""));
        return;
      }
      case "dropdown": {
        if (field.tagName === "SELECT" && isCustomDropdown(field)) {
          await fillIcimsDropdown({ field, control: field }, String(value ?? ""));
          return;
        }
        if (field.tagName === "SELECT") {
          const match = findOptionByText(getSelectOptionEntries(field), value);
          if (match) engine.fillSelectInput(field, match.value);
          return;
        }
        await engine.fillTextInputReliably(field, String(value ?? ""));
        return;
      }
      default:
        return;
    }
  }

  async function fillSections(profileData) {
    if (!SECTION_HIERARCHY) return [];
    const results = [];
    for (const section of SECTIONS) {
      const entries = (profileData && profileData[section.profileSection]) || [];
      if (!entries.length) continue;
      const result = await SECTION_HIERARCHY.fillSection(section, entries, fillSectionLeaf);
      results.push({ rootFieldId: section.rootFieldId, ...result });
    }
    return results;
  }

  window.ProactiveAutofillSites = window.ProactiveAutofillSites || {};
  window.ProactiveAutofillSites.icims = {
    hostTest: (h) => /\.icims\.com$/i.test(h) || h === AUTH0_LOGIN_HOST,
    isApplicable: () => isIcimsJobsPage() || isAuth0LoginPage(),
    expandCollapsedToggles,
    detectFields,
    fillField,
    getResumeFileInput,
    isResumeParsing,
    getAdvanceButton,
    getFinalSubmitButton,
    advanceFlow,
    detectSections,
    fillSections,
  };
})();
