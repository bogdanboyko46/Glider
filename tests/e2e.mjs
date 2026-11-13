// End-to-end behaviour checks, run against the demo page in harness mode.
//   node tests/e2e.mjs
import { launch, serve, IN_PAGE } from './cdp.mjs';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`);
};

const { server, origin } = await serve();
const chrome = await launch({ width: 1280, height: 800 });
const URL_ = `${origin}/demo/sample-assignment.html?harness`;

try {
  const page = await chrome.page();
  await page.goto(URL_, 1000);
  // Start with the lens off so the untouched page can be recorded.
  await page.eval(`localStorage.clear(); localStorage.setItem('glider:settings:v2', JSON.stringify({ on: false })); 0`);
  await page.goto(URL_, 1200);
  await page.eval(IN_PAGE);

  const rect = (sel) => page.eval(`__ll.rect(${JSON.stringify(sel)})`);
  const clickSel = async (sel, wait = 300) => {
    const r = await rect(sel);
    if (!r) throw new Error('missing ' + sel);
    await page.click(r.cx, r.cy);
    await page.sleep(wait);
  };
  const state = () => page.eval('JSON.parse(JSON.stringify(Glider.app.state))');
  const set = async (patch, wait = 500) => { await page.eval(`Glider.app.update(${JSON.stringify(patch)})`); await page.sleep(wait); };
  const count = (sel) => page.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  const htmlHas = (cls) => page.eval(`document.documentElement.classList.contains(${JSON.stringify(cls)})`);

  /* ---- boot, lens off -------------------------------------------------- */
  check('dock is mounted in a shadow root', await page.eval(`!!document.querySelector('#glider-root').shadowRoot.querySelector('.ll-pill')`));
  check('lens off: page is untouched', (await count('.glider-wrap')) === 0 && !(await page.eval(`[...document.documentElement.classList].some((c) => c.startsWith('glider-'))`)));
  const baseline = await page.eval('document.body.innerHTML');
  const baselineText = await page.eval(`document.querySelector('article').textContent`);
  check('no voice code is loaded', await page.eval(`typeof Glider.TTSEngine === 'undefined' && !__ll.root().querySelector('[data-say], [data-action="play"]')`));
  check('no profiles or tabs: one panel', await page.eval(`!__ll.root().querySelector('[data-profile], [role="tab"]')`));

  /* ---- pill / panel, every design -------------------------------------- */
  await clickSel('.ll-pill-main');
  check('clicking the pill opens the panel', await page.eval(`__ll.q('.ll-dock').dataset.open === 'true'`));
  const p = await rect('.ll-panel');
  const scroll = await page.eval(`(() => { const b = __ll.q('.ll-body'); return b.scrollHeight - b.clientHeight; })()`);
  check('panel fits on screen with nothing to scroll', p.x >= 0 && p.y >= 0 && p.x + p.w <= 1280 && p.y + p.h <= 800 && scroll <= 0, JSON.stringify(p));
  check('the dock uses the Sage design', await page.eval(`__ll.q('.ll').dataset.skin === 'sage' && getComputedStyle(__ll.q('.ll-panel')).backgroundColor === 'rgb(238, 242, 234)'`));
  check('no design picker, tint control, word preview, logo or hint', await page.eval(`!__ll.root().querySelector('[data-skin-pick], [data-tint], [data-sample], .ll-foot, .ll-mark, .ll-hero')`));
  await set({ skin: 'pop' }, 200);
  check('a different design cannot be set', (await state()).skin === 'sage' && !('tint' in (await state())));

  /* ---- one switch turns everything on ---------------------------------- */
  await clickSel('.ll-head [data-toggle="on"]', 900);
  const s1 = await state();
  check('the header switch turns the lens on', s1.on === true && await page.eval(`__ll.q('.ll-head [data-toggle="on"]').getAttribute('aria-checked') === 'true'`));
  const classes = await page.eval(`['glider-spacing','glider-bionic','glider-syllables'].every((c) => document.documentElement.classList.contains(c))`);
  check('one switch: spacing, bionic and hover lens all on', classes);
  check('tokens created', (await count('.glider-token')) > 200, String(await count('.glider-token')));
  const fix = await page.eval(`(() => { const out = {}; for (const w of ['is','that','knowledge','Epistemology']) { const t = __ll.token(w); out[w] = t ? t.querySelector('.glider-fix').textContent : null; } return out; })()`);
  check('bionic: fixation lengths (1 / 2 / 40%)', fix.is === 'i' && fix.that === 'th' && fix.knowledge === 'know' && fix.Epistemology === 'Epist', JSON.stringify(fix));
  check('text content unchanged', (await page.eval(`document.querySelector('article').textContent`)) === baselineText);
  const skipped = await page.eval(`['pre','code','textarea','[contenteditable]','input','button','script','style'].map((s) => document.querySelectorAll(s + ' .glider-token').length).reduce((a, b) => a + b, 0)`);
  check('skips code, form fields, editable regions and buttons', skipped === 0, String(skipped));
  check('dock itself is never tokenised', await page.eval(`__ll.root().querySelectorAll('.glider-token').length === 0`));
  const margin = await page.eval(`getComputedStyle(document.querySelector('.glider-punct')).marginRight`);
  check('prosody: punctuation gets 0.35em pause', parseFloat(margin) > 3, margin);
  const homo = await page.eval(`['principal','affect','effect','Their','thorough'].map((w) => { const t = __ll.token(w); return !!t && t.classList.contains('glider-homophone'); })`);
  check('look-alike words underlined', homo.every(Boolean), JSON.stringify(homo));
  check('ordinary words not underlined', await page.eval(`!__ll.token('philosophy').classList.contains('glider-homophone')`));
  const para = await page.eval(`(() => { const cs = getComputedStyle(document.querySelector('.reading p')); return { align: cs.textAlign, ls: cs.letterSpacing, ws: cs.wordSpacing, lh: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) }; })()`);
  check('spacing guard on at its defaults', para.align === 'left' && para.ls === '1px' && para.ws === '3px' && Math.abs(para.lh - 1.8) < 0.02, JSON.stringify(para));
  check('no page tint is applied', await page.eval(`!document.getElementById('glider-tint') && !document.documentElement.classList.contains('glider-invert')`));
  check('fine-tuning is live only while the lens is on', await page.eval(`!__ll.q('.ll-body').hasAttribute('inert')`));

  /* ---- hover lens ------------------------------------------------------- */
  await clickSel('[data-action="collapse"]');
  let r = await page.eval(`__ll.rect(__ll.token('Epistemology'))`);
  await page.move(r.cx, r.cy);
  await page.sleep(500);
  const tip1 = await page.eval(`(() => { const t = __ll.q('.ll-tip'); return { hidden: t.hidden, syls: t.querySelectorAll('.ll-syl, .ll-part-letters').length, text: [...t.querySelectorAll('.ll-syl, .ll-part-letters')].map((e) => e.textContent).join(''), buttons: t.querySelectorAll('button').length }; })()`);
  check('hovering a long word splits it into syllables', !tip1.hidden && tip1.syls === 6 && tip1.text.replace(/·/g, '') === 'Epistemology', JSON.stringify(tip1));
  check('the lens has a Hear word button', await page.eval(`__ll.q('.ll-tip [data-say="word"]').getAttribute('aria-label') === 'Hear Epistemology'`));
  await page.sleep(600);
  const parts1 = await page.eval(`(() => { const t = __ll.q('.ll-tip'); return { letters: [...t.querySelectorAll('.ll-part-letters')].map((e) => e.textContent).join('|'), sounds: [...t.querySelectorAll('.ll-part-sound')].map((e) => e.textContent).join('|'), stress: [...t.querySelectorAll('.ll-part[data-stress="true"] .ll-part-sound')].map((e) => e.textContent).join('|'), dupe: !!t.querySelector('.ll-syls'), slow: !t.querySelector('[data-say="slow"]').hidden }; })()`);
  check('each written chunk shows the sound it makes', parts1.letters === 'E|pis|te|mol|o|gy' && parts1.sounds === 'eh|pihs|tuh|mahl|uh|jee' && !parts1.dupe, JSON.stringify(parts1));
  check('the stressed part is marked', parts1.stress === 'mahl', parts1.stress);
  await page.eval(`(() => { window.__spoken = []; const S = speechSynthesis; S.speak = (u) => { window.__spoken.push(u.text + '@' + Math.round(u.rate * 10)); setTimeout(() => u.onend && u.onend(), 30); }; S.cancel = () => {}; })()`);
  await page.eval(`__ll.q('.ll-tip [data-say="word"]').click()`);
  await page.sleep(200);
  check('Hear word says the whole word, slowly', (await page.eval('window.__spoken.join(",")')) === 'Epistemology@8', await page.eval('window.__spoken.join(",")'));
  await page.eval(`window.__spoken = []; __ll.q('.ll-tip [data-part="3"]').click()`);
  await page.sleep(200);
  check('tapping a part says just that sound, in a spelling the voice reads right', (await page.eval('window.__spoken.join(",")')) === 'maal@7', await page.eval('window.__spoken.join(",")'));
  await page.eval(`window.__spoken = []; window.__lit = []; const mo = new MutationObserver(() => { const now = [...__ll.q('.ll-tip').querySelectorAll('.ll-part[data-now]')].map((e) => e.dataset.part).join(''); if (now && window.__lit[window.__lit.length - 1] !== now) window.__lit.push(now); }); mo.observe(__ll.q('.ll-tip'), { subtree: true, attributes: true }); __ll.q('.ll-tip [data-say="slow"]').click()`);
  await page.sleep(3200);
  const slow1 = await page.eval('window.__spoken.join(",") + " / " + window.__lit.join(",")');
  check('Sound it out says each part in turn, then the word, lighting each part', slow1 === 'eh@7,pihss@7,tuh@7,maal@7,uh@7,jie@7,Epistemology@8 / 0,1,2,3,4,5,012345', slow1);
  check('no ruler and no ruler control', await page.eval(`!document.getElementById('glider-ruler') && !__ll.root().querySelector('[data-toggle="ruler"], [data-lines]')`));
  const tipBox = await rect('.ll-tip');
  check('lens sits above the word, on screen', tipBox.y >= 0 && tipBox.y + tipBox.h <= r.y + 2 && tipBox.x >= 0, JSON.stringify(tipBox));
  await page.move(tipBox.cx, tipBox.cy);
  await page.sleep(500);
  check('lens stays open while the pointer is on it', await page.eval(`!__ll.q('.ll-tip').hidden`));
  await page.move(40, 700);
  await page.sleep(700);
  check('lens hides after leaving', await page.eval(`__ll.q('.ll-tip').hidden`));
  check('short words do not open the lens', await page.eval(`!__ll.token('that').classList.contains('glider-long')`));
  r = await page.eval(`__ll.rect(__ll.token('principal'))`);
  await page.move(r.cx, r.cy);
  await page.sleep(500);
  const tip2 = await page.eval(`(() => { const t = __ll.q('.ll-tip'); return { pairs: t.querySelectorAll('.ll-pair').length, syls: t.querySelectorAll('.ll-syl, .ll-part-letters').length, current: t.querySelector('[data-current="true"] .ll-pair-word') ? t.querySelector('[data-current="true"] .ll-pair-word').textContent : '' }; })()`);
  check('a look-alike word shows its syllables and its pair', tip2.pairs === 2 && tip2.syls >= 2 && tip2.current.startsWith('principal'), JSON.stringify(tip2));
  await page.move(40, 700);
  await page.sleep(600);
  await page.eval(`__ll.token('Justification').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); 0`);
  await page.sleep(900);
  check('double-click pins the lens open', await page.eval(`!__ll.q('.ll-tip').hidden && Glider.app.tip.pinned`));
  await page.click(40, 700);
  await page.sleep(300);
  check('clicking elsewhere closes a pinned lens', await page.eval(`__ll.q('.ll-tip').hidden`));

  /* ---- fine tuning ------------------------------------------------------ */
  await set({ letterSpacing: 2, wordSpacing: 6, lineHeight: 2.2 });
  const para2 = await page.eval(`(() => { const cs = getComputedStyle(document.querySelector('.reading p')); return { ls: cs.letterSpacing, ws: cs.wordSpacing, lh: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize) }; })()`);
  check('spacing sliders change the page', para2.ls === '2px' && para2.ws === '6px' && Math.abs(para2.lh - 2.2) < 0.02, JSON.stringify(para2));
  await clickSel('.ll-pill-main');
  await clickSel('[data-toggle="mirror"]', 600);
  check('b d p q colours: letters marked', (await count('.glider-m-b')) > 10 && (await count('.glider-m-q')) > 0);
  check('b d p q colours work inside the bold part', (await count('.glider-fix .glider-m')) > 5);
  await clickSel('[data-toggle="mirror"]', 600);
  check('b d p q colours off again, bionic kept', (await count('.glider-m')) === 0 && (await count('.glider-fix')) > 200);
  await clickSel('[data-toggle="font"]', 500);
  check('hyperlegible font applied and loaded', await page.eval(`getComputedStyle(document.querySelector('.reading p')).fontFamily.includes('Glider Atkinson') && document.fonts.check('16px "Glider Atkinson"')`));
  await clickSel('[data-toggle="font"]', 300);
  const sizeOf = () => page.eval(`(() => { const p = document.querySelector('.reading p'); const li = document.querySelector('.reading li p, .reading blockquote p'); return { z: p.currentCSSZoom, nested: li ? li.currentCSSZoom : null, h: p.getBoundingClientRect().height, w: p.getBoundingClientRect().width, sx: document.documentElement.scrollWidth - innerWidth }; })()`);
  const size0 = await sizeOf();
  check('text size starts at the page size', size0.z === 1 && !(await htmlHas('glider-size')), JSON.stringify(size0));
  await page.eval(`(() => { const r = __ll.q('[data-range="fontSize"]'); r.value = '130'; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.sleep(400);
  const size1 = await sizeOf();
  check('the size slider enlarges body text', (await state()).fontSize === 130 && Math.abs(size1.z - 1.3) < 0.01 && size1.h > size0.h * 1.3, JSON.stringify(size1));
  check('larger text reflows in the same column, no sideways scroll', Math.abs(size1.w - size0.w) < 2 && size1.sx <= 0, JSON.stringify(size1));
  check('nested text is not enlarged twice', size1.nested === null || Math.abs(size1.nested - 1.3) < 0.01, String(size1.nested));
  check('the size value is shown', await page.eval(`__ll.q('[data-value="fontSize"]').textContent === '130%'`));
  await set({ fontSize: 100 }, 300);
  check('back to 100% removes the scaling', (await sizeOf()).z === 1 && !(await htmlHas('glider-size')));
  check('text content still unchanged', (await page.eval(`document.querySelector('article').textContent`)) === baselineText);

  /* ---- shortcut --------------------------------------------------------- */
  await clickSel('[data-action="collapse"]');
  await page.key('l', { alt: true, code: 'KeyL' });
  await page.sleep(400);
  check('Alt+L opens the dock', await page.eval(`__ll.q('.ll-dock').dataset.open === 'true'`));

  /* ---- off restores the page exactly ------------------------------------ */
  await set({ letterSpacing: 1, wordSpacing: 3, lineHeight: 1.8 }, 200);
  await clickSel('.ll-head [data-toggle="on"]', 900);
  const after = await page.eval('document.body.innerHTML');
  check('switching off returns the exact original DOM', after === baseline, `len ${baseline.length} vs ${after.length}`);
  check('switching off clears html classes and variables', await page.eval(`![...document.documentElement.classList].some((c) => c.startsWith('glider-')) && document.documentElement.getAttribute('style') in { '': 1, null: 1 }`), await page.eval(`document.documentElement.className + ' | ' + document.documentElement.getAttribute('style')`));
  check('fine-tuning is inert while off', await page.eval(`__ll.q('.ll-body').hasAttribute('inert')`));
  await clickSel('.ll-head [data-toggle="on"]', 900);

  /* ---- content added later (single-page apps) ------------------------- */
  await page.eval(`document.getElementById('load-more').click()`);
  await page.sleep(600);
  check('off-screen content waits (lazy)', (await count('#late-content .glider-token')) === 0);
  await page.eval(`document.getElementById('late-content').scrollIntoView()`);
  await page.sleep(900);
  check('content added after load is tokenised once near the viewport', (await count('#late-content .glider-token')) > 10, String(await count('#late-content .glider-token')));
  await page.eval(`scrollTo(0, 0)`);
  await page.sleep(300);

  /* ---- dragging -------------------------------------------------------- */
  await clickSel('[data-action="collapse"]');
  const p0 = await rect('.ll-pill-main');
  await page.drag(p0.cx, p0.cy, 200, 150);
  await page.sleep(400);
  const p1 = await rect('.ll-pill');
  check('the edge mark can be dragged: it follows the pointer up the screen and snaps to the nearer side', p1.x <= 2 && Math.abs(p1.cy - 150) < 40, JSON.stringify(p1));
  check('dragging does not open the panel', await page.eval(`__ll.q('.ll-dock').dataset.open === 'false'`));
  check('the edge mark is bare: five strokes, no switch, no label, no box', await page.eval(`(() => { const p = __ll.q('.ll-pill'); const cs = getComputedStyle(p); return p.querySelectorAll('.ll-strokes i').length === 5 && !p.querySelector('.ll-switch, .ll-pill-name') && cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.boxShadow === 'none'; })()`));
  await set({ on: false }, 500);
  const offMark = await page.eval(`(() => { const i = __ll.q('.ll-strokes i:nth-child(3)'); return { on: __ll.q('.ll-pill').dataset.on, w: Math.round(i.getBoundingClientRect().width), panel: __ll.q('.ll-dock').dataset.open }; })()`);
  check('lens off: the mark draws its strokes back and the page is untouched', offMark.on === 'false' && offMark.w <= 18 && offMark.panel === 'false' && (await count('.glider-wrap')) === 0, JSON.stringify(offMark));
  await set({ on: true }, 700);
  check('and on again', (await state()).on === true && (await count('.glider-token')) > 200 && await page.eval(`Math.round(__ll.q('.ll-strokes i:nth-child(3)').getBoundingClientRect().width) >= 32`));
  await clickSel('.ll-pill-main');
  const moved = await rect('.ll-panel');
  check('panel opens inward from the new corner, on screen', moved.x >= 0 && moved.y >= 0 && moved.x + moved.w <= 1280 && moved.y + moved.h <= 800, JSON.stringify(moved));
  const head = await rect('.ll-head');
  await page.drag(head.x + 150, head.cy, 900, 300);
  await page.sleep(400);
  const dragged = await rect('.ll-panel');
  check('open panel can be dragged by its header', dragged.x > moved.x + 200, `${moved.x} -> ${dragged.x}`);

  /* ---- persistence ------------------------------------------------------ */
  await set({ fontSize: 120 }, 300);
  await clickSel('[data-toggle="mirror"]', 300);
  const posBefore = await page.eval('JSON.stringify(Glider.app.dockPos)');
  await page.goto(URL_, 1500);
  await page.eval(IN_PAGE);
  const s2 = await state();
  check('settings survive a reload', s2.on === true && s2.fontSize === 120 && s2.mirror === true);
  check('the lens re-applies after reload', (await count('.glider-homophone')) > 5 && await htmlHas('glider-bionic'));
  const posAfter = await page.eval('JSON.stringify(Glider.app.dockPos)');
  check('dock position survives a reload', posBefore === posAfter && JSON.parse(posAfter).x !== 20, `${posBefore} vs ${posAfter}`);

  check('no page errors or warnings', page.errors.length === 0, page.errors.slice(0, 5).join(' || '));
} catch (error) {
  check('test run completed', false, error.stack || String(error));
} finally {
  await chrome.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
