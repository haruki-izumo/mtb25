/* =====================================================================
 * handlers/adapters/eightfold.js — Eightfold.ai.
 * =====================================================================
 * Stable `data-test-id="Contact_Information_<field>"` convention.
 * Only email/first-name confirmed directly; last-name/phone use the
 * same `Contact_Information_<field>` prefix by the same naming
 * convention — if the guess is wrong for a given tenant, the generic
 * contact heuristic (which runs right after any adapter, see
 * pipeline/basic.js) picks up whatever this adapter didn't find, same
 * safety net every other adapter here relies on. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "Eightfold",
    hostTest: (h) =>
      /eightfold\.ai$/i.test(h) ||
      (typeof document !== "undefined" && !!document.querySelector('[data-test-id^="Contact_Information_"]')),
    detect() {
      const doc = document;
      const m = {};
      const grab = (field, key) => {
        const el = doc.querySelector(`[data-test-id="Contact_Information_${field}"]`);
        if (el && isVisible(el)) m[key] = el;
      };
      grab("email", "email");
      grab("firstname", "first_name");
      grab("lastname", "last_name");
      grab("phone", "phone");
      const resume = doc.querySelector('input[type=file][accept*="pdf" i]') || doc.querySelector('input[type=file]');
      if (resume) m.__resumeFile = resume;
      return m;
    },
  });
})();
