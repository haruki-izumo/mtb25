/* =====================================================================
 * normalize/text.js — pure text utilities (no DOM)
 * =====================================================================
 * Tag/entity detection and the share/meta line scrub used to clean a
 * job description before it reaches the panel. Copied VERBATIM from
 * job-fit.js so there is zero logic divergence during the migration;
 * once job-detect is wired in, job-fit.js will consume these instead of
 * keeping its own copies. Pure string functions — exhaustively
 * unit-testable without a DOM (see test/text.test.js).
 *
 * Dual export: attaches to the window namespace for the in-page library
 * AND module.exports for node tests.
 * ===================================================================== */
(function () {
  "use strict";

  // Strip anything that looks like an HTML tag from plain text.
  const stripTagLikeText = (text) =>
    String(text || "").replace(/<\/?[a-zA-Z][a-zA-Z0-9-]{0,40}(?:\s[^>]{0,200})?>/g, "");

  // True when the text still contains markup (a tag) or an HTML entity —
  // used to decide whether another decode pass is needed.
  const looksLikeMarkup = (text) =>
    /<\/?[a-zA-Z]|&(?:[a-zA-Z]{2,8}|#\d{2,5}|#x[0-9a-fA-F]{2,5});/.test(text);

  // Drop standalone social-share affordance lines and meta-rail lines
  // (ID:/Published on:/Apply/Back to jobs/Powered by …) that survive the
  // DOM-level strip — e.g. a share rendered as a link with visible text,
  // or the TTC Portals "share to twitter" / "share to linkedin" rows.
  const stripShareLines = (txt) => {
    if (!txt) return txt;
    // Matches social-share affordance lines: "Share", "Share:",
    // "share by facebook", and the TTC Portals form "share to twitter"
    // / "share to linkedin" (the " to "/" on " connector was missing,
    // so those slipped into the JD body).
    const SHARE_LINE = /^\s*(share(\s*[:\-–•]|\s+(?:by|via|to|on)\s+)?\s*(facebook|fb|linkedin|in|twitter|x|whatsapp|wa|email|mail|copy(\s*link)?|link)?\s*)$/i;
    const META_LINE = /^\s*((job\s*)?id\s*[:#]\s*\S+|published\s*(on)?\s*[:\-]?\s*.+|posted\s*(on)?\s*[:\-]?\s*.+|apply(\s+(now|here|today|for\s+this\s+(job|role|position)))?|back\s+to\s+(jobs|listings|all\s+jobs)|view\s+(all\s+)?jobs?|powered\s+by\s+.+)\s*$/i;
    return txt
      .split("\n")
      .filter((l) => !SHARE_LINE.test(l) && !META_LINE.test(l))
      .join("\n");
  };

  const api = { stripTagLikeText, looksLikeMarkup, stripShareLines };
  if (typeof window !== "undefined" && window.ProactiveJobDetect) {
    window.ProactiveJobDetect.normalize.text = api;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
