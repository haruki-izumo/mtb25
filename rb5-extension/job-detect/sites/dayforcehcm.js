/* =====================================================================
 * job-detect/sites/dayforcehcm.js — Dayforce HCM career-site job
 * postings (<tenant>.dayforcehcm.com/<tenant>/jobs/<id>).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/dayforcehcm/index.js —
 * detection only.
 * ===================================================================== */
(function () {
  "use strict";

  function parserFunc() {
    const positionElement = document.querySelector('h1[test-id="job-detail-title"]');
    const position = positionElement?.textContent.trim() || null;
    if (!position) return null;

    // #main-content .ant-card-bordered is the Ant Design card the JD body
    // renders inside — the only JD container on this template.
    const jobDescriptionElement = document.querySelector("#main-content .ant-card-bordered");
    const jobDescription = jobDescriptionElement
      ? (jobDescriptionElement.innerText || jobDescriptionElement.textContent || "").trim() || null
      : null;
    if (!jobDescription) return null;

    return {
      title: position,
      // Company-less rule (2026-10-01): Dayforce's own career-site template
      // names no employer here — explicit null, not an omitted key.
      company: null,
      description: jobDescription,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
