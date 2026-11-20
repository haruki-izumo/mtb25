/* =====================================================================
 * core/dom.js — pure DOM utilities
 * =====================================================================
 * Visibility, label resolution, field-signal aggregation. No autofill
 * state, no profile knowledge — every export here is testable against
 * static HTML fixtures alone. ======================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill) return;
  const ns = window.ProactiveAutofill;

  /** Visible AND interactable.  Width/height > 0, not display:none, not
   *  disabled / read-only. Note: this rejects sr-only-style 0×0 inputs,
   *  which is the right default; callers that need to drive a hidden
   *  input (intl-tel-input, role-based radios) should reach for the
   *  wrapper element instead. */
  function isVisible(el) {
    if (!el) return false;
    if (el.disabled || el.readOnly) return false;
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    if (!view) return false;
    const cs = view.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** Recognise placeholder UI inside a custom dropdown's trigger ("Select…", "—", "n/a"). */
  // Tolerates the spacing/decoration ATSes actually ship: "Select...",
  // "Select ..." (Lever puts a SPACE before the ellipsis, which the old
  // literal "select..." never matched), "Select…", "-- Select --",
  // "Select an option", "Please choose".
  // "search" and friends are here too: a TYPEAHEAD select's placeholder is
  // "Search" / "Type to search", and Rippling puts that in aria-label
  // alongside the real aria-labelledby, so the field resolved to "Search".
  const PLACEHOLDER_RE =
    /^\s*(?:-{2,}\s*|—+\s*)?(?:select|choose|please\s+select|please\s+choose|select\s+(?:an?\s+)?option|choose\s+(?:an?\s+)?option|pick\s+one|search|search\s+(?:an?\s+)?option|type\s+to\s+(?:search|filter|select)|start\s+typing|begin\s+typing|search\s+or\s+select|none|n\/a|-{2,}|—+)\s*(?:\.{2,}|…)?\s*(?:-{2,}|—+)?\s*\*?\s*$/i;

  /** Visible text of a <label>, EXCLUDING any form control nested inside
   *  it. Lever wraps the control in the label:
   *    <label><div>Gender</div><select><option>Select ...</option>
   *           <option>Male</option>…</select></label>
   *  so a plain textContent read returned
   *  "GenderSelect ...MaleFemaleDecline to self-identify" — and that
   *  trailing word destroys the `gender\b` boundary every preset regex
   *  relies on, so the field matched NOTHING and was left unfilled.
   *  Stripping the control leaves the actual label ("Gender"). Harmless
   *  for the checkbox case (<label><input> He/him</label> → "He/him"),
   *  since a control contributes no text of its own there. */
  function labelTextOf(labelEl) {
    if (!labelEl) return "";
    try {
      const clone = labelEl.cloneNode(true);
      clone.querySelectorAll("select, option, optgroup, textarea, input, button").forEach((n) => n.remove());
      const t = (clone.textContent || "").replace(/\s+/g, " ").trim();
      if (t) return t;
    } catch { /* cloneNode unsupported — fall through */ }
    return (labelEl.textContent || "").replace(/\s+/g, " ").trim();
  }

  /** Resolve the human label for an arbitrary form control. Tries, in
   *  order: aria-label, aria-labelledby, <label for=id>, enclosing
   *  <label>, ancestors with a label-like child, preceding siblings,
   *  and finally the trigger's own descendant text nodes (for custom
   *  dropdown triggers that put the question inside the trigger itself,
   *  e.g. Greenhouse selects). */
  function labelTextFor(el) {
    if (!el) return "";
    const doc = el.ownerDocument || (typeof document !== "undefined" ? document : null);
    if (!doc) return "";
    // aria-label wins — UNLESS it's just the placeholder. Rippling ships
    //   <div role="combobox" aria-labelledby="field-32-label"
    //        aria-label="Select..."> … and <span id="field-32-label">Gender
    // so returning aria-label first resolved EVERY EEO dropdown's label to
    // "Select...", no preset matched, and Gender / race / Hispanic /
    // disability / pronouns were all silently skipped. Fall through to
    // aria-labelledby (the real label) when aria-label is placeholder text.
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim() && !PLACEHOLDER_RE.test(aria)) return aria.trim();
    const aLabelled = el.getAttribute("aria-labelledby");
    if (aLabelled) {
      // aria-labelledby can list multiple ids; concat their text.
      const ids = aLabelled.split(/\s+/).filter(Boolean);
      const parts = [];
      for (const id of ids) {
        const node = doc.getElementById(id);
        if (node) {
          const t = (node.textContent || "").trim();
          if (t) parts.push(t);
        }
      }
      if (parts.length) return parts.join(" ");
    }
    if (el.id) {
      const lbl = doc.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (lbl) return labelTextOf(lbl);
    }
    const enc = el.closest && el.closest("label");
    if (enc) {
      const t = labelTextOf(enc);
      if (t) return t;
    }

    // Workday + many ATS render labels as siblings outside <label>. Walk
    // up to ~4 parents to find a heading / span / div with a short text.
    // [class*="question" i] + the case-insensitive "i" flag on
    // [class*="label" i] match Ashby's own convention (a plain, un-ARIA'd
    // <div class="ashby-application-form-question-title">) — the exact
    // same addition checkbox-groups.js's own ancestor walk already needed
    // for Ashby's checkbox/radio groups; this shared helper (also used by
    // contact.js and detectors/questions.js) never got it, which is why
    // Ashby's Email field and some single-line/textarea questions were
    // silently undetected even though the matching logic downstream was
    // otherwise fine.
    let parent = el.parentElement;
    for (let i = 0; i < 4 && parent; i++) {
      const cand = parent.querySelector(
        "label, [class*='label' i], [class*='question' i], legend, h1, h2, h3, h4, h5, h6",
      );
      if (cand && cand !== el && cand.textContent.trim()) {
        const t = cand.textContent.trim();
        if (t.length > 0 && t.length < 300) return t;
      }
      parent = parent.parentElement;
    }
    let prev = el.previousElementSibling;
    while (prev) {
      if (/^(LABEL|SPAN|DIV|P|H[1-6])$/.test(prev.tagName) && prev.textContent.trim()) {
        return prev.textContent.trim();
      }
      prev = prev.previousElementSibling;
    }

    // Greenhouse-style trigger: the whole bordered box IS the trigger,
    // and the question text lives INSIDE it as a sibling of the
    // "Select..." placeholder. Walk the trigger's text nodes, prefer
    // question-shaped strings.
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") {
      const candidates = [];
      const walker = doc.createTreeWalker(el, /* NodeFilter.SHOW_TEXT = */ 4, {
        acceptNode(n) {
          const t = (n.nodeValue || "").trim();
          if (!t) return /* FILTER_REJECT */ 2;
          if (PLACEHOLDER_RE.test(t)) return /* FILTER_REJECT */ 2;
          return /* FILTER_ACCEPT */ 1;
        },
      });
      let n;
      while ((n = walker.nextNode())) {
        const t = (n.nodeValue || "").trim();
        if (t.length >= 5 && t.length <= 300) candidates.push(t);
      }
      if (candidates.length > 0) {
        const question = candidates.find((t) =>
          /[?\*]\s*$/.test(t) ||
          /^(why|how|what|when|where|tell|describe|explain|share|do you|are you|have you|would you|can you|please)/i.test(t),
        );
        return question || candidates.sort((a, b) => b.length - a.length)[0];
      }
    }
    return "";
  }

  /** Concatenated string of "label-like" signals for an input. Used by
   *  the contact matcher's pattern testing — kept as an array so each
   *  signal can be tested independently (anchored patterns like
   *  `/^name$/i` can never match a joined string). */
  function fieldSignals(el) {
    return [
      el.name || "",
      el.id || "",
      el.getAttribute("autocomplete") || "",
      el.getAttribute("placeholder") || "",
      el.getAttribute("aria-label") || "",
      el.getAttribute("data-automation-id") || "",
      labelTextFor(el),
    ];
  }

  /** `CSS.escape` polyfill for jsdom (which doesn't ship one by default).
   *  Only escapes the subset of characters that actually appear in
   *  HTML ids — colons, dots, slashes, square brackets, ampersand. */
  function cssEscape(s) {
    if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
    return String(s).replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
  }

  /** Stable temp-id helper. Tags an element with data-proactive-autofill-id
   *  so the side panel can route per-id messages back without holding a
   *  cross-frame reference. Idempotent. */
  function makeTempId(el) {
    if (!el.dataset.proactiveAutofillId) {
      el.dataset.proactiveAutofillId = "pa-" + Math.random().toString(36).slice(2, 10);
    }
    return el.dataset.proactiveAutofillId;
  }

  /** Promise-friendly delay — every pipeline pause funnels through here.
   *
   *  In a BACKGROUND tab Chrome throttles the page's setTimeout (≈1/s,
   *  then 1/min after 5 minutes hidden). Because a fill is a long chain
   *  of small waits, switching tabs mid-run stalled Auto-fill until the
   *  user came back. While the document is hidden we hand the delay to
   *  the extension's service worker, whose timers aren't page-visibility
   *  throttled, so the run finishes in the background.
   *
   *  Falls back to a local timer whenever messaging isn't available or
   *  the worker doesn't answer, so the pipeline can never hang. */
  function wait(ms) {
    const delay = Math.max(0, Number(ms) || 0);
    const local = () => new Promise((r) => setTimeout(r, delay));
    try {
      if (typeof document === "undefined" || !document.hidden) return local();
      const rt = typeof chrome !== "undefined" && chrome.runtime;
      if (!rt || typeof rt.sendMessage !== "function") return local();
      return new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        // Safety net: a terminated / unreachable worker must not hang the
        // run. (This timer is itself throttled while hidden — that's the
        // degraded path, not the normal one.)
        const guard = setTimeout(done, delay + 2000);
        try {
          rt.sendMessage({ type: "PA_WAIT", ms: delay }, () => {
            void rt.lastError; // read so Chrome doesn't log an unchecked error
            clearTimeout(guard);
            done();
          });
        } catch { clearTimeout(guard); done(); }
      });
    } catch { return local(); }
  }

  ns.core.dom = {
    isVisible,
    labelTextFor,
    fieldSignals,
    cssEscape,
    makeTempId,
    wait,
    PLACEHOLDER_RE,
  };
})();
