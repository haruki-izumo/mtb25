/* =====================================================================
 * detectors/dropdowns.js — custom dropdown detection + selection.
 * =====================================================================
 * Three responsibilities:
 *   - detectCustomDropdowns: enumerate every visible dropdown on the page
 *     (native <select>, react-select, ARIA combobox, headless-UI listbox).
 *   - captureCustomDropdownOptions: open a custom dropdown to read its
 *     option list when the options aren't pre-rendered (the common case).
 *   - selectDropdownOption: open a dropdown and click the option whose
 *     text matches a target — exact → substring → token-overlap.
 *
 * Battle-tested across 30+ patches. The mousedown sequence and post-
 * click blur are critical for react-select / Formik forms — don't
 * simplify them without testing. ==================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill) return;
  const ns = window.ProactiveAutofill;
  if (!ns.core?.dom || !ns.core?.reactInput) return;
  const { isVisible, labelTextFor, makeTempId, wait, PLACEHOLDER_RE, cssEscape } = ns.core.dom;
  const { fireOpen, fireBlur, setReactInputValue } = ns.core.reactInput;

  const DROPDOWN_TRIGGER_SELECTORS = [
    "select",
    '[role="combobox"]',
    '[class*="select__control"]',
    '[class*="select__value-container"]',
    '[aria-haspopup="listbox"]',
    // BambooHR "fabric" Select — a <button class="fab-SelectToggle"
    // aria-haspopup="true"> facade over a hidden <select>. The hidden
    // select is opacity:0/0×0 so isVisible() rejects it, and the button
    // uses aria-haspopup="true" (not "listbox"), so neither was detected.
    '[class*="fab-SelectToggle"]',
  ].join(",");

  /** @returns {Array<{trigger: HTMLElement, label: string, options: Array<{value:string,text:string}>, isNative: boolean, id: string}>} */
  function detectCustomDropdowns(doc) {
    const root = doc || (typeof document !== "undefined" ? document : null);
    if (!root) return [];
    const seen = new WeakSet();
    const out = [];
    root.querySelectorAll(DROPDOWN_TRIGGER_SELECTORS).forEach((trigger) => {
      // React-select renders a .select__control wrapper containing an
      // input[role="combobox"] — both match the trigger selector, so
      // we de-dupe by preferring the visible wrapper.
      // BambooHR fabric Select: the clickable facade is the
      // .fab-SelectToggle button; the real field + <label for> live on the
      // hidden <select> in the same .fab-Select container. Use the button
      // as the trigger and read the label from that hidden select.
      const fabHit = trigger.closest('[class*="fab-SelectToggle"]');
      if (fabHit) {
        // The class prefix "fab-SelectToggle" is shared by the button AND
        // its __container/__guts/__placeholder descendants, so several
        // elements per widget match. Normalise to the single <button> so
        // `seen` de-dupes them into one dropdown.
        const fabToggle = fabHit.closest('button[class*="fab-SelectToggle"]')
          || fabHit.querySelector?.('button[class*="fab-SelectToggle"]')
          || (fabHit.tagName === "BUTTON" ? fabHit : null);
        if (!fabToggle) return;
        if (seen.has(fabToggle)) return;
        seen.add(fabToggle);
        if (!isVisible(fabToggle)) return;
        const container = fabToggle.closest('.fab-Select, [data-fabric-component="Select"]') || fabToggle.parentElement;
        const hiddenSel = container && container.querySelector('select');
        let label = "";
        if (hiddenSel && hiddenSel.id) {
          const lbl = root.querySelector(`label[for="${cssEscape(hiddenSel.id)}"]`);
          if (lbl) label = (lbl.textContent || "").replace(/[\s*  ]+$/, "").trim();
        }
        if (!label) label = labelTextFor(fabToggle);
        if (!label) return;
        out.push({ trigger: fabToggle, label, options: [], isNative: false, id: makeTempId(fabToggle) });
        return;
      }
      const top =
        trigger.closest('[class*="select__control"]') ||
        trigger.closest("select") ||
        trigger.closest('[role="combobox"]') ||
        trigger;
      if (seen.has(top)) return;
      seen.add(top);
      if (!isVisible(top)) return;
      const label = labelTextFor(top);
      if (!label) return;
      // Native <select>.
      if (top.tagName === "SELECT") {
        const options = [...top.options]
          .map((o) => ({ value: o.value, text: (o.text || "").trim() }))
          .filter((o) => o.text && !PLACEHOLDER_RE.test(o.text));
        out.push({ trigger: top, label, options, isNative: true, id: makeTempId(top) });
        return;
      }
      // ARIA / react-select — try to read options without opening.
      const owns = top.getAttribute("aria-owns") || top.getAttribute("aria-controls");
      let optionEls = [];
      if (owns) {
        const listbox = root.getElementById(owns);
        if (listbox) optionEls = [...listbox.querySelectorAll('[role="option"], li')];
      }
      if (optionEls.length === 0) {
        const wrap =
          top.closest('.field, [class*="field"], [class*="form-control"], [class*="select__"]') ||
          top.parentElement;
        if (wrap) {
          optionEls = [...wrap.querySelectorAll('[role="option"], li[role], [class*="select__option"]')];
        }
      }
      const options = optionEls
        .map((o) => ({ value: o.getAttribute("data-value") || o.textContent.trim(), text: o.textContent.trim() }))
        .filter((o) => o.text);
      out.push({ trigger: top, label, options, isNative: false, id: makeTempId(top) });
    });
    return out;
  }

  /** Open a custom dropdown to read its option text, then close. */
  async function captureCustomDropdownOptions(dropdown) {
    if (!dropdown || dropdown.isNative || !dropdown.trigger) return [];
    const doc = dropdown.trigger.ownerDocument || document;
    try {
      const trigger = dropdown.trigger;
      trigger.focus?.();
      trigger.click();
      await wait(220);
      const collect = () => {
        const seen = new Set();
        const out = [];
        // Mirror the broadened OPT_SEL in selectDropdownOption so what
        // we DETECT here is exactly what we can COMMIT later.
        const SEL = [
          '[role="option"]',
          '[role="menuitem"]',
          '[role="listbox"] li',
          '[role="listbox"] [role="presentation"]',
          '[role="menu"] li',
          '[data-radix-collection-item]',
          '[class*="select__option"]',
          '[class*="dropdown-item"]',
          '[class*="DropdownItem"]',
          '[class*="MenuItem"]',
          '[class*="ListItem"]',
          '[class*="Option_"]',
          '[class*="fab-Menu"] [role="menuitem"]',
          '[class*="fab-Menu"] button',
          '[class*="MenuOption"]',
        ].join(", ");
        for (const el of doc.querySelectorAll(SEL)) {
          if (!isVisible(el)) continue;
          const txt = (el.textContent || "").trim();
          if (!txt || seen.has(txt)) continue;
          seen.add(txt);
          out.push(txt);
        }
        return out;
      };
      let options = collect();
      if (!options.length) {
        try {
          trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true }));
        } catch {/* non-fatal */}
        await wait(220);
        options = collect();
      }
      // Close the menu so we don't leave it stuck open mid-fill.
      try {
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      } catch {/* non-fatal */}
      doc.body.click();
      await wait(80);
      return options;
    } catch (e) {
      try { console.warn("[proactive] captureCustomDropdownOptions failed:", e); } catch {}
      return [];
    }
  }

  /** Shared 3-tier option matcher. Walks candidates from the
   *  strictest match (exact) down to the loosest (token overlap) so
   *  every dropdown shape — native <select>, react-select, Radix,
   *  Mantine, generic styled — uses identical commit semantics. The
   *  caller passes a candidate list shaped {key, text, value} where
   *  `key` is what the caller wants returned (DOM element, <option>,
   *  whatever). Returns the matched candidate or null.
   *
   *  Tiers, in order:
   *    1. Exact text match (case-insensitive, whitespace-normalised).
   *    2. Exact value match (native <select> only — caller may set
   *       value = "" for options without one).
   *    3. Word-boundary substring in either direction: "Male" matches
   *       "Male (He/Him)" but NOT "Female". "Advanced" matches
   *       "C1 - Advanced (fluent)" and vice-versa.
   *    4. ≥50% token overlap as a last-resort fuzzy fallback. */
  function matchOption(candidates, wantedText) {
    if (!candidates || candidates.length === 0) return null;
    const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wantNorm = norm(wantedText);
    if (!wantNorm) return null;
    // Tier 1 — exact text.
    let m = candidates.find((c) => norm(c.text) === wantNorm);
    if (m) return m;
    // Tier 2 — exact value (only meaningful when candidate carries a
    // distinct .value, e.g. native <option>).
    m = candidates.find((c) => c.value && String(c.value).toLowerCase() === wantNorm);
    if (m) return m;
    // Tier 3 — word-boundary substring either direction.
    const wantRe = new RegExp(`\\b${escRe(wantNorm)}\\b`);
    m = candidates.find((c) => {
      const n = norm(c.text);
      if (!n) return false;
      if (wantRe.test(n)) return true;
      const optRe = new RegExp(`\\b${escRe(n)}\\b`);
      return optRe.test(wantNorm);
    });
    if (m) return m;
    // Tier 4 — ≥50% token overlap, best score wins.
    const wantTokens = new Set(wantNorm.split(/\W+/).filter((t) => t.length >= 2));
    if (!wantTokens.size) return null;
    let best = null, bestScore = 0;
    for (const c of candidates) {
      const tokens = new Set(norm(c.text).split(/\W+/).filter((t) => t.length >= 2));
      let overlap = 0;
      for (const t of wantTokens) if (tokens.has(t)) overlap++;
      if (overlap / wantTokens.size >= 0.5 && overlap > bestScore) {
        best = c; bestScore = overlap;
      }
    }
    return best;
  }

  /** The option a menu currently highlights (keyboard-focused / active),
   *  or null. Used to decide whether a blind Enter is safe — committing
   *  the highlighted row is only correct when that row is the one we want.
   *  Covers the ARIA combobox (aria-activedescendant on the input) plus the
   *  common highlight markers: react-select `--is-focused`, Radix/MUI
   *  `data-highlighted`, `aria-selected`, and generic `.active/.highlighted`. */
  function highlightedOption(menu, trigger, searchInput, doc) {
    const d = doc || (trigger && trigger.ownerDocument) || document;
    const inp = searchInput
      || (trigger && trigger.matches && trigger.matches("input") ? trigger : null)
      || (trigger && trigger.querySelector?.("input[aria-activedescendant]"))
      || trigger;
    const adId = inp && inp.getAttribute && inp.getAttribute("aria-activedescendant");
    if (adId) {
      try { const el = d.getElementById(adId); if (el) return el; } catch { /* bad id */ }
    }
    if (menu && menu.querySelector) {
      return menu.querySelector(
        '[class*="is-focused"], [class*="isFocused"], [class*="--focused"], ' +
        '[class*="--highlighted"], [class*="isHighlighted"], [class*="Highlighted"], ' +
        '[data-highlighted], [aria-selected="true"], .active, .highlighted, .focused',
      ) || null;
    }
    return null;
  }

  /** Pick an option by text. Returns true on success. */
  async function selectDropdownOption(dropdown, wantedText) {
    if (!dropdown || !wantedText) return false;
    const want = String(wantedText).trim().toLowerCase();
    // Native <select>: route through the shared 3-tier matcher so
    // long-form options ("No, I do not have a disability and have
    // not had one in the past") match short synonyms ("No") via
    // word-boundary substring — previously the matcher only did
    // exact equality and silently bailed.
    if (dropdown.isNative) {
      const sel = dropdown.trigger;
      const candidates = [...sel.options]
        // Drop the placeholder "Select ..." so we don't accidentally
        // pick it as a token-overlap winner.
        .filter((o) => o.value || !PLACEHOLDER_RE.test(o.text || ""))
        .map((o) => ({ key: o, text: o.text || "", value: o.value || "" }));
      const matched = matchOption(candidates, want);
      if (!matched) return false;
      // Commit through the NATIVE <select> value setter, not a plain
      // `sel.value =`. A React/Vue-controlled <select> (Greenhouse's new
      // job-boards UI) shadows the value property with its own tracker;
      // a plain assignment updates that tracker too, so the dispatched
      // change reads as "no change" and the widget snaps back to
      // "Select…" — the reported "White won't stay selected". The
      // prototype setter bypasses the tracker so onChange sees a real
      // change. selectedIndex is set too for libs that read it.
      const view = (sel.ownerDocument && sel.ownerDocument.defaultView) || window;
      try {
        const nativeSet = Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, "value")?.set;
        if (nativeSet) nativeSet.call(sel, matched.key.value);
        else sel.value = matched.key.value;
      } catch { sel.value = matched.key.value; }
      try { if (typeof matched.key.index === "number") sel.selectedIndex = matched.key.index; } catch { /* non-fatal */ }
      // Some React form libs (Greenhouse v2, Lever) listen on input;
      // others (older Formik) on change. Fire both, plus focus/blur
      // so re-validation kicks in and the "Required" red border clears.
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      try { sel.focus(); sel.blur(); } catch { /* non-fatal */ }
      return true;
    }
    const doc = dropdown.trigger.ownerDocument || document;
    try {
      dropdown.trigger.focus?.();
      fireOpen(dropdown.trigger);
      // Cover Radix UI ([role="menuitem"], [data-radix-collection-item]),
      // Headless UI ([role="option"] but also bare <li> inside a listbox),
      // Mantine / Chakra / generic styled dropdowns ([class*=dropdown-item],
      // [class*=MenuItem], [class*=Option]), and any <li>/<button>/<div>
      // sitting inside a role=listbox|menu container. Without this many
      // job-board dropdowns (Rippling, Greenhouse v2, etc.) opened on
      // trigger click but their plain <li> options were invisible to
      // the matcher — leaving the dropdown stuck open with no commit.
      const OPT_SEL = [
        '[role="option"]',
        '[role="menuitem"]',
        '[role="listbox"] li',
        '[role="listbox"] [role="presentation"]',
        '[role="menu"] li',
        '[data-radix-collection-item]',
        '[class*="select__option"]',
        '[class*="dropdown-item"]',
        '[class*="DropdownItem"]',
        '[class*="MenuItem"]',
        '[class*="ListItem"]',
        '[class*="Option_"]',
        '[class*="fab-Menu"] [role="menuitem"]',
        '[class*="fab-Menu"] button',
        '[class*="MenuOption"]',
        'li[data-country]',
        '[class*="country-selector-dropdown__list-item"]',
      ].join(", ");
      /** The menu THIS control owns, if we can identify it. A
       *  document-wide option sweep also picks up any OTHER dropdown whose
       *  menu is still open (e.g. an earlier field that failed to close),
       *  and then matches against the wrong option list entirely. */
      const ownMenu = () => {
        const idOf = (el) => el && (el.getAttribute("aria-controls") || el.getAttribute("aria-owns"));
        let id = idOf(dropdown.trigger);
        if (!id) {
          const inner = dropdown.trigger.querySelector?.("input[aria-controls], input[aria-owns]");
          id = idOf(inner);
        }
        // BambooHR fabric Select: the toggle button carries data-menu-id,
        // and the popup renders (in a portal) as [id=…] / [data-menu-id=…].
        const menuId = (dropdown.trigger.getAttribute && dropdown.trigger.getAttribute("data-menu-id"))
          || (dropdown.trigger.querySelector?.("[data-menu-id]")?.getAttribute("data-menu-id"));
        for (const cand of [id, menuId]) {
          if (!cand) continue;
          try { const byId = doc.getElementById(cand); if (byId) return byId; } catch { /* bad id */ }
          const byAttr = doc.querySelector(`[data-menu-id="${cssEscape(cand)}"][role], [id="${cssEscape(cand)}"], [aria-labelledby="${cssEscape(cand)}"]`);
          if (byAttr && byAttr !== dropdown.trigger) return byAttr;
        }
        // react-select renders .select__menu as a sibling of the control.
        const wrap = dropdown.trigger.parentElement;
        return (wrap && wrap.querySelector?.('[class*="select__menu"], [role="listbox"], [class*="fab-Menu" i]')) || null;
      };
      const collect = () => {
        const scope = ownMenu();
        if (scope) {
          let mine = [...scope.querySelectorAll(OPT_SEL)].filter(isVisible);
          // Menu found but its items carry an unfamiliar class/role (some
          // BambooHR fabric menus): fall back to the menu's leaf clickables
          // — buttons/links/[role]/list items/short-text divs.
          if (!mine.length) {
            mine = [...scope.querySelectorAll('button, a, li, [role="option"], [role="menuitem"], [class*="option" i], [class*="Option" i], [tabindex]')]
              .filter((el) => isVisible(el) && (el.textContent || "").trim() && !el.querySelector('button, a, li, [role="option"], [role="menuitem"]'));
          }
          if (mine.length) return mine;
        }
        return [...doc.querySelectorAll(OPT_SEL)].filter(isVisible);
      };
      // Same 3-tier matcher native <select> uses; returns null on no hit.
      const scoreMatch = (els) => els.length
        ? matchOption(els.map((el) => ({ key: el, text: el.textContent || "", value: "" })), want)
        : null;
      const searchInput = (dropdown.trigger.matches && dropdown.trigger.matches("input"))
        ? dropdown.trigger
        : (dropdown.trigger.querySelector?.("input") || null);

      // POLL for the menu to render rather than waiting a single fixed
      // interval — react-select / SPA EEO sections ("Please identify your
      // race") render their options asynchronously, and one fixed wait
      // intermittently fired BEFORE they appeared, so the field filled
      // "sometimes". Stop as soon as an option matches.
      let optionEls = [];
      let matchedOption = null;
      for (let i = 0; i < 12 && !matchedOption && !optionEls.length; i++) {
        await wait(i === 0 ? 140 : 70);
        optionEls = collect();
        matchedOption = scoreMatch(optionEls);
      }
      // Opened but nothing rendered — nudge with ArrowDown, keep polling.
      // Aim the key at the inner combobox INPUT when there is one:
      // react-select owns its keyboard handling there, and a keydown
      // dispatched on the control div is a DESCENDANT-less event that
      // never reaches it. Focusing first matters too — an unfocused
      // react-select ignores ArrowDown.
      if (!optionEls.length) {
        const keyTarget = searchInput || dropdown.trigger;
        try { keyTarget.focus?.(); } catch {/* non-fatal */}
        for (const el of new Set([keyTarget, dropdown.trigger])) {
          try {
            el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", keyCode: 40, which: 40, bubbles: true }));
          } catch {/* non-fatal */}
        }
        for (let i = 0; i < 8 && !optionEls.length; i++) { await wait(80); optionEls = collect(); }
        matchedOption = scoreMatch(optionEls);
      }
      // Still nothing AND the control isn't already open — some pickers
      // wrap the clickable target in an inner button. Guard on
      // aria-expanded so we never TOGGLE a slow-but-open react-select
      // menu shut (which was one way the fill flaked out).
      const ariaExpanded = () => {
        const inp = dropdown.trigger.querySelector?.("input");
        return String((inp && inp.getAttribute("aria-expanded")) || dropdown.trigger.getAttribute("aria-expanded") || "").toLowerCase() === "true";
      };
      if (!optionEls.length && !ariaExpanded()) {
        const inner = dropdown.trigger.querySelector?.("button, [role='button']");
        if (inner && inner !== dropdown.trigger) {
          fireOpen(inner);
          for (let i = 0; i < 8 && !optionEls.length; i++) { await wait(80); optionEls = collect(); }
          matchedOption = scoreMatch(optionEls);
        }
      }
      // Searchable / async react-select (Greenhouse School/Degree backed
      // by a schools DB, Rippling "Pronouns"): OPEN shows NOTHING, or a
      // DEFAULT list that does not contain the wanted item. Whenever the
      // current options don't match, TYPE the query into the inner
      // combobox input, wait for the (async, network-backed) results, and
      // re-match against THOSE. Previously we only typed when open
      // produced ZERO options — so a School field that opened on a
      // default list (e.g. "Atlanta College of Arts") never searched for
      // the profile's actual school and committed the wrong one / nothing.
      if (!matchedOption) {
        // The search box may live INSIDE the popup menu (BambooHR
        // fab-Select's portal, some MUI menus) rather than in the trigger.
        // Look there too — a big virtualised list (all countries) only
        // renders the wanted row once it's typed/filtered.
        let searchEl = searchInput;
        if (!searchEl) {
          const m = ownMenu();
          searchEl = m && m.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])');
        }
        if (searchEl) {
          try { searchEl.focus?.(); } catch {/* non-fatal */}
          setReactInputValue(searchEl, String(wantedText));
          try {
            searchEl.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
            searchEl.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
          } catch {/* non-fatal */}
          for (let i = 0; i < 24 && !matchedOption; i++) {
            await wait(90);
            matchedOption = scoreMatch(collect());
          }
        }
      }
      // Last resort for a keyboard-only listbox with no search box (some
      // fab-Select menus): type the answer's letters at the open menu so
      // its native typeahead jumps to + highlights the row, then commit
      // with Enter. Only when we still have no clickable match.
      if (!matchedOption) {
        const menu = ownMenu();
        const keyTarget = menu || searchInput || dropdown.trigger;
        if (keyTarget && String(wantedText).trim()) {
          try { keyTarget.focus?.(); } catch {/* non-fatal */}
          for (const ch of String(wantedText).slice(0, 12)) {
            try {
              keyTarget.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true }));
              keyTarget.dispatchEvent(new KeyboardEvent("keypress", { key: ch, bubbles: true }));
              keyTarget.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
            } catch {/* non-fatal */}
          }
          await wait(120);
          matchedOption = scoreMatch(collect());
          if (!matchedOption) {
            // A blind Enter commits whatever the menu highlighted — usually
            // the alphabetically-first row — even when it's WRONG (a Country
            // picker snapping to "Åland Islands" for a US profile). So when
            // we can SEE what's highlighted, only commit it if it actually
            // matches the wanted text; a non-matching highlight is left
            // untouched. When the highlight is undetectable (a pure keyboard
            // listbox / native-typeahead widget — BambooHR's fab-Select —
            // that exposes no highlight marker), fall back to the blind Enter
            // those widgets rely on to commit the row the typeahead landed on.
            const hl = highlightedOption(ownMenu(), dropdown.trigger, searchInput, doc);
            if (hl) {
              const hlMatch = matchOption([{ key: hl, text: hl.textContent || "", value: "" }], want);
              if (hlMatch) matchedOption = hlMatch;
            } else {
              try {
                keyTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
              } catch {/* non-fatal */}
              await wait(120);
            }
          }
        }
      }
      const target = matchedOption?.key || null;
      if (target) {
        // react-select binds option-pick to mousedown, not click.
        // Fire the full pointer sequence.
        fireOpen(target);
        await wait(80);
        // Clear stale "field required" errors by blurring the dropdown's
        // inner input (Formik / react-hook-form etc. re-validate on blur).
        const innerInput = dropdown.trigger.querySelector?.("input") || dropdown.trigger;
        fireBlur(innerInput);
        return true;
      }
      // No match — clear the typed query first so a controlled
      // react-select can't blur-commit the stale/highlighted first option
      // (that's how an unrelated school got selected), then close.
      if (searchInput) { try { setReactInputValue(searchInput, ""); } catch {/* non-fatal */} }
      try {
        dropdown.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      } catch {/* non-fatal */}
      doc.body.click();
      return false;
    } catch (e) {
      try { console.warn("[proactive] selectDropdownOption failed:", e); } catch {}
      return false;
    }
  }

  /** True when `el` is a typeahead / autocomplete text input — a
   *  location box (Google Places, Algolia, react-select-async, Workday
   *  geo) that REQUIRES the user to pick a suggestion; a typed value
   *  alone fails the "Please enter your location" validation on submit. */
  function looksLikeAutocomplete(el) {
    if (!el) return false;
    const ac = (el.getAttribute("aria-autocomplete") || "").toLowerCase();
    if (ac === "list" || ac === "both") return true;
    if ((el.getAttribute("role") || "").toLowerCase() === "combobox") return true;
    if (el.hasAttribute("aria-controls") || el.hasAttribute("aria-owns") || el.hasAttribute("aria-expanded")) return true;
    let n = el;
    for (let i = 0; i < 4 && n; i++) {
      const raw = n.className;
      const cls = raw && raw.baseVal !== undefined ? raw.baseVal : raw;
      if (typeof cls === "string" &&
          /autocomplete|typeahead|geosuggest|\bplaces\b|location-?search|combobox|select__control|\bpac-|algolia|downshift|react-select/i.test(cls)) {
        return true;
      }
      n = n.parentElement;
    }
    return false;
  }

  /** Commit a typeahead selection: the value is already typed into the
   *  input, but the widget only records a real selection when a
   *  SUGGESTION is clicked. Nudge the fetch with a keystroke-shaped
   *  event, wait for the option list, then click the option matching
   *  the typed value (or the first suggestion). Returns true if an
   *  option was clicked. */
  async function commitAutocompleteSelection(input, value) {
    if (!input || !value) return false;
    const doc = input.ownerDocument || document;
    try {
      input.focus?.();
      // Re-assert the value and fire a keystroke so async typeaheads
      // (Algolia / Places / downshift) start fetching suggestions.
      setReactInputValue(input, value);
      try {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "End", bubbles: true }));
      } catch {/* KeyboardEvent unsupported in older runtimes */}
      const OPT_SEL = [
        '[role="option"]',
        '[role="listbox"] li',
        '[class*="option"]', '[class*="Option"]',
        '[class*="suggestion"]', '[class*="Suggestion"]',
        '[class*="autocomplete"] li', '[class*="Autocomplete"] li',
        '[class*="menu"] li', '[class*="Menu"] li',
        '[class*="pac-item"]', '[class*="geosuggest__item"]',
        'li[id*="option"]', 'li[id*="suggestion"]',
      ].join(", ");
      let opts = [];
      for (let i = 0; i < 12 && !opts.length; i++) {
        await wait(60);
        opts = [...doc.querySelectorAll(OPT_SEL)].filter(isVisible);
      }
      if (!opts.length) return false;
      const cands = opts.map((el) => ({ key: el, text: el.textContent || "" }));
      const matched = matchOption(cands, value) || cands[0];
      const target = matched && matched.key;
      if (!target) return false;
      fireOpen(target);
      await wait(60);
      fireBlur(input);
      return true;
    } catch (e) {
      try { console.warn("[proactive] commitAutocompleteSelection failed:", e); } catch {}
      return false;
    }
  }

  ns.detectors.dropdowns = {
    DROPDOWN_TRIGGER_SELECTORS,
    detectCustomDropdowns,
    captureCustomDropdownOptions,
    selectDropdownOption,
    matchOption,
    looksLikeAutocomplete,
    commitAutocompleteSelection,
  };
})();
