/*
 * Glider — main orchestrator.
 *
 * Owns the settings (chrome.storage.local, synced live across tabs), builds
 * the floating dock inside a Shadow DOM so host-page CSS and ours never meet,
 * and drives the DOM engine from one `apply()`
 * function. There is a single reading lens: on or off.
 */
(() => {
  'use strict';

  const LL = (globalThis.Glider = globalThis.Glider || {});
  if (LL.booted) return; // injected twice (e.g. on install) — keep the first copy
  if (!document.documentElement || !/html/i.test(document.contentType || 'text/html')) return;
  LL.booted = true;

  /* After an extension update Chrome injects a fresh copy next to the old,
     now-orphaned one. The newcomer asks older copies to stand down and clears
     anything they left in the page. */
  const TAKEOVER = 'glider:takeover';
  document.dispatchEvent(new CustomEvent(TAKEOVER));
  for (const id of ['glider-root', 'glider-ruler', 'glider-tint']) { // ruler and tint: left by older builds
    const stale = document.getElementById(id);
    if (stale) stale.remove();
  }
  for (const wrap of Array.from(document.getElementsByClassName('glider-wrap'))) {
    wrap.replaceWith(document.createTextNode(wrap.textContent));
  }

  /* Decided once: inside an extension we never fall back to the host site's
     localStorage, even if the extension context later goes away. */
  const IN_EXTENSION = (() => {
    try { return typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.id && !!chrome.storage; }
    catch (_) { return false; }
  })();


  /* =====================================================================
   * Settings
   * ===================================================================== */

  const SETTINGS_KEY = 'glider:settings:v2';
  const DOCK_KEY = 'glider:dock';

  /* There is one lens. When it is on, every aid works together: the spacing
     guard, bionic cadence, the look-alike underlines, and the hover lens that
     splits a long word into syllables. The rest of the settings only tune it. */
  /* The name people see. Internal ids use the glider- prefix. */
  const APP_NAME = 'Glider';

  const DEFAULTS = Object.freeze({
    on: true,            // the lens itself
    dockVisible: true,   // show the floating dock
    skin: 'sage',        // the chosen design; the others stay in DOCK_CSS
    fontSize: 100,       // body text size, percent of the page's own size
    letterSpacing: 1,
    wordSpacing: 3,
    lineHeight: 1.8,
    mirror: false,       // b d p q colours
    font: false,         // Atkinson Hyperlegible for body text
    gaze: false,         // webcam eye tracking: notice a hard line and help
    gazeSensitivity: 3,  // 1 (help rarely) .. 5 (help often)
    seeOriginal: false,  // a faint "see original" control beside text that was set out differently (adapt/adapt.js)
    gazeTrace: false,    // TEMPORARY: heat where the tracker thinks the eyes are, to check it by eye (gaze-reader.js setTrace)
    showLevels: true,    // show how hard a word is to read (and its CEFR level) in the hover lens
    showDefinitions: false, // open the word's meaning in the lens straight away
    showWordParts: true, // mark prefixes, roots and suffixes in the lens
    dockMode: 'float',   // 'float': the pill sits in a corner; 'edge': a slim tab tucked into the screen edge
  });

  const BOOL_KEYS = ['on', 'dockVisible', 'mirror', 'font', 'gaze', 'seeOriginal', 'gazeTrace', 'showLevels', 'showDefinitions', 'showWordParts'];
  const DOCK_MODES = ['float', 'edge'];
  const WORDS_KEY = 'glider:words';  // the reader's saved words, newest last
  const WORDS_CAP = 2000;
  const SKINS = Object.freeze([
    { id: 'paper', name: 'Paper' },
    { id: 'flow', name: 'Flow' },
    { id: 'frost', name: 'Frost' },
    { id: 'graphite', name: 'Graphite' },
    { id: 'sage', name: 'Sage' },
    { id: 'blueprint', name: 'Blueprint' },
    { id: 'pop', name: 'Pop' },
    { id: 'marigold', name: 'Marigold' },
    { id: 'plum', name: 'Plum' },
    { id: 'contrast', name: 'High contrast' },
  ]);

  const RANGES = Object.freeze({
    fontSize: { min: 100, max: 160, step: 10, format: (v) => `${v}%` },
    letterSpacing: { min: 0, max: 4, step: 0.5, format: (v) => `${v} px` },
    wordSpacing: { min: 0, max: 10, step: 1, format: (v) => `${v} px` },
    lineHeight: { min: 1.4, max: 2.4, step: 0.1, format: (v) => Number(v).toFixed(1) },
    gazeSensitivity: { min: 1, max: 5, step: 1, format: (v) => ['Rarely', 'Less', 'Balanced', 'More', 'Often'][v - 1] },
  });

  /* What each "Help" step does to the calibrated threshold: above 1 the eye
     tracker waits longer before helping, below 1 it steps in sooner. */
  const GAZE_SENSITIVITY = Object.freeze([1.4, 1.2, 1, 0.85, 0.7]);

  function sanitize(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const s = {};
    for (const key of Object.keys(DEFAULTS)) s[key] = key in src ? src[key] : DEFAULTS[key];
    for (const key of BOOL_KEYS) s[key] = !!s[key];
    for (const key of Object.keys(RANGES)) {
      const r = RANGES[key];
      const n = Number(s[key]);
      s[key] = Number.isFinite(n) ? Math.min(r.max, Math.max(r.min, n)) : DEFAULTS[key];
    }
    s.gazeSensitivity = Math.round(s.gazeSensitivity);
    s.dockMode = DEFAULTS.dockMode; // the edge mark is the only dock look; the tuck-into-the-side mode is off
    // One design: it is fixed, whatever was stored earlier.
    s.skin = DEFAULTS.skin;
    return s;
  }

  /* chrome.storage with a localStorage fallback so the same file also runs
     in the plain-page demo harness. */
  const storage = {
    /** False once the extension has been reloaded or removed under this page. */
    alive() {
      try { return !IN_EXTENSION || !!chrome.runtime.id; } catch (_) { return false; }
    },
    async get(key) {
      try {
        if (IN_EXTENSION) return (await chrome.storage.local.get(key))[key];
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : undefined;
      } catch (_) { return undefined; }
    },
    set(key, value) {
      try {
        if (IN_EXTENSION) chrome.storage.local.set({ [key]: value }).catch(() => {});
        else localStorage.setItem(key, JSON.stringify(value));
      } catch (_) { /* extension reloaded or storage blocked: keep working in memory */ }
    },
    onChange(key, fn) {
      try {
        if (IN_EXTENSION) {
          chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[key]) fn(changes[key].newValue);
          });
        } else {
          window.addEventListener('storage', (event) => {
            if (event.key === key && event.newValue) fn(JSON.parse(event.newValue));
          });
        }
      } catch (_) { /* no live sync available */ }
    },
  };

  const assetURL = (path) => {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) return chrome.runtime.getURL(path);
    } catch (_) { /* fall through */ }
    return path;
  };

  /* =====================================================================
   * Icons (inline SVG, stroke follows text colour)
   * ===================================================================== */

  const svg = (body, extra = '') =>
    `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

  const ICON = {
    /* The mark is recoloured per design through CSS classes. */
    steps: svg('<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>'),
    speaker: svg('<path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z"/><path d="M15.5 9a4 4 0 0 1 0 6"/><path d="M18 6.5a7.5 7.5 0 0 1 0 11"/>'),
    minimise: svg('<path d="m7 10 5 5 5-5"/>'),
    bookmark: svg('<path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z"/>'),
    book: svg('<path d="M4 5.5C4 4.7 4.7 4 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M20 5.5c0-.8-.7-1.5-1.5-1.5H13v16h5.5c.8 0 1.5-.7 1.5-1.5z"/>'),
    spark: svg('<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z"/><path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>'),
    tuck: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M15 4.5v15"/><path d="m9 10 2 2-2 2"/>'),
    float: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><rect x="11.5" y="12" width="6" height="4.5" rx="1.2"/>'),
    home: svg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>'),
  };

  /* =====================================================================
   * Dock styles (live inside the shadow root only)
   *
   * One structure, ten designs. Everything visual runs through custom
   * properties: the base block below is the Paper design, and each
   * [data-skin] block redefines the tokens (and a few shapes) it changes.
   * ===================================================================== */

  const DOCK_CSS = `
:host { all: initial; }

.ll {
  --lexend: "Glider Lexend", "Lexend", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
  --atkinson: "Glider Atkinson", "Atkinson Hyperlegible", "Segoe UI", system-ui, sans-serif;
  --serif: "Glider Serif", "Instrument Serif", "Iowan Old Style", Georgia, serif;
  --mono: "Glider Mono", "JetBrains Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;
  --system: "Segoe UI Variable Display", "Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  --ease: cubic-bezier(.2, .8, .2, 1);

  /* ---- Paper (default): flat white, ink text, highlighter yellow ---- */
  --font: var(--lexend);
  --font-display: var(--font);
  --title-size: 15px;
  --title-weight: 600;
  --title-style: normal;
  --title-track: -.01em;
  --name-weight: 500;

  --surface: #ffffff;
  --well: #f1f3f9;
  --well-hover: #e8ebf5;
  --ink: #141b34;
  --ink-2: #55607f;
  --line: #e1e5f0;
  --line-strong: #8a93b2;
  --accent: #ffd84d;
  --accent-ink: #141b34;
  --accent-edge: #141b34;
  --focus: #141b34;
  --track: #dfe3ee;
  --thumb: #ffffff;
  --range-fill: var(--ink);
  --syl-a: #ffe57a;
  --syl-b: #cfe6ff;
  --syl-ink: #141b34;

  --hero-bg: #fff6cf;
  --hero-ink: #141b34;
  --hero-ink-2: #5c5a3c;
  --hero-edge: transparent;
  --hero-shadow: 0 0 0 0 transparent;
  --hero-off-bg: var(--well);

  --pill-bg: var(--surface);
  --pill-ink: var(--ink);
  --pill-h: 46px;
  --pill-radius: 999px;

  --mark-bg: #141b34;
  --mark-hi: #ffd84d;
  --mark-ink: #141b34;
  --mark-dim: rgba(255, 255, 255, .34);

  --panel-w: 348px;
  --pad: 14px;
  --row-h: 46px;
  --radius: 18px;
  --radius-ctl: 11px;
  --radius-chip: 6px;
  --sw-radius: 999px;
  --sw-thumb-radius: 50%;
  --bw: 1px;
  --divider: var(--bw) solid var(--line);
  --edge: 0 0 0 1px rgba(20, 27, 52, .09);
  --shadow: var(--edge), 0 2px 4px rgba(20, 27, 52, .05), 0 18px 44px -10px rgba(20, 27, 52, .28);
  --backdrop: none;
  --texture: none;

  position: fixed;
  inset: 0;
  pointer-events: none;
  font-family: var(--font);
  font-size: 13px;
  line-height: 1.4;
  font-weight: 400;
  color: var(--ink);
  text-align: left;
  letter-spacing: 0;
  -webkit-font-smoothing: antialiased;
  -webkit-text-size-adjust: 100%;
}

.ll *, .ll *::before, .ll *::after { box-sizing: border-box; }
.ll [hidden] { display: none !important; }
:where(.ll) button, :where(.ll) input { font: inherit; color: inherit; letter-spacing: inherit; margin: 0; }
:where(.ll) button { background: none; border: 0; padding: 0; cursor: pointer; text-align: inherit; }
.ll :focus { outline: none; }
.ll :focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

/* ----------------------------------------------------------------- dock */

.ll-dock { position: absolute; width: 0; height: 0; }
.ll-dock > * { position: absolute; pointer-events: auto; }
.ll-dock[data-h="r"] > * { right: 0; }
.ll-dock[data-h="l"] > * { left: 0; }
.ll-dock[data-v="b"] > * { bottom: 0; }
.ll-dock[data-v="t"] > * { top: 0; }
.ll-dock[data-h="r"][data-v="b"] > * { transform-origin: 100% 100%; }
.ll-dock[data-h="l"][data-v="b"] > * { transform-origin: 0 100%; }
.ll-dock[data-h="r"][data-v="t"] > * { transform-origin: 100% 0; }
.ll-dock[data-h="l"][data-v="t"] > * { transform-origin: 0 0; }

.ll-mark { display: block; flex: none; width: 28px; height: 28px; }
.ll-mark svg { display: block; width: 100%; height: 100%; }
.m-bg { fill: var(--mark-bg); }
.m-hi { fill: var(--mark-hi); }
.m-ink { fill: var(--mark-ink); }
.m-dim { fill: var(--mark-dim); }

/* --------------------------------------------------------------- switch */

.ll-switch {
  position: relative;
  display: block;
  flex: none;
  width: 42px;
  height: 24px;
  border-radius: var(--sw-radius);
  background: var(--track);
  box-shadow: inset 0 0 0 var(--bw) var(--line-strong);
  transition: background-color .15s ease, box-shadow .15s ease;
}
.ll-switch::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: var(--sw-thumb-radius);
  background: var(--thumb);
  box-shadow: 0 1px 3px rgba(16, 17, 21, .3), 0 0 0 var(--bw) var(--line-strong);
  transition: transform .15s var(--ease), background-color .15s ease;
}
.ll-switch[aria-checked="true"], [aria-checked="true"] > .ll-switch {
  background: var(--accent);
  box-shadow: inset 0 0 0 1.5px var(--accent-edge);
}
.ll-switch[aria-checked="true"]::after, [aria-checked="true"] > .ll-switch::after {
  transform: translateX(18px);
  background: var(--accent-ink);
  box-shadow: none;
}

/* ----------------------------------------------------------------- pill */

