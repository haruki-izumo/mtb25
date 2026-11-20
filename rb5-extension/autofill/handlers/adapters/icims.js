/* =====================================================================
 * handlers/adapters/icims.js — iCIMS.
 * =====================================================================
 * iCIMS doesn't expose the kind of stable per-field `data-automation-id`
 * Workday does — contact fields here are plain labeled inputs the
 * generic detectContact() heuristic (which runs after any adapter's own
 * detect(), filling whatever keys are still unset — see pipeline/basic.js)
 * already handles fine on its own.
 *
 * What it DOES need help with: iCIMS collapses optional field groups
 * behind "Show More" toggles (`name="icims_gsi_<Group>"`) — a field
 * hidden behind one of these is invisible to EVERY detector, generic or
 * not, until the toggle is clicked. detect() below expands every one of
 * them up front, then returns an empty map — there's nothing iCIMS-
 * specific left to resolve itself; the generic pass right after this one
 * does the actual field matching, now against the fully-expanded form. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "iCIMS",
    hostTest: (h) =>
      /icims\.com$/i.test(h) ||
      (typeof document !== "undefined" &&
        (!!document.querySelector('form[name="icims_form"]') ||
          !!document.querySelector(".iCIMS_FormMainStyle"))),
    detect() {
      const doc = document;
      doc.querySelectorAll('[name^="icims_gsi_"], button[name^="icims_gsi_"], a[name^="icims_gsi_"]').forEach((el) => {
        if (isVisible(el)) el.click();
      });
      const m = {};
      const resume =
        doc.querySelector('input[type=file][accept*="pdf" i]') ||
        doc.querySelector('input[type=file]');
      if (resume) m.__resumeFile = resume;
      return m;
    },
  });
})();
