/**
 * Shared placement/style for the overlays ProActive injects into the page:
 * the job-fit badge and the auto-fill banner. (A third — the toast stack —
 * used to live here too; every toast, in-page or in-panel, now renders
 * inside the extension panel itself via panelToast in sidepanel.js, so
 * there's no in-page toast overlay left to position.)
 *
 * Used to be user-configurable (a Settings dialog let each one be placed
 * independently) — that whole settings screen is gone now, so every overlay
 * is permanently bottom-right / the "card" badge style. get() below always
 * resolves to these fixed values; chrome.storage is no longer read at all
 * (nothing writes to it anymore either, since the settings UI that used to
 * is gone).
 *
 * Loaded as the first file of both content-script entries (and importable by
 * the side panel), so it must stay a plain, idempotent script — no modules, no
 * top-level await. Both content-script entries share one isolated world per
 * frame, so the guard below keeps a second load from clobbering the first.
 */
(function () {
  if (typeof window !== "undefined" && window.__proactiveOverlayPrefs) return;

  const KEYS = {
    fitBadge: "ab_pos_fitbadge",
    autofill: "ab_pos_autofill",
    fitBadgeStyle: "ab_style_fitbadge",
  };

  const DEFAULTS = {
    [KEYS.fitBadge]: "bottom-right",
    [KEYS.autofill]: "bottom-right",
    [KEYS.fitBadgeStyle]: "card",
  };

  const POSITIONS = [
    "top-left",
    "top-center",
    "top-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
  ];

  function normalizePos(p) {
    return POSITIONS.indexOf(p) >= 0 ? p : "bottom-right";
  }

  /**
   * Absolute-edge offsets for a position:fixed host. Every side is reset so a
   * host can be re-positioned in place without stale left/right sticking.
   */
  function positionStyle(pos, offset) {
    const p = normalizePos(pos);
    const dash = p.indexOf("-");
    const vert = p.slice(0, dash); // top | bottom
    const horiz = p.slice(dash + 1); // left | center | right
    const s = { top: "auto", bottom: "auto", left: "auto", right: "auto", transform: "none" };
    s[vert] = offset + "px";
    if (horiz === "left") s.left = offset + "px";
    else if (horiz === "right") s.right = offset + "px";
    else {
      s.left = "50%";
      s.transform = "translateX(-50%)";
    }
    return s;
  }

  function applyPosition(el, pos, offset) {
    if (!el) return;
    const s = positionStyle(pos, offset);
    el.style.top = s.top;
    el.style.bottom = s.bottom;
    el.style.left = s.left;
    el.style.right = s.right;
    el.style.transform = s.transform;
  }

  /** Always resolves to the fixed default now — nothing writes to
   *  chrome.storage for these keys anymore, so there's nothing to read. Stays
   *  async (a resolved Promise) so every existing caller's `await` still
   *  works unchanged. */
  function get(key) {
    return Promise.resolve(DEFAULTS[key]);
  }

  /** Fire `cb(changes)` whenever any overlay pref changes. */
  function onChange(cb) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes) return;
        for (const k in KEYS) {
          if (changes[KEYS[k]]) {
            cb(changes);
            return;
          }
        }
      });
    } catch {
      /* storage events unavailable — overlays keep their current placement */
    }
  }

  const api = {
    KEYS,
    DEFAULTS,
    POSITIONS,
    normalizePos,
    positionStyle,
    applyPosition,
    get,
    onChange,
  };

  if (typeof window !== "undefined") window.__proactiveOverlayPrefs = api;
})();
