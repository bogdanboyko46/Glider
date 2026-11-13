// node tests/gaze-core.test.js — sanity + simulation tests for lexilens-extension/gaze/gaze-core.js
const path = require('node:path');
const C = require(path.join(__dirname, '..', 'lexilens-extension', 'gaze', 'gaze-core.js'));
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
assert(a.f.length === 44, `feature length ${a.f.length}`);
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
console.log('\nall core tests passed');
