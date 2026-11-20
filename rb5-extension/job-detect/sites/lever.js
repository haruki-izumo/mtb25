// job-detect/sites/lever.js — Lever (jobs.lever.co + EU/regional mirrors).
// Ported from BidHub's own
// packages/job-parsers/content/platforms/lever/index.js — this is the
// deterministic, exact-markup version Big Banana runs on jobs.lever.co
// instead of the generic "lever" entry in
// job-detect/extractors/adapters/index.js (which guesses the title from
// ".posting-headline h2"/"h2"/"h1" — a heading that a themed/company-CSS
// Lever board sometimes hides or restyles past recognition). <title> is
// far more reliable here because Lever itself sets it server-side on
// every posting view, themed or not.
(function () {
  "use strict";

  function parserFunc() {
    // Lever renders <title> as "<Company> - <Position>" on every posting
    // page. splitIndex >= 2 requires at least a 2-character company name
    // before the dash — guards against a bare "- Position" (no company)
    // or a title with no dash at all (e.g. a non-posting page under the
    // same host, mid-navigation) from being misread as the company.
    const title = document.title;
    const splitIndex = title.indexOf("-");
    let company = null;
    let position = null;
    let jobDescription = null;

    if (splitIndex >= 2) {
      company = title.substring(0, splitIndex).trim();
      position = title.substring(splitIndex + 1).trim();
    }

    // Position is the only mandatory identity field — see the
    // "Company-less" rule in job-detect/extractors/adapters/index.js's
    // own lever entry: `company: null` just means "this page names no
    // employer" and jobcore accepts it. A page that doesn't even yield a
    // position isn't a real posting view, so report nothing.
    if (!position) return null;

    // data-qa="job-description" is Lever's own hook; .posting-requirements
    // is the older template that predates it. Both sit inside a shared
    // ".content" wrapper that also carries the posting's header/location/
    // commitment info — grabbing the whole wrapper (not just the
    // description node) keeps that context in the extracted HTML, same
    // as BidHub's own source. A posting page whose markup doesn't match
    // either selector, or whose description node unexpectedly has no
    // ".content" ancestor, throws here — the shared engine's mutation
    // handler swallows that silently and the next debounced re-run (the
    // DOM is still settling) picks it up once the real markup lands.
    const jobDescriptionElement = document.querySelector(
      'div[data-qa="job-description"], .posting-requirements'
    );
    if (!jobDescriptionElement) return null;
    const contentElement = jobDescriptionElement.closest(".content");
    jobDescription = (contentElement.innerText || contentElement.textContent || "").trim();

    return {
      title: position,
      company: company || null,
      description: jobDescription,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
