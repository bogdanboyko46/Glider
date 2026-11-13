// Real app, finale (scenes 5 and 6 in one take): the real lens, dock, eye tracker and simplifier.
// A scripted reader reads the first paragraph at an even rhythm, slows on a hard sentence and keeps
// jumping back to its start, and the product does what it really does: marks the lines, offers a simpler
// version and, because this reader chose automatic mode, swaps it in. Then the reader reads on.
//
// Stand-ins, and only these:
//   - the camera: showcase/app-gaze-cam.html shows a generated picture of a student and turns the scripted
//     gaze point into the feature numbers the real camera frame would send
//   - the amber ring, trail and "your eyes" label: drawn where the scripted reader is looking
//   - a fast reading pace on file, so that the stall registers within the few seconds a clip allows
//   - the hard paragraph is a single sentence, and the tracker is asked to mark the whole paragraph
//     (markWholeBlock), so the mark and the rewrite cover the complete sentence
//   - by default the dock's gentle help (spacing ease, syllable lens) is switched off for this take so that
//     only the mark and the simpler text appear; FULL=1 leaves it on, as in normal use
//   node showcase/real-r56.mjs          then: python showcase/real2gif.py r56
//   FULL=1 node showcase/real-r56.mjs   then: python showcase/real2gif.py r56-full
import { capture } from './capture.mjs';

const FULL = process.env.FULL === '1';
const FRAME = `document.querySelector('[data-gaze-reader]').shadowRoot.querySelector('iframe').contentWindow`;
const CAL = `(() => { const h = document.querySelector('[data-gaze-reader]'); if (!h) return null; const r = h.shadowRoot;
  const d = r.getElementById('cdot'), i = r.getElementById('instr');
  return { dot: d.style.display === 'block' ? [parseFloat(d.style.left), parseFloat(d.style.top)] : null,
           card: i.style.display !== 'none' ? i.innerText.slice(0, 40) : '', status: GazeReader.getState().status, done: !!window.__calDone, err: window.__calErr || null }; })()`;

const READER = `(async () => {
  const fw = ${FRAME};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mk = (css) => { const d = document.createElement('div'); d.setAttribute('data-glider-ignore', ''); d.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;z-index:2147483645;' + css; document.documentElement.appendChild(d); return d; };
  // where the scripted reader is looking: an amber ring, a short fading trail, and a label the first time it appears
  const trail = [];   // no trail: the marker is one crisp shape
  const ring = mk('width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;box-sizing:border-box;border:3px solid #c98a12;background:transparent;transition:transform 60ms linear;transform:translate(-100px,-100px)');
  const label = mk('margin:-38px 0 0 -34px;padding:4px 9px;border-radius:999px;background:#e0a52b;color:#2b2208;font:700 12px/1 Segoe UI,system-ui,sans-serif;white-space:nowrap;transition:transform 60ms linear,opacity .5s ease;transform:translate(-100px,-100px)');
  label.textContent = 'your eyes';
  const past = [];
  const linesOf = (el) => { const r = document.createRange(); r.selectNodeContents(el); return GazeCore.mergeLineRects(r.getClientRects()); };
  const stand = () => document.querySelector('[data-glider-simplified]');
  let stop = () => false;
  const lookAt = async (x, y, dur) => {
    fw.trueGaze.x = x; fw.trueGaze.y = y;
    past.unshift([x, y]); past.length = Math.min(past.length, 7);
    trail.forEach((d, i) => { const p = past[i + 1]; d.style.transform = p ? 'translate(' + p[0] + 'px,' + p[1] + 'px)' : 'translate(-100px,-100px)'; });
    ring.style.transform = label.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    await sleep(dur);
    return !stop();
  };
  const look = async (el, line, frac, dur) => {
    const L = linesOf(el); if (!L.length) return false;
    const l = L[Math.min(line, L.length - 1)];
    return lookAt(l.left + (l.right - l.left) * frac + (Math.random() - .5) * 5, (l.top + l.bottom) / 2 + (Math.random() - .5) * 3, dur);
  };
  // steady left-to-right fixations along one line
  const readLine = async (el, line, n, dur, from = .04, to = .96) => { for (let k = 0; k < n; k++) if (!(await look(el, line, from + (to - from) * (n === 1 ? .5 : k / (n - 1)), dur))) return false; return true; };
  window.__log = [];
  const t0 = performance.now();
  const mark = (what) => __log.push([Math.round(performance.now() - t0), what]);
  setTimeout(() => { label.style.opacity = '0'; }, 2600);

  const p1 = document.getElementById('p1'), p2 = document.getElementById('p2'), p3 = document.getElementById('p3');
  // The hard sentence is the whole second paragraph: it starts at the start of its first line.
  const hardStart = () => ({ line: 0, frac: .04 });
  const unusedHardStart = () => {
    const L = linesOf(p2);
    const tok = [...p2.querySelectorAll('.glider-token')].find((t) => t.textContent === 'Inside');
    const r = tok && tok.getBoundingClientRect();
    if (!r || !L.length) return { line: 1, frac: .5 };
    const cy = (r.top + r.bottom) / 2;
    let line = 0; L.forEach((l, i) => { if (cy >= l.top && cy <= l.bottom) line = i; });
    return { line, frac: Math.max(0, Math.min(1, (r.left + 8 - L[line].left) / (L[line].right - L[line].left))) };
  };

  // 1. plain reading: an even rhythm, line after line
  for (let i = 0; i < linesOf(p1).length; i++) await readLine(p1, i, 5, 175);
  mark('second paragraph');
  const t2 = performance.now();
  stop = () => !!stand() || performance.now() - t2 > 17000;
  let go = true;
  const seg = async (line, n, dur, a, b) => { if (go) go = await readLine(p2, line, n, dur, a, b); };
  let h = hardStart();
  // 2. the hard sentence: slower, then back to its start, again and again
  mark('hard sentence starts at line ' + h.line + ', ' + h.frac.toFixed(2));
  const pass = async (dur, last) => {
    h = hardStart();
    for (let l = 0; go && l <= last; l++) await seg(l, l === last && last < 2 ? 3 : 5, dur, .04, l === last && last < 2 ? .6 : .96);
  };
  await pass(300, 1);
  mark('back 1'); await pass(320, 2);
  mark('back 2'); await pass(330, 2);
  for (let round = 0; go && round < 6; round++) { mark('back'); await pass(340, 2); }
  stop = () => false;
  const s = stand();
  mark(s ? 'simplified text is in' : 'no swap');
  if (s) {
    const body = s.querySelector('.glider-simple__text') || s;
    await look(body, 0, .02, 700);                      // a beat: the new text has just arrived
    const n = linesOf(body).length;
    for (let i = 0; i < n; i++) await readLine(body, i, 5, 165);
  }
  await readLine(p3, 0, 4, 170);
  mark('done');
  window.__readerDone = true;
})()`;

