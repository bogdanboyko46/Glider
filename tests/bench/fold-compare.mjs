#!/usr/bin/env node
// node tests/bench/fold-compare.mjs [seeds]   (default 60; about a minute and a half)
//
// Step 3c: should the 5 validation dots be folded into the training set? The same synthetic people and the same camera
// frames, fitted three ways (fitCalibration options fold and score), compared person by person; and which of the three
// accuracy figures is closest to what is then measured. SYNTHETIC CAMERA ONLY. Results: tests/bench/RESULTS.md, step 3c.
import * as B from './gaze-bench.mjs';
import { Person3D } from './synth3d.mjs';
const n = Number(process.argv[2] || 60), noise = Number(process.argv[3] || 0.5);
const V = { 'fold, lodo (18 dots)': { fold: true }, 'fold, val (5 dots, 13-dot model)': { fold: true, score: 'val' }, 'no fold, val (5 dots)': { fold: false } };
const q = (a, p) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); const i = p * (s.length - 1), lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const res = {};
for (const [name, fit] of Object.entries(V)) {
  res[name] = [];
  for (let s = 1; s <= n; s++) {
    const r = B.runSeed((seed, fps) => new Person3D({ seed, fps, noisePx: noise }), s, { featureCount: 25, trim: true, model: 'auto', ...fit }, {});
    const m = r.cond.STILL.metrics, mv = (r.cond['HEAD-SHIFT'].metrics['fix.e.rms'] + r.cond['HEAD-ROTATE'].metrics['fix.e.rms']) / 2;
    res[name].push({ still: m['fix.e.rms'], move: mv, cy: m['claim.effY'], my: m['fix.y.rms'], cx: m['claim.effX'], mx: m['fix.x.rms'], kind: r.cal[30].kind });
  }
}
const base = res['fold, lodo (18 dots)'];
for (const [name, rows] of Object.entries(res)) {
  const dS = rows.map((r, i) => r.still - base[i].still), dM = rows.map((r, i) => r.move - base[i].move);
  const logy = rows.map((r) => Math.abs(Math.log(r.my / Math.max(1, r.cy)))), logx = rows.map((r) => Math.abs(Math.log(r.mx / Math.max(1, r.cx))));
  const out30 = rows.filter((r) => r.my / r.cy > 1.3 || r.my / r.cy < 1 / 1.3).length;
  console.log(`${name.padEnd(34)} S_still med ${q(rows.map((r) => r.still), 0.5).toFixed(1)} mean ${mean(rows.map((r) => r.still)).toFixed(1)} | S_move med ${q(rows.map((r) => r.move), 0.5).toFixed(1)} mean ${mean(rows.map((r) => r.move)).toFixed(1)} | vs fold+lodo: still mean diff ${mean(dS).toFixed(2)} (better on ${dS.filter((v) => v < 0).length}, worse on ${dS.filter((v) => v > 0).length}), move mean diff ${mean(dM).toFixed(2)} | claimed y med ${q(rows.map((r) => r.cy), 0.5).toFixed(1)} measured ${q(rows.map((r) => r.my), 0.5).toFixed(1)}; ratio med x${q(rows.map((r) => r.my / r.cy), 0.5).toFixed(2)}; mean |log ratio| y ${mean(logy).toFixed(3)} x ${mean(logx).toFixed(3)}; people off by more than 30 %: ${out30} of ${n} | E ${rows.filter((r) => r.kind === 'E').length}`);
}
