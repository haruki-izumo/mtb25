/* =====================================================================
 * normalize/html.js — HTML fragment → plain text (needs a Document)
 * =====================================================================
 * parseToText strips script/style/etc nodes before reading text (ATS job
 * descriptions routinely embed tracking scripts in the description HTML,
 * whose source would otherwise leak into the JD). htmlToText decodes
 * double-encoded HTML in a bounded loop, then strips any tag-like
 * residue. Copied VERBATIM from job-fit.js, with an optional `doc`
 * argument (defaults to the global document) so it is unit-testable
 * against a jsdom document.
 *
 * Depends on normalize/text.js (stripTagLikeText, looksLikeMarkup) —
 * resolved from the window namespace in-page, or require() in node.
 * Dual export.
 * ===================================================================== */
(function () {
  "use strict";

  const T =
    (typeof window !== "undefined" &&
      window.ProactiveJobDetect &&
      window.ProactiveJobDetect.normalize &&
      window.ProactiveJobDetect.normalize.text) ||
    (typeof require !== "undefined" ? require("./text.js") : null);
  const stripTagLikeText = (T && T.stripTagLikeText) || ((s) => String(s == null ? "" : s));
  const looksLikeMarkup = (T && T.looksLikeMarkup) || (() => false);

  const parseToText = (h, doc) => {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d) return "";
    const div = d.createElement("div");
    div.innerHTML = h;
    div
      .querySelectorAll("script, style, noscript, template, svg, iframe, link, meta, head")
      .forEach((el) => el.remove());
    return div.textContent || "";
  };

  const htmlToText = (html, doc) => {
    if (!html) return "";
    let text = parseToText(html, doc);
    for (let i = 0; i < 8 && looksLikeMarkup(text); i++) {
      const next = parseToText(text, doc);
      if (next === text) break;
      text = next;
    }
    text = stripTagLikeText(text);
    return text.replace(/\n{3,}/g, "\n\n").trim();
  };

  const api = { parseToText, htmlToText };
  if (typeof window !== "undefined" && window.ProactiveJobDetect) {
    window.ProactiveJobDetect.normalize.html = api;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
