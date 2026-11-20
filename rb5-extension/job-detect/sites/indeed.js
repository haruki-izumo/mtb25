// job-detect/sites/indeed.js — general indeed.com job-posting pages
// (/viewjob, job-search result "preview" panes, etc. — NOT the SmartApply
// apply flow, see indeed-smartapply.js for that). Ported from BidHub's own
// packages/job-parsers/content/platforms/indeed/index.js.
(function () {
  "use strict";

  function parserFunc() {
    // BidHub's own generic engine runs this SAME parser.js on EVERY indeed.com
    // page, so the smartapply.indeed.com host has to be explicitly excluded
    // here — otherwise this file's position/company selectors (which don't
    // exist on the SmartApply DOM) would fire a bogus empty-ish result on top
    // of indeed-smartapply.js's own, correct one. Belt-and-suspenders: Big
    // Banana's manifest should already scope these two files to disjoint
    // hosts, but the guard costs nothing and matches the source exactly.
    if (location.hostname.includes("smartapply")) return null;

    let position = null;
    let company = null;
    let jobDescription = null;

    // Position: the header title's FIRST child text node only — the element
    // also contains a "- job post" suffix span on some layouts, and reading
    // just childNodes[0] (not .textContent) drops that suffix the same way
    // BidHub's own source does.
    const positionElement = document.querySelector(".jobsearch-JobInfoHeader-title > span");
    if (positionElement) {
      position = positionElement.childNodes[0]?.textContent?.trim();
    }

    // Company-less rule (2026-10-01): position is the only mandatory identity
    // field — a page mid-navigation or without this exact header markup
    // reports nothing rather than a bogus guess.
    if (!position) return null;

    // Company: the linked employer name first (the <a> wraps the name in its
    // own child text node same as the title does), else the same container's
    // plain text when the employer has no profile page to link to.
    let companyElement = document.querySelector("div[data-company-name='true'] a");
    if (companyElement) {
      company = companyElement.childNodes[0]?.textContent?.trim();
    } else {
      companyElement = document.querySelector("div[data-company-name='true']");
      company = companyElement?.textContent?.trim() || null;
    }

    // Description: the whole jobsearch-JobComponent subtree (not just
    // #jobDescriptionText) so the metadata strip above the JD body — pay,
    // job type, location — rides along with it, matching BidHub's own
    // source. Only read once #jobDescriptionText itself is confirmed
    // present, since JobComponent also renders on in-between loading states
    // that have no JD text yet.
    const jobDescriptionTextElement = document.getElementById("jobDescriptionText");
    if (jobDescriptionTextElement) {
      const jobDescriptionElement = document.querySelector("div.jobsearch-JobComponent");
      jobDescription = jobDescriptionElement
        ? (jobDescriptionElement.innerText || jobDescriptionElement.textContent || "").trim()
        : null;
    }

    return {
      title: position,
      company: company || null,
      description: jobDescription,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
