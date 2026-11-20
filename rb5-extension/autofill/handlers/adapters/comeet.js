/* =====================================================================
 * handlers/adapters/comeet.js — Comeet ("Spark Hire Recruit") careers.
 * =====================================================================
 * The application form itself is a plain `label[for]`-driven Angular
 * form — no stable id convention for name/email/phone, so the generic
 * detectContact() heuristic (which runs after any adapter's own
 * detect() — see pipeline/basic.js) already handles those fine on its
 * own.
 *
 * What it DOES need help with: Comeet's own markup hardcodes literal
 * ids `#cv` and `#coverLetter` on the two upload inputs, the same way
 * across every tenant (it's one hosted platform, not a per-posting
 * custom form). A generic "first/only `input[type=file]` on the page"
 * fallback can grab the wrong one when a posting also has a separate
 * portfolio upload, so address the resume/cover-letter inputs by their
 * real ids directly instead. Note the form itself commonly lives in a
 * cross-origin `www.comeet.co` iframe embedded in the `www.comeet.com`
 * posting page — this adapter runs in whichever frame has the form. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;

  ns.pipeline.registry.registerAdapter({
    name: "Comeet",
    hostTest: (h) =>
      /comeet\.(co|com)$/i.test(h) ||
      (typeof document !== "undefined" && !!document.querySelector("form#applyForm")),
    detect() {
      const doc = document;
      const m = {};
      const resume = doc.querySelector("#cv");
      if (resume) m.__resumeFile = resume;
      const coverLetter = doc.querySelector("#coverLetter");
      if (coverLetter) m.__coverLetterFile = coverLetter;
      return m;
    },
  });
})();
