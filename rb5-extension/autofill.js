/* =====================================================================
 * ProActive — job-application auto-fill (entry point)
 * =====================================================================
 * This file is now intentionally thin. The actual library lives under
 * autofill/ — split into core, detectors, handlers, pipeline, and ui
 * modules that self-register on the `window.ProactiveAutofill`
 * namespace. This file holds the chrome.runtime message bridge and
 * the post-fill / multi-step / Q&A helpers that talk back to the side
 * panel.
 *
 * Side-panel-facing message contract (unchanged from v3.x):
 *
 *   AUTOFILL_DETECT          -> scan the page, return a snapshot of
 *                               detected contact fields + questions +
 *                               whether a Next/Continue button exists.
 *   AUTOFILL_REVIEW           -> like AUTOFILL_DETECT, but richer and
 *                               read-only-with-values: the Auto Fill tab's
 *                               "Form Questions" review list. Takes a
 *                               profile and returns each detected contact
 *                               field's human label + resolved value
 *                               (valuesFromProfile, no DOM write), plus
 *                               BOTH textarea and single-line question
 *                               labels (detectQuestions + detectInputQuestions).
 *   AUTOFILL_FILL            -> run the Basic Auto-fill pipeline,
 *                               attach resume/cover, highlight what
 *                               changed, show the floating banner.
 *                               Returns FillResult with `questions`
 *                               and `dropdowns` arrays the Advanced
 *                               flow can ship to /answer-questions.
 *   AUTOFILL_FILL_QUESTIONS  -> the side panel got answers from the
 *                               LLM — paste them back into the matching
 *                               textarea / input by temp id (with a
 *                               label-based fallback).
 *   AUTOFILL_FILL_DROPDOWNS  -> same as above for unfilled dropdowns.
 *   AUTOFILL_COUNT_EMPTY     -> count visible empty inputs / textareas
 *                               / dropdowns / radio groups / file
 *                               inputs left on the page.
 *   AUTOFILL_APPLY_QA_ANSWERS-> manual Follow-up Q "Ask" flow:
 *                               label-match the question text against
 *                               page textareas and fill the best match.
 *   AUTOFILL_NEXT_STEP       -> click Next/Continue, wait for the
 *                               DOM to settle, return a fresh
 *                               detect snapshot.
 *
 * Library layout — see autofill/README.md for the full picture.
 * ===================================================================== */
