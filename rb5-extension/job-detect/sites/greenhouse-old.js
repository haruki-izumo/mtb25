// job-detect/sites/greenhouse-old.js — Greenhouse's CLASSIC hosted-board
// template (boards.greenhouse.io / boards.eu.greenhouse.io), distinct
// from the newer job-boards.greenhouse.io template already ported as
// job-detect/sites/greenhouse.js — the two hosts render different markup
// entirely, hence a separate file (and its own content_scripts match
// list) rather than one parser branching on host. Ported from BidHub's
// own packages/job-parsers/content/platforms/greenhouse/old.js.
(function () {
  "use strict";

  function parserFunc() {
    const title = document.title;
    let position = null;
    let company = null;
    let jobDescription = null;

    // The classic template puts "<Role> at <Company>" into <title> as
    // "Job Application for <Role> at <Company>" — slice past the fixed
    // "Job Application for" prefix (19 chars; the trailing space before
    // the role is swallowed by the .trim() below) and split on " at ".
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

    // The classic template's job content lives under #app_body: #header
    // (role/location/department chrome) + #content (the actual JD body).
    // Missing #content is tolerated the same way BidHub's own source
    // falls back to it being null rather than throwing.
    //
    // innerText, not innerHTML — this used to grab raw markup (same bug
    // confirmed and fixed in job-detect/sites/greenhouse.js: the Job
    // Description box showed literal "<div ..." tags instead of the
    // posting's actual text).
    const jdElement = document.querySelector("div#app_body");
    if (jdElement) {
      const contentElement = jdElement.querySelector("#content");
      if (contentElement) {
        const headerElement = jdElement.querySelector("#header");
        const contentText = (contentElement.innerText || contentElement.textContent || "").trim();
        const headerText = headerElement ? (headerElement.innerText || headerElement.textContent || "").trim() : "";
        jobDescription = headerText ? `${headerText}\n${contentText}` : contentText;
      }
    }

    return {
      title: position,
      company: company || null,
      description: jobDescription,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
