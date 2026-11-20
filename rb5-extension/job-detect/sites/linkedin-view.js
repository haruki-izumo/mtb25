// job-detect/sites/linkedin-view.js — LinkedIn single job DETAIL page
// (linkedin.com/jobs/view/<id>). Ported from BidHub's own
// packages/job-parsers/content/platforms/linkedin/view.js. Distinct from
// linkedin-search.js (the /jobs/search/* and /jobs/collections/* list
// pages' own detail pane, read via different selectors/markup) — BidHub
// itself keeps these as two separate site files, not one shared module,
// because the two layouts don't share a DOM structure.
//
// LinkedIn has no autofill in BidHub (its own "Easy Apply" flow isn't
// autofilled there), so this is detection-only — no form-filling logic.
(function () {
  "use strict";

  // --- ported from the small linkedin/utils.js webpack module that both
  // BidHub linkedin-view.js (this file) and linkedin.js import ---------

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
    // The detail page's own <title> is "<Role> | <Company> | LinkedIn" (or
    // similar) — split on "|" rather than scraping a heading, since
    // LinkedIn's top-card markup here churns across redesigns far more
    // than <title> does. Fewer than 2 segments means the title doesn't
    // match the expected shape (e.g. mid-navigation) — bail rather than
    // guess.
    const title = document.title;
    const splits = title.split("|");
    let position = null;
    let company = null;
    let jobDescription = null;

    if (splits.length >= 2) {
      position = splits[0].trim();
      company = splits[1].trim();
    } else {
      return null;
    }

    // There's no stable class/id on the description container across
    // LinkedIn's redesigns, but every real posting has an "About the job"
    // <h2> heading right above it — walk up two levels from that heading
    // to its section wrapper and take the WHOLE section's HTML (heading +
    // body together) rather than trying to isolate just the body.
    const h2Elements = document.querySelectorAll("h2");
    let aboutTheJobElement = null;
    for (let i = 0; i < h2Elements.length; i++) {
      const element = h2Elements.item(i);
      if (element.textContent.trim().toLowerCase() === "about the job") {
        aboutTheJobElement = element;
        break;
      }
    }
    if (!aboutTheJobElement) return null;
    const jobDescriptionElement = aboutTheJobElement.parentElement?.parentElement;
    if (!jobDescriptionElement) return null;
    jobDescription = (jobDescriptionElement.innerText || jobDescriptionElement.textContent || "").trim();

    // The job metadata row (applicant count, posted-time, etc.) lives in a
    // sibling block identified only by its "More options" button (no
    // class/id of its own either) — when present, prepend that block's
    // HTML to the description so the metadata isn't lost.
    const moreOptionButton = document.querySelector(
      'button[aria-label="More options"]'
    );
    if (moreOptionButton) {
      const metadataElement = moreOptionButton.parentElement?.parentElement;
      if (metadataElement) {
        const metadataText = (metadataElement.innerText || metadataElement.textContent || "").trim();
        jobDescription = metadataText ? `${metadataText}\n${jobDescription}` : jobDescription;
      }
    }

    // BidHub's own source computes easyApply here via
    // isLinkedInEasyApplyButton() but never adds it to the returned
    // object below (unlike linkedin/index.js, which does) — that omission
    // is carried over as-is rather than "fixed", since this is a straight
    // port of BidHub's own behavior.
    const applyButton = document.querySelector(
      '[data-view-name="job-apply-button"]'
    );
    const easyApply = isLinkedInEasyApplyButton(applyButton);
    void easyApply;

    return {
      title: position,
      company,
      description: jobDescription,
      url: normalizeLinkedInJobUrl(window.location.href),
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
