// Numeric analysis of one Gaze Lab recording. analyze(rec, {cal}) returns a plain object with one
// key per report section (null / {na:'reason'} when the task or data does not support it).
import { C, isNum, mean, sd, rms, mae, median, quantile, clamp, pooledAutocorr, effectiveN } from './util.mjs';
import { accParams, detectFixations, replayShipped, blocksOf, decodeNearest, decodeProg } from './replay.mjs';

const IPD_CM = 6.3;
const arr = (v) => (Array.isArray(v) ? v : []);
const na = (why) => ({ na: why });

// ------------------------------------------------------------------ preparation
function prep(rec, cal) {
  const ev = arr(rec.events).filter((e) => e && isNum(e.t));
  const raw = ev.filter((e) => e.k === 'raw').sort((a, b) => a.t - b.t);
  const gaze = ev.filter((e) => e.k === 'gaze').map((e) => ({ t: e.t, x: isNum(e.rawX) ? e.rawX : e.x, y: isNum(e.rawY) ? e.rawY : e.y })).filter((g) => isNum(g.x) && isNum(g.y)).sort((a, b) => a.t - b.t);
  const gazeIsRaw = ev.some((e) => e.k === 'gaze' && isNum(e.rawX));
  const own = rec.dump && typeof rec.dump === 'object' ? rec.dump : {};
  const hasTrain = (d) => d && d.train && Array.isArray(d.train.X) && d.train.X.length > 10 && Array.isArray(d.train.Y) && d.train.Y.length === d.train.X.length;
  let dump = own, dumpSource = hasTrain(own) ? 'this recording' : null;
  if (!hasTrain(own) && cal && hasTrain(cal.rec.dump)) { dump = { ...cal.rec.dump, ...Object.fromEntries(Object.entries(own).filter(([, v]) => v != null)) }; dump.train = cal.rec.dump.train; dumpSource = cal.name; }
  const env = rec.env || {}, phys = rec.physical || {};
  const scr = env.screen || {}; let pxPerCm = NaN, pxPerDeg = NaN;
  if (isNum(scr.w) && isNum(scr.h) && isNum(phys.screenDiagIn) && phys.screenDiagIn > 0) pxPerCm = Math.hypot(scr.w, scr.h) / (phys.screenDiagIn * 2.54);
  if (isNum(pxPerCm) && isNum(phys.distanceCm)) pxPerDeg = pxPerCm * phys.distanceCm * Math.tan(Math.PI / 180);
  const camEv = ev.filter((e) => e.k === 'camera' && e.settings).pop();
  const camera = (camEv && camEv.settings) || dump.camera || null;
  const blocks = blocksOf(rec.layout);
  const truth = arr(rec.truth).filter((e) => e && typeof e === 'object');
  // evaluation segments: places where we know where the tester was looking
  const lineCy = (bid, li) => { const b = blocks.find((q) => q.id === bid) || (isNum(bid) ? blocks[bid] : null); const l = b && b.lines[li]; return l ? (l.top + l.bottom) / 2 : NaN; };
  let segs = truth.filter((e) => e.kind === 'target' && isNum(e.x) && isNum(e.y)).map((e) => ({ kind: 'target', id: e.id, x: e.x, y: e.y, t0: isNum(e.tSettle) ? e.tSettle : e.tShow + 700, t1: e.tEnd, phase: e.phase || null })).filter((s) => isNum(s.t0) && isNum(s.t1) && s.t1 > s.t0);
  if (!segs.length) {
    segs = truth.filter((e) => e.kind === 'word' && isNum(e.t0) && isNum(e.t1)).map((e) => ({ kind: 'word', id: `${e.block}:${e.line}:${e.word}`, x: isNum(e.x) ? e.x : null, y: lineCy(e.block, e.line), t0: e.t0 + 200, t1: Math.max(e.t1, e.t0 + 260), phase: null })).filter((s) => isNum(s.y));
  }
  if (!segs.length) {
    segs = truth.filter((e) => e.kind === 'line' && isNum(e.t0) && isNum(e.t1)).map((e) => ({ kind: 'line', id: `${e.block}:${e.line}`, x: null, y: lineCy(e.block, e.line), t0: e.t0 + 300, t1: e.t1 - 100, phase: null })).filter((s) => isNum(s.y) && s.t1 > s.t0);
  }
  segs.sort((a, b) => a.t0 - b.t0);
  return { rec, raw, gaze, gazeIsRaw, dump, dumpSource, hasTrain: hasTrain(dump), pxPerCm, pxPerDeg, camera, blocks, truth, segs, env, phys };
}

