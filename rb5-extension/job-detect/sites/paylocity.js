/* =====================================================================
 * job-detect/sites/paylocity.js — Paylocity recruiting postings
 * (recruiting.paylocity.com/Recruiting/Jobs/Details/<id>).
 * =====================================================================
 * Ported from BidHub's packages/job-parsers/content/platforms/
 * paylocity/index.js.
 *
 * document.title is consistently "<Company> - <Position>" — split on
 * the LAST hyphen (a position title can itself contain a hyphen, so
 * splitting on the first one would cut it in half). The body combines
 * the location line and the JD details block.
 * ===================================================================== */
(function () {
  "use strict";

  function parsePaylocityJob() {
    if (!window.location.pathname.includes("/Details")) return null;

    const title = document.title;
    const splitIndex = title.lastIndexOf("-");
    let company = null;
    let position = null;
    if (splitIndex >= 2) {
      company = title.slice(0, splitIndex).trim();
      position = title.slice(splitIndex + 1).trim();
    }
    // Company-less rule: title is the only mandatory identity field;
    // company: null = "this page names no employer" (jobcore accepts it).
    if (!position) return null;

    const elementText = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");

    let description = "";
    const locationElement = document.querySelector("div.preview-location");
    if (locationElement) description += `\n${elementText(locationElement)}`;
    const descriptionElement = document.querySelector("div.job-preview-details");
    if (descriptionElement) description += `\n${elementText(descriptionElement)}`;

    return { title: position, company: company || null, description };
  }

  window.ProactiveJobDetect.parser(parsePaylocityJob);
})();
