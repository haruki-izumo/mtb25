// job-detect/sites/ziprecruiter.js — ZipRecruiter job-details pane, both
// the jobs-search SPA (ziprecruiter.com/jobs-search/...) and a standalone
// job page. Ported from BidHub's own
// packages/job-parsers/content/platforms/ziprecruiter/index.js.
//
// Not ported from that file: the <style> block BidHub's own source
// appends to <body> to raise its injected panel's z-index above ZR's
// chrome. That's a fix for BidHub's own panel-injection model (a panel is
// injected fresh into the page itself) — Big Banana's side panel is a
// persistent extension-chrome page, not injected into ZR's DOM, so there
// is no z-index fight for it to lose.
(function () {
  "use strict";

  // The company link used to sit right next to the <h2>; ZR moved it
  // (verified live 2026-08-25), and by 2026-09-10 the only company-page
  // anchors left are "Learn more about X" (carrying an external-link svg
  // whose accessible text "external" rides along in textContent) and
  // "View All X Jobs" — strip the icon and the link phrasing before
  // trusting the text.
  function cleanCompanyAnchorText(anchor) {
    var clone = anchor.cloneNode(true);
    clone.querySelectorAll('svg, [aria-hidden="true"], .sr-only').forEach(function (node) {
      node.remove();
    });
    return clone.textContent
      .replace(/\s+/g, " ")
      .replace(/^\s*(learn more about|see more jobs at)\s+/i, "")
      .replace(/^\s*view all\s+(.+?)\s+jobs\s*$/i, "$1")
      .trim();
  }

  function getCompanyName(jobDetailsContainer, positionElement) {
    var siblingAnchor = positionElement.parentElement.querySelector("a");
    if (siblingAnchor) {
      var siblingCompany = cleanCompanyAnchorText(siblingAnchor);
      if (siblingCompany) return siblingCompany;
    }
    var companyAnchors = Array.from(
      jobDetailsContainer.querySelectorAll('a[href^="/co/"], a[href^="https://www.ziprecruiter.com/co/"]')
    );
    for (var i = 0; i < companyAnchors.length; i++) {
      var company = cleanCompanyAnchorText(companyAnchors[i]);
      if (company) return company;
    }
    return null;
  }

  // Selecting a job on the jobs-search SPA puts its stable listing key in
  // the URL as ?lk=; a standalone job page instead carries it as ?lvk=.
  // Both map to the same shareable /jobs//j?lvk=<key> deep link (verified
  // live 2026-08-24). Without a key there's no stable identity for the
  // job on screen (e.g. the default-selected job before any click), so
  // nothing is reported — clicking any job puts the key in the URL and
  // the parser re-runs.
  function getJobUrl() {
    var params = new URLSearchParams(window.location.search);
    var listingKey = params.get("lk") || params.get("lvk");
    if (!listingKey) return null;
    return "https://www.ziprecruiter.com/jobs//j?lvk=" + listingKey;
  }

  function parserFunc() {
    var jobUrl = getJobUrl();
    if (!jobUrl) return null;

    var jobDetailsContainer = document.querySelector('div[data-testid="job-details-scroll-container"]');
    if (!jobDetailsContainer) return null;

    // Position is the only mandatory identity field — no <h2> means the
    // pane hasn't rendered a job yet (mid-navigation, a skeleton state).
    var positionElement = jobDetailsContainer.querySelector("h2");
    if (!positionElement) return null;
    var position = positionElement.textContent.trim();
    if (!position) return null;

    // Company-less rule (2026-10-01): a page naming no employer still
    // reports `company: null` rather than being dropped entirely.
    var company = getCompanyName(jobDetailsContainer, positionElement) || null;

    // Most renders put the JD right after an <hr>; some renders have no
    // element after it at all (the JD sits inside the preceding block
    // instead) — in that case accept the container's own text once it's
    // clearly a rendered JD rather than a loading skeleton.
    var jdElement = jobDetailsContainer.querySelector("hr");
    jdElement = jdElement ? jdElement.nextElementSibling : null;
    if (!jdElement && jobDetailsContainer.textContent.length <= 500) return null;
    var jobDescription = (jobDetailsContainer.innerText || jobDetailsContainer.textContent || "").trim();

    return {
      title: position,
      company: company,
      description: jobDescription,
      url: jobUrl,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
