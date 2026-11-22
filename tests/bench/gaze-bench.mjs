#!/usr/bin/env node
// Gaze benchmark: scores the eye tracker exactly as shipped, in plain node, in seconds, with no
// browser and no camera.
//
//   node tests/bench/gaze-bench.mjs                    run, print the tables, write tests/out/gaze-bench.json
//   node tests/bench/gaze-bench.mjs --save-baseline    ... and keep the result as tests/bench/baseline.json
//   node tests/bench/gaze-bench.mjs --compare          ... and print the change against the baseline;
//                                                      exit 1 when S_still or S_move is more than 3 % worse
//   --baseline FILE       compare against (or save to) another result file, e.g. tests/bench/after-step2.json
//   --json FILE           where the full result goes (default tests/out/gaze-bench.json)
//   --recordings DIR      score the lab recordings in DIR for the REAL rows (default tests/lab/recordings)
//   --real-only           only the REAL rows: score the recordings and print them, in a second, without the synthetic runs
//   --model auto|A|B|C|E  which gaze model the calibration may use: auto (ships) runs the shoot-out, A is the
//                         25-input ridge alone, a letter forces that model
//   --cal proc|still|move proc (ships): the calibration procedure of gaze-core.js (CalibrationRun); still / move: the fixed
//                         loop of steps 1 and 2 (move: the head sways 1.5 cm and 3 degrees during the dots)
//   --proc a=1,b=false    CalibrationRun options, e.g. head=false, reshow=0, still=false; "step2" = the old fixed windows.
//                         Three more names are read by the benchmark's own frame loop: blinks=flag (the fixed blink rule),
//                         gate=false (no head gate), dispersion=step2 (the fixation limit as it was until step 3)
//   --who a=1,...         how the synthetic person behaves in the procedure (WHO below); "careless" = late, missed and lost dots
//   --fit a=1,...         more fitCalibration options, e.g. fold=true (validation dots join the training set), score=val
//   --gate-sweep          print how the error grows as the head leaves the calibration posture (what HEAD_GATE was read from)
//   --clicks              print what click refinement does to the error, ungated and gated
//   --hygiene a,b=1,...   switch step 2a options of model A on: norm, perAxis, zClamp=4, sdFloor, bounds=0.15, dropMeans
//   --columns 0,1,...     model A reads exactly these numbers of the camera vector (implies --model A)
//   --no-variants         skip the "models and calibrations" table (five more passes at 0.5 px)
//   --features 17|25|44   regression inputs (25 is what ships)      --trim on|off   per-dot outlier trimming (on ships)
//   --seeds N             synthetic people (default 20)             --noise a,b,c   iris noise levels in px (0.2,0.5,0.8)
//   --set name=number     change one numeric option of the 3D person (tests/bench/synth3d.mjs DEFAULTS3D), to see
//                         what an assumption costs; repeatable; never saved as a baseline
//
// What runs is the tracker's own code from glider-extension/gaze/gaze-core.js: extractFeatures (inside
// the synthetic camera), fitCalibration on the reader's 13 + 5 dots (model shoot-out included), predict, headMoved,
// trackingParams and FixationDetector. The frame loop below (class Tracker) is the one part written
// twice: it repeats processFrame() of gaze-reader.js, which needs a DOM.
//
// EVERY NUMBER HERE COMES FROM A SYNTHETIC CAMERA unless its row says REAL. The noise levels are
// assumptions. Nothing printed is evidence of accuracy on a real webcam or on real eyes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { C, REPO_DIR, LAB_DIR, mkRng, isNum } from '../lab/lib/util.mjs';
import { World } from '../lab/lib/synth.mjs';
import { Person3D, DEFAULTS3D } from './synth3d.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CAVEAT = 'synthetic; noise levels are assumptions; not evidence of real-camera accuracy';
export const OUT_FILE = path.join(REPO_DIR, 'tests', 'out', 'gaze-bench.json');
export const BASELINE_FILE = path.join(HERE, 'baseline.json');
const D2R = Math.PI / 180;

// The assumed screen for turning px into degrees: 14 inch, 1536x864 CSS px, eyes 60 cm away.
export const PROFILE = { screenDiagIn: 14, screen: { w: 1536, h: 864 }, viewport: { w: 1536, h: 730 }, distanceCm: 60 };
export const PX_PER_DEG = Math.hypot(PROFILE.screen.w, PROFILE.screen.h) / (PROFILE.screenDiagIn * 2.54) * PROFILE.distanceCm * Math.tan(D2R);
export const PITCHES = [24, 28, 32, 36, 48, 64];
// gaze-reader.js opts defaults for the dot calibration, and the lab's validate task.
const READER = { settleMs: 1000, sampleMs: 1000, headPause: true };   // headPause: the reader waits on a card before the head segment (tests/bench/bench.test.mjs checks that gaze-reader.js says the same)
const VALIDATE = { settleMs: 700, dwellMs: 1800, holdMs: 1500 };
export const CAL_MOVE = { cm: 1.5, deg: 3 };   // the head sway of the "calibration with head movement" variant
const LOOK_DELAY_MS = [250, 330];   // the eyes leave for a new dot this long after it appears
// 13 held-out targets: a 3x3 grid at 10 / 50 / 90 % plus four inner points at 30 / 70 % (the lab's validate grid).
export const TEST_GRID = [[0.1, 0.1], [0.5, 0.1], [0.9, 0.1], [0.3, 0.3], [0.7, 0.3], [0.1, 0.5], [0.5, 0.5], [0.9, 0.5], [0.3, 0.7], [0.7, 0.7], [0.1, 0.9], [0.5, 0.9], [0.9, 0.9]];

export const CONDITIONS = [
  { name: 'STILL', what: 'same posture as during calibration', subs: [{ name: 'still', shift: {} }] },
  { name: 'HEAD-SHIFT', what: '3 cm sideways; 5 cm back; slouch 2 cm (three runs, pooled)', subs: [{ name: 'sideways 3 cm', shift: { x: 3 } }, { name: 'back 5 cm', shift: { z: 5 } }, { name: 'slouch 2 cm', shift: { y: 2 } }] },
  { name: 'HEAD-ROTATE', what: '5 degrees yaw; 5 degrees pitch (two runs, pooled)', subs: [{ name: 'yaw 5 deg', shift: { yaw: 5 * D2R } }, { name: 'pitch 5 deg', shift: { pitch: 5 * D2R } }] },
  { name: 'LATER', what: 'five minutes on, after a slow 2 cm drift', subs: [{ name: '2 cm drift over 5 min', drift: { x: 1.2, y: 1.2, z: 1.03 }, overMs: 300000 }] },
  { name: 'LOW-FPS', what: 'camera at 15 fps, calibration included', fps: 15, subs: [{ name: '15 fps', shift: {} }] },
];

// ----------------------------------------------------------------------------- the shipped frame loop
/** processFrame() of gaze-reader.js without the page: head gate, blink skip, model, fixation detector. */
export class Tracker {
  constructor({ model, calibHead, accuracy }, { gate = true, blinks = 'lids', dispersion = null } = {}) {
    this.model = model; this.calibHead = gate ? calibHead || null : null;
    this.blinker = blinks === 'lids' ? new C.BlinkDetector() : null;   // 'flag': the frame's own blink flag (the fixed rule)
    // dispersion 'step2': the fixation detector's limit as it was until step 3 (2.2 x the larger scatter), for comparison
    const limit = accuracy ? (dispersion === 'step2' ? Math.max(60, Math.min(220, 2.2 * Math.max(accuracy.precisionX, accuracy.precisionY))) : C.trackingParams(accuracy).dispersion) : null;
    this.fix = limit ? new C.FixationDetector({ dispersion: limit }) : new C.FixationDetector();
    this.driftSince = 0; this.drifted = false;
  }
  /** @returns {{status:'lost'|'gated'|'blink'|'ok', x?:number, y?:number, fix?:object}} */
  push(fr, t) {
    if (!fr.face) return { status: 'lost' };
    if (this.calibHead) {
      if (C.headMoved(fr.head, this.calibHead, fr.f, this.model.kind)) {
        if (!this.driftSince) this.driftSince = t;
        if (!this.drifted && t - this.driftSince > 600) this.drifted = true;
      } else {
        this.driftSince = 0;
        if (this.drifted) { this.drifted = false; this.fix.reset(); }
      }
    }
    const blink = this.blinker && fr.lids ? this.blinker.push(fr.lids, t) : fr.blink;
    if (this.drifted) return { status: 'gated' };
    if (blink) return { status: 'blink' };
    const [x, y] = this.model.predict(fr.f);
    return { status: 'ok', x, y, fix: this.fix.push(t, x, y) };
  }
}

