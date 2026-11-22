// node tests/gaze-core.test.js — sanity + simulation tests for glider-extension/gaze/gaze-core.js
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'glider-extension', 'gaze', 'gaze-core.js'));
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exit(1); } console.log('ok  ', m); };
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;

// 1. solve()
const w = C.solve([[4, 1], [1, 3]].map((r) => Float64Array.from(r)), [1, 2]);
assert(Math.abs(w[0] - 1 / 11) < 1e-9 && Math.abs(w[1] - 7 / 11) < 1e-9, 'linear solve');

// 2. extractFeatures on a synthetic face: moving the irises right/down moves u/v
function face(irisDx, irisDy) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const set = (i, x, y) => { lm[i] = { x, y, z: 0 }; };
  set(33, 0.40, 0.45); set(133, 0.46, 0.45); set(159, 0.43, 0.435); set(145, 0.43, 0.465);
  set(362, 0.54, 0.45); set(263, 0.60, 0.45); set(386, 0.57, 0.435); set(374, 0.57, 0.465);
  set(468, 0.43 + irisDx, 0.45 + irisDy); set(473, 0.57 + irisDx, 0.45 + irisDy);
  return lm;
}
const a = C.extractFeatures(face(0, 0), null, null, 1280, 720);
const b = C.extractFeatures(face(0.01, 0.005), null, null, 1280, 720);
assert(a.f.length === 63 && C.FEATURE_COUNT === 63 && C.BASE_FEATURE_COUNT === 44, `feature length ${a.f.length}: the 44 numbers of before, then 19 appended in step 2`);
assert(b.f[8] > a.f[8] && b.f[9] > a.f[9], 'iris shift moves u/v features');
assert(!a.blink, 'open eyes not flagged as blink');

// 3. Ridge on simulated calibration: features are noisy, partly nonlinear functions of gaze + head pose
const W = 1440, H = 900;
function sim(x, y, head) {
  const u = 0.12 * (x / W - 0.5) + 0.02 * head + 0.004 * gauss();
  const v = 0.05 * (y / H - 0.5) + 0.003 * gauss();      // vertical signal is weaker on webcams
  const f = [u, v, v * 0.8 + 0.003 * gauss(), 0.3 + v + 0.004 * gauss(), u, v, v, 0.3, u, v, v, 0.3, u * u, v * v, u * v, v * v, u * v];
  for (let k = 0; k < 8; k++) f.push(Math.max(0, (k < 4 ? -v : u) * 3 + 0.02 * gauss()));
  for (let k = 0; k < 16; k++) f.push(k === 3 ? head : k === 15 ? 1 : 0.01 * gauss());
  f.push(0.5 + 0.01 * head, 0.5, 0.1);
  return f;
}
const pts = [];
for (const fx of [0.06, 0.5, 0.94]) for (const fy of [0.08, 0.5, 0.92]) pts.push([fx * W, fy * H]);
for (const fx of [0.28, 0.72]) for (const fy of [0.29, 0.71]) pts.push([fx * W, fy * H]);
const X = [], Y = [], G = [];
pts.forEach((p, gi) => { const head = gauss() * 0.3; for (let k = 0; k < 25; k++) { X.push(sim(p[0], p[1], head)); Y.push(p); G.push(gi); } });
const model = new C.Ridge().fit(X, Y, G);
let se = 0, cnt = 0;
for (let k = 0; k < 400; k++) { const x = rnd() * W, y = rnd() * H; const p = model.predict(sim(x, y, gauss() * 0.3)); se += (p[0] - x) ** 2 + (p[1] - y) ** 2; cnt++; }
const rmse = Math.sqrt(se / cnt);
console.log(`     ridge: lambda=${model.lambda} cvErr=${model.cvErr.toFixed(1)}px testRMSE=${rmse.toFixed(1)}px`);
assert(rmse < 120, 'ridge recovers gaze on simulated data');
const m2 = C.Ridge.fromJSON(JSON.parse(JSON.stringify(model)));
assert(Math.abs(m2.predict(X[0])[0] - model.predict(X[0])[0]) < 1e-9, 'ridge serializes');

// 4. Fixation detector on a noisy reading scanpath (30 Hz)
const fd = new C.FixationDetector({ dispersion: 90 });
let t = 0, fixes = [];
const truth = [];
for (let line = 0; line < 4; line++) for (let k = 0; k < 6; k++) truth.push([200 + k * 110, 300 + line * 60, 250]);
for (const [x, y, dur] of truth) for (let s = 0; s < dur; s += 33) { const f = fd.push(t, x + 12 * gauss(), y + 12 * gauss()); if (f) fixes.push(f); t += 33; }
console.log(`     fixations: ${fixes.length} detected for ${truth.length} true`);
assert(fixes.length >= truth.length * 0.7 && fixes.length <= truth.length * 1.6, 'fixation count plausible');

// 5. Line locking vs nearest-line at different tracker error levels
function readSim(pitch, sy, trials = 200) {
  let hmmOk = 0, nearOk = 0, n = 0;
  const lines = Array.from({ length: 8 }, (_, i) => ({ top: 100 + i * pitch, bottom: 100 + i * pitch + pitch * 0.7, left: 100, right: 900 }));
  for (let tr = 0; tr < trials; tr++) {
    const hmm = new C.LineHMM();
    const bias = gauss() * sy * 0.5;                       // slow calibration drift shared by a whole paragraph
    let first = true;
    for (let li = 0; li < lines.length; li++) {
      // occasional regression to previous line
      const seq = [li]; if (li > 0 && rnd() < 0.15) seq.push(li - 1, li);
      for (const L of seq) {
        for (let k = 0; k < 7; k++) {
          const cy = (lines[L].top + lines[L].bottom) / 2;
          const fx = 120 + k * 120 + gauss() * 40, fy = cy + bias + gauss() * sy;
          const r = hmm.update(lines, fx, fy, 60, sy, first); first = false;
          let nearest = 0; for (let j = 1; j < lines.length; j++) if (Math.abs((lines[j].top + lines[j].bottom) / 2 - fy) < Math.abs((lines[nearest].top + lines[nearest].bottom) / 2 - fy)) nearest = j;
          hmmOk += r.line === L; nearOk += nearest === L; n++;
        }
      }
    }
  }
  return [nearOk / n, hmmOk / n];
}
for (const [pitch, sy] of [[60, 30], [60, 45], [60, 60], [48, 45], [80, 60]]) {
  const [nl, hmm] = readSim(pitch, sy);
  console.log(`     line pitch ${pitch}px, vertical error σ=${sy}px: nearest-line ${(nl * 100).toFixed(0)}%  →  HMM ${(hmm * 100).toFixed(0)}%`);
}
const [n60, h60] = readSim(60, 45);
assert(h60 > n60 + 0.1, 'HMM line locking beats nearest-line');

// 6. mergeLineRects
const merged = C.mergeLineRects([
  { top: 10, bottom: 30, left: 0, right: 100, width: 100, height: 20 },
  { top: 12, bottom: 28, left: 100, right: 200, width: 100, height: 16 },
  { top: 40, bottom: 60, left: 0, right: 150, width: 150, height: 20 },
]);
assert(merged.length === 2 && merged[0].right === 200, 'line rect merge');

