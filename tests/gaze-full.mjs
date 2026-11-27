// The whole content-script stack (lens + dock + eye tracking) on one page, with a
// fake camera frame. Checks the dock's eye-tracking controls and what Glider
// does (nothing of its own) when the tracker reports a struggle.
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
  const names = await page.eval(`[...__ll.root().querySelectorAll('.ll-name')].map((n) => n.textContent).join('|')`);
  check('the switch is called "Adaptive"; there is no separate eye tracking or adapt switch', /(^||)Adaptive(||$)/.test(names) && !/Eye tracking|Adapt ahead/.test(names), names);
  check('"See original" is folded away with the other details, and off', await page.eval(`__ll.q('.ll-gaze-original').hidden && !!__ll.q('[data-toggle="seeOriginal"]')`) && (await state()).seeOriginal === false && await page.eval(`GliderAdapt.mode() === 'off'`));

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
  // The camera box is hidden in Glider (camera: 'hidden'); the dock mark carries the status instead.
  await page.eval(`Glider.app.setOpen(false); 0`);   // close the panel: the mark is what the reader sees
  await page.sleep(500);
  const dot = await page.eval(`__ll.q('.ll-pill').dataset.gaze || ''`);
  check('no camera box: the dock mark shows the eye tracking status as a small dot (amber: needs calibrating)', dot === 'paused', dot);
  await page.shot(join(REPO, 'tests', 'out', 'gaze-minimal.png'));
  await page.eval(`Glider.app.setOpen(true); 0`);
  await page.sleep(500);
  check('Adaptive on: adapting the page is enabled too (learning), and "See original" shows under it', await page.eval(`GliderAdapt.mode() === 'learn' && !__ll.q('.ll-gaze-original').hidden`));
  await page.eval(`__ll.q('[data-toggle="seeOriginal"]').click()`);
  await page.sleep(300);
  check('the "See original" switch turns the setting on', (await state()).seeOriginal === true && await page.eval(`__ll.q('[data-toggle="seeOriginal"]').getAttribute('aria-checked') === 'true'`));
  await set({ seeOriginal: false }, 300);

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

  // The panel no longer acts on struggles (no word lens, no spacing card): only the simplifier changes the page, and only its wording.
  const quiet = await page.eval(`(() => { const t = __ll.q('.ll-tip'); return { handler: typeof Glider.app.onStruggle, tip: !t || t.hidden, eased: document.querySelectorAll('.glider-ease').length, note: !!__ll.q('.ll-eased') }; })()`);
  check('struggles: the panel opens no word lens and adds no spacing, card or note', quiet.handler === 'undefined' && quiet.tip && !quiet.eased && !quiet.note, JSON.stringify(quiet));
  const split = await page.eval(`JSON.stringify(GliderAdapt.rules().split)`);
  check('the layout rule (one part per line) is off: only wording changes', /"active":false/.test(split) && /layout-off/.test(split), split);

  await set({ on: false }, 900);
  check('lens off: tracker stops and its widget is gone', (await gaze()).status === 'idle' && !(await widget()));
  check('lens off: the page is exactly as it was', (await page.eval('document.body.innerHTML')) === baseline);
  await set({ on: true }, 1500);
  check('lens on again: tracker restarts (setting kept)', ['ready', 'tracking', 'starting'].includes((await gaze()).status), (await gaze()).status);
  await set({ gaze: false }, 600);
  check('eye tracking off: tracker idle, lens still on', (await gaze()).status === 'idle' && (await state()).on === true && !(await widget()));
  check('Adaptive off: adapting the page is off as well', await page.eval(`GliderAdapt.mode() === 'off'`));
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