// ----------------------------------------------------------------------------- driving a synthetic person
/** The dot calibration as calibrate() in gaze-reader.js runs it: 13 + 5 dots, settle, then collect. */
export function calibrate(person, rng, calOpts = {}, { move = false } = {}) {
  const vp = person.o.viewport; let gx = vp.w / 2, gy = vp.h / 2;
  // move: the head sways slowly while the dots are shown (what a "turn and lean a little" segment
  // would give): up to CAL_MOVE.cm sideways and back, two thirds of it up and down, CAL_MOVE.deg of
  // yaw and pitch, half of it roll, each on its own period so that pose and dot are unrelated.
  const mr = mkRng((person.o.seed || 1) * 613 + 7), ph = Array.from({ length: 6 }, () => mr.U(0, 2 * Math.PI));
  const sway = (t) => {
    const w = (i, sec) => Math.sin(2 * Math.PI * t / (1000 * sec) + ph[i]);
    person.setShift({ x: CAL_MOVE.cm * w(0, 7.3), y: CAL_MOVE.cm * 2 / 3 * w(1, 9.1), z: CAL_MOVE.cm * w(2, 11.7), yaw: CAL_MOVE.deg * D2R * w(3, 8.3), pitch: CAL_MOVE.deg * D2R * w(4, 6.1), roll: CAL_MOVE.deg / 2 * D2R * w(5, 10.3) });
  };
  const run = (pts, base, role) => pts.map((p, i) => {
    const x = p[0] * vp.w, y = p[1] * vp.h, tShow = person.t, tLook = tShow + rng.U(...LOOK_DELAY_MS), samples = [];
    while (person.t < tShow + READER.settleMs + READER.sampleMs) {
      const t = person.tick(); if (t >= tLook) { gx = x; gy = y; }
      if (move) sway(t);
      const fr = person.frame(t, gx, gy);
      if (t >= tShow + READER.settleMs && fr.face && !fr.blink) samples.push({ f: fr.f, head: fr.head, t });   // (the fixed blink rule, as in steps 1 and 2)
    }
    return { x, y, g: base + i, role, samples };
  });
  const points = run(C.CAL_POINTS, 0, 'cal').concat(run(C.VAL_POINTS, 100, 'val'));
  if (move) person.setShift({});
  return C.fitCalibration(points, { viewport: vp, ...calOpts });
}

// How the synthetic person behaves during the calibration procedure. The standard person does as
// told: the eyes reach each dot 250 to 330 ms after it appears, and in the head segment the head
// turns by about headDeg degrees (yaw; 0.7 of it pitch, 0.3 roll) and moves about headCm. All assumed.
//   late: share of dots the eyes reach only lateMs after the dot appeared (inside the old sampling window)
//   bad:  share of dots not looked at at all on their first showing (the eyes stay on the dot before)
//   lost: share of dots during whose first showing the face is lost
//   readMs: the eyes stay on the head-turn instruction for this long after the first head-segment dot appears
//           (somebody still reading it, or slow to leave it); NOTE_AT is where that text is on the screen
//   pauseMs: with the pause before the head segment (CalibrationRun headPause), how long the person takes to
//           read the instruction card and press Space
export const WHO = { late: 0, lateMs: [800, 1600], bad: 0, lost: 0, headDeg: 5, headCm: 1, readMs: 0, pauseMs: 4000 };
export const NOTE_AT = [0.5, 0.12];
export const SLOPPY = { late: 0.15, bad: 0.06, lost: 0.04 };
// The procedure of step 2 (and before) as CalibrationRun options: fixed windows, nothing shown twice, no head segment.
export const PROC_OLD = { still: false, dropMs: 0, reshow: 0, head: false, blinks: 'flag' };
export const FIT_OLD = { fold: true, score: 'val', allowEmpty: true };

/** The calibration as gaze-reader.js runs it since step 3: C.CalibrationRun decides, a synthetic person follows. */
export function runProcedure(person, rng, proc = {}, calOpts = {}, who = {}) {
  const W = { ...WHO, ...who }, vp = person.o.viewport, seed = person.o.seed || 1;
  const br = mkRng(seed * 911 + 3), hr = mkRng(seed * 613 + 7), u = () => hr.U(0.6, 1.4);
  const amp = { yaw: W.headDeg * D2R * u(), pitch: 0.7 * W.headDeg * D2R * u(), roll: 0.3 * W.headDeg * D2R * u(), x: W.headCm * u(), y: 0.6 * W.headCm * u(), z: 0.6 * W.headCm * u() };
  const keys = ['yaw', 'pitch', 'roll', 'x', 'y', 'z'], per = [3.1, 2.3, 4.3, 3.7, 2.9, 5.1].map((s) => s * hr.U(0.85, 1.15)), ph = per.map(() => hr.U(0, 2 * Math.PI));
  const run = new C.CalibrationRun({ viewport: vp, ...READER, ...proc, fit: calOpts });
  let gx = vp.w / 2, gy = vp.h / 2, step = -1, tLook = 0, aim = null, lost = false, tHead = null, tWait = null, tRead = null;
  const note = () => [NOTE_AT[0] * vp.w + 120 * Math.sin(person.t / 400), NOTE_AT[1] * vp.h];   // the eyes run along the line of text
  for (;;) {
    const t = person.tick(), v = run.update(t);
    if (v.done) break;
    if (v.wait) {
      // The card before the head segment: the person reads it, then presses Space. Nothing is sampled meanwhile.
      if (tWait === null) tWait = t;
      [gx, gy] = note();
      run.push(person.frame(t, gx, gy), t);
      if (t - tWait >= W.pauseMs) run.resume(t);
      continue;
    }
    if (v.stepId !== step) {
      step = v.stepId; aim = [v.x, v.y]; lost = false;
      let delay = rng.U(...LOOK_DELAY_MS);
      if (v.seg === 'head' && tRead === null) { tRead = t + W.readMs; if (W.readMs > 0) { [gx, gy] = note(); } }
      const a = br.u(), b = br.u(), c = br.u(), d = br.U(...W.lateMs);   // always drawn: the same people whatever the settings
      if (v.seg === 'dots') { if (a < W.bad) aim = null; else if (b < W.late) delay = d; if (c < W.lost) lost = true; }
      tLook = t + delay;
    }
    if (aim && t >= tLook) { gx = aim[0]; gy = aim[1]; }
    if (v.seg === 'head' && t < tRead) [gx, gy] = note();
    if (v.seg === 'head') {
      if (tHead === null) tHead = t;
      const ramp = Math.min(1, (t - tHead) / 600), s = {};
      keys.forEach((k, i) => { s[k] = ramp * amp[k] * Math.sin(2 * Math.PI * (t - tHead) / (1000 * per[i]) + ph[i]); });
      person.setShift(s);
    } else if (tHead !== null) { person.setShift({}); tHead = null; }
    const fr = person.frame(t, gx, gy);
    run.push(lost ? { face: false } : fr, t);
  }
  person.setShift({});
  return run.result();
}

/** Look at each target in turn while the tracker runs. Returns per-target errors and frame counts. */
export function runBlock(person, fit, targets, rng, { shift = null, drift = null, overMs = 0, gate = true, blinks = 'lids', dispersion = null } = {}) {
  const vp = person.o.viewport, tr = new Tracker(fit, { gate, blinks, dispersion });
  let gx = vp.w / 2, gy = vp.h / 2;
  const count = { frames: 0, lost: 0, gated: 0, blink: 0, used: 0, fixes: 0, ms: 0, fixMs: 0 };
  const recs = [];
  let prevT = null;
  // A slow drift reaches its full size at the end of the block, `overMs` after the calibration ended.
  const blockMs = VALIDATE.holdMs + targets.length * (VALIDATE.settleMs + VALIDATE.dwellMs);
  const t0 = person.t, tFull = t0 + Math.max(overMs, blockMs);
  const pose = (t) => { if (drift) { const k = Math.min(1, (t - t0) / (tFull - t0)); person.setShift({ x: k * drift.x, y: k * drift.y, z: k * drift.z }); } };
  if (shift) person.setShift(shift);
  if (drift) {   // the minutes before the test: nobody is scored, the head just moves on (two frames a second are enough)
    while (person.t < tFull - blockMs) { person.t += 500; pose(person.t); person.frame(person.t, gx, gy); }
  }
  const step = (now) => {
    pose(now);
    const fr = person.frame(now, gx, gy), r = tr.push(fr, now);
    count.frames++; count[r.status === 'ok' ? 'used' : r.status]++;
    if (prevT !== null) count.ms += now - prevT;
    prevT = now;
    if (r.fix) {
      count.fixes++; count.fixMs += r.fix.dur;
      const rec = recs.find((q) => r.fix.t >= q.tSettle && r.fix.t + r.fix.dur <= q.tEnd);
      if (rec) rec.fixes.push([r.fix.x - rec.x, r.fix.y - rec.y]);
    }
    return r;
  };
  const tHold = person.t + VALIDATE.holdMs;   // getting into the posture, eyes on the middle of the screen
  while (person.t < tHold) step(person.tick());
  for (const p of targets) {
    const x = p[0] * vp.w, y = p[1] * vp.h, tShow = person.t, tLook = tShow + rng.U(...LOOK_DELAY_MS);
    const rec = { x, y, tSettle: tShow + VALIDATE.settleMs, tEnd: tShow + VALIDATE.settleMs + VALIDATE.dwellMs, frames: [], fixes: [], bottom: p[1] >= 0.85, seen: 0, blinked: 0 };
    recs.push(rec);
    while (person.t < rec.tEnd) {
      const t = person.tick(); if (t >= tLook) { gx = x; gy = y; }
      const r = step(t);
      if (r.status === 'ok' && t >= rec.tSettle && t <= rec.tEnd) rec.frames.push([r.x - x, r.y - y]);
      if (t >= rec.tSettle && t <= rec.tEnd && r.status !== 'lost') { rec.seen++; if (r.status === 'blink') rec.blinked++; }
    }
  }
  person.setShift({});
  return { recs, count };
}

