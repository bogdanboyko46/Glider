/*
 * bridge.js — content script. Connects the eye tracker's 'struggle' event to the
 * text: the paragraph the reader is stuck on is swapped, in place, for a larger
 * and simpler version.
 *
 *   GazeReader 'struggle' {element, lineText, paragraphText, reason}
 *        -> offline simplifier (simplify/simplifier.js): shown at once
 *        -> Claude rewrite via the service worker (simplify/claude.js), when an API key is saved:
 *           replaces the offline text when it arrives
 *
 * The page's own paragraph is never edited. It is hidden and a stand-in with the
 * same tag and classes is placed right after it, so "Show original", turning the
 * lens off or stopping eye tracking puts the page back exactly as it was, and
 * frameworks that own the paragraph (React, Vue) keep their nodes.
 *
 * Settings (chrome.storage.local 'glider:simplify'): { enabled: true, useClaude: true, scale: 1.2 }.
 * Test and manual hook: window.GliderSimplifyBridge.
 */
(() => {
  'use strict';
  if (window.__gliderSimplifyBridge || window.top !== window) return;
  window.__gliderSimplifyBridge = true;
  const Simplify = globalThis.GliderSimplify;
  if (!Simplify) return;

  const SETTINGS_KEY = 'glider:simplify';
  const API_KEY_NAME = 'glider:anthropicKey';
  const DEFAULTS = { enabled: true, useClaude: true, scale: 1.2 };
  const TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'DD', 'FIGCAPTION']);
  const MIN_CHARS = 60, MAX_CHARS = 3000, COOLDOWN_MS = 2500, MAX_ACTIVE = 3;

  const hasChrome = (() => { try { return !!(chrome && chrome.storage && chrome.storage.local); } catch (_) { return false; } })();
  const cfg = { ...DEFAULTS };
  let hasKey = false;
  let lastAt = -1e9;
  const active = new Map();        // original element -> entry
  const declined = new WeakSet();  // the reader asked for the original back: leave these alone

  function applyConfig(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    cfg.enabled = 'enabled' in src ? !!src.enabled : DEFAULTS.enabled;
    cfg.useClaude = 'useClaude' in src ? !!src.useClaude : DEFAULTS.useClaude;
    const s = Number(src.scale);
    cfg.scale = Number.isFinite(s) ? Math.min(1.6, Math.max(1, s)) : DEFAULTS.scale;
    if (!cfg.enabled) restoreAll();
  }
  if (hasChrome) {
    chrome.storage.local.get([SETTINGS_KEY, API_KEY_NAME]).then((got) => {
      applyConfig(got[SETTINGS_KEY]);
      hasKey = !!String(got[API_KEY_NAME] || '').trim();
    }).catch(() => {});
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[SETTINGS_KEY]) applyConfig(changes[SETTINGS_KEY].newValue);
        if (changes[API_KEY_NAME]) hasKey = !!String(changes[API_KEY_NAME].newValue || '').trim();
      });
    } catch (_) { /* no live sync */ }
  }

  // ------------------------------------------------------------------ styles
  const STYLE_ID = 'glider-simplify-style';
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
      [data-glider-hidden] { display: none !important; }
      [data-glider-simplified] {
        position: relative !important;
        line-height: 1.9 !important;
        letter-spacing: .02em !important;
        word-spacing: .12em !important;
        text-align: left !important;
        hyphens: manual !important;
        background: #fff6d6 !important;
        color: #1d241f !important;
        border-radius: 6px !important;
        box-shadow: 0 0 0 10px #fff6d6, -14px 0 0 0 #2f6b4a !important;
        margin-top: 34px !important;
        margin-bottom: 26px !important;
        animation: glider-simple-in .5s ease both;
      }
      [data-glider-simplified][data-glider-swap] > .glider-simple__text { animation: glider-simple-swap .45s ease both; }
      .glider-simple__bar { position: absolute !important; right: -6px !important; top: -32px !important; display: block !important; }
      @keyframes glider-simple-in { from { opacity: .2; transform: scale(.94); transform-origin: left top; } to { opacity: 1; transform: none; } }
      @keyframes glider-simple-swap { from { opacity: .15; } to { opacity: 1; } }
      @media (prefers-reduced-motion: reduce) { [data-glider-simplified], [data-glider-simplified] > .glider-simple__text { animation: none !important; } }
      @media print { [data-glider-simplified] { display: none !important; } [data-glider-hidden] { display: revert !important; } }
    `;
    document.documentElement.appendChild(st);
  }
  const BAR_CSS = `
    :host { all: initial; }
    .bar { display: inline-flex; align-items: center; gap: 8px; padding: 3px 4px 3px 10px; border-radius: 999px;
           background: #2f6b4a; color: #fff; font: 700 12px/1.3 "Segoe UI", system-ui, sans-serif; white-space: nowrap; }
    button { all: unset; cursor: pointer; padding: 3px 10px; border-radius: 999px; background: #fff; color: #20352a; font: inherit; }
    button:hover { background: #e0e8d9; }
    button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
  `;
  const LABELS = { offline: 'Simplified', pending: 'Simplified · improving…', claude: 'Simplified by Claude' };

  // ------------------------------------------------------------------- swap
  function eligible(el) {
    if (!(el instanceof Element) || !el.isConnected) return false;
    if (!TAGS.has(el.tagName) && !el.hasAttribute('data-gr-block')) return false;
    if (el.closest('[data-glider-simplified], [data-glider-ignore], #glider-root')) return false;
    if (el.hasAttribute('data-glider-hidden') || active.has(el) || declined.has(el)) return false;
    if (el.isContentEditable || el.querySelector('input, textarea, select, button, video, iframe, table')) return false;
    return true;
  }

  function show(el, text) {
    ensureStyle();
    const clone = el.cloneNode(false);
    clone.removeAttribute('id');
    clone.removeAttribute('data-glider-hidden');
    clone.classList.remove('glider-ease');
    clone.setAttribute('data-glider-simplified', '');
    clone.setAttribute('aria-live', 'polite');
    const px = parseFloat(getComputedStyle(el).fontSize) || 16;
    clone.style.setProperty('font-size', (px * cfg.scale).toFixed(1) + 'px', 'important');

    const body = document.createElement('span');
    body.className = 'glider-simple__text';
    body.textContent = text;

    const host = document.createElement('span');
    host.className = 'glider-simple__bar';
    host.setAttribute('data-glider-ignore', '');
    host.setAttribute('contenteditable', 'false');
    const sr = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = BAR_CSS;
    const bar = document.createElement('span');
    bar.className = 'bar';
    const label = document.createElement('span');
    const back = document.createElement('button');
    back.type = 'button';
    back.textContent = 'Show original';
    back.title = 'Put the original text back';
    bar.append(label, back);
    sr.append(style, bar);

    clone.append(body, host);
    const entry = { el, clone, body, label, source: 'offline', original: text, at: performance.now() };
    back.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); declined.add(el); restore(el); });
    setLabel(entry, 'offline');

    el.after(clone);
    el.setAttribute('data-glider-hidden', '');
    active.set(el, entry);
    if (active.size > MAX_ACTIVE) restore(active.keys().next().value);
    emit('glider:simplified', entry);
    return entry;
  }

  function setLabel(entry, source) {
    entry.source = source;
    entry.label.textContent = LABELS[source] || LABELS.offline;
    entry.clone.setAttribute('data-glider-source', source === 'pending' ? 'offline' : source);
  }

  function update(entry, text, source) {
    if (active.get(entry.el) !== entry) return;        // restored meanwhile
    if (text && text !== entry.body.textContent) {
      entry.clone.removeAttribute('data-glider-swap');
      entry.body.textContent = text;
      void entry.clone.offsetWidth;                    // restart the fade
      entry.clone.setAttribute('data-glider-swap', '');
    }
    setLabel(entry, source);
    emit('glider:simplified', entry);
  }

  function restore(el) {
    const entry = active.get(el);
    if (!entry) return;
    active.delete(el);
    entry.clone.remove();
    el.removeAttribute('data-glider-hidden');
  }
  function restoreAll() { for (const el of Array.from(active.keys())) restore(el); }

  function emit(name, entry) {
    try { document.dispatchEvent(new CustomEvent(name, { detail: { source: entry.source } })); } catch (_) { /* never matters */ }
  }

  // ----------------------------------------------------------------- engine
  /** Simplify one block now. Returns the entry, or null when the block is not suitable. */
  function simplifyElement(el, hint = {}) {
    if (!eligible(el)) return null;
    const text = String(hint.paragraphText || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < MIN_CHARS || text.length > MAX_CHARS) return null;
    const offline = Simplify.simplify(text);
    const entry = show(el, offline.text || text);
    entry.original = text;
    if (cfg.useClaude && hasKey && hasChrome) {
      setLabel(entry, 'pending');
      let asked;
      try { asked = chrome.runtime.sendMessage({ type: 'glider:simplify', text, lineText: String(hint.lineText || '') }); }
      catch (_) { asked = Promise.resolve(null); }
      Promise.resolve(asked).then(
        (reply) => { if (reply && reply.ok && reply.text) update(entry, reply.text, 'claude'); else update(entry, '', 'offline'); },
        () => update(entry, '', 'offline'),
      );
    }
    return entry;
  }

  /** The eye tracker says the reader is struggling with a line of this block. */
  function handleStruggle(detail) {
    if (!cfg.enabled || !detail || !detail.element) return;
    const now = performance.now();
    if (now - lastAt < COOLDOWN_MS) return;
    if (simplifyElement(detail.element, detail)) lastAt = now;
  }   // returns undefined on purpose: returning false would cancel Glider's other help for this struggle

  function bind() {
    const G = globalThis.GazeReader;
    if (!G || typeof G.on !== 'function') return false;
    G.on('struggle', (d) => { try { handleStruggle(d); } catch (e) { console.warn('[glider] simplify failed', e); } });
    // Tracking stopped (eye tracking or the lens was switched off): the page goes back to how it was.
    G.on('status', (s) => { if (s && s.status === 'idle') restoreAll(); });
    return true;
  }
  bind();

  window.GliderSimplifyBridge = {
    handleStruggle, simplifyElement, restore, restoreAll,
    active: () => Array.from(active.values()).map((e) => ({ source: e.source, text: e.body.textContent, original: e.original })),
    config: () => ({ ...cfg, hasKey }),
    _set(next) { if ('hasKey' in next) hasKey = !!next.hasKey; applyConfig({ ...cfg, ...next }); lastAt = -1e9; },
  };
})();