// 7. Personal baseline + struggle decision (pure functions added with the reading-pace baseline)
if (typeof C.summarizeBaseline === 'function') {
  assert(typeof C.tauFromCv === 'function' && typeof C.struggleDecision === 'function', 'tauFromCv and struggleDecision are exported');

  // --- tauFromCv: personal threshold from the reader's own variability
  assert(near(C.tauFromCv(0), 1.6, 1e-9), `tauFromCv(0) is 1.6 (got ${C.tauFromCv(0)})`);
  assert(near(C.tauFromCv(0.6), 3.0, 1e-9) && near(C.tauFromCv(0.9), 3.0, 1e-9) && near(C.tauFromCv(5), 3.0, 1e-9),
    `very erratic reader (cv >= 0.6) gets 3.0 (got ${C.tauFromCv(0.6)}, ${C.tauFromCv(0.9)}, ${C.tauFromCv(5)})`);
  let mono = true, inRange = true, prevTau = -Infinity;
  for (let cv = 0; cv <= 1.2001; cv += 0.01) {
    const tau = C.tauFromCv(cv);
    if (!(tau >= prevTau - 1e-12)) mono = false;
    if (!(tau >= 1.6 - 1e-12 && tau <= 3.0 + 1e-12)) inRange = false;
    prevTau = tau;
  }
  assert(mono, 'tauFromCv is monotonic non-decreasing in cv');
  assert(inRange, 'tauFromCv stays within [1.6, 3.0]');
  assert(C.tauFromCv(0.1) < C.tauFromCv(0.5), `steady reader gets a lower tau than an erratic one (${C.tauFromCv(0.1)} < ${C.tauFromCv(0.5)})`);

  // --- summarizeBaseline
  const even = (n, words, dwellMs) => Array.from({ length: n }, () => ({ words, dwellMs }));
  // 5 lines x 10 words, 3 s of gaze each (15 s) inside an 18 s wall clock: gaze 200 wpm, clock 166.7 wpm
  const g1 = C.summarizeBaseline({ lines: even(5, 10, 3000), clockMs: 18000, totalWords: 50, regressions: 1 });
  console.log('     baseline (gaze):', JSON.stringify(g1));
  assert(g1.source === 'gaze', `all lines have dwell and gaze time is 83% of the clock: source 'gaze' (got ${g1.source})`);
  assert(near(g1.wpm, 200, 1), `gaze wpm comes from the gaze dwell: 200 (got ${g1.wpm})`);
  assert(near(g1.msPerWord, 300, 2), `msPerWord 300 (got ${g1.msPerWord})`);
  assert(near(g1.cv, 0, 1e-9), `perfectly even lines: cv 0 (got ${g1.cv})`);
  assert(near(g1.tau, 1.6, 1e-9), `cv 0 gives tau 1.6 (got ${g1.tau})`);
  assert(near(g1.regressionRate, 0.2, 1e-9), `regressionRate = regressions / lines = 0.2 (got ${g1.regressionRate})`);
  assert(g1.lines === 5 && g1.words === 50, `lines 5, words 50 (got ${g1.lines}, ${g1.words})`);
  assert(g1.ms === 15000 || g1.ms === 18000, `ms is the measured reading time (got ${g1.ms})`);

  // Only 2 of 5 lines have dwell (40% < 60%): fall back to the clock
  const c1 = C.summarizeBaseline({
    lines: [{ words: 10, dwellMs: 3000 }, { words: 10, dwellMs: 3000 }, { words: 10, dwellMs: 0 }, { words: 10, dwellMs: 0 }, { words: 10, dwellMs: 0 }],
    clockMs: 20000, totalWords: 50, regressions: 0,
  });
  console.log('     baseline (clock):', JSON.stringify(c1));
  assert(c1.source === 'clock', `2 of 5 lines with dwell: source 'clock' (got ${c1.source})`);
  assert(near(c1.wpm, 150, 1), `clock wpm = totalWords / clockMs = 150 (got ${c1.wpm})`);
  assert(near(c1.msPerWord, 400, 2), `clock msPerWord 400 (got ${c1.msPerWord})`);
  assert(c1.cv === 0, `fewer than 3 lines with dwell: cv 0 (got ${c1.cv})`);
  assert(c1.ms === 20000, `clock source reports the clock time (got ${c1.ms})`);
  assert(c1.regressionRate === 0, 'no regressions: rate 0');

  // Line-coverage boundary: 3 of 5 (exactly 60%) is enough, 2 of 5 is not
  const cover = (k) => C.summarizeBaseline({
    lines: Array.from({ length: 5 }, (_, i) => ({ words: 10, dwellMs: i < k ? 3000 : 0 })),
    clockMs: k * 3000 + 1000, totalWords: 50, regressions: 0,
  });
  assert(cover(3).source === 'gaze', `exactly 60% of lines with dwell: 'gaze' (got ${cover(3).source})`);
  assert(cover(2).source === 'clock', `40% of lines with dwell: 'clock' (got ${cover(2).source})`);

  // Dwell-vs-clock boundary: summed gaze dwell must be 50%..130% of the clock
  const ratio = (r) => C.summarizeBaseline({ lines: even(5, 10, 2000), clockMs: 10000 / r, totalWords: 50, regressions: 0 });
  assert(ratio(0.45).source === 'clock', `gaze dwell 45% of clock: 'clock' (got ${ratio(0.45).source})`);
  assert(ratio(0.55).source === 'gaze', `gaze dwell 55% of clock: 'gaze' (got ${ratio(0.55).source})`);
  assert(ratio(1.25).source === 'gaze', `gaze dwell 125% of clock: 'gaze' (got ${ratio(1.25).source})`);
  assert(ratio(1.35).source === 'clock', `gaze dwell 135% of clock: 'clock' (got ${ratio(1.35).source})`);
  assert(near(ratio(0.45).wpm, 50 / (10000 / 0.45) * 60000, 1), `rejected gaze: wpm from the clock (got ${ratio(0.45).wpm})`);

  // wpm clamped to [40, 600] whichever source is used
  const fastG = C.summarizeBaseline({ lines: even(5, 20, 1000), clockMs: 5500, totalWords: 100, regressions: 0 });    // 1200 wpm
  const slowG = C.summarizeBaseline({ lines: even(5, 4, 12000), clockMs: 66000, totalWords: 20, regressions: 0 });     // 20 wpm
  const fastC = C.summarizeBaseline({ lines: even(5, 20, 0), clockMs: 5000, totalWords: 100, regressions: 0 });        // 1200 wpm
  const slowC = C.summarizeBaseline({ lines: even(5, 4, 0), clockMs: 60000, totalWords: 20, regressions: 0 });         // 20 wpm
  assert(fastG.source === 'gaze' && fastG.wpm === 600, `gaze wpm clamps at 600 (got ${fastG.source} ${fastG.wpm})`);
  assert(slowG.source === 'gaze' && slowG.wpm === 40, `gaze wpm clamps at 40 (got ${slowG.source} ${slowG.wpm})`);
  assert(fastC.source === 'clock' && fastC.wpm === 600, `clock wpm clamps at 600 (got ${fastC.source} ${fastC.wpm})`);
  assert(slowC.source === 'clock' && slowC.wpm === 40, `clock wpm clamps at 40 (got ${slowC.source} ${slowC.wpm})`);

  // cv: coefficient of variation of per-line ms-per-word over the lines that have dwell
  const msw = (list) => list.map((m) => ({ words: 10, dwellMs: m * 10 }));
  const v3 = C.summarizeBaseline({ lines: msw([200, 300, 400]), clockMs: 10000, totalWords: 30, regressions: 0 });
  // sd of [200,300,400] is 81.65 (population) or 100 (sample); either convention is accepted
  assert(near(v3.cv, 0.2722, 0.004) || near(v3.cv, 0.3333, 0.004), `cv of 200/300/400 ms-per-word lines is 0.27 (or 0.33 with sample sd) (got ${v3.cv})`);
  assert(near(v3.tau, C.tauFromCv(v3.cv), 1e-9), `tau is tauFromCv(cv) (got ${v3.tau} vs ${C.tauFromCv(v3.cv)})`);
  const v2 = C.summarizeBaseline({ lines: msw([200, 400]), clockMs: 6500, totalWords: 20, regressions: 0 });
  assert(v2.cv === 0, `only 2 lines with dwell: cv 0 (got ${v2.cv})`);
  const v3z = C.summarizeBaseline({ lines: msw([200, 300, 400]).concat([{ words: 10, dwellMs: 0 }]), clockMs: 10000, totalWords: 40, regressions: 2 });
  assert(near(v3z.cv, v3.cv, 1e-6), `lines without dwell are left out of cv (got ${v3z.cv} vs ${v3.cv})`);
  assert(near(v3z.regressionRate, 0.5, 1e-9), `regressionRate counts every line: 2 / 4 (got ${v3z.regressionRate})`);
  const steady = C.summarizeBaseline({ lines: msw([290, 300, 310, 300, 295, 305]), clockMs: 19000, totalWords: 60, regressions: 0 });
  const erratic = C.summarizeBaseline({ lines: msw([120, 520, 200, 640, 150, 470]), clockMs: 22000, totalWords: 60, regressions: 3 });
  console.log(`     steady reader cv=${steady.cv.toFixed(3)} tau=${steady.tau.toFixed(2)} | erratic reader cv=${erratic.cv.toFixed(3)} tau=${erratic.tau.toFixed(2)}`);
  assert(steady.cv < erratic.cv && steady.tau < erratic.tau, 'a steady reader gets a lower cv and a lower tau than an erratic one');
  assert(steady.tau >= 1.6 && erratic.tau <= 3.0, 'baseline tau stays within [1.6, 3.0]');

  // --- struggleDecision
  const calm = { onLineMs: 800, expLineMs: 1500, paraMs: 3000, expParaMs: 8000, finished: false, backtracks: 0, tau: 2, regressionRate: 0.1 };
  const D = (o) => C.struggleDecision({ ...calm, ...o });
  const d0 = D({});
  assert(d0.reason === null, `ordinary reading: no struggle (got ${d0.reason})`);
  assert(d0.severity >= 0 && d0.severity <= 1 && Number.isFinite(d0.ratio), 'calm decision still reports severity in 0..1 and a finite ratio');

  // stuck-line: onLineMs > max(2000, tau * expLineMs)        (tau 2 x 1500 ms = 3000 ms)
  assert(D({ onLineMs: 2950 }).reason === null, 'stuck-line: just under tau x expected line time does not trigger');
  assert(D({ onLineMs: 3000 }).reason === null, 'stuck-line: exactly tau x expected does not trigger (strict >)');
  assert(D({ onLineMs: 3050 }).reason === 'stuck-line', 'stuck-line: just over tau x expected line time triggers');
  assert(D({ onLineMs: 1950, expLineMs: 500 }).reason === null, 'stuck-line: 2000 ms floor, 1950 ms on a short line does not trigger');
  assert(D({ onLineMs: 2050, expLineMs: 500 }).reason === 'stuck-line', 'stuck-line: 2000 ms floor, 2050 ms on a short line triggers');
  assert(D({ onLineMs: 3600, tau: 1.6 }).reason === 'stuck-line' && D({ onLineMs: 3600, tau: 3.0 }).reason === null,
    'the same slowdown on a line triggers for a low tau (1.6) and not for a high one (3.0)');
  const s1 = D({ onLineMs: 6000 });
  assert(s1.reason === 'stuck-line' && s1.severity > 0 && s1.severity <= 1, `stuck-line severity is within (0, 1] (got ${s1.severity})`);
  assert(near(s1.ratio, 4, 0.05), `ratio is the worst observed/expected ratio: 6000 / 1500 = 4 (got ${s1.ratio})`);
  assert(D({ onLineMs: 12000 }).severity >= D({ onLineMs: 3100 }).severity, 'a longer stall is never less severe');

  // rereading: backtracks >= (regressionRate > 0.35 ? 3 : 2)
  assert(D({ backtracks: 1 }).reason === null, 'rereading: one backtrack does not trigger');
  assert(D({ backtracks: 2 }).reason === 'rereading', 'rereading: two backtracks trigger for a reader who rarely regresses');
  assert(D({ backtracks: 2, regressionRate: 0.35 }).reason === 'rereading', 'rereading: regressionRate exactly 0.35 still needs only two');
  assert(D({ backtracks: 2, regressionRate: 0.4 }).reason === null, 'rereading: a habitual re-reader (rate 0.4) needs three, two do not trigger');
  assert(D({ backtracks: 3, regressionRate: 0.4 }).reason === 'rereading', 'rereading: a habitual re-reader triggers at three');
  const r1 = D({ backtracks: 4 });
  assert(r1.severity > 0 && r1.severity <= 1, `rereading severity is within (0, 1] (got ${r1.severity})`);

  // slow-paragraph: !finished && paraMs > max(4000, 1.1 * tau * expParaMs)   (1.1 x 2 x 8000 = 17600 ms)
  assert(D({ paraMs: 17500 }).reason === null, 'slow-paragraph: just under 1.1 x tau x expected does not trigger');
  assert(D({ paraMs: 17700 }).reason === 'slow-paragraph', 'slow-paragraph: just over 1.1 x tau x expected triggers');
  assert(D({ paraMs: 30000, finished: true }).reason === null, 'slow-paragraph: never once the last line was reached');
  assert(D({ paraMs: 3950, expParaMs: 1000 }).reason === null, 'slow-paragraph: 4000 ms floor, 3950 ms on a short paragraph does not trigger');
  assert(D({ paraMs: 4050, expParaMs: 1000 }).reason === 'slow-paragraph', 'slow-paragraph: 4000 ms floor, 4050 ms on a short paragraph triggers');
  assert(D({ paraMs: 20000, tau: 1.6 }).reason === 'slow-paragraph' && D({ paraMs: 20000, tau: 3.0 }).reason === null,
    'the same slow paragraph triggers for a low tau (1.6) and not for a high one (3.0)');
  const p1 = D({ paraMs: 24000 });
  assert(p1.severity > 0 && p1.severity <= 1, `slow-paragraph severity is within (0, 1] (got ${p1.severity})`);
  assert(near(p1.ratio, 3, 0.05), `ratio is the worst observed/expected ratio: 24000 / 8000 = 3 (got ${p1.ratio})`);

  // priority: stuck-line, then rereading, then slow-paragraph
  assert(D({ onLineMs: 9000, backtracks: 5, paraMs: 60000 }).reason === 'stuck-line', 'priority: stuck-line wins over rereading and slow-paragraph');
  assert(D({ backtracks: 5, paraMs: 60000 }).reason === 'rereading', 'priority: rereading wins over slow-paragraph');
  assert(D({ onLineMs: 9000, paraMs: 60000, finished: true, backtracks: 0 }).reason === 'stuck-line', 'a finished paragraph can still have a stuck line');
} else {
  console.log('SKIP  baseline + struggle-decision section (summarizeBaseline / tauFromCv / struggleDecision not in gaze-core.js yet)');
}
// 8. fitCalibration: the dot calibration, as gaze-reader.js and tests/bench run it
{
  let s8 = 5;
  const r8 = () => ((s8 = (s8 * 1103515245 + 12345) % 2147483648) / 2147483648);
  const g8 = () => Math.sqrt(-2 * Math.log(r8() + 1e-12)) * Math.cos(2 * Math.PI * r8());
  const VW = 1280, VH = 720;
  const CAL = [[0.06, 0.08], [0.5, 0.08], [0.94, 0.08], [0.72, 0.29], [0.28, 0.29], [0.06, 0.5], [0.5, 0.5], [0.94, 0.5], [0.72, 0.71], [0.28, 0.71], [0.06, 0.92], [0.5, 0.92], [0.94, 0.92]];
  const VAL = [[0.25, 0.22], [0.75, 0.22], [0.5, 0.5], [0.25, 0.78], [0.75, 0.78]];
  // 44 numbers: 0-24 carry the gaze, 25-43 are a "head" that sits still (and would wreck the fit if used after a move)
  const feat = (x, y, sd) => {
    const u = 0.12 * (x / VW - 0.5) + sd * g8(), v = 0.05 * (y / VH - 0.5) + sd * g8();
    const f = [];
    for (let k = 0; k < 25; k++) f.push((k % 2 ? v : u) * (1 + k / 25) + sd * 0.3 * g8());
    for (let k = 25; k < 44; k++) f.push(0.5 + 1e-4 * g8());
    return f;
  };
  const dots = (sd, outliersOn = -1) => [...CAL.map((p, i) => [p, i, 'cal']), ...VAL.map((p, i) => [p, 100 + i, 'val'])].map(([p, g, role]) => {
    const x = p[0] * VW, y = p[1] * VH, samples = [];
    for (let k = 0; k < 28; k++) {
      // three frames of dot `outliersOn` are taken while the eyes are still somewhere else
      const stray = g === outliersOn && k < 3;
      samples.push({ f: feat(stray ? x + 500 : x, stray ? y - 300 : y, sd), head: { cx: 0.5 + g / 1e4, cy: 0.48, s: 0.1 }, t: k * 33 });
    }
    return { x, y, g, role, samples };
  });

  const pts = dots(0.002);
  // (changed in step 3: by default the validation dots are no longer folded into the training set. `fit` below is the
  //  folded calibration, as it was, so that the checks written for it still say what they said; `held` is the default.)
  const fit = C.fitCalibration(pts, { viewport: { w: VW, h: VH }, fold: true });
  const held = C.fitCalibration(pts, { viewport: { w: VW, h: VH } });
  assert(new Set(held.train.G).size === 13 && held.train.G.every((q) => q < 100) && held.accuracy.source === 'val' && held.accuracy.dots === 5 && held.perDot.filter((d) => d.heldOut).length === 5 && held.perDot.filter((d) => d.heldOut).every((d) => d.role === 'val' && d.kept === 0),
    'fitCalibration: the model trains on the 13 training dots; the accuracy is its error on the 5 validation dots, which it has not seen');
  assert(fit.model.ready && fit.model.keep.every((j) => j < 25), 'fitCalibration: the model reads only the first 25 features');
  // (changed in step 2: the training rows are the camera's whole vector, so that a dump can refit any model; they were cut to 25)
  assert(fit.train.X.length === fit.train.Y.length && fit.train.X.length === fit.train.G.length && fit.train.X[0].length === 44, `fitCalibration: train set is ${fit.train.X.length} rows, each the whole camera vector`);
  assert(C.fitCalibration(pts, { trainWidth: 25 }).train.X[0].length === 25, 'fitCalibration trainWidth: the stored rows can be cut');
  assert(fit.train.X.length <= 18 * 28 && fit.train.X.length > 0.7 * 18 * 28, 'fitCalibration: trimming keeps most frames');
  assert(new Set(fit.train.G).size === 18, 'fitCalibration {fold:true}: the final model trains on all 18 dots (13 + 5)');
  for (const k of ['accuracyX', 'accuracyY', 'precisionX', 'precisionY', 'effX', 'effY', 'recommendedLinePitchPx']) assert(Number.isInteger(fit.accuracy[k]), `fitCalibration: accuracy.${k} is a whole number (${fit.accuracy[k]})`);
  assert(fit.accuracy.viewport.w === VW && fit.accuracy.viewport.h === VH, 'fitCalibration: accuracy carries the viewport');
  assert(near(fit.calibHead.cy, 0.48, 1e-9) && near(fit.calibHead.s, 0.1, 1e-9) && fit.calibHead.cx > 0.5, 'fitCalibration: calibHead is the mean head of the kept frames');
  // (changed in step 3: the accuracy is leave-one-dot-out over all 18 dots, so every dot is scored by a fit that had not seen it; it was the 5 validation dots)
  assert(fit.perDot.length === 18 && fit.perDot.filter((d) => d.heldOut).length === 18 && fit.perDot.every((d) => d.n === 28 && d.kept <= 28 && Number.isFinite(d.biasX)), 'fitCalibration {fold:true}: perDot lists 18 dots, each scored by a fit that had not seen it');
  assert(fit.accuracy.source === 'lodo' && fit.accuracy.dots === 18 && fit.extra === null, 'fitCalibration {fold:true}: the accuracy says it is leave-one-dot-out over 18 dots');
  {
    const s = C.summarizeDots(fit.model.cvDots);
    assert(fit.model.cvDots.length === 18 && fit.accuracy.effX === Math.round(s.effX) && fit.accuracy.effY === Math.round(s.effY) && fit.accuracy.precisionY === Math.round(s.sdY) && near(s.eff, fit.model.cv.eff, 1e-9), 'fitCalibration: that accuracy is the shipped model\'s own per-dot leave-one-dot-out error (Ridge cvDots)');
    assert(!('cvDots' in fit.model.toJSON()) && !JSON.stringify(fit.model).includes('cvDots'), 'Ridge: the per-dot errors are not saved with the model');
  }
  const legacy = C.fitCalibration(pts, { viewport: { w: VW, h: VH }, fold: true, score: 'val' });

  // The same steps written out by hand, as gaze-reader.js had them before the maths moved here.
  {
    const cal = pts.filter((p) => p.role === 'cal'), val = pts.filter((p) => p.role === 'val');
    const X = [], Y = [], G = [], heads = [];
    for (const p of cal) for (const s of p.samples) { X.push(s.f.slice(0, 25)); Y.push([p.x, p.y]); G.push(p.g); heads.push(s.head); }
    let model = new C.Ridge().fit(X, Y, G);
    C.trimTrain(model, X, Y, G, heads);
    model = new C.Ridge().fit(X, Y, G);
    const acc = C.accuracyFrom(model, val, { w: VW, h: VH });
    assert(JSON.stringify(model.toJSON()) === JSON.stringify(held.model.toJSON()) && JSON.stringify({ ...acc, source: 'val', dots: 5, model: 'A' }) === JSON.stringify(held.accuracy),
      'fitCalibration (default): exactly the two-pass fit on the training dots, scored on the validation dots');
    for (const p of val) for (const s of p.samples) { X.push(s.f.slice(0, 25)); Y.push([p.x, p.y]); G.push(p.g); heads.push(s.head); }
    model = new C.Ridge().fit(X, Y, G);
    C.trimTrain(model, X, Y, G, heads);
    model = new C.Ridge().fit(X, Y, G);
    assert(JSON.stringify(model.toJSON()) === JSON.stringify(fit.model.toJSON()), 'fitCalibration: same model as the hand-written two-pass fit');
    // (changed in step 3: this older figure, a 13-dot fit scored on the 5 validation dots, is now opts.score 'val')
    assert(JSON.stringify({ ...acc, source: 'val', dots: 5, model: 'A' }) === JSON.stringify(legacy.accuracy) && JSON.stringify(legacy.model.toJSON()) === JSON.stringify(fit.model.toJSON()), "fitCalibration {fold:true, score:'val'} (as until step 3): same accuracy as the hand-written steps (plus its source and which model it is), same model");
    assert(JSON.stringify(X) === JSON.stringify(fit.train.X.map((r) => r.slice(0, 25))), 'fitCalibration: same training rows as the hand-written steps');
  }

  // accuracy is bias and scatter on the held-out dots: check against a direct computation
  {
    const cal = pts.filter((p) => p.role === 'cal');
    const only = C.fitCalibration(cal.concat(pts.filter((p) => p.role === 'val').map((p) => ({ ...p, samples: p.samples.map((s) => ({ ...s })) }))));
    assert(only.accuracy.effX >= only.accuracy.accuracyX && only.accuracy.effX <= Math.hypot(only.accuracy.accuracyX + 1, only.accuracy.precisionX + 1), 'fitCalibration: effX lies between the bias and bias plus scatter');
    assert(!('viewport' in only.accuracy), 'fitCalibration: no viewport in the accuracy when none is given');
  }

  // trimming: stray frames on one dot are dropped, and switching it off keeps them
  {
    const dirty = dots(0.002, 6);
    const on = C.fitCalibration(dirty), off = C.fitCalibration(dirty, { trim: false });
    assert(off.train.X.length === 13 * 28, 'fitCalibration trim off: every frame of the training dots is kept');
    const d6on = on.perDot.find((d) => d.g === 6), d6off = off.perDot.find((d) => d.g === 6);
    assert(d6on.kept <= 25 && d6off.kept === 28, `fitCalibration trim on: the three stray frames of dot 6 are dropped (${d6on.kept} of 28 kept)`);
    const test = dots(0.002);
    const err = (m) => Math.sqrt(test.reduce((a, p) => a + p.samples.reduce((b, s) => { const q = m.predict(s.f); return b + (q[0] - p.x) ** 2 + (q[1] - p.y) ** 2; }, 0), 0) / (18 * 28));
    assert(err(on.model) <= err(off.model) + 0.5, `fitCalibration: trimming does not hurt on fresh frames (${err(on.model).toFixed(1)} px vs ${err(off.model).toFixed(1)} px)`);
  }

  // featureCount
  {
    const f17 = C.fitCalibration(pts, { featureCount: 17 }), f44 = C.fitCalibration(pts, { featureCount: 44 });
    assert(f17.model.inputWidth <= 17 && f17.model.keep.every((j) => j < 17), 'fitCalibration featureCount 17: the model reads 17 numbers');
    assert(f44.model.keep.some((j) => j >= 25), 'fitCalibration featureCount 44: the head numbers are used');
  }

  // dots that cannot be fitted
  {
    const thin = dots(0.002); for (const g of [0, 1, 2]) thin[g].samples.length = 4;
    let msg = ''; try { C.fitCalibration(thin); } catch (e) { msg = e.message; }
    assert(/eyes were lost on several dots/.test(msg), 'fitCalibration: three dots with under 8 frames fail with the eyes-lost message');
    assert(C.calibrationProblem(thin.filter((p) => p.role === 'cal')) instanceof Error, 'calibrationProblem: the same check on the training dots alone (before the last five are shown)');
    const two = dots(0.002); for (const g of [0, 1]) two[g].samples.length = 4;
    assert(C.calibrationProblem(two) === null && C.fitCalibration(two).model.ready, 'fitCalibration: two thin dots are tolerated');
    const few = dots(0.002); for (const p of few) p.samples.length = 9;
    msg = ''; try { C.fitCalibration(few); } catch (e) { msg = e.message; }
    assert(/not enough face frames/.test(msg), 'fitCalibration: under 120 training frames fails with the lighting message');
    const noVal = dots(0.002); for (const p of noVal) if (p.role === 'val') p.samples.length = 2;
    msg = ''; try { C.fitCalibration(noVal); } catch (e) { msg = e.message; }
    // (changed in step 3: validation dots count like any other dot; five thin ones are "several dots")
    assert(/eyes were lost on several dots/.test(msg), 'fitCalibration: five thin validation dots fail like any thin dots');
    msg = ''; try { C.fitCalibration(dots(0.002).filter((p) => p.role !== 'val' || p.g < 102), { score: 'val' }); } catch (e) { msg = e.message; }
    assert(/lost the face during validation/.test(msg), "fitCalibration score 'val': an accuracy from fewer than 3 validation dots is refused");
    msg = ''; try { C.accuracyFromDots([{ n: 20, biasX: 1, biasY: 1, sdX: 5, sdY: 5 }, { n: 20, biasX: 2, biasY: 0, sdX: 5, sdY: 5 }, { n: 3, biasX: 2, biasY: 0, sdX: 5, sdY: 5 }]); } catch (e) { msg = e.message; }
    assert(/lost the face during validation/.test(msg) && C.accuracyFromDots([1, 2, 3].map(() => ({ n: 20, biasX: 3, biasY: 4, sdX: 5, sdY: 5 }))).accuracyY === 4, 'accuracyFromDots: three unseen dots with frames are the least an accuracy is reported from');
    const empty = dots(0.002); empty[4].samples = [];
    msg = ''; try { C.fitCalibration(empty); } catch (e) { msg = e.message; }
    assert(/lost on one of the dots/.test(msg) && C.calibrationProblem(empty, true) === null, 'fitCalibration: a dot with no frames at all is never accepted');
  }
}

