// Print the real word lens for one word: its markup and the computed styles of every visible element.
// Used to hand an exact description of the shipped UI to whoever redraws it.   node showcase/dump-lens.mjs [word]
import { writeFileSync } from 'node:fs';
import { launch, serve, IN_PAGE } from '../tests/cdp.mjs';

const word = process.argv[2] || 'should';
const { server, origin } = await serve();
const chrome = await launch({ width: 640, height: 360 });
try {
  const page = await chrome.page();
  await page.goto(origin + '/showcase/title-page.html', 2800);
  await page.eval(IN_PAGE);
  await page.eval('Glider.app.update({ on: true }); 0');
  await page.sleep(900);
  const at = await page.eval(`(() => { const t = [...document.querySelectorAll('#s .glider-token')].find((e) => e.textContent === ${JSON.stringify(word)}); const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  await page.move(60, 300);
  await page.move(at.x, at.y);
  await page.sleep(1500);
  const dump = await page.eval(`(() => {
    const root = document.querySelector('#glider-root').shadowRoot, tip = root.querySelector('.ll-tip');
    const props = ['display', 'gap', 'padding', 'margin', 'border-radius', 'background-color', 'color', 'box-shadow', 'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'opacity'];
    const lines = [];
    const walk = (el, depth) => {
      const cs = getComputedStyle(el);
      if (el.hidden || cs.display === 'none') return;
      const r = el.getBoundingClientRect();
      const cls = typeof el.className === 'string' && el.className ? ' class="' + el.className + '"' : '';
      const text = el.children.length ? '' : ' ' + JSON.stringify(el.textContent.trim().slice(0, 40));
      lines.push('  '.repeat(depth) + '<' + el.tagName.toLowerCase() + cls + '>' + text + ' [' + Math.round(r.width) + 'x' + Math.round(r.height) + ' at ' + Math.round(r.left) + ',' + Math.round(r.top) + '] ' + props.map((p) => p + ': ' + cs.getPropertyValue(p)).join('; '));
      for (const c of el.children) walk(c, depth + 1);
    };
    walk(tip, 0);
    const tok = [...document.querySelectorAll('#s .glider-token')].find((e) => e.textContent === ${JSON.stringify(word)});
    const tr = tok.getBoundingClientRect(), tc = getComputedStyle(tok), p = getComputedStyle(document.getElementById('s'));
    return { tree: lines.join('\\n'), html: tip.innerHTML,
      word: { rect: [Math.round(tr.left), Math.round(tr.top), Math.round(tr.width), Math.round(tr.height)], background: tc.backgroundColor, radius: tc.borderRadius },
      paragraph: { letterSpacing: p.letterSpacing, wordSpacing: p.wordSpacing, lineHeight: p.lineHeight, fontSize: p.fontSize, html: document.getElementById('s').innerHTML } };
  })()`);
  writeFileSync('showcase/out/_lens-dump.json', JSON.stringify(dump, null, 1));
  console.log('ok', dump.tree.split('\n').length, 'elements; word', JSON.stringify(dump.word), 'paragraph', dump.paragraph.letterSpacing, dump.paragraph.wordSpacing, dump.paragraph.lineHeight, dump.paragraph.fontSize);
} finally { await chrome.close(); server.close(); }
