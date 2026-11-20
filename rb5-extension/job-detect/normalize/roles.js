/* =====================================================================
 * normalize/roles.js — out-of-scope role blocklist (pure)
 * =====================================================================
 * The user targets software-DEVELOPER roles. Many postings have similar
 * surface area but are NOT developer roles (support, sales, product /
 * program management, people management, dev-rel, security/field/pre-sales
 * engineering, teaching, marketing, …). matchAvoidRole(title) returns a
 * short label when the JOB TITLE looks like one of those — the fit
 * assessment turns that into a hard "skip".
 *
 * EXTENDING: add an entry to AVOID_ROLE_PATTERNS — { label, re } where re
 * is tested against the lowercased, whitespace-collapsed title. Keep
 * patterns title-shaped (match role nouns like "manager", "analyst",
 * "support", not generic words) so they don't fire on a real dev role.
 *
 * Matched against the TITLE ONLY (never the JD body), and a clear
 * software-IC title is allow-listed first so a broad pattern can't block
 * "Software Engineer" / "Frontend Developer" etc. Pure; dual export.
 * ===================================================================== */
(function () {
  "use strict";

  // A clear software-developer IC title — never blocked, even if a broad
  // avoid pattern would catch a word in it. Requires a dev-specific
  // qualifier (so "Field Service Engineer" / "Security Engineer" are NOT
  // treated as dev), or a standalone "programmer". Deliberately does NOT
  // allow-list a bare "developer" — "Developer Relations / Advocate" must
  // stay blockable.
  const DEV_ROLE_RE =
    /\b(software|back[\s-]?end|front[\s-]?end|full[\s-]?stack|web|mobile|ios|android|systems?|platform|cloud|data|ml|machine[\s-]?learning|ai|firmware|embedded|game|graphics|qa|test[\s-]?automation|sdet|devops|sre|site[\s-]?reliability|blockchain|smart[\s-]?contract|development)\s+(engineer|developer|programmer|architect)\b|\b(software|web|app|application|mobile|game|frontend|backend|full[\s-]?stack)\s+developer\b|\bprogrammer\b/;

  // First match wins; order is informational only (labels are independent).
  const AVOID_ROLE_PATTERNS = [
    { label: "customer/technical support",
      re: /\b(customer|technical|tech|client|it|product|application)\s+support\b|\bsupport\s+(agent|analyst|specialist|representative|rep|associate|advisor|advocate|lead|engineer|coordinator|manager|consultant)\b|\bhelp\s?desk\b|\bservice\s?desk\b/ },
    { label: "customer success",
      re: /\bcustomer\s+success\b|\bclient\s+success\b|\bcustomer\s+experience\b|\bonboarding\s+(manager|specialist)\b/ },
    { label: "sales / account",
      re: /\b(sales|account|revenue)\s+(manager|director|executive|representative|rep|associate|specialist|lead|consultant|development)\b|\baccount\s+executive\b|\bsales\s+engineer\b|\bsdr\b|\bbdr\b|\bbusiness\s+development\b/ },
    { label: "partnerships / channel",
      re: /\bpartner(ship)?s?\s+(manager|director|lead|associate)\b|\bchannel\s+(partner|sales|manager|director)\b|\balliances?\b/ },
    { label: "product / program management",
      re: /\bproduct\s+(manager|owner|lead|director)\b|\bprogram\s+manager\b|\bproject\s+manager\b|\bproduct\s+marketing\b|\bscrum\s+master\b|\bdelivery\s+manager\b/ },
    { label: "people management",
      re: /\b(engineering|software|development|technical|it|qa|product|data)\s+(manager|director)\b|\bmanager,?\s+(engineering|software|development)\b|\bhead\s+of\s+(engineering|product|software|development|technology|data)\b|\b(vp|vice\s+president)\s+(of\s+)?(engineering|product|technology)\b|\bdirector\s+of\s+(engineering|software|product|technology)\b/ },
    { label: "developer relations / advocacy",
      re: /\bdeveloper\s+(relations|advocate|advocacy|evangelist|experience|marketing)\b|\bdevrel\b|\btech(nical)?\s+evangelist\b|\bcommunity\s+(manager|lead|advocate)\b/ },
    { label: "marketing",
      re: /\bmarketing\b|\bgrowth\s+(manager|lead|marketer)\b|\bcontent\s+(writer|strategist|manager|marketer)\b|\bcopywriter\b|\bbrand\s+(manager|lead)\b|\bseo\b|\bdemand\s+gen/ },
    { label: "teaching / coaching",
      re: /\binstructor\b|\bteacher\b|\btutor\b|\bcoach\b|\btrainer\b|\bmentor\b|\bcurriculum\b|\beducator\b|\bfaculty\b|\blecturer\b/ },
    { label: "security",
      re: /\b(information|app(lication)?|operational|cyber|cloud|network|infrastructure|product|offensive)?\s*security\s+(engineer|analyst|architect|specialist|consultant|lead|manager)\b|\bsecurity\s+(engineer|analyst|architect|specialist|consultant|operations)\b|\bappsec\b|\binfosec\b|\bsoc\s+analyst\b|\bpen(etration)?\s*tester\b/ },
    { label: "field / pre-sales / solutions engineering",
      re: /\bfield\s+\w*\s*engineer\b|\bfield\s+(application|service|sales|support)\b|\bsolutions?\s+(engineer|architect|consultant)\b|\bsales\s+engineer\b|\bsupport\s+engineer\b|\bimplementation\s+(engineer|consultant|specialist)\b|\bdeployment\s+engineer\b/ },
    { label: "technical account management",
      re: /\btechnical\s+account\s+manager\b|\baccount\s+manager\b|\bcustomer\s+success\s+manager\b/ },
    { label: "operations / recruiting / HR",
      re: /\b(business|operations?|people|talent)\s+(manager|analyst|partner|specialist|coordinator|lead|operations)\b|\brecruit(er|ing|ment)\b|\bbusiness\s+analyst\b|\bhr\s+(manager|business\s+partner|generalist)\b/ },
  ];

  // ── Server-managed override ─────────────────────────────────────────
  // The dashboard lets each user (and, for the org default, an admin) manage
  // these lists. The panel/content script fetch the resolved set from
  // GET /api/fit-rules, cache it in chrome.storage (ab_fit_rules), and call
  // setRules() to REPLACE the built-in regex lists above with phrase lists:
  //   target: ["software engineer", …]  → allow-list (never skip)
  //   avoid:  [{ label, terms:[…] }]    → skip with that label
  // Matching becomes word-boundary phrase containment on the title. When no
  // override is set (offline / logged-out / not yet fetched) the built-in
  // regexes above are used, so detection never silently goes dark.
  let _custom = null;

  // Wrap a normalized title in spaces so containment is word-boundary safe:
  //   _hasPhrase(_norm("Product Marketing Manager"), "product marketing") → true
  const _norm = (s) => " " + String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim() + " ";
  const _hasPhrase = (normTitle, term) => {
    const p = _norm(term).trim();
    return !!p && normTitle.includes(" " + p + " ");
  };

  /** Install a server-managed rule set (or pass null/empty to fall back to the
   *  built-ins). Kept as a mutator so job-fit.js's captured matchAvoidRole
   *  reference keeps working. */
  function setRules(rules) {
    const target = Array.isArray(rules && rules.target)
      ? rules.target.filter((x) => typeof x === "string" && x.trim())
      : [];
    const avoid = Array.isArray(rules && rules.avoid)
      ? rules.avoid
          .filter((g) => g && typeof g.label === "string" && Array.isArray(g.terms))
          .map((g) => ({ label: g.label, terms: g.terms.filter((t) => typeof t === "string" && t.trim()) }))
          .filter((g) => g.terms.length)
      : [];
    // Only switch to custom mode with a usable avoid list — a garbage/empty
    // payload keeps the built-ins.
    _custom = avoid.length ? { target, avoid } : null;
  }
  /** @returns {string|null} a short label when the title is an out-of-scope
   *  (non-developer) role, else null. */
  function matchAvoidRole(title) {
    const t = String(title || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!t) return null;
    if (_custom) {
      const nt = _norm(t);
      if (_custom.target.some((term) => _hasPhrase(nt, term))) return null; // targeted role — keep
      for (const g of _custom.avoid) {
        if (g.terms.some((term) => _hasPhrase(nt, term))) return g.label;
      }
      return null;
    }
    // Built-in fallback (offline / not yet fetched).
    if (DEV_ROLE_RE.test(t)) return null; // clear software-IC role — keep
    for (const p of AVOID_ROLE_PATTERNS) {
      if (p.re.test(t)) return p.label;
    }
    return null;
  }

  const api = { AVOID_ROLE_PATTERNS, DEV_ROLE_RE, matchAvoidRole, setRules };
  if (typeof window !== "undefined" && window.ProactiveJobDetect) {
    window.ProactiveJobDetect.normalize.roles = api;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
