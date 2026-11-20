/* =====================================================================
 * job-detect/sites/pinpointhq.js — Pinpoint (Pinpointhq) career sites.
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/pinpointhq/index.js.
 * ===================================================================== */
(function () {
  "use strict";

  function parserFunc() {
    const position = document.querySelector('meta[property="og:title"]')?.content || null;
    const title = document.title;
    const company = title.split("|").pop().replace("Careers", "").trim() || null;

    // Company-less rule: position is the only mandatory identity field —
    // `company: null` means "this page names no employer", not a parse
    // failure.
    if (!position) return null;

    const jdElement = document.querySelector(".external-panel__content--ruled");
    const jobDescription = jdElement ? (jdElement.innerText || jdElement.textContent || "").trim() : null;
    if (!jobDescription) return null;

    return { title: position, company, description: jobDescription };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
