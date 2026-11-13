// Real app, scene 3: the pointer rests on a long word, the real lens opens, "Sound it out" is pressed and the
// real chunk-by-chunk highlight runs. Headless Chrome has no voice, so speech is stubbed (no audio): each
// utterance "ends" after 240 ms, which is what advances the real highlight.
import { capture } from './capture.mjs';

const WORD = 'approximately';
const tokenCentre = (page, text) => page.eval(`(() => { const el = [...document.querySelectorAll('.glider-token')].find((t) => t.textContent.trim().toLowerCase() === ${JSON.stringify(text)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const slowButton = (page) => page.eval(`(() => { const b = document.querySelector('#glider-root').shadowRoot.querySelector('.ll-tip:not([hidden]) [data-say="slow"]:not([hidden])'); if (!b) return null; const r = b.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);

const meaningButton = (page) => page.eval(`(() => { const b = document.querySelector('#glider-root').shadowRoot.querySelector('.ll-tip:not([hidden]) [data-act="define"]'); if (!b) return null; const r = b.getBoundingClientRect(); return r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);

await capture({
  name: 'r3-wordlens', url: '/showcase/app-page.html', width: 1000, height: 625, seconds: 7, settle: 2600,   // extra settle: the level and sound data load first
  before: (page) => page.eval(`(() => { const S = window.speechSynthesis; if (!S) return 0; S.speak = (u) => { setTimeout(() => u.onend && u.onend(), 240); }; S.cancel = () => {}; return 1; })()`),
  run: async (page, { glide, sleep }) => {
    // Come up the left margin and along the word's own line, so the pointer never rests on another
    // long word on the way (that would open that word's lens over this one).
    await page.move(90, 430); page.__at = { x: 90, y: 430 };
    await sleep(250);
    const word = await tokenCentre(page, WORD);
    if (!word) throw new Error('token not found: ' + WORD);
    await glide(page, 112, word.y, 500);
    await glide(page, word.x, word.y, 550);                // rest on the word: the real lens opens
    let btn = null;
    for (let i = 0; i < 30 && !btn; i++) { await sleep(50); btn = await slowButton(page); }
    if (!btn) throw new Error('"Sound it out" never appeared');
    await sleep(300);
    await glide(page, btn.x, btn.y, 450);
    await sleep(150);
    await page.click(btn.x, btn.y);                        // the real chunk-by-chunk run
    await sleep(2950);                                     // five parts, then the whole word
    const mean = await meaningButton(page);
    if (mean) {                                            // then the real definition opens inside the lens
      await glide(page, mean.x, mean.y, 300);
      await page.click(mean.x, mean.y);
      await sleep(900);
    }
  },
});
