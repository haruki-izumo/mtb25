/* =====================================================================
 * handlers/adapters/paylocity.js — Paylocity (recruiting.paylocity.com).
 * =====================================================================
 * Contact fields are plain labeled inputs (label[for] / aria-label /
 * data-for) — the generic detectContact() heuristic already handles
 * those fine on its own.
 *
 * What it DOES need help with: landing on the Apply page raises a
 * mandatory "Apply with resume" modal (#forceUploadResumeModal) whose
 * only action is uploading a resume — nothing else on the form is
 * reachable until that happens. The modal's file input (#btn-forceResume)
 * stays mounted in the DOM (hidden) for the rest of the session even
 * after the modal closes, while the in-form resume slot (#btn-resume)
 * is removed from the DOM entirely once a resume is actually attached.
 * So the right input to hand the fill pipeline depends on which of the
 * two is currently live: the modal's input only while the modal is
 * open, the in-form input otherwise. Cover letter (#btn-coverLetter)
 * has no such modal and is just grabbed directly. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;

  ns.pipeline.registry.registerAdapter({
    name: "Paylocity",
    hostTest: (h) =>
      /paylocity\.com$/i.test(h) ||
      (typeof document !== "undefined" &&
        !!document.querySelector('[data-pcty-section], #forceUploadResumeModal')),
    detect() {
      const doc = document;
      const m = {};
      const modal = doc.getElementById("forceUploadResumeModal");
      const modalOpen =
        !!modal &&
        modal.getAttribute("aria-hidden") !== "true" &&
        modal.getBoundingClientRect().height > 0;
      const resumeInput = modalOpen
        ? doc.getElementById("btn-forceResume")
        : doc.getElementById("btn-resume");
      if (resumeInput) m.__resumeFile = resumeInput;
      const coverInput = doc.getElementById("btn-coverLetter");
      if (coverInput) m.__coverLetterFile = coverInput;
      return m;
    },
  });
})();
