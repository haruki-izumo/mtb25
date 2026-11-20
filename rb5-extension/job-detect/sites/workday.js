// job-detect/sites/workday.js — Workday job postings (*.myworkdayjobs.com).
// Ported from BidHub's own
// packages/job-parsers/content/platforms/myworkdayjobs/index.js. That
// file's whole detection is this short: Workday names the role in one
// stable `h2[data-automation-id="jobPostingHeader"]` header and renders
// the full JD into one `data-automation-id="job-posting-details"`
// container — both tagged with Workday's own automation-id attribute
// (the same attribute family the autofill side keys every form field
// off of), so there's no title-parsing or selector fallback chain
// needed the way other ATSes require.
//
// BidHub's own file never resolves a company for Workday at all — the
// tenant's branding (logo, header text) varies too much tenant-to-tenant
// to trust a single selector, so this stays null here too, same
// company-less convention as job-detect/sites/bamboohr.js: title is the
// only mandatory identity field.
(function () {
  "use strict";

  function parserFunc() {
    const positionElement = document.querySelector('h2[data-automation-id="jobPostingHeader"]');
    const title = positionElement?.textContent?.trim() || null;
    if (!title) return null;

    // innerText, not innerHTML — this used to grab raw markup (same bug
    // confirmed and fixed across job-detect/sites/greenhouse.js and
    // ~40 other site files: the Job Description box showed literal
    // "<div ..." tags instead of the posting's actual text).
    const jdElement = document.querySelector('div[data-automation-id="job-posting-details"]');
    const description = (jdElement?.innerText || jdElement?.textContent || "").trim() || null;

    return { title, company: null, description };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
