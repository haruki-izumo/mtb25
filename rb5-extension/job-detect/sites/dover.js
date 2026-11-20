// job-detect/sites/dover.js — Dover (app.dover.io / app.dover.com) ATS
// application pages. Ported from BidHub's own
// packages/job-parsers/content/platforms/dover/index.js.
(function () {
  "use strict";

  function parserFunc() {
    const title = document.title;
    let position = null;
    let company = null;
    let jobDescription = null;

    // Dover sets <title> to "Apply for <Position> at <Company>" on its
    // application pages — slice past the fixed "Apply for" prefix (9
    // chars) and split on " at ".
    if (title.toLowerCase().startsWith("apply for")) {
      const titleData = title.substring(9);
      const segments = titleData.split(" at ");
      if (segments.length >= 2) {
        position = segments[0].trim();
        company = segments[1].trim();
      }
    }

    // The job description sits in a MuiBox sibling just above the
    // <form>'s great-grandparent wrapper — Dover's React tree renders the
    // posting copy and the application form as adjacent siblings with no
    // shared, more specific hook than that DOM position.
    const form = document.querySelector("form");
    if (form) {
      const jdWrapperElement = form.parentElement?.parentElement?.previousElementSibling;
      const jdElement = jdWrapperElement?.querySelector("div.MuiBox-root");
      if (jdElement) jobDescription = (jdElement.innerText || jdElement.textContent || "").trim() || null;
    }

    return { title: position, company, description: jobDescription };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
