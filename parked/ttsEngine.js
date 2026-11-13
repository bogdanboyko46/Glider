/*
 * LexiLens — read-aloud engine.
 *
 * Speaks a selection (or the main content of the page) with the browser's
 * built-in speechSynthesis voices — offline, free, no keys — and highlights
 * each word as it is spoken.
 *
 * Highlight timing comes from the voice's `boundary` events. Some voices
 * (notably Chrome's network voices) never fire them, so every sentence also
 * starts an estimated per-word timer that is dropped the moment a real
 * boundary event arrives.
 *
 * Text is spoken one sentence at a time. That keeps highlighting tightly in
 * sync, makes pause / resume / speed changes instant (we restart from the
 * current word), and avoids Chrome cutting off long utterances.
 */
(() => {
  'use strict';

  const LL = (globalThis.LexiLens = globalThis.LexiLens || {});

  const HOLD = 'tts';
  const SPEAKING_CLASS = 'lexilens-speaking';
  const MAX_CHUNK_CHARS = 240;
  const BATCH_ENTRIES = 60; // text nodes prepared per step while reading

  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'TD', 'TH', 'TR', 'TABLE', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'HEADER',
    'FOOTER', 'NAV', 'FIGURE', 'FIGCAPTION', 'PRE', 'ADDRESS', 'FORM', 'FIELDSET', 'BODY', 'DETAILS', 'SUMMARY',
  ]);

  /* Page furniture that "Read page" should not read out. */
  const PAGE_SKIP = [
    'nav', 'header', 'footer', 'aside', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[role="complementary"]', '[aria-hidden="true"]', 'sup.reference', '.mw-editsection', '.noprint',
    '.navbox', '.reflist', '.toc', '.sr-only', '.screenreader-only', '.visually-hidden', 'figure table',
  ].join(',');

  /* Always skipped, even inside a selection. */
  const SELECTION_SKIP = '[aria-hidden="true"], sup.reference, .mw-editsection';

  /* Where the real reading usually lives, most specific first. */
  const MAIN_CANDIDATES = [
    '#mw-content-text .mw-parser-output', '.user_content', '.show-content', '#assignment_show .description',
    '[role="main"] article', 'article', 'main', '[role="main"]', '#main-content', '#content', '#main',
  ];

  const synth = () => globalThis.speechSynthesis || null;

  function blockOf(el) {
    for (let node = el; node; node = node.parentElement) {
      if (BLOCK_TAGS.has(node.tagName)) return node;
    }
    return document.body;
  }

  function isVisible(el) {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
    }
    return el.getClientRects().length > 0;
  }

  class TTSEngine {
    /**
     * @param {object} opts
     * @param {LL.DomEngine} opts.engine   token engine
     * @param {function} [opts.onState]    (state, info) => void
     * @param {function} [opts.onWord]     (token) => void
     */
    constructor({ engine, onState, onWord }) {
      this.engine = engine;
      this.onState = onState || (() => {});
      this.onWord = onWord || (() => {});

      this.state = 'idle'; // 'idle' | 'playing' | 'paused'
      this.rate = 1;
      this.voiceURI = '';
      this.chunks = [];
      this.ci = 0;          // current chunk (sentence)
      this.wi = 0;          // current word within the chunk
      this.session = 0;     // bumps whenever speech is (re)started or cancelled
      this.current = null;  // highlighted token
      this.utterance = null;
      this.fallbackTimer = 0;
      this.restartTimer = 0;
      this.voiceListeners = new Set();

      const s = synth();
      if (s && typeof s.addEventListener === 'function') {
        s.addEventListener('voiceschanged', () => this.voiceListeners.forEach((fn) => fn(this.voices())));
      }
      // Chrome keeps talking across navigations unless told to stop.
      window.addEventListener('pagehide', () => {
        if (this.state !== 'idle') this.stop();
        else { const sy = synth(); if (sy) sy.cancel(); }
      });
    }

    get supported() {
      return !!synth() && typeof SpeechSynthesisUtterance === 'function';
    }

    /* -------------------------------------------------------------- voices */

    /** Voices for the page language (falls back to every voice). */
    voices() {
      const s = synth();
      if (!s) return [];
      const all = s.getVoices() || [];
      const lang = (document.documentElement.lang || navigator.language || 'en').slice(0, 2).toLowerCase();
      const matching = all.filter((v) => (v.lang || '').toLowerCase().startsWith(lang));
      const list = matching.length ? matching : all;
      return list.slice().sort((a, b) =>
        Number(b.localService) - Number(a.localService) || a.name.localeCompare(b.name));
    }

    onVoices(fn) {
      this.voiceListeners.add(fn);
      fn(this.voices());
    }

    pickVoice() {
      const list = this.voices();
      return list.find((v) => v.voiceURI === this.voiceURI) || list.find((v) => v.default) || list[0] || null;
    }

    setVoice(uri) {
      if ((uri || '') === this.voiceURI) return;
      this.voiceURI = uri || '';
      this.restartIfPlaying();
    }

    setRate(rate) {
      const next = Math.min(1.5, Math.max(0.7, Number(rate) || 1));
      if (next === this.rate) return;
      this.rate = next;
      this.restartIfPlaying();
    }

    restartIfPlaying() {
      if (this.state !== 'playing') return;
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        if (this.state === 'playing') this.speakChunk(this.ci, this.wi);
      }, 220);
    }

    /* ----------------------------------------------------------- transport */

    /** Play / pause / resume with one button. */
    toggle() {
      if (this.state === 'playing') this.pause();
      else if (this.state === 'paused') this.resume();
      else this.start();
    }

    /** Read the current selection, or the page from what is on screen. */
    start(preferredRange) {
      if (!this.supported) return false;
      this.stop(true);

      let range = preferredRange || null;
      let fromSelection = false;
      if (!range) {
        const sel = document.getSelection();
        if (sel && sel.rangeCount && !sel.isCollapsed && sel.toString().trim().length > 1) {
          range = sel.getRangeAt(0).cloneRange();
        }
      }
      if (range) fromSelection = true;
      else {
        range = document.createRange();
        range.selectNodeContents(this.mainContent());
      }

      this.engine.hold(HOLD);
      this.entries = this.collect(range, fromSelection);
      this.entryIndex = 0;
      this.lastBlock = null;
      this.chunks = [];
      this.extend();
      if (!this.chunks.length) {
        this.stop(true);
        this.onState('idle', { empty: true });
        return false;
      }
      if (fromSelection) {
        const sel = document.getSelection();
        if (sel) sel.removeAllRanges(); // so the word highlight is visible
      }
      this.source = fromSelection ? 'selection' : 'page';
      this.ci = 0;
      this.wi = 0;
      this.setState('playing');
      this.speakChunk(0, 0);
      return true;
    }

    pause() {
      if (this.state !== 'playing') return;
      this.cancelSpeech();
      this.setState('paused');
    }

    resume() {
      if (this.state !== 'paused') return;
      this.setState('playing');
      this.speakChunk(this.ci, this.wi);
    }

    stop(silent) {
      const wasActive = this.state !== 'idle';
      this.cancelSpeech();
      this.highlight(null);
      this.chunks = [];
      this.entries = [];
      this.entryIndex = 0;
      this.ci = 0;
      this.wi = 0;
      this.engine.release(HOLD);
      if (wasActive) {
        this.state = 'idle';
        if (!silent) this.onState('idle', {});
      }
    }

    /** Say a single word (tooltip speaker button, click-to-hear). */
    speakWord(word) {
      if (!this.supported || !word) return;
      if (this.state === 'playing') this.pause();
      const s = synth();
      s.cancel();
      const u = new SpeechSynthesisUtterance(word);
      const voice = this.pickVoice();
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      u.rate = Math.max(0.7, this.rate * 0.9);
      this.wordUtterance = u; // keep a reference so Chrome does not drop it
      setTimeout(() => s.speak(u), 40);
    }

    /* ------------------------------------------------------------ speaking */

    cancelSpeech() {
      this.session += 1;
      clearTimeout(this.fallbackTimer);
      clearTimeout(this.restartTimer);
      const s = synth();
      if (s) s.cancel();
    }

    speakChunk(ci, wi) {
      this.cancelSpeech();
      const session = this.session;
      // Prepare the next stretch of text a few sentences before it is needed.
      if (ci >= this.chunks.length - 2) this.extend();
      const chunk = this.chunks[ci];
      if (!chunk) { this.finish(); return; }

      this.ci = ci;
      this.wi = Math.min(wi, Math.max(0, chunk.words.length - 1));
      const base = this.wi > 0 && chunk.words[this.wi] ? chunk.words[this.wi].start : 0;

      const u = new SpeechSynthesisUtterance(chunk.text.slice(base));
      const voice = this.pickVoice();
      if (voice) { u.voice = voice; u.lang = voice.lang; }
      else u.lang = document.documentElement.lang || navigator.language || 'en-US';
      u.rate = this.rate;

      let sawBoundary = false;

      u.onstart = () => {
        if (session !== this.session) return;
        this.runFallback(session, chunk, this.wi, () => sawBoundary);
      };
      u.onboundary = (event) => {
        if (session !== this.session) return;
        if (event.name && event.name !== 'word') return;
        sawBoundary = true;
        clearTimeout(this.fallbackTimer);
        const index = this.wordAt(chunk, event.charIndex + base);
        if (index >= 0) this.setWord(chunk, index);
      };
      u.onend = () => {
        if (session !== this.session) return;
        clearTimeout(this.fallbackTimer);
        this.speakChunk(ci + 1, 0);
      };
      u.onerror = (event) => {
        if (session !== this.session) return;
        clearTimeout(this.fallbackTimer);
        if (event.error === 'interrupted' || event.error === 'canceled') {
          // Something else (another tab, another utterance) cut us off.
          if (this.state === 'playing') { this.session += 1; this.setState('paused'); }
          return;
        }
        this.stop(true);
        this.onState('idle', { error: event.error || 'speech-failed' });
      };

      this.utterance = u; // keep a reference so Chrome keeps firing events
      this.onState(this.state, this.info());
      // Chrome can swallow speak() issued in the same tick as cancel().
      setTimeout(() => {
        if (session !== this.session) return;
        const s = synth();
        if (s.paused) s.resume();
        s.speak(u);
      }, 60);
    }

    /** Estimated word-by-word highlight for voices without boundary events. */
    runFallback(session, chunk, from, sawBoundary) {
      clearTimeout(this.fallbackTimer);
      let i = from;
      const step = () => {
        if (session !== this.session || sawBoundary() || i >= chunk.words.length) return;
        this.setWord(chunk, i);
        const word = chunk.words[i];
        const next = chunk.words[i + 1];
        const gap = next ? chunk.text.slice(word.end, next.start) : '';
        const pause = /[,;:.!?—]/.test(gap) ? 260 : 0;
        const ms = ((word.end - word.start) * 58 + 110 + pause) / this.rate;
        i += 1;
        this.fallbackTimer = setTimeout(step, ms);
      };
      step();
    }

    /** Index of the word that contains (or most recently precedes) a char. */
    wordAt(chunk, charIndex) {
      const words = chunk.words;
      let lo = 0;
      let hi = words.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (words[mid].start <= charIndex) { found = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return found;
    }

    setWord(chunk, index) {
      this.wi = index;
      const word = chunk.words[index];
      this.highlight(word ? word.token : null);
    }

    highlight(token) {
      if (this.current === token) return;
      if (this.current) this.current.classList.remove(SPEAKING_CLASS);
      this.current = token && token.isConnected ? token : null;
      if (!this.current) return;
      this.current.classList.add(SPEAKING_CLASS);

      const rect = this.current.getBoundingClientRect();
      if (rect.top < 90 || rect.bottom > window.innerHeight - 130) {
        const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.current.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      }
      this.onWord(this.current);
    }

    finish() {
      this.stop(true);
      this.onState('idle', { finished: true });
    }

    setState(state) {
      this.state = state;
      this.onState(state, this.info());
    }

    info() {
      return {
        sentence: this.ci + 1,
        sentences: this.chunks.length,
        more: this.entryIndex < this.entries.length,
        source: this.source,
      };
    }

    /* ---------------------------------------------------------- collecting */

    /** The element that most likely holds the page's main reading. */
    mainContent() {
      for (const selector of MAIN_CANDIDATES) {
        const el = document.querySelector(selector);
        if (el && (el.innerText || '').trim().length > 400) return el;
      }
      return document.body;
    }

    /**
     * List every text node a Range touches, in order, as
     *   { wrap | node, start, end }   (character offsets inside that node)
     * Nothing is tokenised here; extend() does that a batch at a time so a
     * long page never freezes when reading starts.
     */
    collect(range, fromSelection) {
      const engine = this.engine;
      const root = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
      if (!root) return [];

      const skip = fromSelection ? SELECTION_SKIP : PAGE_SKIP;
      const visibility = new Map();
      const usable = (el) => {
        if (!visibility.has(el)) visibility.set(el, isVisible(el) && !el.closest(skip));
        return visibility.get(el);
      };

      // Pass 1: every text node the range touches, as [start, end) offsets.
      const entries = [];
      const byWrap = new Map();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!range.intersectsNode(node)) continue;
        const length = node.nodeValue.length;
        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : length;
        if (start >= end) continue;
        const parent = node.parentElement;
        if (!parent) continue;

        const wrap = parent.closest('.lexilens-wrap');
        if (wrap) {
          if (!wrap.parentElement || !usable(wrap.parentElement)) continue;
          const offset = offsetWithin(wrap, node);
          const existing = byWrap.get(wrap);
          if (existing) {
            existing.start = Math.min(existing.start, offset + start);
            existing.end = Math.max(existing.end, offset + end);
          } else {
            const entry = { wrap, node: null, start: offset + start, end: offset + end };
            byWrap.set(wrap, entry);
            entries.push(entry);
          }
        } else if (engine.isEligibleText(node) && usable(parent)) {
          entries.push({ wrap: null, node, start, end });
        }
      }

      // "Read page" starts from what is on screen, not from the very top.
      let first = 0;
      if (!fromSelection && window.scrollY > 240) {
        for (let i = 0; i < entries.length; i += 1) {
          const anchor = entries[i].wrap || entries[i].node.parentElement;
          if (anchor.getBoundingClientRect().bottom > 70) { first = i; break; }
        }
      }

      return entries.slice(first);
    }

    /**
     * Tokenise the next batch of entries and append their sentences:
     *   { text, token }  token is null for spaces, numbers and punctuation
     *   { br: true }     a block boundary (forces a sentence break)
     */
    extend() {
      const engine = this.engine;
      const entries = this.entries || [];
      if (this.entryIndex >= entries.length) return;
      const items = [];
      const stop = Math.min(entries.length, this.entryIndex + BATCH_ENTRIES);
      for (let i = this.entryIndex; i < stop; i += 1) {
        const entry = entries[i];
        const wrap = entry.wrap && entry.wrap.isConnected
          ? entry.wrap
          : engine.wrapperFor(entry.node) || engine.tokenizeNow([entry.node])[0];
        if (!wrap || !wrap.parentElement) continue;

        const block = blockOf(wrap.parentElement);
        if (this.lastBlock && block !== this.lastBlock) items.push({ br: true });
        this.lastBlock = block;

        let offset = 0;
        for (const child of wrap.childNodes) {
          const text = child.textContent;
          const from = Math.max(entry.start, offset);
          const to = Math.min(entry.end, offset + text.length);
          if (from < to) {
            const isToken = child.nodeType === Node.ELEMENT_NODE && child.classList.contains('lexilens-token');
            if (isToken) items.push({ text, token: child });
            else items.push({ text: text.slice(from - offset, to - offset), token: null });
          }
          offset += text.length;
        }
      }
      this.entryIndex = stop;
      // Each batch ends on a text-node boundary, so close the sentence there.
      items.push({ br: true });
      for (const chunk of this.chunk(items)) this.chunks.push(chunk);
      if (!items.some((item) => item.token) && this.entryIndex < entries.length) this.extend();
    }

    /** Group pieces into sentence-sized chunks with word offsets. */
    chunk(items) {
      const chunks = [];
      let text = '';
      let words = [];

      const flush = () => {
        const trimmed = text.replace(/\s+$/, '');
        if (words.length || /[\p{L}\p{N}]/u.test(trimmed)) chunks.push({ text: trimmed, words });
        text = '';
        words = [];
      };

      for (const item of items) {
        if (item.br) {
          if (text.trim()) flush();
          continue;
        }
        if (item.token) {
          words.push({ token: item.token, start: text.length, end: text.length + item.text.length });
          text += item.text;
          continue;
        }
        let plain = item.text.replace(/\s+/g, ' ');
        if (!text || text.endsWith(' ')) plain = plain.replace(/^ /, '');
        if (!plain) continue;
        text += plain;

        const sentenceEnd = /[.!?]["'”’)\]]*\s*$/.test(plain) && /\s$/.test(plain);
        const softBreak = text.length > MAX_CHUNK_CHARS && /[,;:—]\s*$/.test(plain);
        const hardBreak = text.length > MAX_CHUNK_CHARS * 1.6 && /\s$/.test(plain);
        if ((sentenceEnd && text.length > 24) || softBreak || hardBreak) flush();
      }
      if (text.trim()) flush();
      return chunks;
    }
  }

  /** Character offset of a text node inside its wrapper. */
  function offsetWithin(wrap, textNode) {
    let offset = 0;
    const walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node === textNode) return offset;
      offset += node.nodeValue.length;
    }
    return offset;
  }

  LL.TTSEngine = TTSEngine;
})();
