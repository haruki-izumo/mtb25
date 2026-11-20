/* =====================================================================
 * ProActive — passive job detection push
 * =====================================================================
 * Runs as a content script on every http(s) page (after job-fit.js, which
 * it shares an isolated world with). When the page looks like a job
 * posting, it extracts the listing with window.ProactiveJobFit and pushes
 * it to the side panel (see sidepanel.js's AUTOFILL_PAGE_CHANGED-style
 * "jd-detected" listener / applyDetectionResult) so Company/Role/Job
 * Description auto-fill without the user ever clicking Detect.
 *
 * There used to also be an in-page floating "Good fit / Check / Likely
 * skip" badge rendered here — removed. The fit warning is now the side
 * panel's own modal (openFitWarningModal in sidepanel.js), so nothing
 * needs to render on the page itself any more; this file is now purely
 * passive extraction + push, no UI of its own.
 * ===================================================================== */
(function () {
  "use strict";

  if (window.__proactiveDetectLoaded) return;
  window.__proactiveDetectLoaded = true;

  // True when this content script is running inside an iframe rather
  // than the top document. ATS embed widgets (Greenhouse, Workday,
  // etc.) frequently inject the JD into a cross-origin iframe — the
  // top frame can't read into it, so the iframe runs the extractor and
  // postMessage's the result up to the parent (see below).
  const IS_IFRAME = window.top !== window;

  // ATS / job-board host fragments. Matched against the hostname.
  const KNOWN_JOB_HOSTS = [
    "linkedin.com", "indeed.com", "lever.co", "greenhouse.io", "ashbyhq.com",
    "workable.com", "wellfound.com", "angel.co", "smartrecruiters.com",
    "hirehive.com", "workdayjobs.com", "myworkdayjobs.com", "bamboohr.com",
    "join.com", "zohorecruit", "teamtailor.com", "recruitee.com", "personio",
    "jobvite.com", "icims.com", "taleo.net", "successfactors", "breezy.hr",
    "traffit.com",
    "jobs.", "careers.", "apply.",
  ];

  // URL path fragments that strongly imply a job posting even on a host we
  // don't recognise (e.g. a company's own /careers/ or /jobs/ route).
  const JOB_PATH_HINTS = ["/jobs/", "/job/", "/careers/", "/career/", "/vacancy/", "/vacancies/", "/positions/", "/opening"];

  let lastUrl = "";
  let lastSentKey = ""; // dedupe pushes (url|title|desc-len)

  function looksLikeJobPage(result) {
    if (!result) return false;
    if (result.source === "json-ld") return true; // JSON-LD JobPosting = high confidence
    const h = location.hostname;
    const path = location.pathname.toLowerCase();
    const onJobHost = KNOWN_JOB_HOSTS.some((k) => h.includes(k));
    const onJobPath = JOB_PATH_HINTS.some((k) => path.includes(k));
    // ?gh_jid=... is the Greenhouse Job Board embed marker — companies
    // (8am.com, etc.) host the JD on their own careers route via the GH
    // widget. The URL alone is a high-confidence signal it's a JD page.
    let ghEmbed = false;
    try {
      const u = new URL(location.href);
      ghEmbed = u.searchParams.has("gh_jid") || u.searchParams.has("gh_src");
    } catch { /* ignore */ }
    const hasBody = (result.description || "").length > 400;
    // Either a known ATS host, a job-ish URL path, OR a Greenhouse
    // embed — plus a real title + a non-trivial body.
    return (onJobHost || onJobPath || ghEmbed) && hasBody && !!result.title;
  }

  let timer = null;
  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  }

  // ─── Parent-frame listener: receive JD extractions from child iframes
  // (ATS embeds — Greenhouse, Workday, etc.) and stash the latest one on
  // the window so job-fit.js's extractFromDocument can fall back to it
  // when the top-frame DOM doesn't contain the JD. Origin must look
  // like a real ATS host — otherwise any embedded ad iframe could push
  // a forged "JD" into the page. Setting the global also re-schedules
  // the next detection pass so it picks up the new data.
  if (!IS_IFRAME) {
    window.addEventListener("message", (event) => {
      const msg = event && event.data;
      if (!msg || msg.__proactive !== true || msg.type !== "jd-extracted") return;
      if (!msg.payload || !msg.payload.title) return;
      let originHost = "";
      try { originHost = new URL(event.origin).hostname || ""; } catch { return; }
      if (!originHost) return;
      const trusted = KNOWN_JOB_HOSTS.some((k) => originHost.includes(k));
      if (!trusted) return;
      // Expose to extractFromDocument and re-run detection soon.
      window.__proactiveFrameJd = {
        result: msg.payload,
        originUrl: msg.url || event.origin,
        originHost,
      };
      schedule(80);
    });
  }

  async function run() {
    if (!window.ProactiveJobFit) return;
    if (document.visibilityState === "hidden") return;

    let result;
    try {
      result = window.ProactiveJobFit.extractFromDocument();
    } catch {
      return;
    }

    // Job-posting metadata (location/work-model/employment type/experience
    // level/salary/posted/expiration — job-detect/extractors/structured/
    // jobmeta.js). Attached here rather than threaded through job-fit.js's
    // own extraction (3 separate return paths, each already tuned for
    // title/company/description provenance) — this frame's own document
    // first, falling back to whatever a child iframe already bubbled up
    // (common: an ATS embed where the PARENT page has no JSON-LD of its
    // own but the iframe it's hosting does) when this frame's own pass
    // comes up empty.
    //
    // Sync pass only here — extractSync() is pure JSON-LD/DOM, no network,
    // so it can't delay the push below. The async pass (Greenhouse's
    // boards-api, only reached when the sync pass came up short on
    // location/posted) runs AFTER the push, as a follow-up (see bottom of
    // this function) — otherwise company/role/description/location/salary
    // all sit waiting on that one slow network field for no reason
    // (confirmed real complaint: they showed up only after the user
    // manually re-clicked Detect).
    let childMeta = null;
    try {
      if (result && window.ProactiveJobMeta) {
        const ownMeta = window.ProactiveJobMeta.extractSync(document, result);
        const hasAny = ownMeta && Object.values(ownMeta).some(Boolean);
        childMeta = !IS_IFRAME && window.__proactiveFrameJd && window.__proactiveFrameJd.result && window.__proactiveFrameJd.result.meta;
        result.meta = hasAny ? ownMeta : childMeta || ownMeta;
      }
    } catch {
      /* best-effort — proceed without meta */
    }

    // ─── iframe path: bubble the result up to the parent, never push from
    // here directly — the top frame owns the one detection pass per page.
    if (IS_IFRAME) {
      try {
        if (result && (result.description || "").length > 200 && result.title) {
          window.top.postMessage(
            { __proactive: true, type: "jd-extracted", payload: result, url: location.href },
            "*",
          );
        }
      } catch { /* opaque parent (sandbox=opaque-origin etc.) — ignore */ }
      return;
    }

    const isJob = looksLikeJobPage(result);

    // Push the detection to the side panel for auto-fill — deduped per
    // url|title|desc-len so re-checks on the same posting don't spam the
    // panel. The panel decides whether to actually fill (smart-refresh:
    // never clobbers edited/generated fields) and whether the job is a
    // good fit (its own openFitWarningModal, not anything rendered here).
    if (isJob && result.title) {
      const key = `${location.href}|${result.title}|${(result.description || "").length}`;
      if (key !== lastSentKey) {
        lastSentKey = key;
        try {
          chrome.runtime?.sendMessage?.(
            { __proactive: true, type: "jd-detected", url: location.href, result },
            // Callback swallows "Receiving end does not exist" when the panel
            // is closed — that's the normal case, not an error.
            () => { void chrome.runtime?.lastError; },
          );
        } catch { /* extension context invalidated — ignore */ }

        // Async follow-up: only reached when the sync pass above left
        // location/posted empty (extract()'s own gate). Sent as a SEPARATE
        // message once ready rather than gated behind lastSentKey — this is
        // an intentional one-time enrichment of the push that already went
        // out, not a duplicate re-check to dedupe away.
        (async () => {
          try {
            if (!window.ProactiveJobMeta) return;
            const ownMeta = await window.ProactiveJobMeta.extract(document, result);
            const hasAny = ownMeta && Object.values(ownMeta).some(Boolean);
            const meta = hasAny ? ownMeta : childMeta || ownMeta;
            if (JSON.stringify(meta) === JSON.stringify(result.meta)) return;
            result.meta = meta;
            if (meta.company) result.company = meta.company;
            chrome.runtime?.sendMessage?.(
              { __proactive: true, type: "jd-detected", url: location.href, result },
              () => { void chrome.runtime?.lastError; },
            );
          } catch {
            /* best-effort — the sync pass already sent */
          }
        })();
      }
    }
  }

  // ---- SPA navigation: re-check when the URL changes ----
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      schedule(700); // let the new view render first
    }
  }, 1200);

  // ---- Late-rendered content: re-check on DOM mutations too, not just a
  // URL change ----
  // Plenty of ATSes render the JD asynchronously (spinner -> XHR -> React
  // render) WITHOUT ever touching the URL — the interval above only
  // catches a navigation, so a page like that got exactly one extraction
  // pass at document_idle, often before the real content existed yet, and
  // then never looked again. Debounced the same way the URL poll already
  // waits for the new view to render (just shorter, since a mutation is a
  // much more specific signal that something actually changed than a
  // fixed-delay guess) — run()'s own lastSentKey dedup still gates the
  // actual chrome.runtime push, so a burst of unrelated mutations (a
  // typing cursor, a live chat widget, an ad refreshing) just re-extracts
  // a few extra times harmlessly instead of spamming the side panel.
  let mutationDebounce = null;
  try {
    new MutationObserver(() => {
      clearTimeout(mutationDebounce);
      mutationDebounce = setTimeout(() => schedule(0), 250);
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  } catch { /* MutationObserver unavailable in some odd embedded context — the
                existing triggers below still cover the common case */ }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") schedule(300);
  });

  if (document.readyState === "complete" || document.readyState === "interactive") {
    schedule(600);
  } else {
    window.addEventListener("DOMContentLoaded", () => schedule(600));
  }
})();
