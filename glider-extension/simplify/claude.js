/*
 * claude.js — asks Glider's rewrite service (the proxy in /proxy) for a simpler version of a
 * hard paragraph. Loaded into the background service worker with importScripts(); content
 * scripts and the options page reach it with chrome.runtime.sendMessage.
 *
 *   { type: 'glider:simplify', text, lineText? }  ->  { ok: true, text, ms, model } | { ok: false, reason }
 *   { type: 'glider:simplify:status' }            ->  { ready: bool, url }
 *
 * The extension holds no API key. The proxy holds the Anthropic key, the model name and the
 * prompt; the extension sends it one paragraph and gets the rewrite back. This is the only
 * network call Glider makes. With no service address set, every request answers
 * { ok: false, reason: 'no-service' } and the offline simplifier's text stays in place.
 */
(() => {
  'use strict';
  /* The deployed proxy, e.g. 'https://glider-simplify.vercel.app/api/simplify'. Empty = offline only.
     The options page can override it (chrome.storage.local 'glider:simplifyService' = { url, token }). */
  const DEFAULT_SERVICE_URL = '';
  const DEFAULT_SERVICE_TOKEN = '';
  const SERVICE_KEY = 'glider:simplifyService';
  const INSTALL_KEY = 'glider:installId';
  const LEGACY_KEY = 'glider:anthropicKey';   // from the short-lived bring-your-own-key build
  const TIMEOUT_MS = 28000;
  const MAX_CHARS = 6000;

  const cache = new Map();   // passage -> rewritten text, for the life of the service worker
  try { chrome.storage.local.remove(LEGACY_KEY); } catch (_) { /* nothing stored */ }

  async function service() {
    let saved = null;
    try { saved = (await chrome.storage.local.get(SERVICE_KEY))[SERVICE_KEY]; } catch (_) { /* defaults */ }
    const url = String((saved && saved.url) || DEFAULT_SERVICE_URL).trim();
    const token = String((saved && saved.token) || DEFAULT_SERVICE_TOKEN).trim();
    return { url: /^https?:\/\/\S+$/i.test(url) ? url : '', token };
  }

  /** A random id for this install, so the service can rate-limit one browser without knowing who it is. */
  async function installId() {
    try {
      const got = (await chrome.storage.local.get(INSTALL_KEY))[INSTALL_KEY];
      if (typeof got === 'string' && got.length >= 8) return got;
      const id = crypto.randomUUID();
      await chrome.storage.local.set({ [INSTALL_KEY]: id });
      return id;
    } catch (_) { return ''; }
  }

  async function rewrite(text, lineText) {
    const passage = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
    if (passage.length < 20) return { ok: false, reason: 'too-short' };
    const { url, token } = await service();
    if (!url) return { ok: false, reason: 'no-service' };
    if (cache.has(passage)) return { ok: true, text: cache.get(passage), ms: 0, cached: true };

    const started = Date.now();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    let response;
    try {
      const headers = { 'content-type': 'application/json' };
      const id = await installId();
      if (id) headers['x-glider-install'] = id;
      if (token) headers['x-glider-token'] = token;
      response = await fetch(url, {
        method: 'POST', signal: abort.signal, headers, credentials: 'omit', cache: 'no-store',
        body: JSON.stringify({ text: passage, lineText: String(lineText || '').replace(/\s+/g, ' ').trim().slice(0, 400) }),
      });
    } catch (e) {
      return { ok: false, reason: e && e.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await response.json(); } catch (_) { /* not JSON */ }
    if (!data || typeof data !== 'object') return { ok: false, reason: response.ok ? 'bad-response' : 'service', status: response.status };
    if (!data.ok || typeof data.text !== 'string' || !data.text.trim()) {
      return { ok: false, reason: typeof data.reason === 'string' ? data.reason : 'service', status: response.status };
    }
    const out = data.text.replace(/\s+/g, ' ').trim();
    if (out.length > 2.5 * passage.length + 200) return { ok: false, reason: 'bad-response' };
    if (cache.size > 200) cache.clear();
    cache.set(passage, out);
    return { ok: true, text: out, ms: Date.now() - started, model: data.model || null };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;
    if (message.type === 'glider:simplify:status') {
      service().then((s) => sendResponse({ ready: !!s.url, url: s.url, builtIn: !!DEFAULT_SERVICE_URL }), () => sendResponse({ ready: false, url: '' }));
      return true;
    }
    if (message.type !== 'glider:simplify' || typeof message.text !== 'string') return undefined;
    rewrite(message.text, message.lineText).then(sendResponse, () => sendResponse({ ok: false, reason: 'error' }));
    return true;   // answered asynchronously
  });
})();
