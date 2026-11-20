/* =====================================================================
 * resolver.js — per-field candidate resolution + confidence scoring
 * =====================================================================
 * The heart of the candidate pipeline (ARCHITECTURE.md §6–7). Many
 * extractors each emit field *candidates* tagged with a source; the
 * resolver scores them (source tier × validation), picks the highest
 * viable one per field, and reports a confidence bucket + the runners-up
 * so the panel can flag a guess instead of presenting it as fact.
 *
 * Pure functions, no DOM. Exposed on the window namespace for the
 * in-page library AND via module.exports for node unit tests — the same
 * dual-export job-fit.js uses.
 * ===================================================================== */
(function () {
  "use strict";

  // Source → base trust (0..1). Keyed by the source string an extractor
  // stamps on a candidate. Namespaced sources ("adapter:greenhouse",
  // "iframe:greenhouse") fall back to their prefix ("adapter", "iframe").
  const SOURCE_TIER = {
    "json-ld": 0.95,
    microdata: 0.9,
    adapter: 0.9, // host-specific site adapter
    "og:site_name": 0.6,
    "dom-h1": 0.6,
    "dom-region": 0.6,
    "dom-slug-heading": 0.65,
    iframe: 0.6, // cross-frame ATS extraction
    "og:title": 0.4,
    "og:description": 0.4,
    "title-split": 0.35,
    "page-title": 0.35,
    hostname: 0.3,
  };
  const DEFAULT_TIER = 0.3;

  const clamp01 = (n) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

  /** Base trust for a source string, resolving "prefix:detail" to prefix. */
  function tierFor(source) {
    if (!source) return DEFAULT_TIER;
    if (SOURCE_TIER[source] != null) return SOURCE_TIER[source];
    const head = String(source).split(":")[0];
    return SOURCE_TIER[head] != null ? SOURCE_TIER[head] : DEFAULT_TIER;
  }

  /**
   * Score a candidate = source tier × validation multiplier. `validation`
   * (default 1) is where field-specific sanity checks apply a penalty or
   * boost, e.g. a generic-looking company ×0.2, a title that equals the
   * company ×0.5, a too-short description ×0.4.
   */
  function score(source, validation) {
    return clamp01(tierFor(source) * (validation == null ? 1 : validation));
  }

  /** Numeric score → UI confidence bucket. */
  function bucket(s) {
    if (s >= 0.8) return "high";
    if (s >= 0.5) return "medium";
    if (s > 0) return "low";
    return "none";
  }

  /** Build a scored candidate. value may be null/"" (filtered at resolve). */
  function candidate(value, source, validation, evidence) {
    return {
      value: value == null ? null : value,
      source: source || "none",
      score: score(source, validation),
      evidence: evidence,
    };
  }

  const isEmpty = (v) =>
    v == null || (typeof v === "string" && v.trim() === "");

  /**
   * Pick the winning candidate for one field: highest score among
   * non-empty candidates at or above `floor`. Returns the value, its
   * source, the confidence bucket, the raw score, and the remaining
   * viable candidates (for debugging / a future "use this instead").
   */
  function resolveField(candidates, floor) {
    const min = floor == null ? 0.25 : floor;
    const viable = (candidates || [])
      .filter((c) => c && !isEmpty(c.value) && c.score >= min)
      .sort((a, b) => b.score - a.score);
    const win = viable[0];
    if (!win) {
      return { value: null, source: "none", confidence: "none", score: 0, alternatives: [] };
    }
    return {
      value: win.value,
      source: win.source,
      confidence: bucket(win.score),
      score: win.score,
      alternatives: viable.slice(1),
    };
  }

  const api = { SOURCE_TIER, tierFor, score, bucket, candidate, resolveField };
  if (typeof window !== "undefined" && window.ProactiveJobDetect) {
    window.ProactiveJobDetect.resolver = api;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
