/*
 * flow.js — the live Reading Check: intro → calibrate → read → questions → "Show analytics".
 *
 *   RCFlow.start(rootEl, { onComplete(session), onDemo() })
 *       Renders into rootEl. onComplete(session) is called exactly once, when the
 *       reader presses "Show analytics". onDemo() backs every "View demo instead".
 *   RCFlow.stop()
 *       Removes listeners, timers and key handlers and turns the camera off.
 *
 * The session object follows the contract at the top of analytics.js.
 * gaze/gaze-reader.js is injected on demand (only inside the extension), so this
 * page also opens from file:// without errors.
 *
 * Every step is entered through enter(), which runs the previous step's
 * cleanups and bumps a token; async work checks alive(token) before touching
 * the page, so a late promise can never draw over a newer step.
 */
(function (root) {
  'use strict';

  const FONT_PX = 28;
  const MIN_PITCH_PX = 60;
  const READ_MAX_MS = 30000;
  const SPACE_GUARD_MS = 1500;
  const READY_MS = 1200;
  const START_TIMEOUT_MS = 20000;
  const SCRIPT_TIMEOUT_MS = 10000;
  const LOW_QUALITY_EFFY = 70;
  const MAX_SAMPLES = 6000;
  const BAND_KEY = 'rc:ageBand';
  const FALLBACK_BANDS = ['8-10', '11-13', '14-17', 'adult'];
  const FALLBACK_LABELS = { '8-10': 'Ages 8–10', '11-13': 'Ages 11–13', '14-17': 'Ages 14–17', adult: 'Adult' };
  const STEPS = ['Intro', 'Calibrate', 'Read', 'Questions'];
  const ACC_KEYS = ['effX', 'effY', 'accuracyX', 'accuracyY', 'precisionX', 'precisionY', 'recommendedLinePitchPx'];

  const F = {
    root: null, opts: {}, running: false, token: 0, cleanups: [],
    gazeStarted: false, completed: false,
    band: 'adult', accuracy: null, calibViewport: null, lowQuality: false, session: null,
  };
  let scriptPromise = null;      // the tracker script is injected at most once per page

  // ---------------------------------------------------------------- helpers
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  const r1 = (v) => Math.round(v * 10) / 10;
  const r5 = (v) => Math.round(v * 1e5) / 1e5;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  /** One animation frame, or 250 ms if frames are not being painted. */
  const nextFrame = () => new Promise((res) => {
    let done = false;
    const go = () => { if (!done) { done = true; res(); } };
    try { requestAnimationFrame(go); } catch (_) { /* fall through to the timer */ }
    setTimeout(go, 250);
  });
  const fontsReady = () => {
    try {
      if (document.fonts && document.fonts.ready) return Promise.race([document.fonts.ready.catch(() => {}), sleep(1500)]);
    } catch (_) { /* no font loading API */ }
    return Promise.resolve();
  };
  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), ms);
      Promise.resolve(promise).then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }
  const log = (...a) => { try { console.warn('[reading-check]', ...a); } catch (_) { /* no console */ } };

  const alive = (tok) => F.running && tok === F.token;

  function runCleanups() {
    const list = F.cleanups;
    F.cleanups = [];
    for (const fn of list) { try { fn(); } catch (e) { log('cleanup', e); } }
  }
  function listen(target, type, fn, options) {
    target.addEventListener(type, fn, options);
    F.cleanups.push(() => target.removeEventListener(type, fn, options));
  }
  function later(fn, ms) {
    const id = setTimeout(guard(fn), ms);
    F.cleanups.push(() => clearTimeout(id));
  }

  /** Wrap a handler so that neither a throw nor a rejected promise can leave a blank screen. */
  function guard(fn) {
    return function (...args) {
      try {
        const out = fn.apply(this, args);
        if (out && typeof out.then === 'function') out.then(null, fail);
        return out;
      } catch (e) { fail(e); }
      return undefined;
    };
  }
  function fail(e) {
    try { console.error('[reading-check] flow error', e); } catch (_) { /* no console */ }
    if (!F.running) return;
    try {
      showError({
        title: 'Something went wrong',
        text: 'Sorry about that. You can try again, or look at a demo of the analytics instead.',
      });
    } catch (e2) { log('error panel failed', e2); }
  }

  /** Start a new step: drop the old step's listeners and timers, empty the root. */
  function enter(name) {
    runCleanups();
    F.token++;
    F.root.replaceChildren();
    F.root.setAttribute('data-rcf-step', name);
    return F.token;
  }

  // ------------------------------------------------------------------- DOM
  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function button(label, cls, fn) {
    const b = h('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', guard(fn));
    return b;
  }
  const primary = (label, fn) => button(label, 'rc-btn rc-btn--primary rcf-btn', fn);
  const ghost = (label, fn) => button(label, 'rc-btn rc-btn--ghost rcf-btn', fn);
  const demoLink = () => button('View demo instead', 'rcf-link', goDemo);

  function stepsNav(current) {
    const nav = h('nav', 'rcf-steps');
    nav.setAttribute('aria-label', 'Progress');
    const ol = h('ol', 'rcf-steps__list');
    STEPS.forEach((name, i) => {
      const li = h('li', 'rcf-steps__item');
      const state = i + 1 < current ? 'done' : i + 1 === current ? 'current' : 'todo';
      li.setAttribute('data-state', state);
      if (state === 'current') li.setAttribute('aria-current', 'step');
      li.appendChild(h('span', 'rcf-steps__num', state === 'done' ? '✓' : String(i + 1)));
      li.appendChild(h('span', 'rcf-steps__name', name));
      if (state === 'done') li.appendChild(h('span', 'rc-visually-hidden', ' (done)'));
      ol.appendChild(li);
    });
    nav.appendChild(ol);
    return nav;
  }

  /**
   * A centred card with the step indicator. Returns { card, actions } so the
   * caller can add its own content; the title takes focus for screen readers.
   */
  function panel(step, title, paragraphs, tone) {
    const wrap = h('div', 'rcf-wrap');
    wrap.appendChild(stepsNav(step));
    const card = h('section', 'rc-card rcf-card' + (tone ? ' rcf-card--' + tone : ''));
    const heading = h('h1', 'rcf-title', title);
    heading.tabIndex = -1;
    card.appendChild(heading);
    for (const p of paragraphs || []) if (p) card.appendChild(h('p', 'rcf-text', p));
    const actions = h('div', 'rcf-actions');
    card.appendChild(actions);
    wrap.appendChild(card);
    F.root.appendChild(wrap);
    try { heading.focus({ preventScroll: true }); } catch (_) { /* focus is a nicety */ }
    return { wrap, card, actions, heading };
  }

  // ---------------------------------------------------------------- tracker
  const GR = () => root.GazeReader;
  const hasRuntime = () => {
    try { return typeof chrome !== 'undefined' && !!chrome.runtime && typeof chrome.runtime.getURL === 'function' && !!chrome.runtime.id; }
    catch (_) { return false; }
  };
  /** Call a tracker method if this build has it; never throws. */
  function gazeCall(name, ...args) {
    try {
      const g = GR();
      if (g && typeof g[name] === 'function') return g[name](...args);
    } catch (e) { log('GazeReader.' + name + ' failed', e); }
    return undefined;
  }
  function stopGaze() {
    if (!F.gazeStarted) return;
    F.gazeStarted = false;
    gazeCall('stop');
  }
  /** Subscribe for the current step only. */
  function subscribe(event, cb) {
    let off = null;
    try { off = GR().on(event, cb); } catch (e) { log('cannot subscribe to ' + event, e); }
    F.cleanups.push(() => { if (typeof off === 'function') off(); });
  }

  function loadTracker() {
    if (GR()) return Promise.resolve();
    if (scriptPromise) return scriptPromise;
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!err && !GR()) err = new Error('tracker did not initialise');
        if (err) { scriptPromise = null; try { s.remove(); } catch (_) { /* gone */ } reject(err); } else resolve();
      };
      const timer = setTimeout(() => done(new Error('tracker load timed out')), SCRIPT_TIMEOUT_MS);
      s.addEventListener('load', () => done());
      s.addEventListener('error', () => done(new Error('tracker failed to load')));
      let src = '../gaze/gaze-reader.js';
      try { src = chrome.runtime.getURL('gaze/gaze-reader.js'); } catch (_) { /* relative path works from the page */ }
      s.src = src;
      (document.head || document.documentElement).appendChild(s);
    });
    return scriptPromise;
  }

  // -------------------------------------------------------------- exits
  function goDemo() {
    const cb = F.opts.onDemo;
    stop();
    try {
      if (typeof cb === 'function') cb();
      else location.search = '?demo=1';
    } catch (e) { log('onDemo failed', e); }
  }

  // ------------------------------------------------------------ 1. intro
  function readBand() {
    try {
      const v = localStorage.getItem(BAND_KEY);
      if (v && bands().includes(v)) return v;
    } catch (_) { /* storage blocked */ }
    return bands().includes('adult') ? 'adult' : bands()[0];
  }
  function saveBand(v) { try { localStorage.setItem(BAND_KEY, v); } catch (_) { /* storage blocked */ } }
  function bands() {
    const N = root.RCNorms;
    return N && Array.isArray(N.AGE_BANDS) && N.AGE_BANDS.length ? N.AGE_BANDS : FALLBACK_BANDS;
  }
  function bandLabel(b) {
    const N = root.RCNorms;
    return (N && N.BANDS && N.BANDS[b] && N.BANDS[b].label) || FALLBACK_LABELS[b] || String(b);
  }

  function stepIntro() {
    stopGaze();
    enter('intro');
    F.band = readBand();
    const p = panel(1, 'Reading Check', [
      'Read one short passage while your webcam follows your eyes. You will see your reading pattern (where your eyes pause and jump back) and signs of tiredness and focus, like blinking and steadiness.',
      'It takes about 2 minutes: follow a dot, read for up to 30 seconds, then answer 2 questions.',
    ]);

    const privacy = h('div', 'rcf-note');
    privacy.appendChild(h('p', 'rcf-note__line', 'Everything stays on this device. No video or images are stored, only numbers.'));
    privacy.appendChild(h('p', 'rcf-note__line rcf-note__line--strong', 'This is not a diagnosis.'));
    p.card.insertBefore(privacy, p.actions);

    const field = h('fieldset', 'rcf-bands');
    field.appendChild(h('legend', 'rcf-bands__legend', 'Who is reading?'));
    const row = h('div', 'rcf-bands__row');
    for (const b of bands()) {
      const label = h('label', 'rcf-band');
      const input = h('input', 'rcf-band__input');
      input.type = 'radio';
      input.name = 'rcf-age-band';
      input.value = b;
      input.checked = b === F.band;
      input.addEventListener('change', () => { if (input.checked) { F.band = b; saveBand(b); } });
      label.appendChild(input);
      label.appendChild(h('span', 'rcf-band__body', bandLabel(b)));
      row.appendChild(label);
    }
    field.appendChild(row);
    p.card.insertBefore(field, p.actions);

    const start = primary('Start', () => { saveBand(F.band); return stepPrepare(); });
    start.classList.add('rcf-btn--lg');
    p.actions.appendChild(start);
    p.actions.appendChild(demoLink());
  }

  // ---------------------------------------------------- 2a. start the camera
  async function stepPrepare() {
    const tok = enter('prepare');
    const p = panel(2, 'Starting the camera…', ['This takes a few seconds. If your browser asks, allow the camera.']);
    p.card.setAttribute('aria-busy', 'true');
    p.actions.appendChild(ghost('Back', stepIntro));
    p.actions.appendChild(demoLink());

    if (!hasRuntime()) {
      showError({
        title: 'The live check needs the extension',
        text: 'Open this page from the Glider extension to use the camera. You can still explore a demo of the analytics.',
        retry: false,
      });
      return;
    }
    try {
      await loadTracker();
    } catch (e) {
      log(e);
      if (alive(tok)) showError({ title: 'Eye tracking could not load', text: 'Try again in a moment, or look at a demo of the analytics instead.' });
      return;
    }
    if (!alive(tok)) return;
    if (!root.GazeCore) log('GazeCore is missing; line boxes fall back to word boxes');

    gazeCall('init', { managed: true, autoAdapt: false, shortcuts: false, widget: false });
    gazeCall('setWidgetVisible', false);

    let state = null;
    F.gazeStarted = true;
    try {
      const g = GR();
      if (!g || typeof g.start !== 'function') throw new Error('tracker has no start()');
      state = await withTimeout(g.start(), START_TIMEOUT_MS);
    } catch (e) {
      log('camera start failed', e);
      if (!alive(tok)) return;
      stopGaze();
      showCameraError();
      return;
    }
    if (!alive(tok)) return;
    gazeCall('setWidgetVisible', false);

    const now = gazeCall('getState');
    const status = (now && now.status) || (state && state.status);
    if (status === 'needs-permission') showPermission();
    else if (status === 'ready' || status === 'tracking' || status === 'calibrating') await stepCalibrate();
    else { stopGaze(); showCameraError(); }
  }

  function showCameraError() {
    showError({
      title: 'The camera did not start',
      text: 'Check that a webcam is connected and that no other app is using it, then try again. You can also look at a demo of the analytics.',
    });
  }

  function showPermission() {
    enter('permission');
    const p = panel(2, 'Allow the camera', [
      'Eye tracking needs one-time access to your webcam. The button below opens a small page where you can allow it.',
      'Video never leaves this device and is never saved.',
    ]);
    p.actions.appendChild(primary('Allow camera', () => {
      let url = 'gaze/permission.html';
      try { url = chrome.runtime.getURL('gaze/permission.html'); } catch (_) { /* keep the relative path */ }
      try { window.open(url, '_blank', 'noopener'); } catch (e) { log('could not open the permission page', e); }
    }));
    p.actions.appendChild(ghost('I’ve allowed it — try again', () => { F.gazeStarted = true; stopGaze(); return stepPrepare(); }));
    p.actions.appendChild(ghost('Back', stepIntro));
    p.actions.appendChild(demoLink());
  }

  /** Friendly dead-end-free error: Retry · View demo instead · Back. */
  function showError(o) {
    enter('error');
    const p = panel(2, o.title, [o.text], 'warn');
    if (o.detail) p.card.insertBefore(h('p', 'rcf-detail', o.detail), p.actions);
    if (o.retry !== false) p.actions.appendChild(primary(o.retryLabel || 'Retry', o.retry || stepPrepare));
    const demo = button('View demo instead', o.retry === false ? 'rc-btn rc-btn--primary rcf-btn' : 'rc-btn rc-btn--ghost rcf-btn', goDemo);
    p.actions.appendChild(demo);
    p.actions.appendChild(ghost('Back', stepIntro));
  }

  // ----------------------------------------------------------- 2b. calibrate
  async function stepCalibrate() {
    const tok = enter('calibrate');
    const p = panel(2, 'Follow the dot', [
      'Sit the way you normally read and keep your head still. A dot will move around the screen: follow it with your eyes.',
      'Press Esc at any time to cancel.',
    ]);
    p.card.setAttribute('aria-busy', 'true');

    let acc = null;
    try {
      const g = GR();
      if (!g || typeof g.calibrate !== 'function') throw new Error('tracker has no calibrate()');
      acc = await g.calibrate({ baseline: false });
    } catch (e) {
      if (!alive(tok)) return;
      const msg = String((e && e.message) || e || '');
      if (msg === 'cancelled') { showCancelled(); return; }
      log('calibration failed', e);
      if (/needs-permission/.test(msg)) { showPermission(); return; }
      showError({
        title: 'Calibration didn’t work this time',
        text: 'Face the light, make sure the camera can see your whole face, and keep your head still. Then try once more.',
        detail: msg && msg.length < 160 ? msg : '',
        retryLabel: 'Try again',
      });
      return;
    }
    if (!alive(tok)) return;
    gazeCall('setWidgetVisible', false);

    if (!acc || typeof acc !== 'object' || !Number.isFinite(acc.effY)) {
      showError({
        title: 'Calibration didn’t work this time',
        text: 'Face the light, make sure the camera can see your whole face, and keep your head still. Then try once more.',
        retryLabel: 'Try again',
      });
      return;
    }
    const clean = {};
    for (const k of ACC_KEYS) clean[k] = num(acc[k], null);
    if (clean.effX === null) clean.effX = clean.effY;
    if (clean.recommendedLinePitchPx === null) clean.recommendedLinePitchPx = Math.round(Math.max(36, Math.min(120, 1.5 * clean.effY)));
    F.accuracy = clean;
    F.calibViewport = { w: window.innerWidth, h: window.innerHeight };
    F.lowQuality = false;

    if (clean.effY > LOW_QUALITY_EFFY) showLowQuality();
    else await stepRead();
  }

  function showCancelled() {
    enter('cancelled');
    const p = panel(2, 'Calibration cancelled', ['No problem. Start it again when you are ready.']);
    p.actions.appendChild(primary('Try again', stepPrepare));
    p.actions.appendChild(ghost('Back', stepIntro));
    p.actions.appendChild(demoLink());
  }

  function showLowQuality() {
    enter('low-quality');
    const p = panel(2, 'Let’s try once more', [
      'The tracking was a little shaky. Face the light, keep your head still, and sit about an arm’s length from the screen.',
      'You can also continue; the results will be marked as lower quality.',
    ], 'warn');
    p.actions.appendChild(primary('Recalibrate', stepPrepare));
    p.actions.appendChild(ghost('Continue anyway', () => { F.lowQuality = true; return stepRead(); }));
  }

  // ---------------------------------------------------------------- 3. read
  function getPassage() {
    const P = root.RCPassages;
    const p = P && typeof P.forBand === 'function' ? P.forBand(F.band) : null;
    if (!p || typeof p.text !== 'string' || !p.text.trim()) throw new Error('no passage for band ' + F.band);
    return p;
  }

  /** Same idea as GazeCore.mergeLineRects, used only if GazeCore is unavailable or returns nothing. */
  function mergeFallback(rects) {
    const lines = [];
    const rs = rects.filter((r) => r.width > 1 && r.height > 1).sort((a, b) => a.top - b.top || a.left - b.left);
    for (const r of rs) {
      const cy = (r.top + r.bottom) / 2;
      const L = lines.find((l) => Math.abs((l.top + l.bottom) / 2 - cy) < 0.5 * Math.min(r.bottom - r.top, l.bottom - l.top));
      if (L) { L.top = Math.min(L.top, r.top); L.bottom = Math.max(L.bottom, r.bottom); L.left = Math.min(L.left, r.left); L.right = Math.max(L.right, r.right); }
      else lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
    }
    return lines.sort((a, b) => a.top - b.top);
  }

  /** Line rectangles and word boxes of the laid-out passage, in viewport px. */
  function measure(textEl, spans, words) {
    let rects = [];
    try {
      const range = document.createRange();
      range.selectNodeContents(textEl);
      rects = Array.from(range.getClientRects());
    } catch (e) { log('range rects failed', e); }
    const boxes = spans.map((s) => s.getBoundingClientRect());
    let lines = [];
    try {
      const C = root.GazeCore;
      if (C && typeof C.mergeLineRects === 'function') lines = C.mergeLineRects(rects) || [];
    } catch (e) { log('mergeLineRects failed', e); }
    if (!lines.length) lines = mergeFallback(rects.length ? rects : boxes);

    const perLine = lines.map(() => []);
    const wordBoxes = boxes.map((b, i) => {
      const cy = (b.top + b.bottom) / 2;
      let line = -1, best = Infinity;
      for (let k = 0; k < lines.length; k++) {
        const d = Math.abs((lines[k].top + lines[k].bottom) / 2 - cy);
        if (d < best) { best = d; line = k; }
      }
      if (line >= 0) perLine[line].push(words[i]);
      return { i, text: words[i], line, left: r1(b.left), top: r1(b.top), right: r1(b.right), bottom: r1(b.bottom) };
    });
    const lineRects = lines.map((l, k) => ({
      top: r1(l.top), bottom: r1(l.bottom), left: r1(l.left), right: r1(l.right),
      text: perLine[k].join(' '), words: perLine[k].length,
    }));
    return { lineRects, wordBoxes };
  }

  function newId() {
    try { if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID(); } catch (_) { /* fall back */ }
    return 'rc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  async function stepRead(notice) {
    const tok = enter('read');
    const passage = getPassage();
    const words = passage.text.trim().split(/\s+/);
    const acc = F.accuracy || {};
    const pitch = Math.max(MIN_PITCH_PX, Math.round(num(acc.recommendedLinePitchPx, 0)));

    const stage = h('div', 'rcf-read');
    const ready = h('p', 'rcf-read__ready', notice || 'Get ready…');
    ready.setAttribute('role', 'status');
    const inner = h('div', 'rcf-read__inner');
    const hint = h('p', 'rcf-read__hint', 'Read silently at your normal pace. Press Space when done.');
    const text = h('p', 'rcf-read__text');
    text.style.setProperty('--rcf-pitch', pitch + 'px');
    const spans = words.map((w, i) => {
      if (i) text.appendChild(document.createTextNode(' '));
      const s = h('span', null, w);
      s.setAttribute('data-w', String(i));
      text.appendChild(s);
      return s;
    });
    let live = false, ended = false, t0 = 0, startedAt = 0, scroll0 = 0, layout = null;
    const gaze = [], frames = [];
    let pausedMs = 0, driftSince = null;

    const done = button('Done', 'rcf-read__done', () => finish('button'));
    done.hidden = true;
    inner.appendChild(hint);
    inner.appendChild(text);
    stage.appendChild(ready);
    stage.appendChild(inner);
    stage.appendChild(done);
    F.root.appendChild(stage);

    function finish(reason) {
      if (ended || !live) return;
      ended = true;
      live = false;
      const durationMs = Math.max(0, Math.round(Math.min(performance.now() - t0, READ_MAX_MS + 1000)));
      const fontPx = (() => { try { return num(parseFloat(getComputedStyle(text).fontSize), FONT_PX); } catch (_) { return FONT_PX; } })();
      F.session = {
        id: newId(),
        startedAt,
        ageBand: F.band,
        passageId: String(passage.id || F.band),
        accuracy: Object.assign({}, F.accuracy),
        viewport: { w: window.innerWidth, h: window.innerHeight },
        passage: { title: String(passage.title || ''), text: passage.text, fontPx, linePitchPx: pitch },
        lineRects: layout.lineRects,
        wordBoxes: layout.wordBoxes,
        gaze,
        frames,
        answers: [],
        durationMs,
        lowQuality: !!F.lowQuality,
        trackingPausedMs: Math.round(pausedMs + (driftSince !== null ? performance.now() - driftSince : 0)),
        demo: false,
      };
      stopGaze();                                   // the camera is off from here on
      done.hidden = true;
      stage.classList.add('rcf-read--fade');
      const timedOut = reason === 'timeout';
      later(() => stepQuestions(passage, timedOut), timedOut ? 900 : 350);
    }

    const onKey = (e) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      e.preventDefault();                           // never scroll the passage
      if (e.repeat || !live || performance.now() - t0 < SPACE_GUARD_MS) return;
      finish('space');
    };
    const onResize = guard(() => {
      if (ended) return;
      ended = true;
      live = false;
      showResized();
    });
    listen(window, 'keydown', onKey, true);
    listen(window, 'resize', onResize);

    await Promise.all([sleep(notice ? READY_MS + 800 : READY_MS), fontsReady()]);
    if (!alive(tok) || ended) return;
    await nextFrame();
    await nextFrame();
    if (!alive(tok) || ended) return;

    layout = measure(text, spans, words);
    scroll0 = stage.scrollTop;
    ready.hidden = true;
    done.hidden = false;
    stage.classList.add('rcf-read--live');

    subscribe('gaze', (g) => {
      if (!live || !g || gaze.length >= MAX_SAMPLES) return;
      const t = Math.round(g.t - t0);
      const x = num(g.rawX, g.x), y = num(g.rawY, g.y);
      if (!(t >= 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
      // Stored in the coordinates of the recorded layout, even if the passage was scrolled.
      gaze.push({ t, x: r1(x), y: r1(y + (stage.scrollTop - scroll0)) });
    });
    // With the widget hidden there is no "move back" toast: the tracker just stops sending gaze
    // while the head is off the calibration pose. Time it, so the dashboard can say so.
    subscribe('status', (st) => {
      const now = performance.now();
      if (driftSince !== null) { pausedMs += now - driftSince; driftSince = null; }
      if (live && st && st.drifted) driftSince = now;
    });
    subscribe('frame', (f) => {
      if (!live || !f || frames.length >= MAX_SAMPLES) return;
      const t = Math.round(f.t - t0);
      if (!(t >= 0)) return;
      const hd = f.head;
      const head = hd && Number.isFinite(hd.cx) && Number.isFinite(hd.cy) && Number.isFinite(hd.s)
        ? { cx: r5(hd.cx), cy: r5(hd.cy), s: r5(hd.s) } : null;
      frames.push({ t, face: !!f.face, blink: !!f.blink, head });
    });

    t0 = performance.now();
    startedAt = Date.now();
    live = true;
    later(() => finish('timeout'), READ_MAX_MS);
  }

  function showResized() {
    enter('resized');
    const cv = F.calibViewport;
    const moved = !!cv && (Math.abs(cv.w - window.innerWidth) > 8 || Math.abs(cv.h - window.innerHeight) > 8);
    const p = panel(3, 'The window changed size', [
      moved
        ? 'Eye tracking was set up for the earlier window size, so it is best to calibrate again. Keep the window as it is now.'
        : 'The text moved, so the reading starts again. Keep the window as it is now.',
    ]);
    if (moved) {
      p.actions.appendChild(primary('Recalibrate', stepPrepare));
      p.actions.appendChild(ghost('Read anyway', () => { F.lowQuality = true; return stepRead('Starting again. Get ready…'); }));
    } else {
      p.actions.appendChild(primary('Start reading again', () => stepRead('Starting again. Get ready…')));
      p.actions.appendChild(ghost('Recalibrate', stepPrepare));
    }
    p.actions.appendChild(demoLink());
  }

  // ----------------------------------------------------------- 4. questions
  function stepQuestions(passage, timedOut) {
    const questions = (Array.isArray(passage.questions) ? passage.questions : [])
      .filter((q) => q && typeof q.q === 'string' && Array.isArray(q.options) && q.options.length);
    const answers = [];
    const session = F.session;

    const ask = (index) => {
      if (index >= questions.length) { session.answers = answers; stepDone(); return; }
      enter('questions');
      const q = questions[index];
      const p = panel(4, q.q, []);
      const kicker = h('p', 'rcf-kicker', 'Question ' + (index + 1) + ' of ' + questions.length);
      p.card.insertBefore(kicker, p.heading);
      if (index === 0) {
        p.card.insertBefore(h('p', 'rcf-text rcf-text--soft', timedOut
          ? 'Time is up, and that is fine. The camera is off now. Two quick questions about what you read.'
          : 'The camera is off now. Two quick questions about what you read.'), p.heading);
      }

      let chosen = null;
      const group = h('div', 'rcf-opts');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-label', q.q);
      const next = primary(index + 1 < questions.length ? 'Next' : 'Finish', () => {
        if (chosen === null) return;
        record(chosen);
      });
      next.disabled = true;
      q.options.forEach((opt, i) => {
        const label = h('label', 'rcf-opt');
        const input = h('input', 'rcf-opt__input');
        input.type = 'radio';
        input.name = 'rcf-q' + index;
        input.value = String(i);
        input.addEventListener('change', () => { if (input.checked) { chosen = i; next.disabled = false; } });
        label.appendChild(input);
        label.appendChild(h('span', 'rcf-opt__body', String(opt)));
        group.appendChild(label);
      });
      p.card.insertBefore(group, p.actions);

      let recorded = false;
      const record = (value) => {
        if (recorded) return;
        recorded = true;
        answers.push({ q: q.q, chosen: value, correct: q.correct });
        ask(index + 1);
      };
      p.actions.appendChild(next);
      p.actions.appendChild(ghost('I’m not sure', () => record(null)));
    };
    ask(0);
  }

  // ---------------------------------------------------------------- 5. done
  function stepDone() {
    enter('done');
    const p = panel(4, 'All done', ['Nice work. Your reading pattern is ready to look at.']);
    const show = primary('Show analytics', () => {
      if (F.completed) return;
      F.completed = true;
      show.disabled = true;
      const session = F.session;
      const cb = F.opts.onComplete;
      const host = F.root;
      stop();
      try {
        const out = typeof cb === 'function' ? cb(session) : undefined;
        if (out && typeof out.then === 'function') out.then(null, (e) => { try { console.error('[reading-check] onComplete rejected', e); } catch (_) { /* no console */ } });
      } catch (e) {
        try { console.error('[reading-check] onComplete threw', e); } catch (_) { /* no console */ }
        // Never a blank screen: offer the demo if the dashboard could not be drawn.
        try {
          if (host && !host.childElementCount) {
            const box = h('div', 'rcf-wrap');
            const card = h('section', 'rc-card rcf-card rcf-card--warn');
            card.appendChild(h('h1', 'rcf-title', 'The analytics could not be shown'));
            card.appendChild(h('p', 'rcf-text', 'Sorry about that. Reload the page to try again, or look at the demo.'));
            const actions = h('div', 'rcf-actions');
            const demo = h('a', 'rc-btn rc-btn--primary rcf-btn', 'View demo instead');
            demo.href = '?demo=1';
            actions.appendChild(demo);
            card.appendChild(actions);
            box.appendChild(card);
            host.appendChild(box);
          }
        } catch (_) { /* nothing more to do */ }
      }
    });
    show.classList.add('rcf-btn--lg');
    p.actions.appendChild(show);
    try { show.focus({ preventScroll: true }); } catch (_) { /* focus is a nicety */ }
  }

  // ------------------------------------------------------------------ API
  function start(rootEl, opts) {
    if (F.running) stop();
    if (!rootEl || typeof rootEl.appendChild !== 'function') { log('RCFlow.start needs a root element'); return; }
    F.root = rootEl;
    F.opts = opts && typeof opts === 'object' ? opts : {};
    F.running = true;
    F.completed = false;
    F.accuracy = null;
    F.calibViewport = null;
    F.lowQuality = false;
    F.session = null;
    rootEl.classList.add('rcf-root');
    guard(stepIntro)();
  }

  /**
   * Unsubscribe, clear timers and key handlers, turn the camera off. Removes the
   * flow's own panels from the root (so no stale button stays clickable) and
   * leaves anything else in the root untouched. Safe to call at any time, twice.
   */
  function stop() {
    F.running = false;
    F.token++;
    runCleanups();
    stopGaze();
    try {
      if (F.root) {
        for (const n of Array.from(F.root.children)) {
          if (n.classList && (n.classList.contains('rcf-wrap') || n.classList.contains('rcf-read'))) n.remove();
        }
        F.root.removeAttribute('data-rcf-step');
        F.root.classList.remove('rcf-root');
      }
    } catch (_) { /* root gone */ }
  }

  root.RCFlow = { start, stop };
})(typeof globalThis !== 'undefined' ? globalThis : this);
