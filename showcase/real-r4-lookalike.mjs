// Real app, scene 4: the pointer rests on an underlined look-alike word and the real card shows the pair.
import { capture } from './capture.mjs';

// First of these that the real engine has underlined as a look-alike.
const lookalike = (page) => page.eval(`(() => { for (const w of ['effect', 'their', 'whether']) { const el = [...document.querySelectorAll('.glider-token.glider-homophone')].find((t) => t.textContent.trim().toLowerCase() === w); if (el) { const r = el.getBoundingClientRect(); return { word: w, x: r.left + r.width / 2, y: r.top + r.height / 2 }; } } return null; })()`);
const cardShown = (page) => page.eval(`(() => { const t = document.querySelector('#glider-root').shadowRoot.querySelector('.ll-tip:not([hidden])'); return !!(t && t.dataset.show === 'true' && t.querySelector('.ll-pair')); })()`);

await capture({
  name: 'r4-lookalike', url: '/showcase/app-page.html', width: 1000, height: 625, seconds: 6, settle: 2600,
  run: async (page, { glide, sleep }) => {
    // Up the left margin and along the word's own line, so no other word's lens opens on the way.
    await page.move(90, 540); page.__at = { x: 90, y: 540 };
    await sleep(400);
    const w = await lookalike(page);
    if (!w) throw new Error('no look-alike word is underlined on the page');
    await glide(page, 112, w.y, 500);
    await glide(page, w.x, w.y, 500);                      // rest on the word: the real card opens
    let ok = false;
    for (let i = 0; i < 30 && !ok; i++) { await sleep(50); ok = await cardShown(page); }
    if (!ok) throw new Error('the look-alike card never appeared for ' + w.word);
    console.log('look-alike word used:', w.word);
    await sleep(2500);                                     // hold on the pair
    await glide(page, 100, w.y + 150, 700);          // move away: the card leaves
    await sleep(700);
  },
});
