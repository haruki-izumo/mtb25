/* =====================================================================
 * handlers/adapters/applytojob.js — ApplyToJob / Resumator
 *   (<company>.applytojob.com).
 * =====================================================================
 * Contact fields here are plain labeled inputs (modern theme:
 * `.form-group` rows under `.job-form-fields`; legacy theme:
 * `.resumator-field-wrapper` rows) — the generic detectContact()
 * heuristic (which runs after any adapter's own detect() — see
 * pipeline/basic.js) already handles those fine on its own, same
 * reasoning as iCIMS's own adapter.
 *
 * What it DOES need help with: Resumator lets the applicant pick
 * between an "Upload" and a "Type/Paste" method for both the Resume
 * and the Cover Letter, and renders only the chosen method's widget —
 * the real `input[type=file]` is hidden (its wrapper carries a `.none`
 * class) until the "Upload"/"switch to upload" toggle link is clicked.
 * Click every one of those toggles up front so both file inputs are
 * actually present for the generic file-filler to find afterward, then
 * return — there's nothing ApplyToJob-specific left to resolve itself,
 * same division of labor as iCIMS's "expand, then let the generic pass
 * do the matching" adapter. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "ApplyToJob",
    hostTest: (h) =>
      /applytojob\.com$/i.test(h) ||
      (typeof document !== "undefined" &&
        (!!document.querySelector("#form_submit_new_resume") ||
          !!document.querySelector("#resumator-submit-resume"))),
    detect() {
      const doc = document;
      doc
        .querySelectorAll(
          '#resumator-choose-upload, #resumator-resume-switch-upload, a[id*="choose-upload"], a[id*="switch-upload"]'
        )
        .forEach((el) => {
          if (isVisible(el)) el.click();
        });
      const m = {};
      const resume =
        doc.querySelector('input[type=file][accept*="pdf" i]') ||
        doc.querySelector("input[type=file]");
      if (resume) m.__resumeFile = resume;
      return m;
    },
  });
})();