// ----------------------------------------------------------------------------- metrics
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
function quantile(a, p) { const s = [...a].sort((x, y) => x - y), i = p * (s.length - 1), lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); }
const sdev = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };

/** groups: one array of [ex, ey] per target. Flat {key: number}; keys are missing when there is no data. */
function levelStats(prefix, groups, out) {
  const all = groups.flat();
  out[`n.${prefix}`] = all.length;
  if (!all.length) return;
  const ax = { x: all.map((e) => e[0]), y: all.map((e) => e[1]) }, eu = all.map((e) => Math.hypot(e[0], e[1]));
  for (const k of ['x', 'y']) {
    const abs = ax[k].map(Math.abs), i = k === 'x' ? 0 : 1;
    const full = groups.filter((g) => g.length >= 2);
    out[`${prefix}.${k}.med`] = quantile(abs, 0.5); out[`${prefix}.${k}.rms`] = rms(ax[k]); out[`${prefix}.${k}.p90`] = quantile(abs, 0.9);
    out[`${prefix}.${k}.bias`] = mean(ax[k]);                                  // mean signed error over everything
    // bias vs precision, the way the tracker's own accuracy figure splits them:
    if (full.length) {
      out[`${prefix}.${k}.acc`] = rms(full.map((g) => mean(g.map((e) => e[i]))));   // RMS over targets of each target's mean error
      out[`${prefix}.${k}.prec`] = mean(full.map((g) => sdev(g.map((e) => e[i]))));  // mean over targets of the scatter around that mean
    }
  }
  out[`${prefix}.e.med`] = quantile(eu, 0.5); out[`${prefix}.e.rms`] = rms(eu); out[`${prefix}.e.p90`] = quantile(eu, 0.9);
  // Would the vertical error land on the right line of text? exact: within half a line pitch; band: within the line above or below too.
  for (const p of PITCHES) {
    out[`line.${prefix}.exact.${p}`] = mean(ax.y.map((e) => (Math.abs(e) < p / 2 ? 1 : 0)));
    out[`line.${prefix}.band.${p}`] = mean(ax.y.map((e) => (Math.abs(e) < 1.5 * p ? 1 : 0)));
  }
}

/** One or more blocks (pooled) -> flat metrics. */
export function score(blocks, accuracy) {
  const recs = blocks.flatMap((b) => b.recs), out = {};
  levelStats('frame', recs.map((r) => r.frames), out);
  levelStats('fix', recs.map((r) => r.fixes), out);
  const c = { frames: 0, lost: 0, gated: 0, blink: 0, used: 0, ms: 0, fixMs: 0 };
  for (const b of blocks) for (const k of Object.keys(c)) c[k] += b.count[k];
  out['share.lost'] = c.lost / c.frames; out['share.blink'] = c.blink / c.frames; out['share.gated'] = c.gated / c.frames;
  out['share.used'] = c.used / c.frames; out['share.fixTime'] = c.ms ? c.fixMs / c.ms : 0;   // share of the time that ended up inside a fixation
  // frames skipped as blinks while a target on the bottom row (90 % down the page) was looked at, against the other rows
  const sum = (rows, k) => rows.reduce((a, r) => a + (r[k] || 0), 0), bot = recs.filter((r) => r.bottom), top = recs.filter((r) => r.bottom === false);
  if (sum(bot, 'seen')) out['share.blinkBottom'] = sum(bot, 'blinked') / sum(bot, 'seen');
  if (sum(top, 'seen')) out['share.blinkOther'] = sum(top, 'blinked') / sum(top, 'seen');
  if (accuracy) {
    out['claim.effX'] = accuracy.effX; out['claim.effY'] = accuracy.effY;
    // above 1: the tracker is worse than it says on the "Calibration done" card
    if (isNum(out['fix.x.rms'])) { out['claim.ratioX'] = out['fix.x.rms'] / Math.max(1, accuracy.effX); out['claim.ratioY'] = out['fix.y.rms'] / Math.max(1, accuracy.effY); }
  }
  return out;
}

function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
/**
 * Median and a percentile-bootstrap 95 % interval of the median, over seeds.
 * `tag` seeds the resampling, so a cell's interval does not depend on which other rows were run.
 */
export function summarize(values, tag, B = 1000) {
  const rng = mkRng(hash(String(tag)));
  const v = values.filter(isNum);
  if (!v.length) return { med: null, lo: null, hi: null, n: 0 };
  const med = quantile(v, 0.5);
  if (v.length < 3) return { med, lo: null, hi: null, n: v.length };
  const meds = new Float64Array(B), s = new Float64Array(v.length);
  for (let b = 0; b < B; b++) { for (let i = 0; i < v.length; i++) s[i] = v[Math.floor(rng.u() * v.length)]; meds[b] = quantile(Array.from(s), 0.5); }
  const sorted = Array.from(meds).sort((a, b) => a - b);
  return { med, lo: sorted[Math.floor(0.025 * (B - 1))], hi: sorted[Math.ceil(0.975 * (B - 1))], n: v.length };
}

// ----------------------------------------------------------------------------- one synthetic person, all conditions
/**
 * @param make  (seed, fps) => person (World interface)
 * @returns {{seed, failed?:string, cal?:object, cond?:{[name]: {metrics, subs:{[name]: metrics}}}}}
 */
