/* =====================================================================
 * ProActive — shared job extraction + fit assessment
 * =====================================================================
 * Loaded BOTH as a content script (isolated world, in the page) and in
 * the side panel (via <script> in sidepanel.html). Attaches a single
 * global, window.ProactiveJobFit, with two pure entry points:
 *
 *   extractFromDocument()         reads the CURRENT document and returns
 *                                 { source, title, company, description,
 *                                   jobLocationType, pageText, url }.
 *                                 Fully self-contained (all helpers
 *                                 nested) so the side panel can inject it
 *                                 verbatim via chrome.scripting.executeScript,
 *                                 while the content script calls it directly.
 *
 *   assessJobFit(result, ctx)     classifies a posting against the user's
 *                                 remote-only / English-only constraints.
 *                                 Returns { level, blockers, flags, reasons }.
 *
 * Keeping both here means the side panel "Detect" button and the passive
 * page badge share ONE implementation — no drift between two copies
 * (which is exactly what caused earlier detection bugs).
 * ===================================================================== */
(function () {
  "use strict";

  // ── Detection helpers come from the job-detect/* modules ────────────
  // They load before this file: manifest content_scripts order, the
  // panel's files-injection list, and sidepanel.html <script> tags all
  // put job-detect/* ahead of job-fit.js. In the browser they live on
  // window.ProactiveJobDetect; under node (the golden-fixture harness
  // require()s this file directly) we require() them. This is what lets
  // job-fit.js consume the shared library instead of carrying its own
  // copies of these helpers — the dedup the migration set up.
  const __ND = (typeof window !== "undefined" && window.ProactiveJobDetect) || null;
  // Track missing deps so we can short-circuit later without throwing —
  // an uncaught throw at the top of this IIFE stopped the file before
  // it could register window.ProactiveJobFit, which in turn made every
  // subsequent content script that depends on it look "broken" in the
  // Chrome error overlay. Fail soft, fail loud (one warn line), keep
  // the rest of the page-script chain running.
  const __missingDeps = [];
  const __need = (nsPath, requirePath) => {
    if (__ND) {
      let o = __ND;
      for (const k of nsPath) o = o && o[k];
      if (o) return o;
    }
    if (typeof require !== "undefined") {
      try { return require(requirePath); } catch (e) { /* fall through */ }
    }
    __missingDeps.push(nsPath.join("."));
    return null;
  };
  const _text = __need(["normalize", "text"], "./job-detect/normalize/text.js");
  const _html = __need(["normalize", "html"], "./job-detect/normalize/html.js");
  const _geo = __need(["normalize", "geo"], "./job-detect/normalize/geo.js");
  const _language = __need(["normalize", "language"], "./job-detect/normalize/language.js");
  const _roles = __need(["normalize", "roles"], "./job-detect/normalize/roles.js");
  const _query = __need(["dom", "query"], "./job-detect/dom/query.js");
  const _regions = __need(["dom", "regions"], "./job-detect/dom/regions.js");
  const _resolver = __need(["resolver"], "./job-detect/resolver.js");
  // Optional, NOT run through __need — the old per-site adapter registry
  // (job-detect/extractors/adapters/index.js) is superseded by the new
  // BidHub-ported job-detect/sites/*.js files for its 46 sites and is no
  // longer manifest-loaded in the browser at all (see manifest.json's own
  // exclude_matches comment) — so window.ProactiveJobDetect.extractors
  // .adapters simply won't exist there, same as any other optional dep.
  // Treating that as non-fatal (default []) instead of a missing required
  // dependency keeps the generic JSON-LD/DOM fallback below working on
  // every OTHER site — it used to be the one thing that could make this
  // whole file "defer" (stub out extraction entirely) even though nothing
  // else was actually missing. The require() fallback stays (same as
  // every other __need'd dep) for the Node test harness, which loads this
  // file directly with no real window.ProactiveJobDetect populated and
  // needs the real adapter list to exercise the adapter-matched branch.
  let _adapters = (__ND && __ND.extractors && __ND.extractors.adapters) || null;
  if (!_adapters && typeof require !== "undefined") {
    try { _adapters = require("./job-detect/extractors/adapters/index.js"); } catch { /* browser — fine, optional */ }
  }
  _adapters = _adapters || [];
  const _jsonld = __need(["extractors", "structured", "jsonld"], "./job-detect/extractors/structured/jsonld.js");
  if (__missingDeps.length) {
    console.warn(
      "[proactive] job-fit deferred — ProactiveJobDetect deps not loaded yet:",
      __missingDeps.join(", "),
      "(SPA route change or partial re-injection — background should re-inject the full chain)",
    );
    // Leave a stub so callers don't ReferenceError; they'll just get
    // empty extraction results and the detection UI will surface a
    // clean "couldn't detect" instead of a red-banner crash.
    if (typeof window !== "undefined") {
      window.ProactiveJobFit = window.ProactiveJobFit || {
        extractFromDocument: () => ({ source: "unavailable", title: "", company: "", description: "", jobLocationType: "", pageText: "", url: location?.href || "" }),
        assessJobFit: () => ({ level: "unknown", blockers: [], flags: [], reasons: [] }),
      };
    }
    return;
  }

  const { stripTagLikeText, looksLikeMarkup, stripShareLines } = _text;
  const { parseToText, htmlToText } = _html;
  const { canonicalCountry, EUROPEAN_COUNTRIES, REGION_TOKENS, parseRemoteLocations, detectCountryRestriction } = _geo;
  const { NON_ENGLISH_LANGUAGES, detectLanguageRequirement } = _language;
  const { matchAvoidRole } = _roles;
  const { firstText } = _query;
  const { cleanRegionText, findJdContainer, SIDEBAR_MARKERS } = _regions;

  // ---- Self-contained page extractor (injectable + content-script safe) ----
  function extractFromDocument() {
    const host = location.hostname;

    // ─── Greenhouse embed detector — NESTED INSIDE extractFromDocument
    // because the file's whole point is that this function gets
    // serialized verbatim by chrome.scripting.executeScript and re-run
    // in target frames WITHOUT closures. An IIFE-level helper would be
    // ReferenceError when injected, breaking every Detect click on
    // sites that don't have JSON-LD JobPosting.
    //
    // True when the current page hosts a Greenhouse Job Board embed
    // even though its hostname isn't *.greenhouse.io. Companies embed
    // the widget on their own /careers/ or /openings/ page and either
    // pass the Job ID via the URL (?gh_jid=...) or mount the widget
    // into a fixed container (#grnhse_app for the JS embed,
    // #grnhse_iframe for the iframe variant).
    const ghEmbed = (() => {
      try {
        const url = new URL(location.href);
        if (url.searchParams.has("gh_jid") || url.searchParams.has("gh_src")) return true;
      } catch { /* malformed URL — ignore */ }
      return !!document.querySelector("#grnhse_app, #grnhse_iframe");
    })();

    let pageText = (document.body && document.body.innerText ? document.body.innerText : "").trim();
    if (pageText.length > 80000) pageText = pageText.slice(0, 80000);

    // (firstText / stripTagLikeText / looksLikeMarkup / parseToText /
    // htmlToText now come from job-detect/* — bound at the top of this IIFE.)

    // (cleanRegionText now comes from job-detect/dom/regions.js.)

    // (stripShareLines now comes from job-detect/normalize/text.js.)

    // (SIDEBAR_MARKERS / findJdContainer now come from job-detect/dom/regions.js.)

    // 1) JSON-LD JobPosting
    //
    // We trust JSON-LD for title / company / jobLocationType because
    // those are short fields with little room to be wrong. We do NOT
    // unconditionally trust the `description` field — some ATSes
    // (SoftServe, others) put the company boilerplate ("SoftServe is
    // people-first…") in JobPosting.description instead of the actual
    // role text. So we only RETURN early from JSON-LD when the
    // description is substantial (≥800 chars). Otherwise we capture
    // the JSON-LD values into `ld*` and fall through to DOM
    // extraction; later in the function we keep whichever description
    // is longer.
    const ld = _jsonld(document, htmlToText);
    let ldTitle = ld.title;
    let ldCompany = ld.company;
    let ldDescription = ld.description;
    let ldJobLocationType = ld.jobLocationType;
    let ldSeen = ld.seen;
    // Short-circuit and treat JSON-LD as canonical when it gives BOTH a
    // company and a substantial description (≥800 chars) — a high-
    // confidence structured source. When company is missing we fall
    // through so the site/slug fallbacks can fill it (the long JSON-LD
    // description is still preferred later via the ldDescription length
    // check). Some ATSes (Jobvite) emit a full description but omit
    // hiringOrganization, which is exactly the fall-through case.
    if (ldCompany && ldDescription && ldDescription.length >= 800) {
      const s = _resolver.score("json-ld");
      const high = { source: "json-ld", confidence: _resolver.bucket(s), score: s };
      return {
        source: "json-ld", title: ldTitle, company: ldCompany, description: ldDescription,
        jobLocationType: ldJobLocationType, pageText, url: location.href,
        provenance: { title: high, company: high, description: high },
      };
    }

    // 2) Site-specific selectors
    //
    // Pre-seed from the JSON-LD pass if it saw a JobPosting but the
    // description was too short / boilerplate to trust on its own —
    // title and company are still useful and almost always correct.
    let title = ldTitle || "";
    let company = ldCompany || "";
    let description = "";

    // Per-field provenance + confidence so the side panel can flag a
    // guess instead of presenting it as fact. The confidence bucket is
    // derived from the source by the shared resolver (job-detect/
    // resolver.js): SOURCE_TIER × validation → score → high/medium/low.
    // mark() is called wherever a field is assigned; the last writer wins,
    // mirroring the assignment order below. Sources, by resulting bucket:
    //   high   — json-ld, adapter:<id>
    //   medium — og:site_name, dom-h1, dom-slug-heading, dom-region, iframe
    //   low    — page-title, title-split, hostname, og:description
    const prov = {
      title: { source: "none", confidence: "none", score: 0 },
      company: { source: "none", confidence: "none", score: 0 },
      description: { source: "none", confidence: "none", score: 0 },
    };
    const mark = (field, source) => {
      const score = _resolver.score(source);
      prov[field] = { source, confidence: _resolver.bucket(score), score };
    };
    if (ldTitle) mark("title", "json-ld");
    if (ldCompany) mark("company", "json-ld");

    // ── Site adapters (job-detect/extractors/adapters) ──────────────
    // Ordered registry, one entry per ATS / job-board family. The first
    // adapter whose match(ctx) accepts this page wins (array order). Its
    // extract(ctx) RETURNS the fields it could find; we assign those and
    // attribute them. Anything it omits or leaves blank, the generic
    // fallback below fills. ctx carries the page handles each adapter
    // needs, so the registry itself is a pure, separately-tested module.
    const ctx = { firstText, doc: document, url: location.href, host, ghEmbed };
    const matchedAdapter = _adapters.find((a) => a.match(ctx));
    if (matchedAdapter) {
      const res = matchedAdapter.extract(ctx) || {};
      if ("title" in res) title = res.title;
      if ("company" in res) company = res.company;
      if ("description" in res) description = res.description;
      // A host-specific selector is as trustworthy as structured data.
      // Mark only fields the adapter actually produced (non-empty, and —
      // for title/company — different from the JSON-LD pre-seed).
      const src = `adapter:${matchedAdapter.id}`;
      if (title && title !== (ldTitle || "")) mark("title", src);
      if (company && company !== (ldCompany || "")) mark("company", src);
      if (description) mark("description", src);
    }

    // 3) Generic fallback
    const metaContent = (sel) => document.querySelector(sel)?.getAttribute("content") || "";
    // The OG-title splitter handles: hyphen-minus, en-dash (–, U+2013,
    // common on European brand sites), em-dash (—, U+2014), pipe,
    // mid-dot, bullet. Without en-dash, "Brand – Tagline" titles
    // returned a single part and the company never got extracted.
    const TITLE_SEPS = /[\-–—|·•]/;
    const splitTitleParts = (t) =>
      (t || "").split(TITLE_SEPS).map((x) => x.trim()).filter(Boolean);

    // Many career portals set og:site_name / og:title to a generic label
    // ("Careers", "Jobs", "Vacancies") rather than the actual employer.
    // Taking it verbatim badged the company as "Careers" (e.g.
    // career.dev.pro, whose og:site_name is literally "Careers"). These
    // helpers reject the generic labels and strip a leading/trailing
    // generic token off otherwise-good candidates ("Career Dev Pro" →
    // "Dev Pro") so we fall through to a real brand signal instead.
    const GENERIC_RE = /careers?|jobs?|vacanc(?:y|ies)|hiring|apply|recruit(?:ing|ment)?|job ?board|open positions|work with us|join us|we(?:'re| are) hiring|talent/;
    const isGenericCompany = (s) => {
      const n = String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
      return !n || new RegExp(`^(?:${GENERIC_RE.source})$`).test(n);
    };
    const stripGenericTokens = (s) =>
      String(s || "")
        // Leading token, plus a following "at"/"with"/"@" connector so
        // "Careers at Airbnb" → "Airbnb" (not "at Airbnb") and
        // "Jobs with Acme" → "Acme".
        .replace(new RegExp(`^\\s*(?:${GENERIC_RE.source})\\b[\\s:|·\\-–—]*(?:(?:at|with|@)\\b[\\s:]*)?`, "i"), "")
        .replace(new RegExp(`[\\s:|·\\-–—]*\\b(?:${GENERIC_RE.source})\\s*$`, "i"), "")
        .trim();
    // A clean brand looks like a short noun phrase, not a marketing
    // sentence ("Want to Be a Part of Dev.Pro?") — reject sentence
    // punctuation and long/many-word strings.
    const looksLikeCompany = (s) =>
      !!s && !isGenericCompany(s) && !/[?!]/.test(s) && s.length >= 2 && s.length <= 60 && s.split(/\s+/).length <= 5;

    // URL-slug heading match. The cleanest signal of which heading
    // carries the role title on /career/<slug> and /jobs/<slug> pages
    // is the slug itself: "business-developer-(data-protection-services)"
    // maps to "Business Developer (Data Protection Services)".
    //
    // Used because: company-hosted Angular SPAs frequently have
    // MULTIPLE headings on the page (the role's h1 + a layout-level
    // "Our Perks & Benefits" h1 + nav links wrapped as h2/h3). Picking
    // the first h1 in DOM order grabs the perks heading on some
    // templates — wrong section. Slug-matching anchors deterministically
    // on the role title regardless of DOM order.
    const normalizeForMatch = (s) =>
      String(s || "")
        .toLowerCase()
        .replace(/[%]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const urlSlugN = (() => {
      try {
        const segs = decodeURIComponent(location.pathname).split("/").filter(Boolean);
        return normalizeForMatch(segs[segs.length - 1] || "");
      } catch { return ""; }
    })();
    const findRoleHeading = () => {
      if (!urlSlugN) return null;
      // Multi-tier candidate list, tried in order. Tier 1 = semantic
      // headings (most ATS templates put the title in an h1/h2). Tier
      // 2 = the bespoke title classes Angular Material / handrolled
      // career templates use (reliefapplications.org keeps the role
      // in a styled <div class="job-title-text"> — no heading tag).
      const tierLists = [
        Array.from(document.querySelectorAll("h1, h2, h3")),
        Array.from(
          document.querySelectorAll(
            "[class*='job-title' i], [class*='job_title' i]," +
              "[class*='posting-title' i], [class*='posting_title' i]," +
              "[class*='role-title' i], [class*='position-title' i]," +
              "[class*='headline' i]",
          ),
        ),
      ];
      for (const tier of tierLists) {
        for (const el of tier) {
          const t = (el.textContent || "").trim();
          if (t.length < 3 || t.length > 250) continue;
          const tN = normalizeForMatch(t);
          if (!tN) continue;
          if (urlSlugN.includes(tN) || tN.includes(urlSlugN)) return el;
        }
      }
      return null;
    };
    const roleHeading = findRoleHeading();

    if (!title && roleHeading) {
      // Slug-matched role heading wins — most reliable on Angular SPAs
      // that have multiple H1s.
      title = (roleHeading.textContent || "").trim();
      if (title) mark("title", "dom-slug-heading");
    }
    if (!title) {
      // Fall back to the first <h1>. On simple company career pages
      // this is the role title; on noisy SPAs it might be a layout
      // heading like "Our Perks & Benefits" — that's why we tried the
      // slug match first.
      const h1Text = Array.from(document.querySelectorAll("h1"))
        .map((el) => (el.textContent || "").trim())
        .find((t) => t.length >= 3 && t.length <= 250);
      if (h1Text) { title = h1Text; mark("title", "dom-h1"); }
    }
    if (!title) {
      const rawTitle = (metaContent("meta[property='og:title']") || document.title || "").trim();
      title = rawTitle;
      // "Role - Company" / "Role | Company": the page/og title bundles the
      // employer after a separator (careers.kula.ai → "Senior DevOps
      // Developer - Mappedin"). Strip the company segment so the ROLE is
      // left. Only split when a segment actually IS the company
      // (og:site_name) — otherwise a hyphenated role ("Full-Stack
      // Engineer") would be truncated to "Full".
      const siteLc = stripGenericTokens(metaContent("meta[property='og:site_name']"))
        .trim()
        .toLowerCase();
      if (siteLc) {
        const parts = splitTitleParts(rawTitle);
        const isCompanySeg = (p) => {
          const pl = p.toLowerCase();
          return pl === siteLc || pl.startsWith(siteLc + " ");
        };
        if (parts.length > 1 && parts.some(isCompanySeg)) {
          const roleParts = parts.filter((p) => !isCompanySeg(p));
          if (roleParts.length) title = roleParts.join(" - ").trim();
        }
      }
      if (title) mark("title", "page-title");
    }
    if (!company) {
      // Three competing heuristic sources for company. Each VALUE is
      // computed exactly as before; the resolver then picks the
      // highest-tier non-empty one and records the rest as `alternatives`.
      // Tier order (og:site_name > title-split > hostname) reproduces the
      // old if-(!company) chain precedence — this is the one place several
      // candidates genuinely compete, so it's where resolveField earns its
      // keep. (adapter / JSON-LD precedence stays the sequential logic
      // above: a matched adapter intentionally suppresses the LD pre-seed.)

      // 1) og:site_name — strongest WHEN a real brand; reject generic
      //    portal labels ("Careers", "Jobs").
      const ogSiteRaw = stripGenericTokens(metaContent("meta[property='og:site_name']"));
      const ogSiteVal = ogSiteRaw && !isGenericCompany(ogSiteRaw) ? ogSiteRaw : "";

      // 2) Title split — the part that isn't the role title. Gather from
      //    BOTH the document title and og:title, strip generic tokens, and
      //    prefer the one that reads like a brand.
      let splitVal = "";
      {
        const roleLc = (title || "").toLowerCase();
        const cands = [];
        for (const src of [document.title || "", metaContent("meta[property='og:title']")]) {
          for (const raw of splitTitleParts(src)) {
            const p = stripGenericTokens(raw);
            if (!p) continue;
            if (roleLc && (roleLc.includes(p.toLowerCase()) || p.toLowerCase().includes(roleLc))) continue;
            cands.push(p);
          }
        }
        splitVal = cands.find(looksLikeCompany) || cands.find((p) => !isGenericCompany(p)) || "";
      }

      // 3) Registrable hostname (reliefapplications.org → "Reliefapplications"),
      //    leading generic sub-domains stripped (career.dev.pro → "Dev").
      let hostVal = "";
      {
        const labels = (host || "").replace(/^www\./, "").split(".");
        while (labels.length > 2 && /^(?:careers?|jobs?|apply|hiring|work|talent|recruit(?:ing)?|join|hr|people|vacanc(?:y|ies))$/i.test(labels[0])) {
          labels.shift();
        }
        const root = labels[0] || "";
        if (root && root.length >= 3 && !isGenericCompany(root)) hostVal = root.charAt(0).toUpperCase() + root.slice(1);
      }

      const resolvedCompany = _resolver.resolveField([
        _resolver.candidate(ogSiteVal, "og:site_name"),
        _resolver.candidate(splitVal, "title-split"),
        _resolver.candidate(hostVal, "hostname"),
      ]);
      if (resolvedCompany.value) {
        company = resolvedCompany.value;
        prov.company = {
          source: resolvedCompany.source,
          confidence: resolvedCompany.confidence,
          score: resolvedCompany.score,
          alternatives: resolvedCompany.alternatives.map((c) => ({ source: c.source, value: c.value })),
        };
      }
    }
    if (!description) {
      // Some templates (hiresome.ai et al.) emit Open Graph via
      // `name="og:description"` instead of the spec's `property=`. Try
      // both, plus the plain meta description as a last resort.
      const ogDesc =
        metaContent("meta[property='og:description']") ||
        metaContent("meta[name='og:description']") ||
        metaContent("meta[name='description']");
      let text = "";
      // 1) schema microdata — the JD only, when the site marks it up.
      // schema.org JobPosting microdata + semantic id/class hooks.
      // ATSes like SmartRecruiters split the JD into MULTIPLE
      // containers — one per section (Responsibilities, Qualifications,
      // Additional Information, …). Grabbing only ONE container drops
      // the rest. The list below covers both the microdata route
      // ([itemprop='description'] / 'qualifications' / etc.) and the
      // id/class route (id="job-description" / id="qualifications" /
      // class="st-tile-additional-info" / …). The id/class hooks are
      // wide because every ATS names them slightly differently.
      const JOBPOSTING_ITEMPROPS = [
        "description",
        "responsibilities",
        "skills",
        "qualifications",
        "educationRequirements",
        "experienceRequirements",
        "jobBenefits",
        "incentiveCompensation",
      ];
      const SECTION_HOOK_RE =
        /\b(job[-_]?description|jobDescription|st[-_]?jobdescription|st[-_]?description|description|responsibilities|qualifications|additional[-_]?(information|info)|additionalInformation|skills|requirements|education[-_]?requirements|experience[-_]?requirements|job[-_]?benefits|jobBenefits|incentive[-_]?compensation|incentiveCompensation|st[-_]?tile|st[-_]?qualifications|st[-_]?additional)\b/i;
      const sectionEls = [];
      // 1. All itemprop containers we care about.
      for (const el of document.querySelectorAll(
        JOBPOSTING_ITEMPROPS.map((p) => `[itemprop='${p}']`).join(","),
      )) {
        sectionEls.push(el);
      }
      // 2. All elements whose id OR class hits the section hook regex.
      for (const el of document.querySelectorAll("[id], [class]")) {
        const sig = (el.id || "") + " " + (el.className && typeof el.className === "string" ? el.className : "");
        if (SECTION_HOOK_RE.test(sig)) sectionEls.push(el);
      }
      if (sectionEls.length) {
        // De-dupe: if A contains B, drop B. The outer container is the
        // one we want when both are present. After this pass, sectionEls
        // contains only "top-level" JD sections.
        const top = [];
        outer: for (const el of sectionEls) {
          for (const other of sectionEls) {
            if (other !== el && other.contains(el)) continue outer;
          }
          if (!top.includes(el)) top.push(el);
        }
        // If multiple top-level sections share a near common ancestor,
        // prefer extracting from the common ancestor — that picks up
        // any intermediate prose / lists that aren'\''t wrapped in a
        // semantic id/class but visually belong in the JD.
        let chosen = null;
        if (top.length >= 2) {
          // Walk up from the first element until an ancestor contains
          // all the others, or we reach <body>.
          let ancestor = top[0].parentElement;
          while (ancestor && ancestor !== document.body) {
            if (top.every((el) => ancestor.contains(el))) {
              chosen = ancestor;
              break;
            }
            ancestor = ancestor.parentElement;
          }
        }
        if (chosen) {
          const t = cleanRegionText(chosen);
          if (!SIDEBAR_MARKERS.test(t) && t.length >= 200) text = t;
        }
        if (text.length < 200) {
          // Fall back to concatenating each top-level section.
          const parts = top
            .sort((a, b) =>
              a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
            )
            .map((el) => cleanRegionText(el))
            .filter(Boolean);
          const joined = parts.join("\n\n").trim();
          if (!SIDEBAR_MARKERS.test(joined) && joined.length >= 200) text = joined;
        }
      }
      // 2) heading-anchored JD column — isolates the description from a
      //    metadata sidebar (Zoho's "Job Information") and the footer.
      if (text.length < 200) {
        const jd = findJdContainer();
        if (jd) text = cleanRegionText(jd);
      }
      // 2b) Role-heading-anchored fallback. Walk sibling elements
      //    after the role heading, collecting their text until we hit
      //    a layout boundary (next equal-rank heading OR a perks /
      //    benefits / offer section).
      //
      // Angular SPAs (reliefapplications.org) wrap the title in a
      // single-child <div> inside the real page container:
      //   <div class="page">
      //     <div><div class="job-title-text">…</div></div>
      //     <div class="about-container">…JD…</div>     ← want these
      //     <div class="about-container">…JD…</div>
      //     <div class="perks-container">…</div>        ← STOP here
      //   </div>
      // We climb single-child wrappers so the walk happens at the
      // .page level (where about-container and perks-container are
      // siblings), not at the title-only inner div.
      //
      // STOP_CLASS_RE catches the common "next major section" patterns
      // on company career pages: perks, benefits, offer, advantages,
      // values, why-us, why-work — none of which are part of the JD.
      // Also catches the cross-sell CTA sections every ATS appends
      // after the role description (SoftServe'\''s ".more-opportunities"
      // wrap, "similar-jobs", "related-jobs", "other-positions",
      // "open-positions" carousels, etc.) and the page footer.
      const STOP_CLASS_RE =
        /(perks|benefits|advantages|why[-_]?(us|work|join)|company[-_]?values|what[-_]?we[-_]?offer|more[-_]?(opportunities|jobs|positions|roles|openings)|similar[-_]?(jobs|positions|roles|openings)|related[-_]?(jobs|positions|roles|openings)|other[-_]?(positions|jobs|roles|openings)|open[-_]?positions|all[-_]?jobs|recommended[-_]?(jobs|positions)|jobs[-_]?recommendations|footer|sub[-_]?footer|app[-_]?footer)/i;
      if (text.length < 200) {
        const anchor = roleHeading || document.querySelector("h1");
        if (anchor) {
          // Climb single-child wrappers so siblings are the page's
          // actual content sections, not the title's siblings (which
          // might be empty).
          let walkStart = anchor;
          let walkParent = anchor.parentElement;
          while (
            walkParent &&
            walkParent.children.length === 1 &&
            walkParent !== document.body
          ) {
            walkStart = walkParent;
            walkParent = walkParent.parentElement;
          }
          const startTag = (anchor.tagName || "").toLowerCase();
          const startLevel = /^h[1-6]$/.test(startTag)
            ? parseInt(startTag.substring(1), 10)
            : 0;

          if (walkParent) {
            let collecting = false;
            const buf = [];
            for (const child of Array.from(walkParent.children)) {
              if (child === walkStart) { collecting = true; continue; }
              if (!collecting) continue;

              // Stop at any sibling whose class identifies it as a
              // perks/benefits/values section.
              const cls = String(child.className || "");
              if (STOP_CLASS_RE.test(cls)) break;
              // Also stop if the sibling CONTAINS a heading whose
              // text starts with "Our perks", "Benefits", "Why work",
              // etc. — class names aren't always semantic.
              const innerHead = child.querySelector("h1, h2, h3");
              const innerHeadText = innerHead && (innerHead.textContent || "").trim().toLowerCase();
              if (
                innerHeadText &&
                /^(our )?(perks|benefits|advantages|why\s+(us|work|join)|what\s+we\s+offer|company\s+values|more\s+(opportunities|jobs|positions|roles|openings)|similar\s+(jobs|positions|roles|openings)|related\s+(jobs|positions|roles|openings)|other\s+(positions|jobs|roles|openings)|open\s+positions|all\s+jobs|recommended\s+(jobs|positions)|browse\s+(all|more)|explore\s+(more|other)|view\s+(more|all)\s+(jobs|positions))\b/.test(innerHeadText)
              ) {
                break;
              }

              const tag = (child.tagName || "").toLowerCase();
              if (startLevel > 0 && /^h[1-6]$/.test(tag)) {
                const lvl = parseInt(tag.substring(1), 10);
                if (lvl <= startLevel) break;
              }
              const chunk = cleanRegionText(child);
              if (chunk) buf.push(chunk);
            }
            const walked = buf.join("\n").trim();
            if (walked.length >= 200) text = walked;
          }
          // Closest semantic ancestor fallback only kicks in if the
          // walk didn't yield enough.
          if (text.length < 200) {
            const region =
              anchor.closest("main, article, [role='main'], section") ||
              anchor.parentElement;
            if (region) {
              const candidateText = cleanRegionText(region);
              if (candidateText.length >= 200) text = candidateText;
            }
          }
        }
      }
      // 3) last resort — the main content region, page chrome stripped.
      //    Try a deeper set of candidate regions before falling back to
      //    document.body. Many company career pages wrap the JD in a
      //    [class*='content' i] / [class*='post' i] / [class*='article' i]
      //    container that's neither <main> nor <article>.
      //
      //    The compound vacancy+description selectors handle template
      //    patterns like SoftServe's `.vacancy-page .content .description`
      //    where the actual JD lives in a sub-region named just
      //    "description" — too generic to grep blindly on every page
      //    (would grab meta-description containers / blog post bodies)
      //    but safe when paired with a vacancy / job / role wrapper.
      // Run the selector chain not only when the walk found nothing, but
      // also when it found only a thin slice (< 600 chars). On pages
      // where the role <h1> sits in a hero section SEPARATE from the JD
      // body (careers.airbnb.com: h1 in the header, JD in
      // #job-detail-panel), the sibling walk collects a small unrelated
      // chunk (a pay disclaimer) and, being ≥200 chars, used to block the
      // far better class/id-based selectors. Take whichever is longer.
      if (text.length < 600) {
        // Ordered most-specific-JD-hook → generic container. For EACH
        // selector we take the LONGEST clean region among ALL its matches
        // and accept the first selector that yields a substantial body.
        //
        // Iterating (rather than a `||` chain of querySelector) is what
        // stops a thin/empty match from short-circuiting the chain and
        // blocking the document.body fallback: on careers.kula.ai a logo
        // <img class="job-details-logo"> matched [class*='job-detail'],
        // returned 0 chars, and prevented body (3.4k chars of JD) from
        // ever being read — so the JD fell back to a 150-char
        // og:description and the page failed the "is this a job?" gate.
        const REGION_SELECTORS = [
          "[class*='vacancy' i] [class*='description' i]",
          "[class*='vacancy' i] [class*='content' i]",
          "[class*='job-detail' i]",
          "[class*='job-description' i]",
          "[class*='job-content' i]",
          "[class*='job-info' i]",
          "[class*='role-detail' i]",
          "[class*='role-description' i]",
          "[class*='position-detail' i]",
          "[class*='posting-detail' i]",
          // ID-based selectors — modern ATSes (hiresome.ai's
          // job-posting-tab-panel-overview, custom-built portals that use
          // Tailwind utility classes with semantic ids) hang the JD off an
          // id rather than a class hook.
          "[role='tabpanel'][id*='overview' i]",
          "[role='tabpanel'][id*='job' i]",
          "[role='tabpanel'][id*='posting' i]",
          "[role='tabpanel'][id*='description' i]",
          "[id*='job-posting' i]",
          "[id*='jobPosting' i]",
          "[id*='job-description' i]",
          "[id*='jobDescription' i]",
          "[id*='job-overview' i]",
          "[id*='jobOverview' i]",
          "[class*='vacancy' i]",
          "[class*='career-content' i]",
          "[class*='post-content' i]",
          "main",
          "article",
          "[role='main']",
        ];
        let regionText = "";
        for (const sel of REGION_SELECTORS) {
          let best = "";
          for (const el of document.querySelectorAll(sel)) {
            const t = cleanRegionText(el);
            if (t.length > best.length) best = t;
          }
          // First specific hook with a real body wins (keeps specific >
          // generic); a thin/empty hit (logo, wrapper) is skipped.
          if (best.length >= 200) { regionText = best; break; }
        }
        // Ultimate fallback: the whole body, page chrome stripped.
        if (regionText.length < 200) {
          const bodyText = cleanRegionText(document.body);
          if (bodyText.length > regionText.length) regionText = bodyText;
        }
        // Keep whichever is longer — never let a thin selector hit (e.g.
        // body stripped to almost nothing) clobber a good walk result.
        if (regionText.length > text.length) text = regionText;
      }
      // Description priority — pick whichever source produced the
      // longest plain-text body. JSON-LD JobPosting.description and
      // og:description are both legitimate sources, but BOTH commonly
      // contain just the company boilerplate ("SoftServe is people-
      // first…") rather than the actual role. DOM extraction is the
      // one we trust most when it returns a substantial body.
      description = text || "";
      if (description) mark("description", "dom-region");
      if (ldDescription && ldDescription.length > description.length) {
        description = ldDescription;
        mark("description", "json-ld");
      }
      if (ogDesc && ogDesc.length > description.length) {
        description = ogDesc;
        mark("description", "og:description");
      }
    }

    title = stripTagLikeText(String(title)).replace(/\s+/g, " ").trim();
    company = stripTagLikeText(String(company)).replace(/\s+/g, " ").trim();
    description = htmlToText(String(description));
    description = stripShareLines(description);
    if (description.length > 30000) description = description.slice(0, 30000) + "\n…[truncated]";

    // ─── Cross-frame fallback ────────────────────────────────────────
    // ATS embed widgets (Greenhouse / Workday / etc.) render the JD
    // inside a cross-origin iframe. The top frame can't read into it,
    // so our extractor only sees the host's marketing chrome — a thin
    // description that fails the >400-char gate downstream.
    //
    // content-detect.js runs in iframes too (manifest all_frames:true)
    // and posts its result up to the parent, where the message
    // listener caches it on window.__proactiveFrameJd after verifying
    // the iframe's origin is a known ATS host. If our local extraction
    // is weak and a child frame has a stronger one, prefer it — but
    // keep the parent's URL so the badge + side panel still anchor to
    // the page the user sees in the address bar.
    const childJd = window.__proactiveFrameJd && window.__proactiveFrameJd.result;
    if (
      childJd &&
      (childJd.description || "").length > (description || "").length &&
      (childJd.description || "").length >= 400
    ) {
      const iframeProv = { source: "iframe", confidence: "medium" };
      const cp = childJd.provenance || {};
      return {
        source: childJd.source || "iframe",
        title: childJd.title || title,
        company: childJd.company || company,
        description: childJd.description,
        jobLocationType: childJd.jobLocationType || "",
        pageText: childJd.pageText || pageText,
        url: location.href,
        // Prefer the child frame's own per-field provenance (it ran the
        // same extractor); fall back to a generic "iframe/medium" for a
        // field the child filled without provenance, or to the parent's
        // mark for a field we kept from the parent.
        provenance: {
          title: childJd.title ? (cp.title || iframeProv) : prov.title,
          company: childJd.company ? (cp.company || iframeProv) : prov.company,
          description: cp.description || iframeProv,
        },
      };
    }

    // Drop any stale mark for a field that ended up empty (e.g. a JSON-LD
    // pre-seed that an adapter later blanked and nothing refilled).
    if (!String(title || "").trim()) prov.title = { source: "none", confidence: "none" };
    if (!String(company || "").trim()) prov.company = { source: "none", confidence: "none" };
    if (!String(description || "").trim()) prov.description = { source: "none", confidence: "none" };

    return {
      source: "selectors", title, company, description,
      jobLocationType: "", pageText, url: location.href, provenance: prov,
    };
  }

  // ---- Fit assessment (pure, no DOM) ----


  /**
   * Returns { level, blockers, flags, reasons }:
   *   level "good"  → green: nothing found.
   *   level "check" → amber: only soft flags (hybrid / office-days /
   *                   couldn't-confirm-remote).
   *   level "skip"  → red: at least one hard blocker (on-site,
   *                   country-locked elsewhere, relocation, clearance,
   *                   required non-English language).
   * `reasons` is blockers.concat(flags) for callers that want one list.
   */
  function assessJobFit(result, profileCtx) {
    result = result || {};
    profileCtx = profileCtx || {};
    const { title = "", description = "", jobLocationType = "", pageText = "" } = result;
    const lt = String(jobLocationType || "").toUpperCase();
    let hay = `${title}\n${description}\n${pageText}`.toLowerCase();
    if (hay.length > 80000) hay = hay.slice(0, 80000);

    const blockers = [];
    const flags = [];

    // ---- Structured work-arrangement label (authoritative) ----
    const labelType = (() => {
      const m = hay.match(
        /(?:location type|workplace type|work ?place|work model|work setting|work mode|remote status|arbeitsort|arbeitsmodell|standorttyp)\s*[:\-—]?\s*(on[\s-]?site|on[\s-]?premises?|in[\s-]?office|vor ort|büro|remote|hybrid)/
      );
      if (!m) return "";
      const v = m[1];
      if (/hybrid/.test(v)) return "hybrid";
      if (/remote/.test(v)) return "remote";
      return "onsite";
    })();

    // "work from anywhere" only counts as a genuine remote arrangement when
    // it ISN'T the common PTO-style perk "4 weeks work from anywhere" /
    // "one month of work from anywhere" / "work from anywhere for 2 weeks"
    // (temporary remote as a benefit, not a fully-remote role). Left
    // unguarded, that perk phrase flipped an On-site role to "Good fit"
    // (ether.fi on Ashby: "Location Type: On-site" + "4 weeks work from
    // anywhere").
    const wfaPerk =
      /\b(?:\d+|one|two|three|four|five|six|a|couple|few|several)\s+(?:weeks?|days?|months?)\b[^.\n]{0,15}\bwork(?:ing)? from anywhere\b/.test(hay) ||
      /\bwork(?:ing)? from anywhere\b[^.\n]{0,12}\b(?:for|up to|per year|each year|annually|a year)\b/.test(hay);
    const remoteAnywhere =
      /\bremote[\s-]?(?:anywhere|worldwide|global(?:ly)?)\b|\banywhere in the world\b|\bfully[\s-]?distributed\b/.test(hay) ||
      (/\bwork from anywhere\b/.test(hay) && !wfaPerk);
    const kwRemote =
      lt.includes("TELECOMMUTE") ||
      /\b(?:fully|100%|100 %)?\s*remote\b|\bwork[\s-]?from[\s-]?home\b|\bwfh\b|\bremote[\s-]?(?:first|only|friendly)\b|\bdistributed team\b|\bvollständig remote\b|\b100% remote\b/.test(hay);
    const kwHybrid = /\bhybrid\b/.test(hay);
    const kwOnsite =
      /\bon[\s-]?site\b|\bin[\s-]?office\b|\bin[\s-]?person\b|\boffice[\s-]?based\b|\bvor ort\b|\bpräsenz\b/.test(hay);

    let arrangement = labelType;
    if (!arrangement) {
      if (remoteAnywhere || kwRemote) arrangement = "remote";
      else if (kwHybrid) arrangement = "hybrid";
      else if (kwOnsite) arrangement = "onsite";
      else arrangement = "unknown";
    }
    const hasRemoteOption = remoteAnywhere || kwRemote;

    const officeDays =
      /(\d)\s*(?:-\s*\d\s*)?days?\s*(?:a|per)?\s*week[^.\n]{0,40}(?:office|on[\s-]?site|in[\s-]?person)/.test(hay) ||
      /(?:office|on[\s-]?site|in[\s-]?person)[^.\n]{0,40}(\d)\s*(?:-\s*\d\s*)?days?\s*(?:a|per)?\s*week/.test(hay);

    // A STRUCTURED "Location Type" label (Ashby / Greenhouse / etc.:
    // "Location Type: On-site") is authoritative — evaluate it FIRST so it
    // wins over the loose remoteAnywhere keyword heuristic. Otherwise a
    // perk phrase ("4 weeks work from anywhere") suppressed the on-site
    // blocker entirely and the role read as "Good fit".
    if (labelType === "onsite") {
      blockers.push("On-site / in-office role.");
    } else if (labelType === "hybrid") {
      // A STRUCTURED "Location Type: Hybrid" label is authoritative — flag
      // it regardless of incidental remote mentions ("offices + remote
      // teams worldwide" blurbs, a "work from anywhere" perk, etc.).
      flags.push("Hybrid role — not fully remote.");
    }

    if (!remoteAnywhere) {
      if (!labelType) {
        // No structured label — fall back to the keyword-derived arrangement.
        if (arrangement === "onsite") {
          blockers.push("On-site / in-office role.");
        } else if (arrangement === "hybrid" && !hasRemoteOption) {
          flags.push("Hybrid role — not fully remote.");
        } else if (officeDays) {
          flags.push("Advertised remote but wants some days in the office.");
        } else if (arrangement === "unknown") {
          flags.push("Couldn't confirm this is fully remote — check the posting.");
        }
      } else if (labelType === "remote" && officeDays) {
        // Structured "Remote" label, but the JD still asks for office days.
        flags.push("Advertised remote but wants some days in the office.");
      }

      if (/\b(?:must|willing to|required to|need to)\s+relocat|\brelocation (?:is )?(?:required|mandatory|expected)\b|\brelocat(?:e|ion) to\b|\bumzug\b/.test(hay)) {
        blockers.push("Requires relocation.");
      }

      const restriction = detectCountryRestriction(hay, profileCtx.country);
      if (restriction) blockers.push(restriction);
    }

    // Security clearance — flag ONLY when a clearance is actually REQUIRED.
    // A bare "security clearance" mention is too broad: ATS postings carry
    // structured fields like "Security Clearance Type: None/Not Required" /
    // "Security Clearance Status: Not Required" that NAME the phrase while
    // stating none is needed. (hay is already lower-cased.)
    const clearanceNotRequired =
      /\bclearance(?:\s+(?:type|status|level|requirement))?\s*[:\-—]?\s*(?:none|not\s+required|not\s+needed|not\s+necessary|no\b|n\/a)/.test(hay) ||
      // Label field "Clearance Required: None / No / Not Required / N/A"
      // (Guidehouse etc.) — the label matches "clearance required" but the
      // VALUE says none is needed.
      /\bclearance\s+required\s*[:\-—]?\s*(?:none|no\b|not\b|n\/a|false)/.test(hay) ||
      /\bno\s+(?:security\s+|active\s+)?clearance\b/.test(hay) ||
      /\b(?:security\s+)?clearance\s+(?:is\s+)?not\s+(?:required|needed|necessary)\b/.test(hay) ||
      /\bdoes\s+not\s+require\b[^.\n]{0,20}\bclearance\b/.test(hay);
    const clearanceRequired =
      /\b(?:secret|top[\s-]?secret)\s+clearance\b/.test(hay) ||
      /\b(?:sc|dv|ts\/sci)\s+clear(?:ed|ance)\b/.test(hay) ||
      /\bactive\s+(?:security\s+)?clearance\b/.test(hay) ||
      /\bclearance\s+(?:is\s+)?required\b/.test(hay) ||
      /\bable to obtain .{0,20}clearance\b/.test(hay) ||
      /\b(?:must (?:have|hold|possess)|requires?|need(?:s|ed)?)\b[^.\n]{0,30}\bsecurity clearance\b/.test(hay) ||
      // "security clearance … required/mandatory", but NOT across a
      // "not"/"none" (so "…clearance: none/not required" doesn't match).
      /\bsecurity clearance\b(?:(?!\bnot\b|\bnone\b)[^.\n]){0,25}\b(?:required|mandatory|is a must|is essential)\b/.test(hay);
    if (clearanceRequired && !clearanceNotRequired) {
      blockers.push("Requires a security clearance.");
    }

    const lang = detectLanguageRequirement(hay);
    if (lang) blockers.push(`Requires ${lang} (you target English-only roles).`);

    // Out-of-scope role — matched against the TITLE only (not the JD body,
    // which mentions "support"/"sales"/etc. in passing). A non-developer
    // role (support, sales, product/program/people management, dev-rel,
    // security/field/pre-sales engineering, teaching, …) is a hard skip.
    const avoidRole = matchAvoidRole(title);
    if (avoidRole) {
      blockers.push(`Not a developer role — looks like ${avoidRole}. You target developer roles.`);
    }

    const level = blockers.length ? "skip" : flags.length ? "check" : "good";
    return { level, blockers, flags, reasons: blockers.concat(flags) };
  }

  /**
   * Heuristic page-type check. Returns true when the current page
   * looks like a job posting we should let the side panel auto-fill
   * Company / Role / JD from. Mirrors the criteria content-detect.js
   * uses for showing the floating badge.
   *
   * SELF-CONTAINED so the side panel can serialize it via
   * chrome.scripting.executeScript({ func }) and run it in the page —
   * every helper is nested, every constant is local.
   */
  function isLikelyJobPage(result) {
    const KNOWN_JOB_HOSTS = [
      "linkedin.com", "indeed.com", "lever.co", "greenhouse.io", "ashbyhq.com",
      "workable.com", "wellfound.com", "angel.co", "smartrecruiters.com",
      "hirehive.com", "workdayjobs.com", "myworkdayjobs.com", "bamboohr.com",
      "join.com", "zohorecruit", "teamtailor.com", "recruitee.com", "personio",
      "jobvite.com", "icims.com", "taleo.net", "successfactors", "breezy.hr",
      "traffit.com", "recruitcrm.io",
      // ADP WorkforceNow / Recruitment Management
      "workforcenow.adp.com", "adp.com",
      // Avature, Phenom, iCIMS portals, Eightfold, etc.
      "avature.net", "phenom.com", "eightfold.ai", "ultipro.com", "ukg.com",
      "paylocity.com", "paychex.com", "ceridian.com", "dayforce.com",
      "silkroad.com", "wd1.myworkdaysite.com", "myworkdaysite.com",
      "sapsf.com", "successfactors.com",
      "applytojob.com", "recruiterbox.com", "jazzhr.com",
      "pinpointhq.com", "pinpoint.dev",
      "talentlink.com", "talentlms.com",
      "jobaps.com", "ngahr.com", "neogov.com",
      "polymer.co", "polymerhq.io",
      "rippling.com", "gusto.com", "remoterocketship.com",
      "hireology.com", "applicantstack.com",
      "trakstar.com", "fountain.com",
      "jobs.", "careers.", "apply.", "career.", "recruiting.", "recruitment.",
      "talent.", "work.", "join.",
    ];
    const JOB_PATH_HINTS = [
      "/jobs/", "/job/", "/careers/", "/career/", "/vacancy/", "/vacancies/",
      "/positions/", "/position/", "/opening", "/role/", "/roles/",
      "/recruitment/", "/recruiting/", "/req/", "/requisition/",
      "/listing/", "/listings/", "/posting/", "/postings/",
      "/apply/", "/application/",
    ];
    if (!result) return false;
    if (result.source === "json-ld") return true; // JSON-LD JobPosting = high confidence
    const h = location.hostname;
    const path = location.pathname.toLowerCase();
    const onJobHost = KNOWN_JOB_HOSTS.some((k) => h.includes(k));
    const onJobPath = JOB_PATH_HINTS.some((k) => path.includes(k));
    // Greenhouse / Lever / etc. embed widgets carry their Job ID in
    // the URL — high-confidence signal even on a company's marketing
    // domain (8am.com / careers.foo.com / etc.).
    let embed = false;
    try {
      const u = new URL(location.href);
      embed =
        u.searchParams.has("gh_jid") ||
        u.searchParams.has("gh_src") ||
        u.searchParams.has("jobId") ||
        u.searchParams.has("jobid") ||
        u.searchParams.has("requisitionId") ||
        u.searchParams.has("posting_id") ||
        u.searchParams.has("postingId");
    } catch { /* malformed URL — ignore */ }
    // Substantial JD body is required. Lots of pages have a "title"
    // (every Google search result has one!) but only real JD pages
    // produce 400+ chars of role description.
    const hasBody = (result.description || "").length > 400;
    if ((onJobHost || onJobPath || embed) && hasBody && !!result.title) return true;
    // Known-ATS single-posting page with a trustworthy role + employer,
    // even when the JD body is thin. Some ATSes (recruitcrm.io/apply)
    // show the application FORM by default and hide the JD behind a "View
    // Job Description" toggle, so at detect time the body is near-empty
    // even though the page is unambiguously one job posting. Accept when
    // we pulled BOTH a title and a company from a non-guess source (an
    // adapter / structured metadata — not a low-confidence hostname or
    // title-split). Scoped to per-posting paths (…/apply/<id>,
    // …/job/<id>, …/req/<id>) so a listing index can't slip through.
    const singlePostingPath =
      /\/(?:apply|application|posting|postings|req|requisition|job|jobs|position|positions|opening|openings|vacancy|vacancies)\/[^/]+/.test(path);
    if ((onJobHost || embed) && singlePostingPath && !!result.title && !!result.company) {
      const prov = result.provenance || {};
      const notLow = (p) => !p || p.confidence !== "low";
      if (notLow(prov.title) && notLow(prov.company)) return true;
    }
    // Last-resort: extraction returned a substantial title + body AND
    // the page has form-side proof it's a job posting (Apply button
    // visible, or "Job Description"/"Responsibilities"/"Requirements"
    // heading). This catches ATSes we haven't seen before — ADP'\''s
    // WorkforceNow Recruitment Management, custom-built portals, etc.
    if (hasBody && !!result.title && (result.description || "").length > 800) {
      try {
        const bodyText = (document.body?.innerText || "").toLowerCase();
        const hasJobHeading = /\b(job\s+description|responsibilities|requirements?|qualifications?|what\s+you'll\s+do|essential\s+(?:job\s+)?(?:functions|responsibilities)|about\s+the\s+role|the\s+role)\b/.test(bodyText);
        const hasApplyButton = !!Array.from(document.querySelectorAll("button, a, input[type=submit]")).find((el) => {
          const t = (el.textContent || el.value || "").trim().toLowerCase();
          return t === "apply" || t === "apply now" || t === "apply for this job" || t === "submit application";
        });
        if (hasJobHeading || hasApplyButton) return true;
      } catch { /* DOM access errors ignored */ }
    }
    return false;
  }

  const api = { extractFromDocument, assessJobFit, isLikelyJobPage };
  // Browser (side panel + content script): expose on window. The
  // `typeof window` guard lets Node import this file for unit testing
  // assessJobFit (a pure function) without a DOM — see test/.
  if (typeof window !== "undefined") window.ProactiveJobFit = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
