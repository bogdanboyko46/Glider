/*
 * settings-bridge.js — "Apply recommended settings". window.RCSettingsBridge.
 *
 * Writes into the extension's one settings object ('glider:settings:v2' in
 * chrome.storage.local); the content script reacts to the storage change by
 * itself. Mirrors DEFAULTS / LIMITS in content/content.js and popup/popup.js.
 *
 *   apply(patch)    -> Promise<{ applied: {key: value}, skipped: [key] }>   never rejects
 *   describe(patch) -> [{ key, label, value, raw }]                          value is display text
 *
 * Only known keys are touched, numbers are clamped to the sliders' ranges, and
 * a numeric setting the reader already has higher is never lowered.
 */
(function (root) {
  'use strict';

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
  });

  const NUMERIC = {
    fontSize: { min: 100, max: 160, step: 10, format: (v) => v + '%' },
    letterSpacing: { min: 0, max: 4, step: 0.5, format: (v) => v + ' px' },
    wordSpacing: { min: 0, max: 10, step: 1, format: (v) => v + ' px' },
    lineHeight: { min: 1.4, max: 2.4, step: 0.1, format: (v) => Number(v).toFixed(1) },
  };
  const BOOLEAN = ['on', 'mirror', 'font', 'gaze'];

  const LABELS = {
    lineHeight: 'Line spacing',
    letterSpacing: 'Letter spacing',
    wordSpacing: 'Word spacing',
    fontSize: 'Text size',
    on: 'Reading lens',
    gaze: 'Eye-tracking help',
    font: 'Atkinson font',
    mirror: 'Colour b d p q',
  };

  function toBool(v) {
    if (typeof v === 'string') return !/^(|0|false|off|no)$/i.test(v.trim());
    return !!v;
  }

  /** Clamp to the slider's range and snap to its step. Returns null for non-numbers. */
  function toNumber(key, v) {
    const lim = NUMERIC[key];
    const n = typeof v === 'boolean' || v === null || v === '' ? NaN : Number(v);
    if (!Number.isFinite(n)) return null;
    const clamped = Math.min(lim.max, Math.max(lim.min, n));
    const snapped = lim.min + Math.round((clamped - lim.min) / lim.step) * lim.step;
    return Math.min(lim.max, Math.round(snapped * 100) / 100);
  }

  /** Split a patch into the keys we can set (sanitised) and the ones we cannot. */
  function sanitise(patch) {
    const clean = {}, skipped = [];
    if (!patch || typeof patch !== 'object') return { clean, skipped };
    for (const key of Object.keys(patch)) {
      if (NUMERIC[key]) {
        const n = toNumber(key, patch[key]);
        if (n === null) skipped.push(key); else clean[key] = n;
      } else if (BOOLEAN.includes(key)) {
        clean[key] = toBool(patch[key]);
      } else {
        skipped.push(key);
      }
    }
    return { clean, skipped };
  }

  function storageArea() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) return chrome.storage.local;
    } catch (_) { /* not an extension page */ }
    return null;
  }

  async function apply(patch) {
    let clean = {}, skipped = [];
    try { ({ clean, skipped } = sanitise(patch)); } catch (e) { return { applied: {}, skipped: [] }; }
    const area = storageArea();
    if (!area || !Object.keys(clean).length) return { applied: clean, skipped };
    try {
      const stored = (await area.get(SETTINGS_KEY))[SETTINGS_KEY];
      const current = Object.assign({}, DEFAULTS, stored && typeof stored === 'object' ? stored : {});
      const applied = {};
      for (const key of Object.keys(clean)) {
        let value = clean[key];
        if (NUMERIC[key]) {
          const have = toNumber(key, current[key]);
          if (have !== null && have > value) value = have;    // never lower what the reader chose
        }
        current[key] = value;
        applied[key] = value;
      }
      await area.set({ [SETTINGS_KEY]: current });
      return { applied, skipped };
    } catch (e) {
      try { console.warn('[reading-check] could not write settings', e); } catch (_) { /* no console */ }
      return { applied: {}, skipped: skipped.concat(Object.keys(clean)) };
    }
  }

  function describe(patch) {
    try {
      const { clean } = sanitise(patch);
      return Object.keys(clean).map((key) => ({
        key,
        label: LABELS[key] || key,
        value: NUMERIC[key] ? NUMERIC[key].format(clean[key]) : (clean[key] ? 'On' : 'Off'),
        raw: clean[key],
      }));
    } catch (_) { return []; }
  }

  root.RCSettingsBridge = { apply, describe, SETTINGS_KEY, LABELS };
})(typeof globalThis !== 'undefined' ? globalThis : this);
