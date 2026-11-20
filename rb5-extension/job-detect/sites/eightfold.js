// job-detect/sites/eightfold.js — Eightfold AI-hosted careers sites
// (*.eightfold.ai/careers...). Ported from BidHub's own
// packages/job-parsers/content/platforms/eightfold/index.js.
(function () {
  "use strict";

  function parserFunc() {
    const positionElement = document.querySelector("h1.position-title");
    const position = positionElement?.textContent?.trim() || null;
    if (!position) return null;

    const jobDescriptionElement = document.querySelector("div.position-job-description-column");
    const jobDescription = jobDescriptionElement
      ? (jobDescriptionElement.innerText || jobDescriptionElement.textContent || "").trim() || null
      : null;
    if (!jobDescription) return null;

    return {
      title: position,
      // Company-less rule: explicit null = "no employer named here" (the key used to be omitted).
      company: null,
      description: jobDescription,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
