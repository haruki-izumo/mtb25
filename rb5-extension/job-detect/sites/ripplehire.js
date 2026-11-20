/* =====================================================================
 * job-detect/sites/ripplehire.js — RippleHire ATS
 * (<tenant>.ripplehire.com/candidate/?token=<T>#detail/job/<seq>).
 * =====================================================================
 * Ported from BidHub's own
 * packages/job-parsers/content/platforms/ripplehire/index.js —
 * detection only.
 *
 * A Backbone hash router renders everything into ONE document:
 * #detail/job/<seq> is the posting (title, description, skills,
 * compensation), #apply/job/<seq> the application (only "You are
 * applying for <title>" plus the form). The shared parser() re-runs on
 * hashchange / mutations, so this file lives across both routes. On the
 * posting the DOM is parsed directly; on the apply route (no
 * description in the DOM) the same JSON the page itself loads — GET
 * /candidate/candidatejobdetail?token=<T>&jobSeq=<seq>&lang=en — is
 * fetched once per job and cached, and its arrival is signalled through
 * an attribute write on <html> so the engine's MutationObserver re-runs
 * the (synchronous) parse and emits the cached job. Verified live on
 * the UST tenant 2026-09-30: the API needs the XHR headers (else it
 * answers XML) and, on most tenants, the ?token= from the page url.
 * ===================================================================== */
