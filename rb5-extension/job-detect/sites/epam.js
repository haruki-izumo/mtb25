/* =====================================================================
 * job-detect/sites/epam.js — EPAM's own careers site
 * (careers.epam.com), a Next.js app whose vacancies live at
 * /<lang>/vacancy/<slug>-<bltId>_<lang>. Ported from BidHub's own
 * packages/job-parsers/content/platforms/epam/index.js.
 * =====================================================================
 * Everything is read from the rendered DOM. The markup is CSS-modules,
 * so every class carries a per-build hash
 * ("Description_container__VxWne") — match on the stable prefix, never
 * the full class. Where EPAM ships a data-testid we prefer that: those
 * survive rebuilds untouched.
 *
 * The application form opens in a MODAL on the same URL (no
 * navigation), so the posting data stays parseable for the whole apply
 * flow and needs no re-parse step.
 * ===================================================================== */
(function () {
  "use strict";

  function parserFunc() {
    function norm(value) {
      return String(value ?? "").replace(/\s+/g, " ").trim();
    }

    // Title: the banner <h1>, which carries
    // data-testid="job-details-banner-title" — an exact match, unlike the
    // "JobDetailsBanner_title__*" prefix that would also catch a sibling
    // component named with the same stem. It is also the only <h1> on the
    // page. document.title is "<Position> | <marketing tagline> With
    // EPAM", so the last-resort fallback keeps only the part before the
    // pipe.
    const rawTitle =
      document.querySelector('[data-testid="job-details-banner-title"]')?.textContent ||
      document.querySelector('[class*="JobDetailsBanner_title"]')?.textContent ||
      document.querySelector("h1")?.textContent ||
      document.title.split("|")[0];
    const position = norm(rawTitle) || null;

    // careers.epam.com is single-employer, so there is no per-vacancy
    // employer element — the site name in the head is the only name the
    // page states.
    const company = "EPAM Systems";

    // The body is "Description_container__*" / data-testid="description-
    // container", which wraps two sibling blocks: the intro paragraph
    // ("description-content") and the Responsibilities / Requirements /
    // Nice to have / We offer accordions ("categories-container"). Both
    // are always rendered — the intro is only *visually* truncated and
    // the accordions keep their content in the DOM when collapsed — so
    // reading the parent's rendered text captures the full posting (the
    // intro's own "-webkit-line-clamp:14" style only affects its on-page
    // layout, not the text read back here).
    //
    // Optional-chained on purpose: the script can run before the page's
    // preloader/skeleton pass finishes, so the container can be missing
    // on an early tick. Returning null here (rather than throwing) lets
    // the shared MutationObserver retry cleanly on the next mutation.
    const descriptionContainer = document.querySelector('[data-testid="description-container"]');
    const description =
      (descriptionContainer?.innerText || descriptionContainer?.textContent || "").trim() || null;

    if (!position || !company || !description) return null;
    return { title: position, company, description };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
