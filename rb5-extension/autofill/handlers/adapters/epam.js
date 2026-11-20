/* =====================================================================
 * handlers/adapters/epam.js — EPAM careers (careers.epam.com).
 * =====================================================================
 * EPAM's own Next.js careers site, not a third-party ATS. The "Apply"
 * button opens a native `<dialog>` modal holding a DynamicForm whose
 * CSS-module class names are content-hashed (unusable as selectors),
 * but every question wrapper carries a STABLE
 * `data-testid="apply-<key>-field"` plus stable control ids inside it
 * (#name, #surname, #email, #linkedin) and a `#phone` national-number
 * input. That's a real, durable convention worth anchoring on directly
 * rather than leaning on the generic label-matching heuristic, which
 * would otherwise have to fight the hashed class names for a question
 * label.
 *
 * The phone wrapper (`apply-phone-field`) holds TWO controls sharing
 * one question: a country dial-code picker plus the national-number
 * input, addressed here by its own `#phone` id — never "first input in
 * the wrapper", which would land on the picker instead.
 *
 * The CV upload lives under DOM key `file` (`apply-file-field`), not
 * `resume` — EPAM replaces that native input with an attached-file
 * chip once a file is chosen, so this only finds it pre-upload; that's
 * fine, the fill pipeline only needs it once, to attach.
 *
 * The form mounts ASYNC (skeleton placeholders swapped for real
 * controls after a config fetch), but that just means detect() finds
 * nothing until the DOM actually has these ids — no polling needed
 * here, the runtime's own re-detect on DOM mutation covers it. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "EPAM",
    hostTest: (h) =>
      /careers\.epam\.com$/i.test(h) ||
      (typeof document !== "undefined" && !!document.querySelector('form[data-testid="dynamic-form"]')),
    detect() {
      const doc = document;
      const m = {};
      const grabField = (key, mapKey) => {
        const wrapper = doc.querySelector(`[data-testid="apply-${key}-field"]`);
        const el = wrapper && wrapper.querySelector('input:not([type="hidden"]), textarea');
        if (el && isVisible(el)) m[mapKey] = el;
      };
      grabField("name", "first_name");
      grabField("surname", "last_name");
      grabField("email", "email");
      grabField("linkedin", "linkedin");
      // See header comment: the number input is its own #phone id, not just
      // "the input inside apply-phone-field" (that wrapper's first control is
      // the country dial-code picker).
      const phoneWrapper = doc.querySelector('[data-testid="apply-phone-field"]');
      const phone = phoneWrapper && phoneWrapper.querySelector('#phone, input[name="phone"]');
      if (phone && isVisible(phone)) m.phone = phone;
      const resume = doc.querySelector('[data-testid="apply-file-field"] input[type="file"]');
      if (resume) m.__resumeFile = resume;
      return m;
    },
  });
})();