(function () {
  "use strict";

  const ROUTE_PATTERN = /^#(detail|apply)\/job\/(\d+)(?:\/|$)/i;
  const DETAIL_ATTRIBUTE = "data-bidhub-ripplehire-jd";
  const XHR_HEADERS = { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" };
  // <title> shapes: posting "Apply for <Company> - <Title> - RippleHire.com",
  // application "Application for <Title> at <Company> - RippleHire.com".
  const DETAIL_TITLE = /^Apply for (.+?) - .+ - RippleHire\.com$/i;
  const APPLY_TITLE = /^Application for .+ at (.+?) - RippleHire\.com$/i;
  const CAREERS_TITLE = /^Careers at (.+)$/i;

  function norm(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  // jobDesc/jobSkills are raw HTML strings (whether read as a live
  // element's .innerHTML below, or straight out of the candidatejobdetail
  // JSON), not live DOM elements, so innerText/textContent can't reach
  // them directly: parse into a detached <div> and read its textContent
  // back out. This feeds a plain-text textarea (#jobText), which can
  // never render markup.
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

  // jobSeq → { status: 'pending' | 'ready' | 'error', job, promise }
  const detailCache = new Map();

  function getRippleHireRoute(hash = window.location.hash) {
    const match = String(hash || "").match(ROUTE_PATTERN);
    return match ? { kind: match[1].toLowerCase(), jobSeq: match[2] } : { kind: null, jobSeq: null };
  }

  // One plain-text body for both sources: the description, then the
  // skills and the compensation range under their own labels when the
  // tenant filled them (the posting renders them the same way). jobDesc
  // and jobSkills arrive as raw HTML strings either way (a live element's
  // .innerHTML below, or straight out of the JSON), so they're run through
  // htmlFragmentToText rather than embedded as markup.
  function composeDescription({ jobDesc, jobSkills, compensationRange } = {}) {
    const parts = [];
    const descText = htmlFragmentToText(jobDesc);
    if (descText) parts.push(descText);
    const skillsText = htmlFragmentToText(jobSkills);
    if (skillsText) parts.push(`Skills\n${skillsText}`);
    if (norm(compensationRange)) parts.push(`Compensation\n${norm(compensationRange)}`);
    return parts.length ? parts.join("\n\n") : null;
  }

  function companyFromDocument(root) {
    const careers = norm(root.querySelector("h1.careers_text")?.textContent);
    const fromCareers = norm(careers.match(CAREERS_TITLE)?.[1]);
    if (fromCareers) return fromCareers;
    const title = norm(root.title);
    return norm(title.match(DETAIL_TITLE)?.[1]) || norm(title.match(APPLY_TITLE)?.[1]) || null;
  }

  // The rendered posting (#detail/job/<seq>): `.section-title h2` is the
  // title, `p.description` / `p.skills` / `p.compensationRange` hold the
  // HTML the JSON carries. The enableLink === "N" `.alert-warning` ("This
  // job opportunity is no longer available.") does not block the parse —
  // expiry is the page-state config's call, the posting text is still
  // the posting.
  function parseRippleHireDom(root = document) {
    const description = root.querySelector("p.description");
    if (!description || !norm(description.textContent)) return null;
    const position =
      Array.from(root.querySelectorAll(".section-title h2"))
        .map((node) => norm(node.textContent))
        .find(Boolean) || null;
    const company = companyFromDocument(root);
    const html = composeDescription({
      jobDesc: description.innerHTML,
      jobSkills: root.querySelector("p.skills")?.innerHTML,
      compensationRange: root.querySelector("p.compensationRange")?.textContent,
    });
    // Company-less rule (2026-10-01): position is the only mandatory
    // identity field; `company: null` = "this page names no employer"
    // (jobcore accepts it).
    if (!position || !html) return null;
    return { title: position, company: company || null, description: html };
  }

  // candidatejobdetail payload → job, or null when it carries no posting.
  function jobFromDetailJson(json) {
    const jobVO = json?.jobVO;
    if (!jobVO || typeof jobVO !== "object") return null;
    const position = norm(jobVO.jobTitle);
    const company = norm(json?.companyVO?.companyName);
    const description = composeDescription(jobVO);
    if (!position || !description) return null;
    return { title: position, company: company || null, description };
  }

  function detailUrl(jobSeq) {
    const params = new URLSearchParams();
    const token = new URLSearchParams(window.location.search).get("token");
    if (token) params.set("token", token);
    params.set("jobSeq", jobSeq);
    params.set("lang", "en");
    return `${window.location.origin}/candidate/candidatejobdetail?${params.toString()}`;
  }

  // Fetch the posting JSON once per jobSeq (same origin, the page's own
  // endpoint). Success caches the job and pokes <html> so the observing
  // parser re-runs; any failure is cached as an error so a dead or
  // token-gated job never turns into a request storm.
  function requestJobDetail(jobSeq) {
    if (!jobSeq || detailCache.has(jobSeq)) return detailCache.get(jobSeq)?.promise;
    const entry = { status: "pending", job: null, promise: null };
    detailCache.set(jobSeq, entry);
    entry.promise = (async () => {
      try {
        const response = await fetch(detailUrl(jobSeq), { credentials: "same-origin", headers: XHR_HEADERS });
        if (!response.ok) throw new Error(`candidatejobdetail ${response.status}`);
        const job = jobFromDetailJson(await response.json());
        if (!job) throw new Error("candidatejobdetail: no posting in payload");
        entry.status = "ready";
        entry.job = job;
        document.documentElement.setAttribute(DETAIL_ATTRIBUTE, jobSeq);
      } catch {
        entry.status = "error";
      }
    })();
    return entry.promise;
  }

  // Synchronous by contract (the shared parser() JSON-stringifies the
  // return value — a Promise would serialise as {}): cached JSON first,
  // then the rendered posting, else kick the fetch and report nothing yet.
  function parseRippleHireJob(root = document, { hash = window.location.hash, requestDetail = requestJobDetail } = {}) {
    const { jobSeq } = getRippleHireRoute(hash);
    if (!jobSeq) return null;
    const cached = detailCache.get(jobSeq);
    if (cached?.status === "ready") return cached.job;
    const fromDom = parseRippleHireDom(root);
    if (fromDom) return fromDom;
    if (!cached) requestDetail(jobSeq);
    return null;
  }

  window.ProactiveJobDetect.parser(function parserFunc() {
    return parseRippleHireJob(document);
  });
})();