/** Assign time-sorted samples to segments. Returns per-segment arrays. */
function bySegment(samples, segs) {
  const out = segs.map(() => []);
  let j = 0;
  const order = segs.map((s, i) => i);
  for (const smp of samples) {
    while (j < order.length && segs[order[j]].t1 < smp.t) j++;
    for (let k = j; k < order.length && segs[order[k]].t0 <= smp.t; k++) if (smp.t <= segs[order[k]].t1) { out[order[k]].push(smp); break; }
  }
  return out;
}
/** Means of consecutive n-sample windows (a stand-in for "one fixation"). */
function windowMeans(vals, n = 6) {
  const out = [];
  for (let i = 0; i + n <= vals.length; i += n) { let s = 0; for (let k = 0; k < n; k++) s += vals[i + k]; out.push(s / n); }
  if (!out.length && vals.length >= 3) out.push(mean(vals));
  return out;
}

// ------------------------------------------------------------------ 1. header
function header(P) {
  const { rec, env, phys, camera } = P;
  const cw = camera && (camera.width || camera.w), ch = camera && (camera.height || camera.h), cf = camera && camera.frameRate;
  const warn = [];
  if (!camera) warn.push('camera settings not recorded');
  else { if (isNum(cw) && isNum(ch) && (cw < 1280 || ch < 720)) warn.push(`camera resolution ${cw}x${ch} is under 1280x720`); if (isNum(cf) && cf < 20) warn.push(`camera frame rate ${cf.toFixed(1)} is under 20 fps`); }
  return { task: rec.task || 'unknown', label: rec.label || '', durationMs: rec.durationMs, startedAt: rec.startedAt, viewport: env.viewport || null, screen: env.screen || null, dpr: env.dpr, physical: phys, pxPerCm: P.pxPerCm, pxPerDeg: P.pxPerDeg, camera: camera ? { width: cw, height: ch, frameRate: cf } : null, warnings: warn, dumpSource: P.dumpSource, notes: rec.notes || '' };
}

// ------------------------------------------------------------------ 2. signal health
function health(P) {
  const raw = P.raw; if (raw.length < 3) return na('no raw camera frames in this recording');
  const dts = []; for (let i = 1; i < raw.length; i++) dts.push(raw[i].t - raw[i - 1].t);
  const dtMed = median(dts), face = raw.filter((e) => e.face !== false && e.head);
  let longestNoFace = 0, lastOk = raw[0].t;
  for (const e of raw) { if (e.face !== false && !e.blink) { longestNoFace = Math.max(longestNoFace, e.t - lastOk); lastOk = e.t; } }
  const out = { frames: raw.length, dtMedian: dtMed, dtP95: quantile(dts, 0.95), fps: 1000 / dtMed, faceLostPct: 100 * raw.filter((e) => e.face === false).length / raw.length, blinkPct: face.length ? 100 * face.filter((e) => e.blink).length / face.length : NaN, longestGapMs: Math.max(...dts), longestNoEyesMs: longestNoFace, reportedFps: median(raw.map((e) => e.fps).filter(isNum)) };
  const h0 = P.dump.calibHead;
  if (!h0 || !isNum(h0.cx) || !isNum(h0.s) || !face.length) { out.head = na(face.length ? 'no dump.calibHead to compare with' : 'no face frames'); return out; }
  const cam = P.camera || {}; const aspect = isNum(cam.width) && isNum(cam.height) && cam.width > 0 ? cam.height / cam.width : 9 / 16;
  const dist = isNum(P.phys.distanceCm) ? P.phys.distanceCm : 60;
  const part = (fr) => {
    const cx = mean(fr.map((e) => e.head.cx)), cy = mean(fr.map((e) => e.head.cy)), s = mean(fr.map((e) => e.head.s));
    return { dcx: cx - h0.cx, dcy: cy - h0.cy, sRatio: s / h0.s, cmX: (cx - h0.cx) * IPD_CM / s, cmY: (cy - h0.cy) * aspect * IPD_CM / s, cmZ: dist * (h0.s / s - 1) };
  };
  const n = face.length, k = Math.max(1, Math.floor(n / 10));
  const moved = face.filter((e) => Math.hypot(e.head.cx - h0.cx, e.head.cy - h0.cy) > 0.08 || Math.abs(e.head.s / h0.s - 1) > 0.15).length;
  out.head = { all: part(face), start: part(face.slice(0, k)), end: part(face.slice(n - k)), pausedPct: 100 * moved / n, assumption: `IPD ${IPD_CM} cm, frame aspect ${aspect.toFixed(2)}, calibration distance ${dist} cm` };
  const phases = P.truth.filter((e) => e.kind === 'phase' && isNum(e.t0) && isNum(e.t1));
  if (phases.length) out.head.phases = phases.map((p) => ({ name: p.name, ...part(face.filter((e) => e.t >= p.t0 && e.t <= p.t1)) })).filter((p) => isNum(p.dcx));
  return out;
}

