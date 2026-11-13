/* Settings for "Simplify hard text": on/off, size, and whether Claude rewrites are used. Nothing technical lives here:
   the address of the rewrite service is built into simplify/claude.js. */
(() => {
  'use strict';
  const SETTINGS_KEY = 'glider:simplify';
  const DEFAULTS = { enabled: true, useClaude: true, scale: 1.2 };
  const $ = (id) => document.getElementById(id);
  const store = (() => { try { return chrome.storage.local; } catch (_) { return null; } })();
  /* Plain words for the reader; the technical reason goes to the console for whoever is debugging. */
  const TRY_LATER = 'Claude could not be reached just now. The simpler version above was made on this device.';
  const REASONS = {
    'rate-limited': 'That was a lot of rewrites in a short time. Try again in a few minutes.',
    declined: 'Claude could not rewrite this text.', 'too-short': 'The text is too short to simplify.',
    'bad-request': 'This text is too long or too short to rewrite.',
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
      ? 'On: a better rewrite follows the quick one.'
      : 'Not available right now. Glider still simplifies on this device.';
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

  $('try').addEventListener('click', async () => {
    const text = $('sample').value.trim();
    const offline = globalThis.GliderSimplify.simplify(text);
    $('out-offline').hidden = false;
    $('out-offline').querySelector('p').textContent = offline.text || text;
    $('out-claude').hidden = true;
    if (!cfg.useClaude) { say($('try-status'), 'Claude rewrites are switched off above.'); return; }
    if (!status.ready) { say($('try-status'), 'Claude rewrites are not available right now.'); return; }
    say($('try-status'), 'Asking Claude…');
    const reply = await ask(text);
    if (reply.ok) {
      $('out-claude').hidden = false;
      $('out-claude').querySelector('p').textContent = reply.text;
      say($('try-status'), reply.cached ? 'Claude (from this session’s cache).' : `Claude answered in ${(reply.ms / 1000).toFixed(1)} s.`, 'good');
    } else { console.warn('[glider] rewrite failed:', reply.reason, reply.status || ''); say($('try-status'), REASONS[reply.reason] || TRY_LATER, 'bad'); }
  });

  (async () => {
    if (store) {
      try {
        const got = await store.get(SETTINGS_KEY);
        cfg = { ...DEFAULTS, ...(got[SETTINGS_KEY] && typeof got[SETTINGS_KEY] === 'object' ? got[SETTINGS_KEY] : {}) };
      } catch (_) { /* defaults */ }
    }
    render();
    await refresh();
  })();
})();
