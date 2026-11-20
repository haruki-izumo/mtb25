/* =====================================================================
 * job-detect/sites/kula.js — Kula ATS job postings
 * (careers.kula.ai/<account>/<id>-<slug>; the application form is the
 * same page's "Application form" tab, reached as …/apply).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/kula/index.js — detection
 * only.
 *
 * The posting and the form are ONE Next.js component, and BOTH urls
 * embed a schema.org JobPosting JSON-LD block (title, HTML description,
 * hiringOrganization), so the parse is stable across the tab switch and
 * the ?applySuccess=true post-submit state. Fallbacks read the meta
 * tags: the posting's og:title is "<Position> | <Company> Careers" and
 * og:site_name is the company; the /apply tab's <title> is only
 * "Careers at <Company>" (no position), so it is never used as a
 * position source.
 * ===================================================================== */
(function () {
  "use strict";

  const JSON_LD_SELECTOR = 'script[type="application/ld+json"]';

  function norm(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function isJobPosting(entry) {
    const type = entry?.["@type"];
    return type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"));
  }

  // The first JobPosting node across every JSON-LD block (plain object,
  // array, or @graph).
  function findKulaJobPosting(root = document) {
    for (const node of root.querySelectorAll(JSON_LD_SELECTOR)) {
      let data;
      try {
        data = JSON.parse(node.textContent);
      } catch {
        continue; // malformed / non-JSON block
      }
      const candidates = Array.isArray(data)
        ? data
        : [data, ...(Array.isArray(data?.["@graph"]) ? data["@graph"] : [])];
      const found = candidates.find(isJobPosting);
      if (found) return found;
    }
    return null;
  }

  function metaContent(root, selector) {
    return norm(root.querySelector(selector)?.getAttribute("content"));
  }

  // The JSON-LD JobPosting's `description` is a raw HTML string sitting in
  // JSON data, not a live DOM element, so innerText/textContent can't reach
  // it directly: parse into a detached <div> and read its textContent back
  // out. This feeds a plain-text textarea (#jobText), which can never
  // render markup.
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

  function parseKulaJob(root = document) {
    const posting = findKulaJobPosting(root);

    // og:title = "<Position> | <Company> Careers" on the posting; the
    // apply tab has no position in it.
    const ogTitle = metaContent(root, 'meta[property="og:title"]');
    const [ogPosition, ogCompanyPart] = ogTitle.includes("|")
      ? ogTitle.split("|").map(norm)
      : ["", ""];

    const position =
      norm(posting?.title) ||
      ogPosition ||
      // The details tab is always the FIRST tabpanel (kept mounted,
      // hidden, on the form tab).
      norm(root.querySelector('[role="tabpanel"] h1, h1')?.textContent) ||
      null;

    const company =
      norm(posting?.hiringOrganization?.name) ||
      metaContent(root, 'meta[property="og:site_name"]') ||
      norm(ogCompanyPart.replace(/\s+Careers$/i, "")) ||
      norm(norm(root.title).match(/^Careers at (.+)$/i)?.[1]) ||
      null;

    const tabPanelElement = root.querySelector('[role="tabpanel"]');
    const description =
      htmlFragmentToText(posting?.description) ||
      (tabPanelElement ? (tabPanelElement.innerText || tabPanelElement.textContent || "").trim() : "") ||
      null;

    // Company-less rule (2026-10-01): position is the only mandatory
    // identity field; `company: null` = "this page names no employer"
    // (jobcore accepts it).
    if (!position || !description) return null;

    return { title: position, company: company || null, description };
  }

  window.ProactiveJobDetect.parser(function parserFunc() {
    return parseKulaJob(document);
  });
})();
