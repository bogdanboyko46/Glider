/*
 * bridge.js — content script. Connects the eye tracker's 'struggle' event to the
 * text: the paragraph the reader is stuck on is swapped, in place, for a larger
 * and simpler version.
 *
 *   GazeReader 'struggle' {element, lineText, paragraphText, reason}
 *        -> offline simplifier (simplify/simplifier.js): shown at once
 *        -> Claude rewrite from Glider's rewrite service, asked through the service worker (simplify/claude.js):
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
  const SERVICE_KEY = 'glider:simplifyService';
  const GATE_KEY = 'glider:simplifyGate';   // what the gate has learned about this reader: { bias }
  // auto: false = offer a "Simpler version" button and let the reader choose (the default);
  //       true  = replace the paragraph without asking once the evidence is strong.
  // gate: tests switch it off to exercise the swap machinery directly.
  const DEFAULTS = { enabled: true, useClaude: true, scale: 1.2, auto: false, gate: true };
  const OFFER_MS = 12000;
  const TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'DD', 'FIGCAPTION']);
  const MIN_CHARS = 60, MAX_CHARS = 3000, COOLDOWN_MS = 2500, MAX_ACTIVE = 3;

  const hasChrome = (() => { try { return !!(chrome && chrome.storage && chrome.storage.local); } catch (_) { return false; } })();
  const cfg = { ...DEFAULTS };
  let hasService = false;   // is a rewrite service address configured? (the extension holds no API key)
  let lastAt = -1e9;
  const active = new Map();        // original element -> entry
  const declined = new WeakSet();  // the reader asked for the original back: leave these alone
  const Gate = globalThis.GliderSimplifyGate;
  const TextScore = globalThis.GliderTextScore;
  const gate = Gate ? Gate.create({}) : null;
  const saveBias = () => { if (gate && hasChrome) { try { chrome.storage.local.set({ [GATE_KEY]: { bias: gate.bias } }); } catch (_) { /* context gone */ } } };

  function applyConfig(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    cfg.enabled = 'enabled' in src ? !!src.enabled : DEFAULTS.enabled;
    cfg.useClaude = 'useClaude' in src ? !!src.useClaude : DEFAULTS.useClaude;
    const s = Number(src.scale);
    cfg.scale = Number.isFinite(s) ? Math.min(1.6, Math.max(1, s)) : DEFAULTS.scale;
    cfg.auto = 'auto' in src ? !!src.auto : DEFAULTS.auto;
    cfg.gate = 'gate' in src ? !!src.gate : DEFAULTS.gate;
    if (gate) gate.setMode(cfg.auto ? 'auto' : 'offer');
    if (!cfg.enabled) hideOffer();
    if (!cfg.enabled) restoreAll();
  }
  if (hasChrome) {
    chrome.storage.local.get(SETTINGS_KEY).then((got) => applyConfig(got[SETTINGS_KEY])).catch(() => {});
    chrome.storage.local.get(GATE_KEY).then((got) => { if (gate && got[GATE_KEY]) gate.setBias(got[GATE_KEY].bias); }).catch(() => {});
    askService();
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[SETTINGS_KEY]) applyConfig(changes[SETTINGS_KEY].newValue);
        if (changes[SERVICE_KEY]) askService();
      });
    } catch (_) { /* no live sync */ }
  }

  function askService() {
    let asked;
    try { asked = chrome.runtime.sendMessage({ type: 'glider:simplify:status' }); } catch (_) { return; }
    Promise.resolve(asked).then((r) => { hasService = !!(r && r.ready); }, () => { hasService = false; });
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
    back.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      declined.add(el);
      if (gate) { gate.feedback('undone', el, performance.now()); saveBias(); }   // a quick undo teaches the gate to wait longer
      restore(el);
    });
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
  function restoreAll() { hideOffer(); for (const el of Array.from(active.keys())) restore(el); }

  // ------------------------------------------------------------------ offer
  /* A small button beside the paragraph: "Simpler version". It floats in its own shadow root
     on <html>, so nothing is added to the page's own content and the text does not move. */
  const OFFER_CSS = `
    :host { all: initial; }
    .chip { position: fixed; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 999px; pointer-events: auto;
            background: #2f6b4a; color: #fff; font: 700 12.5px/1.3 "Segoe UI", system-ui, sans-serif; white-space: nowrap;
            box-shadow: 0 4px 14px rgba(32, 53, 42, .28); opacity: 0; transition: opacity .25s ease; }
    .chip[data-show="true"] { opacity: 1; }
    button { all: unset; cursor: pointer; padding: 4px 11px; border-radius: 999px; font: inherit; color: inherit; }
    button.go { background: #fff; color: #20352a; }
    button.go:hover { background: #e0e8d9; }
    button.no { padding: 4px 8px; opacity: .85; }
    button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) { .chip { transition: none; } }
  `;
  let offer = null;   // { el, hint, host, chip, timer }
  function placeOffer() {
    if (!offer) return;
    if (!offer.el.isConnected) { hideOffer(); return; }
    const r = offer.el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) { offer.chip.style.visibility = 'hidden'; return; }
    offer.chip.style.visibility = '';
    const w = offer.chip.offsetWidth || 170, h = offer.chip.offsetHeight || 30;
    offer.chip.style.left = Math.round(Math.max(8, Math.min(innerWidth - w - 8, r.right - w))) + 'px';
    offer.chip.style.top = Math.round(Math.max(8, Math.min(innerHeight - h - 8, r.top - h - 6))) + 'px';
  }
  function showOffer(el, hint) {
    hideOffer();
    const host = document.createElement('div');
    host.id = 'glider-simplify-offer';
    host.setAttribute('data-glider-ignore', '');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;';
    const sr = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = OFFER_CSS;
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.setAttribute('role', 'group');
    chip.setAttribute('aria-label', 'Simpler version of this paragraph');
    const go = document.createElement('button');
    go.type = 'button'; go.className = 'go'; go.textContent = 'Simpler version';
    const no = document.createElement('button');
    no.type = 'button'; no.className = 'no'; no.textContent = 'No thanks'; no.title = 'Leave this paragraph as it is';
    chip.append(go, no);
    sr.append(style, chip);
    document.documentElement.appendChild(host);
    offer = { el, hint, host, chip, timer: 0 };
    go.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const o = offer; hideOffer();
      if (gate) { gate.feedback('accepted', o.el, performance.now()); saveBias(); }
      swapKeepingPlace(o.el, o.hint);
    });
    no.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const o = offer; hideOffer();
      declined.add(o.el);
      if (gate) { gate.feedback('dismissed', o.el, performance.now()); saveBias(); }
    });
    placeOffer();
    requestAnimationFrame(() => { if (offer && offer.chip === chip) chip.dataset.show = 'true'; });
    offer.timer = setTimeout(() => {
      if (!offer || offer.chip !== chip) return;
      if (chip.matches(':hover, :focus-within')) { offer.timer = setTimeout(() => hideOffer('ignored'), 4000); return; }
      hideOffer('ignored');
    }, OFFER_MS);
    emit('glider:simplify-offer', { source: 'offer' });
  }
  function hideOffer(why) {
    if (!offer) return;
    const o = offer; offer = null;
    clearTimeout(o.timer);
    o.host.remove();
    if (why === 'ignored' && gate) { gate.feedback('ignored', o.el, performance.now()); saveBias(); }
  }
  addEventListener('scroll', placeOffer, { passive: true, capture: true });
  addEventListener('resize', placeOffer, { passive: true });

  /** Swap, then make sure the reader can see where the paragraph now starts. */
  function swapKeepingPlace(el, hint) {
    const entry = simplifyElement(el, hint);
    if (!entry) return null;
    const r = entry.clone.getBoundingClientRect();
    if (r.top < 70 || r.top > innerHeight - 120) {
      try { window.scrollBy({ top: r.top - Math.min(140, innerHeight / 4), behavior: 'instant' }); } catch (_) { window.scrollBy(0, r.top - 140); }
    }
    return entry;
  }

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
    if (cfg.useClaude && hasService && hasChrome) {
      setLabel(entry, 'pending');
      let asked;
      try { asked = chrome.runtime.sendMessage({ type: 'glider:simplify', text, lineText: hint.coarse ? '' : String(hint.lineText || '') }); }   // a coarse struggle only knows "about here"
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
    const el = detail.element;
    if (!gate || !cfg.gate) {   // ungated path, kept for tests of the swap machinery
      if (now - lastAt < COOLDOWN_MS) return;
      if (simplifyElement(el, detail)) lastAt = now;
      return;
    }
    if (!eligible(el)) return;
    const text = String(detail.paragraphText || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < MIN_CHARS || text.length > MAX_CHARS) return;
    const decision = gate.evaluate(detail, {
      text, simplified: Simplify.simplify(text).text, meta: TextScore ? TextScore.domMeta(el) : null,
      serviceReady: cfg.useClaude && hasService, now,
    });
    lastDecision = decision;
    if (decision.action === 'offer') { showOffer(el, detail); return; }
    if (decision.action === 'swap') {
      hideOffer();
      if (swapKeepingPlace(el, detail)) { lastAt = now; return false; }   // false: the tracker's line highlight would sit on text that has just gone
    }
  }   // otherwise returns undefined on purpose: Glider's gentler help for this struggle still runs

  /* The tracker's once-a-second "how far, how long" sample for the paragraph being read. */
  const textCache = new WeakMap();   // element -> { text, simplified, meta, at }
  function textOf(el) {
    const c = textCache.get(el), now = performance.now();
    if (c && now - c.at < 15000) return c;
    const text = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const fresh = { text, simplified: Simplify.simplify(text).text, meta: TextScore ? TextScore.domMeta(el) : null, at: now };
    textCache.set(el, fresh);
    return fresh;
  }
  function handleProgress(p) {
    if (!cfg.enabled || !cfg.gate || !gate || !p || !p.element) return;
    const el = p.element;
    if (!eligible(el)) return;
    const t = textOf(el);
    if (t.text.length < MIN_CHARS || t.text.length > MAX_CHARS) return;
    const now = performance.now();
    const decision = gate.evaluateProgress(p, { text: t.text, simplified: t.simplified, meta: t.meta, serviceReady: cfg.useClaude && hasService, now });
    if (decision.action === 'none' && decision.why === 'pace-normal') return;
    lastDecision = decision;
    const hint = { element: el, paragraphText: t.text, lineText: '', coarse: true };
    if (decision.action === 'offer') showOffer(el, hint);
    else if (decision.action === 'swap') { hideOffer(); if (swapKeepingPlace(el, hint)) lastAt = now; }
  }
  let lastDecision = null;

  function bind() {
    const G = globalThis.GazeReader;
    if (!G || typeof G.on !== 'function') return false;
    G.on('struggle', (d) => { try { return handleStruggle(d); } catch (e) { console.warn('[glider] simplify failed', e); } });
    G.on('progress', (p) => { try { handleProgress(p); } catch (e) { console.warn('[glider] simplify failed', e); } });
    // Tracking stopped (eye tracking or the lens was switched off): the page goes back to how it was.
    G.on('status', (s) => { if (s && s.status === 'idle') restoreAll(); });
    return true;
  }
  bind();

  window.GliderSimplifyBridge = {
    handleStruggle, handleProgress, simplifyElement, restore, restoreAll,
    gate, lastDecision: () => lastDecision, offer: () => (offer ? { el: offer.el, shown: offer.chip.dataset.show === 'true' } : null),
    active: () => Array.from(active.values()).map((e) => ({ source: e.source, text: e.body.textContent, original: e.original })),
    config: () => ({ ...cfg, hasService }),
    _set(next) { if ('hasService' in next) hasService = !!next.hasService; applyConfig({ ...cfg, ...next }); lastAt = -1e9; },
  };
})();
