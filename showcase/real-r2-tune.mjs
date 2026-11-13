// Real app, scene 2: lens on; the pointer presses the edge mark, the panel opens, Size and Words are dragged and the page responds.
import { capture } from './capture.mjs';

const knob = (page, key) => page.eval(`(() => { const el = document.querySelector('#glider-root').shadowRoot.querySelector('[data-range="${key}"]'); const r = el.getBoundingClientRect(); const p = (el.value - el.min) / (el.max - el.min); return { x: r.left + 9 + p * (r.width - 18), y: r.top + r.height / 2, left: r.left, w: r.width }; })()`);
async function dragTo(page, key, fraction, sleep) {
  const k = await knob(page, key);
  const tx = k.left + 9 + fraction * (k.w - 18);
  await page.drag(k.x, k.y, tx, k.y);
  page.__at = { x: tx, y: k.y };
  await sleep(120);
}

await capture({
  name: 'r2-tune', url: '/showcase/app-page.html', width: 1000, height: 625, seconds: 7,
  run: async (page, { glide, centre, sleep }) => {
    await page.move(430, 480); page.__at = { x: 430, y: 480 };
    await sleep(500);
    const mark = await centre(page, '.ll-pill-main', true);
    await glide(page, mark.x, mark.y, 800);
    await sleep(300);
    await page.click(mark.x, mark.y);
    await sleep(900);
    let k = await knob(page, 'fontSize');
    await glide(page, k.x, k.y, 500);
    for (const f of [.2, .35, .5]) { await dragTo(page, 'fontSize', f, sleep); await sleep(180); }
    await sleep(500);
    k = await knob(page, 'wordSpacing');
    await glide(page, k.x, k.y, 400);
    for (const f of [.45, .6, .75]) { await dragTo(page, 'wordSpacing', f, sleep); await sleep(180); }
    await sleep(600);
    const close = await centre(page, '[data-action="collapse"]', true);
    await glide(page, close.x, close.y, 450);
    await page.click(close.x, close.y);
    await glide(page, 400, 540, 600);
    await sleep(600);
  },
});
