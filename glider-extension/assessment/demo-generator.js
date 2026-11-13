/*
 * demo-generator.js — simulates a reader and returns a session in the exact
 * shape the live flow records (see the CONTRACT in analytics.js). Pure and
 * seeded: used by tools/make-demo-session.js, by the unit tests (which plant
 * known regressions, a stuck line and blinks), and as the in-page fallback for
 * demo mode when demo-session.json cannot be fetched.
 */
(function (root) {
  'use strict';
  const isNode = typeof module !== 'undefined' && module.exports;
  const P = isNode ? require('./passages.js') : root.RCPassages;

  function rng(seed) {
    let s = seed >>> 0 || 1;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    return { rnd, gauss };
  }

  /** Greedy word wrap into the controlled layout the Reading Check uses. */
  function layout(text, { viewport, fontPx, linePitchPx, charsPerLine }) {
    const charW = fontPx * 0.52, lineH = Math.round(fontPx * 1.3);
    const words = text.split(/\s+/).filter(Boolean);
    const rows = [[]];
    let len = 0;
    for (const w of words) {
      const add = (len ? 1 : 0) + w.length;
      if (len + add > charsPerLine && len) { rows.push([]); len = 0; }
      rows[rows.length - 1].push(w);
      len += (len ? 1 : 0) + w.length;
    }
    const left = Math.round((viewport.w - charsPerLine * charW) / 2);
    const top0 = Math.round(Math.max(90, (viewport.h - rows.length * linePitchPx) / 2));
    const lineRects = [], wordBoxes = [];
    rows.forEach((row, li) => {
      const top = top0 + li * linePitchPx + (linePitchPx - lineH) / 2;
      let col = 0;
      for (const w of row) {
        wordBoxes.push({ i: wordBoxes.length, text: w, line: li, left: left + col * charW, top, right: left + (col + w.length) * charW, bottom: top + lineH });
        col += w.length + 1;
      }
      lineRects.push({ top, bottom: top + lineH, left, right: left + (col - 1) * charW, text: row.join(' '), words: row.length });
    });
    return { lineRects, wordBoxes };
  }

  function makeSession(o = {}) {
    const opt = Object.assign({
      seed: 11, ageBand: 'adult', text: null, viewport: { w: 1440, h: 900 }, fontPx: 28, linePitchPx: 64, charsPerLine: 60,
      fps: 30, noiseX: 7, noiseY: 6, fixMs: 225, fixJitter: 0.22, regressionProb: 0.15,
      stuckLine: 3, stuckFactor: 2.4, rereadAfterLines: [5], blinkEveryMs: 4000, blinkMs: 170,
      offTextGlances: 1, faceLostMs: 0, fatigue: 0.12, answers: [1, 0], maxFixations: Infinity,
      accuracy: { accuracyX: 34, accuracyY: 27, precisionX: 28, precisionY: 24, effX: 36, effY: 29, recommendedLinePitchPx: 44 },
    }, o);
    const { rnd, gauss } = rng(opt.seed);
    const passage = P.forBand(opt.ageBand);
    const text = opt.text || passage.text;
    const { lineRects, wordBoxes } = layout(text, opt);
    const truth = { fixations: 0, regressions: 0, rereads: 0, blinks: 0, stuckLine: opt.stuckLine, offText: 0 };

    // ---- the reader's plan: a list of fixation targets
    const plan = [];
    const cy = (w) => (w.top + w.bottom) / 2, cx = (w) => (w.left + w.right) / 2;
    const fix = (w, mult = 1, tag = 'f') => {
      const progress = plan.length / Math.max(1, wordBoxes.length);
      const dur = Math.max(110, opt.fixMs * mult * (1 + opt.fatigue * progress) * Math.exp(opt.fixJitter * gauss()));
      plan.push({ x: cx(w), y: cy(w), dur, tag });
    };
    const minStep = 85;
    lineRects.forEach((_, li) => {
      const ws = wordBoxes.filter((w) => w.line === li);
      const stuck = li === opt.stuckLine;
      let j = 0, lastX = -1e9, canRegress = 0;
      while (j < ws.length) {
        fix(ws[j], stuck ? opt.stuckFactor : 1);
        lastX = cx(ws[j]);
        if (canRegress <= 0 && j >= 3 && j < ws.length - 1 && rnd() < (stuck ? Math.max(0.35, opt.regressionProb) : opt.regressionProb)) {
          const back = j - (rnd() < 0.5 ? 2 : 3);
          fix(ws[back], stuck ? opt.stuckFactor * 0.8 : 0.9, 'regression');
          truth.regressions++;
          lastX = cx(ws[back]);
          j = back;
          canRegress = 3;
        }
        canRegress--;
        let k = j + 1;
        while (k < ws.length - 1 && cx(ws[k]) - lastX < minStep) k++;
        if (k < ws.length && cx(ws[k]) - lastX < minStep) break;       // tail word too close: taken in with this fixation
        j = k;
      }
      if (opt.rereadAfterLines.includes(li) && li > 0) {
        const prev = wordBoxes.filter((w) => w.line === li - 1);
        const mid = Math.max(0, Math.floor(prev.length / 2) - 1);
        let px = -1e9, n = 0;
        for (let q = mid; q < prev.length && n < 3; q++) {
          if (cx(prev[q]) - px < minStep) continue;
          fix(prev[q], 1.1, n === 0 ? 'reread' : 'f'); px = cx(prev[q]); n++;
        }
        truth.rereads++; truth.regressions++;
      }
    });
    if (opt.offTextGlances > 0) {
      const at = Math.floor(plan.length * 0.62);
      plan.splice(at, 0, { x: lineRects[0].right + 260, y: lineRects[0].top - 150, dur: 420, tag: 'offtext' });
      truth.offText = 1;
    }
    if (plan.length > opt.maxFixations) plan.length = opt.maxFixations;
    truth.fixations = plan.length;

    // ---- play the plan through a 'camera' at opt.fps
    const dt = 1000 / opt.fps, SACC = 30;
    const gaze = [], frames = [];
    let t = 0, script = 0, pi = 0, pStart = 0;
    let nextBlink = opt.blinkEveryMs > 0 ? opt.blinkEveryMs * (0.6 + 0.3 * rnd()) : Infinity, blinkEnd = -1;
    const lostAt = opt.faceLostMs > 0 ? plan.reduce((s, p) => s + p.dur, 0) * 0.45 : Infinity;
    const lead = 250;                                   // eyes settle on the first word before reading
    while (pi < plan.length) {
      const head = { cx: 0.5 + 0.004 * Math.sin(t / 5200) + 0.0012 * gauss(), cy: 0.47 + 0.003 * Math.sin(t / 7300) + 0.0012 * gauss(), s: 0.112 + 0.0015 * Math.sin(t / 9100) + 0.0005 * gauss() };
      if (t >= lostAt && t < lostAt + opt.faceLostMs) {
        frames.push({ t: Math.round(t), face: false, blink: false, head: null });
      } else {
        if (t >= nextBlink && blinkEnd < 0) { blinkEnd = t + opt.blinkMs; truth.blinks++; }
        if (blinkEnd >= 0 && t < blinkEnd) {
          frames.push({ t: Math.round(t), face: true, blink: true, head });
        } else {
          if (blinkEnd >= 0) { blinkEnd = -1; nextBlink = t + opt.blinkEveryMs * (0.75 + 0.5 * rnd()); }
          frames.push({ t: Math.round(t), face: true, blink: false, head });
          const p = plan[pi];
          gaze.push({ t: Math.round(t), x: +(p.x + opt.noiseX * gauss()).toFixed(1), y: +(p.y + opt.noiseY * gauss()).toFixed(1) });
          if (t >= lead) script += dt;                   // the plan only advances while the eyes are open
          if (script - pStart >= p.dur + SACC) { pStart = script; pi++; }
        }
      }
      t += dt;
    }
    const durationMs = Math.round(t);
    truth.durationMs = durationMs;
    truth.words = wordBoxes.length;

    const session = {
      id: o.id || 'demo-' + opt.seed, startedAt: o.startedAt || Date.UTC(2026, 10, 13, 15, 30), ageBand: opt.ageBand, passageId: passage.id,
      accuracy: opt.accuracy, viewport: opt.viewport,
      passage: { title: passage.title, text, fontPx: opt.fontPx, linePitchPx: opt.linePitchPx },
      lineRects, wordBoxes, gaze, frames,
      answers: passage.questions.map((q, i) => ({ q: q.q, chosen: opt.answers[i] ?? null, correct: q.correct })),
      durationMs, lowQuality: false, demo: true,
    };
    return { session, truth };
  }

  /** A few earlier, slightly different sessions so history charts have something to show. */
  function makeHistory(n = 4) {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(makeSession({
        seed: 40 + i * 7, id: 'demo-prev-' + i, startedAt: Date.UTC(2026, 10, 13, 15, 30) - (n - i) * 6 * 86400e3,
        regressionProb: 0.24 - 0.025 * i, fixMs: 262 - 9 * i, stuckFactor: 2.8 - 0.1 * i, answers: i < 1 ? [1, 2] : [1, 0],
      }).session);
    }
    return out;
  }

  /** Per-minute aggregates like the ones session-logger.js writes during normal reading. */
  function makeMinuteLog(minutes = 26, seed = 5) {
    const { gauss } = rng(seed);
    const start = Date.UTC(2026, 10, 13, 14, 40);
    return Array.from({ length: minutes }, (_, i) => {
      const tired = i / minutes;
      return {
        t: start + i * 60000, min: i,
        blinkRate: +(9 + 7 * tired * tired + 1.2 * gauss()).toFixed(1),
        meanFixMs: Math.round(232 + 46 * tired + 9 * gauss()),
        regressionRate: +(0.13 + 0.09 * tired + 0.015 * gauss()).toFixed(3),
        fixations: Math.round(150 - 30 * tired + 8 * gauss()),
      };
    });
  }

  /* The shipped demo: ~20% regressions, a stuck line late in the passage, two line re-reads, one missed answer. */
  const DEMO_OPTIONS = { seed: 29, regressionProb: 0.2, stuckLine: 6, stuckFactor: 2.3, rereadAfterLines: [3, 7], fatigue: 0.2, answers: [1, 2] };

  const api = { makeSession, makeHistory, makeMinuteLog, layout, DEMO_OPTIONS };
  if (isNode) module.exports = api;
  else root.RCDemo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
