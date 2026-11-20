/* =====================================================================
 * pipeline/basic.js — Basic Auto-fill orchestration.
 * =====================================================================
 * Composes the detectors into a deterministic fill sequence. No LLM
 * calls; every step is local. The same FillResult shape is returned to
 * the side panel; "advanced" mode (advanced.js) decorates the result
 * with screening questions + unfilled dropdowns that need an LLM.
 *
 * Step order is significant — earlier passes claim inputs, later
 * passes skip them via LAST_FILL.elements / seen-input tracking:
 *
 *   1. detectAdapter         host-specific FieldMap override
 *   2. detectContact         generic heuristic for unfilled keys
 *   3. fillContactMap        write values for every map entry
 *   4. attachPhoneCountry    intl-tel-input fast path + generic walk
 *   5. attachResume          .pdf attach (also fires drop event)
 *   6. attachCoverLetter     either input[type=file] or textarea paste
 *   7. fillPresetDropdowns   Yes/No / sensitive / one-of via dropdown
 *   8. fillPresetCheckboxes  same presets via radio/checkbox surface
 *   9. fillPresetTextInputs  same presets via text/number input
 *  10. fillRatingTextInputs  "rate 1-10" numeric inputs → "8"
 *  11. fillPresetTextareas   presets that landed on a textarea
 *  12. fillConsentCheckboxes Privacy / Terms / GDPR ticks
 *  13. detectNextStep        is there a Next/Continue button?
 *
 * Each step is a pure function of (ctx, result). Reorder freely; add
 * new steps by inserting into the array. ============================ */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill) return;
  const ns = window.ProactiveAutofill;
  if (
    !ns.core?.dom || !ns.core?.reactInput || !ns.core?.values ||
    !ns.detectors?.contact || !ns.detectors?.dropdowns ||
    !ns.detectors?.checkboxGroups || !ns.detectors?.phoneCountry ||
    !ns.detectors?.files || !ns.detectors?.consent ||
    !ns.detectors?.rating || !ns.detectors?.questions ||
    !ns.pipeline?.registry || !ns.handlers?.presets?.pickPreset
  ) return;

  const { isVisible, labelTextFor, makeTempId, cssEscape, wait } = ns.core.dom;
  const {
    setReactInputValue,
    attachPdfToFileInput,
  } = ns.core.reactInput;
  const {
    valuesFromProfile,
    resolvePhoneCountry,
    parseSalaryFromJd,
    resolveSalaryForField,
    formatSalaryForField,
    toIsoDate,
  } = ns.core.values;
  const { detectContact } = ns.detectors.contact;
  const { detectCustomDropdowns, captureCustomDropdownOptions, selectDropdownOption, looksLikeAutocomplete, commitAutocompleteSelection } = ns.detectors.dropdowns;
  const { detectCheckboxGroups, fillCheckboxGroup } = ns.detectors.checkboxGroups;
  const { findPhoneCountryDropdown, intlTelInputFastPath } = ns.detectors.phoneCountry;
  const { detectFiles } = ns.detectors.files;
  const { fillConsentCheckboxes } = ns.detectors.consent;
  const { fillRatingTextInputs, isDropdownSearchInput } = ns.detectors.rating;
  const { detectQuestions, detectInputQuestions, RATING_LABEL_LOOKS } = ns.detectors.questions;
  const { pickAdapter } = ns.pipeline.registry;
  const { pickPreset, pickAgeBracketOption } = ns.handlers.presets;

  /** Age brackets differ on every ATS ("25-34" vs "21-29"/"30-39"), so the
   *  configured value is resolved NUMERICALLY against the options this
   *  form actually offers. Returns the attempts list with that concrete
   *  option first; a no-op for every other preset. */
  const withAgeBracketOption = (preset, optionLabels, attempts) => {
    if (!preset || preset.key !== "age_bracket") return attempts;
    const best = pickAgeBracketOption(preset.answer, optionLabels);
    if (!best || attempts[0] === best) return attempts;
    return [best, ...attempts.filter((a) => a !== best)];
  };

  const NEXT_BUTTON_LABEL =
    /^\s*(next|continue|proceed|next step|save and continue|save & continue|to next page)\s*$/i;
  const SCREENING_INPUT_SEL =
    'input[type="text"], input[type="number"], input[type="date"], input[type="search"], input:not([type])';

  /** Initialize the per-call mutable state shared across pipeline steps. */
  function createContext(input) {
    /** @type {import("../core/types.js").FillResult} */
    const result = {
      filled: [],
      skipped: [],
      presetFilled: [],
      resumeAttached: false,
      coverLetterAttached: false,
      coverLetterPasted: false,
      // True when the page HAS a cover-letter slot (file input, lazy-mount
      // trigger, or textarea). Lets the panel distinguish "no cover field
      // on this form" from "cover field found but we had nothing to put in
      // it" — the latter used to fail completely silently.
      coverLetterDetected: false,
      adapterLabel: "Generic",
      questions: [],
      dropdowns: [],
      hasNextStep: false,
    };
    ns.LAST_FILL.elements = [];
    ns.LAST_FILL.resumeEl = null;
    return {
      input,
      result,
      map: /** @type {import("../core/types.js").FieldMap} */ ({}),
      adapterKeys: new Set(),
      adapterLabel: "Generic",
      allTextareas: [],
      allDropdowns: [],
      allCheckboxGroups: [],
      remainingQuestions: [],
      remainingDropdowns: [],
      // Dropdown triggers already committed — shared so an early
      // country/state ordering step and stepPresetDropdowns don't fight.
      dropdownsDone: new WeakSet(),
      files: { resumeFile: null, coverLetterFile: null, coverLetterTextarea: null, resumeAttachTrigger: null, coverLetterAttachTrigger: null, additionalResumeFiles: [] },
    };
  }

  function recordFill(el, previousValue) {
    ns.LAST_FILL.elements.push({ el, previousValue });
  }

  /* ====================================================================
   * STEPS — each is async (ctx) => void
   * ==================================================================== */

  const stepAdapter = (ctx) => {
    const adapter = pickAdapter(typeof location !== "undefined" ? location.hostname : "");
    if (!adapter) return;
    ctx.adapterLabel = adapter.label || adapter.name || "Adapter";
    ctx.result.adapterLabel = ctx.adapterLabel;
    let hits;
    try { hits = adapter.detect() || {}; }
    catch { hits = {}; }
    for (const [k, el] of Object.entries(hits)) {
      if (k === "__resumeFile") ctx.files.resumeFile = el;
      else if (k === "__coverLetterFile") ctx.files.coverLetterFile = el;
      else if (el) {
        ctx.map[k] = el;
        ctx.adapterKeys.add(k);
      }
    }
  };

  const stepContact = (ctx) => {
    const generic = detectContact(document);
    for (const [k, el] of Object.entries(generic)) {
      if (!ctx.map[k]) ctx.map[k] = el;
    }
  };

  /** Strip a leading international dial-code prefix from a phone number
   *  so the NATIONAL number goes into an input that already has a
   *  separate country selector set. "+639221101091" / "00639221101091"
   *  / "639221101091" with dial "63" → "9221101091". A number with no
   *  such prefix is returned unchanged. */
  function stripDialPrefix(phone, dial) {
    let p = String(phone || "").trim();
    if (!p || !dial) return p;
    // Drop a leading "+" or "00" international-access prefix first.
    p = p.replace(/^\s*\+/, "").replace(/^\s*00(?=\d)/, "");
    // Then peel the country dial code if the number leads with it.
    const digitsDial = String(dial).replace(/\D/g, "");
    if (digitsDial && p.replace(/[\s\-().]/g, "").startsWith(digitsDial)) {
      // Remove the dial digits, tolerating separators between them.
      let removed = 0;
      let out = "";
      for (const ch of p) {
        if (removed < digitsDial.length) {
          if (/\d/.test(ch)) { removed++; continue; }
          continue; // skip separators that sit within the dial code
        }
        out += ch;
      }
      p = out;
    }
    return p.replace(/^[\s\-.()]+/, "").trim();
  }

  const stepFillContact = (ctx) => {
    const values = valuesFromProfile(ctx.input.profile);
    for (const [key, el] of Object.entries(ctx.map)) {
      let v = values[key];
      if (!v) { ctx.result.skipped.push({ key, reason: "no value in profile" }); continue; }
      // When a separate phone-country selector was applied on THIS form
      // (stepPhoneCountry ran first and set it), fill only the national
      // number — a widget with a "+63" selector rejects / double-codes
      // a "+63…"-prefixed value. When no selector was found, leave the
      // full international number so a plain phone input stays complete.
      if (key === "phone" && ctx.phoneCountryApplied?.dial) {
        v = stripDialPrefix(v, ctx.phoneCountryApplied.dial);
        if (!v) { ctx.result.skipped.push({ key, reason: "empty after dial strip" }); continue; }
      }
      const previousValue = el.value;
      const ok = setReactInputValue(el, v);
      if (ok) {
        const confidence = ctx.adapterKeys.has(key) ? "high" : "medium";
        ctx.result.filled.push({ key, value: v, confidence });
        recordFill(el, previousValue);
      } else {
        ctx.result.skipped.push({ key, reason: "set failed" });
      }
    }
  };

  /** Location / city fields on some ATSes (Workday, BambooHR "Location
   *  (City)", Google-Places / Algolia typeaheads) are AUTOCOMPLETE
   *  inputs: filling the text isn't enough — the widget only records a
   *  real selection when a suggestion is clicked, so submit fails with
   *  "Please enter your location" and the user has to re-pick it.
   *  After stepFillContact typed the value, click the matching
   *  suggestion to commit the selection. No-op for plain text inputs
   *  (looksLikeAutocomplete gates it). */
  const stepLocationAutocomplete = async (ctx) => {
    const values = valuesFromProfile(ctx.input.profile);
    for (const key of ["location", "city", "state_region"]) {
      const el = ctx.map[key];
      const val = values[key];
      if (!el || !val || !looksLikeAutocomplete(el)) continue;
      const ok = await commitAutocompleteSelection(el, val);
      if (ok) ctx.result.filled.push({ key: `${key}_selected`, value: val, confidence: "high" });
    }
  };

  const stepPhoneCountry = async (ctx) => {
    const phoneEl = ctx.map.phone;
    if (!phoneEl) return;
    const country = resolvePhoneCountry(ctx.input.profile);
    if (!country) return;

    const titleName = country.name
      ? country.name.replace(/\b\w/g, (c) => c.toUpperCase())
      : "";
    // Dial-code-aware candidates: a phone country picker may list the
    // option as "United States +1", "US +1", a bare "+1", or just the name.
    // Name-first so a US profile matches "United States" before the "+1"
    // that Canada and a dozen NANP territories also carry.
    const candidates = [
      titleName && country.dial ? `${titleName} +${country.dial}` : "",
      titleName && country.dial ? `${titleName} (+${country.dial})` : "",
      country.iso && country.dial ? `${country.iso} +${country.dial}` : "",
      titleName,
      country.dial ? `+${country.dial}` : "",
      country.dial, country.iso,
    ].filter(Boolean);
    const commitDropdown = async (trigger) => {
      const dd = { trigger, isNative: trigger.tagName === "SELECT" };
      for (const cand of candidates) {
        if (await selectDropdownOption(dd, cand)) {
          ctx.result.filled.push({ key: "phone_country_code", value: cand, confidence: "preset" });
          ctx.phoneCountryApplied = { dial: country.dial };
          // Claim the trigger so stepPresetDropdowns' generic "Country"
          // preset doesn't re-process this phone dial-code picker and
          // clobber it with the ADDRESS country (or snap it to the
          // alphabetically-first option).
          try { ctx.dropdownsDone?.add(trigger); } catch { /* non-fatal */ }
          return true;
        }
      }
      return false;
    };

    const ccTrigger = findPhoneCountryDropdown(phoneEl);
    const isItiFlag = !!(ccTrigger && ccTrigger.matches &&
      ccTrigger.matches('.iti__selected-country, [class*="iti__selected"], [class*="selected-flag"]'));

    // 1. A dedicated country dropdown (react-select / native <select>) is
    //    the authoritative control — prefer it over the intl-tel-input flag
    //    button, which on combined widgets only mirrors it.
    if (ccTrigger && !isItiFlag) {
      if (await commitDropdown(ccTrigger)) return;
    }
    // 2. intl-tel-input widget: match the option by ISO and verify.
    if (await intlTelInputFastPath(phoneEl, country)) {
      ctx.result.filled.push({
        key: "phone_country_code",
        value: `${country.iso || ""} +${country.dial}`,
        confidence: "preset",
      });
      ctx.phoneCountryApplied = { dial: country.dial };
      return;
    }
    // 3. Last resort: drive whatever trigger we found (e.g. the iti flag
    //    button on a pure intl-tel-input) through the candidate flow.
    if (ccTrigger) await commitDropdown(ccTrigger);
  };

  const stepAttachResume = async (ctx) => {
    let { resumeFile } = ctx.files;
    const { resumeAttachTrigger } = ctx.files;
    const { pdfBase64, pdfFilename } = ctx.input;
    if (!pdfBase64) return;

    // Lazy-mount fallback (Resumator / JazzHR / ApplyToJob): no file
    // input was visible at detect-time, but an "Attach resume" anchor
    // is. Click it from content-script context (programmatic click
    // without an active user-gesture → no native picker dialog), wait
    // for the mounted <input type=file>, then attach.
    if (!resumeFile && resumeAttachTrigger) {
      try { resumeAttachTrigger.click(); } catch { /* non-fatal */ }
      // Poll up to ~600ms in 60ms ticks. The mount path varies (React
      // re-render, jQuery append, web component upgrade) so a fixed
      // wait either over- or under-shoots.
      for (let i = 0; i < 10 && !resumeFile; i++) {
        await wait(60);
        const fresh = detectFiles(document, {});
        if (fresh.resumeFile) {
          resumeFile = fresh.resumeFile;
          ctx.files.resumeFile = resumeFile;
          break;
        }
      }
    }
    if (!resumeFile) return;
    const ok = attachPdfToFileInput(resumeFile, pdfFilename || "resume.pdf", pdfBase64);
    if (ok) {
      ctx.result.resumeAttached = true;
      ns.LAST_FILL.resumeEl = resumeFile;
    }
    // Workable-style "AUTOFILL APPLICATION" / "Import resume from"
    // pages carry a parse-resume input at the top AND a required
    // "Resume *" upload below. detectFiles queues the second one in
    // additionalResumeFiles so we attach the same PDF here — the
    // parse slot triggers Workable's field auto-populate, the
    // standard slot satisfies the required-file validator so the
    // application can actually submit.
    const extras = Array.isArray(ctx.files.additionalResumeFiles)
      ? ctx.files.additionalResumeFiles : [];
    for (const extra of extras) {
      if (!extra || extra === resumeFile) continue;
      try {
        if (attachPdfToFileInput(extra, pdfFilename || "resume.pdf", pdfBase64)) {
          ns.LAST_FILL.resumeEl = ns.LAST_FILL.resumeEl || extra;
        }
      } catch { /* additional slot failure is non-fatal */ }
    }

    // Parse-resume DROPDOWN (Workable "AUTOFILL APPLICATION → Import
    // resume from"): the hidden <input type=file> for "My computer" only
    // mounts once the menu opens, so there was nothing to attach to at
    // detect-time. Open the menu, grab the freshly-mounted input, and
    // attach the SAME CV — this fires Workable's field auto-populate.
    // We drive the mounted input via DataTransfer rather than clicking
    // "My computer" (which calls input.click() → the OS picker we can't
    // satisfy from a background click).
    const parseTrigger = ctx.files.parseResumeAttachTrigger;
    if (parseTrigger) {
      const FILE_SEL = 'input[type="file"]';
      const before = new Set(document.querySelectorAll(FILE_SEL));
      const firstAdded = () => [...document.querySelectorAll(FILE_SEL)].find((el) => !before.has(el)) || null;
      try { parseTrigger.click(); } catch { /* non-fatal */ }
      let parseInput = null;
      for (let i = 0; i < 12 && !parseInput; i++) { await wait(60); parseInput = firstAdded(); }
      // Fallback: some builds mount the input on the "My computer" item,
      // not on menu-open. Click that item (a programmatic click can't
      // open the OS picker, but it mounts the input we then drive).
      if (!parseInput) {
        const item = [...document.querySelectorAll('a, button, [role="menuitem"], [role="option"], li')]
          .find((el) => {
            const t = (el.textContent || "").trim();
            return t.length <= 40 && /\bcomputer\b|from\s+(?:your\s+)?(?:computer|device)|local\s+file/i.test(t) && isVisible(el);
          });
        if (item) {
          try { item.click(); } catch { /* non-fatal */ }
          for (let i = 0; i < 12 && !parseInput; i++) { await wait(60); parseInput = firstAdded(); }
        }
      }
      if (parseInput && parseInput !== resumeFile && parseInput !== ctx.files.coverLetterFile && !extras.includes(parseInput)) {
        try {
          if (attachPdfToFileInput(parseInput, pdfFilename || "resume.pdf", pdfBase64)) {
            ctx.result.resumeAttached = true;
            ns.LAST_FILL.resumeEl = ns.LAST_FILL.resumeEl || parseInput;
          }
        } catch { /* non-fatal */ }
        // Nudge the menu shut so it doesn't sit over the form.
        try { parseInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } catch { /* non-fatal */ }
      }
    }
  };

  const stepAttachCoverLetter = async (ctx) => {
    let { coverLetterFile } = ctx.files;
    const { coverLetterTextarea, coverLetterAttachTrigger } = ctx.files;
    const { coverLetterPdfBase64, coverLetterFilename, coverLetterText } = ctx.input;
    // Lazy-mount fallback for Greenhouse's new job-boards UI: no
    // <input type=file> is present under "Cover Letter" until the
    // "Attach" pill is clicked.
    //
    // We must NOT re-run detectFiles here to find the mounted input.
    // Once the resume is attached, Greenhouse REMOVES the resume
    // <input type=file> from the DOM (it's replaced by a "filename ✕"
    // chip), so the freshly-mounted cover-letter input is often the
    // ONLY file input left on the page — and a full re-classification
    // tags it as the RESUME slot, which is why the cover letter never
    // attached ("not working") and the CV sometimes landed in the
    // cover-letter input ("CV attached instead of cover letter").
    //
    // Instead: snapshot every file input BEFORE the click, then grab
    // the one that APPEARS after. That input belongs to the cover
    // letter by construction — no label/section heuristics involved.
    if (!coverLetterFile && coverLetterAttachTrigger && coverLetterPdfBase64) {
      const FILE_SEL = 'input[type="file"]';
      const before = new Set(document.querySelectorAll(FILE_SEL));
      // The trigger's nearby ancestor scopes the "which added input"
      // tie-break so a stray hidden input mounted elsewhere can't win.
      let section = coverLetterAttachTrigger;
      for (let i = 0; i < 4 && section.parentElement; i++) section = section.parentElement;
      try { coverLetterAttachTrigger.click(); } catch { /* non-fatal */ }
      for (let i = 0; i < 15 && !coverLetterFile; i++) {
        await wait(60);
        const added = [...document.querySelectorAll(FILE_SEL)].filter((el) => !before.has(el));
        if (added.length) {
          coverLetterFile = added.find((el) => section.contains(el)) || added[0];
          ctx.files.coverLetterFile = coverLetterFile;
          break;
        }
      }
      // Fallback: some builds keep the <input type=file> mounted (hidden)
      // and "Attach" merely clicks it — nothing is ADDED. Grab a file
      // input inside the trigger's cover-letter section that isn't the
      // resume input (the trigger was already confirmed to sit under a
      // "Cover Letter" heading, so this input belongs to the cover slot).
      if (!coverLetterFile) {
        const inSection = [...section.querySelectorAll(FILE_SEL)]
          .filter((el) => el !== ctx.files.resumeFile && !el.disabled);
        if (inSection.length) {
          coverLetterFile = inSection[inSection.length - 1];
          ctx.files.coverLetterFile = coverLetterFile;
        }
      }
    }
    // Record that the form HAS a cover-letter slot, whether or not we had
    // anything to put in it. Without this the panel couldn't tell "no
    // cover field here" from "cover field found but no cover letter was
    // generated", so the latter looked like a broken auto-fill.
    ctx.result.coverLetterDetected = !!(coverLetterFile || coverLetterTextarea || coverLetterAttachTrigger);
    if (coverLetterFile && coverLetterPdfBase64) {
      ctx.result.coverLetterAttached = attachPdfToFileInput(
        coverLetterFile,
        coverLetterFilename || "cover_letter.pdf",
        coverLetterPdfBase64,
      );
    }
    if (coverLetterTextarea && coverLetterText) {
      const previousValue = coverLetterTextarea.value;
      if (setReactInputValue(coverLetterTextarea, coverLetterText)) {
        ctx.result.coverLetterPasted = true;
        recordFill(coverLetterTextarea, previousValue);
      }
    }
  };

  const stepDetectFiles = (ctx) => {
    // Adapter hits stay; generic loop only fills slots adapter didn't.
    const files = detectFiles(document, {
      resumeFile: ctx.files.resumeFile,
      coverLetterFile: ctx.files.coverLetterFile,
    });
    ctx.files = files;
  };

  const stepDetectSurfaces = (ctx) => {
    ctx.allTextareas = detectQuestions(document);
    ctx.allDropdowns = detectCustomDropdowns(document);
    ctx.allCheckboxGroups = detectCheckboxGroups(document);
  };

  /** Candidate order for committing a preset into a dropdown.
   *  Education / degree-level: try the concrete, specificity-ordered
   *  synonyms (Science-first) BEFORE the raw profile value — a generic
   *  "Bachelor's" otherwise loosely token-matches the first "…of Arts"
   *  option and commits it before the correct "…of Science" synonym is
   *  attempted. Everything else: the answer first, synonyms as fallback. */
  const dropdownAttemptsFor = (preset) => {
    const attempts = [];
    if (preset.kind === "education" || preset.kind === "degree_level") {
      if (preset.synonyms) for (const s of preset.synonyms) if (s && !attempts.includes(s)) attempts.push(s);
      if (preset.answer && !attempts.includes(preset.answer)) attempts.push(preset.answer);
    } else {
      if (preset.answer) attempts.push(preset.answer);
      if (preset.synonyms) for (const s of preset.synonyms) if (s && !attempts.includes(s)) attempts.push(s);
    }
    return attempts;
  };

  const stepPresetDropdowns = async (ctx) => {
    const prefs = (ctx.input.profile?.data?.preferences) || {};
    const contact = (ctx.input.profile?.data?.contact) || {};
    const profileData = ctx.input.profile?.data;
    // Some forms reveal fields PROGRESSIVELY: Greenhouse's EEOC block shows
    // only "Are you Hispanic/Latino?" until it's answered, then mounts
    // "Please identify your race". A one-shot scan filled Hispanic and
    // never saw race. So LOOP: fill everything we can, and if a fill may
    // have revealed a new dropdown, wait a beat and re-scan. `done` tracks
    // committed triggers so we don't re-fill; deferral to the LLM fallback
    // happens once, at the end, for whatever is still unmatched.
    const done = ctx.dropdownsDone;
    const deferred = new Map(); // id → { label, options }
    // Fill order priority: COUNTRY before STATE. On BambooHR/Workday
    // picking the country CLEARS the state (it re-renders the state list
    // for that country), so a state committed first is wiped. Everything
    // else keeps DOM order.
    const orderKey = (d) => {
      const k = pickPreset(d.label, prefs, contact, profileData)?.key;
      if (k === "country_field") return 0;
      if (k === "state_field") return 2;
      return 1;
    };
    for (let round = 0; round < 6; round++) {
      const dropdowns = (round === 0 ? ctx.allDropdowns : detectCustomDropdowns(document))
        .map((d, i) => ({ d, i }))
        .sort((a, b) => orderKey(a.d) - orderKey(b.d) || a.i - b.i)
        .map((x) => x.d);
      let filledAny = false;
      for (const d of dropdowns) {
        if (!d.trigger || done.has(d.trigger)) continue;
        const preset = pickPreset(d.label, prefs, contact, profileData);
        let filled = false;
        if (preset) {
          const optLabels = (d.options || []).map((o) => (typeof o === "string" ? o : o && o.text));
          const attempts = withAgeBracketOption(preset, optLabels, dropdownAttemptsFor(preset));
          for (const candidate of attempts) {
            if (!candidate) continue;
            if (await selectDropdownOption(d, candidate)) {
              preset.answer = candidate;
              filled = true;
              break;
            }
          }
          if (filled) {
            done.add(d.trigger);
            filledAny = true;
            deferred.delete(d.id); // in case an earlier round deferred it
            ctx.result.presetFilled.push({ key: preset.key, label: d.label, answer: preset.answer, via: "dropdown" });
          }
        }
        if (!filled) {
          // Remember for the Advanced LLM fallback, keyed by id so a
          // re-scan of the same still-unfilled dropdown doesn't duplicate.
          let opts = (d.options || [])
            .map((o) => (typeof o === "string" ? o : o.text))
            .map((s) => String(s || "").trim())
            .filter(Boolean);
          if (!opts.length && !d.isNative) {
            opts = await captureCustomDropdownOptions(d);
            d.options = opts.map((t) => ({ value: t, text: t }));
          }
          if (opts.length) deferred.set(d.id, { id: d.id, label: d.label, options: opts });
        }
      }
      // Stop once a round changes nothing — the form has settled. Else a
      // fill may have unlocked a conditional field; let it mount, re-scan.
      if (!filledAny) break;
      await wait(500);
    }
    for (const entry of deferred.values()) ctx.remainingDropdowns.push(entry);
  };

  /** Selecting Country on BambooHR/Workday CLEARS the State — it re-renders
   *  the state list/field for that country. stepPresetDropdowns fills
   *  Country before State, but a State that was already written as TEXT by
   *  stepFillContact (or a dropdown cleared by a late country re-render)
   *  ends up blank. Run AFTER the country is set: if the page has a Country
   *  control and the State is now empty, re-assert it. */
  const stepReassertAddressState = async (ctx) => {
    const prefs = (ctx.input.profile?.data?.preferences) || {};
    const contact = (ctx.input.profile?.data?.contact) || {};
    const profileData = ctx.input.profile?.data;
    const values = valuesFromProfile(ctx.input.profile);
    if (!values.state_region) return;
    const presetKey = (label) => pickPreset(label, prefs, contact, profileData)?.key;
    let dds = detectCustomDropdowns(document);
    // Only relevant when a Country selector exists (the thing that clears
    // State). A plain State with no Country was already filled normally.
    if (!dds.some((d) => presetKey(d.label) === "country_field")) return;
    // Give any country-triggered re-render a moment to settle, then re-read.
    await wait(500);
    dds = detectCustomDropdowns(document);
    const shownValue = (t) => {
      const v = t && t.querySelector && t.querySelector('[class*="single-value" i], [class*="singleValue" i]');
      return v ? (v.textContent || "").trim() : "";
    };
    const stateDd = dds.find((d) => presetKey(d.label) === "state_field");
    if (stateDd) {
      if (shownValue(stateDd.trigger)) return; // still set — nothing to do
      const preset = pickPreset(stateDd.label, prefs, contact, profileData);
      for (const cand of dropdownAttemptsFor(preset)) {
        if (cand && await selectDropdownOption(stateDd, cand)) {
          ctx.dropdownsDone.add(stateDd.trigger);
          ctx.result.presetFilled.push({ key: "state_field", label: stateDd.label, answer: cand, via: "dropdown-reapply" });
          break;
        }
      }
      return;
    }
    // State is a TEXT input (BambooHR "Province"). Re-detect fresh — the
    // country change may have replaced the element — and refill if blank.
    const el = detectContact(document).state_region;
    if (el && isVisible(el) && !String(el.value || "").trim()) {
      const previousValue = el.value;
      if (setReactInputValue(el, values.state_region)) {
        recordFill(el, previousValue);
        ctx.result.filled.push({ key: "state_region_reassert", value: values.state_region, confidence: "medium" });
      }
    }
  };

  const stepPresetCheckboxGroups = (ctx) => {
    const prefs = (ctx.input.profile?.data?.preferences) || {};
    const contact = (ctx.input.profile?.data?.contact) || {};
    const profileData = ctx.input.profile?.data;
    for (const g of ctx.allCheckboxGroups) {
      let preset = pickPreset(g.label, prefs, contact, profileData);
      if (!preset) {
        // Generic-label EEO groups: the disambiguating keyword lives
        // ONLY in the options. Ashby's disability question is labelled
        // just "Please check one of the boxes below:", and its race
        // group often has no heading at all — the "…disability…" /
        // "…Hispanic or Latino…" text is in the radio options. Retry
        // with the option texts appended so an EEO preset can match.
        // Accept ONLY a "sensitive" result: an ordinary Yes/No group
        // must never be mis-typed as EEO by an incidental option word.
        const optText = g.options.map((o) => o.label).join("  ");
        const fromOpts = pickPreset(`${g.label} ${optText}`, prefs, contact, profileData);
        if (fromOpts && fromOpts.kind === "sensitive") preset = fromOpts;
      }
      if (!preset) continue;
      let baseAnswers;
      if (preset.kind === "languages") {
        baseAnswers = String(preset.answer || "").split(/[,;|]+/).map((s) => s.trim()).filter(Boolean);
      } else {
        baseAnswers = [preset.answer];
      }
      let attempts = [...baseAnswers];
      if (preset.synonyms) for (const s of preset.synonyms) if (!attempts.includes(s)) attempts.push(s);
      attempts = withAgeBracketOption(preset, g.options.map((o) => o.label), attempts);
      // Only a genuinely multi-value preset ("languages") may tick more
      // than one box. Everything else has ONE answer whose synonyms are
      // just alternate phrasings — ticking each match selected a second,
      // unrelated option on "select all that apply" questions.
      const ok = fillCheckboxGroup(g, attempts, { single: baseAnswers.length === 1 });
      if (ok) {
        for (const opt of g.options) {
          if (opt.input.checked) recordFill(opt.input, "");
        }
        ctx.result.presetFilled.push({
          key: preset.key,
          label: g.label,
          answer: baseAnswers.join(", "),
          via: g.type === "radio" ? "radio" : "checkbox",
        });
      }
    }
  };

  const stepPresetTextInputs = async (ctx) => {
    const prefs = (ctx.input.profile?.data?.preferences) || {};
    const contact = (ctx.input.profile?.data?.contact) || {};
    const profileData = ctx.input.profile?.data;
    const salary = ctx.input.jobText ? parseSalaryFromJd(ctx.input.jobText) : null;
    const touched = new WeakSet();
    for (const e of ns.LAST_FILL.elements) touched.add(e.el);
    for (const el of document.querySelectorAll(SCREENING_INPUT_SEL)) {
      if (!isVisible(el)) continue;
      if (touched.has(el)) continue;
      if (isDropdownSearchInput(el)) continue;
      const label = labelTextFor(el);
      const preset = pickPreset(label, prefs, contact, profileData);
      if (!preset) continue;
      let value = "";
      if (preset.kind === "salary") {
        const sal = resolveSalaryForField(el, salary, prefs);
        value = formatSalaryForField(el, sal);
      } else if (preset.kind === "date") {
        const raw = String(preset.answer || "");
        value = el.type === "date" ? toIsoDate(raw) : raw;
      } else {
        value = preset.answer;
      }
      if (!value) continue;
      const previousValue = el.value;
      if (setReactInputValue(el, value)) {
        recordFill(el, previousValue);
        ctx.result.presetFilled.push({ key: preset.key, label, answer: value, via: "text" });
      }
    }
  };

  const stepRatingInputs = (ctx) => {
    const touched = new WeakSet();
    for (const e of ns.LAST_FILL.elements) touched.add(e.el);
    const fills = fillRatingTextInputs(document, touched, recordFill);
    for (const f of fills) {
      ctx.result.presetFilled.push({ key: f.key, label: f.label, answer: f.answer, via: f.via });
    }
  };

  const stepPresetTextareas = (ctx) => {
    const prefs = (ctx.input.profile?.data?.preferences) || {};
    const contact = (ctx.input.profile?.data?.contact) || {};
    const profileData = ctx.input.profile?.data;
    const salary = ctx.input.jobText ? parseSalaryFromJd(ctx.input.jobText) : null;
    // Kinds that resolve to a Yes/No or short single-choice answer.
    // A free-text TEXTAREA is never the right home for these — a
    // question like "Have you worked with SimPro data before? If yes,
    // what types of reports…?" is a DESCRIPTIVE prompt that happens to
    // open with "Have you"; filling the textarea with a bare "Yes"
    // (from positive_capability / has_relevant_experience) is wrong.
    // Defer them to the LLM follow-up path, which writes a real
    // paragraph. Yes/No presets still fill actual Yes/No widgets
    // (buttons, radios, dropdowns) via their own steps.
    const SHORT_ANSWER_KINDS = new Set(["yes_no", "one_of", "country_match"]);
    for (const q of ctx.allTextareas) {
      const preset = pickPreset(q.label, prefs, contact, profileData);
      if (preset && !SHORT_ANSWER_KINDS.has(preset.kind)) {
        const el = document.querySelector(`[data-proactive-autofill-id="${cssEscape(q.id)}"]`);
        if (el) {
          const previousValue = el.value;
          let value = (preset.kind === "salary")
            ? formatSalaryForField(el, resolveSalaryForField(el, salary, prefs))
            : preset.answer;
          if (setReactInputValue(el, value)) {
            recordFill(el, previousValue);
            ctx.result.presetFilled.push({ key: preset.key, label: q.label, answer: value, via: "textarea" });
            continue;
          }
        }
      }
      ctx.remainingQuestions.push(q);
    }
    // Append single-line question inputs (they share the same fill
    // mechanism as textareas — recorded for Advanced flow's Q&A).
    const touched = new WeakSet();
    for (const e of ns.LAST_FILL.elements) touched.add(e.el);
    for (const q of detectInputQuestions(document, touched)) {
      ctx.remainingQuestions.push(q);
    }
  };

  const stepConsent = (ctx) => {
    const fills = fillConsentCheckboxes(document, recordFill);
    for (const c of fills) {
      ctx.result.presetFilled.push({ key: c.key, label: c.label, answer: c.answer, via: c.via });
    }
  };

  const stepNextButton = (ctx) => {
    const candidates = document.querySelectorAll("button, input[type=submit], a[role=button]");
    for (const b of candidates) {
      if (!isVisible(b)) continue;
      const t = (b.textContent || b.value || "").trim();
      if (NEXT_BUTTON_LABEL.test(t)) { ctx.result.hasNextStep = true; return; }
    }
  };

  /** Greenhouse (and other ATSes) PARSE the resume we just uploaded and
   *  auto-populate the Education block a beat AFTERWARDS — overwriting
   *  the School / Degree / Discipline we already committed with their own
   *  guesses ("Art Institute of Atlanta", "Master of Business
   *  Administration (M.B.A.)"). The parse is async, so it lands after
   *  stepPresetDropdowns has finished and silently wins.
   *
   *  Once the resume is attached, wait for the DOM to stop churning
   *  (the parse re-renders the Education block) and re-apply the
   *  education dropdowns so the PROFILE wins. Only touches
   *  education-kind presets, and only when a resume was actually
   *  attached — every other form is untouched. */
  const stepReapplyEducationAfterParse = async (ctx) => {
    if (!ctx.result.resumeAttached) return;
    const prefs = (ctx.input.profile?.data?.preferences) || {};
    const contact = (ctx.input.profile?.data?.contact) || {};
    const profileData = ctx.input.profile?.data;
    const EDU_KINDS = new Set(["education", "education_year", "degree_level"]);
    // Cheap pre-check: is there an education-shaped dropdown at all?
    const hasEduDropdown = detectCustomDropdowns(document).some((d) => {
      const p = pickPreset(d.label, prefs, contact, profileData);
      return p && (EDU_KINDS.has(p.kind) || p.key === "field_of_study");
    });
    const hasEduYear = [...document.querySelectorAll(SCREENING_INPUT_SEL)].some((el) => {
      const p = pickPreset(labelTextFor(el), prefs, contact, profileData);
      return p && p.kind === "education_year" && p.answer;
    });
    if (!hasEduDropdown && !hasEduYear) return;
    const isEdu = (p) => !!p && (EDU_KINDS.has(p.kind) || p.key === "field_of_study");
    /** What a react-select currently DISPLAYS (its single-value chip). */
    const shownValue = (trigger) => {
      const v = trigger.querySelector?.('[class*="single-value" i], [class*="singleValue" i]');
      return v ? (v.textContent || "").trim() : "";
    };
    // label → the option text we last committed. A field still showing
    // that is OURS; anything else is the ATS resume-parser's guess ("Art
    // Institute of Atlanta", an M.B.A. we never chose), which lands
    // asynchronously AFTER our first fill — so we re-assert it.
    const committed = new Map();
    const reassertOnce = async () => {
      let changed = false;
      for (const d of detectCustomDropdowns(document)) {
        const preset = pickPreset(d.label, prefs, contact, profileData);
        if (!isEdu(preset)) continue;
        const shown = shownValue(d.trigger);
        const mine = committed.get(d.label);
        if (mine && shown === mine) continue; // still our value — leave it
        const attempts = dropdownAttemptsFor(preset).filter(Boolean);
        // Already displaying our answer (the "…of Science (M.S.)" option
        // for "Master of Science")? Adopt it instead of re-opening. The
        // test is STRICT — exact or a prefix either way — NOT fuzzy: a
        // ≥50%-token-overlap match wrongly adopted the PARSER's guess
        // ("Art Institute of Atlanta" shares "Institute"+"of" with
        // "Georgia Institute of Technology"), locking in the wrong value.
        const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
        const sn = norm(shown);
        const isOurs = sn && attempts.some((a) => {
          const an = norm(a);
          return an && (sn === an || sn.startsWith(an) || an.startsWith(sn));
        });
        if (isOurs) { committed.set(d.label, shown); continue; }
        for (const candidate of attempts) {
          if (await selectDropdownOption(d, candidate)) {
            committed.set(d.label, shownValue(d.trigger) || candidate);
            changed = true;
            ctx.result.presetFilled.push({
              key: preset.key, label: d.label, answer: candidate, via: "dropdown-reapply",
            });
            break;
          }
        }
      }
      // Year inputs get clobbered by the parse too ("2014/2017" instead of
      // the profile's dates), so re-assert those alongside the dropdowns.
      for (const el of document.querySelectorAll(SCREENING_INPUT_SEL)) {
        if (!isVisible(el) || el.disabled || el.readOnly) continue;
        const p = pickPreset(labelTextFor(el), prefs, contact, profileData);
        if (!p || p.kind !== "education_year" || !p.answer) continue;
        if (String(el.value).trim() === String(p.answer).trim()) continue;
        if (setReactInputValue(el, p.answer)) changed = true;
      }
      return changed;
    };
    // The parse is NETWORK-TIMED, so a fixed sleep can't reliably catch
    // it — the old 3-round / 3-second watch broke early and the parse
    // won the race. POLL instead: each pass is cheap unless a field has
    // actually drifted (only then do we re-open + re-select). Settle after
    // a few consecutive clean passes past a minimum watch, with a hard cap
    // so a form that never parses doesn't linger.
    const start = Date.now();
    let clean = 0;
    for (let i = 0; i < 30; i++) {
      const changed = await reassertOnce();
      clean = changed ? 0 : clean + 1;
      const elapsed = Date.now() - start;
      if (elapsed > 8000) break;                // hard cap
      if (elapsed > 2500 && clean >= 3) break;  // settled — no drift for a while
      await wait(400);
    }
  };

  /** The Basic Auto-fill step list. Public so tests / Advanced can
   *  re-use, append, or splice. */
  const BASIC_STEPS = [
    stepAdapter,
    stepContact,
    // Country selector BEFORE the number: on combined phone widgets
    // (intl-tel-input / react-international-phone) changing the country
    // reformats/clears the input, so filling the number first then
    // switching country wiped the number — leaving "+63" set and the
    // phone field empty. Setting country first also lets stepFillContact
    // strip the dial prefix (fills the national number, not "+63…").
    stepPhoneCountry,
    stepFillContact,
    stepLocationAutocomplete,
    stepDetectFiles,
    stepAttachResume,
    stepAttachCoverLetter,
    stepDetectSurfaces,
    stepPresetDropdowns,
    stepReassertAddressState,
    stepPresetCheckboxGroups,
    stepPresetTextInputs,
    stepRatingInputs,
    stepPresetTextareas,
    stepConsent,
    stepReapplyEducationAfterParse,
    stepNextButton,
  ];

  /**
   * Run the Basic Auto-fill pipeline.
   * @param {import("../core/types.js").FillContext} input
   * @returns {Promise<import("../core/types.js").FillResult>}
   */
  async function runBasic(input) {
    const ctx = createContext(input);
    for (const step of BASIC_STEPS) {
      try { await step(ctx); }
      catch (e) {
        try { console.warn("[proactive] basic step failed:", e); } catch {}
      }
    }
    ctx.result.questions = ctx.remainingQuestions;
    ctx.result.dropdowns = ctx.remainingDropdowns;
    return ctx.result;
  }

  ns.pipeline.basic = {
    BASIC_STEPS,
    runBasic,
    createContext,
    recordFill,
  };
})();
