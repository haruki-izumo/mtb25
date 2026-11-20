/* =====================================================================
 * job-detect/sites/recruitee.js — Recruitee career sites. Ported from
 * BidHub's own packages/job-parsers/content/platforms/recruitee/index.js.
 * ===================================================================== */
(function () {
  "use strict";

  function parserFunc() {
    // Recruitee offer pages expose the company via og:site_name and the
    // position as the page h1 (og:title is "<Company> - <Position>"). The
    // description is the styled job-description block.
    const company = document.querySelector('meta[property="og:site_name"]')?.content?.trim() || null;
    let position = document.querySelector("h1")?.textContent?.trim() || null;

    if (!position) {
      const ogTitle = document.querySelector('meta[property="og:title"]')?.content?.trim() || "";
      position = company && ogTitle.startsWith(`${company} - `) ? ogTitle.slice(`${company} - `.length).trim() : ogTitle || null;
    }

    // Company-less rule: position is the only mandatory identity field —
    // `company: null` means "this page names no employer", not a parse
    // failure.
    if (!position) return null;

    const descriptionElement =
      document.querySelector(".custom-css-style-job-description") || document.querySelector('[class*="job-description"]');
    const description = descriptionElement ? (descriptionElement.innerText || descriptionElement.textContent || "").trim() : null;
    if (!description) return null;

    return { title: position, company, description };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