// ------------------------------------------------------------------ 3. feature noise
const NOISE_FEATS = [[8, 'mean u'], [9, 'mean v'], [10, 'mean vl'], [11, 'opening']];
function noiseStats(groups, dtMed) {
  // groups: array of [{t, v}] per target
  const cent = [], all = []; let ss = 0, dof = 0, ss6 = 0, w6 = 0;
  for (const g of groups) {
    if (g.length < 12) continue;
    const m = mean(g.map((p) => p.v)); const c = g.map((p) => ({ t: p.t, r: p.v - m })); cent.push(c);
    for (const p of c) { ss += p.r * p.r; all.push(p.r); } dof += g.length - 1;
    const wm = windowMeans(c.map((p) => p.r), 6); for (const v of wm) ss6 += v * v; w6 += wm.length * (1 - 6 / g.length);
  }
  if (dof < 20) return null;
  const rho = [1]; for (let k = 1; k <= 5; k++) rho.push(pooledAutocorr(cent, k, dtMed));
  // Centring each target on its own mean biases every autocorrelation low by about c = var(mean)/var.
  // First-order correction with an AR(1) estimate of c; negligible for long windows (camera task).
  const nBar = all.length / cent.length;
  if (isNum(rho[1]) && rho[1] < 0.95) { const c = Math.min(0.5, (1 + rho[1]) / (1 - rho[1]) / nBar); for (let k = 1; k <= 5; k++) if (isNum(rho[k])) rho[k] += c * (1 - rho[k]); }
  const s = Math.sqrt(ss / dof), s6 = w6 > 0 ? Math.sqrt(ss6 / w6) : NaN;
  const neff = effectiveN(6, rho);
  return { sd: s, ac1: rho[1], ac5: rho[5], rho, neff6: neff, sd6: s6, neff6Direct: isNum(s6) && s6 > 0 ? (s * s) / (s6 * s6) : NaN, n: all.length, targets: cent.length };
}
function featureNoise(P, model) {
  const segs = P.segs.filter((s) => s.kind === 'target' && s.t1 - s.t0 >= 1000);
  if (!segs.length) return na('no target fixated for 1 s or more');
  const frames = P.raw.filter((e) => e.face !== false && !e.blink && Array.isArray(e.f));
  if (!frames.length) return na('no raw frames with features');
  const per = bySegment(frames, segs);
  const dts = []; for (let i = 1; i < P.raw.length; i++) dts.push(P.raw[i].t - P.raw[i - 1].t); const dtMed = median(dts);
  const out = { targets: segs.length, dtMed, features: [], px: null };
  for (const [idx, name] of NOISE_FEATS) {
    const st = noiseStats(per.map((fr) => fr.filter((e) => isNum(e.f[idx])).map((e) => ({ t: e.t, v: e.f[idx] }))), dtMed);
    out.features.push(st ? { idx, name, ...st } : { idx, name, na: 'too few frames' });
  }
  if (model) {
    const D = Math.max(...model.keep) + 1;
    const pr = per.map((fr) => fr.filter((e) => e.f.length >= D).map((e) => { const p = model.predict(e.f); return { t: e.t, x: p[0], y: p[1] }; }));
    const x = noiseStats(pr.map((g) => g.map((p) => ({ t: p.t, v: p.x }))), dtMed), y = noiseStats(pr.map((g) => g.map((p) => ({ t: p.t, v: p.y }))), dtMed);
    if (x && y) out.px = { x, y };
  }
  if (!out.px) out.pxNa = model ? 'frames do not match the model width' : 'no dump.model';
  return out;
}

