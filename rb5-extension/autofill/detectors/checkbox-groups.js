/* =====================================================================
 * detectors/checkbox-groups.js — radio + checkbox group detection.
 * =====================================================================
 * Three strategies, applied in order, each handling a real-world ATS
 * pattern. seenInputs is threaded across strategies so we don't return
 * the same group represented two ways:
 *
 *   1. <fieldset> + <legend>    — classic standards-compliant markup.
 *   2. Shared `name=`           — radios in the wild.
 *   3. ARIA role=radiogroup     — SmartRecruiters / Workday / Phenom
 *      hide the actual <input type=radio> (aria-hidden, tabindex=-1)
 *      and use a <div role="radio"> wrapper as the click target. We
 *      treat the wrapper AS the option element — clicking it triggers
 *      the form library's state update.
 * ==================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill) return;
  const ns = window.ProactiveAutofill;
  if (!ns.core?.dom) return;
  const { isVisible, labelTextFor } = ns.core.dom;

  const cssEscape = ns.core.dom.cssEscape;

  // Modern ATSes (Ashby, current Greenhouse/Lever) render the REAL
  // <input type=radio|checkbox> visually hidden — opacity:0 or a 1px
  // sr-only box — behind a styled, clickable <label>. isVisible()
  // rejects the input itself, so the fieldset/name strategies below
  // would never see the group. Treat a hidden real input as SELECTABLE
  // when it has a VISIBLE label proxy (its wrapping <label>, or a
  // label[for=id] that is on-screen): the proxy proves the option is
  // rendered, and input.click() still drives the framework's onChange
  // through the hidden control.
  function visibleProxyFor(input) {
    const enc = input.closest && input.closest("label");
    if (enc && isVisible(enc)) return enc;
    const d = input.ownerDocument;
    if (input.id && d) {
      let lbl = null;
      try { lbl = d.querySelector(`label[for="${cssEscape(input.id)}"]`); } catch { lbl = null; }
      if (lbl && isVisible(lbl)) return lbl;
    }
    return null;
  }
  const isSelectable = (input) => isVisible(input) || !!visibleProxyFor(input);

  function detectCheckboxGroups(doc) {
    const root = doc || (typeof document !== "undefined" ? document : null);
    if (!root) return [];
    const groups = [];
    const seenInputs = new WeakSet();

    // Strategy 1: <fieldset> with <legend>.
    root.querySelectorAll("fieldset").forEach((fs) => {
      const inputs = Array.from(
        fs.querySelectorAll('input[type="checkbox"], input[type="radio"]'),
      ).filter(isSelectable);
      if (inputs.length < 2) return;
      const legend = fs.querySelector("legend");
      const question = legend ? (legend.textContent || "").trim() : "";
      if (!question) return;
      inputs.forEach((i) => seenInputs.add(i));
      groups.push({
        label: question,
        type: inputs[0].type,
        options: inputs.map((input) => ({
          input,
          label: labelTextFor(input) || input.value || "",
        })),
      });
    });

    // Strategy 2: group by shared `name`.
    const byName = new Map();
    root.querySelectorAll('input[type="checkbox"], input[type="radio"]').forEach((input) => {
      if (seenInputs.has(input) || !isSelectable(input)) return;
      const name = input.getAttribute("name") || "";
      if (!name) return;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(input);
    });
    for (const [, inputs] of byName) {
      if (inputs.length < 2) continue;
      const first = inputs[0];
      let parent = first.parentElement;
      let question = "";
      for (let i = 0; i < 6 && parent && parent !== root.body; i++) {
        if (inputs.every((inp) => parent.contains(inp))) {
          const optTexts = new Set(inputs.map((i) => (labelTextFor(i) || "").trim()));
          // querySelectorAll (not querySelector): when each option is
          // itself a <label> (Ashby wraps the hidden input in a styled
          // label), a single querySelector keeps returning the FIRST
          // option label and never reaches the real question heading.
          // Skip any candidate that IS or CONTAINS one of this group's
          // inputs, and any candidate whose text is an option label.
          const heads = parent.querySelectorAll(
            "legend, label[class*='label' i], h1, h2, h3, h4, h5, h6," +
              "[class*='question' i], [class*='label' i]",
          );
          for (const head of heads) {
            if (inputs.some((inp) => head === inp || head.contains(inp))) continue;
            const t = (head.textContent || "").trim();
            if (t && !optTexts.has(t) && t.length >= 3 && t.length <= 400) {
              question = t;
              break;
            }
          }
          if (question) break;
        }
        parent = parent.parentElement;
      }
      if (!question) continue;
      inputs.forEach((i) => seenInputs.add(i));
      groups.push({
        label: question,
        type: first.type,
        options: inputs.map((input) => ({
          input,
          label: labelTextFor(input) || input.value || "",
        })),
      });
    }

    // Strategy 4: paired toggle buttons (Greenhouse / Ashby / Lever
    // Yes-No prompts that aren't radios at all — just two <button>s
    // with click handlers updating React state). Triggered when a
    // container holds exactly 2 visible buttons whose text is "Yes" /
    // "No" / "True" / "False" (the universal toggle pair) AND a
    // label-like sibling exists. Conservative: we don't try to detect
    // 3+-option button rows here — those usually carry semantic role
    // attributes already covered by Strategy 3.
    const TOGGLE_OPT_RE = /^\s*(yes|no|true|false|tak|nie|ja|nein|sí|si|non|oui)\s*$/i;
    const seenToggleContainers = new WeakSet();
    // Hard guardrails — a vanilla <button> defaults to type=submit
    // inside a <form>, so clicking it submits the form. Only treat as
    // a toggle when the button is explicitly safe to click: type=button,
    // role=switch, aria-pressed/aria-checked, or already covered by a
    // proper radiogroup ancestor (let Strategy 3 handle those).
    const isSafeToggleButton = (btn) => {
      if (btn.closest("[role='radiogroup'], [role='radio']")) return false;
      if (btn.tagName === "BUTTON") {
        const t = (btn.getAttribute("type") || "").toLowerCase();
        // An EXPLICIT submit/reset button is a real form action — never a
        // toggle. A bare (untyped) <button> is submit-by-default, but on
        // React ATSes (Ashby/Workable/Rippling) the YES/NO pills are
        // untyped <button>s with an onClick that updates state — dropping
        // them lost real toggles. Strategy 4 only reaches this for a
        // validated 2-button yes/no pair, and toggleCheckbox neutralises
        // the form's submit during the click, so accepting an untyped
        // button here is safe.
        if (t === "submit" || t === "reset") return false;
      }
      return true;
    };
    root.querySelectorAll("button, [role='button']").forEach((btn) => {
      if (!isVisible(btn)) return;
      const txt = (btn.textContent || "").trim();
      if (!TOGGLE_OPT_RE.test(txt)) return;
      if (!isSafeToggleButton(btn)) return;
      // Walk up to a small ancestor that holds exactly 2 toggle-shaped
      // buttons; that ancestor IS the group container.
      let parent = btn.parentElement;
      for (let i = 0; i < 5 && parent && parent !== root.body; i++) {
        if (seenToggleContainers.has(parent)) return;
        const pair = Array.from(parent.querySelectorAll("button, [role='button']"))
          .filter((b) => isVisible(b))
          .filter((b) => TOGGLE_OPT_RE.test((b.textContent || "").trim()));
        if (pair.length === 2) {
          // Find the question label. Search from the button container
          // OUTWARD. The label is often a sibling of the buttons INSIDE
          // the same container (Workable "Were you referred by …" +
          // Yes/No), so we must accept a header inside `parent` too —
          // the old `!parent.contains(head)` gate rejected exactly that
          // layout and the group went undetected. We skip any header
          // that is or wraps a toggle button.
          const HEAD_SEL =
            "legend, label, h1, h2, h3, h4, h5, h6," +
            "[class*='question' i], [class*='label' i], [class*='Label' i], p";
          let question = "";
          let qNode = parent;
          for (let j = 0; j < 6 && qNode && qNode !== root.body; j++) {
            for (const head of qNode.querySelectorAll(HEAD_SEL)) {
              if (pair.some((b) => head === b || head.contains(b) || b.contains(head))) continue;
              const t = (head.textContent || "").trim();
              if (t && t.length >= 3 && t.length <= 400 && !TOGGLE_OPT_RE.test(t)) { question = t; break; }
            }
            if (question) break;
            qNode = qNode.parentElement;
          }
          if (question) {
            seenToggleContainers.add(parent);
            groups.push({
              label: question,
              type: "radio",
              options: pair.map((b) => ({
                input: b,
                label: (b.textContent || "").trim(),
              })),
            });
          }
          break; // either we recorded it or we found a 2-button group
                 // that lacked a label — either way, stop climbing.
        }
        if (pair.length > 2) break; // too noisy to be a yes/no toggle
        parent = parent.parentElement;
      }
    });

    // Strategy 3: ARIA role=radiogroup with hidden inputs (SmartRecruiters).
    root.querySelectorAll('[role="radiogroup"]').forEach((rg) => {
      const wrappers = Array.from(rg.querySelectorAll('[role="radio"]'))
        .filter((w) => w.closest('[role="radiogroup"]') === rg)
        .filter((w) => isVisible(w));
      if (wrappers.length < 2) return;
      const innerInputs = wrappers
        .map((w) => w.querySelector('input[type="radio"], input[type="checkbox"]'))
        .filter(Boolean);
      if (innerInputs.length && innerInputs.every((i) => seenInputs.has(i))) return;
      let question = "";
      const labelledby = rg.getAttribute("aria-labelledby");
      if (labelledby) {
        const ids = labelledby.split(/\s+/).filter(Boolean);
        const parts = [];
        for (const id of ids) {
          const el = root.getElementById(id);
          if (el) {
            const t = (el.textContent || "").trim();
            if (t) parts.push(t);
          }
        }
        question = parts.join(" ").trim();
      }
      if (!question) question = labelTextFor(rg);
      if (!question) {
        const legend = rg.querySelector("legend");
        if (legend) question = (legend.textContent || "").trim();
      }
      if (!question || question.length < 3) return;
      const options = wrappers.map((wrap) => {
        const inner = wrap.querySelector('input[type="radio"], input[type="checkbox"]');
        let lbl = (wrap.textContent || "").trim();
        if (!lbl && inner) lbl = inner.value || "";
        return { input: wrap, label: lbl };
      });
      innerInputs.forEach((i) => seenInputs.add(i));
      groups.push({ label: question, type: "radio", options });
    });

    // Strategy 5: option-set checkboxes/radios WITHOUT a shared `name`.
    // Lever's modern forms (and some React builds) render each option as
    // an independently-named control (name="pron_0", "pron_1", …) under a
    // single visible heading ("Pronouns"). Strategy 2 groups by shared
    // name, so each becomes a size-1 group and is dropped — the cluster
    // is never detected. Here we group the still-unclaimed, short-labelled
    // controls that share the tightest LABELLED ancestor container.
    // Conservative guards keep unrelated checkboxes apart: same input
    // TYPE, ≥3 members, each label ≤60 chars, and the container must
    // yield a real heading that isn't one of the option labels.
    const SHORT_OPT_MAX = 60;
    const shortLabel = (i) => String(labelTextFor(i) || i.value || "").trim().length <= SHORT_OPT_MAX;
    const ungrouped = [...root.querySelectorAll('input[type="checkbox"], input[type="radio"]')]
      .filter((i) => !seenInputs.has(i) && isSelectable(i));
    const claimed = new WeakSet();
    for (const start of ungrouped) {
      if (claimed.has(start) || seenInputs.has(start)) continue;
      const type = start.type;
      let parent = start.parentElement;
      let chosen = null, members = null, question = "";
      // Innermost container that holds ≥3 same-type short-labelled
      // ungrouped controls AND resolves a heading — the tightest
      // labelled cluster, so we never over-grab to the whole <form>.
      for (let i = 0; i < 6 && parent && parent !== root.body; i++) {
        const kin = ungrouped.filter(
          (i2) => i2.type === type && !claimed.has(i2) && parent.contains(i2) && shortLabel(i2),
        );
        if (kin.length >= 3) {
          const optTexts = new Set(kin.map((i2) => (labelTextFor(i2) || "").trim()));
          const heads = parent.querySelectorAll(
            "legend, label[class*='label' i], h1, h2, h3, h4, h5, h6," +
              "[class*='question' i], [class*='label' i]",
          );
          for (const head of heads) {
            if (kin.some((inp) => head === inp || head.contains(inp))) continue;
            const t = (head.textContent || "").trim();
            if (t && !optTexts.has(t) && t.length >= 3 && t.length <= 400) { question = t; break; }
          }
          if (question) { chosen = parent; members = kin; break; }
        }
        parent = parent.parentElement;
      }
      if (!chosen || !members) continue;
      members.forEach((i2) => { claimed.add(i2); seenInputs.add(i2); });
      groups.push({
        label: question,
        type,
        options: members.map((input) => ({ input, label: labelTextFor(input) || input.value || "" })),
      });
    }

    return groups;
  }

  function toggleCheckbox(input, checked) {
    if (!input || input.disabled) return false;
    // Note: role="radio" wrappers (Strategy 3) don't have .checked.
    // We fall through to .click() in that case.
    if (typeof input.checked === "boolean" && !!input.checked === !!checked) return true;
    // Clicking a bare (submit-default) <button> toggle would also submit
    // the enclosing form. Neutralise the form's submit for the duration
    // of the click — the React onClick that flips the YES/NO state still
    // runs; only the accidental navigation is suppressed. Radios /
    // checkboxes / type=button buttons never submit, so this is a no-op
    // for them. Removed on the next tick so a later genuine submit works.
    const isBtn = input.tagName === "BUTTON" || (input.getAttribute && input.getAttribute("role") === "button");
    const form = isBtn ? (input.form || (input.closest && input.closest("form"))) : null;
    const guardSubmit = (e) => { e.preventDefault(); e.stopPropagation(); };
    if (form) {
      try { form.addEventListener("submit", guardSubmit, true); } catch { /* non-fatal */ }
    }
    try { input.click(); }
    catch { if (form) { try { form.removeEventListener("submit", guardSubmit, true); } catch {/* */} } return false; }
    if (form) {
      try {
        const view = input.ownerDocument && input.ownerDocument.defaultView;
        (view || globalThis).setTimeout(() => { try { form.removeEventListener("submit", guardSubmit, true); } catch {/* */} }, 0);
      } catch { try { form.removeEventListener("submit", guardSubmit, true); } catch {/* */} }
    }
    try {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } catch {/* non-fatal */}
    return true;
  }

  /** Pick which option(s) match the preset's candidate answers. Strategy:
   *  exact > prefix > contains.
   *
   *  Radios always take the single best match. Checkboxes tick every
   *  match ONLY when the preset genuinely carries several answers (the
   *  "languages" kind). For a single-answer preset the extra candidates
   *  are alternate PHRASINGS of that one answer, not more answers — so
   *  ticking each match checked two boxes on a "select all that apply"
   *  ethnicity question ("White" + "Asian or Asian American", because
   *  "Asian" sat in the White synonym list). opts.single forces the
   *  best-match-only behaviour for those. */
  function fillCheckboxGroup(group, candidates, opts) {
    if (!group || !group.options || group.options.length === 0) return false;
    const wantList = candidates.filter(Boolean);
    if (wantList.length === 0) return false;
    const wantsLc = wantList.map((w) => String(w).toLowerCase());

    const matchScore = (optLabel) => {
      const lc = String(optLabel || "").toLowerCase();
      for (let i = 0; i < wantsLc.length; i++) {
        const w = wantsLc[i];
        if (!w) continue;
        if (lc === w) return { rank: 3, wantIndex: i };
        if (new RegExp(`^\\s*${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(optLabel)) {
          return { rank: 2, wantIndex: i };
        }
        if (lc.includes(w) || w.includes(lc)) return { rank: 1, wantIndex: i };
      }
      return null;
    };

    let filled = false;
    const onlyBest = group.type === "radio" || !!(opts && opts.single);
    // CANDIDATE priority first, match quality second. candidates[0] is
    // the preset's ACTUAL answer; the rest are fallback phrasings.
    // Ranking by quality first let a later synonym that happened to match
    // exactly beat the real answer — with preferences.ethnicity="Asian",
    // the static "White" synonym exact-matched the White box and won over
    // the "Asian or Asian American" prefix match.
    const ranked = group.options
      .map((opt) => ({ opt, score: matchScore(opt.label) }))
      .filter((x) => x.score)
      .sort((a, b) => a.score.wantIndex - b.score.wantIndex || b.score.rank - a.score.rank);

    if (ranked.length === 0) return false;
    for (const { opt } of ranked) {
      const ok = toggleCheckbox(opt.input, true);
      if (ok) {
        filled = true;
        if (onlyBest) break;
      }
    }
    return filled;
  }

  ns.detectors.checkboxGroups = {
    detectCheckboxGroups,
    toggleCheckbox,
    fillCheckboxGroup,
  };
})();
