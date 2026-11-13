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

// stills of the real app for the two slides that show a page but no recording
const frames = readdirSync(join(OUT, '_real_r1-lens')).filter((f) => f.endsWith('.png')).sort();
copyFileSync(join(OUT, '_real_r1-lens', frames[0]), join(OUT, 'still-off.png'));
copyFileSync(join(OUT, '_real_r1-lens', frames[frames.length - 1]), join(OUT, 'still-on.png'));

const { server, origin } = await serve();
const chrome = await launch({ width: 1280, height: 720 });
const rects = {};
try {
  const page = await chrome.page();
  for (let n = 1; n <= 10; n++) {
    await page.goto(`${origin}/showcase/slides.html?n=${n}`, 700);
    await page.eval(`Promise.all([document.fonts.ready, ...[...document.images].map((i) => i.decode().catch(() => 0)), new Promise((ok) => { const im = new Image(); im.onload = im.onerror = ok; im.src = getComputedStyle(document.body).backgroundImage.slice(5, -2); })]).then(() => 1)`);
    await page.sleep(150);
    const r = await page.eval(`document.body.dataset.rect || ''`);
    if (r) rects[n] = JSON.parse(r);
    await page.shot(join(OUT, `slide-${String(n).padStart(2, '0')}.png`), { x: 0, y: 0, width: 1280, height: 720, scale: 1.5 });
  }
  writeFileSync(join(OUT, 'slides.json'), JSON.stringify(rects, null, 1));
  console.log('rendered 10 slides; recordings go on', Object.keys(rects).join(', '), 'errors', JSON.stringify(page.errors));
} finally { await chrome.close(); server.close(); }
