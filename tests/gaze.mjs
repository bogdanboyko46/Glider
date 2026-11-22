// End-to-end check of the webcam gaze module with a simulated reader (headless, no camera).
//   node tests/gaze.mjs            (GAZE_TRACE=1 also prints the detector's trace lines)
// A fake camera frame (tests/gaze-site/fake-frame.html) turns a "true gaze" point into noisy
// feature vectors; this script moves that point the way a reader's eyes would move.
import { launch, serve } from './cdp.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};
const skip = (name, why) => console.log(`SKIP  ${name} (${why})`);
const note = (text) => console.log(`      ${text}`);

// Seeded noise so the simulated reader is the same on every run.
let seed = 3;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = (sd = 1) => sd * Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

const FIX_PER_LINE = 6;          // normal reading: fixations on one article line
const FIX_MS = [200, 300];       // ... each lasting this long
const BASE_FIX_MS = 230;         // baseline passage: fixation length
const STUCK_FIXES = 24;          // 24 x 250 ms = 6 s on one line
const STUCK_MS = 250;

// Helpers evaluated in the page. The harness forces shadow roots open and is same-origin with the frame.
const IN_PAGE = `
  window.__ev = []; window.__sg = []; window.__fx = []; window.__th = []; window.__status = []; window.__cd = [];
  window.__gz = {
    sr() { const h = document.querySelector('[data-gaze-reader]'); return h ? h.shadowRoot : null; },
    frame() { const sr = this.sr(); const f = sr && sr.querySelector('iframe'); return f ? f.contentWindow : null; },
    look(x, y) { Object.assign(this.frame().trueGaze, { x, y }); return performance.now(); },
    // Look at a point while reading a known line: also records the truth for decode scoring.
    fix(el, line, x, y) { const t = this.look(x, y); __th.push({ t, el, line }); return t; },
    ui() {
      const sr = this.sr();
      if (!sr) return null;
      const d = sr.getElementById('cdot'), i = sr.getElementById('instr'), b = sr.getElementById('bread'), n = sr.getElementById('cnote');
      const x = d ? parseFloat(d.dataset.x) : NaN, y = d ? parseFloat(d.dataset.y) : NaN;
      return {
        dot: d && d.style.display === 'block' && isFinite(x) && isFinite(y) ? [x, y] : null,
        card: i && i.style.display !== 'none' ? i.innerText.trim() : '',
        bread: !!b && b.style.display === 'block',
        note: n && n.style.display === 'block' ? n.textContent : '',
        status: GazeReader.getState().status,
        done: !!(window.__acc || window.__calErr),
      };
    },
    // One rect per visual line, with the number of words on it. sel: an id in the page, or '#btext' in the shadow root.
    lines(sel) {
      const el = sel.startsWith('#') ? this.sr().querySelector(sel) : document.getElementById(sel);
      if (!el) return [];
      const r = document.createRange(); r.selectNodeContents(el);
      const lines = GazeCore.mergeLineRects(r.getClientRects()).map((l) => ({ ...l, words: 0 }));
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        const re = /\\S+/g; let m;
        while ((m = re.exec(n.nodeValue))) {
          r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
          const b = r.getBoundingClientRect(), cy = (b.top + b.bottom) / 2;
          const L = lines.find((l) => cy >= l.top && cy <= l.bottom);
          if (L) L.words++;
        }
      }
      return lines;
    },
  };
  0`;

const HOOKS = `
  GazeReader.on('status', (s) => { if (__status[__status.length - 1] !== s.status) __status.push(s.status); });
  GazeReader.on('caldot', (d) => __cd.push(d));
  window.__accEv = []; GazeReader.on('accuracy', (a) => __accEv.push(JSON.parse(JSON.stringify(a))));
  window.__camEv = []; GazeReader.on('camera', (c) => __camEv.push(c));
  GazeReader.on('struggle', (d) => __ev.push({
    reason: d.reason, el: d.element && d.element.id, line: d.lineIndex, text: String(d.lineText || '').slice(0, 60),
    sev: d.severity, m: d.metrics, at: performance.now() }));
  GazeReader.on('struggling', (s) => __sg.push({ struggling: s.struggling, reason: s.reason, ratio: s.ratio, tau: s.tau, at: performance.now() }));
  GazeReader.on('fixation', (f) => { setTimeout(() => {
    const c = GazeReader.getCurrentLine();
    __fx.push({ t: f.t, dur: f.dur, x: Math.round(f.x), y: Math.round(f.y), c: c && { el: c.element.id, line: c.lineIndex, conf: c.confidence } });
  }, 0); });
  0`;

const started = Date.now();
const traces = [];
let events = [], struggling = [], finalState = null, statuses = [];
const { server, origin } = await serve();
const chrome = await launch({ width: 1280, height: 720 });

