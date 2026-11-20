/* =====================================================================
 * extractors/structured/jobmeta.js — job-posting metadata
 * (location, remote/hybrid/onsite, employment type, experience level,
 * salary, posted date, expiration date).
 * =====================================================================
 * Separate from jsonld.js (which only ever reads title/company/
 * description/jobLocationType, the fields job-fit.js's own extraction
 * flow actually needs) — this reads the REST of the same schema.org
 * JobPosting object (employmentType/baseSalary/datePosted/validThrough/
 * jobLocation), re-parsing the <script type="application/ld+json">
 * blocks independently rather than threading more fields through
 * job-fit.js's own multiple return paths (3 separate `return {...}`
 * points, each already carefully tuned for title/company/description
 * provenance — safer to leave alone).
 *
 * Called once per detection pass from a single shared hook point for
 * EACH of Big Banana's two job-detection code paths — content-detect.js
 * (the old generic system, non-ported sites) and
 * job-detect/engine/parser.js's defaultMessageSender (the new per-site
 * system all 46+ ported ATSes use) — so every site gets this for free,
 * no per-site-file changes needed. See both files' own comments.
 *
 * BidHub's own equivalent (confirmed via direct research of its bundles)
 * has NO client-side extraction for experience level or an expiration/
 * deadline date at all — those two are presumably derived server-side.
 * Experience level here is therefore a best-effort TITLE-text heuristic
 * (the only universally-available signal), not a port of anything real —
 * flagged as such below. Everything else (location, work model,
 * employment type, salary, posted date) IS the same schema.org
 * JobPosting vocabulary BidHub's own Ashby/SmartRecruiters/Paycom
 * parsers already read as their primary or fallback source.
 * ===================================================================== */