await capture({
  name: FULL ? 'r56-full' : 'r56', url: '/showcase/app-gaze.html', width: 1000, height: 625, seconds: 21, settle: 2500,
  before: async (page) => {
    // Eye calibration happens off camera: follow the real calibration dots with the simulated eyes.
    for (let i = 0; i < 60 && !['ready', 'tracking'].includes(await page.eval('GazeReader.getState().status')); i++) await page.sleep(200);
    await page.eval(`${FRAME}.trueGaze.W = innerWidth; ${FRAME}.trueGaze.H = innerHeight; GazeReader.init({ settleMs: 250, sampleMs: 420, markWholeBlock: true });
      GazeReader.calibrate({ baseline: false }).then(() => { window.__calDone = 1; }, (e) => { window.__calErr = String(e); }); 0`);
    let lastCard = '';
    for (let i = 0; i < 1500; i++) {
      const st = await page.eval(CAL);
      if (!st) { await page.sleep(100); continue; }
      if (st.err) throw new Error('calibration failed: ' + st.err);
      if (st.done) break;
      if (st.dot) await page.eval(`Object.assign(${FRAME}.trueGaze, { x: ${st.dot[0]}, y: ${st.dot[1]} }); 0`);
      if (st.card && st.card !== lastCard) { lastCard = st.card; await page.sleep(250); await page.key(' ', { code: 'Space' }); }
      await page.sleep(40);
    }
    const state = await page.eval('JSON.stringify({ s: GazeReader.getState().status, acc: GazeReader.getState().accuracy && [GazeReader.getState().accuracy.effX, GazeReader.getState().accuracy.effY], base: GazeReader.getState().baseline && GazeReader.getState().baseline.wpm, simplify: GliderSimplifyBridge.config() })');
    console.log('before recording:', state);
    if (!FULL) await page.eval(`Glider.app.onStruggle = () => {}; 0`);   // the dock's spacing ease and syllable lens stay out of this take
    await page.eval(`${FRAME}.trueGaze.x = 200; ${FRAME}.trueGaze.y = 130; scrollTo(0, 0); 0`);
    await page.sleep(1200);   // let the tracker settle
  },
  run: async (page, { sleep }) => {
    await page.eval(`window.__readerDone = false; ${READER}; 0`);
    for (let i = 0; i < 230 && !(await page.eval('!!window.__readerDone')); i++) await sleep(100);
    await sleep(700);
    console.log('reader log (ms):', await page.eval('JSON.stringify(window.__log)'));
    console.log('last simplify decision:', await page.eval('JSON.stringify(GliderSimplifyBridge.lastDecision())'));
    console.log('dock help:', await page.eval('JSON.stringify(Glider.app.gazeHelp)'));
  },
});
