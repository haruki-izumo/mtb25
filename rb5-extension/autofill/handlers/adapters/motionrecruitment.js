/* =====================================================================
 * handlers/adapters/motionrecruitment.js — Motion Recruitment Partners'
 * own application form (jobs.motionrecruitment.com and similar).
 * =====================================================================
 * Plain, stable element ids — the cleanest case in this adapter set. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "MotionRecruitment",
    hostTest: (h) =>
      /motionrecruitment\.com$/i.test(h) ||
      (typeof document !== "undefined" && !!document.getElementById("email-input-id")),
    detect() {
      const doc = document;
      const m = {};
      const grab = (id, key) => {
        const el = doc.getElementById(id);
        if (el && isVisible(el)) m[key] = el;
      };
      grab("email-input-id", "email");
      grab("firstName-input-id", "first_name");
      grab("lastName-input-id", "last_name");
      grab("phone-input-id", "phone");
      const resume = doc.querySelector('input[type=file][accept*="pdf" i]') || doc.querySelector('input[type=file]');
      if (resume) m.__resumeFile = resume;
      return m;
    },
  });
})();