// ------------------------------------------------------------------ 4/5. error statistics
/** per: per-segment arrays of {t, x, y} predictions. Everything in px. */
function errorStats(per, segs) {
  const ex = [], ey = [], wx = [], wy = [], tt = [], eu = []; const targets = [];
  per.forEach((g, i) => {
    const s = segs[i]; if (g.length < 3) return;
    const dx = s.x === null ? null : g.map((p) => p.x - s.x), dy = g.map((p) => p.y - s.y);
    if (dx) { ex.push(...dx); wx.push(...windowMeans(dx)); }
    ey.push(...dy); wy.push(...windowMeans(dy));
    g.forEach((p, k) => { tt.push(p.t); eu.push(Math.hypot(dx ? dx[k] : 0, dy[k])); });
    targets.push({ id: s.id, phase: s.phase, n: g.length, bx: dx ? mean(dx) : NaN, by: mean(dy), sx: dx ? sd(dx) : NaN, sy: sd(dy) });
  });
  if (!ey.length) return null;
  const accX = rms(targets.map((t) => t.bx).filter(isNum)), accY = rms(targets.map((t) => t.by)), precX = mean(targets.map((t) => t.sx).filter(isNum)), precY = mean(targets.map((t) => t.sy).filter(isNum));
  return { n: ey.length, nTargets: targets.length, rmsX: rms(ex), rmsY: rms(ey), maeX: mae(ex), maeY: mae(ey), fixX: rms(wx), fixY: rms(wy), biasX: mean(ex), biasY: mean(ey), accX, accY, precX, precY, formulaEffX: Math.sqrt(accX ** 2 + precX ** 2 / 6), formulaEffY: Math.sqrt(accY ** 2 + precY ** 2 / 6), targets, _t: tt, _e: eu };
}
function accuracy(P) {
  if (!P.segs.length) return na('no truth targets, words or lines in this recording');
  if (!P.gaze.length) return na('no gaze events in this recording (the tracker was not producing output)');
  const per = bySegment(P.gaze, P.segs); const all = errorStats(per, P.segs);
  if (!all) return na('no gaze events fall inside the truth windows');
  const out = { kind: P.segs[0].kind, source: P.gazeIsRaw ? 'gaze rawX/rawY' : 'gaze x/y (filtered; rawX missing)', ...all };
  const t = all._t, e = all._e; const t0 = Math.min(...t), span = Math.max(...t) - t0 || 1;
  out.medFirstThird = median(e.filter((_, i) => t[i] < t0 + span / 3)); out.medLastThird = median(e.filter((_, i) => t[i] > t0 + 2 * span / 3));
  delete out._t; delete out._e;
  out.worst = [...all.targets].sort((a, b) => Math.hypot(b.bx || 0, b.by) - Math.hypot(a.bx || 0, a.by))[0];
  const phases = [...new Set(P.segs.map((s) => s.phase).filter(Boolean))];
  if (phases.length) out.phases = phases.map((ph) => { const idx = P.segs.map((s, i) => (s.phase === ph ? i : -1)).filter((i) => i >= 0); const st = errorStats(idx.map((i) => per[i]), idx.map((i) => P.segs[i])); if (st) { delete st._t; delete st._e; delete st.targets; } return { name: ph, ...(st || { na: 'no gaze' }) }; });
  const acc = P.dump.accuracy;
  if (acc && isNum(acc.effX) && isNum(acc.effY)) out.claim = { effX: acc.effX, effY: acc.effY, accuracyX: acc.accuracyX, accuracyY: acc.accuracyY, precisionX: acc.precisionX, precisionY: acc.precisionY, factorX: all.fixX / Math.max(acc.effX, 1e-9), factorY: all.fixY / Math.max(acc.effY, 1e-9) };
  else out.claim = na('no dump.accuracy');
  return out;
}

