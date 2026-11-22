// Offline replay of the shipped fixation -> line -> struggle pipeline (ported wiring from
// glider-extension/gaze/gaze-reader.js; the classes themselves are the real ones from gaze-core.js),
// plus the nearest-line baseline and the proposed "progress" decoder ported from audit-decoding/lib.js.
import { C, clamp, isNum } from './util.mjs';

/** What applyAccuracy() derives from an accuracy object. Falls back to the S defaults (60, 60, 90). */
export function accParams(acc) {
  if (!acc || !isNum(acc.effX) || !isNum(acc.effY)) return { sx: 60, sy: 60, dispersion: 90, fromDump: false };
  return { ...C.trackingParams({ ...acc, precisionX: acc.precisionX || 0, precisionY: acc.precisionY || 0 }), fromDump: true };
}

/** samples: [{t,x,y}] in time order, blink frames already removed (processFrame skips them). */
export function detectFixations(samples, dispersion) {
  const det = new C.FixationDetector({ dispersion }); const out = [];
  for (const s of samples) { const f = det.push(s.t, s.x, s.y); if (f) out.push({ ...f, emitT: s.t }); }
  return out;
}

/** layout.blocks -> [{id, pitch, lines, rect, words}] with only usable lines kept. */
export function blocksOf(layout) {
  const out = [];
  for (const b of (layout && Array.isArray(layout.blocks) ? layout.blocks : [])) {
    const lines = (Array.isArray(b.lines) ? b.lines : []).filter((l) => l && isNum(l.top) && isNum(l.bottom) && isNum(l.left) && isNum(l.right));
    if (!lines.length) continue;
    const rect = { top: Math.min(...lines.map((l) => l.top)), bottom: Math.max(...lines.map((l) => l.bottom)), left: Math.min(...lines.map((l) => l.left)), right: Math.max(...lines.map((l) => l.right)) };
    let pitch = b.pitch;
    if (!isNum(pitch) && lines.length > 1) pitch = (lines[lines.length - 1].top - lines[0].top) / (lines.length - 1);
    if (!isNum(pitch)) pitch = lines[0].bottom - lines[0].top;
    const words = lines.reduce((a, l) => a + (Array.isArray(l.words) ? l.words.length : 0), 0) || lines.length * 10;
    out.push({ id: b.id, pitch, lines, rect, words });
  }
  return out;
}

/**
 * onFixation + checkStruggle, as wired in gaze-reader.js (no scrolling: the lab page does not scroll).
 * @returns {{dec: Array<null|{b:number,line:number,conf:number}>, triggers: Array<{t,reason,b,line}>}}
 */
