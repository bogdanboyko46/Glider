// Film the REAL Glider extension on a REAL website, for the showcase deck.
//
//   node showcase/live-capture.mjs probe            what the article shows (words, look-alikes, parts)
//   node showcase/live-capture.mjs lens tune        film scenes by name (see SCENES below)
//   then: python showcase/live2media.py lens tune   adds the browser frame and writes GIF + MP4
//
// What is real: the unpacked extension from glider-extension/, loaded into Edge the way a user
// installs it (Load unpacked), running on the sample course page (demo/sample-assignment.html, served
// by the local test server), filmed continuously with the browser's own screencast (every painted
// frame, with its real time). Nothing in the page is staged.
// What is added: a pointer (headless browsers do not draw one), and afterwards the window frame
// around the page (live2media.py), showing the page's real address and title.
//
// Output: showcase/out/_live_<scene>/f0000.jpg ... and times.json (ms since the start of the take).
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, serve, IN_PAGE } from '../tests/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// PACE slows every scripted action (pointer moves, drags, pauses) without touching Glider itself,
// which still responds at its real speed: PACE=1.4 node showcase/live-capture.mjs lens ...
const PACE = Number(process.env.PACE || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * PACE));
const W = 800, H = 600;                       // page size; the frame adds a 78 px bar: 800 x 678 (the card boxes are 1.18 : 1)
const PAGE = '/demo/sample-assignment.html';
let URL_ = '';   // set once the local server is up

const SETTINGS = (patch) => ({
  on: true, dockVisible: true, skin: 'sage', fontSize: 100, letterSpacing: 1, wordSpacing: 3, lineHeight: 1.8,
  mirror: false, font: false, gaze: false, gazeSensitivity: 3, showLevels: true, showDefinitions: false, showWordParts: true,
  dockMode: 'float', ...patch,
});

/* A pointer, drawn where the scripted mouse is: headless screenshots have none. */
const CURSOR = `(() => {
  if (document.getElementById('demo-cursor')) return;
  const c = document.createElement('div');
  c.id = 'demo-cursor'; c.setAttribute('data-glider-ignore', '');
  c.style.cssText = 'position:fixed;left:0;top:0;width:24px;height:24px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px)';
  c.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M4 2.5l15.5 9.2-6.6 1.3-3.4 6.5z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.documentElement.appendChild(c);
  addEventListener('mousemove', (e) => { c.style.transform = 'translate(' + (e.clientX - 4) + 'px,' + (e.clientY - 2) + 'px)'; }, true);
})()`;

/* Wait for the page's text, then start at the top, as a reader would. */
const READY = `(async () => {
  const find = () => [...document.querySelectorAll('main p, article p, p')].find((p) => p.textContent.trim().length > 150);
  for (let i = 0; i < 40 && !find(); i++) await new Promise((r) => setTimeout(r, 250));
  scrollTo(0, 0);
  await new Promise((r) => setTimeout(r, 700));
  return !!find();
})()`;

/* Bring the paragraph holding a word to about a third of the way down, so its tokens exist and it is in view. */
const SHOW = (text) => `(async () => {
  const word = ${JSON.stringify(String(text).toLowerCase())};
  const p = [...document.querySelectorAll('p, li')].find((el) => el.textContent.toLowerCase().split(/[^a-z']+/).includes(word));
  if (!p) return false;
  scrollTo(0, Math.max(0, p.getBoundingClientRect().top + scrollY - innerHeight * 0.33));
  await new Promise((r) => setTimeout(r, 900));
  return true;
})()`;

function pointer(page, start) {
  return {
    at: start || { x: W * 0.5, y: H * 0.92 },
    async glide(x, y, ms = 600) {
      const from = this.at, steps = Math.max(6, Math.round(ms / 16));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        await page.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
        await sleep(ms / steps);
      }
      this.at = { x, y };
    },
    async click(x, y) {
      if (x !== undefined) await this.glide(x, y, 0);
      const { x: px, y: py } = this.at;
      await page.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
      await sleep(70);
      await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 });
    },
    /** Press, move slowly to (x, y), release: a real drag the page sees as one. */
    async drag(x, y, ms = 700) {
      const from = this.at, steps = Math.max(8, Math.round(ms / 16));
      await page.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (x - from.x) * e, y: from.y + (y - from.y) * e, button: 'left', buttons: 1 });
        await sleep(ms / steps);
      }
      await page.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      this.at = { x, y };
    },
  };
}

