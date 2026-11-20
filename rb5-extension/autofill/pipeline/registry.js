/* =====================================================================
 * pipeline/registry.js — adapter + preset registration.
 * =====================================================================
 * Plugin entry-point for new ATSes / new screening presets. Adapters
 * and presets self-register at load time via this module; the pipeline
 * iterates the registry to pick an active adapter and to match presets
 * against question labels.
 *
 * Public API:
 *   registerAdapter(adapter)              — add to the ordered list.
 *   registerPreset(preset)                — append to the preset list.
 *   pickAdapter(host)                     — first adapter whose
 *                                            hostTest matches.
 *   getPresets()                          — live preset array.
 *
 * Adding a new ATS: write `handlers/adapters/yourATS.js` that calls
 * registerAdapter({...}) and add it to the manifest js[] list. No core
 * change. =========================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill) return;
  const ns = window.ProactiveAutofill;

  /** @type {import("../core/types.js").Adapter[]} */
  const adapters = [];
  /** @type {import("../core/types.js").Preset[]} */
  const presets = [];

  function registerAdapter(adapter) {
    if (!adapter || typeof adapter.hostTest !== "function" || typeof adapter.detect !== "function") {
      throw new TypeError("registerAdapter: requires { name, hostTest, detect }");
    }
    // Don't register the same adapter twice — handy for hot-reload
    // during dev.
    if (!adapters.some((a) => a.name === adapter.name)) {
      adapters.push(adapter);
    }
  }

  function registerPreset(preset) {
    // Duck-type the regex check — `instanceof RegExp` fails across
    // realms (jsdom contexts, iframes, etc.). Anything with a
    // .test() method is treated as a regex-like for matching purposes.
    if (!preset || !preset.key || !preset.match || typeof preset.match.test !== "function") {
      throw new TypeError("registerPreset: requires { key, match: RegExp, kind, ... }");
    }
    if (!presets.some((p) => p.key === preset.key)) {
      presets.push(preset);
    }
  }

  function pickAdapter(host) {
    const h = host || (typeof window !== "undefined" && window.location?.hostname) || "";
    for (const a of adapters) {
      try { if (a.hostTest(h)) return a; }
      catch {/* defensive — broken adapter shouldn't block others */}
    }
    return null;
  }

  function getPresets()  { return presets.slice(); }

  ns.pipeline.registry = {
    registerAdapter,
    registerPreset,
    pickAdapter,
    getPresets,
  };
})();
