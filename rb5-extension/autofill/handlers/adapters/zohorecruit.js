/* =====================================================================
 * handlers/adapters/zohorecruit.js — Zoho Recruit career sites
 * (<tenant>.zohorecruit.com and Zoho's embeddable career-site widget).
 * =====================================================================
 * Zoho Recruit's career site is built with a drag-and-drop form
 * builder: a tenant can freely rename, reorder, or translate every
 * visible field label, so label-text matching alone is fragile here.
 * Underneath, though, each STANDARD field keeps a fixed, cryptic
 * numeric code baked into its `name` attribute regardless of how the
 * tenant relabels it (e.g. "rec-form_063542" for First Name,
 * "...063544" for Last Name, "...063548" for Email, "...063554" for
 * Mobile) — confirmed straight from BidHub's own
 * STANDARD_FIELD_LABELS lookup table. Matching on these codes directly
 * is strictly more reliable than reading the on-page label.
 *
 * Résumé upload is its own special case: it lives in Zoho's
 * `.crc-other-upload` section (shared with optional cover-letter/photo
 * uploads) and carries the fixed code "072325" / the literal
 * "easyresume" token in its name — scoping to that wrapper and code
 * avoids grabbing whichever other upload happens to be first in the
 * DOM. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "Zoho Recruit",
    hostTest: (h) =>
      /\.zohorecruit\.com$/i.test(h) ||
      (typeof document !== "undefined" &&
        (!!document.querySelector(".crc-form-field") || !!document.querySelector(".crc-form-wrapper"))),
    detect() {
      const doc = document;
      const m = {};
      const grabByCode = (code, key) => {
        const el = doc.querySelector(`[name*="${code}"]`);
        if (el && isVisible(el)) m[key] = el;
      };
      grabByCode("063542", "first_name");
      grabByCode("063544", "last_name");
      grabByCode("063548", "email");
      grabByCode("063554", "phone");

      const resume = Array.from(doc.querySelectorAll('.crc-other-upload input[type=file]')).find((input) => {
        const name = input.getAttribute("name") || "";
        if (/072325|easyresume/i.test(name)) return true;
        const wrapper = input.closest(".crc-form-field, .crc-form-row, .crc-form-sec");
        return /\b(resume|cv)\b/i.test(wrapper ? wrapper.textContent : "");
      });
      if (resume) m.__resumeFile = resume;

      return m;
    },
  });
})();
