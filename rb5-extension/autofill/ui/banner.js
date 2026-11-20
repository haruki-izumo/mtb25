/* =====================================================================
 * ui/banner.js — floating "ProActive auto-filled N fields" banner
 * with Undo, plus the per-field highlight ring.
 * =====================================================================
 * Shadow-DOM-isolated so the host page's CSS can't bleed in. Uses an
 * extremely high z-index (max int) so it sits above modals / sticky
 * headers; positioned top-right because that's where the side panel
 * lives so the user's eye is already there. =========================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill) return;
  const ns = window.ProactiveAutofill;
  if (!ns.core?.reactInput) return;
  const { setReactInputValue } = ns.core.reactInput;

  const HIGHLIGHT_MS = 6000;
  const HOST_ATTR = "data-proactive-autofill-host";

  // ---- User-configurable placement (side panel → Settings) -----------------
  const PREFS = window.__proactiveOverlayPrefs || null;
  let bannerPos = "bottom-left";
  let badgePos = "bottom-left"; // fit badge's corner, for stacking

  /**
   * Place the banner, keeping it clear of the fit badge when BOTH are anchored
   * to the same corner (otherwise they'd sit on top of each other). Different
   * corners need no offset.
   */
  function placeBanner(hostEl) {
    let offset = 16;
    if (bannerPos === badgePos) {
      const badge = document.getElementById("proactive-fit-badge-host");
      if (badge) {
        const r = badge.getBoundingClientRect();
        if (r && r.height) offset = 20 + Math.round(r.height) + 12; // badge edge + its height + gap
      }
    }
    if (PREFS) PREFS.applyPosition(hostEl, bannerPos, offset);
    else Object.assign(hostEl.style, { bottom: offset + "px", left: "16px" });
  }

  function repositionBanner() {
    const el = document.querySelector("[" + HOST_ATTR + "]");
    if (el) placeBanner(el);
  }

  if (PREFS) {
    PREFS.get(PREFS.KEYS.autofill).then((v) => {
      bannerPos = PREFS.normalizePos(v);
      repositionBanner();
    });
    PREFS.get(PREFS.KEYS.fitBadge).then((v) => {
      badgePos = PREFS.normalizePos(v);
      repositionBanner();
    });
    PREFS.onChange((changes) => {
      if (changes[PREFS.KEYS.autofill]) bannerPos = PREFS.normalizePos(changes[PREFS.KEYS.autofill].newValue);
      if (changes[PREFS.KEYS.fitBadge]) badgePos = PREFS.normalizePos(changes[PREFS.KEYS.fitBadge].newValue);
      if (changes[PREFS.KEYS.autofill] || changes[PREFS.KEYS.fitBadge]) repositionBanner();
    });
  }

  function highlightFilledField(el, confidence = "high") {
    if (!el || !el.style) return;
    const COLORS = {
      high:   "rgba(16, 185, 129, 0.55)", // emerald — adapter hit
      preset: "rgba(99, 102, 241, 0.55)", // indigo — preset/canonical
      medium: "rgba(245, 158, 11, 0.55)", // amber — generic heuristic
    };
    const prevShadow = el.style.boxShadow || "";
    const prevTransition = el.style.transition || "";
    el.style.transition = "box-shadow 0.25s ease-out";
    el.style.boxShadow = `0 0 0 3px ${COLORS[confidence] || COLORS.high}`;
    setTimeout(() => {
      el.style.boxShadow = prevShadow;
      el.style.transition = prevTransition;
    }, HIGHLIGHT_MS);
  }

  function removeBanner() {
    if (typeof document === "undefined") return;
    document.querySelectorAll("[" + HOST_ATTR + "]").forEach((n) => n.remove());
  }

  /** Restore every field we touched in the last fill to its prior value. */
  function undoLastFill() {
    const LAST_FILL = ns.LAST_FILL;
    for (const { el, previousValue } of LAST_FILL.elements) {
      if (el && document.body.contains(el)) {
        setReactInputValue(el, previousValue);
      }
    }
    LAST_FILL.elements = [];
    if (LAST_FILL.resumeEl && document.body.contains(LAST_FILL.resumeEl)) {
      try {
        const dt = new DataTransfer();
        LAST_FILL.resumeEl.files = dt.files;
        LAST_FILL.resumeEl.dispatchEvent(new Event("change", { bubbles: true }));
      } catch {/* ignore */}
      LAST_FILL.resumeEl = null;
    }
  }

  ns.ui.banner = {
    HIGHLIGHT_MS,
    HOST_ATTR,
    highlightFilledField,
    removeBanner,
    undoLastFill,
  };
})();
