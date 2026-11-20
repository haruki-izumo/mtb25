/* =====================================================================
 * core/react-input.js — DOM mutation primitives that work on React /
 * Vue / Angular forms.
 * =====================================================================
 * Frameworks shadow native input.value with their own controlled-state
 * tracking, so plain `el.value = X` doesn't fire onChange. The shim
 * here uses the native property setter and dispatches the input/change
 * events those frameworks listen for. Same trick LinkedIn auto-apply,
 * 1Password, and Simplify use. ===================================== */
(function () {
  "use strict";
  if (typeof window === "undefined" || !window.ProactiveAutofill) return;
  const ns = window.ProactiveAutofill;

  /**
   * Coerce a value into something a CONSTRAINED input will actually accept.
   *
   * Chrome rejects a non-conforming assignment outright: it logs
   *   The specified value "2+ years" cannot be parsed, or is out of range.
   * and leaves the field EMPTY. So writing an LLM screening answer like
   * "2+ years" into <input type="number"> silently filled nothing while we
   * still counted it as filled. Pull a usable value out where we can
   * ("2+ years" -> "2"), and return null to skip the write when we can't —
   * better an untouched field the user can complete than a blanked one.
   *
   * Returns the (possibly rewritten) value, or null to skip.
   */
  function coerceForInputType(el, value) {
    // Only <input> constrains its value; <textarea> and friends take anything.
    if (!el || el.tagName !== "INPUT") return value;
    const type = String(el.type || "text").toLowerCase();
    const str = String(value ?? "").trim();
    // Clearing is always legal (undo, resetting a search box).
    if (!str) return str;

    const iso = () => ns.core?.values?.toIsoDate?.(str) || null;

    switch (type) {
      case "number":
      case "range": {
        // Drop thousands separators ("60,000" -> "60000") then take the first
        // number: "2+ years" -> 2, "5-7 years" -> 5, "approx. 3" -> 3.
        const m = str.replace(/[,\s\u00a0](?=\d{3}\b)/g, "").match(/-?\d+(?:\.\d+)?/);
        if (!m) return null; // no number in there at all — leave the field alone
        let n = parseFloat(m[0]);
        if (!Number.isFinite(n)) return null;
        const min = parseFloat(el.getAttribute("min"));
        if (Number.isFinite(min) && n < min) n = min;
        const max = parseFloat(el.getAttribute("max"));
        if (Number.isFinite(max) && n > max) n = max;
        // step defaults to 1 on number/range, so a fractional value is a step
        // mismatch that blocks submission — round to keep the form valid.
        const stepAttr = el.getAttribute("step");
        if (stepAttr !== "any") {
          const step = parseFloat(stepAttr || "1");
          if (Number.isFinite(step) && Number.isInteger(step)) n = Math.round(n);
        }
        return String(n);
      }
      // Date-ish types reject anything not in their exact format.
      case "date":
        return /^\d{4}-\d{2}-\d{2}$/.test(str) ? str : iso();
      case "month":
        return /^\d{4}-\d{2}$/.test(str) ? str : null;
      case "week":
        return /^\d{4}-W\d{2}$/i.test(str) ? str : null;
      case "time":
        return /^\d{2}:\d{2}(:\d{2})?$/.test(str) ? str : null;
      case "datetime-local":
        return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str) ? str : null;
      case "color":
        return /^#[0-9a-f]{6}$/i.test(str) ? str : null;
      default:
        // text, email, url, tel, search, password, hidden … unconstrained:
        // an invalid value is a validation state, not a rejected assignment.
        return value;
    }
  }

  /** Set a textbox / textarea value via the React-friendly native
   *  setter. Returns true if the assignment took effect. */
  function setReactInputValue(el, value) {
    if (!el) return false;
    const coerced = coerceForInputType(el, value);
    // Unrepresentable for this input type — skip rather than let the browser
    // reject it and blank the field (and don't report it as filled).
    if (coerced === null) return false;
    value = coerced;
    try {
      const proto = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) {
        setter.call(el, value);
      } else {
        el.value = value;
      }
      // Fire the events controlled-input libraries listen for.
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      try {
        el.value = value;
        return true;
      } catch {
        return false;
      }
    }
  }

  /** Open a custom dropdown that listens for mousedown rather than
   *  click. react-select v5+, headless-UI, Greenhouse-modern, and
   *  intl-tel-input all do this. We dispatch the full pointer sequence
   *  and follow up with .click() so plain-click handlers also fire. */
  function fireOpen(el) {
    if (!el) return false;
    try {
      const opts = { bubbles: true, cancelable: true, button: 0, view: window };
      el.dispatchEvent(new MouseEvent("pointerdown", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("pointerup", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
    } catch {/* events not constructible in older runtimes */}
    try { el.click(); } catch {/* click suppressed */}
    return true;
  }

  /** Dispatch FocusEvent("blur") + Event("focusout") on a field so
   *  Formik / react-hook-form / homegrown validators clear stale
   *  "required" errors after we set a value. The visible UI commit
   *  happens via setReactInputValue / option clicks; this just nudges
   *  the validation layer to re-run. */
  function fireBlur(el) {
    if (!el || typeof el.dispatchEvent !== "function") return;
    try {
      el.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      el.dispatchEvent(new Event("focusout", { bubbles: true }));
    } catch {/* non-fatal */}
  }

  // Despite the name (kept for the smallest diff against every call site —
  // this attaches whatever resume FORMAT the user picked, not only a PDF),
  // this always used to stamp the File object as "application/pdf" no
  // matter what bytes it actually held. `filename` already carries the
  // real extension correctly (sidepanel.js reads it straight off the
  // server's own resume.pdf/resume.docx response name) — only the MIME
  // type was hardcoded wrong. A Word (.doc/.docx) resume landed in the
  // input labelled as a PDF, which is exactly the kind of type/extension
  // mismatch a lot of ATS client-side validators reject outright — "PDF
  // works, DOC silently doesn't attach" — so it's derived from that same
  // filename's extension instead.
  const MIME_BY_EXT = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };

  /** Programmatic file attach. Primary path: set input.files + dispatch
   *  change/input (react-dropzone, plain inputs, modern Greenhouse /
   *  Lever / SmartRecruiters all read input.files on change). Only when
   *  that assignment is REJECTED (a decorative, drop-only dropzone) do
   *  we fall back to a synthetic drop — firing it unconditionally
   *  double-attached on widgets that consume both. Returns true if the
   *  attach was attempted. */
  function attachPdfToFileInput(input, filename, base64) {
    if (!input || input.type !== "file") return false;
    try {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const name = filename || "resume.pdf";
      const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || "pdf").toLowerCase();
      const file = new File([bytes], name, { type: MIME_BY_EXT[ext] || "application/pdf" });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      // Did the programmatic files assignment stick? For a real
      // <input type=file> it does — the change/input events below are
      // then the commit mechanism (react-dropzone, plain inputs,
      // modern Greenhouse/Lever all read input.files on change).
      const filesStuck = !!(input.files && input.files.length > 0);
      // A file input commits on `change` — NOT `input`. Firing BOTH made
      // dropzones that listen to each (Zoho Recruit) accept the file
      // twice ("two CVs attached"). react-dropzone, Greenhouse, Lever et
      // al. all read input.files on `change`, so `change` alone suffices.
      input.dispatchEvent(new Event("change", { bubbles: true }));
      // Synthetic drop — ONLY when the input rejected the files
      // assignment (a truly decorative, drop-only dropzone). Firing it
      // unconditionally double-attached on widgets like react-dropzone
      // that consume BOTH the hidden input's change AND the container
      // drop — the reported "CV attached twice" bug.
      if (!filesStuck) {
        const zone = input.closest(
          "[class*='dropzone'], [class*='Dropzone'], [class*='upload'], [class*='Upload']," +
          "[class*='file-attach'], [class*='attachment'], [class*='FileAttach'], [class*='FileUpload']",
        ) || input.parentElement;
        if (zone) {
          try {
            const dragOver = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
            zone.dispatchEvent(dragOver);
            const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
            zone.dispatchEvent(drop);
          } catch {/* DataTransfer in DragEvent unsupported on Firefox / older Chrome */}
        }
      }
      return true;
    } catch (e) {
      try { console.warn("[proactive] attachPdfToFileInput failed:", e); } catch {/* test harness */}
      return false;
    }
  }

  ns.core.reactInput = {
    setReactInputValue,
    coerceForInputType,
    fireOpen,
    fireBlur,
    attachPdfToFileInput,
  };
})();
