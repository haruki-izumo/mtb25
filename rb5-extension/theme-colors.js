/**
 * Accent colour for the side panel — deliberately the SAME model as the
 * dashboard (proactive-dashboard/src/utils/uiPrefs.js + index.css):
 *
 *   • the same six named presets,
 *   • the same localStorage key ("ab_accent"), storing the KEY not a hex,
 *   • the same mechanism — a `data-accent` attribute on <html> that panel.css
 *     themes off, with the default ("indigo") writing no attribute at all.
 *
 * Keeping the key and the attribute identical means the two surfaces of one
 * product agree, and a curated palette replaces free-form hex entry — which
 * let a user pick something like #13144E for the accent and leave the panel
 * unreadable.
 *
 * Loaded from <head> — before first paint — so a chosen accent never flashes
 * the default first. Plain, idempotent script: no modules, no top-level await.
 */
(function () {
  if (typeof window !== "undefined" && window.ProactiveAccent) return;

  var KEY = "ab_accent";
  var DEFAULT = "indigo"; // the bright blue in :root; writes no attribute

  // Mirrors ACCENTS in the dashboard's uiPrefs.js — keep the two in sync.
  var ACCENTS = [
    { key: "indigo", color: "#00a1ff", label: "Blue" },
    { key: "azure", color: "#0074ba", label: "Deep Blue" },
    { key: "cyan", color: "#01c0c8", label: "Cyan" },
    { key: "violet", color: "#8b5cf6", label: "Violet" },
    { key: "emerald", color: "#10b981", label: "Emerald" },
    { key: "rose", color: "#f43f5e", label: "Rose" },
  ];

  function isKnown(key) {
    for (var i = 0; i < ACCENTS.length; i++) if (ACCENTS[i].key === key) return true;
    return false;
  }

  /** The stored accent, falling back to the default for anything unknown. */
  function load() {
    var v;
    try {
      v = localStorage.getItem(KEY);
    } catch (e) {
      v = null;
    }
    return isKnown(v) ? v : DEFAULT;
  }

  /** DOM only — no persistence. Default clears the attribute so :root wins. */
  function apply(key) {
    var root = document.documentElement;
    if (!root) return;
    if (isKnown(key) && key !== DEFAULT) root.setAttribute("data-accent", key);
    else root.removeAttribute("data-accent");
  }

  window.ProactiveAccent = {
    KEY: KEY,
    DEFAULT: DEFAULT,
    ACCENTS: ACCENTS,
    isKnown: isKnown,
    load: load,
    apply: apply,
  };

  // Drop the key written by the short-lived free-form hex picker so a stale
  // custom palette can't linger in storage.
  try {
    localStorage.removeItem("ab_theme_colors");
  } catch (e) {
    /* non-fatal */
  }

  apply(load()); // before first paint
})();
