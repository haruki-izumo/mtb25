/* =====================================================================
 * job-detect/sites/gem.js — Gem job boards
 * (jobs.gem.com/<board>/<extId>[?jr_id=…]). Ported from BidHub's own
 * packages/job-parsers/content/platforms/gem/index.js.
 * =====================================================================
 * Gem boards are a client-rendered SPA. On a direct load the server HTML's
 * <title>/og:title carry the job TITLE (with a trailing space); after an
 * in-app board → posting navigation those same tags still describe the
 * BOARD ("Fetch Careers") because the SPA never rewrites them. The SPA
 * renders the posting AND the application form into one
 * `[class*="jobPostingContent"]` container, with the title inside it at
 * `[class*="jobPostingHeader"]`.
 *
 * The company name is nowhere in the document itself: the header shows it
 * only as a logo (alt="Company logo", not the actual name), "View all
 * jobs" links to /<board>, and the careers link is external. The one place
 * Gem gives up the real name is its own unauthenticated GraphQL —
 * jobBoardExternal(vanityUrlPath) { teamDisplayName } — the exact query
 * the public board page itself loads — so this fetches it once per board
 * slug (same origin), caches the result, and pokes a <html> attribute so
 * the parser's own MutationObserver re-runs the synchronous parse once the
 * answer lands. parser() JSON-stringifies whatever parserFunc returns, so
 * returning a half-resolved Promise would just serialize as "{}" — the
 * fetch has to run on the side, out of band from the synchronous parse.
 *
 * While the lookup is pending the parser reports nothing — a guessed
 * company must never reach the server; only once Gem answers null (or the
 * request fails) does the humanised board slug ("fetch" → "Fetch") stand
 * in, so the posting still parses with SOME company rather than none.
 * ===================================================================== */
(function () {
  "use strict";

  const GRAPHQL_PATH = "/api/public/graphql";
  const BOARD_QUERY =
    "query GemBoard($boardId: String!) { jobBoardExternal(vanityUrlPath: $boardId) { teamDisplayName } }";
  const BOARD_ATTRIBUTE = "data-bigbanana-gem-board";
  const DESCRIPTION_SELECTOR = '[class*="jobPostingContent"]';
  // The rendered posting title inside the container — the ONLY title
  // source that's right on BOTH navigation paths: on a direct load
  // document.title/og:title are the posting's title, but after an in-app
  // board → posting navigation they're still the BOARD's.
  const TITLE_SELECTOR = '[class*="jobPostingHeader"]';
  const OG_TITLE_SELECTOR = 'meta[property="og:title"]';
  // "<Company> Careers" / "Careers at <Company>" / "Jobs at <Company>" —
  // the board's own title, never a posting's.
  const CAREERS_TITLE = /^(?:careers?|jobs)(?:\s+at\s+.+)?$|\b(?:careers?|career\s+site|jobs)\s*$/i;
  // /<board>/<extId>: extId is the base64url node token the SPA reads from
  // the URL (long enough to exclude /<board>/jobs-style paths); a bare
  // /<board> is the listing, not a posting.
  const EXT_ID_PATTERN = /^[A-Za-z0-9_-]{16,}={0,2}$/;
  const RESERVED_SLUGS = new Set(["api"]);

  function norm(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function isBoardTitle(title) {
    const value = norm(title);
    return CAREERS_TITLE.test(value) && value.split(" ").length <= 6;
  }

  // board slug -> { status: 'pending' | 'ready' | 'error', company, promise }
  const boardCache = new Map();
  function __resetGemBoardCache() {
    boardCache.clear();
  }

  function getGemRoute(href = window.location.href) {
    let pathname;
    try {
      pathname = new URL(href).pathname;
    } catch {
      return { boardSlug: null, extId: null };
    }
    const parts = pathname
      .split("/")
      .filter(Boolean)
      .map((part) => {
        try {
          return decodeURIComponent(part);
        } catch {
          return part;
        }
      });
    const boardSlug = parts[0];
    const extId = parts[1];
    const rest = parts.slice(2);
    if (!boardSlug || RESERVED_SLUGS.has(boardSlug.toLowerCase())) return { boardSlug: null, extId: null };
    if (!extId || rest.length > 0 || !EXT_ID_PATTERN.test(extId)) return { boardSlug, extId: null };
    return { boardSlug, extId };
  }

  // "acme-inc" → "Acme Inc": the last-resort company when the board lookup
  // can't answer.
  function companyFromBoardSlug(boardSlug) {
    const words = norm(String(boardSlug ?? "").replace(/[-_]+/g, " "))
      .split(" ")
      .filter(Boolean);
    if (words.length === 0) return null;
    return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  }

  // Fetch the board's display name once per slug (same origin, the
  // board's own public GraphQL). Success caches the name and pokes <html>
  // so the observing parser re-runs; a null board or any failure is
  // cached as an error so a dead slug never turns into a request storm.
  function requestGemBoardCompany(boardSlug) {
    if (!boardSlug || boardCache.has(boardSlug)) return boardCache.get(boardSlug)?.promise;
    const entry = { status: "pending", company: null, promise: null };
    boardCache.set(boardSlug, entry);
    entry.promise = (async () => {
      try {
        const response = await fetch(`${window.location.origin}${GRAPHQL_PATH}`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ query: BOARD_QUERY, variables: { boardId: boardSlug } }),
        });
        if (!response.ok) throw new Error(`gem graphql ${response.status}`);
        const json = await response.json();
        const company = norm(json?.data?.jobBoardExternal?.teamDisplayName);
        if (!company) throw new Error("gem graphql: no board for slug");
        entry.status = "ready";
        entry.company = company;
      } catch {
        entry.status = "error";
      } finally {
        document.documentElement.setAttribute(BOARD_ATTRIBUTE, boardSlug);
      }
    })();
    return entry.promise;
  }

  // Synchronous by contract (parser() JSON-stringifies the return value —
  // a Promise would serialise as {}): null until the SPA has rendered the
  // posting AND the board lookup has settled.
  function parseGemJob(root = document, { href = window.location.href, requestBoard = requestGemBoardCompany } = {}) {
    const { boardSlug, extId } = getGemRoute(href);
    if (!boardSlug || !extId) return null;

    const descriptionElement = root.querySelector(DESCRIPTION_SELECTOR);
    const description = descriptionElement
      ? norm(descriptionElement.innerText || descriptionElement.textContent) || null
      : null;
    if (!description) return null;

    // Rendered header first, then the page title, then the meta tag — and
    // never a board-shaped title: a stale "<Company> Careers" means the
    // SPA hasn't finished rendering this posting yet, so report nothing
    // and let the next mutation re-run the parse.
    const position =
      [
        norm(descriptionElement.querySelector(TITLE_SELECTOR)?.textContent),
        norm(root.title),
        norm(root.querySelector(OG_TITLE_SELECTOR)?.getAttribute("content")),
      ].find((candidate) => candidate && !isBoardTitle(candidate)) || null;
    if (!position) return null;

    const cached = boardCache.get(boardSlug);
    if (!cached) {
      requestBoard(boardSlug);
      return null;
    }
    if (cached.status === "pending") return null;

    // Company-less rule: position is the only mandatory identity field —
    // `company: null` means "this page names no employer". The
    // board-slug fallback is kept deliberately, so company is null only
    // when even the slug yields nothing.
    const company = (cached.status === "ready" ? cached.company : companyFromBoardSlug(boardSlug)) || null;

    return { title: position, company, description };
  }

  function parserFunc() {
    return parseGemJob(document);
  }

  window.ProactiveJobDetect.parser(parserFunc);
})();
