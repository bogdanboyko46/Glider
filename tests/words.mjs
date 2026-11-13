// Word levels in the hover lens, saving words, and the dock tucked into the screen edge.
// Runs against the demo page in harness mode (no extension needed).
//   node tests/words.mjs
import { launch, serve, IN_PAGE } from './cdp.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

const W = 1280, H = 800;
const { server, origin } = await serve();
const chrome = await launch({ width: W, height: H });
const URL_ = `${origin}/demo/sample-assignment.html?harness`;

try {
  const page = await chrome.page();
  await page.goto(URL_, 600);
  await page.eval(`localStorage.clear(); 0`);
  await page.goto(URL_, 1400);
  await page.eval(IN_PAGE);

  const rect = (sel) => page.eval(`__ll.rect(${JSON.stringify(sel)})`);
  const set = async (patch, wait = 400) => { await page.eval(`Glider.app.update(${JSON.stringify(patch)})`); await page.sleep(wait); };
  const hover = async (word, wait = 700) => {
    await page.move(40, 760);
    await page.sleep(400);
    const r = await page.eval(`(() => { const t = __ll.token(${JSON.stringify(word)}); t.scrollIntoView({ block: 'center' }); return __ll.rect(t); })()`);
    await page.sleep(200);
    const r2 = await page.eval(`__ll.rect(__ll.token(${JSON.stringify(word)}))`);
    await page.move(r2.cx, r2.cy);
    await page.sleep(wait);
    return r;
  };
  const chip = () => page.eval(`(() => { const c = __ll.q('.ll-tip .ll-level'); return c && !c.hidden ? { level: c.dataset.level, text: c.textContent } : null; })()`);
  const stored = () => page.eval(`JSON.parse(localStorage.getItem('glider:words') || '[]')`);

  const diff = () => page.eval(`(() => { const c = __ll.q('.ll-tip .ll-diff'); const w = __ll.q('.ll-tip .ll-why'); return c && !c.hidden ? { band: c.dataset.band, text: c.textContent, why: w && !w.hidden ? w.textContent : '' } : null; })()`);

  /* ---- reading difficulty and how common a word is ------------------- */
  check('settings know the new keys', await page.eval(`(() => { const s = Glider.app.state; return s.showLevels === true && s.showDefinitions === false && s.showWordParts === true && s.dockMode === 'float'; })()`));
  await hover('accumulate');
  let d = await diff();
  check('the lens says how hard the word is to read, with why', d && d.band === 'medium' && /Medium/.test(d.text) && /4 syllables/.test(d.why), JSON.stringify(d));
  let c = await chip();
  check('how common it is shows as a small CEFR tag', c && c.level === 'B2' && c.text === 'B2', JSON.stringify(c));
  check('the tag says it is about how common the word is', await page.eval(`/How common/.test(__ll.q('.ll-tip .ll-level').title)`));
  await hover('carefully');
  d = await diff();
  check('an easy word says so, without reasons', d && d.band === 'easy' && d.why === '', JSON.stringify(d));
  await hover('Epistemology');
  d = await diff();
  check('a long unlisted word is hard to read, and has no CEFR tag', d && d.band === 'hard' && (await chip()) === null, JSON.stringify(d));
  await set({ showLevels: false });
  await hover('accumulate');
  check('Word difficulty off: no chip and no tag', (await diff()) === null && (await chip()) === null && await page.eval(`!__ll.q('.ll-tip').hidden`));
  await set({ showLevels: true });

  /* ---- word parts ---------------------------------------------------- */
  await hover('carefully', 1200);
  const tags = await page.eval(`[...__ll.q('.ll-tip').querySelectorAll('.ll-tag')].map((t) => t.textContent + ':' + t.dataset.kind).join(' ')`);
  check('parts that line up with the syllables get badges on them', tags === 'base:w suffix:s suffix:s', tags);
  check('the badges sit over their chips', await page.eval(`(() => { const t = __ll.q('.ll-tip .ll-tag[data-tag="1"]'); const chips = [...__ll.q('.ll-tip').querySelectorAll('[data-chips] .ll-part, [data-chips] .ll-syl')]; const c = chips[1]; return !!t && Math.abs(t.offsetLeft - c.offsetLeft) < 1 && Math.abs(t.offsetWidth - c.offsetWidth) < 1; })()`));
  await page.eval(`__ll.q('.ll-tip .ll-tag[data-tag="1"]').click()`);
  await page.sleep(300);
  check('pressing a badge says what the part means', await page.eval(`(() => { const b = __ll.q('.ll-tip .ll-partinfo'); return !b.hidden && /-ful/.test(b.textContent) && /full of/.test(b.textContent); })()`));
  await page.eval(`__ll.q('.ll-tip .ll-tag[data-tag="0"]').click()`);
  await page.sleep(900);
  check('a base word gets its dictionary meaning', await page.eval(`(() => { const b = __ll.q('.ll-tip .ll-partinfo'); return !b.hidden && /care/.test(b.textContent) && /base word/i.test(b.textContent) && !/Looking/.test(b.textContent); })()`), await page.eval(`__ll.q('.ll-tip .ll-partinfo').textContent`));
  await page.eval(`__ll.q('.ll-tip .ll-tag[data-tag="0"]').click()`);
  await page.sleep(200);
  check('pressing it again closes it', await page.eval(`__ll.q('.ll-tip .ll-partinfo').hidden`));
  await page.click(30, 30);
  await page.sleep(300);
  await hover('perspective', 1200);
  const row = await page.eval(`(() => { const r = __ll.q('.ll-tip .ll-wparts'); return r && !r.hidden ? [...r.querySelectorAll('.ll-wpart')].map((b) => b.querySelector('b').textContent + ':' + b.dataset.kind).join(' ') : null; })()`);
  check('parts that do not line up get a "Word parts" row', row === 'per:p spect:r ive:s' && await page.eval(`!__ll.q('.ll-tip .ll-tag')`), String(row));
  await set({ showWordParts: false });
  await hover('carefully', 1200);
  check('Word parts off: no badges', await page.eval(`!__ll.q('.ll-tip .ll-tag') && __ll.q('.ll-tip .ll-wparts').hidden`));
  await set({ showWordParts: true });

  /* ---- meanings ------------------------------------------------------ */
  await hover('accumulate');
  check('the meaning is closed until asked for', await page.eval(`__ll.q('.ll-tip .ll-def').hidden && __ll.q('.ll-tip [data-act="define"]').getAttribute('aria-expanded') === 'false'`));
  await page.eval(`__ll.q('.ll-tip [data-act="define"]').click()`);
  await page.sleep(1500);
  const meaning = await page.eval(`__ll.q('.ll-tip .ll-def').textContent`);
  check('Meaning shows the dictionary definition', /verb/.test(meaning) && /gather/.test(meaning) && /WordNet/.test(meaning), meaning.slice(0, 120));
  check('outside the extension there is no "Explain simply"', await page.eval(`!__ll.q('.ll-tip [data-act="explain"]')`));
  check('the lens stays on screen', await page.eval(`(() => { const r = __ll.q('.ll-tip').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; })()`));
  await page.click(30, 30);
  await page.sleep(300);
  await set({ showDefinitions: true });
  await hover('particularly', 1500);
  check('"Show the meaning straight away" opens it with the lens', await page.eval(`!__ll.q('.ll-tip .ll-def').hidden && /adverb/.test(__ll.q('.ll-tip .ll-def').textContent)`));
  await set({ showDefinitions: false });

  /* ---- saving words -------------------------------------------------- */
  await hover('accumulate');
  check('the lens has a save button, not pressed', await page.eval(`__ll.q('.ll-tip [data-save]').getAttribute('aria-pressed') === 'false'`));
  await page.eval(`__ll.q('.ll-tip [data-save]').click()`);
  await page.sleep(300);
  let list = await stored();
  const saved = list[0] || {};
  check('saving stores the word', list.length === 1 && saved.word === 'accumulate', JSON.stringify(list.map((w) => w.word)));
  check('it keeps the level, sounds and syllables', saved.level === 'B2' && typeof saved.say === 'string' && saved.syllables.join('') === 'accumulate', JSON.stringify({ level: saved.level, say: saved.say, syl: saved.syllables }));
  check('it keeps the sentence and the page', /accumulate/i.test(saved.context) && saved.context.length <= 220 && saved.url.includes('sample-assignment.html') && !!saved.title, saved.context);
  check('it keeps how hard it is to read', saved.difficulty && saved.difficulty.band === 'medium', JSON.stringify(saved.difficulty));
  await page.sleep(800);
  const withDef = (await stored())[0] || {};
  check('and its meaning, looked up if the lens never showed it', withDef.definition && /gather/.test(withDef.definition.def) && withDef.definition.pos === 'verb', JSON.stringify(withDef.definition));
  check('the button shows it is saved', await page.eval(`__ll.q('.ll-tip [data-save]').getAttribute('aria-pressed') === 'true'`));
  check('a note confirms it', await page.eval(`/Saved “accumulate”/.test(__ll.q('.ll-toast').textContent)`));
  await hover('particularly');
  check('another word is not marked saved', await page.eval(`__ll.q('.ll-tip [data-save]').getAttribute('aria-pressed') === 'false'`));
  await hover('accumulate');
  check('coming back to a saved word shows it saved', await page.eval(`__ll.q('.ll-tip [data-save]').getAttribute('aria-pressed') === 'true'`));
  await page.eval(`__ll.q('.ll-tip [data-save]').click()`);
  await page.sleep(300);
  list = await stored();
  check('pressing again removes it', list.length === 0 && await page.eval(`__ll.q('.ll-tip [data-save]').getAttribute('aria-pressed') === 'false'`));
  await page.eval(`__ll.q('.ll-tip [data-save]').click()`);
  await page.sleep(300);
  await page.goto(URL_, 1400);
  await page.eval(IN_PAGE);
  await hover('accumulate');
  check('saved words survive a reload', await page.eval(`__ll.q('.ll-tip [data-save]').getAttribute('aria-pressed') === 'true'`));
  await page.move(40, 760);
  await page.sleep(500);

  /* ---- tucked into the edge ------------------------------------------ */
  await page.eval(`scrollTo(0, 0)`);
  const floatPill = await rect('.ll-pill');
  check('the header has tuck and Glider page buttons', await page.eval(`!!__ll.q('[data-action="dock-mode"]') && !!__ll.q('[data-action="open-page"]')`));
  await page.eval(`__ll.q('.ll-pill-main').click()`);
  await page.sleep(400);
  await page.eval(`__ll.q('[data-action="dock-mode"]').click()`);
  await page.sleep(600);
  check('tucking closes the panel and saves the style', await page.eval(`Glider.app.state.dockMode === 'edge' && __ll.q('.ll-dock').dataset.open === 'false' && __ll.q('.ll-dock').dataset.mode === 'edge'`));
  let tab = await rect('.ll-pill');
  check('the tab is slim and flush with the right edge', Math.abs(tab.x + tab.w - W) <= 1 && tab.w <= 34 && tab.h > tab.w * 2, JSON.stringify(tab));
  // A scripted click counts as a key press, so focus moved to the tab (which brightens it): blur first.
  check('keyboard focus brightens the tab', await page.eval(`Number(getComputedStyle(__ll.q('.ll-pill')).opacity) === 1`));
  await page.eval(`__ll.root().activeElement && __ll.root().activeElement.blur()`);
  await page.sleep(500);
  check('the tab is quiet until hovered', await page.eval(`Number(getComputedStyle(__ll.q('.ll-pill')).opacity) < 0.7`));
  await page.move(tab.cx, tab.cy);
  await page.sleep(500);
  check('hovering the tab brightens it', await page.eval(`Number(getComputedStyle(__ll.q('.ll-pill')).opacity) === 1`));
  check('the switch is hidden on the tab', await page.eval(`getComputedStyle(__ll.q('.ll-pill .ll-switch')).display === 'none'`));
  await page.click(tab.cx, tab.cy);
  await page.sleep(600);
  const panel = await rect('.ll-panel');
  check('clicking the tab opens the panel from the edge, on screen', await page.eval(`__ll.q('.ll-dock').dataset.open === 'true'`) && Math.abs(W - (panel.x + panel.w) - 8) <= 1 && panel.y >= 0 && panel.y + panel.h <= H, JSON.stringify(panel));
  check('the header button now offers to float', await page.eval(`__ll.q('[data-action="dock-mode"]').title === 'Float in the corner'`));
  await page.eval(`__ll.q('[data-action="collapse"]').click()`);
  await page.sleep(500);
  tab = await rect('.ll-pill');
  await page.drag(tab.cx, tab.cy, 60, 200);
  await page.sleep(500);
  tab = await rect('.ll-pill');
  check('dragging the tab to the other side moves it to the left edge', tab.x <= 1 && tab.y < 400 && await page.eval(`Glider.app.dockPos.h === 'l'`), JSON.stringify(tab));
  check('dragging does not open the panel', await page.eval(`__ll.q('.ll-dock').dataset.open === 'false'`));
  await page.goto(URL_, 1400);
  await page.eval(IN_PAGE);
  tab = await rect('.ll-pill');
  check('the tab and its edge survive a reload', tab.x <= 1 && tab.w <= 34, JSON.stringify(tab));
  await set({ dockMode: 'float' }, 700);
  const back = await rect('.ll-pill');
  check('floating again puts the pill back off the edge', back.x >= 8 && back.w > 60, JSON.stringify(back));
  check('no page errors or warnings', page.errors.length === 0, page.errors.join(' | '));
  void floatPill;
} catch (error) {
  check('run finished without throwing', false, error.stack || String(error));
} finally {
  await chrome.close();
  server.close();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
