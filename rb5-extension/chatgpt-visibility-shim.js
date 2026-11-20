/* =====================================================================
 * chatgpt-visibility-shim.js — makes chatgpt.com believe it's always the
 * visible, focused tab, even while Big Banana is running it in a
 * deliberately unfocused/background window (see openFreshBananaChatGptTab
 * in sidepanel.js).
 *
 * Confirmed via live testing: typing the prompt and submitting it both work
 * fine while the window is backgrounded — ChatGPT's own UI shows the
 * message as sent — but actually GENERATING a reply never starts until the
 * window is brought to the front, and comes back instantly the moment it
 * is. That's consistent with ChatGPT's own app explicitly checking
 * document.hidden/visibilityState (or document.hasFocus()) before kicking
 * off the request, and/or relying on requestAnimationFrame — which Chrome
 * throttles to near-zero for a backgrounded/occluded window, a browser-
 * level decision no page script can see around on its own.
 *
 * This file runs in the page's own MAIN world (not the usual isolated
 * content-script world — see manifest.json's "world": "MAIN" on this
 * entry) at document_start, before chatgpt.com's own bundle executes, so
 * whatever it reads for "am I visible" and "give me a render callback"
 * gets these answers from the very first check.
 * ===================================================================== */
(function () {
  "use strict";
  try {
    Object.defineProperty(document, "hidden", { get: () => false, configurable: true });
    Object.defineProperty(document, "visibilityState", { get: () => "visible", configurable: true });
    document.hasFocus = () => true;
  } catch (e) {
    /* best-effort — never break the page over this */
  }

  // requestAnimationFrame redirected to a timer instead of the browser's
  // native (and, for an occluded window, heavily throttled) implementation
  // — setTimeout isn't subject to the same near-zero throttle, so anything
  // ChatGPT schedules through rAF keeps running on a normal cadence
  // regardless of window visibility/focus.
  try {
    let nextId = 1;
    const pending = new Map();
    window.requestAnimationFrame = (cb) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        try {
          cb(performance.now());
        } catch (e) {
          /* a throwing rAF callback shouldn't break the shim itself */
        }
      }, 16);
      pending.set(id, timer);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      const timer = pending.get(id);
      if (timer != null) {
        clearTimeout(timer);
        pending.delete(id);
      }
    };
  } catch (e) {
    /* best-effort */
  }
})();
