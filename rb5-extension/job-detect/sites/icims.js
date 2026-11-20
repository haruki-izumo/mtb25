/* =====================================================================
 * job-detect/sites/icims.js — iCIMS job-posting pages (*.icims.com).
 * =====================================================================
 * Ported from BidHub Copilot's own
 * packages/job-parsers/content/platforms/icims/index.js — the exact
 * selectors and null-guards, just re-homed onto the shared
 * window.ProactiveJobDetect.parser() engine (job-detect/engine/parser.js)
 * instead of BidHub's own background-relay parser() wrapper.
 *
 * iCIMS themes its careersite per tenant (colors/layout vary wildly) but
 * keeps the posting title and job-description body behind its own
 * structural `.iCIMS_*` classes across every tenant, so those are read
 * by class rather than by guessing at tenant-specific layout.
 *
 * `company` is intentionally left null: iCIMS never puts the hiring
 * company's name in a stable structural element on this page (the
 * tenant's own branding is a logo <img> / the page <title>, not a
 * labeled DOM node) — BidHub's own adapter never resolved it either.
 * Left for whatever generic company fallback (title-split / og:site_name
 * / hostname) runs after the adapter pass.
 * ===================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveJobDetect?.parser) return;

  function parserFunc() {
    const titleElement = document.querySelector("h1.iCIMS_Header");
    const title = titleElement ? titleElement.textContent.trim() : "";
    if (!title) return null;

    // Only emit once the description body is actually present — mirrors
    // BidHub's own guard, which avoids pushing a half-rendered result
    // while the SPA is still mounting the job-content panel.
    const descriptionElement = document.querySelector("div.iCIMS_JobContent");
    const description = descriptionElement
      ? (descriptionElement.innerText || descriptionElement.textContent || "").trim()
      : "";
    if (!description) return null;

    return { title, company: null, description };
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
