/* =====================================================================
 * handlers/adapters/pinpointhq.js — PinpointHQ (*.pinpointhq.com).
 * =====================================================================
 * Contact fields (name/email/phone) are plain labeled inputs with no
 * stable id/name convention — the generic detectContact() heuristic
 * already handles those fine on its own.
 *
 * What it DOES need help with: the résumé widget anchors on a stable
 * React wrapper (`[id^="Shared::Form::Filefield-react-component"]`),
 * NOT the file input itself, because once a résumé is attached
 * PinpointHQ REMOVES the native `input[type=file]` entirely and
 * renders a success tag with a "Remove" button in its place — a
 * re-attach otherwise has nothing to assign `.files` to. Clicking
 * Remove first (synchronously, right here — detect() isn't awaited,
 * same reasoning as Workday's own detect()) restores the input so the
 * generic attach step that runs right after this resolves has
 * something to work with. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "PinpointHQ",
    hostTest: (h) =>
      /pinpointhq\.com$/i.test(h) ||
      (typeof document !== "undefined" &&
        !!document.querySelector('#application-form, [id^="Shared::Form::Filefield-react-component"]')),
    detect() {
      const doc = document;
      const m = {};
      const resumeField = doc.querySelector('[id^="Shared::Form::Filefield-react-component"]');
      if (resumeField) {
        let fileInput = resumeField.querySelector('input[type="file"]');
        if (!fileInput) {
          const removeBtn = resumeField.querySelector('button[aria-label="Remove"], .bp3-tag-remove');
          if (removeBtn && isVisible(removeBtn)) removeBtn.click();
          fileInput = resumeField.querySelector('input[type="file"]');
        }
        if (fileInput) m.__resumeFile = fileInput;
      }
      return m;
    },
  });
})();
