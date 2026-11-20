/* =====================================================================
 * handlers/adapters/freshteam.js — Freshteam (Freshworks) careers.
 * =====================================================================
 * Freshteam's application form (`form[name="applicant_form"]`) has no
 * stable id/name convention for name/email/phone — those are plain
 * `label` + `input` pairs the generic detectContact() heuristic (which
 * runs after any adapter's own detect() — see pipeline/basic.js)
 * already handles fine.
 *
 * The one real convention: Freshteam hardcodes literal ids
 * `#uploadFile` (resume) and `#uploadCoverLetter` (cover letter) on
 * its two upload inputs — the same across every tenant. Freshteam's
 * own in-house parser treats a plain "resume"/"cover letter" text
 * match as the primary signal and these ids only as a fallback; here
 * it's flipped around to a direct id lookup, since that's simpler and
 * just as reliable, and it avoids a generic "any file input" fallback
 * grabbing an unrelated attachment slot on forms that have one. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;

  ns.pipeline.registry.registerAdapter({
    name: "Freshteam",
    hostTest: (h) =>
      /freshteam\.com$/i.test(h) ||
      (typeof document !== "undefined" && !!document.querySelector('form[name="applicant_form"]')),
    detect() {
      const doc = document;
      const m = {};
      const resume = doc.getElementById("uploadFile");
      if (resume) m.__resumeFile = resume;
      const coverLetter = doc.getElementById("uploadCoverLetter");
      if (coverLetter) m.__coverLetterFile = coverLetter;
      return m;
    },
  });
})();
