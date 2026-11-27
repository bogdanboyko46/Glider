// node tests/simplify.mjs [outDir] — the struggle -> simplify bridge in headless Chrome.
// Runs simplify/simplifier.js + simplify/bridge.js on the gaze test article with a fake chrome.* and a
// canned reply from the rewrite service, hands the bridge struggle events the way the tracker does, and checks the page.
import { join } from 'node:path';
import { launch, serve, REPO } from './cdp.mjs';

const out = process.argv[2] || join(REPO, 'tests', 'out');
let failed = 0;
const check = (ok, label, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  -> ' + detail : ''}`); if (!ok) failed += 1; };
const CANNED = 'Plants use stored energy to turn carbon dioxide into sugar. This is called the Calvin cycle. One enzyme starts it. It is very common, but it works slowly.';

const SETUP = `(async () => {
  window.__asked = [];
  window.__claude = { ok: true, text: ${JSON.stringify(CANNED)}, ms: 400, model: 'test' };
  chrome.runtime.sendMessage = (m) => {
    if (m.type === 'glider:simplify:status') return Promise.resolve({ ready: false, url: '' });   // no rewrite service configured
    __asked.push(m); return new Promise((r) => setTimeout(() => r(window.__claude), 400));
  };
  chrome.storage.onChanged = { addListener() {} };
  for (const src of ['simplify/simplifier.js', 'simplify/textscore.js', 'simplify/gate.js', 'simplify/bridge.js']) {
    await new Promise((ok, bad) => { const s = document.createElement('script'); s.src = '/glider-extension/' + src; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
  }
  // the "See original" mark is drawn by the lens stylesheet
  await new Promise((ok) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/glider-extension/content/content.css'; l.onload = ok; l.onerror = ok; document.head.appendChild(l); });
  window.__before = document.body.innerHTML;
  GliderSimplifyBridge._set({ gate: false });   // the first sections test the swap machinery itself, without the decision gate
  // A tracker-shaped struggle: time on the paragraph as a multiple of what this reader's pace predicts.
  window.__gated = (id, ratio, reason) => { const el = document.getElementById(id); const text = el.innerText.trim();
    return GliderSimplifyBridge.handleStruggle({ element: el, lineIndex: 1, lineText: text.slice(0, 80), paragraphText: text, reason: reason || 'slow-paragraph', severity: 0.6, coarse: true,
      metrics: { paragraphDwellMs: ratio * 10000, expectedParagraphMs: 10000, tau: 2, baselineWpm: 140, backtracks: 0 } }); };
  window.__struggle = (id) => { const el = document.getElementById(id); el.scrollIntoView({ block: 'center' }); const text = el.innerText.trim();
    GliderSimplifyBridge.handleStruggle({ element: el, lineIndex: 1, lineText: text.slice(0, 80), paragraphText: text, reason: 'stuck-line', severity: 0.6 }); };
  const KEYS = ['fontSize', 'fontFamily', 'lineHeight', 'letterSpacing', 'wordSpacing', 'color', 'backgroundColor', 'marginTop', 'marginBottom', 'paddingLeft', 'boxShadow', 'textAlign', 'animationName'];
  window.__look = (id) => { const el = document.getElementById(id), c = el.nextElementSibling;
    const is = !!c && c.hasAttribute('data-glider-simplified');
    const a = getComputedStyle(el), b = is ? getComputedStyle(c) : null;
    return { hidden: a.display === 'none', is, tag: is ? c.tagName : null, cls: is ? c.className : null, ownCls: el.className,
      text: is ? c.querySelector('.glider-simple__text').textContent : null, inner: is ? c.innerText.trim() : null,
      source: is ? (c.getAttribute('data-glider-source') || 'offline') : null, toggle: is ? !!c.querySelector('.glider-adapt-toggle') : null,
      style: is ? KEYS.filter((k) => a[k] !== b[k]).map((k) => k + ' ' + a[k] + ' -> ' + b[k]) : null,
      chrome: document.querySelectorAll('#glider-simplify-offer, .glider-simple__bar').length }; };
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

  // ---- offline: instant, in place, looking exactly like the paragraph it replaces
  const want2 = await offlineOf('p2');
  await page.eval(`__struggle('p2'); 0`);
  let s = await look('p2');
  check(s.hidden && s.is && s.tag === 'P' && s.cls === s.ownCls, 'struggle on a paragraph: the original is hidden and a stand-in <p> with its classes sits in its place');
  check(s.text === want2 && s.text !== (await page.eval(`document.getElementById('p2').innerText.trim()`)), 'the stand-in shows the simplified text at once', String(s.text).slice(0, 70) + '…');
  check(s.style.length === 0, 'seamless: same font, size, spacing, colour and margins as the paragraph it replaces, no animation', JSON.stringify(s.style));
  check(s.chrome === 0 && !s.toggle && s.inner === s.text, 'seamless: no label, no button, no prompt; nothing but the text');
  check((await page.eval('__asked.length')) === 0, 'nothing is sent anywhere when no rewrite service is set');
  await page.shot(join(out, 'simplify-offline.png'));

  // ---- "See original": only with the panel's switch on; a faint mark that puts the page back exactly
  await page.eval(`GliderSimplifyBridge._set({ seeOriginal: true }); 0`);
  s = await look('p2');
  check(s.toggle && s.inner === s.text, '"See original" switched on: a small mark at the end, adding no text');
  await page.shot(join(out, 'simplify-see-original.png'));
  await page.eval(`document.querySelector('[data-glider-simplified] .glider-adapt-toggle').click(); 0`);
  s = await look('p2');
  check(!s.hidden && !s.is && (await page.eval('document.body.innerHTML === __before')), '"See original": the page is exactly as it was');
  await page.eval(`GliderSimplifyBridge._set({ seeOriginal: false }); __struggle('p2'); 0`);
  check(!(await look('p2')).is, 'a paragraph the reader put back is not simplified again');

  // ---- with the rewrite service: the wording on screen never changes in front of the reader
  await page.eval(`GliderSimplifyBridge._set({ hasService: true }); __struggle('p1'); 0`);
  s = await look('p1');
  check(s.is && s.text === (await offlineOf('p1')), 'with the service: the quick version shows at once');
  await page.sleep(900);
  s = await look('p1');
  const asked = await page.eval('__asked');
  check(s.text === (await offlineOf('p1')) && s.source === 'offline', 'the Claude rewrite does not replace a paragraph that is on screen');
  check(asked.length === 1 && asked[0].type === 'glider:simplify' && asked[0].text.startsWith('Photosynthesis') && asked[0].lineText.length > 0, 'one request, carrying the paragraph and the hard line');

  // ---- cooldown, ineligible targets
  await page.eval(`GliderSimplifyBridge.restoreAll(); GliderSimplifyBridge._set({ hasService: false }); __struggle('p1'); __struggle('p3'); 0`);
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

  // ---- ahead: after a struggle, hard paragraphs below the window are simplified before the reader gets there
  await page.eval(`(() => { const sp = document.createElement('div'); sp.id = 'spacer'; sp.style.height = '2400px'; document.body.appendChild(sp);
    const easy = document.createElement('p'); easy.id = 'e1'; easy.textContent = 'Every morning the baker opens her shop before the sun comes up. She mixes flour, water and a little salt, then leaves the dough to rest.'; document.body.appendChild(easy);
    for (let k = 1; k <= 5; k++) { const p = document.getElementById('p3').cloneNode(true); p.id = 'a' + k; document.body.appendChild(p); } })()`);
  await page.eval(`GliderSimplifyBridge._set({ hasService: true }); __asked.length = 0; __struggle('p3'); 0`);   // (p2 was put back above: it is left alone)
  await page.sleep(1400);
  const ahead = await page.eval(`['a1','a2','a3','a4','a5','e1'].map((id) => __look(id).is)`);
  check(ahead.slice(0, 3).every(Boolean) && !ahead[3] && !ahead[4], 'ahead: the next three hard paragraphs below the window are simplified already', JSON.stringify(ahead));
  check(!ahead[5], 'ahead: an easy paragraph is left as it is', JSON.stringify(ahead));
  s = await look('a1');
  check(s.text === CANNED && s.source === 'claude', 'ahead: off screen, the Claude rewrite is used', s.source);
  await page.eval(`document.getElementById('a3').nextElementSibling.scrollIntoView({ block: 'end' }); 0`);
  await page.sleep(1400);
  const more = await page.eval(`['a4','a5'].map((id) => __look(id).is)`);
  check(more.every(Boolean), 'ahead: scrolling on brings the next ones', JSON.stringify(more));

  // ---- putting one back stops the look-ahead on this page
  await page.eval(`GliderSimplifyBridge.restoreAll(); GliderSimplifyBridge._set({ seeOriginal: true, hasService: false }); 0`);
  await page.sleep(2600);   // past the cooldown
  await page.eval(`__struggle('p1'); 0`);
  await page.eval(`document.getElementById('p1').nextElementSibling.querySelector('.glider-adapt-toggle').click(); window.scrollTo(0, 0); GliderSimplifyBridge.runAhead(); 0`);
  check(await page.eval(`GliderSimplifyBridge.ahead() === false && !__look('a1').is`), 'after "See original" nothing more is changed ahead of the reader');
  await page.eval(`GliderSimplifyBridge.restoreAll(); ['spacer','e1','a1','a2','a3','a4','a5'].forEach((id) => document.getElementById(id).remove()); GliderSimplifyBridge._set({ seeOriginal: false }); window.scrollTo(0, 0); 0`);

  // ---- the decision gate: gentle help first, then the swap, in place, without asking
  await page.eval(`GazeReader.start().then(() => GazeReader.stop()); 0`);   // a new reading session (look-ahead state cleared)
  await page.sleep(1200);
  await page.eval(`GliderSimplifyBridge._set({ gate: true }); 0`);
  const ret = await page.eval(`String(__gated('p3', 2.1))`);
  let dec = await page.eval('JSON.stringify(GliderSimplifyBridge.lastDecision())');
  check(!(await look('p3')).is && /"gentle"/.test(dec) && ret === 'undefined', 'gate: the first sign of a slow paragraph changes nothing here (left to the gentle help)', dec);
  await page.eval(`__gated('p3', 2.9); __gated('p3', 4.0); 0`);
  dec = await page.eval('JSON.stringify(GliderSimplifyBridge.lastDecision())');
  check(!(await look('p3')).is, 'gate: struggle events alone never change the text, however many', dec);
  await page.eval(`GliderSimplifyBridge.restoreAll(); 0`);

  const easy = await page.eval(`(() => { const p = document.createElement('p'); p.id = 'easy'; p.textContent = 'Every morning the baker opens her shop before the sun comes up. She mixes flour, water and a little salt, then leaves the dough to rest. While it rises, she sweeps the floor.'; document.body.appendChild(p); __gated('easy', 3); __gated('easy', 6); const d = GliderSimplifyBridge.lastDecision(); p.remove(); return d.action + ' ' + d.why; })()`);
  check(/^none text:/.test(easy), 'gate: easy text is never changed, however long the reader spends on it', easy);

  await page.sleep(13000);   // past the pause the gate keeps between two actions
  // The tracker's once-a-second sample: 45 s spent, half-way through a paragraph expected to take 12 s in all (pace 7.5; the bar is higher here because the "See original" clicks above taught the gate to wait longer).
  await page.eval(`(() => { const p = document.getElementById('p2').cloneNode(true); p.id = 'p2b'; document.body.appendChild(p);
    window.__pace = (b) => GliderSimplifyBridge.handleProgress({ element: p, paragraphDwellMs: 45000, expectedParagraphMs: 12000, progress: 0.5, coarse: true, baselineWpm: b === undefined ? 140 : b }); __pace(); })()`);
  check(!(await look('p2b')).is, 'gate: a very slow pace changes nothing at first');
  await page.sleep(2000);
  await page.eval(`__pace(); 0`);
  check(!(await look('p2b')).is, 'gate: two seconds of slow pace is not enough');
  await page.sleep(2600);
  await page.eval(`__pace(); 0`);
  s = await look('p2b');
  dec = await page.eval('JSON.stringify(GliderSimplifyBridge.lastDecision())');
  check(s.is && s.chrome === 0, 'gate: the pace stayed slow for four seconds, so the paragraph is simplified in place', dec);
  await page.eval(`GliderSimplifyBridge.restoreAll(); document.getElementById('p2b').remove(); 0`);
  // Without a measured reading pace the "expected time" is a guess: the text is never changed on it.
  await page.sleep(13000);
  await page.eval(`(() => { const p = document.getElementById('p2').cloneNode(true); p.id = 'p2c'; document.body.appendChild(p);
    window.__pace0 = () => GliderSimplifyBridge.handleProgress({ element: p, paragraphDwellMs: 45000, expectedParagraphMs: 12000, progress: 0.5, coarse: true, baselineWpm: null }); __pace0(); })()`);
  await page.sleep(4600);
  await page.eval(`__pace0(); 0`);
  dec = await page.eval('JSON.stringify(GliderSimplifyBridge.lastDecision())');
  check(!(await look('p2c')).is, 'gate: with no measured reading pace, nothing is changed however slow', dec);
  await page.eval(`GliderSimplifyBridge.restoreAll(); document.getElementById('p2c').remove(); GliderSimplifyBridge._set({ gate: false }); 0`);

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
