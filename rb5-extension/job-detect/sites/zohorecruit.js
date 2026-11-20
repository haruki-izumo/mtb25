// job-detect/sites/zohorecruit.js — Zoho Recruit's own hosted careers
// pages (candidate-facing job postings, not the recruiter-facing Zoho
// Recruit CRM app). Ported from BidHub's own
// packages/job-parsers/content/platforms/zohorecruit/index.js.
(function () {
  "use strict";

  function parserFunc() {
    const positionElement = document.querySelector(".cw-jobheader-info h1");
    if (!positionElement) return null;
    const position = positionElement.textContent.trim();

    // Company-less rule (2026-10-01): position is the only mandatory
    // identity field — a page naming no employer still reports
    // `company: null` rather than being dropped entirely. Zoho's own
    // header line reads "<Company> | <Location> | ..."; only the first
    // pipe-separated segment is the company name.
    const companyElement = document.querySelector(".cw-jobheader-info > p");
    const company = companyElement?.textContent.split("|")[0].trim() || null;

    let description = null;
    const descriptionElement = document.querySelector(".cw-jobdescription");
    if (descriptionElement) {
      const summaryElement = document.querySelector(".cw-summary");
      const summaryContent = summaryElement ? (summaryElement.innerText || summaryElement.textContent || "").trim() : "";
      const descriptionContent = (descriptionElement.innerText || descriptionElement.textContent || "").trim();
      description = `${summaryContent}\n${descriptionContent}`;
    }

    // Position AND description are both required here (matches BidHub's
    // own source exactly) — a posting page mid-render has the header
    // before the description section loads, and reporting a position-only
    // result then would beat the real one to the punch.
    if (!position || !description) return null;

    return {
      title: position,
      company,
      description,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