(function () {
  "use strict";

  if (window.__proactiveAutofillLoaded) return;
  // NOTE: the loaded flag is claimed only AFTER the namespace check passes
  // (below). If we set it here and the deps weren't ready yet (an SPA
  // route change re-running this file before _bootstrap on a fresh
  // document), a later re-injection would bail at the guard above and
  // never finish initialising — leaving only the error fallback.

  // The namespace MUST be populated by the time we get here. Each
  // autofill/* file fails closed if its dependencies aren't ready, so
  // a manifest mis-order surfaces as an obvious "ns.detectors.contact
  // is undefined" rather than corrupting page state.
  const ns = window.ProactiveAutofill;
  if (!ns || !ns.pipeline?.basic || !ns.ui?.banner) {
    // Pinpoint which dependency tier failed — the generic
    // "modules not loaded" gave no clue and made Workable's
    // "Form is already fully filled" false-positive untraceable.
    const missing = !ns ? "ns(window.ProactiveAutofill)"
      : !ns.core?.dom ? "core.dom"
      : !ns.core?.reactInput ? "core.reactInput"
      : !ns.core?.values ? "core.values"
      : !ns.detectors?.contact ? "detectors.contact"
      : !ns.detectors?.dropdowns ? "detectors.dropdowns"
      : !ns.detectors?.questions ? "detectors.questions"
      : !ns.detectors?.files ? "detectors.files"
      : !ns.pipeline?.registry ? "pipeline.registry"
      : !ns.handlers?.presets?.pickPreset ? "handlers.presets.pickPreset"
      : !ns.pipeline?.basic ? "pipeline.basic"
      : !ns.ui?.banner ? "ui.banner"
      : "(unknown)";
    console.warn(
      "[proactive] autofill modules not loaded; missing:", missing,
      "— check manifest content_scripts order"
    );
    // Register a minimal fallback listener so the side panel hears a
    // proper error instead of a dropped connection — otherwise the
    // background's `sendMessage` rejects, the side panel falls back
    // to `Number(undefined) || 0`, and the user sees "Form is
    // already fully filled" while staring at empty inputs.
    try {
      if (chrome?.runtime?.onMessage && !window.__proactiveAutofillFallbackInstalled) {
        window.__proactiveAutofillFallbackInstalled = true;
        // Keep a reference so a successful re-injection can REMOVE this —
        // otherwise it keeps answering AUTOFILL_* with the stale error even
        // after the real handler loads.
        const fallbackListener = (msg, _sender, sendResponse) => {
          if (msg && typeof msg.type === "string" && msg.type.startsWith("AUTOFILL_")) {
            sendResponse({
              ok: false,
              code: "modules_not_loaded",
              error: `Auto-fill couldn't initialise on this page (missing ${missing}). Reload the tab and try again.`,
            });
            return true;
          }
          return false;
        };
        window.__proactiveAutofillFallback = fallbackListener;
        chrome.runtime.onMessage.addListener(fallbackListener);
      }
    } catch { /* listener install is best-effort */ }
    return;
  }

  // Namespace is good — claim the singleton now (not at the top) and tear
  // down any error fallback a prior failed load left behind, so it can't
  // keep answering AUTOFILL_* with the stale "couldn't initialise" error.
  window.__proactiveAutofillLoaded = true;
  if (window.__proactiveAutofillFallback) {
    try { chrome.runtime.onMessage.removeListener(window.__proactiveAutofillFallback); } catch { /* ignore */ }
    window.__proactiveAutofillFallback = null;
    window.__proactiveAutofillFallbackInstalled = false;
  }

  const { isVisible, labelTextFor, makeTempId, cssEscape, wait } = ns.core.dom;
  const { setReactInputValue } = ns.core.reactInput;
  const { detectCustomDropdowns, selectDropdownOption } = ns.detectors.dropdowns;
  const { detectQuestions, detectInputQuestions } = ns.detectors.questions;
  const { detectContact } = ns.detectors.contact;
  const { detectFiles } = ns.detectors.files;
  const { valuesFromProfile } = ns.core.values;
  const { pickAdapter } = ns.pipeline.registry;
  const { runBasic } = ns.pipeline.basic;
  const { runAdvanced } = ns.pipeline.advanced;
  const { highlightFilledField } = ns.ui.banner;

  /* ====================================================================
   * fillAll — the top-level entry the side panel calls. Picks the
   * pipeline by mode and decorates the result with the banner UI.
   * ==================================================================== */
  async function fillAll(input) {
    const result = (input.mode === "advanced")
      ? await runAdvanced(input)
      : await runBasic(input);
    // No on-page banner here: it rendered in the form's frame (often an iframe),
    // so it couldn't see / stack with the top-frame fit badge and overlapped it.
    // The side panel now reports the result as a top-frame toast instead.
    return result;
  }

  /* ====================================================================
   * AUTOFILL_DETECT — quick snapshot of the page for the side panel.
   * ==================================================================== */
  function detectSnapshot() {
    const adapter = pickAdapter(location.hostname);
    /** @type {Record<string, HTMLElement>} */
    const map = {};
    let resumeFile = null;
    if (adapter) {
      let hits;
      try { hits = adapter.detect() || {}; } catch { hits = {}; }
      for (const [k, el] of Object.entries(hits)) {
        if (k === "__resumeFile") resumeFile = el;
        else if (el) map[k] = el;
      }
    }
    const generic = detectContact(document);
    for (const [k, el] of Object.entries(generic)) {
      if (!map[k]) map[k] = el;
    }
    if (!resumeFile) {
      const f = detectFiles(document);
      resumeFile = f.resumeFile;
    }
    const questions = detectQuestions(document);
    const nextBtn = detectNextButton();
    return {
      adapter: adapter ? (adapter.label || adapter.name || "Adapter") : "Generic",
      fields: Object.keys(map),
      hasResumeFileInput: !!resumeFile,
      questions,
      hasNextStep: !!nextBtn,
    };
  }

  // Human label for a core/values.js key — same vocabulary runBasic's own
  // contact fill uses, just spelled out for the Auto Fill tab's review
  // list (detectSnapshot above only ever needed the bare keys).
  const FIELD_LABELS = {
    full_name: "Full Name", first_name: "First Name", last_name: "Last Name",
    preferred_first_name: "Preferred First Name", preferred_last_name: "Preferred Last Name",
    preferred_name: "Preferred Name", email: "Email", phone: "Phone",
    phone_extension: "Phone Extension", location: "Location", address: "Address",
    city: "City", state_region: "State / Region", country: "Country",
    postal_code: "Postal Code", linkedin: "LinkedIn", github: "GitHub",
  };

  // The page's OWN visible label, when one can be resolved, wins over the
  // generic FIELD_LABELS fallback above — e.g. an ATS with a single,
  // unsplit "Name" field (Ashby) still matches our full_name rule (no
  // separate "bare name" key exists, and it doesn't need one: full_name
  // IS the right value for a single Name box), but the review list should
  // say "Name" here, same as the page itself, not "Full Name" — a correct
  // fill with a confusing label just reads as wrong. Falls back to the
  // generic label for a real full_name/first_name/etc. split, or anywhere
  // labelTextFor can't resolve anything short/sane (empty, or a stray long
  // paragraph a loose ancestor-walk match sometimes picks up).
  function reviewFieldLabel(key, el) {
    try {
      const t = labelTextFor(el).trim();
      if (t && t.length <= 60) return t.replace(/\s*\*\s*$/, "");
    } catch { /* ignore */ }
    return FIELD_LABELS[key] || key;
  }

  /* ====================================================================
   * AUTOFILL_REVIEW — the Auto Fill tab's "Form Questions" list. Same
   * read-only contract as detectSnapshot (nothing here ever writes to the
   * page), richer: resolves each matched contact field's human label +
   * what it WOULD be filled with (valuesFromProfile, pure/no DOM), and
   * reports both textarea and single-line question labels — detectSnapshot
   * only ever collected the former, since its one caller (the status
   * line) never needed the rest.
   * ==================================================================== */
  function reviewSnapshotOnce(profile) {
    const adapter = pickAdapter(location.hostname);
    /** @type {Record<string, HTMLElement>} */
    const map = {};
    let resumeFile = null;
    if (adapter) {
      let hits;
      try { hits = adapter.detect() || {}; } catch { hits = {}; }
      for (const [k, el] of Object.entries(hits)) {
        if (k === "__resumeFile") resumeFile = el;
        else if (el) map[k] = el;
      }
    }
    const generic = detectContact(document);
    for (const [k, el] of Object.entries(generic)) {
      if (!map[k]) map[k] = el;
    }
    if (!resumeFile) {
      const f = detectFiles(document);
      resumeFile = f.resumeFile;
    }
    const values = valuesFromProfile(profile || {});
    // Only fields BOTH detected on the page AND resolvable from this
    // profile — a key the page has but the profile doesn't (or vice
    // versa) is nothing Autofill could actually do anything with. Each
    // gets a stable temp id (same scheme detectQuestions' own elements
    // get) so a user-edited override in the review list can be written
    // back later through the SAME AUTOFILL_FILL_QUESTIONS path questions
    // use — one write mechanism for the whole review list, not two.
    const contactFields = Object.keys(map)
      .filter((k) => values[k])
      .map((k) => ({ key: k, id: makeTempId(map[k]), label: reviewFieldLabel(k, map[k]), value: values[k] }));
    // Question detectors skip elements an earlier pass already claimed —
    // same "already touched" exclusion runBasic itself relies on, so a
    // field already counted above never ALSO shows up as a free-text
    // question row.
    const touched = new Set(Object.values(map));
    const questions = detectQuestions(document);
    const inputQuestions = detectInputQuestions(document, touched);
    const nextBtn = detectNextButton();
    return {
      adapter: adapter ? (adapter.label || adapter.name || "Adapter") : "Generic",
      contactFields,
      hasResumeFileInput: !!resumeFile,
      questions,
      inputQuestions,
      hasNextStep: !!nextBtn,
    };
  }
  const reviewFieldCount = (snap) =>
    snap.contactFields.length + snap.questions.length + snap.inputQuestions.length + (snap.hasResumeFileInput ? 1 : 0);

  // Greenhouse's job-boards.greenhouse.io template (and reportedly others)
  // server-renders the form, then React swaps the ENTIRE subtree out
  // during hydration — confirmed by inspecting a live Greenhouse page's
  // own bundle behavior; a reference extension had to build an explicit
  // hydration-gate + MutationObserver re-detect for exactly this. A
  // single synchronous scan can land in the gap: it sees real, correctly-
  // labeled fields (nothing wrong with the selectors), but the DOM nodes
  // it found are about to be torn out and replaced, or were queried a
  // beat before the swap finished — either way the single pass under- or
  // mis-reports what's actually there a moment later. Retrying a couple
  // of times, a short beat apart, and keeping whichever pass found the
  // most costs nothing on an already-settled page (the counts just match
  // and the loop exits on the first try) and self-heals on one that's
  // still mid-render — same shape of fix the reference extension needed,
  // without having to special-case Greenhouse's hydration specifically.
  async function reviewSnapshot(profile) {
    let best = reviewSnapshotOnce(profile);
    if (reviewFieldCount(best) === 0) {
      for (const delayMs of [500, 1000, 1500]) {
        await wait(delayMs);
        const next = reviewSnapshotOnce(profile);
        if (reviewFieldCount(next) > reviewFieldCount(best)) best = next;
        if (reviewFieldCount(best) > 0) break;
      }
    }
    return best;
  }

  const NEXT_BUTTON_LABEL =
    /^\s*(next|continue|proceed|next step|save and continue|save & continue|to next page)\s*$/i;
  function detectNextButton() {
    const candidates = document.querySelectorAll("button, input[type=submit], a[role=button]");
    for (const b of candidates) {
      if (!isVisible(b)) continue;
      const t = (b.textContent || b.value || "").trim();
      if (NEXT_BUTTON_LABEL.test(t)) return b;
    }
    return null;
  }

  /* ====================================================================
   * Shared label-matching for routing an LLM answer back to a field.
   * Used by BOTH the Auto-fill batch (fillQuestions) and the manual
   * "Ask" flow (applyManualQaAnswers) so both are equally robust — a
   * label rendered with &nbsp; / double spaces / a trailing "*" that
   * didn't byte-match the question text used to leave the textarea
   * empty on React ATSes (Rippling).
   * ==================================================================== */
  const normalizeLabel = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")          // collapse any whitespace incl. &nbsp;
      .replace(/[*?\s]+$/, "")       // drop trailing "*" / "?" markers
      .replace(/^[\s*?]+/, "")
      .trim()
      .toLowerCase();

  /** Collect visible, labelled free-text fields (textarea / text input),
   *  piercing open shadow roots. Returns [{el, label, labelN}]. */
  function collectLabeledFields() {
    const SEL = 'textarea, input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"], input:not([type])';
    const allEls = [];
    const collectFrom = (root) => {
      try {
        root.querySelectorAll(SEL).forEach((el) => allEls.push(el));
        root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) collectFrom(el.shadowRoot); });
      } catch { /* node may not support querySelectorAll */ }
    };
    collectFrom(document);
    const out = [];
    for (const el of allEls) {
      if (!isVisible(el) || el.disabled || el.readOnly) continue;
      const lbl = labelTextFor(el).trim();
      if (!lbl) continue;
      out.push({ el, label: lbl, labelN: normalizeLabel(lbl) });
    }
    return out;
  }

  /** Score how well a normalized question matches a normalized label:
   *  exact (1000) > substring (600) > word-boundary (500) > ≥35% token
   *  overlap (100+overlap). 0 = no match. */
  function scoreLabelMatch(qN, labelN) {
    if (!qN || !labelN) return 0;
    if (labelN === qN) return 1000;
    if (labelN.includes(qN) || qN.includes(labelN)) return 600;
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (qN.length >= 8) {
      try {
        if (new RegExp(`\\b${escRe(qN)}\\b`).test(labelN) || new RegExp(`\\b${escRe(labelN)}\\b`).test(qN)) return 500;
      } catch { /* pathological regex — fall through */ }
    }
    const qTokens = new Set(qN.split(/\W+/).filter((t) => t.length > 3));
    const lTokens = new Set(labelN.split(/\W+/).filter((t) => t.length > 3));
    let overlap = 0;
    for (const t of qTokens) if (lTokens.has(t)) overlap++;
    if (qTokens.size && overlap / qTokens.size >= 0.35) return 100 + overlap;
    return 0;
  }

  /** Best unused labelled field for a question text, or null. */
  function bestFieldForLabel(questionText, candidates, used) {
    const qN = normalizeLabel(questionText);
    if (!qN) return null;
    let best = null, bestScore = 0;
    for (const c of candidates) {
      if (used && used.has(c.el)) continue;
      const score = scoreLabelMatch(qN, c.labelN);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  /* ====================================================================
   * fillQuestions — paste LLM-generated answers back into screening
   * textareas / question-shaped inputs.
   * ==================================================================== */
  function fillQuestions({ answers }) {
    const out = [];
    if (!Array.isArray(answers)) return { filled: 0, failed: 0, results: out };
    let filled = 0, failed = 0;
    // Built lazily on first id-miss so the common (id present) path pays
    // nothing. Shared with the manual "Ask" matcher.
    let candidates = null;
    const used = new WeakSet();
    for (const a of answers) {
      let el = a.id
        ? document.querySelector(`[data-proactive-autofill-id="${cssEscape(a.id)}"]`)
        : null;
      if (el) used.add(el);
      // Fallback: the temp id has gone stale (React re-rendered / stripped
      // the data attribute on Rippling et al). Route by label using the
      // SAME aggressive-normalize + fuzzy scoring the manual Ask uses —
      // the old exact byte-match failed on labels carrying &nbsp; /
      // double spaces / a trailing "*", leaving the textarea empty.
      if (!el && a.label) {
        if (!candidates) candidates = collectLabeledFields();
        const first = String(a.label).split(/\r?\n/)[0];
        const best = bestFieldForLabel(first, candidates, used);
        if (best) { el = best.el; used.add(el); }
      }
      if (!el) { failed++; out.push({ id: a.id, ok: false, reason: "element gone" }); continue; }
      const previousValue = el.value;
      const ok = setReactInputValue(el, a.answer || "");
      if (ok) {
        filled++;
        ns.LAST_FILL.elements.push({ el, previousValue });
        highlightFilledField(el);
        out.push({ id: a.id, ok: true });
      } else {
        failed++;
        out.push({ id: a.id, ok: false, reason: "set failed" });
      }
    }
    return { filled, failed, results: out };
  }

  /* ====================================================================
   * fillDropdowns — pick LLM-resolved options on unfilled dropdowns.
   * ==================================================================== */
  async function fillDropdowns({ answers }) {
    const out = [];
    if (!Array.isArray(answers)) return { filled: 0, failed: 0, results: out };
    let filled = 0, failed = 0;
    const live = detectCustomDropdowns(document);
    for (const a of answers) {
      if (!a.answer) { failed++; out.push({ id: a.id, ok: false, reason: "no answer" }); continue; }
      let d = a.id ? live.find((x) => x.id === a.id) : null;
      if (!d && a.label) {
        const wanted = String(a.label).trim().toLowerCase();
        d = live.find((x) => (x.label || "").trim().toLowerCase() === wanted);
      }
      if (!d) { failed++; out.push({ id: a.id, ok: false, reason: "dropdown gone" }); continue; }
      const ok = await selectDropdownOption(d, a.answer);
      if (ok) { filled++; out.push({ id: a.id, ok: true, picked: a.answer }); }
      else { failed++; out.push({ id: a.id, ok: false, reason: "option not found" }); }
    }
    return { filled, failed, results: out };
  }

  /* ====================================================================
   * countEmptyFields — visible empty fields the user still has to fill.
   * ==================================================================== */
  function countEmptyFields() {
    let total = 0, required = 0;
    const isReq = (el) =>
      el.required ||
      el.getAttribute("aria-required") === "true" ||
      /\*\s*$/.test(labelTextFor(el) || "");
    const TEXT_SEL =
      'input[type="text"], input[type="number"], input[type="date"], input[type="search"], input[type="email"], input[type="tel"], input[type="url"], input:not([type])';
    for (const el of document.querySelectorAll(TEXT_SEL)) {
      if (!isVisible(el) || el.disabled || el.readOnly) continue;
      if (el.value && el.value.trim().length > 0) continue;
      total++; if (isReq(el)) required++;
    }
    for (const el of document.querySelectorAll("textarea")) {
      if (!isVisible(el) || el.disabled || el.readOnly) continue;
      if (el.value && el.value.trim().length > 0) continue;
      total++; if (isReq(el)) required++;
    }
    for (const el of document.querySelectorAll("select")) {
      if (!isVisible(el) || el.disabled) continue;
      const selText = (el.options[el.selectedIndex]?.text || "").trim().toLowerCase();
      if (el.value && el.value !== "" && selText && !/^select\.?\.?\.?$|^choose\.?\.?\.?$/.test(selText)) continue;
      total++; if (isReq(el)) required++;
    }
    const seenCustom = new WeakSet();
    for (const trigger of document.querySelectorAll('[role="combobox"], [class*="select__control"]')) {
      const top = trigger.closest('[class*="select__control"], [role="combobox"]') || trigger;
      if (seenCustom.has(top)) continue;
      seenCustom.add(top);
      if (!isVisible(top)) continue;
      const chosen = top.querySelector('[class*="select__single-value"], [class*="select__multi-value"]');
      if (chosen && chosen.textContent.trim()) continue;
      const txt = (top.textContent || "").trim().toLowerCase();
      if (txt && !/^select\.?\.?\.?$|^choose\.?\.?\.?$|^pick one/i.test(txt) && !txt.includes("select...")) continue;
      total++; if (top.getAttribute("aria-required") === "true") required++;
    }
    const groupNames = new Set();
    for (const el of document.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
      if (!isVisible(el) || !el.name) continue;
      groupNames.add(el.name);
    }
    for (const name of groupNames) {
      const inputs = document.querySelectorAll(`input[name="${cssEscape(name)}"]`);
      let anyChecked = false, anyRequired = false;
      for (const inp of inputs) {
        if (inp.checked) anyChecked = true;
        if (isReq(inp)) anyRequired = true;
      }
      if (anyChecked) continue;
      total++; if (anyRequired) required++;
    }
    for (const el of document.querySelectorAll('input[type="file"]')) {
      if (el.disabled) continue;
      if (el.files && el.files.length > 0) continue;
      total++; if (isReq(el)) required++;
    }
    return { total, required };
  }

  /* ====================================================================
   * applyManualQaAnswers — manual Follow-up Q "Ask" flow.
   * ==================================================================== */
  function applyManualQaAnswers(answers) {
    const out = { filled: 0, skipped: 0, results: [] };
    if (!Array.isArray(answers) || !answers.length) return out;
    // Same collector + normalize + scoring the Auto-fill batch uses, so
    // a manually-asked answer routes to its field exactly as reliably.
    // (The 30-char "already filled" skip is intentionally NOT applied —
    // the Ask flow's whole point is to refill with a better answer.)
    const candidates = collectLabeledFields();
    const used = new WeakSet();
    for (const a of answers) {
      const qRaw = String(a.question || "").trim();
      const aRaw = String(a.answer || "").trim();
      if (!qRaw || !aRaw) { out.skipped++; continue; }
      const best = bestFieldForLabel(qRaw, candidates, used);
      if (!best) { out.skipped++; out.results.push({ question: qRaw, ok: false, reason: "no matching field" }); continue; }
      const previousValue = best.el.value;
      if (setReactInputValue(best.el, aRaw)) {
        used.add(best.el);
        ns.LAST_FILL.elements.push({ el: best.el, previousValue });
        highlightFilledField(best.el, "preset");
        out.filled++;
        out.results.push({ question: qRaw, ok: true, label: best.label });
      } else {
        out.skipped++;
        out.results.push({ question: qRaw, ok: false, reason: "set failed" });
      }
    }
    return out;
  }

  /* ====================================================================
   * clickNextStepAndWait — multi-step form navigation. Click the
   * Next/Continue button, wait for the DOM to settle, return a fresh
   * detect snapshot. Polls via `wait` (core/dom.js), NOT a raw
   * setInterval/setTimeout — those are throttled to ~1/s the moment this
   * tab goes into the background (Chrome's page-visibility timer
   * throttling), which stalled a multi-step ATS form's "click Next, wait
   * for the next page to load" step for however long the tab stayed
   * inactive; `wait` relays to the (unthrottled) service worker instead
   * while hidden — same fix stepAttachResume's polling above already
   * relies on.
   * ==================================================================== */
  async function clickNextStepAndWait(timeoutMs = 3500) {
    const btn = detectNextButton();
    if (!btn) return { ok: false, error: "No next button visible." };
    let lastTick = Date.now();
    const obs = new MutationObserver(() => { lastTick = Date.now(); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    try { btn.click(); }
    catch (e) { obs.disconnect(); return { ok: false, error: String(e) }; }

    const start = Date.now();
    let settled = false;
    while (Date.now() - start < timeoutMs) {
      await wait(120);
      if (Date.now() - lastTick > 400) { settled = true; break; }
    }
    obs.disconnect();
    const snap = detectSnapshot();
    const result = { ok: true, adapter: snap.adapter, fields: snap.fields, questionCount: snap.questions.length };
    return settled ? result : { ...result, timedOut: true };
  }

  /* ====================================================================
   * SPA navigation watcher — many ATSes route between application
   * steps with pushState instead of a full page navigation. We patch
   * history methods and notify the side panel so it can re-detect.
   * ==================================================================== */
  (function watchSpaNavigation() {
    const fire = () => {
      try { chrome.runtime.sendMessage({ type: "AUTOFILL_PAGE_CHANGED" }); }
      catch { /* extension context torn down (e.g. reload) */ }
    };
    ["pushState", "replaceState"].forEach((m) => {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        fire();
        return r;
      };
    });
    window.addEventListener("popstate", fire);
  })();

  /* ====================================================================
   * Message bridge — side panel ↔ content script.
   *
   * IMPORTANT: this listener runs in EVERY frame (manifest all_frames:
   * true). chrome.tabs.sendMessage delivers to all frames and the FIRST
   * listener to call sendResponse wins. On sites that host the apply
   * form in an iframe (Manatal/careers-page.com, some Workable embeds,
   * Greenhouse iframe variant) the empty main frame would respond
   * first with `filled: [], total: 0` and the side panel showed
   * "Form is already fully filled" while the real form in the child
   * iframe sat untouched. The gate below lets the form-bearing frame
   * win the race by relinquishing the channel from frames that
   * obviously have nothing to fill.
   * ==================================================================== */
  const FORM_CONTENT_SEL =
    'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), ' +
    'textarea, select, ' +
    '[role="combobox"], [role="textbox"], [role="listbox"], ' +
    '[contenteditable="true"]';
  function frameHasFormContent() {
    try { return document.querySelectorAll(FORM_CONTENT_SEL).length > 0; }
    catch { return true; /* err on the side of responding */ }
  }
  // Messages that only make sense in a frame that actually hosts a
  // form. AUTOFILL_FILL_QUESTIONS / _DROPDOWNS / _APPLY_QA_ANSWERS
  // target per-id elements that only the form-frame tagged, so the
  // same gate applies to them. AUTOFILL_NEXT_STEP is also form-only.
  const FORM_FRAME_MSGS = new Set([
    "AUTOFILL_DETECT",
    "AUTOFILL_REVIEW",
    "AUTOFILL_FILL",
    "AUTOFILL_FILL_QUESTIONS",
    "AUTOFILL_FILL_DROPDOWNS",
    "AUTOFILL_COUNT_EMPTY",
    "AUTOFILL_APPLY_QA_ANSWERS",
    "AUTOFILL_NEXT_STEP",
  ]);

  // Deferred neutral fallbacks per message type — used by the
  // no-form-frame branch below so the side panel always gets SOMETHING
  // back even when the form-bearing frame doesn't exist (Shadow DOM
  // forms our selector can't see, single-frame pages with custom
  // widgets, etc.). Each payload mirrors the shape the form frame
  // would return so the side panel's downstream logic doesn't choke.
  function neutralReplyFor(type) {
    switch (type) {
      case "AUTOFILL_DETECT":
        return { ok: true, adapter: null, fields: {}, questions: [], dropdowns: [], hasResume: false, hasNextButton: false };
      case "AUTOFILL_REVIEW":
        return { ok: true, adapter: null, contactFields: [], hasResumeFileInput: false, questions: [], inputQuestions: [], hasNextStep: false };
      case "AUTOFILL_FILL":
        return { ok: true, filled: [], skipped: [], presetFilled: [], questions: [], dropdowns: [], resumeAttached: false, adapter: null, adapterLabel: null };
      case "AUTOFILL_COUNT_EMPTY":
        return { ok: true, total: 0, required: 0 };
      case "AUTOFILL_FILL_QUESTIONS":
      case "AUTOFILL_FILL_DROPDOWNS":
      case "AUTOFILL_APPLY_QA_ANSWERS":
        return { ok: true, filled: 0, failed: 0 };
      case "AUTOFILL_NEXT_STEP":
        return { ok: false, error: "No next button visible." };
      default:
        return { ok: false, code: "no_form_in_frame" };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    // No-form-frame path: a frame that obviously has nothing to fill
    // shouldn't beat the form-bearing frame to the punch. Defer so the real
    // form frame (if any) wins the sendResponse race; if nobody else
    // answers, we still respond — keeps the side panel out of the "no
    // reply from content script" failure mode that the v3.1.16 hard
    // `return false` gate produced on pages where our selector didn't see
    // the form (Shadow DOM, custom widgets, content scripts missing in the
    // iframe, …). Claim the async channel so the timer gets to run.
    //
    // AUTOFILL_FILL specifically needs much more headroom than the other
    // form-frame messages: attaching the resume alone can take up to ~600ms
    // (the lazy-mount fallback's own polling, stepAttachResume above) before
    // the education-re-apply step's own DOM-churn wait (another ~500ms-ish)
    // even starts. 200ms was nowhere near enough — the empty decoy frame
    // (or a same-origin ad/tracking iframe with no form at all) routinely
    // WON the race and reported resumeAttached:false / filled:[] while the
    // real form frame was still mid-fill, which is exactly what made a resume
    // that visibly DID attach on the page show up as "not uploaded" in the
    // side panel's own Resume Uploaded checklist. AUTOFILL_REVIEW needs the
    // same headroom for a different reason — reviewSnapshot's own retry loop
    // (see its comment) can take up to ~3s on a page whose framework replaces
    // the whole form subtree during hydration (Greenhouse's job-boards.
    // greenhouse.io template, confirmed), so this frame's neutral empty
    // reply must not win that race either. Every other form-frame message
    // here (AUTOFILL_DETECT, _COUNT_EMPTY, …) has no comparably slow step,
    // so they keep the original short delay.
    if (FORM_FRAME_MSGS.has(msg.type) && !frameHasFormContent()) {
      const delay = msg.type === "AUTOFILL_FILL" ? 1500 : msg.type === "AUTOFILL_REVIEW" ? 3200 : 200;
      setTimeout(() => {
        try { sendResponse(neutralReplyFor(msg.type)); }
        catch { /* channel may already be closed by the form frame's response */ }
      }, delay);
      return true;
    }
    try {
      if (msg.type === "AUTOFILL_DETECT") {
        sendResponse({ ok: true, ...detectSnapshot() });
        return true;
      }
      if (msg.type === "AUTOFILL_REVIEW") {
        reviewSnapshot(msg.profile).then((snap) => sendResponse({ ok: true, ...snap }));
        return true;
      }
      if (msg.type === "AUTOFILL_FILL") {
        fillAll({
          profile: msg.profile,
          pdfBase64: msg.pdfBase64,
          pdfFilename: msg.pdfFilename,
          jobText: msg.jobText,
          coverLetterPdfBase64: msg.coverLetterPdfBase64,
          coverLetterFilename: msg.coverLetterFilename,
          coverLetterText: msg.coverLetterText,
          mode: msg.mode,
        }).then((result) => sendResponse({ ok: true, ...result }));
        return true;
      }
      if (msg.type === "AUTOFILL_FILL_QUESTIONS") {
        sendResponse({ ok: true, ...fillQuestions({ answers: msg.answers }) });
        return true;
      }
      if (msg.type === "AUTOFILL_FILL_DROPDOWNS") {
        fillDropdowns({ answers: msg.answers }).then((result) => sendResponse({ ok: true, ...result }));
        return true;
      }
      if (msg.type === "AUTOFILL_COUNT_EMPTY") {
        sendResponse({ ok: true, ...countEmptyFields() });
        return true;
      }
      if (msg.type === "AUTOFILL_APPLY_QA_ANSWERS") {
        sendResponse({ ok: true, ...applyManualQaAnswers(msg.answers || []) });
        return true;
      }
      if (msg.type === "AUTOFILL_NEXT_STEP") {
        clickNextStepAndWait().then((r) => sendResponse(r));
        return true;
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
      return true;
    }
    return false;
  });
})();
