/* =====================================================================
 * job-detect/sites/breezy.js — Breezy HR job postings
 * (<tenant>.breezy.hr/p/<slug>).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/breezy/index.js — detection
 * only.
 * ===================================================================== */
(function () {
  "use strict";

  function parserFunc() {
    // Breezy titles every posting tab "<Position> at <Company>" — split
    // on " at " rather than trying to find a dedicated company element
    // (there isn't one on the posting page itself).
    const title = document.title;
    const segments = title.split(" at ");
    let position = null;
    let company = null;

    if (segments.length >= 2) {
      position = segments[0].trim();
      company = segments[1].trim();
    }

    // Company-less rule (2026-10-01, carried over from BidHub): position
    // is the only mandatory identity field — a title with no " at " at
    // all (neither position nor company recoverable) isn't a real
    // posting view, so report nothing.
    if (!position && !company) return null;

    // div#description div.description is the posting's own JD body;
    // div.banner carries the role's header strip (location/department)
    // right above it — both go into `description` together, same as
    // BidHub's own extraction.
    const jobDescriptionElement = document.querySelector("div#description div.description");
    let jobDescription = null;
    if (jobDescriptionElement) {
      const bannerElement = document.querySelector("div.banner");
      const bannerText = (bannerElement.innerText || bannerElement.textContent || "").trim();
      const bodyText = (jobDescriptionElement.innerText || jobDescriptionElement.textContent || "").trim();
      jobDescription = `${bannerText}\n${bodyText}`;
    }

    return { title: position, company, description: jobDescription };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
