// Self-test: synthetic recordings with known injected properties; the analyzer must recover each.
//   node tests/lab/lib/selftest.mjs
import path from 'node:path';
import fs from 'node:fs';
import { LAB_DIR, effectiveN, isNum } from './util.mjs';
import { makeSession, record, DEFAULTS } from './synth.mjs';
import { analyze } from './analysis.mjs';
import { render, renderCompare } from './report.mjs';
import { analyzeFile } from '../analyze.mjs';

let failed = 0;
function check(name, got, want, tol, unit = '') {
  const ok = isNum(got) && Math.abs(got - want) <= tol;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${isNum(got) ? +got.toFixed(4) : got}${unit}, expected ${+(+want).toFixed(4)}${unit} +/- ${+(+tol).toFixed(4)}`);
}
function truthy(name, cond, detail = '') { if (!cond) failed++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ': ' + detail : ''}`); }
const run = (task, sopts = {}, ropts = {}, after = null) => { const s = makeSession(sopts); if (after) after(s); return analyze(record(s, task, ropts), { name: 'synthetic-' + task }); };

// ---- 1. per-frame noise sd and lag-1 autocorrelation of the eye features (two different phi)
for (const phi of [0.6, 0.2]) {
  const R = run('camera', { seed: 11, headWanderCm: 0, blinkEveryMs: 0, noise: { phi } }, { durMs: 60000 });
  const want = { 8: DEFAULTS.noise.u, 9: DEFAULTS.noise.v, 10: DEFAULTS.noise.vl, 11: DEFAULTS.noise.open };
  const neffTrue = effectiveN(6, [1, phi, phi ** 2, phi ** 3, phi ** 4, phi ** 5]);
  for (const f of R.noise.features) {
    check(`noise sd f[${f.idx}] (phi ${phi})`, f.sd, want[f.idx], want[f.idx] * 0.12);
    check(`lag-1 autocorrelation f[${f.idx}] (phi ${phi})`, f.ac1, phi, 0.08);
    check(`independent frames in 6, f[${f.idx}] (phi ${phi})`, f.neff6, neffTrue, 0.25 * neffTrue);
  }
  check(`lag-1 autocorrelation of screen y (phi ${phi})`, R.noise.px.y.ac1, phi, 0.12);
}
// same, on short validate targets (tests the centring-bias correction)
{
  const R = run('validate', { seed: 12, headWanderCm: 0, noise: { phi: 0.6 } });
  check('lag-1 autocorrelation f[9] on 1.5 s validate targets (phi 0.6)', R.noise.features[1].ac1, 0.6, 0.1);
  check('noise sd f[9] on validate targets', R.noise.features[1].sd, DEFAULTS.noise.v, DEFAULTS.noise.v * 0.12);
}

