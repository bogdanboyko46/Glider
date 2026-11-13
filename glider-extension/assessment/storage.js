/*
 * storage.js — persistence for the Reading Check. window.RCStorage.
 *
 * Raw sessions (large arrays) live in IndexedDB; the small history list and the
 * per-minute log live in chrome.storage.local. Every method is async and never
 * rejects: on any failure it warns and returns a safe default. Without
 * chrome.storage (page opened as a file) or without IndexedDB, an in-memory
 * fallback keeps the page working for as long as it stays open.
 *
 * Only numbers are stored. No video, no images.
 */
(function (root) {
  'use strict';

  const DB_NAME = 'glider-reading-check';
  const STORE = 'sessions';
  const HISTORY_KEY = 'rcHistory';
  const MINUTE_KEY = 'rcMinuteLog';
  const BASELINE_KEY = 'grBaseline';
  const HISTORY_CAP = 50;
  const IDB_TIMEOUT_MS = 4000;

  const warn = (what, e) => { try { console.warn('[reading-check] storage: ' + what, e); } catch (_) { /* no console */ } };

  // ------------------------------------------------- chrome.storage.local
  const mem = {};                      // fallback key/value store
  const memSessions = new Map();       // fallback (and mirror) session store

  function area() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) return chrome.storage.local;
    } catch (_) { /* not an extension page */ }
    return null;
  }

  async function kvGet(key) {
    const a = area();
    if (a) {
      try {
        const out = await a.get(key);
        return out ? out[key] : undefined;
      } catch (e) { warn('read ' + key, e); }
    }
    return mem[key];
  }

  async function kvSet(key, value) {
    mem[key] = value;
    const a = area();
    if (!a) return;
    try { await a.set({ [key]: value }); } catch (e) { warn('write ' + key, e); }
  }

  async function kvRemove(keys) {
    for (const k of keys) delete mem[k];
    const a = area();
    if (!a) return;
    try { await a.remove(keys); } catch (e) { warn('remove', e); }
  }

  // ------------------------------------------------------------ IndexedDB
  let dbPromise = null;

  /** Resolves with the database, or null when IndexedDB cannot be used. */
  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let settled = false;
      const finish = (db) => { if (!settled) { settled = true; clearTimeout(timer); resolve(db); } };
      const timer = setTimeout(() => { warn('IndexedDB open timed out'); finish(null); }, IDB_TIMEOUT_MS);
      try {
        if (typeof indexedDB === 'undefined' || !indexedDB) { finish(null); return; }
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          try {
            if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
          } catch (e) { warn('upgrade', e); }
        };
        req.onsuccess = () => {
          const db = req.result;
          try {
            db.onversionchange = () => { try { db.close(); } catch (_) { /* closing */ } dbPromise = null; };
            db.onclose = () => { dbPromise = null; };
          } catch (_) { /* handlers are optional */ }
          if (settled) { try { db.close(); } catch (_) { /* late open */ } return; }
          finish(db);
        };
        req.onerror = () => { warn('IndexedDB open failed', req.error); finish(null); };
        req.onblocked = () => { warn('IndexedDB open blocked'); finish(null); };
      } catch (e) { warn('IndexedDB unavailable', e); finish(null); }
    }).then((db) => { if (!db) dbPromise = null; return db; });
    return dbPromise;
  }

  /** Run one request in a transaction. Resolves with its result, or `fallback` on any failure. */
  async function idb(mode, work, fallback) {
    const db = await openDb();
    if (!db) return fallback;
    return new Promise((resolve) => {
      let result = fallback, settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      try {
        const tx = db.transaction(STORE, mode);
        const req = work(tx.objectStore(STORE));
        if (req) req.onsuccess = () => { result = req.result; };
        tx.oncomplete = () => finish(result);
        tx.onerror = () => { warn('transaction failed', tx.error); finish(fallback); };
        tx.onabort = () => { warn('transaction aborted', tx.error); finish(fallback); };
      } catch (e) { warn('transaction', e); dbPromise = null; finish(fallback); }
    });
  }

  const FAILED = {};   // sentinel: distinguishes "failed" from "nothing stored"

  // ------------------------------------------------------------- sessions
  async function saveSession(session) {
    try {
      if (!session || typeof session !== 'object' || session.id == null) return false;
      memSessions.set(session.id, session);
      const res = await idb('readwrite', (s) => s.put(session), FAILED);
      return res !== FAILED;
    } catch (e) { warn('saveSession', e); return false; }
  }

  async function getSession(id) {
    try {
      if (id == null) return null;
      const res = await idb('readonly', (s) => s.get(id), FAILED);
      if (res && res !== FAILED) return res;
      return memSessions.get(id) || null;
    } catch (e) { warn('getSession', e); return null; }
  }

  async function getLatestSession() {
    try {
      const res = await idb('readonly', (s) => s.getAll(), FAILED);
      const all = Array.isArray(res) ? res.slice() : [];
      for (const s of memSessions.values()) if (!all.some((x) => x && x.id === s.id)) all.push(s);
      let best = null;
      for (const s of all) {
        if (!s || typeof s !== 'object') continue;
        if (!best || (Number(s.startedAt) || 0) >= (Number(best.startedAt) || 0)) best = s;
      }
      return best;
    } catch (e) { warn('getLatestSession', e); return null; }
  }

  // -------------------------------------------------------------- history
  const byTime = (a, b) => (Number(a.startedAt) || 0) - (Number(b.startedAt) || 0);

  async function getHistory() {
    try {
      const list = await kvGet(HISTORY_KEY);
      return Array.isArray(list) ? list.filter((x) => x && typeof x === 'object').sort(byTime) : [];
    } catch (e) { warn('getHistory', e); return []; }
  }

  async function addSummary(summary) {
    try {
      if (!summary || typeof summary !== 'object') return false;
      const list = (await getHistory()).filter((x) => x.id !== summary.id);
      list.push(summary);
      list.sort(byTime);
      await kvSet(HISTORY_KEY, list.slice(-HISTORY_CAP));
      return true;
    } catch (e) { warn('addSummary', e); return false; }
  }

  async function getMinuteLog() {
    try {
      const rows = await kvGet(MINUTE_KEY);
      return Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
    } catch (e) { warn('getMinuteLog', e); return []; }
  }

  /** The tracker's own reading-pace baseline. Read-only here. */
  async function getBaseline() {
    try {
      const b = await kvGet(BASELINE_KEY);
      return b && typeof b === 'object' ? b : null;
    } catch (e) { warn('getBaseline', e); return null; }
  }

  /** Clears everything the Reading Check stored. The tracker's grBaseline / grCalib are left alone. */
  async function deleteAll() {
    try {
      memSessions.clear();
      await idb('readwrite', (s) => s.clear(), FAILED);
      await kvRemove([HISTORY_KEY, MINUTE_KEY]);
      return true;
    } catch (e) { warn('deleteAll', e); return false; }
  }

  root.RCStorage = { saveSession, getSession, getLatestSession, getHistory, addSummary, getMinuteLog, getBaseline, deleteAll };
})(typeof globalThis !== 'undefined' ? globalThis : this);
