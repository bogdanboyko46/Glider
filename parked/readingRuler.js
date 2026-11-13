/*
 * LexiLens — reading ruler and focus spotlight.
 *
 * A translucent band follows the pointer (or the Up/Down arrow keys) and dims
 * the page above and below a 2 to 4 line reading window. It is three fixed
 * layers moved with CSS transforms, so tracking stays smooth on heavy pages.
 */
(() => {
  'use strict';

  const LL = (globalThis.LexiLens = globalThis.LexiLens || {});

  const DEFAULT_LINE_PX = 28;
  const EDGE_PAD = 12;
  const SAMPLE_EVERY_MS = 160;

  const reducedMotion = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  class ReadingRuler {
    constructor() {
      this.enabled = false;
      this.lines = 3;
      this.linePx = DEFAULT_LINE_PX;
      this.y = Math.round(window.innerHeight / 2);
      this.targetY = this.y;
      this.root = null;
      this.raf = 0;
      this.lastSample = 0;
      this.keyboardMode = false;
      this.lastPointerY = -1;

      this.onPointerMove = this.onPointerMove.bind(this);
      this.onKeyDown = this.onKeyDown.bind(this);
      this.onResize = this.onResize.bind(this);
      this.tick = this.tick.bind(this);
    }

    /* ------------------------------------------------------------- public */

    setEnabled(on) {
      on = !!on;
      if (on === this.enabled) return;
      this.enabled = on;
      if (on) {
        this.mount();
        this.apply(true);
        this.root.setAttribute('data-on', '');
        window.addEventListener('pointermove', this.onPointerMove, { passive: true });
        window.addEventListener('keydown', this.onKeyDown, true);
        window.addEventListener('resize', this.onResize, { passive: true });
      } else {
        if (this.root) this.root.removeAttribute('data-on');
        window.removeEventListener('pointermove', this.onPointerMove);
        window.removeEventListener('keydown', this.onKeyDown, true);
        window.removeEventListener('resize', this.onResize);
        cancelAnimationFrame(this.raf);
        this.raf = 0;
      }
    }

    isEnabled() {
      return this.enabled;
    }

    /** Re-attach the ruler if the page removed it. */
    ensure() {
      if (!this.enabled || (this.root && this.root.isConnected)) return;
      this.mount();
      this.apply(true);
      this.root.setAttribute('data-on', '');
    }

    /** Height of the reading window, in lines of text (2 to 4). */
    setLines(n) {
      this.lines = Math.min(4, Math.max(2, Math.round(Number(n) || 3)));
      if (this.root) this.apply(false);
    }

    /** Move the window to a viewport Y (used to follow read-aloud). */
    pointAt(y) {
      if (!this.enabled) return;
      this.keyboardMode = true;
      this.moveTo(y);
    }

    /* ------------------------------------------------------------ internals */

    mount() {
      if (this.root && this.root.isConnected) return;
      const root = document.createElement('div');
      root.id = 'lexilens-ruler';
      root.setAttribute('aria-hidden', 'true');
      for (const edge of ['top', 'bottom']) {
        const shade = document.createElement('div');
        shade.className = 'lexilens-ruler-shade';
        shade.dataset.edge = edge;
        root.appendChild(shade);
      }
      const band = document.createElement('div');
      band.className = 'lexilens-ruler-band';
      root.appendChild(band);
      document.documentElement.appendChild(root);
      this.root = root;
    }

    get height() {
      return Math.round(this.lines * this.linePx + 10);
    }

    clampY(y) {
      const half = this.height / 2;
      return Math.min(window.innerHeight - half - EDGE_PAD, Math.max(half + EDGE_PAD, y));
    }

    apply(immediate) {
      if (!this.root) return;
      if (immediate) this.y = this.targetY = this.clampY(this.targetY);
      this.root.style.setProperty('--lexilens-ruler-h', this.height + 'px');
      this.root.style.setProperty('--lexilens-ruler-y', this.y.toFixed(1) + 'px');
    }

    moveTo(y) {
      this.targetY = this.clampY(y);
      if (reducedMotion()) {
        this.y = this.targetY;
        this.apply(false);
        return;
      }
      if (!this.raf) this.raf = requestAnimationFrame(this.tick);
    }

    tick() {
      this.raf = 0;
      const delta = this.targetY - this.y;
      if (Math.abs(delta) < 0.4) {
        this.y = this.targetY;
        this.apply(false);
        return;
      }
      this.y += delta * 0.32;
      this.apply(false);
      this.raf = requestAnimationFrame(this.tick);
    }

    /** Estimate the line height of the text under the pointer. */
    sampleLineHeight(x, y) {
      const now = performance.now();
      if (now - this.lastSample < SAMPLE_EVERY_MS) return;
      this.lastSample = now;
      const el = document.elementFromPoint(x, y);
      if (!el || el.id === 'lexilens-root' || el === document.documentElement || el === document.body) return;
      const style = getComputedStyle(el);
      let px = parseFloat(style.lineHeight);
      if (!Number.isFinite(px)) px = parseFloat(style.fontSize) * 1.5;
      if (!Number.isFinite(px)) return;
      px *= el.currentCSSZoom || 1; // text size setting
      px = Math.min(96, Math.max(18, px));
      if (Math.abs(px - this.linePx) > 1) {
        this.linePx = px;
        this.root.style.setProperty('--lexilens-ruler-h', this.height + 'px');
      }
    }

    onPointerMove(event) {
      if (this.keyboardMode) {
        // After arrow-key use, ignore tiny pointer jitter.
        if (Math.abs(event.clientY - this.lastPointerY) < 6) return;
        this.keyboardMode = false;
      }
      this.lastPointerY = event.clientY;
      this.sampleLineHeight(event.clientX, event.clientY);
      this.moveTo(event.clientY);
    }

    onKeyDown(event) {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isTypingTarget(event) || focusNeedsArrows()) return;

      const step = event.key === 'ArrowDown' ? this.linePx : -this.linePx;
      const next = this.targetY + step;
      const clamped = this.clampY(next);
      this.keyboardMode = true;
      if (Math.abs(clamped - next) < 1) {
        // Room to move inside the viewport: move the ruler, keep the page still.
        event.preventDefault();
        this.moveTo(next);
      }
      // At the edge we let the browser scroll the page under the ruler.
    }

    onResize() {
      this.targetY = this.clampY(this.targetY);
      this.y = this.targetY;
      this.apply(false);
    }
  }

  /** True when the key press belongs to a form field, editor or our own dock. */
  function isTypingTarget(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    const el = path[0];
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (path.some((node) => node && node.id === 'lexilens-root')) return true;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.getAttribute('role') === 'textbox' ||
      el.getAttribute('role') === 'slider' || el.getAttribute('role') === 'listbox';
  }

  /** True when keyboard focus is on something that uses the arrow keys itself. */
  function focusNeedsArrows() {
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
    if (!active || active === document.body || active === document.documentElement) return false;
    return active.matches('input, select, textarea, video, audio, iframe, [role], [contenteditable]:not([contenteditable="false"]), [tabindex]:not(a):not(button)');
  }

  LL.isTypingTarget = isTypingTarget;
  LL.ReadingRuler = ReadingRuler;
})();