// 9. trackingParams and headMoved (the reader's applyAccuracy and "you moved" gate)
{
  const p = C.trackingParams({ effX: 10, effY: 10, precisionX: 20, precisionY: 30 });
  // (changed in step 3: the dispersion limit is 2.5 x the scatter of both axes together; it was 2.2 x the larger one)
  assert(p.sx === 25 && p.sy === 18 && p.dispersion === 125, 'trackingParams: floors of 25 / 18 px, dispersion 2.5 x (scatter across + scatter down)');
  assert(C.trackingParams({ effX: 70, effY: 90, precisionX: 200, precisionY: 5 }).dispersion === 220 && C.trackingParams({ effX: 70, effY: 90, precisionX: 5, precisionY: 5 }).dispersion === 60, 'trackingParams: dispersion stays within 60..220 px');
  // (changed in step 3: the head gate is tighter, depends on the model in use, and reads the head pose when there is one;
  //  it was 0.08 of the picture and 15 % of the eye distance for every model)
  const h0 = { cx: 0.5, cy: 0.5, s: 0.1 }, GA = C.HEAD_GATE.A, GH = C.HEAD_GATE.H;
  // (changed 2026-11-21: model A takes the wide gate too. Its own limits paused two whole reading tasks on a real camera for 3 degrees of head tilt.)
  assert(!C.headMoved({ cx: 0.5 + 0.9 * GH.box, cy: 0.5, s: 0.1 }, h0) && C.headMoved({ cx: 0.5 + 1.1 * GH.box, cy: 0.5, s: 0.1 }, h0) && C.headMoved({ cx: 0.5, cy: 0.5, s: 0.1 * (1 - 1.1 * GH.size) }, h0), 'headMoved without a head pose, model A: the picture limits of the wide gate');
  assert(!C.headMoved({ cx: 0.5 + 1.1 * GA.box, cy: 0.5, s: 0.1 }, h0, null, 'E') && C.headMoved({ cx: 0.5 + 1.1 * GH.box, cy: 0.5, s: 0.1 }, h0, null, 'E'), 'headMoved: a head-frame model has the wider gate');
  assert(GH.yawDeg <= 8 && GH.pitchDeg <= 8 && GH.rollDeg <= 8 && C.headGate('A') === GH && C.headGate(undefined) === GH && C.headGate('E') === GH && C.headGate('B') === GH, 'HEAD_GATE: every model has the wide gate, rotation never over 8 degrees');
  {
    // with a head pose on both sides, rotation and centimetres decide
    const I = C.FEATURE_INDEX, D2R = Math.PI / 180;
    const row = (yawDeg, pitchDeg, rollDeg, x, y, z) => { const f = new Array(C.FEATURE_COUNT).fill(0); f[I.POSE_OK] = 1; f[I.POSE] = yawDeg * D2R / 0.1; f[I.POSE + 1] = pitchDeg * D2R / 0.1; f[I.POSE + 2] = rollDeg * D2R / 0.1; f[I.POSE + 3] = x / 3; f[I.POSE + 4] = y / 3; f[I.POSE + 5] = z / 3; return f; };
    const ref = { cx: 0.5, cy: 0.5, s: 0.1, pose: true, yaw: 2 * D2R, pitch: -10 * D2R, roll: 0, tx: 1, ty: -5, tz: -55 }, here = { cx: 0.9, cy: 0.5, s: 0.1 };
    const mv = (kind, dyaw, dpitch, droll, dx, dy, dz) => C.headMoved(here, ref, row(2 + dyaw, -10 + dpitch, droll, 1 + dx, -5 + dy, -55 + dz), kind);
    assert(!mv('E', 0, 0, 0, 0, 0, 0) && !mv('E', 7, 4, 7, 5, 3, 8), 'headMoved with a pose: inside the gate nothing happens, whatever the picture position says');
    assert(mv('E', 9, 0, 0, 0, 0, 0) && mv('E', 0, -6, 0, 0, 0, 0) && mv('E', 0, 0, 9, 0, 0, 0) && mv('E', 9, 0, 0, 0, 0, 0), 'headMoved with a pose: yaw, pitch or roll beyond the gate counts');
    assert(mv('E', 0, 0, 0, -9, 0, 0) && mv('E', 0, 0, 0, 0, 5.5, 0) && mv('E', 0, 0, 0, 0, 0, 13), 'headMoved with a pose: sideways, up or down, and depth beyond the gate count');
    // (changed at sign-off: model A's gate was about 1 degree and 1.3 cm, which paused a reader sitting as calibrated; see HEAD_GATE)
    assert(mv('A', 9, 0, 0, 0, 0, 0) && mv('A', 0, -6, 0, 0, 0, 0) && mv('A', 0, 0, 0, -9, 0, 0) && mv('A', 0, 0, 0, 0, 5.5, 0) && !mv('A', 3.5, 3, 3, 3, 2.5, 4), 'headMoved with a pose, model A: the three degrees of tilt and three centimetres that used to pause it are inside, a real change of posture is outside');
    assert(GA.yawDeg >= 2.5 && GA.pitchDeg >= 2 && GA.xCm >= 2 && GA.yCm >= 1.5 && GA.box >= 0.03, 'HEAD_GATE.A leaves room for a head that follows the eyes: not the 1 degree, 1.3 cm limits that paused a still reader');
    const off = C.headOffset(here, ref, row(5, -10, 0, 1, -3, -55));
    assert(off.pose && near(off.yawDeg, 3, 1e-9) && near(off.yCm, 2, 1e-9) && near(off.zCm, 0, 1e-9) && near(off.box, 0.4, 1e-9), 'headOffset: degrees and centimetres from the calibration pose');
    assert(!C.headOffset(here, h0, row(5, 0, 0, 0, 0, 0)).pose && C.headMoved(here, h0, row(0, 0, 0, 0, 0, 0), 'E'), 'headMoved: a calibration saved without a pose falls back to the picture limits');
    // the check before a saved calibration is reused
    const okFrames = Array.from({ length: 30 }, () => ({ face: true, head: here, f: row(4, -9, 0, 1, -5, -55) })), away = okFrames.map((fr) => ({ ...fr, f: row(14, -9, 0, 1, -5, -55) })), turned = okFrames.map((fr) => ({ ...fr, f: row(7, -9, 0, 1, -5, -55) }));
    assert(C.headWithinGate(okFrames, ref, 'E').ok && !C.headWithinGate(away, ref, 'E').ok && C.headWithinGate(turned, ref, 'E').ok && C.headWithinGate(turned, ref, 'A').ok && !C.headWithinGate(away, ref, 'A').ok, 'headWithinGate: the head must be within the gate (the same wide gate for every model since 2026-11-21)');
    assert(C.headWithinGate(okFrames, ref, 'A').ok, 'headWithinGate: a saved model-A calibration is restored for a head two degrees from where it was (it used to be refused)');
    assert(!C.headWithinGate(okFrames.slice(0, 4), ref, 'E').ok && !C.headWithinGate([], ref, 'E').ok && C.headWithinGate(okFrames.concat(away.slice(0, 10)), ref, 'E').ok, 'headWithinGate: nobody in front of the camera is not a match; most frames decide');
  }
}

