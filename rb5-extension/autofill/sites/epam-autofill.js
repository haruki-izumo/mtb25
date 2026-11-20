/* =====================================================================
 * autofill/sites/epam-autofill.js — EPAM careers (careers.epam.com).
 * =====================================================================
 * Ported from BidHub's own packages/job-parsers/content/platforms/epam/
 * autofill.js, plus the tiny epam-primary-skills.js module it depends
 * on (the "Primary skill" field's bundled option vocabulary — see
 * EPAM_PRIMARY_SKILLS below).
 *
 * EPAM careers is the company's own Next.js site, not a third-party
 * ATS. A vacancy page's "Apply" button opens the application form in a
 * native MODAL (`<dialog open>` holding `form#apply`) — the URL never
 * changes, so the posting and the form are the same "page", and
 * advance() only has to open the modal, not navigate anywhere.
 *
 * Two platform traits shape everything below:
 *   - CSS-module class names are content-hashed, so detection anchors
 *     on the STABLE `data-testid`s the form emits instead: every
 *     question is `[data-testid="apply-<key>-field"]`. One wrapper
 *     (`apply-phone-field`) holds TWO questions — a country dial-code
 *     picker plus the national-number input — so the picker is
 *     surfaced as a synthetic field (PHONE_COUNTRY_CODE_SPEC) with no
 *     FIELD_SPEC entry of its own.
 *   - The modal mounts ASYNC: it first renders `*_Skeleton` placeholders
 *     and swaps in the real controls after a config fetch, and it keeps
 *     re-rendering individual question wrappers afterwards (e.g.
 *     picking a country re-renders the consent block). detectFields()
 *     treats "skeletons only" as "no fields yet", and fillField()
 *     always re-resolves a question's LIVE wrapper by its data-testid
 *     right before touching it (getLiveField) rather than trusting the
 *     Element handle detectFields() handed out — a cached handle can
 *     already be stale by the time a fill runs.
 *
 * Dropdowns are react-select instances whose instance id
 * ("react-select-6") is the ONLY thing tying a floating options menu
 * back to its field — menus render with their own id prefix
 * (`react-select-<n>-option-<i>`) and are NOT nested inside the
 * question wrapper, so every option read/click below is scoped by that
 * prefix.
 *
 * !! Dropdowns are closed by BLURRING their input, never by Escape —
 * Escape is the native <dialog>'s built-in dismiss key and would close
 * the whole application, losing everything typed so far.
 *
 * Ported, structural-only:
 *   - field enumeration keyed by the DynamicForm's own key (FIELD_SPEC
 *     below), covering plain text/number inputs, the phone number +
 *     its synthetic country-code question, react-select single-select
 *     and multi-select dropdowns, the location/ZIP/primary-skill
 *     typeahead dropdowns, the résumé upload, and any required
 *     acknowledgement checkbox (consent / "plan to return to Ukraine")
 *   - value-filling per field kind, incl. the react-select open/type/
 *     pick mechanics, the phone country-code auto-detect-and-switch,
 *     and the location cascade's "wait for the parent level to commit"
 *     gate (city/zipcode/preferableCity depend on a country/state that
 *     must resolve first, or their own option list stays empty)
 *   - the vacancy page's "Apply" button (opens the modal) and the
 *     modal's own final Submit button's detection
 *
 * OUT OF SCOPE (left to Big Banana's own existing systems, untouched):
 *   - Free-text / single-select / multi-select ANSWER GENERATION.
 *     BidHub resolves every open question through its own AI backend
 *     (ANSWER_TYPE_HANDLERS → getAnswer()), including an embedding-
 *     similarity fallback for an option list with no clean textual
 *     match — none of that is ported. pickOptionIndex() below only
 *     does exact → prefix → contains matching; a looser miss is simply
 *     left unfilled rather than guessed.
 *   - CAPTCHA.
 *   - The location cascade's cross-field WAIT is kept (it's a genuine
 *     DOM fact: a dependent dropdown's menu is empty until its parent
 *     commits), but BidHub's own dependent-question AI-answer
 *     *sequencing/scheduling* machinery around it (bypassDomMutex,
 *     runDomTask, the shared job-runner's fieldPromises bookkeeping) is
 *     not — a caller is expected to fill fields in detectFields()'s
 *     own document order, which already lists a cascade level before
 *     anything that depends on it.
 *   - Proxy/remote-CDP "real input" lanes.
 *   - The modal's final Submit button is never clicked here — only
 *     detected (getSubmitButton). BidHub's own advanceFlow() never
 *     touches it either; the only button it drives is the vacancy
 *     page's "Apply" (which opens the modal, nothing more).
 * ===================================================================== */
