/* =====================================================================
 * extractors/structured/jsonld.js — schema.org JobPosting reader
 * =====================================================================
 * Parse <script type="application/ld+json"> blocks (incl. @graph) and
 * pull the first JobPosting's title / hiringOrganization.name /
 * description / jobLocationType. Returns the raw values + `seen`; the
 * caller decides whether JSON-LD is canonical (job-fit.js short-circuits
 * only when there's BOTH a company and a substantial description).
 *
 * `description` is normalized to plain text via the injected htmlToText
 * (job-detect/normalize/html.js). Moved verbatim from job-fit.js's inline
 * loop; takes `doc` for testability. Dual export.
 * ===================================================================== */
(function () {
  "use strict";

  function extractJsonLd(doc, htmlToText) {
    const toText = typeof htmlToText === "function" ? htmlToText : (s) => String(s || "");
    let ldTitle = "";
    let ldCompany = "";
    let ldDescription = "";
    let ldJobLocationType = "";
    let ldSeen = false;
    const ldScripts = (doc || document).querySelectorAll('script[type="application/ld+json"]');
    ldLoop: for (const s of ldScripts) {
      try {
        const parsed = JSON.parse(s.textContent || "");
        const items = Array.isArray(parsed)
          ? parsed
          : parsed && parsed["@graph"]
          ? parsed["@graph"]
          : [parsed];
        for (const item of items) {
          const t = item && item["@type"];
          const isJob =
            t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"));
          if (isJob) {
            const title = String(item.title || "").trim();
            const company = String(
              item.hiringOrganization && item.hiringOrganization.name
                ? item.hiringOrganization.name
                : ""
            ).trim();
            const description = toText(String(item.description || ""));
            const jobLocationType = String(item.jobLocationType || "").trim();
            if (title || company || description) {
              ldTitle = title || ldTitle;
              ldCompany = company || ldCompany;
              ldDescription = description || ldDescription;
              ldJobLocationType = jobLocationType || ldJobLocationType;
              ldSeen = true;
              break ldLoop; // first content-bearing JobPosting wins
            }
          }
        }
      } catch {
        /* malformed JSON-LD — ignore */
      }
    }
    return {
      title: ldTitle,
      company: ldCompany,
      description: ldDescription,
      jobLocationType: ldJobLocationType,
      seen: ldSeen,
    };
  }

  if (typeof window !== "undefined" && window.ProactiveJobDetect) {
    window.ProactiveJobDetect.extractors.structured.jsonld = extractJsonLd;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = extractJsonLd;
})();
