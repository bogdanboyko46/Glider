/* Settings for "Simplify hard text": the on/off switch, the size, and the optional Anthropic API key. */
(() => {
  'use strict';
  const SETTINGS_KEY = 'glider:simplify';
  const API_KEY_NAME = 'glider:anthropicKey';
  const DEFAULTS = { enabled: true, useClaude: true, scale: 1.2 };
  const $ = (id) => document.getElementById(id);
  const store = (() => { try { return chrome.storage.local; } catch (_) { return null; } })();
  const REASONS = {
    'no-key': 'No key is saved.', 'bad-key': 'Anthropic did not accept this key.', 'rate-limited': 'Rate limit reached. Try again in a moment.',
    timeout: 'Claude took too long to answer.', network: 'Could not reach Anthropic. Check the internet connection.',
    server: 'Anthropic had a temporary problem. Try again.', declined: 'Claude declined to rewrite this text.',
    rejected: 'Anthropic rejected the request.', 'bad-response': 'The answer could not be used.', 'too-short': 'The text is too short to simplify.',
  };

  let cfg = { ...DEFAULTS };
  let hasKey = false;

  function say(el, text, tone) { el.textContent = text; if (tone) el.dataset.tone = tone; else delete el.dataset.tone; }

  function render() {
    $('enabled').checked = cfg.enabled;
    $('useClaude').checked = cfg.useClaude;
    $('scale').value = String(Math.round(cfg.scale * 100));
    $('scale-label').textContent = Math.round(cfg.scale * 100) + '%';
    $('remove').hidden = !hasKey;
    $('key').placeholder = hasKey ? 'A key is saved. Paste a new one to replace it.' : 'sk-ant-…';
  }

  async function save(patch) {
    cfg = { ...cfg, ...patch };
    render();
    if (store) { try { await store.set({ [SETTINGS_KEY]: cfg }); } catch (_) { /* kept in memory */ } }
  }

  async function ask(text) {
    try { return await chrome.runtime.sendMessage({ type: 'glider:simplify', text }); }
    catch (_) { return { ok: false, reason: 'network' }; }
  }

  $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
  $('useClaude').addEventListener('change', (e) => save({ useClaude: e.target.checked }));
  $('scale').addEventListener('input', (e) => save({ scale: Number(e.target.value) / 100 }));

  $('save').addEventListener('click', async () => {
    const key = $('key').value.trim();
    const status = $('key-status');
    if (!key) { say(status, 'Paste a key first.', 'bad'); return; }
    if (!store) { say(status, 'Keys can only be saved inside the extension.', 'bad'); return; }
    await store.set({ [API_KEY_NAME]: key });
    hasKey = true;
    $('key').value = '';
    render();
    say(status, 'Saved. Checking it with a short test…');
    const reply = await ask('The enzyme is probably the most abundant protein on Earth, and it is famously inefficient.');
    if (reply && reply.ok) say(status, `The key works (Claude answered in ${(reply.ms / 1000).toFixed(1)} s).`, 'good');
    else say(status, 'Saved, but the test failed: ' + (REASONS[reply && reply.reason] || 'unknown error') + (reply && reply.detail ? ' ' + reply.detail : ''), 'bad');
  });

  $('remove').addEventListener('click', async () => {
    if (store) { try { await store.remove(API_KEY_NAME); } catch (_) { /* nothing to remove */ } }
    hasKey = false;
    render();
    say($('key-status'), 'Key removed. Glider simplifies on this device only.');
  });

  $('try').addEventListener('click', async () => {
    const text = $('sample').value.trim();
    const offline = globalThis.GliderSimplify.simplify(text);
    $('out-offline').hidden = false;
    $('out-offline').querySelector('p').textContent = offline.text || text;
    $('out-claude').hidden = true;
    if (!hasKey || !cfg.useClaude) { say($('try-status'), hasKey ? 'Claude is switched off above.' : 'Save a key above to also see Claude’s rewrite.'); return; }
    say($('try-status'), 'Asking Claude…');
    const reply = await ask(text);
    if (reply && reply.ok) {
      $('out-claude').hidden = false;
      $('out-claude').querySelector('p').textContent = reply.text;
      say($('try-status'), reply.cached ? 'Claude (from this session’s cache).' : `Claude answered in ${(reply.ms / 1000).toFixed(1)} s.`, 'good');
    } else say($('try-status'), REASONS[reply && reply.reason] || 'Claude could not be reached.', 'bad');
  });

  (async () => {
    if (store) {
      try {
        const got = await store.get([SETTINGS_KEY, API_KEY_NAME]);
        cfg = { ...DEFAULTS, ...(got[SETTINGS_KEY] && typeof got[SETTINGS_KEY] === 'object' ? got[SETTINGS_KEY] : {}) };
        hasKey = !!String(got[API_KEY_NAME] || '').trim();
      } catch (_) { /* defaults */ }
    }
    render();
  })();
})();
