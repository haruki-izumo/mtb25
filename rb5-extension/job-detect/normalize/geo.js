/* =====================================================================
 * normalize/geo.js — country / region / remote-eligibility logic (pure)
 * =====================================================================
 * Canonicalize a free-text country, understand regional umbrellas
 * (Europe / EMEA / North America …), parse a "Remote (A; B; C)"
 * allow-list, and decide whether a posting is location-restricted away
 * from the candidate's country. Copied VERBATIM from job-fit.js so there
 * is zero logic divergence during the migration; job-fit.js's assessFit
 * will consume these once job-detect is wired in.
 *
 * Pure functions, no DOM. Dual export: window namespace + module.exports.
 * ===================================================================== */
(function () {
  "use strict";

  const COUNTRY_ALIASES = {
    "usa": "United States", "u.s.": "United States", "u.s.a.": "United States",
    "us": "United States", "united states": "United States", "america": "United States",
    "uk": "United Kingdom", "u.k.": "United Kingdom", "united kingdom": "United Kingdom",
    "great britain": "United Kingdom", "britain": "United Kingdom", "england": "United Kingdom",
    "uae": "United Arab Emirates", "united arab emirates": "United Arab Emirates",
    "germany": "Germany", "deutschland": "Germany", "france": "France", "spain": "Spain",
    "españa": "Spain", "poland": "Poland", "polska": "Poland", "netherlands": "Netherlands",
    "holland": "Netherlands", "italy": "Italy", "portugal": "Portugal", "ireland": "Ireland",
    "sweden": "Sweden", "norway": "Norway", "switzerland": "Switzerland", "austria": "Austria",
    "belgium": "Belgium", "denmark": "Denmark", "finland": "Finland", "czech republic": "Czechia",
    "czechia": "Czechia", "slovakia": "Slovakia", "hungary": "Hungary", "romania": "Romania",
    "bulgaria": "Bulgaria", "greece": "Greece", "croatia": "Croatia", "slovenia": "Slovenia",
    "estonia": "Estonia", "latvia": "Latvia", "lithuania": "Lithuania", "ukraine": "Ukraine",
    "canada": "Canada", "australia": "Australia", "new zealand": "New Zealand",
    "india": "India", "singapore": "Singapore", "japan": "Japan", "brazil": "Brazil",
    "mexico": "Mexico", "israel": "Israel", "turkey": "Turkey", "luxembourg": "Luxembourg",
    // Commonly-targeted remote-hiring countries (were missing, so a
    // profile in any of these canonicalized to "" and could never be
    // matched against a posting's allow-list).
    "philippines": "Philippines", "argentina": "Argentina", "egypt": "Egypt",
    "nigeria": "Nigeria", "kenya": "Kenya", "south africa": "South Africa",
    "indonesia": "Indonesia", "vietnam": "Vietnam", "viet nam": "Vietnam",
    "pakistan": "Pakistan", "bangladesh": "Bangladesh", "colombia": "Colombia",
    "chile": "Chile", "peru": "Peru", "uruguay": "Uruguay", "ecuador": "Ecuador",
    "costa rica": "Costa Rica", "dominican republic": "Dominican Republic",
    "ghana": "Ghana", "morocco": "Morocco", "thailand": "Thailand",
    "malaysia": "Malaysia", "south korea": "South Korea", "taiwan": "Taiwan",
    "hong kong": "Hong Kong", "china": "China", "nepal": "Nepal",
    "sri lanka": "Sri Lanka", "saudi arabia": "Saudi Arabia",
  };

  function canonicalCountry(text) {
    const s = String(text || "").toLowerCase();
    const keys = Object.keys(COUNTRY_ALIASES).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      const re = new RegExp(`(?:^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z])`);
      if (re.test(s)) return COUNTRY_ALIASES[k];
    }
    return "";
  }

  // European countries we recognize, so a posting that allows "Remote
  // (Europe)" / "EMEA" / "EU" is understood to include an EU-based candidate.
  const EUROPEAN_COUNTRIES = new Set([
    "United Kingdom", "Ireland", "Germany", "France", "Spain", "Netherlands",
    "Italy", "Portugal", "Sweden", "Norway", "Switzerland", "Austria",
    "Belgium", "Denmark", "Finland", "Czechia", "Slovakia", "Hungary",
    "Romania", "Bulgaria", "Greece", "Croatia", "Slovenia", "Estonia",
    "Latvia", "Lithuania", "Poland", "Ukraine", "Luxembourg",
  ]);

  // Asia / APAC countries, so "Remote (Asia)", "APAC", or an "Asia–Europe
  // overlap" posting is understood to include an Asia-based candidate. (The
  // Philippines lives here — the case that motivated adding a standalone Asia
  // region, since "APAC"/"Asia-Pacific" alone doesn't match a bare "Asia".)
  const ASIA_PACIFIC_COUNTRIES = new Set([
    "Philippines", "India", "Singapore", "Japan", "Indonesia", "Vietnam",
    "Pakistan", "Bangladesh", "Thailand", "Malaysia", "South Korea", "Taiwan",
    "Hong Kong", "China", "Nepal", "Sri Lanka", "Saudi Arabia",
    "Australia", "New Zealand",
  ]);

  // Regional umbrella terms that show up in remote-location allow-lists.
  // `covers(home)` answers "does this region include the candidate's country?"
  const REGION_TOKENS = [
    { label: "Worldwide", re: /\b(?:anywhere|world ?wide|global(?:ly)?|any country|any location|fully distributed)\b/, covers: () => true },
    { label: "Europe", re: /\b(?:europe|european union|eu|eea|emea|schengen|nordics?|benelux|dach|cee|central europe|eastern europe|western europe|southern europe|northern europe)\b/, covers: (home) => EUROPEAN_COUNTRIES.has(home) },
    { label: "North America", re: /\b(?:north america|americas)\b/, covers: (home) => ["United States", "Canada", "Mexico"].includes(home) },
    { label: "Asia", re: /\b(?:asia|apac|asia[\s-]?pacific|south[\s-]?east asia|se ?asia)\b/, covers: (home) => ASIA_PACIFIC_COUNTRIES.has(home) },
    { label: "LATAM", re: /\b(?:latam|latin america|south america)\b/, covers: (home) => ["Brazil", "Mexico"].includes(home) },
  ];

  // Parse the locations named in a "Remote (…)" / "Remote - …" clause, which
  // ENUMERATE where remote work is allowed. Splits the list on common
  // separators (; , / | "and" "or") and records, for each entry, the
  // canonical country or regional umbrella it names — plus whether any of
  // them covers `home`. `labels` is the de-duplicated allow-list for display.
  function parseRemoteLocations(segment, home) {
    const inner = String(segment || "").split(")")[0];
    // Split on the usual list separators PLUS newlines: stacked layouts
    // render "Canada; Europe; United States" with a line break between
    // each entry, and without \n here a multi-line list collapses to a
    // single run that only the first country is parsed from.
    const parts = inner.split(/[;,/|\n\r]|\bor\b|\band\b|&|\+/).map((p) => p.trim()).filter(Boolean);
    const labels = [];
    let homeCovered = false;
    for (const part of parts) {
      for (const region of REGION_TOKENS) {
        if (region.re.test(part)) {
          labels.push(region.label);
          if (region.covers(home)) homeCovered = true;
        }
      }
      const c = canonicalCountry(part);
      if (c) {
        labels.push(c);
        if (home && c === home) homeCovered = true;
      }
      // Entries that name neither a country nor a region ("only", "remote",
      // stray words) are ignored.
    }
    return { labels: Array.from(new Set(labels)), homeCovered };
  }

  function detectCountryRestriction(hay, profileCountry) {
    const home = canonicalCountry(profileCountry);

    // Without a known candidate country we can't assess location fit, so
    // never emit a "skip" on a guess. Otherwise a "Remote - Philippines" /
    // "based in Philippines" posting reads as "restricted to Philippines"
    // when the profile country is empty/unrecognized — a false skip on a
    // role the candidate is actually eligible for.
    if (!home) return "";

    // "Remote (Canada; Europe; United States)" and friends are ALLOW-LISTS,
    // not single-country locks. Parse the whole list and only flag when the
    // candidate's country (or a region covering it) is absent. Handling this
    // before the generic patterns is what stops a multi-region posting from
    // being mis-read as "restricted to" only its first listed location.
    //
    // A parenthetical "remote ( … )" is captured up to the closing paren
    // INCLUDING newlines — stacked layouts put each location on its own
    // line, and stopping at the first newline truncated the list to just
    // its first entry (e.g. flagging "restricted to Canada" on a posting
    // open to Canada/Europe/US). The dash form "remote - …" has no closing
    // delimiter, so it stays single-line to avoid swallowing later text.
    // Collect EVERY parenthetical "remote ( … )" clause and union them.
    // Per-country pill layouts (wellfound et al.) render one parenthetical
    // per eligible country — "Remote (for India residents)", "Remote (for
    // Philippines residents)", … — as separate pills. Matching only the
    // FIRST wrongly flagged "restricted to India" on a posting whose other
    // pills include the candidate's country. If ANY pill covers the home
    // country, the candidate is eligible.
    const parenRe = /\bremote\b\s*\(\s*([^)]{1,200})\)/g;
    let pm;
    let sawParen = false;
    let parenHomeCovered = false;
    const parenLabels = [];
    while ((pm = parenRe.exec(hay)) !== null) {
      sawParen = true;
      const { labels, homeCovered } = parseRemoteLocations(pm[1], home);
      parenLabels.push(...labels);
      if (homeCovered) parenHomeCovered = true;
    }
    if (sawParen && parenLabels.length) {
      if (parenHomeCovered) return ""; // candidate is explicitly eligible
      const list = Array.from(new Set(parenLabels)).join(", ");
      return home
        ? `Location-restricted to ${list} (your profile is in ${home}).`
        : `Location-restricted to ${list}.`;
    }

    // The dash form "Remote - <location list>" has no closing delimiter, so
    // it stays single-line to avoid swallowing later text. The dash MUST be
    // a real separator (whitespace before it), so the compound words
    // "remote-first" / "remote-friendly" / "remote-only" are NOT read as
    // "Remote - <location list>". Without this, a culture line like
    // "Remote-first … with teammates in the US, Poland" was parsed as an
    // allow-list and wrongly flagged a Philippines profile.
    const remoteClause = hay.match(/\bremote\b\s+[\-–]\s*([^)\n]{1,140})/);
    if (remoteClause) {
      const { labels, homeCovered } = parseRemoteLocations(remoteClause[1], home);
      if (labels.length) {
        if (homeCovered) return ""; // candidate is explicitly eligible
        const list = labels.join(", ");
        return home
          ? `Location-restricted to ${list} (your profile is in ${home}).`
          : `Location-restricted to ${list}.`;
      }
      // No parseable location in the clause ("remote-first", "remote - we…") —
      // fall through to the generic restriction patterns below.
    }

    // Ashby / Greenhouse / Lever pages put the location list under a
    // standalone "Location" or "Locations" label, not inside a parenthetical:
    //
    //   Location
    //   Ukraine, Remote; Krakow; Lithuania; Spain; Warsaw
    //
    //   Employment Type
    //   Full time
    //
    // Treat that as an allow-list too — only when the captured segment
    // mentions "remote" AND contains a multi-entry separator, so we don't
    // mis-grab arbitrary text following an unrelated mention of the word
    // "location" in a JD body.
    const locHeaderMatch = hay.match(/(?:^|\n)\s*locations?\s*\n+([^\n]{10,400})/);
    if (
      locHeaderMatch &&
      /\bremote\b/.test(locHeaderMatch[1]) &&
      /[,;]/.test(locHeaderMatch[1])
    ) {
      const { labels, homeCovered } = parseRemoteLocations(locHeaderMatch[1], home);
      if (labels.length) {
        if (homeCovered) return "";
        const list = labels.join(", ");
        return home
          ? `Location-restricted to ${list} (your profile is in ${home}).`
          : `Location-restricted to ${list}.`;
      }
    }

    // Explicit candidate-location targeting that NAMES the home country.
    // "sourcing candidates based in Argentina, the Philippines, or Egypt",
    // "open to candidates in X, Y or Z", "hiring in X / Y", "eligible to
    // work in <Home>". When the post says it hires in the candidate's own
    // country, they're eligible — and this MUST win over stray "US Eastern
    // time" / "authorized to work in the United States" boilerplate that
    // the generic single-country patterns below would otherwise flag.
    if (home) {
      // Inclusion (broad, safe): any location intro that NAMES the home
      // country means the candidate is eligible. Lenient on purpose — a
      // false "eligible" is far better than wrongly skipping a real fit.
      const inclRe =
        /\b(?:based|located|residing|reside|hiring|sourcing|candidates?|applicants?|eligible to work|authoriz(?:ed|ation) to work|work(?:ing)?|open to (?:candidates|applicants))\b[^.\n]{0,40}?\b(?:in|across|from|within)\s+([a-z][a-z ,.'/&-]{2,90})/g;
      let am;
      while ((am = inclRe.exec(hay)) !== null) {
        const { homeCovered } = parseRemoteLocations(am[1], home);
        if (homeCovered) return ""; // home country is explicitly allowed
      }
      // Exclusion (narrow): an explicit allow-list that ends in "only" and
      // names >=2 countries the home country is NOT among -> restricted to
      // that list. The "only" anchor keeps generic "teams in US, India,
      // Poland" / "experience in X and Y" mentions from mis-flagging.
      const onlyRe =
        /\b(?:based|located|residing|hiring|sourcing|candidates?|applicants?)\b[^.\n]{0,40}?\b(?:in|from|within)\s+([a-z][a-z ,.'/&-]{2,90}?\bonly\b)/g;
      let om;
      while ((om = onlyRe.exec(hay)) !== null) {
        const { labels, homeCovered } = parseRemoteLocations(om[1], home);
        if (!homeCovered && labels.length >= 2) {
          return `Location-restricted to ${labels.join(", ")} (your profile is in ${home}).`;
        }
      }
    }

    const patterns = [
      /(?:must be|should be|need to be|candidates? must be|you must be)\s+(?:located|based|residing|situated)\s+(?:in|within)\s+([a-z][a-z .'-]{1,30})/g,
      /\b(?:located|based|residing|situated)\s+(?:in|within)\s+([a-z][a-z .'-]{1,30})\s+(?:is required|required|only|mandatory)\b/g,
      /\beligible to work in\s+([a-z][a-z .'-]{1,30})/g,
      /\b(?:residents?|citizens?)\s+of\s+([a-z][a-z .'-]{1,30})\s+only\b/g,
      /\b([a-z][a-z .'-]{1,20})\s+(?:residents?|citizens?)\s+only\b/g,
      /\bwork\s+permit\s+for\s+([a-z][a-z .'-]{1,30})/g,
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(hay)) !== null) {
        const found = canonicalCountry(m[1]);
        if (found && found !== home) {
          return home
            ? `Location-restricted to ${found} (your profile is in ${home}).`
            : `Location-restricted to ${found}.`;
        }
      }
    }
    return "";
  }

  const api = {
    COUNTRY_ALIASES,
    canonicalCountry,
    EUROPEAN_COUNTRIES,
    REGION_TOKENS,
    parseRemoteLocations,
    detectCountryRestriction,
  };
  if (typeof window !== "undefined" && window.ProactiveJobDetect) {
    window.ProactiveJobDetect.normalize.geo = api;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
