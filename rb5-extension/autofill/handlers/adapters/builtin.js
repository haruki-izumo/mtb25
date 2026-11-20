/* =====================================================================
 * handlers/adapters/builtin.js — Built In "Easy Apply"
 *   (builtin.com/apply/job/<slug>/<id>).
 * =====================================================================
 * Built In's own Easy Apply form gives its fixed profile fields
 * literal, non-generated ids — "first-name" / "last-name" / "email" /
 * "phone" / "fileData-resume" — unlike its dynamic question controls,
 * which are keyed off bare numeric question ids instead (and are left
 * to the generic detector). Those fixed ids are the stable seam worth
 * grabbing directly. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "Built In",
    hostTest: (h) =>
      /builtin\.com$/i.test(h) ||
      (typeof document !== "undefined" && !!document.getElementById("easyApplyForm")),
    detect() {
      const doc = document;
      const m = {};
      const grab = (sel, key) => {
        const el = doc.querySelector(sel);
        if (el && isVisible(el)) m[key] = el;
      };
      grab("#first-name", "first_name");
      grab("#last-name", "last_name");
      grab("#email", "email");
      grab("#phone", "phone");
      const resume = doc.querySelector("#fileData-resume");
      if (resume) m.__resumeFile = resume;
      return m;
    },
  });
})();
