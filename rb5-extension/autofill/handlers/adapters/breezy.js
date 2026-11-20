/* =====================================================================
 * handlers/adapters/breezy.js — Breezy HR (<tenant>.breezy.hr).
 * =====================================================================
 * Contact fields are plain labeled AngularJS-bound inputs with no
 * stable per-field attribute of their own — the generic
 * detectContact() heuristic already handles those fine on its own.
 *
 * What IS stable: Breezy's own application form names its resume
 * upload input literally `name="cResume"` — a fixed Angular model
 * binding baked into every Breezy tenant's form, not a generated id.
 * Breezy forms often carry OTHER file inputs too (e.g. a custom
 * "portfolio"/attachment question), so a blind "first file input on
 * the page" fallback risks grabbing the wrong one; going straight for
 * the named input avoids that. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;

  ns.pipeline.registry.registerAdapter({
    name: "Breezy",
    hostTest: (h) =>
      /\.breezy\.hr$/i.test(h) ||
      (typeof document !== "undefined" &&
        !!document.querySelector('form[ng-controller*="FormWithQuestionnaireCtrl"]')),
    detect() {
      const doc = document;
      const m = {};
      const resume =
        doc.querySelector('input[type=file][name="cResume"]') ||
        doc.querySelector('input[type=file][accept*="pdf" i]') ||
        doc.querySelector("input[type=file]");
      if (resume) m.__resumeFile = resume;
      return m;
    },
  });
})();
