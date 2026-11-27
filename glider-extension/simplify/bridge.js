/*
 * bridge.js — content script. Connects the eye tracker to the text: a paragraph the reader
 * is stuck on is swapped, in place, for a simpler version, and once that has happened, hard
 * paragraphs further down are swapped too, before the reader gets to them.
 *
 *   GazeReader 'progress' -> the gate (simplify/gate.js) decides; only its automatic rule swaps: the
 *        reader's pace on the paragraph, against their own measured baseline, held for seconds
 *        -> offline simplifier (simplify/simplifier.js)
 *        -> Claude rewrite from Glider's rewrite service, asked through the service worker
 *           (simplify/claude.js), used only where the reader cannot see it arrive
 *
 * Seamless: the stand-in has the paragraph's own tag and classes and no styling of its own,
 * so the only visible difference is the wording. There is no prompt, label or animation.
 * With the panel's "See original" switch on, the same faint mark adapt/adapt.js uses sits at
 * the end of a swapped paragraph and puts the original back.
 *
 * Before the reader sees it: after the first swap on a page, paragraphs below the window that
 * are at least as hard as the one the reader struggled with are swapped ahead of time, a few at
 * a time as the reader scrolls. A paragraph on screen is only ever swapped because of a struggle
 * on it. Putting a paragraph back ("See original") stops the ahead-of-time swaps on that page.
 *
 * The page's own paragraph is never edited. It is hidden and the stand-in is placed right after
 * it, so "See original", turning the lens off or stopping eye tracking puts the page back exactly
 * as it was, and frameworks that own the paragraph (React, Vue) keep their nodes.
 *
 * Settings (chrome.storage.local 'glider:simplify'): { enabled: true, useClaude: true }.
 * Test and manual hook: window.GliderSimplifyBridge.
 */
