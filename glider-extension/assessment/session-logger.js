/*
 * session-logger.js — content script, loaded after gaze/gaze-reader.js.
 *
 * While the eye tracker is running on a normal page it appends one row per
 * minute of active reading to chrome.storage.local 'rcMinuteLog', which feeds
 * the Reading Check's "Over time" chart:
 *   { t, min, blinkRate, meanFixMs, regressionRate, fixations }
 * Inert when the tracker is off: no timers, it only reacts to tracker events.
 * Numbers only; nothing about the page or its text is stored.
 */
(function () {
  'use strict';
  if (window.__rcSessionLogger) return;
  let store = null;
  try {
    if (!window.GazeReader || typeof window.GazeReader.on !== 'function') return;
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return;
    store = chrome.storage.local;
  } catch (_) { return; }
  window.__rcSessionLogger = true;

  const KEY = 'rcMinuteLog';
  const CAP = 240;
  const MINUTE_MS = 60000;
  const MIN_FIXATIONS = 20;
  const MAX_STEP_MS = 2000;      // a longer gap between events is a pause, not reading time
  const CHUNK_GAP_MS = 60;       // chunks of one long fixation follow each other this closely…
  const CHUNK_DIST_PX = 60;      // …and stay this close together
  const BLINK_MERGE_MS = 100;

  let began = 0;                 // Date.now() when logging began on this page
  let lastT = 0;                 // last event time (performance.now clock)
  let active = 0;                // ms of active tracking in the current minute
  let open = null;               // merged fixation still growing { x, y, t, end, dur }
  let prev = null;               // last completed merged fixation
  let fixations = 0, fixMs = 0, pairs = 0, regressions = 0, blinks = 0;
  let run = null;                // blink run in progress { t0, t1, n }
  let held = null;               // finished blink run, waiting to see if the next one merges
  let writing = false;

  const hidden = () => { try { return document.hidden; } catch (_) { return false; } };

  function closeFixation() {
    if (!open) return;
    fixations++;
    fixMs += open.dur;
    if (prev && open.t - prev.end < MAX_STEP_MS) {
      const dx = open.x - prev.x, dy = open.y - prev.y;
      const returnSweep = dx < -160 && dy > 20;
      pairs++;
      if (dx < -80 && Math.abs(dy) < 60 && !returnSweep) regressions++;
    }
    prev = open;
    open = null;
  }

  function countHeld() {
    if (held && held.n >= 2) blinks++;
    held = null;
  }
  /** A blink run ended: merge it into the one just before it, or hold it for the next. */
  function endRun() {
    if (!run) return;
    if (held && run.t0 - held.t1 < BLINK_MERGE_MS) { held.t1 = run.t1; held.n += run.n; }
    else { countHeld(); held = run; }
    run = null;
  }

  function reset() {
    active = 0; fixations = 0; fixMs = 0; pairs = 0; regressions = 0; blinks = 0;
  }

  async function append(row) {
    if (writing) return;
    writing = true;
    try {
      const got = await store.get(KEY);
      const rows = got && Array.isArray(got[KEY]) ? got[KEY] : [];
      rows.push(row);
      await store.set({ [KEY]: rows.slice(-CAP) });
    } catch (_) { /* storage unavailable or the extension was reloaded: skip this row */ }
    writing = false;
  }

  function flush() {
    closeFixation();
    endRun();
    countHeld();
    const minutes = active / MINUTE_MS;
    if (fixations >= MIN_FIXATIONS && minutes > 0) {
      append({
        t: Date.now(),
        min: Math.max(1, Math.round((Date.now() - began) / MINUTE_MS)),
        blinkRate: Math.round((blinks / minutes) * 10) / 10,
        meanFixMs: Math.round(fixMs / fixations),
        regressionRate: pairs ? Math.round((regressions / pairs) * 1000) / 1000 : 0,
        fixations,
      });
    }
    reset();
  }

  /** Advance the active-time clock; returns false while the tab is hidden. */
  function tick(t) {
    if (!Number.isFinite(t)) return false;
    if (hidden()) { lastT = t; return false; }
    if (!began) began = Date.now();
    const dt = t - lastT;
    if (lastT && dt > 0 && dt < MAX_STEP_MS) active += dt;
    lastT = t;
    if (active >= MINUTE_MS) flush();
    return true;
  }

  function onFixation(f) {
    try {
      if (!f || !Number.isFinite(f.x) || !Number.isFinite(f.y) || !Number.isFinite(f.t)) return;
      const dur = Number.isFinite(f.dur) ? f.dur : 0;
      if (!tick(f.t + dur)) return;
      if (open && f.t - open.end <= CHUNK_GAP_MS && Math.hypot(f.x - open.x, f.y - open.y) <= CHUNK_DIST_PX) {
        const total = open.dur + dur || 1;
        open.x = (open.x * open.dur + f.x * dur) / total;
        open.y = (open.y * open.dur + f.y * dur) / total;
        open.end = f.t + dur;
        open.dur += dur;
        return;
      }
      closeFixation();
      open = { x: f.x, y: f.y, t: f.t, end: f.t + dur, dur };
    } catch (_) { /* never disturb the page */ }
  }

  function onFrame(fr) {
    try {
      if (!fr || !tick(fr.t)) return;
      if (fr.face && fr.blink) {
        if (run) { run.t1 = fr.t; run.n++; } else run = { t0: fr.t, t1: fr.t, n: 1 };
      } else if (run) {
        endRun();
      } else if (held && fr.t - held.t1 >= BLINK_MERGE_MS) {
        countHeld();
      }
    } catch (_) { /* never disturb the page */ }
  }

  try {
    window.GazeReader.on('fixation', onFixation);
    window.GazeReader.on('frame', onFrame);
  } catch (_) { /* older tracker build: stay inert */ }
})();
