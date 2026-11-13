/*
 * gaze-reader.js — content script. Webcam eye tracking that notices when a
 * reader is struggling with a specific line and tells the rest of the extension.
 *
 * Pipeline:  camera iframe (MediaPipe) --features--> calibrated ridge model -->
 *            gaze (x,y) --> fixations --> paragraph + line (HMM line locking) -->
 *            struggle detector --> 'struggle' event (+ optional default adaptation)
 *
 * Public API (same isolated world as your other content scripts):
 *   GazeReader.init({ autoAdapt, debug, shortcuts, baselineWpm, root })
 *   GazeReader.start()       -> Promise<state>   opens camera, loads model
 *   GazeReader.calibrate()   -> Promise<accuracy>   dots, then the reading-pace passage ({baseline:false} skips it)
 *   GazeReader.measureBaseline() -> Promise<baseline>   redo only the reading-pace passage
 *   GazeReader.setSensitivity(mult)   multiplies the calibrated tau (struggle threshold)
 *       'baseline' fires with {wpm, tau, cv, regressionRate, ...}; 'struggling' fires when the state flips.
 *   GazeReader.stop()
 *   GazeReader.on('struggle' | 'line' | 'accuracy' | 'status' | 'gaze' | 'fixation', cb)  -> unsubscribe fn
 *       'line' fires whenever the decoded reading line changes (use it to move a reading ruler with the eyes).
 *       A 'struggle' callback that returns false suppresses the default adaptation.
 *   GazeReader.setDebug(bool)     gaze dot + reading heatmap overlay
 *   GazeReader.setRoot(node)      where to look for text (Document/Element/ShadowRoot)
 *   GazeReader.getState()
 *   GazeReader.getCurrentLine()   -> {element, lineIndex, lineRect, confidence} | null
 *
 * Messages (from popup/background via chrome.tabs.sendMessage):
 *   {type:'gaze:enable', value:bool} {type:'gaze:calibrate'} {type:'gaze:debug', value:bool} {type:'gaze:state'}
 * Shortcuts: Alt+Shift+E on/off · Alt+Shift+C recalibrate · Alt+Shift+G debug overlay
 */
