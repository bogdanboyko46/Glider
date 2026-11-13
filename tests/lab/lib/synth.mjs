// Synthetic Gaze Lab recordings in the v1 recording format, for developing and self-testing the
// analyzer. A small geometric "person in front of a webcam" produces the 44-number feature vector:
// eye rotation depends on where the head is, iris features are nonlinear in the eye angle,
// blendshapes saturate, noise is AR(1) and correlated between features. The shipped pipeline
// (real Ridge / FixationDetector / LineHMM) then runs on those frames to produce the events.
//
//   node tests/lab/lib/synth.mjs --write     regenerate tests/lab/fixtures/*.json
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { C, LAB_DIR, mkRng, clamp } from './util.mjs';
import { accParams, detectFixations, replayShipped, blocksOf } from './replay.mjs';

const D2R = Math.PI / 180;
const CAL_POINTS = [[0.06, 0.08], [0.5, 0.08], [0.94, 0.08], [0.72, 0.29], [0.28, 0.29], [0.06, 0.5], [0.5, 0.5], [0.94, 0.5], [0.72, 0.71], [0.28, 0.71], [0.06, 0.92], [0.5, 0.92], [0.94, 0.92]];
const VAL_POINTS = [[0.25, 0.22], [0.75, 0.22], [0.5, 0.5], [0.25, 0.78], [0.75, 0.78]];
const TEST_POINTS = [[0.1, 0.12], [0.5, 0.12], [0.9, 0.12], [0.3, 0.3], [0.7, 0.3], [0.1, 0.5], [0.5, 0.5], [0.9, 0.5], [0.3, 0.7], [0.7, 0.7], [0.1, 0.88], [0.5, 0.88], [0.9, 0.88]];
const SHIFT_POINTS = [[0.2, 0.2], [0.8, 0.25], [0.5, 0.5], [0.2, 0.8], [0.8, 0.75]];

export const DEFAULTS = {
  seed: 1, fps: 30, drop: 0.02, blinkEveryMs: 7000, faceLostEveryMs: 0,
  viewport: { w: 1536, h: 730 }, screen: { w: 1536, h: 864 }, chromePx: 110, screenDiagIn: 14, distanceCm: 60,
  camera: { width: 1280, height: 720, frameRate: 30 }, hfovDeg: 70, ipdCm: 6.3,
  // per-frame AR(1) noise on the mean eye features (indices 8..11): sd and lag-1 autocorrelation
  noise: { u: 0.004, v: 0.006, vl: 0.005, open: 0.008, phi: 0.5, vlRho: 0.5 },
  noiseScale: 1, headWanderCm: 0.15, headFollow: 0.08,
  lookBias: { x: 0, y: 0 },      // the "tester" looks this many px away from every target
  wpm: 180, round: 5,
};

function round(v, d) { const k = 10 ** d; return Math.round(v * k) / k; }
function rotMat(yaw, pitch, roll) {   // column-major 3x3 as [c0, c1, c2]
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  // R = Ry(yaw) * Rx(pitch) * Rz(roll)
  return [
    [cy * cr + sy * sp * sr, cp * sr, -sy * cr + cy * sp * sr],
    [-cy * sr + sy * sp * cr, cp * cr, sy * sr + cy * sp * cr],
    [sy * cp, -sp, cy * cp],
  ];
}

