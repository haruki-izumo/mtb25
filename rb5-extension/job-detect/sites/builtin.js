// job-detect/sites/builtin.js — Built In job-posting pages
// (builtin.com/job/<category>/<slug>/<id> — NOT the /apply/job/ Easy Apply
// form, which has no title/company/description markup of its own; see
// autofill/sites/builtin-autofill.js for that page). Ported from BidHub's
// own packages/job-parsers/content/platforms/builtin/index.js.
(function () {
  "use strict";

  // First non-empty line of an element's text — Built In's h1/h2 both
  // render the real heading on its own line followed by blank
  // whitespace-only lines from the template, so a plain .textContent.trim()
  // would still be correct here but BidHub's own extraction takes the
  // first non-blank line defensively (a server-rendered SVG/badge sibling
  // text node inside the same heading would otherwise leak in).
  function firstNonEmptyLine(element) {
    if (!element) return null;
    const line = (element.textContent || "").split("\n").find((candidate) => candidate.trim().length > 0);
    return line ? line.trim() : null;
  }

  function parserFunc() {
    // Everything (title, company, metadata facts, body) lives inside this
    // one wrapper on the posting page; its absence is also how this
    // parser tells the posting page apart from the Easy Apply form page,
    // which has no job-post-item at all.
    const containerElement = document.querySelector("div.job-post-item");
    if (!containerElement) return null;

    const position = firstNonEmptyLine(containerElement.querySelector("h1"));
    const company = firstNonEmptyLine(containerElement.querySelector("h2"));

    // Position is the only mandatory identity field — company: null just
    // means "this page names no employer" and jobcore accepts it (same
    // company-less rule the other adapters use).
    if (!position) return null;

    // The facts strip (location/remote/salary chips) sits in
    // div.match-background right above the actual body
    // ([id*="job-post-body"]); the body node's PARENT carries the real
    // description wrapper (headings/padding Built In applies around the
    // raw body), and an optional sibling right after it renders the
    // extracted "Skills" chip list. Both only exist together — a page
    // still finishing its hydration can have the heading but not yet the
    // body, so description is left null rather than half-built.
    const metadataElement = containerElement.querySelector("div.match-background");
    const jdElement = containerElement.querySelector('[id*="job-post-body"]');
    let jobDescription = null;
    if (metadataElement && jdElement) {
      const jdContainer = jdElement.parentElement;
      const skillContainer = jdElement.nextElementSibling;
      const textOf = (el) => (el.innerText || el.textContent || "").trim();
      jobDescription = `${textOf(metadataElement)}\n${textOf(jdContainer)}`;
      if (skillContainer) jobDescription += `\n${textOf(skillContainer)}`;
    }

    return {
      title: position,
      company: company || null,
      description: jobDescription,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
