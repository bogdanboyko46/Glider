// Record the REAL Glider UI while a script drives it, as a frame sequence with timestamps.
// One headless browser at a time: refuses to start while another test browser is running.
//
//   import { capture, glide } from './capture.mjs';
//   await capture({ name: 'r1-lens', url: '/showcase/app-page.html', seconds: 7, run: async (page) => { ... } });
//
// Output: showcase/out/_real_<name>/f0000.jpg ... and times.json (ms since start for each frame).
// Turn it into a GIF with: python showcase/real2gif.py <name>
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, serve, IN_PAGE } from '../tests/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A visible pointer, because headless screenshots do not include the real one. Demo only. */
const CURSOR = `(() => {
  if (document.getElementById('demo-cursor')) return;
  const c = document.createElement('div');
  c.id = 'demo-cursor'; c.setAttribute('data-glider-ignore', '');
  c.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))';
  c.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M5 3l14 8-6 1.5L10 19z" fill="#20352a" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  document.documentElement.appendChild(c);
  addEventListener('mousemove', (e) => { c.style.transform = 'translate(' + (e.clientX - 5) + 'px,' + (e.clientY - 3) + 'px)'; }, true);
})()`;

/** Move the pointer smoothly from where it is to (x, y). */
export async function glide(page, x, y, ms = 500) {
  const from = page.__at || { x: x - 200, y: y + 120 };
  const steps = Math.max(4, Math.round(ms / 24));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await sleep(ms / steps);
  }
  page.__at = { x, y };
}
/** Centre of an element: sel inside the dock's shadow root when shadow is true, else on the page. */
export const centre = (page, sel, shadow = false) => page.eval(`(() => { const el = ${shadow ? `document.querySelector('#glider-root').shadowRoot.querySelector(${JSON.stringify(sel)})` : `document.querySelector(${JSON.stringify(sel)})`}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top }; })()`);

export async function capture({ name, url, width = 1280, height = 720, seconds = 7, settle = 1500, scale = 1, before, run }) {
  try {
    const n = execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe' OR Name='msedge.exe'\\" | Where-Object { $_.CommandLine -match 'glider-chrome|lexilens-chrome' } | Measure-Object).Count"`, { encoding: 'utf8' }).trim();
    if (Number(n) > 0) { console.error('BUSY: another test browser is running; wait a few seconds and retry.'); process.exit(3); }
  } catch (_) { /* cannot check */ }
  const dir = join(HERE, 'out', '_real_' + name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const { server, origin } = await serve();
  const chrome = await launch({ width, height });
  try {
    const page = await chrome.page();
    await page.goto(origin + url, settle);
    await page.eval(IN_PAGE);
    await page.eval(CURSOR);
    if (before) await before(page);
    const times = [];
    let done = false;
    const t0 = Date.now();
    const actor = (async () => { try { await run(page, { glide, centre, sleep }); } finally { done = true; } })();
    let i = 0;
    while (!done || Date.now() - t0 < seconds * 1000) {
      const t = Date.now() - t0;
      if (t > seconds * 1000 + 200) break;
      await page.shot(join(dir, `f${String(i).padStart(4, '0')}.png`), scale === 1 ? undefined : { x: 0, y: 0, width, height, scale });   // scale > 1: a small viewport recorded large, so the UI reads big
      times.push(t); i += 1;
    }
    await actor.catch((e) => console.error('run failed:', e.message));
    writeFileSync(join(dir, 'times.json'), JSON.stringify(times));
    console.log(`${name}: ${i} frames over ${(times[times.length - 1] / 1000).toFixed(1)} s (${(i / (times[times.length - 1] / 1000)).toFixed(1)} fps), errors ${JSON.stringify(page.errors)}`);
  } finally { await chrome.close(); server.close(); }
}
