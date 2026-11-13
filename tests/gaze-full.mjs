// The whole content-script stack (lens + dock + eye tracking) on one page, with a
// fake camera frame. Checks the dock's eye-tracking controls and what Glider
// does when the tracker reports a struggle.
//   node tests/gaze-full.mjs
import { join } from 'node:path';
import { launch, serve, IN_PAGE, REPO } from './cdp.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

const { server, origin } = await serve();
const chrome = await launch({ width: 1280, height: 800 });
try {
  const page = await chrome.page();
  const URL_ = `${origin}/tests/gaze-site/full.html`;
  await page.goto(URL_, 800);
  await page.eval(`localStorage.clear(); localStorage.setItem('glider:settings:v2', JSON.stringify({ on: false })); 0`);
  await page.goto(URL_, 1200);
  await page.eval(IN_PAGE);
  const baseline = await page.eval('document.body.innerHTML');
  const state = () => page.eval('JSON.parse(JSON.stringify(Glider.app.state))');
  const set = async (patch, wait = 600) => { await page.eval(`Glider.app.update(${JSON.stringify(patch)})`); await page.sleep(wait); };
  const gaze = () => page.eval('GazeReader.getState()');
  const widget = () => page.eval(`!!document.querySelector('[data-gaze-reader]')`);

  check('eye tracking is off by default and the camera is not opened', (await state()).gaze === false && (await gaze()).status === 'idle' && !(await widget()));
  await set({ on: true }, 900);
  await page.eval(`__ll.q('.ll-pill-main').click()`);
  await page.sleep(400);
  check('the panel shows the eye tracking switch, its details folded away', await page.eval(`!__ll.q('.ll-gaze').hidden && !!__ll.q('[data-toggle="gaze"]') && __ll.q('.ll-gaze-sliders').hidden`));

  await page.eval(`__ll.q('[data-toggle="gaze"]').click()`);
  await page.sleep(1500);
  const g1 = await gaze();
  check('the switch starts the tracker', (await state()).gaze === true && g1.status === 'ready', g1.status);
  const statusText = await page.eval(`__ll.q('.ll-gaze-status').textContent`);
  check('status line asks for calibration', /calibrate/i.test(statusText), statusText);
  const p = await page.eval(`__ll.rect('.ll-panel')`);
  const scroll = await page.eval(`(() => { const b = __ll.q('.ll-body'); return b.scrollHeight - b.clientHeight; })()`);
  check('panel with eye tracking on fits on screen, nothing to scroll', p.y >= 0 && p.y + p.h <= 800 && p.x >= 0 && p.x + p.w <= 1280 && scroll <= 0, JSON.stringify(p) + ' scroll ' + scroll);
  await page.shot(join(REPO, 'tests', 'out', 'gaze-panel.png'));

  const tau0 = (await gaze()).tau;
  await set({ gazeSensitivity: 5 }, 300);
  const tau1 = (await gaze()).tau;
  await set({ gazeSensitivity: 1 }, 300);
  const tau2 = (await gaze()).tau;
  check('the Help slider moves tau (Often lowers it, Rarely raises it)', tau1 < tau0 && tau2 > tau0, `${tau1} < ${tau0} < ${tau2}`);
  await set({ gazeSensitivity: 3 }, 300);

  await page.eval(`__ll.q('[data-action="gaze-calibrate"]').click()`);
  await page.sleep(700);
  const calib = await page.eval(`(() => { const r = document.querySelector('[data-gaze-reader]').shadowRoot; return { show: r.getElementById('calib').classList.contains('show'), text: r.getElementById('instr').innerText.slice(0, 40) }; })()`);
  check('Calibrate opens the calibration screen and minimises the panel', calib.show && /Calibrate eye tracking/.test(calib.text) && await page.eval(`__ll.q('.ll-dock').dataset.open === 'false'`), JSON.stringify(calib));
  await page.key('Escape');
  await page.sleep(500);
  check('Esc cancels calibration', await page.eval(`!document.querySelector('[data-gaze-reader]').shadowRoot.getElementById('calib').classList.contains('show')`));

  // A struggle report, as GazeReader would send it, for the second line of p2.
  const detail = `(() => { const el = document.getElementById('p2'); const r = document.createRange(); r.selectNodeContents(el); const lines = GazeCore.mergeLineRects(r.getClientRects()); return { element: el, lineIndex: 1, lineRect: lines[1], lineText: '', paragraphText: el.textContent, severity: 0.5, metrics: {} }; })()`;
  await page.eval(`Glider.app.onStruggle({ ...${detail}, reason: 'stuck-line' }); 0`);
  await page.sleep(500);
  const tip = await page.eval(`(() => { const t = __ll.q('.ll-tip'); const tok = Glider.app.tip.token; const line = ${detail}.lineRect; const r = tok && tok.getClientRects()[0]; return { hidden: t.hidden, syls: t.querySelectorAll('.ll-syl, .ll-part').length, word: tok && tok.textContent, onLine: !!r && (r.top + r.bottom) / 2 >= line.top - 4 && (r.top + r.bottom) / 2 <= line.bottom + 4, help: Glider.app.gazeHelp }; })()`);
  check('stuck line: the syllable lens opens on the hardest word of that line', !tip.hidden && tip.syls > 1 && tip.onLine && tip.help.count === 1, JSON.stringify(tip));
  await page.eval(`Glider.app.onStruggle({ ...${detail}, reason: 'rereading' }); 0`);
  await page.sleep(500);
  const eased = await page.eval(`(() => { const a = getComputedStyle(document.getElementById('p2')), b = getComputedStyle(document.getElementById('p1')); return { cls: document.getElementById('p2').classList.contains('glider-ease'), ws: [a.wordSpacing, b.wordSpacing], lh: [a.lineHeight, b.lineHeight] }; })()`);
  check('re-reading: that paragraph gets wider spacing', eased.cls && parseFloat(eased.ws[0]) > parseFloat(eased.ws[1]) && parseFloat(eased.lh[0]) > parseFloat(eased.lh[1]), JSON.stringify(eased));

  await set({ on: false }, 900);
  check('lens off: tracker stops and its widget is gone', (await gaze()).status === 'idle' && !(await widget()));
  check('lens off: the page is exactly as it was', (await page.eval('document.body.innerHTML')) === baseline);
  await set({ on: true }, 1500);
  check('lens on again: tracker restarts (setting kept)', ['ready', 'tracking', 'starting'].includes((await gaze()).status), (await gaze()).status);
  await set({ gaze: false }, 600);
  check('eye tracking off: tracker idle, lens still on', (await gaze()).status === 'idle' && (await state()).on === true && !(await widget()));
  check('no page errors or warnings', page.errors.length === 0, page.errors.slice(0, 5).join(' || '));
} catch (error) {
  check('test run completed', false, error.stack || String(error));
} finally {
  await chrome.close();
  server.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
