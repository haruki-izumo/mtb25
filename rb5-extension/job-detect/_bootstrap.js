/* =====================================================================
 * ProActive Job-Detect — namespace bootstrap
 * =====================================================================
 * The detection library, split into plain-JS files (no bundler) that
 * share one `window.ProactiveJobDetect` namespace — the same pattern
 * autofill/_bootstrap.js and job-fit.js use. Each subsequent file
 * attaches its exports to this namespace and fails closed if its
 * dependencies aren't ready, so a manifest mis-order surfaces
 * immediately instead of corrupting detection silently.
 *
 *   window.ProactiveJobDetect.resolver            per-field winner selection
 *   window.ProactiveJobDetect.normalize.{…}       text / country / remote / salary
 *   window.ProactiveJobDetect.dom.{…}             query helpers, region finder
 *   window.ProactiveJobDetect.extractors.structured.{jsonld, microdata, og}
 *   window.ProactiveJobDetect.extractors.adapters[]   ordered site adapters
 *   window.ProactiveJobDetect.extractors.heuristic.{…}
 *   window.ProactiveJobDetect.run()               assemble a DetectionResult
 *
 * Load order (manifest content_scripts, and the panel's files-injection):
 *   _bootstrap.js → resolver.js → normalize/* → dom/* → extractors/* → run.js
 *
 * See ARCHITECTURE.md. This is being built incrementally alongside the
 * existing job-fit.js; the cutover (manifest + panel injection + moving
 * logic out of job-fit.js) is a later, browser-tested increment.
 * ===================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined") return;
  window.ProactiveJobDetect = window.ProactiveJobDetect || {
    VERSION: "0.1.0",
    resolver: {},
    normalize: {},
    dom: {},
    extractors: { structured: {}, adapters: [], heuristic: {} },
  };
})();
