/*
 * gaze-reader.js — content script. Webcam eye tracking that notices when a
 * reader is struggling with a specific line and tells the rest of the extension.
 *
 * Pipeline:  camera iframe (MediaPipe) --features--> calibrated ridge model -->
 *            gaze (x,y) --> fixations --> paragraph + line (HMM line locking) -->
 *            struggle detector --> 'struggle' event (+ optional default adaptation)
 *
 * Public API (same isolated world as your other content scripts):
 *   GazeReader.init({ autoAdapt, debug, shortcuts, baselineWpm, root, trace, traceLog })
 *       trace: the heat trace of the gaze estimate (same as setTrace). traceLog: one '[gaze-trace]' console line per fixation.
 *   GazeReader.start()       -> Promise<state>   opens camera, loads model. It always settles: 'ready' or 'tracking',
 *       'needs-permission' (state.error.code camera-permission | camera-blocked), or 'error' (state.error:
 *       {code, short, text, detail}; codes camera-in-use, no-camera, camera-lost, model-load, model-timeout, camera-timeout, timeout).
 *       Calling it again after 'needs-permission' or 'error' starts afresh; after the camera is allowed on
 *       gaze/permission.html it does so by itself.
 *   GazeReader.calibrate()   -> Promise<accuracy>   dots, a five-dot check, then the reading-pace passage ({baseline:false} skips it)
 *       accuracy.validation is the check: {ok, grade:'good'|'fair'|'poor', message, errPx, errDeg, effX, effY, perDot, advice, health}
 *       (C.validationResult in gaze-core.js). The 'accuracy' event carries the same object.
 *   GazeReader.measureBaseline() -> Promise<baseline>   redo only the reading-pace passage
 *   GazeReader.setSensitivity(mult)   multiplies the calibrated tau (struggle threshold)
 *       'baseline' fires with {wpm, tau, cv, regressionRate, ...}; 'struggling' fires when the state flips.
 *   GazeReader.stop()
 *   GazeReader.on('struggle' | 'line' | 'accuracy' | 'status' | 'gaze' | 'fixation' | 'caldot' | 'camera', cb)  -> unsubscribe fn
 *       'caldot' fires once per calibration dot: {i, g, role, seg, x, y, tShow, tSampleStart, tSampleEnd, frames, settled}
 *       (seg 'dots' | 'reshow' | 'head', and 'check' for the five dots of the check after the fit).
 *       'camera' fires when the camera opens and when its figures change: {t, settings:{width, height, ...}, delegate:'GPU'|'CPU',
 *       fps, modelFps, warnings:['fps' | 'small' | 'offcentre']}; getState().camera is the same without t.
 *       Status values: idle, starting, needs-permission, ready, calibrating, baseline, tracking, paused, error.
 *       'paused': calibrated, but the window was resized or moved since, so the mapping no longer fits.
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
    screenDiagonalIn: 27,    // the screen's physical size (no browser reports it) and how far the reader sits from it:
    viewDistanceCm: 65,      // only used to put the error into degrees on the result card
    autoDump: true,          // TEMPORARY: a poor calibration result downloads glider-gaze-dump.json by itself
    trace: false,            // TEMPORARY: draw a heat trace of where the tracker thinks the eyes are (setTrace)
    shortcuts: true,
    baselineWpm: 150,
    root: null,
    settleMs: 750,           // after the dot starts moving: its 600 ms glide plus time for the eyes to land (the last 300 ms
                             // of it are frames collected and thrown away; see CalibrationRun in gaze-core.js)
    sampleMs: 700,
    headSegment: false,      // after the dots: six seconds of "watch the dot and turn your head a little", which is what lets a
                             // head-aware model be fitted and checked (false: dots only, as before)
    validate: true,          // after the fit: five more dots on new places, and the result card says what was measured on them
    labLandmarks: false,     // lab only: the camera frame also sends a small subset of the face landmarks with every 'raw' frame
    startTimeoutMs: 25000,   // a start that hears nothing from the camera frame for this long ends in 'error' (the frame itself gives
                             // up on the camera or the face model after 20 s, with a reason; this is for a frame that never answers)
    domEvents: false,       // also dispatch DOM CustomEvents (visible to the page; off by default)
    traceLog: false,        // log detector internals to the console, one '[gaze-trace]' line per fixation
    managed: false,         // the host extension decides when tracking runs (no self-start)
    onEnableRequest: null,  // managed mode: called with true/false when the user asks to turn tracking on/off
    sensitivity: 1,         // multiplies the calibrated tau: above 1 helps later, below 1 helps sooner
    baselineText: null,     // override the reading-pace passage
    featureCount: 17,       // model A's regression inputs: eye features + eye-look blendshapes. The raw head matrix and head
                            // position (25-43) barely vary in a keep-still calibration and wreck it after a small shift.
    model: 'A',   /* was 'auto'. On a real camera (five sessions) the head-frame models either failed their geometry check or won the shoot-out and then put every later dot 140 px low; 'auto' brings the shoot-out back. */          // which gaze model a calibration may end up with. 'auto': the head-frame models (B, C, E in
                            // gaze-core.js) are tried and one replaces A only if it beats A's leave-one-dot-out error
                            // by 5 %. 'A': the 25-input ridge, as before. 'B', 'C', 'E': that model whenever it can be fitted.
    markWholeBlock: false,  // mark the whole paragraph the reader is stuck in, not just the line
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

  const BLOCK_SEL = 'p,li,blockquote,dd,dt,figcaption,td,th,h1,h2,h3,h4,h5,h6,pre,[data-gr-block]';

  const S = {
    status: 'idle', host: null, root: null, iframe: null, port: null,
    model: null, accuracy: null, calibHead: null, calibScreen: null, train: null,
    latest: null, recent: [], calRun: null, calRaw: null, procedure: null, trainExtra: null, probe: null, geomT: 0, fps: 0,
    drifted: false, driftSince: 0, needsRecal: false,
    sx: 60, sy: 60, fix: new C.FixationDetector(), euroX: new C.OneEuro(), euroY: new C.OneEuro(), blinker: new C.BlinkDetector(),
    // The heat trace has its own, faster filter (1.5 Hz at rest against 0.6 Hz). After a jump of two words the smooth gaze is 73 % of
    // the way there at 100 ms and needs about 0.3 s to arrive; this one is at 93 % (tests/gaze-core.test.js). It shakes a little more at rest.
    traceX: new C.OneEuro(1.5, 0.01), traceY: new C.OneEuro(1.5, 0.01),
    error: null,             // why the last start did not get to 'ready': {code, short, text, detail}
    startTimer: 0, perf: null, quality: [], qualityT: 0, face: null, check: null, health: null, camera: null,
    gaze: null, lastFix: null, block: null, cur: null, prevBlockBottom: null,
    states: new WeakMap(), lineCache: new WeakMap(), blocksCache: null, layoutV: 0,
    heat: new Map(), wpm: 150, scrollT: -1e9, scrollEpoch: 0, prevFixEnd: 0, drift: { y: 0 }, highlights: [], clicks: [], refitTimer: 0,
    startPromise: null, raf: 0, hudPainted: false,
    frameT: -Infinity,       // capture time of the newest camera frame, on this page's clock
    delegate: null, timeSource: null,   // what the camera frame reports: 'GPU' | 'CPU', and where its frame times come from
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
  function setStatus(s) { if (S.status !== s) { S.status = s; emit('status', getState()); wake(); } }
  function getState() {
    return {
      status: S.status, calibrated: !!S.model, accuracy: S.accuracy, wpm: Math.round(S.wpm),
      fps: S.fps, drifted: S.drifted, needsRecalibration: S.needsRecal, debug: opts.debug,
      baseline: S.baseline ? { ...S.baseline } : null, tau: +tau().toFixed(2), struggling: !!S.struggling,
      error: S.error && (S.status === 'error' || S.status === 'needs-permission') ? { ...S.error } : null,
      camera: cameraStatus(),
    };
  }
  /** What the camera gives and what runs the face model: {width, height, delegate, fps, modelFps, warnings}; null before the camera opens. */
  function cameraStatus() {
    if (!S.camera && !S.delegate) return null;
    const c = S.camera || {};
    return { width: c.width || null, height: c.height || null, delegate: S.delegate || null, fps: S.fps || 0, modelFps: S.perf ? S.perf.modelFps : null, warnings: S.quality.map((w) => w.id) };
  }
  function emitCamera() { emit('camera', { t: performance.now(), settings: S.camera, ...cameraStatus() }); }

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
    /* The camera picture must stay on screen under the calibration, or Chrome stops delivering its frames: it sits
       on top of the calibration screen, all but invisible. */
    #cam:has(~ #calib.show) { z-index: 3; opacity: .02; pointer-events: none; transition: none; }
    #cdot { position: fixed; left: 0; top: 0; will-change: translate; width: 28px; height: 28px; margin: -14px 0 0 -14px; border-radius: 50%; background: #2f6b4a;
            box-shadow: 0 0 0 5px rgba(47, 107, 74, .18); transition: translate .35s cubic-bezier(.45, 0, .25, 1); display: none; } /* keep settleMs at least this glide + 400ms */
    #cdot::after { content: ''; position: absolute; left: 10px; top: 10px; width: 8px; height: 8px; border-radius: 50%; background: #fff; }
    #cdot.pulse { animation: shrink var(--dur, 1s) ease-out forwards; }
    @keyframes shrink { from { transform: scale(1.15); } to { transform: scale(.6); } }
    #cnote { position: fixed; left: 50%; top: 9%; transform: translateX(-50%); width: min(620px, calc(100vw - 32px)); text-align: center;
             color: #20352a; font-size: 21px; line-height: 1.5; font-weight: 700; display: none; cursor: default; }
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
    .card button.alt { background: transparent; color: #2f6b4a; box-shadow: inset 0 0 0 2px #2f6b4a; }
    .card button.alt:hover { background: #e0e8d9; }
    .card .advice { margin: 0 0 10px; padding: 9px 13px; border-radius: 14px; background: #e6ecdf; font-size: 16px; line-height: 1.5; }
    kbd { display: inline-block; padding: 1px 7px; border-radius: 7px; background: #e0e8d9; color: #20352a; font: inherit; font-size: 13px; font-weight: 700; }

    #bread { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(720px, 88vw); color: #20352a;
             cursor: default; display: none; }
    #bhint { font-size: 16px; line-height: 1.5; color: #566b5c; margin: 0 0 20px; }
    #btext { margin: 0; font-size: 24px; line-height: 60px; text-align: left; letter-spacing: .02em; word-spacing: .14em; }
    #bread button { margin-top: 26px; }

    /* While a card asks the reader to check their face, the camera box stays
       in view above the calibration screen. It is covered again once the dot
       starts, so it cannot pull the eyes away from the dot. */
    #cam:has(~ #calib.show > #instr:not([style*="display: none"]) .card.face) { z-index: 3; opacity: 1; pointer-events: auto; box-shadow: 0 0 0 3px #2f6b4a, 0 18px 40px -14px rgba(32, 53, 42, .34); }
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
    .hl { position: fixed; border-radius: 3px; background: rgba(47, 107, 74, .12); pointer-events: none;
          border-left: 4px solid #2f6b4a; transition: top .1s, left .1s, width .1s; }
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
      <div id="cam"><div id="bar"><span id="camlabel">Adaptive</span>
        <button id="bmin" title="Make the camera smaller" aria-label="Make the camera smaller">–</button><button id="bx" title="Turn Adaptive off" aria-label="Turn Adaptive off">×</button></div><div id="slot"></div></div>
      <div id="toast"></div>
      <div id="calib"><div id="cdot"></div><div id="cnote"></div><div id="instr"></div>
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
    wake();
  }
  const $ = (id) => S.root && S.root.getElementById(id);

  /** Hidden, not removed: the camera frame must stay rendered to keep delivering frames. */
  function applyWidget() {
    const cam = $('cam');
    if (!cam) return;
    cam.style.opacity = opts.widget ? '' : '0.02';   // not 0: a fully transparent camera picture is not drawn, and its frames stop
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
  /* What can stop a start, in the reader's words: `short` for the dock's status line and the camera
     widget, `text` for the toast. Anything else is a loading failure and is shown with its reason. */
  const PROBLEMS = {
    'camera-permission': { short: 'Allow the camera to begin', text: 'Eye tracking needs one-time camera access.' },
    'camera-blocked': { short: 'The camera is blocked for Glider', text: 'The camera is blocked for Glider. Press Allow camera, then allow it from the camera icon in the address bar.' },
    'camera-in-use': { short: 'The camera is in use by another app', text: 'The camera is being used by another app. Close it (a video call, the Camera app), then press Retry.' },
    'no-camera': { short: 'No camera found', text: 'No camera was found. Plug one in or switch it on, then press Retry.' },
    'camera-lost': { short: 'The camera stopped', text: 'The camera stopped (unplugged, or taken by another app). Check it, then press Retry.' },
  };
  function problem(code, detail) {
    const p = PROBLEMS[code];
    if (p) return { code, detail: detail || '', ...p };
    const why = detail || 'no reason given';
    return { code: code || 'error', detail: why, short: 'Eye tracking could not load', text: `Eye tracking could not load (${why}).` };
  }
  const setLabel = (text) => { const el = $('camlabel'); if (el && el.textContent !== text) el.textContent = text; };

  function start() {
    // 'needs-permission' and 'error' are where a start ended, not a start in progress: asking again starts again.
    if (S.startPromise && !['idle', 'error', 'needs-permission'].includes(S.status)) return S.startPromise;
    ensureUI();
    dropFrame();
    if (S.error) hideToast();
    S.blinker.reset();
    Object.assign(S, { error: null, perf: null, quality: [], qualityT: 0, face: null, camera: null, delegate: null, fps: 0, blockedRequests: 0 });
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
        if (S.iframe !== ifr) return;   // stopped or started again before this frame loaded
        const ch = new MessageChannel();
        const port = S.port = ch.port1;
        port.onmessage = (e) => { if (S.port === port) onFrameMessage(e.data); };   // a frame that was replaced has nothing more to say
        ifr.contentWindow.postMessage({ type: 'gr-init', nonce, labLandmarks: !!opts.labLandmarks }, new URL(chrome.runtime.getURL('')).origin, [ch.port2]);
      }, { once: true });
    });
    armStartTimer();
    return S.startPromise;
  }
  /** Let go of the camera frame's port (the frame is told to stop first). */
  function dropFrame() {
    clearTimeout(S.startTimer); S.startTimer = 0;
    try { if (S.port) { S.port.postMessage({ type: 'stop' }); S.port.close(); } } catch (_) { /* frame gone */ }
    S.port = null;
  }
  /* A start may not hang on 'starting'. The camera frame reports each stage ('opening camera', 'loading
     face model') and times its own stages out with a reason; every report restarts this clock, which is
     only for a frame that says nothing. */
  function armStartTimer() {
    clearTimeout(S.startTimer);
    S.startTimer = setTimeout(() => {
      if (S.status !== 'starting') return;
      const slot = $('slot'); if (slot) slot.replaceChildren();   // a frame that does not answer may still hold the camera
      S.iframe = null;
      fail('timeout', `no answer in ${Math.round(opts.startTimeoutMs / 1000)} seconds`);
    }, opts.startTimeoutMs);
  }
  /** The start ended without a camera or without the face model: say which, and offer to try again. */
  function fail(code, detail) {
    dropFrame();
    S.error = problem(code, detail);
    setLabel(S.error.short);
    setStatus('error');
    toast(S.error.text, 0, [['Retry', () => { start(); }]]);
    S.resolveStart && S.resolveStart(getState());
  }
  /** gaze/permission.html says the camera has been allowed: start again, without a reload or a second flip of the switch. */
  function onCameraGranted() {
    if (S.status !== 'needs-permission') return;
    hideToast();
    start();
  }
  try {
    chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.grCameraGranted && changes.grCameraGranted.newValue) onCameraGranted(); });
  } catch (_) { /* a page without storage events (the test harness) */ }

  function stop() {
    dropFrame();
    S.error = null; S.check = null;
    cancelAnimationFrame(S.raf); S.raf = 0; S.hudPainted = false;
    if (S.host) S.host.remove();
    for (const el of S.assisted) el.classList.remove('gr-assist');
    S.assisted.clear();
    const pageStyle = document.getElementById('gr-page-style');
    if (pageStyle) pageStyle.remove();
    const was = S.struggling;
    Object.assign(S, { host: null, root: null, iframe: null, port: null, highlights: [], startPromise: null, calRun: null, probe: null, bl: null, struggling: null, block: null, cur: null });
    if (was) emit('struggling', { struggling: false, reason: was.reason, element: was.el, ratio: 0, tau: +tau().toFixed(2) });
    setStatus('idle');
    // Whoever is still waiting for a start that was stopped gets an answer (a second resolve of a settled promise does nothing).
    if (S.resolveStart) { S.resolveStart(getState()); S.resolveStart = null; }
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
      setLabel(d.detail || d.state);
      if (d.state === 'loading') {
        if (S.status === 'starting') armStartTimer();   // the frame is alive and has reached its next stage
      } else if (d.state === 'needs-permission') {
        clearTimeout(S.startTimer);
        // Not allowed yet, or blocked: two different things to tell the reader, one way out (the permission page).
        S.error = problem(d.code === 'camera-blocked' ? 'camera-blocked' : 'camera-permission', d.detail);
        setLabel(S.error.short);
        setStatus('needs-permission');
        toast(S.error.text, 0, [['Allow camera', openPermissionPage]]);
        S.resolveStart && S.resolveStart(getState());
      } else if (d.state === 'error') {
        fail(d.code, d.detail);
      } else if (d.state === 'ready') {
        clearTimeout(S.startTimer);
        const port = S.port;
        await restoreBaseline();
        const restored = await restoreCalibration();
        if (S.port !== port) return;   // stopped (or started again) while the saved calibration was being checked
        if (restored === true) {
          setStatus('tracking');
          if (S.baseline) toast('Eye tracking on (saved calibration).', 3500, [['Recalibrate', calibrate]]);
          else toast('Eye tracking on. A short reading check lets it learn your pace.', 0, [['Measure my pace', () => measureBaseline().catch(() => {})]]);
        } else {
          setStatus('ready');
          toast(restored === 'moved' ? 'Eye tracking is ready. You are not sitting where you last calibrated, so it needs a new calibration.'
            : 'Eye tracking is ready. A one-minute calibration makes it accurate.', 0, [['Calibrate', () => calibrate().catch(() => {})]]);
        }
        S.resolveStart && S.resolveStart(getState());
      }
      return;
    }
    if (d.type === 'camera') {
      S.camera = d.settings || null;
      emitCamera();
      const c = S.camera;
      if (c && c.width && c.height && (c.width < 1280 || c.height < 720)) toast('Your camera is only giving ' + c.width + ' by ' + c.height + '. Eye tracking will be rough at that size.', 8000);
      return;
    }
    if (d.type === 'perf') {
      // Which delegate the face model ended up on (the frame tries the CPU once when the GPU is slow) and how fast it runs.
      S.perf = { delegate: d.delegate, modelFps: d.modelFps, tried: d.tried || [], blocked: d.blocked || 0 };
      if (d.delegate) S.delegate = d.delegate;
      emitCamera();
      return;
    }
    // The camera frame refused a network call (MediaPipe's usage logger; see frame.js). Kept for debugDump().
    if (d.type === 'blocked') { S.blockedRequests = d.n; return; }
    if (d.type !== 'f') return;
    S.fps = d.fps;
    const t = frameTime(d);
    if (d.delegate) S.delegate = d.delegate;
    // Quality gate: where the face is in the picture and how big (smoothed), looked at every two seconds.
    if (d.face && d.head) {
      const w = d.fw > 0 ? d.fw : C.faceWidthFromEyes(d.head.s), a = S.face ? 0.1 : 1, F = S.face || (S.face = { cx: 0, cy: 0, w: 0 });
      F.cx += a * (d.head.cx - F.cx); F.cy += a * (d.head.cy - F.cy); F.w += a * (w - F.w);
    }
    if (t - S.qualityT > 2000) { S.qualityT = t; checkQuality(); }
    // Blinks: the camera frame sends its fixed verdict (d.blink) and the lid numbers behind it. With the numbers,
    // C.BlinkDetector decides instead: it does not take a look down the page for a blink. (An older frame script
    // or a test camera sends no lids; its own flag is used then.)
    if (d.face && d.lids) d = { ...d, blink: S.blinker.push(d.lids, t), blinkFlag: !!d.blink };
    // The five-dot check keeps the verdict live tracking uses (after the detector, not the frame's fixed rule):
    // what it measures is the tracker as it runs while reading.
    if (S.check) S.check.push({ t, face: !!d.face, blink: !!d.blink, f: d.face ? d.f : undefined });
    // Every camera frame, blinks and lost faces included (same clock as 'gaze').
    if (listeners.frame && listeners.frame.length) emit('frame', { t, face: !!d.face, blink: !!d.blink, head: d.head || null });
    // Lab use: the raw feature vector of every frame, before any model.
    if (listeners.raw && listeners.raw.length) emit('raw', { t, face: !!d.face, blink: !!d.blink, f: d.face ? d.f : undefined, head: d.head || null, fps: d.fps, lids: d.lids || null, lmk: d.lmk });
    // The calibration sees every frame of its dots, lost faces and blinks included (it sorts them out itself).
    if (S.calRun) S.calRun.push(d, t);
    if (S.model && t - S.geomT > 1000) { S.geomT = t; checkGeometry(); }
    if (!d.face) { S.latest = { face: false, t }; return; }
    S.latest = { ...d, t };
    if (S.probe && S.probe.length < 90) S.probe.push({ face: true, blink: !!d.blink, f: d.f, head: d.head });
    // (click refinement asks for frames that arrived in the last 200 ms, so these keep the arrival time)
    if (!d.blink) { S.recent.push({ f: d.f, t: performance.now() }); if (S.recent.length > 6) S.recent.shift(); }
    if ((S.status === 'tracking' || (S.status === 'baseline' && S.bl)) && S.model && !document.hidden) processFrame(d, t);
  }

  /* The live quality gate (C.cameraQuality): under 20 pictures a second, a small face, a face near the
     edge of the picture. The camera widget's label says so, the 'camera' event and getState().camera
     list the warnings, and the calibration's first card repeats them in full. Nothing pops up over the
     text somebody is reading. */
  function checkQuality() {
    if (!['ready', 'tracking', 'paused', 'calibrating', 'baseline'].includes(S.status)) return;
    const F = S.face;
    let q = C.cameraQuality({ fps: S.fps, faceW: F ? F.w : 0, cx: F ? F.cx : NaN, cy: F ? F.cy : NaN });
    // A slow second (the face model warming up, a busy moment) is not a slow camera: the frame rate has to stay low over two looks.
    S.lowFps = q.some((w) => w.id === 'fps') ? (S.lowFps || 0) + 1 : 0;
    if (S.lowFps < 2) q = q.filter((w) => w.id !== 'fps');
    const changed = q.map((w) => w.id).join() !== S.quality.map((w) => w.id).join();
    S.quality = q;
    if (!changed) return;
    setLabel(q.length ? q[0].short : 'tracking');
    emitCamera();
  }

  /* When the camera took this frame, on this page's clock. The camera frame has its own clock, so it
     sends the frame's age (send time minus capture time, both on its clock) and the age is taken off
     the time of arrival. A frame without those fields (an older frame script, a test camera) counts
     as taken now. Times never run backwards, whatever the camera reports. */
  function frameTime(d) {
    const now = performance.now();
    let t = now;
    const age = d.ts - d.tc;
    if (Number.isFinite(age)) { t = now - Math.min(500, Math.max(0, age)); S.timeSource = d.tsrc || 'frame'; }
    if (t <= S.frameT) t = S.frameT + 0.01;
    S.frameT = t;
    return t;
  }

  // ------------------------------------------------------------- tracking
  function processFrame(d, t) {
    if (S.calibHead) {
      // Inside the gate a head-frame model compensates; outside it (or, for model A, after any real movement) tracking pauses.
      const moved = C.headMoved(d.head, S.calibHead, d.f, S.model.kind);
      if (moved) {
        if (!S.driftSince) S.driftSince = t;
        if (!S.drifted && t - S.driftSince > 600) {
          S.drifted = true;
          if (!S.bl) toast('Move back to where you sat during calibration. Tracking is paused.', 0, [['Recalibrate here', () => calibrate().catch(() => {})]]);
          emit('status', getState());
        }
      } else {
        S.driftSince = 0;
        // Back in place: the filters must not glide in from where the eyes were before the pause.
        if (S.drifted) { S.drifted = false; hideToast(); S.fix.reset(); resetFilters(); emit('status', getState()); }
      }
    }
    if (S.drifted || d.blink) return;
    const [x, y] = S.model.predict(d.f);
    S.gaze = { x: S.euroX.filter(x, t), y: S.euroY.filter(y, t), rawX: x, rawY: y, t };
    // The heat trace: the raw estimate through the faster filter, less the vertical offset the line
    // decoder has learned (S.drift.y, which it takes off before it picks a line), so the heat sits
    // where the tracker really has the eyes, and without the smooth gaze's lag.
    if (opts.trace) traceAdd(S.traceX.filter(x, t), S.traceY.filter(y, t) - S.drift.y);
    emit('gaze', S.gaze);
    const fix = S.fix.push(t, x, y);
    if (fix) onFixation(fix);
  }

  function resetFilters() { S.euroX.reset(); S.euroY.reset(); S.traceX.reset(); S.traceY.reset(); }
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

  /* Whether a fixation belongs to a paragraph. The sideways estimate is the weak one (measured 100 to 200 px
     off at line starts), so a fixation level with the paragraph but beside it still counts, up to 0.3 of the
     paragraph's width and at most BLOCK_SIDE_MAX px. pickBlock only uses this for the nearest block. */
  const BLOCK_SIDE_SX = 3.5, BLOCK_SIDE_WIDTH = 0.3, BLOCK_SIDE_MAX = 300;
  function stays(r, x, y) {
    if (normDist(r, x, y) < 1.2) return true;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    return dy / S.sy < 1.2 && dx <= Math.max(BLOCK_SIDE_SX * S.sx, Math.min(BLOCK_SIDE_MAX, BLOCK_SIDE_WIDTH * (r.right - r.left)));
  }

  function pickBlock(x, y) {
    const blocks = getBlocks();
    let best = null, bestR = null, bd = Infinity;
    for (const b of blocks) { const dd = normDist(b.r, x, y); if (dd < bd) { bd = dd; best = b.el; bestR = b.r; } }
    if (S.block) {   // hysteresis: don't hop paragraphs on one noisy fixation
      const cur = blocks.find((b) => b.el === S.block);
      if (cur && stays(cur.r, x, y) && normDist(cur.r, x, y) <= bd + 0.8) return S.block;
    }
    return bd <= 2 || (bestR && stays(bestR, x, y)) ? best : null;
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
      lastLine: -1, maxLine: -1, backtracks: [], triggers: 0, prog: -1, progAt: 0,
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

  const BLOCK_RESUME_MS = 3000;
  function enterBlock(el, t) {
    S.block = el;
    if (!el) return;
    const st = blockState(el);
    if (t - st.leftAt > 5000) resetCounters(st, st.nLines);
    // A brief step outside the paragraph and straight back (a fixation estimated past its edge) is still the
    // same reading: the line tracker keeps its place. It starts afresh after a real absence or another block.
    const resumed = el === S.lastReadEl && t - st.leftAt < BLOCK_RESUME_MS;
    S.lastReadEl = el;
    if (resumed) return;
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
    if (st.epoch !== S.scrollEpoch) { st.epoch = S.scrollEpoch; st.hmm.reset(); st.lastLine = -1; st.pend = null; }
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
    // The decoder names a new line at the first fixation after a sweep and is only sure of it a few
    // fixations later (conf goes over 0.55). Until then the time is credited to the line it names but
    // nothing else is concluded; when it settles, that time moves to the line it settled on.
    const settled = r.conf > 0.55 || st.lastLine < 0;
    const pend = st.pend || null;
    if (pend && pend.line !== L) { st.lineDwell[pend.line] = Math.max(0, st.lineDwell[pend.line] - pend.ms); st.lineDwell[L] += pend.ms; }
    if (L === st.lastLine) { st.runMs += dwell + (pend ? pend.ms : 0); st.pend = null; }
    else if (!settled) st.pend = { line: L, ms: (pend ? pend.ms : 0) + dwell };
    else {
      const held = pend ? pend.ms : 0;
      st.pend = null;
      if (st.lastLine >= 0 && L < st.lastLine && L <= st.maxLine && r.conf > 0.55) st.backtracks.push(fix.t);
      // Coming back to a line after really reading another one starts a fresh pass:
      // re-reading must not add up to "stuck". A one-fixation decode flicker (short
      // run elsewhere) keeps the running total, so a true stall still accumulates.
      if (st.visits[L] > 0 && st.runMs >= 500 && r.conf > 0.55) st.lineDwell[L] = dwell + held;
      st.visits[L]++;
      st.runMs = dwell + held;
      st.lastLine = L;
    }
    if (settled || L === st.lastLine) st.maxLine = Math.max(st.maxLine, L);
    // Smoothed position in the paragraph: single decoded lines are noisy, their running mean much less so.
    st.prog = st.prog < 0 ? L : st.prog + 0.15 * (L - st.prog);
    if (listeners.progress && listeners.progress.length && fix.t - st.progAt >= 1000) {
      st.progAt = fix.t;
      const e = expectedMs(st, lines, -1);
      const pitch = lines.length > 1 ? (lines[lines.length - 1].top - lines[0].top) / (lines.length - 1) : lines[0].bottom - lines[0].top;
      emit('progress', {
        element: el, t: fix.t, paragraphDwellMs: Math.round(st.totalDwell), expectedParagraphMs: Math.round(e.para),
        progress: +((st.prog + 1) / lines.length).toFixed(3), lineCount: lines.length, coarse: S.sy > 0.6 * pitch,
        baselineWpm: S.baseline ? Math.round(S.baseline.wpm) : null, readerWpm: Math.round(S.wpm), tau: +tau().toFixed(2),
      });
    }
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
    if (next) wake();   // the render loop ends a struggle nothing has confirmed for a while
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
    if (opts.traceLog) console.log('[gaze-trace]', JSON.stringify({ line: L, onLine: Math.round(onLine), expLine: Math.round(exp.line), total: Math.round(st.totalDwell), expPara: Math.round(exp.para), back: st.backtracks.length, words: st.words, n: lines.length, tau: +T.toFixed(2), ratio: +d.ratio.toFixed(2) }));
    // How fine can we trust the tracker on this text? When its vertical error is large
    // next to the line spacing, a single line is a guess: fall back to the paragraph's
    // total time, which does not depend on getting the line right.
    const pitch = lines.length > 1 ? (lines[lines.length - 1].top - lines[0].top) / (lines.length - 1) : lines[0].bottom - lines[0].top;
    const coarse = S.sy > 0.6 * pitch;
    let reason = d.reason, severity = d.severity;
    if (coarse) {
      // Up to three signs per visit, each needing clearly more time than the one before.
      const slow = st.triggers < 3 && st.totalDwell > Math.max(4000, T * exp.para * (1 + 0.4 * st.triggers));
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
        setStatus(S.needsRecal ? 'paused' : 'tracking');
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
    const whole = !!opts.markWholeBlock;
    read.textContent = whole || d.coarse ? 'Read this part aloud' : 'Read line aloud';
    read.onclick = () => {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance((whole ? d.paragraphText : d.lineText) || d.paragraphText);
      u.rate = 0.9;
      const pick = globalThis.Glider && globalThis.Glider.pickVoice;
      const voice = typeof pick === 'function' ? pick('en-US') : null;
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      speechSynthesis.speak(u);
    };
    pill.appendChild(read);
    // In managed mode the host extension owns every change to the page's text.
    if (d.reason !== 'stuck-line' && !opts.managed) { d.element.classList.add('gr-assist'); S.assisted.add(d.element); }
    $('hlayer').append(hl, pill);
    S.highlights.push({ el: d.element, idx: d.lineIndex, span: whole ? 999 : d.lineSpan || 0, until: performance.now() + 7000, hl, pill });
    wake();
  }

  // --------------------------------------------------------- render loop
  /* The loop runs only while it has work: a highlight to keep on its line, a struggling state to time
     out, or the debug overlay / heat trace to paint. With none of those it wipes the canvas once and
     stops; wake() starts it again. */
  const hudShown = () => (opts.debug || opts.trace) && S.status !== 'calibrating';
  // (the overlay is not painted during a calibration, so it does not keep the loop going then; setStatus wakes it afterwards)
  const loopNeeded = () => !!S.root && (hudShown() || S.highlights.length > 0 || !!S.struggling);
  function wake() { if (!S.raf && loopNeeded()) loop(); }
  function loop() {
    cancelAnimationFrame(S.raf);
    const frame = () => {
      S.raf = 0;
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
      if (hudShown()) drawHud();
      else if (S.hudPainted) clearHud();
      if (loopNeeded()) S.raf = requestAnimationFrame(frame);
    };
    S.raf = requestAnimationFrame(frame);
  }

  function clearHud() {
    const cv = $('hud');
    if (cv) { const g = cv.getContext('2d'); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height); }
    S.hudPainted = false;
  }

  function drawHud() {
    const cv = $('hud');
    const dpr = devicePixelRatio || 1;
    // Canvas sizes are whole numbers: compare rounded, or a fractional devicePixelRatio (1.25, 1.5)
    // never matches and the canvas is reallocated on every frame.
    const pw = Math.round(innerWidth * dpr), ph = Math.round(innerHeight * dpr);
    if (cv.width !== pw || cv.height !== ph) {
      cv.width = pw; cv.height = ph;
      cv.style.width = innerWidth + 'px'; cv.style.height = innerHeight + 'px';
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, innerWidth, innerHeight);
    S.hudPainted = true;
    if (opts.trace && S.status !== 'calibrating') traceDraw(g);
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

  /** Waits for a button with data-act on the card: resolves with its data-act. Space or Enter is the first button, Esc is 'esc'. */
  /** TEMPORARY: download the last calibration as it happened (feature numbers per camera frame, never pictures) plus the screen's figures. */
  function saveDump() {
    try {
      const d = window.GazeReader.debugDump();
      d.screen = { w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight, dpr: devicePixelRatio, innerW: innerWidth, innerH: innerHeight, outerW: outerWidth, outerH: outerHeight, screenX, screenY };
      d.calFail = S.calFail || null;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(d)], { type: 'application/json' }));
      a.download = 'glider-gaze-dump.json';
      (S.root || document.body).appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) { console.warn('[gaze] could not save the diagnostics', e); }
  }
  /** What the head-drift correction (model D) needs: CSS px per cm of screen, the viewing distance, the camera picture's shape. */
  function driftScale() {
    const pxPerCm = Math.hypot(screen.width, screen.height) / (Number(opts.screenDiagonalIn) * 2.54);
    const cam = S.camera || {}, aspect = cam.width > 0 && cam.height > 0 ? cam.height / cam.width : 0.5625;
    return Number.isFinite(pxPerCm) && pxPerCm > 0 ? { pxPerCm, distCm: 0.8 * (Number(opts.viewDistanceCm) || 65), aspect, gy: 0 } : null;   // sideways only, and the head turns about the neck, not the eyes: on the real recordings these did best
  }
  /** CSS px per degree of gaze at the middle of the screen, from the screen's size in px, its diagonal in inches and the viewing distance. */
  function pxPerDegree() {
    const diagPx = Math.hypot(screen.width, screen.height), cmPerPx = (Number(opts.screenDiagonalIn) * 2.54) / diagPx;
    const v = (Number(opts.viewDistanceCm) * Math.tan(Math.PI / 180)) / cmPerPx;
    return Number.isFinite(v) && v > 0 ? Math.round(v * 10) / 10 : undefined;
  }
  function waitForChoice(calibEl) {
    return new Promise((resolve) => {
      const btns = [...calibEl.querySelectorAll('button[data-act]')];
      const onKey = (e) => {
        if (e.repeat) { if (e.code === 'Space') e.preventDefault(); return; }
        if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); e.stopPropagation(); done(btns[0] ? btns[0].dataset.act : 'go'); }
        else if (e.code === 'Escape') done('esc');
      };
      const done = (v) => { window.removeEventListener('keydown', onKey, true); resolve(v); };
      window.addEventListener('keydown', onKey, true);
      for (const b of btns) b.onclick = () => done(b.dataset.act);
    });
  }
  /** " Camera: 1280 by 720, 30 pictures a second, GPU." for the first calibration card; empty before the camera has reported. */
  function cameraLine() {
    const c = cameraStatus();
    if (!c || !c.width) return '';
    return ` Camera: ${c.width} by ${c.height}${c.fps ? `, ${c.fps} pictures a second` : ''}${c.delegate ? ', ' + c.delegate : ''}.`;
  }

  /* The check after the fit: a dot on each of C.CHECK_POINTS (places no calibration dot used), about
     0.9 s for the eyes to arrive and 1.2 s that count. Every frame of those 1.2 s goes through the
     model in use, exactly as it will while reading; C.validationResult turns the outputs into the
     result (it leaves out the frames before the eyes arrive at a dot: the windows here are fixed,
     they do not wait for the eyes as the calibration does). Esc skips the rest of the check (the
     calibration is kept).
     @returns {{dots:[{x, y, preds}], reason?}} */
  async function runCheck(dot, cal, cancelled) {
    const settle = Math.max(200, 0.9 * opts.settleMs), sample = Math.max(300, 1.2 * opts.sampleMs), n = C.CHECK_POINTS.length, dots = [];
    dot.style.transition = ''; dot.style.display = 'block';
    try {
      for (let k = 0; k < n && !cancelled(); k++) {
        const x = Math.round(C.CHECK_POINTS[k][0] * innerWidth), y = Math.round(C.CHECK_POINTS[k][1] * innerHeight);
        cal.style.setProperty('--done', (k / n).toFixed(3));
        dot.classList.remove('pulse');
        dot.style.translate = x + 'px ' + y + 'px'; dot.dataset.x = x; dot.dataset.y = y;
        const tShow = performance.now();
        S.check = [];
        await sleep(settle);
        const tStart = performance.now();
        dot.style.setProperty('--dur', sample + 'ms'); void dot.offsetWidth; dot.classList.add('pulse');
        await sleep(sample);
        const tEnd = performance.now(), frames = S.check || [];
        S.check = null;
        if (cancelled()) break;
        const preds = frames.filter((fr) => fr.face && !fr.blink && fr.f && fr.t >= tStart && fr.t <= tEnd).map((fr) => S.model.predict(fr.f));
        dots.push({ x, y, preds });
        emit('caldot', { i: 1000 + k, g: 300 + k, role: 'check', seg: 'check', x, y, tShow, tSampleStart: tStart, tSampleEnd: tEnd, frames: preds.length, settled: true });
      }
    } finally {
      S.check = null;
      dot.classList.remove('pulse'); dot.style.display = 'none';
    }
    return cancelled() ? { dots, reason: 'the check was skipped' } : { dots };
  }

  let calibrating = null;
  async function calibrate(o) {
    if (calibrating) return calibrating;
    const withBaseline = !(o && o.baseline === false);
    calibrating = (async () => {
      if (S.status === 'idle' || S.status === 'error') await start();
      if (!['ready', 'tracking', 'paused'].includes(S.status)) throw new Error('camera not ready: ' + S.status);
      hideToast();
      const prevStatus = S.status;
      setStatus('calibrating');
      const cal = $('calib'), dot = $('cdot'), instr = $('instr'), cnote = $('cnote');
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
          <li>Keep your head still and follow the green dot with your <b>eyes</b>. It moves to a new spot, then shrinks.</li>
          ${opts.headSegment ? '<li>Near the end the screen asks you to turn your head a little while you keep watching the dot.</li>' : ''}</ol>
          ${S.quality.map((w) => `<p class="advice">${w.text}</p>`).join('')}
          <small>This takes about ${opts.validate ? 'a minute' : (opts.headSegment ? 45 : 40) + ' seconds'}${withBaseline ? '. After that there is one short passage to read' : ''}.${cameraLine()}</small>
          <div class="go"><button>Start</button> <span class="quiet"><kbd>Space</kbd> to start, <kbd>Esc</kbd> to cancel</span></div></div>`;
        await waitForStart(instr);
        let acc, skipped = false;
        // One round: the dots, the fit, the five-dot check and its card. "Recalibrate" on the card starts another round.
        for (;;) {
        escaped = false;
        while (!(S.latest && S.latest.face)) {
          instr.style.display = 'block';
          instr.innerHTML = '<div class="card face"><h3>Looking for your face</h3><p>Move until your whole face shows in the camera box. A brighter room helps.</p><small>The dot starts as soon as your face is found. <kbd>Esc</kbd> to cancel.</small></div>';
          await sleep(300);
          if (escaped) throw new Error('cancelled');
        }
        instr.style.display = 'none';
        dot.style.display = 'block';

        // The procedure itself (which dot, when its frames count, which dots come again, the head
        // segment) is C.CalibrationRun, shared with tests/bench; this loop only moves the dot.
        const run = new C.CalibrationRun({
          viewport: { w: innerWidth, h: innerHeight }, settleMs: opts.settleMs, sampleMs: opts.sampleMs, head: !!opts.headSegment, headPause: true,
          fit: { featureCount: opts.featureCount, model: opts.model, drift: driftScale(), fold: true, score: 'val' },   // all 18 dots go into the model in use; the figure is a 13-dot fit on the other 5
        });
        S.calRun = run;
        let stepId = -1, pulsing = false;
        for (;;) {
          if (escaped) throw new Error('cancelled');
          if (S.status === 'error') throw new Error('cancelled');   // the camera stopped under the dots: its message and Retry are already on screen
          const v = run.update(performance.now());
          for (const e of run.events.splice(0)) emit('caldot', e);
          if (v.done) break;
          if (v.wait) {
            // Before the head segment the run waits (headPause). The instruction is read on a card, at the
            // reader's own speed, with no dot on screen and nothing being measured: text shown next to a dot
            // that is already being sampled is read with the eyes that should be on the dot. Space or the
            // button goes on; Esc cancels the calibration, as on the first card.
            dot.classList.remove('pulse'); dot.style.display = 'none'; pulsing = false;
            instr.style.display = 'block';
            instr.innerHTML = `<div class="card"><h3>One more step: a small head turn</h3>
              <p>The dot comes back for six seconds. Keep your <b>eyes on the dot</b> and slowly turn your head a little: left, right, up, down.</p>
              <small>Take your time. Nothing is measured until you go on.</small>
              <div class="go"><button>Go on</button> <span class="quiet"><kbd>Space</kbd> to go on, <kbd>Esc</kbd> to cancel</span></div></div>`;
            await waitForStart(instr);
            instr.style.display = 'none';
            dot.style.display = 'block';
            run.resume(performance.now());
            continue;
          }
          if (v.stepId !== stepId) {
            stepId = v.stepId; pulsing = false;
            // Progress, 0..1, for a quiet indicator styled in CSS.
            cal.style.setProperty('--done', v.progress.toFixed(3));
            dot.classList.remove('pulse');
            dot.style.transition = v.glide ? '' : 'none';
            cnote.textContent = v.text || ''; cnote.style.display = v.text ? 'block' : 'none';
          }
          if (dot.dataset.x !== String(v.x) || dot.dataset.y !== String(v.y)) { dot.style.translate = v.x + 'px ' + v.y + 'px'; dot.dataset.x = v.x; dot.dataset.y = v.y; }
          if (v.sampling !== pulsing) {
            pulsing = v.sampling;
            dot.classList.remove('pulse');
            if (pulsing) { dot.style.setProperty('--dur', v.sampleMs + 'ms'); void dot.offsetWidth; dot.classList.add('pulse'); }
          }
          await sleep(16);
        }
        S.calRun = null;
        dot.style.display = 'none'; cnote.style.display = 'none';
        // The maths (two-pass fit, trimming, the shoot-out, accuracy on the dots that were held out) is C.fitCalibration.
        const fit = run.result();
        acc = fit.accuracy;
        // A camera picture that does not change with the eyes (a photo, a frozen camera) gives a model without numbers: say so, do not track on it.
        const first = run.points.find((p) => p.samples.length);
        if (![acc.effX, acc.effY, acc.precisionX, acc.precisionY].every(Number.isFinite) || !first || !fit.model.predict(first.samples[0].f).every(Number.isFinite)) throw new Error('the camera picture did not change with your eyes');

        S.model = fit.model;
        S.accuracy = acc;
        S.train = fit.train;
        S.trainExtra = fit.extra;
        S.procedure = fit.procedure;
        S.calRaw = run.raw;
        S.shootout = fit.shootout;
        S.clicks = [];
        S.calibHead = fit.calibHead;
        S.calibScreen = { w: innerWidth, h: innerHeight, sx: screenX, sy: screenY };
        applyAccuracy(acc);
        S.drift.y = 0; S.drifted = false; S.needsRecal = false;

        // The check: five dots on places no dot used before, the model in use run on them as it will run while
        // reading. The card says what was measured there; the calibration's own figure is only the fallback.
        const checked = opts.validate ? await runCheck(dot, cal, () => escaped) : { dots: [], reason: 'the check is switched off' };
        const health = { ...C.calibrationHealth(run.raw), faceW: S.face ? +S.face.w.toFixed(3) : 0 };
        const val = C.validationResult(checked.dots, { fallback: acc, reason: checked.reason, pxPerDeg: pxPerDegree() });
        val.advice = val.grade === 'poor' ? C.trackingAdvice(health) : [];
        val.health = Object.fromEntries(Object.entries(health).map(([k, v]) => [k, typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null]));
        acc.validation = val;
        S.health = val.health;
        saveCalibration();

        instr.style.display = 'block';
        const go = withBaseline ? 'Continue' : 'Start reading';
        const figures = val.ok
          ? `Checked on ${val.dots} new dots: typical error about ${val.errPx} px, approximately ${val.errDeg} degrees (approximate: it assumes a ${opts.screenDiagonalIn}-inch screen at about ${opts.viewDistanceCm} cm). For one look at a word: ±${val.effX} px across, ±${val.effY} px up and down.`
          : val.source === 'calibration' ? `The check could not be measured (${val.reason}). From the calibration's own dots: about ${val.errPx} px, approximately ${val.errDeg} degrees (approximate).`
            : `The check could not be measured (${val.reason}).`;
        // Poor: the way on is to calibrate again, knowing what to change. "Use anyway" keeps what there is.
        const buttons = val.grade === 'poor' ? '<button data-act="recal">Recalibrate</button><button class="alt" data-act="go">Use anyway</button>'
          : `<button data-act="go">${go}</button>${val.grade === 'fair' ? '<button class="alt" data-act="recal">Recalibrate</button>' : ''} <span class="quiet">or press <kbd>Space</kbd></span>`;
        instr.innerHTML = `<div class="card"><h3>Calibration done</h3>
          <div class="big">${val.title}</div>
          <div class="meter" data-level="${val.level}" aria-hidden="true"><i></i><i></i><i></i></div>
          <p>${val.text.charAt(0).toUpperCase() + val.text.slice(1)}.</p>
          ${val.advice.slice(0, 3).map((a) => `<p class="advice">${a.text}</p>`).join('')}
          <small>${figures}</small>
          <div class="go">${buttons}</div>
          <div class="go"><button class="alt" data-dump>Save diagnostics</button> <span class="quiet">a file of numbers (no pictures) for working out what went wrong</span></div></div>`;
        { const db = instr.querySelector('button[data-dump]'); if (db) db.onclick = (ev) => { ev.stopPropagation(); saveDump(); db.textContent = 'Saved to Downloads'; }; }
        emit('accuracy', acc);
        // TEMPORARY, while the tracker is being made to work on real cameras: a poor result saves its own diagnostics.
        if (val.grade === 'poor' && opts.autoDump) { saveDump(); const db = instr.querySelector('button[data-dump]'); if (db) db.textContent = 'Saved to Downloads'; }
        const choice = await waitForChoice(instr);
        skipped = choice === 'esc';
        if (choice !== 'recal') break;
        }
        // Second half: learn this reader's own pace. Skipping it keeps the eye
        // calibration and falls back to the previous (or default) pace and tau.
        if (withBaseline && !skipped) {
          try { await runBaseline(instr); }
          catch (e) { if (e.message !== 'cancelled') throw e; }
        }
        setStatus('tracking');
        return acc;
      } catch (e) {
        if (S.status !== 'error') setStatus(S.model ? (S.needsRecal ? 'paused' : 'tracking') : prevStatus);
        // What the camera actually delivered, so a failure can be told apart (slow camera, face lost, blinks, timing).
        let why = '';
        try {
          const raw = (S.calRun && S.calRun.raw) || [], h = C.calibrationHealth(raw), pct = (v) => Math.round(100 * v);
          if (raw.length) {
            why = ` [camera ${h.fps} fps (${S.delegate || '?'}, clock ${S.timeSource || '?'}, by timer ${(S.latest && S.latest.viaTimer) || 0}) · face lost ${pct(h.lostShare)} % · blinks ${pct(h.blinkShare)} % · kept per dot: ${raw.map((d) => d.frames + '/' + d.stream.length).join(' ')}]`;
            S.calFail = { message: e.message, health: h, dots: raw.map((d) => ({ g: d.g, role: d.role, seg: d.seg, kept: d.frames, seen: d.stream.length, settled: d.settled, restarts: d.restarts, lenient: d.lenient, tShow: d.tShow, tSampleStart: d.tSampleStart, tSampleEnd: d.tSampleEnd, t0: d.stream.length ? d.stream[0].t : null, t1: d.stream.length ? d.stream[d.stream.length - 1].t : null, lids: d.stream.filter((f) => f.lids).slice(0, 40).map((f) => [+f.lids.l.toFixed(2), +f.lids.r.toFixed(2), +f.lids.open.toFixed(3)]) })) };
            console.warn('[gaze] calibration failed: ' + e.message + why, JSON.stringify(S.calFail));
          }
        } catch (_) { /* the diagnosis must never hide the failure */ }
        if (e.message !== 'cancelled' && S.status !== 'error') toast('Calibration failed: ' + e.message + why, why ? 60000 : 7000, [['Try again', () => calibrate().catch(() => {})]]);
        throw e;
      } finally {
        window.removeEventListener('keydown', onEsc, true);
        cal.classList.remove('show');
        dot.style.display = 'none'; dot.style.transition = '';
        if (cnote) cnote.style.display = 'none';
        if ($('bread')) $('bread').style.display = 'none';
        S.calRun = null;
        S.bl = null;
      }
    })();
    try { return await calibrating; } finally { calibrating = null; }
  }

  function applyAccuracy(acc) {
    const p = C.trackingParams(acc);
    S.sx = p.sx;
    S.sy = p.sy;
    S.fix = new C.FixationDetector({ dispersion: p.dispersion });
    resetFilters();
  }

  // -------------------------------------------- click-based refinement
  // People often look at what they click, and then the click is a free calibration sample. Often
  // they do not, so C.clickUsable decides: only while the eyes rest, only when the model already
  // has them near the click. Never a click on Glider's own controls (its dock, this widget): the
  // eyes are on the page then. And a click sample lives for a minute (C.CLICK_TTL_MS).
  function refitWithClicks() {
    clearTimeout(S.refitTimer); S.refitTimer = 0;
    if (!S.model || !S.train) return;
    const had = S.clicks.length;
    S.clicks = C.liveClicks(S.clicks, performance.now());
    if (!had && !S.clicks.length) return;
    // The same kind of model, with its penalties (and, for a head-frame model, its geometry) kept.
    const { X, Y, G } = S.train;
    S.model = C.refitModel(S.model, X.concat(S.clicks.map((c) => c.f)), Y.concat(S.clicks.map((c) => [c.x, c.y])), G.concat(S.clicks.map(() => 'click')), opts.featureCount);
    // Come back when the oldest of them runs out, so that it leaves the model again.
    if (S.clicks.length) S.refitTimer = setTimeout(refitWithClicks, Math.max(400, C.CLICK_TTL_MS - (performance.now() - S.clicks[0].t) + 50));
  }
  document.addEventListener('pointerdown', (e) => {
    if (!opts.clickRefine || S.status !== 'tracking' || !S.model || !S.train || S.drifted) return;
    const path = e.composedPath();
    if (S.host && path.includes(S.host)) return;
    if (path.some((n) => n && n.nodeType === 1 && (n.id === 'glider-root' || n.hasAttribute('data-glider-ignore')))) return;
    const now = performance.now();
    const fresh = S.recent.filter((r) => now - r.t < 200);
    if (fresh.length < 2) return;
    const preds = fresh.map((r) => S.model.predict(r.f));
    const pred = { x: preds.reduce((a, p) => a + p[0], 0) / preds.length, y: preds.reduce((a, p) => a + p[1], 0) / preds.length };
    const fx = S.fix.current(S.frameT);
    const usable = C.clickUsable({ click: { x: e.clientX, y: e.clientY }, pred, sx: S.sx, sy: S.sy, fixating: !!fx && fx.dur >= S.fix.minDur });
    S.clickStats = S.clickStats || { used: 0, refused: 0 };
    S.clickStats[usable ? 'used' : 'refused']++;
    if (!usable) return;
    for (const r of fresh) S.clicks.push({ f: r.f, x: e.clientX, y: e.clientY, g: 1000 + S.clicks.length, t: now });
    if (S.clicks.length > 300) S.clicks.splice(0, S.clicks.length - 300);
    clearTimeout(S.refitTimer);
    S.refitTimer = setTimeout(refitWithClicks, 400);
  }, true);

  // ----------------------------------------------------------- persistence
  function saveCalibration() {
    const round = (a) => a.map((v) => Math.round(v * 1e5) / 1e5);
    S.calibT = Date.now();
    chrome.storage.local.set({
      grCalib: {
        t: S.calibT, model: S.model.toJSON(), accuracy: S.accuracy, head: S.calibHead, screen: S.calibScreen, shootout: S.shootout || null, procedure: S.procedure || null,
        train: { X: S.train.X.map(round), Y: S.train.Y, G: S.train.G },
      },
    });
  }
  /** No calibration is in use: a model left in memory by an earlier start (stop() keeps it) must not count as one. */
  function forgetCalibration() {
    S.model = null; S.train = null; S.trainExtra = null; S.clicks = [];
    S.drifted = false; S.driftSince = 0; S.needsRecal = false;
  }
  async function restoreCalibration() {
    try {
      const { grCalib: c } = await chrome.storage.local.get('grCalib');
      // Nothing saved, too old, or made for another window size or place: whatever is still in memory is that
      // same calibration (or an older one) and is no better. Without this the status said 'ready' with
      // calibrated: true, and Esc in the next calibration went back to 'tracking' on the stale model.
      if (!c || Date.now() - c.t > 3 * 3600e3) { forgetCalibration(); return false; }
      const sc = c.screen;
      if (!sc || Math.abs(sc.w - innerWidth) > 8 || Math.abs(sc.h - innerHeight) > 8 || Math.abs(sc.sx - screenX) > 8 || Math.abs(sc.sy - screenY) > 8) { forgetCalibration(); return false; }
      const model = C.Ridge.fromJSON(c.model);
      // The window is where it was; is the head? One second of camera frames against the posture the
      // calibration was made in (C.headWithinGate, the limits of the head gate). Nobody in front of
      // the camera, or somebody sitting elsewhere: the saved model is not used.
      S.probe = [];
      await sleep(1000);
      const probe = S.probe || []; S.probe = null;
      S.restoreCheck = c.head ? C.headWithinGate(probe, c.head, model.kind) : { ok: false, frames: probe.length, moved: 0 };
      if (!S.restoreCheck.ok) { forgetCalibration(); return 'moved'; }   // a model still in memory from before a stop is that same calibration
      S.model = model; S.calibT = c.t;
      S.accuracy = c.accuracy; S.calibHead = c.head; S.calibScreen = c.screen; S.train = c.train; S.shootout = c.shootout || null;
      S.trainExtra = null; S.calRaw = null; S.procedure = c.procedure || null; S.clicks = [];
      applyAccuracy(c.accuracy);
      // A restored calibration starts clean: no vertical offset learned in an earlier sitting, no stale pause.
      S.drift.y = 0; S.drifted = false; S.driftSince = 0; S.needsRecal = false;
      return true;
    } catch (e) { console.warn('[gaze] restore failed', e); forgetCalibration(); return false; }
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
  /* The calibration maps the eyes to this window at this size in this place on the screen. Resized
     or moved, the old mapping would put the gaze somewhere else: tracking pauses (status 'paused')
     until the window is back as it was or a new calibration is made. Checked on resize and, since
     moving a window fires no event, once a second while frames arrive. */
  function geometryChanged() {
    const sc = S.calibScreen;
    return !!(S.model && sc && (Math.abs(sc.w - innerWidth) > 8 || Math.abs(sc.h - innerHeight) > 8 || Math.abs(sc.sx - screenX) > 8 || Math.abs(sc.sy - screenY) > 8));
  }
  function checkGeometry() {
    const changed = geometryChanged();
    if (changed && !S.needsRecal) {
      S.needsRecal = true;
      if (S.status === 'tracking') {
        setStruggling(null); S.cur = null; S.gaze = null;
        setStatus('paused');
        toast('The window changed size or place, so eye tracking is paused.', 0, [['Recalibrate', () => calibrate({ baseline: false }).catch(() => {})]]);
      } else emit('status', getState());
    } else if (!changed && S.needsRecal) {
      S.needsRecal = false;
      if (S.status === 'paused') {
        // Back as calibrated: go on, and do not let the filters glide in from where the eyes were before.
        S.fix.reset(); resetFilters(); S.prevFixEnd = 0;
        hideToast();
        setStatus('tracking');
      } else emit('status', getState());
    }
  }
  addEventListener('resize', () => { invalidate(); checkGeometry(); });

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

  function setDebug(v) { opts.debug = !!v; wake(); emit('status', getState()); }

  /* TEMPORARY tracking feedback: a heat trace of the gaze estimate, so the reader can see whether the tracker is
     close to where they are looking. Green where the estimate passed, through yellow to red where it stayed; it
     cools by half every TRACE_HALF_LIFE ms. Viewport coordinates, on a coarse grid stretched over the screen so
     it is soft. It is cleared on scroll and resize (it would no longer sit on the text it was drawn over). */
  const TRACE_CELL = 6, TRACE_HALF_LIFE = 3400, TRACE_SIGMA = 30;
  // Milliseconds of looking at one spot that take it to full heat. Heat is added per camera frame for
  // the time since the previous camera frame. (It used to be the time since the last repaint, so the
  // trace got fainter the faster the screen refreshed; 2080 gives what a 60 Hz screen showed then.)
  const TRACE_FULL_MS = 2080;
  const TRACE_STOPS = [[110, 205, 70], [255, 232, 0], [255, 140, 0], [232, 30, 22]];
  const T = { heat: null, cw: 0, ch: 0, at: 0, addAt: 0, off: null };
  function traceGrid() {
    const cw = Math.ceil(innerWidth / TRACE_CELL), ch = Math.ceil(innerHeight / TRACE_CELL);
    if (!T.heat || T.cw !== cw || T.ch !== ch) {
      T.heat = new Float32Array(cw * ch); T.cw = cw; T.ch = ch; T.at = performance.now();
      T.off = document.createElement('canvas'); T.off.width = cw; T.off.height = ch;
    }
    return T;
  }
  function traceCool(now) {
    const dt = now - T.at; if (dt <= 0) return;
    const f = Math.pow(0.5, dt / TRACE_HALF_LIFE), h = T.heat;
    for (let n = 0; n < h.length; n++) h[n] *= f;
    T.at = now;
  }
  function traceAdd(x, y) {
    const now = performance.now(); traceGrid();
    const dt = Math.min(120, now - T.addAt);         // a gap (a blink, a look away) adds no heat
    T.addAt = now;
    traceCool(now);
    const sig = TRACE_SIGMA / TRACE_CELL, R = Math.ceil(sig * 3), cx = x / TRACE_CELL, cy = y / TRACE_CELL, add = dt / TRACE_FULL_MS, h = T.heat;
    for (let j = Math.max(0, Math.floor(cy - R)); j < Math.min(T.ch, cy + R); j++) {
      for (let i = Math.max(0, Math.floor(cx - R)); i < Math.min(T.cw, cx + R); i++) {
        const d2 = (i - cx) * (i - cx) + (j - cy) * (j - cy);
        h[j * T.cw + i] = Math.min(1, h[j * T.cw + i] + add * Math.exp(-d2 / (2 * sig * sig)));
      }
    }
  }
  function traceDraw(g) {
    traceGrid(); traceCool(performance.now());
    const ctx = T.off.getContext('2d'), img = ctx.createImageData(T.cw, T.ch), px = img.data, h = T.heat;
    for (let n = 0; n < h.length; n++) {
      const t = h[n]; if (t < 0.02) continue;
      const u = Math.min(0.999, t) * 3, a = Math.floor(u), b = u - a, c0 = TRACE_STOPS[a], c1 = TRACE_STOPS[a + 1];
      px[n * 4] = c0[0] + (c1[0] - c0[0]) * b; px[n * 4 + 1] = c0[1] + (c1[1] - c0[1]) * b; px[n * 4 + 2] = c0[2] + (c1[2] - c0[2]) * b;
      px[n * 4 + 3] = Math.min(140, t * 3.2 * 140);  // see-through: the overlay cannot blend into the page, so the words must show through it
    }
    ctx.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.drawImage(T.off, 0, 0, T.cw * TRACE_CELL, T.ch * TRACE_CELL);
  }
  function traceClear() { T.addAt = performance.now(); if (T.heat) { T.heat.fill(0); T.at = T.addAt; } }
  addEventListener('scroll', () => { if (opts.trace) traceClear(); }, { capture: true, passive: true });
  /* "Show tracking". It may be switched at any time, before the camera is on or before a calibration
     too: the option is kept and the heat appears as soon as there is a gaze estimate to draw. The
     overlay canvas never takes a click (pointer-events: none on it and on its host). */
  function setTrace(v) { opts.trace = !!v; traceClear(); S.traceX.reset(); S.traceY.reset(); wake(); emit('status', getState()); }

  /** Where the eyes are right now: {element, lineIndex, lineRect, confidence} or null. */
  function getCurrentLine() {
    if (!S.cur || !S.cur.el.isConnected) return null;
    const r = getLines(S.cur.el)[S.cur.line];
    return { element: S.cur.el, lineIndex: S.cur.line, lineRect: r ? { ...r } : null, confidence: +S.cur.conf.toFixed(2) };
  }

  window.GazeReader = {
    init(o = {}) {
      const trace = opts.trace;
      Object.assign(opts, o);
      if (o.baselineWpm && !S.baseline) S.wpm = o.baselineWpm;
      if (opts.trace !== trace) { traceClear(); S.traceX.reset(); S.traceY.reset(); }
      wake();
      return window.GazeReader;
    },
    start, stop, calibrate, measureBaseline, on, setDebug, setTrace, getState, getCurrentLine,
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
        // rows collected but not used by the model in use (the head-segment dots when model A is in use)
        trainExtra: S.trainExtra || null,
        // The last calibration as it happened, for replay: per dot when it was shown, which stretch was sampled,
        // and every camera frame from the moment it appeared (stream: {t, face, blink, f, head}; nothing trimmed).
        calibration: S.calRaw ? { procedure: S.procedure, dots: S.calRaw.map((d) => ({ ...d, stream: d.stream.map((fr) => ({ ...fr, f: fr.f ? fr.f.map((v) => Math.round(v * 1e6) / 1e6) : undefined })) })) } : null,
        headGate: S.model ? C.headGate(S.model.kind) : null, restoreCheck: S.restoreCheck || null,
        // which gaze model is in use ('A' the 25-input ridge, 'B' / 'C' / 'E' a head-frame model) and what the shoot-out saw
        modelKind: S.model ? S.model.kind || 'A' : null, shootout: S.shootout || null,
        calibHead: S.calibHead, calibScreen: S.calibScreen, baseline: S.baseline, camera: S.camera || null, tau: +tau().toFixed(2),
        noise: { sx: S.sx, sy: S.sy, dispersion: S.fix.dispersion, drift: S.drift.y }, clicks: S.clicks.length, clickStats: S.clickStats || { used: 0, refused: 0 },
        delegate: S.delegate, timeSource: S.timeSource,
        // when the calibration in use was made (Date.now() at its end; the same after it is restored): recordings made on one calibration share it
        calibratedAt: S.calibT || null,
        // step 4: the check after the fit, what the camera saw during the calibration, the delegate trial, the live quality gate, the last start problem
        validation: (S.accuracy && S.accuracy.validation) || null, health: S.health || null, perf: S.perf || null,
        quality: S.quality.map((w) => w.id), face: S.face ? { ...S.face } : null, error: S.error ? { ...S.error } : null,
        blockedRequests: S.blockedRequests || 0,   // network calls the camera frame refused (it allows none)
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
