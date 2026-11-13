// Render the ten static slide layouts (showcase/slides.html?n=1..10) to 1920 x 1080 PNGs and export where each recording goes.
//   node showcase/render_slides.mjs        -> showcase/out/slide-01.png ... and showcase/out/slides.json
import { execSync } from 'node:child_process';
import { writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, serve } from '../tests/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'out');
try {
  const n = execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe' OR Name='msedge.exe'\\" | Where-Object { $_.CommandLine -match 'glider-chrome|lexilens-chrome' } | Measure-Object).Count"`, { encoding: 'utf8' }).trim();
  if (Number(n) > 0) { console.error('BUSY: another test browser is running; wait a few seconds and retry.'); process.exit(3); }
} catch (_) { /* cannot check */ }

const { server, origin } = await serve();
const chrome = await launch({ width: 1280, height: 720 });
const rects = {};
try {
  const page = await chrome.page();
  for (let n = 2; n <= 4; n++) {
    await page.goto(`${origin}/showcase/cards.html?n=${n}`, 700);
    await page.eval(`Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => 0)), new Promise((ok) => { const im = new Image(); im.onload = im.onerror = ok; im.src = getComputedStyle(document.body).backgroundImage.slice(5, -2); })]).then(() => 1)`);
    await page.sleep(150);
    const r = await page.eval(`document.body.dataset.rects || ''`);
    if (r) rects[n] = JSON.parse(r);
    await page.shot(join(OUT, `card-${String(n).padStart(2, '0')}.png`), { x: 0, y: 0, width: 1280, height: 720, scale: 1.5 });
  }
  writeFileSync(join(OUT, 'cards.json'), JSON.stringify(rects, null, 1));
  console.log('rendered cards 2 to 4; windows on', Object.keys(rects).join(', '), 'errors', JSON.stringify(page.errors));
} finally { await chrome.close(); server.close(); }
