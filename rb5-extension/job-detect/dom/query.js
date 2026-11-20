/* =====================================================================
 * dom/query.js — DOM query helpers
 * =====================================================================
 * firstText: return the trimmed text of the first selector that matches
 * and has content (innerText preferred, textContent fallback) — the
 * workhorse every site adapter uses to pull a title / company /
 * description off a known container.
 *
 * Copied from job-fit.js's nested helper, with one safe addition: an
 * optional `doc` argument (defaults to the global document) so the
 * function is unit-testable against a jsdom document without touching
 * globals. In-page callers pass nothing and get the original behavior.
 * Dual export.
 * ===================================================================== */
(function () {
  "use strict";

  const firstText = (selectors, doc) => {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d) return "";
    for (const sel of selectors) {
      const el = d.querySelector(sel);
      const text = el && (el.innerText || el.textContent || "").trim();
      if (text) return text;
    }
    return "";
  };

  const api = { firstText };
  if (typeof window !== "undefined" && window.ProactiveJobDetect) {
    window.ProactiveJobDetect.dom.firstText = firstText;
    window.ProactiveJobDetect.dom.query = api;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
