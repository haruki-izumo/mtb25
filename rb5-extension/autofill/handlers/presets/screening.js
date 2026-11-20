/* =====================================================================
 * handlers/presets/screening.js — instant, no-LLM answers to the
 * canonical screening questions every ATS asks.
 * =====================================================================
 * Each preset is a (regex, answer-resolution-strategy) pair. The
 * pickPreset() function walks the list in order and returns the first
 * match — order matters when multiple regexes could fire (e.g.,
 * right_to_work_eu is listed before the generic legally_authorized_
 * country catch-all so country-flagged questions match the specific
 * preset first).
 *
 * Answer resolution order, per match:
 *   1. profile.data.preferences[preset.key] (explicit override).
 *   2. profile.data.contact[preset.readFromContact] (e.g. location).
 *   3. Kind-specific resolver (country_match / country_extract /
 *      region_map / current_company / languages).
 *   4. preset.default.
 *
 * Self-registers via pipeline.registry.registerPreset. ============== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { extractCountryFromLocation, deriveNationality, splitLocation } = ns.core.values;
  const { registerPreset } = ns.pipeline.registry;

  /** Given a profile degree value ("Bachelor's", "BSc", "Master of
   *  Science in CS", …), return the raw value plus level-based synonyms
   *  so a Degree DROPDOWN option ("Bachelors Degree", "Bachelor of
   *  Science", "Undergraduate", "BS") is matchable. */
  // Ordered degree synonyms for dropdown matching. The concrete
  // "…of Science" / "…of Arts" variants come BEFORE the generic
  // "Bachelor's Degree" forms and BEFORE the raw profile value, because
  // a bare "Bachelor's" loosely token-matches the FIRST concrete option
  // a form lists — usually "…of Arts" — and commits it before the
  // correct "…of Science" synonym is ever tried. Default is Science (the
  // common case for the technical applicants this tool serves); an
  // explicit Arts/humanities signal (in the degree text OR the field of
  // study) flips the preference to Arts so we never override a real
  // Arts degree.
  function degreeSynonyms(degree, fieldHint) {
    const raw = String(degree || "").trim();
    const d = raw.toLowerCase();
    const hint = String(fieldHint || "").toLowerCase();
    const saysArts = /\barts?\b|\bb\.?\s?a\.?\b|\bm\.?\s?a\.?\b|humanities|\bfine\s+arts?\b/.test(d);
    const saysSci = /science|\bb\.?\s?s\.?\b|\bb\.?\s?sc\b|\bm\.?\s?s\.?\b|\bm\.?\s?sc\b|\beng(?:ineering)?\b/.test(d);
    const artsField = /\b(arts?|history|english|literature|philosoph\w*|languages?|linguist\w*|music|theat\w*|film|media|communicat\w*|journalis\w*|sociolog\w*|anthropolog\w*|politic\w*|humanities|graphic\s+design|fine\s+arts?|religio\w*)\b/.test(hint);
    const preferArts = saysArts || (!saysSci && artsField);
    const order = (sci, arts, generic) =>
      preferArts ? [...arts, ...sci, ...generic] : [...sci, ...arts, ...generic];

    let out = [];
    if (/\bph\.?\s?d\b|doctora|doctoral|d\.?\s?phil/.test(d)) {
      out = ["PhD", "Ph.D.", "Doctorate", "Doctoral Degree", "Doctoral", "Doctorate Degree"];
    } else if (/master|\bm\.?\s?s\.?\b|\bm\.?\s?a\.?\b|\bmba\b|\bm\.?\s?sc\b|\bm\.?\s?eng\b|postgrad|graduate\s+degree/.test(d)) {
      out = order(
        ["Master of Science", "MS", "MSc"],
        ["Master of Arts", "MA"],
        ["Master's", "Masters", "Master's Degree", "Masters Degree", "MBA", "Postgraduate", "Postgraduate Degree", "Graduate Degree"],
      );
    } else if (/bachelor|\bb\.?\s?s\.?\b|\bb\.?\s?a\.?\b|\bb\.?\s?sc\b|\bb\.?\s?eng\b|undergrad|baccalaureate/.test(d)) {
      out = order(
        ["Bachelor of Science", "BS", "BSc"],
        ["Bachelor of Arts", "BA"],
        ["Bachelor's", "Bachelors", "Bachelor's Degree", "Bachelors Degree", "Undergraduate Degree", "Undergraduate"],
      );
    } else if (/associate/.test(d)) {
      out = ["Associate's", "Associates", "Associate Degree", "Associate's Degree", "Associates Degree"];
    } else if (/high\s*school|secondary|\bged\b|\bhs\b|diploma/.test(d)) {
      out = ["High School", "High School Diploma", "Secondary School", "Diploma", "HS Diploma"];
    }
    // raw kept (deduped, last) so a dropdown that lists the exact profile
    // text still matches — it's just the least-specific candidate.
    return [...new Set([...out, raw].filter(Boolean))];
  }

  // Best available field-of-study string, used to decide Arts vs Science
  // when the degree level itself is generic ("Bachelor's").
  /** Pull the SUBJECT out of a degree string — "Bachelor of Science - BS,
   *  Computer Science" / "BSc in Computer Science" → "Computer Science".
   *  Returns "" when the tail is just another degree LEVEL, so we never
   *  put "BS" in a Discipline box. */
  function fieldFromDegreeString(degree) {
    const raw = String(degree || "").trim();
    if (!raw) return "";
    let m = raw.match(/\bin\s+([A-Za-z][\w&./'\- ]{2,60})$/i);
    if (!m) m = raw.match(/,\s*([A-Za-z][\w&./'\- ]{2,60})$/);
    // "BSc Computer Science" / "B.S. Computer Science" — subject follows a
    // degree abbreviation with no "in"/comma.
    if (!m) m = raw.match(/\b(?:b\.?\s?s\.?c?|b\.?\s?a\.?|b\.?\s?eng|m\.?\s?s\.?c?|m\.?\s?a\.?|m\.?\s?eng|ph\.?\s?d|b\.?tech|m\.?tech)\.?\s+(?:of\s+\w+\s+)?(?:in\s+)?([A-Z][\w&./'\- ]{2,60})$/i);
    const cand = m ? m[1].trim().replace(/[.\s]+$/, "") : "";
    if (!cand) return "";
    if (/^(?:b\.?\s?s\.?c?|b\.?\s?a\.?|m\.?\s?s\.?c?|m\.?\s?a\.?|mba|ph\.?\s?d|bachelors?|masters?|doctorate|associate|diploma|undergraduate|postgraduate)\b/i.test(cand)) return "";
    return cand;
  }

  /** Parse an age-bracket label into [lo, hi]. Handles "18-20", "21–29",
   *  "25 to 34", "65+", "60 or older", "Under 18", "17 or younger" and a
   *  bare "32". Returns null for non-range text ("Prefer not to answer"),
   *  which is how those options are skipped. */
  function parseAgeRange(label) {
    const s = String(label || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!s || /prefer not|decline|not\s+say|n\/a/.test(s)) return null;
    let m = s.match(/(\d{1,3})\s*(?:-|–|—|to)\s*(\d{1,3})/);
    if (m) return [Number(m[1]), Number(m[2])];
    m = s.match(/(\d{1,3})\s*\+/);
    if (m) return [Number(m[1]), 200];
    m = s.match(/(\d{1,3})\s*(?:or\s+|and\s+)?(?:older|above|over|plus)\b/);
    if (m) return [Number(m[1]), 200];
    m = s.match(/(?:under|below|less\s+than)\s*(\d{1,3})/);
    if (m) return [0, Math.max(0, Number(m[1]) - 1)];
    m = s.match(/(\d{1,3})\s*(?:or\s+|and\s+)?(?:younger|under|below)\b/);
    if (m) return [0, Number(m[1])];
    m = s.match(/^(\d{1,3})$/);
    if (m) return [Number(m[1]), Number(m[1])];
    return null;
  }

  /** Choose which of a form's age options fits the configured bracket.
   *  Every ATS slices the brackets differently ("25-34" vs "21-29" /
   *  "30-39"), so a fixed synonym list matched almost nothing. Resolve
   *  NUMERICALLY instead: containment first, else the greatest overlap.
   *  Lets one profile value — a bracket OR a plain age ("32") — land
   *  correctly on any bracket set. Returns "" when nothing is parseable. */
  function pickAgeBracketOption(preferred, optionLabels) {
    const prefRange = parseAgeRange(preferred);
    if (!prefRange) return "";
    const age = (prefRange[0] + Math.min(prefRange[1], 120)) / 2;
    let contained = "", best = "", bestOverlap = 0;
    for (const raw of optionLabels || []) {
      const label = String(raw || "").trim();
      if (!label) continue;
      const r = parseAgeRange(label);
      if (!r) continue;
      if (!contained && age >= r[0] && age <= r[1]) contained = label;
      const overlap = Math.min(prefRange[1], r[1]) - Math.max(prefRange[0], r[0]) + 1;
      if (overlap > bestOverlap) { bestOverlap = overlap; best = label; }
    }
    return contained || best || "";
  }

  // US state ↔ 2-letter abbreviation, both directions. Given "CA" or
  // "california" returns { full: "California", abbr: "CA" }. Unknown input
  // (a non-US region) echoes back as the full name with no abbr.
  const US_STATES = {
    alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
    colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC",
    florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
    indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
    maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
    mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK",
    oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
    "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT",
    virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
    "puerto rico": "PR",
  };
  const US_ABBR = Object.fromEntries(Object.entries(US_STATES).map(([full, ab]) => [ab, full]));
  function usStateTwin(input) {
    const s = String(input || "").trim();
    if (!s) return { full: "", abbr: "" };
    const lc = s.toLowerCase();
    if (US_STATES[lc]) {
      const full = s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1));
      return { full, abbr: US_STATES[lc] };
    }
    const up = s.toUpperCase();
    if (US_ABBR[up]) {
      const full = US_ABBR[up].replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1));
      return { full, abbr: up };
    }
    return { full: s, abbr: "" };
  }

  /** True when a location names a US state (so a "Country" dropdown can be
   *  resolved to the United States even when the location string carries no
   *  explicit country token — "Wexford, PA 15090" / "Austin, Texas").
   *  A full state name anywhere is enough; a bare 2-letter abbreviation is
   *  only trusted alongside a 5-digit ZIP, since "OR"/"IN"/"OK"/"CA" collide
   *  with ordinary words and other countries' region codes. */
  function locationImpliesUS(location) {
    const raw = String(location || "");
    if (!raw.trim()) return false;
    const loc = raw.toLowerCase();
    for (const full of Object.keys(US_STATES)) {
      if (new RegExp("\\b" + full.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b").test(loc)) return true;
    }
    if (/\b\d{5}(?:-\d{4})?\b/.test(raw)) {
      for (const ab of Object.values(US_STATES)) {
        if (new RegExp("(?:^|[\\s,])" + ab + "(?:[\\s,]|$)").test(raw)) return true; // uppercase abbr
      }
    }
    return false;
  }

  function degreeFieldHint(profileData, profilePrefs) {
    const edu = profileData && Array.isArray(profileData.education) ? profileData.education : [];
    // Any key an education entry might carry the subject under.
    const EDU_KEYS = ["field", "major", "discipline", "fieldOfStudy", "field_of_study",
      "subject", "course", "program", "concentration", "specialization",
      "areaOfStudy", "area_of_study", "studyField", "study"];
    const eduField = (e) => { for (const k of EDU_KEYS) if (e && String(e[k] || "").trim()) return String(e[k]).trim(); return ""; };
    const top = edu.find((e) => eduField(e));
    const fromEdu = top ? eduField(top) : "";
    const fromPrefs = profilePrefs && (profilePrefs.field_of_study || profilePrefs.major
      || profilePrefs.discipline || profilePrefs.subject || profilePrefs.course
      || profilePrefs.specialization || profilePrefs.concentration || profilePrefs.area_of_study);
    // Last resort: the subject baked into the degree string itself, so a
    // "Discipline" box still fills when no explicit field is configured
    // ("Bachelor of Science in Computer Science" / "BSc, Data Science").
    const withDegree = edu.find((e) => e && e.degree);
    const fromDegree = withDegree ? fieldFromDegreeString(withDegree.degree) : "";
    return String(fromEdu || fromPrefs || fromDegree || "").trim();
  }

  // Coarse country → region. Substring-matched against profile location.
  const REGION_PATTERNS = [
    ["Europe", /\b(poland|polska|germany|deutschland|france|spain|italy|uk|united kingdom|britain|england|scotland|wales|ireland|netherlands|holland|belgium|austria|switzerland|sweden|norway|denmark|finland|portugal|greece|czech|czechia|slovakia|hungary|romania|bulgaria|croatia|slovenia|estonia|latvia|lithuania|luxembourg|malta|cyprus|iceland|albania|serbia|montenegro|bosnia|north macedonia|moldova|ukraine|belarus|russia)\b/i],
    ["Asia Pacific", /\b(china|japan|india|australia|singapore|south korea|north korea|korea|thailand|vietnam|indonesia|malaysia|philippines|new zealand|hong kong|taiwan|pakistan|bangladesh|sri lanka|nepal|cambodia|laos|myanmar|mongolia|fiji)\b/i],
    ["North America", /\b(united states|usa|u\.?s\.?a\.?|america|canada|mexico)\b/i],
    ["South America", /\b(brazil|brasil|argentina|chile|colombia|peru|venezuela|ecuador|bolivia|paraguay|uruguay|guyana|suriname)\b/i],
    ["Middle East", /\b(uae|united arab emirates|emirates|saudi arabia|saudi|israel|turkey|türkiye|iran|iraq|lebanon|jordan|qatar|kuwait|bahrain|oman|yemen|syria|palestine)\b/i],
    ["Africa", /\b(south africa|nigeria|egypt|kenya|ghana|morocco|ethiopia|tanzania|algeria|tunisia|uganda|cameroon|senegal|ivory coast|côte d'ivoire|zimbabwe|zambia|angola|mozambique|sudan|libya|rwanda)\b/i],
  ];
  function inferRegionFromLocation(location) {
    if (!location) return null;
    const loc = String(location).toLowerCase();
    for (const [region, re] of REGION_PATTERNS) {
      if (re.test(loc)) return region;
    }
    return null;
  }

  /** The full preset list. Order matters — earlier entries win. */
  const SCREENING_PRESETS = [
    // ───────── Consent / Privacy ─────────
    {
      key: "applicant_privacy_notice",
      match: /(applicant\s+privacy\s+notice|privacy\s+notice|privacy\s+statement|data\s+(privacy|protection)\s+(notice|statement|acknowledgement)|gdpr\s+(consent|notice|acknowledgement)|candidate\s+privacy|recruitment\s+privacy|i\s+(have\s+)?(read|received|reviewed|understand|acknowledge)\s+the\s+(privacy|notice))/i,
      kind: "one_of",
      default: "Yes",
      synonyms: ["I agree", "Agree", "I acknowledge", "Acknowledge", "I have read", "Confirmed", "Confirm", "Accept", "I accept"],
    },

    // ───────── Right to work ─────────
    // "Do you currently or will you in the future require sponsorship to
    // work in the United States or Canada?" → No. MUST precede the
    // right_to_work_* presets: these labels almost always append
    // "Applicants must be authorized to work … in the US/Canada", and
    // right_to_work_us matched that "authoriz… US" fragment and answered
    // YES — the exact opposite of what the question asks. Scoped to the
    // interrogative "do/will you … require/need … sponsor" shape so a
    // genuine right-to-work question that merely mentions sponsorship
    // ("Are you authorized to work in the US without sponsorship?") is
    // still left to right_to_work_us → Yes.
    { key: "requires_sponsorship",
      match: /\b(?:do|does|will|would)\s+you\b[\s\S]{0,80}?\b(?:requir\w*|need\w*)\b[\s\S]{0,40}?\bsponsor/i,
      kind: "yes_no", default: "No" },
    { key: "right_to_work_eu",
      match: /(right to work|authoriz(ed|ation)|legally? (able|allowed) to work|work permit|work authorization|prawo do pracy|arbeitserlaubnis|recht.*arbeiten|derecho a trabajar|permiso de trabajo|droit de travailler|autoris.+travail).+(eu|europe|european union|ue|union européenne|europäisch)|(european union|eu|ue|europa).+(right to work|authoriz|legally|prawo do pracy|arbeitserlaubnis|derecho a trabajar)/i,
      kind: "yes_no", default: "Yes" },
    { key: "right_to_work_us",
      match: /(right to work|authoriz(ed|ation)|legally? (able|allowed) to work|work permit|work authorization).+(us|u\.s\.|united states|usa)|(united states|us|u\.s\.).+(right to work|authoriz|legally)/i,
      kind: "yes_no", default: "Yes" },
    { key: "right_to_work_uk",
      match: /(right to work|authoriz(ed|ation)|legally? (able|allowed) to work|work permit|work authorization).+(uk|u\.k\.|united kingdom|britain)|(uk|united kingdom).+(right to work|authoriz|legally)/i,
      kind: "yes_no", default: "Yes" },
    { key: "right_to_work_canada",
      match: /(right to work|authoriz(?:ed|ation)|legally? (?:able|allowed) to work|work permit|work authorization).+(canada|canadian)|(canada|canadian).+(right to work|authoriz|legally)/i,
      kind: "yes_no", default: "Yes" },
    { key: "right_to_work_australia",
      match: /(right to work|authoriz(?:ed|ation)|legally? (?:able|allowed) to work|work permit|work authorization).+(australia|australian|aus\b)|(australia|australian|aus\b).+(right to work|authoriz|legally)/i,
      kind: "yes_no", default: "Yes" },
    { key: "right_to_work_generic",
      // Two openers:
      //  - "are you legally/authorized …" → bare work\b is fine (the
      //    opener already scopes it to right-to-work).
      //  - "do you (currently) have …" → MUST be followed by explicit
      //    right-to-work context ("right to work", "authoriz",
      //    "work permit", "eligib", "legal right"), NOT a bare
      //    "…work". Otherwise "Do you have reliable internet … for
      //    remote WORK?" and "Do you have 6+ years … WORKing" would
      //    false-match this catch-all instead of their real presets.
      match: /^(?:are you legally|are you authoriz|czy masz prawo|haben sie das recht|¿tienes derecho|avez-vous le droit)[\s\S]*\b(work\b|authoriz|pracy|arbeiten|trabajar|travailler)|^do you (?:currently )?have\b[\s\S]*\b(?:right\s+to\s+work|work\s+authoriz|authoriz\w*\s+to\s+work|work\s+permit|legal\s+right\s+to\s+work|eligib\w*\s+to\s+work)/i,
      kind: "yes_no", default: "Yes" },
    // "Work eligibility is extremely important. Are you legally
    // eligible to work in the country where you're planning to work
    // from?" — a country-agnostic phrasing that the ^-anchored
    // right_to_work_generic above can't match because the label
    // opens with "Work eligibility …". Listed AFTER right_to_work_*
    // country-specific presets so a US/UK/EU-tagged variant still
    // wins when a country name is present.
    { key: "work_eligibility_general",
      match: /\b(?:legally\s+)?eligible\s+to\s+work\b|\bwork\s+eligibility\b|are\s+you\s+(?:legally\s+)?eligible\s+to\s+work/i,
      kind: "yes_no", default: "Yes" },
    { key: "needs_visa_sponsorship",
      match: /(visa|sponsor|wiz(a|y)|sponsoring|visado|patrocinio)/i,
      kind: "yes_no", default: "No" },

    // ───────── Conflicts of interest / restrictions ─────────
    // "Do you have any employment restrictions such as a non-compete?"
    // → No (a candidate applying is free to take the role).
    { key: "employment_restrictions",
      match: /\bnon[\s-]?compete\b|\bemployment\s+restrictions?\b|\brestrictive\s+covenant\b|\bnon[\s-]?solicit(?:ation)?\b|(?:any\s+)?(?:contractual|legal|current)\s+(?:restrictions?|obligations?|commitments?)\b|(?:any\s+)?restrictions?\s+(?:that|which)?\s*(?:would|might|may|could)?\s*(?:prevent|preclude|restrict|limit|stop|bar)\s+(?:you\s+)?from\b/i,
      kind: "yes_no", default: "No" },
    // "Are you currently employed with an Affinitiv customer?" /
    // "…a competitor / client / partner?" — conflict-of-interest
    // disclosure → No. Requires the customer/competitor keyword so it
    // never fires on a plain "Are you currently employed?".
    { key: "employed_with_customer",
      match: /(?:currently\s+)?(?:employed|work(?:ing)?)\s+(?:with|by|at|for)\s+(?:a\s+|an\s+|any\s+)?(?:[\w.&'-]+\s+){0,3}?(?:customer|client|competitor|competing|partner|vendor|supplier|affiliate|rival|subsidiary)\b/i,
      kind: "yes_no", default: "No" },
    // Self-declaration statements "I am (currently) an employee /
    // contractor of <Company>", "I am a former employee of <Company>",
    // "I am, or was, a customer of <Company>" — relationship / conflict
    // disclosures → No. Requires a role noun (employee/contractor/
    // customer/…) FOLLOWED by of/at/with/for, so "I am authorized to
    // work" / "I am a team player" don't false-fire.
    // Leading negative lookahead: a "related to / relative / family /
    // spouse …" phrasing is NEPOTISM (relatives_employed), about a
    // RELATIVE being an employee — not the candidate. Exclude it so
    // "Are you related to a current employee of the company?" routes to
    // relatives_employed, while "I am an employee of Newsela" stays
    // here.
    { key: "company_affiliation",
      match: /^(?![\s\S]*\b(?:relat(?:ed|ive)s?|family|spouse|husband|wife|siblings?|brothers?|sisters?|cousins?|parents?|children|in[\s-]?laws?)\b)[\s\S]*?\b(?:i\s+am|i'?m|are\s+you|were\s+you|have\s+you\s+(?:ever\s+)?been)\b[\s\S]{0,45}?\b(?:current(?:ly)?|former|past|previous|existing|prior)?\s*(?:an?\s+)?(?:employee|contractor|subcontractor|consultant|vendor|customer|client|partner|supplier|shareholder|stockholder|investor|affiliate|reseller|distributor)\b[\s\S]{0,25}?\b(?:of|at|with|for)\b/i,
      kind: "yes_no", default: "No" },

    // ───────── Mobility ─────────
    { key: "willing_to_relocate",
      match: /(relocat|move (closer|to)|willing.*move|need to relocate|open to relocation|przeprowadz|umzug|umziehen|reubicar|reubicación|déménag)/i,
      kind: "yes_no", default: "No" },
    { key: "remote_ok",
      match: /(comfortable|willing|happy|zdaln|zdalnie|fernarbeit|remot).{0,30}(remote|work from home|wfh|zdaln|home.?office|fernarbeit|teletrabajo|télétravail)/i,
      kind: "yes_no", default: "Yes" },
    { key: "onsite_ok",
      match: /(comfortable|willing|happy|stacjon).{0,30}(onsite|on-site|in.?office|in.?person|stacjonarn|büro|presencial|sur place)/i,
      kind: "yes_no", default: "No" },
    { key: "hybrid_ok",
      match: /(comfortable|willing|happy|open\s+to|able\s+to\s+work).{0,30}(hybrid|in.?office\s*\/\s*remote|remote\s*\/\s*in.?office|hybrid\s+(?:work|model))/i,
      kind: "yes_no", default: "Yes" },
    { key: "willing_to_travel",
      match: /(willing|able|comfortable|open)\s+to\s+travel|travel\s+(?:requirement|expectations?|percentage)|how\s+(?:much|often)\s+(?:are\s+you\s+willing\s+to\s+)?travel/i,
      kind: "yes_no", default: "No" },

    // ───────── Start date / salary ─────────
    { key: "earliest_start_date",
      // "start date(?! year)" so an Education "Start date year" field
      // isn't answered "Immediately" — that routes to
      // education_start_year instead.
      match: /(earliest.*start|when (can|could) you start|available.*start|start\s+date\b(?!\s+year)|termin rozpoczęcia|startdatum|verfügbarkeit|fecha de inicio|disponibilidad|date de début)/i,
      kind: "text", default: "Immediately" },
    { key: "notice_period",
      match: /notice\s+period|notice\s+(?:to\s+give|required)|how\s+(?:much|long)\s+notice|how\s+(?:soon|quickly)\s+can\s+you\s+(?:start|leave\s+(?:your\s+)?current)/i,
      kind: "text", default: "Immediately",
      // Synonyms cover the dropdown variants common on Rippling /
      // Greenhouse / Workable notice-period pickers — selectDropdownOption
      // tries them in order until one matches an option's text.
      synonyms: [
        "Immediately",
        "As soon as possible",
        "ASAP",
        "Immediate",
        "Less than 1 week",
        "Less than 2 weeks",
        "1-2 weeks",
        "1 to 2 weeks",
        "Within 2 weeks",
        "2 weeks",
        "No notice",
        "None",
      ] },
    { key: "preferred_employment_type",
      match: /(?:preferred|desired)\s+(?:employment|contract|engagement)\s+(?:type|preference)|(?:type\s+of\s+)?employment\s+(?:type|you('| a)re\s+(?:looking\s+for|seeking))|full[\s\-]time\s+or\s+part[\s\-]time|employment\s+status\s+preference/i,
      kind: "text", default: "Full-time" },
    { key: "desired_salary",
      match: /(desired|expected|preferred|target|requirement|requested|oczekiwan|gehaltsvorstellung|salario|prétention).+(salary|compensation|comp\b|pay|gross|pensj|wynagrodz|gehalt|salario|salaire|income|earnings)|salary.+(expect|desired|target|gross|requirement|requirements|requested)|compensation.+(expect|desired|target|requirement)|income.+(expect|desired|target|requirement)|^salary\s*(requirement|expectation)|\bincome\s+expectations?\b|\bsalary\s+expectations?\b/i,
      kind: "salary", default: "60000 EUR/year" },
    { key: "desired_daily_rate",
      match: /(daily|day)\s+rate|rate\s+per\s+day|day(?:-|\s)*rate|tjm|taux\s+journalier/i,
      kind: "salary", default: "250 EUR/day" },
    { key: "desired_hourly_rate",
      match: /(?:desired|expected|preferred|target|requested)\s+(?:hourly|hour)\s+(?:rate|wage|salary)|(?:hourly|hour)\s+(?:rate|wage)\s+(?:expect|require|desired)|rate\s+per\s+hour/i,
      kind: "salary", default: "35 EUR/hour" },
    { key: "preferred_currency",
      match: /(?:preferred|desired)\s+currency|currency\s+(?:preference|of\s+(?:payment|salary))|in\s+which\s+currency/i,
      kind: "text", default: "EUR" },
    { key: "open_to_equity",
      match: /(?:open|willing)\s+to\s+(?:equity|stock\s+options?|share\s+options?)|equity\s+(?:compensation|portion|portion\s+of\s+(?:salary|comp))|stock(?:-|\s)options\s+(?:as\s+part)/i,
      kind: "yes_no", default: "Yes" },

    // ───────── Career & languages ─────────
    // "Do you have <X> experience / certification / knowledge?" — the
    // universal Yes/No capability question (Workable button-pair
    // toggles, Greenhouse yes/no dropdowns). A job applicant answers
    // Yes to "do you have experience with React", "do you have a
    // HubSpot certification", "do you have advanced knowledge of AWS",
    // etc. MUST sit before years_of_experience: the interrogative
    // "Do you have 6+ years of experience …?" is a Yes/No toggle, but
    // years_of_experience would otherwise grab it and return the
    // number "5" (which no Yes/No option matches, so nothing gets
    // selected). The regex requires the capability keyword to come
    // AFTER "do you have", which only happens in this interrogative
    // form — "How many years of experience do you have?" (keyword
    // before "do you have") falls through to years_of_experience as
    // intended. Keyword gate keeps it scoped to capability questions
    // so it never touches "do you have a criminal record / disability"
    // (those match their specific No-default presets earlier anyway).
    // "Do you have prior/previous experience AT THIS COMPANY / working
    // HERE (before)?" is a RE-HIRE disclosure, not a skills question —
    // answering Yes would falsely admit prior employment. Must sit
    // before has_relevant_experience (which matches "do you have …
    // experience" and would otherwise say Yes). Scoped tightly to
    // this-company / here context so "prior experience with React /
    // in sales" stays a skills Yes.
    { key: "prior_employment_here",
      match: /(?:prior|previous)\s+(?:work\s+|professional\s+)?experience\s+(?:(?:working|employed)\s+)?(?:at\s+(?:this|our)\s+(?:compan|organi|firm|office)|here\b|with\s+us\b|with\s+(?:this|our)\s+(?:compan|organi))|experience\s+(?:working|employed)\s+(?:here|at\s+(?:this|our)\s+(?:compan|organi))\s+before|(?:worked|working)\s+here\s+before/i,
      kind: "yes_no", default: "No" },
    { key: "has_relevant_experience",
      // Negative lookahead: "Do you have FAMILY/RELATIVES with
      // experience at this company?" is a nepotism disclosure, not a
      // skills question — don't answer Yes (which would falsely admit
      // you have relatives working there). Those route to
      // relatives_employed (→ No) or defer to the LLM.
      // Lookahead excludes only UNAMBIGUOUS relative terms — NOT
      // "children"/"parents", which are job-domain nouns ("experience
      // working with children/parents" = childcare/teaching → Yes).
      match: /do\s+you\s+have\b(?![\s\S]{0,45}\b(?:relatives?|family|spouse|husband|wife|wives|siblings?|brothers?|sisters?|cousins?|uncles?|aunts?|nephews?|nieces?|sons?|daughters?|fianc(?:é|e|ée|ee)?|in[\s-]?laws?)\b)[\s\S]{0,90}\b(experience|certification|certified|credential|knowledge|understanding|familiar(?:ity)?|proficien(?:t|cy)|expertise|exposure|hands[\s-]?on|worked\s+(?:with|on|in)|background\s+(?:in|with))\b/i,
      kind: "yes_no", default: "Yes" },
    // "Have you <achievement verb> …?" capability/achievement toggles
    // (Ashby / Workable Yes-No pairs): "Have you shipped a production
    // app?", "Have you personally owned a feature end-to-end?", "Have
    // you worked on improving app performance?". Plus the reflective
    // "are you able to <clearly separate / articulate / describe> …?"
    // form. A job applicant answers Yes.
    //
    // The verb list is explicit (positive achievement verbs only) so
    // this never fires on No-default questions: "Have you ever been
    // convicted …" (no listed verb → no match; has_criminal_record
    // catches it), "Have you previously worked FOR us" (this needs
    // "worked on/with", not "worked for" → previously_worked_for wins),
    // and "are you able to relocate / travel / work weekends" (those
    // verbs aren't in the able-to list).
    { key: "positive_capability",
      // "used" carries a negative lookahead so "Have you used illegal
      // drugs / substances / alcohol …" can't be answered Yes — those
      // stay for their own (No-default) handling; every other "Have you
      // used <tool>?" is a Yes.
      // "worked (on|with|in)" tolerates an adverb ("previously/ever/
      // formerly worked with Kubernetes") and covers the domain-
      // experience form "worked in fintech / sales / a fast-paced
      // environment" — otherwise those fell through to
      // previously_worked_for and got a wrong "No".
      // "worked with(?! us/this/our)" so "Have you worked with us
      // before?" is left for previously_worked_for (→ No, re-hire)
      // instead of being answered Yes here.
      match: /^\s*have\s+you\s+(?:ever\s+)?(?:personally\s+)?(?:shipped|built|created|developed|designed|delivered|deployed|launched|released|owned|led|managed|maintained|implemented|architected|scaled|improved|optimi[sz]ed|handled|written|coded|contributed|mentored|automated|migrated|integrated|debugged|refactored|configured|administered|queried|tested|applied|utili[sz]ed|used(?!\s+(?:any\s+)?(?:illegal|recreational|non[\s-]?prescribed|drugs?|substances?|alcohol|narcotics?|marijuana|cannabis)))\b|have\s+you\s+(?:ever\s+|previously\s+|formerly\s+)?worked\s+(?:on|with(?!\s+(?:us|this|our)\b)|in)\b|are\s+you\s+able\s+to\s+(?:clearly\s+)?(?:separate|distinguish|articulate|describe|explain|identify|demonstrate|communicate|walk\s+(?:me|us)\s+through)\b/i,
      kind: "yes_no", default: "Yes" },
    { key: "years_of_experience",
      match: /(?:total\s+|how\s+many\s+)?years?\s+of\s+(?:relevant\s+|professional\s+|industry\s+)?(?:work\s+)?experience|years?\s+(?:have\s+you|do\s+you\s+have)\s+(?:in\s+|of\s+)?(?:relevant\s+|professional\s+)?(?:experience|work)/i,
      kind: "text", default: "5" },
    { key: "highest_education",
      match: /(?:highest|maximum)\s+(?:level\s+of\s+)?education|education(?:al)?\s+(?:level|attainment|qualification)|highest\s+(?:degree|qualification|level\s+attained)/i,
      kind: "degree_level", default: "Bachelor's" },
    { key: "field_of_study",
      // Bare "major" carries a negative lookahead so "major LIFE
      // activities" (in the disability EEO question) isn't read as a
      // college major — that stole the disability question from
      // disability_status. "What is your major?" still matches.
      // "Discipline" / "course of study" / "field/area of study" are
      // the Education-section synonyms for the degree subject; they
      // read preferences.field_of_study (e.g. "Computer Science").
      match: /(?:field|area|primary\s+area)\s+of\s+(?:study|specialization)|^\s*discipline\b|course\s+of\s+study|(?:field|area)\s+of\s+specialization|major\s+(?:subject|field|in\s+(?:university|college))|(?:what\s+(?:was|is)\s+your\s+)?(?:major(?!\s+(?:life|health|role|part|impact|concern|issues?|cit(?:y|ies)|holidays?|surgery|illness|injur\w*|changes?|difference|contributor|milestones?|players?))|specialization|degree\s+(?:subject|in))/i,
      kind: "text", default: "" },
    { key: "graduation_year",
      match: /(?:graduation|graduating?)\s+year|year\s+(?:of\s+graduation|graduated)|when\s+(?:did|will)\s+you\s+graduate/i,
      kind: "text", default: "" },
    // ── Structured Education block (School / Degree / Start / End) ──
    // Greenhouse/BambooHR "Education" sections split into a School and
    // Degree dropdown plus start/end year inputs. These read the first
    // entry of profile.data.education [{school,degree,start,end}] via
    // the "education" / "education_year" kinds (resolved in pickPreset).
    // eduField names the sub-field; education_year extracts the 4-digit
    // year from a "Month YYYY" / "2018" value.
    { key: "education_school",
      match: /^\s*school\b|^\s*university\b|^\s*college\b|^\s*institution\b|name\s+of\s+(?:school|university|college|institution)|alma\s+mater|educational\s+institution/i,
      kind: "education", eduField: "school", default: "" },
    { key: "education_degree",
      match: /^\s*degree\b|degree\s+(?:earned|obtained|type|name|received)|type\s+of\s+degree|qualification\s+(?:earned|obtained|type)|level\s+of\s+study/i,
      kind: "education", eduField: "degree", default: "" },
    { key: "education_start_year",
      match: /(?:start|from|commenc|began|begin)\s*(?:ing)?\s*(?:date\s*)?year|year\s+(?:started|of\s+enrol|of\s+admission|began|commenced)|start\s+date\s+year|enrol(?:l)?ment\s+year/i,
      kind: "education_year", eduField: "start", default: "" },
    { key: "education_end_year",
      match: /(?:end|to|completion|finish|grad)\s*(?:ing|ed)?\s*(?:date\s*)?year|year\s+(?:ended|completed|finished|of\s+completion)|end\s+date\s+year|(?:expected\s+)?completion\s+year/i,
      kind: "education_year", eduField: "end", default: "" },

    // ───────── Pre-employment standard screening ─────────
    // These three are the universal "PH: STANDARD QUESTIONS" trio
    // (and similar regional standard-screening sections elsewhere).
    // All default Yes because no working-age applicant who'd actually
    // submit an application would answer No to any of them; the
    // dashboard preference overrides exist for the rare cases where
    // a profile actually wants No (e.g., a candidate without high
    // school education who'd rather not submit at all).

    // "Are you at least 18 years of age?" / "Are you 18 or older?" /
    // "Are you 18+?". Defensive: doesn't match "18 years of experience"
    // (the years-of-experience preset matches that first because
    // it has a higher-up position in the list and uses the more
    // specific "years of experience" phrasing).
    { key: "at_least_18",
      match: /(?:at\s+least\s+|over\s+|aged\s+|age\s+of\s+)?(?:18|eighteen)\s+(?:years?\s+(?:of\s+age|old)|or\s+older|\+|\s*\+\s*$)|are\s+you\s+(?:at\s+least\s+|over\s+)?(?:18|eighteen)\b(?!\s+years?\s+of\s+experience)/i,
      kind: "yes_no", default: "Yes" },

    // "Have you completed your high school education?" /
    // "Did you complete high school?" / "Do you have a high school
    // diploma?" / "Have you finished secondary school?" + GCSE /
    // A-levels variants for UK forms.
    { key: "completed_high_school",
      match: /(?:completed|finished|graduated\s+from|have\s+a|got\s+(?:your\s+)?|do\s+you\s+have\s+(?:a\s+|your\s+)?)?(?:your\s+)?(?:high\s+school|secondary\s+school|secondary\s+education)\s+(?:education|diploma|degree|graduation|qualification|gcse|a[\s\-]levels)?|(?:high\s+school|secondary\s+school)\s+(?:diploma|graduate)/i,
      kind: "yes_no", default: "Yes" },

    // "If you are hired, can you provide proof of your identity and
    // eligibility to work in <country>?" — a separate phrasing from
    // the right_to_work_* presets (which match "authorized to work"
    // or "right to work" only). This catches the "proof / eligibility
    // / documentation" verbiage. Always-Yes by default — the
    // applicant is committing to provide standard onboarding docs.
    // "…work authorization" AND "…employment authorization" (the I-9
    // phrasing Ashby uses): the old regex only accepted "work
    // authorization", so "Are you able to show proof of EMPLOYMENT
    // authorization?" matched no preset at all and the Yes/No pair
    // stayed blank.
    { key: "provide_proof_of_eligibility",
      match: /(?:provide|show|present|furnish|produce)\s+(?:proof|documents?|evidence|documentation)\s+of\s+(?:your\s+)?(?:identity|eligibility|right\s+to\s+work|(?:work|employment)\s+authoriz\w*|legal\s+right)|eligibility\s+to\s+work\s+(?:in|here)|(?:proof|evidence)\s+of\s+(?:your\s+)?(?:right\s+to\s+work|(?:work|employment)\s+authoriz\w*|legal\s+right|identity\s+and\s+eligibility)/i,
      kind: "yes_no", default: "Yes" },
    // English level / proficiency. Pattern catches free-text inputs
    // ("Your English level"), CEFR-flavoured radio groups ("A1/A2 -
    // Basic" … "C2 - Proficient/Native"), and the common Native/Fluent
    // dropdowns. Default "C1" maps to a confident professional-fluency
    // answer that the CEFR radio matcher picks via the "C1 - Advanced"
    // option (prefix-match in fillCheckboxGroup); for plain dropdowns
    // synonyms cover Advanced / Fluent / Proficient / Native and the
    // verbatim "C1 - Advanced (fluent, can work fully in English)"
    // option text Ashby / Workable render. Native speakers can pin
    // "Native" via preferences.english_proficiency.
    { key: "english_proficiency",
      match: /(?:level\s+of\s+|your\s+)?english\s+(?:proficiency|level|fluency|skills?)|how\s+(?:would\s+you\s+rate\s+your|fluent\s+is\s+your|good\s+is\s+your)\s+english|english\s+language\s+(?:proficiency|level|fluency)/i,
      kind: "one_of",
      // Default "Advanced" reads naturally in free-text inputs
      // ("English proficiency?" → typed "Advanced"). For CEFR radio
      // groups the synonyms list includes "C1 - Advanced" (and its
      // dash variants) so fillCheckboxGroup'\''s prefix matcher still
      // commits the C1 option. Native speakers override via
      // preferences.english_proficiency.
      default: "Advanced",
      synonyms: [
        "Advanced",
        "C1",
        "C1 - Advanced",
        "C1 – Advanced",
        "C1 — Advanced",
        "C1 (Advanced)",
        "C1 - Advanced (fluent, can work fully in English)",
        "Fluent",
        "Proficient",
        "C2 - Proficient/Native",
        "C2 – Proficient/Native",
        "C2 (Native)",
        "C2 (Proficient)",
        "C2",
        "Native",
        "Native speaker",
        "Full Professional Proficiency",
      ] },

    // ───────── Background checks & consents ─────────
    { key: "okay_with_background_check",
      match: /background\s+(?:check|verification|investigation)|criminal\s+(?:history|background)\s+check|consent\s+to\s+(?:a\s+)?background|willing(?:ness)?\s+to\s+(?:consent\s+to\s+)?background/i,
      kind: "yes_no", default: "Yes" },
    { key: "okay_with_drug_test",
      match: /drug\s+(?:test|screening|screen)|substance\s+(?:test|abuse\s+screening|use\s+test)|pre[\s\-]employment\s+drug/i,
      kind: "yes_no", default: "Yes" },
    { key: "references_available",
      match: /(?:professional|work)\s+references?\s+(?:available|provided|upon|on\s+request)|(?:provide|share|supply)\s+(?:professional\s+)?references|are\s+(?:you\s+)?(?:able\s+to\s+)?(?:provide\s+)?references/i,
      kind: "yes_no", default: "Yes" },
    { key: "has_criminal_record",
      match: /(?:criminal|felony|misdemeanor)\s+(?:record|conviction|history)|ever\s+(?:been\s+)?(?:convicted|charged)|prior\s+(?:arrest|conviction)|have\s+you\s+ever\s+been\s+convicted/i,
      kind: "yes_no", default: "No" },
    { key: "requires_accommodation",
      match: /(?:require|need|request)\s+(?:reasonable\s+|any\s+)?accommodation|disability\s+accommodation|accommodation\s+(?:for\s+(?:the\s+)?(?:interview|process)|during\s+(?:the\s+)?(?:interview|hiring))/i,
      kind: "yes_no", default: "No" },
    { key: "opt_in_marketing",
      match: /(?:opt[\s\-]in|subscribe|sign\s+up|consent)\s+to\s+(?:recruiter|marketing|recruitment)\s+(?:comms?|communications?|emails?|updates?|newsletter)|hear\s+about\s+(?:future\s+(?:roles|openings|opportunities))|join\s+(?:our\s+)?(?:talent\s+(?:community|network)|talent\s+pool)/i,
      kind: "yes_no", default: "No" },

    // Interview-recording / auto-transcript consent (BrightHire, Otter,
    // Metaview, Zoom AI Companion, etc.). Default Yes — candidates who
    // submit an application generally consent to standard recruiting
    // tools; pinning No is rare but available via preferences.
    { key: "recording_consent",
      match: /(?:record(?:ing)?|transcript|auto[\s\-]?transcript)\s+(?:our|the|your)?\s*(?:interview|call|conversation|meeting)|consent\s+to\s+(?:us\s+)?(?:using\s+|recording\s+)|brighthire|otter\.ai|metaview|do\s+you\s+consent\s+to\s+(?:recording|us\s+(?:recording|using))/i,
      kind: "yes_no", default: "Yes",
      synonyms: ["Yes", "I consent", "Yes, I consent", "Yes, I agree", "Agree", "Accept"] },

    // Self-identification / EEO data-processing consent — "Please
    // confirm you consent your self-identification data to be
    // processed for the listed purposes." Common in EEO disclosure
    // sections.
    { key: "self_identification_consent",
      match: /consent\s+(?:to\s+|your\s+)?(?:self[\s\-]?identification|self[\s\-]?id|demographic)\s+data\s+(?:to\s+be\s+)?(?:processed|collected|used)|self[\s\-]?identification\s+(?:data|information)\s+(?:to\s+be\s+)?(?:processed|collected)/i,
      kind: "yes_no", default: "Yes",
      synonyms: ["Yes, I consent", "Yes", "I consent", "I agree", "Agree", "Accept", "Consent"] },

    // California Consumer Privacy Act notice — the dropdown appears
    // on most US-based ATS forms regardless of where the candidate
    // lives. Most candidates aren't CA residents, so default to that
    // option; a CA-based candidate would set
    // preferences.california_resident_notice = "Acknowledge/Confirm".
    { key: "california_resident_notice",
      match: /notice\s+at\s+collection\s+for\s+california|california\s+(?:job\s+applicants?|consumer\s+privacy|ccpa)|california\s+(?:resident|applicant)\s+(?:notice|disclosure)/i,
      kind: "sensitive", default: "I am not a California resident",
      synonyms: [
        "I am not a California resident",
        "Not a California resident",
        "I am not a CA resident",
        "Acknowledge/Confirm",
        "Acknowledge",
        "Confirm",
      ] },

    // ───────── ATS-specific catch-alls ─────────
    { key: "gdpr_data_acknowledge",
      match: /(personal data|gdpr|supervisory authority|data portability|rectifi(?:ed|cation)|erased|erasure).{0,300}(controller|rectifi|erased|erasure|portability|supervisory authority|complaint)|(controller|gdpr).{0,200}personal data/i,
      kind: "sensitive", default: "Acknowledge/Confirm",
      synonyms: ["Acknowledge/Confirm", "Acknowledge", "Confirm", "I acknowledge", "I confirm", "I agree", "Agree", "Accept", "I accept", "Yes"] },
    { key: "legally_authorized_country",
      match: /legally\s+authoriz(?:ed|e|ation)\s+to\s+(?:work|provide\s+services?)|are\s+you\s+(?:legally\s+)?authoriz(?:ed|e|ation)\s+to\s+(?:work|provide)/i,
      kind: "yes_no", default: "Yes" },
    // "Are you based in <Country> and do you have the right to work in
    // the country?" — Philippines / India / LatAm-only postings ask
    // this verbatim. Captures the country and yes/no's based on whether
    // it appears in the profile location (country_match kind).
    { key: "based_in_country_with_authorization",
      match: /are\s+you\s+(?:currently\s+)?based\s+in(?:\s+the)?\s+([A-Za-z][A-Za-z\s.'\-]+?)(?:\s+and|\s*[?*]*$)/i,
      kind: "country_match", default: "No" },
    { key: "currently_located_country",
      match: /are\s+you\s+(?:currently\s+)?located\s+in(?:\s+the)?\s+(.+?)\s*[?*]*$/i,
      kind: "country_match", default: "No" },
    // "Do you currently live in the U.S.?" / "Do you reside in
    // <Country>?" — residence yes/no. Defaults YES (affirmative, like
    // the right_to_work_* eligibility questions) so a candidate isn't
    // auto-filtered out; overridable per profile via
    // preferences.live_in_country = "No".
    // "In what city and state do you currently reside?" — wants the
    // CITY + STATE (not the full "City, State, Country"). kind
    // "city_state" joins splitLocation's city + state ("Charlotte,
    // Michigan"). MUST precede live_in_country, which otherwise grabs
    // "…do you live in?" and answers Yes.
    { key: "city_and_state",
      match: /city\s+and\s+state|state\s+and\s+city|city\s*[,/]\s*state|state\s*[,/]\s*city|(?:what|which)\s+city\s+(?:and|&)\s+state/i,
      kind: "city_state", default: "" },
    { key: "live_in_country",
      match: /do\s+you\s+(?:currently\s+)?(?:live|reside)\s+in\b|are\s+you\s+(?:currently\s+)?(?:living|residing)\s+in\b|(?:currently\s+)?(?:live|living|reside|residing|based)\s+in\s+(?:the\s+)?(?:u\.?s\.?a?\.?|united\s+states|u\.?k\.?|united\s+kingdom)\b/i,
      kind: "yes_no", default: "Yes" },
    // "Are you a Filipino citizen currently residing in the
    // Philippines?" / "Are you a citizen of and residing in <Country>?"
    // — captures the residency country (m[1]) and Yes/No's it against
    // the profile location via country_match. A PH profile whose
    // location contains "Philippines" → Yes; anyone else → No. Placed
    // before nationality (which is a free-text/sensitive field) so the
    // yes/no residency form wins for this phrasing.
    { key: "citizen_residing_country",
      match: /\b(?:citizen|citizenship|national)\b[\s\S]{0,80}?\b(?:residing|reside|living|located|based)\s+in(?:\s+the)?\s+([A-Za-z][A-Za-z\s.'\-]+?)\s*[?*.]*$/i,
      kind: "country_match", default: "No" },
    // "This role follows U.S. time zone working hours. Are you
    // comfortable working in alignment with this schedule?" + close
    // variants (night-shift / overnight / EST-PST hours).
    // Defaults to Yes with synonyms covering the common option text
    // ("Yes — I'm used to it"), since the people who'd answer No
    // wouldn't be applying to a US-hours-only role in the first place.
    // Per-profile override available via preferences.us_timezone_comfort.
    { key: "us_timezone_comfort",
      match: /(?:u\.?s\.?|american)\s+(?:time\s+zone|time-zone|timezone|working\s+hours|business\s+hours)|(?:work|working)\s+(?:in\s+alignment\s+with|to\s+match|on)\s+(?:u\.?s\.?|american)\s+(?:time|hours|schedule)|comfortable\s+(?:with|working).{0,40}(?:night\s+shift|overnight|graveyard|u\.?s\.?\s+hours)/i,
      kind: "one_of", default: "Yes",
      synonyms: [
        "Yes - I'm used to it", "Yes – I'm used to it", "Yes — I'm used to it",
        "Yes, I'm used to it", "Yes, I am used to it",
        "Yes",
        "Yes - I can adapt", "Yes – I can adapt",
      ] },
    // "Are you available to work full-time, Monday to Friday, on a day
    // shift aligned to Australian business hours?" — availability /
    // schedule questions. Requires a schedule keyword (full-time /
    // shift / hours / a weekday / business hours / …) within reach of
    // "available|able|willing|open to work|commit|start" so it doesn't
    // grab "available to relocate" (willing_to_relocate) or "able to
    // work in the US" (right_to_work — no schedule keyword there).
    { key: "available_to_work",
      match: /are\s+you\s+(?:available|able|willing|open|happy|ready)\s+to\s+(?:work|commit|start|join|begin)\b[\s\S]{0,90}\b(full[\s-]?time|part[\s-]?time|shift|hours|schedule|monday|tuesday|wednesday|thursday|friday|weekday|weekend|business\s+hours|day\s+shift|night\s+shift|overtime|flexible|\d+\s*hours)\b|are\s+you\s+available\s+(?:to\s+start\b|immediately\b|for\s+(?:full|part)[\s-]?time)/i,
      kind: "yes_no", default: "Yes" },
    // "Do you have reliable internet, power, and a suitable computer
    // for full-time remote work?" — remote-work readiness. Separate
    // from has_relevant_experience (whose keyword gate is
    // experience/skill words, none of which appear here). A candidate
    // applying for remote work answers Yes.
    { key: "remote_work_readiness",
      // Adjective list includes separate/private/designated/own/… so
      // "When working from home do you have a SEPARATE workspace?" fires
      // (a WFH-readiness question → Yes).
      match: /\b(?:reliable|stable|dedicated|suitable|quiet|good|strong|high[\s-]?speed|separate|private|designated|proper|own|distraction[\s-]?free|appropriate|functional|working)\b[\s\S]{0,60}\b(?:internet|wi[\s-]?fi|connection|broadband|workspace|work\s*space|work\s+area|home\s+office|office\s+space|computer|laptop|equipment|setup|environment|power\s+(?:supply|source|backup)?)\b|do\s+you\s+have[\s\S]{0,60}\b(?:internet|wi[\s-]?fi|workspace|home\s+office|equipment|setup)\b[\s\S]{0,40}\b(?:remote|work\s+from\s+home|wfh)\b|(?:working\s+from\s+home|remote(?:ly)?|wfh)[\s\S]{0,50}\b(?:separate|dedicated|private|designated|suitable|quiet|proper|own)\s+(?:workspace|work\s*space|work\s+area|office|room|space|environment)/i,
      kind: "yes_no", default: "Yes" },
    // "Were you referred by a current employee? If Yes: name. If No:
    // put N/A." — single text input. Default "N/A" handles the
    // common no-referral case; per-profile preferences.employee_referral
    // override lets a candidate with a referral name in hand pin it.
    { key: "employee_referral",
      // Allows a COMPANY name between "a/an" and "employee" — "referred
      // by a Directio employee" — which the old regex missed. Answer is
      // "N/A" for the free-text "if no, put N/A" variant; the "No"
      // synonym makes the Yes/No RADIO/button variant ("Were you
      // referred by a <Company> employee?") select No via
      // fillCheckboxGroup.
      match: /referred\s+by\s+(?:a\s+|an\s+|any\s+)?(?:current\s+|former\s+|existing\s+)?(?:[A-Za-z][\w.&'-]*\s+){0,2}?(?:employee|colleague|staff|team\s+member|worker)|(?:employee|staff|insider|colleague)\s+referral|(?:were|have|are)\s+you\s+(?:been\s+|being\s+)?referred\b|how\s+(?:were\s+you\s+|did\s+you\s+get\s+)?referred|did\s+(?:a\s+|an\s+|any\s+)?(?:current\s+|former\s+|existing\s+)?(?:[A-Za-z][\w.&'-]*\s+){0,2}?employee\s+refer/i,
      kind: "text", default: "N/A",
      synonyms: ["No", "N/A", "Not referred", "No referral", "None"] },
    { key: "country_of_residence",
      // Added "country in which you are located" / "country you are
      // located in" / "country you reside in" / "country are you
      // (currently) located" — Workable + a few smaller ATSes phrase
      // the location question that way and the old regex only caught
      // "country of residence" / "country you live in".
      match: /(?:in\s+(?:which|what)\s+country\s+(?:do\s+you|are\s+you)|country\s+(?:in\s+which\s+you\s+are\s+(?:located|residing)|you\s+are\s+(?:located|residing)\s+in|of\s+residence|you\s+(?:primarily\s+)?reside|you\s+live\s+in|where\s+you\s+(?:are\s+located|live|reside))|please\s+choose\s+the\s+country)/i,
      kind: "country_extract", default: "" },
    { key: "region_of_residence",
      match: /(?:in\s+(?:which|what)\s+region|region\s+(?:do\s+you|you('| a)re\s+(?:located|in|reside)|of\s+(?:residence|the\s+world)))/i,
      kind: "region_map", default: "Europe" },
    // Bare "Country" / "Country/Region" field on a decomposed address
    // (BambooHR City/State/ZIP/Country). Resolves to the country from
    // the profile location ("Pasay, Philippines" → "Philippines"), so a
    // dropdown defaulting to "United States" is corrected. Excludes
    // "Country code" (phone) and "Country of citizenship/origin"
    // (those are nationality). Handles both the dropdown (via
    // stepPresetDropdowns) and a plain-text country input (via
    // stepPresetTextInputs).
    { key: "country_field",
      match: /^\s*country\s*\*?\s*$|^\s*country\s*\/?\s*region\b|^\s*country\b(?!\s*(?:code|of\s+(?:citizenship|origin|birth|nationality)|\s+you\s+(?:reside|live)))/i,
      kind: "country_extract", default: "" },
    // "State" as a SELECT (BambooHR fabric widget, Workday). Resolves the
    // region from the profile location; the resolver also emits the
    // name↔abbreviation twin ("California"/"CA") so it matches whichever
    // form the dropdown lists.
    { key: "state_field",
      match: /^\s*(?:u\.?\s?s\.?\s+)?state\b(?![\s\S]*\b(?:visa|employment|veteran|disab|of\s+(?:mind|matter|being|the)|current\s+state\s+of)\b)|^\s*state\s*\/?\s*(?:province|region|territory)\b|^\s*province\b|^\s*region\s*\*?\s*$/i,
      kind: "state_extract", default: "" },
    // Nepotism / relatives-employed disclosure — "Do you have any
    // relatives currently employed in <Company>?" / "Are any of your
    // family members employed here?" / "Are you related to a current
    // employee?". Default No. Requires BOTH a relative term AND an
    // employment term in proximity, so it never fires on a bare "Do
    // you have family?" or an unrelated "employed" question.
    //
    // MUST sit before current_company: current_company matches
    // "currently employed/working at|for|by", which would otherwise
    // swallow "relatives currently employed AT the company" and return
    // an empty employer name. "partner" is deliberately NOT a relative
    // term here — it collides with the business "partner team /
    // partner company".
    { key: "relatives_employed",
      // "family" carries a negative lookahead so the ADJECTIVE use
      // ("family business / family-owned / family environment / family
      // firm") is NOT read as relatives — those are employer-type /
      // culture questions, not nepotism. "partner" is likewise guarded
      // against the business sense ("partner team / partner company").
      // Branch 2 (employment word BEFORE the relative) requires the
      // specific "family members"/"relatives"/… forms, never bare
      // "family", so "employed at a family business" can't false-fire.
      // "parent"/"mother" carry a business-sense guard ("parent
      // company / parent organization / mother company") like family
      // and partner, so a corporate-structure question isn't read as
      // a relative. The company-context branch catches "family /
      // relatives with experience AT this company" / "working here"
      // (nepotism phrasings that name no explicit employment verb).
      // COMPANY CONTEXT IS REQUIRED. A relative term + a bare
      // employment word ("relatives who are self-employed", "spouse
      // working full-time", "family members who work in tech",
      // "experience working with children") is NOT nepotism — those
      // are about a relative's general employment or a job DOMAIN.
      // Nepotism always ties the relative to THIS employer: "employed
      // HERE / at this|our|the company / in <NamedCompany> / with us",
      // or "with experience at this company". The named-employer branch
      // excludes generic domains (sales/tech/government/this field/…)
      // and articles so "employed in Satellite Office" matches but
      // "employed in sales" / "in this field" does not.
      match: /\b(?:relatives?|family(?![-\s]+(?:business|owned|run|friendly|firm|environment|compan|oriented|values|atmosphere|culture|feel|vibe|responsibilit|matters?|reasons?|leave|emergenc|obligations?))(?:\s+members?|\s+member)?|member\s+of\s+(?:your|the)\s+family|immediate\s+family|spouse|husband|wife|wives|fianc(?:é|e|ée|ee)?|(?:domestic\s+|life\s+)?partner(?!\s+(?:team|compan|firm|organi|ecosystem|network|program|manager|portal|ship|s\b))|siblings?|brothers?|sisters?|parents?(?!\s+(?:compan|organi|org\b|entity|entit|firm|group|co\b|holding))|mother(?!\s+(?:compan|organi|ship|tongue|board|language))|father|child(?:ren)?|sons?|daughters?|uncles?|aunts?|cousins?|nephews?|nieces?|in[\s-]?laws?)\b[\s\S]{0,50}(?:(?:employed|work(?:ing|ed|s)?|hired|on\s+staff)\b[\s\S]{0,25}(?:\bhere\b|at\s+(?:this|our|the)\s+(?:compan|organi|firm|office|team|business|group|department)|(?:in|for|with|by)\s+(?:this|our|the)\s+(?:compan|organi|office|firm|group)|(?:by|for|with)\s+us\b|at\s+our\b)|(?:currently\s+)?employed\s+(?:in|at|by)\s+(?!(?:a|an|the|this|our|your|my|another|other|various|different|multiple|several|numerous|self|sales|tech|technology|healthcare|finance|banking|insurance|marketing|advertising|education|academia|retail|hospitality|consulting|manufacturing|logistics|construction|government|law|medicine|nursing|teaching|hr|the\s+(?:field|industry|sector|public|private|same)|this\s+(?:field|industry|sector|space|area))\b)\w|(?:at|with|for|in|of)\s+(?:this|our)\s+(?:compan|organi|firm|business|team)|(?:an?\s+|our\s+|the\s+|any\s+)?(?:current|existing|company|permanent|former|past|previous|full[\s-]?time)\s+employees?\b|employees?\s+(?:\bhere\b|of\s+(?:this|our|the)|at\s+(?:this|our))|working\s+here|employed\s+here)|\brelated\s+to\s+(?:any(?:one|body)|(?:any|a|an|the)\s+(?:of\s+(?:our|the|your)\s+)?(?:current\s+|existing\s+)?(?:employees?|staff|members?|colleagues?))|do\s+you\s+know\s+(?:any(?:one|body)|someone)\b[\s\S]{0,40}\b(?:employed|works?\s+(?:here|at|for)|currently\s+work)/i,
      kind: "yes_no", default: "No" },
    { key: "current_company",
      match: /(?:^|\s)current\s+(?:company|employer|workplace|organi[sz]ation)|currently\s+(?:work(?:ing)?|employed)\s+(?:at|for|by)|current\s+place\s+of\s+(?:work|employment)|most\s+recent\s+(?:company|employer)/i,
      kind: "current_company", default: "" },
    { key: "current_location_field",
      match: /(?:^|\s)current\s+location|currently\s+(?:located|live|living|resid(?:e|ing))\s+in|where\s+(?:do\s+you|are\s+you)\s+(?:currently\s+)?(?:located|live|based|resid(?:e|ing))|city\s+of\s+residence/i,
      kind: "text", default: "", readFromContact: "location" },
    // Nepotism / relatives-employed disclosure — "Do you have any
    // relatives currently employed in <Company>?" / "Are any of your
    // family members employed here?" / "Are you related to a current
    // employee?". Default No. Requires BOTH a relative term AND an
    // employment term in proximity, so it never fires on a bare "Do
    // you have family?" or an unrelated "employed" question. Placed
    // before previously_worked_for (which only matches "have/did YOU …
    // worked", not "do you have relatives … employed").
    // "Have you been previously employed by …?" / "Have you previously
    // worked at …?" / "Have you ever worked for …?". Old regex required
    // "been employed" ADJACENT, so "been PREVIOUSLY employed" slipped
    // through — rebuilt to allow adverbs in between.
    //
    // Prepositions are (for|at|by) ONLY — NOT "in"/"with". "worked in
    // <domain>" (sales/fintech/agile teams) and "worked with <tech>"
    // are EXPERIENCE questions (positive_capability → Yes), not re-hire.
    // "at" excludes "at a/an <type>" ("worked at a startup" = experience)
    // so only "at <Company>/this/our" reads as a re-hire employer.
    { key: "previously_worked_for",
      // All three prepositions carry a guard so a GENERIC employer type
      // ("worked for a nonprofit / clients / other companies / more
      // than 5 years", "employed by a staffing agency", "worked at a
      // startup") reads as EXPERIENCE, not re-hire. Only a concrete
      // employer — "for us / this / our", "by <Name>", "at <Name>/this/
      // our", "here" — matches. FOR-guard also blocks durations
      // ("for 5 years / more than / over") and plural/other-employer
      // objects ("clients / customers / companies / other / various").
      // ALL three prepositions share the same generic-employer guard
      // (the "at" branch previously only blocked "a/an", so "worked at
      // multiple / other / several companies" leaked through as
      // re-hire). Blocks articles, durations, plural/generic employer
      // types, and third-parties ("our clients / partners"), leaving
      // only concrete employers: "for us", "by <Name>", "at <Name>/
      // this/our", "here".
      match: /(?:have|did)\s+you\s+(?:ever\s+|previously\s+|formerly\s+)?(?:been\s+)?(?:previously\s+|formerly\s+|ever\s+)?(?:employed|worked|work|hired)\s+(?:for|by|at)(?!\s+(?:a|an|more|over|about|approximately|around|roughly|nearly|at\s+least|several|many|multiple|numerous|other|another|various|different|large|small|the\s+past|self|yourself|myself|ourselves|themselves|himself|herself|competitors?|clients?|customers?|partners?|vendors?|suppliers?|companies|organi[sz]ations|firms|enterprises|startups?|employers?|businesses|(?:our|the)\s+(?:clients?|customers?|partners?|vendors?|competitors?|suppliers?)|\d)\b)\b|(?:previously|formerly)\s+(?:employed|worked|hired)\s+(?:for|by|at)(?!\s+(?:a|an|more|over|about|approximately|around|roughly|nearly|at\s+least|several|many|multiple|numerous|other|another|various|different|large|small|the\s+past|self|yourself|myself|ourselves|themselves|himself|herself|competitors?|clients?|customers?|partners?|vendors?|suppliers?|companies|organi[sz]ations|firms|enterprises|startups?|employers?|businesses|(?:our|the)\s+(?:clients?|customers?|partners?|vendors?|competitors?|suppliers?)|\d)\b)\b|(?:employed|worked)\s+(?:here\b|there\b|with\s+us|for\s+us|by\s+us|at\s+(?:this|our)\b)|been\s+employed\s+(?:here|there|with\s+us|by\s+us|at\s+(?:this|our)|previously\b|in\s+the\s+past)|been\s+(?:an?\s+)?(?:employee|staff\s+member|team\s+member)\s+(?:here|at\s+(?:this|our)|with\s+us|previously\b)|(?:previous|prior|former)\s+(?:employee|employment|work|position|role|tenure|stint)\s+(?:at|with|for|here|in\s+(?:this|our))|former\s+(?:employee|employment)\b/i,
      kind: "yes_no", default: "No" },
    { key: "referral_source",
      // "how|where did you hear/learn/find out/discover about us/this
      // opening?". The about-context (us|this|the role|opening) is
      // REQUIRED so "how did you learn Python?" (a skills question)
      // doesn't false-match.
      match: /(?:how|where)\s+did\s+you\s+(?:hear|find\s+out|learn|come\s+(?:across|to\s+know)|discover|see|first\s+(?:hear|learn))\s+(?:about\s+)?(?:us\b|this\b|the\s+(?:role|position|opening|job|company|vacancy|posting|opportunity))|referral\s+source|source\s+of\s+(?:this\s+)?(?:referral|application)|how\s+were\s+you\s+referred|where\s+did\s+you\s+(?:see|find)\s+(?:this|the|our)\b/i,
      kind: "sensitive", default: "LinkedIn",
      synonyms: ["LinkedIn", "LinkedIN", "Linked In", "LinkedIn Jobs", "LinkedIn Job Search", "Found on LinkedIn"] },
    // "If 'Other,' please specify." — the free-text follow-up to a
    // "Where did you hear about us?" radio. We pick a real option
    // (LinkedIn), so the Other box is N/A. Scoped to require "other"
    // near "specify/explain" so it never matches "please specify your
    // salary".
    { key: "other_specify",
      match: /\bif\s+['"‘’]?\s*other\b|if\s+you\s+(?:selected|chose|picked|answered|indicated)\s+['"‘’]?\s*other|other[\s,:'"‘’]*\(?\s*please\s+(?:specify|explain|describe|state|elaborate)|please\s+specify\s+(?:below\s+)?(?:if\s+)?(?:you\s+(?:selected|chose)\s+)?other/i,
      kind: "text", default: "N/A" },
    { key: "professional_languages",
      match: /(?:speak|fluent|fluency)\s+(?:multiple\s+)?languages?\s+(?:at\s+)?(?:a\s+)?(?:professional|business|fluent)\s+level|(?:professional|business)\s+(?:languages?|fluency)|languages\s+spoken/i,
      kind: "languages", default: "English" },

    // ───────── Demographic / EEO ─────────
    { key: "disability_status",
      match: /(disabilit|disabled|long.?term illness|chronic illness|niepełnosprawn|behinderung|discapacidad|handicap)/i,
      kind: "sensitive", default: "No",
      synonyms: ["No", "No, I do not have a disability", "I don't have a disability", "Prefer not to say", "Decline to answer"] },
    { key: "veteran_status",
      match: /(veteran|military|serv(ed|ice).*armed|weteran|veteran(er)?|veterano|ancien combattant)/i,
      kind: "sensitive", default: "No",
      synonyms: ["No", "I am not a protected veteran", "Not a veteran", "I am not a veteran", "Prefer not to say", "Decline to answer"] },
    { key: "lgbtq_identification",
      match: /(lgbt|lgbtq|lgbtqia|do you identify as lgbt)/i,
      kind: "sensitive", default: "No",
      // Negative long-forms come BEFORE the prefer-not fallbacks so a
      // "No, I do not identify …" option is matched first. Without
      // them, a form whose negative option is phrased WITHOUT the word
      // "No" ("I do not identify as a member of the LGBTQIA+
      // community") left the bare "No" candidate matching nothing, so
      // the flow fell to "Prefer not to say" — which token-overlaps
      // "Prefer not to respond" and got picked, overriding the user's
      // "No". Mirrors disability_status' negative-first synonym list.
      synonyms: [
        "No",
        "No, I do not identify as LGBTQ+",
        "No, I do not identify",
        "I do not identify as LGBTQ+",
        "I do not identify as a member of the LGBTQIA+ community",
        "I don't identify as LGBTQ+",
        "Not a member",
        "Prefer not to say",
        "Prefer not to respond",
        "Decline to answer",
      ] },
    { key: "sexual_orientation",
      match: /(sexual orientation|orientation sexuelle|orientación sexual|orientacj(a|i) seksu|sexuelle orientierung)/i,
      kind: "sensitive", default: "Heterosexual",
      synonyms: ["Heterosexual", "Straight", "Heterosexual/Straight", "Prefer not to say", "Decline to answer"] },
    // "Do you identify as transgender?" — a Yes/No EEO question, NOT a
    // gender-identity dropdown. MUST come before gender_identity (which
    // matches "identify as" and would return "Male", whose
    // "Prefer not to say" synonym fuzzy-matched "I prefer to
    // self-describe"). Default No; negative synonyms first so the bare
    // "No" option is picked before any prefer-not fallback.
    { key: "transgender_identity",
      match: /\btransgender\b|identif(?:y|ies)\s+as\s+trans\b|\bare\s+you\s+trans(?:gender)?\b|\btrans\s*(?:gender|\*)\b/i,
      kind: "sensitive", default: "No",
      synonyms: [
        "No",
        "No, I do not identify as transgender",
        "I do not identify as transgender",
        "Not transgender",
        "Cisgender",
        "Prefer not to say",
        "Decline to answer",
      ] },
    { key: "gender_identity",
      match: /(what.*gender|gender identity|gender\b|identif(y|ies)\s+as|płeć|geschlecht|género|genre)/i,
      kind: "sensitive", default: "Male",
      synonyms: ["Male", "Man", "M", "Prefer not to say", "Decline to answer"] },
    // "Are you Hispanic or Latino?" — a standalone Yes/No/Decline EEO
    // question (Rippling, US OFCCP forms), distinct from the race
    // picker. MUST come before `ethnicity`, which also matches the word
    // "hispanic"/"latino" and would otherwise answer "White" — a value
    // that never matches a Yes/No/Decline dropdown, so the field
    // silently stayed on "Select…". The regex is deliberately narrow —
    // an INTERROGATIVE ("are you … hispanic/latino"), an "…origin/
    // descent/ethnicity" phrase, or a whole-label "Hispanic or Latino?"
    // — so a RACE group whose OPTIONS merely include "Hispanic or
    // Latino" (checkbox option-text fallback) still routes to ethnicity.
    { key: "hispanic_or_latino",
      match: /are\s+you\s+(?:of\s+)?(?:hispanic|latino)|(?:hispanic|latino)\s+(?:or\s+(?:latino|hispanic)\s+)?(?:origin|descent|ethnicity|heritage)|^\s*(?:hispanic|latino)\s*(?:\/|\s+or\s+)\s*(?:latino|hispanic)\s*\??\s*$/i,
      kind: "sensitive", default: "No",
      synonyms: ["No", "Not Hispanic or Latino", "I am not Hispanic", "I am not Latino", "Prefer not to say", "Decline to answer"] },
    { key: "ethnicity",
      match: /(ethnic|race|hispanic|latino|pochodzeni(e|a) etniczne|ethnie|etnia|race ou origine)/i,
      kind: "sensitive", default: "White",
      // Alternate PHRASINGS of the answer only — never a different
      // ethnicity. "Asian" used to sit here, so a form without a "White"
      // option would have answered "Asian" outright, and a "select all
      // that apply" checkbox list ticked both.
      synonyms: ["White", "White or European", "White (Not Hispanic or Latino)", "White or Caucasian", "Caucasian", "Prefer not to say", "Decline to answer"] },
    // Nationality / country of citizenship. Distinct from ethnicity:
    // "Filipino" / "Polish" / "American". Default kept neutral ("Prefer
    // not to say") so a misfire on an EEO form never invents a country
    // for the candidate — the per-profile preferences override is the
    // canonical source.
    { key: "nationality",
      match: /\bnationality\b|\bcitizenship\b|country\s+of\s+(citizenship|origin)|narodowość|staatsangehörigkeit|nacionalidad|nationalité/i,
      // kind "nationality": resolved from preferences.nationality, else
      // the demonym derived from the profile location ("Pasay,
      // Philippines" → "Filipino"). A required free-text "Nationality*"
      // field wants the actual nationality, not the EEO-safe "Prefer
      // not to say" — that stays only as the final fallback when the
      // location has no recognisable country. Synonyms carry the
      // country name + prefer-not so a dropdown offering either shape
      // still commits.
      kind: "nationality", default: "Prefer not to say",
      synonyms: ["Prefer not to say", "Decline to answer"] },
    { key: "pronouns",
      match: /(pronouns|preferred pronouns|zaimki|pronombres|pronoms)/i,
      kind: "sensitive", default: "he/him",
      synonyms: ["he/him", "He/Him", "He/him/his", "Prefer not to say"] },

    // Religion. Standard PH / SEA / MEA application screening field.
    // Default kept neutral so we don't impose an answer where the
    // user hasn't expressed one; admins pin it via
    // preferences.religion. Synonyms cover the common ATS option
    // texts so substring/exact match commits cleanly.
    { key: "religion",
      match: /\breligion\b|religious\s+(?:affiliation|belief|preference)|\bfaith\b\s*(?:tradition|background)?/i,
      kind: "sensitive", default: "Prefer not to say",
      synonyms: [
        "Prefer not to say", "Decline to answer",
        "Christian", "Catholic", "Roman Catholic", "Protestant",
        "Muslim", "Islam", "Hindu", "Buddhist", "Jewish",
        "Atheist", "Agnostic", "None", "Other",
      ] },

    // Marital status — appears on PH / SEA / MEA forms and a few
    // background-check screens. Same neutral-default policy as
    // religion / nationality.
    { key: "marital_status",
      match: /marital\s+status|civil\s+status|are\s+you\s+(?:currently\s+)?married|stan\s+cywilny|familienstand|estado\s+civil|état\s+civil/i,
      kind: "sensitive", default: "Prefer not to say",
      synonyms: [
        "Prefer not to say", "Decline to answer",
        "Single", "Married", "Divorced", "Separated", "Widowed",
        "In a relationship", "Domestic partnership", "Civil union",
      ] },

    // Age bracket — discrete bucket pickers ("18-24", "25-34",
    // "35-44", …). Default "25-34" matches the median engineering
    // applicant; admins can switch buckets per profile via
    // preferences.age_bracket. Synonyms include the dash variants
    // (en-dash, em-dash, hyphen, "to", and the spaced forms) so
    // exact/substring matching commits regardless of how the ATS
    // renders the range.
    { key: "age_bracket",
      match: /\bage\s+(?:bracket|range|group|band)\b|what\s+is\s+your\s+age\s+(?:range|group)/i,
      kind: "sensitive", default: "25-34",
      synonyms: [
        "25-34", "25 - 34", "25 – 34", "25 to 34", "25–34",
        "18-24", "35-44", "45-54", "55-64", "65+",
        "Prefer not to say", "Decline to answer",
      ] },
    { key: "first_generation_college",
      match: /first[\s\-]generation\s+college|first\s+(?:person\s+)?in\s+(?:your|my)\s+(?:immediate\s+)?family\s+to\s+(?:go\s+to|attend|complete)\s+(?:college|university)/i,
      kind: "sensitive", default: "No",
      synonyms: ["No", "Prefer not to say", "Decline to answer"] },

    // ───────── Location / contact (typeahead-friendly) ─────────
    { key: "current_location",
      match: /(where.*currently located|current location|city of residence|miasto zamieszkania|aktueller wohnort|ciudad actual|ville actuelle)/i,
      kind: "text", default: "", readFromContact: "location" },
    { key: "date_of_birth",
      match: /(date of birth|birth date|^dob$|^d\.o\.b\.|data urodzenia|geburtsdatum|fecha de nacimiento|date de naissance)/i,
      kind: "date", default: "", readFromContact: "date_of_birth" },
    { key: "phone_country_code",
      match: /(country code|dialing code|kierunkowy|landesvorwahl|código de país|indicatif pays)/i,
      kind: "text", default: "", readFromContact: "phone_country_code" },
  ];

  // Register all presets up-front. registerPreset is idempotent so
  // re-loading the file (hot-reload) doesn't duplicate entries.
  for (const p of SCREENING_PRESETS) registerPreset(p);

  /** Pick the first preset whose regex hits the label and resolve its
   *  answer for the current profile. Returns
   *  { key, kind, answer, synonyms } or null. */
  function pickPreset(label, profilePrefs, profileContact, profileData) {
    if (!label) return null;
    const presets = ns.pipeline.registry.getPresets();
    const text = String(label).replace(/\s+/g, " ");
    for (const p of presets) {
      const m = p.match.exec(text);
      if (!m) continue;

      const explicit = profilePrefs && Object.prototype.hasOwnProperty.call(profilePrefs, p.key)
        ? profilePrefs[p.key]
        : null;
      let resolved = (explicit && String(explicit).trim()) ? explicit : null;

      if (!resolved && p.readFromContact && profileContact) {
        const v = profileContact[p.readFromContact];
        if (v && String(v).trim()) resolved = v;
      }
      if (p.kind === "degree_level") {
        // "Highest level of education" as a dropdown/text. Resolve the
        // level from the explicit pref (above), else the structured
        // education entry's degree, else the preset default; attach
        // concrete Science-preferred degreeSynonyms so a "Bachelor of
        // Arts / Bachelor of Science" dropdown commits Science instead of
        // token-matching the first "…of Arts" option.
        let lvl = resolved;
        if (!lvl) {
          const edu = profileData && Array.isArray(profileData.education) ? profileData.education : [];
          const top = edu.find((e) => e && e.degree && String(e.degree).trim());
          if (top) lvl = String(top.degree).trim();
        }
        if (!lvl) lvl = p.default;
        return { key: p.key, kind: p.kind, answer: lvl, synonyms: degreeSynonyms(lvl, degreeFieldHint(profileData, profilePrefs)) };
      }
      if (!resolved && p.kind === "country_match") {
        const country = (m[1] || "").replace(/[?\s*]+$/g, "").trim();
        const loc = profileContact && profileContact.location
          ? String(profileContact.location).trim()
          : "";
        if (country && loc) {
          const cnLc = country.toLowerCase();
          const locLc = loc.toLowerCase();
          resolved = locLc.includes(cnLc) || cnLc.includes(locLc) ? "Yes" : "No";
        } else {
          resolved = p.default;
        }
      }
      if (!resolved && p.kind === "country_extract") {
        // Use splitLocation().country (recognised country only) rather
        // than the raw last comma-segment — otherwise a location with
        // no country ("San Francisco, California") would fill a Country
        // field with the region/city ("California").
        const loc = profileContact && profileContact.location;
        const country = splitLocation(loc).country;
        if (country) resolved = country;
        else if (locationImpliesUS(loc)) {
          // US address with no explicit country token (BambooHR
          // "Wexford, PA 15090"): resolve to the United States and offer
          // the common option spellings so whichever the dropdown lists
          // matches.
          return {
            key: p.key, kind: p.kind, answer: "United States",
            synonyms: ["United States", "United States of America", "USA", "US", "U.S.", "U.S.A."],
          };
        }
      }
      if (p.kind === "state_extract") {
        // Region from the profile location ("San Francisco, California,
        // United States" → "California"). Emit both the full name and the
        // 2-letter abbreviation so the option matches regardless of how
        // the dropdown labels it.
        const st = resolved || splitLocation(profileContact && profileContact.location).state;
        if (st) {
          const twin = usStateTwin(st);
          return { key: p.key, kind: p.kind, answer: twin.full || st, synonyms: [twin.full, twin.abbr, st].filter(Boolean) };
        }
      }
      if (!resolved && p.kind === "city_state") {
        // "City, State" (drop the country) from the profile location.
        const { city, state } = splitLocation(profileContact && profileContact.location);
        const parts = [city, state].filter(Boolean);
        resolved = parts.length
          ? parts.join(", ")
          : String((profileContact && profileContact.location) || "").trim();
      }
      if (!resolved && (p.kind === "education" || p.kind === "education_year")) {
        // Read the first meaningful entry of profile.data.education
        // [{school,degree,start,end}]. education_year extracts the
        // 4-digit year from a "Month YYYY" / "2018" value.
        const edu = profileData && Array.isArray(profileData.education) ? profileData.education : [];
        const top = edu.find((e) => e && (e.school || e.degree || e.start || e.end));
        let v = top ? String(top[p.eduField] || "").trim() : "";
        if (p.kind === "education_year" && v) {
          const ym = v.match(/\b(?:19|20)\d{2}\b/);
          v = ym ? ym[0] : "";
        }
        // Fallbacks to the flat preferences when the structured
        // education array is empty or missing the sub-field.
        if (!v && p.eduField === "degree") v = String((profilePrefs && profilePrefs.highest_education) || "").trim();
        if (!v && p.eduField === "end") {
          const g = String((profilePrefs && profilePrefs.graduation_year) || "").trim();
          const ym = g.match(/\b(?:19|20)\d{2}\b/);
          v = ym ? ym[0] : "";
        }
        if (v && p.eduField === "degree") {
          // A degree dropdown option is usually the LEVEL, phrased
          // "Bachelors Degree" / "Bachelor's Degree" / "Bachelor of
          // Science" / "BS" — the profile's "Bachelor's" won't
          // fuzzy-match those (apostrophe / no shared token). Emit
          // level-based synonyms so selectDropdownOption commits.
          return { key: p.key, kind: p.kind, answer: v, synonyms: degreeSynonyms(v, degreeFieldHint(profileData, profilePrefs)) };
        }
        if (v) resolved = v;
      }
      if (!resolved && p.kind === "nationality") {
        // preferences.nationality already handled by the explicit
        // check above; here derive the demonym from location.
        const demonym = deriveNationality(profileContact && profileContact.location);
        if (demonym) {
          return {
            key: p.key, kind: p.kind, answer: demonym,
            // Add the country name so a nationality DROPDOWN listing
            // countries ("Philippines") still matches, plus the
            // prefer-not fallbacks for privacy-only option sets.
            synonyms: [
              demonym,
              extractCountryFromLocation(profileContact && profileContact.location),
              "Prefer not to say", "Decline to answer",
            ].filter(Boolean),
          };
        }
      }
      if (!resolved && p.kind === "region_map") {
        const region = inferRegionFromLocation(profileContact && profileContact.location);
        if (region) resolved = region;
      }
      if (!resolved && p.kind === "current_company") {
        const exp = profileData && Array.isArray(profileData.experience) ? profileData.experience : [];
        const top = exp.find((e) => e && e.company && String(e.company).trim());
        if (top) resolved = String(top.company).trim();
      }
      // "Discipline" / "Field of study" with no explicit preference: fall
      // back to the education entry's field/major, else the subject baked
      // into its degree string ("… - BS, Computer Science"). Without this
      // the box was simply left on "Select…".
      if (!resolved && p.key === "field_of_study") {
        resolved = degreeFieldHint(profileData, profilePrefs);
      }
      if (!resolved) resolved = p.default;
      return { key: p.key, kind: p.kind, answer: resolved, synonyms: p.synonyms || null };
    }
    return null;
  }

  ns.handlers.presets.pickPreset = pickPreset;
  ns.handlers.presets.parseAgeRange = parseAgeRange;
  ns.handlers.presets.pickAgeBracketOption = pickAgeBracketOption;
  ns.handlers.presets.SCREENING_PRESETS = SCREENING_PRESETS;
  ns.handlers.presets.inferRegionFromLocation = inferRegionFromLocation;
})();