export function replayShipped(fixes, blocks, P = {}) {
  const sx = P.sx || 60, sy = P.sy || 60;
  let wpm = P.wpm || 150; const baseWpm = P.baselineWpm || null;
  const T = clamp((P.tau || C.TAU_DEFAULT) * (P.sensitivity || 1), 1.3, 4);
  const regressionRate = P.regressionRate || 0;
  const drift = { y: 0 }; const states = new Map();
  let cur = null, prevBlockBottom = null, prevFixEnd = 0;
  const dec = [], triggers = [];
  const reset = (st, n) => Object.assign(st, { nLines: n, lineDwell: new Float64Array(n), visits: new Uint16Array(n), totalDwell: 0, runMs: 0, lastLine: -1, maxLine: -1, backtracks: [], triggers: 0 });
  const state = (b) => { let st = states.get(b); if (!st) { st = { hmm: new C.LineHMM(drift), words: blocks[b].words, leftAt: -1e9, lastTrigger: -1e9 }; reset(st, 0); states.set(b, st); } return st; };
  const normDist = (r, x, y) => { const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0; const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0; return Math.hypot(dx / sx, dy / sy); };
  const pick = (x, y) => {
    let best = null, bd = Infinity;
    blocks.forEach((b, i) => { const d = normDist(b.rect, x, y); if (d < bd) { bd = d; best = i; } });
    if (cur !== null) { const dc = normDist(blocks[cur].rect, x, y); if (dc < 1.2 && dc <= bd + 0.8) return cur; }
    return bd <= 2 ? best : null;
  };
  const expected = (st, lines, L) => {
    const widths = lines.map((l) => l.right - l.left), total = widths.reduce((a, v) => a + v, 0) || 1; const mpw = 60000 / wpm;
    return { para: st.words * mpw + 150 * lines.length, line: L >= 0 ? st.words * (widths[L] / total) * mpw + 150 : 0 };
  };
  for (const fix of fixes) {
    const b = pick(fix.x, fix.y);
    if (b !== cur) {
      if (cur !== null) {   // leaveBlock
        const st = state(cur); st.leftAt = fix.t; prevBlockBottom = blocks[cur].rect.bottom;
        if (st.nLines > 1 && st.maxLine >= st.nLines - 1 && st.triggers === 0 && st.totalDwell > 1500 && st.words > 8) {
          wpm = 0.75 * wpm + 0.25 * clamp(st.words / (st.totalDwell / 60000), 50, 450);
          if (baseWpm) wpm = clamp(wpm, 0.6 * baseWpm, 1.5 * baseWpm);
        }
      }
      cur = b;
      if (b !== null) { const st = state(b); if (fix.t - st.leftAt > 5000) reset(st, st.nLines); st.hmm.reset(); st.justEntered = true; }
    }
    if (b === null) { dec.push(null); continue; }
    const st = state(b), lines = blocks[b].lines;
    if (st.nLines !== lines.length) { reset(st, lines.length); st.hmm.reset(); }
    const fromAbove = !!st.justEntered && prevBlockBottom !== null && prevBlockBottom <= lines[0].top + 5;
    const r = st.hmm.update(lines, fix.x, fix.y, sx, sy, fromAbove);
    st.justEntered = false;
    const L = r.line, end = fix.t + fix.dur;
    const dwell = prevFixEnd && end - prevFixEnd < 1200 ? end - prevFixEnd : fix.dur;
    prevFixEnd = end;
    st.totalDwell += dwell; st.lineDwell[L] += dwell;
    if (L === st.lastLine) st.runMs += dwell;
    else {
      if (st.lastLine >= 0 && L < st.lastLine && L <= st.maxLine && r.conf > 0.55) st.backtracks.push(fix.t);
      if (st.visits[L] > 0 && st.runMs >= 500 && r.conf > 0.55) st.lineDwell[L] = dwell;
      st.visits[L]++; st.runMs = dwell; st.lastLine = L;
    }
    st.maxLine = Math.max(st.maxLine, L);
    dec.push({ b, line: L, conf: r.conf });
    // checkStruggle
    const now = fix.t;
    if (now - st.lastTrigger < 8000) continue;
    const exp = expected(st, lines, st.lastLine);
    st.backtracks = st.backtracks.filter((bt) => now - bt < 15000);
    const d = C.struggleDecision({ onLineMs: st.lineDwell[L], expLineMs: exp.line, paraMs: st.totalDwell, expParaMs: exp.para, finished: st.maxLine >= st.nLines - 1, backtracks: st.backtracks.length, tau: T, regressionRate });
    if (!d.reason) continue;
    triggers.push({ t: fix.emitT ?? end, reason: d.reason, b, line: L, severity: d.severity });
    st.lastTrigger = now; st.triggers++; st.runMs = 0; st.backtracks = []; st.lineDwell[L] = 0;
  }
  return { dec, triggers };
}

export function decodeNearest(fixes, flat, dy = 0) {
  return fixes.map((f) => { let b = -1, bd = Infinity; flat.forEach((l, j) => { const d = Math.abs((l.top + l.bottom) / 2 - (f.y - dy)); if (d < bd) { bd = d; b = j; } }); return b; });
}

/**
 * Proposed decoder (audit-decoding/lib.js decodeProg, evaluated there with emisScale 3): HMM over
 * (line, progress bin). x is evidence for progress, pace gives the expected advance, the end of a
 * line flows into the start of the next, Kalman drift. `lines` is the flat list in reading order.
 */