(function () {
  "use strict";
  const engine = window.ProactiveAutofillEngine;
  if (!engine) return;
  const { sleep, fillTextInput, fillTextInputWithoutBlur, fillFileInput, clickLikeHuman, getFileInputInsideField, fillComboboxByTyping } = engine;

  const NS = (window.ProactiveAutofillSites = window.ProactiveAutofillSites || {});

  const FORM_SELECTOR = 'form#apply, form[data-testid="dynamic-form"]';
  const ITEM_SELECTOR = '[data-testid^="apply-"][data-testid$="-field"]';
  const DROPDOWN_INPUT_SELECTOR = 'input[role="combobox"], input[class*="dropdown__input"], input[class*="dummyInput"]';
  const SKELETON_SELECTOR = '[class*="Skeleton"]';
  // Each country row is an <li> wrapping the button that actually carries the click handler —
  // the class PREFIX is shared by the li, the button, and three inner spans, so the button is
  // matched explicitly (matching the prefix alone hits 5 nodes per country, and clicking the
  // <li> itself closes the picker without selecting anything).
  const PHONE_COUNTRY_BUTTON_SELECTOR = '[class*="PhoneInput_dropdownListItemButton"]';
  const PHONE_COUNTRY_NAME_SELECTOR = '[class*="PhoneInput_dropdownListItemPrimaryText"]';
  const PHONE_COUNTRY_CODE_SELECTOR = '[class*="PhoneInput_dropdownListItemSecondaryText"]';
  // The button that opens the country picker. Carries the committed selection as
  // `title="Georgia +995"`, which is how the current dial code is read back.
  const PHONE_COUNTRY_SELECT_BUTTON_SELECTOR = '[class*="PhoneInput_countrySelectButton"]';
  const PHONE_DIAL_CODE_SELECTOR = '[class*="PhoneInput_inputDialCode"]'; // the "+995" next to the number input
  const APPLY_MODAL_WAIT_MS = 3000;
  // The (X) on the attached-file chip EPAM renders in place of the CV upload input. Matched by
  // aria-label first (stable, English-only) with the CSS-module prefix as a localisation-proof
  // fallback.
  const RESUME_REMOVE_BUTTON_SELECTOR = 'button[aria-label="Remove file"], button[class*="FilePreviewForUpload_closeBtn"]';
  const RESUME_INPUT_REAPPEAR_TIMEOUT_MS = 5000;
  const DROPDOWN_WAIT_TIMEOUT_MS = 5000;
  const CASCADE_SETTLE_MS = 600;
  const CASCADE_WAIT_TIMEOUT_MS = 15000;

  // EPAM's CLOSED "Primary skill" vocabulary — the only values that field accepts. The control
  // is an async typeahead that renders NO options until something is typed, so unlike every
  // other EPAM dropdown there is nothing to harvest from the page at detection time; without
  // this list the question could only be asked as free text, whose answer ("Full Stack
  // Engineer", say) matches none of the ~400 real rows and commits nothing. Shipping the list
  // keeps the answer inside the vocabulary — the CONTROL is still a typeahead, so the chosen
  // value is typed and then clicked from the live suggestions like any other typeahead field.
  const EPAM_PRIMARY_SKILLS = ['.NET', 'Academic content authoring', 'Accessibility Analysis', 'Accessibility Testing', 'Account Management', 'Accounting and Financial', 'Adobe AEM - Sites & Assets', 'Adobe Campaign and Marketing Automation', 'Adobe Commerce (Magento)', 'Advanced Software Engineering', 'Advanced Systems Engineering', 'Agentic Automation Engineering', 'Agile Coach', 'AI Compliance Assurance', 'AI Native Engineering', 'AI Solution Engineering', 'AI Technology Management', 'Amazon Web Services', 'Android', 'APIs and Integration', 'Appian', 'Application Support', 'Applied AI (Agentic Business Transformation)', 'Applied Mathematics', 'Art Direction', 'Atlassian Platform Administration', 'Audio-visual Production', 'Automated Testing in .NET', 'Automated Testing in Blockchain', 'Automated Testing in DSL', 'Automated Testing in Java', 'Automated Testing in JS', 'Automated Testing in Mobile', 'Automated Testing in Python', 'Automated Testing in Ruby', 'Automation Anywhere', 'Banking Operations', 'BI Analysis', 'BigCommerce', 'Biology Data Curation', 'Blockchain', 'Blue Prism', 'Borland Delphi', 'Brand & Marketing Project Management', 'Brand Design', 'BrightScript', 'Business Analysis', 'Business Analysis Management', 'Business Analytics Consulting', 'Business Consulting', 'Business Development', 'Business Operations', 'Business Process Analysis', 'Business process management (BPM)', 'C Programming', 'C++', 'Calypso', 'Camunda', 'Chatbot', 'Chemistry Data Curation', 'Client Partnership', 'Cloud Engineering Management', 'Cloud Native Development', 'Cloud Operations', 'Commercetools', 'Community Management', 'Compensation & Benefits Management', 'Compliance Assurance', 'Content Authoring', 'Content Creation', 'Content Design', 'Content Development Management', 'Content Management', 'Content Services', 'Content Strategy', 'Contentful', 'Contentstack', 'Conversion Rate Optimization', 'Copywriting', 'Corporate Communications', 'Creative Copywriting', 'Creative Technology', 'CRM Consulting', 'Data & Marketing Analytics Consulting', 'Data Administration', 'Data Analytics and Visualization', 'Data Delivery Management', 'Data DevOps', 'Data Integration', 'Data Quality Engineering', 'Data Science', 'Data Science Consulting', 'Data Software Engineering', 'Data Solution Architecture', 'Data Technology Consulting', 'Database Management & Operations', 'DBA & Cloud Migration', 'Delivery Management', 'Delivery Management [Cloud]', 'Delivery Management [Infrastructure]', 'Delivery Management [SAP]', 'Delivery Management.AI', 'Delivery Operations', 'DevOps', 'Digital Channel Management', 'Digital Client Engagement', 'Digital Marketing Project Management', 'Digital Paid Media Consulting', 'Digital Platforms Functional Consulting', 'Digital Project Management', 'Digital Solution Consulting', 'Drupal', 'Electrical Engineering', 'Electronics Engineering', 'Embedded.Automotive', 'Embedded.Core', 'Enablement Content Production', 'End User IT Support', 'Endpoint Solutions', 'EntApps Movex M3', 'Enterprise Analytics', 'Enterprise Architecture', 'Envisioning', 'ESG and Sustainability Program', 'Financial and Trade Surveillance', 'Financial Crime', 'Financial Planning & Analysis', 'Fluent Commerce OMS', 'Flutter', 'FPGA', 'Functional Testing', 'Game Development', 'Game Testing', 'General Management', 'Generative AI Operations', 'Genesys Platform', 'Go Language', 'Google Cloud Platform', 'Google Technical Support', 'Graphic design', 'Guidewire Platform', 'Healthcare Data Curation', 'Healthcare Strategy', 'Human Capital Management', 'Human Factors', 'Human Performance Enablement', 'IBM Sterling', 'IBM Websphere Commerce', 'Identity and Access Management', 'Immersive Experience Design', 'Industrial Design', 'Infrastructure Automation and Orchestration', 'Innovation Strategy', 'Instructional Design', 'Intelligent Operations', 'Interaction Design', 'Interim - Integration Related', 'iOS Swift', 'IT Service Management (ITSM)', 'Java', 'JavaScript (Frontend)', 'JavaScript (Fullstack)', 'Jurisprudence', 'kdb+', 'Knowledge Base Management', 'Knowledge Enablement', 'Kotlin', 'Language Instruction', 'Learning Experience Design', 'Learning Operations', 'Learning Programs Management', 'Learning Technology', 'LMS Administration', 'Localization Testing', 'Low Code RPA Engineering', 'M&A Integration', 'Mainframe', 'Market Research', 'Marketing Automation Consulting', 'Marketing Strategy Consulting', 'Marketing Technology Consulting', 'Math', 'MATLAB', 'Mechanical Engineering', 'Media Content Creation', 'Media Management', 'Microsoft 365 Engineering', 'Microsoft Azure', 'Microsoft Dynamics 365 CRM', 'Microsoft Dynamics 365 ERP/AX', 'Microsoft Dynamics NAV', 'Microsoft Power Apps', 'Microsoft Power Automate', 'Microsoft SharePoint', 'Mobility', 'Motion Design', 'MS Business Applications Consulting', 'MuleSoft', 'Murex', 'Network Virtualization and SDN', 'Networks & Telecommunication', 'Node.js', 'Office and Facilities Management', 'On-Premise and Hybrid Cloud Infrastructure', 'OpenText Exstream', 'Operational Intelligence', 'Oracle Commerce', 'Oracle ERP', 'Oracle Transportation Management', 'Organizational Change Management', 'Organizational Development', 'OTC Analysis', 'Other Tech', 'OTT development', 'Partnerships and Alliances', 'PCI (Payment Card Industry)', 'PEGA', 'People Analytics', 'People Engagement and Experience', 'People Operations', 'People Partnership and Advisory', 'People Processes and Technologies', 'People Processes Implementation', 'Performance Optimization Management', 'Performance Testing', 'Perl', 'Personnel Administration', 'PHP', 'Physical Prototyping', 'Physics', 'PIM/DAM', 'Platform Engineering', 'Presales Client Engagement', 'Presales Consulting', 'Presales Coordination', 'Process Engineering', 'Procurement', 'Product Management', 'Program Management', 'Project Administration', 'Project Management', 'Python.AI', 'Python.Core', 'Python.Data', 'Python.ML', 'Python.Web', 'Quality Architecture', 'Quality Compliance Assurance', 'Quantitative Analysis', 'Quantitative Business', 'Quantitative Finance', 'R Language', 'React Native', 'Retail Media Consulting', 'Revenue Accounting', 'RPA Engineering', 'Ruby', 'Rust', 'Sales and Marketing', 'Sales Performance Management', 'Sales Research', 'Salesforce', 'Salesforce (Other - DEP)', 'Salesforce (Other)', 'Salesforce Analytics Cloud', 'Salesforce B2B Commerce Cloud on Lightning Experience', 'Salesforce Commerce Cloud (B2B - CloudCraze)', 'Salesforce Commerce Cloud (Backend)', 'Salesforce Commerce Cloud (Frontend)', 'Salesforce Consulting Management', 'Salesforce CPQ', 'Salesforce Field Service', 'Salesforce Financial Services Cloud', 'Salesforce Health Cloud', 'Salesforce Marketing', 'Salesforce Marketing Cloud', 'Salesforce platform', 'Salesforce Primary Clouds (Sales Cloud, Service Cloud, Community Cloud)', 'Salesforce Sales Cloud', 'Salesforce Service Cloud', 'Salesforce Vlocity', 'SAP (Others)', 'SAP ABAP', 'SAP Analytics Cloud', 'SAP Basis and DevOps', 'SAP BI', 'SAP BO', 'SAP BPC', 'SAP BW', 'SAP C/4 HANA.Sales Cloud & SAP Service Cloud', 'SAP CAP based Java', 'SAP CAP based Node.JS', 'SAP CAR', 'SAP Commerce Cloud (Hybris Commerce)', 'SAP Consulting Management', 'SAP CRM', 'SAP Customer Data Cloud (Gigya)', 'SAP Datasphere', 'SAP EWM', 'SAP FICO', 'SAP Fiori UX', 'SAP Functional Consulting', 'SAP HANA Data Warehousing', 'SAP HANA Platform', 'SAP HCM', 'SAP IBP', 'SAP Java', 'SAP Logistics (SCM)', 'SAP Marketing Solutions', 'SAP MDM/MDG', 'SAP PI/PO and Cloud Integration', 'SAP PLM', 'SAP Sales Cloud & SAP Service Cloud (Hybris Cloud For Customer)', 'SAP SAPUI5', 'SAP Security', 'SAP Spartacus for SAP Commerce Cloud (Angular, Hybris)', 'SAP Success Factors', 'Scala', 'Scientific Curation Management', 'Scientific Informatics', 'Scientific Research', 'Scrum Master', 'Search Engine Advertising', 'Search Engine Optimization', 'Security Compliance Assurance', 'Security Engineering Management', 'Security.Cloud', 'Security.Data', 'Security.Development', 'Security.Engineering', 'Security.IAM', 'Security.Network', 'Security.Offensive', 'Security.Operations', 'Security.Risks', 'Security.Testing', 'Selligent Marketing Cloud', 'Server Administration', 'Service Delivery Management', 'Service Delivery Management [SAP]', 'Service Design', 'Service Desk Management', 'ServiceNow', 'SET.Java', 'SET.JavaScript', 'SET.NET', 'SET.Python', 'Shopify', 'Site Reliability Engineering', 'Sitecore', 'Social Media Advertising', 'Social Media Marketing', 'Software Development Management', 'Solution Architecture', 'Solution Architecture in Test Automation', 'Solution Practice Operations', 'Sound Design', 'Space Design', 'Staffing', 'Strategic Management', 'Strategy Consulting', 'Supply Chain Management', 'Supply Chain Operations', 'Support Management', 'Support.Business', 'Support.Data', 'Support.Infrastructure', 'Support.Users', 'System Analysis', 'Systems Architecture', 'TaaS Management', 'Talent Acquisition', 'Talent Acquisition Operations', 'Talent Acquisition Research', 'Talent and Learning Tech Enablement', 'Talent Development Partnership', 'Talent Operations', 'Technical Communication Management', 'Technical Writing', 'Technology Consulting', 'Test Data Management', 'Test Management', 'Testing in Mobile', 'Testing of AI-based applications', 'Training and Development', 'Training Delivery', 'Travel Management', 'UIPath', 'Unified Communications and Collaboration', 'Unity Development', 'Unreal Engine', 'Usability & Ergonomic Design', 'User Research', 'UX Design', 'Video Editing', 'Video Engineering', 'Visual Annotation', 'Visual Design', 'Web Analytics', 'Wide Area Networks', 'Wired Local Area Networks', 'Wireless Local Area Networks', 'Workforce Planning and Management', 'Workforce Verification Operations', 'WorkFusion', 'Xamarin'];

  // Canonical, language-independent question text per DynamicForm key. EPAM labels the
  // first/last name pair "Name"/"Surname", which reads much better to a caller/AI pipeline as
  // "First name"/"Last name".
  const FIELD_SPEC = {
    name: { question: "First name", fieldKind: "text" },
    surname: { question: "Last name", fieldKind: "text" },
    email: { question: "Email address", fieldKind: "text" },
    // The NATIONAL part only — the dial code is its own synthetic question, see
    // PHONE_COUNTRY_CODE_SPEC.
    phone: { question: "Phone number", fieldKind: "phone" },
    currentLocation: { question: "Current country of residence", fieldKind: "dropdown-list" },
    // Country-conditional (US, India, … — not Canada or EU countries).
    state: { question: "State or province", fieldKind: "dropdown-list" },
    // Server-filtered by country (and by state, where the form has one): empty until those
    // commit — see waitForCascadePrerequisites.
    city: { question: "Current city", fieldKind: "dropdown-typeahead" },
    // US-only. A creatable react-select, not a plain text box: typing offers the literal ZIP
    // plus a `Use this ZIP Code: "10001"` row, and once a city is chosen it also lists that
    // city's real ZIPs. Depends on `city` committing first.
    zipcode: { question: "ZIP or postal code", fieldKind: "dropdown-typeahead" },
    preferableLocations: { question: "Preferred work countries", fieldKind: "dropdown-multi" },
    // India (and other single-preference regions) replaces the MULTI-select above with this
    // singular country + city pair.
    preferableLocation: { question: "Preferred work country", fieldKind: "dropdown-list" },
    preferableCity: { question: "Preferred work city", fieldKind: "dropdown-typeahead" },
    primarySkill: { question: "Primary skill", fieldKind: "dropdown-typeahead", options: EPAM_PRIMARY_SKILLS },
    relevantExperience: { question: "Years of relevant experience", fieldKind: "number" },
    english: { question: "English level", fieldKind: "dropdown-list" },
    noticePeriod: { question: "Notice period", fieldKind: "dropdown-list" },
    // The DOM key is 'file'; fieldId is deliberately the canonical 'resume' asset key instead
    // (same convention as personio/avature/builtin/dayforcehcm) so a résumé-asset lookup finds
    // it under one consistent id across every ported site.
    file: { fieldId: "resume", question: "Upload your CV in English", fieldKind: "resume" },
    linkedin: { question: "LinkedIn profile URL", fieldKind: "text" },
    // Ukraine vacancies only, and only while the selected country is NOT Ukraine: a REQUIRED
    // "I plan to return to and work from Ukraine" gate. Handled exactly like the privacy
    // acknowledgement below — always ticked when present.
    planToReturn: { question: "Do you plan to return to and work from Ukraine?", fieldKind: "required-checkbox" },
  };

  // Synthetic entry for EPAM's phone widget: ONE wrapper (`apply-phone-field`) holds both the
  // country dial-code picker and the national-number input, but the picker renders with no
  // wrapper of its own — there's no `apply-phoneCountryCode-field` for FIELD_SPEC to key on.
  // This is what surfaces it as a question in its own right, rather than leaving it as an
  // invisible side effect of the number's fill.
  const PHONE_COUNTRY_CODE_SPEC = { fieldId: "phoneCountryCode", question: "Phone country code" };

  // Keys deliberately never surfaced as questions:
  //   vacancyLocation / prefillWithLinkedIn — hidden inputs the page fills itself.
  //   experience                           — the CV-vs-LinkedIn form MODE toggle, not an
  //                                          application question; whichever document field
  //                                          it reveals (file or linkedin) is detected on its
  //                                          own merits instead.
  const IGNORED_KEYS = new Set(["vacancyLocation", "prefillWithLinkedIn", "experience"]);

  // Checkboxes that are NEVER ticked automatically, whatever their required flag says, because
  // they grant DISCRETIONARY permissions rather than gate submission: the regionalised
  // marketing opt-ins (*ConsentMarketingAccepted) and isEUPrivacyConsentAccepted (shown for EU
  // countries — despite the name it is NOT an acknowledgement, it grants EPAM two EXTRA years
  // of data retention; EU forms have no mandatory consent box at all). Listed explicitly
  // rather than relying on the optional flag, so that if EPAM ever marks one required it is
  // still not auto-granted on the user's behalf.
  const NEVER_AUTO_GRANT_RE = /(consentmarketingaccepted|euprivacyconsentaccepted)/i;

  // ---- small text / polling helpers ----------------------------------------

  function cleanText(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function answerToText(answer) {
    if (answer == null || typeof answer === "object") return "";
    return cleanText(answer);
  }
  function normalizeForMatch(value) {
    return cleanText(value).toLowerCase();
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

  // ---- modal / form / live-wrapper lookup ------------------------------------

  function getApplyModal() {
    for (const dialog of document.querySelectorAll("dialog[open]")) {
      if (dialog.querySelector(FORM_SELECTOR)) return dialog;
    }
    return null;
  }
  function getForm() {
    const modal = getApplyModal();
    if (modal) return modal.querySelector(FORM_SELECTOR);
    return document.querySelector(FORM_SELECTOR); // defensive: in case EPAM ever renders outside a dialog
  }
  // "Open, but still only skeleton placeholders" — the controls exist as grey bars with no
  // real inputs yet. Treated as not-ready so a caller re-detects once the config fetch lands.
  function isFormMounted(form) {
    if (!form) return false;
    if (form.querySelector(SKELETON_SELECTOR)) return false;
    return Boolean(form.querySelector("input, textarea, select"));
  }
  function getFieldKey(item) {
    const match = (item?.getAttribute?.("data-testid") ?? "").match(/^apply-(.+)-field$/);
    return match ? match[1] : null;
  }
  function getDomKeyForFieldId(fieldId) {
    if (fieldId === "resume") return "file";
    if (fieldId === "phoneCountryCode") return "phone";
    return fieldId;
  }
  // Re-resolves a question's LIVE wrapper. The modal re-renders nodes across its own async
  // updates (picking a country re-renders the consent block, for instance), so a handle cached
  // from detectFields() can be stale by the time a fill actually runs.
  function getLiveField(fieldId, fallbackField) {
    const domKey = getDomKeyForFieldId(fieldId);
    const live = getForm()?.querySelector(`[data-testid="apply-${domKey}-field"]`);
    if (live) return live;
    return fallbackField?.isConnected ? fallbackField : null;
  }

  // ---- field detection --------------------------------------------------------

  /**
   * Walk EPAM's apply modal and return every question this adapter knows how to fill
   * deterministically. Reports nothing until the modal is mounted past its skeleton state.
   *
   * @returns {Array<{question:string, fieldId:string, field:Element, fieldKind:string,
   *   options:string[]|null, required:boolean}>}
   */
  function detectFields() {
    const form = getForm();
    if (!isFormMounted(form)) return [];

    const entries = [];
    const seen = new Set();
    const add = (entry) => {
      if (!entry.question || !entry.fieldId || !entry.field) return;
      if (seen.has(entry.fieldId)) return;
      seen.add(entry.fieldId);
      entries.push({ options: null, required: false, ...entry });
    };

    // Required is expressed as a Label_asterisk/Checkbox_asterisk span rather than the native
    // attribute on several controls, so both are checked.
    const isRequired = (item, control) => {
      if (control?.required) return true;
      if (item.querySelector('[class*="asterisk" i]')) return true;
      return control?.getAttribute?.("aria-required") === "true";
    };

    // Document order, so the list reads as the questions appear on screen.
    for (const item of form.querySelectorAll(ITEM_SELECTOR)) {
      const key = getFieldKey(item);
      if (!key || IGNORED_KEYS.has(key)) continue;
      if (NEVER_AUTO_GRANT_RE.test(key)) continue; // marketing / EU-retention opt-ins — never auto-granted
      const spec = FIELD_SPEC[key];
      const fieldId = spec?.fieldId ?? key;

      // Every REQUIRED checkbox is ticked so the application can submit — the region-specific
      // privacy acknowledgement (isPrivacyConsentAccepted / isAmericasPrivacyConsent… /
      // isUaPrivacyConsent… / …) and the Ukraine-vacancy planToReturn gate alike. This also
      // catches checkboxes with NO FIELD_SPEC entry at all, falling back to their own visible
      // label: a required control detection skips silently blocks submission with no sign of
      // why, so an unmodelled one is still surfaced rather than dropped.
      const requiredCheckbox = !spec || spec.fieldKind === "required-checkbox" ? item.querySelector('input[type="checkbox"]') : null;
      if (requiredCheckbox) {
        if (!isRequired(item, requiredCheckbox)) continue; // optional checkboxes are never auto-ticked
        add({
          question: spec?.question || cleanText(item.querySelector("label")?.textContent) || key,
          fieldId,
          field: item,
          fieldKind: "required-checkbox",
          required: true,
        });
        continue;
      }
      if (!spec) continue;

      if (spec.fieldKind === "resume") {
        // Keyed on the WRAPPER, not input[type=file]: on success EPAM REMOVES the file input
        // and renders an attached-file chip in its place, which would otherwise make the
        // question vanish the moment a résumé is attached.
        const fileInput = item.querySelector('input[type="file"]');
        add({ question: spec.question, fieldId, field: item, fieldKind: "resume", required: isRequired(item, fileInput) });
        continue;
      }

      // Dropdowns (single-select, multi-select, and the typeahead variants) all share one
      // detection shape: the committed value lives on a hidden input, the visible control is
      // the react-select box, and `options` stays null except where FIELD_SPEC bundles its own
      // list (primarySkill) — every other list only exists while its menu is open, which
      // fetchFieldOptions() below opens on demand.
      if (spec.fieldKind.startsWith("dropdown")) {
        const control = item.querySelector(DROPDOWN_INPUT_SELECTOR);
        if (!control) continue;
        add({ question: spec.question, fieldId, field: item, fieldKind: spec.fieldKind, options: spec.options ?? null, required: isRequired(item, control) });
        continue;
      }

      // The phone wrapper holds two controls, so it emits two questions, dial-code first: a
      // caller filling in detectFields()'s own document order fills the picker before the
      // number — which matters, because choosing a country CLEARS the number input.
      if (spec.fieldKind === "phone") {
        const selectButton = item.querySelector(PHONE_COUNTRY_SELECT_BUTTON_SELECTOR);
        if (selectButton) {
          add({ question: PHONE_COUNTRY_CODE_SPEC.question, fieldId: PHONE_COUNTRY_CODE_SPEC.fieldId, field: item, fieldKind: "phone-country-code", required: isRequired(item, selectButton) });
        }
        const numberInput = item.querySelector('#phone, input[name="phone"]');
        if (numberInput) {
          add({ question: spec.question, fieldId, field: item, fieldKind: "phone", required: isRequired(item, numberInput) });
        }
        continue;
      }

      // Plain inputs: #name, #surname, #email, #relevantExperience, #linkedin.
      const control = item.querySelector('input:not([type="hidden"]), textarea');
      if (!control) continue;
      add({ question: spec.question, fieldId, field: item, fieldKind: spec.fieldKind, required: isRequired(item, control) });
    }
    return entries;
  }

  // ---- submit detection + advance --------------------------------------------

  // Strictly the modal's own final submit — the vacancy page's "Apply" button is a reveal
  // control and must never come back here.
  function getSubmitButton() {
    return getForm()?.querySelector('button[type="submit"], input[type="submit"]') ?? null;
  }

  // The vacancy page's "Apply" button (ApplyButton_button__*), which opens the modal. Returns
  // null once the modal is open, so re-entry is a no-op.
  function getAdvanceButton() {
    if (getApplyModal()) return null;
    const byClass = Array.from(document.querySelectorAll('button[class*="ApplyButton_button"], button[class*="ApplyButton"]')).find((b) => !b.disabled);
    if (byClass) return byClass;
    // Fallback: a standalone button labelled exactly "Apply", anchored to buttons outside the
    // form so a "Find me a job" / footer navigation link is never picked instead.
    return (
      Array.from(document.querySelectorAll("button")).find((b) => {
        if (b.disabled || b.type === "submit" || b.closest(FORM_SELECTOR)) return false;
        return /^apply$/i.test(cleanText(b.textContent));
      }) ?? null
    );
  }

  // EPAM reveals the application form in a MODAL on the SAME url (no navigation to wait on):
  // click to open it, then let the reveal settle before returning. The modal mounts behind
  // skeleton placeholders after its own config fetch — which isFormMounted() already treats as
  // not-ready — so this always returns false and leaves the next detectFields() pass to find
  // the freshly-mounted form, rather than being treated as a mid-form "Next".
  async function advance({ shouldAbort = () => false } = {}) {
    if (getSubmitButton()) return false; // modal already mounted — nothing left to advance to
    const advanceButton = getAdvanceButton();
    if (!advanceButton || shouldAbort()) return false;
    await clickLikeHuman(advanceButton, { shouldAbort });
    await waitFor(() => getApplyModal(), APPLY_MODAL_WAIT_MS, 100, shouldAbort);
    return false;
  }

  function isAutofillAvailable() {
    return Boolean(detectFields().length || getSubmitButton() || getAdvanceButton());
  }

  // ---- react-select dropdown mechanics ----------------------------------------

  // The react-select instance id ("react-select-6") backing a wrapper — the ONLY thing an
  // option menu can be matched back to it by.
  function getDropdownInstance(item) {
    const id = item?.querySelector(DROPDOWN_INPUT_SELECTOR)?.id ?? "";
    return id ? id.replace(/-input$/, "") : null;
  }
  // A `dummyInput`-classed react-select has no text entry: it can only be opened and clicked,
  // never typed into.
  function isSearchableDropdown(item) {
    const input = item?.querySelector(DROPDOWN_INPUT_SELECTOR);
    return Boolean(input) && !/dummyInput/i.test(String(input.className || ""));
  }
  function readDropdownOptionNodes(instance) {
    return instance ? Array.from(document.querySelectorAll(`[id^="${instance}-option"]`)) : [];
  }
  function optionLabels(nodes) {
    return nodes.map((node) => cleanText(node.innerText || node.textContent));
  }
  // Is this option row ALREADY the committed selection? EPAM's multi-selects render with
  // `hideSelectedOptions={false}` — a chosen row stays in the menu wearing both EPAM's own
  // `MultiOption_selected` class and react-select's `option--is-selected`, and clicking it
  // AGAIN toggles it off. Matched by class, not `aria-selected` (EPAM leaves that unset).
  function isOptionSelected(node) {
    return Boolean(node?.matches?.('[class*="MultiOption_selected"], [class*="option--is-selected"]'));
  }
  // The node that actually carries react-select's mousedown handler. EPAM wraps react-select in
  // its own `Dropdown_controlBox` div, an ANCESTOR of react-select's own `dropdown__control` —
  // a dispatched event travels UP from its target and never reaches the inner control's
  // handler from the outer box, so the inner node is queried for FIRST.
  function getDropdownControl(item) {
    return item?.querySelector('[class*="dropdown__control"]') || item?.querySelector('[class*="Dropdown_controlBox"]') || item || null;
  }
  // react-select toggles its menu on mousedown, not click — clickLikeHuman's full pointer
  // sequence includes a real mousedown, so it opens the menu the same way a user's click would.
  async function openDropdown(item, { shouldAbort = () => false } = {}) {
    const control = getDropdownControl(item);
    if (!control) return;
    await clickLikeHuman(control, { shouldAbort });
  }
  // Closed by blurring the widget's own input — see the file header's note on why this is
  // never Escape.
  function closeDropdown(item) {
    item?.querySelector(DROPDOWN_INPUT_SELECTOR)?.blur();
  }
  function waitForDropdownOptions(instance, shouldAbort = () => false, timeoutMs = DROPDOWN_WAIT_TIMEOUT_MS) {
    if (!instance) return Promise.resolve(null);
    return waitFor(() => {
      const nodes = readDropdownOptionNodes(instance);
      return nodes.length > 0 ? nodes : null;
    }, timeoutMs, 120, shouldAbort);
  }
  // Resolves a wanted value against live option labels: exact, then prefix/containment.
  // Deliberately NOT the embedding/AI fuzzy match BidHub's own pickOptionIndex() falls back to
  // for anything looser — see the file header's scope note. Returns -1 on no match.
  function pickOptionIndex(wanted, labels) {
    const want = normalizeForMatch(wanted);
    if (!want) return -1;
    let index = labels.findIndex((label) => normalizeForMatch(label) === want);
    if (index >= 0) return index;
    index = labels.findIndex((label) => {
      const normalized = normalizeForMatch(label);
      return normalized.startsWith(want) || want.startsWith(normalized);
    });
    if (index >= 0) return index;
    return labels.findIndex((label) => normalizeForMatch(label).includes(want));
  }

  // Opens a closed-LIST dropdown (dropdown-list / dropdown-multi), picks the matching option,
  // and closes it again. Tries matching against whatever the menu shows on open first; only
  // types into the input to filter if that didn't resolve a match (a short list like "English
  // level" usually renders its full set without typing at all; a long one like "current
  // country of residence" needs the filter).
  async function fillDropdownOption(item, value, { shouldAbort = () => false } = {}) {
    const instance = getDropdownInstance(item);
    if (!instance) return;
    await openDropdown(item, { shouldAbort });
    let nodes = await waitForDropdownOptions(instance, shouldAbort);
    if (nodes && isSearchableDropdown(item) && pickOptionIndex(value, optionLabels(nodes)) < 0) {
      const input = item.querySelector(DROPDOWN_INPUT_SELECTOR);
      if (input) {
        fillTextInputWithoutBlur(input, cleanText(value)); // typing (not blurring) drives the async filter
        const filtered = await waitForDropdownOptions(instance, shouldAbort);
        if (filtered) nodes = filtered;
      }
    }
    if (!nodes || shouldAbort()) {
      closeDropdown(item);
      return;
    }
    const index = pickOptionIndex(value, optionLabels(nodes));
    // Clicking a row that's ALREADY selected is not a no-op here — on a multi-select it
    // deselects (see isOptionSelected), which would make a repeat fill of the same answer wipe
    // it. The check is on the RESOLVED NODE rather than a label comparison, because the two
    // routinely differ (the caller may say "United States", resolved via containment to the
    // row labelled "United States of America") — only the node itself knows it's the same option.
    if (index >= 0 && !isOptionSelected(nodes[index])) nodes[index].click();
    closeDropdown(item);
    await sleep(200);
  }

  // Types a term into a typeahead (city/zipcode/preferableCity/primarySkill), waits for the
  // async suggestion list, and clicks the best match. Retries on just the first comma-split
  // token because these lists match a leading fragment ("Tbilisi" hits where "Tbilisi, Georgia"
  // does not) — reusing the engine's own fallback-term mechanism for that retry.
  async function fillTypeaheadField(item, value, { shouldAbort = () => false } = {}) {
    const instance = getDropdownInstance(item);
    const input = item?.querySelector(DROPDOWN_INPUT_SELECTOR);
    if (!instance || !input) return;
    const text = cleanText(value);
    if (!text) return;
    const firstToken = text.split(/[,/]+/)[0]?.trim();
    const fallback = firstToken && normalizeForMatch(firstToken) !== normalizeForMatch(text) ? firstToken : null;
    await fillComboboxByTyping(input, text, {
      menuSelector: `[id^="${instance}-option"]`,
      fallback,
      timeoutMs: DROPDOWN_WAIT_TIMEOUT_MS,
      shouldAbort,
    });
    closeDropdown(item); // the menu usually self-closes on a pick; this only matters if it didn't
    await sleep(250);
  }

  // ---- location cascade ---------------------------------------------------------
  // The location dropdowns form a server-filtered CASCADE: country → state → city → ZIP (and
  // preferred country → preferred city). Each level's option list is empty until the level
  // above it has a COMMITTED value — a fill that runs too early silently produces nothing. The
  // prerequisite is checked against the live hidden input that carries the committed value
  // (timing-independent), not against detection-time scheduling.

  function getCommittedValue(name) {
    const input = getForm()?.querySelector(`input[type="hidden"][name="${name}"]`);
    return cleanText(input?.value);
  }
  // Resolves once `name`'s hidden input holds a value. Best-effort: on timeout the fill still
  // proceeds, since attempting it beats skipping the field outright.
  async function waitForCommittedValue(name, shouldAbort = () => false) {
    if (getCommittedValue(name)) return true;
    return Boolean(await waitFor(() => (getCommittedValue(name) ? true : null), CASCADE_WAIT_TIMEOUT_MS, 150, shouldAbort));
  }
  async function waitForCascadePrerequisites(fieldId, shouldAbort = () => false) {
    if (fieldId === "city") {
      await waitForCommittedValue("currentLocation", shouldAbort);
      await sleep(CASCADE_SETTLE_MS);
      if (getForm()?.querySelector('[data-testid="apply-state-field"]')) await waitForCommittedValue("state", shouldAbort);
      return;
    }
    if (fieldId === "zipcode") {
      await waitForCommittedValue("city", shouldAbort);
      return;
    }
    if (fieldId === "preferableCity") {
      await waitForCommittedValue("preferableLocation", shouldAbort);
    }
  }

  // ---- phone country-code picker --------------------------------------------------
  // EPAM splits the phone into a country dial code (its own button + searchable 211-row list)
  // and a national-number input. The picker's rows are queried from `document`, not the field
  // wrapper — only the row BUTTON carries react's handler.

  function readPhoneCountryRows() {
    return Array.from(document.querySelectorAll(PHONE_COUNTRY_BUTTON_SELECTOR))
      .map((row) => {
        const name = cleanText(row.querySelector(PHONE_COUNTRY_NAME_SELECTOR)?.textContent);
        const fallbackMatch = cleanText(row.textContent).match(/\+(\d+)\s*$/);
        const code = cleanText(row.querySelector(PHONE_COUNTRY_CODE_SELECTOR)?.textContent) || (fallbackMatch ? `+${fallbackMatch[1]}` : "");
        const digits = code.replace(/\D/g, "");
        // Both halves in one label, so a caller's answer can match on either the country name
        // or the dial code.
        return { row, name, digits, label: name && code ? `${name} (${code})` : name || code };
      })
      .filter((entry) => entry.label);
  }
  function isPhoneCountryPickerOpen() {
    return readPhoneCountryRows().length > 0;
  }
  // Closed by re-clicking its own toggle button — never Escape (same modal-dismiss hazard as
  // the react-select dropdowns).
  async function openPhoneCountryPicker(item, { shouldAbort = () => false } = {}) {
    const selectButton = item?.querySelector(PHONE_COUNTRY_SELECT_BUTTON_SELECTOR);
    if (!selectButton) return null;
    if (!isPhoneCountryPickerOpen()) await clickLikeHuman(selectButton, { shouldAbort }); // the button TOGGLES — re-clicking an open picker would shut it
    return waitFor(() => {
      const rows = readPhoneCountryRows();
      return rows.length > 0 ? rows : null;
    }, DROPDOWN_WAIT_TIMEOUT_MS, 120, shouldAbort);
  }
  function closePhoneCountryPicker(item) {
    if (!isPhoneCountryPickerOpen()) return;
    item?.querySelector(PHONE_COUNTRY_SELECT_BUTTON_SELECTOR)?.click();
  }
  // The dial code currently committed, as bare digits ("995"). Read from the "+995" next to
  // the input, falling back to the select button's `title="Georgia +995"`.
  function getSelectedPhoneDialCode(item) {
    const fromDialCode = cleanText(item?.querySelector(PHONE_DIAL_CODE_SELECTOR)?.textContent);
    const fromTitle = cleanText(item?.querySelector(PHONE_COUNTRY_SELECT_BUTTON_SELECTOR)?.getAttribute("title"));
    return (fromDialCode.match(/\+(\d+)/) || fromTitle.match(/\+(\d+)/) || [])[1] ?? null;
  }
  // Picks the row whose dial code is the LONGEST one prefixing `digits`, so +1268 (Antigua)
  // wins over +1 (United States) for a number starting 1268…
  function findPhoneCountryRowByDigits(rows, digits) {
    let best = null;
    for (const entry of rows) {
      if (!entry.digits || !digits.startsWith(entry.digits)) continue;
      if (!best || entry.digits.length > best.digits.length) best = entry;
    }
    return best;
  }
  // Commits a country from the dial-code question's own answer — accepts a full option label
  // ("Georgia (+995)"), a bare code ("+995"/"995"), or just the country name.
  async function fillPhoneCountryCode(item, value, { shouldAbort = () => false } = {}) {
    const wanted = cleanText(value);
    if (!wanted) return;
    const rows = await openPhoneCountryPicker(item, { shouldAbort });
    if (!rows || shouldAbort()) {
      closePhoneCountryPicker(item);
      return;
    }
    let match = rows.find((r) => normalizeForMatch(r.label) === normalizeForMatch(wanted)) || rows.find((r) => normalizeForMatch(r.name) === normalizeForMatch(wanted));
    if (!match) {
      // A code-only answer ("+995"): match the digits exactly — a containment match would let
      // "+99" land on Georgia.
      const codeOnly = wanted.match(/^\+?\s*(\d{1,4})$/);
      if (codeOnly) match = rows.find((r) => r.digits === codeOnly[1]);
    }
    if (!match) {
      const index = pickOptionIndex(wanted, rows.map((r) => r.label));
      if (index >= 0) match = rows[index];
    }
    if (!match || shouldAbort()) {
      closePhoneCountryPicker(item);
      return;
    }
    match.row.click();
    closePhoneCountryPicker(item); // self-closes on a successful pick; this only matters if it didn't
    await sleep(350);
  }
  // Writes the national number. The dial code is the OTHER question's job — this only touches
  // the picker as a self-heal, when the answer carries an international prefix the committed
  // dial code doesn't already account for (dial-code question skipped/unanswered/different
  // country), rather than silently producing a wrong number.
  async function fillPhone(item, value, { shouldAbort = () => false } = {}) {
    const input = item?.querySelector('#phone, input[name="phone"]');
    if (!input) return;
    const raw = cleanText(value);
    const international = raw.match(/^\+\s*(\d[\d\s\-()]*)$/);
    if (!international) {
      // No country prefix in the answer — write the digits and leave the page's own default
      // dial code untouched.
      fillTextInput(input, raw.replace(/[^\d\s\-()]/g, "").trim());
      return;
    }
    const digits = international[1].replace(/\D/g, "");
    const selectedCode = getSelectedPhoneDialCode(item);
    if (selectedCode && digits.startsWith(selectedCode)) {
      // Already on the right country — write the remainder and leave the picker alone.
      fillTextInput(input, digits.slice(selectedCode.length));
      return;
    }
    const selectButton = item.querySelector(PHONE_COUNTRY_SELECT_BUTTON_SELECTOR);
    if (selectButton && digits) {
      const rows = await openPhoneCountryPicker(item, { shouldAbort });
      const best = rows ? findPhoneCountryRowByDigits(rows, digits) : null;
      if (best) {
        best.row.click();
        closePhoneCountryPicker(item);
        await sleep(350);
        // Selecting a country CLEARS the number input — the national part must be written
        // AFTER the switch, never before it.
        fillTextInput(input, digits.slice(best.digits.length));
        return;
      }
      closePhoneCountryPicker(item);
      await sleep(150);
    }
    fillTextInput(input, digits);
  }

  // ---- résumé upload ---------------------------------------------------------
  // Hands back a writable <input type="file">, detaching an already-attached CV first. On
  // success EPAM REMOVES the input from the DOM and renders an attached-file chip ("cv.pdf
  // 0.04 Mb") with its own (X) in its place — so a CV already attached (most often because the
  // applicant uploaded one by hand before autofill ran) leaves nothing to write to until that
  // (X) is clicked. Returns null when there's neither an input nor a chip.
  async function ensureResumeFileInput(fieldId, fallbackField, { shouldAbort = () => false } = {}) {
    const item = getLiveField(fieldId, fallbackField);
    const existing = item ? getFileInputInsideField(item) : null;
    if (existing) return existing;
    const removeButton = item?.querySelector(RESUME_REMOVE_BUTTON_SELECTOR);
    if (!removeButton) return null;
    removeButton.click();
    return waitFor(() => {
      // React swaps the whole preview <section> for a fresh FileUpload — re-resolve the
      // wrapper on every tick instead of reusing the pre-click handle.
      const refreshed = getLiveField(fieldId, fallbackField);
      return refreshed ? getFileInputInsideField(refreshed) : null;
    }, RESUME_INPUT_REAPPEAR_TIMEOUT_MS, 100, shouldAbort);
  }

  // ---- filling ------------------------------------------------------------------

  /**
   * Write an already-resolved answer into a question returned by detectFields(), dispatched by
   * its fieldKind. Every branch re-resolves the LIVE wrapper via getLiveField() first — see the
   * file header's note on why a cached Element handle isn't trusted here.
   *
   * @param {{fieldId:string, field:Element, fieldKind:string}} entry
   * @param {*} answer - string for text/number/phone/phone-country-code/dropdown-list/
   *   dropdown-typeahead; string|string[] for dropdown-multi; {type:"file", fileName, base64,
   *   mimeType} for resume. Ignored entirely for required-checkbox (see below).
   */
  async function fillField(entry, answer, { shouldAbort = () => false } = {}) {
    if (!entry || shouldAbort()) return;
    const { fieldId, fieldKind } = entry;

    if (fieldKind === "required-checkbox") {
      // Always ticked when present — detection only ever emits a checkbox that's REQUIRED
      // (NEVER_AUTO_GRANT_RE already excludes the discretionary ones), so the wanted end state
      // is always "checked" regardless of whatever `answer` the caller passes.
      const item = getLiveField(fieldId, entry.field);
      const checkbox = item?.querySelector('input[type="checkbox"]');
      // The control is visually hidden (opacity 0, 0×0): clickLikeHuman's simulated pointer
      // would hit whatever IS visually at that screen position instead of this element, so
      // this is a plain .click() — verified to still flip the box and notify React.
      if (checkbox && !checkbox.checked) checkbox.click();
      return;
    }

    if (answer == null) return;

    switch (fieldKind) {
      case "text": {
        const value = answerToText(answer);
        if (!value) return;
        const item = getLiveField(fieldId, entry.field);
        const input = item?.querySelector('input:not([type="hidden"]), textarea');
        if (input) fillTextInput(input, value);
        return;
      }
      case "number": {
        // relevantExperience is <input type="number">: a "5 years" style answer would be
        // rejected wholesale, so only the leading numeric value is kept.
        const value = answerToText(answer);
        if (!value) return;
        const item = getLiveField(fieldId, entry.field);
        const input = item?.querySelector('input[type="number"], input:not([type="hidden"])');
        const numeric = value.match(/\d+(?:[.,]\d+)?/)?.[0];
        if (input && numeric) fillTextInput(input, numeric.replace(",", "."));
        return;
      }
      case "phone-country-code": {
        const value = answerToText(answer);
        if (!value) return;
        const item = getLiveField(fieldId, entry.field);
        if (item) await fillPhoneCountryCode(item, value, { shouldAbort });
        return;
      }
      case "phone": {
        const value = answerToText(answer);
        if (!value) return;
        const item = getLiveField(fieldId, entry.field);
        if (item) await fillPhone(item, value, { shouldAbort });
        return;
      }
      case "dropdown-list": {
        const value = answerToText(answer);
        if (!value) return;
        const item = getLiveField(fieldId, entry.field);
        if (item) await fillDropdownOption(item, value, { shouldAbort });
        return;
      }
      case "dropdown-multi": {
        const wanted = (Array.isArray(answer) ? answer : [answer]).map(answerToText).filter(Boolean);
        if (!wanted.length) return;
        const item = getLiveField(fieldId, entry.field);
        if (!item) return;
        // Each value gets its own open/pick cycle — closeDropdown() after every pick is what
        // keeps the next openDropdown() from TOGGLING an already-open menu shut.
        for (const value of wanted) {
          if (shouldAbort() || !item.isConnected) return;
          await fillDropdownOption(item, value, { shouldAbort });
        }
        return;
      }
      case "dropdown-typeahead": {
        const value = answerToText(answer);
        if (!value) return;
        await waitForCascadePrerequisites(fieldId, shouldAbort);
        if (shouldAbort()) return;
        const item = getLiveField(fieldId, entry.field);
        if (item) await fillTypeaheadField(item, value, { shouldAbort });
        return;
      }
      case "resume": {
        if (typeof answer !== "object" || answer.type !== "file") return;
        const fileInput = await ensureResumeFileInput(fieldId, entry.field, { shouldAbort });
        if (!fileInput || shouldAbort()) return;
        fillFileInput(fileInput, answer.fileName, answer.base64, answer.mimeType);
        await sleep(300); // EPAM validates and previews the upload asynchronously
        return;
      }
      default:
        return;
    }
  }

  // The option list a dropdown/the phone picker currently offers (opens it, reads it, closes
  // it again) — for a caller that needs the choices before picking one, same purpose as
  // BambooHR's exported fetchSelectOptions(). Returns the bundled vocabulary for primarySkill
  // and null for the other typeahead fields (city/zipcode/preferableCity), whose lists cannot
  // be harvested without a committed parent value and a typed term.
  async function fetchFieldOptions(entry, { shouldAbort = () => false } = {}) {
    if (!entry) return null;
    const { fieldId, fieldKind, field, options } = entry;
    if (fieldKind === "dropdown-list" || fieldKind === "dropdown-multi") {
      const item = getLiveField(fieldId, field);
      if (!item) return null;
      const instance = getDropdownInstance(item);
      if (!instance) return null;
      await openDropdown(item, { shouldAbort });
      const nodes = await waitForDropdownOptions(instance, shouldAbort);
      const labels = nodes ? optionLabels(nodes).filter(Boolean) : [];
      closeDropdown(item);
      return labels.length > 0 ? labels : null;
    }
    if (fieldKind === "phone-country-code") {
      const item = getLiveField(fieldId, field);
      if (!item) return null;
      const rows = await openPhoneCountryPicker(item, { shouldAbort });
      const labels = rows ? rows.map((r) => r.label).filter(Boolean) : [];
      closePhoneCountryPicker(item);
      await sleep(150);
      return labels.length > 0 ? labels : null;
    }
    return options ?? null;
  }

  NS.epam = {
    isAutofillAvailable,
    detectFields,
    fillField,
    fetchFieldOptions,
    getSubmitButton,
    advance,
  };
})();