.ll-pill {
  display: flex;
  align-items: center;
  height: var(--pill-h);
  padding: 0 11px 0 0;
  border-radius: var(--pill-radius);
  background: var(--pill-bg);
  color: var(--pill-ink);
  -webkit-backdrop-filter: var(--backdrop);
  backdrop-filter: var(--backdrop);
  box-shadow: var(--pill-shadow, var(--shadow));
  white-space: nowrap;
  cursor: grab;
  touch-action: none;
  user-select: none;
  transition: opacity .16s var(--ease), transform .16s var(--ease), visibility 0s;
}
.ll-pill:active, .ll-pill:active button { cursor: grabbing; }
/* Eye tracking's status on the dock mark (the camera box is hidden): a small dot at the mark's outer top corner. */
.ll-pill[data-gaze]::after { content: ""; position: absolute; top: 2px; left: 4px; width: 7px; height: 7px; border-radius: 50%;
  background: #2f8a55; box-shadow: 0 0 0 2px var(--surface, #fff); pointer-events: none; }
.ll-dock[data-h="l"] .ll-pill[data-gaze]::after { left: auto; right: 4px; }
.ll-pill[data-gaze="paused"]::after { background: #d99a1b; }
.ll-pill-main {
  display: flex;
  align-items: center;
  gap: 9px;
  height: 100%;
  padding: 0 12px 0 9px;
  border-radius: var(--pill-radius) 12px 12px var(--pill-radius);
  cursor: inherit;
}
.ll-pill-name { font-family: var(--font-display); font-size: var(--pill-name-size, 14px); font-weight: var(--title-weight); font-style: var(--title-style); letter-spacing: var(--title-track); }

.ll-dock[data-open="true"] .ll-pill,
.ll-dock[data-open="false"] .ll-panel {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: scale(.96);
  transition: opacity .12s ease, transform .12s ease, visibility 0s linear .12s;
}

/* ---------------------------------------------------------------- panel */

.ll-panel {
  display: flex;
  flex-direction: column;
  width: var(--panel-w);
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  border-radius: var(--radius);
  background-color: var(--surface);
  background-image: var(--texture);
  background-size: 16px 16px;
  -webkit-backdrop-filter: var(--backdrop);
  backdrop-filter: var(--backdrop);
  box-shadow: var(--shadow);
  overflow: hidden;
  transition: opacity .18s var(--ease), transform .18s var(--ease), visibility 0s;
}

.ll-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 10px 11px var(--pad);
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.ll-head:active { cursor: grabbing; }
.ll-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ll-title { font-family: var(--font-display); font-size: var(--title-size); font-weight: var(--title-weight); font-style: var(--title-style); line-height: 1.15; letter-spacing: var(--title-track); }
.ll-status { font-size: 12px; color: var(--ink-2); line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.ll-icon-btn {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-ctl);
  color: var(--ink-2);
  transition: background-color .12s ease, color .12s ease;
}
.ll-icon-btn:hover { background: var(--well); color: var(--ink); }

/* hero: the one switch */
.ll-hero {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 var(--pad) 12px;
  padding: 13px 14px;
  border-radius: var(--radius-ctl);
  background: var(--hero-off-bg);
  color: var(--ink);
  box-shadow: inset 0 0 0 var(--bw) var(--line);
  transition: background-color .18s ease, color .18s ease, box-shadow .18s ease;
}
.ll-hero[aria-checked="true"] {
  background: var(--hero-bg);
  color: var(--hero-ink);
  box-shadow: inset 0 0 0 var(--bw) var(--hero-edge), var(--hero-shadow);
}
.ll-hero-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ll-hero-title { font-size: 14.5px; font-weight: 600; line-height: 1.25; letter-spacing: -.005em; }
.ll-hero-hint { font-size: 12px; line-height: 1.35; color: var(--ink-2); }
.ll-hero[aria-checked="true"] .ll-hero-hint { color: var(--hero-ink-2); }
.ll-hero[aria-checked="true"] > .ll-switch {
  background: var(--hero-sw, var(--accent));
  box-shadow: inset 0 0 0 1.5px var(--hero-sw-edge, var(--accent-edge));
}
.ll-hero[aria-checked="true"] > .ll-switch::after { background: var(--hero-sw-thumb, var(--accent-ink)); }

/* hover sample */
.ll-sample {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px 10px;
  padding: 12px var(--pad) 11px;
}
.ll-sample-label { font-size: 12px; color: var(--ink-2); }

/* syllable chunks (sample + tooltip) */
.ll-syls { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; font-size: 16px; font-weight: 600; line-height: 1.2; letter-spacing: .01em; color: var(--syl-ink); }
.ll-syl { padding: 3px 6px 4px; border-radius: var(--radius-chip); background: var(--syl-a); box-shadow: var(--chip-shadow, none); }
.ll-syl:nth-child(4n + 3) { background: var(--syl-b); }
.ll-dot { color: var(--ink-2); font-weight: 400; }
.ll-sample .ll-syls { font-size: 14px; }

/* fine tuning */
.ll-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 var(--pad) 4px;
  border-top: var(--divider);
  scrollbar-width: thin;
  scrollbar-color: var(--line-strong) transparent;
  transition: opacity .18s ease;
}
.ll-body[data-on="false"] { opacity: .42; }
.ll-body > * + * { border-top: var(--divider); }

.ll-row { display: flex; align-items: center; gap: 10px; min-height: var(--row-h); padding: 5px 0; }
.ll-row-text { flex: 1; min-width: 0; }
.ll-name { display: block; font-size: 13px; font-weight: var(--name-weight); line-height: 1.3; }
.ll-hint { display: block; font-size: 11.5px; color: var(--ink-2); line-height: 1.35; }
.ll-kbd {
  display: inline-block;
  margin-left: 7px;
  padding: 0 5px;
  border-radius: 5px;
  box-shadow: inset 0 0 0 var(--bw) var(--line-strong);
  font-size: 10.5px;
  font-weight: 500;
  line-height: 16px;
  color: var(--ink-2);
  vertical-align: 1px;
}

/* sliders */
.ll-sliders { display: grid; grid-template-columns: auto 1fr 40px; align-items: center; column-gap: 12px; padding: 7px 0 8px; }
.ll-sliders label { font-size: 12.5px; font-weight: var(--name-weight); white-space: nowrap; }
.ll-value { font-size: 12px; color: var(--ink-2); text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ll-range {
  -webkit-appearance: none;
  appearance: none;
  display: block;
  width: 100%;
  height: 28px;
  padding: 0;
  background: transparent;
  cursor: pointer;
}
.ll-range::-webkit-slider-runnable-track {
  height: var(--range-h, 4px);
  border-radius: var(--range-radius, 2px);
  background: linear-gradient(to right, var(--range-fill) var(--p, 0%), var(--track) var(--p, 0%));
  box-shadow: var(--range-edge, none);
}
.ll-range::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  margin-top: calc((var(--range-h, 4px) - 16px) / 2);
  border-radius: var(--sw-thumb-radius);
  background: var(--range-thumb, var(--thumb));
  border: 2px solid var(--range-thumb-edge, var(--range-fill));
  box-shadow: 0 1px 2px rgba(16, 17, 21, .2);
}
.ll-range:focus-visible { outline: none; }
.ll-range:focus-visible::-webkit-slider-thumb { outline: 2px solid var(--focus); outline-offset: 2px; }

/* eye tracking */
.ll-gaze-line { display: flex; align-items: center; justify-content: flex-end; gap: 12px; padding: 2px 0 8px; }
.ll-gaze-status { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.4; color: var(--ink-2); }
.ll-btn {
  flex: none;
  height: 28px;
  padding: 0 13px;
  border-radius: var(--radius-ctl);
  background: var(--accent);
  color: var(--accent-ink);
  box-shadow: inset 0 0 0 var(--bw) var(--accent-edge);
  font-size: 12px;
  font-weight: 600;
  line-height: 28px;
  white-space: nowrap;
  transition: opacity .12s ease;
}
.ll-btn:hover { opacity: .88; }
.ll-gaze .ll-sliders { grid-template-columns: auto 1fr 60px; padding: 0 0 8px; }

/* segmented (ruler lines) */
.ll-seg { display: inline-grid; flex: none; grid-auto-flow: column; grid-auto-columns: 28px; gap: 2px; padding: 3px; border-radius: var(--radius-ctl); background: var(--well); box-shadow: inset 0 0 0 var(--bw) var(--line); }
.ll-seg button {
  height: 24px;
  border-radius: max(2px, calc(var(--radius-ctl) - 3px));
  text-align: center;
  font-size: 12.5px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--ink-2);
}
.ll-seg button:hover { color: var(--ink); }
.ll-seg button[aria-checked="true"] { background: var(--accent); color: var(--accent-ink); font-weight: 600; box-shadow: inset 0 0 0 var(--seg-edge, 0px) var(--accent-edge); }