/** A person + camera + screen. frame(t, gx, gy) -> one 'raw' event body. */
export class World {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts, noise: { ...DEFAULTS.noise, ...(opts.noise || {}) }, lookBias: { ...DEFAULTS.lookBias, ...(opts.lookBias || {}) } };
    const o = this.o; this.rng = mkRng(o.seed);
    this.cmPerPx = (o.screenDiagIn * 2.54) / Math.hypot(o.screen.w, o.screen.h);
    this.base = { x: this.rng.g() * 1, y: 10 + this.rng.g() * 1, z: o.distanceCm, yaw: this.rng.g() * 2 * D2R, pitch: this.rng.g() * 2 * D2R, roll: this.rng.g() * 1 * D2R };
    this.shift = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0 };
    this.ar = {}; this.wander = { x: 0, y: 0, z: 0 }; this.lastT = null;
    this.nextBlink = o.blinkEveryMs > 0 ? -Math.log(1 - this.rng.u()) * o.blinkEveryMs : Infinity; this.blinkEnd = -1;
    this.nextLost = o.faceLostEveryMs > 0 ? -Math.log(1 - this.rng.u()) * o.faceLostEveryMs : Infinity; this.lostEnd = -1;
    this.t = 0;
  }
  setShift(s) { this.shift = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, ...s }; }
  _ar(key, sdv, phi) {   // stationary AR(1), advanced once per frame
    const prev = this.ar[key];
    const v = prev === undefined ? this.rng.g() * sdv : phi * prev + Math.sqrt(1 - phi * phi) * sdv * this.rng.g();
    this.ar[key] = v; return v;
  }
  /** Advance the clock by one camera frame; returns the new time or null when the frame is dropped. */
  tick() {
    const period = 1000 / this.o.fps;
    this.t += Math.max(8, period + this.rng.g() * 2);
    if (this.rng.u() < this.o.drop) this.t += period;
    return this.t;
  }
  frame(t, gx, gy) {
    const o = this.o, N = o.noise, k = o.noiseScale, r = this.rng;
    const dt = this.lastT === null ? 33 : t - this.lastT; this.lastT = t;
    for (const a of ['x', 'y', 'z']) { const tau = 20000, s = o.headWanderCm; this.wander[a] += -(dt / tau) * this.wander[a] + Math.sqrt(2 * s * s * dt / tau) * r.g(); }
    if (t >= this.nextBlink) { this.blinkEnd = t + r.U(120, 260); this.nextBlink = t + 400 - Math.log(1 - r.u()) * o.blinkEveryMs; }
    if (t >= this.nextLost) { this.lostEnd = t + r.U(200, 700); this.nextLost = t + 1000 - Math.log(1 - r.u()) * o.faceLostEveryMs; }
    // noise states advance on every frame so the autocorrelation is per camera frame
    const nu = this._ar('u', N.u * k, N.phi), nv = this._ar('v', N.v * k, N.phi), nvl0 = this._ar('vl', N.vl * k, N.phi), no = this._ar('o', N.open * k, N.phi);
    const nvl = N.vlRho * (N.vl / N.v) * nv + Math.sqrt(1 - N.vlRho ** 2) * nvl0;   // correlated with v, same sd and phi
    if (t < this.lostEnd) return { face: false, blink: false, fps: o.fps };
    const E = { x: this.base.x + this.shift.x + this.wander.x, y: this.base.y + this.shift.y + this.wander.y, z: this.base.z + this.shift.z + this.wander.z };
    const Tx = (gx + o.lookBias.x - o.viewport.w / 2) * this.cmPerPx, Ty = (gy + o.lookBias.y + o.chromePx) * this.cmPerPx;
    const thx = Math.atan((Tx - E.x) / E.z), thy = Math.atan((Ty - E.y) / E.z);
    const yaw = this.base.yaw + this.shift.yaw + o.headFollow * thx + this._ar('yaw', 0.15 * D2R, 0.97);
    const pitch = this.base.pitch + this.shift.pitch + o.headFollow * thy + this._ar('pit', 0.15 * D2R, 0.97);
    const roll = this.base.roll + this.shift.roll + this._ar('rol', 0.1 * D2R, 0.97);
    const ex = thx - yaw, ey = thy - pitch;
    const blink = t < this.blinkEnd;
    // iris features: nonlinear in the eye angle, leak a little head pose
    const u = 0.55 * Math.sin(ex) + 0.05 * ex * ey + 0.25 * yaw + nu;
    const v = 0.02 + 0.30 * Math.sin(ey) + 0.10 * ey * ey + 0.15 * pitch + nv;
    const vl = 0.01 + 0.12 * Math.sin(ey) - 0.04 * ex * ex + nvl;
    let op = 0.30 - 0.25 * ey + 0.12 * ey * ey + no; if (blink) op = 0.06 + Math.abs(r.g()) * 0.02;
    const au = 0.012 + 0.06 * ex * ex + r.g() * 0.002 * k, av = 0.004 + r.g() * 0.002 * k, avl = r.g() * 0.002 * k, ao = 0.01 + r.g() * 0.003 * k;
    const A = { u: u + au, v: v + av, vl: vl + avl, open: op + ao }, B = { u: u - au, v: v - av, vl: vl - avl, open: op - ao };
    const um = (A.u + B.u) / 2, vm = (A.v + B.v) / 2, vlm = (A.vl + B.vl) / 2, om = (A.open + B.open) / 2;
    const f = [A.u, A.v, A.vl, A.open, B.u, B.v, B.vl, B.open, um, vm, vlm, om, um * um, vm * vm, um * vm, vlm * vlm, um * vlm];
    const bn = () => this.rng.g() * 0.015 * k, c01 = (x) => clamp(x, 0, 1);
    const bcm = this._ar('bcm', 0.02 * k, N.phi);
    f.push(c01(0.08 + 1.3 * ey + bcm + bn()), c01(0.08 + 1.3 * ey + bcm + bn()), c01(0.08 - 1.3 * ey - bcm + bn()), c01(0.08 - 1.3 * ey - bcm + bn()),
      c01(0.1 + 1.1 * ex + bn()), c01(0.1 - 1.1 * ex + bn()), c01(0.1 - 1.1 * ex + bn()), c01(0.1 + 1.1 * ex + bn()));
    // facial transformation matrix, column-major, translation in cm with z negative (MediaPipe convention)
    const R = rotMat(yaw + this._ar('myaw', 0.3 * D2R * k, N.phi), pitch + this._ar('mpit', 0.4 * D2R * k, N.phi), roll + this._ar('mrol', 0.2 * D2R * k, N.phi));
    const tx = E.x + this._ar('mtx', 0.08 * k, N.phi), ty = -(E.y - 10) + this._ar('mty', 0.08 * k, N.phi), tz = -(E.z + this._ar('mtz', 0.5 * k, N.phi));
    f.push(R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, tx, ty, tz, 1);
    const Wc = 2 * E.z * Math.tan(o.hfovDeg / 2 * D2R), aspect = o.camera.height / o.camera.width;
    const head = { cx: 0.5 + E.x / Wc + r.g() * 0.0008 * k, cy: 0.5 + (E.y - 10) / (Wc * aspect) + r.g() * 0.0008 * k, s: o.ipdCm / Wc * (1 + r.g() * 0.004 * k) };
    f.push(head.cx, head.cy, head.s);
    const d = o.round;
    return { face: true, blink, f: f.map((x) => round(x, d)), head: { cx: round(head.cx, d), cy: round(head.cy, d), s: round(head.s, d) }, fps: o.fps };
  }
}

