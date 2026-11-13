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
  window.__ev = []; window.__sg = []; window.__fx = []; window.__th = []; window.__status = [];
  window.__gz = {
    sr() { const h = document.querySelector('[data-gaze-reader]'); return h ? h.shadowRoot : null; },
    frame() { const sr = this.sr(); const f = sr && sr.querySelector('iframe'); return f ? f.contentWindow : null; },
    look(x, y) { Object.assign(this.frame().trueGaze, { x, y }); return performance.now(); },
    // Look at a point while reading a known line: also records the truth for decode scoring.
    fix(el, line, x, y) { const t = this.look(x, y); __th.push({ t, el, line }); return t; },
    ui() {
      const sr = this.sr();
      if (!sr) return null;
      const d = sr.getElementById('cdot'), i = sr.getElementById('instr'), b = sr.getElementById('bread');
      const x = d ? parseFloat(d.style.left) : NaN, y = d ? parseFloat(d.style.top) : NaN;
      return {
        dot: d && d.style.display === 'block' && isFinite(x) && isFinite(y) ? [x, y] : null,
        card: i && i.style.display !== 'none' ? i.innerText.trim() : '',
        bread: !!b && b.style.display === 'block',
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
  await page.eval(`GazeReader.init({ settleMs: 300, sampleMs: 500, trace: true, baselineWpm: 350 }); 0`);
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
  let lastCard = '', pressedAt = 0, passage = null, dots = 0, lastDot = '';
  const deadline = Date.now() + 150000;
  for (;;) {
    const st = await page.eval('__gz.ui()');
    if (!st || Date.now() > deadline) { check('calibration flow did not stall', false, `last UI state ${JSON.stringify(st)}`); break; }
    seenStatus.add(st.status);
    if (st.done) break;
    if (st.dot) {
      const key = st.dot.join(',');
      if (key !== lastDot) { lastDot = key; dots += 1; }
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
  check('calibration completes (13 + 5 dots, intro and done cards)', !!acc && dots === 18 && hasCard(/Calibrate eye tracking/) && hasCard(/Calibration done/), calErr || `${dots} dots, ${cards.length} cards`);
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
