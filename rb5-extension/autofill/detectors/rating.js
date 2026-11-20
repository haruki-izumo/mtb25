/* =====================================================================
 * detectors/rating.js — self-rating fields ("rate 1-10").
 * =====================================================================
 * Fills with 8 across text/number inputs, numeric dropdowns, and 1..10
 * radio groups. 10 reads boastful and trips bias filters on some
 * ATSes; 7–10 reads honest. Rating-style TEXTAREAS are handled by
 * detectors/questions.js (they need bullet-list LLM answers, not a
 * single digit). ==================================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill) return;
  const ns = window.ProactiveAutofill;
  if (!ns.core?.dom || !ns.core?.reactInput || !ns.detectors?.questions) return;
  const { isVisible, labelTextFor } = ns.core.dom;
  const { setReactInputValue } = ns.core.reactInput;
  const { RATING_LABEL_LOOKS } = ns.detectors.questions;

  const RATING_DEFAULT_VALUE = "8";
  const TEXT_SEL =
    'input[type="text"], input[type="number"], input[type="date"], input[type="search"], input:not([type])';

  /** Helper used by the bare-text-input pass: dropdown SEARCH inputs
   *  are owned by the dropdown preset pass. */
  function isDropdownSearchInput(el) {
    return (
      el.getAttribute("role") === "combobox" ||
      el.getAttribute("aria-haspopup") === "listbox" ||
      el.getAttribute("aria-haspopup") === "menu" ||
      el.getAttribute("aria-autocomplete") === "list" ||
      !!el.closest('[class*="select__"], [role="combobox"], [role="listbox"], select')
    );
  }

  /**
   * Fill every rating-style text/number input with the default value.
   * Returns an array of preset-fill records the caller appends to
   * its FillResult.presetFilled.
   * @param {Document} doc
   * @param {WeakSet<Element>} alreadyTouched
   * @param {(el:Element, prev:string)=>void} recordFill
   */
  function fillRatingTextInputs(doc, alreadyTouched, recordFill) {
    const root = doc || (typeof document !== "undefined" ? document : null);
    if (!root) return [];
    const out = [];
    for (const el of root.querySelectorAll(TEXT_SEL)) {
      if (!isVisible(el)) continue;
      if (alreadyTouched && alreadyTouched.has(el)) continue;
      if (isDropdownSearchInput(el)) continue;
      const label = labelTextFor(el);
      if (!label || !RATING_LABEL_LOOKS.test(label)) continue;
      const previousValue = el.value;
      if (setReactInputValue(el, RATING_DEFAULT_VALUE)) {
        if (recordFill) recordFill(el, previousValue);
        out.push({ key: "self_rating", label, answer: RATING_DEFAULT_VALUE, via: "text", el });
      }
    }
    return out;
  }

  ns.detectors.rating = {
    RATING_DEFAULT_VALUE,
    isDropdownSearchInput,
    fillRatingTextInputs,
  };
})();
