// job-detect/sites/freshteam.js — Freshteam (*.freshteam.com/jobs/...)
// posting pages. Ported from BidHub's own
// packages/job-parsers/content/platforms/freshteam/index.js.
(function () {
  "use strict";

  function parserFunc() {
    const companyElement = document.querySelector('meta[property="og:description"]');
    const companyContent = companyElement?.getAttribute("content")?.trim() || null;
    // Freshteam's og:description reads "Posted by : <Company> | <blurb>" —
    // strip the "Posted by :" prefix and keep only the segment before the
    // first pipe.
    const company = companyContent ? companyContent.split("|")[0].replace("Posted by :", "").trim() : null;

    const positionElement = document.querySelector('meta[property="og:title"]');
    const positionContent = positionElement?.getAttribute("content")?.trim() || null;
    // og:title reads "Hiring for <Position> - <Company>" — drop the
    // trailing " - <Company>" segment, then strip the "Hiring for" prefix.
    const positionParts = positionContent ? positionContent.split(" - ") : [];
    const positionTitle = positionParts.length > 1 ? positionParts.slice(0, -1).join(" - ") : positionContent;
    const position = positionTitle ? positionTitle.replace("Hiring for ", "").trim() : null;

    // Company-less rule: position is the only mandatory identity field;
    // `company: null` = "this page names no employer" (jobcore accepts it).
    if (!position) return null;

    const jobDetailsHeaderElement = document.querySelector(".job-details-header .content .row .col-xs-8");
    const jobDetailsHeader = jobDetailsHeaderElement?.innerText?.trim() || null;
    const jobDescriptionElement = document.querySelector(".job-details-content > :first-child");
    let jobDescription = jobDescriptionElement
      ? (jobDescriptionElement.innerText || jobDescriptionElement.textContent || "").trim()
      : null;
    if (!jobDescription) return null;
    // The header line (location/department chips) renders as a separate
    // sibling above the actual description body — prepend it so it isn't
    // lost from the extracted text.
    if (jobDetailsHeader) jobDescription = `${jobDetailsHeader}\n${jobDescription}`;

    return {
      title: position,
      company: company || null,
      description: jobDescription,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
