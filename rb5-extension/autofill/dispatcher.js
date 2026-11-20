// Bridges the new BidHub-ported per-site engine (job-detect/sites/*.js +
// autofill/sites/*-autofill.js, calling into autofill/engine/dom-
// interactions.js) into sidepanel.js's EXISTING message contract — the
// exact same chrome.runtime.onMessage types the old autofill.js answered
// (AUTOFILL_DETECT/REVIEW/FILL/FILL_QUESTIONS/FILL_DROPDOWNS/COUNT_EMPTY/
// APPLY_QA_ANSWERS/NEXT_STEP). sidepanel.js itself needed ZERO changes —
// this file's whole job is to make the new structural-detection engine
// answer exactly like the old one did, response-shape for response-shape.
//
// Two detection layers compose here, not one:
//   1. window.ProactiveAutofillSites.<site> — the new BidHub-ported
//      structural detector for THIS specific ATS (field kinds, labels,
//      submit/advance buttons). One site registers per page (manifest
//      `matches` are mutually exclusive per ATS), so whichever single key
//      shows up in that namespace is this page's site module.
//   2. window.ProactiveAutofill.detectors.contact — the OLD deterministic
//      label→profile-key matcher (FIELD_RULES), kept ON PURPOSE (see this
//      repo's own decision record): a field the new detector finds that
//      ALSO matches a known contact field (name/email/phone/address/…)
//      gets filled straight from the candidate's own profile, no AI call.
//      Only the fields contact-matching can't place are surfaced to
//      sidepanel.js as "questions" for its existing AI-answer pipeline —
//      same split the old system always had between deterministic
//      contact fields and open screening questions.
(function () {
  "use strict";

  const engine = window.ProactiveAutofillEngine;
  const OLD = window.ProactiveAutofill; // old core: detectors.contact, core.values

  // Read live, not snapshotted: per manifest.json's own file order, each
  // site's own autofill/sites/<site>-autofill.js loads AFTER this file
  // within the same content_scripts entry, so it hasn't registered itself
  // on window.ProactiveAutofillSites yet at the moment this IIFE runs. A
  // `const SITES = window.ProactiveAutofillSites || {}` captured here would
  // permanently snapshot an empty object and getSiteModule() would never
  // see ANY site, on any page, ever.
  function getSites() {
    return window.ProactiveAutofillSites || {};
  }
  function getSiteModule() {
    const keys = Object.keys(getSites());
    return keys.length ? getSites()[keys[0]] : null;
  }
  function siteName() {
    const keys = Object.keys(getSites());
    return keys.length ? keys[0] : null;
  }

  // Method-name drift across the ~45 ported files (several independent
  // porting passes landed on slightly different verbs for the same job —
  // detectFields vs detectQuestions, advance vs advanceToApplicationForm,
  // etc.) — probe the plausible names rather than assuming one.
  function pick(mod, names) {
    for (const n of names) {
      if (typeof mod[n] === "function") return mod[n].bind(mod);
    }
    return null;
  }
  function siteMethods(mod) {
    return {
      isAvailable: pick(mod, ["isAutofillAvailable", "isAvailable"]) || (() => true),
      detect: pick(mod, ["detectFields", "detectQuestions"]) || (() => []),
      fill: pick(mod, ["fillField", "fill", "fillDetectedField"]),
      advance: pick(mod, ["advance", "advanceToApplicationForm", "advanceFlow"]),
      getSubmitButton: pick(mod, ["getSubmitButton", "detectSubmitButton"]),
      clickSubmit: pick(mod, ["clickSubmitButton", "clickSubmit"]),
      // Only present on sites with a repeatable Education/Work-history
      // section (see autofill/engine/section-hierarchy.js) — absent
      // everywhere else, same optional-capability pattern as `advance`.
      detectSections: pick(mod, ["detectSections"]),
      fillSections: pick(mod, ["fillSections"]),
    };
  }

  // Resolve the actual fillable DOM node off a detected entry — ported
  // files consistently call this `control` (the real input/select/etc,
  // vs `field`, the wrapper), but fall back to `field` for the odd file
  // that only set one.
  function controlOf(entry) {
    return entry.control || entry.field || null;
  }

  // bestMatchFor(el) only ever looks AT the element itself — its own name/
  // id/placeholder/aria-label, plus a nearby-label DOM walk (labelTextFor)
  // that assumes a label[for], an enclosing <label>, or a short text node
  // within ~4 ancestor levels. Some sites' real controls (Gem, confirmed)
  // carry NONE of those attributes at all, and lay the label out in a
  // completely separate sibling subtree of the row rather than an
  // ancestor — bestMatchFor correctly finds nothing to go on and returns
  // null. The site's own detectFields() already resolved the right
  // question text through its own (site-specific) logic, so when the
  // element-only match comes up empty, fall back to matching that
  // already-known text straight against the same FIELD_RULES table
  // instead of asking bestMatchFor to rediscover a label it structurally
  // can't reach. Same pattern-score discount and >=70 acceptance
  // threshold bestMatchFor itself uses, so results read identically
  // either way.
  function contactMatchByLabel(question) {
    const rules = OLD?.detectors?.contact?.FIELD_RULES;
    const sig = String(question || "").trim().toLowerCase();
    if (!rules || !sig) return null;
    let best = null;
    for (const rule of rules) {
      if (!rule.patterns) continue;
      for (const p of rule.patterns) {
        if (p.test(sig)) {
          const s = rule.score - 10;
          if (!best || s > best.score) best = { key: rule.key, score: s };
          break;
        }
      }
    }
    return best && best.score >= 70 ? best : null;
  }

  // Layer 2 — does this structurally-detected field also look like a
  // known contact field? Runs the OLD matcher against the SAME element
  // the new detector already found, so there's no second independent DOM
  // pass and no chance of double-filling the same input two different ways.
  function contactMatch(entry) {
    if (!OLD?.detectors?.contact?.bestMatchFor) return null;
    const el = controlOf(entry);
    let match = null;
    if (el) {
      try {
        match = OLD.detectors.contact.bestMatchFor(el);
      } catch {
        match = null;
      }
    }
    if (!match) match = contactMatchByLabel(entry.question);
    return match;
  }

  function profileValues(profile) {
    try {
      return OLD?.core?.values?.valuesFromProfile?.(profile) || {};
    } catch {
      return {};
    }
  }

  // The OLD generic pipeline's deterministic, no-AI answer engine for
  // common screening questions (Country, work authorization, EEO,
  // referral source, salary, ~65 presets total — see
  // autofill/handlers/presets/screening.js) — matches a question's LABEL
  // against a big regex table and resolves an answer straight from the
  // profile, no LLM call. This dispatcher only ever routed a field to one
  // of two places (the OLD contact matcher, or the generic AI-question
  // pipeline) and never called this at all, so every one of these
  // questions fell through to the AI on every ported site — worse at a
  // strict dropdown than a direct preset match, and sometimes outright
  // fails (an AI free-text answer for a Yes/No/Country field). Checked
  // AFTER contactMatch (name/email/phone/etc. still win there) and BEFORE
  // the generic question bucket.
  function presetMatch(entry, profile) {
    const pickPreset = OLD?.handlers?.presets?.pickPreset;
    if (typeof pickPreset !== "function") return null;
    const data = profile?.data || {};
    try {
      return pickPreset(entry.question, data.preferences || {}, data.contact || {}, data);
    } catch {
      return null;
    }
  }

  // Cheap deterministic hash, used only to synthesize a stable fallback id
  // (see normalizeEntry below) — not security-sensitive, just needs to be
  // the same string across repeat detect() calls on the same page.
  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  // Site-to-site shape drift: Greenhouse's own entries (the convention this
  // file was first written against) use fieldKind/fieldId/isResume/
  // isCoverLetter/options, but several other ported files — Ashby among
  // them — spell the same concepts differently (Ashby: `kind`, no id field
  // at all). Reading entries through this once here means every site's
  // output lines up with the one contract below, without having to touch
  // each site file's own internal naming — `__entry`/fill() below still get
  // the RAW entry untouched, so each site's own fillField switch is unaffected.
  function normalizeEntry(entry, index) {
    const fieldKind = entry.fieldKind || entry.kind || null;
    // Greenhouse/most sites flag a resume/cover-letter slot via fieldKind
    // itself ("resume"/"cover_letter"); Gem instead keeps fieldKind as the
    // CONTROL shape ("file") and flags the slot's actual meaning via a
    // separate answerType ("resume"/"cover_letter") — check both so this
    // isn't missed depending on which convention a given site used.
    const isResume = entry.isResume === true || fieldKind === "resume" || entry.answerType === "resume";
    const isCoverLetter =
      entry.isCoverLetter === true || fieldKind === "cover_letter" || entry.answerType === "cover_letter";
    const fieldId = entry.fieldId || entry.id || `auto-${index}-${hashStr(String(entry.question || ""))}`;
    const options = entry.options || entry.choices || [];
    return { fieldKind, isResume, isCoverLetter, fieldId, options };
  }

  // Splits a site module's detectFields() output into:
  //   contactFields — {key, id, label, value, order} for whatever the OLD
  //     matcher could place from the profile (filled right away by the
  //     caller, same shape the old reviewSnapshot() returned).
  //   questions — everything else, surfaced to sidepanel.js's existing
  //     AI-answer pipeline exactly like a screening question always was.
  //   resumeEntry/coverLetterEntry — the file-upload slots, kept out of
  //     both lists (handled by their own dedicated fill path, same as
  //     the old hasResumeFileInput flag).
  //   resumeOrder/coverLetterOrder — each entry's index in detectFields()'s
  //     OWN output, i.e. its real position on the page. detectFields()
  //     returns entries in page/DOM order (confirmed for every ported
  //     site — each walks the form top to bottom), so this `order` is what
  //     lets sidepanel.js render contact fields, questions AND the resume
  //     card interleaved in the same order the real page shows them,
  //     instead of grouping all contact fields first (the review list used
  //     to always put every auto-filled field ahead of every question, and
  //     always draw the resume card dead last, regardless of where either
  //     actually sat on the page).
  function classify(entries, profile) {
    const values = profileValues(profile);
    const contactFields = [];
    const questions = [];
    let resumeEntry = null;
    let coverLetterEntry = null;
    let resumeOrder = null;
    let coverLetterOrder = null;
    entries.forEach((entry, index) => {
      const norm = normalizeEntry(entry, index);
      if (norm.isResume) {
        resumeEntry = entry;
        resumeOrder = index;
        return;
      }
      if (norm.isCoverLetter) {
        coverLetterEntry = entry;
        coverLetterOrder = index;
        return;
      }
      const match = contactMatch(entry);
      if (match && values[match.key] !== undefined && values[match.key] !== "") {
        contactFields.push({
          key: match.key,
          id: norm.fieldId,
          label: entry.question || match.key,
          value: values[match.key],
          order: index,
          __entry: entry,
        });
        return;
      }
      const preset = presetMatch(entry, profile);
      if (preset && preset.answer != null && String(preset.answer).trim() !== "") {
        contactFields.push({
          key: `preset:${preset.key}`,
          id: norm.fieldId,
          label: entry.question || preset.key,
          value: preset.answer,
          order: index,
          __entry: entry,
        });
        return;
      }
      questions.push({
        id: norm.fieldId,
        label: entry.question,
        fieldKind: norm.fieldKind,
        options: norm.options,
        required: !!entry.required,
        order: index,
        __entry: entry,
      });
    });
    return { contactFields, questions, resumeEntry, coverLetterEntry, resumeOrder, coverLetterOrder };
  }

  // Where a repeatable section (Education/Work history) sits relative to
  // the regular detected fields, for sidepanel.js's single merged ordering
  // (see classify()'s own `order` above) — the section's own container is
  // never in `entries` (detectFields() skips it on purpose), so its
  // position is found by DOM comparison against whichever entry it
  // precedes. Half-integer so it sorts cleanly between two whole-number
  // entry indices without ever colliding with one.
  function sectionDomOrder(container, entries) {
    if (!container || typeof container.compareDocumentPosition !== "function") return entries.length;
    for (let i = 0; i < entries.length; i++) {
      const other = entries[i]?.control || entries[i]?.field;
      if (!other || typeof other.compareDocumentPosition !== "function") continue;
      // Bits describing `container`'s position relative to `other` — PRECEDING
      // means container comes BEFORE other in the document, i.e. this is the
      // first regular field the section sits ahead of.
      const pos = other.compareDocumentPosition(container);
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return i - 0.5;
    }
    return entries.length;
  }

  // detectSections()'s raw node list carries live DOM elements (container/
  // control) and function-bearing section descriptors — neither survives
  // chrome.runtime.sendMessage's structured-clone boundary to the side
  // panel. Strip down to plain data here, resolving each leaf's value from
  // the profile (same "resolve now, write later" pattern contactFields
  // already uses) before anything crosses that boundary.
  function serializeSectionNodes(nodes, entries, profileData) {
    return nodes.map((node) => {
      if (node.kind === "root") {
        return {
          fieldId: node.fieldId,
          parentFieldId: null,
          kind: "root",
          label: node.label,
          entryCount: node.entryCount,
          order: sectionDomOrder(node.container, entries),
        };
      }
      if (node.kind === "group") {
        return { fieldId: node.fieldId, parentFieldId: node.parentFieldId, kind: "group", label: node.label };
      }
      const sectionEntries = (profileData && profileData[node.section.profileSection]) || [];
      const entry = sectionEntries[node.rowIndex];
      let value = "";
      try {
        value = (node.mapping.resolveValue ? node.mapping.resolveValue(entry) : entry?.[node.mapping.profileKey]) || "";
      } catch {
        value = "";
      }
      return { fieldId: node.fieldId, parentFieldId: node.parentFieldId, kind: "leaf", label: node.label, value: String(value) };
    });
  }

  // SPA ATSes (Ashby and most others here) hydrate their form
  // progressively — a detect() taken the instant the sidepanel opens can
  // legitimately catch the page mid-render and see only some of the real
  // fields, same class of race the old autofill.js's own reviewSnapshot()
  // retry loop existed to paper over (see its comment). Keep whichever
  // pass found the most, short-circuiting as soon as a pass doesn't add
  // anything new (the page has settled).
  async function detectSettled(m) {
    let best = (await m.detect()) || [];
    for (const delayMs of [400, 800, 1200]) {
      if (best.length > 0) {
        await new Promise((r) => setTimeout(r, 250));
        const check = (await m.detect()) || [];
        if (check.length <= best.length) return best.length >= check.length ? best : check;
        best = check;
        continue;
      }
      await new Promise((r) => setTimeout(r, delayMs));
      const next = (await m.detect()) || [];
      if (next.length > best.length) best = next;
    }
    return best;
  }

  // ---- Per-message-type handlers ----------------------------------------

  async function handleDetect() {
    const mod = getSiteModule();
    if (!mod || !engine) return { ok: false, error: "no_site_module" };
    const m = siteMethods(mod);
    if (!m.isAvailable()) return { ok: false, error: "not_available" };
    const entries = await detectSettled(m);
    const { contactFields, questions, resumeEntry } = classify(entries, null);
    return {
      ok: true,
      adapter: siteName(),
      fields: contactFields.map((f) => f.key),
      hasResumeFileInput: !!resumeEntry,
      questions,
      hasNextStep: !!m.advance,
    };
  }

  async function handleReview(profile) {
    const mod = getSiteModule();
    if (!mod || !engine) return { ok: false, error: "no_site_module" };
    const m = siteMethods(mod);
    if (!m.isAvailable()) return { ok: false, error: "not_available" };
    const entries = await detectSettled(m);
    const { contactFields, questions, resumeEntry, resumeOrder, coverLetterEntry, coverLetterOrder } = classify(entries, profile);
    let sections = [];
    if (m.detectSections) {
      try {
        sections = serializeSectionNodes(m.detectSections(profile?.data) || [], entries, profile?.data);
      } catch {
        sections = [];
      }
    }
    return {
      ok: true,
      adapter: siteName(),
      contactFields,
      hasResumeFileInput: !!resumeEntry,
      resumeOrder: resumeEntry ? resumeOrder : null,
      // classify() already splits this out the same way it does resumeEntry
      // (kept out of contactFields/questions so it gets its own Attach-style
      // card, not a generic question row) — handleReview just never actually
      // passed it on to the caller, so a detected cover-letter slot was
      // correctly found but never reached the review list at all.
      hasCoverLetterFileInput: !!coverLetterEntry,
      coverLetterOrder: coverLetterEntry ? coverLetterOrder : null,
      questions,
      inputQuestions: [],
      sections,
      hasNextStep: !!m.advance,
    };
  }

  async function handleFill(input) {
    const mod = getSiteModule();
    if (!mod || !engine) return { ok: false, error: "no_site_module" };
    const m = siteMethods(mod);
    if (!m.fill) return { ok: false, error: "site_cannot_fill" };
    const entries = await detectSettled(m);
    const { contactFields, questions, resumeEntry, coverLetterEntry } = classify(entries, input.profile);

    const filled = [];
    const skipped = [];

    for (const cf of contactFields) {
      try {
        await m.fill(cf.__entry, cf.value);
        filled.push(cf.key);
      } catch {
        skipped.push(cf.key);
      }
    }

    let resumeAttached = false;
    if (resumeEntry && input.pdfBase64) {
      try {
        await m.fill(resumeEntry, {
          fileName: input.pdfFilename || "resume.pdf",
          base64: input.pdfBase64,
          mimeType: "application/pdf",
        });
        resumeAttached = true;
      } catch {
        /* left for the user to attach manually */
      }
    }
    if (coverLetterEntry && (input.coverLetterPdfBase64 || input.coverLetterText)) {
      try {
        if (input.coverLetterPdfBase64) {
          await m.fill(coverLetterEntry, {
            fileName: input.coverLetterFilename || "cover-letter.pdf",
            base64: input.coverLetterPdfBase64,
            mimeType: "application/pdf",
          });
        } else {
          await m.fill(coverLetterEntry, input.coverLetterText);
        }
      } catch {
        /* left for the user */
      }
    }

    let sectionResults = [];
    if (m.fillSections) {
      try {
        sectionResults = (await m.fillSections(input.profile?.data)) || [];
      } catch {
        sectionResults = [];
      }
      for (const sr of sectionResults) {
        filled.push(...(sr.filled || []));
        skipped.push(...(sr.skipped || []));
      }
    }

    const dropdownQuestions = questions.filter((q) => (q.options || []).length > 0);
    const textQuestions = questions.filter((q) => !(q.options || []).length);

    return {
      ok: true,
      resumeAttached,
      filled,
      presetFilled: [],
      skipped,
      adapter: siteName(),
      questions: textQuestions.map((q) => ({ id: q.id, label: q.label })),
      dropdowns: dropdownQuestions.map((q) => ({ id: q.id, label: q.label, options: q.options })),
      sections: sectionResults,
      __entriesById: Object.fromEntries(entries.map((e) => [e.fieldId, e])),
    };
  }

  // A question-answer fill (AUTOFILL_FILL_QUESTIONS / AUTOFILL_FILL_DROPDOWNS
  // / AUTOFILL_APPLY_QA_ANSWERS all do the same thing: look the field back
  // up by id and write the given answer). Re-detects fresh since the DOM
  // may have changed since the original detect() call that produced the id.
  async function fillAnswers(answers) {
    const mod = getSiteModule();
    const m = mod ? siteMethods(mod) : null;
    if (!mod || !m?.fill) return { filled: [], failed: (answers || []).map((a) => a.id || a.question) };
    const entries = (await m.detect()) || [];
    const byId = new Map(entries.map((e) => [e.fieldId, e]));
    const byLabel = new Map(entries.map((e) => [String(e.question || "").trim().toLowerCase(), e]));
    const filled = [];
    const failed = [];
    for (const a of answers || []) {
      const entry =
        (a.id && byId.get(a.id)) || byLabel.get(String(a.label || a.question || "").trim().toLowerCase());
      if (!entry) {
        failed.push(a.id || a.question);
        continue;
      }
      try {
        await m.fill(entry, a.answer);
        filled.push(a.id || a.question);
      } catch {
        failed.push(a.id || a.question);
      }
    }
    return { ok: true, filled, failed, results: filled };
  }

  async function handleCountEmpty() {
    const mod = getSiteModule();
    if (!mod) return { ok: true, total: 0, required: 0, detected: 0 };
    const m = siteMethods(mod);
    const entries = (await m.detect()) || [];
    const empty = entries.filter((e) => {
      const el = controlOf(e);
      if (!el) return true;
      if (el.type === "checkbox" || el.type === "radio") return !el.checked;
      if (el.tagName === "SELECT") return !el.value;
      return !String(el.value || "").trim();
    });
    // `detected` (every field this page's adapter found, filled or not) —
    // lets the panel report a plain "Filled X/Y fields" fraction instead of
    // just the leftover-empty count on its own (see sidepanel.js's own
    // runAutofill summary).
    return { ok: true, total: empty.length, required: empty.filter((e) => e.required).length, detected: entries.length };
  }

  async function handleNextStep() {
    const mod = getSiteModule();
    if (!mod) return { ok: false, error: "no_site_module" };
    const m = siteMethods(mod);
    if (!m.advance) return { ok: false, error: "no_next_step" };
    try {
      const advanced = await m.advance();
      if (!advanced) return { ok: false, error: "could_not_advance" };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
    const entries = await detectSettled(m);
    const { contactFields, questions } = classify(entries, null);
    return {
      ok: true,
      adapter: siteName(),
      fields: contactFields.map((f) => f.key),
      questionCount: questions.length,
    };
  }

  // ---- Race arbitration for the one direct (non-background-relayed)
  // call, AUTOFILL_DETECT (chrome.tabs.sendMessage reaches every frame
  // since this file is all_frames:true on ATS sites with iframed forms —
  // same two-tier scheme the old autofill.js used). Every OTHER message
  // type is relayed by background.js with an explicit frameId, so only
  // the targeted frame's listener runs at all — no race there.
  function frameHasSiteModule() {
    return !!getSiteModule();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("AUTOFILL_")) return undefined;

    if (msg.type === "AUTOFILL_DETECT" && !frameHasSiteModule()) {
      // Staggered neutral reply so a form-less decoy frame doesn't win
      // the race against the frame that actually has the application form.
      setTimeout(() => sendResponse({ ok: false, fields: [], questions: [] }), 200);
      return true;
    }

    (async () => {
      try {
        switch (msg.type) {
          case "AUTOFILL_DETECT":
            sendResponse(await handleDetect());
            break;
          case "AUTOFILL_REVIEW":
            sendResponse(await handleReview(msg.profile));
            break;
          case "AUTOFILL_FILL":
            sendResponse(await handleFill(msg));
            break;
          case "AUTOFILL_FILL_QUESTIONS":
          case "AUTOFILL_FILL_DROPDOWNS":
          case "AUTOFILL_APPLY_QA_ANSWERS":
            sendResponse(await fillAnswers(msg.answers));
            break;
          case "AUTOFILL_COUNT_EMPTY":
            sendResponse(await handleCountEmpty());
            break;
          case "AUTOFILL_NEXT_STEP":
            sendResponse(await handleNextStep());
            break;
          default:
            sendResponse({ ok: false, error: "unknown_message_type" });
        }
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true; // async sendResponse
  });
})();
