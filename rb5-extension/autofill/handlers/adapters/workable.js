/* =====================================================================
 * handlers/adapters/workable.js — Workable
 * (apply.workable.com / <company>.workable.com, and jobs.workable.com's
 * "Jobs By Workable" board — see note below).
 * =====================================================================
 * Contact fields are plain labeled inputs (label/fieldset/aria-
 * labelledby) with no stable per-field attribute of their own — the
 * generic detectContact() heuristic already handles those fine on its
 * own.
 *
 * What it DOES need help with: Workable's application form can carry
 * up to THREE separate native `input[type=file]` slots at once —
 * résumé, cover letter, and an optional "Photo" (avatar) upload — all
 * indistinguishable from each other by type alone. Workable tags each
 * one directly with its own `data-ui` ("resume" / "cover-letter" or
 * "cover_letter" / "avatar"), so target those instead of grabbing the
 * first file input on the page (which, on a form with a Photo field
 * ordered first, would silently attach the résumé into the avatar
 * slot). Also clicks any visible "remove"/"delete" button on the form
 * first — same "clear the existing file before attaching a new one"
 * pattern BambooHR/Ultipro need — since re-running autofill after
 * changing the selected résumé otherwise leaves the stale file in
 * place next to the input Workable swaps in.
 *
 * One adapter covers both "Workable" and "workable-jobs": the latter
 * is just the public jobs.workable.com aggregator board — clicking
 * Apply from a board listing always lands on the exact same
 * `form[data-ui="application-form"]` markup on the employer's own
 * Workable subdomain. Confirmed by diffing BidHub's
 * workable-autofill.js against workable-jobs-autofill.js: their
 * platform-specific tail sections (content/platforms/workable/
 * autofill.js) are byte-for-byte identical — only the separate job-
 * listing-metadata parser (index.js) differs between the two. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "Workable",
    hostTest: (h) =>
      /\.workable\.com$/i.test(h) ||
      (typeof document !== "undefined" && !!document.querySelector('form[data-ui="application-form"]')),
    detect() {
      const doc = document;
      const form = doc.querySelector('form[data-ui="application-form"]');
      if (!form) return {};

      form.querySelectorAll("button, [role=button]").forEach((btn) => {
        const label = (btn.getAttribute("aria-label") || btn.textContent || "").trim();
        if (/\b(delete|remove)\b/i.test(label) && isVisible(btn)) btn.click();
      });

      const m = {};
      const resume = form.querySelector('input[type=file][data-ui="resume"]');
      if (resume) m.__resumeFile = resume;
      const coverLetter =
        form.querySelector('input[type=file][data-ui="cover-letter"]') ||
        form.querySelector('input[type=file][data-ui="cover_letter"]');
      if (coverLetter) m.__coverLetterFile = coverLetter;
      return m;
    },
  });
})();
