// The real unpacked extension (Edge): word levels from the service worker, saving a word into
// chrome.storage, the Glider page showing it, and the dock's button opening that page.
//   node tests/extension-pages.mjs
import { launch, serve, IN_PAGE } from './cdp.mjs';

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };

const { server, origin } = await serve();
const chrome = await launch({ width: 1280, height: 800, extension: true });

try {
  const page = await chrome.page();
  await page.sleep(1500); // let the service worker register
  const targets = async () => (await chrome.browser.send('Target.getTargets')).targetInfos;
  const sw = (await targets()).find((t) => t.type === 'service_worker' && /^chrome-extension:\/\/[a-z]+\/background\/service-worker\.js$/.test(t.url));
  check('Glider\'s service worker started', !!sw, sw && sw.url);
  let base = sw ? sw.url.replace(/background\/service-worker\.js$/, '') : '';

  // A placeholder key, so the lens offers "Explain simply". The test never presses it: nothing is sent.
  const keyPage = await chrome.page();
  await keyPage.goto(`${base}home/home.html#account`, 800);
  await keyPage.eval(`chrome.storage.local.set({ 'glider:anthropicKey': 'placeholder-for-tests' })`);

  await page.goto(`${origin}/demo/sample-assignment.html`, 2500);
  await page.eval(IN_PAGE);
  check('the extension injected the dock', await page.eval(`!!document.querySelector('#glider-root')`));

  // Hover "accumulate" (B2 in CEFR-J): the level comes back from the service worker.
  await page.eval(`[...document.querySelectorAll('p')].find((p) => p.textContent.includes('accumulate')).scrollIntoView({ block: 'center' }); 0`);
  await page.sleep(900);
  const r = await page.eval(`__ll.rect(__ll.token('accumulate'))`);
  await page.move(r.cx, r.cy);
  await page.sleep(1200);
  const chip = await page.eval(`(() => { const c = __ll.q('.ll-tip .ll-level'); return c && !c.hidden ? c.dataset.level : null; })()`);
  check('the lens shows the level from the service worker', chip === 'B2', String(chip));
  check('and how hard the word is to read', await page.eval(`__ll.q('.ll-tip .ll-diff').dataset.band === 'medium'`));
  await page.eval(`__ll.q('.ll-tip [data-act="define"]').click()`);
  await page.sleep(2500);
  check('Meaning comes from the dictionary in the service worker', await page.eval(`/gather/.test(__ll.q('.ll-tip .ll-def').textContent)`), await page.eval(`__ll.q('.ll-tip .ll-def').textContent.slice(0, 80)`));
  check('with a key saved, "Explain simply" is offered', await page.eval(`!!__ll.q('.ll-tip [data-act="explain"]')`));
  // word parts from the service worker: "carefully" is care + ful + ly
  await page.move(40, 760);
  await page.click(30, 30);
  await page.sleep(400);
  await page.eval(`[...document.querySelectorAll('p')].find((p) => /carefully/.test(p.textContent)).scrollIntoView({ block: 'center' }); 0`);
  await page.sleep(900);
  const rc = await page.eval(`__ll.rect(__ll.token('carefully'))`);
  await page.move(rc.cx, rc.cy);
  await page.sleep(1500);
  const tags = await page.eval(`[...__ll.q('.ll-tip').querySelectorAll('.ll-tag')].map((t) => t.textContent).join(' ')`);
  check('word parts come from the service worker', tags === 'base suffix suffix', tags);
  await page.move(40, 760);
  await page.click(30, 30);
  await page.sleep(400);
  await page.eval(`[...document.querySelectorAll('p')].find((p) => p.textContent.includes('accumulate')).scrollIntoView({ block: 'center' }); 0`);
  await page.sleep(700);
  const ra = await page.eval(`__ll.rect(__ll.token('accumulate'))`);
  await page.move(ra.cx, ra.cy);
  await page.sleep(1000);

  await page.eval(`__ll.q('.ll-tip [data-save]').click()`);
  await page.sleep(500);
  check('the save button shows it saved', await page.eval(`__ll.q('.ll-tip [data-save]').getAttribute('aria-pressed') === 'true'`));

  // The dock's Glider page button asks the service worker to open the page.
  await page.move(40, 760);
  await page.eval(`__ll.q('.ll-pill-main').click()`);
  await page.sleep(400);
  const before = (await targets()).filter((t) => t.type === 'page' && t.url.includes('/home/home.html')).length;
  await page.eval(`__ll.q('[data-action="open-page"]').click()`);
  await page.sleep(1500);
  const homes = (await targets()).filter((t) => t.type === 'page' && t.url.includes('/home/home.html'));
  check('the dock button opens the Glider page', homes.length === before + 1, homes.map((t) => t.url).join(' '));
  if (homes[0]) base = homes[0].url.replace(/home\/home\.html.*$/, '');
  await page.eval(`__ll.q('[data-action="open-page"]').click()`);
  await page.sleep(1500);
  check('pressing it again reuses that tab', (await targets()).filter((t) => t.type === 'page' && t.url.includes('/home/home.html')).length === homes.length);

  // The Glider page reads the same chrome.storage.
  const home = await chrome.page();
  await home.goto(`${base}home/home.html#words`, 1200);
  const shown = await home.eval(`[...document.querySelectorAll('.gh-word')].map((li) => li.dataset.word + ':' + (li.querySelector('.gh-lvl b') || {}).textContent)`);
  check('the Glider page lists the saved word with its level', shown.length === 1 && shown[0] === 'accumulate:B2', JSON.stringify(shown));
  await home.sleep(1200);
  check('with its reading difficulty and meaning', await home.eval(`(() => { const li = document.querySelector('.gh-word'); return li.querySelector('.gh-diff').dataset.band === 'medium' && /gather/.test(li.querySelector('.gh-word-def').textContent); })()`));
  await keyPage.eval(`chrome.storage.local.remove('glider:anthropicKey')`);

  // A setting changed on the Glider page reaches the open tab.
  await home.goto(`${base}home/home.html#settings`, 1000);
  await home.eval(`document.querySelector('[data-mode="edge"]').click()`);
  await page.sleep(900);
  check('choosing "Tucked into the side" there tucks the dock on the page', await page.eval(`__ll.q('.ll-dock').dataset.mode === 'edge'`));
  // (Content scripts live in an isolated world, so the page is checked by what it shows.)
  const hoverAgain = async () => {
    await page.move(40, 760);
    await page.sleep(500);
    const t = await page.eval(`__ll.rect(__ll.token('accumulate'))`);
    await page.move(t.cx, t.cy);
    await page.sleep(1200);
  };
  await home.eval(`document.querySelector('.gh-switch[data-key="showLevels"]').click()`);
  await page.sleep(600);
  await hoverAgain();
  check('and turning word levels off there hides the chip on the page', await page.eval(`!__ll.q('.ll-tip').hidden && __ll.q('.ll-tip .ll-level').hidden`));

  // Removing on the Glider page reaches the open tab.
  await home.goto(`${base}home/home.html#words`, 1000);
  await home.eval(`document.querySelector('.gh-word [data-act="remove"]').click()`);
  await page.sleep(800);
  await hoverAgain();
  check('removing on the Glider page un-saves it on the page', await page.eval(`__ll.q('.ll-tip [data-save]').getAttribute('aria-pressed') === 'false'`));

  check('the options page is the Glider page', await home.eval(`chrome.runtime.getManifest().options_ui.page === 'home/home.html'`));
  check('no page errors', page.errors.length === 0 && home.errors.length === 0, page.errors.concat(home.errors).join(' | '));
} catch (error) {
  check('run finished without throwing', false, error.stack || String(error));
} finally {
  await chrome.close();
  server.close();
}

console.log(failed ? `\n${failed} FAILED` : '\nall extension page checks passed');
process.exit(failed ? 1 : 0);
