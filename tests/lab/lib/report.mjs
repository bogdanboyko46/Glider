// Plain-text rendering of analyze() results (about 70 lines per recording) and the --compare table.
import { isNum, f0, f1, f2, f3, f4, pct } from './util.mjs';

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const sgn = (v, d = 0) => (isNum(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) : 'n/a');

export function soWhat(R) {
  const out = []; const ppd = R.pxPerDeg; const deg = (px) => (isNum(ppd) && isNum(px) ? ` (${(px / ppd).toFixed(2)} deg)` : '');
  const A = R.accuracy, M = R.models, L = R.lines, N = R.noise;
  if (A && !A.na) {
    out.push(`Vertical error of the shipped tracker: ${f0(A.fixY)} px${deg(A.fixY)} per fixation, ${f0(A.rmsY)} px${deg(A.rmsY)} per frame; mean vertical offset ${sgn(A.biasY)} px.`);
    if (A.claim && !A.claim.na) out.push(`The tracker claimed +/-${f0(A.claim.effY)} px vertically; measured is ${f2(A.claim.factorY)}x that${isNum(A.claim.factorX) ? ' (horizontal ' + f2(A.claim.factorX) + 'x)' : ''}.`);
  } else out.push(`Vertical error: not available (${A ? A.na : 'no accuracy section'}).`);
  if (L && !L.na && L.shipped && !L.shipped.na) {
    const s = L.shipped;
    out.push(`sigma_y / pitch = ${f2(s.sigmaOverPitch)} (sd ${f0(s.sigmaY)} px, bias ${sgn(s.biasY)} px, pitch ${f0(L.pitch)} px); shipped HMM right ${pct(s.raw.hmm)} of fixation time, nearest-line ${pct(s.raw.nearest)}, progress decoder ${pct(s.raw.progress)}.`);
  }
  if (M && !M.na) {
    const b = M.variants.find((v) => v.name === M.best);
    out.push(`Best model variant: ${M.best}, fixation RMS y ${f0(b.fixY)} px${deg(b.fixY)}` + (isNum(M.gainY) ? `, ${M.gainY >= 0.05 ? (100 * M.gainY).toFixed(0) + '% better than shipped' : M.gainY > 0.005 ? (100 * M.gainY).toFixed(0) + '% better than shipped, which is within noise' : 'no gain over shipped'}` : '') + ' (picked on this same recording: confirm on a second one).');
  } else out.push(`Best model variant: not available (${M ? M.na : 'no model section'}).`);
  if (N && !N.na && N.px) out.push(`A 6-frame fixation holds ${f1(N.px.y.neff6)} independent frames vertically (${f1(N.px.x.neff6)} horizontally), not 6: averaging cuts frame noise by ${f2(Math.sqrt(N.px.y.neff6))}x, not 2.45x.`);
  return out.slice(0, 6);
}

