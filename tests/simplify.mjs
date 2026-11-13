// node tests/simplify.mjs [outDir] — the struggle -> simplify bridge in headless Chrome.
// Runs simplify/simplifier.js + simplify/bridge.js on the gaze test article with a fake chrome.* and a
// canned "Claude" reply, hands the bridge struggle events the way the tracker does, and checks the page.
import { join } from 'node:path';
import { launch, serve, REPO } from './cdp.mjs';

const out = process.argv[2] || join(REPO, 'tests', 'out');
let failed = 0;
const check = (ok, label, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  -> ' + detail : ''}`); if (!ok) failed += 1; };
const CANNED = 'Plants use stored energy to turn carbon dioxide into sugar. This is called the Calvin cycle. One enzyme starts it. It is very common, but it works slowly.';

const SETUP = `(async () => {
  window.__asked = [];
  window.__claude = { ok: true, text: ${JSON.stringify(CANNED)}, ms: 400, model: 'test' };
  chrome.runtime.sendMessage = (m) => { __asked.push(m); return new Promise((r) => setTimeout(() => r(window.__claude), 400)); };
  chrome.storage.onChanged = { addListener() {} };
  for (const src of ['simplify/simplifier.js', 'simplify/bridge.js']) {
    await new Promise((ok, bad) => { const s = document.createElement('script'); s.src = '/glider-extension/' + src; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
  }
  window.__before = document.body.innerHTML;
  window.__struggle = (id) => { const el = document.getElementById(id); const text = el.innerText.trim();
    GliderSimplifyBridge.handleStruggle({ element: el, lineIndex: 1, lineText: text.slice(0, 80), paragraphText: text, reason: 'stuck-line', severity: 0.6 }); };
  window.__look = (id) => { const el = document.getElementById(id), c = el.nextElementSibling;
    const is = !!c && c.hasAttribute('data-glider-simplified');
    return { hidden: getComputedStyle(el).display === 'none', is, tag: is ? c.tagName : null,
      text: is ? c.querySelector('.glider-simple__text').textContent : null, inner: is ? c.innerText.trim() : null,
      label: is ? c.querySelector('.glider-simple__bar').shadowRoot.querySelector('.bar > span').textContent : null,
      source: is ? c.getAttribute('data-glider-source') : null,
      px: is ? parseFloat(getComputedStyle(c).fontSize) : null, basePx: parseFloat(getComputedStyle(document.getElementById('p3')).fontSize) }; };
  return typeof GliderSimplifyBridge === 'object' && typeof GliderSimplify === 'object';
})()`;

const { server, origin } = await serve();
const chrome = await launch({ width: 1100, height: 900 });
try {
  const page = await chrome.page();
  await page.goto(`${origin}/tests/gaze-site/harness.html`, 600);
  check(await page.eval(SETUP), 'simplifier and bridge load next to the tracker');
  const look = (id) => page.eval(`__look('${id}')`);
  const offlineOf = (id) => page.eval(`GliderSimplify.simplify(document.getElementById('${id}').innerText).text`);

  // ---- offline: instant, in place, larger
  const want2 = await offlineOf('p2');
  await page.eval(`__struggle('p2'); 0`);
  let s = await look('p2');
  check(s.hidden && s.is && s.tag === 'P', 'struggle on a paragraph: the original is hidden and a stand-in <p> sits in its place');
  check(s.text === want2 && s.text !== (await page.eval(`document.getElementById('p2').innerText.trim()`)), 'the stand-in shows the simplified text at once', String(s.text).slice(0, 70) + '…');
  check(s.inner === s.text, 'the control bar adds nothing to the paragraph text (kept in a shadow root)');
  check(Math.abs(s.px - s.basePx * 1.2) < 0.6, `text is enlarged 1.2x (${s.basePx}px -> ${s.px}px)`);
  check(s.label === 'Simplified' && s.source === 'offline', 'labelled "Simplified"');
  check((await page.eval('__asked.length')) === 0, 'nothing is sent anywhere without an API key');
  await page.sleep(600);
  await page.shot(join(out, 'simplify-offline.png'));

  // ---- show original puts the page back exactly, and that paragraph is then left alone
  await page.eval(`document.querySelector('[data-glider-simplified] .glider-simple__bar').shadowRoot.querySelector('button').click(); 0`);
  s = await look('p2');
  check(!s.hidden && !s.is && (await page.eval('document.body.innerHTML === __before')), '"Show original": the page is exactly as it was');
  await page.eval(`GliderSimplifyBridge._set({}); __struggle('p2'); 0`);
  check(!(await look('p2')).is, 'a paragraph the reader put back is not simplified again');

  // ---- with a key: offline text first, then the Claude rewrite replaces it
  await page.eval(`GliderSimplifyBridge._set({ hasKey: true }); __struggle('p1'); 0`);
  s = await look('p1');
  check(s.is && s.text === (await offlineOf('p1')) && /improving/.test(s.label), 'with a key: offline text shows immediately while Claude works', s.label);
  await page.sleep(900);
  s = await look('p1');
  const asked = await page.eval('__asked');
  check(s.text === CANNED && s.label === 'Simplified by Claude' && s.source === 'claude', 'the Claude rewrite replaces it in place');
  check(asked.length === 1 && asked[0].type === 'glider:simplify' && asked[0].text.startsWith('Photosynthesis') && asked[0].lineText.length > 0, 'one request, carrying the paragraph and the hard line');
  await page.shot(join(out, 'simplify-claude.png'));

  // ---- Claude fails: the offline text simply stays
  await page.eval(`window.__claude = { ok: false, reason: 'network' }; GliderSimplifyBridge._set({}); __struggle('p3'); 0`);
  await page.sleep(900);
  s = await look('p3');
  check(s.is && s.text === (await offlineOf('p3')) && s.label === 'Simplified', 'when Claude cannot be reached the offline version stays');

  // ---- cooldown, ineligible targets
  await page.eval(`GliderSimplifyBridge.restoreAll(); GliderSimplifyBridge._set({ hasKey: false }); __struggle('p1'); __struggle('p3'); 0`);
  check((await look('p1')).is && !(await look('p3')).is, 'two struggles in quick succession simplify only one paragraph');
  const h1 = await page.eval(`(() => { GliderSimplifyBridge._set({}); GliderSimplifyBridge.handleStruggle({ element: document.querySelector('h1') }); return !!document.querySelector('h1 + [data-glider-simplified]'); })()`);
  check(!h1, 'headings are never replaced');
  const again = await page.eval(`(() => { GliderSimplifyBridge._set({}); const c = document.querySelector('[data-glider-simplified]'); GliderSimplifyBridge.handleStruggle({ element: c }); return document.querySelectorAll('[data-glider-simplified]').length; })()`);
  check(again === 1, 'a stand-in is never simplified again');

  // ---- tracker stops: everything goes back
  await page.eval(`GazeReader.start().then(() => GazeReader.stop()); 0`);
  await page.sleep(1200);
  const clean = await page.eval(`document.querySelectorAll('[data-glider-simplified], [data-glider-hidden]').length`);
  check(clean === 0, 'when eye tracking stops, every paragraph is restored');

  // ---- switched off in settings
  await page.eval(`GliderSimplifyBridge._set({ enabled: false }); __struggle('p3'); 0`);
  check(!(await look('p3')).is, 'switched off in settings: struggles are ignored');
  check(page.errors.length === 0, 'no page errors', JSON.stringify(page.errors).slice(0, 400));
} finally {
  await chrome.close();
  server.close();
}
if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nsimplify bridge checks passed');
