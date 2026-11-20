/* =====================================================================
 * job-detect/sites/oraclecloud.js — Oracle Cloud Recruiting (ORC)
 * "Candidate Experience" job postings (*.oraclecloud.com).
 * =====================================================================
 * Ported from BidHub's packages/job-parsers/content/platforms/
 * oraclecloud/index.js.
 *
 * The role title is the one stable DOM hook (`h1.job-details__title`).
 * The employer isn't named anywhere reliable in the DOM, but
 * `document.title` is consistently "<Position> - <Company>" (with
 * ORC's own tenant chrome — "Careers"/"Career Site" — sometimes
 * trailing the company name), so the company comes from parsing the
 * title instead. The JD body is a set of `.job-details__section`
 * blocks concatenated in document order.
 * ===================================================================== */
(function () {
  "use strict";

  function parseOracleCloudJob() {
    const title = document.querySelector("h1.job-details__title")?.textContent || null;
    // Company-less rule: title is the only mandatory identity field;
    // company: null = "this page names no employer" (jobcore accepts it).
    if (!title) return null;

    let company = null;
    const docTitle = document.title;
    const splitIndex = docTitle.lastIndexOf("-");
    if (splitIndex >= 2) {
      const candidate = docTitle.slice(splitIndex + 1).trim();
      // Strip trailing filler like "Careers", "Career Site", "Site".
      const stripped = candidate.replace(/(?:[\s|·—–-]*\b(?:careers?|site)\b)+[\s|·—–-]*$/i, "").trim();
      company = stripped || candidate || null;
    }

    const sections = Array.from(document.querySelectorAll(".job-details__section"));
    const description = sections.length
      ? sections
          .map((el) => (el.innerText || el.textContent || "").trim())
          .filter(Boolean)
          .join("\n")
      : null;

    return { title, company, description };
  }

  window.ProactiveJobDetect.parser(parseOracleCloudJob);
})();