// ------------------------------------------------------------------ 5. model alternatives
function matrixLayout(X) {
  // Is f[25..40] a column-major rigid transform with the translation in 12..14 (or its transpose)?
  const rows = X.filter((r) => r.length >= 41); if (rows.length < 10) return null;
  const med = (i) => median(rows.map((r) => r[25 + i]));
  const M = Array.from({ length: 16 }, (_, i) => med(i));
  const ok = (m) => Math.abs(m[15] - 1) < 0.05 && Math.abs(m[3]) + Math.abs(m[7]) + Math.abs(m[11]) < 0.05 && Math.abs(m[14]) > 5 &&
    [0, 4, 8].every((c) => { const n = Math.hypot(m[c], m[c + 1], m[c + 2]); return n > 0.5 && n < 2; });
  if (ok(M)) return 'col';
  const T = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15].map((i) => M[i]);
  return ok(T) ? 'row' : null;
}
function poseOf(f, layout) {
  let m = f.slice(25, 41);
  if (layout === 'row') m = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15].map((i) => m[i]);
  const n = Math.hypot(m[8], m[9], m[10]) || 1, tz = Math.abs(m[14]) || 1;
  return [Math.atan2(m[8], Math.abs(m[10])), Math.asin(clamp(-m[9] / n, -1, 1)), Math.atan2(m[1], Math.abs(m[5])), m[12] / tz, m[13] / tz, Math.log(tz)];
}
function trimTrain(model, X, Y, G) {
  const byG = new Map();
  X.forEach((r, i) => { const p = model.predict(r); if (!byG.has(G[i])) byG.set(G[i], []); byG.get(G[i]).push({ i, rx: p[0] - Y[i][0], ry: p[1] - Y[i][1] }); });
  const keep = new Array(X.length).fill(true);
  for (const g of byG.values()) {
    for (const k of ['rx', 'ry']) {
      const m = median(g.map((q) => q[k])), madv = 1.4826 * median(g.map((q) => Math.abs(q[k] - m)));
      for (const q of g) if (Math.abs(q[k] - m) > 2.5 * madv) keep[q.i] = false;
    }
  }
  return keep;
}
function modelAlternatives(P) {
  const d = P.dump;
  if (!P.hasTrain) return na('no dump.train in this recording or in an earlier one (use --cal <file>)');
  if (!P.segs.length) return na('no truth targets, words or lines to test against');
  const X0 = d.train.X, Y = d.train.Y, G0 = Array.isArray(d.train.G) && d.train.G.length === X0.length ? d.train.G : null;
  const D = X0[0].length;
  if (X0.some((r) => !Array.isArray(r) || r.length !== D)) return na('dump.train.X rows have inconsistent widths');
  const frames = P.raw.filter((e) => e.face !== false && !e.blink && Array.isArray(e.f) && e.f.length === D);
  if (!frames.length) return na(`no raw frames with a ${D}-number feature vector (train width ${D})`);
  const per = bySegment(frames, P.segs);
  const notes = [`train ${X0.length} frames x ${D} features, ${G0 ? new Set(G0).size : '?'} dots (from ${P.dumpSource}); test ${per.reduce((a, g) => a + g.length, 0)} raw frames on ${P.segs.length} ${P.segs[0].kind} windows`];
  const G = G0 || X0.map((_, i) => Math.floor(i * 5 / X0.length));
  const sub = (lo, hi) => (f) => f.slice(lo, hi);
  const variants = [];
  const evalModel = (name, model, map, extra = {}) => {
    const pr = per.map((g) => g.map((e) => { const p = model.predict(map ? map(e.f) : e.f); return { t: e.t, x: p[0], y: p[1] }; }));
    const st = errorStats(pr, P.segs); if (!st) return;
    const v = { name, lambda: model.lambda, cvErr: model.cvErr, nTrain: model.n, rmsX: st.rmsX, rmsY: st.rmsY, fixX: st.fixX, fixY: st.fixY, biasX: st.biasX, biasY: st.biasY, ...extra };
    // offset-corrected: learn a constant offset on the first windows, score on the rest only
    const nOff = P.segs[0].kind === 'target' ? 2 : Math.max(2, Math.ceil(P.segs.length * 0.1));
    if (P.segs.length >= nOff + 2) {
      const first = pr.slice(0, nOff).flatMap((g, i) => g.map((p) => ({ dx: P.segs[i].x === null ? 0 : p.x - P.segs[i].x, dy: p.y - P.segs[i].y })));
      if (first.length >= 6) {
        const ox = mean(first.map((q) => q.dx)), oy = mean(first.map((q) => q.dy));
        const rest = errorStats(pr.slice(nOff), P.segs.slice(nOff)), corr = errorStats(pr.slice(nOff).map((g) => g.map((p) => ({ t: p.t, x: p.x - ox, y: p.y - oy }))), P.segs.slice(nOff));
        if (rest && corr) v.offset = { nOff, ox, oy, restFixX: rest.fixX, restFixY: rest.fixY, corrFixX: corr.fixX, corrFixY: corr.fixY };
      }
    }
    const phases = [...new Set(P.segs.map((s) => s.phase).filter(Boolean))];
    if (phases.length) v.phases = Object.fromEntries(phases.map((ph) => { const idx = P.segs.map((s, i) => (s.phase === ph ? i : -1)).filter((i) => i >= 0); const s2 = errorStats(idx.map((i) => pr[i]), idx.map((i) => P.segs[i])); return [ph, s2 ? { fixX: s2.fixX, fixY: s2.fixY } : null]; }));
    v._model = model; v._map = map || null;
    variants.push(v);
  };
  const fit = (map, rows) => { const idx = rows || X0.map((_, i) => i); return new C.Ridge().fit(idx.map((i) => (map ? map(X0[i]) : X0[i])), idx.map((i) => Y[i]), idx.map((i) => G[i])); };
  const safe = (name, fn) => { try { fn(); } catch (e) { notes.push(`${name}: failed (${e.message})`); } };

  if (d.model && Array.isArray(d.model.keep) && Math.max(...d.model.keep) < D) safe('a', () => evalModel('a shipped (as trained)', C.Ridge.fromJSON(d.model), null));
  else notes.push('a shipped: not available (no usable dump.model)');
  const bases = [['b refit 44', null]];
  if (D !== 44) { bases[0][0] = `b refit ${D}`; notes.push(`feature vector has ${D} numbers, not 44: eye-only / blendshape / pose variants skipped`); }
  else {
    bases.push(['c eye-only 0-16', sub(0, 17)], ['d eye+blend 0-24', sub(0, 25)]);
    const lay = matrixLayout(X0);
    if (lay) { bases.push(['e eye+pose6', (f) => f.slice(0, 17).concat(poseOf(f, lay))]); if (lay === 'row') notes.push('matrix looked row-major: transposed before deriving pose'); }
    else notes.push('e eye+pose: skipped, f[25..40] does not look like a rigid 4x4 transform with translation in cm');
  }
  // dot timing: train rows carry no timestamps; rows of one dot are in arrival order over the sample window
  const sampleMs = (P.rec.params && isNum(P.rec.params.sampleMs) && P.rec.params.sampleMs) || 1000;
  const runs = new Map(); G.forEach((g, i) => { if (!runs.has(g)) runs.set(g, []); runs.get(g).push(i); });
  const canDrop = G0 && [...runs.values()].every((r) => r.length >= 8);
  const late = canDrop ? [...runs.values()].flatMap((r) => r.slice(Math.ceil(r.length * 300 / sampleMs))) : null;
  if (!canDrop) notes.push('g drop-first-300ms: skipped, dot timing cannot be inferred (no group ids or too few frames per dot)');
  else notes.push(`g assumes each dot was sampled for ${sampleMs} ms at an even frame rate (train rows have no timestamps): drops the first ${Math.round(30000 / sampleMs)}% of each dot`);
  for (const [name, map] of bases) {
    let base = null;
    safe(name, () => { base = fit(map); evalModel(name, base, map); });
    if (!base || !/^[bc]/.test(name)) continue;
    safe(name + ' trim', () => { const keep = trimTrain(base, map ? X0.map(map) : X0, Y, G); const rows = keep.map((k, i) => (k ? i : -1)).filter((i) => i >= 0); evalModel(`f ${name.slice(2)} +trim`, fit(map, rows), map, { kept: rows.length / X0.length }); });
    if (late) safe(name + ' drop300', () => evalModel(`g ${name.slice(2)} -300ms`, fit(map, late), map, { kept: late.length / X0.length }));
  }
  if (!variants.length) return { na: 'no model variant could be evaluated', notes };
  const best = variants.reduce((a, b) => (b.fixY < a.fixY ? b : a));
  const shipped = variants.find((v) => v.name.startsWith('a '));
  const out = { kind: P.segs[0].kind, yOnly: P.segs[0].x === null, variants, best: best.name, criterion: 'lowest fixation-level RMS y', notes };
  if (shipped) out.gainY = 1 - best.fixY / shipped.fixY;
  const phases = [...new Set(P.segs.map((s) => s.phase).filter(Boolean))];
  if (phases.length) out.bestPerPhase = Object.fromEntries(phases.map((ph) => [ph, variants.filter((v) => v.phases && v.phases[ph]).reduce((a, b) => (!a || b.phases[ph].fixY < a.phases[ph].fixY ? b : a), null)?.name]));
  return out;
}

