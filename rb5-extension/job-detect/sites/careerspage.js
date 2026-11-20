// job-detect/sites/careerspage.js — careers-page.com (Manatal) postings:
// /{company}/job/{id} and its /apply form. Ported from BidHub's own
// packages/job-parsers/content/platforms/careerspage/index.js.
//
// The identity lives in the page title, but the two title sources
// disagree (live markup, 2026-10-05):
//   <title>    "{Position} {Company} | Career Page"   — NO separator
//   og:title   "{Position} - {Company} | Career Page" — spaced dash
// Splitting <title> at the last BARE '-' is wrong — a title like
// "Full-Stack Developer (Angular/Django) Hivex" has in-word hyphens that
// aren't the position/company separator — so og:title (which carries a
// real spaced dash) is preferred, and only a SPACED dash is ever treated
// as the separator.
(function () {
  "use strict";

  // Spaced hyphen / en dash / em dash. Global: the LAST one in the string
  // is the position/company separator ("Engineer - Platform - Acme" ->
  // "Engineer - Platform" / "Acme").
  const SPACED_DASH = /\s[-–—]\s/g;
  // What may sit between the heading and the company in a separator-less <title>.
  const LEADING_JUNK = /^[\s\-–—|:]+/;

  function cleanText(value) {
    return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : null;
  }

  // "{Position} - {Company} | Career Page" -> { position, company }. The
  // " | Career Page" suffix goes first; then the last spaced dash splits;
  // without one the whole string is the position and the page names no
  // company here.
  function splitCareersPageTitle(rawTitle) {
    const title = cleanText(String(rawTitle ?? "").split("|")[0]);
    if (!title) return { position: null, company: null };
    let last = null;
    for (const match of title.matchAll(SPACED_DASH)) last = match;
    if (!last) return { position: title, company: null };
    return {
      position: cleanText(title.slice(0, last.index)),
      company: cleanText(title.slice(last.index + last[0].length)),
    };
  }

  // og:title is the one source that carries the separator; <title> is the fallback.
  function getCareersPageTitle(doc = document) {
    const ogTitle = cleanText(doc.querySelector('meta[property="og:title"]')?.getAttribute("content"));
    return ogTitle || doc.title || "";
  }

  function parserFunc() {
    const { position: titlePosition, company: titleCompany } = splitCareersPageTitle(getCareersPageTitle(document));
    const heading = cleanText(document.querySelector("h2.job-position-break")?.textContent);
    const position = heading || titlePosition;

    // Company-less rule (2026-10-01): position is the only mandatory
    // identity field — a page naming no employer still reports
    // `company: null` rather than being dropped entirely.
    if (!position) return null;

    let company = titleCompany;
    if (!company && heading && titlePosition && titlePosition.startsWith(heading)) {
      // Separator-less <title> with the exact position known from the
      // heading: what follows it is the company.
      company = cleanText(titlePosition.slice(heading.length).replace(LEADING_JUNK, ""));
    }

    // The JD is `.job-details-body .redactor-styles` after an
    // "<h3>Job Description:</h3>" heading; `h4 + div` is an older-template
    // fallback some tenants still render.
    const descriptionElement =
      document.querySelector(".job-details-body .redactor-styles") || document.querySelector("h3 + div, h4 + div");

    return {
      title: position,
      company: company || null,
      description: descriptionElement
        ? (descriptionElement.innerText || descriptionElement.textContent || "").trim()
        : null,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
