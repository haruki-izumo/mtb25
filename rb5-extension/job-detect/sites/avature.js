/* =====================================================================
 * job-detect/sites/avature.js — Avature career sites
 * (<tenant>.avature.net/careers/...). Ported from BidHub's own
 * packages/job-parsers/content/platforms/avature/index.js.
 * ===================================================================== */
(function () {
  "use strict";

  function parserFunc() {
    function norm(value) {
      return String(value ?? "").replace(/\s+/g, " ").trim();
    }

    // Avature career sites live at <tenant>.avature.net/careers/JobDetail/<id>
    // (a single posting) or /careers/FolderDetail/<id>/ (a folder/posting
    // group). The posting title renders in `.banner__text__title`; the rich
    // description sits in
    // `.article__content__view__field.description--rich-text`. We fall back
    // to the document title ("<Position> - - <id> - <Company>") when the
    // markup differs between tenants.
    let position = norm(document.querySelector(".banner__text__title")?.textContent);
    let company = null;
    const host = window.location.hostname.split(".")[0];
    if (host && host !== "www") {
      company = host.charAt(0).toUpperCase() + host.slice(1);
    }

    // Title fallback: "Senior Software Engineer: Scala - - 17162 - UCLA Health".
    if (!position) {
      const titleParts = document.title.split(" - ").map(norm).filter(Boolean);
      if (titleParts.length) {
        position = titleParts[0];
        const last = titleParts[titleParts.length - 1];
        if (last && !/^\d+$/.test(last)) company = last;
      }
    }
    if (!position) return null;

    const descriptionElement =
      document.querySelector(".article__content__view__field.description--rich-text") ||
      document.querySelector(".description--rich-text");

    return {
      title: position,
      company,
      description: descriptionElement
        ? (descriptionElement.innerText || descriptionElement.textContent || "").trim()
        : null,
    };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