export function runSeed(make, seed, calOpts, cal = {}) {
  // cal: {proc, who} runs the procedure (proc: CalibrationRun options); {old:true, move} is the fixed loop of steps 1 and 2
  if (typeof cal === 'boolean') cal = { old: true, move: cal };
  const out = { seed, cond: {}, cal: {} };
  const order = (rng) => { const a = TEST_GRID.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng.u() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const sessions = new Map();   // one calibration per frame rate
  for (const cond of CONDITIONS) {
    const fps = cond.fps || 30;
    if (!sessions.has(fps)) {
      const rng = mkRng(seed * 104729 + fps), person = make(seed, fps);
      let fit = null, error = null;
      try { fit = cal.old ? calibrate(person, rng, calOpts, { move: !!cal.move }) : runProcedure(person, rng, cal.proc || {}, calOpts, cal.who || {}); } catch (e) { error = e.message; }
      sessions.set(fps, { rng, person, fit, error });
      out.cal[fps] = fit ? { accuracy: fit.accuracy, lambda: fit.model.lambda, cvErr: fit.model.cvErr, kind: fit.kind, shootout: fit.shootout, nTrain: fit.train.X.length, nCollected: fit.perDot.reduce((a, d) => a + d.n, 0), procedure: fit.procedure || null } : { error };
    }
    const S = sessions.get(fps);
    if (!S.fit) { out.cond[cond.name] = { failed: S.error }; continue; }
    const blocks = cond.subs.map((sub) => runBlock(S.person, S.fit, order(S.rng), S.rng, { ...sub, blinks: (cal.proc && cal.proc.blinks) || (cal.old ? 'flag' : 'lids'), gate: !(cal.proc && cal.proc.gate === false), dispersion: (cal.proc && cal.proc.dispersion) || null }));
    out.cond[cond.name] = { kind: S.fit.kind, metrics: score(blocks, S.fit.accuracy), subs: Object.fromEntries(cond.subs.map((sub, i) => [sub.name, score([blocks[i]], S.fit.accuracy)])) };
  }
  return out;
}

// ----------------------------------------------------------------------------- head gate sweep (step 3d)
export const SWEEP = {
  x: { unit: 'cm', what: 'sideways', mags: [1, 2, 3, 4, 6, 8, 12], shift: (v) => ({ x: v }) },
  y: { unit: 'cm', what: 'down (+) or up (-)', mags: [1, 2, 3, 4, 6, 8], shift: (v) => ({ y: v }) },
  z: { unit: 'cm', what: 'back (+) or forward (-)', mags: [2, 4, 6, 8, 12, 16], shift: (v) => ({ z: v }) },
  yaw: { unit: 'deg', what: 'turn', mags: [2, 4, 6, 8, 10, 15, 20], shift: (v) => ({ yaw: v * D2R }) },
  pitch: { unit: 'deg', what: 'nod', mags: [2, 4, 6, 8, 10, 15, 20], shift: (v) => ({ pitch: v * D2R }) },
  roll: { unit: 'deg', what: 'tilt', mags: [2, 4, 6, 8, 10, 15, 20], shift: (v) => ({ roll: v * D2R }) },
};
/**
 * How the error of a calibrated model grows as the head leaves the calibration posture, with the
 * head gate switched off. Per axis and size: the median over seeds of the fixation RMS error and of
 * its ratio to the same person's error in the calibration posture (the worse of the two directions);
 * `doubles` is the size at which that ratio reaches 2 (interpolated), or null when it never does.
 */
export function gateSweep({ seeds, noisePx = 0.5, model = 'auto', set = {}, log = () => {} }) {
  const calOpts = { featureCount: 25, trim: true, model };
  const S = seeds.map((seed) => {
    const rng = mkRng(seed * 104729 + 30), person = new Person3D({ ...set, seed, noisePx });
    let fit = null; try { fit = runProcedure(person, rng, {}, calOpts, {}); } catch { /* counted below */ }
    return { seed, rng, person, fit };
  }).filter((s) => s.fit);
  const err = (s, shift) => { const b = runBlock(s.person, s.fit, TEST_GRID, s.rng, { shift, gate: false }); return score([b], s.fit.accuracy)['fix.e.rms']; };
  const base = S.map((s) => err(s, null));
  const out = { model, models: modelCounts(S.map((s) => s.fit.kind)), seeds: S.length, still: quantile(base, 0.5), axes: {} };
  for (const [name, ax] of Object.entries(SWEEP)) {
    const rows = ax.mags.map((mag) => {
      const e = S.map((s) => Math.max(err(s, ax.shift(mag)), err(s, ax.shift(-mag))));
      return { mag, err: quantile(e.filter(isNum), 0.5), ratio: quantile(e.map((v, i) => v / base[i]).filter(isNum), 0.5) };
    });
    let doubles = null, prev = { mag: 0, ratio: 1 };
    for (const r of rows) { if (r.ratio >= 2) { doubles = prev.mag + (r.mag - prev.mag) * (2 - prev.ratio) / (r.ratio - prev.ratio); break; } prev = r; }
    out.axes[name] = { unit: ax.unit, what: ax.what, rows, doubles };
    log(`sweep ${model} ${name} done`);
  }
  return out;
}
export function renderSweep(W) {
  const L = [`== HEAD GATE SWEEP, model ${W.model} (in use: ${W.models}); SYNTH-3D at 0.5 px, ${W.seeds} seeds, gate off   [${CAVEAT}]`,
    `   fixation RMS px in the calibration posture: ${n1(W.still)} (median). Cells: median error px / ratio to that person's own still error (worse direction).`];
  for (const [name, ax] of Object.entries(W.axes)) L.push(`   ${pad(name + ' (' + ax.what + ')', 30)} ${ax.rows.map((r) => `${r.mag} ${ax.unit}: ${n0(r.err)} / x${n2(r.ratio)}`).join('   ')}   -> doubles at ${ax.doubles === null ? 'more than ' + ax.rows[ax.rows.length - 1].mag : n1(ax.doubles)} ${ax.unit}`);
  return L.join('\n');
}

// ----------------------------------------------------------------------------- click refinement (step 3f)
/**
 * What clicks do to a calibrated model, with and without the gate (C.clickUsable). After the
 * calibration the person clicks `clicks` times at random places; with probability `pOn` the eyes
 * are on the click, otherwise somewhere else on the screen (assumed). The frames around every
 * click (the old rule) or around the clicks the gate lets through are added and the model refitted;
 * all three models then predict the same frames of a 13-target block. Frame-level RMS error, px.
 */
export function clickBench({ seeds, noisePx = 0.5, clicks = 12, pOn = 0.6, set = {} }) {
  const rows = seeds.map((seed) => {
    const rng = mkRng(seed * 104729 + 30), cr = mkRng(seed * 331 + 5), person = new Person3D({ ...set, seed, noisePx }), vp = person.o.viewport;
    let fit; try { fit = runProcedure(person, rng, {}, { featureCount: 25, trim: true, model: 'auto' }, {}); } catch { return null; }
    const tr = new Tracker(fit), P = C.trackingParams(fit.accuracy), all = [], gated = [];
    let on = 0, onUsed = 0, off = 0, offUsed = 0;
    for (let k = 0; k < clicks; k++) {
      const click = { x: cr.U(0.05, 0.95) * vp.w, y: cr.U(0.05, 0.95) * vp.h }, eyesOn = cr.u() < pOn;
      let eye = click; if (!eyesOn) { do { eye = { x: cr.U(0.05, 0.95) * vp.w, y: cr.U(0.05, 0.95) * vp.h }; } while (Math.hypot(eye.x - click.x, eye.y - click.y) < 250); }
      const recent = [], tEnd = person.t + cr.U(500, 900);
      let t = person.t;
      while (person.t < tEnd) { t = person.tick(); const fr = person.frame(t, eye.x, eye.y), r = tr.push(fr, t); if (r.status === 'ok') { recent.push({ f: fr.f, t }); if (recent.length > 6) recent.shift(); } }
      const fresh = recent.filter((q) => t - q.t < 200); if (fresh.length < 2) continue;
      const preds = fresh.map((q) => fit.model.predict(q.f)), pred = { x: mean(preds.map((p) => p[0])), y: mean(preds.map((p) => p[1])) }, fx = tr.fix.current(t);
      const usable = C.clickUsable({ click, pred, sx: P.sx, sy: P.sy, fixating: !!fx && fx.dur >= tr.fix.minDur });
      if (eyesOn) { on++; if (usable) onUsed++; } else { off++; if (usable) offUsed++; }
      for (const q of fresh) { all.push({ f: q.f, y: [click.x, click.y] }); if (usable) gated.push({ f: q.f, y: [click.x, click.y] }); }
    }
    const refit = (extra) => (extra.length ? C.refitModel(fit.model, fit.train.X.concat(extra.map((q) => q.f)), fit.train.Y.concat(extra.map((q) => q.y)), fit.train.G.concat(extra.map(() => 'click'))) : fit.model);
    const models = { none: fit.model, all: refit(all), gated: refit(gated) }, se = { none: 0, all: 0, gated: 0 };
    let n = 0;
    for (const p of TEST_GRID) {
      const x = p[0] * vp.w, y = p[1] * vp.h, t0 = person.t;
      while (person.t < t0 + VALIDATE.settleMs + VALIDATE.dwellMs) {
        const t = person.tick(), fr = person.frame(t, x, y);
        if (t < t0 + VALIDATE.settleMs || !fr.face || fr.blink) continue;
        n++; for (const k of Object.keys(models)) { const q = models[k].predict(fr.f); se[k] += (q[0] - x) ** 2 + (q[1] - y) ** 2; }
      }
    }
    return { seed, none: Math.sqrt(se.none / n), all: Math.sqrt(se.all / n), gated: Math.sqrt(se.gated / n), on, onUsed, off, offUsed };
  }).filter(Boolean);
  const med = (k) => quantile(rows.map((r) => r[k]), 0.5), sum = (k) => rows.reduce((a, r) => a + r[k], 0);
  return { seeds: rows.length, clicks, pOn, none: med('none'), all: med('all'), gated: med('gated'), meanNone: mean(rows.map((r) => r.none)), meanAll: mean(rows.map((r) => r.all)), meanGated: mean(rows.map((r) => r.gated)), usedOn: sum('onUsed') / Math.max(1, sum('on')), usedOff: sum('offUsed') / Math.max(1, sum('off')) };
}
export function renderClicks(K) {
  return [`== CLICK REFINEMENT: ${K.clicks} clicks after the calibration, the eyes on the click for ${Math.round(100 * K.pOn)} % of them (assumed); SYNTH-3D at 0.5 px, ${K.seeds} seeds   [${CAVEAT}]`,
    `   frame-level RMS error px on 13 targets afterwards, median over seeds (mean):`,
    `   no clicks used            ${n1(K.none)} (${n1(K.meanNone)})`,
    `   every click used (before) ${n1(K.all)} (${n1(K.meanAll)})`,
    `   gated clicks (now)        ${n1(K.gated)} (${n1(K.meanGated)})`,
    `   the gate let through ${pc(K.usedOn)} of the clicks with the eyes on them and ${pc(K.usedOff)} of the clicks with the eyes elsewhere`].join('\n');
}

const SOURCES = {
  'SYNTH-3D': {
    what: 'geometric head, eyeballs and pinhole camera (tests/bench/synth3d.mjs) through the real extractFeatures',
    levels: (noise, set) => noise.map((n) => ({ label: `${n.toFixed(1)} px`, key: String(n), make: (seed, fps) => new Person3D({ ...set, seed, fps, noisePx: n }) })),
  },
  'SYNTH-FEATURE': {
    what: 'the lab feature-level person (tests/lab/lib/synth.mjs World), its own noise model at scale 1',
    levels: () => [{ label: 'lab x1', key: 'lab', make: (seed, fps) => new World({ seed, fps, camera: { width: 1280, height: 720, frameRate: fps }, viewport: PROFILE.viewport, screen: PROFILE.screen }) }],
  },
};

// ----------------------------------------------------------------------------- recordings (fixtures, real)
function loadJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
const started = (rec) => (typeof rec.startedAt === 'number' ? rec.startedAt : Date.parse(rec.startedAt) || 0);
const hasModel = (rec) => !!(rec && rec.dump && rec.dump.model && Array.isArray(rec.dump.model.keep) && Array.isArray(rec.dump.model.wx));

/**
 * Score every recording in a folder that has targets: the recorded camera frames go through the
 * model that was live when they were recorded (its own dump, else the newest earlier dump in the
 * folder) and the same frame loop as above.
 * @returns {{files:number, rows:Array<{file, phase, calFrom, metrics}>, skipped:string[]}}
 */
export function scoreRecordings(dir) {
  let names = []; try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { /* no folder */ }
  const recs = names.map((name) => ({ name, rec: loadJson(path.join(dir, name)) })).filter((r) => r.rec && typeof r.rec === 'object');
  const rows = [], skipped = [];
  for (const { name, rec } of recs) {
    const targets = (Array.isArray(rec.truth) ? rec.truth : []).filter((e) => e && e.kind === 'target' && isNum(e.x) && isNum(e.y) && isNum(e.tEnd) && (isNum(e.tSettle) || isNum(e.tShow)));
    if (!targets.length) { skipped.push(`${name}: no targets`); continue; }
    let cal = hasModel(rec) ? { name, rec } : null;
    if (!cal) cal = recs.filter((r) => r.name !== name && hasModel(r.rec) && started(r.rec) <= started(rec)).sort((a, b) => started(b.rec) - started(a.rec))[0] || null;
    if (!cal) { skipped.push(`${name}: no calibration (no dump.model here or in an earlier recording)`); continue; }
    const dump = cal.rec.dump, model = C.Ridge.fromJSON(dump.model), width = model.inputWidth;
    const raw = (Array.isArray(rec.events) ? rec.events : []).filter((e) => e && e.k === 'raw' && isNum(e.t)).sort((a, b) => a.t - b.t);
    if (!raw.some((e) => Array.isArray(e.f) && e.f.length >= width)) { skipped.push(`${name}: no raw camera frames wide enough for the model`); continue; }
    const tr = new Tracker({ model, calibHead: dump.calibHead, accuracy: dump.accuracy });
    const phases = new Map();
    const block = (ph) => phases.get(ph) || phases.set(ph, { recs: [], count: { frames: 0, lost: 0, gated: 0, blink: 0, used: 0, fixes: 0, ms: 0, fixMs: 0 } }).get(ph);
    let prevT = null;
    const wins = targets.map((e) => ({ x: e.x, y: e.y, tSettle: isNum(e.tSettle) ? e.tSettle : e.tShow + 700, tEnd: e.tEnd, phase: e.phase || 'all', frames: [], fixes: [] }));
    for (const w of wins) block(w.phase).recs.push(w);
    for (const e of raw) {
      const ok = e.face !== false && Array.isArray(e.f) && e.f.length >= width && e.head;
      const r = tr.push(ok ? { face: true, blink: !!e.blink, f: e.f, head: e.head } : { face: false }, e.t);
      const w = wins.find((q) => e.t >= q.tSettle && e.t <= q.tEnd), near = w || wins.find((q) => e.t <= q.tEnd) || wins[wins.length - 1];
      const c = block(near.phase).count;
      c.frames++; c[r.status === 'ok' ? 'used' : r.status]++;
      if (prevT !== null && e.t - prevT < 1000) c.ms += e.t - prevT;
      prevT = e.t;
      if (r.status === 'ok' && w) w.frames.push([r.x - w.x, r.y - w.y]);
      if (r.fix) { c.fixMs += r.fix.dur; c.fixes++; const fw = wins.find((q) => r.fix.t >= q.tSettle && r.fix.t + r.fix.dur <= q.tEnd); if (fw) fw.fixes.push([r.fix.x - fw.x, r.fix.y - fw.y]); }
    }
    // session: the calibration the recording was made on (the lab writes it since step 4), so that one sitting's files can be told from another's
    for (const [phase, b] of phases) rows.push({ file: name, phase, calFrom: cal.name, session: (rec.session && rec.session.id) || null, metrics: score([b], dump.accuracy) });
  }
  return { files: names.length, rows, skipped };
}

/** What the calibration procedure did over the 30 fps calibrations of these runs: seconds, dots shown again, failures. */
function procedureSummary(runs) {
  const P = runs.map((r) => r.cal[30] && r.cal[30].procedure).filter(Boolean), failed = runs.filter((r) => r.cal[30] && r.cal[30].error).length;
  if (!P.length) return { failed, n: 0 };
  const sec = P.map((p) => p.ms / 1000);
  return { failed, n: P.length, secMed: quantile(sec, 0.5), secMax: Math.max(...sec), reshown: mean(P.map((p) => p.reshown.length)), unsettled: mean(P.map((p) => p.unsettled)) };
}
/** Median unseen-dot error per model over the 30 fps calibrations of these runs. */
function shootoutSummary(runs) {
  const by = {};
  for (const r of runs) { const s = r.cal[30] && r.cal[30].shootout; if (s) for (const [k, v] of Object.entries(s.eff)) if (isNum(v)) (by[k] = by[k] || []).push(v); }
  return Object.fromEntries(Object.entries(by).map(([k, v]) => [k, quantile(v, 0.5)]));
}

// ----------------------------------------------------------------------------- the whole benchmark
/** Which models the calibrations of these runs ended up with, e.g. "A 14, E 6". */
function modelCounts(kinds) {
  const c = {}; for (const k of kinds) if (k) c[k] = (c[k] || 0) + 1;
  return Object.keys(c).sort().map((k) => `${k} ${c[k]}`).join(', ');
}
/** The runs of one source and noise level -> one row per condition. `tag` seeds the bootstrap. */
function conditionRows(runs, source, level, tag0 = '') {
  return CONDITIONS.map((cond) => {
    const ok = runs.filter((r) => r.cond[cond.name].metrics);
    const keys = [...new Set(ok.flatMap((r) => Object.keys(r.cond[cond.name].metrics)))].sort();
    const tag = `${tag0}${source}|${level.key}|${cond.name}|`;
    const metrics = Object.fromEntries(keys.map((k) => [k, summarize(ok.map((r) => r.cond[cond.name].metrics[k]), tag + k)]));
    const subs = Object.fromEntries(cond.subs.map((sub) => [sub.name, Object.fromEntries(['fix.e.rms', 'fix.x.rms', 'fix.y.rms', 'frame.e.rms', 'share.gated'].map((k) => [k, summarize(ok.map((r) => r.cond[cond.name].subs[sub.name][k]), tag + sub.name + '|' + k)]))]));
    return { source, level: level.label, levelKey: level.key, condition: cond.name, seeds: runs.length, calibrationFailed: runs.length - ok.length, models: modelCounts(ok.map((r) => r.cond[cond.name].kind)), metrics, subs };
  });
}
/** PRIMARY SCORES, fixed: fixation-level euclidean RMS, px, SYNTH-3D at 0.5 px iris noise, median over seeds. */
function primaryOf(runs, tag0 = '') {
  const m = (r, c) => (r.cond[c] && r.cond[c].metrics ? r.cond[c].metrics['fix.e.rms'] : NaN);
  const still = runs.map((r) => m(r, 'STILL')), move = runs.map((r) => (m(r, 'HEAD-SHIFT') + m(r, 'HEAD-ROTATE')) / 2);
  return {
    primary: runs.length ? { S_still: summarize(still, tag0 + 'S_still'), S_move: summarize(move, tag0 + 'S_move') } : null,
    perSeed: runs.map((r, i) => ({ seed: r.seed, S_still: isNum(still[i]) ? still[i] : null, S_move: isNum(move[i]) ? move[i] : null })),
  };
}
// The other ways the same people could have been calibrated and tracked, at 0.5 px on SYNTH-3D.
export const VARIANTS = [
  { name: 'procedure, model A forced', model: 'A' },
  { name: 'procedure, the reader keeps the head still in the head segment', who: { headDeg: 0, headCm: 0 } },
  { name: 'procedure, careless reader', who: SLOPPY },
  { name: 'step 2 calibration, careless reader', proc: PROC_OLD, fit: FIT_OLD, who: SLOPPY },
  { name: 'step 2 calibration (the fixed loop, validation dots folded in)', old: true, fit: { fold: true, score: 'val' } },
];

/**
 * cal: 'proc' (ships) runs the calibration procedure (C.CalibrationRun); 'still' and 'move' are the fixed
 * loop of steps 1 and 2 (move: the head sways during the dots). proc: CalibrationRun options, who: how the
 * synthetic person behaves in the procedure (WHO), fit: more fitCalibration options.
 */
export const RECORDINGS_DIR = path.join(LAB_DIR, 'recordings');
/** scoreRecordings() of a folder, with the folder's name as it is printed. */
export function scoreReal(dir = RECORDINGS_DIR) {
  const given = path.resolve(dir) !== path.resolve(RECORDINGS_DIR);
  return { ...scoreRecordings(dir), dir: given ? path.resolve(dir).replace(/\\/g, '/') : 'tests/lab/recordings', given };
}
export function runBench({ seeds, noise, features = 25, trim = true, set = {}, model = 'auto', cal = 'proc', proc = null, who = null, fit = null, hygiene = null, columns = null, variants = true, recordings = RECORDINGS_DIR, log = () => {} }) {
  const calOpts = { featureCount: features, trim, model: columns ? 'A' : model, ...(hygiene ? { hygiene } : {}), ...(columns ? { columns } : {}), ...(fit || {}) };
  const standard = features === 25 && trim && model === 'auto' && cal === 'proc' && !proc && !who && !fit && !hygiene && !columns;
  const how = cal === 'proc' ? { proc: proc || {}, who: who || {} } : { old: true, move: cal === 'move' };
  const rows = [], perSeed = {};
  for (const [source, def] of Object.entries(SOURCES)) {
    for (const level of def.levels(noise, set)) {
      const runs = seeds.map((seed) => runSeed(level.make, seed, calOpts, how));
      perSeed[`${source}|${level.key}`] = runs;
      rows.push(...conditionRows(runs, source, level));
      log(`${source} ${level.label} done`);
    }
  }
  const { primary, perSeed: primaryPerSeed } = primaryOf(perSeed['SYNTH-3D|0.5'] || []);
  // The same synthetic people under the other models and calibrations (only next to the standard run).
  const variantRows = [];
  const lvl = SOURCES['SYNTH-3D'].levels([0.5], set)[0];
  if (variants && standard && perSeed['SYNTH-3D|0.5']) {
    const add = (name, runs, tag) => variantRows.push({ name, ...primaryOf(runs, tag), rows: conditionRows(runs, 'SYNTH-3D', lvl, tag), models: modelCounts(runs.map((r) => r.cal[30] && r.cal[30].kind)), shootout: shootoutSummary(runs), procedure: procedureSummary(runs) });
    add('procedure, shoot-out (as shipped: the standard run above)', perSeed['SYNTH-3D|0.5'], '');
    for (const v of VARIANTS) { add(v.name, seeds.map((seed) => runSeed(lvl.make, seed, { ...calOpts, model: v.model || 'auto', ...(v.fit || {}) }, v.old ? { old: true } : { proc: v.proc || {}, who: v.who || {} })), v.name + '|'); log(`variant ${v.name} done`); }
  }
  const calibration = Object.fromEntries(Object.entries(perSeed).map(([k, runs]) => [k, runs.map((r) => ({ seed: r.seed, ...r.cal }))]));
  const fixtures = scoreRecordings(path.join(LAB_DIR, 'fixtures'));
  const real = scoreReal(recordings);
  return {
    caveat: CAVEAT, variants: variantRows.map(({ perSeed: _drop, ...v }) => v),
    config: { model, cal, proc, who, fit, hygiene, columns, standard, features, trim, seeds, noisePx: noise, set, profile: PROFILE, pxPerDeg: PX_PER_DEG, pitches: PITCHES, calibration: READER, validate: VALIDATE, conditions: CONDITIONS.map((c) => ({ name: c.name, what: c.what, runs: c.subs.map((s) => s.name) })) },
    primary, primaryDefinition: 'S_still = median over seeds of the fixation-level euclidean RMS error (CSS px) in SYNTH-3D STILL at 0.5 px iris noise; S_move = the same for the mean of HEAD-SHIFT and HEAD-ROTATE',
    primaryPerSeed, rows, calibration, fixtures, real,
  };
}

// ----------------------------------------------------------------------------- printing
const n0 = (v) => (isNum(v) ? String(Math.round(v)) : '-');
const n1 = (v) => (isNum(v) ? v.toFixed(1) : '-');
const n2 = (v) => (isNum(v) ? v.toFixed(2) : '-');
const pc = (v) => (isNum(v) ? (100 * v).toFixed(0) + '%' : '-');
const ci = (s, f = n1) => (s && isNum(s.med) ? `${f(s.med)} [${f(s.lo)}, ${f(s.hi)}]` : '-');
const pad = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);
function table(head, lines) {
  const w = head.map((h, i) => Math.max(h.length, ...lines.map((l) => String(l[i]).length)));
  return [head, ...lines].map((l) => l.map((c, i) => (i < 2 ? pad(c, w[i]) : padL(c, w[i]))).join('  ')).join('\n');
}
const M = (row, k) => (row.metrics[k] ? row.metrics[k].med : null);

