// Render layout variations of cards 2 and 3 (a cards file with ?n=2|3&v=1..N) to PNGs, with where each window goes.
//   node showcase/render_variants.mjs [cards-gemini.html] [versions=3]   -> showcase/out/variants/card-N-vV.png and rects.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, serve } from '../tests/cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = process.argv[2] || 'cards-gemini.html';
const VERSIONS = Number(process.argv[3] || 3);
const OUT = join(HERE, 'out', 'variants');
mkdirSync(OUT, { recursive: true });

const { server, origin } = await serve();
const chrome = await launch({ width: 1280, height: 720 });
const rects = {};
try {
  const page = await chrome.page();
  for (let v = 1; v <= VERSIONS; v++) {
    for (const n of [2, 3]) {
      await page.goto(`${origin}/showcase/${FILE}?n=${n}&v=${v}`, 700);
      await page.eval(`document.fonts.ready.then(() => 1)`);
      await page.sleep(150);
      rects[`${n}-${v}`] = JSON.parse(await page.eval(`document.body.dataset.rects || '[]'`));
      await page.shot(join(OUT, `card-${n}-v${v}.png`), { x: 0, y: 0, width: 1280, height: 720, scale: 1.25 });
    }
  }
  writeFileSync(join(OUT, 'rects.json'), JSON.stringify(rects, null, 1));
  console.log('rendered', Object.keys(rects).join(' '), 'errors', JSON.stringify(page.errors));
} finally { await chrome.close(); server.close(); }
