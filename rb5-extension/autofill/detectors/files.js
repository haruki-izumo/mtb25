/* =====================================================================
 * detectors/files.js — resume / cover letter file-input classification.
 * =====================================================================
 * SmartRecruiters, Lever, Workable et al render file inputs as
 * <input type=file hidden> behind a styled "Attach" button. The hidden
 * input often has no label / name / id we can read, so we walk up to
 * ~8 ancestors looking for a section heading ("Resume/CV", "Cover
 * Letter") and classify by that text. When two unlabeled file inputs
 * exist, the second one is promoted to the cover-letter slot.
 *
 * detectFiles returns { resumeFile, coverLetterFile, coverLetterTextarea }
 * — never throws, missing slots are simply null. ===================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill) return;
  const ns = window.ProactiveAutofill;
  if (!ns.core?.dom) return;
  const { isVisible, labelTextFor, cssEscape } = ns.core.dom;

  // [_\s-]* tolerates id/name attributes like "cover_letter" or
  // "cover-letter" alongside the human-readable "cover letter".
  const COVER_RE = /cover[_\s-]*letter|covering[_\s-]*letter|cover[_\s-]*note|motivation[_\s-]*letter|lettre\s*de\s*motivation|anschreiben/i;
  const RESUME_RE = /\b(resume|cv|curriculum[_\s-]*vitae|lebenslauf|c\.?v\.?)\b/i;
  // Parse-resume ("Import resume from" / "AUTOFILL APPLICATION" on
  // Workable, "Fill using resume" on some Greenhouse variants) is a
  // separate slot from the standard Resume file input on the same
  // page — dropping a PDF into the parse slot triggers the ATS's own
  // field auto-population and typically saves the user a lot of typing.
  // We want this slot to WIN the resume assignment when both exist.
  const PARSE_RESUME_RE = /autofill\s+application|import\s+resume|import\s+from|parse\s+resume|fill\s+using\s+(?:your\s+)?resume|autofill\s+with\s+(?:your\s+)?resume|autofill\s+from\s+(?:cv|resume)/i;
  // Photo / avatar / headshot uploads. A file input in one of these
  // sections must NEVER be treated as the resume slot — Workable's
  // "* Photo" upload sits ABOVE the "* Resume" upload, and because it
  // carries no resume/cover label the old classifier's "unlabelled →
  // resume" fallback grabbed it, attaching the CV to the photo field
  // and leaving the real Resume input empty.
  const PHOTO_RE = /\b(photo|avatar|profile\s*(?:picture|photo|image)|headshot|head\s*shot|display\s*picture|picture|image|logo)\b/i;
  // "Attach resume", "Upload your CV", "Browse for resume" — the
  // trigger pattern Resumator/JazzHR/ApplyToJob and several smaller
  // ATSes use to lazy-mount the actual <input type=file>.
  const ATTACH_TRIGGER_RE = /\b(attach|upload|browse|add|select)\b[\s\S]{0,30}\b(resume|cv|curriculum[_\s-]*vitae)\b/i;

  // Broad section-heading selector — matches plain <strong>/<b> and
  // class-tagged title/heading/label headings, not just <h*>/<legend>.
  // React-dropzone cover-letter widgets ("Cover Letter" rendered as a
  // bold <strong> or <div class="title">) otherwise stayed unlabelled,
  // so a lone/first cover dropzone was grabbed by the unlabelled-→-resume
  // fallback — the CV landed there and the cover PDF never attached.
  const HEADER_SEL =
    "h1, h2, h3, h4, h5, h6, legend, label," +
    "[class*='heading' i], [class*='Heading']," +
    "[class*='label' i], [class*='Label']," +
    "[class*='title' i], [class*='Title']," +
    "strong, b";
  // Text shapes that are dropzone helper copy, never a section heading.
  const DROPZONE_COPY_RE = /accepted\s+file\s+types|supported\s+files|drag\s+and\s+drop|click\s+to\s+upload|up\s+to\s+\d+\s*mb/i;

  // A file input's OWN field ends where a container also holds a DIFFERENT
  // file input. Heading searches must not climb past this boundary — a
  // Cover Letter upload whose own heading the query can't see would
  // otherwise bleed onto the sibling "Resume/CV" heading and be mis-tagged
  // as a resume, so the CV lands in the cover-letter slot.
  const hasOtherFileInput = (container, el) =>
    [...container.querySelectorAll('input[type="file"]')].some((fi) => fi !== el);

  /** Label for a file input that CANNOT bleed into a sibling upload's
   *  section. labelTextFor's generic parent-walk climbs to the <form>
   *  and grabs the FIRST heading it finds there — for a Cover Letter
   *  input with no own label that's the "Resume/CV" heading, which made
   *  the classifier tag the cover input as a resume and drop the CV into
   *  it. Input-specific sources (aria / for= / enclosing <label>) never
   *  bleed; the heading fallback is bounded to the input's own field. */
  function scopedLabelText(el) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const doc = el.ownerDocument;
    if (el.id && doc) {
      let l = null;
      try { l = doc.querySelector(`label[for="${cssEscape(el.id)}"]`); } catch { l = null; }
      if (l && (l.textContent || "").trim()) return l.textContent.trim();
    }
    const enc = el.closest && el.closest("label");
    if (enc && (enc.textContent || "").trim()) return enc.textContent.trim();
    // Flat "label then field-wrapper" layout (BambooHR fabric, some MUI
    // forms): the section <label> is a PRECEDING SIBLING of the upload's
    // wrapper — at a level shared with the OTHER upload — so the scoped walk
    // below (which stops at that shared container) never reaches it. The
    // input then reads as unlabelled and the DOM-order fallback drops the
    // resume into the (earlier) cover-letter box. Scan leftward/upward for
    // the nearest cover/resume label, never crossing another file input
    // (whose label belongs to that other upload). Gated to cover/resume
    // matches so it can only aid classification, never grab a stray heading.
    for (let node = el.parentElement, up = 0, stop = false; node && up < 5 && !stop; node = node.parentElement, up++) {
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if ((sib.matches && sib.matches('input[type="file"]')) ||
            (sib.querySelector && sib.querySelector('input[type="file"]'))) { stop = true; break; }
        const h = (sib.matches && sib.matches(HEADER_SEL)) ? sib
          : (sib.querySelector ? sib.querySelector(HEADER_SEL) : null);
        const t = h ? (h.textContent || "").trim() : "";
        if (t && t.length <= 120 && !DROPZONE_COPY_RE.test(t) && (COVER_RE.test(t) || RESUME_RE.test(t))) return t;
      }
    }
    // Heading/label WITHIN the bounded field scope only (stop before a
    // container that also holds a different file input).
    let scope = el.parentElement, chosen = el.parentElement;
    for (let i = 0; i < 8 && scope; i++) {
      if (hasOtherFileInput(scope, el)) break;
      chosen = scope;
      scope = scope.parentElement;
    }
    if (chosen) {
      for (const h of chosen.querySelectorAll(HEADER_SEL)) {
        if (h === el || h.contains(el) || el.contains(h)) continue;
        const t = (h.textContent || "").trim();
        if (t && t.length <= 120 && !DROPZONE_COPY_RE.test(t)) return t;
      }
    }
    return "";
  }

  /** Closest section heading text above `el`, using the broad HEADER_SEL.
   *  Breaks at the first ancestor that yields a qualifying heading so we
   *  return the input's OWN section label, not a sibling section's. */
  function nearestSectionLabel(el) {
    let p = el.parentElement;
    for (let i = 0; i < 8 && p; i++) {
      if (hasOtherFileInput(p, el)) break;
      for (const h of p.querySelectorAll(HEADER_SEL)) {
        if (h === el || h.contains(el) || el.contains(h)) continue;
        const t = (h.textContent || "").trim();
        if (!t || t.length > 80) continue;
        if (DROPZONE_COPY_RE.test(t)) continue;
        return t;
      }
      p = p.parentElement;
    }
    return "";
  }

  /** True when a file input sits in a resume-PARSE section — Workable's
   *  "AUTOFILL APPLICATION / Import resume from" card, whose PDF drop
   *  triggers the ATS's own field auto-population. The card's heading is
   *  often a plain <div>/<span> that sectionTextFor's headings-only query
   *  misses, so we also scan nearby buttons/links/paragraphs for the
   *  parse verbiage ("Import resume from", "Autofill application"). */
  function nearParseSection(el) {
    let p = el.parentElement;
    for (let i = 0; i < 5 && p; i++) {
      // Stop once the container spans a DIFFERENT field — another form
      // control (name/email/…) or another file input. The parse card
      // holds only the file input + "Import resume from" button + copy;
      // beyond it the container is the whole <form>, and a parse button
      // there would bleed onto the unrelated standard "Resume" upload.
      const spansOtherField = [...p.querySelectorAll("input, select, textarea")]
        .some((c) => c !== el && (c.tagName !== "INPUT" || (c.getAttribute("type") || "").toLowerCase() !== "file"));
      const otherFileInput = [...p.querySelectorAll('input[type="file"]')].some((fi) => fi !== el);
      if (spansOtherField || otherFileInput) return false;
      for (const node of p.querySelectorAll(
        "button, a, [role='button'], h1, h2, h3, h4, h5, h6, legend, strong, b, p," +
        "[class*='label' i], [class*='title' i], [class*='heading' i]",
      )) {
        if (node.contains(el)) continue;
        const t = (node.textContent || "").trim();
        if (t && t.length <= 200 && PARSE_RESUME_RE.test(t)) return true;
      }
      p = p.parentElement;
    }
    return false;
  }

  function sectionTextFor(el) {
    let p = el.parentElement;
    const parts = [];
    for (let i = 0; i < 8 && p; i++) {
      if (hasOtherFileInput(p, el)) break;
      const h = p.querySelector(
        "h1, h2, h3, h4, h5, h6, legend," +
        "[class*='heading'], [class*='Heading']," +
        "[class*='label'], [class*='Label']",
      );
      if (h && h !== el && h.textContent.trim()) {
        parts.push(h.textContent.trim());
        break;
      }
      p = p.parentElement;
    }
    // Broad nearest heading (<strong>Cover Letter</strong> etc.) that the
    // headings-only query above misses.
    const broad = nearestSectionLabel(el);
    if (broad) parts.push(broad);
    const l = el.closest(
      "label, [class*='upload'], [class*='Upload']," +
      "[class*='attach'], [class*='Attach']",
    );
    if (l) parts.push(l.textContent.trim().slice(0, 200));
    return parts.join(" │ ");
  }

  /**
   * Classify every <input type=file> on the page into resume / cover
   * slots, plus detect a cover-letter <textarea> when one is present.
   * @param {Document} [doc=document]
   * @param {{resumeFile?: HTMLInputElement, coverLetterFile?: HTMLInputElement}} [adapterHits]
   *   Optional adapter-provided overrides; if set, they win.
   */
  function detectFiles(doc, adapterHits) {
    const root = doc || (typeof document !== "undefined" ? document : null);
    if (!root) return { resumeFile: null, coverLetterFile: null, coverLetterTextarea: null, additionalResumeFiles: [] };
    let resumeFile = adapterHits?.resumeFile || null;
    let coverLetterFile = adapterHits?.coverLetterFile || null;
    let coverLetterTextarea = null;

    // Visibility-tolerant: many ATSes hide the file input behind a
    // styled button. We reject only `disabled` inputs.
    const fileInputs = Array.from(root.querySelectorAll('input[type=file]'))
      .filter((el) => !el.disabled);

    // Two-pass classification. Pass 1 collects a { el, fullSig, isParse,
    // isResume, isCover } record per input so we can handle the
    // Workable-style "AUTOFILL APPLICATION" / "Import resume from" slot
    // properly. The parse-resume input is SEPARATE from the required
    // "Resume *" upload — dropping a PDF into the parse slot triggers
    // the ATS's auto-populate on the surrounding form, but the standard
    // Resume input is still required for submission. We attach the same
    // resume PDF to BOTH slots via additionalResumeFiles.
    // A file input is a PHOTO/avatar slot when its section text says so
    // OR its `accept` attribute only permits image types. Either signal
    // is enough to bar it from the resume/cover slots — otherwise the
    // "* Photo" upload on Workable (which sits above "* Resume" and
    // carries no resume label) gets grabbed by the unlabelled-→-resume
    // fallback, so the CV lands in the photo box and Resume stays empty.
    const acceptsOnlyImages = (el) => {
      const accept = (el.getAttribute("accept") || "").toLowerCase().trim();
      if (!accept) return false;
      if (/\bimage\//.test(accept)) {
        // "image/*" or "image/png,application/pdf" — image-only iff no
        // document type is also allowed.
        return !/(pdf|msword|officedocument|\.docx?|\.rtf|\.txt|\.odt|text\/)/.test(accept);
      }
      // Pure extension list: every entry is an image extension.
      const exts = accept.split(",").map((s) => s.trim()).filter(Boolean);
      return exts.length > 0 && exts.every((e) => /\.(png|jpe?g|gif|webp|bmp|heic|heif|svg|tiff?)$/.test(e));
    };
    const classified = fileInputs.map((el) => {
      const sig = [
        el.name || "",
        el.id || "",
        scopedLabelText(el),
        el.getAttribute("aria-label") || "",
        el.getAttribute("data-automation-id") || "",
      ].join(" ");
      const fullSig = sig + " " + sectionTextFor(el);
      // Photo wins over a stray resume/cover keyword match: a "Profile
      // picture" section that happens to contain the word "CV" in
      // helper text shouldn't read as a resume slot.
      const isPhoto = PHOTO_RE.test(fullSig) || acceptsOnlyImages(el);
      return {
        el,
        fullSig,
        isPhoto,
        isParse: !isPhoto && (PARSE_RESUME_RE.test(fullSig) || nearParseSection(el)),
        isCover: !isPhoto && COVER_RE.test(fullSig),
        // Cover wins over resume: an input whose signature says "cover
        // letter" is NEVER a resume seat, even if a bled/adjacent
        // "Resume/CV" also appears — otherwise the CV gets attached to
        // the cover-letter input.
        isResume: !isPhoto && RESUME_RE.test(fullSig) && !COVER_RE.test(fullSig),
      };
    });
    const additionalResumeFiles = [];
    // Pass 2a — parse-resume input wins the resume seat outright so
    // the ATS's auto-populate fires as soon as the file is dropped.
    const parseInput = classified.find((c) => c.isParse && !c.isCover);
    if (parseInput && !resumeFile) resumeFile = parseInput.el;
    // Pass 2b — assign in PRIORITY order, not DOM order: an
    // explicitly RESUME-labelled input must claim the resume seat
    // before any unlabelled input does. Processing in DOM order let an
    // earlier unlabelled input (e.g. Photo) take the seat and blocked
    // the real "Resume" input below it. Same for cover.
    const assignable = classified.filter((c) => c.el !== resumeFile && !c.isPhoto);
    // (i) explicit cover-letter labels.
    for (const c of assignable) {
      if (c.isCover && !coverLetterFile) coverLetterFile = c.el;
    }
    // (ii) explicit resume labels.
    for (const c of assignable) {
      if (c.el === coverLetterFile) continue;
      if (c.isResume) {
        if (!resumeFile) resumeFile = c.el;
        else if (parseInput) additionalResumeFiles.push(c.el);
      }
    }
    // (iii) unlabelled fallback — only inputs with no resume/cover/photo
    // classification at all. First fills resume, second fills cover.
    for (const c of assignable) {
      if (c.el === resumeFile || c.el === coverLetterFile) continue;
      if (c.isResume || c.isCover) continue;
      if (!resumeFile) resumeFile = c.el;
      else if (!coverLetterFile) coverLetterFile = c.el;
    }
    // Two unlabelled inputs both classified as "resume"? Promote the
    // second to cover letter — universal "Resume first, Cover second"
    // form ordering. Skip photo inputs, the parse slot, and any input
    // already claimed as an ADDITIONAL resume (Workable's "AUTOFILL
    // APPLICATION" parse slot + a real "Resume" upload are BOTH resumes —
    // the standard one must not be mistaken for a cover letter).
    if (resumeFile && !coverLetterFile && fileInputs.length >= 2) {
      const second = classified.find((c) =>
        c.el !== resumeFile && !c.isPhoto && !c.isParse && !additionalResumeFiles.includes(c.el));
      if (second) coverLetterFile = second.el;
    }
    if (!resumeFile && !coverLetterFile) {
      // Last-ditch: first NON-photo file input. Never fall back to a
      // photo/avatar input for the resume — better to attach nothing
      // than to drop the CV into the profile-picture box.
      const firstNonPhoto = classified.find((c) => !c.isPhoto);
      if (firstNonPhoto) resumeFile = firstNonPhoto.el;
    }

    // Cover letter as a TEXTAREA (Lever, Workable, some Greenhouse).
    for (const ta of root.querySelectorAll("textarea")) {
      if (!isVisible(ta)) continue;
      const lbl = labelTextFor(ta);
      if (lbl && COVER_RE.test(lbl)) { coverLetterTextarea = ta; break; }
    }

    // Lazy-mount fallback: when no resume file input was found AND the
    // page has an "Attach resume" / "Upload CV" clickable trigger
    // (Resumator / JazzHR / ApplyToJob et al.), surface the trigger so
    // the pipeline can click it and re-scan. Clicked from content-script
    // context — no user-gesture is carried through chrome.runtime
    // messaging — so the native file-picker dialog does NOT open; the
    // page just mounts the hidden <input type=file>, which our second
    // scan then picks up and attaches to via DataTransfer.
    let resumeAttachTrigger = null;
    let coverLetterAttachTrigger = null;
    const triggerSel = 'a, button, [role="button"], [class*="upload"], [class*="Upload"], [class*="attach"], [class*="Attach"]';
    if (!resumeFile) {
      // Anchors, buttons, and divs with role=button. Skip <label> here:
      // a <label> sibling to a real <input type=file> would already have
      // been classified above. We only want the JS-driven trigger
      // pattern.
      for (const el of root.querySelectorAll(triggerSel)) {
        if (!isVisible(el)) continue;
        // Truncate textContent — long card components can match on
        // unrelated marketing copy. The trigger is usually a short
        // 1-5 word link.
        const txt = (el.textContent || "").trim().slice(0, 80);
        if (!txt) continue;
        if (ATTACH_TRIGGER_RE.test(txt)) { resumeAttachTrigger = el; break; }
      }
    }
    // Resume lazy-mount trigger for the bare-verb button row — Greenhouse's
    // new job-boards UI ships Attach / Dropbox / Google Drive / Enter
    // manually under BOTH "Resume/CV" and "Cover Letter" (the button text
    // is a plain verb, so ATTACH_TRIGGER_RE above never matched it and the
    // CV wasn't attached at all on this UI). Mirror the cover trigger:
    // a bare "Attach"/"Upload" button whose NEAREST section heading is the
    // resume (and NOT the cover letter).
    if (!resumeFile && !resumeAttachTrigger) {
      const bareAttachRe = /^\s*(attach|upload|browse|add\s+file|choose\s+file|select\s+file)\s*$/i;
      for (const el of root.querySelectorAll(triggerSel)) {
        if (!isVisible(el)) continue;
        const txt = (el.textContent || "").trim();
        if (!txt || txt.length > 40) continue;
        if (!bareAttachRe.test(txt)) continue;
        const near = nearestSectionLabel(el);
        if (RESUME_RE.test(near) && !COVER_RE.test(near)) { resumeAttachTrigger = el; break; }
      }
    }
    // Cover-letter lazy-mount trigger — Greenhouse's new job-boards UI
    // ships four buttons under "Cover Letter": Attach / Dropbox /
    // Google Drive / Enter manually. The buttons carry no cover-letter
    // text themselves; we scope by walking up to check that the
    // containing section reads "Cover Letter".
    if (!coverLetterFile) {
      // Short, action-verb-only buttons. We deliberately match a bare
      // "Attach" / "Upload" / "Browse" (no "cover letter" required)
      // because the buttons are always plain verbs on this UI.
      const bareAttachRe = /^\s*(attach|upload|browse|add\s+file|choose\s+file|select\s+file)\s*$/i;
      // The Resume/CV section carries an IDENTICAL "Attach" button row.
      // The button's NEAREST section heading must be the cover letter —
      // an any-ancestor scan let the RESUME "Attach" button match the
      // cover section's heading two levels up (shared <form>) and hijack
      // the cover trigger, so the CV's upload button got clicked and the
      // cover letter never attached. nearestSectionLabel breaks at the
      // closest heading, so the resume button resolves to "Resume/CV"
      // (rejected) and only the cover button resolves to "Cover Letter".
      for (const el of root.querySelectorAll(triggerSel)) {
        if (!isVisible(el)) continue;
        const txt = (el.textContent || "").trim();
        if (!txt || txt.length > 40) continue;
        if (!bareAttachRe.test(txt)) continue;
        const near = nearestSectionLabel(el);
        if (COVER_RE.test(near) && !RESUME_RE.test(near)) {
          coverLetterAttachTrigger = el;
          break;
        }
      }
    }

    // Parse-resume lazy-mount trigger — Workable's "AUTOFILL APPLICATION"
    // card is an "Import resume from" DROPDOWN (My computer / Dropbox /
    // Google Drive). The hidden <input type=file> for "My computer" only
    // mounts once the menu is opened, so at detect-time there's no parse
    // input to classify. Surface the "Import resume from" button so the
    // pipeline can open the menu and attach to the freshly-mounted input.
    let parseResumeAttachTrigger = null;
    if (!parseInput) {
      const PARSE_TRIGGER_RE = /import\s+resume|import\s+(?:from|cv)|autofill\s+application|parse\s+resume|upload\s+(?:your\s+)?(?:resume|cv)\s+to\s+autofill/i;
      for (const el of root.querySelectorAll(triggerSel)) {
        if (!isVisible(el)) continue;
        const txt = (el.textContent || "").trim();
        if (!txt || txt.length > 60) continue;
        // The button itself ("Import resume from") OR a button inside a
        // section whose heading/copy is the parse card.
        if (PARSE_TRIGGER_RE.test(txt) || nearParseSection(el)) {
          parseResumeAttachTrigger = el;
          break;
        }
      }
    }

    // Final safety net: the cover-letter slot must never be a resume
    // target — drop it (and the primary resume) from the extra-resume
    // list so the CV can't be attached to the cover-letter input.
    const additionalResumeFilesSafe = additionalResumeFiles.filter(
      (el) => el && el !== coverLetterFile && el !== resumeFile,
    );
    return { resumeFile, coverLetterFile, coverLetterTextarea, resumeAttachTrigger, coverLetterAttachTrigger, parseResumeAttachTrigger, additionalResumeFiles: additionalResumeFilesSafe };
  }

  ns.detectors.files = {
    COVER_RE,
    RESUME_RE,
    PARSE_RESUME_RE,
    sectionTextFor,
    detectFiles,
  };
})();
