// background.js (MV3)
// Per-tab persistent state in IndexedDB. One state per tab. No slots.

// ProActive's per-org custom-branding upload feature (a superadmin could
// upload their own toolbar mark) — BCD's backend has no /branding/version or
// /branding/logo.png equivalent. Left goproactive.org's real, still-live
// server pointed at here would keep fetching THEIR configured mark and
// silently overwriting the bundled icons/logo-*.png (now BCD's actual logo,
// see icons/) via chrome.action.setIcon on every install/startup — which is
// exactly what was happening. Disabled below rather than repointed, since
// there's no BCD equivalent to repoint it to yet.
const API_BASE_FOR_BRANDING = "https://goproactive.org/api";
const REMOTE_BRANDING_ENABLED = false;

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
  // Fresh install / update: pull the current mark. Failure is silent —
  // Chrome falls back to the bundled icons/logo-*.png declared in the
  // manifest so the toolbar is never blank.
  applyRemoteToolbarIcon().catch(() => {});
});

chrome.runtime.onStartup?.addListener(() => {
  // Browser restart: same story — re-check in case the superadmin
  // uploaded a new mark while this profile was closed.
  applyRemoteToolbarIcon().catch(() => {});
});

/**
 * Fetch every needed toolbar-icon size from the server and swap
 * chrome.action's icon in place. The manifest still ships bundled
 * icons/logo-16.png / logo-32.png / logo-48.png — those are what the
 * icon falls back to whenever this function fails (server down, no
 * custom branding uploaded, network offline).
 *
 * Runs in the MV3 service worker, so DOM APIs like <canvas> aren't
 * available. OffscreenCanvas + createImageBitmap give us the same
 * pixel manipulation, and chrome.action.setIcon accepts the
 * resulting ImageData directly (URL / path modes only work for
 * bundled extension files, not remote hosts).
 */
