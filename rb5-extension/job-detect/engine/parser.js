// Shared per-site detection engine — ported from BidHub's own
// packages/job-parsers/content/platforms/parser.js (the exact algorithm:
// MutationObserver + 250ms debounce + popstate/hashchange + a 500ms
// location.href poll for pushState/replaceState SPA navigation that fires
// no event, deduped by JSON.stringify so a re-render that didn't actually
// change the extracted data never re-sends). Every per-site detect file
// (job-detect/sites/*.js) calls ProactiveJobDetect.parser(extractFn) —
// this is the ONE place that algorithm lives, not copy-pasted per site.
//
// Message transport is Big Banana's own, not BidHub's: BidHub relays
// through background.js because it has no persistent page of its own (a
// panel is injected fresh into every tab). Big Banana's side panel IS a
// persistent extension page and already listens for
// chrome.runtime.sendMessage({__proactive:true, type:"jd-detected", ...})
// directly (see content-detect.js) — the detection ALGORITHM here is
// ported exactly; the wire format just matches what sidepanel.js already
// expects, so this doesn't need a new background-relay subsystem to work.
(function () {
  "use strict";
  const NS = (window.ProactiveJobDetect = window.ProactiveJobDetect || {});

  function waitForDocumentReady() {
    return new Promise((resolve) => {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", resolve, { once: true });
      } else {
        resolve();
      }
    });
  }

  function isSameData(newData, oldData) {
    if (!oldData) return false;
    try {
      return JSON.stringify(newData) === JSON.stringify(oldData);
    } catch {
      return false;
    }
  }

  function sendJdDetected(data) {
    try {
      chrome.runtime
        .sendMessage({
          __proactive: true,
          type: "jd-detected",
          url: location.href,
          result: data,
        })
        .catch(() => {});
    } catch {
      /* no listener yet (panel not open) — fine, next mutation retries */
    }
  }

  // Default transport — matches content-detect.js's own push shape so a
  // per-site parser result reaches sidepanel.js the same way the generic
  // fallback detector's result already does.
  //
  // `.meta` (location/work-model/employment type/experience level/salary/
  // posted/expiration — see job-detect/extractors/structured/jobmeta.js)
  // is attached HERE rather than in each individual job-detect/sites/*.js
  // file — this is the one shared choke point every ported site's parser
  // result already flows through before being sent, so every site gets it
  // for free. Best-effort: never let a metadata-extraction hiccup block
  // the title/company/description push, which is the one thing Generate
  // actually depends on.
  //
  // Sent in two stages. jobmeta.js's extractSync() is pure JSON-LD/DOM, no
  // network — sent immediately so company/role/description/location/salary
  // never wait on anything. extract() additionally hits Greenhouse's
  // boards-api (relayed through background.js) for `posted` (and, rarely,
  // location/company) when the sync pass came up short on those — that
  // round-trip can take a few hundred ms, so a second, richer message
  // follows once it resolves instead of making the whole push wait on it
  // (confirmed real complaint: company/role showed immediately but
  // location/salary/posted stayed blank until the user manually re-clicked
  // Detect — this was that one slow field holding the rest hostage).
  async function defaultMessageSender(payload) {
    try {
      if (window.ProactiveJobMeta && payload.data && typeof payload.data === "object") {
        payload.data.meta = window.ProactiveJobMeta.extractSync(document, payload.data);
      }
    } catch {
      /* best-effort — proceed without meta */
    }
    sendJdDetected(payload.data);

    try {
      if (window.ProactiveJobMeta && payload.data && typeof payload.data === "object") {
        const meta = await window.ProactiveJobMeta.extract(document, payload.data);
        const changed = JSON.stringify(meta) !== JSON.stringify(payload.data.meta);
        payload.data.meta = meta;
        // Greenhouse's own authoritative employer name beats this site's
        // own DOM-guess company resolution when it found one (see
        // jobmeta.js's own comment on this field for the confirmed real
        // case — "Xai" guessed from a URL slug vs. the real "SpaceXSI").
        if (meta.company) payload.data.company = meta.company;
        if (changed) sendJdDetected(payload.data);
      }
    } catch {
      /* best-effort — the sync pass already sent */
    }
  }

  let observingElement = null;

  function executeWithMutationObserver(parserFunc, resetUrlCallback, debounceMs, sendMessage) {
    let observer = null;
    let debounceTimeoutId = null;
    let currentUrl = window.location.href;

    const run = () => {
      try {
        const parseResult = parserFunc();
        if (parseResult === null) return;
        sendMessage(parseResult);
      } catch {
        // Don't spam on every failed attempt — a mutation mid-render is
        // expected to parse incompletely sometimes; the next debounced
        // run picks it up once the DOM settles.
      }
    };

    const debouncedRun = () => {
      if (debounceTimeoutId) clearTimeout(debounceTimeoutId);
      debounceTimeoutId = setTimeout(run, debounceMs);
    };

    const handleUrlChange = () => {
      const newUrl = window.location.href;
      if (newUrl !== currentUrl) {
        currentUrl = newUrl;
        resetUrlCallback?.();
        debouncedRun();
      }
    };

    try {
      observer = new MutationObserver(() => {
        if (document.documentElement !== observingElement) {
          observingElement = document.documentElement;
          observer.disconnect();
          observer.observe(observingElement, {
            childList: true,
            attributes: true,
            characterData: true,
            subtree: true,
          });
        }
        debouncedRun();
      });
      debouncedRun();
      observingElement = document.documentElement;
      observer.observe(document.documentElement, {
        childList: true,
        attributes: true,
        characterData: true,
        subtree: true,
      });

      window.addEventListener("popstate", handleUrlChange);
      window.addEventListener("hashchange", handleUrlChange);
      // pushState/replaceState fire no event at all — this is what catches
      // SPA route changes neither popstate nor hashchange would.
      setInterval(handleUrlChange, 500);
    } catch {
      /* a page that blocks MutationObserver construction (rare, some CSP
         sandboxes) just never re-parses after the first run */
    }
  }

  // parserFunc: () => partial job-data object | null. messageType carried
  // through so a future per-type background listener can tell results
  // apart without inspecting shape (unused by sidepanel.js today, kept for
  // parity with BidHub's own signature).
  // Lets sidepanel.js's own "pull" paths (the manual Detect button, and
  // the silent auto-detect that runs on panel open/tab switch — see
  // detectJobFromActiveTab in sidepanel.js) get an IMMEDIATE, synchronous
  // read from this exact same per-site parser, instead of falling back to
  // the much weaker generic DOM/adapter scrape in job-fit.js. Before this,
  // the only way a per-site parser's result ever reached the panel was
  // this file's own passive push (chrome.runtime.sendMessage below) —
  // which silently drops (caught, no retry) if the panel wasn't open yet
  // to receive it, and only re-fires on the next DOM mutation or SPA nav.
  // On a page whose React app renders once and goes idle (e.g. Ashby),
  // that could mean no further attempt EVER happens until something
  // (another mutation, a fresh navigation) coincidentally fires one —
  // confirmed real complaint: BidHub detected an Ashby posting correctly
  // on first load, Big Banana needed several manual Detect clicks for the
  // identical URL, because Detect never actually ran this parser at all.
  NS.runNow = function runNow() {
    try {
      return NS._parserFunc ? NS._parserFunc() : null;
    } catch {
      return null;
    }
  };

  NS.parser = async function parser(
    parserFunc,
    messageType = "autoParserResultFound",
    debounceMs = 250,
    sendMessage = defaultMessageSender
  ) {
    NS._parserFunc = parserFunc;
    // Idempotent: sidepanel.js's pull path re-injects this same site file
    // on demand (to call runNow() above) — re-running the file's IIFE
    // must update _parserFunc (so runNow reflects it) WITHOUT stacking a
    // second MutationObserver/popstate/setInterval loop on top of the one
    // the page's own passive content-script injection already started.
    if (NS._observing) return;
    NS._observing = true;
    await waitForDocumentReady();
    let lastResult = null;
    let lastUrl = window.location.href;
    const resetUrl = () => {
      lastUrl = null;
    };
    executeWithMutationObserver(
      () => {
        const response = parserFunc();
        if (isSameData(response, lastResult) && window.location.href === lastUrl) return null;
        lastResult = response;
        lastUrl = window.location.href;
        return { message_type: messageType, data: response };
      },
      resetUrl,
      debounceMs,
      sendMessage
    );
  };
})();