(() => {
  'use strict';
  if (window.__gliderSimplifyBridge || window.top !== window) return;
  window.__gliderSimplifyBridge = true;
  const Simplify = globalThis.GliderSimplify;
  if (!Simplify) return;

  const SETTINGS_KEY = 'glider:simplify';
  const PANEL_KEY = 'glider:settings:v2';   // the panel's settings (content/content.js): { seeOriginal }
  const SERVICE_KEY = 'glider:simplifyService';
  const GATE_KEY = 'glider:simplifyGate';   // what the gate has learned about this reader: { bias }
  // gate: tests switch it off to exercise the swap machinery directly.
  const DEFAULTS = { enabled: true, useClaude: true, gate: true };
  const TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'DD', 'FIGCAPTION']);
  const MIN_CHARS = 60, MAX_CHARS = 3000, COOLDOWN_MS = 2500, MAX_ACTIVE = 12;
  const AHEAD_MAX = 3;            // paragraphs swapped ahead of the reader at a time (below the window)
  const AHEAD_MARGIN = 0.05;      // ahead: at least as hard as the paragraph struggled with, less this (difficulty 0..1)
  const AHEAD_SCAN_MS = 400;      // scroll pause before looking ahead again
  const CLS_TOGGLE = 'glider-adapt-toggle';   // drawn by content/content.css

  const hasChrome = (() => { try { return !!(chrome && chrome.storage && chrome.storage.local); } catch (_) { return false; } })();
  const cfg = { ...DEFAULTS };
  let seeOriginal = false;   // the panel's "See original" switch
  let hasService = false;    // is a rewrite service address configured? (the extension holds no API key)
  let lastAt = -1e9;
  const active = new Map();        // original element -> entry
  const declined = new WeakSet();  // the reader asked for the original back: leave these alone
  const Gate = globalThis.GliderSimplifyGate;
  const TextScore = globalThis.GliderTextScore;
  const gate = Gate ? Gate.create({}) : null;
  if (gate) gate.setMode('auto');
  const saveBias = () => { if (gate && hasChrome) { try { chrome.storage.local.set({ [GATE_KEY]: { bias: gate.bias } }); } catch (_) { /* context gone */ } } };
  // ahead: null until the first swap on this page; then { level } (difficulty of the paragraph struggled with); false once the reader put one back
  let ahead = null;

  function applyConfig(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    cfg.enabled = 'enabled' in src ? !!src.enabled : DEFAULTS.enabled;
    cfg.useClaude = 'useClaude' in src ? !!src.useClaude : DEFAULTS.useClaude;
    cfg.gate = 'gate' in src ? !!src.gate : DEFAULTS.gate;
    if (!cfg.enabled) restoreAll();
  }
  function applyPanel(raw) {
    const next = !!(raw && typeof raw === 'object' && raw.seeOriginal);
    if (next === seeOriginal) return;
    seeOriginal = next;
    for (const entry of active.values()) syncControl(entry);
  }
  if (hasChrome) {
    chrome.storage.local.get([SETTINGS_KEY, PANEL_KEY]).then((got) => { applyConfig(got[SETTINGS_KEY]); applyPanel(got[PANEL_KEY]); }).catch(() => {});
    chrome.storage.local.get(GATE_KEY).then((got) => { if (gate && got[GATE_KEY]) gate.setBias(got[GATE_KEY].bias); }).catch(() => {});
    askService();
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[SETTINGS_KEY]) applyConfig(changes[SETTINGS_KEY].newValue);
        if (changes[PANEL_KEY]) applyPanel(changes[PANEL_KEY].newValue);
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
      @media print { [data-glider-simplified] { display: none !important; } [data-glider-hidden] { display: revert !important; } }
    `;
    document.documentElement.appendChild(st);
  }

  // ------------------------------------------------------------------- swap
  function eligible(el) {
    if (!(el instanceof Element) || !el.isConnected) return false;
    if (!TAGS.has(el.tagName) && !el.hasAttribute('data-gr-block')) return false;
    if (el.closest('[data-glider-simplified], [data-glider-ignore], #glider-root')) return false;
    if (el.hasAttribute('data-glider-hidden') || active.has(el) || declined.has(el)) return false;
    if (el.isContentEditable || el.querySelector('input, textarea, select, button, video, iframe, table')) return false;
    return true;
  }
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && (r.width > 0 || r.height > 0); };
  const cleanText = (el, hint) => String((hint && hint.paragraphText) || el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();

  function show(el, text, how) {
    ensureStyle();
    const clone = el.cloneNode(false);
    clone.removeAttribute('id');
    clone.removeAttribute('data-glider-hidden');
    clone.setAttribute('data-glider-simplified', '');
    const body = document.createElement('span');
    body.className = 'glider-simple__text';
    body.textContent = text;
    clone.append(body);
    const entry = { el, clone, body, toggle: null, source: 'offline', original: text, how, at: performance.now() };
    syncControl(entry);

    el.after(clone);
    el.setAttribute('data-glider-hidden', '');
    active.set(el, entry);
    if (active.size > MAX_ACTIVE) {
      // The oldest one the reader cannot see goes back; one on screen stays as it is.
      for (const [old, e] of active) if (old !== el && !inView(e.clone)) { restore(old); break; }
    }
    emit('glider:simplified', entry);
    return entry;
  }

  /* The panel's "See original" switch: a faint mark at the end of the paragraph. A <span role="button">
     with no text of its own (the drawing is CSS), so it adds nothing to the paragraph's text. */
  function syncControl(entry) {
    if (!seeOriginal) { if (entry.toggle) { entry.toggle.remove(); entry.toggle = null; } return; }
    if (entry.toggle) return;
    const t = document.createElement('span');
    t.className = CLS_TOGGLE;
    t.setAttribute('data-glider-ignore', '');
    t.setAttribute('contenteditable', 'false');
    t.setAttribute('role', 'button');
    t.setAttribute('tabindex', '0');
    t.setAttribute('aria-pressed', 'true');
    t.setAttribute('aria-label', 'See original');
    t.title = 'See the original';
    const back = (e) => {
      e.preventDefault(); e.stopPropagation();
      declined.add(entry.el);
      ahead = false;   // the reader wants the page's own text: stop changing paragraphs ahead of them
      if (gate) { gate.feedback('undone', entry.el, performance.now()); saveBias(); }
      restore(entry.el);
    };
    t.addEventListener('click', back);
    t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') back(e); });
    entry.clone.append(t);
    entry.toggle = t;
  }

  /** A better text arrived (the Claude rewrite). Used only where the reader cannot see it change. */
  function update(entry, text, source) {
    if (active.get(entry.el) !== entry) return;        // restored meanwhile
    if (!text || text === entry.body.textContent) return;
    if (inView(entry.clone)) return;                   // on screen: the wording the reader has stays
    entry.body.textContent = text;
    entry.source = source;
    entry.clone.setAttribute('data-glider-source', source);
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
    try { document.dispatchEvent(new CustomEvent(name, { detail: { source: entry.source, how: entry.how } })); } catch (_) { /* never matters */ }
  }

  // ----------------------------------------------------------------- engine
  /** Simplify one block now. how: 'struggle' (the reader is on it) or 'ahead'. Returns the entry, or null when the block is not suitable. */
  function simplifyElement(el, hint = {}, how = 'struggle') {
    if (!eligible(el)) return null;
    const text = cleanText(el, hint);
    if (text.length < MIN_CHARS || text.length > MAX_CHARS) return null;
    const offline = Simplify.simplify(text);
    const entry = show(el, offline.text || text, how);
    entry.original = text;
    if (cfg.useClaude && hasService && hasChrome) {
      let asked;
      try { asked = chrome.runtime.sendMessage({ type: 'glider:simplify', text, lineText: hint.coarse ? '' : String(hint.lineText || '') }); }   // a coarse struggle only knows "about here"
      catch (_) { asked = Promise.resolve(null); }
      Promise.resolve(asked).then((reply) => { if (reply && reply.ok && reply.text) update(entry, reply.text, 'claude'); }, () => {});
    }
    return entry;
  }

  /** A struggle swap: the paragraph the reader is on, then arm the ahead-of-time swaps. */
  function swapForStruggle(el, hint, text) {
    const entry = simplifyElement(el, hint, 'struggle');
    if (!entry) return null;
    if (gate) gate.feedback('swapped', el, performance.now());
    if (ahead !== false && TextScore) {
      const level = TextScore.difficulty(text).score;
      ahead = { level: ahead ? Math.min(ahead.level, level) : level };
      scheduleAhead();
    }
    return entry;
  }

  /* ------------------------------------------------------------------ ahead
     Paragraphs below the window, nearest first, at least as hard as the one the reader struggled with. */
  const BLOCK_SEL = 'p,li,blockquote,dd,figcaption,[data-gr-block]';
  let aheadTimer = 0;
  function scheduleAhead() { clearTimeout(aheadTimer); aheadTimer = setTimeout(runAhead, AHEAD_SCAN_MS); }
  function runAhead() {
    if (!ahead || !cfg.enabled || !TextScore) return;
    let pending = 0;
    for (const e of active.values()) if (e.how === 'ahead' && e.clone.getBoundingClientRect().top >= innerHeight) pending++;
    if (pending >= AHEAD_MAX) return;
    const below = [];
    for (const el of document.querySelectorAll(BLOCK_SEL)) {
      if (!eligible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top < innerHeight || (!r.width && !r.height)) continue;   // on screen, above, or not shown
      below.push({ el, top: r.top });
    }
    below.sort((a, b) => a.top - b.top);
    for (const { el } of below) {
      if (pending >= AHEAD_MAX) break;
      const text = cleanText(el);
      if (text.length < MIN_CHARS || text.length > MAX_CHARS) continue;
      const suit = TextScore.suitability(text, { simplified: Simplify.simplify(text).text, meta: TextScore.domMeta(el) });
      if (suit.verdict !== 'offline' && !(suit.verdict === 'llm-only' && cfg.useClaude && hasService)) continue;
      if (suit.difficulty.score < ahead.level - AHEAD_MARGIN) continue;
      if (simplifyElement(el, {}, 'ahead')) pending++;
    }
  }
  addEventListener('scroll', () => { if (ahead) scheduleAhead(); }, { passive: true, capture: true });

  /** The eye tracker says the reader is struggling with a line of this block. */
  function handleStruggle(detail) {
    if (!cfg.enabled || !detail || !detail.element) return;
    const now = performance.now();
    const el = detail.element;
    if (!eligible(el)) return;
    const text = cleanText(el, detail);
    if (text.length < MIN_CHARS || text.length > MAX_CHARS) return;
    if (!gate || !cfg.gate) {   // ungated path, kept for tests of the swap machinery
      if (now - lastAt < COOLDOWN_MS) return;
      if (swapForStruggle(el, detail, text)) { lastAt = now; return false; }
      return;
    }
    const decision = gate.evaluate(detail, {
      text, simplified: Simplify.simplify(text).text, meta: TextScore ? TextScore.domMeta(el) : null,
      serviceReady: cfg.useClaude && hasService, now,
    });
    lastDecision = decision;
    // Only the gate's automatic rule changes text without asking. Its 'offer' level of evidence was made for a
    // question to the reader, which is gone, so it changes nothing. (The gate never swaps on events alone.)
    if (decision.action === 'swap' && swapForStruggle(el, detail, text)) { lastAt = now; return false; }   // false: the tracker's line highlight would sit on text that has just gone
  }   // otherwise returns undefined on purpose: Glider's gentler help for this struggle still runs

  /* The tracker's once-a-second "how far, how long" sample for the paragraph being read. */
  const textCache = new WeakMap();   // element -> { text, simplified, meta, at }
  function textOf(el) {
    const c = textCache.get(el), now = performance.now();
    if (c && now - c.at < 15000) return c;
    const text = cleanText(el);
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
    if (decision.action === 'swap' && swapForStruggle(el, hint, t.text)) lastAt = now;
  }
  let lastDecision = null;

  function bind() {
    const G = globalThis.GazeReader;
    if (!G || typeof G.on !== 'function') return false;
    G.on('struggle', (d) => { try { return handleStruggle(d); } catch (e) { console.warn('[glider] simplify failed', e); } });
    G.on('progress', (p) => { try { handleProgress(p); } catch (e) { console.warn('[glider] simplify failed', e); } });
    // Tracking stopped (eye tracking or the lens was switched off): the page goes back to how it was.
    G.on('status', (s) => { if (s && s.status === 'idle') { restoreAll(); ahead = null; } });
    return true;
  }
  bind();

  window.GliderSimplifyBridge = {
    handleStruggle, handleProgress, simplifyElement, restore, restoreAll, runAhead,
    gate, lastDecision: () => lastDecision,
    active: () => Array.from(active.values()).map((e) => ({ source: e.source, how: e.how, text: e.body.textContent, original: e.original })),
    ahead: () => (ahead ? { ...ahead } : ahead),
    config: () => ({ ...cfg, hasService, seeOriginal }),
    _set(next) {
      if ('hasService' in next) hasService = !!next.hasService;
      if ('seeOriginal' in next) applyPanel({ seeOriginal: next.seeOriginal });
      applyConfig({ ...cfg, ...next }); lastAt = -1e9;
    },
  };
})();
