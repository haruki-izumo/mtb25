/* =====================================================================
 * handlers/adapters/jobdiva.js — JobDiva candidate-portal "Quick Apply".
 * =====================================================================
 * Contact fields (First Name / Last Name / Email / Phone, …) carry NO
 * id/name at all — only a `label.jd-label` + `input.jd-form` pair
 * inside a `.job-app-text-field` wrapper — so the generic label-
 * matching detectContact() heuristic already handles them fine.
 *
 * What it DOES need help with: the resume dropzone. Once a file is
 * uploaded, JobDiva renders a `.jd-dropzone-filecard` sibling of the
 * dropzone AND swaps in a fresh `<input type=file>` — but the filecard
 * remove (X) control (an unlabeled span/svg, no aria-label/title, bound
 * only by JobDiva's own React handler) must be clicked before a
 * re-attach: clicking remove clears the UI but the file input quietly
 * keeps its previously-assigned File object, so attaching a new file
 * onto an "already uploaded" dropzone is a silent no-op. detect()
 * clicks that remove control up front (same reasoning as Ultipro's
 * `delete-file-link`) so the dropzone is empty before the fill step
 * ever touches it. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "JobDiva",
    hostTest: (h) =>
      /jobdiva\.com$/i.test(h) ||
      (typeof document !== "undefined" &&
        (!!document.querySelector(".jd-dropzone, .jd-dropzone-filecard") ||
          !!document.querySelector(".job-app-btns"))),
    detect() {
      const doc = document;
      const m = {};
      const filecard = doc.querySelector(".jd-dropzone-filecard");
      if (filecard) {
        const removeControl =
          Array.from(filecard.querySelectorAll("span")).find((span) => span.querySelector("svg")) ||
          filecard.querySelector("svg");
        if (removeControl && isVisible(removeControl)) removeControl.click();
      }
      const resume =
        doc.querySelector(".jd-dropzone input[type=file]") ||
        doc.querySelector(".jd-form-layout input[type=file]") ||
        doc.querySelector('input[type=file][accept*="pdf" i]') ||
        doc.querySelector("input[type=file]");
      if (resume) m.__resumeFile = resume;
      return m;
    },
  });
})();
