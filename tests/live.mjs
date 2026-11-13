// Loads the real unpacked extension into a throwaway Chrome and exercises it
// on a live site (default: a long Wikipedia article).
//   node tests/live.mjs [outDir] [url]
import { join } from 'node:path';
import { launch, IN_PAGE, REPO } from './cdp.mjs';

const out = process.argv[2] || join(REPO, 'tests', 'out');
const url = process.argv[3] || 'https://en.wikipedia.org/wiki/Epistemology';

const chrome = await launch({ width: 1366, height: 820, extension: true });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };

try {
  const page = await chrome.page();
  await page.sleep(1500); // let the service worker register
  await page.goto(url, 2500);
  await page.eval(IN_PAGE);
  await page.eval(`window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] }); 0`);

  const rect = (sel) => page.eval(`__ll.rect(${JSON.stringify(sel)})`);
  const clickSel = async (sel, wait = 400) => { const r = await rect(sel); if (!r) throw new Error('missing ' + sel); await page.click(r.cx, r.cy); await page.sleep(wait); };
  const count = (sel) => page.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

  check('extension injected the dock', await page.eval(`!!document.querySelector('#glider-root') && !!document.querySelector('#glider-root').shadowRoot`));
  const words = await page.eval(`document.body.innerText.split(/\\s+/).length`);
  console.log('page words:', words);
  await page.shot(join(out, 'live-00-pill.png'));

  check('dock font loaded from the extension', await page.eval(`document.fonts.check('13px "Glider Atkinson"')`));
  check('no voice code in the extension build', await page.eval(`!__ll.root().querySelector('[data-say], [data-action="play"]')`));

  // The lens is on by default: everything applies without a click.
  await page.sleep(800);
  const t1 = await count('.glider-token');
  check('lens on by default: tokens near the viewport only (lazy)', t1 > 100 && t1 < words * 0.6, `${t1} tokens of ~${words} words`);
  await page.move(700, 420);
  await page.sleep(500);
  await page.shot(join(out, 'live-01-on.png'));
  console.log('long tasks after load (ms):', await page.eval('JSON.stringify(window.__long)'));

  await page.eval(`window.__long.length = 0; scrollTo({ top: 6000 }); 0`);
  await page.sleep(1200);
  const t2 = await count('.glider-token');
  check('scrolling tokenises more text', t2 > t1, `${t1} -> ${t2}`);
  console.log('long tasks while scrolling (ms):', await page.eval('JSON.stringify(window.__long)'));
  await page.eval(`scrollTo({ top: 0 }); 0`);
  await page.sleep(500);

  const tok = await page.eval(`(() => { const t = [...document.querySelectorAll('.glider-long')].find((el) => { const r = el.getBoundingClientRect(); return r.top > 220 && r.top < 560 && r.left > 60 && r.left < 800 && el.textContent.length > 9; }); return t ? __ll.rect(t) : null; })()`);
  if (tok) { await page.move(tok.cx, tok.cy); await page.sleep(700); }
  check('hover lens appears on a live page', await page.eval(`!__ll.q('.ll-tip').hidden && __ll.q('.ll-tip').querySelectorAll('.ll-syl, .ll-part').length > 1`));
  await page.sleep(900);
  const said = await page.eval(`[...__ll.q('.ll-tip').querySelectorAll('.ll-part')].map((e) => e.textContent).join(' ')`);
  check('the service worker answers with the sound of each part', said.split(' ').length > 1, said);
  check('the lens has Hear word and Sound it out', await page.eval(`!!__ll.q('.ll-tip [data-say="word"]') && !__ll.q('.ll-tip [data-say="slow"]').hidden`));
  await page.shot(join(out, 'live-02-hover.png'));
  await page.move(30, 600);
  await page.sleep(500);

  await clickSel('.ll-pill-main');

  const before = await count('.glider-wrap');
  await page.eval(`window.__long.length = 0; 0`);
  await clickSel('.ll-head [data-toggle="on"]', 1200);
  check('switching off removes every wrapper on a live page', (await count('.glider-wrap')) === 0 && (await count('.glider-token')) === 0, `had ${before}`);
  check('switching off clears page classes', await page.eval(`![...document.documentElement.classList].some((c) => c.startsWith('glider-'))`));
  await page.shot(join(out, 'live-04-off.png'));
  await clickSel('.ll-head [data-toggle="on"]', 1200);
  check('switching on again re-applies', (await count('.glider-token')) > 100);
  console.log('long tasks for off + on (ms):', await page.eval('JSON.stringify(window.__long)'));

  const errs = page.errors.filter((e) => /glider/i.test(e));
  check('no Glider errors in the page console', errs.length === 0, errs.join(' || '));
  console.log('all console issues on page (site + extension):', page.errors.length);
} catch (error) {
  failed += 1;
  console.log('FAIL  run completed -> ' + (error.stack || error));
} finally {
  await chrome.close();
}
process.exit(failed ? 1 : 0);