function accuracyTable(rows) {
  const head = ['noise', 'condition', 'fix RMS px [95% CI]', 'deg*', 'fix med', 'fix p90', 'frame RMS', 'fix x RMS', 'fix y RMS', 'bias x', 'bias y', 'scatter x/y', 'claimed x/y', 'x off by', 'y off by', 'gated', 'blink', 'in fix', 'n', 'model'];
  return table(head, rows.map((r) => [r.level, r.condition, ci(r.metrics['fix.e.rms']), n2(M(r, 'fix.e.rms') / PX_PER_DEG), n1(M(r, 'fix.e.med')), n1(M(r, 'fix.e.p90')), n1(M(r, 'frame.e.rms')), n1(M(r, 'fix.x.rms')), n1(M(r, 'fix.y.rms')),
    n1(M(r, 'fix.x.acc')), n1(M(r, 'fix.y.acc')), `${n0(M(r, 'frame.x.prec'))}/${n0(M(r, 'frame.y.prec'))}`, `${n0(M(r, 'claim.effX'))}/${n0(M(r, 'claim.effY'))}`, 'x' + n2(M(r, 'claim.ratioX')), 'x' + n2(M(r, 'claim.ratioY')), pc(M(r, 'share.gated')), pc(M(r, 'share.blink')), pc(M(r, 'share.fixTime')),
    r.calibrationFailed ? `${r.seeds - r.calibrationFailed}/${r.seeds}` : String(r.seeds), r.models || '-']));
}
function variantTable(V) {
  const f = (v) => v.rows.map((r) => n1(M(r, 'fix.e.rms')));
  const lodo = (v) => Object.keys(v.shootout).sort().map((k) => `${k} ${n1(v.shootout[k])}`).join(', ') || '-';
  const gated = (v) => v.rows.slice(0, 4).map((r) => pc(M(r, 'share.gated'))).join(' ');
  const claim = (v) => { const r = v.rows[0]; return `${n0(M(r, 'claim.effY'))} / ${n1(M(r, 'fix.y.rms'))}`; };
  const proc = (v) => { const p = v.procedure; return p && p.n ? `${n1(p.secMed)} / ${n1(p.secMax)} s, ${n1(p.reshown)} again` : '-'; };
  return table(['calibration and model', 'model in use', 'S_still [95% CI]', 'S_move [95% CI]', ...CONDITIONS.map((c) => c.name), 'gated (first four)', 'claimed y / measured', 'failed', 'time med / max', 'unseen-dot error by model'],
    V.map((v) => [v.name, v.models || '-', ci(v.primary && v.primary.S_still), ci(v.primary && v.primary.S_move), ...f(v), gated(v), claim(v), String(v.procedure ? v.procedure.failed : '-'), proc(v), lodo(v)]));
}
function lineTable(rows, level) {
  const head = ['noise', 'condition', ...PITCHES.map((p) => `${p}px fix`), ...PITCHES.map((p) => `${p}px frame`)];
  return table(head, rows.map((r) => [r.level, r.condition, ...PITCHES.map((p) => `${pc(M(r, `line.fix.exact.${p}`))}/${pc(M(r, `line.fix.band.${p}`))}`), ...PITCHES.map((p) => `${pc(M(r, `line.frame.exact.${p}`))}/${pc(M(r, `line.frame.band.${p}`))}`)]));
}
function recordingTable(rows) {
  const head = ['file', 'phase', 'fix RMS px', 'deg*', 'fix med', 'frame RMS', 'fix x RMS', 'fix y RMS', 'claimed x/y', 'gated', 'blink', 'fixations'];
  return table(head, rows.map((r) => { const m = r.metrics; return [r.file, r.phase, n1(m['fix.e.rms']), n2(m['fix.e.rms'] / PX_PER_DEG), n1(m['fix.e.med']), n1(m['frame.e.rms']), n1(m['fix.x.rms']), n1(m['fix.y.rms']), `${n0(m['claim.effX'])}/${n0(m['claim.effY'])}`, pc(m['share.gated']), pc(m['share.blink']), String(m['n.fix'])]; }));
}

