// Real app, scene 1: the page starts with the lens off; the pointer goes to the edge mark, opens the panel and switches the lens on.
import { capture } from './capture.mjs';

await capture({
  name: 'r1-lens', url: '/showcase/app-page.html?off', width: 1000, height: 625, seconds: 7,
  run: async (page, { glide, centre, sleep }) => {
    await page.move(420, 470); page.__at = { x: 420, y: 470 };
    await sleep(700);
    const mark = await centre(page, '.ll-pill-main', true);
    await glide(page, mark.x, mark.y, 900);
    await sleep(350);
    await page.click(mark.x, mark.y);                      // the mark opens the panel
    await sleep(900);
    const sw = await centre(page, '.ll-head [data-toggle="on"]', true);
    await glide(page, sw.x, sw.y, 600);
    await sleep(250);
    await page.click(sw.x, sw.y);                          // the header switch turns the lens on
    await sleep(1300);
    const close = await centre(page, '[data-action="collapse"]', true);
    await glide(page, close.x, close.y, 500);
    await page.click(close.x, close.y);
    await glide(page, 380, 520, 700);
    await sleep(900);
  },
});
