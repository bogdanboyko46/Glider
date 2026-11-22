#!/usr/bin/env node
// node tests/bench/check-card.mjs [people] [iris noise px] [late]   (default 60 people at 0.5 px; about half a minute)
//
// Step 4a: how well does the "Calibration done" card agree with what is measured afterwards?
// After the calibration procedure each synthetic person looks at the five check dots exactly as the
// reader shows them (C.CHECK_POINTS; 0.9 s for the eyes to arrive, 1.2 s that count; the model in use
// run on every frame; C.validationResult). Then the same person does the benchmark's STILL block
// (13 targets) and the fixation error there is taken as the truth.
// `late` (0..1): the share of check dots the person reaches 0.8 to 1.6 s late (the reader's check has
// fixed windows: it does not wait for the eyes as the calibration does).
//
// SYNTHETIC CAMERA ONLY. Noise levels are assumptions; this says nothing about a real webcam.
// Results: tests/bench/RESULTS.md, "Step 4".
import * as B from './gaze-bench.mjs';
import { Person3D } from './synth3d.mjs';
import { C, mkRng } from '../lab/lib/util.mjs';

const n = Number(process.argv[2] || 60), noise = Number(process.argv[3] || 0.5), late = Number(process.argv[4] || 0);
const SETTLE = 900, SAMPLE = 1200;   // gaze-reader.js runCheck with the default settleMs and sampleMs
const q = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); const i = p * (s.length - 1), lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };

function checkPass(person, fit, rng) {
  const vp = person.o.viewport, blinker = new C.BlinkDetector();
  let gx = vp.w / 2, gy = vp.h / 2;
  const dots = [];
  for (const p of C.CHECK_POINTS) {
    const x = Math.round(p[0] * vp.w), y = Math.round(p[1] * vp.h), tShow = person.t;
    const tLook = tShow + (rng.u() < late ? rng.U(800, 1600) : rng.U(250, 330)), t0 = tShow + SETTLE, t1 = t0 + SAMPLE, preds = [];
    while (person.t < t1) {
      const t = person.tick(); if (t >= tLook) { gx = x; gy = y; }
      const fr = person.frame(t, gx, gy);
      if (!fr.face) continue;
      const blink = fr.lids ? blinker.push(fr.lids, t) : !!fr.blink;
      if (!blink && t >= t0 && t <= t1) preds.push(fit.model.predict(fr.f));
    }
    dots.push({ x, y, preds });
  }
  return C.validationResult(dots, { fallback: fit.accuracy });
}

const rows = [];
for (let seed = 1; seed <= n; seed++) {
  const person = new Person3D({ seed, fps: 30, noisePx: noise }), rng = mkRng(seed * 104729 + 30);
  let fit; try { fit = B.runProcedure(person, rng, {}, { featureCount: 25, trim: true, model: 'auto' }, {}); } catch (e) { continue; }
  const val = checkPass(person, fit, mkRng(seed * 7919 + 5));
  const grid = B.TEST_GRID.slice(); for (let i = grid.length - 1; i > 0; i--) { const j = Math.floor(rng.u() * (i + 1)); [grid[i], grid[j]] = [grid[j], grid[i]]; }
  const m = B.score([B.runBlock(person, fit, grid, rng, {})], fit.accuracy);
  rows.push({ seed, kind: fit.kind, check: val, calY: fit.accuracy.effY, calX: fit.accuracy.effX, trueY: m['fix.y.rms'], trueX: m['fix.x.rms'], trueE: m['fix.e.rms'], frameMed: m['frame.e.med'] });
}
const grade = (e) => C.validationGrade(e).grade, count = (f) => rows.filter(f).length;
const off30 = (k) => count((r) => { const v = k(r) / Math.max(1, r.trueY); return v > 1.3 || v < 1 / 1.3; });
console.log(`CHECK CARD against the truth   ${rows.length} synthetic people, ${noise} px iris noise${late ? `, ${Math.round(100 * late)} % of check dots reached late` : ''}   [${B.CAVEAT}]`);
console.log(`vertical error per fixation, px, median over people: the card's check ${q(rows.map((r) => r.check.effY), 0.5).toFixed(1)}, the calibration's own figure ${q(rows.map((r) => r.calY), 0.5).toFixed(1)}, measured afterwards ${q(rows.map((r) => r.trueY), 0.5).toFixed(1)}`);
console.log(`check / measured, per person: median x${q(rows.map((r) => r.check.effY / Math.max(1, r.trueY)), 0.5).toFixed(2)}, 10th to 90th percentile x${q(rows.map((r) => r.check.effY / Math.max(1, r.trueY)), 0.1).toFixed(2)} to x${q(rows.map((r) => r.check.effY / Math.max(1, r.trueY)), 0.9).toFixed(2)}`);
console.log(`people whose figure is more than 30 % from the measured vertical error: the check ${off30((r) => r.check.effY)} of ${rows.length}, the calibration's own ${off30((r) => r.calY)} of ${rows.length}`);
console.log(`"typical error" on the card (median frame distance), median over people: ${q(rows.map((r) => r.check.errPx), 0.5).toFixed(0)} px; measured median frame distance afterwards: ${q(rows.map((r) => r.frameMed), 0.5).toFixed(0)} px`);
const g = ['good', 'fair', 'poor'];
console.log(`grade on the card: ${g.map((k) => `${k} ${count((r) => r.check.grade === k)}`).join(', ')};  grade of the measured error: ${g.map((k) => `${k} ${count((r) => grade(r.trueY) === k)}`).join(', ')};  the two agree for ${count((r) => r.check.grade === grade(r.trueY))} of ${rows.length}`);
console.log(`card says good but measured is not: ${count((r) => r.check.grade === 'good' && grade(r.trueY) !== 'good')};  card says fair or poor but measured is good: ${count((r) => r.check.grade !== 'good' && grade(r.trueY) === 'good')};  band of lines on the card (fair): ${[3, 4, 5].map((b) => `${b} lines ${count((r) => r.check.grade === 'fair' && r.check.bandLines === b)}`).join(', ')}`);
console.log(`check not measurable (fewer than 3 dots with 5 frames): ${count((r) => !r.check.ok)}`);
