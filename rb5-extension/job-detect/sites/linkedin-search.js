// job-detect/sites/linkedin-search.js — LinkedIn job SEARCH /
// COLLECTIONS list pages (linkedin.com/jobs/search/*,
// linkedin.com/jobs/collections/*). Ported from BidHub's own
// packages/job-parsers/content/platforms/linkedin/index.js. These pages
// render the two-pane layout — a scrollable list of results on the left,
// the currently-selected job's full posting in a detail pane on the
// right — so this reads whichever job is open in that detail pane, not a
// dedicated per-job URL (that's linkedin-view.js, for /jobs/view/*).
//
// LinkedIn has no autofill in BidHub (its own "Easy Apply" flow isn't
// autofilled there), so this is detection-only — no form-filling logic.
(function () {
  "use strict";

  // --- ported from the small linkedin/utils.js webpack module that both
  // BidHub linkedin.js (this file) and linkedin-view.js import --------

  // /jobs/view/<id> carries the job id in the path; the search/collections
  // list pages instead carry it as ?currentJobId=<id> on an otherwise
  // unrelated search URL — check both so either page shape normalizes to
  // the same canonical "/jobs/view/<id>" link.
  function normalizeLinkedInJobUrl(url) {
    const parsed = new URL(url);
    const jobId =
      parsed.searchParams.get("currentJobId") ??
      parsed.pathname.match(/^\/jobs\/view\/(\d+)/)?.[1];
    if (jobId) {
      return `${parsed.protocol}//${parsed.hostname}/jobs/view/${jobId}`;
    }
    return null;
  }

  // The apply button's accessible text is split across child nodes/icons
  // by LinkedIn's markup, so textContent can come back with embedded
  // newlines between fragments ("Easy\nApply") — strip blank lines and
  // rejoin before the "easy apply" substring check.
  function isLinkedInEasyApplyButton(applyButton) {
    if (!applyButton) return false;
    const buttonText = applyButton.textContent
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .join("")
      .toLowerCase();
    return buttonText.includes("easy apply") || buttonText === "easy apply";
  }

  function parserFunc() {
    const positionElement = document.querySelector(
      ".job-details-jobs-unified-top-card__job-title h1"
    );
    const position = positionElement?.textContent.trim() || null;
    const companyElement = document.querySelector(
      ".job-details-jobs-unified-top-card__company-name"
    );
    const company = companyElement?.textContent.trim() || null;

    // Company-less rule (2026-10-01, carried over from BidHub): position is
    // the only mandatory identity field — `company: null` means "this page
    // names no employer" and is accepted downstream, not treated as a
    // failed parse.
    if (!position) return null;

    // div.jobs-details__main-content is the detail pane's job-posting
    // container on BOTH the search and collections list layouts. BidHub's
    // own source reads .innerHTML here with no null-check; this port reads
    // the element with no null-check too (the engine's debounced run()
    // wraps every call in try/catch, so a mid-render gap just gets retried
    // on the next mutation instead of throwing out to the console), but
    // takes innerText/textContent instead of innerHTML since this feeds a
    // plain-text textarea (#jobText), which can never render markup.
    const jobDescriptionElement = document.querySelector(
      "div.jobs-details__main-content"
    );
    const jobDescription = (jobDescriptionElement.innerText || jobDescriptionElement.textContent || "").trim();
    if (!jobDescription) return null;

    // #jobs-apply-button-id is the list-page detail pane's apply button
    // id (distinct from /jobs/view/*'s own [data-view-name="job-apply-button"]
    // attribute selector in linkedin-view.js).
    const applyButton = document.querySelector("#jobs-apply-button-id");
    const easyApply = isLinkedInEasyApplyButton(applyButton);

    return {
      title: position,
      company,
      description: jobDescription,
      url: normalizeLinkedInJobUrl(window.location.href),
      easyApply,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
