// node tests/assessment-live.mjs [outDir] — the whole live Reading Check with a simulated reader (headless, no camera).
// The real assessment page runs against a fake chrome.* and the fake camera frame from tests/gaze-site;
// this script follows the calibration dots, "reads" the passage, answers the questions and inspects the result.
// It is also the first real user of the tracker's 'frame' event and widget:false option.
import { join } from 'node:path';
import { launch, serve, REPO } from './cdp.mjs';

const out = process.argv[2] || join(REPO, 'tests', 'out');
let failed = 0;
const check = (ok, label, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  -> ' + detail : ''}`); if (!ok) failed += 1; };
let seed = 5;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const gauss = (sd = 1) => sd * Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

// Runs before any page script: fake extension APIs, and shadow roots forced open so the test can see the tracker UI.
const STUB = `(() => {
  if (window.__rcStub) return; window.__rcStub = true;
  const as = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (o) { return as.call(this, { ...o, mode: 'open' }); };
  const store = {};
  window.__store = store;
  window.chrome = {
    runtime: {
      id: 'test',
      getURL: (p) => location.origin + (p === 'gaze/frame.html' ? '/tests/gaze-site/fake-frame.html' : '/glider-extension/' + p),
      onMessage: { addListener() {} },
    },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get: (keys) => {
          const names = keys == null ? Object.keys(store) : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          const o = {};
          for (const k of names) if (k in store) o[k] = store[k];
          return Promise.resolve(o);
        },
        set: (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); return Promise.resolve(); },
        remove: (keys) => { for (const k of [].concat(keys)) delete store[k]; return Promise.resolve(); },
      },
    },
  };
})();`;

const IN_PAGE = `
  window.__t = {
    sr() { const h = document.querySelector('[data-gaze-reader]'); return h ? h.shadowRoot : null; },
    frame() { const sr = this.sr(); const f = sr && sr.querySelector('iframe'); return f ? f.contentWindow : null; },
    look(x, y) { const f = this.frame(); if (f && f.trueGaze) Object.assign(f.trueGaze, { x, y, W: innerWidth, H: innerHeight }); },
    btn(re) { return [...document.querySelectorAll('#rc-root button, #rc-root a')].find((b) => re.test(b.textContent) && !b.disabled && b.offsetParent !== null); },
    click(re) { const b = this.btn(re); if (b) b.click(); return !!b; },
    state() {
      const sr = this.sr();
      const d = sr && sr.getElementById('cdot'), i = sr && sr.getElementById('instr'), cal = sr && sr.getElementById('calib'), cam = sr && sr.getElementById('cam');
      const x = d ? parseFloat(d.style.left) : NaN, y = d ? parseFloat(d.style.top) : NaN;
      const calOn = !!cal && cal.classList.contains('show');
      return {
        reader: typeof GazeReader === 'object',
        status: typeof GazeReader === 'object' ? GazeReader.getState().status : null,
        dot: calOn && d && d.style.display === 'block' && isFinite(x) && isFinite(y) ? [x, y] : null,
        card: calOn && i && i.style.display !== 'none' ? i.innerText.trim().slice(0, 60) : '',
        camHidden: cam ? (getComputedStyle(cam).opacity === '0' || getComputedStyle(cam).display === 'none') : null,
        toast: sr && sr.getElementById('toast') ? getComputedStyle(sr.getElementById('toast')).display !== 'none' : false,
        reading: !!document.querySelector('.rcf-read--live'),
        panel: (document.querySelector('#rc-root h1, #rc-root h2') || {}).textContent || '',
        buttons: [...document.querySelectorAll('#rc-root button')].filter((b) => b.offsetParent !== null).map((b) => b.textContent.trim()),
        dashboard: !!document.querySelector('.rcd'),
      };
    },
    words() {
      return [...document.querySelectorAll('.rcf-read__text [data-w]')].map((s) => { const r = s.getBoundingClientRect(); return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2, top: r.top }; });
    },
  }; 0`;

const { server, origin } = await serve();
const chrome = await launch({ width: 1360, height: 900 });
try {
  const page = await chrome.page();
  await page.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: STUB });
  await page.goto(`${origin}/glider-extension/assessment/assessment.html`, 900);
  await page.eval(IN_PAGE);
  const state = () => page.eval('__t.state()');

  check(await page.eval(`__t.click(/^\\s*start/i)`), 'intro: Start pressed');

  // ---- camera + calibration: follow whatever the overlay shows
  let dots = 0, lastDot = '', lastPress = 0, tuned = false, sawCard = '', widgetHiddenInCal = null;
  const deadline = Date.now() + 120000;
  let st;
  for (;;) {
    st = await state();
    if (Date.now() > deadline) { check(false, 'calibration did not stall', JSON.stringify(st)); break; }
    if (st.reader && !tuned) { tuned = true; await page.eval(`GazeReader.init({ settleMs: 300, sampleMs: 500 }); 0`); }
    if (st.reading || st.dashboard) break;
    if (st.dot) {
      const key = st.dot.join(',');
      if (key !== lastDot) { lastDot = key; dots += 1; }
      widgetHiddenInCal = st.camHidden;
      await page.eval(`__t.look(${st.dot[0]}, ${st.dot[1]}); 0`);
    } else if (st.card && Date.now() - lastPress > 700) {
      sawCard = st.card;
      await page.key(' ', { code: 'Space' }); lastPress = Date.now();
    } else if (!st.card && st.buttons.some((b) => /continue anyway/i.test(b)) && Date.now() - lastPress > 700) {
      console.log('      calibration accuracy was above the gate; continuing anyway');
      await page.eval(`__t.click(/continue anyway/i)`); lastPress = Date.now();
    }
    await page.sleep(60);
  }
  check(dots >= 18, `calibration showed ${dots} dots (13 + 5)`);
  check(st.reading, 'read step reached', st.reading ? '' : JSON.stringify(st));
  check(widgetHiddenInCal === true && st.camHidden === true && !st.toast, 'widget:false — camera widget and toasts stay hidden', `cam hidden ${st.camHidden}, toast ${st.toast}`);
  const acc = await page.eval(`GazeReader.getState().accuracy`);
  console.log('      accuracy', JSON.stringify(acc));

  // ---- read the passage like a person: left to right, line by line, with two jumps back on line 3
  const words = await page.eval('__t.words()');
  const lines = [];
  for (const w of words) { const L = lines.find((l) => Math.abs(l[0].top - w.top) < 8); if (L) L.push(w); else lines.push([w]); }
  const others = await page.eval(`[...document.querySelectorAll('#rc-root .rcf-read *')].filter((e) => e.offsetParent !== null && !e.closest('.rcf-read__text') && e.innerText && e.children.length === 0).map((e) => e.innerText.trim()).filter(Boolean)`);
  console.log(`      passage: ${words.length} words on ${lines.length} lines; other visible text: ${JSON.stringify(others)}`);
  await page.shot(join(out, 'rc-live-read.png'));
  const FIX = 240;
  const tRead = Date.now();
  let planted = 0, fixes = 0;
  for (let li = 0; li < lines.length; li += 1) {
    const L = lines[li];
    for (let j = 0; j < L.length; j += 2) {
      await page.eval(`__t.look(${L[j].x + gauss(6)}, ${L[j].y + gauss(4)}); 0`);
      await page.sleep(FIX); fixes += 1;
      if (li === 2 && (j === 4 || j === 8) && L[j - 4]) {
        await page.eval(`__t.look(${L[j - 4].x}, ${L[j - 4].y}); 0`);
        await page.sleep(FIX); planted += 1; fixes += 1;
      }
    }
  }
  const readMs = Date.now() - tRead;
  await page.key(' ', { code: 'Space' });
  await page.sleep(900);

  // ---- questions (the adult passage: correct options are the 2nd, then the 1st)
  for (const pick of [1, 0]) {
    const ok = await page.eval(`(() => { const o = [...document.querySelectorAll('#rc-root .rcf-opt__input')]; if (!o[${pick}]) return false; o[${pick}].click(); return true; })()`);
    check(ok, `question answered (option ${pick + 1})`);
    await page.sleep(200);
    await page.eval(`__t.click(/next|finish|continue/i)`);
    await page.sleep(500);
  }
  st = await state();
  check(st.status === 'idle' || st.status === null || !st.reader, 'camera is off after the read', `tracker status ${st.status}`);
  check(await page.eval(`__t.click(/show analytics/i)`), '"Show analytics" pressed', JSON.stringify(st.buttons));
  await page.sleep(1800);

  // ---- the result
  st = await state();
  check(st.dashboard, 'dashboard rendered');
  const r = await page.eval(`(async () => {
    const s = await RCStorage.getLatestSession();
    if (!s) return null;
    const a = RCAnalytics.analyze(s);
    const hist = await RCStorage.getHistory();
    return { keys: Object.keys(s).sort(), gaze: s.gaze.length, frames: s.frames.length, heads: s.frames.filter((f) => f.face && f.head && isFinite(f.head.cx)).length,
      tMin: s.gaze.length ? s.gaze[0].t : null, tMax: s.gaze.length ? s.gaze[s.gaze.length - 1].t : null, durationMs: s.durationMs,
      lines: s.lineRects.length, lineText: s.lineRects.every((l) => l.text && l.words > 0), words: s.wordBoxes.length, answers: s.answers, ageBand: s.ageBand, passageId: s.passageId,
      accuracy: s.accuracy, lowQuality: s.lowQuality, paused: s.trackingPausedMs,
      ok: a.ok, reason: a.reason, metrics: a.metrics && { ...a.metrics, head: a.metrics.head && +a.metrics.head.sd.toFixed(4) }, quality: a.quality, lineRatios: a.lines.map((l) => l.ratio),
      history: hist.length, text: document.getElementById('rc-root').innerText };
  })()`);
  check(!!r, 'session was saved and can be read back');
  if (r) {
    console.log('      session', JSON.stringify({ gaze: r.gaze, frames: r.frames, t: [r.tMin, r.tMax], durationMs: r.durationMs, lines: r.lines, words: r.words, paused: r.paused, lowQuality: r.lowQuality }));
    console.log('      metrics', JSON.stringify(r.metrics));
    console.log('      quality', JSON.stringify(r.quality));
    const need = ['accuracy', 'ageBand', 'answers', 'demo', 'durationMs', 'frames', 'gaze', 'id', 'lineRects', 'lowQuality', 'passage', 'passageId', 'startedAt', 'viewport', 'wordBoxes'];
    check(need.every((k) => r.keys.includes(k)), 'session has every contract field', r.keys.join(','));
    check(r.gaze > 0.6 * (r.durationMs / 33) && r.tMin >= 0 && r.tMax <= r.durationMs + 50, `gaze stream: ${r.gaze} samples, timed from the start of the read`);
    check(r.frames >= r.gaze && r.heads === r.frames, `'frame' event: ${r.frames} frames, all with head pose`);
    check(r.lines === lines.length && r.words === words.length && r.lineText, `layout recorded: ${r.lines} lines, ${r.words} words, text per line`);
    check(Math.abs(r.durationMs - readMs) < 1500, `read lasted ${r.durationMs} ms (simulated ${readMs} ms)`);
    check(r.answers.length === 2 && r.answers.every((a) => a.chosen === a.correct), 'both answers recorded as correct');
    check(r.ok, 'analysis ran on the live session', String(r.reason));
    if (r.ok) {
      const wpmTrue = words.length / (readMs / 60000);
      check(Math.abs(r.metrics.wpm - wpmTrue) < 0.2 * wpmTrue, `reading speed ${r.metrics.wpm} wpm (simulated ${Math.round(wpmTrue)})`);
      check(r.metrics.fixationCount > 0.5 * fixes && r.metrics.fixationCount < 1.6 * fixes, `fixations ${r.metrics.fixationCount} (simulated ${fixes})`);
      check(r.metrics.regressions >= planted && r.metrics.regressions <= planted + 6, `regressions ${r.metrics.regressions} (planted ${planted})`);
      check(r.metrics.blinkRate === 0 && r.metrics.faceLostPct === 0 && r.metrics.head !== null, 'frame-based metrics are available');
      check(r.metrics.comprehension.correct === 2, 'comprehension 2 of 2');
    }
    check(r.history === 1, 'summary added to history');
    check(!/\bNaN\b|undefined|\bnull\b|Infinity|\[object /.test(r.text), 'dashboard text has no broken numbers');
  }
  check(page.errors.length === 0, 'no page errors', JSON.stringify(page.errors).slice(0, 600));
  await page.eval('window.scrollTo(0, 0)');
  await page.shot(join(out, 'rc-live-dashboard.png'));
  await page.eval(`document.querySelector('.rcd-scan, [class*="rcd-scan"]')?.scrollIntoView({ block: 'center' })`);
  await page.sleep(2500);
  await page.shot(join(out, 'rc-live-scanpath.png'));
} finally {
  await chrome.close();
  server.close();
}
if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nlive Reading Check passed');
