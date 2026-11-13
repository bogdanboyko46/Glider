// Screenshots of the toolbar popup, rendered standalone (outside the extension).
//   node tests/popup-shots.mjs [outDir] [skin,skin]
import { join } from 'node:path';
import { launch, serve, REPO } from './cdp.mjs';

const out = process.argv[2] || join(REPO, 'tests', 'out');
const skins = (process.argv[3] || 'sage').split(',');
const { server, origin } = await serve();
const chrome = await launch({ width: 420, height: 520 });
try {
  const page = await chrome.page();
  for (const skin of skins) {
    await page.goto(`${origin}/lexilens-extension/popup/popup.html?skin=${skin}`, 700);
    const r = await page.eval(`(() => { const b = document.querySelector('.pop').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
    await page.shot(join(out, `popup-${skin}.png`), { ...r, scale: 2 });
  }
  console.log('errors:', JSON.stringify(page.errors));
} finally {
  await chrome.close();
  server.close();
}
