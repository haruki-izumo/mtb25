// job-detect/sites/ashby.js — Ashby job-posting pages
// (jobs.ashbyhq.com/{org}/{postingId} — both the "Overview" tab and the
// "/application" tab). Ported from BidHub's own
// packages/job-parsers/content/platforms/ashbyhq/index.js — this is the
// most distinctive detection in the whole porting effort, so the strategy
// below (and BidHub's own reasoning for it) is kept intact rather than
// flattened into plain DOM scraping.
//
// Ashby job posting pages server-render two data blocks BEFORE the React
// app hydrates:
//   1. an inline `<script nonce>` `window.__appData = {...};` bootstrap
//      whose `posting` carries the facts the page's visible left pane is
//      rendered from: title, locationName, secondaryLocationNames,
//      workplaceType ("Hybrid" | "OnSite" | "Remote"), employmentType
//      ("FullTime"), descriptionHtml, compensationTierSummary,
//      departmentName — plus `organization.name`;
//   2. a schema.org JobPosting JSON-LD (datePosted, baseSalary,
//      jobLocation.address, description). Its jobLocationType says
//      TELECOMMUTE on Hybrid roles, so it is never read for the
//      arrangement.
// A detector that only scrapes the rendered DOM has two problems on this
// site: the "Application" tab renders the application FORM where the
// Overview tab renders the description (so a DOM-only parse comes back
// empty on half of Ashby's own pages), and the arrangement/location-type
// is nowhere stated in the visible body text. Reading the data blocks
// first — same result on both tabs, complete before hydration, and
// independent of Ashby's hashed CSS-module class names — is what BidHub's
// own comment called "data first, DOM last". The DOM (the rendered left
// pane of labeled Location/Employment Type/Location Type/Department/
// Compensation headings) is kept only as the third-tier fallback for a
// page whose data blocks are missing or reshaped.
//
// The `__appData` object is minified JSON followed by `;` and more
// JavaScript inside the same <script>, so there is no `</script>`
// boundary to cut at — extractBalancedJson walks braces instead. Ashby
// field shapes have drifted across releases (an older shape carried
// isRemote/publishedDate/linkedData/descriptionParts; a newer one carries
// workplaceType/locationName/locationAddress/secondaryLocationNames) —
// every read below is optional so a reshaped page degrades to the next
// tier instead of throwing.
//
// title/company come from document.title ("{Position} @ {Company}"),
// split at the FIRST '@' — the same rule BidHub applies — ahead of the
// data-block fields, since the tab title is rendered before hydration too
// and is the cheapest reliable signal when it matches the expected shape.
(function () {
  "use strict";

  const APP_DATA_MARKER = "window.__appData";
  const LOCATION_TYPE_DISPLAY = { hybrid: "Hybrid", onsite: "On-site", remote: "Remote" };
  const EMPLOYMENT_TYPE_BY_KEY = {
    fulltime: "full-time",
    parttime: "part-time",
    contract: "contractor",
    contractor: "contractor",
    temporary: "temporary",
    intern: "intern",
    internship: "intern",
  };
  const SALARY_UNIT_BY_SCHEMA = { YEAR: "year", MONTH: "month", WEEK: "week", DAY: "day", HOUR: "hour" };

  const text = (value) => (typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : null);
  const unique = (values) => [...new Set(values)];

  // Ashby's own `descriptionHtml` / JSON-LD `description` fields are raw
  // HTML strings sitting in JSON data, not live DOM elements, so the
  // innerText/textContent trick (which needs a rendered element) can't
  // reach them directly: parse into a detached <div> and read its
  // textContent instead — same technique job-detect/normalize/html.js's
  // parseToText uses, inlined here since that file isn't loaded on
  // jobs.ashbyhq.com (see manifest.json's content_scripts entry for this
  // host). This feeds a plain-text textarea (#jobText), which can never
  // render markup — see job-detect/sites/greenhouse.js for the live-element
  // version of this same fix.
  function htmlFragmentToText(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const div = document.createElement("div");
    div.innerHTML = value;
    div.querySelectorAll("script, style, noscript, template, svg, iframe, link, meta, head").forEach((el) => el.remove());
    const result = (div.textContent || "").trim();
    return result || null;
  }

  // 'Hybrid' / 'OnSite' / 'On-site' / 'ON_SITE' -> app vocabulary; anything else is unknown (null).
  function workplaceTypeToLocationType(value) {
    const key = String(value ?? "").toLowerCase().replace(/[^a-z]/g, "");
    if (!key) return null;
    if (key.includes("hybrid")) return "hybrid";
    if (key.includes("remote")) return "remote";
    if (key.includes("onsite") || key.includes("inoffice") || key.includes("inperson")) return "onsite";
    return null;
  }

  // Brace-balanced JSON object starting at text[start] (which must be
  // '{'); null when unbalanced, truncated or unparseable. String literals
  // and backslash escapes are honored so a '}' inside a value never
  // closes the object early.
  function extractBalancedJson(source, start) {
    if (typeof source !== "string" || source[start] !== "{") return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const char = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(source.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  // Tier 1: the page's `window.__appData` object, read from the bootstrap
  // script's TEXT — the content script runs in an isolated world and
  // cannot read `window.__appData` itself, only the <script> source.
  function getAshbyAppData(doc) {
    const scripts = doc.scripts ? Array.from(doc.scripts) : Array.from(doc.querySelectorAll("script"));
    for (const script of scripts) {
      const content = script.textContent || "";
      const marker = content.indexOf(APP_DATA_MARKER);
      if (marker === -1) continue;
      const start = content.indexOf("{", marker);
      if (start === -1) continue;
      const data = extractBalancedJson(content, start);
      if (data && typeof data === "object" && !Array.isArray(data)) return data;
    }
    return null;
  }

  function flattenSchemaNodes(node) {
    if (Array.isArray(node)) return node.flatMap(flattenSchemaNodes);
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node["@graph"])) return [node, ...flattenSchemaNodes(node["@graph"])];
    return [node];
  }
  const isJobPosting = (node) => node["@type"] === "JobPosting" || (Array.isArray(node["@type"]) && node["@type"].includes("JobPosting"));

  // Tier 2: the first schema.org JobPosting in the page's ld+json
  // scripts (single node, array, or @graph).
  function getAshbyJsonLd(doc) {
    for (const node of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const found = flattenSchemaNodes(JSON.parse(node.textContent)).find(isJobPosting);
        if (found) return found;
      } catch {
        // malformed JSON-LD: keep looking
      }
    }
    return null;
  }

  // A heading's value node with its buttons removed ("See More" sits
  // inside the Compensation value).
  function valueText(node) {
    if (!node) return null;
    const clone = node.cloneNode(true);
    clone.querySelectorAll("button").forEach((button) => button.remove());
    return text(clone.textContent);
  }

  // Tier 3: the visible left pane, as rendered by Ashby on BOTH tabs —
  // repeated `<h2>Label</h2>` + value pairs (Location, Employment Type,
  // Location Type, Department, Compensation). Map keyed by the
  // lower-cased label; this is the DOM fallback for a page whose data
  // blocks are missing or reshaped.
  function getAshbyLeftPaneFacts(doc) {
    const facts = new Map();
    const pane = doc.querySelector(".ashby-job-posting-left-pane");
    if (!pane) return facts;
    for (const heading of pane.querySelectorAll("h2, h3")) {
      const label = text(heading.textContent);
      const value = valueText(heading.nextElementSibling);
      if (label && value) facts.set(label.toLowerCase(), value);
    }
    return facts;
  }

  // The rendered JD body — Overview tab only (the Application tab
  // renders the form instead, which is exactly why this is the LAST
  // resort rather than the primary source). This element is live and
  // attached to the document, so innerText (preferred) / textContent
  // reaches it directly — unlike the JSON-sourced HTML strings above.
  function getAshbyDomDescription(doc) {
    const element =
      doc.querySelector("#overview .ashby-job-posting-description") ||
      doc.querySelector(".ashby-job-posting-description-container") ||
      doc.querySelector(".ashby-job-posting-description") ||
      doc.querySelector("div#overview");
    return element ? (element.innerText || element.textContent || "").trim() || null : null;
  }

  // { postalAddress: { addressLocality, addressRegion, addressCountry } }
  // (or the bare postal object) -> "Santa Clara, Ca, United States"; a
  // part already spelled inside an earlier one is dropped.
  function postalAddressText(address) {
    const postal = address && typeof address === "object" && address.postalAddress ? address.postalAddress : address;
    if (!postal || typeof postal !== "object") return null;
    const parts = [postal.addressLocality, postal.addressRegion, postal.addressCountry].map(text).filter(Boolean);
    const deduped = parts.filter(
      (part, index) => !parts.slice(0, index).some((prev) => prev.toLowerCase().split(/,\s*/).includes(part.toLowerCase()))
    );
    return deduped.length > 0 ? deduped.join(", ") : null;
  }

  // schema.org jobLocation (Place, array of Places, or plain string) -> address texts.
  const schemaLocationTexts = (jobLocation) => {
    const places = Array.isArray(jobLocation) ? jobLocation : jobLocation ? [jobLocation] : [];
    return unique(places.map((place) => (typeof place === "string" ? text(place) : postalAddressText(place?.address || place))).filter(Boolean));
  };

  const joinDescriptionParts = (parts) => {
    if (!parts || typeof parts !== "object") return null;
    const joined = ["descriptionOpening", "descriptionBody", "descriptionClosing"]
      .map((key) => parts[key])
      .map((part) => (typeof part === "string" ? part : part?.html))
      .map((part) => htmlFragmentToText(part))
      .filter(Boolean)
      .join("\n");
    return joined || null;
  };

  const secondaryLocationNames = (posting) => {
    const list = Array.isArray(posting?.secondaryLocationNames)
      ? posting.secondaryLocationNames
      : Array.isArray(posting?.secondaryLocations)
        ? posting.secondaryLocations
        : [];
    return list.map((entry) => (typeof entry === "string" ? entry : entry?.location)).map(text).filter(Boolean);
  };

  const finiteNumber = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const number = typeof value === "string" ? Number(value.replace(/[^0-9.-]/g, "")) : Number(value);
    return Number.isFinite(number) ? number : null;
  };

  // schema.org MonetaryAmount -> the {min?, max?, currency?, unit?} shape; null without a number.
  function salaryFromSchema(baseSalary) {
    if (!baseSalary || typeof baseSalary !== "object") return null;
    const value = baseSalary.value && typeof baseSalary.value === "object" ? baseSalary.value : baseSalary;
    const min = finiteNumber(value.minValue ?? value.value ?? baseSalary.minValue);
    const max = finiteNumber(value.maxValue ?? value.value ?? baseSalary.maxValue);
    if (min === null && max === null) return null;
    const salary = {};
    if (min !== null) salary.min = min;
    if (max !== null) salary.max = max;
    const currency = text(baseSalary.currency || value.currency);
    if (currency) salary.currency = currency.toUpperCase();
    const unit = SALARY_UNIT_BY_SCHEMA[String(value.unitText || baseSalary.unitText || "").trim().toUpperCase()];
    if (unit) salary.unit = unit;
    return salary;
  }

  const formatSalary = (salary) => {
    if (!salary) return null;
    const amount = (value) => (Number.isInteger(value) ? value.toLocaleString("en-US") : String(value));
    const range =
      salary.min !== undefined && salary.max !== undefined && salary.min !== salary.max
        ? `${amount(salary.min)} – ${amount(salary.max)}`
        : amount(salary.min ?? salary.max);
    return `${range}${salary.currency ? ` ${salary.currency}` : ""}${salary.unit ? ` per ${salary.unit}` : ""}`;
  };

  // 'FullTime' / 'FULL_TIME' -> 'Full time' for the facts line; the
  // pane's own rendered label wins over this derived one when present.
  const humanizeEmployment = (raw) => {
    const spaced = text(String(raw ?? "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " "));
    return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase() : null;
  };

  // Everything the page states about the posting, merged by priority:
  // __appData.posting (tier 1) → JSON-LD, posting.linkedData counts too
  // (tier 2) → the rendered left pane (tier 3).
  function getAshbyFacts(doc) {
    const appData = getAshbyAppData(doc);
    const posting = appData?.posting && typeof appData.posting === "object" ? appData.posting : null;
    const organization = appData?.organization && typeof appData.organization === "object" ? appData.organization : null;
    const linked = posting?.linkedData && typeof posting.linkedData === "object" ? posting.linkedData : null;
    const jsonLd = getAshbyJsonLd(doc) || linked;
    const pane = getAshbyLeftPaneFacts(doc);

    let locationNames = unique(
      [
        text(posting?.locationName) || text(posting?.locationExternalName) || postalAddressText(posting?.address || posting?.locationAddress),
        ...secondaryLocationNames(posting),
      ].filter(Boolean)
    );
    if (locationNames.length === 0) locationNames = schemaLocationTexts(jsonLd?.jobLocation);
    if (locationNames.length === 0 && pane.get("location")) locationNames = [pane.get("location")];

    const workplaceLabel = text(posting?.workplaceType) || pane.get("location type") || null;
    const workplaceType = workplaceTypeToLocationType(workplaceLabel);
    const employmentRaw = text(posting?.employmentType) || text(jsonLd?.employmentType) || pane.get("employment type") || null;
    const salary = salaryFromSchema(jsonLd?.baseSalary);

    return {
      title: text(posting?.title) || text(jsonLd?.title),
      company: text(organization?.name) || text(jsonLd?.hiringOrganization?.name),
      body:
        htmlFragmentToText(posting?.descriptionHtml) ||
        joinDescriptionParts(posting?.descriptionParts) ||
        htmlFragmentToText(jsonLd?.description) ||
        getAshbyDomDescription(doc),
      locationNames,
      workplaceDisplay: LOCATION_TYPE_DISPLAY[workplaceType] || workplaceLabel,
      employmentDisplay: pane.get("employment type") || humanizeEmployment(employmentRaw),
      compensation:
        text(posting?.compensationTierSummary) || text(posting?.scrapeableCompensationSalarySummary) || pane.get("compensation") || formatSalary(salary),
      department:
        text(posting?.departmentExternalName) ||
        text(posting?.departmentName) ||
        (Array.isArray(posting?.teamNames) ? posting.teamNames.map(text).filter(Boolean).join(", ") : null) ||
        text(posting?.teamName) ||
        pane.get("department") ||
        null,
    };
  }

  // Labeled metadata block + body, same shape BidHub builds for
  // smartrecruiters/rippling too: the block is text, so it survives into
  // the job-text box the same as a real posting's own labeled facts
  // would — fixed order, only the facts that exist.
  function buildAshbyDescription(facts) {
    if (!facts?.body) return null;
    const lines = [
      [facts.locationNames.length > 1 ? "Locations" : "Location", facts.locationNames.join("; ")],
      ["Location Type", facts.workplaceDisplay],
      ["Employment Type", facts.employmentDisplay],
      ["Compensation", facts.compensation],
      ["Department", facts.department],
    ].filter(([, value]) => value);
    if (lines.length === 0) return facts.body;
    const metadataText = lines.map(([label, value]) => `${label}: ${value}`).join("\n");
    return `${metadataText}\n${facts.body}`;
  }

  function parserFunc() {
    const doc = document;
    const title = doc.title || "";
    const splitIndex = title.indexOf("@");
    const facts = getAshbyFacts(doc);
    const position = (splitIndex >= 2 ? text(title.substring(0, splitIndex)) : null) || facts.title;
    const company = (splitIndex >= 2 ? text(title.substring(splitIndex + 1)) : null) || facts.company;
    // Position is the only mandatory identity field — company: null = "this page names no employer".
    if (!position) return null;
    return {
      title: position,
      company: company || null,
      description: buildAshbyDescription(facts),
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
