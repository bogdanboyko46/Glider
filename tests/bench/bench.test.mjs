// node tests/bench/bench.test.mjs — checks of the synthetic 3D person and of the benchmark's own arithmetic.
// These test the measuring instrument, not the tracker: a wrong sign in the geometry or a slip in
// the scoring would make every benchmark number meaningless.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { C, LAB_DIR, REPO_DIR, mkRng } from '../lab/lib/util.mjs';
import { Person3D, makePerson, loadCanonical } from './synth3d.mjs';
import { Tracker, calibrate, runProcedure, runSeed, gateSweep, renderSweep, clickBench, renderClicks, runBlock, score, summarize, runBench, render, renderCompare, scoreRecordings, scoreReal, renderReal, TEST_GRID, CAVEAT, PX_PER_DEG, SLOPPY, PROC_OLD, FIT_OLD } from './gaze-bench.mjs';

let failed = 0;
const ok = (name, cond, detail = '') => { if (!cond) failed++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? '  -> ' + detail : ''}`); };
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;
const sd = (a) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
const QUIET = { noisePx: 0, lookErrDeg: 0, headWanderCm: 0, headWanderDeg: 0, headFollow: 0, blinkEveryMs: 0, drop: 0 };
const D2R = Math.PI / 180;

// ---- the canonical face
{
  const v = loadCanonical();
  ok('canonical face model: 468 vertices, the right eye (33, 133) at -x and the left (362, 263) at +x', v.length === 468 && v[33][0] < v[133][0] && v[133][0] < 0 && v[362][0] > 0 && v[263][0] > v[362][0]);
  ok('canonical face model: eye openings 6.3 cm apart, upper lid above lower', near((v[362][0] + v[263][0]) / 2 - (v[33][0] + v[133][0]) / 2, 6.3, 0.1) && v[159][1] > v[145][1]);
}

// ---- determinism, and the same person at every noise level
{
  const run = (o) => { const p = new Person3D(o); const out = []; for (let i = 0; i < 200; i++) out.push(p.frame(p.tick(), 300 + i, 200)); return out; };
  ok('same seed gives the same frames', JSON.stringify(run({ seed: 4 })) === JSON.stringify(run({ seed: 4 })));
  ok('another seed gives other frames', JSON.stringify(run({ seed: 4 })) !== JSON.stringify(run({ seed: 5 })));
  ok('the person (anatomy, seat) does not depend on the noise level', JSON.stringify(new Person3D({ seed: 4, noisePx: 0.2 }).p) === JSON.stringify(new Person3D({ seed: 4, noisePx: 0.8 }).p) && JSON.stringify(makePerson(4)) === JSON.stringify(new Person3D({ seed: 4 }).p));
  const a = run({ seed: 4, noisePx: 0.2 }), b = run({ seed: 4, noisePx: 0.8 });
  ok('blinks fall on the same frames at every noise level', a.every((f, i) => f.blink === b[i].blink || Math.abs(i - a.findIndex((q) => q.blink)) < 12));
}

// ---- geometry without noise
{
  const p = new Person3D({ seed: 2, ...QUIET });
  const at = (x, y) => { const fr = p.frame(p.tick(), x, y); return { fr, last: p.last }; };
  const L = at(200, 365), R = at(1336, 365), U = at(768, 60), D = at(768, 670), Cn = at(768, 365);
  // screen right is the camera's left: the irises move towards smaller image x, so u falls
  ok('looking right on the screen lowers u (image x), looking left raises it', R.fr.f[8] < Cn.fr.f[8] - 0.03 && L.fr.f[8] > Cn.fr.f[8] + 0.03, `u ${L.fr.f[8].toFixed(3)} / ${Cn.fr.f[8].toFixed(3)} / ${R.fr.f[8].toFixed(3)}`);
  ok('looking down the screen raises v and vl (image y)', D.fr.f[9] > Cn.fr.f[9] + 0.01 && U.fr.f[9] < Cn.fr.f[9] - 0.01 && D.fr.f[10] > U.fr.f[10], `v ${U.fr.f[9].toFixed(3)} / ${Cn.fr.f[9].toFixed(3)} / ${D.fr.f[9].toFixed(3)}`);
  ok('the upper lid follows the eye down (opening shrinks)', D.fr.f[11] < U.fr.f[11], `${U.fr.f[11].toFixed(3)} -> ${D.fr.f[11].toFixed(3)}`);
  ok('eye-look blendshapes: down grows going down, in / out swap sides left to right', D.fr.f[17] > U.fr.f[17] && D.fr.f[18] > U.fr.f[18] && L.fr.f[22] !== R.fr.f[22] && Math.sign(L.fr.f[21] - R.fr.f[21]) === -Math.sign(L.fr.f[22] - R.fr.f[22]));
  ok('nobody blinks just by looking at the bottom of the screen', !D.fr.blink && !at(768, 729).fr.blink && D.fr.f[11] > 0.12);
  // pinhole: distance between the eye openings in the image
  // (the eye corners are about 6.5 cm in front of the pivot the head position is given for)
  const z = -Cn.last.pos[2], zEyes = z - 6.5 * p.p.scale, wantS = 6.3 * p.p.scale * p.fx / zEyes / 1280;
  ok('eye distance in the image matches the pinhole camera', near(Cn.fr.head.s, wantS, 0.03 * wantS), `${Cn.fr.head.s.toFixed(4)} vs ${wantS.toFixed(4)}`);
  ok('the face sits inside the camera frame, below its middle', Cn.fr.head.cx > 0.35 && Cn.fr.head.cx < 0.65 && Cn.fr.head.cy > 0.5 && Cn.fr.head.cy < 0.8);
  // face matrix: a rotation, and a translation that puts the head where it is (scaled by face size)
  const M = Cn.last.matrix, col = (c) => [M[4 * c], M[4 * c + 1], M[4 * c + 2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  ok('face matrix: orthonormal rotation, last row 0 0 0 1', [0, 1, 2].every((c) => near(dot(col(c), col(c)), 1, 1e-9)) && near(dot(col(0), col(1)), 0, 1e-9) && near(dot(col(1), col(2)), 0, 1e-9) && M[3] === 0 && M[7] === 0 && M[11] === 0 && M[15] === 1);
  ok('face matrix: translation in cm, z negative, about the head distance over the face scale', M[14] < -40 && near(M[14], -(z - 3 * p.p.scale) / p.p.scale, 3), `tz ${M[14].toFixed(1)}`);
  ok('63 features (44 as before, 19 added in step 2), none NaN', Cn.fr.f.length === 63 && C.FEATURE_COUNT === 63 && Cn.fr.f.every(Number.isFinite));
  // the eye really points at the target: the visual axis of each eye passes through it
  const T = p.screenPoint(768, 365);
  ok('screen point (768, 365) is on the screen plane, below the camera, on its axis', T[2] === 0 && near(T[0], 0, 1e-9) && T[1] < -5 && T[1] > -15);
  // posture: setShift moves the head the way its documentation says
  p.setShift({ x: 3 }); const sx = at(768, 365); p.setShift({ y: 2 }); const sy = at(768, 365); p.setShift({ z: 5 }); const sz = at(768, 365); p.setShift({});
  ok('setShift x: 3 cm towards the camera\'s right moves the face right in the image', sx.fr.head.cx > Cn.fr.head.cx + 0.02 && near(sx.last.pos[0] - Cn.last.pos[0], 3, 1e-9));
  ok('setShift y: 2 cm down moves the face down in the image', sy.fr.head.cy > Cn.fr.head.cy + 0.02 && near(sy.last.pos[1] - Cn.last.pos[1], -2, 1e-9));
  ok('setShift z: 5 cm back makes the face smaller', near(sz.fr.head.s / Cn.fr.head.s, z / (z + 5), 0.01));
  p.setShift({ yaw: 5 * D2R }); const yw = at(768, 365); p.setShift({});
  ok('setShift yaw: the head turns 5 degrees and the eyes turn back to stay on the target', near(yw.last.yaw - Cn.last.yaw, 5 * D2R, 1e-9) && near(Math.abs(yw.last.az - Cn.last.az), 5 * D2R, 1.2 * D2R), `eye azimuth changed ${((yw.last.az - Cn.last.az) / D2R).toFixed(2)} deg`);
}

// ---- noise is what its knob says
{
  for (const noisePx of [0.2, 0.8]) {
    const p = new Person3D({ seed: 6, ...QUIET, noisePx }), q = new Person3D({ seed: 6, ...QUIET });
    const dx = [], dy = [];
    for (let i = 0; i < 6000; i++) { const t = p.tick(); q.tick(); p.frame(t, 700, 300); q.frame(t, 700, 300); dx.push(p.last.eyes.R.irisPx[0] - q.last.eyes.R.irisPx[0]); dy.push(p.last.eyes.R.irisPx[1] - q.last.eyes.R.irisPx[1]); }
    ok(`iris landmark noise SD is ${noisePx} px on both axes`, near(sd(dx), noisePx, 0.08 * noisePx) && near(sd(dy), noisePx, 0.08 * noisePx), `${sd(dx).toFixed(3)} / ${sd(dy).toFixed(3)} px`);
    let num = 0, den = 0; for (let i = 1; i < dx.length; i++) { num += dx[i] * dx[i - 1]; den += dx[i] * dx[i]; }
    ok(`iris noise lag-1 autocorrelation is about 0.5 at 30 fps (noise ${noisePx} px)`, near(num / den, 0.5, 0.06), (num / den).toFixed(3));
  }
  const p15 = new Person3D({ seed: 6, ...QUIET, noisePx: 0.5, fps: 15 }), q15 = new Person3D({ seed: 6, ...QUIET, fps: 15 }), d = [];
  for (let i = 0; i < 6000; i++) { const t = p15.tick(); q15.tick(); p15.frame(t, 700, 300); q15.frame(t, 700, 300); d.push(p15.last.eyes.L.irisPx[0] - q15.last.eyes.L.irisPx[0]); }
  let num = 0, den = 0; for (let i = 1; i < d.length; i++) { num += d[i] * d[i - 1]; den += d[i] * d[i]; }
  ok('at 15 fps the noise has the same SD and less memory (about 0.25)', near(sd(d), 0.5, 0.04) && near(num / den, 0.25, 0.06), `sd ${sd(d).toFixed(3)}, lag-1 ${(num / den).toFixed(3)}`);
  const w = new Person3D({ seed: 8, ...QUIET, headWanderCm: 0.15 }), xs = [];
  for (let i = 0; i < 60000; i++) { w.t += 500; w.frame(w.t, 700, 300); xs.push(w.last.pos[0]); }
  ok('head wander SD is 0.15 cm', near(sd(xs), 0.15, 0.02), sd(xs).toFixed(3));
}

// ---- blinks
{
  const p = new Person3D({ seed: 9, blinkEveryMs: 3000 }); let n = 0, flagged = 0, shutFlagged = 0, shut = 0;
  for (let i = 0; i < 9000; i++) { const fr = p.frame(p.tick(), 700, 300); n++; if (fr.blink) flagged++; if (p.last.shut > 0.8) { shut++; if (fr.blink) shutFlagged++; } }
  ok('blinks happen and the real extractFeatures flags the closed-eye frames', shut > 50 && shutFlagged / shut > 0.97 && flagged / n > 0.02 && flagged / n < 0.15, `${(100 * flagged / n).toFixed(1)}% of frames flagged, ${(100 * shutFlagged / shut).toFixed(0)}% of shut frames`);
}

// ---- the benchmark's arithmetic
{
  // a perfect noise-free person: calibration and tracking must land on the targets
  const rng = mkRng(1), p = new Person3D({ seed: 3, ...QUIET });
  const fit = calibrate(p, rng);
  const b = runBlock(p, fit, TEST_GRID, rng), m = score([b], fit.accuracy);
  ok('noise-free person: the shipped calibration reaches the held-out targets', m['fix.e.rms'] < 12 && m['frame.e.rms'] < 12, `fixation RMS ${m['fix.e.rms'].toFixed(1)} px, frame RMS ${m['frame.e.rms'].toFixed(1)} px`);
  ok('noise-free person: every target got frames and at least one fixation', b.recs.length === 13 && b.recs.every((r) => r.frames.length > 40 && r.fixes.length >= 1));
  ok('shares add up', near(m['share.lost'] + m['share.blink'] + m['share.gated'] + m['share.used'], 1, 1e-12) && m['share.fixTime'] > 0.5 && m['share.fixTime'] <= 1);
  // a known offset comes back as that bias, on that axis
  const off = runBlock(new Person3D({ seed: 3, ...QUIET }), { ...fit, model: { predict: (f) => { const q = fit.model.predict(f); return [q[0] + 40, q[1] - 25]; } } }, TEST_GRID, mkRng(1));
  const mo = score([off], fit.accuracy), base = score([runBlock(new Person3D({ seed: 3, ...QUIET }), fit, TEST_GRID, mkRng(1))], fit.accuracy);
  ok('an injected (+40, -25) px offset is reported as that bias', near(mo['frame.x.bias'] - base['frame.x.bias'], 40, 1e-6) && near(mo['frame.y.bias'] - base['frame.y.bias'], -25, 1e-6) && near(mo['fix.x.bias'] - base['fix.x.bias'], 40, 1e-6));
  ok('line hits: a 25 px vertical offset misses a 24 px line but stays inside its 3-line band', mo['line.fix.exact.24'] < 0.2 && mo['line.fix.band.24'] > 0.9 && mo['line.fix.exact.64'] > 0.9);
  // head gate: a big lean pauses the tracker (after 600 ms), and the frames are counted as gated
  const lean = runBlock(new Person3D({ seed: 3, ...QUIET }), fit, TEST_GRID.slice(0, 3), mkRng(1), { shift: { x: 12 } });
  // (changed in step 3: the gate is tighter. 3 cm is outside it for model A, so the "not gated" lean is now 1 cm.)
  ok('a 12 cm lean is gated by the head-moved pause, a 1 cm lean is not', score([lean], fit.accuracy)['share.gated'] > 0.9 && score([runBlock(new Person3D({ seed: 3, ...QUIET }), fit, TEST_GRID.slice(0, 3), mkRng(1), { shift: { x: 1 } })], fit.accuracy)['share.gated'] === 0);
  ok('runBlock {gate:false}: the same 12 cm lean is tracked and scored', score([runBlock(new Person3D({ seed: 3, ...QUIET }), fit, TEST_GRID.slice(0, 3), mkRng(1), { shift: { x: 12 }, gate: false })], fit.accuracy)['share.gated'] === 0);
  const tr = new Tracker(fit), moved = { face: true, blink: false, f: new Array(44).fill(0), head: { cx: fit.calibHead.cx + 0.2, cy: fit.calibHead.cy, s: fit.calibHead.s } };
  ok('Tracker: face lost, blink and the 600 ms head pause, in the reader\'s order', tr.push({ face: false }, 0).status === 'lost' && tr.push({ ...moved, head: fit.calibHead, blink: true }, 10).status === 'blink' && tr.push(moved, 20).status === 'ok' && tr.push(moved, 500).status === 'ok' && tr.push(moved, 700).status === 'gated' && tr.push({ ...moved, head: fit.calibHead }, 710).status === 'ok');
  // summaries
  const s = summarize([5, 1, 9, 3, 7], 'x');
  ok('summarize: median with an interval inside the data range, the same every time', s.med === 5 && s.lo >= 1 && s.hi <= 9 && s.lo <= 5 && s.hi >= 5 && JSON.stringify(s) === JSON.stringify(summarize([5, 1, 9, 3, 7], 'x')) && s.n === 5);
  ok('summarize: NaN and null are left out; nothing left gives no number', summarize([NaN, 4, null, 6, 5], 'y').n === 3 && summarize([NaN], 'z').med === null);
  ok('px per degree for the assumed 14 inch 1536x864 screen at 60 cm is about 51.9', near(PX_PER_DEG, 51.9, 0.1));
}

// ---- a small end-to-end run: rows, labels, compare
{
  const R = runBench({ seeds: [1, 2, 3], noise: [0.5] });
  const txt = render(R);
  ok('a run has SYNTH-3D and SYNTH-FEATURE rows for all five conditions', ['STILL', 'HEAD-SHIFT', 'HEAD-ROTATE', 'LATER', 'LOW-FPS'].every((c) => R.rows.some((r) => r.source === 'SYNTH-3D' && r.condition === c) && R.rows.some((r) => r.source === 'SYNTH-FEATURE' && r.condition === c)));
  ok('primary scores are numbers, and movement is worse than sitting still', R.primary.S_still.med > 5 && R.primary.S_move.med > R.primary.S_still.med, `S_still ${R.primary.S_still.med.toFixed(1)}, S_move ${R.primary.S_move.med.toFixed(1)}`);
  const heads = txt.split('\n').filter((l) => l.startsWith('== ') || l.startsWith('PRIMARY'));
  ok('every table header carries the caveat', heads.length >= 6 && heads.every((l) => l.includes(CAVEAT) || l.startsWith('== REAL')), heads.filter((l) => !l.includes(CAVEAT)).join(' | '));
  ok('with no recordings the report says so and prints no REAL number', fs.readdirSync(path.join(LAB_DIR, 'recordings')).filter((f) => f.endsWith('.json')).length > 0 || /^REAL: no recordings$/m.test(txt));
  ok('two runs give identical text', txt === render(runBench({ seeds: [1, 2, 3], noise: [0.5] })));
  ok('fixtures are scored as SYNTH-FEATURE fixtures', R.fixtures.rows.some((r) => r.file === 'synthetic-validate.json' && r.metrics['fix.e.rms'] > 0) && R.fixtures.rows.some((r) => r.phase === 'slouch'));
  const same = renderCompare(R, JSON.parse(JSON.stringify(R)));
  ok('compare with itself: no change, not worse', !same.worse && /delta \+0\.00 px \(\+0\.0%\)/.test(same.text));
  const scaled = (k) => { const B = JSON.parse(JSON.stringify(R)); B.primary.S_still.med *= k; return B; };
  ok('compare: 2 % worse passes, 5 % worse fails', !renderCompare(R, scaled(1 / 1.02)).worse && renderCompare(R, scaled(1 / 1.05)).worse);
  const B2 = JSON.parse(JSON.stringify(R)); B2.primary.S_move.med /= 1.05;
  ok('compare: S_move 5 % worse fails too; a missing score fails', renderCompare(R, B2).worse && renderCompare({ ...R, primary: null }, R).worse);
  // variants reach the calibration
  const v = runBench({ seeds: [1, 2], noise: [0.5], features: 17, trim: false });
  ok('--features and --trim reach fitCalibration', v.config.features === 17 && v.config.trim === false && (() => {
    // (changed in step 3: not every collected frame is a training frame any more, since the validation dots are held out; so the check looks at the dots that were trained on)
    const off = runProcedure(new Person3D({ seed: 1 }), mkRng(3), {}, { trim: false }), on = runProcedure(new Person3D({ seed: 1 }), mkRng(3), {}, {});
    return off.perDot.every((d) => d.kept === 0 || d.kept === d.n) && on.perDot.some((d) => d.kept > 0 && d.kept < d.n) && v.calibration['SYNTH-3D|0.5'][0][30].nTrain > 0;
  })());
}

// ---- step 2: head pose, head-frame models, the shoot-out
{
  // features 0-43 are what they were: the step 2 landmarks have a random stream of their own
  const frames = (o) => { const q = new Person3D({ seed: 6, ...o }); const out = []; for (let i = 0; i < 60; i++) out.push(q.frame(q.tick(), 200 + 9 * i, 100 + 5 * i).f); return out; };
  const std = frames({}), other = frames({ irisRingIndep: 0.5, anchorNoiseK: 2 });
  ok('the first 44 features do not depend on the step 2 noise options; 44-51 do', std.every((f, i) => f.slice(0, 44).every((v, j) => v === other[i][j])) && std.some((f, i) => f[44] !== other[i][44] || f[48] !== other[i][48]));
  // geometry: the gaze ray of the noise-free person lands near the target and stays there when the head moves
  const g = new Person3D({ seed: 3, ...QUIET, matrixNoise: { rotDeg: 0, xyCm: 0, zCm: 0 }, blendNoise: 0, eyeRadiusCm: 1.05 });
  const hits = (shift) => { g.setShift(shift); return [[100, 60], [768, 365], [1400, 660]].map(([x, y]) => { const f = g.frame(g.tick(), x, y).f; return { hit: C.frameHit(f), target: g.last.target, f }; }); };
  const h0 = hits({}), moved = [{ x: 3 }, { y: 2 }, { z: 5 }, { yaw: 5 * D2R }, { pitch: 5 * D2R }, { roll: 5 * D2R }].map(hits);
  ok('gaze ray: lands within 2.5 cm of the target (eye radius as assumed, no noise)', h0.every((q) => Math.hypot(q.hit[0] - q.target[0], q.hit[1] - q.target[1]) < 2.5), h0.map((q) => Math.hypot(q.hit[0] - q.target[0], q.hit[1] - q.target[1]).toFixed(2)).join(' / ') + ' cm');
  const slip = Math.max(...moved.flatMap((m) => m.map((q, i) => Math.hypot(q.hit[0] - h0[i].hit[0], q.hit[1] - h0[i].hit[1]))));
  ok('gaze ray: a 3 cm, 5 cm or 5 degree head movement moves it by under 1 cm (uncorrected: 3 to 5 cm)', slip < 1, 'largest ' + slip.toFixed(2) + ' cm');
  const I = C.FEATURE_INDEX, L = g.last;
  ok('pose features: the face matrix comes back as yaw, pitch, roll in 0.1 rad', near(h0[0].f[I.POSE_OK], 1, 0) && near(moved[5][2].f[I.POSE] * 0.1, L.yaw, 1e-9) && near(moved[5][2].f[I.POSE + 1] * 0.1, L.pitch, 1e-9) && near(moved[5][2].f[I.POSE + 2] * 0.1, L.roll, 1e-9));
  g.setShift({});

  // a calibration during which the head moves: the head-frame model wins, and holds when the head turns
  // (gate off since step 3: model A is paused by a 5 degree turn, and this check is about what the models would say)
  const yawErr = (person, fit, rng) => score([runBlock(person, fit, TEST_GRID, rng, { shift: { yaw: 5 * D2R }, gate: false })], fit.accuracy)['fix.e.rms'];
  const pm = new Person3D({ seed: 3 }), rm = mkRng(7), fm = calibrate(pm, rm, {}, { move: true });
  const pa = new Person3D({ seed: 3 }), ra = mkRng(7), fa = calibrate(pa, ra, { model: 'A' }, { move: true });
  ok('calibration with head movement: the shoot-out picks a head-frame model by more than the margin', fm.kind !== 'A' && fm.kind === fm.accuracy.model && fm.kind === fm.model.kind && fm.shootout.eff[fm.kind] < 0.95 * fm.shootout.eff.A, `${fm.kind}: ${JSON.stringify(fm.shootout.eff)} (${fm.shootout.note})`);
  ok('calibration with head movement: asking for A gives A, on the same rows', fa.kind === 'A' && fa.train.X.length === fm.train.X.length && fa.shootout.asked === 'A');
  const eE = yawErr(pm, fm, rm), eA = yawErr(pa, fa, ra);
  ok('a 5 degree head turn afterwards: the head-frame model is at least twice as close as A', eE < 0.5 * eA, `${fm.kind} ${eE.toFixed(0)} px, A ${eA.toFixed(0)} px`);
  ok('the head-frame model: geometry sane (px per cm of a laptop screen, rays line up with the dots)', fm.model.geo.pxPerCm > 25 && fm.model.geo.pxPerCm < 75 && fm.model.geo.r2.every((v) => v > 0.9), `${fm.model.geo.pxPerCm.toFixed(1)} px/cm against ${(Math.hypot(1536, 864) / (14 * 2.54)).toFixed(1)} true`);
  const back = C.Ridge.fromJSON(JSON.parse(JSON.stringify(fm.model))), f1 = fm.train.X[10];
  ok('the head-frame model survives saving and loading', back.kind === fm.kind && back.inputWidth === 63 && near(back.predict(f1)[0], fm.model.predict(f1)[0], 1e-9) && near(back.predict(f1)[1], fm.model.predict(f1)[1], 1e-9));
  const re = C.refitModel(back, fm.train.X.concat([f1, f1]), fm.train.Y.concat([[500, 300], [500, 300]]), fm.train.G.concat(['click', 'click']));
  ok('refitModel keeps the kind, the geometry and the penalties of a head-frame model', re.kind === fm.kind && re.geo === back.geo && re.lambdaXY[0] === back.lambdaXY[0] && re.lambdaXY[1] === back.lambdaXY[1] && re.n === fm.train.X.length + 2);
  ok('a head-frame model keeps its answer within the viewport plus 15 %', (() => { const far = f1.slice(); far[I.HEAD_IRIS] += 5; far[I.HEAD_IRIS + 2] += 5; const q = fm.model.predict(far); return q[0] >= -0.15 * 1536 - 1e-9 && q[0] <= 1.15 * 1536 + 1e-9 && q[1] >= -0.15 * 730 - 1e-9 && q[1] <= 1.15 * 730 + 1e-9; })());
  // the wrong matrix convention must not get through a calibration that moves the head
  const pt = new Person3D({ seed: 3, matrixTranspose: true }), ft = calibrate(pt, mkRng(7), {}, { move: true });
  ok('a face matrix in the wrong convention (row-major): the shoot-out stays with A', ft.kind === 'A', ft.shootout.note);
  // sitting still, nothing tells the models apart: A stays unless another is 5 % better, and forcing works
  const ps = new Person3D({ seed: 2 }), fs2 = calibrate(ps, mkRng(7));
  const pe = new Person3D({ seed: 2 }), fe = calibrate(pe, mkRng(7), { model: 'E' });
  ok('still calibration: the choice follows the 5 % rule, and model E can be asked for', (fs2.kind === 'A') === !(Math.min(...['B', 'C', 'E'].map((k) => fs2.shootout.eff[k])) < 0.95 * fs2.shootout.eff.A) && fe.kind === 'E' && fe.shootout.asked === 'E', `auto: ${fs2.kind} ${JSON.stringify(fs2.shootout.eff)}`);
  // the lab's synthetic person has 44 numbers and no landmarks: always A
  const R = runBench({ seeds: [1, 2], noise: [0.5] });
  ok('SYNTH-FEATURE (44 numbers per frame) always ends with model A', R.rows.filter((r) => r.source === 'SYNTH-FEATURE').every((r) => r.models === 'A 2'));
  // (changed in step 3: the variants are now about the calibration procedure; six rows with the standard run)
  ok('every row says which model was in use; the standard run also prints the other models and calibrations', R.rows.every((r) => /^[ABCE] \d/.test(r.models)) && R.variants.length === 6 && R.variants.every((v) => v.primary && v.rows.length === 5 && v.procedure) && /people under other models and calibrations/.test(render(R)) && R.config.standard === true && R.config.cal === 'proc');
  const shipped = R.variants[0], procA = R.variants.find((v) => v.name === 'procedure, model A forced');
  ok('the procedure with its head segment: a head-frame model for everyone, and movement costs under twice the still error', shipped.models === 'E 2' && shipped.primary.S_move.med < 2 * shipped.primary.S_still.med && shipped.procedure.secMax < 60, `${shipped.models}; S_still ${shipped.primary.S_still.med.toFixed(0)}, S_move ${shipped.primary.S_move.med.toFixed(0)} px; ${shipped.procedure.secMax.toFixed(0)} s`);
  ok('model A forced: the head gate pauses it for the 5 degree turns instead of tracking them wrongly', procA.models === 'A 2' && procA.rows.find((r) => r.condition === 'HEAD-ROTATE').metrics['share.gated'].med > 0.8 && procA.rows.find((r) => r.condition === 'STILL').metrics['share.gated'].med < 0.05);
  const forced = runBench({ seeds: [1, 2], noise: [0.5], model: 'A' });
  ok('--model A: every calibration is model A, no variants table, not the standard run', forced.rows.every((r) => r.models === 'A 2') && forced.variants.length === 0 && forced.config.standard === false && forced.primary.S_still.med === procA.primary.S_still.med);
  ok('--proc, --who and --fit reach the procedure: not the standard run, and a careless reader gets dots shown again', (() => {
    const v = runBench({ seeds: [1, 2], noise: [0.5], who: SLOPPY, variants: false }), o = runBench({ seeds: [1], noise: [0.5], proc: PROC_OLD, fit: FIT_OLD, variants: false });
    const p = v.calibration['SYNTH-3D|0.5'].map((c) => c[30].procedure), q = o.calibration['SYNTH-3D|0.5'][0][30];
    return v.config.standard === false && p.some((x) => x.reshown.length > 0) && q.procedure.reshown.length === 0 && q.procedure.dots === 18 && q.accuracy.source === 'val';
  })());
  const hyg = runBench({ seeds: [1], noise: [0.5], model: 'A', hygiene: { bounds: 0.15, zClamp: 4 }, variants: false }), cols = runBench({ seeds: [1], noise: [0.5], columns: [0, 1, 2, 3, 4, 5, 6, 7], variants: false });
  ok('--hygiene and --columns reach fitCalibration', hyg.config.hygiene.zClamp === 4 && cols.config.columns.length === 8 && cols.rows[0].models === 'A 1' && cols.primary.S_still.med !== forced.primary.S_still.med);
}

// ---- step 3: the calibration procedure driven by a synthetic person, the gate sweep, and the way back to step 2
{
  const mk = (seed) => new Person3D({ seed });
  const clean = runProcedure(mk(4), mkRng(9)), careless = runProcedure(mk(4), mkRng(9), {}, {}, { late: 0.3, bad: 0.15, lost: 0.1 });
  ok('runProcedure: 18 dots and the head segment in under a minute; a head-frame model is chosen on unseen dots', clean.procedure.dots >= 21 && clean.procedure.ms < 60000 && clean.kind !== 'A' && clean.shootout.moveDots === 3 && clean.shootout.eff[clean.kind] < 0.95 * clean.shootout.eff.A && clean.accuracy.source === 'val' && clean.accuracy.dots === 5, `${clean.procedure.dots} dots, ${(clean.procedure.ms / 1000).toFixed(1)} s, ${clean.shootout.note}`);
  ok('runProcedure: the calibration pose is stored for the head gate', clean.calibHead.pose === true && Math.abs(clean.calibHead.pitch) < 0.5 && clean.calibHead.tz < -30 && clean.calibHead.tz > -90, JSON.stringify(Object.fromEntries(Object.entries(clean.calibHead).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v]))));
  ok('runProcedure, careless reader: dots are shown again and the calibration still comes out', careless.procedure.reshown.length >= 1 && careless.procedure.ms < 75000 && careless.accuracy.effY < 2 * clean.accuracy.effY + 10, `${careless.procedure.reshown.length} shown again, ${(careless.procedure.ms / 1000).toFixed(1)} s, ±${careless.accuracy.effY} px against ±${clean.accuracy.effY} px`);
  const still = runProcedure(mk(4), mkRng(9), {}, {}, { headDeg: 0, headCm: 0 }), noHead = runProcedure(mk(4), mkRng(9), { head: false });
  ok('runProcedure: head: false shows no head segment; a reader who does not move gives model A nothing to lose on', noHead.procedure.dots < clean.procedure.dots && noHead.shootout.moveDots === 0 && noHead.extra === null && still.shootout.eff.A < 0.7 * clean.shootout.eff.A, `unseen-dot error of A: ${still.shootout.eff.A} still head, ${clean.shootout.eff.A} head moved`);
  // ---- sign-off: the reader who reads the head-turn instruction, the pause, and model A's gate
  {
    const mk = () => new Person3D({ seed: 4, noisePx: 0.5 });
    const still = (fit, person) => score([runBlock(person, fit, TEST_GRID, mkRng(9), {})], fit.accuracy)['fix.e.rms'];
    const p0 = mk(), noTrim = runProcedure(p0, mkRng(4), { headPause: false }, { featureCount: 25, model: 'auto', moveTrim: false }, { readMs: 2500 }), e0 = still(noTrim, p0);
    const p1 = mk(), trim = runProcedure(p1, mkRng(4), { headPause: false }, { featureCount: 25, model: 'auto' }, { readMs: 2500 }), e1 = still(trim, p1);
    const p2 = mk(), clean = runProcedure(p2, mkRng(4), {}, { featureCount: 25, model: 'auto' }, {}), e2 = still(clean, p2);
    ok('reading the head-turn text for 2.5 s while the first head dot is sampled: those frames are dropped from the fit', trim.shootout.moveTrim.dropped > 20 && noTrim.shootout.moveTrim.dropped === 0 && trim.shootout.moveTrim.dropped < 0.6 * trim.shootout.moveTrim.frames, `dropped ${trim.shootout.moveTrim.dropped} of ${trim.shootout.moveTrim.frames} head-segment frames (limit ${trim.shootout.moveTrim.limit} px)`);
    ok('... and the calibration is then about as good as a clean one, where it used to be much worse', e1 < 1.25 * e2 && e0 > 1.3 * e1, `still error px: untrimmed ${e0.toFixed(1)}, trimmed ${e1.toFixed(1)}, a reader who never looked away ${e2.toFixed(1)}`);
    ok('a reader who keeps the eyes on the dot loses next to nothing to the trim', clean.shootout.moveTrim.dropped <= 0.02 * clean.shootout.moveTrim.frames && clean.kind === 'E', `dropped ${clean.shootout.moveTrim.dropped} of ${clean.shootout.moveTrim.frames}`);
    ok('the procedure as the reader runs it waits on the card before the head segment (headPause), and the bench does the same', clean.procedure.pausedMs >= 3900 && /headPause: true/.test(fs.readFileSync(path.join(REPO_DIR, 'glider-extension', 'gaze', 'gaze-reader.js'), 'utf8')), `waited ${clean.procedure.pausedMs} ms`);
    // model A in use and a head that follows the eyes a fifth of the way: sitting as calibrated must not pause the tracker
    const gatedStill = [5, 6].map((seed) => { const p = new Person3D({ seed, noisePx: 0.5, headFollow: 0.2 }), f = runProcedure(p, mkRng(seed), {}, { featureCount: 25, model: 'A' }, {}); return score([runBlock(p, f, TEST_GRID, mkRng(seed + 1), {})], f.accuracy)['share.gated']; });
    ok('model A, head following the eyes (headFollow 0.2), same posture as calibrated: the head gate does not pause the reader', gatedStill.every((v) => v < 0.05), `gated ${gatedStill.map((v) => (100 * v).toFixed(0) + ' %').join(', ')} (it was about half before the limits were widened)`);
    const deep = new Person3D({ seed: 4, noisePx: 0.5, matrixDepthK: 0.68 }), shallow = new Person3D({ seed: 4, noisePx: 0.5 });
    deep.tick(); shallow.tick(); deep.frame(deep.t, 700, 300); shallow.frame(shallow.t, 700, 300);
    ok('--set matrixDepthK scales the depth the face matrix reports (a real camera reports about 0.6 to 0.7 of the true distance)', Math.abs(deep.last.matrix[14] / shallow.last.matrix[14] - 0.68) < 0.03 && shallow.last.matrix[14] < -40, `tz ${shallow.last.matrix[14].toFixed(1)} -> ${deep.last.matrix[14].toFixed(1)}`);
  }
  // the wrong matrix convention must not get through the head segment either
  const wrong = runProcedure(new Person3D({ seed: 4, matrixTranspose: true }), mkRng(9));
  ok('runProcedure with a face matrix in the wrong convention: the shoot-out stays with A', wrong.kind === 'A', wrong.shootout.note);
  // the calibration of step 2 is still reachable, to the last digit (its tracking scores are not: the fixation detector's limit changed in step 3)
  const saved = JSON.parse(fs.readFileSync(new URL('./after-step2.json', import.meta.url), 'utf8')).calibration['SYNTH-3D|0.5'].find((q) => q.seed === 1)[30];
  const old = runSeed((seed, fps) => new Person3D({ seed, fps, noisePx: 0.5 }), 1, { featureCount: 25, trim: true, model: 'auto', fold: true, score: 'val' }, { old: true }).cal[30];
  ok('the step 2 calibration (fixed loop, validation dots folded in, accuracy from a 13-dot fit) still gives the model and the accuracy saved after step 2 for seed 1', old.kind === saved.kind && old.cvErr === saved.cvErr && old.lambda === saved.lambda && old.nTrain === saved.nTrain && ['accuracyX', 'accuracyY', 'precisionX', 'precisionY', 'effX', 'effY'].every((k) => old.accuracy[k] === saved.accuracy[k]) && JSON.stringify(old.shootout.eff) === JSON.stringify(saved.shootout.eff), `${old.kind} cvErr ${old.cvErr} against ${saved.kind} ${saved.cvErr}`);
  const W = gateSweep({ seeds: [1, 2, 3], model: 'auto' }), WA = gateSweep({ seeds: [1, 2, 3], model: 'A' });
  ok('gate sweep: error grows with the size of the movement, and model A doubles long before a head-frame model', W.axes.yaw.rows[6].ratio > W.axes.yaw.rows[0].ratio && WA.axes.yaw.doubles < 3 && WA.axes.x.doubles < 3 && (W.axes.yaw.doubles === null || W.axes.yaw.doubles > 2 * WA.axes.yaw.doubles) && /doubles at/.test(renderSweep(W)), `yaw: A ${WA.axes.yaw.doubles.toFixed(1)} deg, ${W.models} ${W.axes.yaw.doubles === null ? 'never' : W.axes.yaw.doubles.toFixed(1) + ' deg'}`);
}

// ---- step 3e and 3f: blinks when the lids follow the eyes down, and clicks
{
  // a person whose blink score rises a lot when looking down: the fixed rule loses the bottom of the screen, the detector does not
  const frames = (y) => { const p = new Person3D({ seed: 5, blinkDownK: 0.55, blinkEveryMs: 0 }), det = new C.BlinkDetector(); let flag = 0, lids = 0, n = 0; for (let i = 0; i < 300; i++) { const t = p.tick(), fr = p.frame(t, 700, i < 60 ? 100 : y); const b = det.push(fr.lids, t); if (i >= 120) { n++; if (fr.blink) flag++; if (b) lids++; } } return { flag: flag / n, lids: lids / n }; };
  const bottom = frames(690), top = frames(100);
  ok('lids that follow the eyes down: the fixed blink rule drops the bottom of the screen, BlinkDetector does not', bottom.flag > 0.8 && bottom.lids < 0.05 && top.lids < 0.05, `bottom of the screen: fixed rule ${(100 * bottom.flag).toFixed(0)} % of frames, detector ${(100 * bottom.lids).toFixed(0)} %; top: ${(100 * top.flag).toFixed(0)} % and ${(100 * top.lids).toFixed(0)} %`);
  const p = new Person3D({ seed: 9, blinkEveryMs: 3000 }), det = new C.BlinkDetector(); let shut = 0, caught = 0, n = 0, out = 0;
  for (let i = 0; i < 9000; i++) { const t = p.tick(), fr = p.frame(t, 700, 300), b = det.push(fr.lids, t); n++; if (b) out++; if (p.last.shut > 0.5) { shut++; if (b) caught++; } }
  ok('real blinks are still caught by BlinkDetector, at the cost of a few more frames (two after each blink)', shut > 100 && caught / shut > 0.97 && out / n < 0.2, `${(100 * caught / shut).toFixed(0)} % of half-shut frames caught, ${(100 * out / n).toFixed(1)} % of all frames left out`);
  const coupled = runBench({ seeds: [1, 2, 3], noise: [0.5], set: { blinkDownK: 0.55 }, variants: false }), fixed = runBench({ seeds: [1, 2, 3], noise: [0.5], set: { blinkDownK: 0.55 }, proc: { blinks: 'flag' }, variants: false });
  const row = (R) => R.rows.find((r) => r.source === 'SYNTH-3D' && r.condition === 'STILL');
  ok('the same person through the whole bench: every calibration comes out and the bottom row keeps its frames; with the fixed rule calibrations fail', row(coupled).calibrationFailed === 0 && row(coupled).metrics['share.blinkBottom'].med < 0.15 && row(fixed).calibrationFailed >= 1, `detector: ${row(coupled).calibrationFailed} of 3 failed, ${(100 * row(coupled).metrics['share.blinkBottom'].med).toFixed(0)} % of bottom-row frames lost; fixed rule: ${row(fixed).calibrationFailed} of 3 failed`);
  const K = clickBench({ seeds: [1, 2, 3, 4], clicks: 10 });
  ok('click refinement: the gate lets through clicks the eyes are on, not the others, and the model is no worse for it', K.usedOn > 0.4 && K.usedOff < 0.1 && K.gated < 1.05 * K.none && K.all > K.gated && /gated clicks/.test(renderClicks(K)), `no clicks ${K.none.toFixed(1)}, every click ${K.all.toFixed(1)}, gated ${K.gated.toFixed(1)} px; let through ${(100 * K.usedOn).toFixed(0)} % / ${(100 * K.usedOff).toFixed(0)} %`);
}

// ---- recordings folder handling
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaze-bench-'));
  try {
    ok('an empty recordings folder: no files, no rows', scoreRecordings(dir).files === 0 && scoreRecordings(dir).rows.length === 0 && scoreRecordings(path.join(dir, 'missing')).files === 0);
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ task: 'camera', truth: [{ kind: 'target', x: 5, y: 5, tShow: 0, tSettle: 700, tEnd: 2000 }], events: [] }));
    fs.writeFileSync(path.join(dir, 'b.json'), '{ not json');
    const r = scoreRecordings(dir);
    ok('a recording without a calibration is skipped with a reason, a broken file is ignored', r.files === 2 && r.rows.length === 0 && r.skipped.length === 1 && /no calibration/.test(r.skipped[0]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---- step 4: the REAL rows fill from a recordings folder (lab fixtures copied to a temp folder; nothing is written into tests/lab/recordings)
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gaze-bench-real-'));
  try {
    const fx = path.join(LAB_DIR, 'fixtures'), recDir = path.join(LAB_DIR, 'recordings');
    const count = (d) => { try { return fs.readdirSync(d).length; } catch { return 0; } };
    for (const f of ['synthetic-validate.json', 'synthetic-headshift.json', 'synthetic-camera.json']) fs.copyFileSync(path.join(fx, f), path.join(dir, f));
    // a calibrate recording as the lab writes it since step 4: the calibration's dots as truth, the five check dots also as targets
    const v = JSON.parse(fs.readFileSync(path.join(fx, 'synthetic-validate.json'), 'utf8'));
    const five = v.truth.filter((e) => e.kind === 'target').slice(0, 5);
    fs.writeFileSync(path.join(dir, 'zz-calibrate.json'), JSON.stringify({ ...v, task: 'calibrate', session: { id: 'cal-123' }, truth: five.flatMap((e, i) => [{ kind: 'caldot', id: `check-${300 + i}`, seg: 'check', role: 'check', x: e.x, y: e.y, tShow: e.tShow, tSettle: e.tSettle, tEnd: e.tEnd, frames: 30, settled: true }, { ...e, id: `check-${300 + i}`, phase: 'check' }]) }));
    const before = count(recDir);
    const real = scoreReal(dir), text = renderReal(real);
    const val = real.rows.find((r) => r.file === 'synthetic-validate.json'), hs = real.rows.filter((r) => r.file === 'synthetic-headshift.json'), cal = real.rows.find((r) => r.file === 'zz-calibrate.json');
    ok('--recordings DIR: the REAL rows fill from the files in it (validate, the four headshift phases, the check dots of a calibrate recording); a recording made before any calibration is skipped with the reason',
      real.given && real.files === 4 && !!val && val.metrics['fix.e.rms'] > 5 && val.metrics['fix.e.rms'] < 80 && hs.length === 4 && !!cal && cal.phase === 'check' && cal.session === 'cal-123' && cal.metrics['n.fix'] > 0 && real.skipped.length === 1 && /synthetic-camera/.test(real.skipped[0]) && /== REAL: recordings from .*gaze-bench-real-/.test(text) && /given with --recordings/.test(text),
      `${real.rows.length} rows; validate ${val && val.metrics['fix.e.rms'].toFixed(1)} px; headshift ${hs.map((r) => r.phase + ' ' + (Number.isFinite(r.metrics['fix.e.rms']) ? r.metrics['fix.e.rms'].toFixed(0) : 'all gated')).join(', ')}; check dots ${cal && cal.metrics['fix.e.rms'].toFixed(1)} px; skipped: ${real.skipped.join(' | ')}`);
    ok('the default folder is named as before, and scoring a temp folder writes nothing into tests/lab/recordings', scoreReal().dir === 'tests/lab/recordings' && !scoreReal().given && count(recDir) === before && /^REAL: no recordings in /.test(renderReal(scoreReal(path.join(dir, 'none')))));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log(failed ? `\n${failed} bench check(s) FAILED` : '\nall bench checks passed');
process.exitCode = failed ? 1 : 0;
