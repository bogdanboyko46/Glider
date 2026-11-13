// node tests/assessment.mjs [outDir] — Reading Check page in headless Chrome (served over localhost, no camera).
// Renders the demo dashboard and its degraded variants, checks for errors and broken numbers, takes screenshots.
import { join } from 'node:path';
import { launch, serve, REPO } from './cdp.mjs';

const out = process.argv[2] || join(REPO, 'tests', 'out');
const W = 1360, H = 900;
let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); if (!ok) failed += 1; };

const { server, origin } = await serve();
const chrome = await launch({ width: W, height: H });
const base = `${origin}/glider-extension/assessment/assessment.html`;
try {
  const page = await chrome.page();
  const text = () => page.eval(`document.getElementById('rc-root').innerText`);
  const broken = (t) => /\bNaN\b|undefined|\bnull\b|Infinity|\[object /.test(t);

  // ---- the full demo dashboard
  await page.goto(`${base}?demo=1`, 1800);
  check(page.errors.length === 0, `demo: no errors ${JSON.stringify(page.errors).slice(0, 400)}`);
  const info = await page.eval(`(() => {
    const m = performance.getEntriesByName('rc-dashboard-rendered')[0];
    const nav = performance.getEntriesByType('navigation')[0];
    return { rendered: m ? Math.round(m.startTime) : -1, dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : -1,
      svgs: document.querySelectorAll('#rc-root svg').length, sections: document.querySelectorAll('#rc-root section').length,
      buttons: document.querySelectorAll('#rc-root button').length, height: document.documentElement.scrollHeight,
      overflowX: document.documentElement.scrollWidth > innerWidth + 1 };
  })()`);
  console.log('     ', JSON.stringify(info));
  check(info.rendered > 0 && info.rendered < 1000, `demo: dashboard rendered ${info.rendered} ms after navigation (< 1000)`);
  check(info.svgs >= 6 && info.sections >= 8, `demo: ${info.sections} sections, ${info.svgs} charts`);
  check(!info.overflowX, 'demo: no horizontal overflow');
  const demoText = await text();
  check(!broken(demoText), 'demo: no NaN / undefined / null in visible text');
  check(/not a diagnosis/i.test(demoText), 'demo: disclaimer is shown');
  check(!/you have dyslexia|probability of dyslexia|% (chance|likel)/i.test(demoText), 'demo: no diagnostic wording');
  check(/Delete my data/i.test(demoText) && /Download/i.test(demoText) && /Apply recommended settings/i.test(demoText), 'demo: export, delete and apply-settings controls exist');
  for (let y = 0, i = 0; y < info.height && i < 12; y += H - 60, i += 1) {
    await page.eval(`window.scrollTo(0, ${y})`);
    await page.sleep(350);
    await page.shot(join(out, `rc-demo-${String(i).padStart(2, '0')}.png`));
  }

  // ---- apply recommended settings (no chrome.storage here: the bridge reports what it would apply)
  await page.eval(`(() => { const b = [...document.querySelectorAll('#rc-root button')].find((x) => /Apply recommended/i.test(x.textContent)); b.scrollIntoView({ block: 'center' }); b.click(); })()`);
  await page.sleep(500);
  check(page.errors.length === 0 && !broken(await text()), 'demo: applying settings works without errors');
  await page.shot(join(out, 'rc-demo-applied.png'));

  // ---- degraded data
  for (const [kind, expect] of [['sparse', /not enough data/i], ['noframes', /not available|—/i], ['poor', /retake/i]]) {
    page.errors.length = 0;
    await page.goto(`${base}?demo=${kind}`, 1500);
    const t = await text();
    check(page.errors.length === 0, `${kind}: no errors ${JSON.stringify(page.errors).slice(0, 400)}`);
    check(expect.test(t) && !broken(t), `${kind}: shows ${expect} and no broken numbers`);
    await page.eval('window.scrollTo(0, 0)');
    await page.shot(join(out, `rc-${kind}.png`));
  }

  // ---- the intro of the live flow (outside the extension there is no camera, so it stops at Start)
  page.errors.length = 0;
  await page.goto(base, 1200);
  const intro = await page.eval(`({ radios: document.querySelectorAll('#rc-root input[type=radio]').length,
    start: [...document.querySelectorAll('#rc-root button')].some((b) => /start/i.test(b.textContent)), text: document.getElementById('rc-root').innerText })`);
  check(page.errors.length === 0, `intro: no errors ${JSON.stringify(page.errors).slice(0, 400)}`);
  check(intro.radios === 4 && intro.start, 'intro: four age bands and a Start button');
  check(/not a diagnosis/i.test(intro.text) && /(no|never).{0,40}(video|images)/i.test(intro.text), 'intro: disclaimer and privacy note');
  await page.shot(join(out, 'rc-intro.png'));
} finally {
  await chrome.close();
  server.close();
}
if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nassessment page checks passed');
