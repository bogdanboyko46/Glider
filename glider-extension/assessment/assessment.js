/*
 * assessment.js — the Reading Check page's router.
 *
 *   assessment.html            live check: intro -> calibrate -> read -> questions -> dashboard
 *   assessment.html?demo=1     full dashboard from a simulated session, no camera
 *   assessment.html?last=1     dashboard of the most recent saved check
 *
 * The pieces: RCFlow (flow.js) records a session, RCAnalytics (analytics.js)
 * turns it into metrics, RCDashboard (dashboard.js) draws them, RCStorage and
 * RCSettingsBridge persist. This file only wires them and guarantees that an
 * unexpected failure ends on a friendly panel, never a blank page.
 */
(() => {
  'use strict';
  const root = document.getElementById('rc-root');
  const params = new URLSearchParams(location.search);
  const W = window;
  const safe = async (fn, fallback) => { try { return await fn(); } catch (e) { console.warn('[reading-check]', e); return fallback; } };

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function go(query) { location.href = location.pathname + (query ? '?' + query : ''); }

  function fallback(title, detail) {
    root.replaceChildren();
    const card = el('section', 'rc-card rc-fallback');
    card.append(el('h1', '', title), el('p', '', detail));
    const actions = el('div', 'rc-actions');
    const again = el('button', 'rc-btn rc-btn--primary', 'Start again');
    again.type = 'button';
    again.addEventListener('click', () => go(''));
    const demo = el('button', 'rc-btn', 'View the demo');
    demo.type = 'button';
    demo.addEventListener('click', () => go('demo=1'));
    actions.append(again, demo);
    card.append(actions);
    root.append(card);
  }

  // ------------------------------------------------------------- dashboard
  async function showDashboard(session, { demo = false, save = false } = {}) {
    const analysis = W.RCAnalytics.analyze(session);
    let history = [], minuteLog = [], baseline = null;
    if (demo) {
      history = W.RCDemo.makeHistory(4).map((s) => W.RCAnalytics.summarize(s, W.RCAnalytics.analyze(s)));
      minuteLog = W.RCDemo.makeMinuteLog();
    } else if (W.RCStorage) {
      if (save) {
        await safe(() => W.RCStorage.saveSession(session));
        await safe(() => W.RCStorage.addSummary(W.RCAnalytics.summarize(session, analysis)));
      }
      history = (await safe(() => W.RCStorage.getHistory(), [])) || [];
      minuteLog = (await safe(() => W.RCStorage.getMinuteLog(), [])) || [];
      baseline = await safe(() => W.RCStorage.getBaseline(), null);
    }
    history = history.filter((h) => h && h.id !== session.id && h.ok !== false)
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));

    root.replaceChildren();
    W.scrollTo(0, 0);
    W.RCDashboard.render(root, {
      session, analysis, history, minuteLog, baseline, demo,
      onRetake: () => go(''),
      onDelete: async () => { if (W.RCStorage) await safe(() => W.RCStorage.deleteAll()); go(''); },
      onApplySettings: (patch) => (W.RCSettingsBridge
        ? W.RCSettingsBridge.apply(patch)
        : Promise.resolve({ applied: {}, skipped: Object.keys(patch || {}) })),
    });
    try { performance.mark('rc-dashboard-rendered'); } catch (_) { /* timing is optional */ }
  }

  async function loadDemoSession() {
    const fetched = await safe(async () => {
      const r = await fetch('demo-session.json');
      if (!r.ok) throw new Error('demo-session.json: ' + r.status);
      return r.json();
    }, null);
    // file:// pages cannot fetch; the generator rebuilds the identical session in the page.
    return fetched && Array.isArray(fetched.gaze) ? fetched : W.RCDemo.makeSession(W.RCDemo.DEMO_OPTIONS).session;
  }

  /* ?demo=sparse | noframes | poor show how the dashboard degrades (used by tests and to rehearse the pitch). */
  function demoVariant(kind) {
    const make = (o) => W.RCDemo.makeSession(Object.assign({}, W.RCDemo.DEMO_OPTIONS, o)).session;
    if (kind === 'sparse') return make({ maxFixations: 9 });
    if (kind === 'noframes') return Object.assign(make({}), { frames: [] });
    if (kind === 'poor') {
      return Object.assign(make({ fps: 13, noiseX: 16, noiseY: 14, faceLostMs: 5000,
        accuracy: { accuracyX: 90, accuracyY: 84, precisionX: 46, precisionY: 40, effX: 92, effY: 86, recommendedLinePitchPx: 120 } }), { lowQuality: true });
    }
    return null;
  }

  // ----------------------------------------------------------------- start
  async function main() {
    if (params.has('demo')) {
      await showDashboard(demoVariant(params.get('demo')) || await loadDemoSession(), { demo: true });
      return;
    }
    if (params.has('last') && W.RCStorage) {
      const lastSession = await safe(() => W.RCStorage.getLatestSession(), null);
      if (lastSession) { await showDashboard(lastSession); return; }
    }
    root.replaceChildren();
    W.RCFlow.start(root, {
      onComplete: (session) => {
        showDashboard(session, { save: true }).catch((e) => {
          console.error('[reading-check] dashboard failed', e);
          fallback('The results could not be shown', 'Your reading data was saved on this device. You can start again or look at the demo.');
        });
      },
      onDemo: () => go('demo=1'),
    });
  }

  main().catch((e) => {
    console.error('[reading-check] failed to start', e);
    fallback('Something went wrong', 'The Reading Check could not start. Nothing was recorded.');
  });
})();
