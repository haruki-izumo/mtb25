// job-detect/sites/greenhouse.js — Greenhouse NEW UI
// (job-boards.greenhouse.io / job-boards.eu.greenhouse.io). Ported from
// BidHub's own packages/job-parsers/content/platforms/greenhouse/new.js —
// this is the newer hosted-board template, distinct from the classic
// boards.greenhouse.io one (a separate adapter/batch), hence its own file
// and its own content_scripts match list rather than reuse of the
// job-detect/extractors/adapters/index.js generic "greenhouse" entry
// (which covers both templates plus the embed widget via a CSS-selector
// heuristic — this file is the deterministic, exact-markup version Big
// Banana runs ONLY on the new-UI hosts).
(function () {
  "use strict";

  function parserFunc() {
    const title = document.title;
    let position = null;
    let company = null;
    let jobDescription = null;

    // The new-UI template puts "<Role> at <Company>" into <title> as
    // "Job Application for <Role> at <Company>" — slice past the fixed
    // "Job Application for" prefix (19 chars; the trailing space before
    // the role is swallowed by the .trim() below) and split on " at ".
    // Case-insensitive match on the prefix since some tenants render it
    // "job application for" — the slice itself always uses the ORIGINAL
    // (non-lowercased) title so casing inside the role/company survives.
    if (title.toLowerCase().startsWith("job application for")) {
      const titleData = title.substring(19);
      const segments = titleData.split(" at ");
      if (segments.length >= 2) {
        position = segments[0].trim();
        company = segments[1].trim();
      }
    }
    // Position is the only mandatory identity field — a page whose title
    // doesn't match the expected shape (e.g. mid-navigation, or a non-job
    // page under the same host) reports nothing rather than a bogus guess.
    if (!position) return null;

    // job__description + job__header are the new-UI template's own
    // classes — present on every real posting view. Missing header is
    // tolerated (optional chaining) even though BidHub's own source
    // didn't guard it, since a template change there shouldn't crash the
    // whole parse and lose the title/company we already have.
    //
    // innerText, not outerHTML — this used to grab the raw markup
    // (confirmed real bug: the Job Description box showed literal
    // "<div class="..." tags instead of the posting's actual text).
    // job-detect/normalize/html.js's htmlToText isn't available here (not
    // in this host's own content_scripts entry — see manifest.json), and
    // innerText already does the job every other extractor in this
    // codebase uses it for, with no extra file to load.
    const jdElement = document.querySelector("div.job__description");
    if (jdElement) {
      const jdContent = (jdElement.innerText || jdElement.textContent || "").trim();
      const headerElement = document.querySelector("div.job__header");
      const headerContent = headerElement ? (headerElement.innerText || headerElement.textContent || "").trim() : "";
      jobDescription = headerContent ? `${headerContent}\n${jdContent}` : jdContent;
    }

    return {
      title: position,
      company: company || null,
      description: jobDescription,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
