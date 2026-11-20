// job-detect/sites/indeed-smartapply.js — detection only, for Indeed's
// SmartApply flow (smartapply.indeed.com). This is a SEPARATE apply surface
// from the /beta/indeedapply flow that indeed-autofill.js drives — SmartApply
// renders its own job-header widget (`.ia-JobHeader`) rather than reusing
// indeed.com's normal posting-page DOM, so it needs its own selectors, but
// it carries no fillable form fields of its own (BidHub's own source for
// this file is detection-only too — no field-detection/fill logic at all,
// confirmed by reading it end to end), so there is no matching autofill
// file for this host. Ported from BidHub's own
// packages/job-parsers/content/platforms/indeed/smartapply.js.
(function () {
  "use strict";

  function parserFunc() {
    // .ia-JobHeader is SmartApply's own job-summary widget — absent, this
    // isn't a SmartApply job-apply page (mid-navigation, a non-job
    // SmartApply route, etc.), so bail without touching anything below.
    const infoContainer = document.querySelector(".ia-JobHeader");
    if (!infoContainer) return null;

    let position = null;
    let company = null;
    let jobDescription = null;

    const positionElement = infoContainer.querySelector("h1");
    if (positionElement) {
      position = positionElement.innerText;
    }

    // Company-less rule (2026-10-01): position is the only mandatory identity
    // field; company: null = "this page names no employer" (jobcore accepts
    // it).
    if (!position) return null;

    const companyElement = infoContainer.querySelector("span");
    if (companyElement) {
      company = companyElement.innerText;
      // The same span also carries a trailing "- Remote"/"- New York, NY"
      // location suffix after the employer name — strip everything from the
      // LAST " -" onward (a company name itself could legitimately contain a
      // bare hyphen, e.g. "Jones-Smith Co", so anchoring on " -" with the
      // leading space avoids cutting that short).
      const lastDashIndex = company.lastIndexOf(" -");
      if (lastDashIndex !== -1) {
        company = company.substring(0, lastDashIndex).trim();
      }
    }

    const jobDescriptionElement = document.querySelector("div.ia-JobDescription");
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
