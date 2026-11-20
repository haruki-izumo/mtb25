/* =====================================================================
 * handlers/adapters/greenhouse.js
 * =====================================================================
 * Self-registers with the registry. Both Greenhouse templates (classic
 * boards.greenhouse.io AND modern job-boards.greenhouse.io) use the SAME
 * literal #first_name/#last_name/#email/#phone/#resume ids — confirmed
 * directly against a live modern-template posting's server-rendered HTML
 * (previous comment here claiming the modern template uses "generated
 * ids" was wrong and never actually true).
 *
 * This adapter only needs to grab what the GENERIC contact detector
 * (detectors/contact.js, run automatically after this one — see
 * pipeline/basic.js's stepContact) can't be trusted to get exactly right
 * on its own: the resume/cover-letter file inputs (ambiguous without a
 * confident id/name match — see the cover/resume selection below). Plain
 * contact fields like First Name / Last Name / Email / Preferred First
 * Name don't need a dedicated grab() here just because they exist on
 * Greenhouse specifically — detectContact() already finds ANY field with
 * a real <label for="..."> (or aria-label/autocomplete/name match)
 * against its own pattern table, with no per-ATS code at all. Confirmed:
 * Greenhouse's "Preferred First Name" field is found this way with zero
 * Greenhouse-specific code — grab()'ing it here too would just be
 * duplicate, redundant work, not a required fix. The lesson from getting
 * this wrong once already: before adding a hardcoded grab() for a field
 * that broke on some page, check whether detectContact() already covers
 * it with the existing FIELD_RULES pattern table (autofill/detectors/
 * contact.js) — a missing field is usually a detection-TIMING problem
 * (see reviewSnapshot's retry loop in autofill.js) or a genuinely new
 * FIELD_RULES pattern, not something to special-case per adapter. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible, fieldSignals } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "Greenhouse",
    hostTest: (h) => /\.greenhouse\.io$/i.test(h) || /\.boards\.greenhouse\.io$/i.test(h),
    detect() {
      const m = {};
      const doc = document;
      const grab = (sel, key) => {
        const el = doc.querySelector(sel);
        if (el && isVisible(el)) m[key] = el;
      };
      grab("#first_name", "first_name");
      grab("#last_name",  "last_name");
      grab("#email",      "email");
      grab("#phone",      "phone");
      doc.querySelectorAll("input[type=text], input[type=url], input[type=tel]").forEach((el) => {
        if (!isVisible(el)) return;
        const sigs = fieldSignals(el).join(" ").toLowerCase();
        if (/linkedin/.test(sigs) && !m.linkedin) m.linkedin = el;
        if (/github/.test(sigs) && !m.github)     m.github   = el;
        if (/website|portfolio/.test(sigs) && !m.github) m.github = el;
      });
      // Resume / cover letter file inputs — both Greenhouse templates.
      // Detect the COVER input FIRST so the resume "first file input"
      // fallback can exclude it. On job-boards.greenhouse.io the resume
      // input has a generated id/name, so the blind fallback grabbed the
      // FIRST file input — which was the Cover Letter's — and the CV was
      // attached to the cover slot instead of the resume.
      const cover = doc.querySelector('input[type=file]#cover_letter')
        || doc.querySelector('input[type=file][id*=cover i]')
        || doc.querySelector('input[type=file][name*=cover i]')
        || doc.querySelector('input[type=file][name*=motivation i]');
      // ONLY confident id/name matches — NOT a blind "first file input"
      // fallback. On job-boards.greenhouse.io the resume input has a
      // generated id, so the old fallback grabbed the first file input
      // (the Cover Letter's) and the CV was attached to the cover slot.
      // When neither input is id/name-identifiable, leave it to the
      // generic classifier, which resolves resume vs cover by SECTION
      // HEADING ("Resume/CV" vs "Cover Letter") regardless of DOM order.
      const resume = doc.querySelector('input[type=file]#resume')
        || doc.querySelector('input[type=file][name*=resume i]')
        || doc.querySelector('input[type=file][name*=cv i]:not([name*=cover i])')
        || null;
      if (resume) m.__resumeFile = resume;
      if (cover && cover !== resume) m.__coverLetterFile = cover;
      return m;
    },
  });
})();