function accuracyFrom(model, pts, vp) {   // port of gaze-reader.js accuracyFrom
  let bx = 0, by = 0, nx = 0, ny = 0, k = 0;
  for (const p of pts) {
    if (p.samples.length < 5) continue;
    const preds = p.samples.map((s) => model.predict(s.f));
    const mx = preds.reduce((a, q) => a + q[0], 0) / preds.length, my = preds.reduce((a, q) => a + q[1], 0) / preds.length;
    bx += (mx - p.x) ** 2; by += (my - p.y) ** 2;
    nx += Math.sqrt(preds.reduce((a, q) => a + (q[0] - mx) ** 2, 0) / preds.length);
    ny += Math.sqrt(preds.reduce((a, q) => a + (q[1] - my) ** 2, 0) / preds.length);
    k++;
  }
  const accX = Math.sqrt(bx / k), accY = Math.sqrt(by / k), precX = nx / k, precY = ny / k;
  const effX = Math.sqrt(accX ** 2 + precX ** 2 / 6), effY = Math.sqrt(accY ** 2 + precY ** 2 / 6);
  return { accuracyX: Math.round(accX), accuracyY: Math.round(accY), precisionX: Math.round(precX), precisionY: Math.round(precY), effX: Math.round(effX), effY: Math.round(effY), recommendedLinePitchPx: Math.round(Math.max(36, Math.min(120, 1.5 * effY))), viewport: { ...vp } };
}

