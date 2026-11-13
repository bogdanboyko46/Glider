/*
 * dashboard.js — the Reading Check results page. Classic script, no dependencies.
 *
 *   RCDashboard.render(rootEl, { session, analysis, history, minuteLog, baseline, demo,
 *                                onRetake, onDelete, onApplySettings })
 *   RCDashboard.destroy()
 *
 * Also defines RCCharts.util, the small DOM/SVG toolkit the chart files use. Charts only
 * read it inside their render(), so script order between charts and this file is free.
 * Everything that comes from the session or the analysis is written with textContent.
 */
(function () {
  'use strict';
  const RC = (window.RCCharts = window.RCCharts || {});
  const SVGNS = 'http://www.w3.org/2000/svg';
  const DASH = '—';
  const fin = Number.isFinite;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const NOOP = () => {};

  // ------------------------------------------------------------------ toolkit
  function setAttrs(el, attrs, svg) {
    if (!attrs) return;
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'text') el.textContent = String(v);
      else if (k === 'class') { if (svg) el.setAttribute('class', v); else el.className = v; }
      else if (k === 'on') { for (const ev of Object.keys(v)) el.addEventListener(ev, v[ev]); }
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  function addKids(el, kids) {
    if (kids == null) return;
    for (const c of [].concat(kids)) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
  }
  function h(tag, attrs, kids) { const el = document.createElement(tag); setAttrs(el, attrs, false); addKids(el, kids); return el; }
  function svg(tag, attrs, parent) { const el = document.createElementNS(SVGNS, tag); setAttrs(el, attrs, true); if (parent) parent.appendChild(el); return el; }

  const ICONS = {
    check: ['M5 12.5l4.5 4.5L19 7.5'],
    clock: ['M12 7.5V12l3 2', [12, 12, 8.5]],
    back: ['M9 6l-5 5 5 5', 'M4 11h11a5 5 0 0 1 0 10h-3'],
    dots: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
    line: ['M4 7h16', 'M4 12h10', 'M4 17h16'],
    question: [[12, 12, 8.5], 'M9.6 9.6a2.5 2.5 0 1 1 3.6 2.2c-.8.5-1.2 1-1.2 1.8', 'M12 16.8h.01'],
    eye: ['M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z', [12, 12, 2.8]],
    target: [[12, 12, 8.5], [12, 12, 4.5], 'M12 12h.01'],
    info: [[12, 12, 8.5], 'M12 11v5.5', 'M12 7.8h.01'],
    alert: ['M12 4l9 15.5H3L12 4z', 'M12 10v4.5', 'M12 17h.01'],
    fair: [[12, 12, 8.5], 'M8 12h8'],
    play: ['M8 5.5v13l11-6.5z'],
    pause: ['M8.5 6v12', 'M15.5 6v12'],
    download: ['M12 4v11', 'M7.5 11l4.5 4.5 4.5-4.5', 'M5 19.5h14'],
    trash: ['M5 7h14', 'M9.5 7V4.5h5V7', 'M7 7l1 12.5h8L17 7'],
    refresh: ['M19.5 12a7.5 7.5 0 1 1-2.2-5.3', 'M19.5 4.5V9H15'],
    up: ['M12 19V5', 'M6 11l6-6 6 6'],
    down: ['M12 5v14', 'M6 13l6 6 6-6'],
    same: ['M5 9.5h14', 'M5 14.5h14'],
    within: ['M4 12h16', 'M4 8v8', 'M20 8v8', [12, 12, 2.2]],
    settings: ['M4 7h10', 'M18 7h2', 'M4 17h2', 'M10 17h10', [16, 7, 2], [8, 17, 2]],
  };
  function icon(name, size) {
    const s = size || 18;
    const el = svg('svg', { class: 'rcd-icon rcd-icon--' + name, viewBox: '0 0 24 24', width: s, height: s, 'aria-hidden': 'true', focusable: 'false' });
    for (const p of ICONS[name] || ICONS.info) {
      if (typeof p === 'string') svg('path', { d: p }, el);
      else svg('circle', { cx: p[0], cy: p[1], r: p[2] }, el);
    }
    return el;
  }

  function ticks(lo, hi, n) {
    if (!fin(lo) || !fin(hi) || hi <= lo) return [fin(lo) ? lo : 0];
    const raw = (hi - lo) / Math.max(1, n || 5), mag = Math.pow(10, Math.floor(Math.log10(raw))), r = raw / mag;
    const step = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * mag;
    const out = [];
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-6 && out.length < 60; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out.length ? out : [lo];
  }

  /** One tooltip per chart container. rows: [label, value, optionalKeyClass]. */
  function tip(container) {
    const el = h('div', { class: 'rcd-tip', 'aria-hidden': 'true' });
    el.hidden = true;
    container.appendChild(el);
    return {
      show(clientX, clientY, title, rows) {
        el.textContent = '';
        if (title) el.appendChild(h('div', { class: 'rcd-tip__title', text: title }));
        for (const r of rows || []) {
          if (!r) continue;
          el.appendChild(h('div', { class: 'rcd-tip__row' }, [
            r[2] ? h('span', { class: 'rcd-key ' + r[2] }) : null,
            h('span', { class: 'rcd-tip__label', text: r[0] }),
            h('span', { class: 'rcd-tip__val', text: r[1] }),
          ]));
        }
        el.hidden = false;
        const b = container.getBoundingClientRect(), w = el.offsetWidth, hh = el.offsetHeight;
        let x = clientX - b.left + 14, y = clientY - b.top - hh - 12;
        if (x + w > b.width - 4) x = clientX - b.left - w - 14;
        if (x < 4) x = 4;
        if (y < 4) y = clientY - b.top + 18;
        el.style.left = Math.round(x) + 'px';
        el.style.top = Math.round(y) + 'px';
      },
      hide() { el.hidden = true; },
      destroy() { if (el.parentNode) el.parentNode.removeChild(el); },
    };
  }

  /** Pointer event -> viewBox coordinates of an svg that is scaled uniformly (width:100%). */
  function pt(svgEl, e, W, H) {
    const r = svgEl.getBoundingClientRect();
    return { x: r.width ? (e.clientX - r.left) * W / r.width : 0, y: r.height ? (e.clientY - r.top) * H / r.height : 0 };
  }

  /** What kind of movement brought the eyes to each fixation: forward | regress | sweep | off. */
  function kinds(analysis) {
    const fx = (analysis && analysis.fixations) || [], sc = (analysis && analysis.saccades) || [];
    const out = fx.map((f) => (f && f.offText ? 'off' : 'forward'));
    for (const s of sc) {
      if (!s || !(s.to >= 0 && s.to < out.length) || out[s.to] === 'off') continue;
      out[s.to] = s.type === 'regression' ? 'regress' : s.type === 'sweep' ? 'sweep' : 'forward';
    }
    return out;
  }
  const KIND_LABEL = { forward: 'Forward', regress: 'Went back', sweep: 'New line', off: 'Off the text' };

  let uidN = 0;
  const uid = (p) => (p || 'rcd') + '-' + (++uidN);
  const num = (v, d) => (fin(v) ? Number(v).toFixed(d || 0) : DASH);
  const pct = (v, d) => (fin(v) ? (v * 100).toFixed(d || 0) + '%' : DASH);
  const secs = (ms, d) => (fin(ms) ? (ms / 1000).toFixed(d == null ? 1 : d) + ' s' : DASH);
  function empty(text) { return h('p', { class: 'rcd-empty', text }); }
  function legend(items) {
    return h('ul', { class: 'rcd-legend' }, items.filter(Boolean).map((it) => h('li', null, [h('span', { class: 'rcd-key ' + it[0] }), it[1]])));
  }

  RC.util = { h, svg, icon, ticks, tip, pt, kinds, KIND_LABEL, uid, num, pct, secs, empty, legend, clamp, fin, DASH, NOOP };

  // ------------------------------------------------------------------ dashboard
  let active = null;

  function destroy() {
    const ctx = active;
    active = null;
    if (!ctx) return;
    for (const fn of ctx.cleanups.splice(0)) { try { fn(); } catch (e) { /* keep going */ } }
  }

  const LEVELS = { good: ['check', 'Good data'], fair: ['fair', 'Fair data'], poor: ['alert', 'Poor data'] };
  function badge(level, long) {
    const L = LEVELS[level] || LEVELS.poor;
    return h('span', { class: 'rc-badge rcd-badge', 'data-level': LEVELS[level] ? level : 'poor', title: 'Data quality for this read' },
      [icon(L[0], 15), h('span', { text: long ? L[1] + ' quality' : L[1] })]);
  }

  function section(ctx, title, sub, cls) {
    const id = uid('rcd-h');
    const sec = h('section', { class: 'rcd-section rc-card' + (cls ? ' ' + cls : ''), 'aria-labelledby': id });
    sec.appendChild(h('div', { class: 'rcd-section__head' }, [
      h('div', { class: 'rcd-section__titles' }, [h('h2', { class: 'rcd-h2', id, text: title }), sub ? h('p', { class: 'rcd-sub', text: sub }) : null]),
      badge(ctx.level),
    ]));
    return sec;
  }

  function mount(ctx, name, el, data, opts) {
    try {
      const c = RC[name];
      if (!c || typeof c.render !== 'function') throw new Error('chart "' + name + '" is not loaded');
      const handle = c.render(el, data, opts || {}) || {};
      if (typeof handle.destroy === 'function') ctx.cleanups.push(() => handle.destroy());
      return handle;
    } catch (e) {
      if (window.console) console.warn('[RCDashboard] ' + name, e);
      try { el.textContent = ''; el.appendChild(empty('This chart could not be drawn.')); } catch (e2) { /* nothing more to do */ }
      return {};
    }
  }

  function fmtDate(ms, short) {
    if (!fin(ms)) return '';
    try {
      const d = new Date(ms);
      if (isNaN(d.getTime())) return '';
      return short ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  /** Marker on a track whose middle third is the typical range. */
  function rangeBar(value, range, fmt) {
    if (!fin(value) || !Array.isArray(range) || !fin(range[0]) || !fin(range[1]) || range[1] <= range[0]) return null;
    const lo = range[0], hi = range[1], span = hi - lo, d0 = lo - 0.9 * span, d1 = hi + 0.9 * span;
    const pos = clamp((value - d0) / (d1 - d0), 0.03, 0.97);
    const st = value < lo ? 'below' : value > hi ? 'above' : 'within';
    const word = st === 'within' ? 'Within typical range' : st === 'below' ? 'Below typical range' : 'Above typical range';
    const band = h('span', { class: 'rcd-range__band' });
    band.style.left = (100 * (lo - d0) / (d1 - d0)).toFixed(1) + '%';
    band.style.width = (100 * span / (d1 - d0)).toFixed(1) + '%';
    const dot = h('span', { class: 'rcd-range__dot' });
    dot.style.left = (100 * pos).toFixed(1) + '%';
    const f = fmt || ((v) => String(v));
    return h('div', { class: 'rcd-range', 'data-status': st }, [
      h('div', { class: 'rcd-range__track', role: 'img', 'aria-label': word + '. Typical range ' + f(lo) + ' to ' + f(hi) + '.' }, [band, dot]),
      h('div', { class: 'rcd-range__meta' }, [
        h('span', { class: 'rcd-range__status' }, [icon(st === 'within' ? 'within' : st === 'below' ? 'down' : 'up', 14), word]),
        h('span', { class: 'rcd-range__typ', text: 'Typical ' + f(lo) + '–' + f(hi) }),
      ]),
    ]);
  }

  function delta(cur, prev, fmt) {
    if (!fin(cur) || !fin(prev)) return null;
    const d = cur - prev, txt = fmt(Math.abs(d));
    const zero = /^0(\.0+)?$/.test(String(txt).replace(/[^\d.]/g, '') || '0');
    return h('p', { class: 'rcd-delta' }, zero
      ? [icon('same', 14), 'Same as last test']
      : [icon(d > 0 ? 'up' : 'down', 14), (d > 0 ? 'Up ' : 'Down ') + txt + ' since last test']);
  }

  // ------------------------------------------------------------------ sections
  function buildHeader(ctx) {
    const { session, analysis, o } = ctx;
    const m = analysis.metrics;
    const title = session.passage && session.passage.title;
    const band = (analysis.norms && analysis.norms.label) || (session.ageBand ? 'Ages ' + session.ageBand : '');
    const when = fmtDate(session.startedAt);
    const head = h('header', { class: 'rcd-header' }, [
      h('div', { class: 'rcd-header__top' }, [
        h('h1', { class: 'rcd-h1', text: 'Your Reading Check' }),
        h('div', { class: 'rcd-header__chips' }, [
          o.demo || session.demo ? h('span', { class: 'rc-chip rcd-chip--demo', text: 'Demo data' }) : null,
          badge(ctx.level, true),
        ]),
      ]),
      h('ul', { class: 'rcd-meta' }, [
        when ? h('li', null, [h('span', { class: 'rcd-meta__k', text: 'Taken' }), when]) : null,
        band ? h('li', null, [h('span', { class: 'rcd-meta__k', text: 'Compared with' }), band]) : null,
        title ? h('li', null, [h('span', { class: 'rcd-meta__k', text: 'Passage' }), '“' + title + '”']) : null,
        o.baseline && Number.isFinite(o.baseline.wpm) && o.baseline.wpm > 0
          ? h('li', null, [h('span', { class: 'rcd-meta__k', text: 'Your everyday pace' }), Math.round(o.baseline.wpm) + ' words a minute']) : null,
      ]),
    ]);
    if (analysis.ok && m) {
      const c = m.comprehension || {};
      head.appendChild(h('p', { class: 'rcd-lede', text:
        'You read ' + (analysis.wordCount || 0) + ' words in ' + secs(analysis.readMs, 0) + ', at ' + num(m.wpm) + ' words a minute, and answered ' +
        num(c.correct) + ' of ' + num(c.total) + ' questions correctly.' }));
    }
    head.appendChild(h('p', { class: 'rcd-disclaimer' }, [icon('info', 18),
      h('span', { text: 'This is a snapshot of one short read, measured with a webcam. It is not a diagnosis and cannot tell you why you read the way you do. Everything was measured on this device, and no video or images were kept.' })]));
    return head;
  }

  function statCard(label, value, unit, extra) {
    return h('article', { class: 'rcd-stat rc-card' }, [
      h('h3', { class: 'rcd-stat__label', text: label }),
      h('p', { class: 'rcd-stat__value' }, [h('span', { class: 'rcd-stat__num', text: value }), unit ? h('span', { class: 'rcd-stat__unit', text: unit }) : null]),
    ].concat(extra || []));
  }

  function buildSummary(ctx) {
    const { analysis, prev } = ctx;
    const m = analysis.metrics, cmp = analysis.compare || {};
    const wrap = h('section', { class: 'rcd-summary', 'aria-label': 'Summary' });
    const p = prev || {};
    const std = (label, v, unit, key, fmt, dfmt, pv) => {
      const c = cmp[key];
      const bar = c ? rangeBar(c.value, c.range, fmt) : null;
      return statCard(label, fin(v) ? fmt(v) : DASH, fin(v) ? unit : '', [
        bar || h('p', { class: 'rcd-stat__na', text: fin(v) ? 'No typical range for this measure' : 'Not available for this read' }),
        delta(v, pv, dfmt || fmt),
      ]);
    };
    const n0 = (v) => num(v, 0), n2 = (v) => String(Math.round(v * 100) / 100);
    wrap.appendChild(std('Reading speed', m.wpm, 'words a minute', 'wpm', n0, null, p.wpm));

    const c = m.comprehension || { correct: 0, total: 0 };
    const pips = h('div', { class: 'rcd-pips', role: 'img', 'aria-label': num(c.correct) + ' of ' + num(c.total) + ' answers correct' });
    for (let i = 0; i < clamp(c.total || 0, 0, 10); i++) pips.appendChild(h('span', { class: 'rcd-pip' + (i < c.correct ? ' is-on' : '') }, [i < c.correct ? icon('check', 14) : null]));
    wrap.appendChild(statCard('Comprehension', num(c.correct) + ' / ' + num(c.total), 'answers correct', [
      pips, delta(c.correct, p.comprehension, (v) => v + (v === 1 ? ' answer' : ' answers')),
    ]));

    wrap.appendChild(std('Fixations per word', m.fixPerWord, 'stops per word', 'fixPerWord', n2, null, p.fixPerWord));
    wrap.appendChild(std('Average fixation', m.meanFixMs, 'ms per stop', 'meanFixMs', n0, (v) => n0(v) + ' ms', p.meanFixMs));
    wrap.appendChild(std('Regression rate', m.regressionRate, 'of eye movements went back', 'regressionRate', (v) => pct(v, 0), (v) => (v * 100).toFixed(1) + ' points', p.regressionRate));
    wrap.appendChild(std('Blink rate', m.blinkRate, 'blinks a minute', 'blinkRate', (v) => String(Math.round(v * 10) / 10), null, p.blinkRate));

    const q = analysis.quality || {};
    const meter = h('div', { class: 'rcd-meter', role: 'img', 'aria-label': 'Data quality score ' + num(q.score) + ' out of 100' }, [h('span', { class: 'rcd-meter__fill' })]);
    meter.firstChild.style.width = clamp(fin(q.score) ? q.score : 0, 0, 100) + '%';
    wrap.appendChild(h('article', { class: 'rcd-stat rcd-stat--quality rc-card' }, [
      h('h3', { class: 'rcd-stat__label', text: 'Data quality' }),
      h('p', { class: 'rcd-stat__value' }, [badge(ctx.level)]),
      meter,
      h('p', { class: 'rcd-range__typ', text: 'Score ' + num(q.score) + ' of 100. Details are in “Data quality and method” below.' }),
    ]));
    return wrap;
  }

  function buildReplay(ctx) {
    const sec = section(ctx, 'How your eyes moved through the passage',
      'Each circle is a pause (a fixation). Bigger circles are longer pauses, and the numbers show the order. Dashed orange lines are jumps back.');
    sec.classList.add('rcd-section--hero');
    const el = h('div', { class: 'rcd-chart' });
    sec.appendChild(el);
    ctx.scan = mount(ctx, 'scanpath', el, { session: ctx.session, analysis: ctx.analysis }, {
      reducedMotion: ctx.reduced,
      onTick: (t) => { if (ctx.stair && ctx.stair.setCursor) ctx.stair.setCursor(t); },
    });
    return sec;
  }

  function buildStaircase(ctx) {
    const sec = section(ctx, 'Reading rhythm',
      'Steady reading draws a sawtooth across each line and a staircase down the page. Point at the chart to see that moment in the replay above, or click to jump there.');
    const el = h('div', { class: 'rcd-chart' });
    sec.appendChild(el);
    const call = (fn, v) => { try { if (ctx.scan && ctx.scan[fn]) ctx.scan[fn](v); } catch (e) { /* replay is optional */ } };
    ctx.stair = mount(ctx, 'staircase', el, { session: ctx.session, analysis: ctx.analysis }, {
      onHover: (t) => call('highlight', t),
      onSeek: (t) => call('seek', t),
    });
    return sec;
  }

  function buildLines(ctx) {
    const sec = section(ctx, 'Time on each line', 'How long your eyes stayed on each line, against what your own pace on this passage would predict.');
    const el = h('div', { class: 'rcd-chart' });
    sec.appendChild(el);
    mount(ctx, 'lineTimeline', el, { analysis: ctx.analysis }, {
      onHoverLine: (i) => { try { if (ctx.scan && ctx.scan.highlightLine) ctx.scan.highlightLine(i); } catch (e) { /* optional */ } },
    });
    return sec;
  }

  function buildPair(ctx) {
    const { analysis, prev } = ctx;
    const row = h('div', { class: 'rcd-pair' });
    const a = section(ctx, 'How long each pause lasted', 'Every fixation, grouped by length.');
    const ael = h('div', { class: 'rcd-chart' });
    a.appendChild(ael);
    mount(ctx, 'histogram', ael, { analysis });
    const b = section(ctx, 'Reading profile', 'Five scores from 0 to 100. Further out is stronger.');
    const bel = h('div', { class: 'rcd-chart' });
    b.appendChild(bel);
    mount(ctx, 'radar', bel, { profile: analysis.profile, previous: prev && prev.profile ? prev.profile : null, previousLabel: prev ? fmtDate(prev.startedAt, true) : '' });
    row.appendChild(a);
    row.appendChild(b);
    return row;
  }

  function miniTile(label, value, unit, extra) {
    return h('div', { class: 'rcd-tile' }, [
      h('h3', { class: 'rcd-tile__label', text: label }),
      h('p', { class: 'rcd-tile__value' }, [h('span', { class: 'rcd-tile__num', text: value }), unit ? h('span', { class: 'rcd-tile__unit', text: unit }) : null]),
    ].concat(extra || []));
  }

  function halvesBlock(analysis) {
    const hv = analysis.halves;
    if (!hv || !hv.first || !hv.second) return empty('Not enough reading time to compare the two halves.');
    const rows = [
      ['Average fixation', hv.first.meanFixMs, hv.second.meanFixMs, (v) => num(v) + ' ms'],
      ['Regression rate', hv.first.regressionRate, hv.second.regressionRate, (v) => pct(v, 1)],
      ['Blink rate', hv.first.blinkRate, hv.second.blinkRate, (v) => num(v, 1) + ' a minute'],
    ];
    const box = h('div', { class: 'rcd-halves' });
    for (const [label, a, b, f] of rows) {
      const ok = fin(a) && fin(b), max = ok ? Math.max(a, b, 1e-9) : 1;
      const bar = (v, cls, name) => {
        const fill = h('span', { class: 'rcd-halves__fill ' + cls });
        fill.style.width = (fin(v) ? clamp(100 * v / max, 1.5, 100) : 0).toFixed(1) + '%';
        return h('div', { class: 'rcd-halves__bar' }, [h('span', { class: 'rcd-halves__name', text: name }), h('span', { class: 'rcd-halves__track' }, [fill]), h('span', { class: 'rcd-halves__val', text: fin(v) ? f(v) : 'not available' })]);
      };
      let change = 'No comparison';
      let ic = 'same';
      if (ok) {
        const ch = a > 0 ? Math.round(100 * (b - a) / a) : null;
        if (ch === null || ch === 0) change = 'No change';
        else { change = (ch > 0 ? 'Up ' : 'Down ') + Math.abs(ch) + '% in the second half'; ic = ch > 0 ? 'up' : 'down'; }
      }
      box.appendChild(h('div', { class: 'rcd-halves__row', role: 'group', 'aria-label': label + ', first half against second half' }, [
        h('h4', { class: 'rcd-halves__label', text: label }),
        h('div', { class: 'rcd-halves__bars' }, [bar(a, 'is-first', 'First half'), bar(b, 'is-second', 'Second half')]),
        h('p', { class: 'rcd-delta' }, [icon(ic, 14), change]),
      ]));
    }
    return box;
  }

  function trendGrid(ctx, defs, note) {
    const grid = h('div', { class: 'rcd-trends' });
    for (const d of defs) {
      const cell = h('figure', { class: 'rcd-trend' }, [h('figcaption', { class: 'rcd-trend__title', text: d.title })]);
      const el = h('div', { class: 'rcd-chart' });
      cell.appendChild(el);
      grid.appendChild(cell);
      mount(ctx, 'trend', el, d);
    }
    return note ? [grid, h('p', { class: 'rcd-note', text: note })] : [grid];
  }

  function buildFatigue(ctx) {
    const { analysis, session, o } = ctx;
    const m = analysis.metrics, norms = analysis.norms || {};
    const sec = section(ctx, 'Fatigue and focus', 'Signs of tiring or drifting attention during the read, and across longer reading sessions.');
    const tiles = h('div', { class: 'rcd-tiles' });
    const blinkC = (analysis.compare || {}).blinkRate;
    tiles.appendChild(miniTile('Blink rate', fin(m.blinkRate) ? num(m.blinkRate, 1) : DASH, fin(m.blinkRate) ? 'a minute' : '', [
      blinkC ? rangeBar(blinkC.value, blinkC.range, (v) => String(v)) : h('p', { class: 'rcd-stat__na', text: 'Blink data was not available from the camera' }),
      fin(m.meanBlinkMs) ? h('p', { class: 'rcd-note', text: num(m.blinkCount) + ' blinks, about ' + num(m.meanBlinkMs) + ' ms each' }) : null,
    ]));
    tiles.appendChild(miniTile('Gaze stability', fin(m.stabilityPx) ? '±' + num(m.stabilityPx, 1) : DASH, fin(m.stabilityPx) ? 'px of wobble per pause' : '', [
      rangeBar(m.stabilityPx, norms.stabilityPx, (v) => v + ' px'),
    ]));
    const hd = m.head && fin(m.head.sd) ? m.head.sd * 100 : null;
    tiles.appendChild(miniTile('Head movement', hd === null ? DASH : num(hd, 2) + '%', hd === null ? '' : 'of the camera frame', [
      hd === null ? h('p', { class: 'rcd-stat__na', text: 'Head position was not available from the camera' })
        : rangeBar(Math.round(hd * 100) / 100, Array.isArray(norms.headSd) ? norms.headSd.map((v) => v * 100) : null, (v) => (Math.round(v * 100) / 100) + '%'),
    ]));
    tiles.appendChild(miniTile('Time off the text', fin(m.offTextPct) ? num(m.offTextPct, 1) + '%' : DASH, fin(m.offTextPct) ? 'of the tracked time' : '', [
      h('p', { class: 'rcd-note', text: fin(m.faceLostPct) ? 'Face out of view for ' + num(m.faceLostPct, 1) + '% of the read' : 'Face tracking data was not available' }),
    ]));
    sec.appendChild(tiles);

    sec.appendChild(h('h3', { class: 'rcd-h3', text: 'First half against second half' }));
    sec.appendChild(halvesBlock(analysis));

    // --- over time, from normal reading sessions
    sec.appendChild(h('h3', { class: 'rcd-h3', text: 'Over time while reading' }));
    const log = (Array.isArray(o.minuteLog) ? o.minuteLog : []).filter((r) => r && typeof r === 'object');
    if (log.length < 2) {
      sec.appendChild(empty('Appears after a few minutes of reading with eye tracking on.'));
    } else {
      const pts = (key, scale) => log.map((r, i) => ({ x: i, y: fin(r[key]) ? r[key] * (scale || 1) : null, label: 'Minute ' + ((fin(r.min) ? r.min : i) + 1) }));
      const xl = ['Minute 1', 'Minute ' + log.length];
      for (const n of trendGrid(ctx, [
        { title: 'Blinks a minute', points: pts('blinkRate'), format: (v) => num(v, 1), xLabels: xl, unit: 'a minute' },
        { title: 'Average fixation (ms)', points: pts('meanFixMs'), format: (v) => num(v), xLabels: xl, unit: 'ms' },
        { title: 'Regression rate (%)', points: pts('regressionRate', 100), format: (v) => num(v, 1) + '%', xLabels: xl, unit: '' },
      ], 'One point per minute of ordinary reading with eye tracking on. Rising lines late in a session can be a sign of tiring.')) sec.appendChild(n);
    }

    // --- test history
    sec.appendChild(h('h3', { class: 'rcd-h3', text: 'Your Reading Checks so far' }));
    const hist = ctx.history;
    if (!hist.length) {
      sec.appendChild(empty('Take the Reading Check again another day to see how your results change.'));
    } else {
      const cur = { startedAt: session.startedAt, wpm: m.wpm, meanFixMs: m.meanFixMs, regressionRate: m.regressionRate };
      const all = hist.concat([cur]);
      const pts = (key, scale) => all.map((r, i) => ({ x: i, y: fin(r[key]) ? r[key] * (scale || 1) : null, label: i === all.length - 1 ? 'This test' : (fmtDate(r.startedAt, true) || 'Test ' + (i + 1)) }));
      const xl = [fmtDate(all[0].startedAt, true) || 'First', 'This test'];
      const rg = (r, s) => (Array.isArray(r) ? [r[0] * (s || 1), r[1] * (s || 1)] : null);
      for (const n of trendGrid(ctx, [
        { title: 'Reading speed (words a minute)', points: pts('wpm'), format: (v) => num(v), xLabels: xl, range: rg(norms.wpm), dots: true },
        { title: 'Average fixation (ms)', points: pts('meanFixMs'), format: (v) => num(v), xLabels: xl, range: rg(norms.fixMs), dots: true, unit: 'ms' },
        { title: 'Regression rate (%)', points: pts('regressionRate', 100), format: (v) => num(v, 1) + '%', xLabels: xl, range: rg(norms.regressionRate, 100), dots: true },
      ], 'The shaded band is the typical range for your age group.')) sec.appendChild(n);
    }
    return sec;
  }

  const SETTING_NAMES = { on: 'Glider', lineHeight: 'Line spacing', letterSpacing: 'Letter spacing', wordSpacing: 'Word spacing', fontSize: 'Text size', gaze: 'Eye-tracking help' };
  function settingText(k, v) {
    const name = SETTING_NAMES[k] || k;
    if (v === true) return name + ' on';
    if (v === false) return name + ' off';
    if (k === 'fontSize' && fin(v)) return name + ' ' + v + '%';
    return v == null ? name : name + ' ' + String(v);
  }
  function recommended(analysis) {
    try { if (window.RCAnalytics && typeof window.RCAnalytics.recommendedSettings === 'function') return window.RCAnalytics.recommendedSettings(analysis) || {}; } catch (e) { /* fall through */ }
    const patch = {};
    for (const f of analysis.findings || []) for (const k of Object.keys((f && f.settings) || {})) {
      const v = f.settings[k];
      patch[k] = typeof v === 'number' && typeof patch[k] === 'number' ? Math.max(patch[k], v) : v;
    }
    return patch;
  }

  const TONES = { attention: 'Worth a look', info: 'Good to know', positive: 'Going well' };
  function buildMeaning(ctx) {
    const { analysis, o } = ctx;
    const poor = ctx.level === 'poor';
    const sec = section(ctx, 'What this means', 'Plain-language notes on this read, each with a setting that may help.');
    if (poor) {
      sec.appendChild(h('div', { class: 'rcd-notice' }, [icon('alert', 20),
        h('p', { text: 'The camera data for this read was poor, so these notes may not reflect how you really read. A retake in good light, with your head still, will give a clearer picture.' }),
        typeof o.onRetake === 'function' ? h('button', { type: 'button', class: 'rc-btn rc-btn--primary', on: { click: () => safe(o.onRetake) } }, [icon('refresh', 16), 'Retake']) : null]));
    }
    const list = h('div', { class: 'rcd-findings' + (poor ? ' is-muted' : '') });
    const fs = Array.isArray(analysis.findings) ? analysis.findings.filter(Boolean) : [];
    for (const f of fs) {
      const tone = TONES[f.tone] ? f.tone : 'info';
      list.appendChild(h('article', { class: 'rcd-finding', 'data-tone': tone }, [
        h('span', { class: 'rcd-finding__icon' }, [icon(ICONS[f.icon] ? f.icon : 'info', 22)]),
        h('div', { class: 'rcd-finding__body' }, [
          h('p', { class: 'rcd-finding__tone', text: TONES[tone] }),
          h('h3', { class: 'rcd-finding__title', text: f.title || '' }),
          h('p', { class: 'rcd-finding__text', text: f.text || '' }),
          f.settingLabel ? h('p', { class: 'rcd-finding__setting' }, [icon('settings', 15), h('span', { text: 'Suggested setting: ' + f.settingLabel })]) : null,
        ]),
      ]));
    }
    if (!fs.length) list.appendChild(empty('No notes were generated for this read.'));
    sec.appendChild(list);

    const patch = recommended(analysis);
    const keys = Object.keys(patch);
    const status = h('div', { class: 'rcd-apply__status', role: 'status', 'aria-live': 'polite' });
    const apply = h('div', { class: 'rcd-apply rcd-noprint' });
    if (keys.length && typeof o.onApplySettings === 'function') {
      const btn = h('button', { type: 'button', class: 'rc-btn rc-btn--primary' }, [icon('settings', 16), 'Apply recommended settings']);
      btn.addEventListener('click', () => {
        if (btn.disabled) return;
        btn.disabled = true;
        status.textContent = 'Applying…';
        let p;
        try { p = Promise.resolve(o.onApplySettings(patch)); } catch (e) { p = Promise.reject(e); }
        p.then((res) => {
          if (active !== ctx) return;
          const applied = (res && res.applied && typeof res.applied === 'object') ? res.applied : {};
          const skipped = (res && Array.isArray(res.skipped)) ? res.skipped : [];
          const ak = Object.keys(applied);
          status.textContent = '';
          if (ak.length) {
            status.appendChild(h('p', { class: 'rcd-apply__done' }, [icon('check', 16), 'Applied to Glider:']));
            status.appendChild(h('ul', { class: 'rcd-apply__list' }, ak.map((k) => h('li', { class: 'rc-chip', text: settingText(k, applied[k]) }))));
          } else status.appendChild(h('p', { text: 'No settings were changed.' }));
          if (skipped.length) status.appendChild(h('p', { class: 'rcd-note', text: 'Left as they were: ' + skipped.map((k) => SETTING_NAMES[k] || k).join(', ') + '.' }));
        }, () => {
          if (active !== ctx) return;
          status.textContent = 'The settings could not be applied. Try again.';
        }).then(() => { if (active === ctx) btn.disabled = false; });
      });
      apply.appendChild(h('div', { class: 'rcd-apply__main' }, [btn,
        h('ul', { class: 'rcd-apply__list', 'aria-label': 'Settings that will be applied' }, keys.map((k) => h('li', { class: 'rc-chip', text: settingText(k, patch[k]) })))]));
      apply.appendChild(status);
    } else {
      apply.appendChild(h('p', { class: 'rcd-note', text: keys.length ? 'The recommended settings cannot be applied from this page.' : 'No setting changes are suggested for this read.' }));
    }
    sec.appendChild(apply);
    sec.appendChild(h('p', { class: 'rcd-calm', text:
      'These are patterns from one short read. Patterns like these are sometimes associated with reading difficulties, and they also show up when someone is tired, distracted or meeting unfamiliar words. If reading often feels like hard work, consider talking with a teacher or reading specialist.' }));
    return sec;
  }

  function buildMethod(ctx) {
    const { analysis } = ctx;
    const q = analysis.quality || {};
    const det = h('details', { class: 'rcd-method rc-card' });
    det.appendChild(h('summary', { class: 'rcd-method__summary' }, [h('span', { class: 'rcd-h2', text: 'Data quality and method' }), badge(ctx.level)]));
    const dl = h('dl', { class: 'rcd-dl' });
    const row = (k, v) => { dl.appendChild(h('div', null, [h('dt', { text: k }), h('dd', { text: v })])); };
    row('Calibration error', fin(q.calibErrPx) ? '±' + num(q.calibErrPx) + ' px vertically' : 'not recorded');
    row('Camera frame rate', fin(q.fps) && q.fps > 0 ? num(q.fps, 1) + ' frames a second' : 'not available');
    row('Face out of view', fin(q.faceLostPct) ? num(q.faceLostPct, 1) + '% of the read' : 'not available');
    row('Gaze samples', num(q.gazeSamples));
    row('Camera frames', num(q.frameSamples));
    row('Fixations found', num(q.fixations));
    row('Quality score', num(q.score) + ' of 100');
    det.appendChild(dl);
    const notes = Array.isArray(q.notes) ? q.notes.filter((n) => typeof n === 'string' && n) : [];
    det.appendChild(h('h3', { class: 'rcd-h3', text: 'Notes on this read' }));
    det.appendChild(notes.length ? h('ul', { class: 'rcd-bullets' }, notes.map((n) => h('li', { text: n })))
      : h('p', { class: 'rcd-note', text: 'Nothing unusual was flagged in the recording.' }));
    det.appendChild(h('div', { class: 'rcd-cando' }, [
      h('div', null, [h('h3', { class: 'rcd-h3' }, [icon('check', 16), 'What a webcam can measure']),
        h('ul', { class: 'rcd-bullets' }, [
          'Which line you are on, and when you move to the next line or go back.',
          'Roughly how long each pause lasts, and how many pauses a line takes.',
          'Blinks, head movement, and time spent looking away from the text.',
        ].map((t) => h('li', { text: t })))]),
      h('div', null, [h('h3', { class: 'rcd-h3' }, [icon('alert', 16), 'What it cannot measure']),
        h('ul', { class: 'rcd-bullets' }, [
          'Exactly which word or letter you are looking at. Circle positions along a line are approximate.',
          'Very short pauses and very small eye movements. A webcam merges them, so counts run lower and pauses run longer than a lab tracker would report.',
          'Why a pattern appears. Tiredness, lighting, glasses and an unfamiliar topic all change the numbers.',
        ].map((t) => h('li', { text: t })))]),
    ]));
    det.appendChild(h('p', { class: 'rcd-note', text:
      'The typical ranges are approximate values from laboratory eye-tracking studies of silent reading. They have not been validated for webcam tracking and are shown as a rough guide only. Line times are compared with your own pace on this passage, not with other readers. All processing happened on this device, and only numbers were stored.' }));
    return det;
  }

  function safe(fn) { try { return fn(); } catch (e) { if (window.console) console.warn('[RCDashboard]', e); return undefined; } }

  function actionButtons(ctx, withDownloads) {
    const { o, session, analysis } = ctx;
    const row = h('div', { class: 'rcd-actions' });
    if (withDownloads) {
      row.appendChild(h('button', { type: 'button', class: 'rc-btn rc-btn--primary', on: { click: () => safe(() => window.print()) } }, [icon('download', 16), 'Download report (PDF)']));
      row.appendChild(h('button', { type: 'button', class: 'rc-btn', on: { click: () => safe(() => {
        const blob = new Blob([JSON.stringify({ session, analysis }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        let stamp = '';
        try { stamp = new Date(session.startedAt).toISOString().slice(0, 10); } catch (e) { stamp = 'session'; }
        const a = h('a', { href: url, download: 'reading-check-' + stamp + '.json' });
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        const tm = setTimeout(() => { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 2000);
        ctx.cleanups.push(() => { clearTimeout(tm); URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); });
      }) } }, [icon('download', 16), 'Download data (JSON)']));
    }
    if (typeof o.onRetake === 'function') row.appendChild(h('button', { type: 'button', class: 'rc-btn' + (withDownloads ? ' rc-btn--ghost' : ' rc-btn--primary'), on: { click: () => safe(o.onRetake) } }, [icon('refresh', 16), 'Retake']));
    if (typeof o.onDelete === 'function') {
      const slot = h('div', { class: 'rcd-delete' });
      const ask = h('button', { type: 'button', class: 'rc-btn rc-btn--ghost' }, [icon('trash', 16), 'Delete my data']);
      const msg = h('span', { class: 'rcd-delete__msg', role: 'status', 'aria-live': 'polite' });
      const yes = h('button', { type: 'button', class: 'rc-btn rc-btn--danger', text: 'Yes, delete' });
      const no = h('button', { type: 'button', class: 'rc-btn rc-btn--ghost', text: 'Keep it' });
      const confirmBox = h('div', { class: 'rcd-delete__confirm' }, [h('span', { text: 'Delete this Reading Check and its history from this device?' }), yes, no]);
      confirmBox.hidden = true;
      ask.addEventListener('click', () => { ask.hidden = true; confirmBox.hidden = false; msg.textContent = ''; yes.focus(); });
      no.addEventListener('click', () => { confirmBox.hidden = true; ask.hidden = false; ask.focus(); });
      yes.addEventListener('click', () => {
        if (yes.disabled) return;
        yes.disabled = no.disabled = true;
        let p;
        try { p = Promise.resolve(o.onDelete()); } catch (e) { p = Promise.reject(e); }
        p.then(() => {
          if (active !== ctx) return;
          confirmBox.hidden = true;
          msg.textContent = 'Your Reading Check data was deleted.';
        }, () => {
          if (active !== ctx) return;
          yes.disabled = no.disabled = false;
          confirmBox.hidden = true; ask.hidden = false;
          msg.textContent = 'The data could not be deleted. Try again.';
        });
      });
      slot.appendChild(ask); slot.appendChild(confirmBox); slot.appendChild(msg);
      row.appendChild(slot);
    }
    return row;
  }

  function buildExport(ctx) {
    const sec = h('section', { class: 'rcd-section rcd-export rc-card rcd-noprint', 'aria-label': 'Export and manage your data' }, [
      h('div', { class: 'rcd-section__titles' }, [h('h2', { class: 'rcd-h2', text: 'Keep or remove this report' }),
        h('p', { class: 'rcd-sub', text: 'The PDF opens your browser’s print dialog; choose “Save as PDF”. The JSON file holds the raw numbers from this read.' })]),
      actionButtons(ctx, true),
    ]);
    return sec;
  }

  function buildNotEnough(ctx) {
    const { analysis } = ctx;
    const q = analysis.quality || {};
    const notes = Array.isArray(q.notes) ? q.notes.filter((n) => typeof n === 'string' && n) : [];
    return h('section', { class: 'rcd-section rcd-nodata rc-card', 'aria-label': 'Not enough data' }, [
      h('span', { class: 'rcd-nodata__icon' }, [icon('eye', 34)]),
      h('h2', { class: 'rcd-h2', text: 'Not enough data — retake' }),
      h('p', { class: 'rcd-sub', text: analysis.reason === 'bad-session'
        ? 'This recording is missing the passage layout or the eye-movement data, so there is nothing reliable to show.'
        : 'The camera did not catch enough of your eye movements to draw a fair picture of this read.' }),
      notes.length ? h('ul', { class: 'rcd-bullets' }, notes.map((n) => h('li', { text: n }))) : null,
      h('p', { class: 'rcd-note', text: 'For the next try: face a window or a lamp, sit so your whole face is in view, and keep your head still while you read.' }),
      actionButtons(ctx, false),
    ]);
  }

  // ------------------------------------------------------------------ entry
  function render(root, options) {
    try { destroy(); } catch (e) { /* previous render is gone either way */ }
    if (!root) return;
    const o = options && typeof options === 'object' ? options : {};
    const ctx = { o, cleanups: [], scan: null, stair: null };
    active = ctx;
    try {
      const session = o.session && typeof o.session === 'object' ? o.session : {};
      const analysis = o.analysis && typeof o.analysis === 'object' ? o.analysis
        : { ok: false, reason: 'bad-session', quality: { level: 'poor', notes: ['No analysis was available for this session.'] }, findings: [] };
      ctx.session = session;
      ctx.analysis = analysis;
      ctx.level = (analysis.quality && LEVELS[analysis.quality.level]) ? analysis.quality.level : 'poor';
      ctx.history = (Array.isArray(o.history) ? o.history : []).filter((x) => x && typeof x === 'object' && x.ok !== false);
      ctx.prev = ctx.history.length ? ctx.history[ctx.history.length - 1] : null;
      ctx.reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

      const page = h('div', { class: 'rcd', 'data-quality': ctx.level });
      const add = (fn) => {
        try { const n = fn(ctx); if (n) page.appendChild(n); } catch (e) {
          if (window.console) console.warn('[RCDashboard] section failed', e);
          page.appendChild(h('section', { class: 'rcd-section rc-card' }, [empty('This part of the report could not be shown.')]));
        }
      };
      add(buildHeader);
      if (!analysis.ok || !analysis.metrics) {
        add(buildNotEnough);
      } else {
        [buildSummary, buildReplay, buildStaircase, buildLines, buildPair, buildFatigue, buildMeaning, buildMethod, buildExport].forEach(add);
        // print: full scanpath, method panel open
        const details = page.querySelector('.rcd-method');
        let wasOpen = false;
        const before = () => { try { if (ctx.scan && ctx.scan.showAll) ctx.scan.showAll(); if (details) { wasOpen = details.open; details.open = true; } } catch (e) { /* print anyway */ } };
        const after = () => { try { if (details) details.open = wasOpen; } catch (e) { /* ignore */ } };
        window.addEventListener('beforeprint', before);
        window.addEventListener('afterprint', after);
        ctx.cleanups.push(() => { window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after); });
      }
      root.textContent = '';
      root.appendChild(page);
      // charts that measure themselves (the heatmap canvas) get a nudge once attached
      if (ctx.scan && ctx.scan.attached) { try { ctx.scan.attached(); } catch (e) { /* optional */ } }
    } catch (e) {
      if (window.console) console.warn('[RCDashboard] render failed', e);
      try {
        root.textContent = '';
        root.appendChild(h('div', { class: 'rcd' }, [h('section', { class: 'rcd-section rcd-nodata rc-card' }, [
          h('h2', { class: 'rcd-h2', text: 'This report could not be shown' }),
          h('p', { class: 'rcd-sub', text: 'Something went wrong while drawing the results. Retaking the Reading Check usually fixes it.' }),
          typeof o.onRetake === 'function' ? h('button', { type: 'button', class: 'rc-btn rc-btn--primary', text: 'Retake', on: { click: () => safe(o.onRetake) } }) : null,
        ])]));
      } catch (e2) { /* give up quietly */ }
    }
  }

  window.RCDashboard = { render, destroy };
})();