// 10. OneEuro: samples under 5 ms apart
{
  const e = new C.OneEuro();
  e.filter(100, 0); const a1 = e.filter(100, 33);
  const burst = e.filter(400, 34);          // 1 ms after the last frame: used to be read as a 300000 px/s jump
  assert(burst === a1 && e.t === 33, 'OneEuro: a sample 1 ms after the last one is ignored and the clock kept');
  assert(e.filter(400, 20) === a1, 'OneEuro: a sample from the past is ignored');
  const next = e.filter(100, 66);
  assert(near(next, 100, 1e-9) && Number.isFinite(e.dx), 'OneEuro: the next real frame carries on from the last one that counted');
  const ref = new C.OneEuro(); ref.filter(100, 0); ref.filter(100, 33);
  assert(near(e.dx, (() => { ref.filter(100, 66); return ref.dx; })(), 1e-12), 'OneEuro: the ignored samples leave no trace in the speed estimate');
  const steady = new C.OneEuro(); let out = 0;
  for (let k = 0; k < 60; k++) out = steady.filter(200 + (k % 2 ? 6 : -6), k * 33);
  assert(Math.abs(out - 200) < 6, `OneEuro: still smooths ordinary 30 fps jitter (${out.toFixed(1)})`);
}

// ============================================================== step 2
// 11. Ridge hygiene options: z-clamp, prediction bounds, SD floor, per-axis penalty, fixed-scale inputs
{
  let s = 3; const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const X = [], Y = [], G = [];
  for (let d = 0; d < 12; d++) for (let k = 0; k < 20; k++) { const a = g(), b = g(); X.push([a, b, 5 + 1e-6 * g()]); Y.push([300 * a + 10 * g(), 200 * b + 10 * g()]); G.push(d); }
  const plain = new C.Ridge().fit(X, Y, G);
  const clamped = new C.Ridge().fit(X, Y, G, undefined, { zClamp: 4 });
  const far = [50, 0, 5], edge = [plain.mean[0] + 4 * plain.sd[0], 0, 5];
  assert(Math.abs(plain.predict(far)[0]) > 5000, 'Ridge without a clamp: an input 50 SD out gives a prediction thousands of px away');
  assert(near(clamped.predict(far)[0], clamped.predict(edge)[0], 1e-6) && Math.abs(clamped.predict(far)[0]) < 1500, `Ridge z-clamp: an input 50 SD out counts as 4 SD out (${clamped.predict(far)[0].toFixed(0)} px)`);
  assert(near(clamped.predict(X[0])[0], plain.predict(X[0])[0], 1e-9), 'Ridge z-clamp: inputs inside the calibrated range are untouched');
  assert(clamped.zc === 4 && clamped.toJSON().zc === 4 && near(C.Ridge.fromJSON(JSON.parse(JSON.stringify(clamped))).predict(far)[0], clamped.predict(far)[0], 1e-9), 'Ridge z-clamp: survives saving and loading');
  const boxed = new C.Ridge().fit(X, Y, G, undefined, { bounds: [-100, 400, -50, 300] });
  const pb = boxed.predict(far), pn = boxed.predict([-50, -50, 5]);
  assert(pb[0] === 400 && pn[0] === -100 && pn[1] === -50, 'Ridge bounds: predictions are held inside the box');
  // the third input hardly varies (SD 1e-6): unfloored it is blown up, floored it is not
  const loose = new C.Ridge().fit(X, Y, G), floored = new C.Ridge().fit(X, Y, G, undefined, { sdFloor: [0.01, 0.01, 0.01] });
  const nudge = (m) => Math.abs(m.predict([0, 0, 5.001])[0] - m.predict([0, 0, 5])[0]);
  assert(loose.sd[2] < 1e-5 && floored.sd[2] === 0.01 && nudge(floored) < 0.01 * Math.max(nudge(loose), 1e-9) + 1e-9, `Ridge SD floor: a nearly constant input cannot be blown up (${nudge(loose).toFixed(2)} px -> ${nudge(floored).toFixed(4)} px for a nudge of 0.001)`);
  const fixed = new C.Ridge().fit(X, Y, G, undefined, { fixed: [2], norm: true });
  assert(fixed.sd[2] === 1 && fixed.keep.includes(2), 'Ridge fixed-scale input: centred, not divided by its calibration SD');
  const per = new C.Ridge().fit(X, Y, G, undefined, { norm: true, perAxis: true });
  assert(per.norm === true && per.lambdaXY.length === 2 && C.Ridge.LAMBDAS.includes(per.lambdaXY[0]) && C.Ridge.LAMBDAS.includes(per.lambdaXY[1]) && per.lambda === per.lambdaXY[0], 'Ridge per-axis penalty: x and y each get one from the normalised grid');
  assert(per.cv && per.cv.dots === 12 && per.cv.eff > 0 && per.cv.eff < 40, `Ridge: leave-one-dot-out error by dot (${per.cv.eff.toFixed(1)} px)`);
  // normalised penalty: the same data twice over gives the same weights (the unnormalised one does not)
  const twice = new C.Ridge().fit(X.concat(X), Y.concat(Y), G.concat(G), [0.1], { norm: true }), once = new C.Ridge().fit(X, Y, G, [0.1], { norm: true });
  assert(near(twice.wx[0], once.wx[0], 1e-6), 'Ridge norm: the penalty means the same at any number of frames');
  const dropped = new C.Ridge().fit(X, Y, G, undefined, { drop: [1] });
  assert(!dropped.keep.includes(1) && dropped.keep.includes(0), 'Ridge drop: a dropped input is not read');
}

