// node tests/analytics.test.js — Reading Check metrics on simulated sessions with planted, known answers.
const path = require('node:path');
const dir = path.join(__dirname, '..', 'glider-extension', 'assessment');
const A = require(path.join(dir, 'analytics.js'));
const D = require(path.join(dir, 'demo-generator.js'));
const N = require(path.join(dir, 'norms.js'));

let failed = 0;
const assert = (c, m) => { if (!c) { console.error('FAIL', m); failed++; } else console.log('ok  ', m); };
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;
const noThrow = (fn, m) => { try { const r = fn(); assert(true, m); return r; } catch (e) { assert(false, `${m} — threw ${e.message}`); return null; } };

// 1. A clean reader: no regressions, no stuck line, no re-reads, no blinks.
{
  const { session, truth } = D.makeSession({ seed: 3, regressionProb: 0, stuckLine: -1, rereadAfterLines: [], blinkEveryMs: 0, offTextGlances: 0, fatigue: 0 });
  const a = A.analyze(session);
  assert(a.ok, 'clean read analyses');
  assert(near(a.metrics.fixationCount, truth.fixations, 3), `fixation count ${a.metrics.fixationCount} ≈ planted ${truth.fixations}`);
  assert(a.metrics.regressions <= 1, `no planted regressions -> ${a.metrics.regressions} found`);
  assert(a.metrics.lineRereads === 0, 'no line re-reads');
  assert(a.metrics.blinkCount === 0 && a.metrics.blinkRate === 0, 'no blinks');
  assert(!a.lines.some((l) => l.flagged), 'no line flagged as slow');
  assert(a.saccades.filter((s) => s.type === 'sweep').length === session.lineRects.length - 1, 'one return sweep per line change');
  assert(a.fixations.every((f) => !f.offText), 'every fixation is on the text');
  const wpmTruth = truth.words / (truth.durationMs / 60000);
  assert(near(a.metrics.wpm, wpmTruth, 0.12 * wpmTruth), `wpm ${a.metrics.wpm} ≈ ${Math.round(wpmTruth)}`);
  assert(near(a.metrics.meanFixMs, 225, 45), `mean fixation ${a.metrics.meanFixMs} ms ≈ planted 225 (+ saccade time)`);
  assert(a.metrics.comprehension.correct === 2, 'both answers correct');
  assert(a.findings[0].id === 'typical' || a.findings.some((f) => f.tone === 'attention') === false, 'clean read has no attention finding besides range checks');
}

// 2. Planted regressions are recovered (count within ±2, rate close).
for (const seed of [11, 3, 29, 52]) {
  const { session, truth } = D.makeSession({ seed, regressionProb: 0.2, stuckLine: -1, rereadAfterLines: [], offTextGlances: 0 });
  const a = A.analyze(session);
  assert(near(a.metrics.regressions, truth.regressions, 2), `seed ${seed}: regressions ${a.metrics.regressions} ≈ planted ${truth.regressions}`);
  assert(near(a.metrics.regressionRate, truth.regressions / (truth.fixations - 1), 0.03), `seed ${seed}: regression rate ${a.metrics.regressionRate}`);
}

// 3. A planted stuck line is the slowest and flagged, wherever it is.
for (const stuckLine of [2, 4, 7]) {
  const { session } = D.makeSession({ seed: 17 + stuckLine, stuckLine, stuckFactor: 2.5, regressionProb: 0.04, rereadAfterLines: [], offTextGlances: 0 });
  const a = A.analyze(session);
  const slow = a.lines.find((l) => l.slowest);
  assert(slow && slow.index === stuckLine && slow.flagged, `stuck line ${stuckLine} found (slowest = ${slow && slow.index}, ratio ${slow && slow.ratio})`);
  assert(a.lines.filter((l) => l.flagged).length === 1, 'only the stuck line is flagged');
  assert(a.findings.some((f) => f.id === 'slow-line'), 'slow-line finding is reported');
}

// 4. Planted line re-reads are counted, and attributed to the right line.
{
  const { session, truth } = D.makeSession({ seed: 8, regressionProb: 0, stuckLine: -1, rereadAfterLines: [2, 5, 8], offTextGlances: 0 });
  const a = A.analyze(session);
  assert(a.metrics.lineRereads === truth.rereads, `line re-reads ${a.metrics.lineRereads} = planted ${truth.rereads}`);
  assert([1, 4, 7].every((i) => a.lines[i].rereads === 1), 're-reads land on the lines that were re-read');
  assert(a.saccades.filter((s) => s.kind === 'line').length === 3, 'three line-back regressions');
}

