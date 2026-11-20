/* =====================================================================
 * job-detect/sites/comeet.js — Comeet ("Spark Hire Recruit") job
 * postings (www.comeet.com/jobs/<company>/<companyUid>/<slug>/<posUid>).
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/comeet/index.js.
 * ===================================================================== */
(function () {
  "use strict";

  function parserFunc() {
    // The page title is "<Position> at <Company>"; the rich job
    // description renders as one or more `.userDesignedContent` blocks
    // (Description / Requirements / etc.).
    const rawTitle = (document.title || "").trim();
    const atIndex = rawTitle.lastIndexOf(" at ");
    const titlePosition = atIndex > 0 ? rawTitle.slice(0, atIndex).trim() : rawTitle;
    const titleCompany = atIndex > 0 ? rawTitle.slice(atIndex + 4).trim() : null;

    const position = document.querySelector(".positionName")?.textContent?.trim() || titlePosition || null;
    const company = titleCompany;

    // Company-less rule: position is the only mandatory identity field —
    // `company: null` means "this page names no employer", not a parse
    // failure.
    if (!position) return null;

    const blocks = Array.from(document.querySelectorAll(".userDesignedContent"));
    const description = blocks.length
      ? blocks.map((block) => (block.innerText || block.textContent || "").trim()).join("\n")
      : null;
    if (!description) return null;

    return { title: position, company: company || null, description };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