try {
  const page = await chrome.page();
  page.cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = p.args.map((a) => a.value ?? a.description).join(' ');
    if (text.includes('gaze-trace')) { traces.push(text); if (process.env.GAZE_TRACE) console.log(text); }
  });
  await page.goto(`${origin}/tests/gaze-site/harness.html`, 500);
  const now = () => page.eval('performance.now()');

  check('gaze module loads in the harness', await page.eval(`typeof GazeCore === 'object' && typeof GazeReader === 'object' && typeof GazeReader.calibrate === 'function'`));
  await page.eval(IN_PAGE);
  await page.eval(`GazeReader.init({ headSegment: true, featureCount: 25, settleMs: 300, sampleMs: 500, traceLog: true, baselineWpm: 350 }); 0`);
  await page.eval(HOOKS);
  const startStatus = await page.eval(`Promise.race([GazeReader.start().then((s) => s && s.status), new Promise((r) => setTimeout(() => r('start() timed out'), 10000))])`);
  await page.sleep(300);
  await page.eval(`Object.assign(__gz.frame().trueGaze, { W: innerWidth, H: innerHeight }); 0`);
  check('camera frame starts', ['ready', 'tracking'].includes(startStatus), `status ${startStatus}`);


  /* ---- calibration (+ reading-pace baseline when the module has one) ---- */
  // State-driven: whatever the overlay shows decides what the simulated person does next.
  await page.eval(`GazeReader.calibrate().then((a) => { window.__acc = a; }).catch((e) => { window.__calErr = String(e && e.message || e); }); 0`);
  const cards = [];
  const seenStatus = new Set();
  let lastCard = '', pressedAt = 0, passage = null, dots = 0, lastDot = '', headNote = '';
  const deadline = Date.now() + 150000;
  for (;;) {
    const st = await page.eval('__gz.ui()');
    if (!st || Date.now() > deadline) { check('calibration flow did not stall', false, `last UI state ${JSON.stringify(st)}`); break; }
    seenStatus.add(st.status);
    if (st.done) break;
    if (st.dot) {
      const key = st.dot.join(',');
      if (key !== lastDot) { lastDot = key; dots += 1; }
      if (st.note) headNote = st.note;
      await page.eval(`__gz.look(${st.dot[0]}, ${st.dot[1]}); 0`);
    } else if (st.bread && !st.card) {
      if (!passage) {
        // The baseline passage: read every visual line left to right at the article-reading pace, then Space.
        const t0 = Date.now();
        const lines = await page.eval(`__gz.lines('#btext')`);
        const words = lines.reduce((a, l) => a + l.words, 0);
        const p1 = await page.eval(`__gz.lines('p1')`);
        const articleWordsPerLine = p1.reduce((a, l) => a + l.words, 0) / Math.max(1, p1.length);
        const msPerWord = (FIX_PER_LINE * (FIX_MS[0] + FIX_MS[1]) / 2) / articleWordsPerLine;
        let fixes = 0;
        for (const L of lines) {
          const n = Math.max(3, Math.round((L.words * msPerWord) / BASE_FIX_MS));
          for (let k = 0; k < n; k += 1) {
            const x = L.left + ((k + 0.5) * (L.right - L.left)) / n + gauss(10);
            await page.eval(`__gz.look(${x}, ${(L.top + L.bottom) / 2 + gauss(4)}); 0`);
            await page.sleep(BASE_FIX_MS);
            fixes += 1;
          }
        }
        await page.key(' ', { code: 'Space' });
        const ms = Date.now() - t0;
        passage = { lines: lines.length, words, fixes, ms, wpm: words / (ms / 60000), wordsPerLine: lines.map((l) => l.words) };
        pressedAt = Date.now();
        note(`baseline passage: ${passage.lines} lines, ${words} words, read with ${fixes} fixations of ${BASE_FIX_MS} ms in ${ms} ms = ${passage.wpm.toFixed(0)} wpm`);
      } else if (Date.now() - pressedAt > 2000) {
        note('baseline passage still showing 2 s after Space: pressing Space again');
        await page.key(' ', { code: 'Space' }); pressedAt = Date.now();
      }
    } else if (st.card) {
      if (st.card !== lastCard) {
        lastCard = st.card; cards.push({ text: st.card, status: st.status });
        note(`card [${st.status}]: ${st.card.replace(/\s*\n\s*/g, ' | ').slice(0, 150)}`);
        await page.key(' ', { code: 'Space' }); pressedAt = Date.now();
      } else if (Date.now() - pressedAt > 2500) {
        note('card still showing 2.5 s after Space: pressing Space again');
        await page.key(' ', { code: 'Space' }); pressedAt = Date.now();
      }
    }
    await page.sleep(30);
  }
  const acc = await page.eval('window.__acc || null');
  const calErr = await page.eval('window.__calErr || null');
  note(`calibration: ${JSON.stringify(acc || calErr)}  (${dots} dots, ${((Date.now() - started) / 1000).toFixed(1)} s in)`);
  const hasCard = (re) => cards.some((c) => re.test(c.text));
  // (changed in step 3: the calibration is no longer exactly 18 dots. Doubtful dots are shown again and a head segment follows.)
  // (changed in step 4: five more 'caldot' events, seg 'check', for the check after the fit; they are counted on their own)
  const cdAll = await page.eval('__cd');
  const cd = cdAll.filter((d) => d.seg !== 'check'), checkDots = cdAll.filter((d) => d.seg === 'check');
  const seg = (s) => cd.filter((d) => d.seg === s);
  check('calibration completes (13 + 5 dots, up to 3 shown again, 3 head-segment dots, intro and done cards)',
    !!acc && seg('dots').length === 18 && seg('reshow').length <= 3 && seg('head').length === 3 && cd.length === 21 + seg('reshow').length && hasCard(/Calibrate eye tracking/) && hasCard(/Calibration done/),
    calErr || `${cd.length} caldot events (${seg('reshow').length} shown again), ${dots} dot positions seen, ${cards.length} cards`);
  check("every dot reports a 'caldot' event: sampled after it was shown, with frames, the first 300 ms left out",
    cd.length >= 21 && cd.every((d) => d.frames >= 8 && d.tSampleStart > d.tShow && d.tSampleEnd > d.tSampleStart && Number.isFinite(d.x) && Number.isFinite(d.y)) && seg('dots').every((d) => d.tSampleStart - d.tShow >= 299),
    `frames ${Math.min(...cd.map((d) => d.frames))}..${Math.max(...cd.map((d) => d.frames))}, sampling began ${Math.round(Math.min(...cd.map((d) => d.tSampleStart - d.tShow)))}..${Math.round(Math.max(...cd.map((d) => d.tSampleStart - d.tShow)))} ms after the dot appeared`);
  // (changed at sign-off: the instruction is a card the reader goes on from with Space, before the head dots; while a
  // head dot is on screen there is no text to read. It used to be a note above the first head dot, already being sampled.)
  const headCard = cards.find((c) => /One more step/.test(c.text) && /turn your head a little/.test(c.text)), headDots = seg('head').slice().sort((a, b) => a.tShow - b.tShow);
  const procDump = await page.eval('(() => { const c = GazeReader.debugDump().calibration; return c && c.procedure; })()');
  check('the head turn is asked for on a card that waits for Space, before the head dots; no text is on screen while a head dot is sampled',
    !!headCard && /Go on/.test(headCard.text) && headCard.status === 'calibrating' && headNote === '' && !!procDump && procDump.pausedMs > 0 && headDots.length === 3 && headDots[0].tSampleStart - headDots[0].tShow >= 999,
    `card: ${headCard ? headCard.text.replace(/\s*\n\s*/g, ' | ').slice(0, 90) : 'none'}; note beside a dot: "${headNote}"; waited ${procDump && procDump.pausedMs} ms; first head dot sampled ${headDots[0] ? Math.round(headDots[0].tSampleStart - headDots[0].tShow) : '-'} ms after it appeared`);
  const calDump = await page.eval(`(() => { const d = GazeReader.debugDump(); const c = d.calibration; return { source: d.accuracy && d.accuracy.source, dots: d.accuracy && d.accuracy.dots, n: c && c.dots.length, untrimmed: !!c && c.dots.every((q) => q.stream.length > q.frames && q.stream[0].t <= q.tSampleStart), ms: c && c.procedure && c.procedure.ms, extra: d.trainExtra ? d.trainExtra.X.length : 0, groups: [...new Set(d.train.G)].length, gate: d.headGate }; })()`);
  check('the accuracy is measured on the 5 validation dots by a fit on the other 13 (the model in use has all 18: real-camera sessions, 2026-11-21); the dump keeps every frame of every dot; the head-segment frames stay out of model A',
    calDump.source === 'val' && calDump.dots === 5 && calDump.n === cd.length && calDump.untrimmed && calDump.groups === 18 && calDump.extra > 30 && calDump.ms < 70000 && calDump.gate && calDump.gate.yawDeg > 0, JSON.stringify(calDump));
  const cardText = (cards.find((c) => /Calibration done/.test(c.text)) || { text: '' }).text;
  // (changed in step 4: the card now speaks from the five-dot check after the fit, as "Tracking is good / fair / poor")
  const val = acc && acc.validation, accEv = await page.eval('__accEv');
  check('after the calibration a five-dot check runs on new places and the accuracy carries its result in `validation`',
    !!val && val.ok === true && val.source === 'validation' && val.dots === 5 && val.frames >= 40 && ['good', 'fair', 'poor'].includes(val.grade) && typeof val.message === 'string' && val.message.startsWith('Tracking is ' + val.grade + ':') &&
    Number.isFinite(val.errPx) && Number.isFinite(val.errDeg) && val.perDot.length === 5 && checkDots.length === 5 && checkDots.every((d) => d.role === 'check' && d.frames >= 8 && d.tSampleStart > d.tShow) &&
    accEv.length === 1 && !!accEv[0].validation && accEv[0].validation.grade === val.grade && Number.isFinite(acc.effX) && Number.isFinite(acc.effY) && acc.source === 'val' && !!val.health && val.health.fps > 20,
    val ? `${val.message} (${val.errPx} px, about ${val.errDeg} deg; per fixation ${val.effX} x ${val.effY} px; calibration's own ${acc.effX} x ${acc.effY}); health ${JSON.stringify(val.health)}` : 'no validation field');
  check('the done card says the grade in plain words, with the number in a small line labelled approximate',
    !!val && cardText.includes('Tracking is ' + val.grade) && /which line you are on|band of about \d+ lines|which part of the page/.test(cardText) && /which line you are on/.test(cardText) === (val.effY < 16) &&
    cardText.includes(`typical error about ${val.errPx} px, approximately ${val.errDeg} degrees (approximate`) && (val.grade !== 'poor') === !/Use anyway/.test(cardText),
    cardText.replace(/\s*\n\s*/g, ' | ').slice(0, 260));
  check('vertical error (effY) is under 80px', !!acc && acc.effY < 80, acc ? `effX ${acc.effX}px, effY ${acc.effY}px` : 'no accuracy');
  if (!acc) throw new Error('calibration failed: ' + calErr);

  const s0 = await page.eval('GazeReader.getState()');
  if (s0.baseline != null) {
    const bl = s0.baseline;
    note(`baseline measured: ${JSON.stringify(bl)}`);
    check('baseline flow shows the reading-pace card, the passage and the result card',
      hasCard(/reading pace/i) && !!passage && hasCard(/Your reading pace/i), cards.map((c) => c.text.split('\n')[0].slice(0, 40)).join(' > '));
    const truth = passage ? passage.wpm : NaN;
    check('measured reading pace is within 25% of the simulated pace', Math.abs(bl.wpm - truth) <= 0.25 * truth,
      `measured ${bl.wpm} wpm (${bl.source}), simulated ${truth.toFixed(0)} wpm, off by ${(100 * (bl.wpm - truth) / truth).toFixed(0)}%`);
    check('personal threshold tau is within [1.6, 3.0]', bl.tau >= 1.6 && bl.tau <= 3.0 && s0.tau >= 1.6 && s0.tau <= 3.0, `baseline.tau ${bl.tau}, state.tau ${s0.tau}, cv ${bl.cv}`);
    check("status is 'baseline' from the reading-pace card to the result card",
      seenStatus.has('baseline') && cards.filter((c) => /reading pace/i.test(c.text)).every((c) => c.status === 'baseline'), [...seenStatus].join(', '));
    check("status reached 'tracking' after the baseline", s0.status === 'tracking', `status ${s0.status}`);
  } else {
    skip('baseline', 'not implemented in gaze-reader.js yet');
    check("status reached 'tracking' after calibration", s0.status === 'tracking', `status ${s0.status}`);
  }

  /* ---- simulated reading ------------------------------------------------- */
  await page.eval(`__gz.frame().driftOn = true; 0`);
  const lines = (el) => page.eval(`__gz.lines(${JSON.stringify(el)})`);
  const fixate = async (el, li, L, x, ms) => {
    await page.eval(`__gz.fix(${JSON.stringify(el)}, ${li}, ${x}, ${(L.top + L.bottom) / 2 + gauss(4)}); 0`);
    await page.sleep(ms);
  };
  const readLine = async (el, li, n = FIX_PER_LINE) => {
    const L = (await lines(el))[li];
    for (let k = 0; k < n; k += 1) {
      const x = L.left + ((k + 0.5) * (L.right - L.left)) / n + gauss(10);
      await fixate(el, li, L, x, Math.round(FIX_MS[0] + rnd() * (FIX_MS[1] - FIX_MS[0])));
    }
  };
  const scrollTo = async (el) => {
    // Fixations that straddle the scroll have no meaningful truth: stop scoring until the next one.
    await page.eval(`__th.push({ t: performance.now(), el: null, line: -1 }); document.getElementById(${JSON.stringify(el)}).scrollIntoView({ block: 'center' }); 0`);
    await page.sleep(300);
  };

  // 1) normal read of p3: nothing should trigger
  await scrollTo('p3');
  const n3 = (await lines('p3')).length;
  for (let li = 0; li < n3; li += 1) await readLine('p3', li);
  const tNormalEnd = await now();

  // 2) p1: normal, except ~6 s stuck on the third line
  await scrollTo('p1');
  const n1 = (await lines('p1')).length;
  for (let li = 0; li < n1; li += 1) {
    if (li === 2) {
      const L = (await lines('p1'))[2];
      for (let k = 0; k < STUCK_FIXES; k += 1) await fixate('p1', 2, L, L.left + 0.45 * (L.right - L.left) + gauss(30), STUCK_MS);
    } else await readLine('p1', li);
  }
  const tStuckEnd = await now();

  // 3) p2: lines 1-2 re-read twice
  await scrollTo('p2');
  const n2 = (await lines('p2')).length;
  for (const li of [0, 1, 2, 1, 2, 1, 2, 3, 4]) await readLine('p2', Math.min(li, n2 - 1));
  await page.sleep(500);
  note(`lines per paragraph: p1 ${n1}, p2 ${n2}, p3 ${n3}`);

  events = await page.eval('__ev');
  struggling = await page.eval('__sg');
  statuses = await page.eval('__status');
  finalState = await page.eval('GazeReader.getState()');
  const fx = await page.eval('__fx');
  const th = await page.eval('__th');

  /* ---- struggle detection ------------------------------------------------ */
  const brief = (e) => `${e.reason}@${e.el}:${e.line}`;
  const early = events.filter((e) => e.at <= tNormalEnd);
  check('no struggle during the normal read of p3', early.length === 0, early.map(brief).join(', '));
  const stuck = events.filter((e) => e.reason === 'stuck-line');
  check('stuck-line detected on p1, third line (index 2)', stuck.length === 1 && stuck[0].el === 'p1' && stuck[0].line === 2 && stuck[0].at <= tStuckEnd,
    stuck.map((e) => `${brief(e)} "${e.text}"`).join(', ') || 'no stuck-line event');
  const reread = events.filter((e) => e.reason === 'rereading' && e.el === 'p2');
  check('rereading detected on p2', reread.length >= 1, reread.map(brief).join(', ') || 'no rereading event on p2');
  const planted = (e) => (e.reason === 'stuck-line' && e.el === 'p1' && e.line === 2) || (e.reason === 'rereading' && e.el === 'p2');
  const extras = events.filter((e) => !planted(e));
  check('no struggle events other than the planted ones', extras.length === 0 && events.length <= 3, `${events.length} events: ${events.map(brief).join(', ')}${extras.length ? ' | extras: ' + extras.map(brief).join(', ') : ''}`);
  check('struggle events carry reason, severity, line text and metrics',
    events.length > 0 && events.every((e) => ['stuck-line', 'rereading', 'slow-paragraph'].includes(e.reason) && e.sev >= 0 && e.sev <= 1 && e.text && e.m && typeof e.m === 'object'));

  if ('struggling' in finalState) {
    const firstTrue = struggling.findIndex((s) => s.struggling === true);
    check("'struggling' event went true at least once", firstTrue >= 0, `${struggling.length} events`);
    check("'struggling' went false again after moving on", firstTrue >= 0 && struggling.slice(firstTrue + 1).some((s) => s.struggling === false),
      struggling.map((s) => `${s.struggling ? 'T' : 'F'}${s.reason ? ':' + s.reason : ''}@${Math.round(s.at)}`).join(' '));
  } else {
    skip("'struggling' event", 'getState() has no struggling field: not implemented in gaze-reader.js yet');
  }

  /* ---- decode accuracy --------------------------------------------------- */
  const truthAt = (t) => {
    let cur = null;
    for (const h of th) { if (h.t <= t + 60) cur = h; else break; }
    return cur && cur.el ? cur : null;
  };
  const scored = fx.map((f) => ({ ...f, truth: truthAt(f.t) })).filter((f) => f.truth);
  const paraOk = scored.filter((f) => f.c && f.c.el === f.truth.el).length;
  const lineOk = scored.filter((f) => f.c && f.c.el === f.truth.el && f.c.line === f.truth.line).length;
  const pct = (n) => `${((100 * n) / Math.max(1, scored.length)).toFixed(0)}%`;
  check('paragraph decode accuracy >= 90%', scored.length > 50 && paraOk / scored.length >= 0.9, `${pct(paraOk)} of ${scored.length} fixations`);
  check('line decode accuracy >= 70%', scored.length > 50 && lineOk / scored.length >= 0.7, `${pct(lineOk)} of ${scored.length} fixations`);
  for (const el of ['p3', 'p1', 'p2']) {
    const s = scored.filter((f) => f.truth.el === el);
    const ok = s.filter((f) => f.c && f.c.el === el && f.c.line === f.truth.line).length;
    note(`${el}: ${s.length} fixations, line correct ${((100 * ok) / Math.max(1, s.length)).toFixed(0)}%  ` +
      `[truth>decoded: ${s.map((f) => `${f.truth.line}${f.c ? (f.c.el === el ? '' : f.c.el + ':') + f.c.line : '-'}`).join(' ')}]`);
  }

  /* ---- frame times: the camera frame says how old each frame is ---- */
  await page.eval(`window.__ft = []; window.__offFt = GazeReader.on('frame', (f) => __ft.push(performance.now() - f.t)); __gz.frame().frameAge = 40; 0`);
  await page.sleep(600);
  const ages = await page.eval(`(() => { __offFt(); __gz.frame().frameAge = 0; return __ft.slice(-8); })()`);
  const dump1 = await page.eval(`(() => { const d = GazeReader.debugDump(); return { delegate: d.delegate, timeSource: d.timeSource, drift: d.noise.drift }; })()`);
  check('a frame captured 40 ms before it arrives is timed 40 ms back; the dump names the time source and the delegate',
    ages.length === 8 && ages.every((a) => a >= 39.5 && a < 46) && dump1.timeSource === 'capture' && dump1.delegate === 'CPU',
    `ages ${ages.map((a) => a.toFixed(1)).join(' ')} ms, ${dump1.timeSource}, ${dump1.delegate}`);

  /* ---- a saved calibration is restored clean ---- */
  await page.eval('GazeReader.stop(); 0');
  await page.sleep(200);
  // The offset is read in the same breath as start() resolves: once frames flow again the tracker starts learning a new one.
  const [restored, drift2] = await page.eval(`Promise.race([GazeReader.start().then((s) => [s && s.status, GazeReader.debugDump().noise.drift]), new Promise((r) => setTimeout(() => r(['start() timed out', NaN]), 10000))])`);
  await page.sleep(300);
  await page.eval(`Object.assign(__gz.frame().trueGaze, { W: innerWidth, H: innerHeight }); 0`);
  check('stop and start: the saved calibration is restored, without the vertical offset learned before', restored === 'tracking' && dump1.drift !== 0 && drift2 === 0,
    `status ${restored}, drift ${dump1.drift.toFixed(1)} px before, ${drift2} after`);

  /* ---- render loop: it runs only while there is something to draw ---- */
  // (These checks sit at the end on purpose: anything that takes time before the calibration changes
  // which camera frames the calibration sees, and the reading checks above depend on that.)
  await page.eval('__gz.look(5, 5); 0');   // eyes in the page corner, away from any text: nothing to highlight
  await page.sleep(400);
  await page.eval(`(() => { window.__raf = 0; const o = window.requestAnimationFrame.bind(window); window.requestAnimationFrame = (cb) => { window.__raf += 1; return o(cb); }; })(); 0`);
  const rafIn = async (ms) => { await page.eval('window.__raf = 0'); await page.sleep(ms); return page.eval('window.__raf'); };
  // How many pixels of the overlay canvas are painted, and its size in device pixels.
  const hud = () => page.eval(`(() => { const c = __gz.sr().getElementById('hud'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n += 1; return { w: c.width, h: c.height, painted: n }; })()`);
  const rafIdle = await rafIn(500);
  check('tracking, nothing to draw: no animation frames are requested', rafIdle === 0, `${rafIdle} in 500 ms`);
  await page.eval('GazeReader.setTrace(true); 0');
  const rafOn = await rafIn(500);
  await page.eval('GazeReader.setTrace(false); 0');
  await page.sleep(150);
  const rafOff = await rafIn(500);
  check('"Show tracking" starts the render loop, and turning it off stops it again', rafOn >= 5 && rafOff === 0, `${rafOn} frames in 500 ms while on, ${rafOff} after`);

  /* ---- trace options: traceLog is the console log, trace is the heat overlay ---- */
  const hud0 = await hud();
  check("traceLog prints '[gaze-trace]' lines and does not turn the heat trace on", traces.length > 20 && hud0.painted === 0, `${traces.length} lines, ${hud0.painted} overlay pixels painted`);
  // (step 4) the two options apart: the heat trace alone, with the eyes on a line of text (where the log would print), prints nothing
  await page.eval('GazeReader.init({ traceLog: false }); 0');
  await page.sleep(300);
  const linesBefore = traces.length;
  await page.eval(`(() => { const r = document.getElementById('p2').getBoundingClientRect(); window.__tp = [Math.round(r.left + 200), Math.round(r.top + 30)]; __gz.look(__tp[0], __tp[1]); return 0; })()`);
  await page.eval('GazeReader.setTrace(true); 0');
  await page.sleep(1100);
  const hud1 = await hud();
  // heat near the place looked at, and the overlay lets clicks through to the page
  const heatAt = await page.eval(`(() => { const c = __gz.sr().getElementById('hud'), k = c.width / innerWidth; const d = c.getContext('2d').getImageData(Math.round((__tp[0] - 60) * k), Math.round((__tp[1] - 60) * k), Math.round(120 * k), Math.round(120 * k)).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n += 1;
    const el = document.elementFromPoint(__tp[0], __tp[1]); return { near: n, hit: el && (el.id || el.tagName), pe: getComputedStyle(c).pointerEvents, hostPe: getComputedStyle(document.querySelector('[data-gaze-reader]')).pointerEvents }; })()`);
  const linesTraceOnly = traces.length - linesBefore;
  await page.eval('GazeReader.setTrace(false); 0');
  await page.sleep(400);
  const hud2 = await hud();
  check("setTrace(true) paints heat where the eyes are, without '[gaze-trace]' console lines; setTrace(false) wipes it", hud1.painted > 200 && heatAt.near > 100 && linesTraceOnly === 0 && hud2.painted === 0, `${hud1.painted} pixels on (${heatAt.near} within 60 px of the eyes), ${linesTraceOnly} log lines meanwhile, ${hud2.painted} pixels off`);
  check('the trace canvas takes no clicks: a point under the heat still hits the page text', heatAt.hit === 'p2' && heatAt.pe === 'none' && heatAt.hostPe === 'none', JSON.stringify(heatAt));
  await page.eval('GazeReader.init({ traceLog: true }); 0');
  await page.sleep(1100);
  const hud2b = await hud(), linesLogOnly = traces.length - linesBefore;
  check("traceLog:true gives the '[gaze-trace]' console lines again, without the heat trace", linesLogOnly >= 1 && hud2b.painted === 0, `${linesLogOnly} log lines, ${hud2b.painted} overlay pixels painted`);
  // "Show tracking" switched on while the tracker is off: nothing to draw yet, and the heat comes by itself once it tracks
  await page.eval('GazeReader.stop(); GazeReader.setTrace(true); 0');
  await page.sleep(200);
  const earlyStart = await page.eval(`Promise.race([GazeReader.start().then((s) => s && s.status), new Promise((r) => setTimeout(() => r('start() timed out'), 10000))])`);
  await page.eval(`Object.assign(__gz.frame().trueGaze, { W: innerWidth, H: innerHeight }); __gz.look(__tp[0], __tp[1]); 0`);
  await page.sleep(1100);
  const hudEarly = await hud();
  await page.eval('GazeReader.setTrace(false); __gz.look(5, 5); 0');
  await page.sleep(400);
  check('setTrace(true) before the tracker runs is kept: the heat appears once it tracks', earlyStart === 'tracking' && hudEarly.painted > 200 && (await hud()).painted === 0, `start: ${earlyStart}, ${hudEarly.painted} pixels`);

  /* ---- overlay canvas at a fractional devicePixelRatio (laptops at 125 % or 150 % scaling) ---- */
  // 1281 x 1.25 = 1601.25: a canvas is 1601 wide, so an unrounded comparison never matches and it is reallocated every frame.
  await page.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1281, height: 721, deviceScaleFactor: 1.25, mobile: false });
  await page.sleep(400);
  await page.eval(`(() => { const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'width'); window.__cw = 0;
    Object.defineProperty(HTMLCanvasElement.prototype, 'width', { configurable: true, get: d.get, set(v) { window.__cw += 1; d.set.call(this, v); } }); })(); 0`);
  await page.eval('GazeReader.setDebug(true); 0');
  await page.sleep(400);
  await page.eval('window.__cw = 0');
  const drawn = await rafIn(600);
  const sets = await page.eval('window.__cw');
  const hud3 = await hud();
  const dpr = await page.eval('devicePixelRatio');
  check('devicePixelRatio 1.25: the overlay canvas keeps its size from frame to frame', dpr === 1.25 && drawn >= 5 && sets === 0 && hud3.w === 1601 && hud3.h === 901 && hud3.painted > 0,
    `dpr ${dpr}, ${drawn} frames, canvas resized ${sets} times, ${hud3.w} x ${hud3.h}`);
  await page.eval('GazeReader.setDebug(false); 0');

  // step 2: this test camera sends 44 numbers and no usable face matrix, so the model shoot-out must end with model A
  const m2 = () => page.eval(`(() => { const d = GazeReader.debugDump(); return { status: d.state.status, kind: d.modelKind, v: d.model && d.model.v, mk: d.model && d.model.kind, acc: d.accuracy && d.accuracy.model, note: d.shootout && d.shootout.note, asked: d.shootout && d.shootout.asked, width: d.train && d.train.X[0].length, keepMax: d.model ? Math.max(...d.model.keep) : -1, n: d.model && d.model.n, clicks: d.clicks }; })()`);
  const d2 = await m2();
  check('the reader asks for model A (the shoot-out is off by default since the real-camera sessions), and the dump says which model and why',
    d2.kind === 'A' && d2.mk === 'A' && d2.v === 2 && d2.acc === 'A' && d2.asked === 'A' && /model A asked for/.test(d2.note || '') && d2.width === 44 && d2.keepMax < 25, JSON.stringify(d2));
  // click refinement goes through the same model kind (C.refitModel)
  // (changed in step 3: a click only counts while the eyes rest on it, so the simulated eyes now look at the click first)
  const clickAt = (x, y) => page.eval(`(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { clientX: ${x}, clientY: ${y}, bubbles: true, composed: true })); return 0; })()`);
  await page.eval('__gz.look(320, 240); 0');
  await page.sleep(700);
  // (the gate wants a fixation in progress; with this camera's noise the detector sometimes has just started a new one, so try a few times)
  for (let k = 0; k < 6; k += 1) { await clickAt(320, 240); await page.sleep(350); if ((await page.eval('GazeReader.debugDump().clickStats')).used >= 1) break; }
  await page.sleep(700);
  const d3 = await m2(), cs0 = await page.eval('GazeReader.debugDump().clickStats');
  check('a click the eyes rest on refits the same kind of model with the click frames added', d3.status === 'tracking' && d3.kind === 'A' && d3.clicks >= 2 && d3.n === d2.n + d3.clicks && d3.keepMax < 25, JSON.stringify(d3));
  await clickAt(1000, 620);                                                             // the eyes are still at (320, 240)
  await page.eval(`document.getElementById('p1').setAttribute('data-glider-ignore', ''); 0`);   // stands in for Glider's dock
  await page.eval(`(() => { const r = document.getElementById('p1').getBoundingClientRect(); __gz.look(r.left + 40, r.top + 10); window.__p1 = [r.left + 40, r.top + 10]; return 0; })()`);
  await page.sleep(700);
  await page.eval(`(() => { document.getElementById('p1').dispatchEvent(new PointerEvent('pointerdown', { clientX: __p1[0], clientY: __p1[1], bubbles: true, composed: true })); document.getElementById('p1').removeAttribute('data-glider-ignore'); return 0; })()`);
  await page.sleep(900);
  const d4 = await m2(), cs = await page.eval('GazeReader.debugDump().clickStats');
  check('a click far from the eyes is not used, and neither is a click on Glider\'s own controls', d4.clicks === d3.clicks && d4.n === d3.n && cs.used === cs0.used && cs.refused === cs0.refused + 1, `${JSON.stringify(cs)}, click frames ${d3.clicks} -> ${d4.clicks}`);

  /* ---- step 3: head gate, saved-calibration safety, resized or moved window ---- */
  // (At the very end: these stop and start the tracker and resize the window.)
  const st3 = () => page.eval(`(() => { const s = GazeReader.getState(); return { status: s.status, drifted: s.drifted, recal: s.needsRecalibration, calibrated: s.calibrated }; })()`);
  const gazeIn = async (ms) => { await page.eval('window.__gn = 0; window.__offGn = GazeReader.on("gaze", () => { __gn += 1; }); 0'); await page.sleep(ms); return page.eval('(() => { __offGn(); return __gn; })()'); };
  await page.eval('window.__fakeHeadDx = 0.2; 0');          // the fake camera now sees the head a fifth of the picture to one side
  await page.sleep(1100);
  const moved = await st3(), movedGaze = await gazeIn(400);
  await page.eval('window.__fakeHeadDx = 0; 0');
  await page.sleep(500);
  const back = await st3(), backGaze = await gazeIn(400);
  check('head far from the calibration posture: tracking pauses (no gaze), and resumes when the head is back', moved.drifted === true && movedGaze === 0 && back.drifted === false && backGaze > 5 && back.status === 'tracking',
    `moved: drifted ${moved.drifted}, ${movedGaze} gaze events; back: drifted ${back.drifted}, ${backGaze} gaze events`);

  const restart = async () => { await page.eval('GazeReader.stop(); 0'); await page.sleep(200); const s = await page.eval(`Promise.race([GazeReader.start().then((s) => s && s.status), new Promise((r) => setTimeout(() => r('start() timed out'), 10000))])`); await page.eval(`Object.assign(__gz.frame().trueGaze, { W: innerWidth, H: innerHeight }); 0`); return s; };
  await page.eval('window.__fakeHeadDx = 0.2; 0');
  const refused = await restart(), refusedState = await st3();
  const why = await page.eval('JSON.stringify(GazeReader.debugDump().restoreCheck)');
  await page.eval('window.__fakeHeadDx = 0; 0');
  const reused = await restart();
  check('a saved calibration is reused only when the head is where it was calibrated (checked over the first second)', refused === 'ready' && refusedState.calibrated === false && reused === 'tracking', `head moved: ${refused} ${why}; head back: ${reused}`);

  await page.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 721, deviceScaleFactor: 1.25, mobile: false });
  await page.sleep(1300);
  const small = await st3(), smallGaze = await gazeIn(400);
  await page.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1281, height: 721, deviceScaleFactor: 1.25, mobile: false });
  await page.sleep(1300);
  const again = await st3(), againGaze = await gazeIn(400);
  check("window resized: status 'paused' and no gaze on the old mapping; window back: tracking again", small.status === 'paused' && small.recal === true && smallGaze === 0 && again.status === 'tracking' && again.recal === false && againGaze > 5,
    `resized: ${small.status}, ${smallGaze} gaze events; back: ${again.status}, ${againGaze} gaze events`);

  // (sign-off) Switched off, the window resized, switched on: the saved calibration does not fit and is not restored.
  // The model still in memory from before the stop must not count as a calibration either.
  await page.eval('GazeReader.stop(); 0'); await page.sleep(200);
  await page.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 721, deviceScaleFactor: 1.25, mobile: false });
  await page.sleep(300);
  const staleStart = await page.eval(`Promise.race([GazeReader.start().then((s) => s && s.status), new Promise((r) => setTimeout(() => r('start() timed out'), 10000))])`), stale = await st3(), staleGaze = await gazeIn(400);
  await page.eval('GazeReader.stop(); 0'); await page.sleep(200);
  await page.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1281, height: 721, deviceScaleFactor: 1.25, mobile: false });
  await page.sleep(300);
  const fits = await restart(), fitsState = await st3();
  check("off, window resized, on: status 'ready' and not calibrated (no stale model); window back and restarted: the saved calibration is used", staleStart === 'ready' && stale.calibrated === false && stale.recal === false && staleGaze === 0 && fits === 'tracking' && fitsState.calibrated === true,
    `resized: ${staleStart}, calibrated ${stale.calibrated}, ${staleGaze} gaze events; back: ${fits}, calibrated ${fitsState.calibrated}`);

  /* ---- step 4: a start that cannot get a camera or the face model ends with a clear message, never on 'starting' ---- */
  const startAs = async (mode, extra = '') => { await page.eval(`GazeReader.stop(); window.__fakeFrameMode = ${JSON.stringify(mode)}; ${extra} 0`); await page.sleep(150); const t0 = Date.now(); const s = await page.eval(`Promise.race([GazeReader.start().then((s) => ({ status: s.status, error: s.error })), new Promise((r) => setTimeout(() => r({ status: 'start() timed out' }), 10000))])`); return { ...s, ms: Date.now() - t0 }; };
  const toastNow = () => page.eval(`(() => { const t = __gz.sr() && __gz.sr().getElementById('toast'); return t && t.style.display !== 'none' ? { text: t.firstChild ? t.firstChild.textContent : '', buttons: [...t.querySelectorAll('button')].map((b) => b.textContent) } : null; })()`);
  const waitStatus = async (want, ms = 6000) => { const until = Date.now() + ms; let s = ''; while (Date.now() < until) { s = await page.eval('GazeReader.getState().status'); if (want.includes(s)) break; await page.sleep(100); } return s; };
  const seen = {};
  for (const mode of ['in-use', 'no-camera', 'blocked', 'denied', 'model']) { const s = await startAs(mode); seen[mode] = { ...s, toast: (await toastNow()) || { text: '', buttons: [] } }; }
  const texts = Object.values(seen).map((s) => s.toast.text);
  check('camera in use, no camera, camera blocked, camera not yet allowed and a face model that does not load each give their own message',
    seen['in-use'].status === 'error' && seen['in-use'].error.code === 'camera-in-use' && /another app/.test(texts[0]) && seen['no-camera'].status === 'error' && /No camera was found/.test(texts[1]) &&
    seen.blocked.status === 'needs-permission' && seen.blocked.error.code === 'camera-blocked' && /blocked/.test(texts[2]) && seen.denied.status === 'needs-permission' && seen.denied.error.code === 'camera-permission' && /one-time camera access/.test(texts[3]) &&
    seen.model.status === 'error' && texts[4] === 'Eye tracking could not load (the wasm file is missing).' && new Set(texts).size === 5 &&
    ['in-use', 'no-camera', 'model'].every((m) => seen[m].toast.buttons.join() === 'Retry') && ['blocked', 'denied'].every((m) => seen[m].toast.buttons.join() === 'Allow camera'),
    Object.entries(seen).map(([m, s]) => `${m}: ${s.status} "${s.toast.text}" [${s.toast.buttons.join()}]`).join(' | '));
  // Retry on the "could not load" message, now that the model loads
  await page.eval(`window.__fakeFrameMode = ''; __gz.sr().getElementById('toast').querySelector('button').click(); 0`);
  const retried = await waitStatus(['tracking', 'ready']);
  await page.eval(`Object.assign(__gz.frame().trueGaze, { W: innerWidth, H: innerHeight }); 0`);
  check('Retry starts the tracker again', ['tracking', 'ready'].includes(retried) && (await page.eval('GazeReader.getState().error')) === null, `status ${retried}`);
  // a camera frame that never answers: the start gives up (25 s as shipped, 700 ms here)
  const silent = await startAs('silent', 'GazeReader.init({ startTimeoutMs: 700 });');
  const silentToast = (await toastNow()) || { text: '', buttons: [] };
  await page.eval('GazeReader.init({ startTimeoutMs: 25000 }); 0');
  check("a camera frame that never answers does not leave the status on 'starting': start() resolves with a timeout error and a Retry",
    silent.status === 'error' && silent.error.code === 'timeout' && silent.ms < 3000 && /could not load \(no answer in/.test(silentToast.text) && silentToast.buttons.join() === 'Retry', `${silent.status} after ${silent.ms} ms: "${silentToast.text}"`);
  // the permission page's flag restarts the tracker by itself
  const denied = await startAs('denied');
  await page.eval(`window.__fakeFrameMode = ''; chrome.storage.local.set({ grCameraGranted: Date.now() }); 0`);
  const granted = await waitStatus(['tracking', 'ready']);
  const camState = await page.eval('JSON.stringify(GazeReader.getState().camera)');
  check('camera allowed on the permission page: the tracker starts again by itself, no reload and no second switch', denied.status === 'needs-permission' && ['tracking', 'ready'].includes(granted) && !/camera access/.test(((await toastNow()) || { text: '' }).text), `needs-permission -> ${granted}; camera ${camState}`);
  const cam = JSON.parse(camState), camEv = await page.eval('__camEv.length');
  check("the camera status reports the resolution, the delegate and the frame rate ('camera' event and getState().camera)", !!cam && cam.width === 1280 && cam.height === 720 && Array.isArray(cam.warnings) && camEv >= 1, `${camState}, ${camEv} camera events`);

  check('no page errors or warnings', page.errors.length === 0, page.errors.slice(0, 5).join(' || '));
} catch (error) {
  check('test run completed', false, error.stack || String(error));
} finally {
  await chrome.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
if (failed.length && !process.env.GAZE_TRACE && traces.length) {
  console.log(`\nlast detector trace lines (${traces.length} in total; GAZE_TRACE=1 prints all):`);
  for (const t of traces.slice(-25)) console.log('  ' + t);
}
console.log('\nSTRUGGLE EVENTS:');
for (const e of events) console.log('  ' + JSON.stringify(e));
console.log("'STRUGGLING' EVENTS:");
for (const s of struggling) console.log('  ' + JSON.stringify(s));
console.log('STATUS SEQUENCE: ' + statuses.join(' > '));
console.log('STATE: ' + JSON.stringify(finalState));
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exit(failed.length ? 1 : 0);
