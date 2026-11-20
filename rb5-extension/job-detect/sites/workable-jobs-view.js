/* =====================================================================
 * job-detect/sites/workable-jobs-view.js — Workable's public job board
 * (jobs.workable.com/view/<id>) — a distinct site from
 * apply.workable.com (job-detect/sites/workable.js), which already has
 * its own port.
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/workable-jobs/index.js —
 * detection only. The /search listing page is a separate BidHub file
 * (workable-jobs/search.js) ported as workable-jobs-search.js.
 * ===================================================================== */
(function () {
  "use strict";

  function parserFunc() {
    let title = document.title;
    if (title.endsWith("| Jobs By Workable")) {
      title = title.substring(0, title.length - 18).trim();
    }

    const positionElement = document.querySelector('h1[data-ui="overview-title"]');
    if (!positionElement) return null;
    const position = positionElement.textContent.trim();

    // Company-less rule (2026-10-01): position is the only mandatory
    // identity field; `company: null` = "this page names no employer"
    // (jobcore accepts it).
    const company = title.substring(positionElement.textContent.length).trim().replace("|", "").trim() || null;

    const jobDescriptionElement = document.querySelector('div[class*="jobDescription__card"]');
    const jobDescription = jobDescriptionElement
      ? (jobDescriptionElement.innerText || jobDescriptionElement.textContent || "").trim()
      : null;

    // The page's own canonical <link rel="alternate"> sometimes points at
    // a markdown mirror ("…/jobs/<id>.md") rather than the HTML view —
    // strip that suffix and swap the path back to /view/ so the reported
    // url always matches a real, loadable posting page.
    const urlElement = document.querySelector('link[rel="alternate"]');
    if (!urlElement) return null;
    let jobUrl = urlElement.href;
    if (jobUrl.endsWith(".md")) {
      jobUrl = jobUrl.substring(0, jobUrl.length - 3).replace("/jobs/", "/view/");
    }

    return { title: position, company, description: jobDescription, url: jobUrl };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