// ------------------------------------------------------------------ 6. line decoding
function lineDecoding(P, alt) {
  const blocks = P.blocks; const tl = P.truth.filter((e) => e.kind === 'line' && isNum(e.t0) && isNum(e.t1));
  if (!blocks.length) return na('no layout.blocks with lines in this recording');
  if (!tl.length) return na('no truth line entries in this recording');
  const flat = [], flatIdx = new Map();
  blocks.forEach((b, bi) => b.lines.forEach((l, li) => { flatIdx.set(bi + ':' + li, flat.length); flat.push(l); }));
  const bIndex = (id) => { const i = blocks.findIndex((b) => b.id === id); return i >= 0 ? i : (isNum(id) && blocks[id] ? id : -1); };
  const tLines = tl.map((e) => ({ t0: e.t0, t1: e.t1, b: bIndex(e.block), line: e.line })).filter((e) => flatIdx.has(e.b + ':' + e.line)).map((e) => ({ ...e, fi: flatIdx.get(e.b + ':' + e.line) }));
  if (!tLines.length) return na('truth lines do not match layout block ids');
  const AP = accParams(P.dump.accuracy); const bl = P.dump.baseline || {};
  const wpm = isNum(bl.wpm) ? bl.wpm : 150; const tau = isNum(P.dump.tau) ? P.dump.tau : (isNum(bl.tau) ? bl.tau : C.TAU_DEFAULT);
  const totalW = flat.reduce((a, l) => a + (l.right - l.left), 0), totalWords = blocks.reduce((a, b) => a + b.words, 0);
  const msPerPx = (60000 / wpm) * totalWords / Math.max(1, totalW);
  const pitch = median(blocks.map((b) => b.pitch));
  const trueDwell = new Float64Array(flat.length); for (const e of tLines) trueDwell[e.fi] += e.t1 - e.t0;
  const phases = P.truth.filter((e) => e.kind === 'phase' && isNum(e.t0));
  const inPhase = (t, name) => phases.some((p) => p.name === name && t >= p.t0 && t <= p.t1 + 2500);
  const bucket = (trig) => { const st = { stall: [], reread: [], outside: [] }; for (const g of trig) (inPhase(g.t, 'stall') ? st.stall : inPhase(g.t, 'reread') ? st.reread : st.outside).push(g.reason || 'unknown'); return st; };

  const runStream = (samples) => {
    const fixes = detectFixations(samples, AP.dispersion);
    for (const f of fixes) {   // truth line = the one overlapping most of the fixation
      let best = null, bo = 0;
      for (const e of tLines) { const o = Math.min(e.t1, f.t + f.dur) - Math.max(e.t0, f.t); if (o > bo) { bo = o; best = e; } }
      f.truth = best && bo >= 0.5 * f.dur ? best : null;
    }
    const tf = fixes.filter((f) => f.truth); if (tf.length < 3) return null;
    const cyOf = (e) => (flat[e.fi].top + flat[e.fi].bottom) / 2;
    const dys = tf.map((f) => f.y - cyOf(f.truth)); const off = median(dys);
    const fdy = bySegment(samples, tLines.map((e) => ({ t0: e.t0 + 300, t1: e.t1 }))).flatMap((g, i) => g.map((s) => s.y - cyOf(tLines[i])));
    const score = (shift) => {
      const fx = shift ? fixes.map((f) => ({ ...f, y: f.y - shift })) : fixes;
      const near = decodeNearest(fx, flat), rp = replayShipped(fx, blocks, { sx: AP.sx, sy: AP.sy, wpm, baselineWpm: isNum(bl.wpm) ? bl.wpm : null, tau, regressionRate: bl.regressionRate || 0 });
      const hmm = rp.dec.map((d) => (d ? flatIdx.get(d.b + ':' + d.line) : -1)), prog = decodeProg(fx, flat, AP.sx, AP.sy, { msPerPx });
      let tot = 0, a = 0, h = 0, h1 = 0, p = 0;
      fixes.forEach((f, i) => {
        if (!f.truth) return; const w = f.dur; tot += w; const T = f.truth.fi;
        if (near[i] === T) a += w; if (hmm[i] === T) h += w; if (prog[i] === T) p += w;
        const d = rp.dec[i]; if (d && d.b === f.truth.b && Math.abs(d.line - f.truth.line) <= 1) h1 += w;
      });
      const dwellErr = (dec) => { const c = new Float64Array(flat.length); let prevEnd = 0; fixes.forEach((f, i) => { const end = f.t + f.dur; const dw = prevEnd && end - prevEnd < 1200 ? end - prevEnd : f.dur; prevEnd = end; if (dec[i] >= 0) c[dec[i]] += dw; }); let e = 0, T = 0; for (let j = 0; j < flat.length; j++) { e += Math.abs(c[j] - trueDwell[j]); T += trueDwell[j]; } return T > 0 ? e / T : NaN; };
      return { nearest: a / tot, hmm: h / tot, hmmWithin1: h1 / tot, progress: p / tot, dwellErrHmm: dwellErr(hmm), dwellErrProgress: dwellErr(prog), dwellErrNearest: dwellErr(near), triggers: rp.triggers };
    };
    const raw = score(0), corr = score(off);
    const st = bucket(raw.triggers);
    delete raw.triggers; delete corr.triggers;
    return { fixations: fixes.length, onTruth: tf.length, fixTimeOnTruthMs: tf.reduce((s, f) => s + f.dur, 0), raw, offsetRemoved: corr, medianOffsetY: off, biasY: mean(dys), sigmaY: sd(dys), rmsY: rms(dys), sigmaOverPitch: sd(dys) / pitch, rmsOverPitch: rms(dys) / pitch, frameSigmaY: sd(fdy), struggle: st };
  };

  const out = { pitch, lines: flat.length, sx: AP.sx, sy: AP.sy, dispersion: AP.dispersion, accFromDump: AP.fromDump, tau, wpm, msPerPx, shipped: null, alt: null };
  out.shipped = P.gaze.length ? (runStream(P.gaze) || na('too few fixations on truth lines')) : na('no gaze events');
  if (alt && alt._model) {
    // raw frames through the alternative model, with the same head-moved pause as processFrame
    const h0 = P.dump.calibHead; let since = 0, drifted = false; const smp = []; const D = (P.dump.train.X[0] || []).length;
    for (const e of P.raw) {
      if (e.face === false || !Array.isArray(e.f) || e.f.length !== D) continue;
      if (h0 && e.head && isNum(h0.s)) {
        const moved = Math.hypot(e.head.cx - h0.cx, e.head.cy - h0.cy) > 0.08 || Math.abs(e.head.s / h0.s - 1) > 0.15;
        if (moved) { if (!since) since = e.t; if (e.t - since > 600) drifted = true; } else { since = 0; drifted = false; }
      }
      if (drifted || e.blink) continue;
      const p = alt._model.predict(alt._map ? alt._map(e.f) : e.f); smp.push({ t: e.t, x: p[0], y: p[1] });
    }
    out.altName = alt.name; out.alt = smp.length ? (runStream(smp) || na('too few fixations on truth lines')) : na('no usable raw frames');
  } else out.alt = na('no model alternative available (needs dump.train)');
  if (phases.length) {
    const live = arr(P.rec.events).filter((e) => e && e.k === 'struggle' && isNum(e.t));
    out.liveStruggle = bucket(live);
    out.hasStallPhases = { stall: phases.some((p) => p.name === 'stall'), reread: phases.some((p) => p.name === 'reread') };
  }
  return out;
}

