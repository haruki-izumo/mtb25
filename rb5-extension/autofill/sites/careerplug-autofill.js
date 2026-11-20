// autofill/sites/careerplug-autofill.js — CareerPlug (<company>.careerplug.com).
//
// Structural field-detection + value-filling, ported from BidHub's own
// packages/job-parsers/content/platforms/careerplug/autofill.js
// (detectAutofillFields / FIELD_KIND_HANDLERS / getCareerPlugSubmitButton).
// This is a SEPARATE, richer port of BidHub's full per-site logic — not the
// same thing as the existing autofill/handlers/adapters/careerplug.js, which
// is Big Banana's own, much simpler, generic 15-step pipeline adapter. Both
// files may end up looking at the same resume/cover-letter fieldsets; they
// are not wired together and this file does not register into that other
// system.
//
// Deliberately NOT ported (out of scope for this structural port):
//   - BidHub's AI-backend free-text answer generation (ANSWER_TYPE_HANDLERS'
//     generateAnswer, which calls getAnswer(...)/getResumeForAutofill()/
//     getCoverLetterForAutofill() against BidHub's own ai-core backend).
//     Big Banana has its own system for that; any screening question this
//     file can't structurally resolve is simply left unfilled.
//   - reCAPTCHA v2 challenge detection/solving (isRecaptchaChallengeBlocking,
//     buildCaptchaFieldEntry, CAPTCHA_ANSWER_TYPE/CAPTCHA_FIELD_KIND) — this
//     file never emits or fills a captcha field kind at all.
//   - Clicking CareerPlug's Submit/Apply button (getCareerPlugSubmitButton
//     was also the auto-submit click target in BidHub; here it's left out
//     entirely — actual submission is left to the human).
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofillEngine) return;
  const dom = window.ProactiveAutofillEngine;

  // ---- field detection ---------------------------------------------------

  // resume_text is CareerPlug's "paste your resume as text" alternative to
  // the file upload below it in the same fieldset — we always use the file
  // upload, so this id is never autofilled. Ported verbatim from BidHub's
  // own skip list (BidHub's list also carried a second, commented-out entry
  // for the SMS-consent checkbox id that was never actually enabled —
  // dropped here since it did nothing in the source either; see the
  // detectFields() comment below for what actually happens to that field).
  const SKIP_FIELD_IDS = new Set(["app_applicant_attributes_resume_text"]);

  function getFieldConstraints(input) {
    const constraints = {};
    if (input.required) constraints.required = true;
    if (input.maxLength > 0) constraints.maxLength = String(input.maxLength);
    return constraints;
  }

  // Returns an array of { fieldId, question, field, fieldKind, options,
  // constraints } descriptors for every field on the CURRENT page, or null
  // if CareerPlug's application form isn't present. CareerPlug serves the
  // whole application as one page (#new_app) — there's no multi-step
  // "advance" flow to loop through here, unlike multi-page ATSes.
  function detectFields() {
    const form = document.querySelector("#new_app");
    if (!form) return null;

    const fields = [];
    const seen = new Set();
    const addField = (fieldId, question, field, meta) => {
      if (!fieldId || !question || !field || seen.has(fieldId)) return;
      seen.add(fieldId);
      fields.push({
        fieldId,
        question,
        field,
        fieldKind: meta.fieldKind,
        options: meta.options ?? [],
        constraints: meta.constraints ?? {},
      });
    };

    for (const label of form.querySelectorAll("label[for]")) {
      const fieldId = label.getAttribute("for");
      if (!fieldId || SKIP_FIELD_IDS.has(fieldId) || seen.has(fieldId)) continue;
      const input = document.getElementById(fieldId);
      if (!input || input.type === "submit" || input.type === "hidden") continue;

      // File inputs: resume vs cover letter both render as plain
      // input[type=file] with non-semantic Rails ids
      // (app_applicant_attributes_attachments_0_attachment /
      // ..._1_attachment) — nothing in the id itself says which is which.
      // The reliable signal is the enclosing <fieldset>: the resume one
      // carries class "resume-area", the cover-letter one has
      // id="cover_letter" (same quirk the existing, simpler generic
      // CareerPlug adapter at autofill/handlers/adapters/careerplug.js
      // documents). The attachment index in the id is kept only as a
      // fallback, per BidHub's own source.
      if (input.type === "file") {
        const wrapper = input.closest("fieldset");
        if (!wrapper) continue;
        const isResume = wrapper.classList.contains("resume-area") || fieldId.includes("_0_attachment");
        const isCoverLetter = wrapper.id === "cover_letter" || fieldId.includes("_1_attachment");
        if (isResume) {
          addField("resume", "Resume", wrapper, { fieldKind: "resume" });
        } else if (isCoverLetter) {
          addField("cover_letter", "Cover Letter", wrapper, { fieldKind: "cover_letter" });
        }
        continue;
      }

      const question = dom.getQuestionText(label);
      if (!question) continue;

      // Every real field has a stable wrapper div with id="<fieldId>_input"
      // — use that as the field's scope (matches BidHub) so filling can
      // stay generic instead of re-deriving the control type here.
      const field = document.getElementById(`${fieldId}_input`) || input;

      if (input.tagName === "SELECT") {
        const options = Array.from(input.options)
          .filter((o) => o.value)
          .map((o) => (o.innerText || o.textContent).trim());
        addField(fieldId, question, field, {
          fieldKind: "select-native",
          options,
          constraints: getFieldConstraints(input),
        });
        continue;
      }
      if (input.tagName === "TEXTAREA") {
        addField(fieldId, question, field, { fieldKind: "textarea", constraints: getFieldConstraints(input) });
        continue;
      }
      // Quirk ported straight from BidHub: nothing here special-cases
      // checkbox/radio inputs (CareerPlug's SMS-consent opt-in renders as
      // one, under its own label[for]) — it falls through to fieldKind
      // "text" exactly like a plain text input. That's harmless: the text
      // handler below resolves the control via dom.getTextInput(), whose
      // selector only matches text/email/tel/url/number/password inputs and
      // correctly returns null for a checkbox, so this is a silent no-op
      // rather than a mis-fill.
      addField(fieldId, question, field, { fieldKind: "text", constraints: getFieldConstraints(input) });
    }
    return fields;
  }

  // BidHub's own gate, ported verbatim: CareerPlug serves the application
  // form directly at /jobs/<id>/apps/new (the bare posting URL /jobs/<id>
  // server-redirects there) — there's no posting-page "Apply" click to
  // advance through first, so availability is just "the form exists and
  // detectFields() found at least one field" (BidHub's default
  // isAutofillAvailable == fieldCount > 0).
  function isAutofillAvailable() {
    if (!document.querySelector("#new_app")) return false;
    const fields = detectFields();
    return Array.isArray(fields) && fields.length > 0;
  }

  // ---- structural question -> profile-field matching ---------------------
  // BidHub's own CareerPlug file never hardcodes a selector for name/email/
  // phone/etc — every contact field arrives through the same generic
  // label[for] loop above as an ordinary "text" field, and BidHub resolved
  // ALL of them (contact fields and genuine custom screening questions
  // alike) by asking its AI backend for an answer. That generation step is
  // out of scope here (see file header), so this port instead recognizes the
  // handful of CareerPlug's own standard applicant-profile labels by text
  // and fills those structurally; anything else (a employer's own custom
  // screening question) is left untouched for Big Banana's existing generic
  // pipeline / AI free-text system to pick up later.
  const KNOWN_FIELD_MATCHERS = [
    { key: "first_name", pattern: /\bfirst\s*name\b/i },
    { key: "last_name", pattern: /\blast\s*name\b/i },
    { key: "full_name", pattern: /^\s*(?:full\s*)?name\s*$/i },
    { key: "email", pattern: /\be-?mail\b/i },
    { key: "phone", pattern: /\bphone\b|\bmobile\b|\bcell\b/i },
    { key: "address", pattern: /\baddress\b/i },
    { key: "city", pattern: /\bcity\b/i },
    { key: "state", pattern: /\bstate\b|\bprovince\b/i },
    { key: "zip", pattern: /\bzip\b|\bpostal\s*code\b/i },
    { key: "linkedin", pattern: /\blinkedin\b/i },
    { key: "website", pattern: /\bwebsite\b|\bportfolio\b/i },
  ];

  function matchKnownFieldKey(question) {
    const normalized = String(question ?? "").trim();
    if (!normalized) return null;
    const hit = KNOWN_FIELD_MATCHERS.find((m) => m.pattern.test(normalized));
    return hit ? hit.key : null;
  }

  // full_name <-> first_name/last_name are interchangeable depending on
  // which shape the caller's profileData happens to carry; split/join on
  // demand rather than requiring the caller to pre-derive both.
  function resolveProfileValue(key, profileData) {
    if (!profileData) return undefined;
    const direct = profileData[key];
    if (direct != null && direct !== "") return direct;
    if (key === "first_name" || key === "last_name") {
      const full = profileData.full_name;
      if (full) {
        const parts = String(full).trim().split(/\s+/);
        return key === "first_name" ? parts[0] : parts.slice(1).join(" ") || parts[0];
      }
    }
    if (key === "full_name") {
      const joined = [profileData.first_name, profileData.last_name].filter(Boolean).join(" ");
      if (joined) return joined;
    }
    return undefined;
  }

  function fillKnownTextField(field, fieldKind, question, profileData) {
    const key = matchKnownFieldKey(question);
    if (!key) return;
    const value = resolveProfileValue(key, profileData);
    if (value == null || value === "") return;
    const input = fieldKind === "textarea" ? dom.getTextarea(field) : dom.getTextInput(field);
    if (!input) return;
    dom.fillTextInput(input, String(value));
  }

  function fillKnownSelectField(field, question, profileData) {
    const key = matchKnownFieldKey(question);
    if (!key) return;
    const value = resolveProfileValue(key, profileData);
    if (value == null || value === "") return;
    const select = dom.getNativeSelect(field);
    if (!select) return;
    const normalized = String(value).trim().toLowerCase();
    const option = Array.from(select.options).find((o) => {
      const text = (o.innerText || o.textContent || "").trim().toLowerCase();
      return text === normalized || (o.value && o.value.toLowerCase() === normalized);
    });
    if (option) dom.fillSelectInput(select, option.value);
  }

  // ---- resume / cover letter ----------------------------------------------

  async function fillResumeField(field, profileData, shouldAbort) {
    if (shouldAbort()) return;
    const answer = profileData?.__resumeFile;
    if (!answer || typeof answer !== "object") return; // no resume provided — leave untouched
    const fileInput = dom.getFileInputInsideField(field);
    if (!fileInput) return;
    dom.fillFileInput(fileInput, answer.fileName, answer.base64, answer.mimeType);
  }

  // Small local stand-in for BidHub's own waitForPositiveResultWithAbort —
  // not part of the shared dom-interactions engine, so kept here.
  function waitUntil(check, timeoutMs, shouldAbort) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (shouldAbort?.() || check() || Date.now() - start >= timeoutMs) {
          resolve();
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  // Cover letter can be answered as a file OR as pasted text — the section
  // wrapper (fieldset#cover_letter) contains BOTH a file input and a
  // hidden-by-default textarea. Real CareerPlug quirk ported verbatim from
  // BidHub's own handler: the textarea lives inside a Bootstrap collapse
  // (#cover_letter_input) that starts collapsed; clicking the "Type/Paste
  // Text" toggle link (a[href="#cover_letter_input"]) adds the Bootstrap
  // `in` class that actually reveals it. Filling the textarea before that
  // click lands the value in a field CareerPlug's own form never submits.
  async function fillCoverLetterField(field, profileData, shouldAbort) {
    if (shouldAbort()) return;
    const fileAnswer = profileData?.__coverLetterFile;
    if (fileAnswer && typeof fileAnswer === "object") {
      const fileInput = dom.getFileInputInsideField(field);
      if (fileInput) dom.fillFileInput(fileInput, fileAnswer.fileName, fileAnswer.base64, fileAnswer.mimeType);
      return;
    }
    const text = profileData?.cover_letter;
    if (typeof text !== "string" || !text) return; // nothing structurally resolvable — leave for the generic pipeline

    const pasteWrapper = document.getElementById("cover_letter_input");
    const isCollapsed = pasteWrapper && !pasteWrapper.classList.contains("in");
    if (isCollapsed) {
      const pasteToggle = field.querySelector('a[href="#cover_letter_input"]');
      if (pasteToggle) {
        pasteToggle.click();
        await waitUntil(() => pasteWrapper.classList.contains("in"), 2000, shouldAbort);
        await dom.sleep(100);
      }
    }
    if (shouldAbort()) return;
    const textarea = field.querySelector("#app_applicant_attributes_cover_letter") || dom.getTextarea(field);
    if (textarea) dom.fillTextInput(textarea, text);
  }

  // ---- entry point ---------------------------------------------------------

  // profileData keys used: first_name/last_name (or full_name), email,
  // phone, address, city, state, zip, linkedin, website, __resumeFile,
  // __coverLetterFile, cover_letter — see KNOWN_FIELD_MATCHERS above. Any
  // field whose question doesn't match one of those (a employer's own
  // custom screening question) is left unfilled by design; CareerPlug's
  // form is single-page, so there is no "advance to next step" loop needed
  // here, and this never clicks the final Submit button.
  async function fill(profileData, opts = {}) {
    const { shouldAbort = () => false } = opts;
    const fields = detectFields();
    if (!fields || !fields.length) return;
    for (const entry of fields) {
      if (shouldAbort()) break;
      try {
        switch (entry.fieldKind) {
          case "resume":
            await fillResumeField(entry.field, profileData, shouldAbort);
            break;
          case "cover_letter":
            await fillCoverLetterField(entry.field, profileData, shouldAbort);
            break;
          case "select-native":
            fillKnownSelectField(entry.field, entry.question, profileData);
            break;
          case "textarea":
          case "text":
            fillKnownTextField(entry.field, entry.fieldKind, entry.question, profileData);
            break;
          default:
            break;
        }
      } catch {
        // one bad field should never abort the whole run — move on.
      }
    }
  }

  window.ProactiveAutofillSites = window.ProactiveAutofillSites || {};
  window.ProactiveAutofillSites.careerplug = { isAutofillAvailable, detectFields, fill };
})();
