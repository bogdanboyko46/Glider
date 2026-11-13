/* Settings for "Simplify hard text": the on/off switch, the size, and the rewrite service. No API key lives here. */
(() => {
  'use strict';
  const SETTINGS_KEY = 'glider:simplify';
  const SERVICE_KEY = 'glider:simplifyService';
  const DEFAULTS = { enabled: true, useClaude: true, scale: 1.2 };
  const SAMPLE = 'The enzyme is probably the most abundant protein on Earth, and it is famously inefficient.';
  const $ = (id) => document.getElementById(id);
  const store = (() => { try { return chrome.storage.local; } catch (_) { return null; } })();
  const REASONS = {
    'no-service': 'No rewrite service is set up yet.', timeout: 'The rewrite service took too long to answer.',
    network: 'Could not reach the rewrite service. Check the internet connection and the address.',
    'rate-limited': 'Too many rewrites in a short time. Try again in a few minutes.',
    forbidden: 'The service did not accept this extension.', unauthorized: 'The access code is wrong or missing.',
    'server-key': 'The service is missing its Anthropic key. This is a problem on the server.',
    upstream: 'Anthropic had a problem answering. Try again.', declined: 'Claude declined to rewrite this text.',
    'cut-off': 'The rewrite was cut off.', 'bad-response': 'The answer could not be used.', 'bad-request': 'The service rejected the text.',
    'too-short': 'The text is too short to simplify.', service: 'The rewrite service answered with an error.', error: 'Something went wrong.',
  };

  let cfg = { ...DEFAULTS };
  let status = { ready: false, url: '', builtIn: false };

  function say(el, text, tone) { el.textContent = text; if (tone) el.dataset.tone = tone; else delete el.dataset.tone; }
  const message = (m) => { try { return Promise.resolve(chrome.runtime.sendMessage(m)).catch(() => null); } catch (_) { return Promise.resolve(null); } };
  const ask = async (text) => (await message({ type: 'glider:simplify', text })) || { ok: false, reason: 'network' };

  function render() {
    $('enabled').checked = cfg.enabled;
    $('useClaude').checked = cfg.useClaude;
    $('scale').value = String(Math.round(cfg.scale * 100));
    $('scale-label').textContent = Math.round(cfg.scale * 100) + '%';
    $('service-state').textContent = status.ready
      ? 'Rewrite service is set.'
      : 'No rewrite service is set up yet, so Glider simplifies on this device only.';
  }

  async function refresh() {
    status = (await message({ type: 'glider:simplify:status' })) || { ready: false, url: '' };
    render();
  }

  async function save(patch) {
    cfg = { ...cfg, ...patch };
    render();
    if (store) { try { await store.set({ [SETTINGS_KEY]: cfg }); } catch (_) { /* kept in memory */ } }
  }

  $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
  $('useClaude').addEventListener('change', (e) => save({ useClaude: e.target.checked }));
  $('scale').addEventListener('input', (e) => save({ scale: Number(e.target.value) / 100 }));

  $('save').addEventListener('click', async () => {
    const url = $('url').value.trim(), token = $('token').value.trim();
    const out = $('key-status');
    if (url && !/^https?:\/\/\S+$/i.test(url)) { say(out, 'That does not look like a web address.', 'bad'); return; }
    if (!store) { say(out, 'This can only be saved inside the extension.', 'bad'); return; }
    if (url || token) await store.set({ [SERVICE_KEY]: { url, token } }); else await store.remove(SERVICE_KEY);
    await refresh();
    if (!status.ready) { say(out, 'Saved. No service address is set, so Glider simplifies on this device only.'); return; }
    say(out, 'Saved. Testing…');
    const reply = await ask(SAMPLE + ' ' + Date.now());   // unique text, so the answer is not from the cache
    if (reply.ok) say(out, `The service works (answered in ${(reply.ms / 1000).toFixed(1)} s).`, 'good');
    else say(out, 'Saved, but the test failed: ' + (REASONS[reply.reason] || REASONS.error), 'bad');
  });

  $('try').addEventListener('click', async () => {
    const text = $('sample').value.trim();
    const offline = globalThis.GliderSimplify.simplify(text);
    $('out-offline').hidden = false;
    $('out-offline').querySelector('p').textContent = offline.text || text;
    $('out-claude').hidden = true;
    if (!cfg.useClaude) { say($('try-status'), 'Claude rewrites are switched off above.'); return; }
    if (!status.ready) { say($('try-status'), REASONS['no-service']); return; }
    say($('try-status'), 'Asking Claude…');
    const reply = await ask(text);
    if (reply.ok) {
      $('out-claude').hidden = false;
      $('out-claude').querySelector('p').textContent = reply.text;
      say($('try-status'), reply.cached ? 'Claude (from this session’s cache).' : `Claude answered in ${(reply.ms / 1000).toFixed(1)} s.`, 'good');
    } else say($('try-status'), REASONS[reply.reason] || REASONS.error, 'bad');
  });

  (async () => {
    if (store) {
      try {
        const got = await store.get([SETTINGS_KEY, SERVICE_KEY]);
        cfg = { ...DEFAULTS, ...(got[SETTINGS_KEY] && typeof got[SETTINGS_KEY] === 'object' ? got[SETTINGS_KEY] : {}) };
        const svc = got[SERVICE_KEY];
        if (svc && typeof svc === 'object') { $('url').value = String(svc.url || ''); $('token').value = String(svc.token || ''); }
      } catch (_) { /* defaults */ }
    }
    render();
    await refresh();
  })();
})();