// 5. Planted blinks: exact count, plausible rate and duration.
for (const blinkEveryMs of [2500, 4000, 7000]) {
  const { session, truth } = D.makeSession({ seed: 5, blinkEveryMs, blinkMs: 170 });
  const a = A.analyze(session);
  assert(a.metrics.blinkCount === truth.blinks, `blinks every ${blinkEveryMs} ms: ${a.metrics.blinkCount} = planted ${truth.blinks}`);
  assert(near(a.metrics.blinkRate, truth.blinks / (truth.durationMs / 60000), 0.6), `blink rate ${a.metrics.blinkRate}/min`);
  assert(near(a.metrics.meanBlinkMs, 170, 45), `blink duration ${a.metrics.meanBlinkMs} ms ≈ 170`);
}
{
  // single blink:true frames are noise, and two runs 66 ms apart are one blink
  const frames = [];
  for (let i = 0; i < 90; i++) frames.push({ t: i * 33, face: true, blink: [10, 30, 31, 32, 34, 35, 60, 61].includes(i), head: { cx: 0.5, cy: 0.5, s: 0.1 } });
  const b = A.detectBlinks(frames);
  assert(b.length === 2, `blink rules: 1-frame run dropped, close runs merged -> ${b.length} blinks`);
}

// 6. Off-text glance and lost face show up in their metrics.
{
  const { session } = D.makeSession({ seed: 21, offTextGlances: 1, faceLostMs: 1500 });
  const a = A.analyze(session);
  assert(a.fixations.filter((f) => f.offText).length >= 1, 'off-text fixation detected');
  assert(a.saccades.some((s) => s.type === 'offtext') && a.saccades.some((s) => s.type === 'reentry'), 'off-text and re-entry saccades classified');
  assert(a.metrics.offTextPct > 0.5 && a.metrics.offTextPct < 6, `off-text ${a.metrics.offTextPct}%`);
  assert(near(a.metrics.faceLostPct, 100 * 1500 / session.durationMs, 1), `face lost ${a.metrics.faceLostPct}%`);
}

// 7. Comprehension and profile scores.
{
  const good = A.analyze(D.makeSession({ seed: 2, answers: [1, 0] }).session);
  const bad = A.analyze(D.makeSession({ seed: 2, answers: [0, null] }).session);
  assert(good.metrics.comprehension.correct === 2 && bad.metrics.comprehension.correct === 0, 'comprehension counts correct answers; null is wrong');
  assert(good.profile.comprehension === 100 && bad.profile.comprehension === 10, 'comprehension score');
  const fluent = A.analyze(D.makeSession({ seed: 2, regressionProb: 0.02, rereadAfterLines: [] }).session);
  const choppy = A.analyze(D.makeSession({ seed: 2, regressionProb: 0.45, rereadAfterLines: [2, 4, 6, 8] }).session);
  assert(fluent.profile.fluency > choppy.profile.fluency + 20, `fluency drops with regressions (${fluent.profile.fluency} vs ${choppy.profile.fluency})`);
  assert(choppy.findings.some((f) => f.id === 'rereading'), 'rereading finding for the choppy reader');
  const fast = A.analyze(D.makeSession({ seed: 2, fixMs: 170 }).session);
  const slow = A.analyze(D.makeSession({ seed: 2, fixMs: 330 }).session);
  assert(fast.profile.speed > slow.profile.speed + 15, `speed score follows pace (${fast.profile.speed} vs ${slow.profile.speed})`);
  assert(slow.findings.some((f) => f.id === 'long-fixations'), 'long-fixations finding for the slow reader');
  assert(Object.values(good.profile).every((v) => Number.isInteger(v) && v >= 0 && v <= 100), 'profile scores are integers 0..100');
}

// 8. First half vs second half picks up planted fatigue.
{
  const a = A.analyze(D.makeSession({ seed: 9, fatigue: 1.6, stuckLine: -1, rereadAfterLines: [] }).session);
  assert(a.halves.second.meanFixMs > 1.2 * a.halves.first.meanFixMs, `second half slower (${a.halves.first.meanFixMs} -> ${a.halves.second.meanFixMs} ms)`);
  assert(a.findings.some((f) => f.id === 'fatigue'), 'fatigue finding');
}

