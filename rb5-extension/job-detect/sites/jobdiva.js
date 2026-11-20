/* =====================================================================
 * job-detect/sites/jobdiva.js — JobDiva candidate portal job postings
 * (<tenant>.jobdiva.com/portal/*).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/jobdiva/index.js — detection
 * only.
 * ===================================================================== */
(function () {
  "use strict";

  function parserFunc() {
    const positionElement = document.querySelector(".jd-job-title");
    const position = positionElement ? positionElement.innerText : null;
    if (!position) return null;

    // .jd-desc-title is a heading row, not the description itself — the
    // actual JD body is its parent's next sibling in the markup.
    const jdDescElement = document.querySelector(".jd-desc-title");
    let jobDescription = null;
    if (jdDescElement) {
      const jdElement = jdDescElement.parentElement?.nextSibling;
      if (jdElement) jobDescription = (jdElement.innerText || jdElement.textContent || "").trim();
    }

    return {
      title: position,
      // Company-less rule (2026-10-01): JobDiva's portal names no employer
      // on this template — explicit null, not an omitted key.
      company: null,
      description: jobDescription,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
