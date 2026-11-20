// job-detect/sites/applytojob.js — ApplyToJob / Resumator careers pages
// (<company>.applytojob.com).
//
// Ported from BidHub's own
// packages/job-parsers/content/platforms/applytojob/index.js. Resumator
// ships two distinct page templates depending on how old/new the tenant's
// career site is, so this tries the newer one first and falls back to the
// legacy one — same two-function shape BidHub itself used rather than one
// function branching internally.
(function () {
  "use strict";

  // Modern Resumator theme: the role lives in `.job-header h2` and the body
  // in `#job-description`. The <title> is "{Position} - {Company} -
  // Careers" (ApplyToJob's own fixed suffix) — the company is recovered by
  // slicing out the known-length prefix (the role text + " - ") and the
  // fixed 13-character suffix, rather than a naive split on " - ", since
  // the role or company text can itself legitimately contain a hyphen.
  function parseModernApplyToJob() {
    const positionElement = document.querySelector(".job-header h2");
    const position = positionElement ? positionElement.textContent.trim() : null;
    const jobDescriptionElement = document.querySelector("#job-description");
    if (!position || !jobDescriptionElement) return null;

    const title = document.title;
    const company = title.substring(position.length + 2, title.length - 13).trim();
    const headerElement = document.querySelector(".job-header");
    const headerText = headerElement ? (headerElement.innerText || headerElement.textContent || "").trim() : "";
    const bodyText = (jobDescriptionElement.innerText || jobDescriptionElement.textContent || "").trim();
    const jobDescription = `${headerText}\n${bodyText}`;

    // Company-less rule: title is the only mandatory identity field;
    // company: null = "this page names no employer" (jobcore accepts it).
    if (!position || !jobDescription) return null;
    return { title: position, company: company || null, description: jobDescription };
  }

  // Legacy/classic Resumator theme: the role lives in `#resumator-job-title`
  // and the body in `#resumator-job-description`. The page title is
  // "{position} - {company} - Career Page", so derive the company from it
  // instead of a fixed-offset slice (the legacy theme's suffix differs from
  // the modern one's, and this form is more tolerant of either).
  function deriveCompanyFromTitle(title, position) {
    let value = String(title || "").replace(/\s*-\s*Career Page\s*$/i, "").trim();
    if (position && value.toLowerCase().startsWith(position.toLowerCase())) {
      value = value.slice(position.length).replace(/^\s*-\s*/, "").trim();
    }
    return value || null;
  }
  function parseLegacyApplyToJob() {
    const titleElement = document.querySelector("#resumator-job-title");
    const position = titleElement ? titleElement.textContent.trim() : null;
    const jobDescriptionElement = document.querySelector("#resumator-job-description");
    if (!position || !jobDescriptionElement) return null;

    const company = deriveCompanyFromTitle(document.title, position);
    const headerText = titleElement
      ? `${(titleElement.innerText || titleElement.textContent || "").trim()}\n`
      : "";
    const jobDescription = `${headerText}${(jobDescriptionElement.innerText || jobDescriptionElement.textContent || "").trim()}`;

    // Company-less rule: title is the only mandatory identity field;
    // company: null = "this page names no employer" (jobcore accepts it).
    if (!position || !jobDescription) return null;
    return { title: position, company: company || null, description: jobDescription };
  }

  function parserFunc() {
    return parseModernApplyToJob() || parseLegacyApplyToJob();
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
