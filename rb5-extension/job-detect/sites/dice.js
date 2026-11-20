// job-detect/sites/dice.js — Dice (dice.com). Ported from BidHub's own
// packages/job-parsers/content/platforms/dice/index.js. Matches both the
// posting page (`/job-detail/<id>`) and the apply wizard
// (`/job-applications/<id>/wizard`) per the manifest content_scripts entry,
// but the parser itself only ever reports from the posting page — the
// wizard has no job-detail markup of its own (just the apply form, which
// autofill/sites/dice-autofill.js owns), so re-detecting there would just
// emit null parses to the panel on every mutation of the form.
(function () {
  "use strict";

  function parserFunc() {
    if (window.location.pathname.includes("job-applications")) {
      return null;
    }

    const positionElement = document.querySelector("h1");
    const position = positionElement?.textContent.trim() || null;

    // Dice's posting layout doesn't mark the employer name with its own
    // class/id — it's just the first anchor inside the sibling container
    // one level up from the <h1>'s own wrapper (h1.parentElement.parentElement
    // .children[0]). Brittle, but this is exactly what BidHub's own source
    // keys off; the existing generic "dice" adapter in
    // job-detect/extractors/adapters/index.js arrived at the identical
        // selector independently, which is corroborating rather than a
    // coincidence — it's the only stable anchor Dice's markup offers.
    const companyElement = positionElement?.parentElement?.parentElement?.children?.[0]?.querySelector("a");
    const company = companyElement?.textContent.trim() || null;

    // The job description isn't one contiguous block on Dice — it's
    // stitched from up to four disjoint regions: two small metadata spans
    // (posted date / employment type, remote-ness) plus the "Job details"
    // and "Company info" sections (identified by their <h2> heading text,
    // since neither has a stable class name). Concatenated in DOM order so
    // the panel gets one description blob instead of four partial ones.
    const metaData1Element = document.querySelector("span.order-3");
    const metaData2Element = document.querySelector("div.order-4");
    const h2Elements = document.querySelectorAll("h2");
    let jobDetailsElement = null;
    let companyInfoElement = null;
    for (const element of h2Elements) {
      const label = element.textContent.trim().toLowerCase();
      if (label === "job details") jobDetailsElement = element;
      if (label === "company info") companyInfoElement = element;
    }

    const elementText = (el) => (el ? (el.innerText || el.textContent || "").trim() : "");

    let jobDescription = "";
    if (metaData1Element) jobDescription += `\n${elementText(metaData1Element)}`;
    if (metaData2Element) jobDescription += `\n${elementText(metaData2Element)}`;
    if (jobDetailsElement?.parentElement) jobDescription += `\n${elementText(jobDetailsElement.parentElement)}`;
    if (companyInfoElement?.parentElement) jobDescription += `\n${elementText(companyInfoElement.parentElement)}`;

    // Position is the only mandatory identity field, same convention as
    // every other per-site parser — an incomplete mid-render parse (h1 not
    // painted yet) reports nothing rather than a bogus partial result.
    if (!position) return null;

    return {
      title: position,
      company,
      description: jobDescription || null,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