/** The REAL rows: lab recordings, scored through the model that was live when they were made. */
export function renderReal(real) {
  const dir = real.dir || 'tests/lab/recordings';
  if (!real.files) return real.given ? `REAL: no recordings in ${dir}` : 'REAL: no recordings';
  if (!real.rows.length) return [`REAL: ${real.files} file(s) in ${dir}, none with targets and a usable calibration`, ...real.skipped.map((s) => '   ' + s)].join('\n');
  // (a folder given with --recordings may hold anything, synthetic fixtures included: its rows are as real as its files)
  const what = real.given ? 'given with --recordings: the rows are as real as the files in it' : 'a real camera';
  return [`== REAL: recordings from ${dir} (${what}; one session each, no interval; deg* still assumes the profile above)`, recordingTable(real.rows), ...real.skipped.map((s) => '   skipped ' + s)].join('\n');
}

export function render(R) {
  const L = [], c = R.config;
  const extra = (c.hygiene ? `, hygiene ${JSON.stringify(c.hygiene)}` : '') + (c.columns ? `, model A on columns ${c.columns.join(' ')}` : '');
  L.push(`GAZE BENCH   tracker variant: features ${c.features}, trim ${c.trim ? 'on' : 'off'}, model ${c.columns ? 'A' : c.model}, calibration ${c.cal === 'move' ? 'fixed loop with head sway (step 2)' : c.cal === 'still' ? 'fixed loop (step 2)' : 'procedure'}${c.proc ? ' ' + JSON.stringify(c.proc) : ''}${c.who ? ', person ' + JSON.stringify(c.who) : ''}${c.fit ? ', fit ' + JSON.stringify(c.fit) : ''}${extra}${c.standard ? ' (as shipped)' : ''}   ${c.seeds.length} seeds (${c.seeds[0]}..${c.seeds[c.seeds.length - 1]})   iris noise ${c.noisePx.join(' / ')} px`);
  if (c.set && Object.keys(c.set).length) L.push(`SYNTH-3D person changed with --set: ${JSON.stringify(c.set)}   (not the standard benchmark: do not compare its scores with the baseline)`);
  L.push(`Each seed: the reader's calibration procedure (C.CalibrationRun: 13 + 5 dots sampled once the eyes have stopped, doubtful dots shown again, the head segment; then fitCalibration with the model shoot-out), then ${TEST_GRID.length} held-out targets per run; blink skip, head gate, FixationDetector as in gaze-reader.js.`);
  L.push(`The standard synthetic person does as told in the calibration: eyes on each dot within a third of a second, and in the head segment a head turn of about ${WHO.headDeg} degrees and ${WHO.headCm} cm (assumed).`);
  L.push(`"claimed" is the calibration card's effX/effY: the shipped model's error on the five validation dots, which it was not trained on. Compare "claimed x/y" with "fix x RMS" / "fix y RMS" (the "off by" columns are measured / claimed).`);
  L.push(`"gated" frames are thrown away by the head gate (HEAD_GATE in gaze-core.js): a row with many of them is scored on the few frames that were let through, or on none ("-").`);
  L.push(`Cells are the median over seeds; [..] is a bootstrap 95 % interval of that median. Errors in CSS px against the target.`);
  L.push(`deg* = px / ${PX_PER_DEG.toFixed(1)}: ASSUMED ${c.profile.screenDiagIn} inch ${c.profile.screen.w}x${c.profile.screen.h} screen at ${c.profile.distanceCm} cm, not measured.`);
  L.push(`bias x/y = RMS over targets of each target's mean error; "claimed" = effX/effY from the calibration card; "off by" = measured fixation RMS / claimed (above 1: worse than claimed).`);
  L.push(`scatter x/y = mean over targets of the frame-to-frame SD; gated = frames the head-moved pause threw away; blink = frames skipped as blinks; in fix = share of the time inside an emitted fixation; n = seeds with a calibration.`);
  L.push(`model = which gaze model the calibrations ended up with, and for how many seeds: A the 25-input ridge, B/C/E the head-frame models (E: A's inputs in the head frame plus the geometric head-pose correction).`);
  for (const [source, def] of Object.entries(SOURCES)) {
    const rows = R.rows.filter((r) => r.source === source);
    L.push('', `== ${source}: accuracy   [${CAVEAT}]`, `   ${def.what}`, accuracyTable(rows));
    L.push('', `== ${source}: would the vertical error land on the right line? exact line / 3-line band, by line pitch   [${CAVEAT}]`, lineTable(rows));
  }
  const sub = R.rows.filter((r) => r.source === 'SYNTH-3D' && Object.keys(r.subs).length > 1);
  if (sub.length) {
    L.push('', `== SYNTH-3D: the pooled movement rows, run by run (fixation RMS px)   [${CAVEAT}]`);
    L.push(table(['noise', 'condition', 'run', 'fix RMS px [95% CI]', 'fix x RMS', 'fix y RMS', 'gated'], sub.flatMap((r) => Object.entries(r.subs).map(([name, s]) => [r.level, r.condition, name, ci(s['fix.e.rms']), n1(s['fix.x.rms'].med), n1(s['fix.y.rms'].med), pc(s['share.gated'].med)]))));
  }
  if (R.variants && R.variants.length) {
    L.push('', `== SYNTH-3D at 0.5 px: the same ${c.seeds.length} people under other models and calibrations (fixation RMS px)   [${CAVEAT}]`);
    L.push(`   careless reader: ${Math.round(100 * SLOPPY.late)} % of dots reached 0.8 to 1.6 s late, ${Math.round(100 * SLOPPY.bad)} % not looked at on their first showing, ${Math.round(100 * SLOPPY.lost)} % with the face lost. step 2 calibration: fixed windows, nothing shown twice, no head segment, an empty dot accepted.`);
    L.push(`   failed: calibrations that ended with an error. time: seconds from the first dot to the last, and dots shown again per calibration. unseen-dot error: the median error the shoot-out compared.`);
    L.push(variantTable(R.variants));
  }
  L.push('', `== SYNTH-FEATURE fixtures: tests/lab/fixtures, one recorded synthetic session, no interval   [${CAVEAT}]`);
  L.push(R.fixtures.rows.length ? recordingTable(R.fixtures.rows) : '   no fixture with targets and a calibration');
  L.push('');
  L.push(renderReal(R.real));
  L.push('', `PRIMARY SCORES   [${CAVEAT}]`);
  if (R.primary) {
    L.push(`  S_still = ${ci(R.primary.S_still, n2)} px   fixation-level euclidean RMS, SYNTH-3D STILL at 0.5 px iris noise (median over ${R.primary.S_still.n} seeds)`);
    L.push(`  S_move  = ${ci(R.primary.S_move, n2)} px   the same, mean of HEAD-SHIFT and HEAD-ROTATE`);
  } else L.push('  not available: this run has no SYNTH-3D row at 0.5 px (the primary scores need --noise to include 0.5)');
  return L.join('\n');
}

