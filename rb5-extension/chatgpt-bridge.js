// Manual-mode bridge: lets sidepanel.js run a prompt on a live ChatGPT tab
// and read back the assistant's reply, instead of calling OpenAI directly.
// Ported from gpt-extension/content.js's own battle-tested automation (same
// selectors/polling — that file mirrors a *live* ChatGPT answer in real
// time; this one just needs a single prompt-in, reply-out round trip), but
// kept as its own file with its own BANANA_* message names so it never
// collides with gpt-extension's GPTMIRROR_* messages if both extensions are
// ever installed and pointed at the same ChatGPT tab at once. Injected
// on-demand by sidepanel.js via chrome.scripting.executeScript — not a
// static content_scripts entry — so it never runs on pages that aren't
// actually being used for Manual mode.
(() => {
  if (window.__bananaChatGptBridgeInstalled) return;
  window.__bananaChatGptBridgeInstalled = true;

  const ASSISTANT_SELECTOR = '[data-message-author-role="assistant"], [data-content-search-unit-key$=":assistant"]';
  const ASSISTANT_BODY_SELECTOR = '[data-markdown-text-style="assistant-message"]';
  const STOP_BUTTON_SELECTOR = 'button[aria-label*="Stop" i], button[data-testid="stop-button"]';
  const COMPOSER_SELECTOR = [
    '#prompt-textarea',
    '[data-testid="prompt-textarea"]',
    '[contenteditable="true"][data-composer-markdown]',
    '[contenteditable="true"][role="textbox"]',
    '.ProseMirror[contenteditable="true"]',
  ].join(', ');
  const SEND_BUTTON_SELECTOR = 'button[data-testid="send-button"], button[aria-label="Send" i]';
  const STABLE_MS = 1500;
  // How long the VISIBLE text must sit unchanged after the Stop button
  // disappears before that's trusted as "done" — see waitForAssistantReply's
  // own comment for why this exists at all: a background tab (Big Banana's
  // ChatGPT tabs normally run in one, see openFreshBananaChatGptTab in
  // sidepanel.js) gets its requestAnimationFrame-gated paints throttled by
  // Chrome, so the DOM can still be a few chunks behind the real stream even
  // though the network side (and therefore the Stop button) already finished
  // — reading the text the instant the button vanishes silently captured a
  // truncated reply (confirmed via a live server log: the JSON cut off
  // mid-string, "bad_ai_json"). A visible/focused tab settles near-instantly
  // either way, so this only adds real delay in the one case that needs it.
  const BUTTON_GONE_STABLE_MS = 1200;
  const BUTTON_GONE_STABLE_MS_BG = 3000;

  function assistantText(node) {
    const body = node.querySelector?.(ASSISTANT_BODY_SELECTOR);
    return (body || node).innerText || '';
  }

  function isStreaming() {
    return !!document.querySelector(STOP_BUTTON_SELECTOR);
  }

  function lastAssistantText() {
    const turns = document.querySelectorAll(ASSISTANT_SELECTOR);
    if (!turns.length) return null;
    const node = turns[turns.length - 1];
    return { node, text: assistantText(node) };
  }

  // Skips hidden decoy elements some pages keep around that also match
  // COMPOSER_SELECTOR and can come first in document order.
  function findComposer() {
    const candidates = document.querySelectorAll(COMPOSER_SELECTOR);
    for (const el of candidates) {
      if (el.offsetParent !== null || el.getClientRects().length > 0) return el;
    }
    return candidates[0] || null;
  }

  function pressEnterToSend(el) {
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  // The tab's own 'complete' status (what sidepanel.js's
  // openFreshBananaChatGptTab waits for before even sending BANANA_RUN_PROMPT)
  // only means the document/subresources finished loading — ChatGPT's React
  // app mounts the composer textbox well after that, and a specific chat/
  // custom-GPT URL (vs. the bare chatgpt.com landing page) can take
  // noticeably longer still (loading a conversation's history, a GPT's own
  // config/greeting). runPrompt used to call findComposer() exactly once,
  // synchronously, the instant the message arrived — failing immediately
  // with "couldn't find the message box" on any tab that hadn't finished
  // hydrating yet, which is exactly what "opens the tab but never types
  // anything" looks like from the outside. Poll instead of asserting.
  function waitForComposer(runId, onReady, onTimeout, tries) {
    if (runId !== currentRunId) {
      onTimeout();
      return;
    }
    const composer = findComposer();
    if (composer) {
      onReady(composer);
      return;
    }
    if ((tries || 0) >= 150) {
      onTimeout();
      return;
    }
    setTimeout(() => waitForComposer(runId, onReady, onTimeout, (tries || 0) + 1), 100);
  }

  function clickSendWhenReady(onReady, onTimeout, tries) {
    const btn = document.querySelector(SEND_BUTTON_SELECTOR);
    const disabled = !!btn && (btn.disabled || btn.getAttribute('aria-disabled') === 'true');
    if (btn && !disabled) {
      btn.click();
      onReady();
      return;
    }
    if ((tries || 0) >= 20) {
      onTimeout();
      return;
    }
    setTimeout(() => clickSendWhenReady(onReady, onTimeout, (tries || 0) + 1), 100);
  }

  // Whether `text` looks like a FINISHED fenced/bare JSON reply, not a
  // still-streaming partial one — composeManualPrompt's own prompt asks
  // ChatGPT for exactly one ```json fence and nothing else, so "does the
  // fence/braces look closed" is a solid completeness signal specific to
  // this use case. Gates the text-stability fallback below (see its own
  // comment): the STOP button disappearing is a strong, authoritative
  // "ChatGPT itself says it's done" signal and is trusted unconditionally,
  // but a mere quiet gap in the streamed text is not — a long JSON payload
  // can legitimately pause mid-generation for well over STABLE_MS (a
  // "thinking" phase, a slow network chunk), and treating that pause alone
  // as "done" was silently handing finishManualGenerate a truncated
  // mid-object reply, which is what made Manual mode read as "sometimes it
  // just doesn't work" — it wasn't a parse-logic bug (extractJsonPayload on
  // the server is already quite robust), it was this file handing back
  // incomplete text in the first place.
  function looksComplete(text) {
    if (!text) return false;
    const fences = text.match(/```/g);
    if (fences && fences.length % 2 !== 0) return false; // an opened fence with no closing one yet
    let depth = 0;
    let inString = false;
    let escape = false;
    let sawOpenBrace = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escape) escape = false;
        else if (ch === '\\') escape = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') {
        depth++;
        sawOpenBrace = true;
      } else if (ch === '}') {
        depth--;
      }
    }
    return sawOpenBrace && depth <= 0;
  }

  let currentRunId = 0;
  function waitForAssistantReply(beforeText, runId, timeoutMs) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let seenStreaming = false;
      let diverged = false;
      let lastText = null;
      let stableSince = null;
      const poll = () => {
        if (runId !== currentRunId) {
          resolve({ ok: false, error: 'Cancelled.', cancelled: true });
          return;
        }
        const cur = lastAssistantText();
        let streaming = false;
        let text = '';
        let buttonSaysDone = false;
        let textSaysDone = false;
        if (cur) {
          text = cur.text;
          if (!diverged && text !== beforeText) diverged = true;
          if (diverged) {
            streaming = isStreaming();
            if (streaming) seenStreaming = true;
            if (text !== lastText) {
              lastText = text;
              stableSince = Date.now();
            }
            const stableMs = stableSince ? Date.now() - stableSince : 0;
            // Stop-button-gone is still ChatGPT's own authoritative "the
            // network stream finished" signal — but in a background tab that
            // doesn't mean the DOM has actually caught up to it yet (see
            // BUTTON_GONE_STABLE_MS_BG's own comment), so it additionally has
            // to have gone quiet for a grace period. Belt-and-braces for the
            // background case specifically: ALSO require looksComplete, same
            // structural check textSaysDone always used — a throttled tab can
            // in principle sit "stable" on a truncated chunk for the whole
            // grace period (the next repaint just hasn't happened yet), and
            // this is the one thing that can tell that apart from a reply
            // that's actually finished, regardless of how long the stall
            // lasts. A foreground tab's DOM never lags like this, so it stays
            // exactly as unconditional as before.
            const buttonGoneGraceMs = document.hidden ? BUTTON_GONE_STABLE_MS_BG : BUTTON_GONE_STABLE_MS;
            buttonSaysDone =
              seenStreaming && !streaming && stableMs >= buttonGoneGraceMs &&
              (!document.hidden || looksComplete(text));
            // This is the path that matters when the Stop button was never
            // reliably observed at all (seenStreaming stayed false).
            textSaysDone = !streaming && !!text && stableMs >= STABLE_MS && looksComplete(text);
            // Best-effort live mirror for the side panel's Generate button
            // (see BANANA_STREAM_CHUNK in sidepanel.js) — one-way, no
            // response expected, so a missing listener (panel closed) is
            // silently ignored rather than thrown.
            try {
              chrome.runtime.sendMessage({ type: 'BANANA_STREAM_CHUNK', runId, text, done: false });
            } catch { /* no listener — nothing to mirror to right now */ }
          }
        }
        if (diverged && (buttonSaysDone || textSaysDone)) {
          try {
            chrome.runtime.sendMessage({ type: 'BANANA_STREAM_CHUNK', runId, text, done: true });
          } catch { /* ignore */ }
          resolve({ ok: true, text });
          return;
        }
        if (Date.now() - startedAt > (timeoutMs || 180000)) {
          resolve({ ok: false, error: 'Timed out waiting for a response from ChatGPT.' });
          return;
        }
        setTimeout(poll, 200);
      };
      poll();
    });
  }

  function runPrompt(text) {
    const runId = ++currentRunId;
    return new Promise((resolve) => {
      waitForComposer(
        runId,
        (composer) => {
          const beforeText = lastAssistantText()?.text ?? null;
          composer.focus();
          document.execCommand('selectAll', false, null);
          document.execCommand('insertText', false, text);
          // A Big Banana prompt (profile + JD + instructions) can run tens
          // of thousands of characters — pressing Enter in the SAME tick as
          // that large an insertText risks submitting before ChatGPT's own
          // ProseMirror editor has actually finished processing the paste,
          // so Enter lands on a composer that (from ChatGPT's own React
          // state) still reads as not-yet-updated and does nothing. That
          // read as "ChatGPT just sits there" — nothing was ever actually
          // sent. A plain setTimeout, not the two-requestAnimationFrame wait
          // this used to be — rAF callbacks don't fire AT ALL for a hidden
          // tab (confirmed: the prompt sat typed-but-never-submitted in the
          // composer until the tab was manually brought to the front), and
          // this tab runs in its own unfocused window specifically so it can
          // stay backgrounded (see openFreshBananaChatGptTab in
          // sidepanel.js) — the trigger for "has the paste settled yet" has
          // to work regardless of visibility, and a fixed delay comfortably
          // longer than two paint frames does that unconditionally.
          setTimeout(() => {
            pressEnterToSend(composer);
            clickSendWhenReady(
              () => waitForAssistantReply(beforeText, runId).then(resolve),
              () => waitForAssistantReply(beforeText, runId).then(resolve)
            );
          }, 50);
        },
        () => resolve({ ok: false, error: "Couldn't find ChatGPT's message box on this page." })
      );
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'BANANA_PING') {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'BANANA_CANCEL_RUN') {
      currentRunId++;
      sendResponse({ ok: true });
      return;
    }
    if (msg.type !== 'BANANA_RUN_PROMPT') return;
    runPrompt(String(msg.text || '')).then(sendResponse);
    return true; // keep the async message channel open for sendResponse above
  });
})();
