/* =====================================================================
 * handlers/adapters/lever.js — Lever (jobs.lever.co + EU mirrors).
 * ==================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "Lever",
    // jobs.lever.co AND regional mirrors (jobs.eu.lever.co etc.).
    hostTest: (h) => /(^|\.)jobs(\.[a-z]{2})?\.lever\.co$/i.test(h),
    detect() {
      const m = {};
      const doc = document;
      const grab = (sel, key) => {
        const el = doc.querySelector(sel);
        if (el && isVisible(el)) m[key] = el;
      };
      grab('input[name="name"]',           "full_name");
      grab('input[name="email"]',          "email");
      grab('input[name="phone"]',          "phone");
      grab('input[name="urls[LinkedIn]"]', "linkedin");
      grab('input[name="urls[GitHub]"]',   "github");
      grab('input[name="location"]',       "location");
      const resume = doc.querySelector('input[type=file][name="resume"]')
        || doc.querySelector('input[type=file]');
      if (resume) m.__resumeFile = resume;
      return m;
    },
  });
})();