/** Run the dot calibration exactly as calibrate() does. Returns the session (world + dump). */
export function makeSession(opts = {}) {
  const w = new World(opts); const o = w.o; const vp = o.viewport;
  const events = []; let gx = vp.w / 2, gy = vp.h / 2;
  const runPoints = (pts, base) => pts.map((p, i) => {
    const x = p[0] * vp.w, y = p[1] * vp.h; const tShow = w.t; const samples = [];
    while (w.t < tShow + 650 + 1000) {
      const t = w.tick(); if (t - tShow > 180) { gx = x; gy = y; }
      const fr = w.frame(t, gx, gy); events.push({ k: 'raw', t: round(t, 1), ...fr });
      if (t >= tShow + 650 && fr.face && !fr.blink) samples.push(fr);
    }
    return { x, y, g: base + i, samples };
  });
  const calPts = runPoints(CAL_POINTS, 0);
  const X = [], Y = [], G = [], heads = [];
  const add = (pts) => { for (const p of pts) for (const s of p.samples) { X.push(s.f); Y.push([p.x, p.y]); G.push(p.g); heads.push(s.head); } };
  add(calPts);
  let model = new C.Ridge().fit(X, Y, G);
  const valPts = runPoints(VAL_POINTS, 100);
  const accuracy = accuracyFrom(model, valPts, vp);
  add(valPts);
  model = new C.Ridge().fit(X, Y, G);
  const m = (k) => heads.reduce((a, h) => a + h[k], 0) / heads.length;
  const baseline = { wpm: o.wpm, msPerWord: 60000 / o.wpm, cv: 0.2, regressionRate: 0.1, tau: C.tauFromCv(0.2), source: 'synthetic' };
  const dump = {
    state: { status: 'tracking' }, accuracy, model: model.toJSON(), train: { X, Y, G },
    calibHead: { cx: m('cx'), cy: m('cy'), s: m('s') }, calibScreen: { w: vp.w, h: vp.h, sx: 0, sy: 0 },
    baseline, camera: { ...o.camera }, tau: baseline.tau,
  };
  return { world: w, model, dump, calibEvents: events, startedAt: opts.startedAt || 1794300000000 };
}

function makeLayout(vp, rng, { blocks = 2, linesPer = 5, pitch = 64, fontPx = 24, left = 260, width = 900, top0 = 90 } = {}) {
  const WORDS = 'the quick reader moves along every line of this plain passage while small eyes follow each word across a bright screen and then return to start again below'.split(' ');
  const out = []; let top = top0;
  for (let b = 0; b < blocks; b++) {
    const lines = [];
    for (let i = 0; i < linesPer; i++) {
      const cy = top + i * pitch + pitch / 2, h = fontPx * 1.2; const words = []; let x = left;
      const lim = left + width * (i === linesPer - 1 ? rng.U(0.45, 0.75) : 1);
      for (;;) { const text = WORDS[Math.floor(rng.u() * WORDS.length)]; const wpx = text.length * fontPx * 0.52; if (x + wpx > lim) break; words.push({ text, left: round(x, 1), right: round(x + wpx, 1) }); x += wpx + fontPx * 0.3; }
      lines.push({ top: cy - h / 2, bottom: cy + h / 2, left, right: words[words.length - 1].right, words });
    }
    out.push({ id: 'b' + b, pitch, fontPx, lines });
    top += linesPer * pitch + 50;
  }
  return { blocks: out };
}

/**
 * Record one task with an existing session.
 * opts: { label, noDump, gazeScript } plus task-specific knobs.
 */
