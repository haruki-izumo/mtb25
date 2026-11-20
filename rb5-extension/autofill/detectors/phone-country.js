/* =====================================================================
 * detectors/phone-country.js — phone-country picker detection.
 * =====================================================================
 * Finds the country-code dropdown that sits next to a phone input and
 * commits the right country for the candidate's profile.
 *
 * Two paths:
 *   - intlTelInputFastPath: when the phone input lives inside a .iti
 *     wrapper (intl-tel-input v18+), match the option by
 *     data-country-code and click it directly. Bypasses option-text
 *     parsing entirely — most reliable path.
 *   - findPhoneCountryDropdown: generic two-pass DOM walk for every
 *     other picker (react-select, 8am.com Greenhouse-modern,
 *     react-international-phone). Pass 1 looks for obvious dropdown
 *     attributes; Pass 2 falls back to plain <button>/[role=button]
 *     elements whose container chain mentions "country".
 * ==================================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill) return;
  const ns = window.ProactiveAutofill;
  if (!ns.core?.dom || !ns.core?.reactInput) return;
  const { isVisible, wait } = ns.core.dom;
  const { fireOpen } = ns.core.reactInput;

  /** Generic phone-country dropdown finder. Returns the click-target
   *  element (or null). Tries Pass 0 (intl-tel-input family) →
   *  Pass 1 (obvious dropdown attributes) → Pass 2 (plain buttons in
   *  containers that mention "country"). */
  function findPhoneCountryDropdown(phoneInput) {
    if (!phoneInput) return null;
    // PASS 0 — wrapper-aware lookup for the intl-tel-input family.
    const PHONE_WRAPPER_SEL = [
      '[class*="iti"]', '[class*="intl-tel"]', '[class*="IntlTel"]',
      '[class*="phone-input"]', '[class*="PhoneInput"]',
      '[class*="phone-country"]', '[class*="PhoneCountry"]',
      '[class*="react-phone"]', '[class*="ReactPhone"]',
    ].join(",");
    const TELWRAP_TRIGGER_SEL = [
      "select", '[role="combobox"]',
      '[aria-haspopup="listbox"]', '[aria-haspopup="menu"]', '[aria-haspopup="true"]',
      '[class*="selected-flag"]', '[class*="SelectedFlag"]', '[class*="iti__selected"]',
      '[class*="country-select"]', '[class*="CountrySelect"]',
      '[class*="flag-container"]', '[class*="FlagContainer"]',
      'button[type="button"]',
    ].join(",");
    // Climb to the OUTERMOST phone wrapper. Some widgets (Greenhouse's
    // remix phone-input) render the country picker as a react-select in a
    // SIBLING subtree (.phone-input__country) from the intl-tel-input that
    // wraps the number (.phone-input__phone). A single closest() stops at
    // the inner ".phone-input__phone" and only ever sees the iti flag
    // button — which merely MIRRORS the react-select, so setting it leaves
    // the authoritative control (and the submitted value) unchanged.
    let wrapper = null;
    for (let node = phoneInput, i = 0; node && i < 6; i++) {
      const w = node.closest?.(PHONE_WRAPPER_SEL);
      if (!w) break;
      wrapper = w;
      node = w.parentElement;
    }
    if (wrapper) {
      // A real country dropdown (native <select> / react-select control /
      // combobox) is the authoritative form control — return it ahead of
      // the intl-tel-input flag button.
      const REAL_DD = 'select, [class*="select__control"], [role="combobox"]';
      for (const cand of wrapper.querySelectorAll(REAL_DD)) {
        if (cand === phoneInput || cand.contains?.(phoneInput) || phoneInput.contains?.(cand)) continue;
        if (!isVisible(cand)) continue;
        return cand.closest('[class*="select__control"]') || cand;
      }
      const inside = wrapper.querySelectorAll(TELWRAP_TRIGGER_SEL);
      for (const cand of inside) {
        if (cand === phoneInput || cand.contains?.(phoneInput) || phoneInput.contains?.(cand)) continue;
        if (!isVisible(cand)) continue;
        return cand;
      }
    }
    const OBVIOUS_SEL = [
      "select", '[role="combobox"]',
      '[aria-haspopup="listbox"]', '[aria-haspopup="menu"]', '[aria-haspopup="true"]',
      '[class*="select__control"]', '[class*="select__value-container"]',
      '[class*="country-select"]', '[class*="CountrySelect"]',
      '[class*="phone-country"]', '[class*="PhoneCountry"]',
      '[class*="selected-flag"]', '[class*="SelectedFlag"]', '[class*="iti__selected"]',
    ].join(",");
    const BUTTON_SEL = ["button", '[role="button"]', '[class*="dropdown"]', '[class*="Dropdown"]', "[tabindex]"].join(",");
    const COUNTRY_RE = /\b(country|kraj|land|país|pays|nation)\b/i;
    const sharedAncestor = (cand) =>
      cand.parentElement === phoneInput.parentElement ||
      cand.parentElement?.parentElement === phoneInput.parentElement ||
      phoneInput.parentElement?.parentElement === cand.parentElement ||
      (cand.parentElement && phoneInput.parentElement &&
        cand.parentElement.parentElement === phoneInput.parentElement.parentElement);

    // Pass 1: obvious triggers.
    let p = phoneInput.parentElement;
    for (let i = 0; i < 5 && p; i++) {
      for (const cand of p.querySelectorAll(OBVIOUS_SEL)) {
        if (cand === phoneInput || cand.contains?.(phoneInput) || phoneInput.contains?.(cand)) continue;
        if (!isVisible(cand)) continue;
        if (sharedAncestor(cand)) return cand;
      }
      p = p.parentElement;
    }
    // Pass 2: plain buttons whose container text mentions "country".
    p = phoneInput.parentElement;
    for (let i = 0; i < 5 && p; i++) {
      for (const cand of p.querySelectorAll(BUTTON_SEL)) {
        if (cand === phoneInput || cand.contains?.(phoneInput) || phoneInput.contains?.(cand)) continue;
        if (!isVisible(cand)) continue;
        const type = (cand.getAttribute("type") || "").toLowerCase();
        if (type === "submit") continue;
        const btnText = (cand.textContent || "").trim();
        if (/^(submit|apply|next|continue|cancel|dropbox|google drive|enter manually|attach)$/i.test(btnText)) continue;
        if (!sharedAncestor(cand)) continue;
        let containerText = (cand.getAttribute("aria-label") || "") + " " + btnText;
        let c = cand.parentElement;
        for (let j = 0; j < 5 && c; j++) {
          containerText += " " + (c.innerText || c.textContent || "").slice(0, 400);
          c = c.parentElement;
        }
        if (COUNTRY_RE.test(containerText)) return cand;
      }
      p = p.parentElement;
    }
    return null;
  }

  /** intl-tel-input v18+ fast path. Returns true ONLY when the target
   *  country is confirmed selected (caller can then skip the generic
   *  findPhoneCountryDropdown flow). Returns false when the wrapper isn't
   *  an iti widget OR the commit couldn't be verified — so the caller
   *  falls through to the generic picker path.
   *
   *  Why the verification + retry: the option is matched by
   *  data-country-code (ISO), which is unambiguous — but the CLICK is
   *  timing-sensitive. The dropdown opens a beat after the first gesture,
   *  and search-input variants re-render the list, so a single fixed wait
   *  intermittently misses. When it misses, the widget keeps whichever
   *  country it defaulted to — and for a shared dial code that default is
   *  the alphabetically-first entry (e.g. +358 → "Åland Islands" before
   *  "Finland"), i.e. the "sometimes wrong country" the user reported.
   *  Verify by the committed FLAG (iti__<iso>) or the country NAME in the
   *  trigger's aria-label/title — never by the dial code, since +358 is
   *  shared and would falsely "confirm" Åland when Finland was intended. */
  async function intlTelInputFastPath(phoneInput, country) {
    if (!phoneInput || !country?.iso) return false;
    const itiWrapper = phoneInput.closest('.iti, [class~="iti"]');
    if (!itiWrapper) return false;
    const iso = country.iso.toLowerCase();
    const trigger =
      itiWrapper.querySelector(".iti__selected-country") ||
      itiWrapper.querySelector('[class*="iti__selected"], [class*="selected-flag"]');
    if (!trigger) return false;

    // iti v18 may portal the list to <body>; look inside the wrapper
    // first, then fall back to any on-page iti list.
    const findOption = () =>
      itiWrapper.querySelector(`li[data-country-code="${iso}"]`) ||
      document.querySelector(
        `.iti__country-list li[data-country-code="${iso}"], ` +
        `ul[id*="country-listbox"] li[data-country-code="${iso}"]`,
      );
    if (!findOption()) return false;

    // Is the target country already the committed selection? (Verify by
    // flag sprite class or the country name in aria-label/title — NOT the
    // dial code, which collides across countries.)
    const nameRe = country.name
      ? new RegExp("\\b" + country.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i")
      : null;
    const committed = () => {
      const flag = trigger.querySelector('[class*="iti__flag"]') || trigger;
      if (flag.classList && flag.classList.contains("iti__" + iso)) return true;
      if (nameRe) {
        const label =
          (trigger.getAttribute("aria-label") || "") + " " +
          (trigger.getAttribute("title") || "");
        if (nameRe.test(label)) return true;
      }
      return false;
    };
    if (committed()) return true;

    for (let attempt = 0; attempt < 3; attempt++) {
      fireOpen(trigger);
      // Wait for the list to open and the target option to be clickable.
      let option = null;
      for (let i = 0; i < 16; i++) {
        option = findOption();
        if (option && isVisible(option)) break;
        await wait(50);
      }
      if (!option) { await wait(60); continue; }
      try { option.scrollIntoView?.({ block: "nearest" }); } catch { /* jsdom */ }
      fireOpen(option);
      // Confirm the commit landed before claiming success.
      for (let i = 0; i < 10; i++) {
        if (committed()) return true;
        await wait(50);
      }
      await wait(60); // let any open dialog settle before the next attempt
    }
    return committed();
  }

  ns.detectors.phoneCountry = {
    findPhoneCountryDropdown,
    intlTelInputFastPath,
  };
})();
