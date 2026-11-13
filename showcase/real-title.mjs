// Opening slide, recorded from the real extension: the cramped sentence, the real lens switching on (every change in one step),
// the real word lens on "should", then the name card.
import { capture } from './capture.mjs';

await capture({
  name: 'title', url: '/showcase/title-page.html', width: 640, height: 360, scale: 2, seconds: 9.6, settle: 2800,
  // the word lens lives in the dock's layer, so the dock stays on; only the edge mark is hidden for this slide
  before: (page) => page.eval(`document.querySelector('#glider-root').shadowRoot.querySelector('.ll-dock').style.display = 'none'; 0`),
  run: async (page, { glide, sleep }) => {
    await page.move(560, 330); page.__at = { x: 560, y: 330 };
    await sleep(500);
    await page.eval(`document.body.classList.add('tight'); 0`);   // the text crowds together
    await sleep(1350);
    // the real lens switches on: its spacing and its bold word starts arrive together, and the page's transition carries the text there smoothly
    await page.eval(`Glider.app.update({ on: true }); document.body.classList.remove('tight'); 0`);
    await sleep(1500);
    const w = await page.eval(`(() => { const t = [...document.querySelectorAll('#s .glider-token')].find((e) => e.textContent === 'should'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height * 0.55, bottom: r.bottom }; })()`);
    if (!w) throw new Error('the word "should" was not found as a token');
    await glide(page, 60, w.bottom + 40, 300);                    // come in from below the line, so no other word is crossed
    await glide(page, w.x, w.y, 550);
    await sleep(2200);                                            // the real word lens opens and is held
    await glide(page, 690, 400, 350);                              // off the edge, so no pointer sits on the name card
    await sleep(350);
    await page.eval(`document.body.classList.add('end'); 0`);     // the name card
    await sleep(2400);
  },
});