async function applyRemoteToolbarIcon() {
  if (!REMOTE_BRANDING_ENABLED) return; // see the constant's comment above
  // Cheap "did anything change?" check first — the server responds
  // with { version: 0 } when no custom branding has been uploaded,
  // and we treat any non-zero as "swap in the remote mark."
  const verRes = await fetch(`${API_BASE_FOR_BRANDING}/branding/version`);
  if (!verRes.ok) throw new Error(`version fetch: ${verRes.status}`);
  const { version } = await verRes.json();
  if (!version) return; // bundled default is fine
  // Skip re-doing this in the same MV3 session if we've already applied
  // this version. The service worker's memory is transient — this only
  // saves work while the worker stays warm.
  if (self.__lastAppliedBrandingVersion === version) return;

  const imageData = {};
  for (const size of [16, 32, 48]) {
    const url = `${API_BASE_FOR_BRANDING}/branding/logo.png?size=${size}&v=${version}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`icon fetch ${size}: ${res.status}`);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, size, size);
    imageData[String(size)] = ctx.getImageData(0, 0, size, size);
  }
  await new Promise((resolve, reject) => {
    chrome.action.setIcon({ imageData }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
  self.__lastAppliedBrandingVersion = version;
}

const DB_NAME = "ext-state";
const DB_VERSION = 1;
const STORE = "tabState";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open DB"));
  });
}

function idbGet(key) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const store = tx.objectStore(STORE);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error("idbGet error"));
      })
  );
}

function idbPut(key, valueObj) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const toSave = Object.assign({}, valueObj, { key });
        const req = store.put(toSave);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error || new Error("idbPut error"));
      })
  );
}

function idbDelete(key) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        const req = store.delete(key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error || new Error("idbDelete error"));
      })
  );
}

function defaultState() {
  return {
    selectedProfileId: "",
    companyName: "",
    roleTitle: "",
    jobText: "",
    /** Draft follow-up question, kept per tab so the shared textarea in the
     *  side panel doesn't leak one tab's text into another. */
    qaDraft: "",
    generatingStatus: null,
    info: null,
    files: [],
    qa: [],
    isSaving: false,
    isOpen: true,
    /** True after CV bundle was written to the global save folder from this tab. */
    cvSavedToFolder: false,
    /** Matches extension folder revision when cvSavedToFolder was set; invalidates check if user picks a new folder. */
    cvSavedFolderRev: 0,
  };
}

/**
 * Migrate old slot-shaped records to flat state. Older versions stored
 * { activeSlotId, slotOrder, slots: { default: {...} } } per tab.
 */
function migrate(raw) {
  if (!raw) return defaultState();
  const { key: _k, ...rest } = raw;
  if (rest.slots && rest.activeSlotId) {
    const aid = rest.activeSlotId;
    const inner = (rest.slots && rest.slots[aid]) || {};
    return { ...defaultState(), ...inner, isOpen: rest.isOpen !== false };
  }
  return { ...defaultState(), ...rest };
}

async function getState(tabId) {
  const key = `tab:${tabId}`;
  const rec = await idbGet(key);
  return migrate(rec);
}

// setState is read-modify-write (read the current record, merge the patch,
// write it back) — NOT atomic on its own. sidepanel.js has call sites that
// don't await each other (setAutofillStatus's own savePatch is explicitly
// fire-and-forget, `.catch()`'d rather than awaited, so several can be in
// flight for the same tab at once — e.g. autofill's own progress pings
// firing right after a generation just finished for that tab). Two
// overlapping calls for the SAME tab can both read the pre-patch record,
// then each write their own merge — whichever write lands second silently
// discards the other's fields, including a just-completed generation's
// `info`/`files`. That's the "generated successfully, but Download says
// generate first" flakiness, and the panel showing a stale/reverted
// resume or cover letter after the fact.
//
// Fixed by serializing every setState call FOR THE SAME TAB through a
// per-tab promise chain: each call's read only starts once the previous
// call's write for that tab has actually committed, so two overlapping
// callers can never both read the same pre-patch snapshot. Different tabs
// still run fully in parallel — only same-tab writes are serialized.
const stateQueues = new Map(); // tabId -> tail promise of its write chain

async function setState(tabId, patch) {
  const key = `tab:${tabId}`;
  const prev = stateQueues.get(tabId) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const cur = await getState(tabId);
    const next = { ...cur, ...(patch || {}) };
    await idbPut(key, next);
    return next;
  });
  stateQueues.set(tabId, run);
  return run;
}

async function clearState(tabId) {
  const key = `tab:${tabId}`;
  await idbDelete(key);
  stateQueues.delete(tabId);
  return { ok: true };
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    await clearState(tabId);
  } catch {
    /* tab already gone */
  }
});

// Which frame in the tab actually hosts the application form — checked
// fresh before every Auto-fill message instead of broadcasting to every
// frame and racing their replies (chrome.tabs.sendMessage(tabId, msg) with
// no frameId delivers to ALL frames; only the first sendResponse wins).
// That race used to be "fixed" by making empty/decoy frames wait behind an
// artificial delay (see autofill.js's FORM_FRAME_MSGS gate) so the real
// form frame's reply would win — but resume attachment alone can run past
// 1500ms on a slow page (lazy-mount polling + the education-reapply DOM
// wait), so a decoy frame's "resumeAttached:false" neutral reply still won
// the race on those pages, which is exactly what made a resume that DID
// attach on the page show up as "not uploaded" in the side panel. Targeting
// the message at a single, known-correct frameId removes the race
// entirely — no other frame's onMessage listener even fires for it, so the
// real reply is the only one that ever comes back, however long it takes.
// executeScript (not chrome.webNavigation, which this extension doesn't
// have permission for) is what enumerates frameIds here — it already runs
// with allFrames:true for on-demand injection below, and MV3 hands back
// each frame's own {frameId, result} pair.
// Minimal Chrome "match pattern" (<scheme>://<host><path>) tester — just
// enough of the spec for this manifest's own patterns (http(s)/*, a bare
// host, or a *.host wildcard; * in the path matching any run of chars
// including /). Used by manifestFilesForUrl below so the on-demand
// injection fallback is always derived from the manifest itself instead of
// a separately hand-maintained file list that can silently drift from it.
function matchPattern(pattern, url) {
  try {
    const m = /^(\*|https?):\/\/(\*|\*\.[^/*]+|[^/*]+)(\/.*)$/.exec(pattern);
    if (!m) return false;
    const [, scheme, host, path] = m;
    const u = new URL(url);
    if (scheme !== "*" && scheme !== u.protocol.replace(":", "")) return false;
    if (host !== "*") {
      if (host.startsWith("*.")) {
        const base = host.slice(2);
        if (u.hostname !== base && !u.hostname.endsWith("." + base)) return false;
      } else if (host !== u.hostname) {
        return false;
      }
    }
    const pathRe = new RegExp("^" + path.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    return pathRe.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

// The exact set of files Chrome would inject into `url` on a fresh page
// load, per the manifest's own content_scripts — same matches/exclude_
// matches logic Chrome itself applies, computed live so this can't drift
// from the real manifest the way a hand-copied file list did before.
function manifestFilesForUrl(url) {
  const entries = chrome.runtime.getManifest().content_scripts || [];
  const files = [];
  const seen = new Set();
  for (const entry of entries) {
    const matches = (entry.matches || []).some((p) => matchPattern(p, url));
    if (!matches) continue;
    const excluded = (entry.exclude_matches || []).some((p) => matchPattern(p, url));
    if (excluded) continue;
    for (const f of entry.js || []) {
      if (!seen.has(f)) {
        seen.add(f);
        files.push(f);
      }
    }
  }
  return files;
}

async function resolveFormFrameId(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        try {
          const SEL =
            'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), ' +
            'textarea, select, [role="combobox"], [role="textbox"], [role="listbox"], [contenteditable="true"]';
          return document.querySelectorAll(SEL).length > 0;
        } catch {
          return false;
        }
      },
    });
    const hits = (results || []).filter((r) => r.result === true);
    if (hits.length === 0) return 0; // no frame reports form content — fall back to the top frame, same as before
    // Prefer the top frame over a nested iframe if both happen to have
    // form-ish content (a cookie-consent widget, a chat bubble, …) — the
    // common case (form directly on the page) should never be second-guessed.
    return hits.some((r) => r.frameId === 0) ? 0 : hits[0].frameId;
  } catch {
    return 0;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (!msg) {
        sendResponse({ ok: false, error: "empty message" });
        return;
      }

      // Timer proxy for a BACKGROUND tab. Chrome throttles a hidden
      // page's setTimeout (≈1/s, then 1/min after 5 minutes), which
      // stalled a running Auto-fill the moment the user switched tabs —
      // it only crawled forward again when they came back. The service
      // worker is not subject to page-visibility throttling, so the
      // content script delegates its delays here while hidden. Capped so
      // a bad caller can't pin the worker open.
      if (msg.type === "PA_WAIT") {
        const ms = Math.max(0, Math.min(Number(msg.ms) || 0, 30000));
        setTimeout(() => { try { sendResponse({ ok: true }); } catch { /* channel closed */ } }, ms);
        return;
      }

      // Greenhouse's public boards-api.greenhouse.io (job-detect/extractors/
      // structured/jobmeta.js's location/posted-date source — same data
      // BidHub's own crawler reads). Can't be fetched from the page's own
      // content-script world: several Greenhouse-hosted pages ship a CSP
      // connect-src that doesn't allowlist boards-api.greenhouse.io (even
      // though it's Greenhouse's own domain), so the browser blocks it
      // there outright. A service worker isn't bound by any page's CSP, so
      // the fetch runs here instead and relays the result back.
      if (msg.type === "GH_BOARDS_API_FETCH") {
        try {
          const board = String(msg.board || "").trim();
          const jobId = String(msg.jobId || "").trim();
          if (!board || !/^\d+$/.test(jobId)) {
            sendResponse({ ok: false });
            return;
          }
          const res = await fetch(
            `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}`,
            { credentials: "omit" },
          );
          if (!res.ok) {
            sendResponse({ ok: false, status: res.status });
            return;
          }
          const data = await res.json();
          sendResponse({ ok: true, data });
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
        return;
      }

      if (msg.type === "INIT") {
        const state = await getState(msg.tabId);
        // Piggy-back on INIT to opportunistically re-check the toolbar
        // icon. INIT fires whenever the side panel wakes up, which is
        // basically the same cadence a user's browsing session hits
        // fresh checks. Errors are swallowed — the manifest icon is
        // the always-available fallback.
        applyRemoteToolbarIcon().catch(() => {});
        sendResponse({ ok: true, state });
        return;
      }

      if (msg.type === "SAVE_STATE") {
        const state = await setState(msg.tabId, msg.patch || {});
        sendResponse({ ok: true, state });
        return;
      }

      if (msg.type === "SET_OPEN") {
        const state = await setState(msg.tabId, { isOpen: !!msg.isOpen });
        try {
          if (state.isOpen && chrome.sidePanel && chrome.sidePanel.open) {
            await chrome.sidePanel.open({ tabId: msg.tabId });
          }
        } catch {
          /* sidePanel.open may reject if not allowed */
        }
        sendResponse({ ok: true });
        return;
      }

      // ============================================================
      // Auto-fill bridge
      // ============================================================
      // The side panel runs in an extension origin and can't talk to
      // page DOM directly. The content script (autofill.js) runs in
      // every page but can't reach chrome.storage / the API directly.
      // The background SW forwards messages between them: side panel
      // -> background -> chrome.tabs.sendMessage(tabId, msg) -> content
      // script in that tab. The content script's reply travels back
      // the same way.
      // ============================================================
      if (
        msg.type === "AUTOFILL_DETECT" ||
        msg.type === "AUTOFILL_REVIEW" ||
        msg.type === "AUTOFILL_FILL" ||
        msg.type === "AUTOFILL_FILL_QUESTIONS" ||
        msg.type === "AUTOFILL_FILL_DROPDOWNS" ||
        msg.type === "AUTOFILL_COUNT_EMPTY" ||
        msg.type === "AUTOFILL_APPLY_QA_ANSWERS" ||
        msg.type === "AUTOFILL_NEXT_STEP"
      ) {
        if (!msg.tabId) {
          sendResponse({ ok: false, error: "missing tabId" });
          return;
        }
        try {
          const frameId = await resolveFormFrameId(msg.tabId);
          const reply = await chrome.tabs.sendMessage(msg.tabId, msg, { frameId });
          sendResponse(reply || { ok: false, error: "no reply from content script" });
        } catch (err) {
          // sendMessage throws when there's no listener in the target
          // tab. That commonly happens when:
          //   (a) the tab was loaded BEFORE the extension was reloaded
          //       (existing tabs don't auto re-inject content scripts);
          //   (b) document_idle hasn't fired yet on a slow / heavy page;
          //   (c) the page navigated via pushState and the SPA watcher
          //       hasn't re-registered yet.
          // For http/https tabs, inject the content scripts on-demand
          // and retry once. chrome:// / file:// / chrome-extension://
          // are still legitimately blocked — those produce a clearer
          // error.
          let injected = false;
          try {
            const tab = await chrome.tabs.get(msg.tabId).catch(() => null);
            const url = tab?.url || "";
            if (/^https?:\/\//i.test(url)) {
              // Re-injecting only autofill.js leaves window.ProactiveAutofill
              // empty, so its gate at the top bails again and the listener is
              // STILL not registered — which is what produced the bogus
              // "Form is already fully filled" status on Workable. Need the
              // full dependency chain, in the same order Chrome would use on
              // a fresh load — computed from the manifest's own
              // content_scripts (manifestFilesForUrl below) rather than a
              // hand-maintained copy of it, which is exactly what let this
              // list silently fall out of sync with the real manifest once
              // the per-site job-detect/sites + autofill/sites content_
              // scripts entries were added (this fallback kept injecting
              // only the old pre-port generic files, so a tab that hit this
              // on-demand path got the old generic autofill.js/job-fit.js
              // system — e.g. the old 4-field-ish generic review — never the
              // real per-site one, even on a brand new ATS-specific tab).
              const files = manifestFilesForUrl(url);
              if (files.length) {
                await chrome.scripting.executeScript({
                  target: { tabId: msg.tabId, allFrames: true },
                  files,
                });
                injected = true;
              }
            }
          } catch (injErr) {
            // injection itself failed — keep the original error path
            console.warn("auto-fill on-demand inject failed", injErr);
          }
          if (injected) {
            try {
              const frameId = await resolveFormFrameId(msg.tabId);
              const reply = await chrome.tabs.sendMessage(msg.tabId, msg, { frameId });
              sendResponse(reply || { ok: false, error: "no reply from content script" });
              return;
            } catch (retryErr) {
              sendResponse({
                ok: false,
                error: "Auto-fill couldn't reach the page. Reload the tab and try again.",
                detail: String(retryErr?.message || retryErr),
              });
              return;
            }
          }
          // Truly unreachable surface (chrome://, file://, web store).
          sendResponse({
            ok: false,
            error: "Auto-fill isn't available on this page. Open a job application form first.",
            detail: String(err?.message || err),
          });
        }
        return;
      }

      // AUTOFILL_PAGE_CHANGED is a broadcast from the content script's
      // SPA watcher — the side panel listens for it directly via
      // chrome.runtime.onMessage. Background acknowledges and moves on.
      if (msg.type === "AUTOFILL_PAGE_CHANGED") {
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false, error: "Unknown message" });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true;
});

// ============================================================
// Keyboard shortcuts (chrome://extensions/shortcuts) — Generate and
// Auto-fill. The combo itself is bound in manifest.json's "commands" and
// can only be changed on Chrome's own shortcuts page (see the "Change
// shortcuts" button on the Account tab, which opens it directly).
//
// The pending action is stashed in session storage, not just sent live —
// if the side panel wasn't already open, chrome.sidePanel.open() below
// takes a moment to load it, and a sendMessage fired before its listener
// has registered would otherwise be silently dropped. sidepanel.js's own
// init() checks for a fresh pendingHotkey on load and consumes it.
// ============================================================
chrome.commands.onCommand.addListener(async (command, tab) => {
  const type =
    command === "run-generate" ? "HOTKEY_GENERATE" :
    command === "run-autofill" ? "HOTKEY_AUTOFILL" :
    null;
  if (!type) return;
  const tabId = tab?.id;
  try {
    await chrome.storage.session.set({ pendingHotkey: { type, tabId, ts: Date.now() } });
  } catch {
    /* storage.session unavailable — the live sendMessage below still covers an already-open panel */
  }
  try {
    if (tabId != null && chrome.sidePanel?.open) {
      await chrome.sidePanel.open({ tabId });
    }
  } catch {
    /* already open, or not permitted from this context */
  }
  try {
    await chrome.runtime.sendMessage({ type, tabId });
  } catch {
    /* no listener yet — the pendingHotkey stash above covers this */
  }
});