// 12. A model saved before step 2 (no version, no kind, one penalty) still loads and predicts the same
{
  const old = { keep: [0, 2], mean: [0.1, 9, -0.2], sd: [0.5, 9, 0.25], yMean: [700, 400], wx: [120, -30], wy: [10, 80], lambda: 3, cvErr: 41.5, n: 480 };
  const m = C.Ridge.fromJSON(JSON.parse(JSON.stringify(old)));
  const f = [0.6, 123, 0.3], want = [700 + 1 * 120 + 2 * -30, 400 + 1 * 10 + 2 * 80];
  const got = m.predict(f);
  assert(near(got[0], want[0], 1e-9) && near(got[1], want[1], 1e-9), 'old model JSON: loads and predicts as it always did');
  assert(m.ready && m.kind === 'A' && m.v === 1 && m.zc === 0 && m.bounds === null && m.norm === false && m.lambdaXY[0] === 3 && m.lambdaXY[1] === 3 && m.inputWidth === 3, 'old model JSON: missing fields default to the old behaviour (kind A, no clamp, no bounds, one unnormalised penalty)');
  assert(near(m.predict([1000, 0, 0.3])[0], 700 + 1999.8 * 120 - 60, 1e-6), 'old model JSON: no z-clamp is applied to a model that was fitted without one');
  const again = C.Ridge.fromJSON(JSON.parse(JSON.stringify(m)));
  assert(near(again.predict(f)[0], want[0], 1e-9) && again.v === 1, 'old model JSON: saving and loading it again changes nothing');
  // click refinement on an old saved calibration: 25-wide rows, the old penalty
  let s = 9; const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const X = [], Y = [], G = [];
  for (let d = 0; d < 9; d++) for (let k = 0; k < 15; k++) { const u = r() - 0.5, v = r() - 0.5; X.push(Array.from({ length: 25 }, (_, j) => (j % 2 ? v : u) * (1 + j / 25) + 0.01 * (r() - 0.5))); Y.push([640 + 1000 * u, 360 + 600 * v]); G.push(d); }
  const base = C.Ridge.fromJSON(JSON.parse(JSON.stringify(new C.Ridge().fit(X, Y, G)))); base.v = 1;
  const re = C.refitModel(base, X.concat([new Array(63).fill(0.01)]), Y.concat([[650, 365]]), G.concat(['click']), 25);
  assert(re.kind === 'A' && re.lambda === base.lambda && re.norm === false && re.inputWidth <= 25, 'refitModel: an old model is refitted as model A on its 25 numbers with its own penalty');
  let threw = false; try { C.Ridge.fromJSON({ ...old, kind: 'Z' }); } catch (e) { threw = true; }
  assert(threw, 'model JSON of an unknown kind is refused (the reader then asks for a new calibration)');
  const v2 = new C.Ridge().fit(X, Y, G).toJSON();
  assert(v2.v === 2 && v2.kind === 'A', 'a model fitted now is saved as version 2 with its kind');
}

// 13. Head pose from known face matrices
{
  const D2R = Math.PI / 180;
  // column-major, as MediaPipe gives it: columns of R, then the translation
  const matrix = (yaw, pitch, roll, t, scale = 1) => { const R = C.rotation(yaw, pitch, roll); return [R[0][0] * scale, R[1][0] * scale, R[2][0] * scale, 0, R[0][1] * scale, R[1][1] * scale, R[2][1] * scale, 0, R[0][2] * scale, R[1][2] * scale, R[2][2] * scale, 0, t[0], t[1], t[2], 1]; };
  const id = C.poseFromMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -60, 1]);
  assert(id.ok && id.yaw === 0 && id.pitch === 0 && id.roll === 0 && id.tx === 0 && id.tz === -60, 'pose: the identity rotation 60 cm away is yaw 0, pitch 0, roll 0');
  // by hand: a face turned 90 degrees about the vertical axis has its +z (out of the face) along the camera's +x
  const Ryaw = C.rotation(Math.PI / 2, 0, 0), Rpit = C.rotation(0, Math.PI / 2, 0), Rrol = C.rotation(0, 0, Math.PI / 2);
  assert(near(Ryaw[0][2], 1, 1e-12) && near(Ryaw[2][2], 0, 1e-12), 'pose convention: positive yaw turns the face towards the camera\'s right (+x)');
  assert(near(Rpit[1][2], -1, 1e-12), 'pose convention: positive pitch tips the face down (-y)');
  assert(near(Rrol[1][0], 1, 1e-12) && near(Rrol[0][1], -1, 1e-12), 'pose convention: positive roll turns the head\'s +x towards +y');
  for (const [yaw, pitch, roll, t] of [[12, -9, 4, [3, -6, -55]], [-20, 15, -8, [-8, 2, -70]], [0, -14, 0, [0, -10, -62]], [5, 0, 0, [1, 1, -40]]]) {
    const q = C.poseFromMatrix(matrix(yaw * D2R, pitch * D2R, roll * D2R, t));
    assert(q.ok && near(q.yaw, yaw * D2R, 1e-9) && near(q.pitch, pitch * D2R, 1e-9) && near(q.roll, roll * D2R, 1e-9) && q.tx === t[0] && q.ty === t[1] && q.tz === t[2], `pose: yaw ${yaw}, pitch ${pitch}, roll ${roll} degrees and the translation are recovered`);
  }
  const scaled = C.poseFromMatrix(matrix(10 * D2R, -5 * D2R, 2 * D2R, [0, 0, -60], 1.12));
  assert(scaled.ok && near(scaled.yaw, 10 * D2R, 1e-9) && near(scaled.pitch, -5 * D2R, 1e-9), 'pose: a uniform scale in the matrix is taken out');
  const good = matrix(0.1, -0.2, 0.05, [2, -8, -60]);
  const bads = { 'no matrix': undefined, 'all zeros': new Array(16).fill(0), 'a NaN': good.map((v, i) => (i === 5 ? NaN : v)), '15 numbers': good.slice(0, 15), 'face behind the camera': good.map((v, i) => (i === 14 ? 60 : v)),
    'a mirrored rotation': good.map((v, i) => (i < 3 ? -v : v)), 'not a rotation': good.map((v, i) => (i === 4 ? v + 0.6 : v)), 'small noise (the test camera)': Array.from({ length: 16 }, (_, i) => (i === 15 ? 1 : 0.01 * Math.sin(i))) };
  for (const [name, M] of Object.entries(bads)) { const q = C.poseFromMatrix(M); assert(!q.ok && q.yaw === 0 && q.pitch === 0 && q.roll === 0 && q.tx === 0 && q.ty === 0 && q.tz === 0, `pose: ${name} is not a pose (ok false, everything 0)`); }

  // in the feature vector: fixed physical units, a flag, and nothing before index 44 touched
  const I = C.FEATURE_INDEX;
  const lm = face(0.004, 0.002);
  for (const c of [468, 473]) for (let k = 1; k <= 4; k++) lm[c + k] = { x: lm[c].x + (k % 2 ? 0.004 : 0) * (k < 3 ? 1 : -1), y: lm[c].y + (k % 2 ? 0 : 0.004) * (k < 3 ? 1 : -1), z: 0 };
  const M = matrix(6 * D2R, -12 * D2R, 3 * D2R, [1.5, -9, -60]);
  const withPose = C.extractFeatures(lm, null, M, 1280, 720), noPose = C.extractFeatures(lm, null, null, 1280, 720);
  assert(withPose.f.length === 63 && withPose.f.every(Number.isFinite) && noPose.f.every(Number.isFinite), 'features: 63 finite numbers with and without a face matrix');
  assert(withPose.f[I.POSE_OK] === 1 && near(withPose.f[I.POSE], 6 * D2R / 0.1, 1e-9) && near(withPose.f[I.POSE + 1], -12 * D2R / 0.1, 1e-9) && near(withPose.f[I.POSE + 2], 3 * D2R / 0.1, 1e-9), 'features: yaw, pitch, roll in units of 0.1 rad');
  assert(near(withPose.f[I.POSE + 3], 0.5, 1e-12) && near(withPose.f[I.POSE + 4], -3, 1e-12) && near(withPose.f[I.POSE + 5], -20, 1e-12), 'features: head position in units of 3 cm');
  assert(noPose.f[I.POSE_OK] === 0 && noPose.f.slice(I.POSE, I.POSE + 6).every((v) => v === 0), 'features: without a usable matrix the pose numbers are 0 and the flag says so');
  assert(noPose.f[I.HEAD_IRIS] === noPose.f[0] && noPose.f[I.HEAD_IRIS + 1] === noPose.f[1] && noPose.f[I.HEAD_IRIS + 2] === noPose.f[4] && noPose.f[I.HEAD_IRIS + 3] === noPose.f[5], 'features: without a pose the head-frame iris offsets are the plain ones');
  assert(withPose.f[I.HEAD_IRIS] !== noPose.f[I.HEAD_IRIS], 'features: with a pose the iris offsets are taken in the head frame');
  const same = (a, b, lo, hi) => a.slice(lo, hi).every((v, i) => v === b[lo + i]);
  assert(same(withPose.f, noPose.f, 0, 25) && same(withPose.f, noPose.f, 41, 44) && same(withPose.f, noPose.f, 44, 52), 'features: 0-24 and 41-51 do not depend on the face matrix');
  const centreOnly = C.extractFeatures(face(0.004, 0.002), null, M, 1280, 720);   // same centres, the rim points elsewhere
  assert(same(centreOnly.f, withPose.f, 0, 44) && same(centreOnly.f, withPose.f, I.POSE_OK, 63) && !same(centreOnly.f, withPose.f, 44, 48), 'features: only 44-51 read the iris rim; 0-43 and the head-frame numbers read the centre point');
  assert(near(withPose.f[I.IRIS5], withPose.f[0], 1e-9) && near(withPose.f[I.IRIS5 + 1], withPose.f[1], 1e-9), 'features: a rim centred on the iris centre gives the same offset from five points as from one');
  // a head turn slides the iris against the corners in the picture; in the head frame it does not.
  // Orthographic picture of an eye whose iris sits 0.36 cm in front of the corners' midpoint, head turned by yaw:
  const picture = (yawDeg) => {
    const R = C.rotation(yawDeg * D2R, 0, 0), L = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
    const put = (i, h) => { L[i] = { x: 0.5 + (R[0][0] * h[0] + R[0][1] * h[1] + R[0][2] * h[2]) * 0.01, y: (360 - (R[1][0] * h[0] + R[1][1] * h[1] + R[1][2] * h[2]) * 12.8) / 720, z: 0 }; };
    const eyes = [[33, 133, 159, 145, 468, -1], [362, 263, 386, 374, 473, 1]];
    for (const [c1, c2, up, lo, iris, side] of eyes) {
      put(c1, [side * (side < 0 ? 4.445859 : 1.856432), 2.663991 - (side < 0 ? 0 : 0.078746), side < 0 ? 3.173422 : 3.757904]);
      put(c2, [side * (side < 0 ? 1.856432 : 4.445859), 2.585245 + (side < 0 ? 0 : 0.078746), side < 0 ? 3.757904 : 3.173422]);
      put(up, [side * 3.177186, 2.964136, 3.876973]); put(lo, [side * 3.177186, 2.294265, 3.775704]);
      for (let k = 0; k < 5; k++) put(iris + k, [side * 3.1511455 + 0.2, 2.624618, 3.8263385]);   // 0.2 cm towards +x in the head, at the lids' depth
    }
    put(168, [0, 3.271027, 5.236015]);
    return C.extractFeatures(L, null, matrix(yawDeg * D2R, 0, 0, [0, 0, -480]), 1280, 720).f;
  };
  const f0 = picture(0), f15 = picture(15);
  assert(Math.abs(f15[0] - f0[0]) > 0.02 && Math.abs(f15[I.HEAD_IRIS] - f0[I.HEAD_IRIS]) < 0.003 && Math.abs(f15[I.HEAD_IRIS + 2] - f0[I.HEAD_IRIS + 2]) < 0.003,
    `features: a 15 degree head turn moves the plain iris offset by ${Math.abs(f15[0] - f0[0]).toFixed(3)} eye widths and the head-frame one by ${Math.abs(f15[I.HEAD_IRIS] - f0[I.HEAD_IRIS]).toFixed(4)}`);
  assert(near(f0[I.HEAD_IRIS], 0.2 / Math.hypot(4.445859 - 1.856432, 2.663991 - 2.585245, 3.757904 - 3.173422), 1e-3), 'features: the head-frame offset is in eye widths (0.2 cm of 2.66)');
}