/* footer: design picker */
.ll-foot { display: grid; gap: 9px; padding: 11px var(--pad) 14px; border-top: var(--divider); }
.ll-foot-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ll-foot-head .ll-name { font-size: 12.5px; }
.ll-skin-name { font-size: 12px; color: var(--ink-2); }
.ll-skins { display: flex; justify-content: space-between; gap: 4px; }
.ll-skin {
  width: 22px;
  height: 22px;
  border-radius: var(--tint-radius, 50%);
  background: linear-gradient(135deg, var(--a) 50%, var(--b) 50%);
  box-shadow: inset 0 0 0 1px var(--tint-edge, rgba(20, 27, 52, .28));
  transition: box-shadow .12s ease;
}
.ll-skin[aria-checked="true"] { box-shadow: inset 0 0 0 1px var(--tint-edge, rgba(20, 27, 52, .28)), 0 0 0 2px var(--ring-gap, var(--surface)), 0 0 0 3.5px var(--ink); }
.ll-skin[data-skin-pick="paper"] { --a: #ffffff; --b: #ffd84d; }
.ll-skin[data-skin-pick="flow"] { --a: #17160f; --b: #dccbff; }
.ll-skin[data-skin-pick="frost"] { --a: #e9f1fb; --b: #1f6feb; }
.ll-skin[data-skin-pick="graphite"] { --a: #18191d; --b: #a5b4ff; }
.ll-skin[data-skin-pick="sage"] { --a: #e3ebdc; --b: #2f6b4a; }
.ll-skin[data-skin-pick="blueprint"] { --a: #0f2a52; --b: #8fdcff; }
.ll-skin[data-skin-pick="pop"] { --a: #ffffff; --b: #ff7ab6; }
.ll-skin[data-skin-pick="marigold"] { --a: #ffc93c; --b: #1b1600; }
.ll-skin[data-skin-pick="plum"] { --a: #2a1f5c; --b: #ffb59e; }
.ll-skin[data-skin-pick="contrast"] { --a: #000000; --b: #ffe600; }

/* -------------------------------------------------------------- tooltip */

.ll-tip {
  position: absolute;
  top: 0;
  left: 0;
  max-width: min(380px, calc(100vw - 16px));
  padding: 11px 12px 12px;
  border-radius: min(14px, var(--radius));
  background-color: var(--surface);
  -webkit-backdrop-filter: var(--backdrop);
  backdrop-filter: var(--backdrop);
  box-shadow: var(--shadow);
  pointer-events: auto;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity .12s ease, transform .12s ease;
}
.ll-tip[data-side="below"] { transform: translateY(-4px); }
.ll-tip[data-show="true"] { opacity: 1; transform: none; }
/* Sound parts: each chunk of the word with the sound it makes underneath.
   Every part is a button that says just that sound. */
.ll-parts { display: flex; flex-wrap: wrap; align-items: stretch; gap: 5px; }
.ll-part {
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
  min-width: 40px; padding: 6px 10px 7px;
  border-radius: var(--radius-chip);
  background: var(--syl-a); color: var(--syl-ink);
  cursor: pointer;
  transition: transform .12s var(--ease), box-shadow .12s var(--ease);
}
.ll-part:nth-child(2n) { background: var(--syl-b); }
.ll-part:hover { transform: translateY(-1px); }
.ll-part:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.ll-part[data-now="true"] { box-shadow: 0 0 0 2.5px var(--accent); transform: translateY(-2px); }
.ll-part-letters { font-size: 17px; font-weight: 600; line-height: 1.15; letter-spacing: .02em; }
.ll-part-sound { font-size: 13px; line-height: 1.2; letter-spacing: .02em; opacity: .78; }
.ll-part[data-stress="true"] .ll-part-sound { font-weight: 700; opacity: 1; }
.ll-part-sound:only-child { font-size: 15px; opacity: 1; }
.ll-syls + .ll-parts { margin-top: 8px; }
.ll-say { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-top: 10px; }
.ll-say-btn {
  display: inline-flex; align-items: center; gap: 7px;
  height: 32px; padding: 0 13px 0 10px;
  border-radius: 999px;
  font-size: 13px; font-weight: 600;
  cursor: pointer;
  transition: transform .12s var(--ease), box-shadow .12s var(--ease);
}
.ll-say-btn svg { width: 16px; height: 16px; flex: none; }
.ll-say-btn[data-say="word"] { background: var(--accent); color: var(--accent-ink); }
.ll-say-btn[data-say="slow"] { background: var(--well); color: var(--ink); box-shadow: inset 0 0 0 1px var(--line-strong, var(--line)); }
.ll-say-btn:hover { transform: scale(1.03); }
.ll-say-btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.ll-say-btn[data-speaking="true"] { box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 28%, transparent); }
.ll-say-btn[hidden] { display: none; }
.ll-word { font-family: var(--font-display); font-size: 16px; font-weight: 600; }

.ll-pairs { display: grid; gap: 6px; margin: 12px 0 2px; padding: 10px 0 0; list-style: none; border-top: var(--divider); }
.ll-tip > .ll-pairs:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
.ll-pair { display: grid; grid-template-columns: 26px 1fr; align-items: center; column-gap: 9px; padding: 7px 10px 7px 7px; border-radius: var(--radius-ctl); }
.ll-pair[data-current="true"] { background: var(--well); box-shadow: inset 0 0 0 var(--bw) var(--line); }
.ll-emoji { font-size: 19px; line-height: 1; text-align: center; font-family: "Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif; }
.ll-pair-word { font-size: 13.5px; font-weight: 600; line-height: 1.25; }
.ll-pair-def { display: block; font-size: 12.5px; color: var(--ink-2); line-height: 1.3; }
.ll-here { margin-left: 7px; padding: 1px 6px 2px; border-radius: var(--sw-radius); background: var(--accent); color: var(--accent-ink); font-size: 10.5px; font-weight: 600; vertical-align: 1px; }

/* ---------------------------------------------------------------- toast */

.ll-toast {
  position: absolute;
  left: 50%;
  bottom: 24px;
  padding: 9px 14px;
  border-radius: var(--sw-radius);
  background: var(--toast-bg, #141b34);
  color: var(--toast-ink, #ffffff);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  box-shadow: 0 10px 30px -8px rgba(20, 27, 52, .5);
  opacity: 0;
  transform: translate(-50%, 8px);
  transition: opacity .18s ease, transform .18s var(--ease);
}
.ll-toast[data-show="true"] { opacity: 1; transform: translate(-50%, 0); }

/* Once toast() has placed it beside the dock it slides in from that side. */
.ll-toast[data-h="r"] { transform: translateX(18px); }
.ll-toast[data-h="l"] { transform: translateX(-18px); }
.ll-toast[data-h][data-show="true"] { transform: none; }

/* ================================================================ designs */

/* Flow: an ivory sheet with a serif voice and a small black capsule at rest. */
.ll[data-skin="flow"] {
  --font-display: var(--serif);
  --title-size: 25px;
  --title-weight: 400;
  --title-track: -.015em;
  --pill-name-size: 19px;
  --surface: #fbfaf4;
  --well: #f1efe5;
  --well-hover: #e8e5d8;
  --ink: #17160f;
  --ink-2: #6a675a;
  --line: #e7e4d8;
  --line-strong: #b9b5a4;
  --accent: #17160f;
  --accent-ink: #fbfaf4;
  --accent-edge: transparent;
  --focus: #6b46e5;
  --track: #e4e1d4;
  --syl-a: #dccbff;
  --syl-b: #cfe9c6;
  --syl-ink: #1f1640;
  --hero-bg: #e6dcff;
  --hero-ink: #1f1640;
  --hero-ink-2: #564a80;
  --hero-sw: #1f1640;
  --hero-sw-thumb: #ffffff;
  --pill-bg: #17160f;
  --pill-ink: #fbfaf4;
  --pill-h: 42px;
  --pill-shadow: 0 10px 28px -8px rgba(23, 22, 15, .45);
  --mark-bg: #dccbff;
  --mark-hi: #17160f;
  --mark-ink: #dccbff;
  --mark-dim: rgba(23, 22, 15, .3);
  --panel-w: 344px;
  --pad: 18px;
  --radius: 26px;
  --radius-ctl: 16px;
  --radius-chip: 8px;
  --divider: 0 solid transparent;
  --row-h: 44px;
  --edge: 0 0 0 1px rgba(23, 22, 15, .07);
  --shadow: var(--edge), 0 30px 60px -20px rgba(23, 22, 15, .3);
  --toast-bg: #17160f;
}
.ll[data-skin="flow"] .ll-pill { --track: rgba(255, 255, 255, .22); --line-strong: transparent; --accent: #dccbff; --accent-ink: #17160f; --thumb: #fbfaf4; }
.ll[data-skin="flow"] .ll-pill .ll-mark, .ll[data-skin="flow"] .ll-head .ll-mark { width: 24px; height: 24px; }
.ll[data-skin="flow"] .ll-head { padding-top: 18px; align-items: flex-start; }
.ll[data-skin="flow"] .ll-head .ll-mark, .ll[data-skin="flow"] .ll-pill .ll-mark { display: none; }
.ll[data-skin="flow"] .ll-pill-main { padding: 0 12px 2px 18px; }
.ll[data-skin="flow"] .ll-hero { padding: 16px; }
.ll[data-skin="flow"] .ll-body { padding-bottom: 6px; }

/* Frost: light glass. The page shows through, softened. */
.ll[data-skin="frost"] {
  --font: var(--system);
  --title-size: 16px;
  --surface: rgba(248, 250, 253, .8);
  --well: rgba(255, 255, 255, .62);
  --well-hover: rgba(255, 255, 255, .86);
  --ink: #0e1a2b;
  --ink-2: #4a5a70;
  --line: rgba(14, 26, 43, .1);
  --line-strong: rgba(14, 26, 43, .34);
  --accent: #1f6feb;
  --accent-ink: #ffffff;
  --accent-edge: transparent;
  --focus: #1f6feb;
  --track: rgba(14, 26, 43, .14);
  --range-fill: #1f6feb;
  --syl-a: #cfe1ff;
  --syl-b: #ffe2bd;
  --syl-ink: #0e1a2b;
  --hero-bg: rgba(31, 111, 235, .13);
  --hero-ink: #0b2a5c;
  --hero-ink-2: #3a5687;
  --hero-edge: rgba(31, 111, 235, .28);
  --hero-off-bg: rgba(255, 255, 255, .5);
  --mark-bg: #1f6feb;
  --mark-hi: #ffffff;
  --mark-ink: #1f6feb;
  --mark-dim: rgba(255, 255, 255, .45);
  --ring-gap: #f1f5fb;
  --radius: 26px;
  --radius-ctl: 14px;
  --divider: 1px solid rgba(14, 26, 43, .08);
  --shadow: inset 0 0 0 1px rgba(255, 255, 255, .7), 0 0 0 1px rgba(14, 26, 43, .08), 0 24px 60px -16px rgba(14, 26, 43, .32);
  --backdrop: blur(28px) saturate(1.9);
  --toast-bg: #0e1a2b;
}

/* Graphite: compact, dark and quiet, with one periwinkle signal. */
.ll[data-skin="graphite"] {
  --title-size: 14px;
  --title-weight: 500;
  --name-weight: 400;
  --surface: #18191d;
  --well: #212329;
  --well-hover: #2a2c34;
  --ink: #edeef2;
  --ink-2: #9a9ca8;
  --line: #2b2d35;
  --line-strong: #555866;
  --accent: #a5b4ff;
  --accent-ink: #14162b;
  --accent-edge: transparent;
  --focus: #a5b4ff;
  --track: #32343d;
  --thumb: #edeef2;
  --range-fill: #a5b4ff;
  --range-thumb: #a5b4ff;
  --syl-a: #a5b4ff;
  --syl-b: #6ee7c8;
  --syl-ink: #14162b;
  --hero-bg: #22253a;
  --hero-ink: #edeef2;
  --hero-ink-2: #a9aed0;
  --hero-edge: #3c4270;
  --mark-bg: #a5b4ff;
  --mark-hi: #14162b;
  --mark-ink: #a5b4ff;
  --mark-dim: rgba(20, 22, 43, .32);
  --tint-edge: rgba(255, 255, 255, .34);
  --panel-w: 324px;
  --pad: 12px;
  --row-h: 40px;
  --pill-h: 40px;
  --radius: 14px;
  --radius-ctl: 8px;
  --radius-chip: 5px;
  --edge: 0 0 0 1px #2e3038;
  --shadow: var(--edge), 0 20px 48px -12px rgba(0, 0, 0, .6);
  --toast-bg: #edeef2;
  --toast-ink: #18191d;
}
.ll[data-skin="graphite"] .ll-mark { width: 24px; height: 24px; }
.ll[data-skin="graphite"] .ll-hero { padding: 10px 12px; }
.ll[data-skin="graphite"] .ll-pill-name { display: none; }
.ll[data-skin="graphite"] .ll-pill-main { padding: 0 10px 0 8px; }
.ll[data-skin="graphite"] .ll-pill { padding-right: 9px; }

/* Sage: soft greens, everything rounded, a calm filled card when the lens is on. */
.ll[data-skin="sage"] {
  --font: var(--atkinson);
  --title-size: 17px;
  --title-weight: 700;
  --title-track: 0;
  --name-weight: 400;
  --surface: #eef2ea;
  --well: #e0e8d9;
  --well-hover: #d5dfcc;
  --ink: #20352a;
  --ink-2: #566b5c;
  --line: #d6dfce;
  --line-strong: #93a593;
  --accent: #2f6b4a;
  --accent-ink: #ffffff;
  --accent-edge: transparent;
  --focus: #2f6b4a;
  --track: #cfd9c7;
  --range-fill: #2f6b4a;
  --range-h: 6px;
  --range-radius: 3px;
  --syl-a: #c4dfc0;
  --syl-b: #f4dfa6;
  --syl-ink: #20352a;
  --hero-bg: #2f6b4a;
  --hero-ink: #ffffff;
  --hero-ink-2: #cfe5d4;
  --hero-sw: #d3e8d2;
  --hero-sw-thumb: #2f6b4a;
  --mark-bg: #2f6b4a;
  --mark-hi: #eef2ea;
  --mark-ink: #2f6b4a;
  --mark-dim: rgba(255, 255, 255, .4);
  --pill-h: 50px;
  --pad: 16px;
  --radius: 30px;
  --radius-ctl: 22px;
  --radius-chip: 999px;
  --divider: 0 solid transparent;
  --edge: 0 0 0 1px rgba(32, 53, 42, .08);
  --shadow: var(--edge), 0 22px 50px -14px rgba(32, 53, 42, .34);
  --toast-bg: #20352a;
}
.ll[data-skin="sage"] .ll-syl { padding: 3px 9px 4px; }
.ll[data-skin="sage"] .ll-hero { padding: 16px 18px; }
.ll[data-skin="sage"] .ll-pill-main { padding-left: 11px; }
.ll[data-skin="sage"] .ll-head { padding-top: 16px; }
.ll[data-skin="sage"] .ll-body > * { margin-bottom: 6px; padding-left: 14px; padding-right: 12px; border-radius: 18px; background: #e4ebdd; }
.ll[data-skin="sage"] .ll-body { padding-bottom: 10px; }
.ll[data-skin="sage"] .ll-hero { margin-bottom: 8px; }
.ll[data-skin="sage"] .ll-seg { background: #d3ddc9; }

/* Blueprint: a drafting sheet. Monospace, ruled grid, square corners. */
.ll[data-skin="blueprint"] {
  --font: var(--mono);
  --title-size: 14px;
  --title-weight: 600;
  --title-track: .02em;
  --name-weight: 400;
  --surface: #0f2a52;
  --well: rgba(143, 220, 255, .08);
  --well-hover: rgba(143, 220, 255, .16);
  --ink: #e6f4ff;
  --ink-2: #9cc3e6;
  --line: rgba(143, 220, 255, .3);
  --line-strong: rgba(143, 220, 255, .7);
  --accent: #8fdcff;
  --accent-ink: #082040;
  --accent-edge: transparent;
  --focus: #ffffff;
  --track: rgba(143, 220, 255, .16);
  --thumb: #e6f4ff;
  --range-fill: #8fdcff;
  --range-h: 2px;
  --range-thumb: #0f2a52;
  --syl-a: #8fdcff;
  --syl-b: #ffffff;
  --syl-ink: #082040;
  --hero-bg: rgba(143, 220, 255, .1);
  --hero-ink: #e6f4ff;
  --hero-ink-2: #9cc3e6;
  --hero-edge: #8fdcff;
  --hero-off-bg: transparent;
  --mark-bg: transparent;
  --mark-hi: #8fdcff;
  --mark-ink: #0f2a52;
  --mark-dim: rgba(143, 220, 255, .5);
  --tint-edge: rgba(255, 255, 255, .5);
  --tint-radius: 2px;
  --pill-radius: 4px;
  --pill-h: 42px;
  --panel-w: 356px;
  --radius: 4px;
  --radius-ctl: 2px;
  --radius-chip: 0;
  --sw-radius: 2px;
  --sw-thumb-radius: 1px;
  --divider: 1px dashed rgba(143, 220, 255, .3);
  --texture: linear-gradient(rgba(143, 220, 255, .07) 1px, transparent 1px), linear-gradient(90deg, rgba(143, 220, 255, .07) 1px, transparent 1px);
  --edge: 0 0 0 1px #8fdcff;
  --shadow: var(--edge), 0 0 0 4px #0f2a52, 0 0 0 5px rgba(143, 220, 255, .45), 0 24px 50px -10px rgba(4, 16, 36, .7);
  --toast-bg: #0f2a52;
  --toast-ink: #e6f4ff;
  font-size: 12px;
}
.ll[data-skin="blueprint"] .ll-pill { box-shadow: 0 0 0 1px #8fdcff, 0 14px 30px -8px rgba(4, 16, 36, .6); }
.ll[data-skin="blueprint"] .ll-name, .ll[data-skin="blueprint"] .ll-sliders label { font-size: 12px; }
.ll[data-skin="blueprint"] .ll-hero-title { font-size: 13px; letter-spacing: .02em; }
.ll[data-skin="blueprint"] .ll-hero-hint, .ll[data-skin="blueprint"] .ll-status { font-size: 11px; }
.ll[data-skin="blueprint"] .ll-syls { font-weight: 600; letter-spacing: 0; }
.ll[data-skin="blueprint"] .ll-toast { box-shadow: 0 0 0 1px #8fdcff; }

/* Pop: thick outlines, hard shadows, a loud pink switch. */
.ll[data-skin="pop"] {
  --title-size: 18px;
  --title-weight: 800;
  --title-track: -.02em;
  --name-weight: 600;
  --surface: #ffffff;
  --well: #f3f3f3;
  --well-hover: #e8e8e8;
  --ink: #111111;
  --ink-2: #4d4d4d;
  --line: #111111;
  --line-strong: #111111;
  --accent: #ff7ab6;
  --accent-ink: #111111;
  --accent-edge: #111111;
  --focus: #2d5bff;
  --track: #ffffff;
  --range-fill: #ff7ab6;
  --range-h: 8px;
  --range-radius: 4px;
  --range-edge: inset 0 0 0 2px #111111;
  --range-thumb-edge: #111111;
  --syl-a: #ffe45c;
  --syl-b: #8ad1ff;
  --syl-ink: #111111;
  --chip-shadow: inset 0 0 0 2px #111111;
  --hero-bg: #ff7ab6;
  --hero-ink: #111111;
  --hero-ink-2: #4a1230;
  --hero-edge: #111111;
  --hero-shadow: 4px 4px 0 #111111;
  --hero-off-bg: #ffffff;
  --hero-sw: #111111;
  --hero-sw-thumb: #ffe45c;
  --mark-bg: #111111;
  --mark-hi: #ff7ab6;
  --mark-ink: #111111;
  --mark-dim: rgba(255, 255, 255, .5);
  --tint-edge: #111111;
  --seg-edge: 2px;
  --pill-h: 48px;
  --pad: 16px;
  --radius: 16px;
  --radius-ctl: 10px;
  --radius-chip: 7px;
  --bw: 2px;
  --divider: 2px solid #111111;
  --shadow: 0 0 0 2px #111111, 6px 6px 0 2px #111111;
  --toast-bg: #111111;
}
.ll[data-skin="pop"] .ll-hero { margin-bottom: 16px; }
.ll[data-skin="pop"] .ll-hero:not([aria-checked="true"]) { box-shadow: inset 0 0 0 2px #111111, 4px 4px 0 #111111; }
.ll[data-skin="pop"] .ll-tint, .ll[data-skin="pop"] .ll-skin { box-shadow: inset 0 0 0 2px #111111; }
.ll[data-skin="pop"] .ll-tint[aria-checked="true"], .ll[data-skin="pop"] .ll-skin[aria-checked="true"] { box-shadow: inset 0 0 0 2px #111111, 3px 3px 0 #111111; transform: translate(-1px, -1px); }
.ll[data-skin="pop"] .ll-syl { padding: 3px 7px 4px; }
.ll[data-skin="pop"] .ll-pill-name { font-size: 15px; }

/* Marigold: the whole dock is the highlighter. Ink does the work. */
.ll[data-skin="marigold"] {
  --title-size: 16px;
  --title-weight: 700;
  --name-weight: 500;
  --surface: #ffc93c;
  --well: rgba(27, 22, 0, .09);
  --well-hover: rgba(27, 22, 0, .16);
  --ink: #1b1600;
  --ink-2: #5c4a00;
  --line: rgba(27, 22, 0, .16);
  --line-strong: rgba(27, 22, 0, .5);
  --accent: #1b1600;
  --accent-ink: #ffc93c;
  --accent-edge: transparent;
  --focus: #1b1600;
  --track: rgba(27, 22, 0, .18);
  --thumb: #fff8dc;
  --range-thumb: #ffc93c;
  --syl-a: #fff8dc;
  --syl-b: #1b1600;
  --syl-ink: #1b1600;
  --hero-bg: #1b1600;
  --hero-ink: #ffc93c;
  --hero-ink-2: #d9b35a;
  --hero-sw: #ffc93c;
  --hero-sw-thumb: #1b1600;
  --mark-bg: #1b1600;
  --mark-hi: #ffc93c;
  --mark-ink: #1b1600;
  --mark-dim: rgba(255, 201, 60, .4);
  --tint-edge: rgba(27, 22, 0, .55);
  --radius: 22px;
  --radius-ctl: 14px;
  --edge: 0 0 0 1px rgba(27, 22, 0, .2);
  --shadow: var(--edge), 0 20px 46px -12px rgba(90, 64, 0, .5);
  --toast-bg: #1b1600;
  --toast-ink: #ffc93c;
}
.ll[data-skin="marigold"] .ll-syl:nth-child(4n + 3) { color: #ffc93c; }

/* Plum: deep violet with a peach signal and an italic serif title. */
.ll[data-skin="plum"] {
  --font-display: var(--serif);
  --title-size: 24px;
  --title-weight: 400;
  --title-style: italic;
  --title-track: 0;
  --pill-name-size: 19px;
  --name-weight: 400;
  --surface: #2a1f5c;
  --well: rgba(255, 255, 255, .07);
  --well-hover: rgba(255, 255, 255, .13);
  --ink: #f4efff;
  --ink-2: #b9addf;
  --line: rgba(255, 255, 255, .12);
  --line-strong: rgba(255, 255, 255, .4);
  --accent: #ffb59e;
  --accent-ink: #3a1420;
  --accent-edge: transparent;
  --focus: #ffb59e;
  --track: rgba(255, 255, 255, .16);
  --thumb: #f4efff;
  --range-fill: #ffb59e;
  --range-thumb: #ffb59e;
  --syl-a: #ffb59e;
  --syl-b: #c9b8ff;
  --syl-ink: #2a1238;
  --hero-bg: #3b2c7d;
  --hero-ink: #f4efff;
  --hero-ink-2: #c4b8ea;
  --hero-edge: rgba(255, 181, 158, .5);
  --mark-bg: #ffb59e;
  --mark-hi: #2a1f5c;
  --mark-ink: #ffb59e;
  --mark-dim: rgba(42, 31, 92, .3);
  --tint-edge: rgba(255, 255, 255, .4);
  --pad: 18px;
  --radius: 24px;
  --radius-ctl: 14px;
  --radius-chip: 8px;
  --edge: 0 0 0 1px rgba(255, 255, 255, .1);
  --shadow: inset 0 1px 0 rgba(255, 255, 255, .12), var(--edge), 0 26px 60px -16px rgba(20, 10, 60, .75);
  --toast-bg: #f4efff;
  --toast-ink: #2a1f5c;
}
.ll[data-skin="plum"] .ll-head { position: relative; flex-direction: column; gap: 8px; padding: 22px var(--pad) 16px; text-align: center; }
.ll[data-skin="plum"] .ll-head-text { align-items: center; gap: 2px; }
.ll[data-skin="plum"] .ll-head .ll-mark { width: 34px; height: 34px; }
.ll[data-skin="plum"] .ll-head .ll-icon-btn { position: absolute; top: 10px; right: 10px; }
.ll[data-skin="plum"] .ll-sample { justify-content: center; }
.ll[data-skin="plum"] .ll-sample-label { width: 100%; text-align: center; }

/* High contrast: maximum legibility, no translucency, thick edges. */
.ll[data-skin="contrast"] {
  --font: var(--atkinson);
  --title-size: 17px;
  --title-weight: 700;
  --title-track: 0;
  --name-weight: 700;
  --surface: #000000;
  --well: #000000;
  --well-hover: #1f1f1f;
  --ink: #ffffff;
  --ink-2: #ffffff;
  --line: #ffffff;
  --line-strong: #ffffff;
  --accent: #ffe600;
  --accent-ink: #000000;
  --accent-edge: #ffe600;
  --focus: #ffe600;
  --track: #000000;
  --range-fill: #ffe600;
  --range-h: 6px;
  --range-edge: 0 0 0 1px #ffffff;
  --range-thumb-edge: #000000;
  --syl-a: #ffe600;
  --syl-b: #ffffff;
  --syl-ink: #000000;
  --hero-bg: #000000;
  --hero-ink: #ffe600;
  --hero-ink-2: #ffffff;
  --hero-edge: #ffe600;
  --hero-off-bg: #000000;
  --mark-bg: #ffe600;
  --mark-hi: #000000;
  --mark-ink: #ffe600;
  --mark-dim: rgba(0, 0, 0, .45);
  --tint-edge: #ffffff;
  --radius: 8px;
  --radius-ctl: 5px;
  --radius-chip: 3px;
  --bw: 2px;
  --shadow: 0 0 0 2px #ffffff, 0 0 0 4px #000000;
  --toast-bg: #000000;
  font-size: 14px;
}
.ll[data-skin="contrast"] .ll-name, .ll[data-skin="contrast"] .ll-sliders label { font-size: 14px; }
.ll[data-skin="contrast"] .ll-hint, .ll[data-skin="contrast"] .ll-hero-hint, .ll[data-skin="contrast"] .ll-status, .ll[data-skin="contrast"] .ll-value, .ll[data-skin="contrast"] .ll-sample-label, .ll[data-skin="contrast"] .ll-skin-name { font-size: 13px; }
.ll[data-skin="contrast"] .ll-toast { box-shadow: 0 0 0 2px #ffffff; }

/* ================================================================ motion */
/* Sage motion, chosen from demo/motion-lab.html. Only how things move:
   every rule here can be deleted to get the plain fades above back. */

/* Switch: the leading edge of the thumb moves first and the back catches up. */
.ll[data-skin="sage"] .ll-switch::after {
  width: auto;
  right: 21px;
  transition: left .14s ease-out, right .22s ease-out .07s, background-color .15s ease;
}
.ll[data-skin="sage"] .ll-switch[aria-checked="true"]::after,
.ll[data-skin="sage"] [aria-checked="true"] > .ll-switch::after {
  transform: none;
  left: 21px;
  right: 3px;
  transition: right .14s ease-out, left .22s ease-out .07s, background-color .15s ease;
}

/* Pill to panel: the pill outline widens into the panel and folds back into
   the same corner. The open clip reaches 70px past the panel so its shadow
   is not cut off. --pill-w is measured in setOpen. */
.ll[data-skin="sage"] .ll-pill { transition: opacity .12s ease .2s, scale .16s var(--ease), box-shadow .16s ease, visibility 0s; }
.ll[data-skin="sage"] .ll-dock[data-open="true"] .ll-pill { transform: none; transition: opacity .1s ease, visibility 0s linear .1s; }
.ll[data-skin="sage"] .ll-panel {
  clip-path: inset(-70px round var(--radius));
  transition: clip-path .36s var(--ease), opacity .1s ease, visibility 0s;
}
.ll[data-skin="sage"] .ll-dock[data-open="false"] .ll-panel {
  --fold-x: calc(100% - var(--pill-w, 124px));
  --fold-y: calc(100% - var(--pill-h));
  transform: none;
  clip-path: inset(var(--fold-y) 0 0 var(--fold-x) round calc(var(--pill-h) / 2));
  transition: clip-path .26s var(--ease), opacity .1s ease .18s, visibility 0s linear .28s;
}
.ll[data-skin="sage"] .ll-dock[data-open="false"][data-h="l"][data-v="b"] .ll-panel { clip-path: inset(var(--fold-y) var(--fold-x) 0 0 round calc(var(--pill-h) / 2)); }
.ll[data-skin="sage"] .ll-dock[data-open="false"][data-h="r"][data-v="t"] .ll-panel { clip-path: inset(0 0 var(--fold-y) var(--fold-x) round calc(var(--pill-h) / 2)); }
.ll[data-skin="sage"] .ll-dock[data-open="false"][data-h="l"][data-v="t"] .ll-panel { clip-path: inset(0 var(--fold-x) var(--fold-y) 0 round calc(var(--pill-h) / 2)); }
@keyframes ll-fade-in { from { opacity: 0; } }
.ll[data-skin="sage"] .ll-dock[data-open="true"] .ll-panel > * { animation: ll-fade-in .2s ease .14s backwards; }
.ll[data-skin="sage"] .ll-dock[data-open="false"] .ll-panel > * { opacity: 0; transition: opacity .08s ease; }

/* Edge mark: the collapsed dock is the logo itself, five bare strokes flush on
   the side of the screen. No box, no label, no switch: pressing it opens the
   panel. When the lens is off the strokes draw back and the accent goes grey. */
.ll[data-skin="sage"] .ll-pill { height: auto; padding: 0; border-radius: 0; background: none; box-shadow: none; -webkit-backdrop-filter: none; backdrop-filter: none; }
.ll[data-skin="sage"] .ll-dock[data-h="r"]:not([data-dragging="true"]) .ll-pill { right: calc(-1 * var(--dock-x, 20px)); }
.ll[data-skin="sage"] .ll-dock[data-h="l"]:not([data-dragging="true"]) .ll-pill { left: calc(-1 * var(--dock-x, 20px)); }
.ll[data-skin="sage"] .ll-dock[data-dragging="true"] .ll-pill { scale: 1.08; box-shadow: none; }
.ll[data-skin="sage"] .ll-pill-main { display: block; height: auto; padding: 10px 0 10px 14px; border-radius: 10px 0 0 10px; cursor: pointer; }
.ll[data-skin="sage"] .ll-dock[data-h="l"] .ll-pill-main { padding: 10px 14px 10px 0; border-radius: 0 10px 10px 0; }
.ll-strokes { display: grid; gap: 4px; justify-items: end; opacity: .78; translate: 5px 0; transition: opacity .16s ease, translate .2s var(--ease); }
.ll-dock[data-h="l"] .ll-strokes { justify-items: start; translate: -5px 0; }
.ll-pill:hover .ll-strokes, .ll-pill-main:focus-visible .ll-strokes { opacity: 1; translate: 0 0; }
.ll-strokes i { display: block; height: 5px; width: 12px; border-radius: 2.5px; background: var(--ink); opacity: .5; transform-origin: right center; transition: transform .22s var(--ease), background-color .15s ease, opacity .15s ease; }
.ll-dock[data-h="l"] .ll-strokes i { transform-origin: left center; }
.ll-strokes i:nth-child(2), .ll-strokes i:nth-child(4) { width: 22px; }
.ll-strokes i:nth-child(3) { width: 34px; background: var(--accent); opacity: 1; }
.ll-pill[data-on="false"] .ll-strokes i { transform: scaleX(.5); }
.ll-pill[data-on="false"] .ll-strokes i:nth-child(3) { background: var(--ink); opacity: .5; }

/* Dragging the pill: it lifts while it is held. */
.ll[data-skin="sage"] .ll-dock[data-dragging="true"] .ll-pill { scale: 1.05; box-shadow: 0 30px 54px -12px rgba(32, 53, 42, .45); }

/* Hover lens: grows out of the word it explains (--ox is set in positionTip). */
.ll[data-skin="sage"] .ll-tip {
  transform-origin: var(--ox, 50%) 100%;
  transform: scale(.9) translateY(6px);
  transition: opacity .12s ease, transform .26s cubic-bezier(.3, 1.4, .5, 1);
}
.ll[data-skin="sage"] .ll-tip[data-side="below"] { transform-origin: var(--ox, 50%) 0; transform: scale(.9) translateY(-6px); }
.ll[data-skin="sage"] .ll-tip[data-show="true"] { transform: none; }

/* Sound it out: the other chunks fade back and the spoken one grows a
   little. The letters stay where they are. */
.ll[data-skin="sage"] .ll-part { transition: transform .12s var(--ease), box-shadow .2s ease, opacity .18s ease; }
.ll[data-skin="sage"] .ll-tip:has(.ll-part[data-now="true"]) .ll-part:not([data-now="true"]) { opacity: .4; }
.ll[data-skin="sage"] .ll-part[data-now="true"] { transform: scale(1.08); }
.ll[data-skin="sage"] .ll-part[data-now="true"]:not(:focus-visible) { box-shadow: none; }

/* Focus: the outline, plus a soft halo that shows on dark pages too. --fs
   carries a control's own edge so the halo does not replace it. */
.ll[data-skin="sage"] { --halo: 0 0 0 7px rgba(127, 199, 154, .38); }
.ll[data-skin="sage"] .ll-switch { --fs: inset 0 0 0 var(--bw) var(--line-strong); }
.ll[data-skin="sage"] .ll-switch[aria-checked="true"] { --fs: inset 0 0 0 1.5px var(--accent-edge); }
.ll[data-skin="sage"] .ll-btn { --fs: inset 0 0 0 var(--bw) var(--accent-edge); }
.ll[data-skin="sage"] .ll-say-btn[data-say="slow"] { --fs: inset 0 0 0 1px var(--line-strong, var(--line)); }
.ll[data-skin="sage"] :is(.ll-icon-btn, .ll-pill-main, .ll-btn) { transition: background-color .12s ease, color .12s ease, opacity .12s ease, box-shadow .2s ease; }
.ll[data-skin="sage"] button:focus-visible { box-shadow: var(--fs, 0 0 0 0 transparent), var(--halo); }
/* The edge mark shows keyboard focus with a crisp outline, not the soft halo. */
.ll[data-skin="sage"] .ll-pill-main:focus-visible { box-shadow: none; outline: 2px solid var(--accent); outline-offset: 2px; }
.ll[data-skin="sage"] .ll-range:focus-visible::-webkit-slider-thumb { box-shadow: 0 1px 2px rgba(16, 17, 21, .2), var(--halo); }

/* Header icon buttons sit close together. */
.ll-head .ll-icon-btn + .ll-icon-btn { margin-left: -8px; }

/* --------------------------------------------------- hover lens: meta row */

/* How hard the word is to read, then how common it is (CEFR, small), save on the right; why below. */
.ll-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 28px; margin: -3px -3px 8px 0; }
.ll-meta .ll-save { margin-left: auto; }
.ll-diff {
  display: inline-flex; align-items: center; gap: 6px;
  height: 24px; padding: 0 10px 0 8px; border-radius: 999px;
  background: var(--well); color: var(--ink-2);
  font-size: 12px; font-weight: 600; line-height: 1; white-space: nowrap; cursor: default;
}
.ll-diff::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--df, var(--line-strong)); flex: none; }
.ll-diff b { color: var(--ink); font-size: 13px; }
.ll-diff[data-band="easy"] { --df: #4f9a6b; }
.ll-diff[data-band="medium"] { --df: #d29a1e; }
.ll-diff[data-band="hard"] { --df: #c4542f; }
.ll-level {
  display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 6px;
  box-shadow: inset 0 0 0 1px var(--line-strong, var(--line)); color: var(--ink-2);
  font-size: 11px; font-weight: 600; letter-spacing: .04em; line-height: 1; cursor: default;
}
.ll-diff[hidden], .ll-level[hidden], .ll-why[hidden] { display: none; }
.ll-why { flex-basis: 100%; margin: 0; padding-left: 2px; color: var(--ink-2); font-size: 12px; line-height: 1.3; }

/* Word parts: a small badge over the chips a prefix, root or suffix covers. */
[data-chips][data-tagged] { position: relative; padding-top: 19px; }
.ll-tag {
  position: absolute; top: 0; height: 16px; padding: 0 4px; min-width: 34px;
  display: flex; align-items: flex-start; justify-content: center;
  border-radius: 5px 5px 0 0; border-bottom: 2px solid var(--kd);
  background: transparent; color: var(--kd);
  font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; line-height: 13px; cursor: pointer;
}
.ll-tag:hover, .ll-tag[aria-expanded="true"] { background: color-mix(in srgb, var(--kd) 14%, transparent); }
.ll-tag:focus-visible, .ll-wpart:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
[data-kind="p"] { --kd: #2f6b9a; }
[data-kind="r"] { --kd: #9a5bb5; }
[data-kind="s"] { --kd: #b0571f; }
[data-kind="w"] { --kd: #2f6b4a; }
.ll-part[data-inpart="true"], .ll-syl[data-inpart="true"] { box-shadow: 0 0 0 2px var(--kd-on, var(--ink)); }
/* When the parts do not line up with the syllables: a row of them instead. */
.ll-wparts { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 5px; margin-top: 8px; }
.ll-wparts[hidden] { display: none; }
.ll-wparts-label { margin-right: 2px; color: var(--ink-2); font-size: 11.5px; font-weight: 600; }
.ll-wpart {
  display: inline-flex; flex-direction: column; align-items: center; gap: 0; padding: 3px 8px 4px; border-radius: 8px;
  box-shadow: inset 0 0 0 1.5px var(--kd); color: var(--ink); cursor: pointer; line-height: 1.15;
}
.ll-wpart b { font-size: 14px; font-weight: 600; }
.ll-wpart small { color: var(--kd); font-size: 9.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.ll-wpart:hover, .ll-wpart[aria-expanded="true"] { background: color-mix(in srgb, var(--kd) 14%, transparent); }
.ll-plus { color: var(--ink-2); font-size: 12px; }
.ll-partinfo { margin-top: 8px; padding: 8px 10px; border-radius: 10px; background: var(--well); font-size: 13px; line-height: 1.4; }
.ll-partinfo[hidden] { display: none; }
.ll-pi-label { font-size: 14px; margin-right: 7px; }
.ll-pi-kind { color: var(--kd); font-size: 10.5px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
.ll-partinfo p { margin: 3px 0 0; }

/* The meaning (WordNet), and "Explain simply" from Claude. */
.ll-def { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line); max-height: 210px; overflow: auto; font-size: 13px; line-height: 1.45; }
.ll-def[hidden] { display: none; }
.ll-senses { margin: 0; padding-left: 18px; display: grid; gap: 5px; }
.ll-senses i { color: var(--ink-2); font-size: 12px; }
.ll-senses q { display: block; margin-top: 2px; color: var(--ink-2); font-style: italic; }
.ll-def-as, .ll-def-src, .ll-def-wait, .ll-def-none, .ll-pi-wait { margin: 0; color: var(--ink-2); font-size: 12px; }
.ll-def-as { margin-bottom: 4px; }
.ll-def-src { margin-top: 6px; font-size: 11px; opacity: .8; }
.ll-explain { margin-top: 8px; }
.ll-explain-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px 0 9px; border-radius: 999px;
  background: var(--well); color: var(--ink); box-shadow: inset 0 0 0 1px var(--line-strong, var(--line));
  font-size: 12.5px; font-weight: 600; cursor: pointer;
}
.ll-explain-btn svg { width: 15px; height: 15px; }
.ll-explain-btn:disabled { opacity: .7; cursor: progress; }
.ll-explained { margin: 0; padding: 8px 10px; border-radius: 10px; background: var(--well); }
.ll-explained b { display: block; margin-bottom: 2px; color: var(--ink-2); font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
.ll-say-btn[data-act="define"] { background: var(--well); color: var(--ink); box-shadow: inset 0 0 0 1px var(--line-strong, var(--line)); }
.ll-say-btn[data-act="define"][aria-expanded="true"] { background: var(--ink); color: var(--surface); box-shadow: none; }
.ll-save {
  display: grid; place-items: center; flex: none;
  width: 30px; height: 30px; border-radius: 999px;
  color: var(--ink-2); cursor: pointer;
  transition: background-color .12s ease, color .12s ease, transform .12s var(--ease);
}
.ll-save svg { width: 17px; height: 17px; }
.ll-save:hover { background: var(--well); color: var(--ink); }
.ll-save[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
.ll-save[aria-pressed="true"] svg { fill: currentColor; }
.ll-save:active { transform: scale(.92); }
.ll-save:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

/* ------------------------------------------------- tucked into the edge */

/* A slim tab flush with the screen edge; it brightens on hover. The lens dot
   shows whether the reading lens is on. The panel opens from the edge. */
.ll .ll-dock[data-mode="edge"] .ll-pill {
  flex-direction: column; justify-content: center;
  width: 30px; height: auto; padding: 10px 0;
  border-radius: 14px 0 0 14px;
  box-shadow: 0 0 0 1px rgba(32, 53, 42, .08), 0 8px 22px -10px rgba(32, 53, 42, .35);
}
.ll .ll-dock[data-mode="edge"][data-h="l"] .ll-pill { border-radius: 0 14px 14px 0; }
.ll .ll-dock[data-mode="edge"][data-open="false"] .ll-pill { opacity: .55; }
.ll .ll-dock[data-mode="edge"][data-open="false"] .ll-pill:is(:hover, :focus-within) { opacity: 1; }
.ll .ll-dock[data-mode="edge"] .ll-pill .ll-switch { display: none; }
.ll .ll-dock[data-mode="edge"] .ll-pill-main {
  flex-direction: row; gap: 8px; width: 100%; height: auto; padding: 4px 0; border-radius: 10px; /* row runs down the tab in vertical writing */
  writing-mode: vertical-rl; transform: rotate(180deg);
}
.ll .ll-dock[data-mode="edge"][data-h="l"] .ll-pill-main { transform: none; }
.ll .ll-dock[data-mode="edge"] .ll-pill-name { font-size: 13px; letter-spacing: .04em; }
.ll .ll-dock[data-mode="edge"] .ll-pill-main::after {
  content: ""; width: 7px; height: 7px; border-radius: 50%; flex: none;
  background: var(--line-strong); box-shadow: 0 0 0 2px var(--surface);
}
.ll[data-lens="on"] .ll-dock[data-mode="edge"] .ll-pill-main::after { background: var(--accent); }
.ll .ll-dock[data-mode="edge"][data-h="r"] > .ll-panel { right: 8px; }
.ll .ll-dock[data-mode="edge"][data-h="l"] > .ll-panel { left: 8px; }
/* Sage folds the panel back into the pill; at the edge it slides into the side instead. */
.ll[data-skin="sage"] .ll-dock[data-mode="edge"][data-open="false"][data-h="r"] .ll-panel { clip-path: inset(0 0 0 100% round var(--radius)); }
.ll[data-skin="sage"] .ll-dock[data-mode="edge"][data-open="false"][data-h="l"] .ll-panel { clip-path: inset(0 100% 0 0 round var(--radius)); }

/* Sage, larger and stronger: bigger type and controls, lighter cards so each row stands off the panel, values in
   their own chip. The status line under the name is kept for screen readers only. */
.ll[data-skin="sage"] { --panel-w: 380px; --ink-2: #44584a; --title-size: 19px; --row-h: 60px; --range-h: 8px; --range-radius: 4px; --radius: 26px; }
.ll[data-skin="sage"] .ll-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.ll[data-skin="sage"] .ll-head { padding-top: 14px; padding-bottom: 12px; }
.ll[data-skin="sage"] .ll-body > * { margin-bottom: 8px; background: #f8faf5; }
.ll[data-skin="sage"] .ll-sliders { grid-template-columns: auto 1fr auto; row-gap: 4px; padding-top: 10px; padding-bottom: 10px; }
.ll[data-skin="sage"] .ll-sliders label, .ll[data-skin="sage"] .ll-name { font-size: 15px; font-weight: 700; }
.ll[data-skin="sage"] .ll-hint { font-size: 13.5px; }
.ll[data-skin="sage"] .ll-value { min-width: 54px; padding: 2px 8px; border-radius: 8px; background: var(--well); color: var(--ink); font-size: 14px; font-weight: 700; text-align: center; }
.ll[data-skin="sage"] .ll-gaze-status { font-size: 13.5px; }
.ll[data-skin="sage"] .ll-switch { width: 50px; height: 28px; }
/* The switch thumb simply slides across: no stretch. */
.ll[data-skin="sage"] .ll-switch::after { width: 22px; height: 22px; left: 3px; right: auto; transition: transform .16s ease, background-color .16s ease; }
.ll[data-skin="sage"] .ll-switch[aria-checked="true"]::after,
.ll[data-skin="sage"] [aria-checked="true"] > .ll-switch::after { left: 3px; right: auto; transform: translateX(22px); transition: transform .16s ease, background-color .16s ease; }
.ll[data-skin="sage"] .ll-range::-webkit-slider-thumb { width: 22px; height: 22px; margin-top: calc((var(--range-h, 4px) - 22px) / 2); }
.ll[data-skin="sage"] .ll-tip { max-width: min(400px, calc(100vw - 16px)); padding: 14px; border-radius: 18px; }
/* How hard the word is: a solid chip in the band's colour that says only "Easy", "Medium" or "Hard". */
.ll[data-skin="sage"] .ll-diff { height: 28px; padding: 0 13px; font-size: 14px; background: var(--df, var(--well)); color: var(--df-ink, #ffffff); }
.ll[data-skin="sage"] .ll-diff::before { display: none; }
.ll[data-skin="sage"] .ll-diff b { font-size: 15px; color: inherit; }
.ll[data-skin="sage"] .ll-diff[data-band="medium"] { --df-ink: #2b2204; }
.ll[data-skin="sage"] .ll-why { font-size: 14px; }
.ll[data-skin="sage"] .ll-part { min-width: 48px; padding: 8px 12px 9px; }
.ll[data-skin="sage"] .ll-part-letters { font-size: 20px; }
.ll[data-skin="sage"] .ll-part-sound { font-size: 14.5px; }
.ll[data-skin="sage"] .ll-say-btn { height: 40px; font-size: 15px; }

@media (prefers-reduced-motion: reduce) {
  .ll *, .ll *::before, .ll *::after { transition-duration: 0s !important; animation: none !important; }
}
`;

  /* =====================================================================
   * Dock markup
   * ===================================================================== */

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const switchRow = (key, name, hint) => `
    <div class="ll-row">
      <div class="ll-row-text">
        <span class="ll-name" id="ll-n-${key}">${name}</span>
        <span class="ll-hint" id="ll-h-${key}">${hint}</span>
      </div>
      <button type="button" class="ll-switch" role="switch" aria-checked="false" data-toggle="${key}" aria-labelledby="ll-n-${key}" aria-describedby="ll-h-${key}"></button>
    </div>`;

  const rangeRow = (key, label) => {
    const r = RANGES[key];
    return `
      <label for="ll-r-${key}">${label}</label>
      <input class="ll-range" id="ll-r-${key}" type="range" min="${r.min}" max="${r.max}" step="${r.step}" data-range="${key}">
      <output class="ll-value" data-value="${key}" for="ll-r-${key}"></output>`;
  };

  const DOCK_HTML = `
<div class="ll" data-skin="sage">
  <div class="ll-dock" data-open="false" data-h="r" data-v="b">
    <div class="ll-pill">
      <button type="button" class="ll-pill-main" aria-expanded="false" aria-label="${APP_NAME}. Open the panel" title="Open ${APP_NAME}">
        <span class="ll-strokes" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
      </button>
    </div>

    <section class="ll-panel" role="dialog" aria-label="${APP_NAME}" inert>
      <header class="ll-head" data-drag>
        <div class="ll-head-text">
          <span class="ll-title">${APP_NAME}</span>
          <span class="ll-status" aria-live="polite"></span>
        </div>
        <button type="button" class="ll-switch" role="switch" aria-checked="false" data-toggle="on" aria-label="Reading lens" title="Turn the reading lens on or off"></button>
        <button type="button" class="ll-icon-btn" data-action="collapse" aria-label="Minimise the panel" title="Minimise (Esc)">${ICON.minimise}</button>
      </header>

      <div class="ll-body" data-on="false">
        <div class="ll-sliders">
          ${rangeRow('fontSize', 'Size')}
          ${rangeRow('letterSpacing', 'Letters')}
          ${rangeRow('wordSpacing', 'Words')}
          ${rangeRow('lineHeight', 'Lines')}
        </div>
        ${switchRow('mirror', 'Colour b d p q', 'Tell mirrored letters apart')}
        ${switchRow('font', 'Hyperlegible font', 'Atkinson Hyperlegible for body text')}
        <div class="ll-gaze" hidden>
          ${switchRow('gaze', 'Adaptive', 'Learns from your eyes and sets the page out to suit you')}
          <div class="ll-gaze-line" hidden>
            <p class="ll-gaze-status" aria-live="polite" hidden></p>
            <button type="button" class="ll-btn" data-action="gaze-calibrate" hidden>Calibrate</button>
          </div>
          <div class="ll-sliders ll-gaze-sliders" hidden>
            ${rangeRow('gazeSensitivity', 'Help')}
          </div>
          <div class="ll-gaze-original" hidden>
            ${switchRow('seeOriginal', 'See original', 'A small mark at the end of text Glider has changed')}
            ${switchRow('gazeTrace', 'Show tracking', 'Temporary: heat where Glider thinks you are looking')}
          </div>
        </div>
      </div>

    </section>
  </div>

  <div class="ll-tip" role="tooltip" hidden></div>
  <div class="ll-toast" role="status" aria-live="polite"></div>
</div>`;

  /* =====================================================================
   * App
   * ===================================================================== */

  class App {
    constructor() {
      this.state = { ...DEFAULTS };
      this.dockPos = { h: 'r', v: 'b', x: 20, y: 20 };
      this.open = false;
      this.applied = {};
      this.lastCommand = new Map();
      this.htmlBgPatched = false;

      this.engine = new LL.DomEngine();
      this.tip = { token: null, pinned: false, showTimer: 0, hideTimer: 0 };
      this.ready = false;
      this.dead = false;
      this.queuedCommands = [];
      this.ownWrites = new Set();
      this.wantedClasses = [];

      // Eye tracking (GazeReader is absent on pages that do not load it).
      this.gaze = null;
      this.gazeOff = [];                                 // unsubscribe functions
      this.gazeApplied = { wanted: false, mult: null };  // what GazeReader was last told
    }

    async init() {
      this.loadFonts();
      this.buildDock();
      this.bindMessages(); // before any await, so early shortcut presses are not lost
      document.addEventListener(TAKEOVER, () => this.destroy(), { once: true });

      const [savedSettings, savedDock, savedWords] = await Promise.all([storage.get(SETTINGS_KEY), storage.get(DOCK_KEY), storage.get(WORDS_KEY)]);
      this.state = sanitize(savedSettings);
      this.setWords(savedWords);
      if (savedDock && typeof savedDock === 'object') {
        this.dockPos = {
          h: savedDock.h === 'l' ? 'l' : 'r',
          v: savedDock.v === 't' ? 't' : 'b',
          x: Math.max(8, Number(savedDock.x) || 20),
          y: Math.max(8, Number(savedDock.y) || 20),
        };
      } else {
        // First run: the edge mark starts a little above the middle of the right side.
        this.dockPos.y = Math.max(20, Math.round(window.innerHeight * 0.4));
      }

      this.bindGaze();
      this.placeDock();
      this.apply();
      this.keepInView();
      this.bindPage();

      storage.onChange(SETTINGS_KEY, (value) => {
        if (this.dead) return;
        // Ignore the echo of our own writes: a late echo must never undo a
        // newer local change (for example mid slider drag).
        const json = JSON.stringify(value);
        if (this.ownWrites.delete(json)) return;
        const next = sanitize(value);
        if (JSON.stringify(next) === JSON.stringify(this.state)) return;
        this.state = next;
        this.apply();
      });
      storage.onChange(WORDS_KEY, (value) => {
        if (this.dead) return;
        this.setWords(value);
        this.renderSaveButton();
      });
      storage.onChange(DOCK_KEY, (value) => {
        if (this.dead || !value || this.drag) return;
        this.dockPos = { ...this.dockPos, ...value };
        this.placeDock();
        this.keepInView();
      });

      this.ready = true;
      for (const name of this.queuedCommands.splice(0)) this.command(name);
    }

    /** Stand down completely (a newer copy of the extension took over). */
    destroy() {
      if (this.dead) return;
      this.dead = true;
      try { this.unbindGaze(); } catch (_) { /* best effort */ }
      try {
        this.engine.setFeatures({});
        this.engine.restoreAll();
        if (this.pageObserver) this.pageObserver.disconnect();
        this.host.remove();
      } catch (_) { /* best effort */ }
    }

    bindMessages() {
      if (!IN_EXTENSION) return;
      try {
        chrome.runtime.onMessage.addListener((message, _sender, respond) => {
          if (this.dead || !message || typeof message.type !== 'string') return;
          if (message.type === 'glider:command') {
            if (this.ready) this.command(message.command);
            else this.queuedCommands.push(message.command);
            respond({ ok: true });
          } else if (message.type === 'glider:ping') {
            respond({ ok: true });
          } else if (message.type === 'gaze:calibrate') { // the popup's Calibrate button
            if (this.ready) this.calibrateGaze();
            respond({ ok: true });
          }
        });
      } catch (_) { /* extension context already gone */ }
    }

    /* ----------------------------------------------------------- settings */

    /** Change settings from the dock or a shortcut. */
    update(patch) {
      if (this.dead) return;
      this.state = sanitize({ ...this.state, ...patch });
      this.apply();
      const json = JSON.stringify(this.state);
      if (this.ownWrites.size > 40) this.ownWrites.clear();
      this.ownWrites.add(json);
      storage.set(SETTINGS_KEY, this.state);
    }

    /* -------------------------------------------------------------- apply */

    /** Push the current settings into the page. Safe to call any time. */
    apply() {
      const s = this.state;
      const on = s.on;
      const html = document.documentElement;

      const classes = {
        'glider-spacing': on,
        'glider-bionic': on,
        'glider-syllables': on,
        'glider-font': on && s.font,
        'glider-size': on && s.fontSize !== 100,
      };
      for (const [name, wanted] of Object.entries(classes)) html.classList.toggle(name, wanted);
      this.wantedClasses = Object.keys(classes).filter((name) => classes[name]);

      if (on && s.fontSize !== 100) html.style.setProperty('--glider-font-scale', String(s.fontSize / 100));
      else html.style.removeProperty('--glider-font-scale');

      if (on) {
        html.style.setProperty('--glider-letter-spacing', `${s.letterSpacing}px`);
        html.style.setProperty('--glider-word-spacing', `${s.wordSpacing}px`);
        html.style.setProperty('--glider-line-height', String(s.lineHeight));
      } else {
        html.style.removeProperty('--glider-letter-spacing');
        html.style.removeProperty('--glider-word-spacing');
        html.style.removeProperty('--glider-line-height');
      }

      // Adapt ahead (adapt/adapt.js) sets text out before the lens wraps its words.
      if (globalThis.GliderAdapt) globalThis.GliderAdapt.setHost({ lensOn: on, adaptive: on && s.gaze, control: s.seeOriginal });

      // With every feature off the engine puts the original text nodes back.
      this.engine.setFeatures({ bionic: on, homophones: on, syllables: on, mirror: on && s.mirror });
      if (!on) this.hideTip(true);

      this.applyGaze();

      this.host.style.display = s.dockVisible ? '' : 'none';
      this.renderDock();
    }

    loadFonts() {
      if (typeof FontFace !== 'function' || !document.fonts) return;
      const faces = [
        ['Glider Lexend', 'fonts/Lexend-Variable.woff2', { weight: '100 900', style: 'normal' }],
        ['Glider Atkinson', 'fonts/AtkinsonHyperlegible-Regular.woff2', { weight: '400', style: 'normal' }],
        ['Glider Atkinson', 'fonts/AtkinsonHyperlegible-Bold.woff2', { weight: '700', style: 'normal' }],
        ['Glider Atkinson', 'fonts/AtkinsonHyperlegible-Italic.woff2', { weight: '400', style: 'italic' }],
        ['Glider Serif', 'fonts/InstrumentSerif-Regular.woff2', { weight: '400', style: 'normal' }],
        ['Glider Serif', 'fonts/InstrumentSerif-Italic.woff2', { weight: '400', style: 'italic' }],
        ['Glider Mono', 'fonts/JetBrainsMono-Variable.woff2', { weight: '100 800', style: 'normal' }],
      ];
      for (const [family, path, descriptors] of faces) {
        try {
          const face = new FontFace(family, `url("${assetURL(path)}") format("woff2")`, { ...descriptors, display: 'swap' });
          document.fonts.add(face);
        } catch (_) { /* the system font stack takes over */ }
      }
    }

    /* --------------------------------------------------------------- dock */

    buildDock() {
      const host = document.createElement('div');
      host.id = 'glider-root';
      host.setAttribute('data-glider-ignore', '');
      host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
      const shadow = host.attachShadow({ mode: 'open' });

      // A constructable stylesheet is not subject to the host page's CSP.
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(DOCK_CSS);
        shadow.adoptedStyleSheets = [sheet];
      } catch (_) {
        const style = document.createElement('style');
        style.textContent = DOCK_CSS;
        shadow.appendChild(style);
      }
      const template = document.createElement('template');
      template.innerHTML = DOCK_HTML;
      shadow.appendChild(template.content);

      this.host = host;
      this.shadow = shadow;
      this.root = shadow.querySelector('.ll');
      this.dock = shadow.querySelector('.ll-dock');
      this.pill = shadow.querySelector('.ll-pill');
      this.pillMain = shadow.querySelector('.ll-pill-main');
      this.panel = shadow.querySelector('.ll-panel');
      this.tipEl = shadow.querySelector('.ll-tip');
      this.toastEl = shadow.querySelector('.ll-toast');
      this.shadow = shadow;
      this.$ = (selector) => shadow.querySelector(selector);
      this.$$ = (selector) => Array.from(shadow.querySelectorAll(selector));

      this.bindDock();
      document.documentElement.appendChild(host);

      // Some single-page apps replace <body>/<html> children wholesale, and
      // theme scripts sometimes overwrite <html class>. Put back what is
      // missing (only what is missing, so this cannot loop).
      this.pageObserver = new MutationObserver(() => {
        if (this.dead) return;
        const html = document.documentElement;
        if (!host.isConnected) html.appendChild(host);
        const classesLost = this.wantedClasses.some((name) => !html.classList.contains(name));
        if (classesLost) this.apply();
      });
      this.pageObserver.observe(document.documentElement, { childList: true, attributes: true, attributeFilter: ['class'] });
    }

    bindDock() {
      const root = this.root;

      root.addEventListener('click', (event) => this.onDockClick(event));
      root.addEventListener('input', (event) => this.onDockInput(event));

      // Pressing dock buttons should not clear the page's text selection.
      root.addEventListener('mousedown', (event) => {
        if (!event.target.closest('input')) event.preventDefault();
      });

      root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && this.open) {
          event.stopPropagation();
          this.setOpen(false, true);
          return;
        }
        const radio = event.target.closest('[role="radio"]');
        if (radio && /^Arrow(Left|Right|Up|Down)$/.test(event.key)) {
          const group = Array.from(radio.closest('[role="radiogroup"]').querySelectorAll('[role="radio"]'));
          const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
          const next = group[(group.indexOf(radio) + (forward ? 1 : group.length - 1)) % group.length];
          next.focus();
          next.click();
          event.preventDefault();
        }
        // Keep typing in the dock from triggering the host page's hotkeys.
        if (!event.altKey && !event.ctrlKey && !event.metaKey) event.stopPropagation();
      });

      // Dragging: the pill, or the panel header.
      root.addEventListener('pointerdown', (event) => this.onDragStart(event));
      root.addEventListener('pointermove', (event) => this.onDragMove(event));
      root.addEventListener('pointerup', (event) => this.onDragEnd(event));
      root.addEventListener('pointercancel', (event) => this.onDragEnd(event));
      root.addEventListener('lostpointercapture', (event) => this.onDragEnd(event));

      this.tipEl.addEventListener('mouseenter', () => clearTimeout(this.tip.hideTimer));
      this.tipEl.addEventListener('click', (event) => {
        if (event.target.closest('[data-save]')) { this.toggleSaveWord(); return; }
        const tag = event.target.closest('[data-tag]');
        if (tag) { this.tip.pinned = true; this.showPartInfo(Number(tag.dataset.tag)); return; }
        if (event.target.closest('[data-act="define"]')) { this.tip.pinned = true; this.toggleDefinition(); return; }
        const explain = event.target.closest('[data-act="explain"]');
        if (explain) { this.explainWord(explain); return; }
        const part = event.target.closest('[data-part]');
        if (part) { this.sayPart(Number(part.dataset.part)); return; }
        const button = event.target.closest('[data-say]');
        if (!button) return;
        if (button.dataset.say === 'slow') this.soundOut(button);
        else this.sayWord(button);
      });
      this.tipEl.addEventListener('mouseleave', () => { if (!this.tip.pinned) this.scheduleHideTip(); });

      window.addEventListener('resize', () => this.keepInView(), { passive: true });
    }

    onDockClick(event) {
      const target = event.target;
      if (this.justDragged) return;

      if (target.closest('.ll-pill-main')) { this.setOpen(true, event.detail === 0); return; }

      const el = target.closest('[data-toggle], [data-skin-pick], [data-action]');
      if (!el) return;

      if (el.dataset.toggle) {
        const key = el.dataset.toggle;
        this.update({ [key]: !this.state[key] });
      } else if (el.dataset.skinPick) {
        this.update({ skin: el.dataset.skinPick });
        this.keepInView();
      } else if (el.dataset.action === 'collapse') {
        this.setOpen(false, event.detail === 0);
      } else if (el.dataset.action === 'dock-mode') {
        const edge = !this.edge;
        this.setOpen(false, event.detail === 0);
        this.update({ dockMode: edge ? 'edge' : 'float' });
        this.toast(edge ? 'Tucked into the side. Click the tab to open' : 'Floating in the corner again');
      } else if (el.dataset.action === 'gaze-calibrate') {
        this.calibrateGaze();
      }
    }

    onDockInput(event) {
      const input = event.target.closest('[data-range]');
      if (input) this.update({ [input.dataset.range]: Number(input.value) });
    }

    setOpen(open, moveFocus) {
      const focusInside = !!this.shadow.activeElement;
      this.open = open;
      if (this.pill.offsetWidth) this.dock.style.setProperty('--pill-w', `${this.pill.offsetWidth}px`); // the panel folds to this
      this.dock.dataset.open = String(open);
      this.pillMain.setAttribute('aria-expanded', String(open));
      this.panel.toggleAttribute('inert', !open);
      this.pill.toggleAttribute('inert', open);
      this.keepInView();
      if (moveFocus || focusInside) {
        const target = open ? this.$('.ll-head [data-toggle="on"]') : this.pillMain;
        requestAnimationFrame(() => target.focus());
      }
    }

    /** Sync every control with the current settings. */
    renderDock() {
      const s = this.state;
      this.root.dataset.skin = s.skin;
      this.root.dataset.lens = s.on ? 'on' : 'off';

      if (this.dock.dataset.mode !== s.dockMode) { // floating pill <-> edge tab
        this.placeDock();
        requestAnimationFrame(() => this.keepInView());
      }
      const modeBtn = this.$('[data-action="dock-mode"]');
      const edge = s.dockMode === 'edge';
      if (modeBtn && modeBtn.dataset.edge !== String(edge)) {
        modeBtn.dataset.edge = String(edge);
        modeBtn.innerHTML = edge ? ICON.float : ICON.tuck;
        modeBtn.title = edge ? 'Float in the corner' : 'Tuck into the side';
        modeBtn.setAttribute('aria-label', edge ? 'Float Glider in the corner of the screen' : 'Tuck Glider into the side of the screen');
      }

      for (const btn of this.$$('[data-toggle]')) btn.setAttribute('aria-checked', String(!!s[btn.dataset.toggle]));
      for (const btn of this.$$('[data-skin-pick]')) btn.setAttribute('aria-checked', String(btn.dataset.skinPick === s.skin));

      for (const input of this.$$('[data-range]')) {
        const key = input.dataset.range;
        const r = RANGES[key];
        if (Number(input.value) !== s[key]) input.value = String(s[key]);
        input.style.setProperty('--p', `${((s[key] - r.min) / (r.max - r.min)) * 100}%`);
        const text = r.format(Math.round(s[key] * 100) / 100);
        input.setAttribute('aria-valuetext', text);
        this.$(`[data-value="${key}"]`).textContent = text;
      }

      const body = this.$('.ll-body');
      body.dataset.on = String(s.on);
      body.toggleAttribute('inert', !s.on);

      this.$('.ll-status').textContent = s.on ? 'On for every page' : 'Off. Pages are untouched';
      this.pillMain.setAttribute('aria-label', `${APP_NAME}, reading lens ${s.on ? 'on' : 'off'}. Open the panel`);
      this.pill.dataset.on = String(s.on);
      this.renderGaze();
    }

    toast(message) {
      clearTimeout(this.toastTimer);
      this.toastEl.textContent = message;
      // Sit beside the dock, on its side of the screen, clear of the pill / panel.
      const { h, v, y } = this.dockPos;
      const x = this.edge ? 8 : this.dockPos.x;
      const clear = Math.max(8, Math.min(y + this.activeBox().offsetHeight + 10, window.innerHeight - 48));
      const style = this.toastEl.style;
      this.toastEl.dataset.h = h;
      style.left = h === 'l' ? `${x}px` : 'auto';
      style.right = h === 'r' ? `${x}px` : 'auto';
      style.top = v === 't' ? `${clear}px` : 'auto';
      style.bottom = v === 'b' ? `${clear}px` : 'auto';
      this.toastEl.dataset.show = 'true';
      this.toastTimer = setTimeout(() => { this.toastEl.dataset.show = 'false'; }, 2200);
    }

    /* ---------------------------------------------------- dock position */

    /** Tucked into the screen edge as a slim tab (the floating x is kept for later). */
    get edge() {
      return this.state.dockMode === 'edge';
    }

    placeDock() {
      const { h, v, y } = this.dockPos;
      const x = this.edge ? 0 : this.dockPos.x;
      this.syncGazeCorner();
      const style = this.dock.style;
      this.dock.dataset.h = h;
      this.dock.dataset.v = v;
      this.dock.dataset.mode = this.state.dockMode;
      style.left = h === 'l' ? `${x}px` : 'auto';
      style.right = h === 'r' ? `${x}px` : 'auto';
      style.top = v === 't' ? `${y}px` : 'auto';
      style.bottom = v === 'b' ? `${y}px` : 'auto';
      style.setProperty('--dock-x', `${x}px`); // the edge mark cancels this inset
    }

    activeBox() {
      return this.open ? this.panel : this.pill;
    }

    /** Nudge the dock so the pill / panel is fully on screen. */
    keepInView() {
      const box = this.activeBox();
      const width = box.offsetWidth;
      const height = box.offsetHeight;
      if (!width || !height) return;
      const maxX = Math.max(8, window.innerWidth - width - 8);
      const maxY = Math.max(8, window.innerHeight - height - 8);
      // At the edge only the height along the edge matters; the floating x is left for later.
      const x = this.edge ? this.dockPos.x : Math.min(maxX, Math.max(8, this.dockPos.x));
      const y = Math.min(maxY, Math.max(8, this.dockPos.y));
      if (x !== this.dockPos.x || y !== this.dockPos.y) {
        this.dockPos.x = x;
        this.dockPos.y = y;
        this.placeDock();
      }
    }

    onDragStart(event) {
      if (event.button !== 0) return;
      const handle = event.target.closest('.ll-pill, [data-drag]');
      if (!handle || event.target.closest('.ll-icon-btn')) return;
      const rect = this.activeBox().getBoundingClientRect();
      // Capture straight away so a fast flick cannot outrun the dock. Capturing
      // on the pressed button (not the whole pill) keeps its click intact.
      const captor = event.target.closest('button') || handle;
      this.drag = { id: event.pointerId, handle: captor, startX: event.clientX, startY: event.clientY, rect, moved: false };
      try { captor.setPointerCapture(event.pointerId); } catch (_) { /* pointer already gone */ }
    }

    onDragMove(event) {
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.id) return;
      if (event.buttons === 0) { this.onDragEnd(event); return; } // the release was missed
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < 5) return;
        drag.moved = true;
        this.dock.dataset.dragging = 'true';
        this.hideTip(true);
      }
      const { width, height } = drag.rect;
      const left = Math.min(window.innerWidth - width - 8, Math.max(8, drag.rect.left + dx));
      const top = Math.min(window.innerHeight - height - 8, Math.max(8, drag.rect.top + dy));
      drag.left = left;
      drag.top = top;
      if (this.edge) {
        // The tab slides along the edge, and hops to the other edge past the middle.
        this.dockPos.h = event.clientX > window.innerWidth / 2 ? 'r' : 'l';
      } else {
        this.dockPos.x = this.dockPos.h === 'l' ? left : window.innerWidth - left - width;
      }
      this.dockPos.y = this.dockPos.v === 't' ? top : window.innerHeight - top - height;
      this.placeDock();
    }

    onDragEnd(event) {
      const drag = this.drag;
      if (!drag || event.pointerId !== drag.id) return;
      this.drag = null;
      try { drag.handle.releasePointerCapture(drag.id); } catch (_) { /* already released */ }
      if (!drag.moved) return;
      delete this.dock.dataset.dragging;

      // Anchor to the nearest corner so the panel always opens inward and
      // the dock keeps its place when the window is resized.
      const { width, height } = drag.rect;
      const h = this.edge ? this.dockPos.h : drag.left + width / 2 > window.innerWidth / 2 ? 'r' : 'l';
      const v = drag.top + height / 2 > window.innerHeight / 2 ? 'b' : 't';
      this.dockPos = {
        h,
        v,
        x: this.edge ? this.dockPos.x : Math.round(h === 'l' ? drag.left : window.innerWidth - drag.left - width),
        y: Math.round(v === 't' ? drag.top : window.innerHeight - drag.top - height),
      };
      this.placeDock();
      storage.set(DOCK_KEY, this.dockPos);

      // Swallow the click that follows a drag.
      this.justDragged = true;
      setTimeout(() => { this.justDragged = false; }, 0);
    }

    /* ---------------------------------------------------- page listeners */

    bindPage() {
      document.addEventListener('mouseover', (event) => this.onPageHover(event), { capture: true, passive: true });
      document.addEventListener('dblclick', (event) => this.onPageDoubleClick(event), true);
      document.addEventListener('click', (event) => {
        if (event.target !== this.host && this.tip.pinned && !this.tokenFrom(event)) this.hideTip(true);
      }, true);
      document.addEventListener('scroll', () => {
        if (this.tip.token && !this.tip.pinned) this.hideTip(true);
        else if (this.tip.token) this.positionTip();
      }, { capture: true, passive: true });
      window.addEventListener('keydown', (event) => this.onPageKey(event), true);
    }

    tokenFrom(event) {
      const target = event.target;
      if (!target || target.nodeType !== Node.ELEMENT_NODE) return null;
      return target.closest('.glider-token');
    }

    /** Does hovering this word open the lens? Long words and look-alikes do. */
    wantsLens(token) {
      if (!token || !this.state.on) return false;
      return token.classList.contains('glider-long') || token.classList.contains('glider-homophone');
    }

    onPageHover(event) {
      if (this.tip.pinned || this.drag) return;
      const token = this.tokenFrom(event);
      if (this.wantsLens(token)) {
        clearTimeout(this.tip.hideTimer);
        if (token === this.tip.token) return;
        clearTimeout(this.tip.showTimer);
        this.tip.showTimer = setTimeout(() => this.showTip(token, false), this.tip.token ? 60 : 150);
      } else {
        clearTimeout(this.tip.showTimer);
        if (this.tip.token && event.target !== this.host) this.scheduleHideTip();
      }
    }

    /** Double-click keeps the lens open until the next click elsewhere. */
    onPageDoubleClick(event) {
      const token = this.tokenFrom(event);
      if (!this.wantsLens(token)) return;
      clearTimeout(this.tip.showTimer);
      this.showTip(token, true);
    }

    onPageKey(event) {
      if (event.key === 'Escape') {
        if (this.tip.token) this.hideTip(true);
        return;
      }
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (!storage.alive()) return;
      // Leave Alt combinations alone while typing (they produce characters on
      // some keyboard layouts), unless the focus is in our own dock.
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (isTypingTarget(event) && !path.includes(this.host)) return;
      const key = event.code;
      if (key === 'KeyL') { event.preventDefault(); this.command('toggle-dock'); }
    }

    /** Run a shortcut. De-duplicated because the browser-level shortcut and
        the in-page key listener can both fire for one key press. */
    command(name) {
      const now = Date.now();
      if (now - (this.lastCommand.get(name) || 0) < 300) return;
      this.lastCommand.set(name, now);

      if (name === 'toggle-dock') {
        if (!this.state.dockVisible) this.update({ dockVisible: true });
        this.setOpen(!this.open, true);
      }
    }

    /* -------------------------------------------------------- eye tracking */

    /** Call a GazeReader method if it is there. Never throws. */
    gazeCall(name, ...args) {
      const G = this.gaze;
      if (!G || typeof G[name] !== 'function') return undefined;
      try { return G[name](...args); } catch (_) { return undefined; }
    }

    /** Take charge of GazeReader: it starts and stops only when we say so. */
    bindGaze() {
      const G = globalThis.GazeReader;
      if (!G || typeof G !== 'object' || window.top !== window) return;
      this.gaze = G;
      this.gazeCall('init', { managed: true, autoAdapt: false, camera: 'hidden', onEnableRequest: (wanted) => this.update({ gaze: !!wanted }) });   // autoAdapt off: no line highlight or read-aloud button on a struggle
      // The tracker's struggles are handled by the simplifier (simplify/bridge.js), which changes only the wording:
      // the panel puts nothing of its own on the page for them.
      for (const [name, fn] of [['status', (state) => this.renderGaze(state)]]) {
        const off = this.gazeCall('on', name, (payload) => { if (!this.dead) fn(payload); });
        if (typeof off === 'function') this.gazeOff.push(off);
      }
    }

    unbindGaze() {
      if (!this.gaze) return;
      this.gazeCall('stop');
      for (const off of this.gazeOff.splice(0)) { try { off(); } catch (_) { /* already gone */ } }
      this.gazeApplied.wanted = false;
      this.gaze = null;
    }

    /** Start or stop the eye tracker to match the settings. Cheap when nothing changed. */
    applyGaze() {
      const s = this.state;
      const wanted = !!this.gaze && s.on && s.gaze;
      if (!this.gaze) return;

      if (!!s.gazeTrace !== this.gazeApplied.trace) { this.gazeApplied.trace = !!s.gazeTrace; this.gazeCall('setTrace', !!s.gazeTrace); }
      const mult = GAZE_SENSITIVITY[s.gazeSensitivity - 1] || 1;
      if (mult !== this.gazeApplied.mult) {
        this.gazeApplied.mult = mult;
        this.gazeCall('setSensitivity', mult);
      }
      if (wanted !== this.gazeApplied.wanted) {
        this.gazeApplied.wanted = wanted;
        if (wanted) Promise.resolve(this.gazeCall('start')).catch(() => {});
        else this.gazeCall('stop');
      }
    }

    /** The Calibrate button (dock or popup): get the panel out of the way first. */
    calibrateGaze() {
      if (this.dead || !this.gaze || !this.state.on || !this.state.gaze) return;
      this.hideTip(true);
      if (this.open) this.setOpen(false, false);
      Promise.resolve(this.gazeCall('calibrate')).catch(() => {});
    }

    gazeStatusText(g) {
      const baseline = g.baseline && Number.isFinite(Number(g.baseline.wpm)) ? g.baseline : null;
      switch (g.status) {
        case 'starting': return 'Starting the camera';
        case 'needs-permission': return (g.error && g.error.short) || 'Allow the camera to begin';
        case 'ready': return g.calibrated ? 'Ready to follow your reading' : 'Calibrate to begin';
        case 'calibrating':
        case 'baseline': return 'Calibrating. Follow the steps on screen';
        case 'tracking': {
          if (!baseline) return 'Following your reading. Pace not measured yet';
          const pace = `Your pace: ${Math.round(Number(baseline.wpm))} words a minute`;
          const tau = Number(g.tau);
          return Number.isFinite(tau) && tau > 0 ? `${pace}. Help when a line takes ${tau.toFixed(1)} times longer` : pace;
        }
        case 'paused': return 'Paused. The window changed, so recalibrate to go on';
        // GazeReader says which problem it is (camera in use, no camera, the face model did not load) and shows a Retry button on the page.
        case 'error': return g.error && g.error.short ? `${g.error.short}. Press Retry on the page` : 'Eye tracking could not start. Switch it off and on again';
        default: return '';
      }
    }

    /** Tell the eye tracker which corner the dock is in, so its camera
        widget (bottom-left by default) moves aside instead of overlapping. */
    /** The camera box is hidden (camera: 'hidden'), so the dock mark carries a small dot: green while eye tracking
        runs, amber while it is paused or needs the reader (move back, recalibrate, allow the camera), none when off. */
    syncGazeDot(state) {
      const pill = this.$('.ll-pill');
      if (!pill) return;
      const st = state && state.status;
      const want = !st || st === 'idle' ? ''
        : (st === 'paused' || st === 'error' || st === 'needs-permission' || state.drifted || state.needsRecalibration || !state.calibrated) ? 'paused' : 'on';
      if ((pill.dataset.gaze || '') === want) return;
      if (want) pill.dataset.gaze = want; else delete pill.dataset.gaze;
      const main = this.$('.ll-pill-main');
      if (main) main.title = want === 'on' ? `Open ${APP_NAME}. Eye tracking is on` : want === 'paused' ? `Open ${APP_NAME}. Eye tracking needs you` : `Open ${APP_NAME}`;
    }

    syncGazeCorner() {
      const host = document.querySelector('[data-gaze-reader]');
      const corner = this.dockPos.h + this.dockPos.v;
      if (host && host.getAttribute('data-dock') !== corner) host.setAttribute('data-dock', corner);
    }

    /** Sync the eye tracking part of the dock. `g` is a GazeReader state. */
    renderGaze(g) {
      this.syncGazeCorner();
      const box = this.$('.ll-gaze');
      if (!box) return;
      box.hidden = !this.gaze;
      if (!this.gaze) { this.syncGazeDot(null); return; }

      const state = (g && typeof g === 'object' ? g : this.gazeCall('getState')) || {};
      const show = !!this.state.gaze;
      this.syncGazeDot(show && this.state.on ? state : null);
      const status = this.$('.ll-gaze-status');
      const button = this.$('[data-action="gaze-calibrate"]');
      for (const el of [this.$('.ll-gaze-line'), status, button, this.$('.ll-gaze-sliders'), this.$('.ll-gaze-original')]) el.hidden = !show;

      const text = show && this.state.on ? this.gazeStatusText(state) : '';
      if (status.textContent !== text) status.textContent = text;
      const label = state.calibrated ? 'Recalibrate' : 'Calibrate';
      if (button.textContent !== label) button.textContent = label;
      if (this.open) this.keepInView();
    }

    /* ----------------------------------------------------------- word lens */

    syllableMarkup(word) {
      const parts = LL.Syllables ? LL.Syllables.split(word) : [word];
      return parts
        .map((part) => `<span class="ll-syl">${esc(part)}</span>`)
        .join('<span class="ll-dot" aria-hidden="true">·</span>');
    }

    showTip(token, pinned) {
      if (!token.isConnected || !this.wantsLens(token)) return;
      const word = this.engine.wordOf(token);
      const showSyllables = token.classList.contains('glider-long');
      const group = token.classList.contains('glider-homophone') ? LL.lookupHomophone(word) : null;
      if (!showSyllables && !group) return;

      const s = this.state;
      let html = `<div class="ll-meta">` +
        `<span class="ll-diff" hidden></span>` +
        `<span class="ll-level" hidden></span>` +
        `<p class="ll-why" hidden></p>` +
        `</div>`;
      if (showSyllables) {
        html += `<div class="ll-syls" data-chips>${this.syllableMarkup(word)}</div>`;
      } else {
        html += `<div class="ll-word">${esc(word)}</div>`;
      }
      html += `<div class="ll-parts" hidden></div>`;
      html += `<div class="ll-wparts" hidden></div>`;
      html += `<div class="ll-partinfo" role="status" hidden></div>`;
      html += `<div class="ll-say">` +
        `<button type="button" class="ll-say-btn" data-say="word" aria-label="Hear ${esc(word)}">${ICON.speaker}<span>Hear word</span></button>` +
        `<button type="button" class="ll-say-btn" data-say="slow" aria-label="Sound out ${esc(word)}, one part at a time" hidden>${ICON.steps}<span>Sound it out</span></button>` +
        `<button type="button" class="ll-say-btn" data-act="define" aria-expanded="false" aria-label="Meaning of ${esc(word)}">${ICON.book}<span>Meaning</span></button>` +
        `</div>`;
      html += `<div class="ll-def" hidden></div>`;
      if (group) {
        const current = word.toLowerCase().replace(/’/g, "'");
        const kind = group.kind === 'look-alike' ? 'Looks alike' : 'Sounds alike';
        html += `<ul class="ll-pairs" aria-label="${kind}">` + group.words.map((entry) => {
          const here = entry.w === current;
          return `<li class="ll-pair" data-current="${here}">
            <span class="ll-emoji" aria-hidden="true">${entry.icon}</span>
            <span><span class="ll-pair-word">${esc(entry.w)}${here ? '<span class="ll-here">this word</span>' : ''}</span>
            <span class="ll-pair-def">${esc(entry.def)}</span></span>
          </li>`;
        }).join('') + '</ul>';
      }

      if (this.tip.token && this.tip.token !== token) this.tip.token.classList.remove('glider-lensed');
      this.tip.token = token;
      this.tip.pinned = pinned;
      token.classList.add('glider-lensed');

      const tip = this.tipEl;
      tip.innerHTML = html;
      tip.hidden = false;
      this.positionTip();
      requestAnimationFrame(() => { tip.dataset.show = 'true'; });

      // Everything below arrives a moment later from the bundled lists (held by the service worker).
      this.tip.word = word;
      this.tip.say = null;
      this.tip.parts = null;
      this.tip.level = null;
      this.tip.difficulty = null;
      this.tip.wordParts = null;
      this.tip.definition = undefined;
      const current = () => this.tip.token === token;
      const levelP = lookupLevel(word);
      const sayP = lookupSay(word);
      const partsP = s.showWordParts && showSyllables ? lookupParts(word) : Promise.resolve(null);

      // How hard the word is to read (Easy / Medium / Hard, with why), and its CEFR level as a small tag.
      Promise.all([levelP, sayP]).then(([level, say]) => {
        if (!current()) return;
        this.tip.level = level;
        const D = globalThis.GliderDifficulty;
        if (D) {
          this.tip.difficulty = D.rate({
            word, level: level ? level.level : null, say: say ? say.say : null,
            syllables: LL.Syllables ? LL.Syllables.split(word) : null, lookalike: !!group,
          });
        }
        if (this.state.showLevels) this.renderDifficulty(word);
      });

      // The sounds: each written chunk gets the sound it makes underneath; the stressed part is bold.
      sayP.then((found) => {
        if (!found || !current()) return;
        const sounds = found.say.split('-');
        const letters = showSyllables && LL.Syllables ? LL.Syllables.split(word) : [];
        const paired = letters.length === sounds.length;
        this.tip.parts = found.speak;
        this.tip.say = found.say;
        const partsHtml = sounds.map((sound, i) => {
          const stress = sound === sound.toUpperCase() && sounds.length > 1;
          const label = paired ? `${letters[i]}, sounds like ${sound.toLowerCase()}` : `Sounds like ${sound.toLowerCase()}`;
          return `<button type="button" class="ll-part" data-part="${i}" data-stress="${stress}" aria-label="${esc(label)}" title="Hear this part">` +
            (paired ? `<span class="ll-part-letters">${esc(letters[i])}</span>` : '') +
            `<span class="ll-part-sound">${esc(sound.toLowerCase())}</span></button>`;
        }).join('');
        const holder = tip.querySelector('.ll-parts');
        if (!holder) return;
        holder.innerHTML = partsHtml;
        holder.hidden = false;
        const syls = tip.querySelector('.ll-syls');
        if (syls && paired) {
          syls.remove();
          holder.setAttribute('data-chips', '');   // the sound chips now carry the letters
        }
        const slow = tip.querySelector('[data-say="slow"]');
        if (slow && sounds.length > 1) slow.hidden = false;
        this.renderWordParts();
        this.positionTip();
      });

      // Prefixes, roots and suffixes. Placed once the chips they sit on are final.
      Promise.all([partsP, sayP]).then(([parts]) => {
        if (!current() || !parts) return;
        this.tip.wordParts = parts;
        this.renderWordParts();
      });

      if (s.showDefinitions) this.toggleDefinition(true);
    }

    /* ------------------------------------------------- difficulty, parts, meaning */

    /** The "Medium to read" chip, why, and the CEFR level as a secondary tag. */
    renderDifficulty(word) {
      const tip = this.tipEl;
      const d = this.tip.difficulty;
      const chip = tip.querySelector('.ll-diff');
      const why = tip.querySelector('.ll-why');
      const tag = tip.querySelector('.ll-level');
      if (!chip || !why || !tag) return;
      const D = globalThis.GliderDifficulty;
      if (d && D) {
        const band = D.BANDS[d.band];
        chip.dataset.band = d.band;
        chip.innerHTML = `<b>${esc(band.short)}</b>`;
        chip.title = 'How hard this word is to read: its length, how common it is, and spellings that do not match the sound';
        chip.setAttribute('aria-label', `${band.name}${d.reasons.length ? ': ' + d.reasons.join(', ') : ''}`);
        chip.hidden = false;
        // Why, only when it is not easy: "4 syllables · one part is not said".
        why.textContent = d.band === 'easy' ? '' : d.reasons.join(' · ');
        why.hidden = d.band === 'easy' || !d.reasons.length;
      }
      const level = this.tip.level;
      if (level) {
        const info = (globalThis.GliderLevels && globalThis.GliderLevels.INFO[level.level]) || { name: '', text: '' };
        const of = level.base !== String(word).toLowerCase() ? ` (as ${level.base})` : '';
        tag.dataset.level = level.level;
        tag.textContent = level.level;
        tag.title = `How common: CEFR level ${level.level}, ${info.name}${of}. ${info.text}. Levels run from A1 (most common) to C2 (rarest)`;
        tag.setAttribute('aria-label', `How common: level ${level.level}, ${info.name}${of}`);
        tag.hidden = false;
      }
      this.positionTip();
    }

    /** Badges over the syllable chips a word part covers; when the parts do not line up with
        the syllables (bi·ol·o·gy is bio + logy), a "Word parts" row instead. */
    renderWordParts() {
      const tip = this.tipEl;
      const parts = this.tip.wordParts;
      const row = tip.querySelector('.ll-wparts');
      const holder = tip.querySelector('[data-chips]');
      for (const old of tip.querySelectorAll('.ll-tag')) old.remove();
      if (holder) holder.removeAttribute('data-tagged');
      if (!parts || !parts.length || !row || !this.state.showWordParts) return;
      const word = String(this.tip.word || '');
      const chips = holder ? Array.from(holder.querySelectorAll('.ll-part, .ll-syl')) : [];
      const letters = chips.map((c) => (c.querySelector('.ll-part-letters') || c).textContent);
      const short = { prefix: 'prefix', root: 'root', suffix: 'suffix', 'base word': 'base' };

      // Where each chip starts and ends in the word.
      const spans = [];
      let at = 0;
      for (const l of letters) { spans.push([at, at + l.length]); at += l.length; }
      const lined = chips.length && at === word.length && letters.join('').toLowerCase() === word.toLowerCase();
      const groups = lined ? parts.map((p) => {
        const first = spans.findIndex((sp) => sp[0] === p.start);
        const last = spans.findIndex((sp) => sp[1] === p.end);
        return first >= 0 && last >= first ? [first, last] : null;
      }) : [];
      const sameLine = (g) => chips[g[0]].offsetTop === chips[g[1]].offsetTop;
      const onChips = lined && groups.every((g) => g && sameLine(g));

      if (onChips) {
        row.hidden = true;
        holder.setAttribute('data-tagged', '');
        parts.forEach((p, i) => {
          const [a, b] = groups[i];
          const tag = document.createElement('button');
          tag.type = 'button';
          tag.className = 'll-tag';
          tag.dataset.tag = String(i);
          tag.dataset.kind = p.type;
          tag.textContent = short[p.kind] || p.kind;
          tag.setAttribute('aria-label', `${word.slice(p.start, p.end)}: ${p.kind}. Show what it means`);
          tag.setAttribute('aria-expanded', 'false');
          tag.style.left = `${chips[a].offsetLeft}px`;
          tag.style.width = `${chips[b].offsetLeft + chips[b].offsetWidth - chips[a].offsetLeft}px`;
          holder.appendChild(tag);
        });
      } else {
        row.innerHTML = `<span class="ll-wparts-label">Word parts</span>` + parts.map((p, i) =>
          `<button type="button" class="ll-wpart" data-tag="${i}" data-kind="${p.type}" aria-expanded="false" aria-label="${esc(word.slice(p.start, p.end))}: ${esc(p.kind)}. Show what it means">` +
          `<b>${esc(word.slice(p.start, p.end))}</b><small>${esc(short[p.kind] || p.kind)}</small></button>`).join('<span class="ll-plus" aria-hidden="true">+</span>');
        row.hidden = false;
      }
      this.positionTip();
    }

    /** A part's badge was pressed: say what the part means (a base word gets its dictionary meaning). */
    showPartInfo(index) {
      const tip = this.tipEl;
      const box = tip.querySelector('.ll-partinfo');
      const p = this.tip.wordParts && this.tip.wordParts[index];
      if (!box || !p) return;
      const open = box.dataset.index === String(index) && !box.hidden;
      for (const b of tip.querySelectorAll('[data-tag]')) b.setAttribute('aria-expanded', String(!open && b.dataset.tag === String(index)));
      const holder = tip.querySelector('[data-chips]');
      for (const c of tip.querySelectorAll('.ll-part, .ll-syl')) delete c.dataset.inpart;
      if (open) { box.hidden = true; delete box.dataset.index; this.positionTip(); return; }
      box.dataset.index = String(index);
      const written = String(this.tip.word || '').slice(p.start, p.end);
      if (holder && holder.hasAttribute('data-tagged')) {
        let at = 0;
        for (const c of holder.querySelectorAll('.ll-part, .ll-syl')) {
          const len = (c.querySelector('.ll-part-letters') || c).textContent.length;
          if (at >= p.start && at + len <= p.end) c.dataset.inpart = 'true';
          at += len;
        }
      }
      const head = `<b class="ll-pi-label">${esc(p.label)}</b><span class="ll-pi-kind" data-kind="${p.type}">${esc(p.kind)}</span>`;
      if (p.type !== 'w') {
        const as = p.example && p.example.toLowerCase() !== String(this.tip.word).toLowerCase() ? ` As in <i>${esc(p.example)}</i>.` : '';
        box.innerHTML = `${head}<p>Means <b>${esc(p.meaning)}</b>.${as}</p>`;
      } else {
        box.innerHTML = `${head}<p class="ll-pi-wait">Looking up “${esc(p.base || written)}”…</p>`;
        lookupDefine(p.base || written).then((d) => {
          if (box.dataset.index !== String(index) || !this.tip.wordParts) return;
          const sense = d && d.senses[0];
          box.innerHTML = `${head}<p>${sense ? `${sense.posName ? `<i>${esc(sense.posName)}</i> ` : ''}${esc(sense.def)}` : 'The word this one is built on.'}</p>`;
          this.positionTip();
        });
      }
      box.hidden = false;
      this.positionTip();
    }

    /** Open or close the word's meaning (WordNet), with "Explain simply" when Claude is set up. */
    toggleDefinition(force) {
      const tip = this.tipEl;
      const box = tip.querySelector('.ll-def');
      const button = tip.querySelector('[data-act="define"]');
      if (!box || !button || !this.tip.word) return;
      const open = typeof force === 'boolean' ? force : box.hidden;
      button.setAttribute('aria-expanded', String(open));
      box.hidden = !open;
      if (!open) { this.positionTip(); return; }
      const word = this.tip.word;
      const token = this.tip.token;
      if (this.tip.definition === undefined) {
        box.innerHTML = '<p class="ll-def-wait">Looking it up…</p>';
        Promise.all([lookupDefine(word), claudeReady()]).then(([d, canExplain]) => {
          if (this.tip.token !== token) return;
          this.tip.definition = d;
          const senses = d ? d.senses.slice(0, 2) : [];
          const as = d && d.word !== word.toLowerCase() ? `<p class="ll-def-as">From “${esc(d.word)}”</p>` : '';
          box.innerHTML = as + (senses.length
            ? `<ol class="ll-senses">${senses.map((x) => `<li>${x.posName ? `<i>${esc(x.posName)}</i> ` : ''}${esc(x.def)}${x.example ? `<q>${esc(x.example)}</q>` : ''}</li>`).join('')}</ol>`
            : '<p class="ll-def-none">This word is not in Glider’s dictionary.</p>') +
            (canExplain ? `<div class="ll-explain"><button type="button" class="ll-explain-btn" data-act="explain" title="Sends this word and its sentence to Anthropic">${ICON.spark}<span>Explain simply</span></button></div>` : '') +
            '<p class="ll-def-src">Dictionary: WordNet</p>';
          this.positionTip();
        });
      }
      this.positionTip();
    }

    /** "Explain simply": Claude says what the word means in this sentence, in plain words. */
    explainWord(button) {
      const token = this.tip.token;
      const word = this.tip.word;
      if (!token || !word || !IN_EXTENSION) return;
      const holder = button.closest('.ll-explain');
      button.disabled = true;
      button.querySelector('span').textContent = 'Asking Claude…';
      const context = this.contextOf(token, word);
      chrome.runtime.sendMessage({ type: 'glider:explain', word, context }).then((reply) => {
        if (this.tip.token !== token || !holder.isConnected) return;
        holder.innerHTML = reply && reply.ok
          ? `<p class="ll-explained"><b>In plain words</b>${esc(reply.text)}</p>`
          : `<p class="ll-def-none">Claude could not explain it just now.</p>`;
        this.positionTip();
      }, () => {
        if (holder.isConnected) holder.innerHTML = '<p class="ll-def-none">Claude could not be reached.</p>';
      });
    }

    /* -------------------------------------------------------- saved words */

    setWords(value) {
      this.words = Array.isArray(value) ? value.filter((w) => w && typeof w.word === 'string') : [];
      this.savedKeys = new Set(this.words.map((w) => w.word.toLowerCase()));
    }

    isSaved(word) {
      return !!this.savedKeys && this.savedKeys.has(String(word).toLowerCase());
    }

    /** The sentence around a word, for remembering where it was met. */
    contextOf(token, word) {
      const block = token.closest('p, li, blockquote, dd, dt, td, th, figcaption, h1, h2, h3, h4, h5, h6') || token.parentElement;
      const text = String((block && block.textContent) || '').replace(/\s+/g, ' ').trim();
      if (!text) return '';
      const sentences = text.match(/[^.!?]+[.!?]*["”’)]?/g) || [text];
      const lower = word.toLowerCase();
      const hit = sentences.find((s) => s.toLowerCase().includes(lower)) || text;
      const s = hit.trim();
      return s.length > 220 ? s.slice(0, 217).trimEnd() + '…' : s;
    }

    /** Save the lens's word to the reader's list, or take it off again. */
    toggleSaveWord() {
      const token = this.tip.token;
      const word = this.tip.word;
      if (!token || !word) return;
      const key = word.toLowerCase();
      let list = (this.words || []).slice();
      const had = list.some((w) => w.word.toLowerCase() === key);
      if (had) {
        list = list.filter((w) => w.word.toLowerCase() !== key);
      } else {
        list.push({
          word: key,
          level: this.tip.level ? this.tip.level.level : null,
          base: this.tip.level ? this.tip.level.base : null,
          say: this.tip.say || null,
          syllables: LL.Syllables ? LL.Syllables.split(word) : [word],
          context: this.contextOf(token, word),
          url: location.href.split('#')[0].slice(0, 500),
          title: String(document.title || location.hostname).slice(0, 140),
          difficulty: this.tip.difficulty ? { band: this.tip.difficulty.band, reasons: this.tip.difficulty.reasons } : null,
          definition: this.tip.definition ? this.firstSense(this.tip.definition) : null,
          parts: this.tip.wordParts ? this.tip.wordParts.map((p) => ({ type: p.type, label: p.label, kind: p.kind, meaning: p.meaning || '', text: word.slice(p.start, p.end) })) : null,
          savedAt: Date.now(),
        });
        if (list.length > WORDS_CAP) list = list.slice(-WORDS_CAP);
      }
      this.setWords(list);
      storage.set(WORDS_KEY, list);
      this.renderSaveButton();
      this.toast(had ? `Removed “${key}” from your words` : `Saved “${key}” to your words`);
      // Keep the meaning with the word, even if the lens never showed it.
      if (!had && this.tip.definition === undefined) {
        lookupDefine(word).then((d) => {
          if (!d || this.dead) return;
          const next = (this.words || []).map((w) => (w.word === key && !w.definition ? { ...w, definition: this.firstSense(d) } : w));
          this.setWords(next);
          storage.set(WORDS_KEY, next);
        });
      }
    }

    firstSense(d) {
      const s = d && d.senses && d.senses[0];
      return s ? { word: d.word, pos: s.posName || '', def: s.def, example: s.example || '' } : null;
    }

    renderSaveButton() {
      const button = this.tipEl && this.tipEl.querySelector('[data-save]');
      if (!button || !this.tip.word) return;
      const saved = this.isSaved(this.tip.word);
      button.setAttribute('aria-pressed', String(saved));
      button.setAttribute('aria-label', `${saved ? 'Remove' : 'Save'} ${this.tip.word} ${saved ? 'from' : 'to'} your words`);
      button.title = saved ? 'Saved to your words. Click to remove' : 'Save to your words';
    }

    /** Stop any speech this lens started and clear its highlights. */
    stopSpeaking() {
      this.tip.run = (this.tip.run || 0) + 1;
      try { if (globalThis.speechSynthesis) globalThis.speechSynthesis.cancel(); } catch (_) { /* no voice */ }
      for (const el of this.tipEl.querySelectorAll('[data-now], [data-speaking]')) { delete el.dataset.now; delete el.dataset.speaking; }
    }

    /** Say the whole word. */
    sayWord(button) {
      if (!this.tip.word) return;
      this.stopSpeaking();
      const run = this.tip.run;
      if (button) button.dataset.speaking = 'true';
      const ok = speakText(this.tip.word, 0.8, () => { if (this.tip.run === run && button) delete button.dataset.speaking; });
      if (!ok) { this.stopSpeaking(); this.toast('This browser has no voice to read with'); }
    }

    /** Say one sound part. */
    sayPart(index) {
      const parts = this.tip.parts;
      if (!parts || !parts[index]) return;
      this.stopSpeaking();
      const run = this.tip.run;
      const el = this.tipEl.querySelector(`[data-part="${index}"]`);
      if (el) el.dataset.now = 'true';
      const ok = speakText(parts[index], 0.7, () => { if (this.tip.run === run && el) delete el.dataset.now; });
      if (!ok) { this.stopSpeaking(); this.toast('This browser has no voice to read with'); }
    }

    /** Sound it out: each part in turn, lit up as it is said, then the whole word. */
    soundOut(button) {
      const parts = this.tip.parts;
      if (!parts || !parts.length) { this.sayWord(button); return; }
      this.stopSpeaking();
      const run = this.tip.run;
      button.dataset.speaking = 'true';
      const step = (i) => {
        if (this.tip.run !== run) return;
        for (const el of this.tipEl.querySelectorAll('[data-now]')) delete el.dataset.now;
        if (i > parts.length) { delete button.dataset.speaking; return; }
        const whole = i === parts.length;
        if (whole) for (const el of this.tipEl.querySelectorAll('.ll-part')) el.dataset.now = 'true';
        else { const el = this.tipEl.querySelector(`[data-part="${i}"]`); if (el) el.dataset.now = 'true'; }
        const ok = speakText(whole ? this.tip.word : parts[i], whole ? 0.8 : 0.7, () => setTimeout(() => step(i + 1), whole ? 0 : 260));
        if (!ok) { this.stopSpeaking(); this.toast('This browser has no voice to read with'); }
      };
      step(0);
    }

    positionTip() {
      const token = this.tip.token;
      const tip = this.tipEl;
      if (!token || !token.isConnected) { this.hideTip(true); return; }
      const rect = token.getClientRects()[0] || token.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) { this.hideTip(true); return; }

      // Measure at the left edge, so a lens near the right edge is not squeezed narrow.
      tip.style.left = '0px';
      tip.style.top = '0px';
      const width = tip.offsetWidth;
      const height = tip.offsetHeight;
      const centre = rect.left + rect.width / 2;
      const left = Math.min(window.innerWidth - width - 8, Math.max(8, centre - width / 2));
      // Above the word when it fits; else below; else whichever side has more room, kept on screen.
      const roomAbove = rect.top - 18, roomBelow = window.innerHeight - rect.bottom - 18;
      let top = rect.top - height - 10;
      let side = 'above';
      if (height > roomAbove) {
        if (height <= roomBelow || roomBelow > roomAbove) { top = rect.bottom + 10; side = 'below'; }
        top = Math.max(8, Math.min(top, window.innerHeight - height - 8));
      }
      tip.dataset.side = side;
      tip.style.setProperty('--ox', `${Math.round(Math.min(width, Math.max(0, centre - left)))}px`); // it grows out of the word
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(top)}px`;
    }

    scheduleHideTip() {
      clearTimeout(this.tip.hideTimer);
      this.tip.hideTimer = setTimeout(() => this.hideTip(false), 240);
    }

    hideTip(immediate) {
      clearTimeout(this.tip.showTimer);
      clearTimeout(this.tip.hideTimer);
      if (this.tip.token) this.tip.token.classList.remove('glider-lensed');
      if (this.tip.token && this.tipEl) this.stopSpeaking();
      this.tip.token = null;
      this.tip.pinned = false;
      const tip = this.tipEl;
      if (!tip || tip.hidden) return;
      tip.dataset.show = 'false';
      if (immediate) tip.hidden = true;
      else setTimeout(() => { if (!this.tip.token) tip.hidden = true; }, 130);
    }
  }

  /* =====================================================================
   * Helpers
   * ===================================================================== */



  /** True when the key press belongs to a form field, editor or our own dock. */
  function isTypingTarget(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    const el = path[0];
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (path.some((node) => node && node.id === 'glider-root')) return true;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.getAttribute('role') === 'textbox' ||
      el.getAttribute('role') === 'slider' || el.getAttribute('role') === 'listbox';
  }

  /* ---- pronunciation ---------------------------------------------------
     "Say it like" respellings come from a bundled word list (built from the
     CMU Pronouncing Dictionary). Inside the extension the service worker
     holds the list, so it is loaded once for every tab and only when a word
     is first hovered. On a plain page (the demo) the file is fetched here. */
  const sayCache = new Map();
  let sayList = null;
  let soundList = null;

  function findSay(list, word) {
    const key = '\n' + word + '\t';
    const at = list.indexOf(key);
    if (at < 0) return null;
    const end = list.indexOf('\n', at + key.length);
    // A Windows checkout can turn the list's line ends into CRLF: trim the end.
    return list.slice(at + key.length, end < 0 ? undefined : end).trimEnd();
  }

  /** Resolves to { say: "fuh-LAH-suh-fee", speak: [what to feed the voice per part] }, or null. */
  function lookupSay(rawWord) {
    const word = String(rawWord).toLowerCase().replace(/’/g, "'");
    if (sayCache.has(word)) return sayCache.get(word);
    const pending = (async () => {
      try {
        if (IN_EXTENSION) {
          const reply = await chrome.runtime.sendMessage({ type: 'glider:say', word });
          return reply && reply.say ? { say: reply.say, speak: reply.speak || reply.say.toLowerCase().split('-') } : null;
        }
        if (!sayList) sayList = fetch(assetURL('data/pronounce.txt')).then((r) => (r.ok ? r.text() : '')).then((t) => '\n' + t);
        if (!soundList) soundList = fetch(assetURL('data/sounds.txt')).then((r) => (r.ok ? r.text() : '')).then((t) => '\n' + t);
        const [list, sounds] = await Promise.all([sayList, soundList]);
        const say = findSay(list, word) || findSay(list, word.replace(/'s$|s$/, ''));
        if (!say) return null;
        // Some respellings are misread by speech voices; sounds.txt holds a
        // spelling of the same sound that voices say correctly.
        return { say, speak: say.toLowerCase().split('-').map((part) => findSay(sounds, part) || part) };
      } catch (_) {
        return null;
      }
    })();
    sayCache.set(word, pending);
    return pending;
  }

  /* ---- word levels -------------------------------------------------------
     CEFR levels (A1..C2) from data/levels.txt. Inside the extension the
     service worker holds the list; on a plain page it is fetched here. */
  const levelCache = new Map();
  let levelTable = null;

  /** Resolves to { level: 'B1', base: 'study' } or null when the word is not listed. */
  function lookupLevel(rawWord) {
    const word = String(rawWord).toLowerCase().replace(/’/g, "'");
    if (levelCache.has(word)) return levelCache.get(word);
    const pending = (async () => {
      try {
        if (IN_EXTENSION) {
          const reply = await chrome.runtime.sendMessage({ type: 'glider:level', word });
          return reply && reply.level ? { level: reply.level, base: reply.base || word } : null;
        }
        const L = globalThis.GliderLevels;
        if (!L) return null;
        if (!levelTable) levelTable = fetch(assetURL('data/levels.txt')).then((r) => (r.ok ? r.text() : '')).then((t) => L.parse(t));
        return L.lookup(await levelTable, word);
      } catch (_) {
        return null;
      }
    })();
    levelCache.set(word, pending);
    return pending;
  }

  /* ---- meanings and word parts --------------------------------------------
     Definitions (WordNet) and prefixes/roots/suffixes. Inside the extension the
     service worker holds the lists; on a plain page they are fetched here. */
  const lookups = { define: new Map(), parts: new Map() };
  const localLists = {};

  function lookupWordData(kind, rawWord) {
    const word = String(rawWord).toLowerCase().replace(/’/g, "'");
    const cache = lookups[kind];
    if (cache.has(word)) return cache.get(word);
    const pending = (async () => {
      try {
        if (IN_EXTENSION) return (await chrome.runtime.sendMessage({ type: 'glider:' + kind, word })) || null;
        const W = globalThis.GliderWordData;
        if (!W) return null;
        const file = kind === 'define' ? 'data/dictionary.txt' : 'data/wordparts.txt';
        if (!localLists[file]) localLists[file] = fetch(assetURL(file)).then((r) => (r.ok ? r.text() : '')).then((t) => W.prepare(t));
        const list = await localLists[file];
        return kind === 'define' ? W.define(list, word) : W.partsOf(list, word);
      } catch (_) {
        return null;
      }
    })();
    if (cache.size > 500) cache.clear();
    cache.set(word, pending);
    return pending;
  }
  const lookupDefine = (word) => lookupWordData('define', word);
  const lookupParts = (word) => lookupWordData('parts', word);

  /** True when an Anthropic key is saved, so "Explain simply" can be offered. Asked once a minute at most. */
  let claudeAsked = { at: 0, ready: Promise.resolve(false) };
  function claudeReady() {
    if (!IN_EXTENSION) return Promise.resolve(false);
    if (Date.now() - claudeAsked.at > 60000) {
      claudeAsked = {
        at: Date.now(),
        ready: chrome.runtime.sendMessage({ type: 'glider:simplify:status' }).then((r) => !!(r && r.hasKey), () => false),
      };
    }
    return claudeAsked.ready;
  }

  /* The narrator: a clean male English voice. Voices differ per browser and device, so this
     ranks whatever is installed. Known male voices score by how natural they sound; a voice
     that is not known to be male is only used when no male one exists. */
  const MALE_VOICES = [
    [/\b(Andrew|Brian|Christopher|Eric|Guy|Roger|Steffan|Davis|Tony|Jason|Ryan|Thomas|William|Liam)\b.*(Natural|Online|Neural)/i, 100],   // Edge / Windows natural voices
    [/Google UK English Male/i, 90],
    [/\b(Daniel|Alex|Aaron|Evan|Tom|Oliver|Arthur|Gordon|Reed|Rocko)\b/i, 80],   // macOS, iOS
    [/Microsoft (Mark|George|Ryan|Guy|Andrew|Brian|Christopher|Eric)\b/i, 70],
    [/Microsoft (David|James|Richard|Ravi|Sean)\b/i, 60],
    [/\bmale\b/i, 50],
  ];
  const FEMALE_HINT = /\bfemale\b|Zira|Hazel|Susan|Samantha|Victoria|Karen|Moira|Tessa|Fiona|Aria|Jenny|Michelle|Sonia|Libby|Emma|Ava|Catherine|Heera|Linda|Google US English|Google UK English Female/i;
  let voiceCache = { key: '', voice: null };
  function pickVoice(lang) {
    const synth = globalThis.speechSynthesis;
    const all = synth ? synth.getVoices() : [];
    const key = all.length + ':' + lang;
    if (voiceCache.key === key && voiceCache.voice) return voiceCache.voice;
    const english = all.filter((v) => /^en/i.test(v.lang));
    let best = null, bestScore = -1;
    for (const v of english) {
      let score = 0;
      for (const [re, points] of MALE_VOICES) if (re.test(v.name)) { score = points; break; }
      if (!score) score = FEMALE_HINT.test(v.name) ? 1 : 10;                        // unknown voices before known female ones
      if (v.lang.toLowerCase() === String(lang).toLowerCase()) score += 3;          // same accent as the page, all else equal
      if (score > bestScore) { best = v; bestScore = score; }
    }
    voiceCache = { key, voice: best };
    return best;
  }
  LL.pickVoice = pickVoice;
  // The voice list arrives late in Chrome: ask for it early so the first word already has the right voice.
  try { if (globalThis.speechSynthesis) { speechSynthesis.getVoices(); speechSynthesis.addEventListener('voiceschanged', () => { voiceCache = { key: '', voice: null }; }); } } catch (_) { /* no speech here */ }

  /** Speak with the browser's own voice. Returns false if it cannot. */
  function speakText(word, rate, onEnd) {
    const synth = globalThis.speechSynthesis;
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return false;
    try {
      const u = new SpeechSynthesisUtterance(String(word));
      const lang = (document.documentElement.lang || '').toLowerCase().startsWith('en') ? document.documentElement.lang : 'en-US';
      u.lang = lang;
      const voice = pickVoice(lang);
      if (voice) { u.voice = voice; u.lang = voice.lang || lang; }
      u.rate = rate;
      u.pitch = 0.95;
      let done = false;
      u.onend = u.onerror = () => { if (!done) { done = true; if (onEnd) onEnd(); } };
      synth.speak(u);
      return true;
    } catch (_) {
      return false;
    }
  }

  /* =====================================================================
   * Boot
   * ===================================================================== */

  const app = new App();
  LL.app = app;
  const boot = () => app.init().catch((error) => console.warn('[Glider] failed to start', error));
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();

