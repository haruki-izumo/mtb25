/* =====================================================================
 * job-detect/sites/bamboohr.js — BambooHR careers pages
 * (<tenant>.bamboohr.com/careers/...).
 * =====================================================================
 * Ported from BidHub's packages/job-parsers/content/platforms/bamboohr/
 * index.js. BambooHR names the role and the employer in plain <meta>
 * tags — og:title is the job title, og:site_name is the tenant's
 * display name — so there's no DOM-structure guessing needed for those
 * two fields. The one quirk: BambooHR's own careers LANDING page (the
 * list of openings for a tenant, not a single posting) reuses the same
 * og:title "Current Openings" on every tenant, so that exact string is
 * explicitly rejected rather than reported as a job titled "Current
 * Openings".
 *
 * The description lives in two separate Fabric-generated blocks: the
 * long-form JD body (`.fabric-by6klc-root`) and a short metadata
 * strip above it — location / employment type / etc.
 * (`.fabric-5qovnk-root`). BidHub concatenates both so the metadata
 * isn't lost; Fabric's own hashed class names are unstable across
 * releases but have held across BambooHR's last several ships. =======
 * ===================================================================== */
(function () {
  "use strict";

  function parseBambooHrJob() {
    const titleEl = document.querySelector('meta[property="og:title"]');
    const title = titleEl?.getAttribute("content")?.trim() || null;
    const companyEl = document.querySelector('meta[property="og:site_name"]');
    const company = companyEl?.getAttribute("content")?.trim() || null;

    // The tenant's careers LANDING page (list of openings) carries this
    // exact og:title on every tenant — not a real posting.
    if (title === "Current Openings") return null;
    // Company-less rule: title is the only mandatory identity field;
    // company: null = "this page names no employer" (jobcore accepts it).
    if (!title) return null;

    const jdEl = document.querySelector(".fabric-by6klc-root");
    const jdText = jdEl ? (jdEl.innerText || jdEl.textContent || "").trim() : "";
    const metaEl = document.querySelector(".fabric-5qovnk-root");
    const metaText = metaEl ? (metaEl.innerText || metaEl.textContent || "").trim() : "";
    const description = [jdText, metaText].filter(Boolean).join("\n") || null;
    if (!description) return null;

    return { title, company: company || null, description };
  }

  window.ProactiveJobDetect.parser(parseBambooHrJob);
})();
