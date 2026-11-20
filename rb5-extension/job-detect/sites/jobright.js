// job-detect/sites/jobright.js — JobRight job-detail pages
// (*.jobright.ai/jobs/info/*). Ported from BidHub's own
// packages/job-parsers/content/platforms/jobright/index.js — detection
// only; JobRight has no autofill file in BidHub's manifest, so this is
// the only piece of JobRight support being ported.
(function () {
  "use strict";

  function parserFunc() {
    // h1.index_job-title__Ok618 is JobRight's own role heading on the
    // detail view. JobRight is itself an aggregator (it mirrors postings
    // sourced from many employers' own ATSs), but its detail page already
    // resolves and renders the real employer's name into
    // .index_company-name__sIRIZ directly — unlike some ATS embeds there's
    // no "JobRight" platform branding to filter out of this field, so
    // there's no extra aggregator-vs-platform disambiguation needed here
    // (BidHub's own source reads it straight, same as below).
    var positionElement = document.querySelector("h1.index_job-title__Ok618");
    var position = (positionElement && positionElement.textContent.trim()) || null;

    var companyElement = document.querySelector(".index_company-name__sIRIZ");
    var company = (companyElement && companyElement.textContent.trim()) || null;

    // The JD is assembled from three separate blocks rather than one
    // container: a short "simple introduction" blurb, a "content brief"
    // summary, and then the full set of expandable detail sections
    // (requirements, responsibilities, benefits, etc.), each rendered as
    // its own section.index_sectionContent__prVJT. Concatenating all of
    // them (in DOM order) is the only way to get the complete posting —
    // any one alone is missing most of the JD.
    var jobSimpleIntroductionElement = document.querySelector(
      "div.index_jobSimpleIntroduction__mJLj_"
    );
    var jobContentBriefElement = document.querySelector(
      "div.index_jobContentBrief__uwsMB"
    );
    var jobContentElements = document.querySelectorAll(
      "section.index_sectionContent__prVJT"
    );

    function elementText(element) {
      return (element.innerText || element.textContent || "").trim();
    }

    var jobDescriptionParts = [];
    if (jobSimpleIntroductionElement) {
      jobDescriptionParts.push(elementText(jobSimpleIntroductionElement));
    }
    if (jobContentBriefElement) {
      jobDescriptionParts.push(elementText(jobContentBriefElement));
    }
    for (var i = 0; i < jobContentElements.length; i++) {
      jobDescriptionParts.push(elementText(jobContentElements[i]));
    }
    var jobDescription = jobDescriptionParts.filter(Boolean).join("\n\n");

    return {
      title: position,
      company: company,
      description: jobDescription || null,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
