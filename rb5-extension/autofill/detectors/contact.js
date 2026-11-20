/* =====================================================================
 * detectors/contact.js — generic contact-field heuristic.
 * =====================================================================
 * Best-effort matcher used when no ATS adapter claims the form. Scores
 * each visible input against label / name / id / placeholder / aria
 * text via FIELD_RULES, picks the highest match per key.
 *
 * The matcher is intentionally split from the FILLER. detectContact()
 * returns a FieldMap; the basic pipeline does the actual setReact-
 * InputValue. This way the matcher is pure and testable without a DOM
 * mutation harness. ================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill) return;
  const ns = window.ProactiveAutofill;
  if (!ns.core || !ns.core.dom) return;
  const { isVisible, fieldSignals } = ns.core.dom;

  /** Generic field rules. Order matters only for ties: when two rules
   *  score the same, the LATER one wins (last-match semantics). The
   *  preferred_* rules sit BEFORE first_name / last_name with a higher
   *  score so they win their specific labels but never collide with
   *  the plain inputs. */
  const FIELD_RULES = [
    { key: "email",      types: ["email"], autocomplete: ["email"],
      patterns: [/\be-?mail\b/i], score: 100 },
    // Phone extension MUST come before phone — both rules match "phone"
    // but the extension rule's autocomplete and patterns are stricter,
    // and a tied score would have last-match semantics; placing it first
    // with a higher score makes the intent obvious and immune to
    // reordering.
    { key: "phone_extension",
      autocomplete: ["tel-extension"],
      patterns: [
        /\b(phone\s*(ext|extension)|ext(ension)?\.?\s*(number|#)?|tel\.?\s*ext|telephone\s+extension)\b/i,
        /^\s*ext\.?\s*\*?\s*$/i,
      ],
      score: 105 },
    { key: "phone",      types: ["tel"],   autocomplete: ["tel", "tel-national"],
      patterns: [/\b(phone|mobile|cell)\b/i], score: 100 },
    { key: "linkedin",   patterns: [/linked.?in/i, /linkedin.?(url|profile)?/i], score: 95 },
    { key: "github",     patterns: [/\bgithub\b/i, /github.?(url|profile)?/i], score: 95 },
    { key: "full_name",  autocomplete: ["name"],
      patterns: [/full.?name/i, /^name\s*\*?\s*$/i, /candidate.?name/i, /your.?name/i], score: 90 },
    { key: "preferred_first_name",
      patterns: [
        /preferred.+(?:first|given).?name/i,
        /display.+(?:first|given).?name/i,
        /chosen.+(?:first|given).?name/i,
        /(?:first|given).?name.*\((?:preferred|display|chosen)\)/i,
      ], score: 97 },
    { key: "preferred_last_name",
      patterns: [
        /preferred.+(?:last|family|sur).?name/i,
        /display.+(?:last|family|sur).?name/i,
        /chosen.+(?:last|family|sur).?name/i,
        /(?:last|family|sur).?name.*\((?:preferred|display|chosen)\)/i,
      ], score: 97 },
    { key: "preferred_name",
      patterns: [
        /^preferred\s*name\s*\*?\s*$/i,
        /^display\s*name\s*\*?\s*$/i,
        /^chosen\s*name\s*\*?\s*$/i,
        /^nickname\s*\*?\s*$/i,
        /preferred.+full.?name/i,
        /how.+would.+you.+like.+to.+be.+(?:called|addressed)/i,
        /what.+do.+you.+(?:prefer|go).+by/i,
      ], score: 97 },
    { key: "first_name", autocomplete: ["given-name"],
      patterns: [/first.?name/i, /given.?name/i, /\bf.?name\b/i], score: 95 },
    { key: "last_name",  autocomplete: ["family-name"],
      patterns: [/last.?name/i, /family.?name/i, /surname/i, /\bl.?name\b/i], score: 95 },
    // Decomposed address fields (BambooHR / Workday split City / State /
    // ZIP / Country). These sit ABOVE the generic `location` rule and
    // carry a higher score so "City" no longer gets swallowed by
    // location. `country` is intentionally NOT here — a country picker
    // is usually a dropdown, handled by the country_field screening
    // preset (which also covers plain-text country inputs).
    { key: "city", autocomplete: ["address-level2"],
      patterns: [/^\s*city\b/i, /\bcity\s*\/?\s*town\b/i, /\btown\s*\/?\s*city\b/i, /^\s*town\s*\*?\s*$/i, /\bsuburb\b/i, /\bcity\s*\/\s*municipality\b/i], score: 86 },
    { key: "state_region", autocomplete: ["address-level1"],
      patterns: [/^\s*state\b/i, /\bprovince\b/i, /^\s*region\b/i, /\bcounty\b/i, /state\s*\/?\s*(?:province|region|territory)/i, /\bprefecture\b/i], score: 86 },
    { key: "postal_code", autocomplete: ["postal-code"],
      patterns: [/\bzip\b/i, /zip\s*code/i, /postal\s*code/i, /post\s*code/i, /\bpostcode\b/i, /\bpin\s*code\b/i, /\beir\s*code\b/i], score: 86 },
    // Dedicated postal / street ADDRESS → values.address (preferences
    // .address, else the location string). Sits just ABOVE `location`
    // and slightly higher-scored so a real "Address" / "Street address"
    // box prefers the configured address, while "where based" / "current
    // location" stay on the location value below.
    { key: "address", autocomplete: ["street-address", "address-line1"],
      patterns: [/\b(?:street\s*address|address\s*line\s*\d?|mailing\s+address|home\s+address|residential\s+address|postal\s+address|full\s+address)\b|^\s*address\b|^\s*street\s*$/i], score: 82 },
    { key: "location",
      patterns: [/\b(?:location|where.*based|current.?location|based\s+in|current\s+city)\b/i], score: 80 },
  ];

  /** Pick the highest-scoring rule for an input. Patterns are tested
   *  against EACH signal individually (anchored regexes like
   *  /^name$/i never match a joined multi-signal string). Returns
   *  {key, score} or null. */
  function bestMatchFor(el) {
    const sigList = fieldSignals(el).map((s) => String(s || "").trim().toLowerCase());
    const type = (el.type || "").toLowerCase();
    // Treat inputmode as an equivalent type signal. Ashby / some React
    // form kits render phone & email as <input type="text"
    // inputmode="tel|email"> with no type="tel"/"email", so a
    // types:["tel"] rule missed them and the field went unfilled
    // ("phone / email sometimes not working"). inputmode "numeric" is
    // NOT mapped — it's too generic (any number field) to imply phone.
    const inputmode = (el.getAttribute("inputmode") || "").toLowerCase();
    const types = new Set([type]);
    if (inputmode === "tel") types.add("tel");
    if (inputmode === "email") types.add("email");
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    let best = null;
    for (const rule of FIELD_RULES) {
      let s = 0;
      if (rule.types && rule.types.some((t) => types.has(t))) s = Math.max(s, rule.score);
      if (rule.autocomplete && rule.autocomplete.includes(ac)) s = Math.max(s, rule.score);
      if (rule.patterns) {
        outer: for (const p of rule.patterns) {
          for (const sig of sigList) {
            if (sig && p.test(sig)) { s = Math.max(s, rule.score - 10); break outer; }
          }
        }
      }
      if (s > 0 && (!best || s > best.score)) best = { key: rule.key, score: s };
    }
    if (best && best.score >= 70) return best;
    return null;
  }

  /**
   * Build a FieldMap from generic heuristics over a document.
   * @param {Document} [doc=document]
   * @returns {import("../core/types.js").FieldMap}
   */
  function detectContact(doc) {
    const root = doc || (typeof document !== "undefined" ? document : null);
    if (!root) return {};
    const map = {};
    const sel = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file])';
    for (const el of root.querySelectorAll(sel)) {
      if (!isVisible(el)) continue;
      const m = bestMatchFor(el);
      if (!m) continue;
      // First match per key wins — the *real* "First Name" field gets
      // first_name; a "Preferred First Name" later in the form picks up
      // its own preferred_first_name key.
      if (!map[m.key]) map[m.key] = el;
    }
    return map;
  }

  ns.detectors.contact = {
    FIELD_RULES,
    bestMatchFor,
    detectContact,
  };
})();
