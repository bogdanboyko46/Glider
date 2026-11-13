// Reference pictures of the REAL extension for whoever redraws it: the sentence with the lens and the b d p q colours on,
// and the real word lens on "should", captured at 3x.   node showcase/lens-ref.mjs   -> showcase/out/_g/ref-*.png
import { writeFileSync } from 'node:fs';
import { launch, serve, IN_PAGE } from '../tests/cdp.mjs';
const { server, origin } = await serve();
const chrome = await launch({ width: 640, height: 360 });
try {
  const page = await chrome.page();
  await page.goto(origin + '/showcase/title-page.html', 2800);
  await page.eval(IN_PAGE);
  await page.eval(`document.querySelector('#glider-root').shadowRoot.querySelector('.ll-dock').style.display = 'none'; Glider.app.update({ on: true, mirror: true }); 0`);
  await page.sleep(1600);
  await page.shot('showcase/out/_g/ref-sentence.png', { x: 0, y: 120, width: 640, height: 200, scale: 3 });
  const at = await page.eval(`(() => { const t = [...document.querySelectorAll('#s .glider-token')].find((e) => e.textContent === 'should'); const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.move(60, 340); await page.move(at.x, at.y); await page.sleep(1500);
  const info = await page.eval(`(() => { const root = document.querySelector('#glider-root').shadowRoot, tip = root.querySelector('.ll-tip'); const r = tip.getBoundingClientRect();
    const g = (el, pe) => { const c = getComputedStyle(el, pe); return { w: c.width, h: c.height, bg: c.backgroundColor, color: c.color, radius: c.borderRadius, shadow: c.boxShadow, font: c.fontWeight + ' ' + c.fontSize + '/' + c.lineHeight + ' ' + c.fontFamily, pad: c.padding, margin: c.margin, ls: c.letterSpacing, minh: c.minHeight, gap: c.gap, align: c.alignItems, border: c.border }; };
    const q = (s) => tip.querySelector(s);
    const m = [...document.querySelectorAll('#s [class*="glider-m-"]')].map((e) => { const c = getComputedStyle(e); return { letter: e.textContent, cls: e.className, color: c.color, shadow: c.boxShadow, radius: c.borderRadius, inBold: !!e.closest('.glider-fix') }; });
    const tok = [...document.querySelectorAll('#s .glider-token')].find((e) => e.textContent === 'should'); const tc = getComputedStyle(tok), tr = tok.getBoundingClientRect();
    return { rect: [r.left, r.top, r.width, r.height], side: tip.dataset.side, word: { rect: [tr.left, tr.top, tr.width, tr.height], bg: tc.backgroundColor, radius: tc.borderRadius, shadow: tc.boxShadow, pad: tc.padding },
      tip: g(tip), meta: g(q('.ll-meta')), diff: g(q('.ll-diff')), diffDot: g(q('.ll-diff'), '::before'), diffB: g(q('.ll-diff b')), level: g(q('.ll-level')), parts: g(q('.ll-parts')), part: g(q('.ll-part')), letters: g(q('.ll-part-letters')), sound: g(q('.ll-part-sound')), say: g(q('.ll-say')), hear: g(q('[data-say="word"]')), meaning: g(q('[data-act="define"]')), svg: g(q('.ll-say-btn svg')), mirror: m, sentenceHtml: document.getElementById('s').innerHTML }; })()`);
  writeFileSync('showcase/out/_g/ref.json', JSON.stringify(info, null, 1));
  const [x, y, w, h] = info.rect;
  await page.shot('showcase/out/_g/ref-lens.png', { x: Math.max(0, x - 40), y: Math.max(0, y - 20), width: Math.min(640, w + 80), height: Math.min(360 - Math.max(0, y - 20), h + 110), scale: 3 });
  console.log('ok', JSON.stringify(info.rect), info.side, 'mirror letters', info.mirror.length);
} finally { await chrome.close(); server.close(); }
