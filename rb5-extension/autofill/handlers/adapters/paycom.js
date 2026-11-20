/* =====================================================================
 * handlers/adapters/paycom.js — Paycom (paycomonline.net career portal).
 * =====================================================================
 * Contact fields (Personal Information section) are plain labeled
 * inputs — the generic detectContact() heuristic already handles those
 * fine on its own.
 *
 * What it DOES need help with: Resume/CV and Cover Letter each live in
 * their own `[role=button][aria-label]` "dropzone" widget wrapping a
 * native `input[type=file]` — the aria-label text ("Resume/CV" vs
 * "Cover Letter") is the ONLY thing that tells the two apart. A plain
 * `input[type=file]` selector would just grab whichever dropzone
 * happens to come first in the DOM, so detect() matches each dropzone
 * by its label instead of guessing from document order. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "Paycom",
    hostTest: (h) =>
      /paycomonline\.net$/i.test(h) ||
      (typeof document !== "undefined" &&
        !!document.querySelector('.uiLibCheckboxInput, .uiLibNativeSelect, .uiLibCountryList')),
    detect() {
      const doc = document;
      const m = {};
      doc.querySelectorAll('[role="button"][aria-label] input[type="file"]').forEach((input) => {
        const zone = input.closest('[role="button"][aria-label]');
        if (!zone || !isVisible(zone)) return;
        const label = zone.getAttribute("aria-label") || "";
        if (/resume|\bcv\b|curriculum/i.test(label)) {
          if (!m.__resumeFile) m.__resumeFile = input;
        } else if (/cover\s*letter/i.test(label)) {
          if (!m.__coverLetterFile) m.__coverLetterFile = input;
        }
      });
      return m;
    },
  });
})();