// 14. Model shoot-out: without a head pose it is model A, whatever is asked for
{
  let s = 21; const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const VW = 1280, VH = 720;
  // width 44: an older camera script or the test camera; width 63 with the pose flag at 0: no usable face matrix
  const feat = (x, y, width) => {
    const u = 0.12 * (x / VW - 0.5) + 0.002 * g(), v = 0.05 * (y / VH - 0.5) + 0.002 * g(), f = [];
    for (let k = 0; k < 25; k++) f.push((k % 2 ? v : u) * (1 + k / 25) + 0.0006 * g());
    for (let k = 25; k < 44; k++) f.push(0.5 + 1e-4 * g());
    if (width > 44) { f.push(u, v, u, v, u, v, u, v, 0, 0, 0, 0, 0, 0, 0, u, v, u, v); }
    return f;
  };
  const dots = (width) => [...C.CAL_POINTS.map((p, i) => [p, i, 'cal']), ...C.VAL_POINTS.map((p, i) => [p, 100 + i, 'val'])].map(([p, gid, role]) => ({
    x: p[0] * VW, y: p[1] * VH, g: gid, role, samples: Array.from({ length: 28 }, (_, k) => ({ f: feat(p[0] * VW, p[1] * VH, width), head: { cx: 0.5, cy: 0.5, s: 0.1 }, t: k * 33 })),
  }));
  for (const width of [44, 63]) for (const ask of ['auto', 'E', 'B', 'A']) {
    const fit = C.fitCalibration(dots(width), { viewport: { w: VW, h: VH }, model: ask });
    assert(fit.kind === 'A' && fit.model.kind === 'A' && fit.accuracy.model === 'A' && fit.shootout.chosen === 'A' && fit.shootout.asked === ask && fit.model.keep.every((j) => j < 25),
      `shoot-out, ${width} numbers per frame and no head pose, '${ask}' asked: model A (${fit.shootout.note})`);
  }
  const fit = C.fitCalibration(dots(63), { viewport: { w: VW, h: VH } });
  assert(/face matrix was missing/.test(fit.shootout.note) && typeof fit.shootout.eff.A === 'number' && !('E' in fit.shootout.eff), 'shoot-out: the note says why A was kept, and only A has an error figure');
  assert(/too short/.test(C.fitCalibration(dots(44)).shootout.note), 'shoot-out: 44-number rows are named as the reason');
  const d44 = dots(44), a44 = C.fitCalibration(d44, { model: 'A' }), auto44 = C.fitCalibration(d44);
  assert(JSON.stringify(a44.model.toJSON()) === JSON.stringify(auto44.model.toJSON()), 'shoot-out: falling back gives exactly the model that asking for A gives');
  assert(C.fitKind('E', dots(44)[0].samples.map((q) => q.f), [], []).fail && C.fitKind('Q', [], [], []).fail, 'fitKind: says why it cannot fit instead of throwing');
  assert(C.MODEL_KINDS.join('') === 'ABCE', 'the model kinds are A, B, C and E');
}

