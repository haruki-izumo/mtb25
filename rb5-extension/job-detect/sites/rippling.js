/* =====================================================================
 * job-detect/sites/rippling.js — Rippling ATS job board
 * (ats.rippling.com/<company>/jobs/<uuid>; the host can carry a region
 * shard like ats.us1.rippling.com, and the path an i18n locale prefix
 * like /de-DE/<company>/jobs/<uuid>).
 * =====================================================================
 * Ported from BidHub's packages/job-parsers/content/platforms/
 * rippling/index.js.
 *
 * Rippling's Next.js page embeds the full job record as JSON in
 * `#__NEXT_DATA__` — no DOM scraping needed for title/company/
 * description, just reading that payload. Location + employment type
 * aren't in the plain description text, so (same pattern
 * SmartRecruiters' own detect file uses) they're appended as labeled
 * lines.
 * ===================================================================== */
(function () {
  "use strict";

  // Lightweight HTML-entity decode (stands in for BidHub's `he.decode` —
  // Rippling's JSON payload entity-encodes the rich-text description).
  function decodeHtmlEntities(value) {
    if (typeof value !== "string" || !value) return value;
    const el = document.createElement("textarea");
    el.innerHTML = value;
    return el.value;
  }

  // The entity-decode above only unescapes the payload back into a raw
  // HTML string ("<p>...</p>") — it's still markup, not display text. Parse
  // it into a detached element and read the rendered text back out, same
  // pattern as the other ATS adapters that get raw HTML out of page JSON.
  function htmlFragmentToText(html) {
    if (!html) return "";
    try {
      const div = document.createElement("div");
      div.innerHTML = html;
      div.querySelectorAll("script,style").forEach((el) => el.remove());
      return (div.textContent || "").trim();
    } catch {
      return "";
    }
  }

  function parseRipplingJob() {
    const metadataElement = document.getElementById("__NEXT_DATA__");
    if (!metadataElement) return null;
    try {
      const metadata = JSON.parse(metadataElement.textContent);
      const job = metadata?.props?.pageProps?.apiData?.jobPost;
      if (!job) return null;

      let description = htmlFragmentToText(decodeHtmlEntities(job.description?.role));
      if (job.workLocations) {
        try {
          description += `\nWork Location: ${job.workLocations.join(", ")}`;
        } catch { /* malformed location list — skip */ }
      }
      if (job.employmentType) {
        try {
          description += `\nEmployment Type: ${job.employmentType.label}`;
        } catch { /* malformed employment type — skip */ }
      }

      return {
        // Company-less rule: decoding an absent companyName threw and
        // dropped the whole posting under the old implementation; null =
        // no employer named.
        company: job.companyName ? decodeHtmlEntities(job.companyName) : null,
        title: decodeHtmlEntities(job.name),
        description,
        postedDate: job.createdOn,
        url: decodeHtmlEntities(job.url),
      };
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  window.ProactiveJobDetect.parser(parseRipplingJob);
})();
