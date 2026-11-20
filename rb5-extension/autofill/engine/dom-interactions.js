// Shared field-detection + value-filling primitives — ported from BidHub's
// own packages/job-parsers/content/platforms/dom-interactions.js (the exact
// algorithm: native-setter + _valueTracker rewind for React-safe writes,
// per-character human-like typing with jittered keydown/beforeinput/input/
// keyup, eased+wobbly simulated mouse-glide clicks, DataTransfer-based file
// upload, shadow-DOM-aware deep query helpers). Every per-site autofill
// file (autofill/sites/*-autofill.js) calls into this ONE module instead of
// reimplementing these mechanics per site.
//
// NOTE on isTrusted: every synthetic event dispatched here is still
// isTrusted:false (a content script cannot produce OS-level input) — same
// caveat BidHub's own source comments carry. Defeating a detector that
// strictly checks isTrusted needs a CDP-level input source, which is a
// separate (currently unported) remote-automation lane, not something
// this module can do on its own.
(function () {
  "use strict";
  const NS = (window.ProactiveAutofillEngine = window.ProactiveAutofillEngine || {});

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---- React-safe value writes ----------------------------------------

  function writeReactTextValue(element, value) {
    const lastValue = element.value;
    element.value = value;
    element._valueTracker?.setValue(lastValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // React-safe value write: use the prototype's native value setter
  // (controlled inputs override the instance `value`) and rewind the
  // internal value tracker so React's onChange fires for the dispatched
  // `input` event.
  function setReactInputValue(element, value) {
    const prototype =
      element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    const lastValue = element.value;
    if (valueSetter) valueSetter.call(element, value);
    else element.value = value;
    element._valueTracker?.setValue(lastValue);
  }

  // Short recovery window for a React state-restore wiping a just-written
  // value back to empty — re-writes on a few short backoff ticks until it
  // holds, or bails the moment something else (a real user edit) wins.
  const TEXT_INPUT_REASSERT_DELAYS_MS = [20, 60, 150, 350];
  async function reassertTextInputValue(element, text, { blur = true, shouldAbort = () => false } = {}) {
    for (const delay of TEXT_INPUT_REASSERT_DELAYS_MS) {
      if (!element.isConnected || shouldAbort()) return;
      if (element.value === text) return;
      if (element.value !== "" && element.value !== text) return; // never fight a real change
      await sleep(delay);
      if (!element.isConnected || shouldAbort() || element.value === text) return;
      writeReactTextValue(element, text);
      if (blur) element.dispatchEvent(new Event("blur"));
    }
  }

  // Fire-and-forget fill: writes once, fires blur, then lets
  // reassertTextInputValue clean up in the background if a framework wipes
  // it right back out.
  function fillTextInput(element, value) {
    if (!element) return;
    const text = String(value ?? "");
    if (text.startsWith("/Volumes/")) return; // never leak a local FS path into a form
    writeReactTextValue(element, text);
    element.dispatchEvent(new Event("blur"));
    void reassertTextInputValue(element, text, { blur: true });
  }

  // Awaitable version — use where a later synchronous step depends on the
  // value already having stuck.
  async function fillTextInputReliably(element, value, { blur = true, shouldAbort = () => false } = {}) {
    if (!element) return;
    const text = String(value ?? "");
    if (text.startsWith("/Volumes/")) return;
    writeReactTextValue(element, text);
    if (blur) element.dispatchEvent(new Event("blur"));
    await reassertTextInputValue(element, text, { blur, shouldAbort });
  }

  function fillTextInputWithoutBlur(element, value) {
    if (value && String(value).startsWith("/Volumes/")) return;
    const lastValue = element.value;
    element.focus();
    element.value = value;
    element._valueTracker?.setValue(lastValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // ---- Human-like typing -------------------------------------------------

  const SHIFTED_CHAR_PATTERN = /[A-Z!@#$%^&*()_+{}|:"<>?~]/;
  function getCharKeyEventInit(char) {
    const isLetter = /^[a-zA-Z]$/.test(char);
    const isDigit = /^[0-9]$/.test(char);
    let code = "";
    let keyCode = char.charCodeAt(0);
    let key = char;
    if (isLetter) {
      code = `Key${char.toUpperCase()}`;
      keyCode = char.toUpperCase().charCodeAt(0);
    } else if (isDigit) {
      code = `Digit${char}`;
    } else if (char === " ") {
      code = "Space";
      keyCode = 32;
    } else if (char === "\n") {
      code = "Enter";
      key = "Enter";
      keyCode = 13;
    }
    return { key, code, keyCode, shiftKey: SHIFTED_CHAR_PATTERN.test(char) };
  }

  function dispatchCharKeyEvents(element, char, eventTypes) {
    const { key, code, keyCode, shiftKey } = getCharKeyEventInit(char);
    for (const type of eventTypes) {
      element.dispatchEvent(
        new KeyboardEvent(type, {
          key,
          code,
          keyCode,
          which: keyCode,
          charCode: type === "keypress" ? keyCode : 0,
          shiftKey,
          bubbles: true,
          cancelable: true,
          composed: true,
        })
      );
    }
  }

  function randomKeyDelayMs(baseDelayMs, jitterRatio) {
    const jitter = baseDelayMs * jitterRatio;
    return Math.max(1, Math.round(baseDelayMs - jitter + Math.random() * jitter * 2));
  }

  const MIN_HUMAN_CHAR_DELAY_MS = 3;

  // Fill a text input/textarea the way a person would: focus, then emit a
  // real per-character key/beforeinput/input/keyup sequence with jittered
  // delays so the value grows one keystroke at a time instead of
  // appearing instantly — defeats the common bot heuristics (instant
  // value set, no focus, no key events). `maxTotalTypingMs` bounds the
  // cadence so long values (cover letters) don't stall the run.
  async function fillTextInputLikeHuman(
    element,
    value,
    {
      blur = true,
      clearFirst = true,
      perCharDelayMs = 45,
      maxTotalTypingMs = 4000,
      jitterRatio = 0.5,
      shouldAbort = () => false,
    } = {}
  ) {
    if (!element) return;
    const text = String(value ?? "");
    if (text.startsWith("/Volumes/")) return;
    if (element.value === text) return;

    element.focus?.();
    let typed = element.value || "";
    if (clearFirst && typed) {
      setReactInputValue(element, "");
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
      typed = "";
    }

    const baseDelayMs = Math.max(MIN_HUMAN_CHAR_DELAY_MS, Math.min(perCharDelayMs, maxTotalTypingMs / Math.max(text.length, 1)));
    // A real keypress holds the key down briefly before release, and
    // typists pause between words — the hold is part of the per-char
    // budget (subtracted from the inter-key gap, not added on top).
    const keyHoldBaseMs = Math.min(35, baseDelayMs * 0.4);
    const gapBaseMs = Math.max(1, baseDelayMs - keyHoldBaseMs);
    const wordPauseBaseMs = Math.min(160, baseDelayMs * 1.4);

    for (const char of text) {
      if (shouldAbort()) break;
      dispatchCharKeyEvents(element, char, ["keydown", "keypress"]);
      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: char }));
      typed += char;
      setReactInputValue(element, typed);
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: char }));
      await sleep(randomKeyDelayMs(keyHoldBaseMs, 0.6));
      dispatchCharKeyEvents(element, char, ["keyup"]);
      let gapMs = randomKeyDelayMs(gapBaseMs, jitterRatio);
      if (char === " ") gapMs += randomKeyDelayMs(wordPauseBaseMs, 0.5);
      // Occasional heavier "thinking" pause, so the interval histogram is
      // right-skewed (like real typing) rather than a flat jitter band.
      else if (Math.random() < 0.06) gapMs += randomKeyDelayMs(baseDelayMs * 2.5, 0.6);
      await sleep(gapMs);
    }

    element.dispatchEvent(new Event("change", { bubbles: true }));
    if (blur) element.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  // ---- Human-like mouse movement + click ---------------------------------

  function getElementPointerPoint(element) {
    const rect = element.getBoundingClientRect?.() ?? { left: 0, top: 0, width: 0, height: 0 };
    // Aim a little off-centre (not always dead-centre) for a more natural pointer.
    const x = rect.left + rect.width * (0.35 + Math.random() * 0.3);
    const y = rect.top + rect.height * (0.35 + Math.random() * 0.3);
    return { x: Math.round(x), y: Math.round(y) };
  }

  // Last dispatched pointer coordinate, so movementX/Y carry real deltas
  // instead of staying 0 while clientX/clientY advance.
  let lastMovePoint = { x: 0, y: 0 };

  function buildPointerInit(x, y, { button = 0, buttons = 0 } = {}) {
    const chromeHeight = Math.max(0, (window.outerHeight || 0) - (window.innerHeight || 0));
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x + (window.screenX || 0),
      screenY: y + (window.screenY || 0) + chromeHeight,
      movementX: x - lastMovePoint.x,
      movementY: y - lastMovePoint.y,
      button,
      buttons,
    };
    lastMovePoint = { x, y };
    return init;
  }

  function dispatchPointerAndMouse(element, { pointer, mouse }, x, y, { button = 0, buttons = 0, bubbles = true } = {}) {
    const init = { ...buildPointerInit(x, y, { button, buttons }), bubbles };
    if (pointer && typeof PointerEvent === "function") {
      element.dispatchEvent(
        new PointerEvent(pointer, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1, pressure: buttons ? 0.5 : 0 })
      );
    }
    if (mouse) {
      element.dispatchEvent(new MouseEvent(mouse, { ...init, detail: mouse === "mousedown" || mouse === "mouseup" ? 1 : 0 }));
    }
  }

  // The simulated cursor's last viewport position / hovered element, so
  // successive clicks travel a continuous path and boundary-crossing
  // events (over/out, enter/leave) fire correctly as the path moves.
  let lastPointerPosition = null;
  let lastMoveElement = null;

  function dispatchMouseMovePoint(x, y) {
    const target = document.elementFromPoint?.(x, y) || document.body || document.documentElement;
    if (!target) return;
    if (target !== lastMoveElement) {
      if (lastMoveElement) {
        dispatchPointerAndMouse(lastMoveElement, { pointer: "pointerout", mouse: "mouseout" }, x, y);
        dispatchPointerAndMouse(lastMoveElement, { pointer: "pointerleave", mouse: "mouseleave" }, x, y, { bubbles: false });
      }
      dispatchPointerAndMouse(target, { pointer: "pointerover", mouse: "mouseover" }, x, y);
      dispatchPointerAndMouse(target, { pointer: "pointerenter", mouse: "mouseenter" }, x, y, { bubbles: false });
      lastMoveElement = target;
    }
    dispatchPointerAndMouse(target, { pointer: "pointermove", mouse: "mousemove" }, x, y);
  }

  // Glide the simulated cursor from its last position to (x, y) over
  // several eased, slightly-wobbly steps so a behavioural tracker sees a
  // real movement path rather than a jump.
  async function moveMouseAlongPathTo(x, y, { shouldAbort = () => false } = {}) {
    const start = lastPointerPosition || { x: Math.max(0, x - 140), y: Math.max(0, y - 100) };
    const distance = Math.hypot(x - start.x, y - start.y);
    const steps = Math.max(2, Math.min(8, Math.round(distance / 80)));
    for (let i = 1; i <= steps; i++) {
      if (shouldAbort()) break;
      const t = i / steps;
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const wobble = Math.sin(t * Math.PI) * (Math.random() * 6 - 3);
      dispatchMouseMovePoint(Math.round(start.x + (x - start.x) * ease + wobble), Math.round(start.y + (y - start.y) * ease + wobble));
      await sleep(Math.max(1, Math.round(3 + Math.random() * 7)));
    }
    lastPointerPosition = { x, y };
  }

  // Activate a control (radio, checkbox, button, listbox option, or a text
  // field before typing) the way a person would: scroll into view, glide
  // the cursor over along a path, hover, then press+release with a full
  // pointer/mouse sequence and jittered dwell times. The real activation
  // is still element.click() at the end, so the actual selection can
  // never regress — the pointer events only wrap it to look human.
  async function clickLikeHuman(element, { shouldAbort = () => false } = {}) {
    if (!element) return;
    const rect0 = element.getBoundingClientRect?.();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const alreadyVisible = rect0 && rect0.top >= 40 && rect0.bottom <= viewportHeight - 40;
    if (!alreadyVisible) {
      // Scroll like a person: a few wheel events (the input that causes
      // scrolling) before the reliable programmatic scroll, so a scroll
      // position change isn't paired with zero wheel input.
      const direction = rect0 && rect0.top < 0 ? -1 : 1;
      const wheelTicks = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < wheelTicks; i++) {
        if (shouldAbort()) return;
        document.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: window,
            deltaMode: 0,
            deltaY: direction * (90 + Math.random() * 70),
            clientX: lastPointerPosition?.x ?? 0,
            clientY: lastPointerPosition?.y ?? 0,
          })
        );
        await sleep(randomKeyDelayMs(18, 0.5));
      }
      element.scrollIntoView?.({ block: "center", inline: "center" });
      await sleep(randomKeyDelayMs(55, 0.5));
    }
    if (shouldAbort()) return;

    const { x, y } = getElementPointerPoint(element);
    await moveMouseAlongPathTo(x, y, { shouldAbort });
    if (shouldAbort()) return;
    dispatchPointerAndMouse(element, { pointer: "pointermove", mouse: "mousemove" }, x, y);
    await sleep(randomKeyDelayMs(25, 0.6));
    if (shouldAbort()) return;

    dispatchPointerAndMouse(element, { pointer: "pointerdown", mouse: "mousedown" }, x, y, { button: 0, buttons: 1 });
    element.focus?.();
    await sleep(randomKeyDelayMs(30, 0.5));
    if (shouldAbort()) return;

    dispatchPointerAndMouse(element, { pointer: "pointerup", mouse: "mouseup" }, x, y, { button: 0, buttons: 0 });
    element.click();
    lastPointerPosition = { x, y };
  }

  // ---- File upload ---------------------------------------------------

  function base64ToArrayBuffer(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    return bytes.buffer;
  }

  function fillFileInput(element, fileName, base64, mimeType = "application/pdf") {
    const fileContent = base64ToArrayBuffer(base64);
    const dataTransfer = new DataTransfer();
    const fileObj = new File([fileContent], fileName, { type: mimeType });
    dataTransfer.items.add(fileObj);
    const lastFiles = element.files;
    element.files = dataTransfer.files;
    element._valueTracker?.setValue(lastFiles);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Some dropzone widgets (JobDiva, Built In) keep the old File on the
  // native input even after their UI "remove" — re-attaching the same/new
  // file is then a no-op for the framework's onChange. Reset value + the
  // React value tracker, then notify, before re-attaching.
  function clearFileInput(element) {
    if (!element) return;
    const lastFiles = element.files;
    element.value = "";
    element._valueTracker?.setValue(lastFiles);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ---- Select / checkbox / radio ----------------------------------------

  function fillSelectInput(element, value) {
    const lastValue = element.value;
    element.value = value;
    element._valueTracker?.setValue(lastValue);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function getChoiceInputs(field, inputType) {
    if (!field) return [];
    if (field.tagName === "INPUT" && field.type === inputType) return [field];
    return Array.from(field.querySelectorAll(`input[type="${inputType}"]`));
  }
  const getCheckboxInputs = (field) => getChoiceInputs(field, "checkbox");
  const getRadioInputs = (field) => getChoiceInputs(field, "radio");

  // ---- Label resolution ------------------------------------------------

  function escapeAttributeValue(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function getQuestionText(textSource) {
    return textSource?.innerText?.split("\n")[0].replace("*", "").trim() || "";
  }

  // Resolves a control's label via the same priority chain BidHub uses:
  // label[for]=id, then the enclosing <label>. An optional descendantSelector
  // narrows to a specific child of that label (e.g. a text-only span) before
  // falling back to the label's own full text.
  function getInputLabelText(input, fallbackText = "", { descendantSelector = null } = {}) {
    if (!input) return fallbackText;
    if (input.id) {
      const linkedLabel = document.querySelector(`label[for="${escapeAttributeValue(input.id)}"]`);
      const linkedTarget = descendantSelector ? linkedLabel?.querySelector(descendantSelector) : linkedLabel;
      const linkedText = getQuestionText(linkedTarget) || linkedTarget?.textContent?.trim();
      if (linkedText) return linkedText;
    }
    const wrappedLabel = input.closest("label");
    const wrappedTarget = descendantSelector ? wrappedLabel?.querySelector(descendantSelector) : wrappedLabel;
    const wrappedText = getQuestionText(wrappedTarget) || wrappedTarget?.textContent?.trim();
    if (wrappedText) return wrappedText;
    return fallbackText;
  }

  const DEFAULT_TEXT_INPUT_SELECTOR = [
    'input[type="text"]',
    'input[type="email"]',
    'input[type="tel"]',
    'input[type="url"]',
    'input[type="number"]',
    'input[type="password"]',
    "input:not([type])",
  ].join(", ");

  function getNativeSelect(field) {
    if (!field) return null;
    return field.tagName === "SELECT" ? field : field.querySelector("select");
  }
  function getTextarea(field) {
    if (!field) return null;
    return field.tagName === "TEXTAREA" ? field : field.querySelector("textarea");
  }
  function getTextInput(field, selector = DEFAULT_TEXT_INPUT_SELECTOR) {
    if (!field) return null;
    if (field.tagName === "INPUT" && field.type !== "hidden" && field.type !== "file") return field;
    return field.querySelector(selector);
  }
  function getFileInputInsideField(field) {
    if (!field) return null;
    return field.tagName === "INPUT" && field.type === "file" ? field : field.querySelector('input[type="file"]');
  }

  // ---- Shadow-DOM-aware deep query --------------------------------------
  // Several ATS widgets (custom comboboxes, date pickers) render inside an
  // open shadow root — a plain querySelector from `document` never reaches
  // in. These walk every open shadow root in the subtree too.

  function getShadowTraversalRoots(root) {
    if (!root) return [];
    const roots = [];
    if (root instanceof Element && root.shadowRoot) roots.push(root.shadowRoot);
    const queryRoot = root instanceof Document || root instanceof DocumentFragment || root instanceof Element ? root : null;
    if (!queryRoot?.querySelectorAll) return roots;
    queryRoot.querySelectorAll("*").forEach((element) => {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    });
    return roots;
  }

  function querySelectorAllDeep(selector, root = document) {
    if (!selector || !root) return [];
    const results = [];
    const visited = new Set();
    const visit = (currentRoot) => {
      if (!currentRoot || visited.has(currentRoot)) return;
      visited.add(currentRoot);
      if (currentRoot instanceof Element && currentRoot.matches?.(selector)) results.push(currentRoot);
      if (currentRoot.querySelectorAll) results.push(...Array.from(currentRoot.querySelectorAll(selector)));
      getShadowTraversalRoots(currentRoot).forEach(visit);
    };
    visit(root);
    return Array.from(new Set(results));
  }

  function querySelectorDeep(selector, root = document) {
    return querySelectorAllDeep(selector, root)[0] ?? null;
  }

  function closestDeep(element, selector, stopRoot = null) {
    let current = element;
    while (current) {
      if (current instanceof Element && current.matches?.(selector)) return current;
      if (stopRoot && current === stopRoot) return null;
      if (current.parentElement) {
        current = current.parentElement;
        continue;
      }
      const host = current.getRootNode?.()?.host;
      if (!host || host === current) return null;
      current = host;
    }
    return null;
  }

  // ---- Custom (react-select-style) combobox ------------------------------
  // Opens a `.select-shell`/`.select__menu`-shaped combobox, types to
  // filter, and picks the first option whose text starts with `value` —
  // same pattern BidHub's Greenhouse/Workable adapters use for school,
  // location, and similar searchable dropdowns. `menuSelector` lets a
  // per-site adapter point this at its own widget's class names.
  function findOptionElementByText(optionElements, value) {
    const normalizedValue = String(value ?? "").trim().toLowerCase();
    if (!normalizedValue) return null;
    return (
      Array.from(optionElements).find((option) => (option.innerText || option.textContent || "").trim().toLowerCase().startsWith(normalizedValue)) ?? null
    );
  }

  async function waitForCondition(check, timeoutMs, shouldAbort = () => false) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (shouldAbort()) return null;
      const result = check();
      if (result) return result;
      await sleep(80);
    }
    return null;
  }

  async function fillComboboxByTyping(
    field,
    value,
    { menuSelector = '.select-shell .select__menu div[role="option"]', fallback = "Other", timeoutMs = 2500, shouldAbort = () => false } = {}
  ) {
    const text = String(value ?? "").trim();
    if (!text || shouldAbort()) return text;
    await clickLikeHuman(field, { shouldAbort });
    fillTextInput(field, text);
    let options = await waitForCondition(() => {
      const found = document.querySelectorAll(menuSelector);
      return found.length ? found : null;
    }, timeoutMs, shouldAbort);
    let chosen = options ? findOptionElementByText(options, text) : null;
    let appliedValue = text;
    if (!chosen && fallback) {
      fillTextInput(field, fallback);
      options = await waitForCondition(() => {
        const found = document.querySelectorAll(menuSelector);
        return found.length ? found : null;
      }, timeoutMs, shouldAbort);
      chosen = options ? findOptionElementByText(options, fallback) : null;
      appliedValue = fallback;
    }
    if (chosen) chosen.click();
    return appliedValue;
  }

  Object.assign(NS, {
    sleep,
    writeReactTextValue,
    setReactInputValue,
    reassertTextInputValue,
    fillTextInput,
    fillTextInputReliably,
    fillTextInputWithoutBlur,
    fillTextInputLikeHuman,
    getElementPointerPoint,
    dispatchPointerAndMouse,
    dispatchMouseMovePoint,
    moveMouseAlongPathTo,
    clickLikeHuman,
    base64ToArrayBuffer,
    fillFileInput,
    clearFileInput,
    fillSelectInput,
    getCheckboxInputs,
    getRadioInputs,
    getInputLabelText,
    getQuestionText,
    getNativeSelect,
    getTextarea,
    getTextInput,
    getFileInputInsideField,
    DEFAULT_TEXT_INPUT_SELECTOR,
    getShadowTraversalRoots,
    querySelectorAllDeep,
    querySelectorDeep,
    closestDeep,
    findOptionElementByText,
    fillComboboxByTyping,
  });
})();
