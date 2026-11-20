/* =====================================================================
 * job-detect/sites/smartrecruiters.js — SmartRecruiters job ads
 * (jobs.smartrecruiters.com, and the oneclick-ui apply form which
 * reuses the same posting markup via an iframe/embed in some tenants).
 * =====================================================================
 * Ported from BidHub's packages/job-parsers/content/platforms/
 * smartrecruiters/index.js.
 *
 * SmartRecruiters renders every non-body fact (location, workplace
 * type, employment type, industry, posted date) as schema.org
 * microdata — `<meta itemprop>` void tags plus attributes on the
 * `<spl-job-location>` web component — never as visible text. None of
 * that reaches a plain-text extraction, so it's spelled out here as a
 * labeled `<ul class="job-details">` block prepended to the JD body
 * (same pattern Rippling's own detect file uses for its metadata).
 * ===================================================================== */
(function () {
  "use strict";

  const text = (element) => element?.textContent?.replace(/\s+/g, " ").trim() || null;
  const attr = (element, name) => element?.getAttribute(name)?.trim() || null;
  const metaContent = (root, itemprop) => attr(root.querySelector(`meta[itemprop="${itemprop}"]`), "content");

  // [label, value] lines for the metadata block, from the job ad's microdata.
  function extractMetadataLines(root) {
    const locationElement = root.querySelector("spl-job-location");
    const addressRoot = root.querySelector('[itemprop="jobLocation"]') || root;
    // Prefer the structured address parts over formattedAddress, which is a
    // street-level string ("Newbury St, Boston, MA, USA").
    const addressParts = ["addressLocality", "addressRegion", "addressCountry"]
      .map((itemprop) => metaContent(addressRoot, itemprop)).filter(Boolean);
    const location = addressParts.length
      ? addressParts.join(", ")
      : attr(locationElement, "remotelocation") || attr(locationElement, "formattedaddress");
    return [
      ["Location", location],
      ["Workplace type", attr(locationElement, "workplacetype")],
      ["Employment type", text(root.querySelector('[itemprop="employmentType"]'))],
      ["Industry", metaContent(root, "industry")],
      ["Posted", metaContent(root, "datePosted")?.slice(0, 10)],
    ].filter(([, value]) => value);
  }

  // The job ad body, as plain text, with the metadata facts (which render
  // as microdata only — `.job-details` itself carries no visible text, so
  // it contributes nothing to innerText) prepended as labeled text lines.
  // This feeds a plain-text textarea (#jobText), which can never render
  // markup, so no HTML is built here at all (previously this cloned
  // `.jobad-main`, spliced in a hand-built `<ul class="job-details">` list,
  // and returned the clone's outerHTML — see job-detect/sites/greenhouse.js
  // for the same class of fix).
  function buildDescription(mainElement) {
    const lines = extractMetadataLines(mainElement);
    const metadataText = lines.map(([label, value]) => `${label}: ${value}`).join("\n");
    const bodyText = (mainElement.innerText || mainElement.textContent || "").trim();
    return metadataText ? `${metadataText}\n${bodyText}` : bodyText;
  }

  function parseSmartRecruitersJob() {
    const title = attr(document.querySelector('meta[property="og:title"]'), "content")
      || text(document.querySelector('.jobad-main [itemprop="title"]'));
    const company = attr(document.querySelector('meta[property="og:site_name"]'), "content") || metaContent(document, "name");
    // Company-less rule: title is the only mandatory identity field;
    // company: null = "this page names no employer" (jobcore accepts it).
    if (!title) return null;
    const jdElement = document.querySelector(".jobad-main");
    if (!jdElement) return null;
    const description = buildDescription(jdElement);

    // The aside `a#st-apply` is server-rendered WITHOUT an href (JS attaches
    // it later); the bottom `.job-apply` oneclick anchors carry it from the
    // first paint, so fall through to them.
    const applyLinkElement = document.querySelector('a#st-apply[href]')
      || document.querySelector('a.js-oneclick[href]')
      || document.querySelector('a[href*="/oneclick-ui/company/"]');
    const applyLink = applyLinkElement?.getAttribute("href")?.trim() || null;
    const cleanApplyLink = applyLink ? applyLink.split("?")[0] : null;
    const url = cleanApplyLink
      ? cleanApplyLink.replace("/oneclick-ui/company", "").replace("/publication", "")
      : null;

    return { title, company: company || null, description, url };
  }

  window.ProactiveJobDetect.parser(parseSmartRecruitersJob);
})();