export function render(R) {
  const o = []; const p = (s) => o.push(s);
  if (!R.ok) { p(`== ${R.file}: ${R.error}`); return o.join('\n'); }
  const H = R.header, ppd = R.pxPerDeg; const deg = (px) => (isNum(ppd) && isNum(px) ? (px / ppd).toFixed(2) : 'n/a');
  // 1 ---- header
  p(`== Gaze Lab: ${H.task}${H.label ? ' "' + H.label + '"' : ''}   [${R.file}]`);
  const vp = H.viewport ? `${H.viewport.w}x${H.viewport.h}` : 'n/a', sc = H.screen ? `${H.screen.w}x${H.screen.h}` : 'n/a', ph = H.physical || {};
  p(`duration ${isNum(H.durationMs) ? (H.durationMs / 1000).toFixed(1) + ' s' : 'n/a'} | viewport ${vp} | screen ${sc}, ${ph.screenDiagIn ?? 'n/a'} in at ${ph.distanceCm ?? 'n/a'} cm | glasses ${ph.glasses ?? 'n/a'} | lighting ${ph.lighting ?? 'n/a'}`);
  p(`scale ${f1(H.pxPerCm)} px/cm, ${f1(ppd)} px/deg | camera ${H.camera ? `${H.camera.width ?? '?'}x${H.camera.height ?? '?'} @ ${isNum(H.camera.frameRate) ? H.camera.frameRate.toFixed(0) : '?'} fps` : 'not available'}`);
  const di = R.dumpInfo;
  p(di ? `calibration: from ${di.source || 'this recording (no train set)'}, ${di.nTrain} train frames, lambda ${di.lambda ?? 'n/a'}, cvErr ${f0(di.cvErr)} px, tau ${f2(di.tau)}, baseline ${f0(di.baselineWpm)} wpm` : 'calibration: not available (no dump here and no earlier recording with one; pass --cal <file>)');
  for (const w of H.warnings) p(`WARNING: ${w}`);
  // 2 ---- signal
  const S = R.health;
  if (S.na) p(`-- Signal health: not available (${S.na})`);
  else {
    p('-- Signal health');
    p(`frames ${S.frames}, ${f1(S.fps)} fps effective (median interval ${f1(S.dtMedian)} ms, p95 ${f1(S.dtP95)} ms), face lost ${f1(S.faceLostPct)}%, blink ${f1(S.blinkPct)}%`);
    p(`longest frame gap ${f0(S.longestGapMs)} ms, longest stretch without usable eyes ${f0(S.longestNoEyesMs)} ms`);
    if (S.head.na) p(`head drift: not available (${S.head.na})`);
    else {
      const row = (n, h) => `  ${pad(n, 11)} dx ${sgn(h.dcx, 3)} dy ${sgn(h.dcy, 3)} scale x${f3(h.sRatio)}  ~ ${sgn(h.cmX, 1)} cm sideways, ${sgn(h.cmY, 1)} cm down, ${sgn(h.cmZ, 1)} cm back`;
      p(`head vs calibration (frame fractions; cm assume ${S.head.assumption}); tracker would pause on ${f1(S.head.pausedPct)}% of frames`);
      if (S.head.phases && S.head.phases.length) for (const q of S.head.phases) p(row(q.name, q));
      else { p(row('whole run', S.head.all)); p(row('first 10%', S.head.start)); p(row('last 10%', S.head.end)); }
    }
  }
  // 3 ---- noise
  const N = R.noise;
  if (N && !N.na) {
    p(`-- FEATURE NOISE within a fixated target (${N.targets} target(s) of 1 s or more)   <-- the number the audits lacked`);
    p('  signal        per-frame sd   lag-1  lag-5   independent frames in a 6-frame fixation');
    for (const f of N.features) p(f.na ? `  f[${f.idx}] ${pad(f.name, 8)} not available (${f.na})` : `  f[${lpad(f.idx, 2)}] ${pad(f.name, 8)} ${lpad(f4(f.sd), 9)}   ${lpad(f2(f.ac1), 5)}  ${lpad(f2(f.ac5), 5)}   ${f1(f.neff6)} (direct ${f1(f.neff6Direct)})   n=${f.n}`);
    if (N.px) for (const k of ['x', 'y']) { const q = N.px[k]; p(`  screen ${k}      ${lpad(f1(q.sd), 6)} px   ${lpad(f2(q.ac1), 5)}  ${lpad(f2(q.ac5), 5)}   ${f1(q.neff6)} (direct ${f1(q.neff6Direct)})   => fixation sd ${f1(q.sd / Math.sqrt(q.neff6))} px; tracker assumes ${f1(q.sd / Math.sqrt(6))}`); }
    else p(`  screen px: not available (${N.pxNa})`);
  } else if (N && ['camera', 'validate', 'headshift'].includes(H.task)) p(`-- Feature noise: not available (${N.na})`);
  // 4 ---- accuracy
  const A = R.accuracy;
  if (A && !A.na) {
    p(`-- Accuracy of the shipped tracker (${A.source}; ${A.nTargets} ${A.kind} windows, ${A.n} frames)`);
    p(`  RMS per frame     x ${f0(A.rmsX)} px (${deg(A.rmsX)} deg)   y ${f0(A.rmsY)} px (${deg(A.rmsY)} deg)   | mean abs x ${f0(A.maeX)} px (${deg(A.maeX)} deg)  y ${f0(A.maeY)} px (${deg(A.maeY)} deg)`);
    p(`  RMS per fixation  x ${f0(A.fixX)} px (${deg(A.fixX)} deg)   y ${f0(A.fixY)} px (${deg(A.fixY)} deg)   (means of 6 consecutive frames)`);
    p(`  mean offset x ${sgn(A.biasX)} y ${sgn(A.biasY)} px | bias across targets x ${f0(A.accX)} y ${f0(A.accY)} | scatter within target x ${f0(A.precX)} y ${f0(A.precY)} | median error first third ${f0(A.medFirstThird)} px, last third ${f0(A.medLastThird)} px`);
    if (A.kind === 'target') {
      const T = A.targets.length > 13 ? [...A.targets].sort((a, b) => Math.hypot(b.bx, b.by) - Math.hypot(a.bx, a.by)).slice(0, 5) : A.targets;
      p(`  per target${A.targets.length > 13 ? ' (worst 5 of ' + A.targets.length + ')' : ''}: id  bias x,y  /  sd x,y  (px)`);
      for (let i = 0; i < T.length; i += 3) p('   ' + T.slice(i, i + 3).map((t) => pad(`${t.id} ${sgn(t.bx)},${sgn(t.by)} / ${f0(t.sx)},${f0(t.sy)}`, 34)).join(''));
    }
    if (A.worst) p(`  worst: ${A.worst.id} bias x ${sgn(A.worst.bx)} y ${sgn(A.worst.by)} px`);
    if (A.phases) for (const q of A.phases) p(q.na ? `  phase ${pad(q.name, 10)} not available` : `  phase ${pad(q.name, 10)} fixation RMS x ${lpad(f0(q.fixX), 4)} y ${lpad(f0(q.fixY), 4)} px | mean offset x ${lpad(sgn(q.biasX), 5)} y ${lpad(sgn(q.biasY), 5)} px`);
    const c = A.claim;
    if (c.na) p(`  tracker's own claim: not available (${c.na})`);
    else p(`  tracker claimed effX ${f0(c.effX)} effY ${f0(c.effY)} px; measured per fixation ${f0(A.fixX)} / ${f0(A.fixY)} => claim is off by x${f2(c.factorX)} (x) and x${f2(c.factorY)} (y); its own formula on this data gives ${f0(A.formulaEffX)} / ${f0(A.formulaEffY)}`);
  } else if (A && !['calibrate', 'dump'].includes(H.task)) p(`-- Accuracy: not available (${A.na})`);
  // 5 ---- model alternatives
  const M = R.models;
  if (M && !M.na) {
    const phs = M.bestPerPhase ? Object.keys(M.bestPerPhase) : [];
    p(`-- Model alternatives: refit on dump.train only, tested on this recording's raw frames (px; * = best fixation y${M.yOnly ? '; x not available: line truth only' : ''})`);
    p(`  ${pad('variant', 26)} ${lpad('fix x', 6)} ${lpad('fix y', 6)} ${lpad('frm x', 6)} ${lpad('frm y', 6)} ${lpad('lambda', 6)} ${lpad('kept', 5)}  ${phs.length ? phs.map((q) => lpad(q.slice(0, 9), 9)).join(' ') + ' (fix y)' : 'after offset fix: rest y -> y'}`);
    for (const v of M.variants) {
      const tail = phs.length ? phs.map((q) => lpad((v.phases && v.phases[q] ? f0(v.phases[q].fixY) : 'n/a') + (M.bestPerPhase[q] === v.name ? '*' : ' '), 9)).join(' ') : (v.offset ? `${f0(v.offset.restFixY)} -> ${f0(v.offset.corrFixY)}` : 'n/a');
      p(`${v.name === M.best ? ' *' : '  '}${pad(v.name, 26)} ${lpad(f0(v.fixX), 6)} ${lpad(f0(v.fixY), 6)} ${lpad(f0(v.rmsX), 6)} ${lpad(f0(v.rmsY), 6)} ${lpad(v.lambda ?? '', 6)} ${lpad(isNum(v.kept) ? (100 * v.kept).toFixed(0) + '%' : '', 5)}  ${tail}`);
    }
    if (phs.length) { const b = M.variants.find((v) => v.name === M.best); if (b.offset) p(`  offset fix (${M.best}): fixation y on targets after the first ${b.offset.nOff}: ${f0(b.offset.restFixY)} -> ${f0(b.offset.corrFixY)} px`); }
    for (const n of M.notes) p(`  note: ${n}`);
  } else if (M && !['calibrate', 'dump'].includes(H.task)) p(`-- Model alternatives: not available (${M.na})`);
  // 6 ---- lines
  const L = R.lines;
  if (L && !L.na) {
    p(`-- Line decoding: ${L.lines} lines, pitch ${f0(L.pitch)} px; replay with sx ${f0(L.sx)} sy ${f0(L.sy)} dispersion ${f0(L.dispersion)}${L.accFromDump ? '' : ' (DEFAULTS: no dump.accuracy)'}; % of fixation time on a truth line`);
    const cols = [['shipped gaze', L.shipped, 'raw'], ['  -median dy', L.shipped, 'offsetRemoved'], [`alt: ${(L.altName || 'n/a').slice(0, 14)}`, L.alt, 'raw'], ['  -median dy', L.alt, 'offsetRemoved']];
    p(`  ${pad('', 22)}` + cols.map((c) => lpad(c[0], 20)).join(''));
    const cell = (c, k) => lpad(c[1] && !c[1].na ? pct(c[1][c[2]][k]) : 'n/a', 20);
    for (const [k, name] of [['nearest', 'nearest line'], ['hmm', 'shipped LineHMM'], ['hmmWithin1', 'LineHMM within 1 line'], ['progress', 'progress decoder'], ['dwellErrHmm', 'dwell err LineHMM'], ['dwellErrProgress', 'dwell err progress']]) p(`  ${pad(name, 22)}` + cols.map((c) => cell(c, k)).join(''));
    for (const [nm, s] of [['shipped gaze', L.shipped], ['alt model', L.alt]]) {
      if (!s || s.na) { p(`  ${nm}: not available (${s ? s.na : 'n/a'})`); continue; }
      p(`  ${pad(nm, 12)} sigma_y/pitch ${f2(s.sigmaOverPitch)} (fixation sd ${f0(s.sigmaY)} px, frame sd ${f0(s.frameSigmaY)} px) | vertical bias ${sgn(s.biasY)} px (median ${sgn(s.medianOffsetY)}) | total RMS/pitch ${f2(s.rmsOverPitch)} | ${s.onTruth}/${s.fixations} fixations on truth`);
    }
    if (L.hasStallPhases) {
      const fired = (has, a, what) => (has ? (a.length ? 'FIRED x' + a.length + ' (' + [...new Set(a)].join(',') + ')' : 'did not fire') : 'no ' + what + ' phase');
      const row = (nm, s) => `  struggle ${pad(nm, 14)} stall: ${fired(L.hasStallPhases.stall, s.stall, 'stall')} | reread: ${fired(L.hasStallPhases.reread, s.reread, 'reread')} | outside both: ${s.outside.length}${s.outside.length ? ' (' + [...new Set(s.outside)].join(',') + ')' : ''}`;
      if (L.shipped && !L.shipped.na) p(row('replay shipped', L.shipped.struggle));
      if (L.alt && !L.alt.na) p(row('replay alt', L.alt.struggle));
      p(row('live events', L.liveStruggle) + `   (tau ${f2(L.tau)}, ${f0(L.wpm)} wpm; a trigger up to 2.5 s after a phase counts as inside it)`);
    }
  } else if (L && ['lines-paced', 'lines-self', 'stall'].includes(H.task)) p(`-- Line decoding: not available (${L.na})`);
  // 7 ---- so what
  p('-- So what');
  for (const s of soWhat(R)) p('  ' + s);
  return o.join('\n');
}

