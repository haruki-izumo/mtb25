/* =====================================================================
 * detectors/questions.js — screening question textareas + single-line
 * question inputs.
 * =====================================================================
 * Anything that looks like a free-text screening question goes through
 * /answer-questions in the Advanced flow. We tag each detected element
 * with a temp id (makeTempId) so the side panel can route the LLM's
 * answer back to the exact element without holding a cross-frame ref.
 *
 * Rating-style textareas ("Please rate from 1-10 across these
 * disciplines: ...") get their bullet sub-items appended to the
 * question label so the LLM can produce a properly-bulleted answer. */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill) return;
  const ns = window.ProactiveAutofill;
  if (!ns.core?.dom) return;
  const { isVisible, labelTextFor, makeTempId } = ns.core.dom;

  /** A label "looks like" a question if it starts with a question
   *  word / verb, or ends with "?".
   *
   *  A leading qualifier is allowed before the verb ("BRIEFLY describe
   *  your highest impact project …", "In a few sentences, explain …").
   *  Without it, a prompt that opens with an adverb AND ends with a
   *  full stop matched neither branch, so the textarea was silently
   *  dropped and the follow-up feature never answered it. */
  const QUESTION_LABEL_LOOKS =
    /^(?:(?:please|kindly|briefly|shortly|concisely|optionally|quickly)\s+|in\s+(?:a\s+few|\d+(?:\s*[-–]\s*\d+)?)\s+sentences[,:]?\s*|in\s+(?:your\s+own\s+words|brief|short)[,:]?\s*){0,2}(?:why|how|what|when|where|which|who|tell|describe|explain|share|provide|list|indicate|specify|state|give|select|outline|summari[sz]e|elaborate|walk\s+(?:us|me)|are\s+you|do\s+you|have\s+you|can\s+you|would\s+you|will\s+you|did\s+you|were\s+you|please(?:\s+(?:describe|explain|provide|list|indicate|specify|state|share|tell|give|select|elaborate|note|comment))?|in\s+(?:your\s+own\s+words|brief)|we(?:'d|\s+would)\s+(?:like|love))\b|\?\s*\*?\s*$/i;

  /** Skip cover-letter / "anything else" boxes — they're not questions
   *  in the sense we want to LLM-answer. */
  const QUESTION_LABEL_SKIPS =
    /(cover letter|cover note|anything else|additional info|other comments|comments?|notes?|message to)/i;

  /** Self-rating fields: "Please rate ... from 1-10". */
  const RATING_LABEL_LOOKS =
    /\b(?:rate|rating|score)\b[^\n]{0,80}?\b(?:1|one)\b[^\n]{0,30}?\b(?:10|ten)\b|\bon\s+a\s+scale\s+of\s+(?:1|one)\s*[-–to]+\s*(?:10|ten)\b|\b(?:1|one)\s*\(?\s*low\s*\)?\s*[-–to]+\s*(?:10|ten)\s*\(?\s*high\s*\)?|\bscale\s*(?:of|from)?\s*(?:1|one)\s*(?:[-–to]+|and)\s*(?:10|ten)\b|\b(?:1|one)\s*[-–]\s*(?:10|ten)\s*(?:rating|scale)\b/i;

  /** QUESTION_LABEL_LOOKS only checks the START of the whole label — real
   *  prompts don't always open with the question verb; a scene-setting
   *  lead-in sentence is common ("You'll be working with infrastructure
   *  on both AWS and Azure. Walk us through your experience operating on
   *  both platforms."), which silently dropped the entire question even
   *  though it plainly IS one. Falls back to testing each sentence on its
   *  own — same strict phrase list, just not required to be the very
   *  first word, so a genuine question later in the label still counts
   *  without loosening the regex into matching arbitrary prose. */
  function looksLikeQuestion(label) {
    if (QUESTION_LABEL_LOOKS.test(label)) return true;
    const sentences = label.split(/(?<=[.!?])\s+(?=[A-Z])/);
    return sentences.length > 1 && sentences.some((s) => QUESTION_LABEL_LOOKS.test(s));
  }

  /** Walk near a rating-style textarea to find its bulleted sub-items
   *  (the disciplines / skills the user is being asked to rate). */
  function extractBulletContextNear(el) {
    if (!el) return [];
    let container = el.parentElement;
    let text = "";
    for (let i = 0; i < 4 && container; i++) {
      const t = container.innerText || "";
      if (t.length > text.length) text = t;
      container = container.parentElement;
    }
    if (!text) return [];
    const lines = text.split(/\r?\n/);
    const bullets = [];
    const seen = new Set();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^(?:[-*•·●]|\d+\.)\s+(.+)$/);
      if (!m) continue;
      let item = m[1]
        .replace(/[\s:]+\d+\s*\/\s*\d+\s*$/, "")
        .replace(/[\s:]+_+(?:\s*\/\s*\d+)?\s*$/, "")
        .replace(/[\s:]+\(?\s*low\s*\)?\s*[-–to]+\s*\(?\s*high\s*\)?\s*$/i, "")
        .trim()
        .replace(/[:\s]+$/, "");
      if (item.length < 1 || item.length > 200) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      bullets.push(item);
      if (bullets.length >= 20) break;
    }
    return bullets;
  }

  /** Detect free-text screening textareas. Skips already-filled boxes,
   *  cover-letter slots, and non-question labels. Rating textareas
   *  are returned with their sub-item bullets appended to the label. */
  function detectQuestions(doc) {
    const root = doc || (typeof document !== "undefined" ? document : null);
    if (!root) return [];
    const out = [];
    for (const el of root.querySelectorAll("textarea")) {
      if (!isVisible(el)) continue;
      if (el.value && el.value.trim().length > 30) continue;
      const label = labelTextFor(el).trim();
      if (!label) continue;
      if (!looksLikeQuestion(label)) continue;
      if (QUESTION_LABEL_SKIPS.test(label)) continue;
      const clean = label.replace(/\s*\*\s*$/g, "").trim();
      let augmented = clean;
      if (RATING_LABEL_LOOKS.test(clean)) {
        const bullets = extractBulletContextNear(el);
        if (bullets.length) {
          augmented = clean
            + "\n\nRate each of the following on the same 1–10 scale (use 7–10 across the board, mid-high). Respond as a bulleted list, one item per line, in this exact order:\n"
            + bullets.map((b) => "- " + b).join("\n");
        }
      }
      out.push({ id: makeTempId(el), label: augmented });
    }
    return out;
  }

  /** Detect single-line text inputs whose label looks like a question.
   *  Skips dropdown search inputs (those belong to the dropdown
   *  preset/LLM path) and inputs already touched by an earlier pass. */
  function detectInputQuestions(doc, alreadyTouched) {
    const root = doc || (typeof document !== "undefined" ? document : null);
    if (!root) return [];
    const SELECTOR = 'input[type="text"], input[type="number"], input[type="date"], input[type="search"], input:not([type])';
    const isTouched = (el) => alreadyTouched && alreadyTouched.has(el);
    const isDropdownSearchInput = (el) =>
      el.getAttribute("role") === "combobox" ||
      el.getAttribute("aria-haspopup") === "listbox" ||
      el.getAttribute("aria-haspopup") === "menu" ||
      el.getAttribute("aria-autocomplete") === "list" ||
      !!el.closest('[class*="select__"], [role="combobox"], [role="listbox"], select');
    const out = [];
    for (const el of root.querySelectorAll(SELECTOR)) {
      if (!isVisible(el)) continue;
      if (el.disabled || el.readOnly) continue;
      if (el.value && el.value.trim().length > 0) continue;
      if (isTouched(el)) continue;
      if (isDropdownSearchInput(el)) continue;
      const label = labelTextFor(el).trim();
      if (!label) continue;
      if (!looksLikeQuestion(label)) continue;
      if (QUESTION_LABEL_SKIPS.test(label)) continue;
      const clean = label.replace(/\s*\*\s*$/g, "").trim();
      out.push({ id: makeTempId(el), label: clean });
    }
    return out;
  }

  ns.detectors.questions = {
    QUESTION_LABEL_LOOKS,
    looksLikeQuestion,
    QUESTION_LABEL_SKIPS,
    RATING_LABEL_LOOKS,
    extractBulletContextNear,
    detectQuestions,
    detectInputQuestions,
  };
})();
