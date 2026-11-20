/* =====================================================================
 * normalize/language.js — required non-English language detection (pure)
 * =====================================================================
 * Flags a posting that REQUIRES a non-English language ("fluent German",
 * "Polish — native speaker", "must speak French") so the fit verdict can
 * treat it as a blocker for an English-only candidate. "Polish is a
 * plus" and English requirements deliberately do NOT match. Copied
 * VERBATIM from job-fit.js; expects an already-lowercased `hay` (its
 * caller assessFit lowercases). Pure; dual export.
 * ===================================================================== */
(function () {
  "use strict";

  const NON_ENGLISH_LANGUAGES = [
    "polish", "german", "french", "spanish", "italian", "dutch", "portuguese",
    "russian", "ukrainian", "czech", "slovak", "swedish", "norwegian", "danish",
    "finnish", "mandarin", "cantonese", "chinese", "japanese", "korean", "arabic",
    "turkish", "romanian", "hungarian", "greek", "hebrew", "bulgarian", "croatian",
    "serbian", "slovenian", "catalan", "thai", "vietnamese", "indonesian", "hindi",
    "estonian", "latvian", "lithuanian", "icelandic", "luxembourgish", "flemish",
  ];

  function detectLanguageRequirement(hay) {
    for (const lang of NON_ENGLISH_LANGUAGES) {
      const L = lang.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const patterns = [
        new RegExp(`\\b(?:fluent|fluency|proficient|proficiency|native|business[\\s-]?level|c1|c2|b2)\\b[^.\\n]{0,20}\\b${L}\\b`),
        new RegExp(`\\b${L}\\b[^.\\n]{0,20}\\b(?:required|mandatory|essential|a must|fluency|proficiency|native speaker)\\b`),
        new RegExp(`\\b(?:must|should|able to)\\s+speak\\s+${L}\\b`),
        new RegExp(`\\b${L}[\\s-]speaking\\b`),
        // Requirements-list shape: "<Language> — Upper Intermediate or
        // higher", "Russian: B2", "Russian (C1)". A language followed by a
        // separator and a CEFR / proficiency level — no "required"/"fluent"
        // keyword, so the patterns above miss it. (English is never in
        // NON_ENGLISH_LANGUAGES, so "English — Upper Intermediate" is fine.)
        new RegExp(`\\b${L}\\b\\s*[—–:()\\-]+\\s*(?:[abc][12]\\b|upper|pre[\\s-]?intermediate|intermediate|advanced|fluent|proficient|conversational|native|elementary|working|professional)`),
      ];
      if (patterns.some((re) => re.test(hay))) {
        return lang.charAt(0).toUpperCase() + lang.slice(1);
      }
    }
    return "";
  }

  const api = { NON_ENGLISH_LANGUAGES, detectLanguageRequirement };
  if (typeof window !== "undefined" && window.ProactiveJobDetect) {
    window.ProactiveJobDetect.normalize.language = api;
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
