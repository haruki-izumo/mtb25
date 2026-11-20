/* =====================================================================
 * handlers/adapters/workday.js — Workday (multi-tenant).
 * =====================================================================
 * Tenants vary (foo.myworkdayjobs.com, foo.wd5.myworkdayjobs.com,
 * careers.foo.com proxying Workday). The shared signal is the
 * `data-automation-id` attribute — we match on hostname OR on any
 * Workday-shaped attribute present in the DOM.
 *
 * NOTE: Workday's own multi-step wizard also has a dedicated Education
 * page (School/Degree/Field of Study, a repeatable Workday-specific
 * multi-select widget) that nothing here or in the generic pipeline
 * fills yet — the fill pipeline only ever resolves CONTACT fields
 * (core/values.js's valuesFromProfile), it has no notion of education
 * data at all. Surfacing education-field elements from detect() here
 * without the pipeline also learning to resolve profile.education
 * values for them would just be a detected-but-never-filled dead end —
 * left for a follow-up that touches pipeline/basic.js too, not bundled
 * into this pass. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "Workday",
    hostTest: (h) =>
      /myworkdayjobs\.com$/i.test(h) ||
      /workday\./i.test(h) ||
      (typeof document !== "undefined" && !!document.querySelector("[data-automation-id]")),
    detect() {
      const m = {};
      const doc = document;
      const grab = (sel, key) => {
        const el = doc.querySelector(sel);
        if (el && isVisible(el)) m[key] = el;
      };
      grab('[data-automation-id="email"]',                            'email');
      grab('input[data-automation-id="phone-number"]',                'phone');
      grab('input[data-automation-id="legalNameSection_firstName"]',  'first_name');
      grab('input[data-automation-id="legalNameSection_lastName"]',   'last_name');
      grab('input[data-automation-id="addressSection_city"]',         'location');
      grab('input[data-automation-id="linkedinUrl"]',                 'linkedin');
      grab('input[data-automation-id="websiteUrl"]',                  'github');
      // Some tenants use preferredName instead of legalName.
      if (!m.first_name) grab('input[data-automation-id="preferredNameSection_firstName"]', 'first_name');
      if (!m.last_name)  grab('input[data-automation-id="preferredNameSection_lastName"]',  'last_name');
      // Workday's resume step shows a "Remove file" button once
      // something's already attached, instead of a plain re-uploadable
      // input — attaching a new file over a stale one otherwise left
      // the OLD resume in place. Clearing it first (synchronously,
      // right here — detect() isn't awaited by its callers, see
      // autofill.js/pipeline/basic.js) is a no-op when nothing's
      // attached yet, and clears the way for the generic attach step
      // that runs right after detect() resolves this function's return.
      const removeBtn =
        doc.querySelector('[data-automation-id="file-upload-item"] button[aria-label*="remove" i]') ||
        doc.querySelector('button[data-automation-id="delete-file"]');
      if (removeBtn && isVisible(removeBtn)) removeBtn.click();
      const resume =
        doc.querySelector('input[type=file][data-automation-id="file-upload-input-ref"]') ||
        doc.querySelector('input[type=file][accept*="pdf" i]') ||
        doc.querySelector('input[type=file]');
      if (resume) m.__resumeFile = resume;
      return m;
    },
  });
})();
