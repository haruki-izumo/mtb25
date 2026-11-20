// job-detect/sites/careerplug.js — CareerPlug (<company>.careerplug.com).
//
// Ported from BidHub's own packages/job-parsers/content/platforms/careerplug
// /index.js. The MutationObserver/debounce/SPA-url-watch/dedupe machinery
// already lives in job-detect/engine/parser.js (ProactiveJobDetect.parser) —
// this file only supplies the extraction function BidHub itself wrote.
(function () {
  "use strict";

  function parserFunc() {
    var containerElement = document.querySelector("div.content-body");
    if (!containerElement) return null;

    var position = null;
    var positionElement = document.querySelector('meta[property="og:title"]');
    if (positionElement) {
      position = positionElement.getAttribute("content").trim();
    }
    // position is the only mandatory identity field (BidHub's own
    // "company-less rule": a page naming no employer is still a valid
    // parse, `company: null`) — a page with no og:title isn't parseable yet.
    if (!position) return null;

    // CareerPlug's own <title> is "<Role> | <Company>" — strip the role and
    // the " | " separator back out to recover the company name. No og
    // site-name meta tag exists on this platform, so this string-diff is
    // the only way to get it.
    var company = null;
    var rawTitle = document.querySelector("title").textContent.trim();
    company = rawTitle.replace(position, "").replace(" | ", "").trim() || null;

    // Job description: div.job-description-container holds the actual
    // posting copy; div.job-info (salary/location/employment-type metadata
    // sitting just above it) is prefixed on so a reader downstream gets the
    // full picture, not just the free-text body. Extracted as plain text
    // (innerText, not outerHTML/innerHTML) — this feeds a plain-text
    // textarea (#jobText), which can never render markup; see
    // job-detect/sites/greenhouse.js for the same fix. Guarded against a
    // missing job-info block (BidHub's original assumed it was always
    // present alongside the description container; a mutation mid-render
    // can catch the DOM before it's attached, and the engine just retries on
    // the next debounced pass anyway).
    var description = null;
    var jdElement = containerElement.querySelector("div.job-description-container");
    if (jdElement) {
      var metadataElement = containerElement.querySelector("div.job-info");
      var metadataText = metadataElement ? (metadataElement.innerText || metadataElement.textContent || "").trim() : "";
      var jdText = (jdElement.innerText || jdElement.textContent || "").trim();
      description = metadataText + "\n" + jdText;
    }

    return {
      title: position,
      company: company,
      description: description,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
