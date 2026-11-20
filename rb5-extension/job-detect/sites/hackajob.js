// job-detect/sites/hackajob.js — hackajob ("Archer from hackajob"),
// https://hackajob.com/job/<uuid>-<slug>. Ported from BidHub's own
// packages/job-parsers/content/platforms/hackajob/index.js. Astro-
// rendered, two variants of the SAME url (verified live 2026-10-08):
//   - the JD page (default): h1.job-refresh__title,
//     .job-refresh__chips .pill (location, contract),
//     .job-refresh__skills .skill-chip, .job-refresh__org (employer) and
//     the rich .job-refresh__description, plus a JobPosting JSON-LD
//     (hiringOrganization, datePosted, employmentType, jobLocation,
//     skills, identifier = the uuid).
//   - the register landing (?utm_campaign=jobiqo-air paid traffic, and
//     /talent/apply?job=<uuid>): "Create your free profile to apply to
//     <Company>" over the account form, with only a summary card
//     (.apply-card__title, company, location, salary, contract, skills)
//     — NO description and no JSON-LD. Once such a visit set hackajob's
//     own campaign cookie, every later /job url in that browser renders
//     this landing too. The description is fetched from the canonical JD
//     url WITHOUT cookies and parsed from that static HTML; until it
//     lands nothing is reported, and if the fetch fails the summary card
//     is all there is.
// /en-us/job/... serves the same page. The posting's canonical form is
// /job/<uuid> (the slug is cosmetic and gets truncated in "View role"
// links).
//
// Out of scope here (per the port's own boundary, see autofill/sites/
// hackajob-autofill.js): none of hackajob's candidate-ACCOUNT flow
// (sign-in, profile wizard, matching) — this file only ever reads public
// posting/landing markup, same as BidHub's own source.
(function () {
  "use strict";

  const JOB_PATH_PATTERN = /^\/(?:en-us\/)?job\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:-[^/?#]*)?\/?$/i;
  const APPLY_PATH_PATTERN = /^\/(?:en-us\/)?talent\/apply\/?$/i;
  const JSON_LD_SELECTOR = 'script[type="application/ld+json"]';
  const FETCH_ATTRIBUTE = "data-bigbanana-hackajob-jd";

  function cleanText(value) {
    return String(value ?? "")
      .replace(/ /g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // The job uuid of a hackajob url: the posting path, the register
  // landing's ?job= param, or null.
  function getHackajobJobId(href) {
    let url;
    try {
      url = new URL(href, "https://hackajob.com");
    } catch {
      return null;
    }
    const pathMatch = url.pathname.match(JOB_PATH_PATTERN);
    if (pathMatch) return pathMatch[1].toLowerCase();
    if (APPLY_PATH_PATTERN.test(url.pathname)) {
      const job = url.searchParams.get("job") || "";
      return /^[0-9a-f-]{36}$/i.test(job) ? job.toLowerCase() : null;
    }
    return null;
  }

  function readHackajobJsonLd(doc) {
    for (const script of doc.querySelectorAll(JSON_LD_SELECTOR)) {
      try {
        const parsed = JSON.parse(script.textContent || "");
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        const posting = candidates.find((entry) => entry && entry["@type"] === "JobPosting");
        if (posting) return posting;
      } catch {
        // not JSON-LD we can read — keep scanning
      }
    }
    return null;
  }

  function humanize(value) {
    return cleanText(value)
      .toLowerCase()
      .replace(/_/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function detailLines({ chips = [], skills = [], posting = null, card = null }) {
    const details = [];
    const seen = new Set();
    const add = (label, value) => {
      const text = cleanText(value);
      if (!text || seen.has(`${label}:${text.toLowerCase()}`)) return;
      seen.add(`${label}:${text.toLowerCase()}`);
      details.push([label, text]);
    };
    if (card) {
      add("Location", card.location);
      add("Salary", card.salary);
      add("Contract", card.contract);
    }
    // Chips: "Wilmington, DE, USA", "Full-time", sometimes a salary — keep
    // them as a single line each.
    chips.forEach((chip) => {
      if (/^(full|part)[- ]time|permanent|contract|temporary|internship|freelance|fixed/i.test(chip)) add("Contract", chip);
      else if (/[£$€]|\bper\b|salary/i.test(chip)) add("Salary", chip);
      else add("Location", chip);
    });
    if (details.every(([label]) => label !== "Location")) {
      const address = posting?.jobLocation?.address;
      const location = [address?.addressLocality, address?.addressRegion, address?.addressCountry]
        .map(cleanText)
        .filter(Boolean)
        .join(", ");
      add("Location", location);
    }
    if (posting?.employmentType && !/^other$/i.test(posting.employmentType) && details.every(([label]) => label !== "Contract")) {
      add("Contract", humanize(posting.employmentType));
    }
    if (posting?.datePosted) add("Posted", String(posting.datePosted).slice(0, 10));
    const skillList = skills.length > 0 ? skills : String(posting?.skills ?? "").split(",").map(cleanText).filter(Boolean);
    if (skillList.length > 0) add("Skills", skillList.join(", "));
    return details;
  }

  function renderDetails(details) {
    return details.length > 0 ? details.map(([label, value]) => `${label}: ${value}`).join("\n") : "";
  }

  // ---- JD page -------------------------------------------------------------

  function parseJdDocument(doc) {
    const title = cleanText(doc.querySelector("h1.job-refresh__title, .job-refresh__main h1")?.textContent);
    const descriptionElement = doc.querySelector(".job-refresh__description");
    if (!title || !descriptionElement || !cleanText(descriptionElement.textContent)) return null;
    const posting = readHackajobJsonLd(doc);
    const company =
      cleanText(doc.querySelector(".job-refresh__org")?.textContent) ||
      cleanText(posting?.hiringOrganization?.name) ||
      cleanText(doc.querySelector(".job-refresh__logo img")?.getAttribute("alt")) ||
      null;
    const chips = Array.from(doc.querySelectorAll(".job-refresh__chips .pill")).map((pill) => cleanText(pill.textContent)).filter(Boolean);
    const skills = Array.from(doc.querySelectorAll(".job-refresh__skills .skill-chip")).map((chip) => cleanText(chip.textContent)).filter(Boolean);
    // `descriptionElement` may belong to a DOMParser-parsed offscreen
    // document (the register-landing path below fetches the canonical JD
    // HTML and parses it with no browsing context at all), where
    // `innerText` always reads empty since there's no layout to compute it
    // from — textContent is the only extraction that works in both the
    // live-document and parsed-document cases, so it's used here rather
    // than the innerText-preferred pattern used elsewhere in this codebase.
    const detailsText = renderDetails(detailLines({ chips, skills, posting }));
    const bodyText = (descriptionElement.textContent || "").trim();
    return {
      position: title,
      company,
      description: detailsText ? `${detailsText}\n${bodyText}` : bodyText,
      ...(posting?.datePosted ? { postedDate: posting.datePosted } : {}),
    };
  }

  // ---- register landing -----------------------------------------------------

  function readLandingCard(doc) {
    const titleElement = doc.querySelector(".apply-card__title");
    if (!titleElement) return null;
    // Live markup: section.apply-card.apply-card--job > .apply-card__org
    // (logo alt + <strong> employer + .apply-card__subline country),
    // h2.apply-card__title, .apply-card__facts spans (salary, contract,
    // location) and .apply-card__chips .apply-card__chip (skills + a "+N"
    // overflow chip).
    const card = titleElement.closest(".apply-card") || titleElement.parentElement;
    const heading = cleanText(doc.querySelector("h1.apply__title, h1")?.textContent);
    const companyFromHeading = cleanText((heading.match(/to apply to (.+)$/i) || [])[1]);
    const company =
      cleanText(card.querySelector(".apply-card__org strong")?.textContent) ||
      cleanText(card.querySelector(".apply-card__org img")?.getAttribute("alt")) ||
      companyFromHeading ||
      null;
    const country = cleanText(card.querySelector(".apply-card__subline")?.textContent);
    const facts = Array.from(card.querySelectorAll(".apply-card__facts span")).map((span) => cleanText(span.textContent)).filter(Boolean);
    const salary = facts.find((fact) => /salary|[£$€]/i.test(fact)) || null;
    const contract = facts.find((fact) => fact !== salary && /time|permanent|contract|temporary|intern|freelance|fixed/i.test(fact)) || null;
    const place = facts.find((fact) => fact !== salary && fact !== contract) || null;
    const location = [place, country].filter(Boolean).join(", ") || null;
    const skills = Array.from(card.querySelectorAll(".apply-card__chip"))
      .map((chip) => cleanText(chip.textContent))
      .filter((chip) => chip && !/^\+\d+$/.test(chip));
    return { title: cleanText(titleElement.textContent), company, location, salary, contract, skills };
  }

  // Canonical JD HTML cache (register landing only): one same-origin
  // fetch per job, the parsed result kept across the parser's re-runs;
  // the attribute flip is the mutation that makes parser() re-run once
  // the fetch settles (parserFunc is synchronous by contract).
  const jdCache = new Map(); // jobId -> { status: 'pending' | 'ready' | 'error', job }

  function requestCanonicalJd(jobId, fetchImpl = window.fetch) {
    if (jdCache.has(jobId)) return jdCache.get(jobId);
    const entry = { status: "pending", job: null };
    jdCache.set(jobId, entry);
    (async () => {
      try {
        const response = await fetchImpl(`${window.location.origin}/job/${jobId}`, { credentials: "omit", redirect: "follow" });
        if (!response.ok) throw new Error(`hackajob jd ${response.status}`);
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const job = parseJdDocument(doc);
        entry.status = job ? "ready" : "error";
        entry.job = job;
      } catch {
        entry.status = "error";
      }
      try {
        document.documentElement.setAttribute(FETCH_ATTRIBUTE, `${jobId}:${entry.status}`);
      } catch {
        // documentElement locked down — the next natural mutation re-runs the parser instead
      }
    })();
    return entry;
  }

  function parseLandingDocument(doc, jobId, { fetchImpl } = {}) {
    const card = readLandingCard(doc);
    if (!card?.title) return null;
    const cached = requestCanonicalJd(jobId, fetchImpl);
    if (cached.status === "ready" && cached.job) {
      return { ...cached.job, company: cached.job.company || card.company || null };
    }
    if (cached.status === "pending") return null;
    // Canonical fetch failed — the summary card is all this page has.
    return {
      position: card.title,
      company: card.company || null,
      description: renderDetails(detailLines({ card, skills: card.skills })),
    };
  }

  function parseHackajobJob(doc = document, loc = window.location, { fetchImpl } = {}) {
    const jobId = getHackajobJobId(loc?.href || `${loc?.pathname || ""}${loc?.search || ""}`);
    if (!jobId) return null;
    if (doc.querySelector(".job-refresh__description")) return parseJdDocument(doc);
    if (doc.querySelector(".apply-card__title")) return parseLandingDocument(doc, jobId, { fetchImpl });
    return null;
  }

  function parserFunc() {
    const job = parseHackajobJob();
    if (!job) return null;
    return {
      title: job.position,
      company: job.company ?? null,
      description: job.description ?? null,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
