/* =====================================================================
 * dom/regions.js — JD region isolation
 * =====================================================================
 * cleanRegionText: a region's visible text MINUS page chrome (nav /
 * footer / cookie / share widgets / application forms / "more jobs"
 * CTAs / scripts), reading a deep clone so the live page is never
 * mutated and inserting newlines after block elements so paragraph
 * structure survives without a layout reflow.
 *
 * findJdContainer: anchor on a JD-style heading and climb to the LARGEST
 * ancestor that still excludes sidebar/footer markers — keeps a metadata
 * side panel out of the description while capturing the full JD.
 *
 * Copied VERBATIM from job-fit.js (selector strings byte-identical),
 * with findJdContainer taking an optional `doc` for testability. Dual
 * export.
 * ===================================================================== */
(function () {
  "use strict";

  const cleanRegionText = (region) => {
    if (!region) return "";
    const clone = region.cloneNode(true);
    clone
      .querySelectorAll(
        "script, style, noscript, template, svg, iframe, nav, footer, aside, form, button," +
          "header, [class*='header' i], [id*='header' i], [class*='topbar' i], [class*='masthead' i]," +
          "mat-form-field, mat-mdc-form-field, mat-select, mat-radio-group," +
          "mat-checkbox, mat-radio-button, mat-stepper, mat-step," +
          "[class*='mat-form-field' i], [class*='application-form' i]," +
          "[class*='apply-form' i], [class*='application-section' i]," +
          "[role='button'], a[class*='btn' i], a[class*='button' i]," +
          "[role='navigation'], [role='contentinfo'], [role='banner']," +
          "[class*='footer' i], [id*='footer' i], [class*='cookie' i]," +
          "[class*='share' i], [class*='social' i], [id*='share' i]," +
          "[aria-label*='share' i], [title*='share' i]," +
          "[data-share], [data-social]," +
          "a[href*='facebook.com/sharer'], a[href*='facebook.com/share']," +
          "a[href*='linkedin.com/share'], a[href*='linkedin.com/sharing']," +
          "a[href*='twitter.com/intent'], a[href*='x.com/intent']," +
          "a[href*='wa.me/?text='], a[href*='api.whatsapp.com/send']," +
          "a[href^='mailto:?subject']," +
          "[class*='more-opportunities' i], [class*='moreOpportunities' i]," +
          "[class*='more-jobs' i], [class*='moreJobs' i]," +
          "[class*='more-positions' i], [class*='morePositions' i]," +
          "[class*='similar-jobs' i], [class*='similarJobs' i]," +
          "[class*='related-jobs' i], [class*='relatedJobs' i]," +
          "[class*='other-positions' i], [class*='otherPositions' i]," +
          "[class*='open-positions' i], [class*='openPositions' i]," +
          "[class*='recommended-jobs' i], [class*='recommendedJobs' i]," +
          "[class*='jobs-recommendations' i], [class*='jobsRecommendations' i]," +
          "[class*='all-jobs' i], [class*='allJobs' i]"
      )
      .forEach((el) => el.remove());
    clone
      .querySelectorAll("p, div, li, br, h1, h2, h3, h4, h5, h6, tr, section")
      .forEach((el) => el.append("\n"));
    return (clone.textContent || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  };

  // Markers that betray a structured metadata side panel (Zoho Recruit's
  // "Job Information") or the page footer. Deliberately limited to labels
  // that DON'T occur in normal JD prose — "Date Opened", "Postal Code",
  // "Powered by", etc. — so a JD that legitimately says "5 years of work
  // experience" isn't mistaken for sidebar content.
  const SIDEBAR_MARKERS =
    /(date opened|postal code|powered by|view all jobs|privacy notice|cookie notice|legal notice|share by\s+(facebook|linkedin|twitter|x|whatsapp|email))/i;

  const findJdContainer = (doc) => {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d) return null;
    const heads = Array.from(d.querySelectorAll("h1, h2, h3, h4"));
    const head = heads.find((h) =>
      /\bjob description\b|\babout (the|this) (role|job|position)\b|\brole (summary|description)\b|\bthe (role|opportunity)\b|\bwhat you('| wi)ll do\b/i.test(
        (h.textContent || "").trim()
      )
    );
    if (!head) return null;
    let el = head.parentElement;
    let best = null;
    for (let i = 0; i < 6 && el && el !== d.body; i++) {
      const txt = cleanRegionText(el);
      if (txt.length > 250 && !SIDEBAR_MARKERS.test(txt)) best = el;
      el = el.parentElement;
    }
    return best;
  };

  const api = { cleanRegionText, findJdContainer, SIDEBAR_MARKERS };
  if (typeof window !== "undefined" && window.ProactiveJobDetect) {
    window.ProactiveJobDetect.dom.regions = api;
    window.ProactiveJobDetect.dom.cleanRegionText = cleanRegionText;
    window.ProactiveJobDetect.dom.findJdContainer = findJdContainer;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
