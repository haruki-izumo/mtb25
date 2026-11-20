// job-detect/sites/teamtailor.js — Teamtailor (<tenant>.teamtailor.com).
// Ported from BidHub's own
// packages/job-parsers/content/platforms/teamtailor/index.js — Teamtailor
// renders no stable per-field class names for the posting itself (every
// tenant skins its own career site), so the whole parser leans on the
// two things every tenant's page still carries: the og: meta tags Rails
// generates for every posting, and the `main section` layout the
// Teamtailor page template itself renders.
(function () {
  "use strict";

  function parserFunc() {
    // Company-less rule: position is the only mandatory identity field —
    // `company: null` means "this page names no employer" (the panel's
    // backend accepts that), it is NOT a parse failure.
    const companyElement = document.querySelector('meta[property="og:site_name"]');
    const company = companyElement?.getAttribute("content")?.trim() || null;

    const titleElement = document.querySelector('meta[property="og:title"]');
    if (!titleElement) return null;
    const rawTitle = titleElement.getAttribute("content");
    if (!rawTitle) return null;

    // og:title is "<Position> - <Company>" — strip the company suffix
    // (when known) and the dash it leaves behind.
    // e.g. "Senior Software Engineer - Swish Analytics" + company "Swish
    // Analytics" -> "Senior Software Engineer"
    let position = rawTitle;
    if (company && position.endsWith(company)) {
      position = position.slice(0, -company.length).trim();
    }
    if (position.endsWith("-")) {
      position = position.slice(0, -1).trim();
    }
    if (!position) return null;

    // The posting page is a stack of `main section` elements; the LAST one
    // is the application form itself (name/email/resume/...), not part of
    // the job posting — join every section except that one.
    const jobDescriptionElements = document.querySelectorAll("main section");
    if (jobDescriptionElements.length === 0) return null;
    let jobDescription = "";
    for (let i = 0; i < jobDescriptionElements.length - 1; i++) {
      const el = jobDescriptionElements[i];
      const sectionText = (el.innerText || el.textContent || "").trim();
      if (sectionText) jobDescription += (jobDescription ? "\n" : "") + sectionText;
    }

    return {
      title: position,
      company,
      description: jobDescription,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
