/* =====================================================================
 * job-detect/sites/personio.js — Personio careers postings
 * (https://<company>.jobs.personio.com/job/<id>). Ported from BidHub's
 * own packages/job-parsers/content/platforms/personio/index.js.
 * =====================================================================
 * Each posting embeds a schema.org JobPosting JSON-LD block (title,
 * description, hiringOrganization). The same JSON-LD is present on the
 * inline application form step (/job/<id>?apply), so parsing stays
 * stable across the apply toggle.
 * ===================================================================== */
(function () {
  "use strict";

  function parserFunc() {
    function norm(value) {
      return String(value ?? "").replace(/\s+/g, " ").trim();
    }

    // The JSON-LD JobPosting's `description` is a raw HTML string sitting
    // in JSON data, not a live DOM element, so innerText/textContent can't
    // reach it directly: parse into a detached <div> and read its
    // textContent back out. This feeds a plain-text textarea (#jobText),
    // which can never render markup.
    function htmlFragmentToText(html) {
      if (!html) return "";
      try {
        const div = document.createElement("div");
        div.innerHTML = html;
        div.querySelectorAll("script,style").forEach((el) => el.remove());
        return (div.textContent || "").trim();
      } catch {
        return "";
      }
    }

    let posting = null;
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(node.textContent);
        const candidates = Array.isArray(data) ? data : [data];
        const found = candidates.find((entry) => {
          const type = entry?.["@type"];
          return type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
        });
        if (found) {
          posting = found;
          break;
        }
      } catch {
        // skip malformed JSON-LD
      }
    }

    // Title: JSON-LD, then the posting <h1>, then og:title / document.title.
    // The page title is "<Position> | Jobs at <Company>" — keep only the
    // left side.
    const rawTitle =
      posting?.title ||
      document.querySelector("h1")?.textContent ||
      document.querySelector('meta[property="og:title"]')?.content ||
      document.title;
    const position = norm(rawTitle).split("|")[0].trim() || null;

    // Company: JSON-LD hiringOrganization, then the "Jobs at/bei
    // <Company>" title suffix, then the careers subdomain (e.g.
    // eschbach.jobs.personio.com).
    let company = norm(posting?.hiringOrganization?.name) || null;
    if (!company) {
      const suffixMatch = norm(document.title).match(/jobs\s+(?:at|bei|@)\s+(.+)$/i);
      if (suffixMatch) company = suffixMatch[1].trim();
    }
    if (!company) {
      company = location.hostname.split(".")[0] || null;
    }

    const descriptionElement = document.querySelector(
      '[class*="jobDescription"], [class*="job-description"], [class*="Layout_left"]'
    );
    const description =
      htmlFragmentToText(posting?.description) ||
      (descriptionElement ? (descriptionElement.innerText || descriptionElement.textContent || "").trim() : "") ||
      null;

    // Company-less rule: position is the only mandatory identity field —
    // `company: null` means "this page names no employer", not a parse
    // failure.
    if (!position || !description) return null;

    return { title: position, company: company || null, description };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
