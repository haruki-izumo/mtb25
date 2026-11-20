/* =====================================================================
 * handlers/adapters/recruitee.js — Recruitee (*.recruitee.com).
 * =====================================================================
 * Every control in the application form carries a stable
 * `candidate.*` name (the id's trailing `-N` counter and the
 * styled-components `sc-*` classes are NOT stable) — `candidate.name`,
 * `candidate.email`, `candidate.phone`, `candidate.cv` (résumé),
 * `candidate.coverLetterFile`. That's a reliable enough convention to
 * grab contact fields directly instead of the generic label heuristic.
 *
 * What it ALSO needs help with: the whole application form sits inside
 * a Reach-UI "Apply" tab panel that's `display:none` until that tab is
 * clicked — the controls exist in the DOM the entire time but aren't
 * interactable (isVisible() correctly reports them hidden) until then.
 * Clicking the tab synchronously, the same way iCIMS expands its
 * "Show More" toggles before returning, means a fresh page load still
 * finds real fields instead of coming back empty. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "Recruitee",
    hostTest: (h) =>
      /recruitee\.com$/i.test(h) ||
      (typeof document !== "undefined" && !!document.querySelector("#offer-application-form")),
    detect() {
      const doc = document;
      const m = {};
      const applyTab = doc.querySelector('[data-cy="apply-button-nav"], [data-cy="apply-button"]');
      if (applyTab && isVisible(applyTab)) applyTab.click();

      const grab = (name, key) => {
        const el = doc.querySelector(`[name="${name}"]`);
        if (el && isVisible(el)) m[key] = el;
      };
      grab("candidate.name", "full_name");
      grab("candidate.email", "email");
      grab("candidate.phone", "phone");

      const resume = doc.querySelector('input[type="file"][name="candidate.cv"]');
      if (resume) m.__resumeFile = resume;
      const cover = doc.querySelector('input[type="file"][name="candidate.coverLetterFile"]');
      if (cover) m.__coverLetterFile = cover;
      return m;
    },
  });
})();
