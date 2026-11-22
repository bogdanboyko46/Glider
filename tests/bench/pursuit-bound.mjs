#!/usr/bin/env node
// node tests/bench/pursuit-bound.mjs [seeds]   (default 40; about a minute)
//
// Step 3b asked for a smooth-pursuit pass in the calibration (a dot that glides for about 8 s). It was not built.
// This script is why: it measures the most such a pass could give. Instead of a gliding dot followed with a lag and
// catch-up saccades, the fit gets the same 8 s as PERFECTLY labelled extra frames (the eye exactly on the target),
// as role 'pursuit' groups of fitCalibration. A real pursuit pass cannot do better than "ideal" below.
//   none   the calibration as shipped
//   dots   8 more fixation dots of 1 s each along the path (their travel time not charged)
//   ideal  240 frames of a gliding target, the eye on it without lag
// Fixation RMS px, median over seeds (mean), standard synthetic person at 0.5 px, head gate off.
// EVERY NUMBER IS FROM THE SYNTHETIC CAMERA. Results of 2026-11-20 are in tests/bench/RESULTS.md, step 3.
import * as B from './gaze-bench.mjs';
import { Person3D } from './synth3d.mjs';
import { C, mkRng } from '../lab/lib/util.mjs';
const D2R = Math.PI / 180;
const nSeeds = Number(process.argv[2] || 40);
const q = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); const i = p * (s.length - 1), lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
const path = (ms, vp) => [vp.w * (0.5 + 0.42 * Math.sin(2 * Math.PI * ms / 8000)), vp.h * (0.5 + 0.40 * Math.sin(4 * Math.PI * ms / 8000 + 0.6))];

function calibrate(seed, mode, model) {
  const person = new Person3D({ seed, noisePx: 0.5 }), rng = mkRng(seed * 104729 + 30), vp = person.o.viewport;
  const hr = mkRng(seed * 613 + 7), u = () => hr.U(0.6, 1.4);
  const amp = { yaw: 5 * D2R * u(), pitch: 3.5 * D2R * u(), roll: 1.5 * D2R * u(), x: u(), y: 0.6 * u(), z: 0.6 * u() };
  const keys = ['yaw', 'pitch', 'roll', 'x', 'y', 'z'], per = [3.1, 2.3, 4.3, 3.7, 2.9, 5.1].map((s) => s * hr.U(0.85, 1.15)), ph = per.map(() => hr.U(0, 2 * Math.PI));
  const run = new C.CalibrationRun({ viewport: vp, fit: { model } });
  let gx = vp.w / 2, gy = vp.h / 2, step = -1, tLook = 0, aim = null, tHead = null;
  for (;;) {
    const t = person.tick(), v = run.update(t);
    if (v.done) break;
    if (v.stepId !== step) { step = v.stepId; aim = [v.x, v.y]; tLook = t + rng.U(250, 330); }
    if (t >= tLook) { gx = aim[0]; gy = aim[1]; }
    if (v.seg === 'head') { if (tHead === null) tHead = t; const ramp = Math.min(1, (t - tHead) / 600), s = {}; keys.forEach((k, i) => { s[k] = ramp * amp[k] * Math.sin(2 * Math.PI * (t - tHead) / (1000 * per[i]) + ph[i]); }); person.setShift(s); }
    run.push(person.frame(t, gx, gy), t);
  }
  person.setShift({});
  const points = run.points.slice();
  if (mode !== 'none') {
    // 8 s of extra frames. 'ideal': the eye glides exactly with the target (240 labelled frames in 8 groups of 1 s).
    // 'dots': 8 more fixation dots of 1 s each along the path (0.4 s of travel each is simply not charged).
    const t0 = person.t;
    for (let gI = 0; gI < 8; gI++) {
      const samples = []; const fixed = path(gI * 1000 + 500, vp);
      while (person.t < t0 + (gI + 1) * 1000) {
        const t = person.tick(), tgt = mode === 'ideal' ? path(t - t0, vp) : fixed;
        const fr = person.frame(t, tgt[0], tgt[1]);
        if (fr.face && !fr.blink) samples.push({ f: fr.f, head: fr.head, t, x: tgt[0], y: tgt[1] });
      }
      points.push({ x: fixed[0], y: fixed[1], g: 300 + gI, role: 'pursuit', samples });
    }
  }
  const fit = C.fitCalibration(points, { viewport: vp, model });
  return { person, rng, fit };
}
for (const model of ['auto', 'A']) for (const mode of ['none', 'dots', 'ideal']) {
  const still = [], move = [];
  for (let seed = 1; seed <= nSeeds; seed++) {
    const S = calibrate(seed, mode, model);
    const blk = (shift) => B.score([B.runBlock(S.person, S.fit, B.TEST_GRID, S.rng, { shift, gate: false })], S.fit.accuracy)['fix.e.rms'];
    still.push(blk(null));
    move.push((blk({ x: 3 }) + blk({ yaw: 5 * D2R })) / 2);
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  console.log(`model ${model.padEnd(4)} extra ${mode.padEnd(5)}  still ${q(still, 0.5).toFixed(1)} (mean ${mean(still).toFixed(1)})   3 cm + 5 deg yaw, gate off ${q(move, 0.5).toFixed(1)} (mean ${mean(move).toFixed(1)})   ${nSeeds} seeds`);
}