export function decodeProg(fixes, lines, sx, sy, K = {}) {
  const o = Object.assign({ B: 10, useX: true, useDur: true, msPerPx: 255 / 72, slowFrac: 0.5, tauDrift: 30000, pReg: 0.10, pPrev: 0.03, pLeak: 0.02, fromAbove: true, emisScale: 3 }, K);
  const n = lines.length, B = o.B, S = n * B, out = new Array(fixes.length).fill(-1);
  if (!n) return out;
  const cys = lines.map((l) => (l.top + l.bottom) / 2), ws = lines.map((l) => Math.max(1, l.right - l.left));
  let belief = null, d = 0, Pd = o.slowFrac * sy * sy, lastEnd = null;
  const syE = Math.sqrt((1 - o.slowFrac) * sy * sy);
  const lineOf = (b) => { const m = new Float64Array(n); for (let s = 0; s < S; s++) m[(s / B) | 0] += b[s]; return m; };
  fixes.forEach((f, idx) => {
    const end = f.t + f.dur; const dtm = lastEnd === null ? 0 : Math.min(1500, Math.max(0, end - lastEnd));
    if (lastEnd !== null) Pd = Math.min(o.slowFrac * sy * sy, Pd + o.slowFrac * sy * sy * dtm / o.tauDrift);
    lastEnd = end;
    const fy = f.y - d; const sE = o.emisScale * Math.sqrt(syE * syE + Pd);
    const emis = new Float64Array(S);
    for (let i = 0; i < n; i++) {
      const ey = Math.exp(-0.5 * ((fy - cys[i]) / sE) ** 2);
      const sxe = Math.sqrt(sx * sx + (ws[i] / B / 2) ** 2 + 40 * 40);
      for (let k = 0; k < B; k++) {
        let ex = 1;
        if (o.useX) ex = 0.03 + 0.97 * Math.exp(-0.5 * ((f.x - (lines[i].left + (k + 0.5) / B * ws[i])) / sxe) ** 2);
        emis[i * B + k] = ey * ex + 1e-12;
      }
    }
    let prior;
    if (!belief) { prior = new Float64Array(S).fill(1); if (o.fromAbove) for (let k = 0; k < B; k++) prior[k] = 3; }
    else {
      prior = new Float64Array(S);
      const fwd = 1 - o.pReg - o.pPrev - o.pLeak;
      let tot = 0; for (let s = 0; s < S; s++) tot += belief[s];
      const leak = o.pLeak / S * tot;
      for (let s = 0; s < S; s++) prior[s] = leak;
      for (let i = 0; i < n; i++) {
        const adv = o.useDur ? dtm / (ws[i] * o.msPerPx) * B : 0;
        for (let k = 0; k < B; k++) {
          const b = belief[i * B + k]; if (b < 1e-9) continue;
          for (let q = 0; q <= k; q++) prior[i * B + q] += b * o.pReg / (k + 1);
          if (i > 0) for (let q = 0; q < B; q++) prior[(i - 1) * B + q] += b * o.pPrev / B; else prior[i * B + k] += b * o.pPrev;
          const w = new Float64Array(2 * B); let wsum = 0;
          if (o.useDur) { const sdv = 0.8 + 0.6 * adv; for (let q = k; q < 2 * B; q++) { w[q] = Math.exp(-0.5 * ((q - k - adv) / sdv) ** 2); wsum += w[q]; } }
          else { for (let q = k; q < B + 2; q++) { w[q] = q === k ? 3 : 1; wsum += w[q]; } }
          for (let q = k; q < 2 * B; q++) {
            if (!w[q]) continue; const m = b * fwd * w[q] / wsum;
            if (q < B) prior[i * B + q] += m;
            else if (i + 1 < n) prior[(i + 1) * B + Math.min(B - 1, q - B)] += m;
            else prior[i * B + B - 1] += m;
          }
        }
      }
    }
    const post = new Float64Array(S); let s = 0;
    for (let j = 0; j < S; j++) { post[j] = prior[j] * emis[j]; s += post[j]; }
    for (let j = 0; j < S; j++) post[j] /= s || 1;
    belief = post; const lm = lineOf(post); let best = 0; for (let j = 1; j < n; j++) if (lm[j] > lm[best]) best = j;
    out[idx] = best;
    let m = 0, v = 0; for (let j = 0; j < n; j++) m += lm[j] * cys[j]; for (let j = 0; j < n; j++) v += lm[j] * (cys[j] - m) ** 2;
    const R = syE * syE + v, Kg = Pd / (Pd + R); d += Kg * ((f.y - m) - d); Pd = (1 - Kg) * Pd;
  });
  return out;
}
