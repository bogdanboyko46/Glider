/*
 * adapt.js — content script: "Adapt ahead", the page half of the panel's Adaptive switch.
 * Loaded after adapt/splitter.js, adapt/reorder.js, adapt/profile.js and gaze/gaze-reader.js.
 *
 * The eye tracker learns which kinds of sentence this reader keeps going back over. Later
 * text of that kind is set out more readably BEFORE the reader reaches it, so nothing
 * changes in front of their eyes. Two rules, each with its own trait and its own counters:
 *
 *   split    (OFF: it changes the layout; see splitAllowed)
 *            a long multi-clause sentence (adapt/splitter.js) is shown one part per line,
 *            later parts indented on every line they take. LAYOUT ONLY: each later part is
 *            put inside a block-level <span> of its own (the page's own nodes are moved into
 *            it, nothing is copied), with an empty <br> where a new line is needed before
 *            the sentence. No text is added, so the block's textContent stays identical, and
 *            taking the spans away again undoes it.
 *   reorder  a sentence that opens with a subordinate clause (adapt/reorder.js) is shown
 *            main clause first. Words are only moved, never added or removed. The page's
 *            own text node is kept and put back when the original is asked for.
 *            When both apply to a sentence the reorder runs first.
 *
 * Learning   GazeReader 'line' says which line is being read, 'struggle' which line(s) the
 *            reader is stuck on or re-reading. A webcam is accurate to about a line, so both
 *            are credited to every sentence that shares that line. Per sentence and per rule
 *            we count read / struggled, separately for sentences with the trait, without it,
 *            and with it but shown adapted.
 * Deciding   GliderAdaptProfile.decide(counters, mode), once per rule  (adapt/profile.js)
 * Applying   only to blocks the reader has not reached. While the tracker is running and
 *            reading has begun, only to blocks still below the window. Never animated.
 * Undo       GliderAdapt.showOriginal(block) puts a block back exactly. With the panel's
 *            "See original" switch on, a faint control at the end of each adapted block does
 *            the same (and can adapt it again). Asking for the original counts against the
 *            rules that were applied there, and that block is then left alone.
 *
 * Storage    chrome.storage.local 'glider:adapt' = { v, mode, split: {...}, reorder: {...} }:
 *            a mode and counters, never any page text.
 *            mode 'learn' (default)  adapt when Adaptive is on and the evidence says so
 *                 'on'               always adapt, with or without the tracker (for a demo)
 *                 'off'              never
 *            There is no switch for the mode. To force it, in the service worker's console:
 *              chrome.storage.local.get('glider:adapt').then((r) =>
 *                chrome.storage.local.set({ 'glider:adapt': { ...r['glider:adapt'], mode: 'on' } }))
 *            With the reading lens switched off nothing is adapted, whatever the mode.
 * Test and manual hook: window.GliderAdapt.
 */
