/* =====================================================================
 * handlers/adapters/personio.js — Personio (*.jobs.personio.com).
 * =====================================================================
 * Personio's "DynamicForm" uses content-hashed CSS-module classes
 * (e.g. DynamicForm_textField__r9bZB) that are useless as selectors,
 * but every field control's id is still the stable, un-hashed
 * `field-<key>` — and the system fields (first_name, last_name, email,
 * phone) always use the same English `name` slug regardless of the
 * page's localization (German, etc). That convention is reliable
 * enough to grab contact fields directly instead of leaning on the
 * generic label heuristic, which would otherwise have to fight
 * localized label text.
 *
 * Documents (CV / cover letter / other) are hidden multi-file inputs
 * behind "Add file" buttons, each carrying a stable `doc-input-<cat>`
 * id — grabbing by id instead of a bare `input[type=file]` scan is
 * what tells the CV slot apart from the cover-letter slot (and from
 * any other optional document categories a tenant has enabled). */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill?.pipeline?.registry) return;
  const ns = window.ProactiveAutofill;
  const { isVisible } = ns.core.dom;

  ns.pipeline.registry.registerAdapter({
    name: "Personio",
    hostTest: (h) =>
      /personio\.com$/i.test(h) ||
      (typeof document !== "undefined" &&
        !!document.querySelector('input[id^="field-"], .name-group-container, .document-field-wrapper')),
    detect() {
      const doc = document;
      const m = {};
      const grab = (key, mapKey) => {
        const el = doc.getElementById(`field-${key}`);
        if (el && isVisible(el)) m[mapKey] = el;
      };
      grab("first_name", "first_name");
      grab("last_name", "last_name");
      grab("email", "email");
      grab("phone", "phone");
      grab("location", "location");
      const resume =
        doc.querySelector('input[type="file"]#doc-input-cv') ||
        doc.querySelector('input[type="file"][id^="doc-input-"]');
      if (resume) m.__resumeFile = resume;
      const cover = doc.querySelector('input[type="file"]#doc-input-cover-letter');
      if (cover) m.__coverLetterFile = cover;
      return m;
    },
  });
})();