export function renderCompare(R, B, file = 'tests/bench/baseline.json') {
  const L = ['', `COMPARE against ${file} (baseline variant: features ${B.config.features}, trim ${B.config.trim ? 'on' : 'off'}, model ${B.config.model || 'A'}; ${B.config.seeds.length} seeds)   [${CAVEAT}]`];
  if (JSON.stringify(B.config.seeds) !== JSON.stringify(R.config.seeds)) L.push('  WARNING: the seed lists differ, so the two runs are not the same synthetic people.');
  if (JSON.stringify(B.config.set || {}) !== JSON.stringify(R.config.set || {})) L.push('  WARNING: the synthetic person was changed with --set, so this is not the benchmark the baseline was measured on.');
  let worse = false;
  const d = (cur, base) => (isNum(cur) && isNum(base) && base > 0 ? (cur - base) / base : NaN);
  for (const k of ['S_still', 'S_move']) {
    const cur = R.primary && R.primary[k].med, base = B.primary && B.primary[k].med, rel = d(cur, base);
    const paired = R.primaryPerSeed.map((p) => { const q = (B.primaryPerSeed || []).find((x) => x.seed === p.seed); return q && isNum(p[k]) && isNum(q[k]) ? p[k] - q[k] : NaN; }).filter(isNum);
    const bad = !isNum(rel) || rel > 0.03; if (bad) worse = true;
    L.push(`  ${pad(k, 8)} ${n2(base)} -> ${n2(cur)} px   delta ${isNum(rel) ? (cur - base >= 0 ? '+' : '') + n2(cur - base) + ' px (' + (rel >= 0 ? '+' : '') + (100 * rel).toFixed(1) + '%)' : 'n/a'}   better on ${paired.filter((v) => v < 0).length}, worse on ${paired.filter((v) => v > 0).length} of ${paired.length} seeds   ${bad ? 'WORSE by more than 3 %' : 'ok'}`);
  }
  const lines = [];
  for (const r of R.rows) {
    const b = B.rows.find((q) => q.source === r.source && q.levelKey === r.levelKey && q.condition === r.condition); if (!b) continue;
    const cur = M(r, 'fix.e.rms'), base = M(b, 'fix.e.rms'), rel = d(cur, base);
    lines.push([r.source, `${r.level} ${r.condition}`, n1(base), n1(cur), isNum(rel) ? (cur - base >= 0 ? '+' : '') + n1(cur - base) : '-', isNum(rel) ? (rel >= 0 ? '+' : '') + (100 * rel).toFixed(1) + '%' : '-', `${n1(M(b, 'fix.y.rms'))} -> ${n1(M(r, 'fix.y.rms'))}`, `${pc(M(b, 'share.gated'))} -> ${pc(M(r, 'share.gated'))}`, r.models || '-']);
  }
  L.push('', table(['source', 'row', 'baseline', 'now', 'delta px', 'delta', 'fix y RMS', 'gated', 'model now'], lines));
  L.push('', worse ? 'RESULT: WORSE than the baseline by more than 3 % on a primary score.' : 'RESULT: no primary score is more than 3 % worse than the baseline.');
  return { text: L.join('\n'), worse };
}

