/* =====================================================================
 * ProActive Auto-fill — namespace bootstrap
 * =====================================================================
 * Content scripts share one isolated world per tab, so we expose every
 * module on a single `window.ProactiveAutofill` namespace and let each
 * file attach its exports. This is the same pattern job-fit.js uses
 * with `window.ProactiveJobFit`.
 *
 *   window.ProactiveAutofill.core.{dom, reactInput, values, types}
 *   window.ProactiveAutofill.detectors.{contact, dropdowns, ...}
 *   window.ProactiveAutofill.handlers.{adapters, presets}
 *   window.ProactiveAutofill.pipeline.{registry, basic, advanced}
 *   window.ProactiveAutofill.ui.banner
 *
 * Files are loaded in manifest dependency order:
 *   _bootstrap.js → core/* → detectors/* → handlers/* → pipeline/* → ui/*
 *
 * Each subsequent file should fail closed if its dependencies aren't
 * ready, so a manifest mis-order surfaces immediately instead of
 * corrupting the page silently. ===================================== */
(function () {
  "use strict";
  if (typeof window === "undefined") return;
  window.ProactiveAutofill = window.ProactiveAutofill || {
    core: {},
    detectors: {},
    /** handlers.{adapters,presets} are NAMESPACE objects for the
     *  helper functions exported by handler modules (pickPreset,
     *  SCREENING_PRESETS, etc.). The actual registered adapter /
     *  preset INSTANCES live in pipeline.registry — adapters and
     *  presets self-register there at load time. */
    handlers: { adapters: {}, presets: {} },
    pipeline: {},
    ui: {},
    /** Per-fill mutable bookkeeping shared across detectors so callers
     *  can undo / re-highlight without threading the state through. */
    LAST_FILL: { elements: [], resumeEl: null },
  };
})();
