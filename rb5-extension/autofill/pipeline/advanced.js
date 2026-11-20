/* =====================================================================
 * pipeline/advanced.js — Advanced Auto-fill = Basic + LLM-aware Q&A.
 * =====================================================================
 * Basic already returns the screening textareas + unfilled dropdowns
 * in `result.questions` / `result.dropdowns`. The side panel batches
 * those through /answer-questions and pushes the answers back via
 * AUTOFILL_FILL_QUESTIONS / AUTOFILL_FILL_DROPDOWNS messages.
 *
 * "Advanced" at this layer is really just "Basic + don't filter the
 * remaining surfaces out before returning". The side panel decides
 * whether to actually call the LLM (Basic mode drops the questions
 * array on the floor, Advanced ships it to /answer-questions). Keeping
 * the pipeline-level distinction thin means a future second layer
 * (e.g. server-side autofill, where we DO want to invoke an LLM
 * synchronously) plugs in here without touching Basic. ============== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill) return;
  const ns = window.ProactiveAutofill;
  if (!ns.pipeline?.basic) return;

  const { runBasic, createContext, BASIC_STEPS } = ns.pipeline.basic;

  /**
   * Run Advanced Auto-fill.
   *
   * Today this is `runBasic` with the result tagged so the side panel
   * knows to invoke /answer-questions on result.questions +
   * result.dropdowns. We keep it as its own function so future LLM-
   * aware steps (in-pipeline answering for a server-side caller) can
   * plug in without touching Basic.
   *
   * @param {import("../core/types.js").FillContext} input
   * @returns {Promise<import("../core/types.js").FillResult>}
   */
  async function runAdvanced(input) {
    const result = await runBasic({ ...input, mode: "advanced" });
    // Reserved for future steps that consume result.questions /
    // result.dropdowns directly (e.g. a sync LLM call). The side
    // panel's existing /answer-questions round-trip stays the
    // public interface for now.
    return result;
  }

  ns.pipeline.advanced = {
    runAdvanced,
    // Re-export so callers (tests, the slim autofill.js entry) only
    // need to import from pipeline.advanced for either mode.
    runBasic,
    createContext,
    BASIC_STEPS,
  };
})();