export function record(session, task, opts = {}) {
  const w = session.world, o = w.o, vp = o.viewport, rng = w.rng;
  const t0 = w.t; const truth = []; let layout = { blocks: [] }; const params = { ...(opts.params || {}) };
  const segs = [];   // {t0, t1, x, y, shift?} : where the tester looks; shift applied at seg start
  const cy = (l) => (l.top + l.bottom) / 2;
  let t = t0 + 500;
  const target = (id, p, dur, phase) => {
    const x = round(p[0] * vp.w, 1), y = round(p[1] * vp.h, 1);
    const e = { kind: 'target', id, x, y, tShow: t, tSettle: t + 700, tEnd: t + dur }; if (phase) e.phase = phase;
    truth.push(e); segs.push({ t0: t + 200 + rng.U(0, 80), t1: t + dur, x, y }); t += dur;
  };
  const readLayout = (paced) => {
    layout = makeLayout(vp, rng, opts.layout || {});
    const msWord = paced ? (opts.msPerWord || 340) : 60000 / o.wpm;
    layout.blocks.forEach((b, bi) => b.lines.forEach((l, li) => {
      const l0 = t;
      if (paced) {
        l.words.forEach((wd, wi) => { const x = (wd.left + wd.right) / 2; truth.push({ kind: 'word', block: b.id, line: li, word: wi, x: round(x, 1), t0: t, t1: t + msWord }); segs.push({ t0: t + 150, t1: t + msWord + 150, x, y: cy(l) + rng.g() * 2 }); t += msWord; });
      } else {
        let x = l.left + 30; const step = (l.right - l.left) / Math.max(2, l.words.length * msWord / 250);
        let stall = opts.stallAt && opts.stallAt[0] === bi && opts.stallAt[1] === li;
        while (x < l.right - 20) {
          const d = clamp(250 * Math.exp(0.3 * rng.g()), 120, 600); segs.push({ t0: t, t1: t + d, x, y: cy(l) + rng.g() * 2 }); t += d + 30;
          if (stall && x > l.left + 0.4 * (l.right - l.left)) {   // stuck on a word: many short refixations around it
            stall = false; const s0 = t; const sx0 = x;
            while (t < s0 + (opts.stallMs || 7000)) { const d2 = clamp(280 * Math.exp(0.3 * rng.g()), 150, 700); segs.push({ t0: t, t1: t + d2, x: sx0 + rng.U(-60, 60), y: cy(l) + rng.g() * 2 }); t += d2 + 30; }
            truth.push({ kind: 'phase', name: 'stall', t0: s0, t1: t });
          }
          x += step * clamp(1 + 0.3 * rng.g(), 0.3, 2);
        }
        const rr = opts.rereadAt && opts.rereadAt[0] === bi && opts.rereadAt[1] === li;
        if (rr) {   // jump back two lines, skim them, twice
          truth.push({ kind: 'line', block: b.id, line: li, t0: l0, t1: t }); truth.push({ kind: 'key', key: ' ', t });
          const s0 = t;
          for (let rep = 0; rep < 2; rep++) for (const lj of [li - 2, li - 1, li]) {
            const pl = b.lines[lj]; const q0 = t;
            for (let xx = pl.left + 40; xx < pl.right - 20; xx += step * 1.6) { const d = clamp(220 * Math.exp(0.3 * rng.g()), 120, 500); segs.push({ t0: t, t1: t + d, x: xx, y: cy(pl) + rng.g() * 2 }); t += d + 30; }
            truth.push({ kind: 'line', block: b.id, line: lj, t0: q0, t1: t });
          }
          truth.push({ kind: 'phase', name: 'reread', t0: s0, t1: t });
          t += 60; return;
        }
        truth.push({ kind: 'key', key: ' ', t });
      }
      truth.push({ kind: 'line', block: b.id, line: li, t0: l0, t1: t });
      t += 60;
    }));
  };

  if (task === 'camera') target('centre', [0.5, 0.5], opts.durMs || 15000);
  else if (task === 'validate') TEST_POINTS.forEach((p, i) => target('t' + i, p, opts.targetMs || 2200));
  else if (task === 'headshift') {
    const shifts = opts.shifts || { baseline: {}, 'lean-left': { x: -3 }, 'lean-back': { z: 5 }, slouch: { y: 3, z: 2, pitch: 4 * D2R } };
    for (const [name, s] of Object.entries(shifts)) {
      const p0 = t; segs.push({ t0: t, t1: t + 1500, hold: true, shift: s }); t += 1500;
      SHIFT_POINTS.forEach((p, i) => target(name + '-' + i, p, opts.targetMs || 2200, name));
      truth.push({ kind: 'phase', name, t0: p0, t1: t });
    }
    params.shifts = shifts;
  } else if (task === 'lines-paced') readLayout(true);
  else if (task === 'lines-self') readLayout(false);
  else if (task === 'stall') { opts = { stallAt: [0, 2], rereadAt: [1, 3], ...opts }; readLayout(false); }
  const tEnd = (task === 'calibrate' || task === 'dump') ? t0 : t + 400;

  // ---- camera frames
  const events = []; let gx = vp.w / 2, gy = vp.h / 2, si = 0;
  if (task !== 'dump' && task !== 'calibrate') events.push({ k: 'camera', t: round(t0, 1), settings: { ...o.camera } }, { k: 'status', t: round(t0, 1), state: 'tracking' });
  const model = session.model; const AP = accParams(session.dump.accuracy);
  const euroX = new C.OneEuro(), euroY = new C.OneEuro(); const gaze = [];
  while (w.t < tEnd) {
    const tt = w.tick();
    while (si < segs.length && segs[si].t0 <= tt) { const s = segs[si++]; if (s.shift) w.setShift(s.shift); if (!s.hold) { gx = s.x; gy = s.y; } }
    const fr = w.frame(tt, gx, gy); const te = round(tt, 1);
    events.push({ k: 'raw', t: te, ...fr });
    if (!fr.face || fr.blink) continue;
    const [x, y] = model.predict(fr.f);
    const g = { k: 'gaze', t: te, x: round(euroX.filter(x, tt), 1), y: round(euroY.filter(y, tt), 1), rawX: round(x, 2), rawY: round(y, 2) };
    events.push(g); gaze.push({ t: te, x: g.rawX, y: g.rawY });
  }
  // fixation / line / struggle events as the live reader would have emitted them
  const fixes = detectFixations(gaze, AP.dispersion); const blocks = blocksOf(layout);
  const rp = replayShipped(fixes, blocks, { sx: AP.sx, sy: AP.sy, wpm: session.dump.baseline.wpm, baselineWpm: session.dump.baseline.wpm, tau: session.dump.tau, regressionRate: session.dump.baseline.regressionRate });
  const extra = []; let last = null;
  fixes.forEach((f, i) => {
    extra.push({ k: 'fix', t: f.emitT, x: round(f.x, 1), y: round(f.y, 1), dur: round(f.dur, 1), n: f.n, t0: round(f.t, 1) });
    const d = rp.dec[i]; const key = d ? d.b + ':' + d.line : null;
    if (d && key !== last) extra.push({ k: 'line', t: f.emitT, el: blocks[d.b].id, line: d.line, conf: round(d.conf, 2) });
    last = key;
  });
  for (const g of rp.triggers) extra.push({ k: 'struggle', t: g.t, reason: g.reason, el: blocks[g.b].id, line: g.line, severity: round(g.severity, 2), metrics: {} });
  const all = events.concat(extra).map((e, i) => [e, i]).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map((p) => p[0]);
  for (const e of truth) for (const k of ['t', 't0', 't1', 'tShow', 'tSettle', 'tEnd']) if (k in e) e[k] = round(e[k], 1);

  const rec = {
    v: 1, task, label: opts.label || 'synthetic', startedAt: session.startedAt + Math.round(t0), durationMs: Math.round(tEnd - t0),
    env: { ua: 'synthetic', viewport: { ...vp }, screen: { ...o.screen, availW: o.screen.w, availH: o.screen.h - 40 }, dpr: 1.25, screenX: 0, screenY: 0, outerW: vp.w, outerH: vp.h + o.chromePx },
    physical: { screenDiagIn: o.screenDiagIn, distanceCm: o.distanceCm, glasses: false, lighting: 'synthetic' },
    params, truth, layout, events: task === 'dump' ? [] : (task === 'calibrate' ? session.calibEvents : all),
    notes: 'synthetic recording from tests/lab/lib/synth.mjs',
  };
  if (!opts.noDump) rec.dump = session.dump;
  w.setShift({});
  return rec;
}

