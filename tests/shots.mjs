// Screenshot tour of every dock design in harness mode (no extension install needed).
//   node tests/shots.mjs [outDir] [skin]
import { join } from 'node:path';
import { launch, serve, IN_PAGE, REPO } from './cdp.mjs';

const ALL = ['sage'];
const out = process.argv[2] || join(REPO, 'tests', 'out');
const skins = process.argv[3] ? process.argv[3].split(',') : ALL;

const { server, origin } = await serve();
const chrome = await launch({ width: 1280, height: 800 });
try {
  const page = await chrome.page();
  await page.goto(`${origin}/demo/sample-assignment.html?harness`, 1200);
  await page.eval(IN_PAGE);
  await page.eval(`localStorage.clear()`);
  await page.goto(`${origin}/demo/sample-assignment.html?harness`, 1200);
  await page.eval(IN_PAGE);

  const rect = async (sel) => page.eval(`__ll.rect(${JSON.stringify(sel)})`);
  const clip = async (sel, pad = 22) => {
    const r = await rect(sel);
    return { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.w + pad * 2, height: r.h + pad * 2, scale: 2 };
  };
  const set = async (patch) => { await page.eval(`Glider.app.update(${JSON.stringify(patch)})`); await page.sleep(350); };
  const hover = async (word) => {
    const tok = await page.eval(`(() => { const t = __ll.token(${JSON.stringify(word)}); return t ? __ll.rect(t) : null; })()`);
    if (!tok) throw new Error('no token ' + word);
    await page.move(tok.cx, tok.cy);
    await page.sleep(650);
  };

  for (const skin of skins) {
    await set({ skin });
    await page.eval(`Glider.app.setOpen(false)`);
    await page.sleep(300);
    await page.move(760, 150);
    await page.shot(join(out, `${skin}-pill.png`), await clip('.ll-pill', 26));
    await hover('epistemology');
    await page.shot(join(out, `${skin}-tip.png`), await clip('.ll-tip', 30));
    await page.move(760, 150);
    await page.eval(`Glider.app.setOpen(true)`);
    await page.sleep(400);
    await page.shot(join(out, `${skin}-panel.png`), await clip('.ll-panel'));
  }

  // Whole-page views in the default design.
  await set({ skin: skins[0] });
  await page.eval(`Glider.app.setOpen(false)`);
  await hover('epistemology');
  await page.shot(join(out, 'page-hover.png'));
  await hover('principal');
  await page.shot(join(out, 'page-lookalike.png'));
  await page.move(500, 380);
  await page.sleep(400);
  await page.shot(join(out, 'page-on.png'));
  await set({ on: false });
  await page.shot(join(out, 'page-off.png'));

  console.log('errors:', JSON.stringify(page.errors, null, 1));
} finally {
  await chrome.close();
  server.close();
}
