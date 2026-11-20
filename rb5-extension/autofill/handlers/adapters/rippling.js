/* =====================================================================
 * handlers/adapters/rippling.js — Rippling ATS (ats.rippling.com).
 * =====================================================================
 * Contact fields (name/email) are plain labeled inputs inside a generic
 * `[data-testid="field"]` wrapper repeated for every question on the
 * form — no per-field id of its own, so the generic detectContact()
 * heuristic already handles those fine on its own.
 *
 * What it DOES need help with: Rippling's phone question wraps the
 * REAL number input together with a separate country-dial-code combobox
 * (`[data-testid="phone_number-code"]`) inside the same field — a blind
 * "find a phone-looking input" pass can land on the dial-code control
 * instead of the actual number. Rippling tags the number input itself
 * with a stable `data-testid="input-phone_number"` (also mirrored as
 * `data-input="phone_number"`), so grab that directly.
 *
 * Resume and cover-letter are two separate native `input[type=file]`
 * dropzones on the same form, each otherwise indistinguishable from
 * the other — but Rippling tags each field's WRAPPER with its own
 * stable `data-testid` ("resume" / "cover_letter"), so scope the file
 * lookup to those wrappers instead of grabbing the first file input on
 * the page. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "Rippling",
    hostTest: (h) =>
      /\.rippling\.com$/i.test(h) ||
      (typeof document !== "undefined" &&
        (!!document.querySelector('input[data-testid="input-phone_number"]') ||
          !!document.querySelector('[data-testid="phone_number-code"]'))),
    detect() {
      const doc = document;
      const m = {};

      const phone = doc.querySelector(
        'input[data-testid="input-phone_number"], input[data-input="phone_number"]'
      );
      if (phone && isVisible(phone)) m.phone = phone;

      const fileInFieldTagged = (testId) => {
        const marker = doc.querySelector(`[data-testid="${testId}"]`);
        const field = marker?.closest('[data-testid="field"]') || marker;
        return field?.querySelector('input[type=file]') || null;
      };
      const resume = fileInFieldTagged("resume");
      if (resume) m.__resumeFile = resume;
      const coverLetter = fileInFieldTagged("cover_letter");
      if (coverLetter) m.__coverLetterFile = coverLetter;

      return m;
    },
  });
})();