const inDock = (sel) => `document.querySelector('#glider-root').shadowRoot.querySelector(${JSON.stringify(sel)})`;
const box = (page, expr) => page.eval(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, w: r.width, h: r.height }; })()`);
/** The first visible token of a word in the article (tokens exist only near the viewport). */
const word = (page, text, n = 0) => box(page, `[...document.querySelectorAll('.glider-token')].filter((t) => t.textContent === ${JSON.stringify(text)} && t.getBoundingClientRect().top > 40 && t.getBoundingClientRect().bottom < innerHeight - 40)[${n}]`);
const knob = (page, key) => page.eval(`(() => { const el = ${inDock(`[data-range="${key}"]`)}; const r = el.getBoundingClientRect(); const p = (el.value - el.min) / (el.max - el.min); return { x: r.left + 9 + p * (r.width - 18), y: r.top + r.height / 2, left: r.left, w: r.width }; })()`);

/* ------------------------------------------------------------------ scenes
   Each runs in real time; `settings` is what Glider is set to before the page loads. */
export const SCENES = {
  // Card 2, left: the page as it is, then the reader opens Glider from the edge and turns the lens on.
  lens: {
    settings: { on: false }, seconds: 7.2, start: { x: 560, y: 540 },
    async run(page, p) {
      await sleep(900);
      const mark = await box(page, inDock('.ll-pill-main'));
      await p.glide(mark.x, mark.y, 1000); await sleep(250); await p.click();
      await sleep(800);
      const sw = await box(page, inDock('.ll-head [data-toggle="on"]'));
      await p.glide(sw.x, sw.y, 650); await sleep(200); await p.click();
      await sleep(1300);
      const close = await box(page, inDock('[data-action="collapse"]'));
      await p.glide(close.x, close.y, 500); await p.click();
      await p.glide(W * 0.42, H * 0.78, 700);
      await sleep(900);
    },
  },
  // Card 2, right: lens on; the reader opens the panel and makes the text larger and the lines wider apart.
  tune: {
    settings: { on: true }, seconds: 9.2, start: { x: 560, y: 540 },
    async run(page, p) {
      await sleep(300);
      const mark = await box(page, inDock('.ll-pill-main'));
      await p.glide(mark.x, mark.y, 700); await sleep(150); await p.click();
      await sleep(650);
      let k = await knob(page, 'fontSize');
      await p.glide(k.x, k.y, 400); await sleep(80);
      await p.drag(k.left + 9 + 0.5 * (k.w - 18), k.y, 850);
      await sleep(250);
      k = await knob(page, 'lineHeight');
      await p.glide(k.x, k.y, 350); await sleep(80);
      await p.drag(k.left + 9 + 0.85 * (k.w - 18), k.y, 700);
      await sleep(350);
      // colours for the mirror letters b d p q, then the Atkinson Hyperlegible font
      for (const key of ['mirror', 'font']) {
        const sw = await box(page, inDock(`.ll-body [data-toggle="${key}"]`));
        if (!sw) continue;
        await p.glide(sw.x, sw.y, 450); await sleep(100); await p.click();
        await sleep(650);
      }
      const close = await box(page, inDock('[data-action="collapse"]'));
      await p.glide(close.x, close.y, 400); await p.click();
      await p.glide(W * 0.5, H * 0.92, 500);
      await sleep(400);
    },
  },
  // Card 2, the one window: open Glider from the edge, turn the lens on, then colours for b d p q and the
  // Hyperlegible font, then move each slider up and down and leave it on the reader's choice.
  panel: {
    settings: { on: false }, seconds: 15, start: { x: 560, y: 540 },
    finish: { fontSize: 130, letterSpacing: 1, wordSpacing: 5, lineHeight: 2.3 },
    async run(page, p, scene) {
      await sleep(400);
      const mark = await box(page, inDock('.ll-pill-main'));
      await p.glide(mark.x, mark.y, 900); await sleep(200); await p.click();
      await sleep(700);
      const on = await box(page, inDock('.ll-head [data-toggle="on"]'));
      await p.glide(on.x, on.y, 550); await sleep(150); await p.click();
      await sleep(700);
      for (const key of ['mirror', 'font']) {
        const sw = await box(page, inDock(`.ll-body [data-toggle="${key}"]`));
        await p.glide(sw.x, sw.y, 450); await sleep(120); await p.click();
        await sleep(450);
      }
      // each slider goes up and down, and ends on its setting
      const path = { fontSize: [150, 130], letterSpacing: [3, 1], wordSpacing: [8, 5], lineHeight: [1.6, 2.3] };
      for (const key of ['fontSize', 'letterSpacing', 'wordSpacing', 'lineHeight']) {
        const k = await knob(page, key);
        await p.glide(k.x, k.y, 380); await sleep(80);
        for (const value of path[key]) {
          const x = await page.eval(`(() => { const el = ${inDock(`[data-range="${key}"]`)}; const r = el.getBoundingClientRect(); const f = (${value} - el.min) / (el.max - el.min); return r.left + 9 + f * (r.width - 18); })()`);
          await p.drag(x, k.y, 420);
          await sleep(100);
        }
        await sleep(120);
      }
      const values = await page.eval(`(() => { const root = document.querySelector('#glider-root').shadowRoot; return Object.fromEntries(['fontSize', 'letterSpacing', 'wordSpacing', 'lineHeight'].map((k) => [k, Number(root.querySelector('[data-range="' + k + '"]').value)])); })()`);
      console.log('  sliders end on:', JSON.stringify(values), JSON.stringify(values) === JSON.stringify(scene.finish) ? '(as asked)' : '(NOT as asked: ' + JSON.stringify(scene.finish) + ')');
      await sleep(500);
      const close = await box(page, inDock('[data-action="collapse"]'));
      await p.glide(close.x, close.y, 450); await p.click();
      await p.glide(W * 0.5, H * 0.92, 600);
      await sleep(1300);                                     // the finished page, at rest
    },
  },
  // Card 3, left: rest on a long word; the lens shows how hard it is, its parts and sounds; sound it out; its meaning.
  wordlens: {
    settings: { on: true, mirror: true, font: true }, seconds: 7.4, target: 'photosynthesis', start: { x: 300, y: 585 },
    async run(page, p, scene) {
      await sleep(400);
      const t = await word(page, scene.target) || await word(page, scene.target[0].toUpperCase() + scene.target.slice(1));
      if (!t) throw new Error('word not visible: ' + scene.target);
      await p.glide(t.x, t.top - 7, 900);                  // along the gap above the line
      await p.glide(t.x, t.y, 160 / PACE);                 // then onto the word
      await sleep(1500);                                    // the lens opens, then its sounds and parts arrive
      // A headless browser has no voice. Stand in for it inside Glider's own (isolated) world, where its
      // content script calls speechSynthesis: each chunk "speaks" for about as long as a voice takes.
      await page.evalGlider(`(() => { const t = new Set(); speechSynthesis.speak = (u) => { t.add(setTimeout(() => u.onend && u.onend(), 240 + 25 * String(u.text).length)); }; speechSynthesis.cancel = () => { t.forEach(clearTimeout); t.clear(); }; return 1; })()`);
      // Into the lens first, straight up from the word and quickly, so the pointer never rests on another
      // word on the way (which would rightly open that word's lens instead).
      const tip = await box(page, inDock('.ll-tip'));
      if (tip) {
        const below = tip.top + tip.h > t.y;                // the lens may sit above or below the word
        await p.glide(t.x, below ? tip.top + 14 : tip.top + tip.h - 14, 220 / PACE);
      }
      const slow = await box(page, inDock('.ll-tip [data-say="slow"]'));
      if (slow) {
        await p.glide(slow.x, slow.y, 650); await sleep(150);
        // log when Glider lights each chunk, to check the timing afterwards
        await page.eval(`(() => { const tip = ${inDock('.ll-tip')}; const t0 = performance.now(); window.__lit = []; new MutationObserver(() => { const now = [...tip.querySelectorAll('.ll-part[data-now]')].map((e) => e.dataset.part).join(''); const last = __lit[__lit.length - 1]; if (!last || last[1] !== now) __lit.push([Math.round(performance.now() - t0), now]); }).observe(tip, { subtree: true, attributes: true, attributeFilter: ['data-now'] }); return 1; })()`);
        await p.click();
        // wait until Glider has sounded out every chunk and the whole word, then a short beat
        for (let i = 0; i < 80; i++) {
          await new Promise((r) => setTimeout(r, 100));
          if (!(await page.eval(`(() => { const b = ${inDock('.ll-tip [data-say="slow"]')}; return !!(b && b.dataset.speaking); })()`))) break;
        }
        console.log('  sound it out (ms after the press, chunk lit):', JSON.stringify(await page.eval('window.__lit')));
        await sleep(450);
      }
      const def = await box(page, inDock('.ll-tip [data-act="define"]'));
      if (def) { await p.glide(def.x, def.y, 450); await sleep(120); await p.click(); }
      await sleep(1400);
    },
  },
  // Card 3, right: a word that is easy to mix up; the lens lists the look-alike words with a short meaning each.
  lookalike: {
    settings: { on: true, mirror: true, font: true }, seconds: 6.4, target: null, start: { x: 330, y: 585 },
    async run(page, p, scene) {
      await sleep(400);
      const t = await word(page, scene.target);
      if (!t) throw new Error('look-alike word not visible: ' + scene.target);
      // come in from the empty margin to the left, so no other word's lens opens on the way
      await sleep(300);
      await p.glide(t.x, t.top - 7, 800);                  // along the gap above the line
      await p.glide(t.x, t.y, 160 / PACE);                 // then onto the word
      await sleep(3800);
    },
  },
};

async function extensionBase(chrome) {
  for (let i = 0; i < 20; i++) {
    const t = (await chrome.browser.send('Target.getTargets')).targetInfos.find((x) => /^chrome-extension:\/\/[a-z]+\/background\/service-worker\.js$/.test(x.url));
    if (t) return t.url.replace(/background\/service-worker\.js$/, '');
    await sleep(300);
  }
  throw new Error('the extension did not start');
}

async function setSettings(chrome, base, patch) {
  const tab = await chrome.page();
  await tab.goto(`${base}simplify/options.html`, 500);
  await tab.eval(`chrome.storage.local.set({ 'glider:settings:v2': ${JSON.stringify(SETTINGS(patch))} }).then(() => chrome.storage.local.remove('glider:dock')).then(() => 1)`);
  await tab.cdp.send('Page.close').catch(() => {});
}

/** Let page.evalGlider() run code in the content script's isolated world (Glider's own globals). */
function trackGliderWorld(page) {
  let ctx = null;
  page.cdp.on('Runtime.executionContextCreated', ({ context }) => {
    if (context.auxData && context.auxData.type === 'isolated' && /^chrome-extension:/.test(context.origin || '')) ctx = context.id;
  });
  page.cdp.on('Runtime.executionContextsCleared', () => { ctx = null; });
  page.evalGlider = async (expression) => {
    for (let i = 0; i < 40 && !ctx; i++) await new Promise((r) => setTimeout(r, 100));
    if (!ctx) throw new Error("Glider's content-script world was not found");
    const r = await page.cdp.send('Runtime.evaluate', { expression, contextId: ctx, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
}

async function film(chrome, base, name) {
  const scene = SCENES[name];
  await setSettings(chrome, base, scene.settings);
  const page = await chrome.page();
  trackGliderWorld(page);
  await page.cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await page.goto(URL_, 3500);
  await page.eval(IN_PAGE);
  if (!(await page.eval(READY))) throw new Error('page text not found');
  if (scene.target && !(await page.eval(SHOW(scene.target)))) throw new Error('word not on the page: ' + scene.target);
  await page.eval(CURSOR);
  // For a word scene, start in the empty left margin, level with the gap just above the word's line,
  // so the pointer can glide along blank space and only land on the word at the end.
  let from = scene.start;
  if (scene.target) {
    const t = await word(page, scene.target);
    const left = await page.eval(`Math.min(...[...document.querySelectorAll('p')].filter((p) => p.getBoundingClientRect().height > 0).map((p) => p.getBoundingClientRect().left))`);
    if (t) from = { x: Math.max(24, left - 40), y: t.top - 7 };
  }
  const p = pointer(page, from);
  await page.move(p.at.x, p.at.y);
  await sleep(400);

  const dir = join(HERE, 'out', '_live_' + name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames = [];
  page.cdp.on('Page.screencastFrame', (f) => {
    frames.push({ t: f.metadata.timestamp * 1000, data: f.data });
    page.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await page.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  const t0 = Date.now();
  // a repaint at the very start, so the first frame is the page at rest
  await page.eval(`document.getElementById('demo-cursor').style.opacity = '0.999'`);
  await scene.run(page, p, scene);
  while (Date.now() - t0 < scene.seconds * PACE * 1000) await sleep(50);
  await page.cdp.send('Page.stopScreencast');
  await sleep(200);
  if (!frames.length) throw new Error('no frames');
  const start = frames[0].t;
  const times = frames.map((f) => Math.round(f.t - start));
  frames.forEach((f, i) => writeFileSync(join(dir, `f${String(i).padStart(4, '0')}.jpg`), Buffer.from(f.data, 'base64')));
  writeFileSync(join(dir, 'times.json'), JSON.stringify({ times, length: Math.round(scene.seconds * PACE * 1000), url: URL_, title: await page.eval('document.title') }));
  console.log(`${name}: ${frames.length} frames over ${(times[times.length - 1] / 1000).toFixed(1)} s, errors ${JSON.stringify(page.errors.filter((e) => !/movePinnableElement/.test(e)))}`);
  await page.cdp.send('Page.close').catch(() => {});
}

async function probe(chrome, base) {
  await setSettings(chrome, base, { on: true });
  const page = await chrome.page();
  await page.cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await page.goto(URL_, 3500);
  await page.eval(READY);
  await sleep(800);
  const info = await page.eval(`(() => {
    const vis = (t) => { const r = t.getBoundingClientRect(); return r.top > 40 && r.bottom < innerHeight - 40; };
    const toks = [...document.querySelectorAll('.glider-token')].filter(vis);
    return { homophones: [...new Set(toks.filter((t) => t.classList.contains('glider-homophone')).map((t) => t.textContent))],
             long: [...new Set(toks.filter((t) => t.classList.contains('glider-long')).map((t) => t.textContent))].slice(0, 60) }; })()`);
  console.log(JSON.stringify(info, null, 1));
  await page.shot(join(HERE, 'out', 'live-probe.png'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const lookIdx = args.indexOf('--lookalike');
  if (lookIdx >= 0) { SCENES.lookalike.target = args[lookIdx + 1]; args.splice(lookIdx, 2); }
  const wordIdx = args.indexOf('--word');
  if (wordIdx >= 0) { SCENES.wordlens.target = args[wordIdx + 1]; args.splice(wordIdx, 2); }
  const { server, origin } = await serve();
  URL_ = origin + PAGE;
  const chrome = await launch({ width: W, height: H, extension: true });
  try {
    const base = await extensionBase(chrome);
    for (const name of args) {
      if (name === 'probe') await probe(chrome, base);
      else if (SCENES[name]) await film(chrome, base, name);
      else console.error('unknown scene', name);
    }
  } finally { await chrome.close(); server.close(); }
}
