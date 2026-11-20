// job-detect/sites/ultipro.js — UltiPro (UKG Pro Recruiting) opportunity
// detail pages (*.ultipro.com/.../JobBoard/.../OpportunityDetail...).
// Ported from BidHub's own
// packages/job-parsers/content/platforms/ultipro/index.js.
//
// UltiPro job pages are Knockout-rendered client-side from ONE inline JSON
// blob the server emits as `CandidateOpportunityDetail({...});`. Every
// visible label on the page is an i18next `$.t(...)` string (localized per
// tenant/candidate), so nothing here may key off visible text: the JSON
// (anchored on that function name, not a label) is the language-independent
// source, and the only DOM hooks used are UltiPro's own `data-automation` /
// id attributes.
//
// The parser forwards more than Title + Description: the rest of the
// posting (locations, on-site/remote, full/part-time, category,
// requisition, posted date, pay, travel, EEO / pay-transparency statements)
// never otherwise leaves the JSON. Field extraction runs server-side over
// the description, so the metadata is spelled out as labeled text at the
// top of it.
(function () {
  "use strict";

  // Enum labels from UltiPro's own en-US translation bundle
  // (Content/locales/en-US/translation.json): Common.JobLocationType_{0,1,2}
  // and Opportunity.OpportunityDetail.FullTime_{true,false}.
  const JOB_LOCATION_TYPES = { 0: "Hybrid", 1: "On-site", 2: "Remote" };
  const OPPORTUNITY_PATTERN = /CandidateOpportunityDetail\((\{[\s\S]*?\})\);/;

  function isSet(value) {
    return value !== null && value !== undefined && value !== "";
  }

  // UltiPro's Description / PayTransparencyPolicyStatement /
  // EqualOpportunityEmployerDescription fields are raw HTML strings sitting
  // in the page's JSON blob, not live DOM elements — parse into a detached
  // <div> and read textContent to get plain text out of them (same
  // technique job-detect/sites/ashby.js's htmlFragmentToText uses, inlined
  // here since job-detect/normalize/html.js isn't loaded on *.ultipro.com
  // per manifest.json's content_scripts entry for this host). This feeds a
  // plain-text textarea (#jobText), which can never render markup — see
  // job-detect/sites/greenhouse.js for the live-element version of this fix.
  function htmlFragmentToText(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    const div = document.createElement("div");
    div.innerHTML = value;
    div.querySelectorAll("script, style, noscript, template, svg, iframe, link, meta, head").forEach((el) => el.remove());
    const result = (div.textContent || "").trim();
    return result || null;
  }

  function getUltiproOpportunity(doc = document) {
    for (const script of Array.from(doc.scripts)) {
      const match = (script.textContent || "").match(OPPORTUNITY_PATTERN);
      if (!match?.[1]) continue;
      try {
        return JSON.parse(match[1]);
      } catch {
        // Ignore malformed matches and keep scanning.
      }
    }
    return null;
  }

  function getCompanyName(doc) {
    const image = doc.querySelector(".navbar-brand img[alt]");
    if (image?.getAttribute("alt")?.trim()) return image.getAttribute("alt").trim();
    return doc.querySelector(".navbar-brand")?.textContent?.trim() || null;
  }

  function formatLocation(location) {
    const address = location?.Address || {};
    const parts = [address.City, address.State, address.Country?.Name].filter(isSet);
    // LocalizedName is the tenant's own label ("USA", "Boston HQ"); keep it
    // when it adds a token the address (or the country code) does not
    // already carry.
    const name = location?.LocalizedName;
    const known = [...parts, address.Country?.Code].filter(isSet).map((part) => part.toLowerCase());
    if (name && !known.includes(name.toLowerCase())) parts.unshift(name);
    return parts.join(", ") || null;
  }

  function formatMoney(amount, currency) {
    if (!isSet(amount)) return null;
    const number = Number(amount);
    const formatted = Number.isFinite(number) ? number.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(amount);
    return currency ? `${formatted} ${currency}` : formatted;
  }

  function formatPay(opportunity) {
    const currency = opportunity.CompensationCurrencyCode || opportunity.PayRangeCurrencyCode || opportunity.CompensationAmount?.Code || null;
    const unit = opportunity.Salaried === false ? "per hour" : "per year";
    const amount = opportunity.CompensationAmount?.Value ?? opportunity.CompensationAmount;
    if (isSet(amount) && typeof amount !== "object") return `${formatMoney(amount, currency)} ${unit}`;
    const min = opportunity.PayRange?.PayRangeMinimum ?? (opportunity.Salaried === false ? opportunity.CompensationHourlyMinimum : opportunity.CompensationAnnualMinimum);
    const max = opportunity.PayRange?.PayRangeMaximum ?? (opportunity.Salaried === false ? opportunity.CompensationHourlyMaximum : opportunity.CompensationAnnualMaximum);
    if (!isSet(min) && !isSet(max)) return null;
    const range = [formatMoney(min, null), formatMoney(max, null)].filter(Boolean).join(" - ");
    return `${range}${currency ? ` ${currency}` : ""} ${unit}`;
  }

  function formatTravel(opportunity) {
    if (!isSet(opportunity.TravelRequired) && !isSet(opportunity.TravelDescription)) return null;
    const required = opportunity.TravelRequired === true ? "Yes" : opportunity.TravelRequired === false ? "No" : null;
    return [required, opportunity.TravelDescription].filter(isSet).join(" - ") || null;
  }

  // [label, value] lines for the metadata block at the top of the description.
  function getUltiproMetadataLines(opportunity) {
    const locations = (opportunity.Locations || []).map(formatLocation).filter(Boolean);
    const employment = [
      typeof opportunity.FullTime === "boolean" ? (opportunity.FullTime ? "Full-Time" : "Part-Time") : null,
      isSet(opportunity.HoursPerWeek) ? `${opportunity.HoursPerWeek} hours per week` : null,
    ].filter(Boolean).join(", ");
    return [
      [locations.length > 1 ? "Locations" : "Location", locations.join("; ")],
      ["Workplace type", JOB_LOCATION_TYPES[opportunity.JobLocationType]],
      ["Employment type", employment],
      ["Job category", opportunity.JobCategoryName],
      ["Requisition number", opportunity.RequisitionNumber],
      ["Posted", typeof opportunity.PostedDate === "string" ? opportunity.PostedDate.slice(0, 10) : null],
      ["Pay", formatPay(opportunity)],
      ["Travel required", formatTravel(opportunity)],
    ].filter(([, value]) => isSet(value));
  }

  // Metadata block + body + the statements the page renders under it, all
  // as plain text, since this feeds a plain-text textarea directly.
  function buildUltiproDescription(opportunity, bodyText) {
    const lines = getUltiproMetadataLines(opportunity);
    const sections = [
      lines.length ? lines.map(([label, value]) => `${label}: ${value}`).join("\n") : "",
      bodyText || "",
      opportunity.PayTransparencyPolicyStatement ? `Pay Transparency\n${htmlFragmentToText(opportunity.PayTransparencyPolicyStatement) || ""}` : "",
      opportunity.EqualOpportunityEmployerDescription
        ? `Equal Opportunity Employer\n${htmlFragmentToText(opportunity.EqualOpportunityEmployerDescription) || ""}`
        : "",
    ].filter(Boolean);
    return sections.join("\n\n") || null;
  }

  function parseUltiproJob(doc = document) {
    const opportunity = getUltiproOpportunity(doc);
    if (!opportunity) return null;

    // Knockout renders the same JSON into this hook; only a fallback for a
    // blob without Description. `opportunity.Description` is a raw HTML
    // string (needs htmlFragmentToText); the DOM fallback element is live
    // and attached, so innerText (preferred) / textContent reaches it
    // directly.
    const descriptionElement = doc.querySelector('[data-automation="job-description"]');
    const bodyText =
      htmlFragmentToText(opportunity.Description) ||
      (descriptionElement ? (descriptionElement.innerText || descriptionElement.textContent || "").trim() : null) ||
      null;
    return {
      title: opportunity.Title || null,
      company: getCompanyName(doc),
      description: buildUltiproDescription(opportunity, bodyText),
    };
  }

  window.ProactiveJobDetect.parser(() => parseUltiproJob(document));
})();
