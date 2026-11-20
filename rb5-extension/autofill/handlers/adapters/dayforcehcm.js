/* =====================================================================
 * handlers/adapters/dayforcehcm.js — Dayforce (dayforcehcm.com) careers.
 * =====================================================================
 * Dayforce's real form controls all carry stable ids prefixed
 * `jobPostingApplication_`, but the contact fields themselves
 * (firstName/email/phone/…) sit behind a dynamic per-tenant suffix
 * resolved only via each control's own `label[for]` — there's no fixed
 * "email" id to anchor on, so the generic detectContact() heuristic
 * (same `label[for]` matching, run after any adapter's own detect() —
 * see pipeline/basic.js) covers those exactly as well as a bespoke
 * lookup would.
 *
 * What IS fixed, across every tenant, are the two upload inputs:
 * `jobPostingApplication_files_resume` and `_files_coverLetter`. Worth
 * addressing by id directly because Dayforce forms often carry other
 * file inputs too (work-history / education-history attachments), so
 * a generic "any `input[type=file]`" fallback risks grabbing one of
 * those instead of the actual resume/cover-letter slot. Everything
 * else Dayforce-specific (Ant Design combobox selects, a resume-parse
 * pass that auto-populates the form after upload, repeatable
 * work/education record sections) is async/behavioral and out of
 * scope for a synchronous detect(). */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;

  ns.pipeline.registry.registerAdapter({
    name: "Dayforce",
    hostTest: (h) =>
      /dayforcehcm\.com$/i.test(h) ||
      (typeof document !== "undefined" && !!document.querySelector('[id^="jobPostingApplication_"]')),
    detect() {
      const doc = document;
      const m = {};
      const resume = doc.getElementById("jobPostingApplication_files_resume");
      if (resume) m.__resumeFile = resume;
      const coverLetter = doc.getElementById("jobPostingApplication_files_coverLetter");
      if (coverLetter) m.__coverLetterFile = coverLetter;
      return m;
    },
  });
})();