(function () {
  "use strict";

  // Checked in priority order — a title naming more than one level (e.g.
  // "Senior Engineering Manager") reads as the MORE senior/specific one.
  const EXPERIENCE_LEVEL_PATTERNS = [
    [/\b(vp|vice[\s-]president|chief\b|c[a-z]o\b|head\s+of)\b/i, "Executive"],
    [/\bdirector\b/i, "Director"],
    [/\b(lead|manager|managing)\b/i, "Lead / Manager"],
    [/\b(staff|principal)\b/i, "Staff / Principal"],
    [/\b(senior|sr\.?)\b/i, "Senior"],
    [/\bmid[\s-]?level\b/i, "Mid Level"],
    [/\bassociate\b/i, "Associate"],
    [/\b(entry[\s-]?level|junior|jr\.?)\b/i, "Entry Level"],
    [/\b(intern(ship)?)\b/i, "Internship"],
  ];
  function detectExperienceLevel(title) {
    const t = String(title || "");
    for (const [re, label] of EXPERIENCE_LEVEL_PATTERNS) {
      if (re.test(t)) return label;
    }
    return "";
  }

  const EMPLOYMENT_TYPE_LABELS = {
    full_time: "Full time", fulltime: "Full time",
    part_time: "Part time", parttime: "Part time",
    contractor: "Contract", contract: "Contract",
    temporary: "Temporary", temp: "Temporary",
    intern: "Internship", internship: "Internship",
    volunteer: "Volunteer",
    per_diem: "Per diem", perdiem: "Per diem",
    other: "Other",
  };
  function normalizeEmploymentType(raw) {
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const r of list) {
      const key = String(r || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (EMPLOYMENT_TYPE_LABELS[key]) return EMPLOYMENT_TYPE_LABELS[key];
    }
    return "";
  }

  // "onsite" (not "on-site") is the canonical key the side panel's own
  // badge-color lookup uses — see sidepanel.js's WORK_MODEL_COLORS.
  const WORK_MODEL_KEYS = { telecommute: "remote", remote: "remote", hybrid: "hybrid", onsite: "onsite", on_site: "onsite" };
  function normalizeWorkModel(raw) {
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const r of list) {
      const key = String(r || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (WORK_MODEL_KEYS[key]) return WORK_MODEL_KEYS[key];
    }
    return "";
  }

  const CURRENCY_SYMBOLS = { USD: "$", CAD: "$", AUD: "$", EUR: "€", GBP: "£" };
  const SALARY_UNIT_LABELS = { YEAR: "year", MONTH: "month", WEEK: "week", DAY: "day", HOUR: "hour" };
  function formatSalary(baseSalary) {
    if (!baseSalary) return "";
    const value = baseSalary.value || baseSalary;
    const currency = String(baseSalary.currency || value.currency || "USD").toUpperCase();
    const symbol = CURRENCY_SYMBOLS[currency] || (currency ? currency + " " : "");
    const unit = SALARY_UNIT_LABELS[String(value.unitText || "").toUpperCase()] || "";
    const min = Number(value.minValue);
    const max = Number(value.maxValue);
    const single = Number(value.value);
    const fmt = (n) => symbol + Math.round(n).toLocaleString("en-US");
    let text = "";
    if (Number.isFinite(min) && Number.isFinite(max) && max > min) text = `${fmt(min)} - ${fmt(max)}`;
    else if (Number.isFinite(min)) text = `${fmt(min)}+`;
    else if (Number.isFinite(max)) text = `Up to ${fmt(max)}`;
    else if (Number.isFinite(single)) text = fmt(single);
    if (text && unit) text += ` / ${unit}`;
    return text;
  }

  function daysBetween(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return Math.round((Date.now() - d.getTime()) / 86400000);
  }
  // Bare relative phrases (no "Posted"/"Expires" verb baked in) — the side
  // panel shows its own "Posted:"/"Expiration:" label ahead of these, so a
  // built-in verb would read redundant ("Posted: Posted 7 days ago").
  function formatPosted(datePosted) {
    const days = daysBetween(datePosted);
    if (days == null || days < 0) return "";
    if (days === 0) return "Today";
    if (days === 1) return "1 day ago";
    return `${days} days ago`;
  }
  function formatExpiration(validThrough) {
    const d = new Date(validThrough);
    if (Number.isNaN(d.getTime())) return "";
    const daysLeft = Math.round((d.getTime() - Date.now()) / 86400000);
    if (daysLeft < 0) {
      const ago = Math.abs(daysLeft);
      return `Expired ${ago} day${ago === 1 ? "" : "s"} ago`;
    }
    if (daysLeft === 0) return "Today";
    return `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;
  }

  function findJobPostingLd(doc) {
    const scripts = (doc || document).querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      let parsed;
      try {
        parsed = JSON.parse(s.textContent || "");
      } catch {
        continue;
      }
      const items = Array.isArray(parsed) ? parsed : parsed && parsed["@graph"] ? parsed["@graph"] : [parsed];
      for (const item of items) {
        const t = item && item["@type"];
        if (t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"))) return item;
      }
    }
    return null;
  }

  function extractLocationText(item) {
    const loc = item && item.jobLocation;
    const one = Array.isArray(loc) ? loc[0] : loc;
    const addr = one && one.address;
    if (!addr) return "";
    const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
    return parts.join(", ");
  }

  /* ---- DOM fallback ---------------------------------------------------
   * Plenty of real postings (confirmed: Greenhouse's job-boards.greenhouse.io
   * /embed/job_app widget — e.g. the Xai/SpaceX "Mobile Android Engineer"
   * listing) ship NO JSON-LD JobPosting at all, even though the location and
   * salary are sitting in plain visible text. jsonld.js/job-fit.js and the
   * per-site job-detect/sites/*.js parsers (Ashby, etc.) sometimes compute
   * richer facts internally, but only expose title/company/description on
   * detectedResult — never the raw location/salary — so this can't just
   * read something already threaded through. Only used when JSON-LD gave
   * nothing for that field; JSON-LD, being structured data, always wins
   * when present. */
  const LOCATION_SELECTORS = [
    ".job__location", // Greenhouse new-UI template + embed widget
    "[data-testid*='location' i]",
    ".posting-categories .location", // Lever
    "[class*='job-location' i]",
    "[class*='posting-location' i]",
  ];
  function domLocationFallback(doc) {
    for (const sel of LOCATION_SELECTORS) {
      let el;
      try {
        el = doc.querySelector(sel);
      } catch {
        continue;
      }
      const t = el && el.textContent && el.textContent.trim();
      // Reject anything implausibly long — a bad selector match grabbing a
      // whole sidebar reads as noise, not a location string.
      if (t && t.length > 0 && t.length <= 120) return t;
    }
    return "";
  }

  // Requires comma-grouped thousands ($180,000) so a stray small dollar
  // figure elsewhere on the page ("$5 fee", "$12M raised") can't match —
  // real salary figures are always at least 4 digits.
  const SALARY_RANGE_RE =
    /[$€£]\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?\s*(?:-|–|to)\s*[$€£]?\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:\s*(?:USD|CAD|AUD|EUR|GBP))?/i;
  const SALARY_SINGLE_RE = /[$€£]\s?\d{1,3}(?:,\d{3})+(?:\.\d+)?\s*\/\s*(?:year|yr|month|mo|hour|hr|week)/i;
  function domSalaryFallback(doc) {
    const container =
      doc.querySelector(".job__description, [class*='job-description' i], #content, main") || doc.body;
    const text = (container && container.innerText) || "";
    const m = text.match(SALARY_RANGE_RE) || text.match(SALARY_SINGLE_RE);
    return m ? m[0].replace(/\s+/g, " ").trim() : "";
  }

  // Scoped to the location string itself (not the whole page body) — "remote"
  // shows up constantly in unrelated marketing copy ("fully remote team
  // culture") on a posting that is itself on-site; a false "Remote" badge is
  // worse than none, so this only fires on a signal placed right next to
  // the location.
  const WORK_MODEL_KEYWORDS = [
    [/\bremote\b/i, "remote"],
    [/\bhybrid\b/i, "hybrid"],
    [/\bon[\s-]?site\b/i, "onsite"],
  ];
  function workModelFromText(text) {
    for (const [re, key] of WORK_MODEL_KEYWORDS) {
      if (re.test(text)) return key;
    }
    return "";
  }

  /* ---- Greenhouse boards-api fallback ---------------------------------
   * A real-world gap the above two layers can't close: Greenhouse pages
   * (hosted board AND the company-embedded ?gh_jid=/?token= widget) often
   * have NO JSON-LD, and no visible "posted N days ago" text anywhere in
   * the rendered DOM at all — there's nothing for a DOM scan to find.
   * BidHub shows a real posted date for these pages anyway; confirmed (by
   * reading BidHub's own installed extension source, background.js —
   * "crawler-sourced tier gets nothing to parse") that this does NOT come
   * from client-side scraping. It's Greenhouse's own public boards-api.
   * greenhouse.io JSON API, fetched server-side by BidHub's crawler and
   * cached. That API is open CORS (Access-Control-Allow-Origin: *), so
   * it's called directly here instead — no backend needed, same
   * authoritative source. Only fills location/posted when the layers
   * above came up empty; salary still has no structured field here either
   * (same free-text `content` HTML the DOM already renders), so that stays
   * on the DOM regex fallback. */
  function resolveGreenhouseBoardJob(doc) {
    let u;
    try {
      u = new URL(location.href);
    } catch {
      return null;
    }
    const isEmbed = /[?&]gh_jid=\d+/.test(u.search);
    if (!/(?:^|\.)greenhouse\.io$/i.test(u.hostname) && !isEmbed) return null;
    const qp = u.searchParams;
    let board = qp.get("for") || "";
    let jobId = qp.get("token") || qp.get("gh_jid") || qp.get("id") || "";
    if (!board || !jobId) {
      const segs = u.pathname.split("/").filter(Boolean);
      const jobsIdx = segs.indexOf("jobs");
      if (jobsIdx > 0 && segs[jobsIdx + 1]) {
        board = board || segs[jobsIdx - 1];
        jobId = jobId || segs[jobsIdx + 1];
      }
    }
    if (!board) {
      // Company-hosted embed names its board only in the widget's own
      // <script src="…/embed/job_board/js?for=<board>"> tag, not the URL.
      const embedScript = doc.querySelector(
        "script[src*='greenhouse.io/embed/job_board/js'], script[src*='boards.greenhouse.io/embed']",
      );
      if (embedScript) {
        try {
          board = new URL(embedScript.src, location.href).searchParams.get("for") || "";
        } catch {
          /* ignore */
        }
      }
    }
    jobId = (String(jobId).match(/\d+/) || [])[0] || "";
    if (!board || !jobId) return null;
    return { board, jobId };
  }
  async function fetchGreenhouseApiMeta(doc) {
    const ref = resolveGreenhouseBoardJob(doc);
    if (!ref) return null;
    // Relayed through background.js (see its GH_BOARDS_API_FETCH handler) —
    // a direct fetch() from here (the page's own content-script world) gets
    // blocked outright on some Greenhouse-hosted pages: their own CSP
    // connect-src doesn't allowlist boards-api.greenhouse.io, even though
    // it's Greenhouse's own domain. The service worker isn't bound by any
    // page's CSP.
    try {
      if (!chrome?.runtime?.sendMessage) return null;
      const res = await chrome.runtime.sendMessage({
        __proactive: true,
        type: "GH_BOARDS_API_FETCH",
        board: ref.board,
        jobId: ref.jobId,
      });
      return res && res.ok ? res.data : null;
    } catch {
      return null;
    }
  }

  // Everything below is synchronous — pure JSON-LD/DOM reads, no network.
  // Split out from extract() so a caller can show this immediately instead
  // of blocking company/role/location/salary (all available instantly) on
  // the one field (`posted`, occasionally `location`/`company` too) that
  // can only come from a network round-trip.
  function computeSync(d, item, detectedResult) {
    const title = (detectedResult && detectedResult.title) || item.title || "";
    const location = extractLocationText(item) || domLocationFallback(d);
    const posted = formatPosted(item.datePosted);
    const salary = formatSalary(item.baseSalary) || domSalaryFallback(d);

    let workModel = normalizeWorkModel((detectedResult && detectedResult.jobLocationType) || item.jobLocationType);
    let workModelInferred = false;
    if (!workModel) workModel = workModelFromText(location);
    // No remote/hybrid/onsite signal anywhere (not in structured data, not
    // in the location text) — "unknown" rather than a confident single
    // guess. This USED to default to "onsite" ("a posting that never says
    // remote is, in practice, onsite") — disproved by a real side-by-side
    // comparison against BidHub (job-boards.greenhouse.io/newrelic/jobs/
    // 5444701008, a posting with no JSON-LD and no DOM text stating any
    // work model at all): BidHub shows Remote/Onsite/Hybrid as three
    // neutral, equally-possible badges for a posting like this, not a
    // single assumed answer. renderJobMeta in sidepanel.js renders
    // "unknown" the same way — all three badges, neutral styling — instead
    // of guessing. workModelInferred stays true either way (never a
    // stated fact), extract() below may still upgrade this to a real
    // value via Greenhouse's own "Work Arrangement" field when the
    // posting actually filled it in.
    if (!workModel && location) {
      workModel = "unknown";
      workModelInferred = true;
    }

    return {
      location,
      workModel,
      workModelInferred,
      company: "",
      employmentType: normalizeEmploymentType(item.employmentType),
      experienceLevel: detectExperienceLevel(title),
      salary,
      posted,
      expiration: formatExpiration(item.validThrough),
    };
  }

  /** Synchronous fast pass — no network. @returns {object} */
  function extractSync(doc, detectedResult) {
    const d = doc || document;
    const item = findJobPostingLd(d) || {};
    return computeSync(d, item, detectedResult);
  }

  /** @param {Document} doc
   *  @param {{title?:string, jobLocationType?:string}} [detectedResult] —
   *    this detection pass's own title/jobLocationType, when the caller
   *    already has one (per-site parsers often resolve jobLocationType
   *    their own way, e.g. Ashby's workplaceType — preferred over the
   *    JSON-LD value here when present).
   *  @returns {Promise<object>} everything extractSync gives, plus
   *    whatever the Greenhouse boards-api round-trip adds when the sync
   *    pass came up short (see fetchGreenhouseApiMeta's own comment). */
  async function extract(doc, detectedResult) {
    const d = doc || document;
    const item = findJobPostingLd(d) || {};
    const meta = computeSync(d, item, detectedResult);

    if (!meta.location || !meta.posted || meta.workModel === "unknown") {
      const gh = await fetchGreenhouseApiMeta(d);
      if (gh) {
        if (!meta.location && gh.location && gh.location.name) {
          meta.location = gh.location.name.trim();
          if (!meta.workModel) {
            const wm = workModelFromText(meta.location);
            if (wm) {
              meta.workModel = wm;
              meta.workModelInferred = false;
            }
          }
        }
        // Greenhouse's own "Work Arrangement" custom field — an explicit,
        // authoritative answer for the postings that actually fill it in,
        // independent of whether location/posted needed this round-trip at
        // all (the New Relic posting this was confirmed against already
        // had its location from the DOM, so the OLD code — nested inside
        // the `!meta.location` branch above — never even looked at this
        // field). Only read when still "unknown" after the sync pass; most
        // Greenhouse postings leave this field null (not every poster
        // fills it in), in which case "unknown" (see computeSync) stands —
        // an honest "don't know" rather than a guess.
        if (meta.workModel === "unknown" && Array.isArray(gh.metadata)) {
          const arrangement = gh.metadata.find((f) => /work arrangement/i.test(f && f.name));
          const wm = arrangement && arrangement.value ? workModelFromText(String(arrangement.value)) : "";
          if (wm) {
            meta.workModel = wm;
            meta.workModelInferred = false;
          }
        }
        // updated_at (last time Greenhouse re-indexed this listing), not
        // first_published (true original creation date) — a req open for
        // over a year but still actively hiring reads as "393 days ago",
        // which looks broken even though it's technically accurate.
        // updated_at tracks how fresh the listing actually is, the same
        // thing a "Posted" label is meant to communicate.
        if (!meta.posted) meta.posted = formatPosted(gh.updated_at || gh.first_published);
        // Greenhouse's real, authoritative employer name — distinct from
        // the DOM's own displayed brand (e.g. "Xai") when a posting's
        // legal/ATS entity differs from the brand shown on the page
        // (confirmed real case: job-boards.greenhouse.io/embed/job_app?
        // for=xai shows "Xai" (the board slug, capitalized) everywhere in
        // its own DOM/title, while Greenhouse's own records for that exact
        // posting — same field BidHub's own backend reads — name the
        // employer "SpaceXSI"). Mostly redundant now that the generic
        // adapter's own title-parsing fix (job-detect/extractors/adapters/
        // index.js) resolves this case synchronously too; kept as a
        // second-opinion safety net for any other page that still gets it
        // wrong.
        if (gh.company_name) meta.company = String(gh.company_name).trim();
      }
    }

    return meta;
  }

  if (typeof window !== "undefined") {
    window.ProactiveJobMeta = { extract, extractSync };
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { extract, extractSync };
})();
