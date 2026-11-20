/* =====================================================================
 * detectors/consent.js — Privacy / Terms / "I agree" checkboxes.
 * =====================================================================
 * Every application form has one or two consent checkboxes. They're
 * functionally always-yes (the form can't be submitted otherwise).
 * Detection walks up to 6 ancestor levels looking for one whose text
 * matches the consent regex, so the Greenhouse pattern (label says
 * only "Confirm" while the privacy sentence sits in a sibling <p>)
 * still matches. Multi-option groups (referral source, languages) are
 * deliberately skipped so we don't mass-tick "Select all that apply"
 * lists. ============================================================ */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill) return;
  const ns = window.ProactiveAutofill;
  if (!ns.core?.dom) return;
  const { isVisible, labelTextFor } = ns.core.dom;

  const CONSENT_RE =
    /\b(i\s+(?:have\s+)?(?:read|agree|accept|consent|acknowledge|confirm|understand)|by\s+(?:submitting|applying|checking)|privacy\s+(?:notice|policy|statement)|terms?\s+(?:and|&)\s+conditions?|data\s+(?:processing|protection)|gdpr|consent\s+to\s+(?:the|having)|opt\s+in|agreement\s+to\s+the)/i;

  /**
   * Tick every consent / privacy / terms checkbox on the page.
   * Records touched elements via `recordFill` so the pipeline can
   * include them in the result + highlight them.
   * @param {Document} [doc=document]
   * @param {(el: Element, prev: boolean) => void} [recordFill]
   * @returns {Array<{key:"consent", label:string, answer:"checked", via:"checkbox", el:Element}>}
   */
  function fillConsentCheckboxes(doc, recordFill) {
    const root = doc || (typeof document !== "undefined" ? document : null);
    if (!root) return [];
    const out = [];
    const groupCount = new Map();
    for (const el of root.querySelectorAll('input[type="checkbox"]')) {
      if (!el.name) continue;
      groupCount.set(el.name, (groupCount.get(el.name) || 0) + 1);
    }
    for (const el of root.querySelectorAll('input[type="checkbox"]')) {
      if (!isVisible(el) || el.disabled || el.readOnly) continue;
      if (el.checked) continue;
      // Skip multi-option groups.
      if (el.name && (groupCount.get(el.name) || 0) > 1) continue;

      const lbl = labelTextFor(el);
      let ctx = lbl || "";
      let matched = ctx && CONSENT_RE.test(ctx);
      if (!matched) {
        let p = el.parentElement;
        for (let i = 0; i < 6 && p; i++) {
          const txt = (p.innerText || p.textContent || "").trim();
          if (txt && txt.length < 800 && CONSENT_RE.test(txt)) {
            ctx = txt;
            matched = true;
            break;
          }
          p = p.parentElement;
        }
      }
      if (!matched) continue;

      const previousValue = el.checked;
      try {
        el.click();
      } catch {
        try {
          el.checked = true;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } catch {/* non-fatal */}
      }
      if (el.checked) {
        if (recordFill) recordFill(el, previousValue);
        out.push({
          key: "consent",
          label: (lbl || ctx).replace(/\s+/g, " ").slice(0, 120),
          answer: "checked",
          via: "checkbox",
          el,
        });
      }
    }
    return out;
  }

  ns.detectors.consent = {
    CONSENT_RE,
    fillConsentCheckboxes,
  };
})();
