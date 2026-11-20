/* =====================================================================
 * handlers/adapters/teamtailor.js — Teamtailor (<tenant>.teamtailor.com).
 * =====================================================================
 * Contact fields are plain labeled inputs driven by Stimulus
 * controllers (`data-controller="forms--inputs--..."`) with no stable
 * per-field attribute of their own for name/email — the generic
 * detectContact() heuristic already handles those fine on its own.
 *
 * What it DOES need help with: Teamtailor's Rails-rendered application
 * form can carry up to THREE separate `input[type=file]` slots —
 * resume, cover letter, and an optional "Additional files" upload — so
 * a blind "grab the first file input" pass is ambiguous between them.
 * The resume and cover-letter inputs each keep a fixed, tenant-
 * independent id straight from the underlying candidate/application
 * record (`candidate_resume_remote_url`, and
 * `candidate_job_applications_attributes_0_cover_letter`), so target
 * those ids directly instead of guessing from label text. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;

  ns.pipeline.registry.registerAdapter({
    name: "Teamtailor",
    hostTest: (h) =>
      /\.teamtailor\.com$/i.test(h) ||
      (typeof document !== "undefined" && !!document.querySelector("#job-application-form")),
    detect() {
      const doc = document;
      const m = {};
      const resume = doc.querySelector('input[type=file]#candidate_resume_remote_url');
      if (resume) m.__resumeFile = resume;
      const coverLetter = doc.querySelector(
        'input[type=file]#candidate_job_applications_attributes_0_cover_letter'
      );
      if (coverLetter) m.__coverLetterFile = coverLetter;
      return m;
    },
  });
})();