// ----------------------------------------------------------------------------- command line
function parseArgs(argv) {
  const o = { seeds: 20, noise: [0.2, 0.5, 0.8], features: 25, trim: true, set: {}, model: 'auto', cal: 'proc', proc: null, who: null, fit: null, sweep: false, hygiene: null, columns: null, variants: true, save: false, compare: false, json: OUT_FILE, baseline: BASELINE_FILE, recordings: RECORDINGS_DIR, realOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--save-baseline') o.save = true;
    else if (a === '--compare') o.compare = true;
    else if (a === '--features') { o.features = Number(next()); if (![17, 25, 44].includes(o.features)) throw new Error('--features takes 17, 25 or 44'); }
    else if (a === '--trim') { const v = next(); if (v !== 'on' && v !== 'off') throw new Error('--trim takes on or off'); o.trim = v === 'on'; }
    else if (a === '--seeds') { o.seeds = Number(next()); if (!(o.seeds >= 1) || !Number.isInteger(o.seeds)) throw new Error('--seeds takes a whole number'); }
    else if (a === '--noise') { o.noise = next().split(',').map(Number); if (!o.noise.length || o.noise.some((v) => !(v >= 0))) throw new Error('--noise takes px values such as 0.2,0.5,0.8'); }
    else if (a === '--json') o.json = path.resolve(next());
    else if (a === '--baseline') o.baseline = path.resolve(next());
    else if (a === '--recordings') o.recordings = path.resolve(next());
    else if (a === '--real-only') o.realOnly = true;
    else if (a === '--model') { o.model = next(); if (!C.MODEL_KINDS.concat('auto').includes(o.model)) throw new Error('--model takes auto, ' + C.MODEL_KINDS.join(', ')); }
    else if (a === '--cal') { o.cal = next(); if (!['proc', 'still', 'move'].includes(o.cal)) throw new Error('--cal takes proc, still or move'); }
    else if (a === '--proc' || a === '--who' || a === '--fit') {
      const key = a.slice(2), v = next(); o[key] = o[key] || {};
      if (key === 'who' && v === 'careless') Object.assign(o.who, SLOPPY);
      else if (key === 'proc' && v === 'step2') Object.assign(o.proc, PROC_OLD);
      else for (const part of v.split(',')) { const [k, val] = part.split('='); if (!k || val === undefined) throw new Error(a + ' takes name=value,...'); o[key][k] = val === 'true' ? true : val === 'false' ? false : Number.isFinite(Number(val)) ? Number(val) : val; }
    }
    else if (a === '--no-variants') o.variants = false;
    else if (a === '--gate-sweep') o.sweep = true;
    else if (a === '--clicks') o.clicks = true;
    else if (a === '--columns') { o.columns = next().split(',').map(Number); if (o.columns.some((v) => !Number.isInteger(v) || v < 0 || v >= C.FEATURE_COUNT)) throw new Error('--columns takes feature numbers below ' + C.FEATURE_COUNT); }
    else if (a === '--hygiene') {
      o.hygiene = {};
      for (const part of next().split(',')) { const [k, v] = part.split('='); if (!['norm', 'perAxis', 'zClamp', 'sdFloor', 'bounds', 'dropMeans'].includes(k)) throw new Error('--hygiene takes norm, perAxis, zClamp=4, sdFloor, bounds=0.15, dropMeans'); o.hygiene[k] = v === undefined ? true : Number(v); }
    }
    else if (a === '--set') { const m = /^([A-Za-z]+)=(-?[\d.]+)$/.exec(next()); if (!m || !(m[1] in DEFAULTS3D) || typeof DEFAULTS3D[m[1]] !== 'number') throw new Error('--set takes name=number, where name is a numeric option of tests/bench/synth3d.mjs (for example headWanderDeg=0)'); o.set[m[1]] = Number(m[2]); }
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}
const jsonSafe = (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v);

function main(argv) {
  let o; try { o = parseArgs(argv); } catch (e) { console.error(e.message); return 2; }
  if (o.help) { const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1); console.log(src.slice(0, src.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
  if (o.save && Object.keys(o.set).length) { console.error('--save-baseline is refused with --set: the baseline is the standard synthetic person'); return 2; }
  if (o.save && (o.features !== 25 || !o.trim || o.model !== 'auto' || o.cal !== 'proc' || o.proc || o.who || o.fit || o.hygiene || o.columns)) console.log('NOTE: saving a baseline for a variant that is not the shipped tracker (features 25, trim on, model auto, the calibration procedure).');
  const t0 = Date.now();
  if (o.realOnly) {
    // Only the lab recordings (a real camera when they come from tests/lab/recordings). Prints; saves nothing.
    console.log(renderReal(scoreReal(o.recordings)));
    return 0;
  }
  if (o.clicks) {
    // What click refinement does with and without its gate (step 3f). Prints only; saves nothing.
    console.log(renderClicks(clickBench({ seeds: Array.from({ length: o.seeds }, (_, i) => i + 1), set: o.set })));
    return 0;
  }
  if (o.sweep) {
    // The sweep that the head gate limits (HEAD_GATE in gaze-core.js) were read from. Prints only; saves nothing.
    const seeds = Array.from({ length: o.seeds }, (_, i) => i + 1);
    for (const model of (o.model === 'auto' ? ['auto', 'A'] : [o.model])) console.log(renderSweep(gateSweep({ seeds, model, set: o.set })) + '\n');
    console.error(`sweep done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return 0;
  }
  const R = runBench({ seeds: Array.from({ length: o.seeds }, (_, i) => i + 1), noise: o.noise, features: o.features, trim: o.trim, set: o.set, model: o.model, cal: o.cal, proc: o.proc, who: o.who, fit: o.fit, hygiene: o.hygiene, columns: o.columns, variants: o.variants, recordings: o.recordings });
  console.log(render(R));
  const text = JSON.stringify(R, jsonSafe, 1);
  fs.mkdirSync(path.dirname(o.json), { recursive: true });
  fs.writeFileSync(o.json, text);
  let code = 0;
  if (o.compare) {
    const B = loadJson(o.baseline);
    if (!B || !B.primary) { console.log(`\nCOMPARE: no baseline at ${path.relative(REPO_DIR, o.baseline)} (run with --save-baseline first)`); code = 1; }
    else { const cmp = renderCompare(R, B, path.relative(REPO_DIR, o.baseline).replace(/\\/g, '/')); console.log(cmp.text); if (cmp.worse) code = 1; }
    // Against the default baseline, also the result the step before left behind: no primary score may fall back behind it.
    if (o.baseline === BASELINE_FILE) {
      for (const name of ['after-step2.json', 'after-step3.json']) {
        const P = loadJson(path.join(HERE, name));
        if (P && P.primary) { const cmp = renderCompare(R, P, `tests/bench/${name}`); console.log(cmp.text); if (cmp.worse) code = 1; }
      }
    }
  }
  if (o.save) { fs.writeFileSync(o.baseline, text); console.log(`\nbaseline saved: ${path.relative(REPO_DIR, o.baseline)}`); }
  // the run time goes to stderr so that two runs print identical text
  console.error(`wrote ${path.relative(REPO_DIR, o.json)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