// ------------------------------------------------------------------ entry point
export function analyze(rec, { cal = null, name = '' } = {}) {
  const R = { file: name, ok: true };
  if (!rec || typeof rec !== 'object') return { file: name, ok: false, error: 'not a recording object' };
  const P = prep(rec, cal);
  const section = (key, fn) => { try { R[key] = fn(); } catch (e) { R[key] = na(`analysis failed: ${e.message}`); } };
  section('header', () => header(P));
  section('health', () => health(P));
  let shipped = null; try { if (P.dump.model && Array.isArray(P.dump.model.keep) && Array.isArray(P.dump.model.wx)) shipped = C.Ridge.fromJSON(P.dump.model); } catch { shipped = null; }
  section('noise', () => featureNoise(P, shipped));
  section('accuracy', () => accuracy(P));
  section('models', () => modelAlternatives(P));
  const bestV = R.models && R.models.variants ? R.models.variants.find((v) => v.name === R.models.best) : null;
  section('lines', () => lineDecoding(P, bestV));
  if (R.models && R.models.variants) for (const v of R.models.variants) { delete v._model; delete v._map; }
  R.dumpInfo = P.dump && (P.dump.model || P.dump.train) ? { source: P.dumpSource, nTrain: P.hasTrain ? P.dump.train.X.length : 0, lambda: P.dump.model && P.dump.model.lambda, cvErr: P.dump.model && P.dump.model.cvErr, accuracy: P.dump.accuracy || null, tau: P.dump.tau, baselineWpm: P.dump.baseline && P.dump.baseline.wpm } : null;
  R.pxPerDeg = P.pxPerDeg;
  return R;
}