(() => {
  'use strict';
  if (window.__gliderAdapt || window.top !== window) return;
  const Split = globalThis.GliderSplitter;
  const Reorder = globalThis.GliderReorder;
  const Profile = globalThis.GliderAdaptProfile;
  if (!Split || !Reorder || !Profile) return;
  window.__gliderAdapt = true;

  const PROFILE_KEY = 'glider:adapt';         // { mode, counters }
  const SETTINGS_KEY = 'glider:settings:v2';  // the panel's settings (content/content.js): { on, gaze, seeOriginal }
  const TAGS = new Set(['P', 'LI', 'BLOCKQUOTE', 'DD', 'FIGCAPTION']);
  const BLOCK_SEL = 'p,li,blockquote,dd,figcaption,[data-gr-block]';
  const MIN_CHARS = 60, MAX_CHARS = 6000, MAX_BLOCKS = 800;
  const MIN_SENTENCE_WORDS = 5;   // shorter sentences are not counted as evidence either way
  const MIN_BLOCK_MS = 1500;      // eyes must stay on a block this long before its sentences count as read
  const SCAN_MS = 200;            // new page content is looked at after this pause
  const SAVE_MS = 2000;           // counters are written at most this often
  const RULES = Profile.RULES;    // ['split', 'reorder']
  const CLS = { br: 'glider-adapt-br', indent: 'glider-adapt-indent', part: 'glider-adapt-part', moved: 'glider-adapt-moved', toggle: 'glider-adapt-toggle' };
  const TOGGLE_NAME = 'Set out for easier reading';
  // The split rule changes the layout (one part per line, indented), and Glider now changes nothing but the
  // wording (owner's decision, 2026-11-25), so it is off. tests/adapt.mjs turns it on to keep the machinery tested.
  const splitAllowed = () => !!globalThis.__gliderAllowSplit;

  const hasChrome = (() => { try { return !!(chrome && chrome.storage && chrome.storage.local); } catch (_) { return false; } })();

  let host = { lensOn: true, adaptive: false, control: false };   // what the panel says
  let profile = Profile.empty();   // as stored
  let delta = Profile.empty();     // counted on this page, not yet stored
  let rules = { split: { active: false, why: 'not-loaded' }, reorder: { active: false, why: 'not-loaded' } };
  let saveTimer = 0, scanTimer = 0, observer = null;

  const states = new WeakMap();    // block element -> what we know about it
  const known = new Set();         // blocks we have changed at some point
  const reached = new WeakSet();   // blocks the reader's eyes have been on
  let current = null;              // the block being read
  let tracking = false;            // is the eye tracker running?
  let started = false;             // has reading begun on this page?

  // ------------------------------------------------------------------- text
  /** The block's own text nodes in order, leaving out Glider's controls. */
  function textNodes(el) {
    const out = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        return n.hasAttribute('data-glider-ignore') || n.tagName === 'SCRIPT' || n.tagName === 'STYLE' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    return out;
  }
  const readText = (el) => textNodes(el).map((n) => n.nodeValue).join('');

  /** Character offset in the block's text -> { node, k } (k may equal the node's length at the very end). */
  function locate(nodes, offset) {
    let seen = 0;
    for (let i = 0; i < nodes.length; i++) {
      const len = nodes[i].nodeValue.length;
      if (offset < seen + len) return { node: nodes[i], k: offset - seen };
      seen += len;
    }
    const last = nodes[nodes.length - 1];
    return last ? { node: last, k: last.nodeValue.length } : null;
  }

  function eligible(el) {
    if (!(el instanceof Element) || !el.isConnected) return false;
    if (!TAGS.has(el.tagName) && !el.hasAttribute('data-gr-block')) return false;
    if (el.closest('[data-glider-simplified], [data-glider-ignore], [data-glider-hidden], #glider-root')) return false;
    if (el.isContentEditable || el.querySelector(BLOCK_SEL + ',input,textarea,select,button,video,iframe,table,pre')) return false;
    return true;
  }

  /** The sentences of a text, with what each rule makes of them. */
  function segment(text, counted) {
    if (text.length < MIN_CHARS || text.length > MAX_CHARS) return [];
    return Split.sentences(text).map((s) => {
      const a = Split.analyse(s.text);
      return {
        start: s.start, end: s.end, words: a.words,
        splitTrait: a.trait, points: a.trait ? a.points : [],
        reorderTrait: Reorder.hasTrait(s.text), reordered: false,
        seen: false, struggled: false, counted: !!counted, buckets: null,
      };
    });
  }

  /** What we know about a block. Rebuilt when the page changes the block's text. */
  function analyse(el) {
    let text = readText(el);
    let st = states.get(el);
    if (st && st.text === text) return st;
    if (st && st.applied) { restore(el, st); text = readText(el); }   // the page rewrote it under us: start again
    st = {
      text, sentences: segment(text, st && st.committed),
      applied: false, did: { split: false, reorder: false }, breaks: 0, moved: [],
      declined: !!(st && st.declined), undone: st ? st.undone : { split: false, reorder: false },
      committed: !!(st && st.committed), firstAt: 0, lastAt: 0,
    };
    states.set(el, st);
    return st;
  }

  // ----------------------------------------------------------------- layout
  function marker(tag, cls) {
    const m = document.createElement(tag);
    m.className = cls;
    m.setAttribute('data-glider-ignore', '');
    m.setAttribute('aria-hidden', 'true');
    return m;
  }

  /** Our own DOM writes must not come back to us as "the page changed". */
  function quietly(fn) {
    try { return fn(); } finally { if (observer) observer.takeRecords(); }
  }

  /**
   * What the split rule does to a block, as offsets into its text:
   *   parts   [from, to) of every later part of a long sentence: each becomes an indented block of its own
   *   starts  where a long sentence begins after other text on the same line: it starts a new line
   */
  function planOf(st) {
    const parts = [], starts = [];
    const firstText = st.text.search(/\S/);
    st.sentences.forEach((s, i) => {
      if (!s.points.length) return;
      const prev = st.sentences[i - 1];
      if (s.start > firstText && !(prev && prev.points.length)) starts.push(s.start);   // after a split sentence the line has ended already
      s.points.forEach((p, n) => parts.push([s.start + p, n + 1 < s.points.length ? s.start + s.points[n + 1] : s.end]));
    });
    return { parts, starts };
  }

  const cuts = new WeakMap();   // our element -> where we split a text node to place it: { head, tail }

  /** The text node that begins exactly at a text offset, splitting one if need be. null at the very end. */
  function nodeAt(el, offset) {
    const pos = locate(textNodes(el), offset);
    if (!pos || pos.k >= pos.node.nodeValue.length) return { node: null, cut: false };
    return pos.k > 0 ? { node: pos.node.splitText(pos.k), cut: true } : { node: pos.node, cut: false };
  }

  /** Start a new line before a text offset with empty markers: a <br>, and an indent box when asked. */
  function breakBefore(el, offset, indent) {
    const at = nodeAt(el, offset);
    if (!at.node) return false;
    // The first letter of a word may sit inside a lens span (or a link): step out to its start.
    let before = at.node, parent = before.parentNode;
    while (parent !== el && !before.previousSibling && !(parent.classList && parent.classList.contains('glider-wrap'))) {
      before = parent; parent = before.parentNode;
    }
    const br = marker('br', CLS.br);
    cuts.set(br, { head: at.cut, tail: false });
    parent.insertBefore(br, before);
    if (indent) parent.insertBefore(marker('span', CLS.indent), before);
    return true;
  }

  /**
   * Put the text [from, to) inside one block-level span, so that every line of it is indented,
   * also the lines it wraps onto. The span holds the page's own nodes (or the lens's word spans)
   * and adds no text. False when the stretch cannot be boxed, for example when it starts inside
   * a link and ends outside it.
   */
  function boxPart(el, from, to) {
    const end = nodeAt(el, to);        // the end first: cutting there does not move the start
    const start = nodeAt(el, from);
    if (!start.node) return false;
    const nodes = textNodes(el);
    const last = end.node ? nodes[nodes.indexOf(end.node) - 1] : nodes[nodes.length - 1];
    if (!last) return false;
    const range = document.createRange();
    range.setStartBefore(start.node);
    range.setEndAfter(last);
    let parent = range.commonAncestorContainer;
    if (parent.nodeType !== Node.ELEMENT_NODE) parent = parent.parentNode;
    let a = start.node, b = last;
    while (a.parentNode !== parent) { if (a.previousSibling) return false; a = a.parentNode; }
    while (b.parentNode !== parent) { if (b.nextSibling) return false; b = b.parentNode; }
    const box = document.createElement('span');
    box.className = CLS.part;
    cuts.set(box, { head: start.cut, tail: end.cut });
    parent.insertBefore(box, a);
    for (let n = a; n; ) { const next = n === b ? null : n.nextSibling; box.appendChild(n); n = next; }
    return true;
  }

  /** Rule 'split': one part per line. Works on plain text and on text the lens has wrapped in spans. */
  function addBreaks(el, st) {
    const plan = planOf(st);
    if (!plan.parts.length) return false;
    const jobs = plan.parts.map(([from, to]) => ({ from, to })).concat(plan.starts.map((from) => ({ from, to: -1 })));
    jobs.sort((x, y) => y.from - x.from);   // last first: text offsets do not move, and nothing made later sits inside an earlier box
    let made = 0;
    for (const j of jobs) {
      const ok = j.to < 0 ? breakBefore(el, j.from, false) : boxPart(el, j.from, j.to) || breakBefore(el, j.from, true);
      if (ok) made += 1;
    }
    st.breaks = made;
    return made > 0;
  }

  /** Join two text nodes that we split apart. The earlier node, the page's own, is the one kept. */
  function rejoin(a, b) {
    if (a && b && a.nodeType === Node.TEXT_NODE && b.nodeType === Node.TEXT_NODE && a.nextSibling === b) { a.appendData(b.nodeValue); b.remove(); }
  }

  /** Undo addBreaks. Text nodes are joined again only where the split was ours: a page may keep two side by side on purpose. */
  function removeBreaks(el, st) {
    for (const box of el.querySelectorAll('.' + CLS.part)) {
      const cut = cuts.get(box) || {};
      const prev = box.previousSibling, next = box.nextSibling, first = box.firstChild, last = box.lastChild;
      box.replaceWith(...box.childNodes);
      if (cut.tail && last) rejoin(last, next);
      if (cut.head && first) rejoin(prev, first);
    }
    for (const br of el.querySelectorAll('.' + CLS.br)) {
      const a = br.previousSibling;
      let b = br.nextSibling;
      if (b && b.nodeType === Node.ELEMENT_NODE && b.classList.contains(CLS.indent)) { const after = b.nextSibling; b.remove(); b = after; }
      br.remove();
      if ((cuts.get(br) || {}).head) rejoin(a, b);
    }
    for (const stray of el.querySelectorAll('.' + CLS.indent)) stray.remove();
    st.breaks = 0;
  }

  /**
   * Rule 'reorder': main clause first. Only a sentence that lies inside one plain text node is
   * moved (not one that runs through a link, and not text the lens has already wrapped). That
   * stretch of the node is cut out, kept, and a span with the reordered words stands in for it.
   */
  function reorderIn(el, st) {
    const nodes = textNodes(el);
    const jobs = [];
    for (const s of st.sentences) {
      if (!s.reorderTrait) continue;
      const a = locate(nodes, s.start), len = s.end - s.start;
      if (!a || a.k + len > a.node.nodeValue.length) continue;
      if (a.node.parentElement.closest('.glider-wrap')) continue;
      const r = Reorder.reorder(st.text.slice(s.start, s.end));
      if (r.changed) jobs.push({ node: a.node, k: a.k, len, text: r.text });
    }
    if (!jobs.length) return false;
    for (const j of jobs.reverse()) {   // last first: offsets into a shared node stay valid
      const head = j.k > 0, tail = j.node.nodeValue.length > j.k + j.len;
      const orig = head ? j.node.splitText(j.k) : j.node;
      if (tail) orig.splitText(j.len);
      const span = document.createElement('span');
      span.className = CLS.moved;
      span.textContent = j.text;
      orig.replaceWith(span);
      st.moved.push({ span, orig, head, tail });
    }
    // The text is different now: find the sentences again and note which ones were moved.
    st.text = readText(el);
    st.sentences = segment(st.text, st.committed);
    let offset = 0;
    const found = new Set();
    for (const n of textNodes(el)) {
      const m = st.moved.find((x) => x.span.contains(n));
      if (m && !found.has(m)) {
        found.add(m);
        const hit = st.sentences.find((s) => s.start <= offset && offset < s.end);
        if (hit) hit.reordered = true;
      }
      offset += n.nodeValue.length;
    }
    return true;
  }

  /** Put the page's own text back where a reordered sentence stands. */
  function restoreMoved(st) {
    for (const { span, orig, head, tail } of st.moved) {
      if (!span.isConnected) continue;
      span.replaceWith(orig);
      if (tail) rejoin(orig, orig.nextSibling);
      if (head) rejoin(orig.previousSibling, orig);
    }
    st.moved = [];
  }

  /** Adapt one block with the given rules ({ split, reorder }). True when anything changed. */
  function adapt(el, st, which) {
    return quietly(() => {
      const did = { reorder: !!which.reorder && reorderIn(el, st), split: false };
      did.split = !!which.split && addBreaks(el, st);
      if (!did.reorder && !did.split) return false;
      st.applied = true;
      st.did = did;
      known.add(el);
      syncControl(el, st);
      return true;
    });
  }

  /** Put a block back exactly as the page wrote it. */
  function restore(el, st) {
    quietly(() => {
      removeBreaks(el, st);
      restoreMoved(st);
      st.applied = false;
      st.text = readText(el);
      st.sentences = segment(st.text, st.committed);
      syncControl(el, st);
    });
  }

  /** The lens may have rebuilt the text and dropped our markers: put them back. */
  function repair(el, st) {
    if (!st.applied || !st.did.split || el.querySelectorAll('.' + CLS.br + ', .' + CLS.part).length === st.breaks) return;
    quietly(() => { removeBreaks(el, st); addBreaks(el, st); syncControl(el, st); });
  }

  // ---------------------------------------------------------------- control
  /* Optional (the panel's "See original" switch): a faint mark at the end of an adapted block.
     It is a <span role="button"> with no text of its own (the drawing is CSS), so it adds
     nothing to the block's textContent, and the simplifier, which leaves blocks that contain
     a real <button> alone, still sees a plain paragraph. */
  function syncControl(el, st) {
    let t = el.querySelector('.' + CLS.toggle);
    const wanted = host.control && effectiveMode() !== 'off' && (st.applied || st.declined);
    if (!wanted) { if (t) t.remove(); return; }
    if (!t) {
      t = document.createElement('span');
      t.className = CLS.toggle;
      t.setAttribute('data-glider-ignore', '');
      t.setAttribute('contenteditable', 'false');
      t.setAttribute('role', 'button');
      t.setAttribute('tabindex', '0');
      t.setAttribute('aria-label', TOGGLE_NAME);
      t.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggle(el); });
      t.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault(); e.stopPropagation(); toggle(el);
      });
    }
    placeControl(el, t);
    t.setAttribute('aria-pressed', String(st.applied));
    t.title = st.applied ? 'See the original' : 'Set this out for easier reading again';
  }
  /** The control goes at the end of the block's text: inside the last part when the block ends with one, so it never gets a line to itself. */
  function placeControl(el, t) {
    let home = el;
    for (let n = el.lastChild; n; ) {
      if (n === t || (n.nodeType === Node.TEXT_NODE && !n.nodeValue.trim())) { n = n.previousSibling; continue; }
      if (n.nodeType !== Node.ELEMENT_NODE) break;
      if (n.classList.contains(CLS.part)) { home = n; break; }
      if (!n.classList.contains('glider-wrap')) break;
      n = n.lastChild;   // the lens wraps a whole text node: the last part may be inside it
    }
    if (t.parentNode === home && !t.nextSibling) return;
    const focused = document.activeElement === t;
    home.appendChild(t);
    if (focused) t.focus({ preventScroll: true });   // moving an element drops its focus
  }
  function syncControls() {
    quietly(() => {
      for (const el of known) {
        if (!el.isConnected) { known.delete(el); continue; }
        const st = states.get(el);
        if (st) syncControl(el, st);
      }
    });
  }

  /** The reader wants this block as the page wrote it. Counts against the rules applied there. */
  function showOriginal(el) {
    const st = states.get(el);
    if (!st || !st.applied) return false;
    st.declined = true;
    for (const name of RULES) {
      if (!st.did[name] || st.undone[name]) continue;   // one sign per block and rule
      st.undone[name] = true;
      delta[name].undone += 1;
      Profile.record(delta[name], 'adapted', true);
    }
    scheduleSave();
    restore(el, st);
    return true;
  }
  /** Adapt a block again after the original was asked for. */
  function adaptAgain(el) {
    const st = analyse(el);
    if (st.applied) return false;
    st.declined = false;
    const which = st.did.split || st.did.reorder ? st.did : { split: splitAllowed(), reorder: true };
    if (adapt(el, st, which)) return true;
    quietly(() => syncControl(el, st));
    return false;
  }
  function toggle(el) {
    const st = states.get(el);
    const active = document.activeElement;
    const focused = !!active && active.classList.contains(CLS.toggle) && el.contains(active);
    const done = st && st.applied ? showOriginal(el) : adaptAgain(el);
    const t = focused && el.querySelector('.' + CLS.toggle);
    if (t && document.activeElement !== t) t.focus({ preventScroll: true });   // the control moved with the text: keep the keyboard on it
    return done;
  }

  // ------------------------------------------------------------------ passes
  function effectiveMode() {
    if (!host.lensOn || profile.mode === 'off') return 'off';
    if (profile.mode === 'on') return 'on';
    return host.adaptive ? 'learn' : 'off';   // learning is part of the panel's Adaptive switch
  }
  const anyActive = () => rules.split.active || rules.reorder.active;

  /** Adapt every block the reader has not reached. `force`: the reader just asked for it. */
  function pass(force) {
    if (!anyActive() || !document.body) return;
    const which = { split: rules.split.active, reorder: rules.reorder.active };
    const blocks = document.querySelectorAll(BLOCK_SEL);
    const ahead = tracking && started && !force;   // reading is under way: only text still below the window
    for (let i = 0; i < blocks.length && i < MAX_BLOCKS; i++) {
      const el = blocks[i];
      if (!eligible(el)) continue;
      const st = analyse(el);
      if (st.applied) { repair(el, st); continue; }
      if (st.declined || el === current || reached.has(el)) continue;
      if (!st.sentences.some((s) => (which.split && s.points.length) || (which.reorder && s.reorderTrait))) continue;
      if (/^pre/.test(getComputedStyle(el).whiteSpace)) continue;
      if (ahead && el.getBoundingClientRect().top < innerHeight) continue;
      adapt(el, st, which);
    }
  }

  function restoreAll() {
    for (const el of Array.from(known)) {
      const st = states.get(el);
      if (st && el.isConnected) { if (st.applied) restore(el, st); else quietly(() => syncControl(el, st)); }
      known.delete(el);
    }
  }

  function onMutations(records) {
    // Markers lost from an adapted block (the lens put its own text nodes back): repair before the next paint.
    const seen = new Set();
    for (const r of records) {
      if (!r.removedNodes.length) continue;
      const el = r.target.nodeType === Node.ELEMENT_NODE ? r.target.closest(BLOCK_SEL) : null;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      const st = states.get(el);
      if (st && st.applied && el.isConnected) repair(el, st);
    }
    if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = 0; pass(false); }, SCAN_MS);
  }

  function watch(on) {
    if (on && !observer && document.body) {
      observer = new MutationObserver(onMutations);
      observer.observe(document.body, { childList: true, subtree: true });
    } else if (!on && observer) {
      observer.disconnect(); observer = null;
      clearTimeout(scanTimer); scanTimer = 0;
    }
  }

  /** Work out the decisions again and bring the page in line with them. */
  function refresh(force) {
    const mode = effectiveMode();
    const now = Profile.add(profile, delta);
    rules = { split: splitAllowed() ? Profile.decide(now.split, mode) : { active: false, why: 'layout-off' }, reorder: Profile.decide(now.reorder, mode) };
    if (mode === 'off') { watch(false); restoreAll(); return; }
    // A rule that lapses while learning stops being applied to new text; text already adapted stays as the reader saw it.
    watch(anyActive());
    syncControls();
    pass(force);
  }

  // ---------------------------------------------------------------- learning
  /** The sentences of a block that share the given line (viewport coordinates). */
  function sentencesOnLine(el, st, lineRect) {
    if (!lineRect || !st.sentences.length) return [];
    const nodes = textNodes(el);
    const range = document.createRange();
    const out = [];
    for (const s of st.sentences) {
      const a = locate(nodes, s.start), b = locate(nodes, s.end);
      if (!a || !b) continue;
      try { range.setStart(a.node, a.k); range.setEnd(b.node, b.k); } catch (_) { continue; }
      for (const r of range.getClientRects()) {
        const mid = (r.top + r.bottom) / 2;
        if (r.width > 0 && mid >= lineRect.top && mid <= lineRect.bottom) { out.push(s); break; }
      }
    }
    return out;
  }

  /** Which counter a sentence belongs to, per rule, at the moment it is first read. */
  function bucketsOf(st, s) {
    return {
      split: st.applied && st.did.split && s.points.length ? 'adapted' : s.splitTrait ? 'trait' : 'plain',
      reorder: s.reordered ? 'adapted' : s.reorderTrait ? 'trait' : 'plain',
    };
  }

  /** Mark the sentences on a line as seen (and struggled on). */
  function mark(el, lineRect, struggled) {
    if (!eligible(el)) return;
    const st = analyse(el);
    const now = performance.now();
    if (!st.firstAt) st.firstAt = now;
    st.lastAt = now;
    for (const s of sentencesOnLine(el, st, lineRect)) {
      if (!s.seen) { s.seen = true; s.buckets = bucketsOf(st, s); }
      if (struggled && !s.struggled) {
        s.struggled = true;
        if (s.counted && s.buckets) { for (const name of RULES) delta[name][s.buckets[name]].struggled += 1; scheduleSave(); }   // came back to it later
      }
    }
  }

  /** The reader has moved on from a block: count the sentences they read there. */
  function commit(el) {
    const st = el && states.get(el);
    if (!st || st.lastAt - st.firstAt < MIN_BLOCK_MS) return;
    let any = false;
    for (const s of st.sentences) {
      if (!s.seen || s.counted || s.words < MIN_SENTENCE_WORDS) continue;
      s.counted = true;
      for (const name of RULES) Profile.record(delta[name], s.buckets[name], s.struggled);
      any = true;
    }
    if (any) { st.committed = true; scheduleSave(); }
  }

  function handleLine(d) {
    if (!d || !d.element) return;
    const el = d.element;
    if (el !== current) { commit(current); current = el; }
    started = true;
    reached.add(el);
    mark(el, d.lineRect, false);
  }
  function handleProgress(p) {
    const st = p && p.element && states.get(p.element);
    if (st && st.firstAt) st.lastAt = performance.now();
  }
  function handleStruggle(d) {
    if (!d || !d.element) return;
    reached.add(d.element);
    mark(d.element, d.lineRect, true);
  }
  function handleStatus(s) {
    const now = !!s && s.status !== 'idle' && s.status !== 'error';
    if (tracking && !now) { commit(current); current = null; save(); }
    tracking = now;
  }

  // ----------------------------------------------------------------- storage
  const isEmpty = (d) => RULES.every((n) => !d[n].undone && ['plain', 'trait', 'adapted'].every((b) => !d[n][b].read && !d[n][b].struggled));
  function scheduleSave() {
    if (!saveTimer) saveTimer = setTimeout(save, SAVE_MS);
  }
  /** Read the stored profile, change it, write it back (other tabs count too). */
  async function store(change) {
    try {
      const got = hasChrome ? await chrome.storage.local.get(PROFILE_KEY) : null;
      profile = change(Profile.sanitize(got ? got[PROFILE_KEY] : profile));
      if (hasChrome) await chrome.storage.local.set({ [PROFILE_KEY]: profile });
    } catch (_) {
      profile = change(profile);   // storage gone (extension reloaded): carry on in memory
    }
  }
  /** Add this page's counts to the stored profile. */
  async function save() {
    clearTimeout(saveTimer); saveTimer = 0;
    if (isEmpty(delta)) return;
    const mine = delta;
    delta = Profile.empty();
    await store((p) => Profile.add(p, mine));
    refresh(false);
  }

  /** The panel's settings -> host. True when something we care about changed. */
  function setHost(next) {
    const h = { lensOn: !next || next.lensOn !== false, adaptive: !!(next && next.adaptive), control: !!(next && next.control) };
    if (host.lensOn === h.lensOn && host.adaptive === h.adaptive && host.control === h.control) return false;
    host = h;
    return true;
  }
  const readSettings = (raw) => !!raw && typeof raw === 'object' && setHost({ lensOn: !('on' in raw) || !!raw.on, adaptive: (!('on' in raw) || !!raw.on) && !!raw.gaze, control: !!raw.seeOriginal });

  let listening = false;
  async function load() {
    if (hasChrome) {
      try {
        const got = await chrome.storage.local.get([PROFILE_KEY, SETTINGS_KEY]);
        profile = Profile.sanitize(got[PROFILE_KEY]);
        readSettings(got[SETTINGS_KEY]);
      } catch (_) { /* defaults */ }
      if (!listening) try {
        listening = true;
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local') return;
          const mode = profile.mode;
          if (changes[PROFILE_KEY]) profile = Profile.sanitize(changes[PROFILE_KEY].newValue);
          const asked = (changes[SETTINGS_KEY] && readSettings(changes[SETTINGS_KEY].newValue)) || profile.mode !== mode;
          if (changes[PROFILE_KEY] || asked) refresh(!!asked);
        });
      } catch (_) { /* no live sync */ }
    }
    refresh(false);
  }

  function bind() {
    const G = globalThis.GazeReader;
    if (!G || typeof G.on !== 'function') return;
    const safe = (fn) => (d) => { try { fn(d); } catch (e) { console.warn('[glider] adapt failed', e); } };   // never returns false: other help still runs
    G.on('line', safe(handleLine));
    G.on('progress', safe(handleProgress));
    G.on('struggle', safe(handleStruggle));
    G.on('status', safe(handleStatus));
    try { handleStatus(G.getState()); } catch (_) { /* not started */ }
  }

  addEventListener('pagehide', () => { commit(current); save(); });
  bind();
  const ready = load();

  window.GliderAdapt = {
    ready,
    /** 'learn' | 'on' | 'off'. Stored, so it holds for every page. */
    async setMode(mode) {
      const m = Profile.mode(mode);
      profile.mode = m;
      refresh(true);
      await store((p) => ({ ...p, mode: m }));
    },
    /** The panel reports its switches: { lensOn, adaptive, control }. */
    setHost(next) { if (setHost(next)) refresh(true); },
    mode: effectiveMode,
    rules: () => ({ split: { ...rules.split }, reorder: { ...rules.reorder } }),
    profile: () => Profile.add(profile, delta),
    /** Read the stored profile and settings again (pages without storage change events). */
    reload: load,
    refresh, save, showOriginal, adaptAgain, toggle,
    handleLine, handleProgress, handleStruggle, handleStatus, commit,
    state: (el) => {
      const st = states.get(el);
      return st ? {
        applied: st.applied, did: { ...st.did }, declined: st.declined, breaks: st.breaks, moved: st.moved.length,
        sentences: st.sentences.map((s) => ({ words: s.words, splitTrait: s.splitTrait, parts: s.points.length + 1, reorderTrait: s.reorderTrait, reordered: s.reordered, seen: s.seen, struggled: s.struggled, buckets: s.buckets })),
      } : null;
    },
  };
})();