/** Headline numbers used by --compare. */
export function headline(R) {
  const A = R.accuracy && !R.accuracy.na ? R.accuracy : {}, L = R.lines && !R.lines.na && R.lines.shipped && !R.lines.shipped.na ? R.lines.shipped : null, ppd = R.pxPerDeg;
  const N = R.noise && !R.noise.na && R.noise.px ? R.noise.px : null, M = R.models && !R.models.na ? R.models : null;
  const d = (v) => (isNum(v) && isNum(ppd) ? v / ppd : NaN);
  const rows = [
    ['task', R.header ? R.header.task : 'n/a', 's'], ['effective fps', R.health && !R.health.na ? R.health.fps : NaN, 1],
    ['frame RMS x px', A.rmsX, 0], ['frame RMS y px', A.rmsY, 0], ['fixation RMS x px', A.fixX, 0], ['fixation RMS y px', A.fixY, 0],
    ['fixation RMS x deg', d(A.fixX), 2], ['fixation RMS y deg', d(A.fixY), 2], ['mean abs x px', A.maeX, 0], ['mean abs y px', A.maeY, 0],
    ['mean offset x px', A.biasX, 0], ['mean offset y px', A.biasY, 0],
    ['claimed effY px', A.claim && !A.claim.na ? A.claim.effY : NaN, 0], ['claim off by (y)', A.claim && !A.claim.na ? A.claim.factorY : NaN, 2],
    ['screen-y sd in target px', N ? N.y.sd : NaN, 1], ['indep. frames of 6 (y)', N ? N.y.neff6 : NaN, 1],
    ['best variant', M ? M.best : 'n/a', 's'], ['best variant fix y px', M ? M.variants.find((v) => v.name === M.best).fixY : NaN, 0],
    ['nearest line %', L ? 100 * L.raw.nearest : NaN, 1], ['LineHMM %', L ? 100 * L.raw.hmm : NaN, 1], ['LineHMM within 1 %', L ? 100 * L.raw.hmmWithin1 : NaN, 1], ['progress decoder %', L ? 100 * L.raw.progress : NaN, 1],
    ['LineHMM % (-median dy)', L ? 100 * L.offsetRemoved.hmm : NaN, 1], ['progress % (-median dy)', L ? 100 * L.offsetRemoved.progress : NaN, 1],
    ['sigma_y / pitch', L ? L.sigmaOverPitch : NaN, 2], ['vertical bias px', L ? L.biasY : NaN, 0], ['dwell err LineHMM %', L ? 100 * L.raw.dwellErrHmm : NaN, 1],
  ];
  return rows;
}

export function renderCompare(RA, RB) {
  const a = headline(RA), b = headline(RB); const o = [];
  o.push(`== Compare   A = ${RA.file}   B = ${RB.file}`);
  o.push(`  ${pad('', 26)}${lpad('A', 22)}${lpad('B', 22)}${lpad('B - A', 12)}`);
  a.forEach((r, i) => {
    const va = r[1], vb = b[i][1], dgt = r[2];
    if (dgt === 's') { o.push(`  ${pad(r[0], 26)}${lpad(String(va).slice(0, 21), 22)}${lpad(String(vb).slice(0, 21), 22)}`); return; }
    if (!isNum(va) && !isNum(vb)) return;
    const fmt = (v) => (isNum(v) ? v.toFixed(dgt) : 'n/a');
    o.push(`  ${pad(r[0], 26)}${lpad(fmt(va), 22)}${lpad(fmt(vb), 22)}${lpad(isNum(va) && isNum(vb) ? sgn(vb - va, dgt) : '', 12)}`);
  });
  return o.join('\n');
}
