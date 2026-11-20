/* =====================================================================
 * job-detect/sites/workable.js — Workable job-application pages
 * (apply.workable.com). Ported from BidHub's own
 * packages/job-parsers/content/platforms/workable/index.js — detection
 * only; the SEARCH/listing host (jobs.workable.com) is a different
 * BidHub file entirely and is not part of this port.
 * ===================================================================== */
(function () {
  "use strict";

  function parserFunc() {
    // Workable titles the apply-page tab "<Role> - Application" — strip
    // that suffix so `title` carries just the role, not the chrome text.
    var title = document.title;
    if (title.endsWith("- Application")) {
      title = title.substring(0, title.length - 14).trim();
    }

    // h1[data-ui="job-title"] is Workable's own role heading, present on
    // every real application page. Its absence means this isn't one (a
    // careers list, a redirect, an error page) — return null so the
    // engine's dedupe never sends a stale/empty result for it.
    var positionElement = document.querySelector('h1[data-ui="job-title"]');
    if (!positionElement) return null;
    var position = positionElement.textContent.trim();
    if (!position) return null;

    // No dedicated company element on this template — the tab title is
    // "<Role> - <Company>" (after the "- Application" suffix is stripped
    // above), so whatever's left once the role prefix is removed is the
    // company. Some Workable boards don't carry a company in the title at
    // all; `company: null` there ("this page names no employer") is fine.
    var company = title.substring(position.length).trim().replace("-", "").trim() || null;

    // The role's metadata line (location/department pills) is the title
    // heading's very next sibling, right before the main JD block — pull
    // both into `description` together, same as BidHub's own extraction.
    var jobDescriptionElement = document.querySelector('main[role="main"]');
    var jobDescription = null;
    if (jobDescriptionElement) {
      var metadataElement = positionElement.nextElementSibling;
      var metadataText = (metadataElement.innerText || metadataElement.textContent || "").trim();
      var jobDescriptionText = (jobDescriptionElement.innerText || jobDescriptionElement.textContent || "").trim();
      jobDescription = metadataText + "\n" + jobDescriptionText;
    }

    return { title: position, company: company, description: jobDescription };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
