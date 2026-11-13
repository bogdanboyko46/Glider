/*
 * LexiLens — DOM engine.
 *
 * Wraps the words of a page in <span class="lexilens-token"> elements so the
 * visual decoders (bionic cadence, b/d/p/q guard, look-alike lens, syllable
 * hover, read-aloud highlight) have something to hold on to — and puts the
 * page back exactly as it was when they are switched off.
 *
 * How it stays safe and fast:
 *  - A TreeWalker prunes whole subtrees we must never touch (scripts, form
 *    fields, code, editable regions, our own UI).
 *  - Each text node is replaced by ONE wrapper span. The original Text node
 *    is kept in a WeakMap and swapped straight back on restore, so reset is
 *    instant and non-destructive.
 *  - Work is lazy: an IntersectionObserver only tokenises text near the
 *    viewport, in small time slices, so long articles never freeze.
 *  - A MutationObserver picks up content added later (single-page apps).
 *  - Tokens are rendered by one idempotent function, so any mix of features
 *    can be toggled in any order without corrupting the DOM.
 */
(() => {
  'use strict';

  const LL = (globalThis.LexiLens = globalThis.LexiLens || {});

  /* Subtrees that are never tokenised. */
  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'template',
    'textarea', 'input', 'select', 'option', 'button',
    'code', 'pre', 'kbd', 'samp', 'var',
    'svg', 'math', 'canvas', 'video', 'audio', 'iframe', 'object', 'embed',
    '[contenteditable]:not([contenteditable="false"])',
    '[role="textbox"]', '.CodeMirror', '.monaco-editor', '.ace_editor',
    '[data-lexilens-ignore]',
    '.lexilens-wrap', '#lexilens-root', '#lexilens-ruler', '#lexilens-tint',
  ].join(',');

  const CLS = {
    wrap: 'lexilens-wrap',
    token: 'lexilens-token',
    punct: 'lexilens-punct',
    fix: 'lexilens-fix',
    mirror: 'lexilens-m',
    homophone: 'lexilens-homophone',
    long: 'lexilens-long',
  };

  /* A word: letters (any script), with inner apostrophes kept ("they're"). */
  const WORD_RE = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
  const HAS_LETTER_RE = /\p{L}/u;
  /* Clause punctuation that is followed by a space or ends the text node. */
  const PUNCT_RE = /[,;.]+(?=\s|$)/g;
  const MIRROR_RE = /[bdpq]/;
  const MIRROR_SPLIT_RE = /([bdpq])/;
  const LONG_WORD = 6;

  /* Function words so frequent that underlining them would cover the page.
     Their rarer partners (too, off, four, saw, hour, wood...) still get the
     underline, and the tooltip there explains both. */
  const QUIET_WORDS = new Set([
    'to', 'of', 'for', 'was', 'are', 'our', 'would', 'some', 'by', 'no', 'here', 'were', 'who', 'how',
    'now', 'own', 'does', 'very', 'new', 'see', 'being', 'which', 'left', 'since', 'know', 'right',
  ]);

  const TIME_SLICE_MS = 7;
  const MUTATION_DEBOUNCE_MS = 140;

  function letterCount(word) {
    let n = 0;
    for (const ch of word) if (ch !== "'" && ch !== '’') n += 1;
    return n;
  }

  /* Bionic fixation length: 1 letter for 1–3, 2 for 4–5, ~40% beyond that. */
  function fixationLength(word) {
    const n = letterCount(word);
    if (n <= 3) return 1;
    if (n <= 5) return 2;
    return Math.ceil(n * 0.4);
  }

  class DomEngine {
    constructor() {
      this.flags = { bionic: false, mirror: false, homophones: false, syllables: false, clickSpeak: false };
      this.holds = new Set();
      this.running = false;

      this.originals = new WeakMap(); // wrapper span -> original Text node
      this.wrappers = new WeakMap();  // original Text node -> wrapper span
      this.words = new WeakMap();     // token span -> its word
      this.snapshots = new WeakMap(); // wrapper span -> text at wrap time

      this.queue = new Set();         // elements waiting to be tokenised
      this.pendingRoots = new Set();  // roots added by the page, waiting to be scanned
      this.sliceTimer = 0;
      this.mutationTimer = 0;
      this.renderPass = 0;

      this.io = null;
      this.mo = null;

      this.liveWraps = document.getElementsByClassName(CLS.wrap);
      this.liveTokens = document.getElementsByClassName(CLS.token);
    }

    /* ------------------------------------------------------------ public */

    /**
     * Tell the engine which token-based features are on. It starts, re-renders
     * or fully restores the page as needed.
     */
    setFeatures(next) {
      const prev = this.flags;
      this.flags = {
        bionic: !!next.bionic,
        mirror: !!next.mirror,
        homophones: !!next.homophones,
        syllables: !!next.syllables,
        clickSpeak: !!next.clickSpeak,
      };
      const structureChanged =
        prev.bionic !== this.flags.bionic ||
        prev.mirror !== this.flags.mirror ||
        prev.homophones !== this.flags.homophones;

      this.reconcile();
      if (this.running && structureChanged) this.rerenderAll();
    }

    /** Keep tokens alive for a temporary consumer such as read-aloud. */
    hold(name) {
      this.holds.add(name);
      this.reconcile();
    }

    release(name) {
      this.holds.delete(name);
      this.reconcile();
    }

    /** True when any feature currently needs tokens on the page. */
    get needed() {
      const f = this.flags;
      return f.bionic || f.mirror || f.homophones || f.syllables || f.clickSpeak || this.holds.size > 0;
    }

    /** Is this text node allowed to be tokenised? */
    isEligibleText(node) {
      if (!node || node.nodeType !== Node.TEXT_NODE) return false;
      const parent = node.parentElement;
      if (!parent || !parent.isConnected) return false;
      if (!HAS_LETTER_RE.test(node.nodeValue)) return false;
      if (parent.isContentEditable) return false;
      return !parent.closest(SKIP_SELECTOR);
    }

    /**
     * Tokenise specific text nodes right now (used by read-aloud for text that
     * is off-screen). Returns the wrapper for each node that was eligible.
     */
    tokenizeNow(textNodes) {
      const out = [];
      for (const node of textNodes) {
        const existing = this.wrapperFor(node);
        if (existing) { out.push(existing); continue; }
        if (!this.isEligibleText(node)) continue;
        out.push(this.tokenizeTextNode(node));
      }
      this.flushRecords();
      return out;
    }

    /** The wrapper that replaced a text node, or that contains a node. */
    wrapperFor(node) {
      if (!node) return null;
      const direct = this.wrappers.get(node);
      if (direct && direct.isConnected) return direct;
      const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      return el ? el.closest('.' + CLS.wrap) : null;
    }

    wordOf(token) {
      return this.words.get(token) || token.textContent || '';
    }

    /** Put every text node back and stop observing. */
    restoreAll() {
      this.stop();
      const wraps = Array.from(this.liveWraps);
      for (const wrap of wraps) {
        const original = this.originals.get(wrap);
        const text = wrap.textContent;
        if (original) {
          // If the page's own code (React, Vue...) rewrote its detached text
          // node while we held it, its newer value wins over our copy.
          const pageChangedIt = original.nodeValue !== this.snapshots.get(wrap);
          if (!pageChangedIt && original.nodeValue !== text) original.nodeValue = text;
          wrap.replaceWith(original);
          this.wrappers.delete(original);
        } else {
          wrap.replaceWith(document.createTextNode(text));
        }
      }
    }

    /* ---------------------------------------------------------- lifecycle */

    reconcile() {
      if (this.needed && !this.running) this.start();
      else if (!this.needed && this.running) this.restoreAll();
    }

    start() {
      if (this.running || !document.body) return;
      this.running = true;

      this.io = new IntersectionObserver((entries) => this.onIntersect(entries), {
        rootMargin: '900px 0px 900px 0px',
      });
      this.mo = new MutationObserver((records) => this.onMutations(records));
      this.mo.observe(document.body, { childList: true, subtree: true });

      this.scan(document.body);
    }

    stop() {
      this.running = false;
      this.renderPass += 1;
      if (this.io) { this.io.disconnect(); this.io = null; }
      if (this.mo) { this.mo.disconnect(); this.mo = null; }
      clearTimeout(this.sliceTimer);
      clearTimeout(this.mutationTimer);
      this.sliceTimer = 0;
      this.mutationTimer = 0;
      this.queue.clear();
      this.pendingRoots.clear();
    }

    /* ------------------------------------------------------------ scanning */

    makeWalker(root) {
      return document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // REJECT prunes the whole subtree; SKIP just walks into it.
            return node.matches(SKIP_SELECTOR) || node.isContentEditable
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_SKIP;
          }
          return HAS_LETTER_RE.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
    }

    /** Find eligible text under `root` and watch its parents for visibility. */
    scan(root) {
      if (!this.running || !root || !root.isConnected) return;
      if (root.nodeType === Node.TEXT_NODE) {
        if (this.isEligibleText(root)) this.io.observe(root.parentElement);
        return;
      }
      if (root.nodeType !== Node.ELEMENT_NODE) return;
      if (root.isContentEditable || root.closest(SKIP_SELECTOR)) return;

      const walker = this.makeWalker(root);
      let last = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (parent && parent !== last) {
          this.io.observe(parent);
          last = parent;
        }
      }
    }

    /** Collect eligible text nodes under a root, in document order. */
    collectTextNodes(root) {
      const out = [];
      if (!root || root.nodeType !== Node.ELEMENT_NODE) return out;
      if (root.isContentEditable || root.closest(SKIP_SELECTOR)) return out;
      const walker = this.makeWalker(root);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) out.push(node);
      return out;
    }

    onIntersect(entries) {
      if (!this.running) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this.io.unobserve(entry.target);
        this.queue.add(entry.target);
      }
      this.schedule();
    }

    onMutations(records) {
      if (!this.running) return;
      for (const record of records) {
        const target = record.target;
        // Ignore our own token re-renders.
        if (target.nodeType === Node.ELEMENT_NODE && target.closest('.' + CLS.wrap)) continue;
        for (const node of record.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList.contains(CLS.wrap) || node.id === 'lexilens-root') continue;
            this.pendingRoots.add(node);
          } else if (node.nodeType === Node.TEXT_NODE) {
            this.pendingRoots.add(node);
          }
        }
      }
      if (this.pendingRoots.size && !this.mutationTimer) {
        this.mutationTimer = setTimeout(() => {
          this.mutationTimer = 0;
          const roots = Array.from(this.pendingRoots);
          this.pendingRoots.clear();
          for (const root of roots) this.scan(root);
        }, MUTATION_DEBOUNCE_MS);
      }
    }

    /** Drop mutation records caused by our own DOM writes. */
    flushRecords() {
      if (this.mo) this.mo.takeRecords();
    }

    /* ---------------------------------------------------------- tokenising */

    schedule() {
      if (this.sliceTimer || !this.queue.size) return;
      this.sliceTimer = setTimeout(() => {
        this.sliceTimer = 0;
        this.processSlice();
      }, 0);
    }

    processSlice() {
      if (!this.running) return;
      const deadline = performance.now() + TIME_SLICE_MS;
      for (const el of this.queue) {
        this.queue.delete(el);
        this.tokenizeElement(el);
        if (performance.now() > deadline) break;
      }
      this.flushRecords();
      this.schedule();
    }

    tokenizeElement(el) {
      if (!el.isConnected || el.isContentEditable || el.closest(SKIP_SELECTOR)) return;
      const children = Array.from(el.childNodes);
      for (const child of children) {
        if (child.nodeType === Node.TEXT_NODE && HAS_LETTER_RE.test(child.nodeValue)) {
          this.tokenizeTextNode(child);
        }
      }
    }

    tokenizeTextNode(node) {
      const text = node.nodeValue;
      const wrap = document.createElement('span');
      wrap.className = CLS.wrap;

      let cursor = 0;
      WORD_RE.lastIndex = 0;
      for (let m = WORD_RE.exec(text); m; m = WORD_RE.exec(text)) {
        if (m.index > cursor) this.appendPlain(wrap, text.slice(cursor, m.index));
        const token = document.createElement('span');
        token.className = CLS.token;
        this.words.set(token, m[0]);
        this.renderToken(token, m[0]);
        wrap.appendChild(token);
        cursor = m.index + m[0].length;
      }
      if (cursor < text.length) this.appendPlain(wrap, text.slice(cursor));

      this.originals.set(wrap, node);
      this.snapshots.set(wrap, text);
      this.wrappers.set(node, wrap);
      node.parentNode.replaceChild(wrap, node);
      return wrap;
    }

    /** Text between words: plain text, with clause punctuation marked. */
    appendPlain(wrap, text) {
      let cursor = 0;
      PUNCT_RE.lastIndex = 0;
      for (let m = PUNCT_RE.exec(text); m; m = PUNCT_RE.exec(text)) {
        if (m.index > cursor) wrap.appendChild(document.createTextNode(text.slice(cursor, m.index)));
        const punct = document.createElement('span');
        punct.className = CLS.punct;
        punct.textContent = m[0];
        wrap.appendChild(punct);
        cursor = m.index + m[0].length;
      }
      if (cursor < text.length) wrap.appendChild(document.createTextNode(text.slice(cursor)));
    }

    /* ------------------------------------------------------------ rendering */

    /**
     * Draw one token for the current feature set. Idempotent: the result
     * depends only on the word and the flags, never on what was there before.
     */
    renderToken(token, word) {
      const { bionic, mirror, homophones } = this.flags;

      token.classList.toggle(CLS.long, letterCount(word) >= LONG_WORD);
      token.classList.toggle(CLS.homophone, homophones && !!this.lookup(word));

      const needsMirror = mirror && MIRROR_RE.test(word);
      if (!bionic && !needsMirror) {
        const only = token.firstChild;
        if (!only || only.nodeType !== Node.TEXT_NODE || token.childNodes.length !== 1 || only.nodeValue !== word) {
          token.textContent = word;
        }
        return;
      }

      const frag = document.createDocumentFragment();
      if (bionic) {
        const cut = this.fixationCut(word);
        const fix = document.createElement('span');
        fix.className = CLS.fix;
        this.fill(fix, word.slice(0, cut), mirror);
        frag.appendChild(fix);
        this.fill(frag, word.slice(cut), mirror);
      } else {
        this.fill(frag, word, mirror);
      }
      token.replaceChildren(frag);
    }

    /** String index after the fixation letters (apostrophes do not count). */
    fixationCut(word) {
      let remaining = fixationLength(word);
      let i = 0;
      while (i < word.length && remaining > 0) {
        const ch = word[i];
        if (ch !== "'" && ch !== '’') remaining -= 1;
        i += 1;
      }
      return i;
    }

    fill(parent, text, mirror) {
      if (!text) return;
      if (!mirror || !MIRROR_RE.test(text)) {
        parent.appendChild(document.createTextNode(text));
        return;
      }
      for (const part of text.split(MIRROR_SPLIT_RE)) {
        if (!part) continue;
        if (part.length === 1 && MIRROR_RE.test(part)) {
          const letter = document.createElement('span');
          letter.className = `${CLS.mirror} ${CLS.mirror}-${part}`;
          letter.textContent = part;
          parent.appendChild(letter);
        } else {
          parent.appendChild(document.createTextNode(part));
        }
      }
    }

    /** The confusion group to underline this word for, if any. */
    lookup(word) {
      if (typeof LL.lookupHomophone !== 'function') return null;
      if (QUIET_WORDS.has(word.toLowerCase())) return null;
      return LL.lookupHomophone(word);
    }

    /** Re-draw every existing token after a feature change, in time slices. */
    rerenderAll() {
      const pass = (this.renderPass += 1);
      const tokens = Array.from(this.liveTokens);
      let i = 0;
      const step = () => {
        if (pass !== this.renderPass || !this.running) return;
        const deadline = performance.now() + 12;
        while (i < tokens.length && performance.now() < deadline) {
          const token = tokens[i];
          if (token.isConnected) this.renderToken(token, this.wordOf(token));
          i += 1;
        }
        this.flushRecords();
        if (i < tokens.length) setTimeout(step, 0);
      };
      step();
    }
  }

  LL.CLS = CLS;
  LL.SKIP_SELECTOR = SKIP_SELECTOR;
  LL.fixationLength = fixationLength;
  LL.DomEngine = DomEngine;
})();