// 15. The calibration procedure (step 3): CalibrationRun, reviewDots, betterShowing, streamStill, accuracyGrade
{
  let s = 33; const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  const g = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const VW = 1280, VH = 720, SD = 0.002;
  // the same 44-number test camera as above: 0-24 carry the gaze (8, 9, 10 included), the rest sits still
  const feat = (x, y) => {
    const u = 0.12 * (x / VW - 0.5) + SD * g(), v = 0.05 * (y / VH - 0.5) + SD * g(), f = [];
    for (let k = 0; k < 25; k++) f.push((k % 2 ? v : u) * (1 + k / 25) + 0.3 * SD * g());
    for (let k = 25; k < 44; k++) f.push(0.5 + 1e-4 * g());
    return f;
  };
  /* A person in front of that camera: the eyes go to each new dot `delay(view)` ms after it appears
     (null: they stay where they are); lost(view) loses the face for that showing. 30 frames a second. */
  const drive = (opts, { delay = () => 280, lost = () => false, pauseMs = 3000 } = {}) => {
    const run = new C.CalibrationRun({ viewport: { w: VW, h: VH }, ...opts });
    let t = 0, ex = VW / 2, ey = VH / 2, step = -1, tLook = 0, aim = null, gone = false, error = null;
    const views = [];
    for (let n = 0; n < 6000; n++) {
      t += 33;
      let v; try { v = run.update(t); } catch (e) { error = e; break; }
      if (v.done) break;
      if (v.wait) {   // headPause: the reader is on the card; frames keep coming, with the eyes on the text, until Space after pauseMs
        if (v.stepId !== step) { step = v.stepId; views.push(v); tLook = t; }
        if (t - tLook >= pauseMs) run.resume(t);
        else run.push({ face: true, blink: false, f: feat(VW / 2, 0.1 * VH), head: { cx: 0.5, cy: 0.5, s: 0.1 } }, t);
        continue;
      }
      if (v.stepId !== step) { step = v.stepId; views.push(v); const d = delay(v); aim = d === null ? null : [v.x, v.y]; tLook = t + (d || 0); gone = lost(v); }
      if (aim && t >= tLook) { ex = aim[0]; ey = aim[1]; }
      run.push(gone ? { face: false } : { face: true, blink: false, f: feat(ex, ey), head: { cx: 0.5, cy: 0.5, s: 0.1 } }, t);
    }
    return { run, views, error, t };
  };
  const uOf = (p) => p.samples.reduce((a, q) => a + q.f[0], 0) / p.samples.length, uAt = (x) => 0.12 * (x / VW - 0.5);

  // the plain case
  const A = drive({});
  const ev = A.run.events, seg = (k) => ev.filter((e) => e.seg === k);
  assert(!A.error && A.run.done && seg('dots').length === 18 && seg('head').length === 3 && seg('reshow').length <= 3, `CalibrationRun: 13 + 5 dots, then the head segment (${ev.length} dots in ${(A.t / 1000).toFixed(1)} s, ${seg('reshow').length} shown again)`);
  assert(seg('dots').every((e) => e.tSampleStart - e.tShow >= 750 && e.tSampleStart - e.tShow <= 1300 && near(e.tSampleEnd - e.tSampleStart, 700, 1e-9) && e.frames >= 19 && e.settled), "CalibrationRun: eyes that arrive in time are sampled about three quarters of a second after the dot appears, for 0.7 s");
  assert(A.t < 50000 && A.views.filter((v) => v.seg === 'head').every((v) => v.text === C.HEAD_TEXT && /turn your head a little/.test(v.text)) && A.views.filter((v) => v.seg !== 'head').every((v) => v.text === null), 'CalibrationRun: under 50 s; the head segment carries its instruction, the dots carry none');
  assert(A.run.raw.length === ev.length && A.run.raw.every((d) => d.stream.length > d.frames && d.stream[0].t <= d.tShow + 34), 'CalibrationRun: the untrimmed stream of every dot is kept, from the moment the dot appeared');
  const fitA = A.run.result();
  assert(fitA.kind === 'A' && fitA.accuracy.source === 'val' && fitA.accuracy.dots === 5 && new Set(fitA.train.G).size === 13 && fitA.train.G.every((q) => q < 100), 'CalibrationRun result: model A is fitted on the 13 training dots only and scored on the 5 validation dots');
  assert(fitA.extra && new Set(fitA.extra.G).size === 3 && fitA.extra.G.every((q) => q >= 200) && fitA.perDot.filter((d) => d.role === 'move').length === 3 && fitA.shootout.moveDots === 3, 'CalibrationRun result: the head-segment frames are handed back separately (extra), not trained on by A');
  assert(fitA.procedure.dots === ev.length && fitA.procedure.ms === Math.round(A.run.tEnd - A.run.t0) && fitA.procedure.unsettled === 0, 'CalibrationRun result: says how long the procedure took and what it did');
  {
    // (sign-off) headPause: the run waits before the head segment until resume(); the instruction is on the waiting view only
    const Pz = drive({ headPause: true }, { pauseMs: 5000 }), pe = Pz.run.events, heads = pe.filter((e) => e.seg === 'head'), waits = Pz.views.filter((v) => v.wait);
    const lastDot = Math.max(...pe.filter((e) => e.seg !== 'head').map((e) => e.tSampleEnd));
    assert(!Pz.error && Pz.run.done && waits.length === 1 && waits[0].text === C.HEAD_TEXT && waits[0].seg === 'head' && waits[0].sampling === false && heads.length === 3, 'CalibrationRun headPause: one waiting view with the instruction, then the three head dots');
    assert(heads[0].tShow - lastDot >= 5000 - 40 && heads.every((e) => e.tSampleStart >= e.tShow) && heads[0].tSampleStart - heads[0].tShow >= 1000 && heads[1].tSampleStart - heads[1].tShow < 800, 'CalibrationRun headPause: no head dot is shown or sampled during the wait; the first one gets a full second before its frames count');
    assert(Pz.views.filter((v) => v.seg === 'head' && !v.wait).every((v) => v.text === null), 'CalibrationRun headPause: no text while a head dot is on screen');
    const rz = Pz.run.result();
    assert(Math.abs(rz.procedure.pausedMs - 5000) <= 40 && rz.procedure.ms - rz.procedure.pausedMs < 52000, 'CalibrationRun headPause: the result says how long the reader took over the card');
    // none of the frames with the eyes on the text reached a dot
    const uText = uAt(VW / 2), allHead = Pz.run.points.filter((p) => p.role === 'move');
    assert(allHead.length === 3 && allHead.every((p) => p.samples.length >= 20) && Pz.run.raw.filter((d) => d.seg === 'head').every((d) => d.stream[0].t >= d.tShow - 34), 'CalibrationRun headPause: frames from the wait are in no dot\'s stream');
    void uText;
    const never = new C.CalibrationRun({ viewport: { w: VW, h: VH }, headPause: true }); never.resume(0);
    assert(never.waiting === false && never.pausedMs === 0, 'CalibrationRun: resume() outside the wait does nothing');
  }
  let msg = ''; try { new C.CalibrationRun({}).result(); } catch (e) { msg = e.message; }
  assert(/not finished/.test(msg), 'CalibrationRun: no result before the end');

  // the old fixed windows are still there as options
  const O = drive({ still: false, dropMs: 0, reshow: 0, head: false, settleMs: 1000, sampleMs: 1000 });
  assert(O.run.events.length === 18 && O.run.events.every((e) => near(e.tSampleStart - e.tShow, 1000, 33) && near(e.tSampleEnd - e.tSampleStart, 1000, 1e-9)) && O.run.result().extra === null, 'CalibrationRun {still:false, dropMs:0, reshow:0, head:false}: 18 fixed windows, as before step 3');

  // eyes that arrive late: the sampling waits for them
  const late = (v) => (v.seg === 'dots' && v.stepId === 6 ? 1500 : 280);
  const L = drive({ reshow: 0, head: false }, { delay: late }), Lold = drive({ still: false, dropMs: 0, reshow: 0, head: false }, { delay: late });
  const eL = L.run.events[5], pL = L.run.points[5], pOld = Lold.run.points[5];
  const wrong = (p, x) => p.samples.filter((q) => Math.abs(q.f[0] - uAt(x)) > 6 * SD).length;
  assert(eL.tSampleStart - eL.tShow >= 1500 && wrong(pL, pL.x) === 0 && wrong(pOld, pOld.x) >= 10, `CalibrationRun: eyes 1.5 s late are waited for (sampling from ${Math.round(eL.tSampleStart - eL.tShow)} ms, no stray frame; the fixed window took ${wrong(pOld, pOld.x)} frames of the dot before)`);

  // a dot that was not looked at, and one with the face lost: both come again
  const B = drive({}, { delay: (v) => (v.seg === 'dots' && v.stepId === 8 ? null : 280), lost: (v) => v.seg === 'dots' && v.stepId === 3 });
  const again = B.run.events.filter((e) => e.seg === 'reshow').map((e) => e.g);
  assert(!B.error && again.includes(7) && again.includes(2) && B.run.review.dots.find((d) => d.g === 7).why === 'residual' && B.run.review.dots.find((d) => d.g === 2).why === 'frames', `CalibrationRun: the dot nobody looked at and the dot with the face lost are shown again (shown again: ${again.join(', ')})`);
  const p7 = B.run.points.find((p) => p.g === 7), p2 = B.run.points.find((p) => p.g === 2);
  assert(B.run.reshown.find((q) => q.g === 7).used === 'second' && Math.abs(uOf(p7) - uAt(p7.x)) < 2 * SD && p2.samples.length >= 19 && B.run.points.length === 21, 'CalibrationRun: the second showing replaces the bad one');
  const fitB = B.run.result();
  assert(fitB.accuracy.effX < 3 * fitA.accuracy.effX + 5 && fitB.procedure.reshown.length === again.length, `CalibrationRun: the calibration comes out as good as a clean one (±${fitB.accuracy.effX} px against ±${fitA.accuracy.effX} px)`);
  const B0 = drive({ reshow: 0, head: false }, { lost: (v) => v.stepId === 3 });
  msg = B0.error ? B0.error.message : ''; if (!msg) { try { B0.run.result(); } catch (e) { msg = e.message; } }
  assert(/lost on one of the dots/.test(msg), 'CalibrationRun without second showings: an empty dot ends the calibration with a message, it is not fitted around');
  const many = drive({}, { lost: (v) => v.seg === 'dots' && v.stepId <= 7 });
  assert(many.error && /lost on several dots/.test(many.error.message) && many.run.events.length === 13, 'CalibrationRun: more empty dots than can be shown again stops after the 13 training dots, not at the end');

  // reviewDots and betterShowing on their own
  const pts = A.run.points.filter((p) => p.role !== 'move').map((p) => ({ ...p, samples: p.samples.slice() }));
  const rv = C.reviewDots(pts);
  assert(rv.dots.length === 18 && rv.median > 0 && rv.dots.every((d) => d.resid !== null) && rv.reshow.length <= 3, 'reviewDots: a residual for every dot, at most three shown again');
  const bad = pts.map((p) => (p.g === 4 ? { ...p, samples: pts.find((q) => q.g === 10).samples } : p));     // dot 4 looked at as if it were dot 10
  const thin = bad.map((p) => (p.g === 101 ? { ...p, samples: p.samples.slice(0, 5) } : p));
  const rb = C.reviewDots(thin);
  assert(rb.reshow[0] === 101 && rb.reshow.includes(4) && rb.dots.find((d) => d.g === 4).resid > 2.5 * rb.median && C.reviewDots(thin, { max: 0 }).reshow.length === 0 && C.reviewDots(thin, { max: 1 }).reshow.join() === '101', 'reviewDots: too few frames first, then residuals over 2.5 x the median; max limits the list');
  const good4 = pts.find((p) => p.g === 4), bad4 = bad.find((p) => p.g === 4);
  assert(C.betterShowing(bad, bad4, good4) === 'second' && C.betterShowing(pts, good4, bad4) === 'first' && C.betterShowing(pts, good4, { ...good4, samples: good4.samples.slice(0, 3) }) === 'first' && C.betterShowing(pts, { ...good4, samples: [] }, { ...good4, samples: good4.samples.slice(0, 3) }) === 'second', 'betterShowing: the showing the other dots agree with; never a thin one over a full one');

  // streamStill / streamMoved / StreamNoise
  const noise = new C.StreamNoise(), stream = [];
  for (let k = 0; k < 40; k++) { const fr = { t: 33 * k, face: true, blink: false, f: feat(k < 20 ? 300 : 900, 400) }; stream.push(fr); noise.push(fr); }
  const sg = noise.sigma;
  assert(sg && sg.length === 3 && sg[0] > 0.3 * SD && sg[0] < 3 * SD, `StreamNoise: frame noise from neighbouring frames, not fooled by the jump (${sg[0].toFixed(4)} for a true ${SD})`);
  assert(C.streamStill(stream.slice(0, 20), 33 * 19, sg) && !C.streamStill(stream.slice(0, 25), 33 * 24, sg) && C.streamStill(stream, 33 * 39, sg) && !C.streamStill(stream, 33 * 39, null) && !C.streamStill(stream.slice(0, 2), 40, sg), 'streamStill: still before the jump and after it, not across it; never without a noise figure or with two frames');
  assert(C.streamMoved(stream, 33 * 14, 33 * 39, sg) && !C.streamMoved(stream.slice(0, 20), 0, 33 * 19, sg), 'streamMoved: tells that the eyes have left where they were when the dot appeared');

  // what the card may say
  const g10 = C.accuracyGrade({ effY: 10 }), g21 = C.accuracyGrade({ effY: 21 }), g60 = C.accuracyGrade({ effY: 60 }), g120 = C.accuracyGrade({ effY: 120 });
  assert(g10.level === 3 && g10.lineByLine && /line by line/.test(g10.text) && C.TYPICAL_LINE_PITCH === 32 && !C.accuracyGrade({ effY: 16 }).lineByLine, 'accuracyGrade: "line by line" only under half a typical line pitch (16 px)');
  assert(g21.level === 2 && !/line by line/.test(g21.text) && /band of about 3 lines/.test(g21.text) && g60.level === 2 && /about 5 lines/.test(g60.text) && g120.level === 1 && /which paragraph/.test(g120.text) && C.accuracyGrade({ effY: 40 }, 96).lineByLine, 'accuracyGrade: otherwise a band of about N lines, or the paragraph only');
}

// 16. BlinkDetector and markBlinks (step 3e): a look down is not a blink, a blink still is
{
  // lids of one frame: blink score (both eyes), lid opening
  const L = (score, open, r = score) => ({ l: score, r, open });
  const run = (seq, o) => { const d = new C.BlinkDetector(o); return seq.map((q, i) => d.push(q, 33 * i)); };
  const level = (n, score, open) => Array.from({ length: n }, () => L(score, open));
  const blink = [L(0.5, 0.2), L(0.9, 0.05), L(0.95, 0.03), L(0.9, 0.05), L(0.5, 0.2)];       // closing, shut, opening: five frames
  const up = level(40, 0.1, 0.3), down = level(60, 0.55, 0.16);
  const a = run(up.concat(blink, up));
  assert(a.slice(0, 40).every((v) => !v) && a.slice(40, 45).every((v) => v) && a[45] && a[46] && a.slice(47).every((v) => !v), 'BlinkDetector: a blink is left out from its first frame, and two frames after it');
  const b = run(up.concat(down));
  const lost = b.slice(40).filter((v) => v).length;
  assert(lost <= 30 && b.slice(75).every((v) => !v), `BlinkDetector: a look down (blink score 0.55, lids half way) costs under a second of frames, then tracking goes on (${lost} frames left out)`);
  assert(level(60, 0.55, 0.16).every((q) => q.l > 0.45), 'the fixed rule (either eye over 0.45) would leave out every one of those frames');
  const c = run(up.concat(down, blink.map((q) => L(Math.min(1, q.l + 0.45), q.open * 0.5)), down));
  assert(c.slice(100, 105).filter((v) => v).length >= 4 && c.slice(108).every((v) => !v), 'BlinkDetector: a blink while looking down is still caught');
  const wink = run(up.concat(Array.from({ length: 6 }, () => L(0.9, 0.28, 0.1)), up));
  assert(wink.every((v) => !v), 'BlinkDetector: one eye alone (a wink, a bad score on one side) is not a blink');
  const shut = run(up.concat(level(120, 0.95, 0.02)));
  assert(shut.slice(40).every((v) => v), 'BlinkDetector: eyes held shut stay a blink however long it lasts');
  const fast = run(up.concat([L(0.2, 0.18)], up));
  assert(fast[40] && fast[41] && fast[42] && !fast[43], 'BlinkDetector: lids closing fast count even before the scores say so');
  const frames = up.concat(blink, up).map((q, i) => ({ t: 33 * i, face: true, lids: q })), m = C.markBlinks(frames);
  assert(m.slice(0, 38).every((v) => !v) && m.slice(38, 47).every((v) => v) && m.slice(47).every((v) => !v), 'markBlinks: over a recorded stream, two frames before and two after the blink go as well');
  const flags = Array.from({ length: 12 }, (_, i) => ({ t: 33 * i, face: true, blink: i === 6 }));
  assert(C.markBlinks(flags).filter((v) => v).length === 5 && C.markBlinks(flags, { pad: 0 }).filter((v) => v).length === 1 && !C.markBlinks([{ t: 0, face: false }])[0], 'markBlinks: frames without lids keep their own blink flag (padded the same way)');
  const ex = C.extractFeatures(Array.from({ length: 478 }, (_, i) => ({ x: 0.3 + (i % 7) / 100, y: 0.4 + (i % 5) / 100, z: 0 })), [{ categoryName: 'eyeBlinkLeft', score: 0.7 }, { categoryName: 'eyeBlinkRight', score: 0.2 }], null, 1280, 720);
  assert(ex.lids.l === 0.7 && ex.lids.r === 0.2 && ex.lids.open === ex.f[11] && ex.blink === true, 'extractFeatures: hands out the lid numbers next to its fixed blink flag');
}

