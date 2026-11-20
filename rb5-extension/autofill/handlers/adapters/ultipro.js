/* =====================================================================
 * handlers/adapters/ultipro.js — UKG/Ultipro (recruiting.ultipro.com).
 * =====================================================================
 * Stable `data-automation="register-<field>"` convention for the
 * account-registration step every Ultipro application starts with,
 * plus the same "remove existing file before attaching a new one"
 * pattern Workday needs (see that adapter's own comment). */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "Ultipro",
    hostTest: (h) =>
      /ultipro\.com$/i.test(h) ||
      (typeof document !== "undefined" && !!document.querySelector('[data-automation^="register-"]')),
    detect() {
      const doc = document;
      const m = {};
      const grab = (sel, key) => {
        const el = doc.querySelector(sel);
        if (el && isVisible(el)) m[key] = el;
      };
      grab('[data-automation="register-email"]',        "email");
      grab('[data-automation="register-first-name"]',   "first_name");
      grab('[data-automation="register-last-name"]',    "last_name");
      grab('[data-automation="register-phone-number"]', "phone");
      // Same reasoning as Workday's own detect(): clear a previously
      // attached file first so a re-attach doesn't just leave the old
      // one in place next to (or instead of) the new one.
      const removeBtn = doc.querySelector('[data-automation="delete-file-link"]');
      if (removeBtn && isVisible(removeBtn)) removeBtn.click();
      const resume =
        doc.querySelector('input[data-automation="upload-file-input"]') ||
        doc.querySelector('input[type=file][accept*="pdf" i]') ||
        doc.querySelector('input[type=file]');
      if (resume) m.__resumeFile = resume;
      return m;
    },
  });
})();
