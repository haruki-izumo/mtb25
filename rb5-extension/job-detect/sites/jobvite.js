// job-detect/sites/jobvite.js — Jobvite (*.jobvite.com) job-detail pages.
// Ported from BidHub's own
// packages/job-parsers/content/platforms/jobvite/index.js.
(function () {
  "use strict";

  function parserFunc() {
    const title = document.title;
    const splitIndex = title.indexOf("-");
    let company = null;
    let position = null;
    let jobDescription = null;

    // Jobvite renders <title> as "<Company> Careers - Apply for <Position>"
    // (or close variants) — split on the first dash, then strip the
    // "Careers" suffix off the company half and the "Apply for" prefix off
    // the position half.
    if (splitIndex >= 2) {
      company = title.substring(0, splitIndex).trim();
      position = title.substring(splitIndex + 1).trim();
      if (company.endsWith("Careers")) company = company.slice(0, -7).trim();
      if (position.startsWith("Apply for")) position = position.substring(9).trim();
    }

    // Company-less rule: position is the only mandatory identity field;
    // `company: null` = "this page names no employer" (jobcore accepts it).
    if (!position) return null;

    const jobDescriptionElement = document.querySelector("div.jv-job-detail-description");
    if (jobDescriptionElement) {
      jobDescription = (jobDescriptionElement.innerText || jobDescriptionElement.textContent || "").trim();
    }

    return {
      title: position,
      company: company || null,
      description: jobDescription,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