// ---- 2. known bias: the tester looks (40, -25) px off every target after calibration (paired, same seed)
{
  const A0 = run('validate', { seed: 21 }), A1 = run('validate', { seed: 21 }, {}, (s) => { s.world.o.lookBias = { x: 40, y: -25 }; });
  check('injected bias x recovered (paired)', A1.accuracy.biasX - A0.accuracy.biasX, 40, 6, ' px');
  check('injected bias y recovered (paired)', A1.accuracy.biasY - A0.accuracy.biasY, -25, 6, ' px');
  // ---- 5. no train/test leak: variant (a) is the shipped model, so it must reproduce the gaze events
  const a = A0.models.variants.find((v) => v.name.startsWith('a '));
  check('variant (a) per-frame RMS x equals the shipped gaze stream', a.rmsX, A0.accuracy.rmsX, 0.3, ' px');
  check('variant (a) per-frame RMS y equals the shipped gaze stream', a.rmsY, A0.accuracy.rmsY, 0.3, ' px');
  const b = A0.models.variants.find((v) => v.name.startsWith('b '));
  check('refit (b) on dump.train reproduces the shipped model', b.fixY, a.fixY, 0.5, ' px');
  // Since step 2 the tracker stores the camera's whole vector per training frame (44 numbers from this synthetic
  // person), so the pose variant (e) can be refitted from its dump; (b) is the refit of what model A reads (25).
  truthy('whole-vector train rows: eight model variants evaluated (a, b and c with their two extras, e)', A0.models.variants.map((v) => v.name[0]).join('') === 'abfgcfge', A0.models.variants.map((v) => v.name[0]).join(''));
  truthy('whole-vector train rows: the head-frame models are skipped with a note (this person has no landmarks, only 44 numbers)', A0.models.notes.some((n) => /head-frame models B, C, E: skipped/.test(n)));
  const W25 = run('validate', { seed: 21, cal: { trainWidth: 25 } });
  truthy('25-wide train rows (a dump from before step 2) against 44-wide raw frames: seven model variants evaluated', W25.models.variants.length === 7, W25.models.variants.map((v) => v.name[0]).join(''));
  const W44 = run('validate', { seed: 21, cal: { featureCount: 44 } });
  truthy('44-wide train rows: all nine model variants evaluated', W44.models.variants.length === 9, W44.models.variants.map((v) => v.name[0]).join(''));
  check('px per degree', A0.pxPerDeg, Math.hypot(1536, 864) / (14 * 2.54) * 60 * Math.tan(Math.PI / 180), 0.01);
  // offset correction removes a constant offset learned on the first two targets
  const a1 = A1.models.variants.find((v) => v.name.startsWith('a '));
  check('offset correction brings the biased run back to the unbiased error (fixation y, rest of targets)', a1.offset.corrFixY, a.offset.restFixY, 4, ' px');
  truthy('offset correction helps when there is a constant bias', a1.offset.corrFixY < a1.offset.restFixY - 3, `rest y ${a1.offset.restFixY.toFixed(1)} -> ${a1.offset.corrFixY.toFixed(1)} px`);
}

// ---- 3. head shift: lean left 3 cm, lean back 5 cm, slouch 3 cm down
{
  const R = run('headshift', { seed: 31 }); const ph = Object.fromEntries(R.health.head.phases.map((p) => [p.name, p]));
  check('lean-left sideways shift', ph['lean-left'].cmX, -3, 0.5, ' cm');
  check('lean-back distance change', ph['lean-back'].cmZ, 5, 0.7, ' cm');
  check('slouch downward shift', ph.slouch.cmY, 3, 0.5, ' cm');
  check('baseline phase stays put', Math.hypot(ph.baseline.cmX, ph.baseline.cmY, ph.baseline.cmZ), 0, 0.7, ' cm');
  const ap = Object.fromEntries(R.accuracy.phases.map((p) => [p.name, p]));
  truthy('head shift degrades accuracy vs baseline phase', ap.slouch.fixY > 1.5 * ap.baseline.fixY, `slouch ${ap.slouch.fixY.toFixed(0)} px vs baseline ${ap.baseline.fixY.toFixed(0)} px`);
  truthy('best variant marked per phase', Object.keys(R.models.bestPerPhase).length === 4);
}