/** One-call helper: fresh session + one task. */
export function synthRecording(task, opts = {}) { return record(makeSession(opts), task, opts); }

export const FIXTURE_TASKS = ['calibrate', 'camera', 'validate', 'headshift', 'lines-paced', 'lines-self', 'stall', 'dump'];

export function writeFixtures(dir = path.join(LAB_DIR, 'fixtures')) {
  fs.mkdirSync(dir, { recursive: true });
  const session = makeSession({ seed: 7, round: 4 }); const out = [];
  for (const task of FIXTURE_TASKS) {
    // Some fixtures carry no dump on purpose (smaller files, and they exercise the "use the newest earlier calibration" path).
    const rec = record(session, task, { label: 'synthetic-fixture', noDump: ['camera', 'headshift', 'lines-self', 'stall'].includes(task), durMs: task === 'camera' ? 10000 : undefined, targetMs: task === 'headshift' ? 1800 : undefined, stallMs: 6000 });
    const file = path.join(dir, `synthetic-${task}.json`);
    fs.writeFileSync(file, JSON.stringify(rec));
    out.push(file);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--write')) for (const f of writeFixtures()) console.log('wrote', f, (fs.statSync(f).size / 1024).toFixed(0) + ' KB');
  else console.log('usage: node tests/lab/lib/synth.mjs --write');
}
