// node tests/adapt.mjs — "Adapt ahead" in headless Chrome.
// Runs adapt/splitter.js + reorder.js + profile.js + adapt.js on the gaze test article with a fake chrome.*,
// with the stored mode 'on' (no tracker needed), and checks what happens to the page. The tracker's
// 'line' / 'struggle' / 'status' events are handed to the script the way GazeReader would.
import { launch, serve } from './cdp.mjs';

let failed = 0;
const check = (ok, label, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '  -> ' + detail : ''}`); if (!ok) failed += 1; };

const LEASE = 'Deductions shall be proportionate to the dilapidation attributable to the Tenant, excluding deterioration attributable to ordinary wear; provided, however, that where the Tenant disputes the apportionment, the burden of substantiating that the dilapidation predated the tenancy shall be borne by the Tenant, who shall be obliged to do so through thorough photographic documentation.';
const IF = 'If you disagree, you must prove the damage was already there.';
const IF_MOVED = 'You must prove the damage was already there if you disagree.';
const TAIL = ' The agent keeps a list of every mark on the walls.';
const BLOCKS = {
  long: LEASE,
  mix: 'The deposit is held by the agent. ' + LEASE + ' Ask for a copy of the list.',
  re: IF + TAIL,
  link: 'If you <a href="#x">disagree</a>, you must prove the damage was already there.' + TAIL,
  both: IF + ' ' + LEASE,
};

const SETUP = `(async () => {
  await chrome.storage.local.set({ 'glider:adapt': { mode: 'on' }, 'glider:settings:v2': { on: true, gaze: false, seeOriginal: false } });
  await new Promise((ok, bad) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/glider-extension/content/content.css'; l.onload = ok; l.onerror = bad; document.head.appendChild(l); });
  window.__add = (id, html) => { const p = document.createElement('p'); p.id = id; p.innerHTML = html; document.body.appendChild(p); return p; };
  window.__orig = {};
  for (const [id, html] of Object.entries(${JSON.stringify(BLOCKS)})) { const p = __add(id, html); __orig[id] = { html: p.innerHTML, text: p.textContent, nodes: p.childNodes.length }; }
  { const p = __add('narrow', ${JSON.stringify(LEASE)}); p.style.width = '420px'; __orig.narrow = { html: p.innerHTML, text: p.textContent, nodes: p.childNodes.length }; }
  // The x position where each line of text starts: for the first part, and for every later part.
  window.__lines = (id) => { const el = document.getElementById(id);
    const starts = (range) => { const out = []; for (const r of range.getClientRects()) { if (r.width > 1 && !out.some((o) => Math.abs(o.top - r.top) < 8)) out.push({ top: r.top, left: Math.round(r.left) }); } return out.map((o) => o.left); };
    const boxes = [...el.querySelectorAll('.glider-adapt-part')];
    const head = document.createRange(); head.setStart(el, 0); head.setEndBefore(boxes[0]);
    return { left: Math.round(el.getBoundingClientRect().left), em: parseFloat(getComputedStyle(el).fontSize), first: starts(head),
      parts: boxes.map((b) => { const r = document.createRange(); r.selectNodeContents(b); return starts(r); }) }; };
  window.__reading = document.createElement('p'); __reading.id = 'reading'; __reading.textContent = ${JSON.stringify(LEASE)};
  window.__gliderAllowSplit = true;   // the split rule is off in the product (layout change); its machinery is still tested here
  for (const src of ['adapt/splitter.js', 'adapt/reorder.js', 'adapt/profile.js', 'adapt/adapt.js']) {
    await new Promise((ok, bad) => { const s = document.createElement('script'); s.src = '/glider-extension/' + src; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
  }
  await GliderAdapt.ready;
  window.__look = (id) => { const el = document.getElementById(id); const o = __orig[id] || {};
    const ind = [...el.querySelectorAll('.glider-adapt-part')].map((i) => { const r = i.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(parseFloat(getComputedStyle(i).paddingLeft)) }; });
    const range = document.createRange(); range.selectNodeContents(el);
    const first = range.getClientRects()[0];
    const t = el.querySelector('.glider-adapt-toggle');
    return { br: el.querySelectorAll('.glider-adapt-br, .glider-adapt-part').length, ind, left: Math.round(first.left), top: Math.round(first.top), em: parseFloat(getComputedStyle(el).fontSize),
      text: el.textContent, inner: el.innerText, sameText: el.textContent === o.text, sameHtml: el.innerHTML === o.html, nodes: el.childNodes.length, wraps: el.querySelectorAll('.glider-wrap').length,
      moved: el.querySelectorAll('.glider-adapt-moved').length,
      toggle: t ? { role: t.getAttribute('role'), tab: t.tabIndex, name: t.getAttribute('aria-label'), pressed: t.getAttribute('aria-pressed'), text: t.textContent, title: t.title,
        opacity: getComputedStyle(t).opacity, w: t.getBoundingClientRect().width, last: el.contains(t) && !t.nextSibling, focused: document.activeElement === t } : null }; };
  window.__lineRect = (id, n) => { const el = document.getElementById(id); const range = document.createRange(); range.selectNodeContents(el);
    const tops = []; for (const r of range.getClientRects()) { if (r.width > 1 && !tops.some((t) => Math.abs(t.top - r.top) < 8)) tops.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }); }
    return tops[n]; };
  window.__leaves = (v) => { let ok = true; const walk = (x, k) => { if (x && typeof x === 'object') { for (const key of Object.keys(x)) walk(x[key], key); } else if (!(typeof x === 'number' || (k === 'mode' && typeof x === 'string'))) ok = false; }; walk(v, ''); return ok; };
  return typeof GliderAdapt === 'object' && GliderAdapt.mode() === 'on';
})()`;

const { server, origin } = await serve();
const chrome = await launch({ width: 1100, height: 900 });
try {
  const page = await chrome.page();
  await page.goto(`${origin}/tests/gaze-site/harness.html`, 600);
  check(await page.eval(SETUP), "the scripts load next to the tracker; stored mode 'on' applies with the tracker idle");
  const look = (id) => page.eval(`__look('${id}')`);

  // ---- split: layout only
  let s = await look('long');
  check(s.br === 4 && s.ind.length === 4, 'the long sentence is set out in five parts (four later parts, each a block of its own)', `${s.br} breaks`);
  check(s.sameText && s.text === LEASE, 'textContent of the split paragraph is unchanged, character for character');
  const tops = [s.top, ...s.ind.map((i) => i.top)];
  check(tops.every((t, i) => i === 0 || t > tops[i - 1]) && s.ind.every((i) => i.left === s.left), 'each part starts a new line, its block at the left edge', JSON.stringify(tops));
  check(s.ind.every((i) => Math.abs(i.w - 1.5 * s.em) <= 1), 'later parts are indented by 1.5em', JSON.stringify(s.ind.map((i) => i.w)));
  check(s.inner.split('\n').length === 5 && s.inner.replace(/\s+/g, ' ').trim() === LEASE, 'what is shown is the same words on five lines');
  check(s.toggle === null && (await page.eval(`document.querySelectorAll('.glider-adapt-toggle').length`)) === 0, '"See original" is off by default: no control is added anywhere');
  const quiet = await page.eval(`(() => { const i = document.querySelector('#long .glider-adapt-part'); const c = getComputedStyle(i), p = getComputedStyle(document.getElementById('long'));
    return [c.transitionDuration, c.animationName, p.transitionDuration, p.animationName].join(' '); })()`);
  check(quiet === '0s none 0s none', 'nothing is animated', quiet);

  const n = JSON.parse(await page.eval(`JSON.stringify(__lines('narrow'))`));
  const indentX = n.left + Math.round(1.5 * n.em);
  check(n.parts.length === 4 && n.parts.some((p) => p.length > 1) && n.parts.every((p) => p.every((x) => Math.abs(x - indentX) <= 1)), 'in a narrow column a later part wraps, and its continuation lines start at the indent, not at the left edge', JSON.stringify(n.parts) + ' indent at ' + indentX);
  check(n.first.length > 1 && n.first.every((x) => Math.abs(x - n.left) <= 1), 'the first part stays flush left on every line', JSON.stringify(n.first) + ' left edge ' + n.left);
  check((await look('narrow')).sameText, 'textContent of the narrow paragraph is unchanged');
  s = await look('mix');
  check(s.br === 5 && s.ind.length === 4 && s.sameText, 'among short sentences: the long one gets its own lines, the short ones are left whole; textContent unchanged', `${s.br} breaks`);

  // ---- reorder: words moved, none added or removed
  s = await look('re');
  check(s.text === IF_MOVED + TAIL && s.moved === 1 && s.br === 0, 'a sentence that opens with a subordinate clause is shown main clause first', s.text);
  check(await page.eval(`GliderReorder.sameWords(__orig.re.text, document.getElementById('re').textContent)`), 'the reordered paragraph holds exactly the same words');
  s = await look('link');
  check(s.sameHtml, 'a sentence that runs through a link is left as it is');
  s = await look('both');
  check(s.text === IF_MOVED + ' ' + LEASE && s.br === 5 && s.ind.length === 4, 'both rules in one paragraph: reordered first, then the long sentence split', `${s.br} breaks`);
  const st = await page.eval(`JSON.stringify(GliderAdapt.state(document.getElementById('both')).did)`);
  check(st === '{"reorder":true,"split":true}', 'both rules are recorded for that block', st);

  // ---- the original comes back exactly, and such a block is then left alone
  await page.eval(`for (const id of ['long', 'mix', 're', 'both']) GliderAdapt.showOriginal(document.getElementById(id)); 0`);
  for (const id of ['long', 'mix', 're', 'both']) {
    s = await look(id);
    check(s.sameHtml && s.sameText && s.nodes === (await page.eval(`__orig.${id}.nodes`)), `show original (${id}): the paragraph is exactly as the page wrote it, same nodes`);
  }
  await page.eval(`GliderAdapt.refresh(true); 0`);
  check((await look('mix')).br === 0 && (await look('re')).moved === 0, 'a block the reader put back is not adapted again');
  let prof = await page.eval(`JSON.stringify(GliderAdapt.profile())`);
  check(JSON.parse(prof).split.undone === 3 && JSON.parse(prof).reorder.undone === 2 && JSON.parse(prof).split.adapted.struggled === 3, 'asking for the original counts against each rule applied there', prof);
  await page.eval(`for (const id of ['long', 're', 'both']) GliderAdapt.adaptAgain(document.getElementById(id)); 0`);
  check((await look('long')).br === 4 && (await look('re')).text === IF_MOVED + TAIL && (await look('both')).br === 5, 'and it can be adapted again on request');

  // ---- "See original" switched on: a faint control
  await page.eval(`GliderAdapt.setHost({ lensOn: true, adaptive: false, control: true }); 0`);
  s = await look('long');
  let t = s.toggle;
  check(!!t && t.role === 'button' && t.tab === 0 && t.name.length > 5 && t.pressed === 'true' && t.last, '"See original" on: adapted paragraphs get a control with a role, a name and a tab stop', JSON.stringify(t));
  check(t.text === '' && s.sameText && t.w > 8, 'the control adds no text: textContent is still unchanged');
  check(Number(t.opacity) < 0.5, `it is faint by default (opacity ${t.opacity})`);
  check((await look('mix')).toggle.pressed === 'false' && (await look('link')).toggle === null, 'a block put back earlier offers to adapt again; untouched blocks get no control');
  await page.eval(`document.querySelector('#long .glider-adapt-toggle').click(); 0`);
  s = await look('long');
  check(s.br === 0 && s.sameText && s.toggle.pressed === 'false', 'pressing it shows the original layout');
  await page.eval(`document.querySelector('#long .glider-adapt-toggle').focus(); 0`);
  await page.key('Enter');
  s = await look('long');
  check(s.br === 4 && s.sameText && s.toggle.pressed === 'true' && s.toggle.focused, 'Enter on the focused control sets the text out again');
  check(Number(s.toggle.opacity) === 1, `with keyboard focus it is clear (opacity ${s.toggle.opacity})`);
  await page.key(' ');
  check((await look('long')).br === 0, 'Space works too');
  await page.key(' ');
  await page.eval(`document.querySelector('#re .glider-adapt-toggle').click(); 0`);
  s = await look('re');
  check(s.text === IF + TAIL && s.toggle.pressed === 'false', 'on a reordered paragraph it puts the original words back', s.text);
  await page.eval(`document.querySelector('#re .glider-adapt-toggle').click(); GliderAdapt.setHost({ lensOn: true, adaptive: false, control: false }); 0`);
  check((await page.eval(`document.querySelectorAll('.glider-adapt-toggle').length`)) === 0 && (await look('long')).br === 4, '"See original" off again: the controls go, the layout stays');

  // ---- never the block being read; new text further down is adapted
  await page.eval(`GliderAdapt.handleLine({ element: __reading, lineIndex: 0, lineRect: null }); document.body.appendChild(__reading); __orig.reading = { html: __reading.innerHTML, text: __reading.textContent }; __add('fresh', ${JSON.stringify(LEASE)}); 0`);
  await page.sleep(500);
  s = await look('reading');
  check(s.br === 0 && s.sameHtml, 'the paragraph being read is not touched');
  check((await look('fresh')).br === 4, 'text that appears later, which the reader has not reached, is adapted');

  // ---- the reading lens wraps words in spans, and puts them back
  await page.eval(`new Promise((ok, bad) => { const s = document.createElement('script'); s.src = '/glider-extension/content/domEngine.js'; s.onload = ok; s.onerror = bad; document.head.appendChild(s); }).then(() => {
    window.__engine = new Glider.DomEngine(); __engine.setFeatures({ bionic: true }); document.getElementById('long').scrollIntoView(); })`);
  await page.sleep(700);
  s = await look('long');
  check(s.wraps > 0 && s.br === 4 && s.ind.length === 4 && s.text === LEASE, 'lens on: the words are wrapped, the parts and the text are intact', `${s.wraps} wraps`);
  check((await look('re')).text === IF_MOVED + TAIL, 'lens on: the reordered sentence is intact');
  await page.eval(`__add('late', ${JSON.stringify(LEASE)}); document.getElementById('late').scrollIntoView(); 0`);
  await page.sleep(700);
  s = await look('late');
  check(s.br === 4 && s.text === LEASE && s.wraps > 0, 'lens on: a paragraph added now is split and wrapped', `${s.wraps} wraps`);
  await page.eval(`__engine.setFeatures({}); 0`);
  await page.sleep(400);
  s = await look('long');
  const l2 = await look('late');
  check(s.wraps === 0 && s.br === 4 && s.text === LEASE && l2.wraps === 0 && l2.br === 4 && l2.text === LEASE, 'lens off: the lens puts its text nodes back and the parts are still there', `${s.br} / ${l2.br} breaks`);
  await page.eval(`for (const id of ['long', 're', 'late']) GliderAdapt.showOriginal(document.getElementById(id)); 0`);
  check((await look('long')).sameHtml && (await look('re')).sameHtml && (await page.eval(`document.getElementById('late').innerHTML`)) === LEASE, 'and the original still comes back exactly after all that');

  // ---- mode 'learn': tied to the Adaptive switch, decided from what the tracker saw
  await page.eval(`GliderAdapt.setMode('learn')`);
  check((await page.eval(`GliderAdapt.mode() + ' ' + document.querySelectorAll('.glider-adapt-br, .glider-adapt-part, .glider-adapt-moved, .glider-adapt-toggle').length`)) === 'off 0', "mode 'learn' with Adaptive off: nothing is adapted, the page is put back");
  check(await page.eval(`['long', 'mix', 're', 'link', 'both'].every((id) => document.getElementById(id).innerHTML === __orig[id].html)`), 'every paragraph is exactly as the page wrote it');
  await page.eval(`GliderAdapt.setHost({ lensOn: true, adaptive: true, control: false }); 0`);
  let rules = await page.eval(`JSON.stringify(GliderAdapt.rules())`);
  check((await page.eval(`GliderAdapt.mode() + ' ' + document.querySelectorAll('.glider-adapt-br, .glider-adapt-part, .glider-adapt-moved').length`)) === 'learn 0' && /not-enough-read/.test(rules), 'Adaptive on, nothing learned yet: nothing is adapted', rules);

  // The tracker reads #p1 (short sentences), then #long (struggling on it), then moves on.
  await page.eval(`window.scrollTo(0, 0); GliderAdapt.handleStatus({ status: 'tracking' }); GliderAdapt.handleLine({ element: document.getElementById('p1'), lineIndex: 0, lineRect: __lineRect('p1', 0) }); 0`);
  await page.sleep(1700);
  await page.eval(`GliderAdapt.handleProgress({ element: document.getElementById('p1') }); document.getElementById('long').scrollIntoView();
    GliderAdapt.handleLine({ element: document.getElementById('long'), lineIndex: 1, lineRect: __lineRect('long', 1) }); 0`);
  await page.sleep(1700);
  await page.eval(`GliderAdapt.handleStruggle({ element: document.getElementById('long'), lineIndex: 1, lineRect: __lineRect('long', 1), reason: 'rereading' });
    GliderAdapt.handleLine({ element: document.getElementById('mix'), lineIndex: 0, lineRect: __lineRect('mix', 0) }); 0`);
  prof = JSON.parse(await page.eval(`JSON.stringify(GliderAdapt.profile())`));
  check(prof.split.trait.read === 1 && prof.split.trait.struggled === 1 && prof.split.plain.read === 1 && prof.split.plain.struggled === 0, 'reading is counted per sentence: one plain sentence read, one long sentence read and struggled on', JSON.stringify(prof.split));
  check(prof.reorder.plain.read === 2 && prof.reorder.trait.read === 0, 'and separately for the reorder rule', JSON.stringify(prof.reorder));
  await page.eval(`GliderAdapt.save()`);
  const stored = await page.eval(`chrome.storage.local.get('glider:adapt').then((g) => JSON.stringify(g['glider:adapt']))`);
  check(await page.eval(`chrome.storage.local.get('glider:adapt').then((g) => __leaves(g['glider:adapt']))`) && !/Tenant|Deductions|deposit/i.test(stored), 'what is stored is a mode and numbers, no page text', stored);

  // Enough evidence arrives (as if from earlier pages): only text still below the window is adapted.
  await page.eval(`__add('below', ${JSON.stringify(LEASE)}); document.getElementById('link').scrollIntoView();
    chrome.storage.local.set({ 'glider:settings:v2': { on: true, gaze: true, seeOriginal: false }, 'glider:adapt': { mode: 'learn', split: { plain: { read: 40, struggled: 4 }, trait: { read: 20, struggled: 10 } } } }).then(() => GliderAdapt.reload())`);
  await page.sleep(400);
  rules = JSON.parse(await page.eval(`JSON.stringify(GliderAdapt.rules())`));
  check(rules.split.active && rules.split.why === 'trait-is-harder' && !rules.reorder.active, 'the split rule becomes active from the evidence; the reorder rule, with none, does not', JSON.stringify(rules));
  const where = JSON.parse(await page.eval(`JSON.stringify(['long', 'mix', 'both', 'fresh', 'late', 'below'].map((id) => { const el = document.getElementById(id); return { id, top: Math.round(el.getBoundingClientRect().top), vh: innerHeight, br: el.querySelectorAll('.glider-adapt-br, .glider-adapt-part').length }; }))`));
  const by = Object.fromEntries(where.map((w) => [w.id, w]));
  check(by.long.br === 0 && by.mix.br === 0, 'blocks the reader has been on are not changed');
  check(by.both.top < by.both.vh && by.both.br === 0, 'an unread block already in the window is not changed in front of the reader', JSON.stringify(by.both));
  check(by.below.top >= by.below.vh && by.below.br === 4, 'an unread block below the window is split before the reader gets there', JSON.stringify(by.below));
  check((await look('re')).moved === 0 && (await page.eval(`document.querySelectorAll('.glider-adapt-moved').length`)) === 0, 'nothing is reordered while that rule is inactive');

  // It stops when adapting does not help.
  await page.eval(`chrome.storage.local.set({ 'glider:adapt': { mode: 'learn', split: { plain: { read: 40, struggled: 4 }, trait: { read: 20, struggled: 10 }, adapted: { read: 12, struggled: 7 } } } }).then(() => GliderAdapt.reload())`);
  await page.eval(`__add('after', ${JSON.stringify(LEASE)}); 0`);
  await page.sleep(400);
  rules = JSON.parse(await page.eval(`JSON.stringify(GliderAdapt.rules())`));
  check(!rules.split.active && rules.split.why === 'no-benefit' && (await look('after')).br === 0 && (await look('below')).br === 4, 'adapted sentences are no easier: the rule backs off for new text and leaves what is already set out', JSON.stringify(rules.split));

  // Lens off: everything goes back.
  await page.eval(`GliderAdapt.setHost({ lensOn: false, adaptive: false, control: false }); 0`);
  check((await page.eval(`document.querySelectorAll('.glider-adapt-br, .glider-adapt-part, .glider-adapt-indent, .glider-adapt-moved, .glider-adapt-toggle').length`)) === 0, 'reading lens off: nothing of ours is left in the page');
  check(page.errors.length === 0, 'no page errors', JSON.stringify(page.errors).slice(0, 400));
} finally {
  await chrome.close();
  server.close();
}
if (failed) { console.error(`\n${failed} FAILED`); process.exit(1); }
console.log('\nadapt ahead checks passed');