// 9. Data quality.
{
  const base = { seed: 4 };
  const acc = (effY) => ({ accuracyX: 40, accuracyY: effY, precisionX: 28, precisionY: 24, effX: 40, effY, recommendedLinePitchPx: 60 });
  assert(A.analyze(D.makeSession(base).session).quality.level === 'good', 'clean session is Good');
  assert(A.analyze(D.makeSession({ ...base, accuracy: acc(60) }).session).quality.level !== 'poor', 'moderate calibration error is not Poor');
  const lowFps = A.analyze(D.makeSession({ ...base, fps: 12, accuracy: acc(60) }).session);
  assert(lowFps.quality.level === 'poor' && near(lowFps.quality.fps, 12, 1), `12 fps + moderate calibration is Poor (${lowFps.quality.fps} fps)`);
  const s = D.makeSession(base).session; s.lowQuality = true;
  assert(A.analyze(s).quality.level === 'poor', 'continuing after a failed calibration is Poor');
  const lost = A.analyze(D.makeSession({ ...base, faceLostMs: 7000 }).session);
  assert(lost.quality.level !== 'good' && lost.quality.notes.length > 0, 'long face loss lowers quality and says why');
}

// 10. Sparse or broken input never throws.
{
  const few = A.analyze(D.makeSession({ seed: 6, maxFixations: 9 }).session);
  assert(!few.ok && few.reason === 'not-enough-data' && few.quality.level === 'poor', `fewer than ${N.QUALITY.minFixations} fixations -> not-enough-data`);
  assert(few.fixations.length === 0 && few.metrics === null && few.findings.length === 0, 'not-enough-data returns empty, well-formed analysis');
  const { session } = D.makeSession({ seed: 6 });
  const noFrames = noThrow(() => A.analyze({ ...session, frames: [] }), 'no frames (tracker without the frame event)');
  assert(noFrames.ok && noFrames.metrics.blinkRate === null && noFrames.metrics.head === null && noFrames.metrics.faceLostPct === null, 'frame-based metrics are null, the rest still computed');
  assert(noFrames.metrics.wpm > 0 && noFrames.quality.fps > 20, 'fps falls back to the gaze sample rate');
  for (const [label, bad] of [
    ['null', null], ['empty object', {}], ['no gaze', { ...session, gaze: [] }], ['no lines', { ...session, lineRects: [] }],
    ['garbage samples', { ...session, gaze: [{ t: 'x' }, null, { t: 1, x: NaN, y: 2 }], frames: [null, {}] }],
    ['missing accuracy/answers', { ...session, accuracy: undefined, answers: undefined, wordBoxes: undefined }],
    ['one line', { ...session, lineRects: session.lineRects.slice(0, 1), wordBoxes: session.wordBoxes.filter((w) => w.line === 0) }],
  ]) {
    const r = noThrow(() => A.analyze(bad), `analyze(${label}) does not throw`);
    if (r) noThrow(() => { A.summarize(bad || {}, r); JSON.stringify(r); A.recommendedSettings(r); }, `summarize(${label})`);
  }
}

// 11. The shipped demo session tells the intended story, and analysis is fast.
{
  const session = require(path.join(dir, 'demo-session.json'));
  const t = process.hrtime.bigint();
  const a = A.analyze(session);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  assert(ms < 100, `30 s session analysed in ${ms.toFixed(1)} ms`);
  assert(a.ok && a.quality.level === 'good', 'demo session is Good quality');
  assert(a.lines.find((l) => l.slowest).index === 6 && a.metrics.lineRereads === 2 && a.metrics.blinkCount === 8, 'demo: stuck line 7, two re-reads, eight blinks');
  assert(a.findings.length >= 3 && a.findings.length <= 5, `demo has ${a.findings.length} findings`);
  const text = JSON.stringify(a.findings).toLowerCase();
  assert(!/dyslexi|diagnos|disorder|probab/.test(text), 'findings never mention a diagnosis');
  const patch = A.recommendedSettings(a);
  const allowed = ['on', 'fontSize', 'letterSpacing', 'wordSpacing', 'lineHeight', 'mirror', 'font', 'gaze'];
  assert(Object.keys(patch).length > 0 && Object.keys(patch).every((k) => allowed.includes(k)), `recommended settings use real keys: ${JSON.stringify(patch)}`);
  const s = A.summarize(session, a);
  assert(s.id === session.id && s.wpm === a.metrics.wpm && s.profile.speed === a.profile.speed, 'summary carries the headline numbers');
}

if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nall analytics tests passed');
