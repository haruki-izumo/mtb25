/* =====================================================================
 * handlers/adapters/kula.js — Kula ATS (careers.kula.ai).
 * =====================================================================
 * Kula's application form (Formik + Chakra UI) names its native
 * contact controls with the dotted Formik path as BOTH their `id` and
 * `name` ("info.first_name", "info.email", …) — a convention the
 * generic label-matching heuristic can miss, partly because a dotted
 * id is only safely selectable via an attribute selector (`#info.foo`
 * is invalid CSS), and partly because the visible phone control is a
 * plain `#phone` tel input sitting next to a HIDDEN
 * `input[name$="-phone-e164"]` that's the value the form actually
 * submits — the generic heuristic has no reason to prefer the visible
 * one. Resume / cover letter are react-dropzone inputs with their own
 * plain, stable ids (`#resume`, `#cover_letter`). */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "Kula",
    hostTest: (h) =>
      /careers\.kula\.ai$/i.test(h) ||
      (typeof document !== "undefined" && !!document.querySelector('[data-testid="job-form"]')),
    detect() {
      const doc = document;
      const m = {};
      const grab = (sel, key) => {
        const el = doc.querySelector(sel);
        if (el && isVisible(el)) m[key] = el;
      };
      grab('[name="info.email"]', "email");
      grab('[name="info.first_name"]', "first_name");
      grab('[name="info.last_name"]', "last_name");
      grab('[name="info.linkedin_url"]', "linkedin");
      // The visible phone input is a plain #phone tel field — the hidden
      // e164 sibling the form actually submits is a fill-time concern,
      // not a detection one; the generic filler just needs this element.
      grab("#phone", "phone");
      const resume = doc.querySelector("input[type=file]#resume") || doc.querySelector("input[type=file]");
      if (resume) m.__resumeFile = resume;
      const coverLetter = doc.querySelector("input[type=file]#cover_letter");
      if (coverLetter) m.__coverLetterFile = coverLetter;
      return m;
    },
  });
})();
