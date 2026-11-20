// job-detect/sites/gusto.js — Gusto public job board
// (jobs.gusto.com / gusto-hiring.com). Ported from BidHub's own
// packages/job-parsers/content/platforms/gusto/index.js — that module is
// this short in BidHub too; Gusto's posting page gives up almost nothing
// beyond <title> and one description container, so there's no selector
// jungle to port here the way there is for gusto-autofill.js.
(function () {
  "use strict";

  function parserFunc() {
    // Gusto's <title> is "<Role> at <Company>" — split on the literal
    // " at " exactly as BidHub does (no regex/trim tricks needed; Gusto
    // always renders it this way on the posting page).
    const title = document.title;
    const parts = title.split(" at ");
    const position = parts[0]?.trim();

    // Company-less rule (2026-10-01, ported verbatim from BidHub): position
    // is the only mandatory identity field — `company: null` ("this page
    // names no employer") is an accepted result, not a failed parse.
    if (!position) return null;
    const company = parts[1]?.trim() || null;

    // `[data-action="job_postings-show"]` is Gusto's Rails controller/action
    // marker on the posting's description container — present only on the
    // real posting view, so its absence (mid-navigation, or some other
    // gusto.com page under the same host) means "nothing to report yet"
    // rather than a job with no description.
    const jobDescriptionElement = document.querySelector('[data-action="job_postings-show"]');
    const description = jobDescriptionElement
      ? (jobDescriptionElement.innerText || jobDescriptionElement.textContent || "").trim()
      : null;
    if (!description) return null;

    return {
      title: position,
      company,
      description,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
