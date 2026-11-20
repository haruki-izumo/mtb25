/* =====================================================================
 * handlers/adapters/careerplug.js — CareerPlug (careerplug.com).
 * =====================================================================
 * Contact fields are discovered generically off `label[for]` pairs in
 * the real CareerPlug source itself — the generic detectContact()
 * heuristic already handles those fine on its own.
 *
 * What it DOES need help with: CareerPlug's resume and cover-letter
 * file inputs both render as `input[type=file]` with Rails-generated,
 * non-semantic ids (`app_applicant_attributes_attachments_0_attachment`
 * / `..._1_attachment`) — index 0 happens to be the resume and index 1
 * the cover letter only because CareerPlug always orders those two
 * fieldsets that way; nothing in the id itself says "resume". The
 * reliable signal is the enclosing `<fieldset>`: the resume one
 * carries class "resume-area", the cover-letter one has
 * id="cover_letter". Going straight for those avoids a blind "first
 * file input" fallback getting the two swapped. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "CareerPlug",
    hostTest: (h) =>
      /careerplug\.com$/i.test(h) ||
      (typeof document !== "undefined" && !!document.querySelector("#new_app")),
    detect() {
      const doc = document;
      const m = {};
      const resume = doc.querySelector("fieldset.resume-area input[type=file]");
      if (resume && isVisible(resume)) m.__resumeFile = resume;
      const cover = doc.querySelector("fieldset#cover_letter input[type=file]");
      if (cover && isVisible(cover) && cover !== resume) m.__coverLetterFile = cover;
      return m;
    },
  });
})();
