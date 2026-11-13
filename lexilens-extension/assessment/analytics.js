/*
 * analytics.js — pure metrics for the Reading Check. No DOM, no Chrome APIs.
 * Classic script in the browser (globalThis.RCAnalytics), require()-able in Node.
 *
 * ---------------------------------------------------------------- CONTRACT
 * SESSION (what the live flow records and the demo generator fakes):
 * {
 *   id: string, startedAt: epoch ms, ageBand: '8-10'|'11-13'|'14-17'|'adult', passageId: string,
 *   accuracy: { effX, effY, accuracyX, accuracyY, precisionX, precisionY, recommendedLinePitchPx },
 *   viewport: { w, h },
 *   passage: { title, text, fontPx, linePitchPx },
 *   lineRects: [{ top, bottom, left, right, text, words }],      viewport px, reading order
 *   wordBoxes: [{ i, text, line, left, top, right, bottom }],     viewport px
 *   gaze:   [{ t, x, y }],                    t = ms since the read began; x/y = rawX/rawY
 *   frames: [{ t, face, blink, head }],       head = { cx, cy, s } or null; may be [] if the tracker has no 'frame' event
 *   answers: [{ q, chosen, correct }],        chosen = option index or null
 *   durationMs: number, lowQuality: bool, demo: bool
 * }
 *
 * ANALYSIS = RCAnalytics.analyze(session):
 * {
 *   ok: bool, reason: null | 'not-enough-data' | 'bad-session',
 *   ageBand, norms (the band's ranges), wordCount, readMs,
 *   bounds: { left, top, right, bottom },                        passage box, unpadded
 *   fixations: [{ i, x, y, t, dur, line, offText, disp }],       line = index into lineRects or -1
 *   saccades:  [{ from, to, t, dx, dy, type, kind }],            type: forward|refix|regression|sweep|offtext|reentry
 *                                                                 kind (regressions only): 'within'|'line'
 *   metrics: { wpm, comprehension: {correct,total}, fixationCount, fixPerWord, meanFixMs, medianFixMs,
 *              saccadeCount, regressions, regressionRate, lineRereads, blinkCount, blinkRate, meanBlinkMs,
 *              stabilityPx, head: {sdCx, sdCy, sdS, sd}, offTextPct, faceLostPct, fps },
 *              (blinkRate, meanBlinkMs, head, faceLostPct are null when there are no frames)
 *   histogram: { binMs, bins: [{ from, to, count }] },           last bin is open-ended
 *   lines: [{ index, text, words, timeMs, expectedMs, ratio, fixations, rereads, slowest, flagged }],
 *   blinks: [{ t, dur }],
 *   halves: { splitMs, first: {meanFixMs, regressionRate, blinkRate}, second: {...} },
 *   profile: { speed, fluency, efficiency, steadiness, comprehension },   each 0..100
 *   compare: { wpm|meanFixMs|regressionRate|fixPerWord|blinkRate: { value, range:[lo,hi], status:'below'|'within'|'above' } },
 *   quality: { level: 'good'|'fair'|'poor', score, calibErrPx, fps, faceLostPct, gazeSamples, frameSamples, fixations, notes: [string] },
 *   findings: [{ id, tone: 'attention'|'info'|'positive', icon, title, text, settings: {key: value}, settingLabel }]
 * }
 * RCAnalytics.summarize(session, analysis) -> small object for the history list.
 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const C = isNode ? require('../gaze/gaze-core.js') : root.GazeCore;
  const N = isNode ? require('./norms.js') : root.RCNorms;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const num = (v, d = 0) => (Number.isFinite(v) ? v : d);
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const median = (a) => {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
  const round = (v, p = 0) => { const k = 10 ** p; return Math.round(v * k) / k; };

  // ----------------------------------------------------------- fixations
  function detectFixations(gaze, acc) {
    const prec = Math.max(num(acc.precisionX), num(acc.precisionY)) || 30;
    const det = new C.FixationDetector({ dispersion: clamp(2.2 * prec, 60, 220), minDur: 100, maxDur: 1e9 });
    const out = [];
    for (const g of gaze) { const f = det.push(g.t, g.x, g.y); if (f) out.push(f); }
    if (gaze.length) {                       // a far-future sample flushes the open window
      const l = gaze[gaze.length - 1];
      const f = det.push(l.t + 1e6, l.x, l.y);
      if (f) out.push(f);
    }
    // within-fixation scatter (RMS distance from the centroid) from the raw samples
    let p = 0;
    for (const f of out) {
      while (p < gaze.length && gaze[p].t < f.t) p++;
      let s = 0, n = 0;
      // strictly before the end: the detector's median-of-3 lets one post-saccade sample into the window
      for (let q = p; q < gaze.length && gaze[q].t < f.t + f.dur; q++) { s += (gaze[q].x - f.x) ** 2 + (gaze[q].y - f.y) ** 2; n++; }
      f.disp = n ? Math.sqrt(s / n) : 0;
    }
    return out;
  }

  function boundsOf(lines) {
    return {
      left: Math.min(...lines.map((l) => l.left)), right: Math.max(...lines.map((l) => l.right)),
      top: Math.min(...lines.map((l) => l.top)), bottom: Math.max(...lines.map((l) => l.bottom)),
    };
  }
  const inside = (b, x, y, px, py) => x >= b.left - px && x <= b.right + px && y >= b.top - py && y <= b.bottom + py;

  // ----------------------------------------------------------- blinks
  function detectBlinks(frames) {
    if (!frames.length) return [];
    const dts = [];
    for (let i = 1; i < frames.length; i++) dts.push(frames[i].t - frames[i - 1].t);
    const frameMs = clamp(median(dts) || 33, 5, 200);
    const runs = [];
    let run = null;
    for (const f of frames) {
      if (f.face && f.blink) {
        if (run) { run.t1 = f.t; run.n++; } else run = { t0: f.t, t1: f.t, n: 1 };
      } else if (run) { runs.push(run); run = null; }
    }
    if (run) runs.push(run);
    const merged = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && r.t0 - last.t1 < 100) { last.t1 = r.t1; last.n += r.n; } else merged.push({ ...r });
    }
    return merged.filter((r) => r.n >= 2).map((r) => ({ t: r.t0, dur: r.t1 - r.t0 + frameMs }));
  }

  // ----------------------------------------------------------- scoring
  /** Typical range maps to 50..85 (85 at the better edge); linear beyond, clamped 5..100. */
  function scoreHigher(v, [lo, hi]) { return clamp(50 + 35 * ((v - lo) / (hi - lo || 1)), 5, 100); }
  function scoreLower(v, [lo, hi]) { return clamp(85 - 35 * ((v - lo) / (hi - lo || 1)), 5, 100); }
  function status(v, [lo, hi]) { return v < lo ? 'below' : v > hi ? 'above' : 'within'; }

  function empty(session, reason, extra = {}) {
    return Object.assign({
      ok: false, reason, ageBand: session && session.ageBand, norms: N.forBand(session && session.ageBand),
      wordCount: 0, readMs: 0, bounds: null, fixations: [], saccades: [], metrics: null, histogram: { binMs: 50, bins: [] },
      lines: [], blinks: [], halves: null, profile: null, compare: {}, findings: [],
      quality: { level: 'poor', score: 0, calibErrPx: null, fps: 0, faceLostPct: null, gazeSamples: 0, frameSamples: 0, fixations: 0, notes: ['Not enough eye-movement data was captured.'] },
    }, extra);
  }

  // ----------------------------------------------------------- analyze
  function analyze(session) {
    if (!session || typeof session !== 'object') return empty({}, 'bad-session');
    const lineRects = Array.isArray(session.lineRects) ? session.lineRects.filter((l) => l && Number.isFinite(l.top) && Number.isFinite(l.left)) : [];
    const gaze = (Array.isArray(session.gaze) ? session.gaze : [])
      .filter((g) => g && Number.isFinite(g.t) && Number.isFinite(g.x) && Number.isFinite(g.y)).sort((a, b) => a.t - b.t);
    const frames = (Array.isArray(session.frames) ? session.frames : []).filter((f) => f && Number.isFinite(f.t)).sort((a, b) => a.t - b.t);
    const acc = session.accuracy && typeof session.accuracy === 'object' ? session.accuracy : {};
    const norms = N.forBand(session.ageBand);
    const answers = Array.isArray(session.answers) ? session.answers : [];
    const comprehension = { correct: answers.filter((a) => a && a.chosen != null && a.chosen === a.correct).length, total: answers.length || 2 };
    const words = Array.isArray(session.wordBoxes) && session.wordBoxes.length
      ? session.wordBoxes.length
      : lineRects.reduce((s, l) => s + num(l.words), 0);
    const readMs = num(session.durationMs) || (gaze.length ? gaze[gaze.length - 1].t - gaze[0].t : 0);
    const quality = qualityOf(session, acc, gaze, frames, readMs);

    if (!lineRects.length || !words) return empty(session, 'bad-session', { quality });
    const fixations = detectFixations(gaze, acc);
    quality.fixations = fixations.length;
    if (fixations.length < N.QUALITY.minFixations) {
      quality.level = 'poor';
      quality.notes.unshift(`Only ${fixations.length} fixations were captured (at least ${N.QUALITY.minFixations} are needed).`);
      return empty(session, 'not-enough-data', { quality, wordCount: words, readMs });
    }

    const effX = Math.max(20, num(acc.effX, 60)), effY = Math.max(18, num(acc.effY, 60));
    const bounds = boundsOf(lineRects);

    // --- line assignment (HMM over the known lines)
    const hmm = new C.LineHMM({ y: 0 });
    fixations.forEach((f, i) => {
      f.i = i;
      f.offText = !inside(bounds, f.x, f.y, 1.5 * effX, 1.5 * effY);
      f.line = f.offText ? -1 : hmm.update(lineRects, f.x, f.y, Math.max(25, effX), effY, true).line;
    });

    // --- saccades
    const saccades = [];
    const rereadsPerLine = lineRects.map(() => 0);
    let regressions = 0, lineRereads = 0;
    for (let i = 1; i < fixations.length; i++) {
      const a = fixations[i - 1], b = fixations[i];
      const s = { from: i - 1, to: i, t: b.t, dx: b.x - a.x, dy: b.y - a.y, type: 'forward', kind: null };
      if (b.offText) s.type = 'offtext';
      else if (a.offText) s.type = 'reentry';
      else if (b.line === a.line) {
        if (s.dx < -1.5 * effX) { s.type = 'regression'; s.kind = 'within'; }
        else if (s.dx < 0) s.type = 'refix';
      } else if (b.line > a.line) s.type = 'sweep';
      else {
        s.type = 'regression'; s.kind = 'line';
        // a re-read is a jump back that sticks for a second fixation (filters one-off decode flicker)
        let nx = fixations[i + 1];
        for (let k = i + 1; nx && nx.offText; k++) nx = fixations[k + 1];
        if (!nx || nx.line < a.line) { lineRereads++; rereadsPerLine[b.line]++; s.reread = true; }
      }
      if (s.type === 'regression') regressions++;
      saccades.push(s);
    }
    const regressionRate = saccades.length ? regressions / saccades.length : 0;

    // --- timing
    const onText = fixations.filter((f) => !f.offText);
    const durs = fixations.map((f) => f.dur);
    const last = lineRects.length - 1;
    const firstL0 = onText.find((f) => f.line === 0);
    let lastLn = null;
    for (const f of onText) if (f.line === last) lastLn = f;
    let t0 = firstL0 ? firstL0.t : null, t1 = lastLn ? lastLn.t + lastLn.dur : null;
    const spanAll = onText.length ? onText[onText.length - 1].t + onText[onText.length - 1].dur - onText[0].t : 0;
    if (t0 === null || t1 === null || t1 - t0 < 0.4 * spanAll) {
      t0 = onText.length ? onText[0].t : 0;
      t1 = onText.length ? onText[onText.length - 1].t + onText[onText.length - 1].dur : readMs;
    }
    const readSpan = Math.max(1, t1 - t0);
    const wpm = clamp(words / (readSpan / 60000), 10, 1200);

    // --- per-line time vs the reader's own pace
    const dwell = lineRects.map(() => 0), fixN = lineRects.map(() => 0);
    fixations.forEach((f, i) => {
      if (f.line < 0) return;
      const nx = fixations[i + 1];
      dwell[f.line] += nx ? Math.min(nx.t - f.t, f.dur + 250) : f.dur;
      fixN[f.line]++;
    });
    const lineWords = lineRects.map((l, i) => num(l.words) || (session.wordBoxes || []).filter((w) => w.line === i).length || 1);
    const totalDwell = dwell.reduce((s, v) => s + v, 0);
    const msPerWord = totalDwell / Math.max(1, lineWords.reduce((s, v) => s + v, 0));
    const lines = lineRects.map((l, i) => {
      const expectedMs = lineWords[i] * msPerWord;
      return {
        index: i, text: l.text || '', words: lineWords[i], timeMs: Math.round(dwell[i]), expectedMs: Math.round(expectedMs),
        ratio: expectedMs > 0 ? round(dwell[i] / expectedMs, 2) : 0, fixations: fixN[i], rereads: rereadsPerLine[i], slowest: false, flagged: false,
      };
    });
    const candidates = lines.filter((l) => l.words >= 3);
    if (candidates.length) {
      const slow = candidates.reduce((a, b) => (b.ratio > a.ratio ? b : a));
      slow.slowest = true;
      for (const l of candidates) l.flagged = l.ratio >= 1.4;
    }

    // --- blinks, head, tracking
    const blinks = detectBlinks(frames);
    const frameSpan = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
    const hasFrames = frames.length > 10 && frameSpan > 0;
    const faceFrames = frames.filter((f) => f.face && f.head);
    const head = hasFrames && faceFrames.length > 5 ? {
      sdCx: sd(faceFrames.map((f) => f.head.cx)), sdCy: sd(faceFrames.map((f) => f.head.cy)), sdS: sd(faceFrames.map((f) => f.head.s)),
    } : null;
    if (head) head.sd = Math.hypot(head.sdCx, head.sdCy, head.sdS);
    const offN = gaze.filter((g) => !inside(bounds, g.x, g.y, effX, effY)).length;
    const stabilityPx = median(fixations.map((f) => f.disp));

    const metrics = {
      wpm: Math.round(wpm), comprehension,
      fixationCount: fixations.length, fixPerWord: round(onText.length / words, 2),
      meanFixMs: Math.round(mean(durs)), medianFixMs: Math.round(median(durs)),
      saccadeCount: saccades.length, regressions, regressionRate: round(regressionRate, 3), lineRereads,
      blinkCount: blinks.length,
      blinkRate: hasFrames ? round(blinks.length / (frameSpan / 60000), 1) : null,
      meanBlinkMs: hasFrames && blinks.length ? Math.round(mean(blinks.map((b) => b.dur))) : null,
      stabilityPx: round(stabilityPx, 1), head,
      offTextPct: round(100 * offN / Math.max(1, gaze.length), 1),
      faceLostPct: quality.faceLostPct, fps: quality.fps,
    };

    // --- histogram (50 ms bins, 100..800, last bin open)
    const BIN = 50, FROM = 100, TO = 800;
    const bins = [];
    for (let b = FROM; b <= TO; b += BIN) bins.push({ from: b, to: b === TO ? Infinity : b + BIN, count: 0 });
    for (const d of durs) bins[clamp(Math.floor((d - FROM) / BIN), 0, bins.length - 1)].count++;

    // --- first half vs second half
    const splitMs = t0 + readSpan / 2;
    const half = (lo, hi) => {
      const fx = fixations.filter((f) => f.t >= lo && f.t < hi);
      const sc = saccades.filter((s) => s.t >= lo && s.t < hi);
      const bl = blinks.filter((b) => b.t >= lo && b.t < hi);
      return {
        meanFixMs: Math.round(mean(fx.map((f) => f.dur))),
        regressionRate: round(sc.length ? sc.filter((s) => s.type === 'regression').length / sc.length : 0, 3),
        blinkRate: hasFrames && hi > lo ? round(bl.length / ((hi - lo) / 60000), 1) : null,
      };
    };
    const halves = { splitMs: Math.round(splitMs), first: half(t0, splitMs), second: half(splitMs, t1 + 1) };

    // --- profile
    const stabScore = scoreLower(stabilityPx, norms.stabilityPx);
    const profile = {
      speed: scoreHigher(wpm, norms.wpm),
      fluency: 0.7 * scoreLower(regressionRate, norms.regressionRate) + 0.3 * clamp(100 - 200 * (lineRereads / lineRects.length), 5, 100),
      efficiency: scoreLower(metrics.fixPerWord, norms.fixPerWord),
      steadiness: head ? 0.5 * stabScore + 0.5 * scoreLower(head.sd, norms.headSd) : stabScore,
      comprehension: comprehension.total ? clamp(10 + 90 * (comprehension.correct / comprehension.total), 0, 100) : 0,
    };
    for (const k of Object.keys(profile)) profile[k] = Math.round(profile[k]);

    const cmp = (value, range) => ({ value, range, status: status(value, range) });
    const compare = {
      wpm: cmp(metrics.wpm, norms.wpm), meanFixMs: cmp(metrics.meanFixMs, norms.fixMs),
      regressionRate: cmp(metrics.regressionRate, norms.regressionRate), fixPerWord: cmp(metrics.fixPerWord, norms.fixPerWord),
    };
    if (metrics.blinkRate !== null) compare.blinkRate = cmp(metrics.blinkRate, norms.blinkRate);

    const analysis = {
      ok: true, reason: null, ageBand: session.ageBand, norms, wordCount: words, readMs: Math.round(readMs), bounds,
      fixations: fixations.map((f) => ({ i: f.i, x: round(f.x, 1), y: round(f.y, 1), t: Math.round(f.t), dur: Math.round(f.dur), line: f.line, offText: f.offText, disp: round(f.disp, 1) })),
      saccades, metrics, histogram: { binMs: BIN, bins }, lines, blinks, halves, profile, compare, quality,
    };
    analysis.findings = findings(analysis);
    return analysis;
  }

  // ----------------------------------------------------------- data quality
  function qualityOf(session, acc, gaze, frames, readMs) {
    const Q = N.QUALITY;
    const notes = [];
    const frameSpan = frames.length > 1 ? frames[frames.length - 1].t - frames[0].t : 0;
    const gazeSpan = gaze.length > 1 ? gaze[gaze.length - 1].t - gaze[0].t : 0;
    const fps = frameSpan > 0 ? frames.length / (frameSpan / 1000) : gazeSpan > 0 ? gaze.length / (gazeSpan / 1000) : 0;
    const faceLostPct = frames.length ? 100 * frames.filter((f) => !f.face).length / frames.length : null;
    const calibErrPx = Number.isFinite(acc.effY) ? acc.effY : null;
    let score = 100;
    if (calibErrPx === null) { score -= 20; notes.push('No calibration accuracy was recorded.'); }
    else if (calibErrPx > Q.calibPoorPx) { score -= 45; notes.push(`Calibration error was high (±${Math.round(calibErrPx)} px vertically).`); }
    else if (calibErrPx > Q.calibGoodPx) { score -= 20; notes.push(`Calibration error was moderate (±${Math.round(calibErrPx)} px vertically).`); }
    if (fps < Q.fpsPoor) { score -= 35; notes.push(`The camera delivered only ${Math.round(fps)} frames a second.`); }
    else if (fps < Q.fpsGood) { score -= 15; notes.push(`The camera frame rate was a little low (${Math.round(fps)} fps).`); }
    if (faceLostPct === null) notes.push('Blink and head data were not available from the tracker.');
    else if (faceLostPct > Q.faceLostPoorPct) { score -= 35; notes.push(`The face was out of view for ${Math.round(faceLostPct)}% of the time.`); }
    else if (faceLostPct > Q.faceLostFairPct) { score -= 15; notes.push(`The face was briefly out of view (${Math.round(faceLostPct)}% of the time).`); }
    if (session.lowQuality) { score = Math.min(score, 45); notes.push('The reader continued after a low-accuracy calibration.'); }
    if (readMs && readMs < 6000) { score -= 20; notes.push('The read was very short.'); }
    score = clamp(score, 0, 100);
    return {
      level: score >= 75 ? 'good' : score >= 50 ? 'fair' : 'poor', score,
      calibErrPx, fps: round(fps, 1), faceLostPct: faceLostPct === null ? null : round(faceLostPct, 1),
      gazeSamples: gaze.length, frameSamples: frames.length, fixations: 0, notes,
    };
  }

  // ----------------------------------------------------------- findings
  /* Plain-language observations. Never a diagnosis: wording stays at "this read" and "typical range". */
  function findings(a) {
    const m = a.metrics, c = a.compare, out = [];
    const pct = (v) => Math.round(v * 100) + '%';
    const add = (f) => out.push(Object.assign({ settings: {}, settingLabel: '' }, f));

    if (c.regressionRate.status === 'above' || m.lineRereads >= Math.max(2, Math.ceil(a.lines.length / 3))) {
      add({
        id: 'rereading', tone: 'attention', icon: 'back',
        title: 'You went back to re-read more often than is typical',
        text: `${pct(m.regressionRate)} of your eye movements went backwards and you returned to an earlier line ${m.lineRereads} time${m.lineRereads === 1 ? '' : 's'}. The typical range for your age group is ${pct(c.regressionRate.range[0])}–${pct(c.regressionRate.range[1])}. Wider line spacing can make it easier to keep your place.`,
        settings: { on: true, lineHeight: 2.2 }, settingLabel: 'Wider line spacing',
      });
    }
    if (c.meanFixMs.status === 'above') {
      add({
        id: 'long-fixations', tone: 'attention', icon: 'clock',
        title: 'Your eyes rested on words longer than is typical',
        text: `Your average pause on a word was ${m.meanFixMs} ms (typical range ${c.meanFixMs.range[0]}–${c.meanFixMs.range[1]} ms). Longer pauses can mean words take more effort to decode. Extra letter spacing and the syllable lens (hover a long word) can help.`,
        settings: { on: true, letterSpacing: 2 }, settingLabel: 'Wider letter spacing + syllable lens',
      });
    }
    if (c.fixPerWord.status === 'above') {
      add({
        id: 'many-fixations', tone: 'attention', icon: 'dots',
        title: 'You made more stops per word than is typical',
        text: `You made about ${m.fixPerWord} stops per word (typical range ${c.fixPerWord.range[0]}–${c.fixPerWord.range[1]}). Larger text with more space between words lets each stop take in a whole word.`,
        settings: { on: true, fontSize: 120, wordSpacing: 6 }, settingLabel: 'Larger text and word spacing',
      });
    }
    const slow = a.lines.find((l) => l.slowest && l.flagged);
    if (slow) {
      add({
        id: 'slow-line', tone: 'info', icon: 'line',
        title: `Line ${slow.index + 1} took ${slow.ratio}× longer than your own pace`,
        text: `“${slow.text}” held your eyes for ${(slow.timeMs / 1000).toFixed(1)} s, against about ${(slow.expectedMs / 1000).toFixed(1)} s expected from the rest of your read. Eye tracking in TextTuner can notice a line like this and offer help on the spot.`,
        settings: { on: true, gaze: true }, settingLabel: 'Turn on eye-tracking help',
      });
    }
    if (m.comprehension.correct < m.comprehension.total && c.wpm.status !== 'below') {
      add({
        id: 'comprehension', tone: 'info', icon: 'question',
        title: 'Speed was fine, but an answer was missed',
        text: `You answered ${m.comprehension.correct} of ${m.comprehension.total} questions correctly at ${m.wpm} words a minute. Reading speed only counts when the meaning comes with it; a slightly slower pace may help.`,
      });
    }
    const h = a.halves;
    const tiredFix = h.first.meanFixMs > 0 && h.second.meanFixMs > 1.2 * h.first.meanFixMs;
    const tiredBlink = h.first.blinkRate !== null && h.second.blinkRate > 1.6 * Math.max(4, h.first.blinkRate);
    if (tiredFix || tiredBlink) {
      add({
        id: 'fatigue', tone: 'info', icon: 'eye',
        title: 'Your eyes worked harder in the second half',
        text: `${tiredFix ? `Pauses grew from ${h.first.meanFixMs} ms to ${h.second.meanFixMs} ms. ` : ''}${tiredBlink ? `Blinking rose from ${h.first.blinkRate} to ${h.second.blinkRate} a minute. ` : ''}This can be an early sign of tiring. Short breaks and larger text ease the load on long assignments.`,
        settings: { on: true, fontSize: 115 }, settingLabel: 'Slightly larger text',
      });
    }
    if (m.blinkRate !== null && c.blinkRate && c.blinkRate.status === 'below') {
      add({
        id: 'low-blink', tone: 'info', icon: 'eye',
        title: 'You blinked very little while reading',
        text: `About ${m.blinkRate} blinks a minute (typical while reading: ${c.blinkRate.range[0]}–${c.blinkRate.range[1]}). Staring at a screen dries the eyes; look away for a few seconds every few minutes.`,
      });
    }
    if (m.offTextPct > 15) {
      add({
        id: 'off-text', tone: 'info', icon: 'target',
        title: 'Your gaze left the text fairly often',
        text: `${Math.round(m.offTextPct)}% of the tracked time was spent outside the passage. A calmer page and wider spacing make the text easier to stay on.`,
        settings: { on: true, lineHeight: 2.0 }, settingLabel: 'Wider line spacing',
      });
    }
    if (!out.some((f) => f.tone === 'attention')) {
      out.unshift({
        id: 'typical', tone: 'positive', icon: 'check', settings: {}, settingLabel: '',
        title: 'This read sat within the typical ranges',
        text: `Pause length, backward jumps and stops per word were all at or better than the typical range for your age group on this passage (${m.wpm} words a minute, ${m.comprehension.correct} of ${m.comprehension.total} answers correct).`,
      });
    }
    return out.slice(0, 5);
  }

  /** Merged settings patch from the findings (later findings never lower an earlier value). */
  function recommendedSettings(analysis) {
    const patch = {};
    for (const f of (analysis && analysis.findings) || []) {
      for (const [k, v] of Object.entries(f.settings || {})) {
        patch[k] = typeof v === 'number' && typeof patch[k] === 'number' ? Math.max(patch[k], v) : v;
      }
    }
    return patch;
  }

  function summarize(session, a) {
    const m = a.metrics || {};
    return {
      id: session.id, startedAt: session.startedAt, ageBand: session.ageBand, passageId: session.passageId, demo: !!session.demo,
      ok: a.ok, quality: a.quality.level,
      wpm: m.wpm ?? null, comprehension: m.comprehension ? m.comprehension.correct : null,
      fixPerWord: m.fixPerWord ?? null, meanFixMs: m.meanFixMs ?? null, regressionRate: m.regressionRate ?? null,
      lineRereads: m.lineRereads ?? null, blinkRate: m.blinkRate ?? null, stabilityPx: m.stabilityPx ?? null,
      offTextPct: m.offTextPct ?? null, profile: a.profile || null,
    };
  }

  const api = { analyze, summarize, findings, recommendedSettings, detectFixations, detectBlinks, scoreHigher, scoreLower };
  if (isNode) module.exports = api;
  else root.RCAnalytics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
