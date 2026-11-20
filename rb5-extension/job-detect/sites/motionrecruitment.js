// job-detect/sites/motionrecruitment.js — motionrecruitment.com job view
// (Next.js). Ported from BidHub's own
// packages/job-parsers/content/platforms/motionrecruitment/index.js.
//
// Class names are CSS-module generated with a stable `<Component>_module_
// <name>` shape but the component prefix has moved (Job_ → JobView_), so
// match the stable suffix rather than the prefix. Motion is a staffing
// agency: the posting body is the client's brief but the applicant applies
// to Motion Recruitment, so that is the company.
//
// A dead/unknown posting renders the site's 404 view on the SAME url shape
// (`NotFoundView_module_*`, h1 "Ooops, 404."), so a bare `h1` is not
// enough: only the job view's own heading counts, otherwise the 404
// title would be registered as a job.
(function () {
  "use strict";

  function parseMotionRecruitmentJob(root = document) {
    if (root.querySelector('[class*="NotFoundView_module"]')) return null;
    const jobView = root.querySelector('[class*="JobView_module"]');
    const positionElement =
      root.querySelector('h1[class*="JobView_module_h1"]') || (jobView ? root.querySelector("h1") : null);
    const position = positionElement?.textContent?.trim();
    if (!position) return null;

    const jdElement = root.querySelector('[class*="jobDescription"], div[class^="Job_jobDescription"]');
    return {
      title: position,
      company: "Motion Recruitment",
      description: jdElement ? (jdElement.innerText || jdElement.textContent || "").trim() || null : null,
    };
  }

  function parserFunc() {
    return parseMotionRecruitmentJob();
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
