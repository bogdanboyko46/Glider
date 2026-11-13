/* Glider toolbar popup.
 *
 * A small companion to the in-page dock. It never talks to the page about
 * settings: it rewrites the one settings object in chrome.storage.local and
 * the content script reacts to the storage change by itself.
 */
(() => {
  'use strict';

  /* ---- These mirror content/content.js. Keep in sync. ---- */

  const SETTINGS_KEY = 'glider:settings:v2';

  const DEFAULTS = Object.freeze({
    on: true,
    dockVisible: true,
    skin: 'sage',
    fontSize: 100,
    letterSpacing: 1,
    wordSpacing: 3,
    lineHeight: 1.8,
    mirror: false,
    font: false,
    gaze: false,
    gazeSensitivity: 3,
    showLevels: true,
    showDefinitions: false,
    showWordParts: true,
    dockMode: 'float',
  });

  /* Light normalisation only; the content script does the strict sanitising. */
  function normalise(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const s = {};
    for (const key of Object.keys(DEFAULTS)) s[key] = key in src ? src[key] : DEFAULTS[key];
    for (const key of ['on', 'dockVisible', 'mirror', 'font', 'gaze', 'showLevels', 'showDefinitions', 'showWordParts']) s[key] = !!s[key];
    if (s.dockMode !== 'edge') s.dockMode = 'float';
    s.skin = DEFAULTS.skin;
    return s;
  }

  /* ------------------------------------------------------------- platform */

  const hasStorage = (() => {
    try { return typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.local; }
    catch (_) { return false; }
  })();
  const hasTabs = (() => {
    try { return typeof chrome !== 'undefined' && !!chrome.tabs && !!chrome.tabs.query; }
    catch (_) { return false; }
  })();

  /* Outside the extension (popup.html opened as a file) settings live in
     memory, so the UI still renders and is clickable. Query parameters set
     up a state for screenshots: ?skin=flow&off&blocked */
  const params = new URLSearchParams(location.search);
  let memory = { ...DEFAULTS };
  if (!hasStorage) {
    if (params.has('off')) memory.on = false;
  }

  async function loadSettings() {
    if (!hasStorage) return normalise(memory);
    try { return normalise((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]); }
    catch (_) { return normalise(memory); }
  }

  async function saveSettings(next) {
    memory = next;
    if (!hasStorage) return;
    try { await chrome.storage.local.set({ [SETTINGS_KEY]: next }); }
    catch (_) { /* storage unavailable: the popup keeps working from memory */ }
  }

  /** True when the content script answers in the active tab. */
  async function pageReachable() {
    if (!hasTabs) return !params.has('blocked');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || typeof tab.id !== 'number') return false;
      const reply = await chrome.tabs.sendMessage(tab.id, { type: 'glider:ping' });
      return !!(reply && reply.ok);
    } catch (_) {
      return false; // chrome:// pages, the Web Store, or a tab opened before install
    }
  }

  /* ------------------------------------------------------------------- UI */

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));

  const root = $('.pop');
  let state = normalise(memory);

  function render() {
    const s = state;
    root.dataset.skin = s.skin;
    for (const sw of $$('[data-toggle]')) sw.setAttribute('aria-checked', String(!!s[sw.dataset.toggle]));
    $('#status').textContent = s.on ? 'On for every page' : 'Off. Pages are untouched';
    $('.rows').dataset.muted = String(!s.on);
    $('#gaze-calibrate').hidden = !(s.on && s.gaze);
  }

  /* Read, merge with defaults, patch, write the whole object back. */
  async function update(patch) {
    const next = normalise({ ...(await loadSettings()), ...patch });
    state = next;
    render();
    await saveSettings(next);
  }

  /* --------------------------------------------------------------- events */

  for (const sw of $$('[data-toggle]')) {
    sw.addEventListener('click', () => {
      const key = sw.dataset.toggle;
      update({ [key]: !state[key] });
    });
  }

  /* Calibration happens in the page, so hand over to it and get out of the way. */
  $('#gaze-calibrate').addEventListener('click', async () => {
    if (!hasTabs) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && typeof tab.id === 'number') await chrome.tabs.sendMessage(tab.id, { type: 'gaze:calibrate' });
    } catch (_) { /* the page cannot be reached: nothing to calibrate */ }
    window.close();
  });

  /* The Reading Check is its own extension page: a two-minute read and a dashboard. */
  $('#reading-check').addEventListener('click', () => {
    const page = 'assessment/assessment.html';
    try {
      const url = chrome.runtime.getURL(page);
      if (hasTabs && chrome.tabs.create) chrome.tabs.create({ url }); else window.open(url, '_blank');
    } catch (_) { window.open('../' + page, '_blank'); }
    window.close();
  });

  /* The Glider page: saved words, analytics, settings and account. The service
     worker reuses a tab that already shows it. */
  $('#glider-page').addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'glider:open-page', section: '' });
    } catch (_) { window.open('../home/home.html', '_blank'); }
    window.close();
  });

  if (hasStorage) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[SETTINGS_KEY]) return;
        state = normalise(changes[SETTINGS_KEY].newValue);
        memory = state;
        render();
      });
    } catch (_) { /* no live sync available */ }
  }

  /* ----------------------------------------------------------------- init */

  (async () => {
    render();
    const [settings, reachable] = await Promise.all([loadSettings(), pageReachable()]);
    state = settings;
    render();
    $('#note').hidden = reachable;
    // Transitions switch on only after the saved state has been painted.
    requestAnimationFrame(() => requestAnimationFrame(() => { root.dataset.ready = 'true'; }));
  })();
})();
