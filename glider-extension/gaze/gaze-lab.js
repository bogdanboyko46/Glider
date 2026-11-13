/*
 * gaze-lab.js — developer bridge between GazeReader and the local Gaze Lab page
 * (tests/lab). It does nothing at all unless the page is served from this
 * computer (127.0.0.1 / localhost) AND carries <meta name="glider-lab">.
 *
 * The lab page lives in the page's own JavaScript world and cannot see
 * GazeReader, so the two talk through CustomEvents on `document` whose detail
 * is a JSON string:
 *   page -> here   glider-lab:cmd    { id, cmd, args }
 *   here -> page   glider-lab:reply  { id, ok, result, error }
 *   here -> page   glider-lab:data   { batch: [ {k, t, ...}, ... ] }   about every 100 ms
 * Nothing is sent anywhere else; the lab page posts recordings to its own
 * local server.
 */
(() => {
  'use strict';
  if (window.top !== window) return;
  if (!/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) return;
  if (!document.querySelector('meta[name="glider-lab"]')) return;
  const G = window.GazeReader;
  if (!G || window.__gliderLabBridge) return;
  window.__gliderLabBridge = true;

  const VERSION = 1;
  // Lab runs must be comparable: no silent model changes from clicks on lab buttons.
  G.init({ clickRefine: false });
  let streaming = false;
  let batch = [];
  let timer = 0;
  let subs = [];

  const send = (name, detail) => document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(detail) }));
  const flush = () => { if (batch.length) { const b = batch; batch = []; send('glider-lab:data', { batch: b }); } };
  const push = (ev) => { if (streaming) batch.push(ev); };
  const now = () => performance.now();
  const round = (v, p = 1e5) => Math.round(v * p) / p;

  function subscribe() {
    if (subs.length) return;
    subs = [
      G.on('raw', (r) => push({ k: 'raw', t: r.t, face: r.face, blink: r.blink, f: r.f ? r.f.map((v) => round(v, 1e6)) : undefined, head: r.head, fps: r.fps })),
      G.on('gaze', (g) => push({ k: 'gaze', t: g.t, x: round(g.x, 10), y: round(g.y, 10), rawX: round(g.rawX, 10), rawY: round(g.rawY, 10) })),
      G.on('fixation', (f) => push({ k: 'fix', t: f.t, x: round(f.x, 10), y: round(f.y, 10), dur: Math.round(f.dur), n: f.n })),
      G.on('line', (l) => push({ k: 'line', t: now(), el: l && l.element ? (l.element.id || null) : null, line: l ? l.lineIndex : -1, conf: l ? l.confidence : 0 })),
      G.on('status', (state) => push({ k: 'status', t: now(), state })),
      G.on('camera', (c) => push({ k: 'camera', t: c.t, settings: c.settings })),
      G.on('struggle', (d) => push({ k: 'struggle', t: now(), reason: d.reason, el: d.element ? (d.element.id || null) : null, line: d.lineIndex, severity: d.severity, metrics: d.metrics })),
      G.on('struggling', (s) => push({ k: 'struggling', t: now(), struggling: s.struggling, reason: s.reason, ratio: s.ratio, tau: s.tau })),
    ];
  }

  function setStream(on) {
    streaming = !!on;
    clearInterval(timer);
    if (streaming) {
      subscribe();
      timer = setInterval(flush, 100);
      // Late joiners still learn the tracker's state and the camera.
      push({ k: 'status', t: now(), state: G.getState() });
      const dump = G.debugDump();
      if (dump.camera) push({ k: 'camera', t: now(), settings: dump.camera });
    } else {
      flush();
    }
  }

  const commands = {
    hello: () => ({ version: VERSION, state: G.getState() }),
    state: () => G.getState(),
    dump: () => G.debugDump(),
    start: async () => { await G.start(); return G.getState(); },
    stop: () => { G.stop(); return G.getState(); },
    calibrate: async (a) => { const acc = await G.calibrate({ baseline: !!(a && a.baseline) }); return { accuracy: acc, state: G.getState() }; },
    baseline: async () => { const b = await G.measureBaseline(); return { baseline: b, state: G.getState() }; },
    setWidget: (a) => { G.setWidgetVisible(!(a && a.visible === false)); return true; },
    debug: (a) => { G.setDebug(!!(a && a.on)); return true; },
    setSensitivity: (a) => { G.setSensitivity(a && a.mult); return G.getState(); },
    init: (a) => { G.init(a || {}); return true; },   // e.g. { trace: true, settleMs, sampleMs }
    setRoot: (a) => {
      const host = a && a.hostSelector ? document.querySelector(a.hostSelector) : null;
      G.setRoot(host ? (host.shadowRoot || host) : null);
      return { found: !!host, shadow: !!(host && host.shadowRoot) };
    },
    stream: (a) => { setStream(a && a.on); return { streaming }; },
  };

  document.addEventListener('glider-lab:cmd', async (e) => {
    let msg;
    try { msg = JSON.parse(e.detail); } catch (_) { return; }
    if (!msg || typeof msg.cmd !== 'string') return;
    const fn = commands[msg.cmd];
    if (!fn) { send('glider-lab:reply', { id: msg.id, ok: false, error: 'unknown command: ' + msg.cmd }); return; }
    try {
      const result = await fn(msg.args);
      send('glider-lab:reply', { id: msg.id, ok: true, result });
    } catch (err) {
      send('glider-lab:reply', { id: msg.id, ok: false, error: String((err && err.message) || err) });
    }
  });

  // Tell a page that loaded first that the bridge is here.
  send('glider-lab:ready', { version: VERSION });
})();
