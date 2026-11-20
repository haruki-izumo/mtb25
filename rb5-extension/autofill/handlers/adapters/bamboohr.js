/* =====================================================================
 * handlers/adapters/bamboohr.js — BambooHR (<tenant>.bamboohr.com/careers/...).
 * =====================================================================
 * Contact fields are plain labeled inputs built on BambooHR's own
 * "Fabric" design system (`data-fabric-component="..."`), with no
 * stable per-field attribute of their own — the generic
 * detectContact() heuristic already handles those fine on its own.
 *
 * What it DOES need help with: Fabric's `FileUpload` component
 * unmounts its own `input[type=file]` COMPLETELY once a file is
 * attached — replaced by a "<filename> [remove file]" chip — so a
 * field that already has a resume/cover-letter attached from a
 * previous run has NO file input left in the DOM for a re-attach to
 * find. Click every visible "remove file" button up front so the
 * input reappears — the same "remove the existing file before
 * attaching a new one" pattern Workday/Ultipro need (see those
 * adapters), just reached through Bamboo's own button. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "BambooHR",
    hostTest: (h) =>
      /\.bamboohr\.com$/i.test(h) ||
      (typeof document !== "undefined" && !!document.querySelector('form#job-application-form')),
    detect() {
      const doc = document;
      doc.querySelectorAll('button[aria-label="remove file"]').forEach((btn) => {
        if (isVisible(btn)) btn.click();
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