// 17. Click refinement gate (step 3f) and the fixation in progress
{
  const ok = (o) => C.clickUsable({ click: { x: 500, y: 300 }, pred: { x: 520, y: 310 }, sx: 25, sy: 20, fixating: true, ...o });
  assert(ok({}) && !ok({ fixating: false }) && !ok({ pred: null }) && !ok({ pred: { x: 560, y: 300 } }) && !ok({ pred: { x: 500, y: 345 } }) && ok({ pred: { x: 450, y: 340 } }) && C.CLICK_SIGMAS === 2,
    'clickUsable: only during a fixation, and only when the model already has the eyes within 2 sigma of the click on both axes');
  const clicks = [{ t: 0 }, { t: 30000 }, { t: 59000 }];
  assert(C.liveClicks(clicks, 59500).length === 3 && C.liveClicks(clicks, 60000).length === 2 && C.liveClicks(clicks, 200000).length === 0 && C.CLICK_TTL_MS === 60000, 'liveClicks: a click sample lives for 60 s');
  const fd = new C.FixationDetector({ dispersion: 80 });
  assert(fd.current(0) === null, 'FixationDetector.current: nothing before the first frame');
  for (let k = 0; k <= 15; k++) fd.push(33 * k, 400 + (k % 3), 300);
  const cur = fd.current(33 * 15);
  assert(cur && cur.dur >= 450 && Math.abs(cur.x - 401) < 3 && fd.current(33 * 15 + 500) === null, `FixationDetector.current: one fixation across its emitted chunks (${cur && cur.dur} ms), gone after a gap`);
  for (let k = 16; k <= 18; k++) fd.push(33 * k, 900, 600);   // (a single stray frame is filtered out; a jump takes two)
  assert(fd.current(33 * 18).dur <= 34 && fd.current(33 * 18).x > 800, 'FixationDetector.current: a jump starts a new one');
}

// 18. Validation pass, the grade on the card, the quality gate and the advice (step 4)
{
  const used = C.CAL_POINTS.concat(C.VAL_POINTS, C.HEAD_POINTS);
  assert(C.CHECK_POINTS.length === 5 && C.CHECK_POINTS.every((p) => used.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.1)), 'CHECK_POINTS: five dots, none on or near a calibration, validation or head-segment dot');
  const g = (e) => C.validationGrade(e);
  assert(g(15).grade === 'good' && g(15).lineByLine && g(16).grade === 'fair' && g(16).bandLines === 3 && g(60).grade === 'fair' && g(60).bandLines === 5 && g(80).grade === 'poor' && g(NaN).grade === 'poor',
    'validationGrade: good under half a 32 px line, fair up to a band of five lines, poor beyond (and without a number)');
  assert(/^Tracking is good: it can follow which line you are on$/.test(g(10).message) && /^Tracking is fair: it follows the paragraph and a band of about 3 lines$/.test(g(20).message) && /^Tracking is poor/.test(g(200).message) && g(10).level === 3 && g(20).level === 2 && g(200).level === 1,
    'validationGrade: the sentence on the card');
  for (const e of [5, 15, 17, 40, 70, 90]) { const a = C.accuracyGrade({ effY: e }), b = g(e); assert(a.level === b.level && a.bandLines === b.bandLines, `validationGrade: same thresholds as accuracyGrade at ${e} px`); }
  // five dots, the model 30 px low and 10 px right on each, scatter 20 px across and 12 px down
  let s = 7; const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648), gs = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const dots = C.CHECK_POINTS.map((p) => ({ x: p[0] * 1280, y: p[1] * 720, preds: Array.from({ length: 36 }, () => [p[0] * 1280 + 10 + 20 * gs(), p[1] * 720 + 30 + 12 * gs()]) }));
  const v = C.validationResult(dots);
  assert(v.ok && v.source === 'validation' && v.dots === 5 && v.frames === 180 && Math.abs(v.biasY - 30) <= 4 && Math.abs(v.biasX - 10) <= 5 && Math.abs(v.sdX - 20) <= 4 && Math.abs(v.effY - Math.hypot(30, 12 / Math.sqrt(2.5))) <= 4,
    `validationResult: bias and scatter per dot, then the calibration's own per-fixation error (${JSON.stringify({ effX: v.effX, effY: v.effY, biasX: v.biasX, biasY: v.biasY })})`);
  assert(v.errPx > 25 && v.errPx < 50 && Math.abs(v.errDeg - v.errPx / C.APPROX_PX_PER_DEG) < 0.06 && v.pxPerDeg === 52 && v.grade === 'fair' && /band of about 3 lines/.test(v.message) && v.perDot.length === 5 && v.perDot.every((d) => d.n === 36 && Math.abs(d.dy - 30) < 10),
    `validationResult: typical error in px and approximate degrees, and the grade (${v.errPx} px, ${v.errDeg} deg, ${v.grade})`);
  const thin = C.validationResult(dots.map((d, i) => (i < 3 ? { ...d, preds: d.preds.slice(0, 3) } : d)), { fallback: { effX: 25, effY: 80 } });
  assert(!thin.ok && thin.source === 'calibration' && thin.grade === 'poor' && thin.effY === 80 && thin.dots === 2 && /lost your eyes/.test(thin.reason), 'validationResult: with under three usable dots it grades the calibration\'s own accuracy and says why');
  const none = C.validationResult([], {});
  assert(!none.ok && none.source === 'none' && none.grade === 'poor' && none.errPx === null, 'validationResult: nothing measured and nothing to fall back on is poor, without a number');
  assert(C.validationResult([{ x: 1, y: 1, preds: [[NaN, 1], [1, Infinity]] }], {}).frames === 0, 'validationResult: outputs that are not numbers do not count');

  // the eyes reach a dot late: the frames of the way there are not tracker error
  const lateDot = (k) => ({ x: 600, y: 400, preds: Array.from({ length: 36 }, (_, i) => (i < k ? [200 + 5 * gs(), 150 + 5 * gs()] : [600 + 10 + 20 * gs(), 400 + 30 + 12 * gs()])) });
  const trimmed = C.arrivalTrim(lateDot(12).preds);
  assert(trimmed.length === 24 && C.arrivalTrim(dots[0].preds).length === 36 && C.arrivalTrim(lateDot(3).preds.slice(0, 8)).length === 8, `arrivalTrim: drops the frames before the eyes arrive (${36 - trimmed.length} of 36), keeps a steady dot whole, leaves a handful of frames alone`);
  const stray = dots[0].preds.map((p, i) => (i === 30 ? [p[0] + 400, p[1]] : p));
  assert(C.arrivalTrim(stray).length === 36, 'arrivalTrim: a stray frame late in the window stays in (it is the tracker\'s scatter)');
  const lateV = C.validationResult([lateDot(12), ...dots.slice(1)]), rawV = C.validationResult([lateDot(12), ...dots.slice(1)], { arrival: false });
  assert(lateV.perDot[0].late === 12 && lateV.perDot[0].n === 24 && Math.abs(lateV.effY - v.effY) <= 4 && rawV.effY > v.effY + 10 && rawV.perDot[0].late === 0,
    `validationResult: a dot reached late does not spoil the result (${lateV.effY} px with the way there left out, ${rawV.effY} px with it counted, ${v.effY} px when on time)`);

  // the heat trace's own filter (gaze-reader.js: OneEuro(1.5, 0.01)) against the smooth gaze's (the defaults): noisy eyes
  // jump 60 px, about two words (a big jump opens both filters at once; it is the small ones the smooth gaze trails). Mean of 200 runs.
  const stepAt = (mk, ms) => { let acc = 0; for (let k = 0; k < 200; k++) { const f = mk(); let s2 = k * 7 + 5; const r = () => ((s2 = (s2 * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5; let out = 0; for (let t = 0; t <= 1000 + ms; t += 33) out = f.filter((t < 1000 ? 400 : 460) + 60 * r(), t); acc += (out - 400) / 60; } return acc / 200; };
  const fastF = () => new C.OneEuro(1.5, 0.01), slowF = () => new C.OneEuro();
  const fast100 = stepAt(fastF, 100), slow100 = stepAt(slowF, 100), fast150 = stepAt(fastF, 150), slow150 = stepAt(slowF, 150);
  assert(fast100 > 0.85 && fast100 > slow100 + 0.12 && fast150 > 0.95 && slow150 < 0.9, `the trace filter follows a small jump faster than the smooth gaze: ${Math.round(100 * fast100)} % against ${Math.round(100 * slow100)} % of the way after 100 ms, ${Math.round(100 * fast150)} % against ${Math.round(100 * slow150)} % after 150 ms`);

  const q = (h) => C.cameraQuality(h).map((w) => w.id).join(',');
  assert(q({ fps: 30, faceW: 0.2, cx: 0.5, cy: 0.5 }) === '' && q({ fps: 0, faceW: 0, cx: NaN, cy: NaN }) === '' && q({ fps: 14, faceW: 0.2, cx: 0.5, cy: 0.5 }) === 'fps' && q({ fps: 30, faceW: 0.12, cx: 0.5, cy: 0.5 }) === 'small' && q({ fps: 30, faceW: 0.3, cx: 0.8, cy: 0.5 }) === 'offcentre' && q({ fps: 30, faceW: 0.3, cx: 0.5, cy: 0.9 }) === 'offcentre' && q({ fps: 10, faceW: 0.1, cx: 0.1, cy: 0.5 }) === 'fps,small,offcentre',
    'cameraQuality: warns under 20 fps, for a small face and for a face near the edge; says nothing before it knows');
  assert(/more light/i.test(C.cameraQuality({ fps: 12 })[0].text) && /more light/i.test(C.cameraQuality({ fps: 12 })[0].short) && /closer/.test(C.cameraQuality({ faceW: 0.1 })[0].text), 'cameraQuality: low frame rate asks for light, a small face asks to sit closer');
  // a recorded calibration: 3 eye dots and a head dot, 30 fps
  const stream = (n, o = {}) => Array.from({ length: n }, (_, i) => ({ t: 33.3 * i, face: !(o.lost && i % o.lost === 0), blink: !!(o.blink && i % o.blink === 1), head: { cx: 0.5 + (o.dx || 0) * (i / n), cy: 0.5, s: 0.09 } }));
  const still = C.calibrationHealth([{ seg: 'dots', settled: true, stream: stream(60) }, { seg: 'dots', settled: false, stream: stream(60) }, { seg: 'head', settled: false, stream: stream(60, { dx: 0.2 }) }]);
  assert(still.frames === 180 && Math.abs(still.fps - 30) < 1 && still.lostShare === 0 && still.blinkShare === 0 && still.headMove < 0.001 && still.unsettled === 1 && Math.abs(still.cx - 0.5) < 1e-9 && still.s === 0.09,
    `calibrationHealth: frame rate, losses and head movement over the eye dots; the head segment's movement is not counted (${JSON.stringify(still)})`);
  const bad = C.calibrationHealth([{ seg: 'dots', settled: true, stream: stream(90, { lost: 4, blink: 2, dx: 0.1 }) }]);
  assert(Math.abs(bad.lostShare - 0.25) < 0.02 && bad.blinkShare > 0.4 && bad.headMove > 0.03, 'calibrationHealth: lost faces, blink-rejected frames and a head that moved during the dots');
  const adv = (h) => C.trackingAdvice(h).map((a) => a.id).join(',');
  assert(adv(still) === 'general' && adv({ ...still, fps: 12 }) === 'fps' && adv({ ...still, faceW: 0.1 }) === 'small' && adv({ ...still, s: 0.05 }) === 'small' && adv({ ...still, cx: 0.9 }) === 'offcentre' && adv(bad) === 'lost,blinks,moved',
    'trackingAdvice: chosen from the measured health; a general line when nothing was wrong');
  assert(/more light/i.test(C.trackingAdvice({ fps: 9 })[0].text) && /blinks/.test(C.trackingAdvice({ blinkShare: 0.5 })[0].text) && /head moved/.test(C.trackingAdvice({ headMove: 0.1 })[0].text), 'trackingAdvice: the words name the cause');
}

console.log('\nall core tests passed');
