/* The Glider page: analytics, saved words, settings and a (preview) account screen.
 *
 * Reads and writes chrome.storage.local directly, the same keys the dock and the
 * popup use, so a change here reaches every open tab through storage events.
 * Opened as a plain file (no extension), it falls back to localStorage; ?demo
 * fills it with sample words and Reading Checks in memory, for screenshots.
 */
(() => {
  'use strict';

  /* ---- These mirror content/content.js. Keep in sync. ---- */
  const SETTINGS_KEY = 'glider:settings:v2';
  const WORDS_KEY = 'glider:words';
  const HISTORY_KEY = 'rcHistory';      // Reading Check summaries (assessment/storage.js)
  const DEFAULTS = Object.freeze({
    on: true, dockVisible: true, skin: 'sage', fontSize: 100, letterSpacing: 1, wordSpacing: 3, lineHeight: 1.8,
    mirror: false, font: false, gaze: false, gazeSensitivity: 3, showLevels: true, showDefinitions: false, showWordParts: true,
    dockMode: 'float',
  });
  const BOOL_KEYS = ['on', 'dockVisible', 'mirror', 'font', 'gaze', 'showLevels', 'showDefinitions', 'showWordParts'];
  const RANGES = Object.freeze({
    fontSize: { min: 100, max: 160, format: (v) => `${v}%` },
    letterSpacing: { min: 0, max: 4, format: (v) => `${v} px` },
    wordSpacing: { min: 0, max: 10, format: (v) => `${v} px` },
    lineHeight: { min: 1.4, max: 2.4, format: (v) => Number(v).toFixed(1) },
    gazeSensitivity: { min: 1, max: 5, format: (v) => ['Rarely', 'Less', 'Balanced', 'More', 'Often'][v - 1] },
  });

  const L = globalThis.GliderLevels;
  const LEVELS = L ? L.LEVELS : ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const levelInfo = (lv) => (L && L.INFO[lv]) || { name: '', text: '' };
  const DF = globalThis.GliderDifficulty;
  const WD = globalThis.GliderWordData;
  const BANDS = ['easy', 'medium', 'hard'];
  const bandName = (b) => (DF && DF.BANDS[b] ? DF.BANDS[b].short : b);

  /** Reading difficulty of a saved word: stored when it was saved, else worked out here. */
  function difficultyOf(w) {
    if (w.difficulty && BANDS.includes(w.difficulty.band)) return w.difficulty;
    if (!DF) return null;
    const look = globalThis.Glider && typeof Glider.lookupHomophone === 'function' && !!Glider.lookupHomophone(w.word);
    return DF.rate({ word: w.word, level: w.level, syllables: w.syllables, say: w.say, lookalike: look });
  }

  /* The dictionary, for words saved before meanings were kept with them. Loaded on first need. */
  let dictionary = null;
  function getDictionary() {
    if (!dictionary && WD) {
      dictionary = fetch('../data/dictionary.txt').then((r) => (r.ok ? r.text() : '')).then((t) => WD.prepare(t)).catch(() => null);
    }
    return dictionary || Promise.resolve(null);
  }

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ------------------------------------------------------------- storage */

  const params = new URLSearchParams(location.search);
  const area = (() => { try { return chrome.storage.local; } catch (_) { return null; } })();
  const DEMO = !area && params.has('demo');
  const memory = {};

  const store = {
    async get(key) {
      if (area) { try { return (await area.get(key))[key]; } catch (_) { return undefined; } }
      if (DEMO) return memory[key];
      try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : undefined; } catch (_) { return undefined; }
    },
    async set(key, value) {
      if (area) { try { await area.set({ [key]: value }); } catch (_) { /* kept on screen only */ } return; }
      if (DEMO) { memory[key] = value; return; }
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* storage blocked */ }
    },
    onChange(fn) {
      try {
        if (area) chrome.storage.onChanged.addListener((changes, name) => { if (name === 'local') fn(Object.keys(changes)); });
        else if (!DEMO) window.addEventListener('storage', (e) => { if (e.key) fn([e.key]); });
      } catch (_) { /* no live sync */ }
    },
  };

  function sanitize(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const s = { ...src };                                   // keep keys other parts of Glider may add
    for (const key of Object.keys(DEFAULTS)) if (!(key in s)) s[key] = DEFAULTS[key];
    for (const key of BOOL_KEYS) s[key] = !!s[key];
    for (const [key, r] of Object.entries(RANGES)) {
      const n = Number(s[key]);
      s[key] = Number.isFinite(n) ? Math.min(r.max, Math.max(r.min, n)) : DEFAULTS[key];
    }
    if (s.dockMode !== 'edge') s.dockMode = 'float';
    s.skin = DEFAULTS.skin;
    return s;
  }

  let settings = sanitize(null);
  let words = [];
  let history = [];

  const cleanWords = (v) => (Array.isArray(v) ? v.filter((w) => w && typeof w.word === 'string') : []);

  async function load() {
    const [s, w, h] = await Promise.all([store.get(SETTINGS_KEY), store.get(WORDS_KEY), store.get(HISTORY_KEY)]);
    settings = sanitize(s);
    words = cleanWords(w);
    history = (Array.isArray(h) ? h : []).filter((x) => x && typeof x === 'object')
      .sort((a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0));
  }

  async function saveSettings(patch) {
    // Merge into what is stored now, so a change made elsewhere a moment ago is kept.
    settings = sanitize({ ...sanitize(await store.get(SETTINGS_KEY)), ...patch });
    renderSettings();
    await store.set(SETTINGS_KEY, settings);
  }

  async function saveWords(next) {
    words = next;
    renderWords();
    renderAnalytics();
    await store.set(WORDS_KEY, next);
  }

  /* --------------------------------------------------------------- toast */

  let toastTimer = 0;
  let toastUndo = null;
  function toast(text, undo) {
    const el = $('#toast');
    clearTimeout(toastTimer);
    el.querySelector('span').textContent = text;
    toastUndo = undo || null;
    $('#toast-undo').hidden = !undo;
    el.hidden = false;
    toastTimer = setTimeout(() => { el.hidden = true; toastUndo = null; }, undo ? 6000 : 2600);
  }
  $('#toast-undo').addEventListener('click', () => {
    const fn = toastUndo;
    $('#toast').hidden = true;
    toastUndo = null;
    if (fn) fn();
  });

  /* ------------------------------------------------------------ routing */

  const VIEWS = ['analytics', 'words', 'settings', 'account'];
  function route() {
    const want = location.hash.replace('#', '');
    const view = VIEWS.includes(want) ? want : 'analytics';
    for (const el of $$('[data-view]')) el.hidden = el.dataset.view !== view;
    for (const a of $$('[data-nav]')) {
      if (a.dataset.nav === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    }
    document.title = `${{ analytics: 'Analytics', words: 'Your words', settings: 'Settings', account: 'Account' }[view]} · Glider`;
    return view;
  }
  window.addEventListener('hashchange', () => { route(); $('#main').focus({ preventScroll: true }); window.scrollTo(0, 0); });
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) { location.hash = go.dataset.go; return; }
    const open = e.target.closest('[data-open]');
    if (open) openExtensionPage(open.dataset.open);
  });

  function openExtensionPage(page) {
    try {
      const url = chrome.runtime.getURL(page);
      if (chrome.tabs && chrome.tabs.create) { chrome.tabs.create({ url }); return; }
      window.open(url, '_blank');
    } catch (_) { window.open('../' + page, '_blank', 'noopener'); }
  }

  /* ----------------------------------------------------------- helpers */

  const fmtDate = (ms, withYear) => {
    const d = new Date(Number(ms));
    if (!Number.isFinite(d.getTime())) return '';
    return d.toLocaleDateString(undefined, withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
  };
  const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } };
  const lvlOf = (w) => (LEVELS.includes(w.level) ? w.level : 'none');

  /* --------------------------------------------------------- analytics */

  function renderAnalytics() {
    const counts = Object.fromEntries([...LEVELS, 'none'].map((lv) => [lv, 0]));
    for (const w of words) counts[lvlOf(w)]++;
    const weekAgo = Date.now() - 7 * 864e5;
    const thisWeek = words.filter((w) => Number(w.savedAt) >= weekAgo).length;
    const last = history[history.length - 1] || null;
    const lastWpm = last && Number.isFinite(Number(last.wpm)) ? Math.round(Number(last.wpm)) : null;

    const bands = { easy: 0, medium: 0, hard: 0 };
    for (const w of words) { const d = difficultyOf(w); if (d) bands[d.band]++; }
    const tile = (label, value, note) => `<div class="gh-tile"><span class="gh-tile-label">${label}</span><span class="gh-tile-value">${value}</span>${note ? `<span class="gh-tile-note">${note}</span>` : ''}</div>`;
    $('#tiles').innerHTML = [
      tile('Saved words', words.length, thisWeek ? `${thisWeek} this week` : 'Save words from the hover lens'),
      tile('Hard to read', bands.hard, words.length ? `${bands.medium} more are medium` : 'None saved yet'),
      tile('Reading Checks', history.length, last ? `Last on ${fmtDate(last.startedAt, true)}` : 'None taken yet'),
      tile('Latest reading speed', lastWpm !== null ? `${lastWpm}<small>words a minute</small>` : '–', lastWpm !== null ? 'From your last Reading Check' : 'Take a Reading Check to see it'),
    ].join('');

    const max = Math.max(1, ...Object.values(counts));
    const rows = [...LEVELS, 'none'].filter((lv) => lv !== 'none' || counts.none > 0).map((lv) => {
      const name = lv === 'none' ? '<b>–</b>Not listed' : `<b>${lv}</b>${esc(levelInfo(lv).name)}`;
      return `<li class="gh-bar" data-lv="${lv}"><span class="gh-bar-name"><span class="gh-dot"></span>${name}</span>` +
        `<span class="gh-bar-track"><span class="gh-bar-fill" style="width:${(100 * counts[lv]) / max}%"></span></span>` +
        `<span class="gh-bar-count">${counts[lv]}</span></li>`;
    });
    $('#level-bars').innerHTML = words.length
      ? `<ul class="gh-bars" aria-label="Saved words by how common they are">${rows.join('')}</ul>`
      : '<p class="gh-note-empty">Saved words will be counted here by level.</p>';
    const bmax = Math.max(1, ...Object.values(bands));
    $('#band-bars').innerHTML = words.length
      ? `<ul class="gh-bars" aria-label="Saved words by reading difficulty">${BANDS.map((b) =>
        `<li class="gh-bar" data-band="${b}"><span class="gh-bar-name"><span class="gh-dot"></span><b>${esc(bandName(b))}</b>to read</span>` +
        `<span class="gh-bar-track"><span class="gh-bar-fill" style="width:${(100 * bands[b]) / bmax}%"></span></span>` +
        `<span class="gh-bar-count">${bands[b]}</span></li>`).join('')}</ul>`
      : '<p class="gh-note-empty">Saved words will be counted here by how hard they are to read.</p>';

    $('#open-last').hidden = !last;
    if (!history.length) {
      $('#checks').innerHTML = '<p class="gh-note-empty">A two-minute read with eye tracking, then a dashboard of how it went. Your results will be listed here.</p>';
    } else {
      const recent = history.slice(-5).reverse();
      $('#checks').innerHTML = `<table class="gh-checks"><thead><tr><th scope="col">Date</th><th scope="col">Speed</th><th scope="col">Answers</th><th scope="col">Data</th></tr></thead><tbody>` +
        recent.map((r) => `<tr><td>${esc(fmtDate(r.startedAt, true) || '–')}</td>` +
          `<td>${Number.isFinite(Number(r.wpm)) && r.wpm !== null ? `${Math.round(Number(r.wpm))} wpm` : '–'}</td>` +
          `<td>${Number.isFinite(Number(r.comprehension)) && r.comprehension !== null ? `${r.comprehension} of 2` : '–'}</td>` +
          `<td>${esc(r.quality ? r.quality[0].toUpperCase() + r.quality.slice(1) : '–')}${r.demo ? ' · demo' : ''}</td></tr>`).join('') +
        '</tbody></table>';
    }
  }

  /* -------------------------------------------------------------- words */

  const view = { query: '', level: 'all', band: 'all', sort: 'new' };
  const bandOf = (w) => { const d = difficultyOf(w); return d ? d.band : 'easy'; };

  function renderFilters() {
    const present = new Set(words.map(lvlOf));
    const bandsHere = new Set(words.map(bandOf));
    const chip = (id, label, dot) => `<button type="button" class="gh-filter" data-filter="${id}" data-lv="${id}" aria-pressed="${view.level === id}"${id !== 'all' && !present.has(id) ? ' disabled' : ''}>${dot ? '<span class="gh-dot"></span>' : ''}${label}</button>`;
    const bchip = (b) => `<button type="button" class="gh-filter" data-band-filter="${b}" data-band="${b}" aria-pressed="${view.band === b}"${!bandsHere.has(b) ? ' disabled' : ''}><span class="gh-dot"></span>${esc(bandName(b))}</button>`;
    $('#filters').innerHTML = `<span class="gh-filter-label">Reading</span>${BANDS.map(bchip).join('')}<span class="gh-filter-sep" aria-hidden="true"></span>` +
      `<span class="gh-filter-label">Level</span>${chip('all', 'All', false)}${LEVELS.map((lv) => chip(lv, lv, true)).join('')}${present.has('none') ? chip('none', 'Not listed', true) : ''}`;
  }

  function highlight(context, word) {
    const text = String(context || '');
    const at = text.toLowerCase().indexOf(String(word).toLowerCase());
    if (at < 0) return esc(text);
    return esc(text.slice(0, at)) + '<mark>' + esc(text.slice(at, at + word.length)) + '</mark>' + esc(text.slice(at + word.length));
  }

  function renderWords() {
    $('#nav-count').hidden = !words.length;
    $('#nav-count').textContent = String(words.length);
    $('#data-words').textContent = words.length ? `${words.length} saved, kept on this device only` : 'None saved. Kept on this device only';
    $('#words-tools').hidden = !words.length;
    $('#words-empty').hidden = words.length > 0;
    renderFilters();

    const q = view.query.trim().toLowerCase();
    let list = words.filter((w) => (view.level === 'all' || lvlOf(w) === view.level) && (view.band === 'all' || bandOf(w) === view.band) &&
      (!q || w.word.includes(q) || String(w.context || '').toLowerCase().includes(q) || String(w.title || '').toLowerCase().includes(q)));
    // Easiest / hardest to read first; within a band, by how common the word is.
    const score = (w) => { const d = difficultyOf(w); return d && typeof d.score === 'number' ? d.score : BANDS.indexOf(bandOf(w)) / 2; };
    const easy = (w) => score(w);
    const hard = (w) => -score(w);
    const sorters = {
      new: (a, b) => b.savedAt - a.savedAt, old: (a, b) => a.savedAt - b.savedAt, az: (a, b) => a.word.localeCompare(b.word),
      easy: (a, b) => easy(a) - easy(b) || a.word.localeCompare(b.word), hard: (a, b) => hard(a) - hard(b) || a.word.localeCompare(b.word),
    };
    list = list.slice().sort(sorters[view.sort] || sorters.new);

    $('#results').textContent = !words.length ? '' : list.length === words.length ? `${words.length} word${words.length === 1 ? '' : 's'}` : `${list.length} of ${words.length} words`;
    $('#words').innerHTML = list.map((w) => {
      const lv = lvlOf(w);
      const info = levelInfo(lv);
      const syl = Array.isArray(w.syllables) && w.syllables.length > 1 ? `<span class="gh-word-syl" aria-label="Syllables">${w.syllables.map(esc).join(' · ')}</span>` : '';
      const say = w.say ? `<span class="gh-word-say">says ${String(w.say).split('-').map((p) => (p === p.toUpperCase() ? `<b>${esc(p.toLowerCase())}</b>` : esc(p))).join('-')}</span>` : '';
      const d = difficultyOf(w);
      const diff = d ? `<span class="gh-diff" data-band="${d.band}" title="${esc(d.reasons.join(', ') || 'Easy to sound out')}"><span class="gh-dot"></span><b>${esc(bandName(d.band))}</b>to read</span>` : '';
      const level = lv === 'none' ? '' : `<span class="gh-lvl" data-lv="${lv}" title="How common: ${esc(info.name)}. ${esc(info.text)}">${lv}</span>`;
      const why = d && d.band !== 'easy' && d.reasons.length ? `<span class="gh-word-why">${esc(d.reasons.join(' · '))}</span>` : '';
      const def = w.definition
        ? `<p class="gh-word-def">${w.definition.pos ? `<i>${esc(w.definition.pos)}</i> ` : ''}${esc(w.definition.def)}</p>`
        : '<p class="gh-word-def" data-def-pending hidden></p>';
      const parts = Array.isArray(w.parts) && w.parts.length
        ? `<p class="gh-word-parts" aria-label="Word parts">${w.parts.map((p) => `<span class="gh-wpart" data-kind="${esc(p.type)}" title="${esc(p.meaning ? `${p.label}: ${p.meaning}` : p.kind)}"><b>${esc(p.text)}</b>${esc(p.kind)}</span>`).join('<span aria-hidden="true">+</span>')}</p>`
        : '';
      const src = /^(https?|file):/i.test(String(w.url || '')) ? `<a href="${esc(w.url)}" target="_blank" rel="noopener noreferrer" title="${esc(w.title || w.url)}">${esc(w.title || host(w.url))}</a>` : '';
      return `<li class="gh-word" data-word="${esc(w.word)}">
        <div class="gh-word-top"><span class="gh-word-text">${esc(w.word)}</span>${diff}${level}${syl}${say}${why}</div>
        ${def}${parts}
        ${w.context ? `<p class="gh-word-context">${highlight(w.context, w.word)}</p>` : ''}
        <div class="gh-word-meta">${src}${src ? '<span aria-hidden="true">·</span>' : ''}<span>Saved ${esc(fmtDate(w.savedAt, true))}</span></div>
        <div class="gh-word-actions">
          <button type="button" class="gh-icon-btn" data-act="hear" aria-label="Hear ${esc(w.word)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>Hear</button>
          <button type="button" class="gh-icon-btn gh-icon-btn--quiet" data-act="remove" aria-label="Remove ${esc(w.word)} from your words"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>Remove</button>
        </div>
      </li>`;
    }).join('');
    fillDefinitions();
  }

  /** Meanings for words saved before Glider kept them, filled in from the dictionary. */
  async function fillDefinitions() {
    const pending = $$('[data-def-pending]');
    if (!pending.length || !WD) return;
    const dict = await getDictionary();
    if (!dict) return;
    for (const p of pending) {
      const li = p.closest('[data-word]');
      const d = li && WD.define(dict, li.dataset.word);
      const s = d && d.senses[0];
      if (!s) continue;
      p.innerHTML = `${s.posName ? `<i>${esc(s.posName)}</i> ` : ''}${esc(s.def)}`;
      p.hidden = false;
      p.removeAttribute('data-def-pending');
    }
  }

  $('#search').addEventListener('input', (e) => { view.query = e.target.value; renderWords(); });
  $('#sort').addEventListener('change', (e) => { view.sort = e.target.value; renderWords(); });
  $('#filters').addEventListener('click', (e) => {
    const band = e.target.closest('[data-band-filter]');
    if (band && !band.disabled) { view.band = view.band === band.dataset.bandFilter ? 'all' : band.dataset.bandFilter; renderWords(); return; }
    const b = e.target.closest('[data-filter]');
    if (!b || b.disabled) return;
    view.level = view.level === b.dataset.filter ? 'all' : b.dataset.filter;
    renderWords();
  });
  $('#words').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const key = btn.closest('[data-word]').dataset.word;
    const entry = words.find((w) => w.word === key);
    if (!entry) return;
    if (btn.dataset.act === 'hear') speak(entry.word, btn);
    if (btn.dataset.act === 'remove') {
      const before = words.slice();
      saveWords(words.filter((w) => w.word !== key));
      toast(`Removed “${key}”`, () => saveWords(before));
    }
  });

  function speak(text, button) {
    const synth = globalThis.speechSynthesis;
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') { toast('This browser has no voice to read with'); return; }
    synth.cancel();
    for (const b of $$('[data-speaking]')) delete b.dataset.speaking;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = 0.8;
    const voice = synth.getVoices().filter((v) => /^en/i.test(v.lang)).find((v) => v.localService);
    if (voice) u.voice = voice;
    button.dataset.speaking = 'true';
    u.onend = u.onerror = () => { delete button.dataset.speaking; };
    synth.speak(u);
  }

  /* ----------------------------------------------------------- settings */

  function renderSettings() {
    const s = settings;
    for (const sw of $$('.gh-switch[data-key]')) sw.setAttribute('aria-checked', String(!!s[sw.dataset.key]));
    for (const input of $$('[data-range]')) {
      const key = input.dataset.range;
      if (document.activeElement !== input) input.value = String(s[key]);
      const text = RANGES[key].format(Math.round(s[key] * 100) / 100);
      input.setAttribute('aria-valuetext', text);
      $(`[data-out="${key}"]`).textContent = text;
    }
    for (const opt of $$('[data-mode]')) opt.setAttribute('aria-checked', String(opt.dataset.mode === s.dockMode));
    $('#lens-tuning').dataset.off = String(!s.on);
    $('#lens-tuning').toggleAttribute('inert', !s.on);
  }

  for (const sw of $$('.gh-switch[data-key]')) sw.addEventListener('click', () => saveSettings({ [sw.dataset.key]: !settings[sw.dataset.key] }));
  for (const input of $$('[data-range]')) input.addEventListener('input', () => saveSettings({ [input.dataset.range]: Number(input.value) }));
  const modes = $$('[data-mode]');
  for (const opt of modes) {
    opt.addEventListener('click', () => saveSettings({ dockMode: opt.dataset.mode }));
    opt.addEventListener('keydown', (e) => {
      if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
      e.preventDefault();
      const next = modes[(modes.indexOf(opt) + 1) % modes.length];
      next.focus();
      next.click();
    });
  }

  /* Destructive buttons ask once, in place. */
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-confirm]');
    if (!btn) return;
    const what = btn.dataset.confirm;
    const box = document.createElement('span');
    box.className = 'gh-confirm';
    box.innerHTML = `<span>${what === 'clear-words' ? 'Delete every saved word?' : 'Reset all settings?'}</span>` +
      `<button type="button" class="rc-btn rc-btn--danger" data-yes>${what === 'clear-words' ? 'Delete' : 'Reset'}</button>` +
      '<button type="button" class="rc-btn rc-btn--ghost" data-no>Cancel</button>';
    btn.replaceWith(box);
    box.querySelector('[data-no]').focus();
    box.addEventListener('click', async (ev) => {
      if (!ev.target.closest('[data-yes], [data-no]')) return;
      const yes = !!ev.target.closest('[data-yes]');
      box.replaceWith(btn);
      btn.focus();
      if (!yes) return;
      if (what === 'clear-words') {
        const before = words.slice();
        await saveWords([]);
        toast('Every saved word was deleted', () => saveWords(before));
      } else {
        settings = sanitize({ ...DEFAULTS });
        renderSettings();
        await store.set(SETTINGS_KEY, settings);
        toast('Settings are back to how Glider started');
      }
    });
  });

  /* ------------------------------------------------------------ account */
  /* A preview of the sign-in screens. Nothing typed here is kept or sent. */

  let authMode = 'in';
  function renderAuth() {
    for (const tab of $$('[data-auth]')) tab.setAttribute('aria-selected', String(tab.dataset.auth === authMode));
    $('#auth-form').setAttribute('aria-labelledby', authMode === 'in' ? 't-in' : 't-up');
    for (const el of $$('[data-only]')) el.hidden = el.dataset.only !== authMode;
    $('#auth-submit').textContent = authMode === 'in' ? 'Sign in' : 'Create account';
    $('#auth-status').textContent = '';
    delete $('#auth-status').dataset.tone;
  }
  for (const tab of $$('[data-auth]')) tab.addEventListener('click', () => { authMode = tab.dataset.auth; renderAuth(); });
  $('#auth-form').addEventListener('submit', (e) => {
    e.preventDefault();
    e.target.elements.password.value = '';             // never keep it, even on screen
    const status = $('#auth-status');
    status.dataset.tone = 'info';
    status.textContent = authMode === 'in'
      ? 'Accounts are not switched on yet, so you cannot sign in. Nothing was sent.'
      : 'Accounts are not switched on yet, so no account was created. Nothing was sent.';
  });
  $('#auth-form [data-only="in"]').addEventListener('click', () => {
    $('#auth-status').dataset.tone = 'info';
    $('#auth-status').textContent = 'Password reset will come with accounts.';
  });

  /* --------------------------------------------------------------- demo */

  function seedDemo() {
    const now = Date.now(), day = 864e5;
    const make = (word, level, say, syllables, context, title, url, ago) => ({ word, level, base: word, say, syllables, context, title, url, savedAt: now - ago * day });
    memory[WORDS_KEY] = [
      make('photosynthesis', null, 'foh-tuh-SIN-thuh-sis', ['pho', 'to', 'syn', 'the', 'sis'], 'Photosynthesis turns light energy into chemical energy stored in sugars.', 'Photosynthesis - Wikipedia', 'https://en.wikipedia.org/wiki/Photosynthesis', 0.2),
      Object.assign(make('hypothesis', 'C2', 'hy-POTH-uh-sis', ['hy', 'poth', 'e', 'sis'], 'A hypothesis must be testable before it can count as science.', 'Unit 3: Scientific method', 'https://lms.example.edu/course/3', 1), {
        parts: [{ type: 'p', label: 'hypo-', kind: 'prefix', meaning: 'under, or less than', text: 'hypo' }, { type: 'r', label: 'thesis', kind: 'root', meaning: 'putting, or placing', text: 'thesis' }],
      }),
      Object.assign(make('carefully', 'A2', 'KAIR-fuh-lee', ['care', 'ful', 'ly'], 'Read the passage carefully before you answer.', 'Week 6 Reading', 'https://lms.example.edu/course/6', 0.5), {
        parts: [{ type: 'w', label: 'care', kind: 'base word', meaning: '', text: 'care' }, { type: 's', label: '-ful', kind: 'suffix', meaning: 'full of', text: 'ful' }, { type: 's', label: '-ly', kind: 'suffix', meaning: 'in a way that is', text: 'ly' }],
      }),
      make('accumulate', 'B2', 'uh-KYOO-myuh-layt', ['ac', 'cu', 'mu', 'late'], 'Small errors accumulate over a long experiment.', 'Lab notes', 'https://lms.example.edu/course/4', 2),
      make('environment', 'A2', 'en-VY-ruhn-muhnt', ['en', 'vi', 'ron', 'ment'], 'Every plant responds to its environment.', 'Biology reading', 'https://lms.example.edu/course/2', 3),
      make('particularly', 'B1', 'per-TIK-yuh-ler-lee', ['par', 'tic', 'u', 'lar', 'ly'], 'This is particularly true of desert plants.', 'Biology reading', 'https://lms.example.edu/course/2', 3),
      make('responsibility', 'B1', 'ri-spon-suh-BIL-uh-tee', ['re', 'spon', 'si', 'bil', 'i', 'ty'], 'Each group member has one responsibility.', 'Group project brief', 'https://lms.example.edu/course/1', 9),
      make('inefficient', 'C1', 'in-uh-FISH-uhnt', ['in', 'ef', 'fi', 'cient'], 'The enzyme is famously slow and inefficient at its job.', 'Photosynthesis - Wikipedia', 'https://en.wikipedia.org/wiki/Photosynthesis', 12),
    ];
    memory[HISTORY_KEY] = [
      { id: 'd1', startedAt: now - 20 * day, wpm: 151, comprehension: 1, quality: 'good', demo: true },
      { id: 'd2', startedAt: now - 9 * day, wpm: 163, comprehension: 2, quality: 'fair', demo: true },
      { id: 'd3', startedAt: now - 2 * day, wpm: 172, comprehension: 2, quality: 'good', demo: true },
    ];
  }

  /* --------------------------------------------------------------- boot */

  store.onChange(async (keys) => {
    if (keys.includes(SETTINGS_KEY)) { settings = sanitize(await store.get(SETTINGS_KEY)); renderSettings(); }
    if (keys.includes(WORDS_KEY)) { words = cleanWords(await store.get(WORDS_KEY)); renderWords(); renderAnalytics(); }
    if (keys.includes(HISTORY_KEY)) { await load(); renderAnalytics(); }
  });

  (async () => {
    if (DEMO) seedDemo();
    route();
    await load();
    renderSettings();
    renderWords();
    renderAnalytics();
    renderAuth();
    document.body.dataset.ready = 'true';
  })();
})();