(() => {
  'use strict';
  if (window.GazeReader) return;
  const C = globalThis.GazeCore;
  if (!C) { console.error('[gaze] gaze-core.js must load before gaze-reader.js'); return; }

  const opts = {
    autoAdapt: true,
    debug: false,
    shortcuts: true,
    baselineWpm: 150,
    root: null,
    settleMs: 1000,          // after the dot starts moving: its 600 ms glide plus time for the eyes to land
    sampleMs: 1000,
    domEvents: false,       // also dispatch DOM CustomEvents (visible to the page; off by default)
    trace: false,           // log detector internals to the console
    managed: false,         // the host extension decides when tracking runs (no self-start)
    onEnableRequest: null,  // managed mode: called with true/false when the user asks to turn tracking on/off
    sensitivity: 1,         // multiplies the calibrated tau: above 1 helps later, below 1 helps sooner
    baselineText: null,     // override the reading-pace passage
    featureCount: 25,       // regression inputs: eye features + eye-look blendshapes. The raw head matrix and head
                            // position (25-43) barely vary in a keep-still calibration and wreck it after a small shift.
    clickRefine: true,      // clicks add calibration samples (the lab turns this off to keep runs comparable)
    widget: true,           // false hides the camera widget and toasts (the camera keeps running)
  };

  /* Read once after the dot calibration to find this reader's normal pace.
     Plain words and short sentences, so it measures comfortable reading. */
  const BASELINE_TEXT = 'Every morning the baker opens her shop before the sun comes up. She mixes flour, water and a little salt, ' +
    'then leaves the dough to rest. While it rises, she sweeps the floor and lights the big oven. By seven the first loaves are ready, ' +
    'and the whole street smells of warm bread. People stop on their way to work to buy one. She knows most of them by name, ' +
    'and she always asks how their day is going.';
  const BASELINE_MAX_AGE = 30 * 24 * 3600e3;

  const CAL_POINTS = [ // fractions of the viewport, snake order (short eye travel)
    [0.06, 0.08], [0.5, 0.08], [0.94, 0.08], [0.72, 0.29], [0.28, 0.29],
    [0.06, 0.5], [0.5, 0.5], [0.94, 0.5], [0.72, 0.71], [0.28, 0.71],
    [0.06, 0.92], [0.5, 0.92], [0.94, 0.92],
  ];
  const VAL_POINTS = [[0.25, 0.22], [0.75, 0.22], [0.5, 0.5], [0.25, 0.78], [0.75, 0.78]];
  const BLOCK_SEL = 'p,li,blockquote,dd,dt,figcaption,td,th,h1,h2,h3,h4,h5,h6,pre,[data-gr-block]';

  const S = {
    status: 'idle', host: null, root: null, iframe: null, port: null,
    model: null, accuracy: null, calibHead: null, calibScreen: null, train: null,
    latest: null, recent: [], collector: null, fps: 0,
    drifted: false, driftSince: 0, needsRecal: false,
    sx: 60, sy: 60, fix: new C.FixationDetector(), euroX: new C.OneEuro(), euroY: new C.OneEuro(),
    gaze: null, lastFix: null, block: null, cur: null, prevBlockBottom: null,
    states: new WeakMap(), lineCache: new WeakMap(), blocksCache: null, layoutV: 0,
    heat: new Map(), wpm: 150, scrollT: -1e9, scrollEpoch: 0, prevFixEnd: 0, drift: { y: 0 }, highlights: [], clicks: [], refitTimer: 0,
    startPromise: null, raf: 0,
    baseline: null,          // {wpm, msPerWord, cv, regressionRate, tau, ...} from the reading-pace passage
    bl: null,                // the baseline read in progress
    struggling: null,        // {el, line, reason, since, ratio} while the reader is in a struggling state
    assisted: new Set(),
  };

  /** The threshold in use: how many times slower than baseline counts as struggling. */
  function tau() {
    const base = S.baseline ? S.baseline.tau : C.TAU_DEFAULT;
    return Math.min(4, Math.max(1.3, base * (Number(opts.sensitivity) || 1)));
  }
  const listeners = {};

  // ------------------------------------------------------------------ events
  function on(ev, cb) {
    (listeners[ev] = listeners[ev] || []).push(cb);
    return () => { listeners[ev] = listeners[ev].filter((f) => f !== cb); };
  }
  function emit(ev, detail) {
    let prevented = false;
    for (const cb of listeners[ev] || []) {
      try { if (cb(detail) === false) prevented = true; } catch (e) { console.error('[gaze] listener error', e); }
    }
    if (opts.domEvents) document.dispatchEvent(new CustomEvent('gazereader:' + ev, { detail }));
    return prevented;
  }
  function setStatus(s) { if (S.status !== s) { S.status = s; emit('status', getState()); } }
  function getState() {
    return {
      status: S.status, calibrated: !!S.model, accuracy: S.accuracy, wpm: Math.round(S.wpm),
      fps: S.fps, drifted: S.drifted, needsRecalibration: S.needsRecal, debug: opts.debug,
      baseline: S.baseline ? { ...S.baseline } : null, tau: +tau().toFixed(2), struggling: !!S.struggling,
    };
  }

  // ---------------------------------------------------------------------- UI
  const CSS = `
    /* Sage, the same design as the Glider dock: pale green surfaces, dark
       green ink, one green accent, round shapes, Atkinson Hyperlegible. */
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Glider Atkinson", "Atkinson Hyperlegible", "Segoe UI", system-ui, sans-serif; }
    canvas { position: fixed; inset: 0; pointer-events: none; }

    /* camera widget: bottom-left, or bottom-right when the dock sits bottom-left */
    #cam { position: fixed; left: 14px; bottom: 14px; width: 208px; padding: 0 6px 6px; border-radius: 22px; overflow: hidden;
           background: #eef2ea; color: #20352a; pointer-events: auto; transition: width .2s;
           box-shadow: 0 0 0 1px rgba(32, 53, 42, .08), 0 18px 40px -14px rgba(32, 53, 42, .34); }
    :host([data-dock="lb"]) #cam { left: auto; right: 14px; }
    #cam.min { width: 124px; }
    #bar { display: flex; align-items: center; gap: 4px; padding: 7px 4px 6px 8px; color: #20352a; font-size: 12.5px; font-weight: 700; }
    #bar span { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #bar span::first-letter { text-transform: uppercase; }
    #bar button { all: unset; cursor: pointer; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%;
                  color: #566b5c; font-size: 15px; line-height: 1; }
    #bar button:hover { background: #e0e8d9; color: #20352a; }
    #bar button:focus-visible { outline: 2px solid #2f6b4a; outline-offset: 1px; }
    #slot { border-radius: 16px; overflow: hidden; background: #20352a; }
    #slot iframe { display: block; width: 100%; aspect-ratio: 4 / 3; border: 0; }

    #toast { position: fixed; left: 50%; top: 16px; transform: translateX(-50%); width: max-content; max-width: min(560px, calc(100vw - 32px));
             padding: 11px 12px 11px 18px; border-radius: 22px; background: #20352a; color: #eef2ea; font-size: 14.5px; line-height: 1.45;
             box-shadow: 0 18px 40px -14px rgba(32, 53, 42, .5); pointer-events: auto; display: none; }
    #toast button { margin-left: 12px; padding: 6px 13px; border-radius: 999px; border: 0; cursor: pointer;
             background: #d3e8d2; color: #20352a; font-size: 13px; font-weight: 700; }
    #toast button:hover { background: #eef2ea; }

    button:focus-visible { outline: 2px solid #2f6b4a; outline-offset: 2px; }
    #toast button:focus-visible { outline-color: #eef2ea; }

    /* calibration and reading-pace screens */
    #calib { position: fixed; inset: 0; background: #eef2ea; pointer-events: auto; display: none; cursor: none; }
    #calib.show { display: block; }
    #cdot { position: fixed; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50%; background: #2f6b4a;
            box-shadow: 0 0 0 5px rgba(47, 107, 74, .18); transition: left .6s cubic-bezier(.45, 0, .25, 1), top .6s cubic-bezier(.45, 0, .25, 1); display: none; } /* keep settleMs at least this glide + 400ms */
    #cdot::after { content: ''; position: absolute; left: 10px; top: 10px; width: 8px; height: 8px; border-radius: 50%; background: #fff; }
    #cdot.pulse { animation: shrink var(--dur, 1s) ease-out forwards; }
    @keyframes shrink { from { transform: scale(1.15); } to { transform: scale(.6); } }
    #instr { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(520px, calc(100vw - 32px));
             text-align: left; color: #20352a; font-size: 18px; line-height: 1.6; letter-spacing: .01em; cursor: default; }
    .card { background: #f8faf5; border-radius: 30px; padding: 26px 28px 24px;
            box-shadow: 0 0 0 1px rgba(32, 53, 42, .08), 0 22px 50px -14px rgba(32, 53, 42, .3); }
    .card h3 { margin: 0 0 12px; font-size: 22px; line-height: 1.25; font-weight: 700; }
    .card p { margin: 0 0 10px; }
    .card ol { margin: 0 0 12px; padding: 0; list-style: none; counter-reset: step; display: grid; gap: 10px; }
    .card li { counter-increment: step; position: relative; padding-left: 42px; min-height: 30px; }
    .card li::before { content: counter(step); position: absolute; left: 0; top: -1px; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%;
                       background: #c4dfc0; font-size: 15px; font-weight: 700; }
    .card .big { margin: 2px 0 8px; font-size: 30px; line-height: 1.2; font-weight: 700; color: #2f6b4a; }
    .card small, .card .quiet { display: block; font-size: 14.5px; line-height: 1.5; color: #566b5c; }
    .card .go { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 14px; margin-top: 18px; }
    .card button, #bread button { padding: 0 22px; height: 44px; border-radius: 999px; border: 0; cursor: pointer;
            background: #2f6b4a; color: #fff; font-size: 16px; font-weight: 700; }
    .card button:hover, #bread button:hover { background: #28593e; }
    kbd { display: inline-block; padding: 1px 7px; border-radius: 7px; background: #e0e8d9; color: #20352a; font: inherit; font-size: 13px; font-weight: 700; }

    #bread { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(720px, 88vw); color: #20352a;
             cursor: default; display: none; }
    #bhint { font-size: 16px; line-height: 1.5; color: #566b5c; margin: 0 0 20px; }
    #btext { margin: 0; font-size: 24px; line-height: 60px; text-align: left; letter-spacing: .02em; word-spacing: .14em; }
    #bread button { margin-top: 26px; }

    /* While a card asks the reader to check their face, the camera box stays
       in view above the calibration screen. It is covered again once the dot
       starts, so it cannot pull the eyes away from the dot. */
    #cam:has(~ #calib.show > #instr:not([style*="display: none"]) .card.face) { z-index: 3; box-shadow: 0 0 0 3px #2f6b4a, 0 18px 40px -14px rgba(32, 53, 42, .34); }
    .card { max-height: calc(100vh - 32px); overflow: auto; }
    /* How far through the dots: a short, pale bar on the bottom edge. It only
       changes while the dot is travelling and never animates, so it cannot
       pull the eyes during sampling. */
    #calib.show:has(> #cdot[style*="display: block"])::after { content: ''; position: fixed; left: 50%; bottom: 6px; width: 120px; height: 4px;
            margin-left: -60px; border-radius: 2px;
            background: linear-gradient(to right, #93a593 calc(var(--done, 0) * 100%), #d6dfce calc(var(--done, 0) * 100%)); }
    .meter { display: flex; align-items: center; gap: 6px; margin: 0 0 12px; }
    .meter i { width: 46px; height: 8px; border-radius: 4px; background: #d6dfce; }
    .meter[data-level="1"] i:nth-child(-n+1), .meter[data-level="2"] i:nth-child(-n+2), .meter[data-level="3"] i { background: #2f6b4a; }
    .card .big + .meter { margin-top: -2px; }

    /* help on the page: the line being read, and the read-aloud pill */
    .hl { position: fixed; border-radius: 8px; background: rgba(244, 223, 166, .5); pointer-events: none;
          box-shadow: 0 0 0 2px rgba(214, 178, 84, .55); transition: top .1s, left .1s, width .1s; }
    .pill { position: fixed; display: flex; gap: 6px; pointer-events: auto; }
    .pill button { all: unset; cursor: pointer; padding: 6px 13px; border-radius: 999px; background: #2f6b4a; color: #fff;
                   font-size: 13.5px; font-weight: 700; box-shadow: 0 8px 18px -8px rgba(32, 53, 42, .5); }
    .pill button:hover { background: #28593e; }

    @media (prefers-reduced-motion: reduce) { #cam, .hl { transition: none; } }
  `;

  function ensureUI() {
    if (S.host && S.host.isConnected) return;
    S.host = document.createElement('div');
    S.host.setAttribute('data-gaze-reader', '');
    S.host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    S.root = S.host.attachShadow({ mode: 'closed' });
    S.root.innerHTML = `<style>${CSS}</style>
      <canvas id="hud"></canvas><div id="hlayer"></div>
      <div id="cam"><div id="bar"><span id="camlabel">Eye tracking</span>
        <button id="bmin" title="Make the camera smaller" aria-label="Make the camera smaller">–</button><button id="bx" title="Turn eye tracking off" aria-label="Turn eye tracking off">×</button></div><div id="slot"></div></div>
      <div id="toast"></div>
      <div id="calib"><div id="cdot"></div><div id="instr"></div>
        <div id="bread"><p id="bhint">Read this the way you normally read. Press <kbd>Space</kbd> when you reach the end.</p>
          <p id="btext"></p><button>I have finished</button></div></div>`;
    document.documentElement.appendChild(S.host);
    const $ = (id) => S.root.getElementById(id);
    $('bmin').onclick = () => $('cam').classList.toggle('min');
    $('bx').onclick = () => requestEnable(false);
    applyWidget();
    if (!document.getElementById('gr-page-style')) {
      const st = document.createElement('style');
      st.id = 'gr-page-style';
      st.textContent = '.gr-assist{word-spacing:.22em!important;letter-spacing:.03em!important;line-height:2!important;}';
      document.documentElement.appendChild(st);
    }
    loop();
  }
  const $ = (id) => S.root && S.root.getElementById(id);

  /** Hidden, not removed: the camera frame must stay rendered to keep delivering frames. */
  function applyWidget() {
    const cam = $('cam');
    if (!cam) return;
    cam.style.opacity = opts.widget ? '' : '0';
    cam.style.pointerEvents = opts.widget ? '' : 'none';
    if (!opts.widget) hideToast();
  }

  let toastTimer = 0;
  function toast(text, ms = 4500, actions = []) {
    if (!S.root || !opts.widget) return;
    const el = $('toast');
    el.textContent = text;
    for (const [label, fn] of actions) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => { el.style.display = 'none'; fn(); };
      el.appendChild(b);
    }
    el.style.display = 'block';
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => { el.style.display = 'none'; }, ms);
  }
  const hideToast = () => { const el = $('toast'); if (el) el.style.display = 'none'; };
  const openPermissionPage = () => window.open(chrome.runtime.getURL('gaze/permission.html'), '_blank');

  // ------------------------------------------------------------ camera frame
  function start() {
    if (S.startPromise && S.status !== 'idle' && S.status !== 'error') return S.startPromise;
    ensureUI();
    setStatus('starting');
    const nonce = crypto.getRandomValues(new Uint32Array(4)).join('');
    const ifr = document.createElement('iframe');
    ifr.allow = 'camera';
    ifr.src = chrome.runtime.getURL('gaze/frame.html') + '#' + nonce;
    $('slot').replaceChildren(ifr);
    S.iframe = ifr;
    S.startPromise = new Promise((resolve) => {
      S.resolveStart = resolve;
      ifr.addEventListener('load', () => {
        const ch = new MessageChannel();
        S.port = ch.port1;
        S.port.onmessage = (e) => onFrameMessage(e.data);
        ifr.contentWindow.postMessage({ type: 'gr-init', nonce }, new URL(chrome.runtime.getURL('')).origin, [ch.port2]);
      }, { once: true });
    });
    return S.startPromise;
  }

  function stop() {
    try { S.port && S.port.postMessage({ type: 'stop' }); } catch (_) { /* frame gone */ }
    cancelAnimationFrame(S.raf);
    if (S.host) S.host.remove();
    for (const el of S.assisted) el.classList.remove('gr-assist');
    S.assisted.clear();
    const pageStyle = document.getElementById('gr-page-style');
    if (pageStyle) pageStyle.remove();
    const was = S.struggling;
    Object.assign(S, { host: null, root: null, iframe: null, port: null, highlights: [], startPromise: null, collector: null, bl: null, struggling: null, block: null, cur: null });
    if (was) emit('struggling', { struggling: false, reason: was.reason, element: was.el, ratio: 0, tau: +tau().toFixed(2) });
    setStatus('idle');
  }

  /** The user asked (camera widget, shortcut, popup) to turn tracking on or off. */
  function requestEnable(wanted) {
    if (opts.managed && typeof opts.onEnableRequest === 'function') { opts.onEnableRequest(!!wanted); return; }
    chrome.storage.local.set({ grEnabled: !!wanted });
    if (wanted) start(); else stop();
  }

  async function onFrameMessage(d) {
    if (!d) return;
    if (d.type === 'status') {
      $('camlabel') && ($('camlabel').textContent = d.detail || d.state);
      if (d.state === 'needs-permission') {
        setStatus('needs-permission');
        toast('Eye tracking needs one-time camera access.', 0, [['Allow camera', openPermissionPage]]);
        S.resolveStart && S.resolveStart(getState());
      } else if (d.state === 'error') {
        setStatus('error');
        toast('Eye tracking error: ' + d.detail, 8000);
        S.resolveStart && S.resolveStart(getState());
      } else if (d.state === 'ready') {
        await restoreBaseline();
        const restored = await restoreCalibration();
        if (restored) {
          setStatus('tracking');
          if (S.baseline) toast('Eye tracking on (saved calibration).', 3500, [['Recalibrate', calibrate]]);
          else toast('Eye tracking on. A short reading check lets it learn your pace.', 0, [['Measure my pace', () => measureBaseline().catch(() => {})]]);
        } else {
          setStatus('ready');
          toast('Eye tracking is ready. A one-minute calibration makes it accurate.', 0, [['Calibrate', () => calibrate().catch(() => {})]]);
        }
        S.resolveStart && S.resolveStart(getState());
      }
      return;
    }
    if (d.type === 'camera') {
      S.camera = d.settings || null;
      emit('camera', { t: performance.now(), settings: S.camera });
      const c = S.camera;
      if (c && c.width && c.height && (c.width < 1280 || c.height < 720)) toast('Your camera is only giving ' + c.width + ' by ' + c.height + '. Eye tracking will be rough at that size.', 8000);
      return;
    }
    if (d.type !== 'f') return;
    S.fps = d.fps;
    const t = performance.now();
    // Every camera frame, blinks and lost faces included (same clock as 'gaze').
    if (listeners.frame && listeners.frame.length) emit('frame', { t, face: !!d.face, blink: !!d.blink, head: d.head || null });
    // Lab use: the raw feature vector of every frame, before any model.
    if (listeners.raw && listeners.raw.length) emit('raw', { t, face: !!d.face, blink: !!d.blink, f: d.face ? d.f : undefined, head: d.head || null, fps: d.fps });
    if (!d.face) { S.latest = { face: false, t }; return; }
    S.latest = { ...d, t };
    if (!d.blink) { S.recent.push({ f: d.f, t }); if (S.recent.length > 6) S.recent.shift(); }
    if (S.collector && !d.blink) S.collector.push({ f: d.f, head: d.head });
    if ((S.status === 'tracking' || (S.status === 'baseline' && S.bl)) && S.model && !document.hidden) processFrame(d, t);
  }

  // ------------------------------------------------------------- tracking
  function processFrame(d, t) {
    if (S.calibHead) {
      const h = d.head, h0 = S.calibHead;
      const moved = Math.hypot(h.cx - h0.cx, h.cy - h0.cy) > 0.08 || Math.abs(h.s / h0.s - 1) > 0.15;
      if (moved) {
        if (!S.driftSince) S.driftSince = t;
        if (!S.drifted && t - S.driftSince > 600) {
          S.drifted = true;
          if (!S.bl) toast('Move back to where you sat during calibration. Tracking is paused.', 0, [['Recalibrate here', () => calibrate().catch(() => {})]]);
          emit('status', getState());
        }
      } else {
        S.driftSince = 0;
        if (S.drifted) { S.drifted = false; hideToast(); S.fix.reset(); emit('status', getState()); }
      }
    }
    if (S.drifted || d.blink) return;
    const [x, y] = S.model.predict(d.f);
    S.gaze = { x: S.euroX.filter(x, t), y: S.euroY.filter(y, t), rawX: x, rawY: y, t };
    emit('gaze', S.gaze);
    const fix = S.fix.push(t, x, y);
    if (fix) onFixation(fix);
  }

  function rootNode() { return opts.root || document; }

  function getBlocks() {
    const now = performance.now();
    if (S.blocksCache && now - S.blocksCache.t < 400) return S.blocksCache.list;
    const vw = innerWidth, vh = innerHeight, root = rootNode();
    const cands = new Set(root.querySelectorAll(BLOCK_SEL));
    const divs = root.querySelectorAll('div,section,article');
    for (let i = 0; i < divs.length && i < 4000; i++) {
      for (const n of divs[i].childNodes) {
        if (n.nodeType === 3 && n.nodeValue.trim().length > 40) { cands.add(divs[i]); break; }
      }
    }
    const list = [];
    for (const el of cands) {
      if (S.host && (el === S.host || S.host.contains(el))) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw || r.width < 30 || r.height < 8) continue;
      const txt = el.textContent;
      if (!txt || txt.trim().length < 20) continue;
      list.push({ el, r });
    }
    const leaf = list.filter((a) => !list.some((b) => b !== a && a.el.contains(b.el)));
    S.blocksCache = { t: now, list: leaf };
    return leaf;
  }

  function normDist(r, x, y) {
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    return Math.hypot(dx / S.sx, dy / S.sy);
  }

  function pickBlock(x, y) {
    const blocks = getBlocks();
    let best = null, bd = Infinity;
    for (const b of blocks) { const dd = normDist(b.r, x, y); if (dd < bd) { bd = dd; best = b.el; } }
    if (S.block) {   // hysteresis: don't hop paragraphs on one noisy fixation
      const cur = blocks.find((b) => b.el === S.block);
      if (cur) { const dc = normDist(cur.r, x, y); if (dc < 1.2 && dc <= bd + 0.8) return S.block; }
    }
    return bd <= 2 ? best : null;
  }

  function getLines(el) {
    const c = S.lineCache.get(el), now = performance.now();
    if (c && c.v === S.layoutV && now - c.t < 1000) return c.lines;
    const range = document.createRange();
    range.selectNodeContents(el);
    const lines = C.mergeLineRects(range.getClientRects());
    S.lineCache.set(el, { t: now, v: S.layoutV, lines });
    return lines;
  }

  /* Reading time follows characters far better than words: dense text has longer words.
     A block's size is therefore counted in "passage words": its characters divided by the
     characters per word of the baseline passage the reader's pace was measured on. */
  const CHARS_PER_WORD = BASELINE_TEXT.replace(/\s+/g, '').length / BASELINE_TEXT.match(/\S+/g).length;
  function wordCount(el) { return (el.innerText || el.textContent || '').replace(/\s+/g, '').length / CHARS_PER_WORD; }

  function blockState(el) {
    let st = S.states.get(el);
    if (!st) {
      st = { hmm: new C.LineHMM(S.drift), words: wordCount(el), nLines: 0, leftAt: -1e9, lastTrigger: -1e9, triggers: 0 };
      resetCounters(st, 0);
      S.states.set(el, st);
    }
    return st;
  }
  function resetCounters(st, n) {
    Object.assign(st, {
      nLines: n, lineDwell: new Float64Array(n), visits: new Uint16Array(n), totalDwell: 0, runMs: 0,
      lastLine: -1, maxLine: -1, backtracks: [], triggers: 0,
    });
  }

  function expectedMs(st, lines, lineIdx) {
    const widths = lines.map((l) => l.right - l.left), total = widths.reduce((a, b) => a + b, 0) || 1;
    const msPerWord = 60000 / S.wpm;
    const para = st.words * msPerWord + 150 * lines.length;
    const line = lineIdx >= 0 ? st.words * (widths[lineIdx] / total) * msPerWord + 150 : 0;
    return { para, line };
  }

  function leaveBlock(el, t) {
    if (!el) return;
    const st = blockState(el);
    st.leftAt = t;
    S.prevBlockBottom = el.getBoundingClientRect().bottom;
    const lines = getLines(el);
    const exp = expectedMs(st, lines, -1).para;
    if (st.totalDwell > 0) {
      S.heat.set(el, st.totalDwell / exp);
      if (S.heat.size > 300) S.heat.delete(S.heat.keys().next().value);
    }
    // Learn this reader's normal pace from paragraphs they finished without trouble.
    // Every finished paragraph teaches, including the slow ones (leaving those out kept the
    // expectation too fast on hard text). One odd paragraph can only pull the pace so far.
    if (st.nLines > 1 && st.maxLine >= st.nLines - 1 && st.totalDwell > 1500 && st.words > 8) {
      const obs = Math.max(0.6 * S.wpm, Math.min(1.6 * S.wpm, st.words / (st.totalDwell / 60000)));
      S.wpm = 0.8 * S.wpm + 0.2 * Math.max(40, Math.min(450, obs));
      // The measured baseline is the anchor: page text can be harder or easier than
      // the passage, but the working pace may only move so far from it.
      if (S.baseline) S.wpm = Math.max(0.45 * S.baseline.wpm, Math.min(1.6 * S.baseline.wpm, S.wpm));
    }
  }

  function enterBlock(el, t) {
    S.block = el;
    if (!el) return;
    const st = blockState(el);
    if (t - st.leftAt > 5000) resetCounters(st, st.nLines);
    st.hmm.reset();
    st.justEntered = true;
  }

  function onFixation(fix) {
    S.lastFix = fix;
    emit('fixation', fix);
    if (S.bl) { baselineFixation(fix); return; }
    if (fix.t < S.scrollT + 200) { S.prevFixEnd = 0; return; }      // fixation overlapped a scroll: positions are unreliable
    const el = pickBlock(fix.x, fix.y);
    if (el !== S.block) { leaveBlock(S.block, fix.t); enterBlock(el, fix.t); }
    if (S.struggling && S.struggling.el !== el) setStruggling(null);   // moved to other text
    if (!el) { S.cur = null; S.prevFixEnd = 0; return; }
    const st = blockState(el);
    const lines = getLines(el);
    if (!lines.length) return;
    if (st.nLines !== lines.length) { resetCounters(st, lines.length); st.hmm.reset(); }
    if (st.epoch !== S.scrollEpoch) { st.epoch = S.scrollEpoch; st.hmm.reset(); st.lastLine = -1; }
    const fromAbove = st.justEntered && S.prevBlockBottom !== null && S.prevBlockBottom <= lines[0].top + 5;
    const r = st.hmm.update(lines, fix.x, fix.y, S.sx, S.sy, fromAbove);
    st.justEntered = false;
    const L = r.line;
    // Credit wall-clock time (fixation + the gap since the previous one): noisy webcam
    // samples split fixations and drop frames, so summing fix.dur undercounts dwell.
    const end = fix.t + fix.dur;
    const dwell = S.prevFixEnd && end - S.prevFixEnd < 1200 ? end - S.prevFixEnd : fix.dur;
    S.prevFixEnd = end;
    st.totalDwell += dwell;
    st.lineDwell[L] += dwell;
    if (L === st.lastLine) st.runMs += dwell;
    else {
      if (st.lastLine >= 0 && L < st.lastLine && L <= st.maxLine && r.conf > 0.55) st.backtracks.push(fix.t);
      // Coming back to a line after really reading another one starts a fresh pass:
      // re-reading must not add up to "stuck". A one-fixation decode flicker (short
      // run elsewhere) keeps the running total, so a true stall still accumulates.
      if (st.visits[L] > 0 && st.runMs >= 500 && r.conf > 0.55) st.lineDwell[L] = dwell;
      st.visits[L]++;
      st.runMs = dwell;
      st.lastLine = L;
    }
    st.maxLine = Math.max(st.maxLine, L);
    const changed = !S.cur || S.cur.el !== el || S.cur.line !== L;
    S.cur = { el, line: L, conf: r.conf };
    if (changed) emit('line', getCurrentLine());
    S.heat.set(el, st.totalDwell / expectedMs(st, lines, -1).para);
    checkStruggle(el, st, lines, fix.t, r.conf);
  }

  /** Enter or leave the struggling state; tells listeners only when it flips. */
  function setStruggling(next) {
    const was = S.struggling;
    S.struggling = next;
    if (!!was === !!next) return;
    const ref = next || was;
    emit('struggling', { struggling: !!next, reason: ref.reason, element: ref.el, ratio: +(ref.ratio || 0).toFixed(2), tau: +tau().toFixed(2) });
    emit('status', getState());
  }

  function checkStruggle(el, st, lines, now, conf) {
    const L = st.lastLine;
    const exp = expectedMs(st, lines, L);
    const T = tau();
    // Total time on this line during this visit (robust to one-fixation decode flickers).
    const onLine = L >= 0 ? st.lineDwell[L] : 0;

    // Leaving the struggling state: the reader has moved on to another line and is
    // taking it at a normal pace again. (A new paragraph clears it in onFixation.)
    const sg = S.struggling;
    if (sg && now - sg.since > 1500 && L !== sg.line && onLine > 600 && onLine < T * exp.line) setStruggling(null);

    if (now - st.lastTrigger < 8000) return;
    st.backtracks = st.backtracks.filter((bt) => now - bt < 15000);
    const d = C.struggleDecision({
      onLineMs: onLine, expLineMs: exp.line, paraMs: st.totalDwell, expParaMs: exp.para,
      finished: st.maxLine >= st.nLines - 1, backtracks: st.backtracks.length, tau: T,
      regressionRate: S.baseline ? S.baseline.regressionRate : 0,
    });
    if (opts.trace) console.log('[gaze-trace]', JSON.stringify({ line: L, onLine: Math.round(onLine), expLine: Math.round(exp.line), total: Math.round(st.totalDwell), expPara: Math.round(exp.para), back: st.backtracks.length, words: st.words, n: lines.length, tau: +T.toFixed(2), ratio: +d.ratio.toFixed(2) }));
    // How fine can we trust the tracker on this text? When its vertical error is large
    // next to the line spacing, a single line is a guess: fall back to the paragraph's
    // total time, which does not depend on getting the line right.
    const pitch = lines.length > 1 ? (lines[lines.length - 1].top - lines[0].top) / (lines.length - 1) : lines[0].bottom - lines[0].top;
    const coarse = S.sy > 0.6 * pitch;
    let reason = d.reason, severity = d.severity;
    if (coarse) {
      const slow = st.triggers === 0 && st.totalDwell > Math.max(4000, T * exp.para);   // once per visit
      reason = slow ? 'slow-paragraph' : null;
      severity = Math.min(1, st.totalDwell / (2.5 * T * Math.max(exp.para, 1)));
    } else if (reason === 'stuck-line' && conf < 0.5) {
      reason = null;   // slow, but not sure enough which line to point at it
    }
    if (!reason) return;
    let line = L;
    if (reason === 'rereading') {
      let m = 0;
      for (let i = 0; i <= st.maxLine; i++) if (st.visits[i] > st.visits[m]) m = i;
      line = m;
    }
    const backtracks = st.backtracks.length;
    st.lastTrigger = now; st.triggers++; st.runMs = 0; st.backtracks = [];
    // Coarse tracking reports a band of lines around the best guess, not one line.
    const span = coarse ? 1 : 0;
    const a = lines[Math.max(0, line - span)], b = lines[Math.min(lines.length - 1, line + span)];
    const rect = { top: a.top, bottom: b.bottom, left: Math.min(a.left, b.left), right: Math.max(a.right, b.right) };
    const detail = {
      element: el, lineIndex: line, lineRect: { ...rect }, lineText: getLineText(el, rect), coarse, lineSpan: span,
      paragraphText: (el.innerText || el.textContent || '').trim(), reason, severity: +severity.toFixed(2),
      metrics: {
        paragraphDwellMs: Math.round(st.totalDwell), expectedParagraphMs: Math.round(exp.para),
        lineDwellMs: Math.round(st.lineDwell[line]), expectedLineMs: Math.round(exp.line), backtracks,
        readerWpm: Math.round(S.wpm), baselineWpm: S.baseline ? Math.round(S.baseline.wpm) : null,
        tau: +T.toFixed(2), ratio: +d.ratio.toFixed(2), lineConfidence: +conf.toFixed(2),
        trackerErrorPx: Math.round(S.sy), linePitchPx: Math.round(pitch),
      },
    };
    if (L >= 0) st.lineDwell[L] = 0;
    if (S.struggling) Object.assign(S.struggling, { el, line: L, reason, since: now, ratio: d.ratio });
    else setStruggling({ el, line: L, reason, since: now, ratio: d.ratio });
    const prevented = emit('struggle', detail);
    if (opts.autoAdapt && !prevented) defaultAdapt(detail);
  }

  // ------------------------------------------------ baseline reading pace
  /** A fixation during the baseline passage: credit its time to the decoded line. */
  function baselineFixation(fix) {
    const bl = S.bl;
    if (!bl.lines.length) return;
    const box = bl.box;
    if (fix.x < box.left - 2.5 * S.sx || fix.x > box.right + 2.5 * S.sx || fix.y < box.top - 2.5 * S.sy || fix.y > box.bottom + 2.5 * S.sy) {
      bl.prevEnd = 0;   // looked away: that time is not reading time
      return;
    }
    const r = bl.hmm.update(bl.lines, fix.x, fix.y, S.sx, S.sy, bl.last < 0);
    const L = r.line;
    const end = fix.t + fix.dur;
    const dwell = bl.prevEnd && end - bl.prevEnd < 1200 ? end - bl.prevEnd : fix.dur;
    bl.prevEnd = end;
    bl.dwell[L] += dwell;
    if (bl.last >= 0 && L < bl.last && L <= bl.max && r.conf > 0.55) bl.regress++;
    bl.last = L;
    bl.max = Math.max(bl.max, L);
  }

  /** Show the passage, time one read of it, and turn that into the reader's baseline. */
  async function runBaseline(instr) {
    const bread = $('bread'), btext = $('btext');
    setStatus('baseline');
    instr.style.display = 'block';
    instr.innerHTML = `<div class="card"><h3>Find your reading pace</h3>
      <ol><li>A short passage comes next.</li>
      <li>Read it once, silently, the way you normally read. Take your time.</li>
      <li>Press <kbd>Space</kbd> when you reach the end.</li></ol>
      <div class="go"><button>Show the passage</button> <span class="quiet"><kbd>Space</kbd> to show it, <kbd>Esc</kbd> to skip</span></div></div>`;
    await waitForStart(instr);
    const text = opts.baselineText || BASELINE_TEXT;
    const totalWords = (text.match(/\S+/g) || []).length;
    const pitch = Math.max(48, Math.min(84, (S.accuracy && S.accuracy.recommendedLinePitchPx) || 60));
    btext.style.lineHeight = pitch + 'px';
    btext.style.fontSize = Math.round(Math.max(20, Math.min(30, pitch * 0.4))) + 'px';
    btext.textContent = text;

    for (;;) {
      instr.style.display = 'none';
      bread.style.display = 'block';
      await sleep(60);   // let the passage lay out before measuring its lines
      const range = document.createRange();
      range.selectNodeContents(btext);
      const lines = C.mergeLineRects(range.getClientRects());
      const lineWords = lines.map((rect) => (getLineText(btext, rect).match(/\S+/g) || []).length);
      S.fix.reset();
      const bl = S.bl = {
        lines, hmm: new C.LineHMM(S.drift), dwell: new Float64Array(lines.length), last: -1, max: -1, regress: 0, prevEnd: 0,
        box: btext.getBoundingClientRect(), t0: performance.now(),
      };
      try { await waitForStart(bread); } finally { S.bl = null; bread.style.display = 'none'; }
      const clockMs = performance.now() - bl.t0;
      instr.style.display = 'block';
      if (clockMs < totalWords * 75) {   // faster than 800 words a minute: not a real read
        instr.innerHTML = `<div class="card"><h3>That was too quick to measure</h3>
          <p>Read the passage through once at your usual speed. Then press <kbd>Space</kbd>.</p>
          <div class="go"><button>Try again</button> <span class="quiet"><kbd>Space</kbd> to try again, <kbd>Esc</kbd> to skip</span></div></div>`;
        await waitForStart(instr);
        continue;
      }
      const b = C.summarizeBaseline({
        lines: lineWords.map((words, i) => ({ words, dwellMs: bl.dwell[i] })), clockMs, totalWords, regressions: bl.regress,
      });
      b.wpm = Math.round(b.wpm); b.msPerWord = Math.round(b.msPerWord);
      b.cv = +b.cv.toFixed(3); b.regressionRate = +b.regressionRate.toFixed(3); b.tau = +b.tau.toFixed(2);
      b.t = Date.now();
      S.baseline = b;
      S.wpm = b.wpm;
      chrome.storage.local.set({ grBaseline: b });
      emit('baseline', { ...b });
      emit('status', getState());
      instr.innerHTML = `<div class="card"><h3>Your reading pace</h3>
        <div class="big">${b.wpm} words a minute</div>
        <p>Help appears when a line takes you about <b>${tau().toFixed(1)} times</b> longer than usual.</p>
        <small>You can make help come sooner or later in the Glider panel.</small>
        <div class="go"><button>Start reading</button> <span class="quiet">or press <kbd>Space</kbd></span></div></div>`;
      await waitForStart(instr).catch(() => {});
      return b;
    }
  }

  /** Redo only the reading-pace passage (the eye calibration is kept). */
  async function measureBaseline() {
    if (calibrating) return calibrating;
    if (!S.model) return calibrate();
    calibrating = (async () => {
      hideToast();
      const cal = $('calib'), instr = $('instr');
      cal.classList.add('show');
      $('cdot').style.display = 'none';
      try { return await runBaseline(instr); }
      finally {
        cal.classList.remove('show');
        $('bread').style.display = 'none';
        S.bl = null;
        setStatus('tracking');
      }
    })();
    try { return await calibrating; } finally { calibrating = null; }
  }

  function getLineText(el, rect) {
    if (!rect) return '';
    const words = [];
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let count = 0;
    for (let n = tw.nextNode(); n && count < 3000; n = tw.nextNode()) {
      const re = /\S+/g;
      let m;
      while ((m = re.exec(n.nodeValue)) && count++ < 3000) {
        range.setStart(n, m.index); range.setEnd(n, m.index + m[0].length);
        const r = range.getBoundingClientRect();
        const cy = (r.top + r.bottom) / 2;
        if (cy >= rect.top && cy <= rect.bottom) words.push(m[0]);
      }
    }
    return words.join(' ');
  }

  // ------------------------------------------------- default adaptation
  function defaultAdapt(d) {
    const hl = document.createElement('div');
    hl.className = 'hl';
    const pill = document.createElement('div');
    pill.className = 'pill';
    const read = document.createElement('button');
    read.textContent = d.coarse ? 'Read this part aloud' : 'Read line aloud';
    read.onclick = () => {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(d.lineText || d.paragraphText);
      u.rate = 0.9;
      speechSynthesis.speak(u);
    };
    pill.appendChild(read);
    // In managed mode the host extension owns every change to the page's text.
    if (d.reason !== 'stuck-line' && !opts.managed) { d.element.classList.add('gr-assist'); S.assisted.add(d.element); }
    $('hlayer').append(hl, pill);
    S.highlights.push({ el: d.element, idx: d.lineIndex, span: d.lineSpan || 0, until: performance.now() + 7000, hl, pill });
  }

  // --------------------------------------------------------- render loop
  function loop() {
    cancelAnimationFrame(S.raf);
    const frame = () => {
      S.raf = requestAnimationFrame(frame);
      if (!S.root) return;
      const now = performance.now();
      if (S.struggling && now - S.struggling.since > 15000) setStruggling(null);   // nothing new for a while
      S.highlights = S.highlights.filter((h) => {
        const ls = getLines(h.el), r0 = ls[Math.max(0, h.idx - h.span)], r1 = ls[Math.min(ls.length - 1, h.idx + h.span)];
        const r = r0 && r1 && ls[h.idx] ? { top: r0.top, bottom: r1.bottom, left: Math.min(r0.left, r1.left), right: Math.max(r0.right, r1.right) } : null;
        if (now > h.until || !r || !h.el.isConnected) { h.hl.remove(); h.pill.remove(); return false; }
        Object.assign(h.hl.style, { left: r.left - 5 + 'px', top: r.top - 2 + 'px', width: r.right - r.left + 10 + 'px', height: r.bottom - r.top + 4 + 'px' });
        Object.assign(h.pill.style, { left: Math.min(innerWidth - 150, r.right + 10) + 'px', top: r.top - 4 + 'px' });
        return true;
      });
      drawHud();
    };
    frame();
  }

  function drawHud() {
    const cv = $('hud');
    const dpr = devicePixelRatio || 1;
    if (cv.width !== innerWidth * dpr || cv.height !== innerHeight * dpr) {
      cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
      cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, innerWidth, innerHeight);
    if (!opts.debug || S.status === 'calibrating') return;

    // reading heatmap: time spent vs. expected, per paragraph
    for (const [el, ratio] of S.heat) {
      if (!el.isConnected) { S.heat.delete(el); continue; }
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) continue;
      const col = ratio < 1.2 ? '46,204,113' : ratio < 2 ? '241,196,15' : '231,76,60';
      g.fillStyle = `rgba(${col},${ratio < 1.2 ? 0.10 : 0.18})`;
      g.fillRect(r.left - 4, r.top - 4, r.width + 8, r.height + 8);
    }
    if (S.cur && S.cur.el.isConnected) {
      const r = S.cur.el.getBoundingClientRect();
      g.strokeStyle = 'rgba(76,141,255,.9)'; g.lineWidth = 2;
      g.strokeRect(r.left - 4, r.top - 4, r.width + 8, r.height + 8);
      const l = getLines(S.cur.el)[S.cur.line];
      if (l) { g.fillStyle = `rgba(76,141,255,${0.12 + 0.25 * S.cur.conf})`; g.fillRect(l.left - 3, l.top, l.right - l.left + 6, l.bottom - l.top); }
    }
    if (S.lastFix) {
      g.strokeStyle = 'rgba(155,89,182,.8)'; g.lineWidth = 2;
      g.beginPath(); g.arc(S.lastFix.x, S.lastFix.y, 6 + Math.min(30, S.lastFix.dur / 25), 0, 2 * Math.PI); g.stroke();
    }
    if (S.gaze && performance.now() - S.gaze.t < 500) {
      g.fillStyle = 'rgba(231,76,60,.15)';
      g.beginPath(); g.ellipse(S.gaze.x, S.gaze.y, S.sx, S.sy, 0, 0, 2 * Math.PI); g.fill();
      g.fillStyle = 'rgba(231,76,60,.95)';
      g.beginPath(); g.arc(S.gaze.x, S.gaze.y, 6, 0, 2 * Math.PI); g.fill();
    }
    const a = S.accuracy;
    const lines = [
      `gaze ${S.status}${S.drifted ? ' (head moved)' : ''} · ${S.fps} fps`,
      a ? `error ±${Math.round(S.sx)}px horiz · ±${Math.round(S.sy)}px vert` : 'not calibrated',
      `reader pace ${Math.round(S.wpm)} wpm${S.baseline ? ` (baseline ${S.baseline.wpm})` : ''} · drift ${Math.round(S.drift.y)}px`,
      `tau ${tau().toFixed(2)}${S.baseline ? '' : ' (default)'} · ${S.struggling ? 'STRUGGLING: ' + S.struggling.reason : 'reading normally'}`,
      S.cur ? `line ${S.cur.line + 1} · confidence ${(S.cur.conf * 100).toFixed(0)}%` : 'line —',
    ];
    g.font = '12px ui-monospace, monospace';
    g.fillStyle = 'rgba(20,24,32,.82)';
    g.fillRect(10, 10, 300, 18 * lines.length + 10);
    g.fillStyle = '#fff';
    lines.forEach((s, i) => g.fillText(s, 18, 28 + 18 * i));
  }

  // ------------------------------------------------------------ calibration
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function collect(ms) {
    return new Promise((res) => { S.collector = []; setTimeout(() => { const c = S.collector || []; S.collector = null; res(c); }, ms); });
  }
  function waitForStart(calibEl) {
    return new Promise((resolve, reject) => {
      const onKey = (e) => {
        if (e.repeat) { if (e.code === 'Space') e.preventDefault(); return; }   // a held key must not skip steps
        if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); e.stopPropagation(); done(); }
        if (e.code === 'Escape') { cleanup(); reject(new Error('cancelled')); }
      };
      const btn = calibEl.querySelector('button');
      const cleanup = () => { window.removeEventListener('keydown', onKey, true); };
      const done = () => { cleanup(); resolve(); };
      window.addEventListener('keydown', onKey, true);
      if (btn) btn.onclick = done;
    });
  }

  let calibrating = null;
  async function calibrate(o) {
    if (calibrating) return calibrating;
    const withBaseline = !(o && o.baseline === false);
    calibrating = (async () => {
      if (S.status === 'idle' || S.status === 'error') await start();
      if (!['ready', 'tracking'].includes(S.status)) throw new Error('camera not ready: ' + S.status);
      hideToast();
      const prevStatus = S.status;
      setStatus('calibrating');
      const cal = $('calib'), dot = $('cdot'), instr = $('instr');
      cal.classList.add('show');
      dot.style.display = 'none';
      let escaped = false;
      const onEsc = (e) => { if (e.code === 'Escape') escaped = true; };
      window.addEventListener('keydown', onEsc, true);
      try {
        instr.style.display = 'block';
        instr.innerHTML = `<div class="card face"><h3>Calibrate eye tracking</h3>
          <ol>${opts.widget ? '<li>Check that you can see your whole face in the camera box in the corner.</li>' : ''}
          <li>Sit the way you will read, about an arm's length from the screen.</li>
          <li>Keep your head still.</li>
          <li>Follow the green dot with your <b>eyes</b>. It moves to a new spot, then shrinks.</li></ol>
          <small>This takes about 30 seconds${withBaseline ? '. After that there is one short passage to read' : ''}.</small>
          <div class="go"><button>Start</button> <span class="quiet"><kbd>Space</kbd> to start, <kbd>Esc</kbd> to cancel</span></div></div>`;
        await waitForStart(instr);
        while (!(S.latest && S.latest.face)) {
          instr.innerHTML = '<div class="card face"><h3>Looking for your face</h3><p>Move until your whole face shows in the camera box. A brighter room helps.</p><small>The dot starts as soon as your face is found. <kbd>Esc</kbd> to cancel.</small></div>';
          await sleep(300);
          if (escaped) throw new Error('cancelled');
        }
        instr.style.display = 'none';
        dot.style.display = 'block';

        const runPoints = async (pts, groupBase) => {
          const out = [];
          for (let i = 0; i < pts.length; i++) {
            if (escaped) throw new Error('cancelled');
            // Progress through all 18 dots, 0..1, for a quiet indicator styled in CSS.
            cal.style.setProperty('--done', (((groupBase ? CAL_POINTS.length : 0) + i) / (CAL_POINTS.length + VAL_POINTS.length)).toFixed(3));
            const x = pts[i][0] * innerWidth, y = pts[i][1] * innerHeight;
            dot.classList.remove('pulse');
            dot.style.left = x + 'px'; dot.style.top = y + 'px';
            await sleep(opts.settleMs);
            dot.style.setProperty('--dur', opts.sampleMs + 'ms');
            void dot.offsetWidth; dot.classList.add('pulse');
            const samples = await collect(opts.sampleMs);
            out.push({ x, y, g: groupBase + i, samples });
          }
          return out;
        };

        const calPts = await runPoints(CAL_POINTS, 0);
        const X = [], Y = [], G = [], heads = [];
        const thin = calPts.filter((p) => p.samples.length < 8).length;
        if (thin > 2) throw new Error('your eyes were lost on several dots. Face the camera, add light and try again');
        for (const p of calPts) for (const s of p.samples) { X.push(s.f.slice(0, opts.featureCount)); Y.push([p.x, p.y]); G.push(p.g); heads.push(s.head); }
        if (X.length < 120) throw new Error('not enough face frames — improve lighting and face the camera');
        let model = new C.Ridge().fit(X, Y, G);
        // Second pass without the stray frames (eyes still arriving, glances away, half blinks).
        trimTrain(model, X, Y, G, heads);
        model = new C.Ridge().fit(X, Y, G);

        const valPts = await runPoints(VAL_POINTS, 100);
        dot.style.display = 'none';
        const acc = accuracyFrom(model, valPts);
        for (const p of valPts) for (const s of p.samples) { X.push(s.f.slice(0, opts.featureCount)); Y.push([p.x, p.y]); G.push(p.g); heads.push(s.head); }
        model = new C.Ridge().fit(X, Y, G);
        trimTrain(model, X, Y, G, heads);
        model = new C.Ridge().fit(X, Y, G);

        S.model = model;
        S.accuracy = acc;
        S.train = { X, Y, G };
        S.clicks = [];
        S.calibHead = {
          cx: heads.reduce((a, h) => a + h.cx, 0) / heads.length,
          cy: heads.reduce((a, h) => a + h.cy, 0) / heads.length,
          s: heads.reduce((a, h) => a + h.s, 0) / heads.length,
        };
        S.calibScreen = { w: innerWidth, h: innerHeight, sx: screenX, sy: screenY };
        applyAccuracy(acc);
        S.drift.y = 0; S.drifted = false; S.needsRecal = false;
        saveCalibration();

        instr.style.display = 'block';
        const quality = acc.effY < 45 ? ['Great', 'Glider can follow you line by line.', 3]
          : acc.effY < 80 ? ['Good', 'Glider can follow you line by line when the lines are spaced out.', 2]
            : ['Rough', 'Glider can only tell which paragraph you are on. A brighter room and a still head will help.', 1];
        instr.innerHTML = `<div class="card"><h3>Calibration done</h3>
          <div class="big">${quality[0]}</div>
          <div class="meter" data-level="${quality[2]}" aria-hidden="true"><i></i><i></i><i></i></div>
          <p>${quality[1]}</p>
          <small>Accuracy: ±${Math.round(acc.effX)}px across, ±${Math.round(acc.effY)}px up and down. Best line spacing: ${acc.recommendedLinePitchPx}px.</small>
          <div class="go"><button>${withBaseline ? 'Continue' : 'Start reading'}</button> <span class="quiet">or press <kbd>Space</kbd></span></div></div>`;
        emit('accuracy', acc);
        let skipped = false;
        await waitForStart(instr).catch(() => { skipped = true; });
        // Second half: learn this reader's own pace. Skipping it keeps the eye
        // calibration and falls back to the previous (or default) pace and tau.
        if (withBaseline && !skipped) {
          try { await runBaseline(instr); }
          catch (e) { if (e.message !== 'cancelled') throw e; }
        }
        setStatus('tracking');
        return acc;
      } catch (e) {
        setStatus(S.model ? 'tracking' : prevStatus);
        if (e.message !== 'cancelled') toast('Calibration failed: ' + e.message, 7000, [['Try again', () => calibrate().catch(() => {})]]);
        throw e;
      } finally {
        window.removeEventListener('keydown', onEsc, true);
        cal.classList.remove('show');
        dot.style.display = 'none';
        if ($('bread')) $('bread').style.display = 'none';
        S.collector = null;
        S.bl = null;
      }
    })();
    try { return await calibrating; } finally { calibrating = null; }
  }

  /** Drop, per calibration dot, the frames whose prediction error is far from that dot's own median (in place). */
  function trimTrain(model, X, Y, G, heads) {
    const med = (a) => { const b = a.slice().sort((p, q) => p - q); return b.length ? b[b.length >> 1] : 0; };
    const byDot = new Map();
    X.forEach((x, i) => { const p = model.predict(x); (byDot.get(G[i]) || byDot.set(G[i], []).get(G[i])).push({ i, ex: p[0] - Y[i][0], ey: p[1] - Y[i][1] }); });
    const drop = new Set();
    for (const rows of byDot.values()) {
      if (rows.length < 8) continue;
      const mx = med(rows.map((r) => r.ex)), my = med(rows.map((r) => r.ey));
      const sx = 1.4826 * med(rows.map((r) => Math.abs(r.ex - mx))) || 1, sy = 1.4826 * med(rows.map((r) => Math.abs(r.ey - my))) || 1;
      for (const r of rows) if (Math.abs(r.ex - mx) > 2.5 * sx || Math.abs(r.ey - my) > 2.5 * sy) drop.add(r.i);
    }
    if (!drop.size || drop.size > 0.3 * X.length) return 0;
    for (const arr of [X, Y, G, heads]) { let w = 0; for (let i = 0; i < arr.length; i++) if (!drop.has(i)) arr[w++] = arr[i]; arr.length = w; }
    return drop.size;
  }

  function accuracyFrom(model, pts) {
    let bx = 0, by = 0, nx = 0, ny = 0, k = 0;
    for (const p of pts) {
      if (p.samples.length < 5) continue;
      const preds = p.samples.map((s) => model.predict(s.f));
      const mx = preds.reduce((a, q) => a + q[0], 0) / preds.length;
      const my = preds.reduce((a, q) => a + q[1], 0) / preds.length;
      bx += (mx - p.x) ** 2; by += (my - p.y) ** 2;
      nx += Math.sqrt(preds.reduce((a, q) => a + (q[0] - mx) ** 2, 0) / preds.length);
      ny += Math.sqrt(preds.reduce((a, q) => a + (q[1] - my) ** 2, 0) / preds.length);
      k++;
    }
    if (!k) throw new Error('lost the face during validation');
    const accX = Math.sqrt(bx / k), accY = Math.sqrt(by / k), precX = nx / k, precY = ny / k;
    // A fixation spans ~6 frames, but neighbouring frames share most of their landmark
    // noise, so it holds only about 2.5 independent ones. Bias does not average out at all.
    const effX = Math.sqrt(accX ** 2 + precX ** 2 / 2.5), effY = Math.sqrt(accY ** 2 + precY ** 2 / 2.5);
    return {
      accuracyX: Math.round(accX), accuracyY: Math.round(accY), precisionX: Math.round(precX), precisionY: Math.round(precY),
      effX: Math.round(effX), effY: Math.round(effY),
      recommendedLinePitchPx: Math.round(Math.max(36, Math.min(120, 1.5 * effY))),
      viewport: { w: innerWidth, h: innerHeight },
    };
  }

  function applyAccuracy(acc) {
    S.sx = Math.max(25, acc.effX);
    S.sy = Math.max(18, acc.effY);
    S.fix = new C.FixationDetector({ dispersion: Math.max(60, Math.min(220, 2.2 * Math.max(acc.precisionX, acc.precisionY))) });
    S.euroX.reset(); S.euroY.reset();
  }

  // -------------------------------------------- click-based refinement
  // People look at what they click. Each click is a free calibration sample.
  document.addEventListener('pointerdown', (e) => {
    if (!opts.clickRefine || S.status !== 'tracking' || !S.model || !S.train || S.drifted) return;
    if (S.host && e.composedPath().includes(S.host)) return;
    const now = performance.now();
    const fresh = S.recent.filter((r) => now - r.t < 200);
    if (fresh.length < 2) return;
    for (const r of fresh) S.clicks.push({ f: r.f, x: e.clientX, y: e.clientY, g: 1000 + S.clicks.length });
    if (S.clicks.length > 300) S.clicks.splice(0, S.clicks.length - 300);
    clearTimeout(S.refitTimer);
    S.refitTimer = setTimeout(() => {
      const { X, Y, G } = S.train;
      const nf = Math.min(X[0].length, opts.featureCount);
      const cX = S.clicks.map((c) => c.f.slice(0, nf)), cY = S.clicks.map((c) => [c.x, c.y]), cG = S.clicks.map((c) => 'click');
      S.model = new C.Ridge().fit(X.map((r) => (r.length > nf ? r.slice(0, nf) : r)).concat(cX), Y.concat(cY), G.concat(cG), [S.model.lambda]);
    }, 400);
  }, true);

  // ----------------------------------------------------------- persistence
  function saveCalibration() {
    const round = (a) => a.map((v) => Math.round(v * 1e5) / 1e5);
    chrome.storage.local.set({
      grCalib: {
        t: Date.now(), model: S.model.toJSON(), accuracy: S.accuracy, head: S.calibHead, screen: S.calibScreen,
        train: { X: S.train.X.map(round), Y: S.train.Y, G: S.train.G },
      },
    });
  }
  async function restoreCalibration() {
    try {
      const { grCalib: c } = await chrome.storage.local.get('grCalib');
      if (!c || Date.now() - c.t > 3 * 3600e3) return false;
      const sc = c.screen;
      if (!sc || Math.abs(sc.w - innerWidth) > 8 || Math.abs(sc.h - innerHeight) > 8 || Math.abs(sc.sx - screenX) > 8 || Math.abs(sc.sy - screenY) > 8) return false;
      S.model = C.Ridge.fromJSON(c.model);
      S.accuracy = c.accuracy; S.calibHead = c.head; S.calibScreen = c.screen; S.train = c.train;
      applyAccuracy(c.accuracy);
      return true;
    } catch (e) { console.warn('[gaze] restore failed', e); return false; }
  }
  /** Reading pace belongs to the person, not the seating position, so it outlives the eye calibration. */
  async function restoreBaseline() {
    try {
      const { grBaseline: b } = await chrome.storage.local.get('grBaseline');
      if (!b || !(b.wpm > 0) || !(b.tau > 0) || Date.now() - b.t > BASELINE_MAX_AGE) return false;
      S.baseline = b;
      S.wpm = b.wpm;
      return true;
    } catch (e) { return false; }
  }

  // ---------------------------------------------------------- page events
  const invalidate = () => { S.layoutV++; S.blocksCache = null; };
  // Scrolling moves text under still eyes; that must not read as jumping back a line.
  addEventListener('scroll', () => { invalidate(); S.scrollT = performance.now(); S.scrollEpoch++; }, { passive: true, capture: true });
  addEventListener('resize', () => {
    invalidate();
    const sc = S.calibScreen;
    if (S.model && sc && (Math.abs(sc.w - innerWidth) > 8 || Math.abs(sc.h - innerHeight) > 8)) {
      S.needsRecal = true;
      toast('The window changed size, so gaze positions are off.', 0, [['Recalibrate', () => calibrate({ baseline: false }).catch(() => {})]]);
    }
  });

  addEventListener('keydown', (e) => {
    if (!opts.shortcuts || !e.altKey || !e.shiftKey) return;
    if (e.code === 'KeyG') { e.preventDefault(); setDebug(!opts.debug); }
    else if (e.code === 'KeyC') { e.preventDefault(); calibrate().catch(() => {}); }
    else if (e.code === 'KeyE') {
      e.preventDefault();
      requestEnable(S.status === 'idle' || S.status === 'error');
    }
  }, true);

  chrome.runtime.onMessage.addListener((m, _sender, send) => {
    if (!m || typeof m.type !== 'string' || !m.type.startsWith('gaze:')) return;
    if (m.type === 'gaze:enable') {
      if (opts.managed) requestEnable(!!m.value);
      else {
        chrome.storage.local.set({ grEnabled: !!m.value });
        if (m.value) { start().then(() => send(getState())); return true; }
        stop();
      }
    } else if (m.type === 'gaze:calibrate') calibrate().catch(() => {});
    else if (m.type === 'gaze:baseline') measureBaseline().catch(() => {});
    else if (m.type === 'gaze:debug') setDebug(!!m.value);
    send(getState());
  });

  function setDebug(v) { opts.debug = !!v; emit('status', getState()); }

  /** Where the eyes are right now: {element, lineIndex, lineRect, confidence} or null. */
  function getCurrentLine() {
    if (!S.cur || !S.cur.el.isConnected) return null;
    const r = getLines(S.cur.el)[S.cur.line];
    return { element: S.cur.el, lineIndex: S.cur.line, lineRect: r ? { ...r } : null, confidence: +S.cur.conf.toFixed(2) };
  }

  window.GazeReader = {
    init(o = {}) { Object.assign(opts, o); if (o.baselineWpm && !S.baseline) S.wpm = o.baselineWpm; return window.GazeReader; },
    start, stop, calibrate, measureBaseline, on, setDebug, getState, getCurrentLine,
    setRoot(node) { opts.root = node; invalidate(); },
    /** Multiplies the calibrated tau. 1 = as calibrated, above 1 = help later, below 1 = help sooner. */
    setSensitivity(mult) {
      const m = Number(mult);
      if (!Number.isFinite(m) || m <= 0 || m === opts.sensitivity) return;
      opts.sensitivity = m;
      emit('status', getState());
    },
    getTau: () => +tau().toFixed(2),
    /** Lab use: everything needed to refit or replay offline. Large. */
    debugDump() {
      return {
        state: getState(), accuracy: S.accuracy, model: S.model ? S.model.toJSON() : null, train: S.train,
        calibHead: S.calibHead, calibScreen: S.calibScreen, baseline: S.baseline, camera: S.camera || null, tau: +tau().toFixed(2),
        noise: { sx: S.sx, sy: S.sy, dispersion: S.fix.dispersion, drift: S.drift.y }, clicks: S.clicks.length,
      };
    },
    /** Show or hide the camera widget and toasts; tracking is unaffected. */
    setWidgetVisible(v) { opts.widget = !!v; applyWidget(); },
  };
  S.wpm = opts.baselineWpm;

  // Standalone use starts itself; inside Glider (managed) the host decides.
  if (window.top === window) {
    chrome.storage.local.get('grEnabled').then(({ grEnabled }) => { if (grEnabled && !opts.managed && location.protocol !== 'chrome-extension:') start(); });
  }
})();