// ---- 4. known line sequence
{
  const lo = run('lines-paced', { seed: 41, noiseScale: 0.3 });
  truthy('low noise: nearest-line recovers the true line sequence', lo.lines.shipped.raw.nearest >= 0.93, (100 * lo.lines.shipped.raw.nearest).toFixed(1) + '%');
  truthy('low noise: shipped LineHMM recovers the true line sequence', lo.lines.shipped.raw.hmm >= 0.9, (100 * lo.lines.shipped.raw.hmm).toFixed(1) + '%');
  truthy('low noise: progress decoder recovers the true line sequence', lo.lines.shipped.raw.progress >= 0.9, (100 * lo.lines.shipped.raw.progress).toFixed(1) + '%');
  truthy('low noise: per-line dwell error small', lo.lines.shipped.raw.dwellErrProgress < 0.2, (100 * lo.lines.shipped.raw.dwellErrProgress).toFixed(1) + '%');
  const b0 = run('lines-paced', { seed: 42, noiseScale: 0.3 }), b1 = run('lines-paced', { seed: 42, noiseScale: 0.3 }, {}, (s) => { s.world.o.lookBias = { x: 0, y: 36 }; });
  check('injected vertical offset recovered on a reading task (paired)', b1.lines.shipped.biasY - b0.lines.shipped.biasY, 36, 6, ' px');
  truthy('removing the median offset restores nearest-line decoding', b1.lines.shipped.offsetRemoved.nearest > b1.lines.shipped.raw.nearest + 0.1 && b1.lines.shipped.offsetRemoved.nearest >= 0.9, `${(100 * b1.lines.shipped.raw.nearest).toFixed(1)}% -> ${(100 * b1.lines.shipped.offsetRemoved.nearest).toFixed(1)}%`);
  const n1 = run('lines-self', { seed: 43, noiseScale: 1 }), n3 = run('lines-self', { seed: 43, noiseScale: 3 });
  const ratio = n3.lines.shipped.sigmaOverPitch / n1.lines.shipped.sigmaOverPitch;
  truthy('sigma_y / pitch scales with injected noise (x3 noise)', ratio > 1.8 && ratio < 4.2, `ratio ${ratio.toFixed(2)}`);
  truthy('more noise decodes worse (nearest line)', n3.lines.shipped.raw.nearest < n1.lines.shipped.raw.nearest);
  const st = run('stall', { seed: 44 });
  truthy('stall task: replayed struggleDecision fires in the stall or reread phase', st.lines.shipped.struggle.stall.length + st.lines.shipped.struggle.reread.length >= 1, JSON.stringify(st.lines.shipped.struggle));
}

// ---- 6. tolerance: broken or partial recordings must not crash and must say "not available"
{
  const good = record(makeSession({ seed: 51 }), 'validate');
  const cases = {
    'empty object': {}, 'no events / no dump': { v: 1, task: 'validate', truth: good.truth },
    'no dump': { ...good, dump: undefined }, 'empty arrays': { ...good, events: [], truth: [] },
    'f of length 20': { ...good, events: good.events.map((e) => (e.k === 'raw' && e.f ? { ...e, f: e.f.slice(0, 20) } : e)) },
    'garbage events': { ...good, events: [null, 3, { k: 'raw' }, { k: 'raw', t: 5, face: true }, { k: 'gaze', t: 'x' }], layout: { blocks: [{ lines: null }] }, truth: [null, { kind: 'target' }] },
    'lines task without layout': { ...good, task: 'lines-self', truth: [{ kind: 'line', block: 'b0', line: 0, t0: 0, t1: 1000 }] },
  };
  for (const [name, rec] of Object.entries(cases)) {
    let ok = true, txt = '';
    try { txt = render(analyze(rec, { name })); JSON.stringify(analyze(rec, { name })); } catch (e) { ok = false; txt = e.stack; }
    truthy(`tolerant of: ${name}`, ok && /not available/.test(txt), ok ? '' : txt.split('\n').slice(0, 2).join(' | '));
  }
  const R20 = analyze(cases['f of length 20'], { name: 'f20' });
  truthy('f of a different length gives a clear model note', !!R20.models.na && /feature vector/.test(R20.models.na), R20.models.na);
}

// ---- 7. fixtures and CLI plumbing
{
  const fx = path.join(LAB_DIR, 'fixtures');
  const cam = path.join(fx, 'synthetic-camera.json');
  if (fs.existsSync(cam)) {
    const R = analyzeFile(cam);
    truthy('recording without dump.train falls back to the newest earlier calibration', R.ok && R.header.dumpSource === 'synthetic-calibrate.json' && !R.models.na, String(R.ok && R.header.dumpSource));
    let lines = 0, worst = '';
    for (const f of fs.readdirSync(fx).filter((q) => q.endsWith('.json'))) { const n = render(analyzeFile(path.join(fx, f))).split('\n').length; if (n > lines) { lines = n; worst = f; } }
    truthy('every fixture report is at most 70 lines', lines <= 70, `longest ${lines} lines (${worst})`);
    const cmp = renderCompare(analyzeFile(path.join(fx, 'synthetic-validate.json')), analyzeFile(path.join(fx, 'synthetic-headshift.json')));
    truthy('--compare table renders', /fixation RMS y px/.test(cmp));
  } else truthy('fixtures present (run: node tests/lab/lib/synth.mjs --write)', false);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exitCode = failed ? 1 : 0;
