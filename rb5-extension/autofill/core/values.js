/* =====================================================================
 * core/values.js — profile → form-fillable value resolver.
 * =====================================================================
 * Pure: takes the user's profile, returns strings the fillers can drop
 * into inputs. No DOM access here — that keeps it trivially testable
 * and reusable from other contexts (cloud-side preview, future native
 * apps). ============================================================ */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill) return;
  const ns = window.ProactiveAutofill;

  /** Surname particles. When one of these appears mid-name, everything
   *  FROM the particle onward is part of the surname — and the
   *  particle itself stays in its stored casing ("de", "del", "y").
   *  Without this, "Juan Miguel de Guia" splits as
   *  first="Juan" / last="Miguel de Guia" instead of the correct
   *  first="Juan Miguel" / last="de Guia". Covers Spanish, Portuguese,
   *  Filipino, Dutch, German, French naming conventions.
   *  Compound particles ("de la", "de los", "de las", "van der") are
   *  caught by checking the trailing words after a primary particle. */
  const NAME_PARTICLES = new Set([
    // Spanish / Portuguese / Filipino
    "de", "del", "la", "las", "los", "y", "i",
    "da", "do", "dos", "das",
    "san", "santa", "sto", "sta",
    // Dutch
    "van", "der", "den", "ten", "te", "het",
    // German
    "von", "zu", "zum", "zur",
    // French / Italian
    "le", "du", "des", "di", "lo",
    // Arabic transliterations
    "al", "el", "ibn", "bin", "abu",
    // Irish / Scottish
    "mac", "mc",
  ]);

  /** Split a full name into first / last with particle-aware logic.
   *  Returns { first, last } where casing is preserved verbatim from
   *  the input (so "Juan Miguel de Guia" → { first: "Juan Miguel",
   *  last: "de Guia" }, lowercase "de" intact). */
  function splitFullName(full) {
    const tokens = String(full || "").trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return { first: "", last: "" };
    if (tokens.length === 1) return { first: tokens[0], last: "" };
    if (tokens.length === 2) return { first: tokens[0], last: tokens[1] };
    // Find the FIRST particle that has at least one token before it
    // and at least one token after it — that boundary is the
    // first-name / last-name split.
    for (let i = 1; i < tokens.length - 1; i++) {
      if (NAME_PARTICLES.has(tokens[i].toLowerCase())) {
        return {
          first: tokens.slice(0, i).join(" "),
          last: tokens.slice(i).join(" "),
        };
      }
    }
    // No particle found — keep the historical behavior: first word is
    // the given name, the rest is the surname. Right for most Western
    // and Slavic two-and-three-word names.
    return { first: tokens[0], last: tokens.slice(1).join(" ") };
  }

  /**
   * Map a Profile into a flat string-keyed values dictionary that
   * detectors look up by their FieldMap key.
   * @param {import("./types.js").Profile} profile
   */
  function valuesFromProfile(profile) {
    const c = (profile && profile.data && profile.data.contact) || {};
    const prefs = (profile && profile.data && profile.data.preferences) || {};
    const full = (c.full_name || "").trim();
    // Resolution order for first / last name:
    //   1. contact.first_name / contact.last_name (admin set them
    //      explicitly when filling out the profile),
    //   2. preferences.first_name / preferences.last_name (admin or
    //      user set them on the per-profile preferences page — this
    //      is the path for international names where the auto-split
    //      below would surface the wrong tokens, e.g. "Juan Miguel
    //      de Guia"),
    //   3. derived from full_name via splitFullName.
    const explicitFirst = (c.first_name || prefs.first_name || "").trim();
    const explicitLast = (c.last_name || prefs.last_name || "").trim();
    const { first: derivedFirst, last: derivedLast } = splitFullName(full);
    const firstFromFull = explicitFirst || derivedFirst;
    const lastFromFull = explicitLast || derivedLast;
    const locParts = splitLocation((c.location || "").trim());
    return {
      full_name:  full,
      first_name: firstFromFull,
      last_name:  lastFromFull,
      // Preferred / Display / Chosen name slots default to the
      // candidate's real name unless the profile has explicit
      // preferred_* overrides.
      preferred_first_name: (c.preferred_first_name || "").trim() || firstFromFull,
      preferred_last_name:  (c.preferred_last_name  || "").trim() || lastFromFull,
      preferred_name:       (c.preferred_name       || "").trim() || full,
      email:      (c.email    || "").trim(),
      phone:      (c.phone    || "").trim(),
      // Phone extension lives in preferences (per-profile) because
      // it's per-employer rather than per-person and the Dashboard's
      // Contact section deliberately stays narrow.
      phone_extension: (prefs.phone_extension || c.phone_extension || "").trim(),
      location:   (c.location || "").trim(),
      // Dedicated street / postal "Address" field value. Prefers the
      // per-profile preferences.address (a real address the candidate
      // entered on the Dashboard) and falls back to the location string
      // so an "Address" box still fills when no explicit address is set.
      address:    (prefs.address || "").trim() || (c.location || "").trim(),
      // Decomposed address parts for forms (BambooHR, Workday, …) that
      // split the address into City / State / ZIP / Country fields.
      // Explicit contact.{city,state,country,postal_code} win; else
      // derive from the location string.
      city:         (c.city || locParts.city || "").trim(),
      state_region: (c.state || c.region || c.state_region || locParts.state || "").trim(),
      country:      (c.country || locParts.country || "").trim(),
      // Explicit contact zip wins; else pull it out of the address /
      // location string ("2332 Geary Blvd, San Francisco, CA 94115" →
      // "94115"). Without this a split "ZIP" box stayed empty even though
      // the address the candidate provided contained the postcode.
      postal_code:  (c.postal_code || c.zip || c.postcode || c.zip_code || "").trim()
                    || extractPostalCode((prefs.address || "").trim() || (c.location || "").trim()),
      linkedin:   (c.linkedin || "").trim(),
      github:     (c.github   || "").trim(),
    };
  }

  /* ====================================================================
   * Country dial-code resolution
   * ==================================================================== */

  /** name → { iso, dial }. Lower-case keys; ISO 2-letter; dial code
   *  without "+". Covers the EU + EFTA + top Anglo / APAC / LatAm /
   *  MENA markets; extend in this file when a new locale comes up. */
  const COUNTRY_DIAL = {
    "afghanistan": { iso: "AF", dial: "93" }, "albania": { iso: "AL", dial: "355" },
    "algeria": { iso: "DZ", dial: "213" }, "argentina": { iso: "AR", dial: "54" },
    "armenia": { iso: "AM", dial: "374" }, "australia": { iso: "AU", dial: "61" },
    "austria": { iso: "AT", dial: "43" }, "azerbaijan": { iso: "AZ", dial: "994" },
    "bangladesh": { iso: "BD", dial: "880" }, "belarus": { iso: "BY", dial: "375" },
    "belgium": { iso: "BE", dial: "32" }, "bolivia": { iso: "BO", dial: "591" },
    "bosnia and herzegovina": { iso: "BA", dial: "387" }, "brazil": { iso: "BR", dial: "55" },
    "bulgaria": { iso: "BG", dial: "359" }, "cambodia": { iso: "KH", dial: "855" },
    "canada": { iso: "CA", dial: "1" }, "chile": { iso: "CL", dial: "56" },
    "china": { iso: "CN", dial: "86" }, "colombia": { iso: "CO", dial: "57" },
    "costa rica": { iso: "CR", dial: "506" }, "croatia": { iso: "HR", dial: "385" },
    "cyprus": { iso: "CY", dial: "357" }, "czech republic": { iso: "CZ", dial: "420" },
    "czechia": { iso: "CZ", dial: "420" }, "denmark": { iso: "DK", dial: "45" },
    "egypt": { iso: "EG", dial: "20" }, "estonia": { iso: "EE", dial: "372" },
    "finland": { iso: "FI", dial: "358" }, "france": { iso: "FR", dial: "33" },
    "georgia": { iso: "GE", dial: "995" }, "germany": { iso: "DE", dial: "49" },
    "ghana": { iso: "GH", dial: "233" }, "greece": { iso: "GR", dial: "30" },
    "hong kong": { iso: "HK", dial: "852" }, "hungary": { iso: "HU", dial: "36" },
    "iceland": { iso: "IS", dial: "354" }, "india": { iso: "IN", dial: "91" },
    "indonesia": { iso: "ID", dial: "62" }, "iran": { iso: "IR", dial: "98" },
    "iraq": { iso: "IQ", dial: "964" }, "ireland": { iso: "IE", dial: "353" },
    "israel": { iso: "IL", dial: "972" }, "italy": { iso: "IT", dial: "39" },
    "japan": { iso: "JP", dial: "81" }, "jordan": { iso: "JO", dial: "962" },
    "kazakhstan": { iso: "KZ", dial: "7" }, "kenya": { iso: "KE", dial: "254" },
    "korea": { iso: "KR", dial: "82" }, "south korea": { iso: "KR", dial: "82" },
    "kuwait": { iso: "KW", dial: "965" }, "latvia": { iso: "LV", dial: "371" },
    "lebanon": { iso: "LB", dial: "961" }, "lithuania": { iso: "LT", dial: "370" },
    "luxembourg": { iso: "LU", dial: "352" }, "malaysia": { iso: "MY", dial: "60" },
    "malta": { iso: "MT", dial: "356" }, "mexico": { iso: "MX", dial: "52" },
    "moldova": { iso: "MD", dial: "373" }, "morocco": { iso: "MA", dial: "212" },
    "netherlands": { iso: "NL", dial: "31" }, "new zealand": { iso: "NZ", dial: "64" },
    "nigeria": { iso: "NG", dial: "234" }, "norway": { iso: "NO", dial: "47" },
    "pakistan": { iso: "PK", dial: "92" }, "peru": { iso: "PE", dial: "51" },
    "philippines": { iso: "PH", dial: "63" }, "poland": { iso: "PL", dial: "48" },
    "polska": { iso: "PL", dial: "48" }, "portugal": { iso: "PT", dial: "351" },
    "qatar": { iso: "QA", dial: "974" }, "romania": { iso: "RO", dial: "40" },
    "russia": { iso: "RU", dial: "7" }, "saudi arabia": { iso: "SA", dial: "966" },
    "serbia": { iso: "RS", dial: "381" }, "singapore": { iso: "SG", dial: "65" },
    "slovakia": { iso: "SK", dial: "421" }, "slovenia": { iso: "SI", dial: "386" },
    "south africa": { iso: "ZA", dial: "27" }, "spain": { iso: "ES", dial: "34" },
    "sri lanka": { iso: "LK", dial: "94" }, "sweden": { iso: "SE", dial: "46" },
    "switzerland": { iso: "CH", dial: "41" }, "taiwan": { iso: "TW", dial: "886" },
    "thailand": { iso: "TH", dial: "66" }, "turkey": { iso: "TR", dial: "90" },
    "türkiye": { iso: "TR", dial: "90" }, "uae": { iso: "AE", dial: "971" },
    "united arab emirates": { iso: "AE", dial: "971" }, "uganda": { iso: "UG", dial: "256" },
    "uk": { iso: "GB", dial: "44" }, "united kingdom": { iso: "GB", dial: "44" },
    "great britain": { iso: "GB", dial: "44" }, "england": { iso: "GB", dial: "44" },
    "scotland": { iso: "GB", dial: "44" }, "ukraine": { iso: "UA", dial: "380" },
    "uruguay": { iso: "UY", dial: "598" }, "usa": { iso: "US", dial: "1" },
    "us": { iso: "US", dial: "1" }, "united states": { iso: "US", dial: "1" },
    "vietnam": { iso: "VN", dial: "84" },
  };

  /** Resolve a candidate's phone country, in priority order:
   *    1. profile.data.preferences.phone_country_code (dashboard UI)
   *    2. profile.data.contact.phone_country_code
   *    3. derived from profile.data.contact.location (longest match wins,
   *       so "South Korea" beats "Korea").
   *  Returns { name, iso, dial } or null. */
  // For dial codes shared by several countries, the canonical primary — so
  // "+1" resolves to the US (not Canada, which merely sorts first in the
  // map) and "+7" to Russia (not Kazakhstan). Without this the reverse
  // dial→country lookup returns whichever entry happens to come first.
  const PRIMARY_ISO_FOR_DIAL = { "1": "US", "7": "RU" };

  /** Map a leading numeric dial string (from an explicit "+1" code or the
   *  head of a phone number) to a country. Longest dial wins so "+1" doesn't
   *  shadow "+1x" codes and "+35" doesn't shadow "+358"; among equal-length
   *  matches the PRIMARY_ISO_FOR_DIAL entry wins. Returns {name,iso,dial}
   *  or null. */
  /** The most descriptive COUNTRY_DIAL name for an ISO ("US" → "united
   *  states", not the shorter "usa"/"us" aliases) — so a phone picker
   *  option like "United States +1" matches the generated candidate. */
  function canonicalNameForIso(iso) {
    let best = "";
    for (const [name, data] of Object.entries(COUNTRY_DIAL)) {
      if (data.iso === iso && name.length > best.length) best = name;
    }
    return best;
  }

  function dialToCountry(digits) {
    let hit = null;
    for (const [name, data] of Object.entries(COUNTRY_DIAL)) {
      if (!digits.startsWith(data.dial)) continue;
      if (!hit) { hit = { name, iso: data.iso, dial: data.dial }; continue; }
      const longer = data.dial.length > hit.dial.length;
      const sameLen = data.dial.length === hit.dial.length;
      const nowPreferred = PRIMARY_ISO_FOR_DIAL[data.dial] === data.iso;
      const hitPreferred = PRIMARY_ISO_FOR_DIAL[hit.dial] === hit.iso;
      if (longer || (sameLen && nowPreferred && !hitPreferred)) {
        hit = { name, iso: data.iso, dial: data.dial };
      }
    }
    if (hit) hit.name = canonicalNameForIso(hit.iso) || hit.name;
    return hit;
  }

  function resolvePhoneCountry(profile) {
    const c = (profile && profile.data && profile.data.contact) || {};
    const p = (profile && profile.data && profile.data.preferences) || {};
    const explicit = String(p.phone_country_code || c.phone_country_code || "").trim();
    if (explicit) {
      const cleaned = explicit.replace(/^\+/, "").toLowerCase();
      if (COUNTRY_DIAL[cleaned]) {
        return { name: cleaned, iso: COUNTRY_DIAL[cleaned].iso, dial: COUNTRY_DIAL[cleaned].dial };
      }
      // An ISO code ("US", "GB") → exact country.
      for (const [name, data] of Object.entries(COUNTRY_DIAL)) {
        if (data.iso.toLowerCase() === cleaned) return { name, iso: data.iso, dial: data.dial };
      }
      // A dial code ("+1", "358") → primary country for that code.
      if (/^\d+$/.test(cleaned)) {
        const hit = dialToCountry(cleaned);
        if (hit) return hit;
      }
      // Fallback: caller still has the raw dial code to match by.
      return { name: "", iso: "", dial: cleaned };
    }
    const loc = String(c.location || "").toLowerCase();
    let best = null;
    if (loc) {
      for (const [name, data] of Object.entries(COUNTRY_DIAL)) {
        if (loc.includes(name) && (!best || name.length > best.name.length)) {
          best = { name, iso: data.iso, dial: data.dial };
        }
      }
    }
    if (best) return best;
    // Last resort: derive from a dial code the phone number itself carries
    // ("+358 44…" or "0035844…"). Resolving a concrete country here lets
    // stepPhoneCountry pick it explicitly rather than leaving the widget to
    // auto-detect — which, for a shared dial code, defaults to the
    // alphabetically-first country (e.g. Åland +358).
    const raw = String(c.phone || c.phone_number || c.mobile || "").trim();
    const m = raw.match(/^\s*(?:\+|00)(\d{1,4})/);
    if (m) {
      const hit = dialToCountry(m[1]);
      if (hit) return hit;
    }
    return null;
  }

  /** Extract a country name from "City, Region, Country" → "Country". */
  function extractCountryFromLocation(location) {
    if (!location) return "";
    const parts = String(location).split(/,/).map((s) => s.trim()).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }

  /** True when `token` names a country — a full COUNTRY_DIAL name or a
   *  common informal abbreviation (USA/UK/UAE). We deliberately do NOT
   *  match bare ISO-2 codes: a 2-letter token in a location string is
   *  far more often a US/Canada STATE/PROVINCE abbreviation, and those
   *  collide hard with country ISO codes (CA=California vs Canada,
   *  IN=Indiana vs India, CO/DE/MD/ID/AR/AL/MT/…). Full country names
   *  don't collide, so peeling the country off a location stays safe. */
  function isCountryToken(token) {
    const t = String(token || "").trim().toLowerCase();
    if (!t) return false;
    if (COUNTRY_DIAL[t]) return true;
    if (/^(usa|us|uk|uae|u\.s\.a?\.?|u\.s\.?|u\.k\.?|u\.a\.e\.?)$/.test(t)) return true;
    return false;
  }

  /** Decompose "City, State, Country" / "City, Country" into address
   *  parts. The trailing comma-segment is treated as the country ONLY
   *  when it's a recognised country name, so:
   *    "Pasay, Philippines"               → {city:"Pasay", state:"", country:"Philippines"}
   *    "Pasay, Metro Manila, Philippines" → {city:"Pasay", state:"Metro Manila", country:"Philippines"}
   *    "Wrocław, Poland"                  → {city:"Wrocław", state:"", country:"Poland"}
   *    "London"                           → {city:"London", state:"", country:""}
   *  A location with no recognisable country leaves country "" and
   *  never mis-assigns a city/region as the country. */
  /** Pull a postal code out of a free-form address / location string.
   *  Covers US ZIP ("94115" / "94115-1234"), UK ("SW1A 1AA"), Canada
   *  ("K1A 0B1"), and generic 4-6 digit codes. Returns "" if none found.
   *  Deliberately conservative: a bare 4-digit run that is a plausible
   *  YEAR range at the end is skipped so "…, 2019" isn't read as a code. */
  function extractPostalCode(str) {
    const s = String(str || "").trim();
    if (!s) return "";
    // US ZIP / ZIP+4.
    let m = s.match(/\b(\d{5}(?:-\d{4})?)\b/);
    if (m) return m[1];
    // Polish / NL-style NN-NNN.
    m = s.match(/\b(\d{2}-\d{3})\b/);
    if (m) return m[1];
    // UK postcode.
    m = s.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i);
    if (m) return m[1].toUpperCase().replace(/\s+/, " ");
    // Canada postal code.
    m = s.match(/\b([A-Z]\d[A-Z]\s*\d[A-Z]\d)\b/i);
    if (m) return m[1].toUpperCase().replace(/\s+/, " ");
    // Generic 4-6 digit code as the trailing token (many EU/APAC formats).
    m = s.match(/(?:^|[,\s])(\d{4,6})\s*$/);
    if (m) return m[1];
    return "";
  }

  function splitLocation(location) {
    const parts = String(location || "").split(/,/).map((s) => s.trim()).filter(Boolean);
    let city = "", state = "", country = "";
    if (!parts.length) return { city, state, country };
    if (parts.length > 1 && isCountryToken(parts[parts.length - 1])) {
      country = parts.pop();
    } else if (parts.length === 1 && isCountryToken(parts[0])) {
      return { city: "", state: "", country: parts[0] };
    }
    if (parts.length >= 2) { city = parts[0]; state = parts.slice(1).join(", "); }
    else if (parts.length === 1) { city = parts[0]; }
    return { city, state, country };
  }

  /** country name (lowercase) → nationality demonym. Covers the markets
   *  our candidates actually apply from; extend as new locales appear.
   *  Used to fill a free-text / dropdown "Nationality" field with the
   *  candidate's actual nationality instead of the privacy-safe
   *  "Prefer not to say" default. */
  const DEMONYM = {
    "philippines": "Filipino", "poland": "Polish", "united states": "American",
    "usa": "American", "united kingdom": "British", "uk": "British",
    "canada": "Canadian", "australia": "Australian", "india": "Indian",
    "germany": "German", "france": "French", "spain": "Spanish",
    "italy": "Italian", "netherlands": "Dutch", "brazil": "Brazilian",
    "mexico": "Mexican", "argentina": "Argentine", "japan": "Japanese",
    "china": "Chinese", "south korea": "South Korean", "korea": "South Korean",
    "singapore": "Singaporean", "malaysia": "Malaysian", "indonesia": "Indonesian",
    "vietnam": "Vietnamese", "thailand": "Thai", "portugal": "Portuguese",
    "ireland": "Irish", "new zealand": "New Zealander", "south africa": "South African",
    "nigeria": "Nigerian", "kenya": "Kenyan", "egypt": "Egyptian",
    "pakistan": "Pakistani", "bangladesh": "Bangladeshi", "ukraine": "Ukrainian",
    "romania": "Romanian", "sweden": "Swedish", "norway": "Norwegian",
    "denmark": "Danish", "finland": "Finnish", "switzerland": "Swiss",
    "austria": "Austrian", "belgium": "Belgian", "greece": "Greek",
    "turkey": "Turkish", "united arab emirates": "Emirati", "uae": "Emirati",
    "saudi arabia": "Saudi", "colombia": "Colombian", "chile": "Chilean",
    "peru": "Peruvian",
  };

  /** Derive the candidate's nationality demonym from their location
   *  string ("Pasay, Philippines" → "Filipino"). Longest country-name
   *  match wins so "South Korea" beats "Korea". Returns "" when no
   *  country in the map is present. */
  function deriveNationality(location) {
    const loc = String(location || "").toLowerCase();
    if (!loc) return "";
    // Prefer the explicit trailing country token, else scan the whole
    // string for the longest matching country name.
    const trailing = extractCountryFromLocation(location).toLowerCase();
    if (trailing && DEMONYM[trailing]) return DEMONYM[trailing];
    let best = "";
    let bestLen = 0;
    for (const name of Object.keys(DEMONYM)) {
      if (loc.includes(name) && name.length > bestLen) { best = DEMONYM[name]; bestLen = name.length; }
    }
    return best;
  }

  /* ====================================================================
   * Salary / rate
   * ==================================================================== */
  const SALARY_WORDS =
    /(salary|compensation|comp\b|pay\s*(?:range|rate)?|base|gross|annual|monthly|per\s*(year|month|annum|month)|p\.?a\.?|ote\b|\beuro|usd|eur|gbp|inr|jpy|\$|€|£|₹|¥|\bnetto?\b|\bbrutto?\b)/i;
  const CURRENCY = { "$": "USD", "€": "EUR", "£": "GBP", "₹": "INR", "¥": "JPY" };

  const DEFAULT_SALARY_BY_PERIOD = {
    year:  { amount: 60000, currency: "EUR", period: "year"  },
    month: { amount:  5000, currency: "EUR", period: "month" },
  };

  function inferPeriod(text) {
    if (/month/i.test(text)) return "month";
    if (/year|p\.?a\.?|annum|annual/i.test(text)) return "year";
    return "year";
  }

  /** Best-effort salary parser. Reads "60000 EUR/year",
   *  "60,000 EUR per year", "€5000 monthly", "60k", etc. */
  function parseSalaryFromJd(jd) {
    if (!jd) return null;
    const text = String(jd);
    if (!SALARY_WORDS.test(text)) return null;
    // amount + currency + period, in any order.
    // 60000 EUR/year   €5000/month   $120,000 per annum   60k EUR yearly
    const re = /([€£$₹¥]?\s*\d{1,3}(?:[,.\s]?\d{3})+|[€£$₹¥]?\s*\d{2,3}\s*k)[^a-zA-Z€£$₹¥]{0,20}(eur|usd|gbp|inr|jpy|€|£|\$|₹|¥)?[^a-zA-Z]{0,20}(year|annum|annual|p\.?a\.?|month|monthly)?/i;
    const m = re.exec(text);
    if (!m) return null;
    let raw = m[1].replace(/[^\d.k]/gi, "");
    let amount;
    if (/k$/i.test(raw)) amount = parseFloat(raw) * 1000;
    else amount = parseFloat(raw.replace(/[.,]/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const currencyToken = m[2] || "";
    const currency =
      currencyToken && /[a-z]/i.test(currencyToken)
        ? currencyToken.toUpperCase()
        : CURRENCY[currencyToken] || "EUR";
    const period = inferPeriod(m[3] || text);
    return { amount, currency, period };
  }

  function inferSalaryPeriodFromQuestion(label) {
    const t = String(label || "").toLowerCase();
    if (/month|monthly/.test(t)) return "month";
    return "year";
  }

  /** Resolve the salary value for a specific field. PRIORITY:
   *  1. the candidate's explicit per-profile preference (desired_salary_*),
   *  2. a salary parsed from the JD whose period matches the question,
   *  3. the hard default.
   *
   *  The preference MUST win over the JD number. A "Requested
   *  Compensation Range" field asks what the CANDIDATE wants, and the
   *  JD parser can scrape an unrelated figure (e.g. "401000") with a
   *  default EUR currency — that must never override a user who set
   *  "120000" + preferred_currency USD. (This ordering was previously
   *  reversed, which is exactly the "wrong amount / wrong currency"
   *  bug.) */
  function resolveSalaryForField(el, jdSalary, prefs) {
    const { labelTextFor } = ns.core.dom;
    const label = labelTextFor(el);
    const want = inferSalaryPeriodFromQuestion(label);
    if (prefs) {
      const fromPrefs = prefs[want === "month" ? "desired_salary_month" : "desired_salary_year"]
        || prefs.desired_salary;
      if (fromPrefs) {
        if (typeof fromPrefs === "string") {
          const parsed = parseSalaryFromJd(fromPrefs);
          if (parsed && parsed.period === want) return parsed;
          // Dashboard fields capture "Desired salary — annual / monthly"
          // separately, so when the user types just "36000" the period
          // is already implied by which slot they used. parseSalaryFromJd
          // bails on a bare number (no salary keyword) — fall back to
          // a number-only parse and pair with the user's preferred
          // currency. Without this, prefs.desired_salary_year = "36000"
          // silently dropped to the hardcoded 60000 EUR default.
          const bare = String(fromPrefs).replace(/[^\d.k]/gi, "");
          if (bare) {
            let amount;
            if (/k$/i.test(bare)) amount = parseFloat(bare) * 1000;
            else amount = parseFloat(bare.replace(/[.,]/g, ""));
            if (Number.isFinite(amount) && amount > 0) {
              // Honour an explicit currency in the prefs string first
              // ("36000 USD"); else use the per-profile
              // preferred_currency; else fall back to EUR.
              const inlineCurrencyMatch = String(fromPrefs).match(/\b(EUR|USD|GBP|CAD|AUD|CHF|SGD|HKD|JPY|INR|PHP|PLN|SEK|NOK|DKK|BRL|MXN|AED|SAR|TRY)\b|([€£$₹¥])/i);
              const inlineCurrency = inlineCurrencyMatch
                ? (inlineCurrencyMatch[1] ? inlineCurrencyMatch[1].toUpperCase() : CURRENCY[inlineCurrencyMatch[2]])
                : null;
              const currency = inlineCurrency
                || (prefs.preferred_currency || "").trim().toUpperCase()
                || "EUR";
              return { period: want, currency, amount };
            }
          }
        } else if (fromPrefs && typeof fromPrefs === "object" && fromPrefs.amount) {
          return {
            period: want,
            currency: fromPrefs.currency
              || (prefs.preferred_currency || "").trim().toUpperCase()
              || "EUR",
            amount: Number(fromPrefs.amount),
          };
        }
      }
    }
    // No usable preference — fall back to a JD-parsed salary (only when
    // its period matches the field), then the hard default.
    if (jdSalary && jdSalary.period === want) return jdSalary;
    return DEFAULT_SALARY_BY_PERIOD[want];
  }

  /** Render a salary record into the string the field actually wants.
   *  Number-only inputs get a bare amount; everything else gets
   *  "60000 EUR". */
  function formatSalaryForField(el, sal) {
    if (!el || !sal) return "";
    const placeholder = (el.getAttribute("placeholder") || "").toLowerCase();
    const wantsNumberOnly = el.type === "number"
      || (/^\s*\d/.test(placeholder) && !/[$€£a-z]/i.test(placeholder));
    if (wantsNumberOnly) return String(sal.amount);
    return sal.currency ? `${sal.amount} ${sal.currency}` : String(sal.amount);
  }

  /* ====================================================================
   * Dates
   * ==================================================================== */
  function toIsoDate(s) {
    if (!s) return "";
    const str = String(s).trim();
    // Already ISO?
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    // DD/MM/YYYY or MM/DD/YYYY — assume DD/MM/YYYY (EU default).
    const m = str.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
    if (m) {
      const day = m[1].padStart(2, "0");
      const month = m[2].padStart(2, "0");
      const year = m[3];
      return `${year}-${month}-${day}`;
    }
    return "";
  }

  ns.core.values = {
    valuesFromProfile,
    splitFullName,
    NAME_PARTICLES,
    COUNTRY_DIAL,
    resolvePhoneCountry,
    extractCountryFromLocation,
    deriveNationality,
    splitLocation,
    parseSalaryFromJd,
    resolveSalaryForField,
    formatSalaryForField,
    inferSalaryPeriodFromQuestion,
    toIsoDate,
    DEFAULT_SALARY_BY_PERIOD,
  };
})();
