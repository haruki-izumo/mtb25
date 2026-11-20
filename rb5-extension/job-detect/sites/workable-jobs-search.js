/* =====================================================================
 * job-detect/sites/workable-jobs-search.js — Workable's public job
 * board SEARCH/listing page (jobs.workable.com/search*). Renders a
 * two-pane layout — a results list on the left, the currently-selected
 * job's posting in a detail pane on the right — so this reads whichever
 * job is open in that pane, not a dedicated per-job URL (that's
 * workable-jobs-view.js, for /view/<id>).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/workable-jobs/search.js —
 * detection only.
 * ===================================================================== */
(function () {
  "use strict";

  function parserFunc() {
    let title = document.title;
    if (title.endsWith("| Jobs By Workable")) {
      title = title.substring(0, title.length - 18).trim();
    }

    const positionElement = document.querySelector('h2[data-ui="overview-title"]');
    if (!positionElement) return null;
    const position = positionElement.textContent.trim();

    // Company-less rule (2026-10-01): position is the only mandatory
    // identity field; `company: null` = "this page names no employer"
    // (jobcore accepts it).
    const companyElement = document.querySelector('h3[data-ui="overview-company"] a');
    const company = companyElement?.textContent.trim() || null;

    const jobDescriptionElement = document.querySelector('div[class*="jobBreakdown__job-breakdown"]');
    const jobDescription = jobDescriptionElement
      ? (jobDescriptionElement.innerText || jobDescriptionElement.textContent || "").trim()
      : null;

    // The list page's own location.href is the SEARCH url, not this
    // specific job's — the detail pane's identity instead lives in the
    // ?selectedJobId= query param, so build the canonical /view/<id>
    // link from that the same way workable-jobs-view.js's own url is
    // shaped.
    const selectedJobId = new URLSearchParams(window.location.search).get("selectedJobId");
    if (!selectedJobId) return null;
    const jobUrl = `https://jobs.workable.com/view/${selectedJobId}`;

    return { title: position, company, description: jobDescription, url: jobUrl };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
