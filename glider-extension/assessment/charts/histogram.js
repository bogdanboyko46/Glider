/*
 * charts/histogram.js — fixation-duration histogram with the age band's typical range shaded,
 * mean and median marked. RCCharts.histogram.render(container, { analysis })
 */
(function () {
  'use strict';
  const RC = (window.RCCharts = window.RCCharts || {});
  const NOOP = () => {};

  function render(container, data) {
    const U = RC.util;
    if (!U || !container) return { destroy: NOOP };
    const { h, svg, clamp, fin } = U;
    const a = (data && data.analysis) || {};
    const hist = a.histogram || {};
    let bins = (Array.isArray(hist.bins) ? hist.bins : []).filter((b) => b && fin(b.from) && fin(b.count));
    const binMs = fin(hist.binMs) && hist.binMs > 0 ? hist.binMs : 50;
    const totalN = bins.reduce((s, b) => s + b.count, 0);
    container.textContent = '';
    if (!bins.length || !totalN) { container.appendChild(U.empty('No fixations were recorded for this chart.')); return { destroy: NOOP }; }

    const m = a.metrics || {};
    const range = a.norms && Array.isArray(a.norms.fixMs) && fin(a.norms.fixMs[0]) && fin(a.norms.fixMs[1]) ? a.norms.fixMs : null;
    // drop the empty tail, but keep the typical range, the mean and a little air in view
    let lastUsed = 0;
    bins.forEach((b, i) => { if (b.count > 0) lastUsed = i; });
    const need = Math.max(range ? range[1] : 0, fin(m.meanFixMs) ? m.meanFixMs : 0, fin(m.medianFixMs) ? m.medianFixMs : 0);
    let keep = Math.min(bins.length, lastUsed + 2);
    while (keep < bins.length && bins[keep - 1].from + binMs < need) keep++;
    const openEnd = keep === bins.length && !fin(bins[bins.length - 1].to);
    bins = bins.slice(0, keep);

    const W = 540, H = 318, L = 46, R = 16, T = 46, B = 52;
    const x0 = bins[0].from, x1 = bins[bins.length - 1].from + binMs;
    const maxC = Math.max.apply(null, bins.map((b) => b.count).concat([1]));
    const yt = U.ticks(0, maxC, 4), yMax = Math.max(maxC, yt[yt.length - 1] || 1);
    const sx = (v) => L + (W - L - R) * clamp((v - x0) / ((x1 - x0) || 1), 0, 1);
    const sy = (c) => H - B - (H - B - T) * clamp(c / yMax, 0, 1);

    const wrap = h('div', { class: 'rcd-hist' });
    const s = svg('svg', {
      class: 'rcd-svg', viewBox: '0 0 ' + W + ' ' + H, role: 'img',
      'aria-label': 'Histogram of ' + totalN + ' fixation durations. Mean ' + U.num(m.meanFixMs) + ' milliseconds, median ' + U.num(m.medianFixMs) + ' milliseconds.' +
        (range ? ' Typical range for this age group ' + range[0] + ' to ' + range[1] + ' milliseconds.' : ''),
    });
    wrap.appendChild(s);

    if (range) svg('rect', { class: 'rcd-range-band', x: sx(range[0]).toFixed(1), y: T, width: Math.max(0, sx(range[1]) - sx(range[0])).toFixed(1), height: H - B - T }, s);
    for (const v of yt) {
      svg('line', { class: 'rcd-grid', x1: L, x2: W - R, y1: sy(v).toFixed(1), y2: sy(v).toFixed(1) }, s);
      svg('text', { class: 'rcd-tick rcd-tick--end', x: L - 8, y: (sy(v) + 4).toFixed(1), text: v }, s);
    }
    const every = bins.length > 9 ? 2 : 1;
    bins.forEach((b, i) => {
      const lastOpen = openEnd && i === bins.length - 1;
      if (lastOpen || (i % every === 0 && !(openEnd && every > 1 && i === bins.length - 2))) svg('text', { class: 'rcd-tick rcd-tick--mid', x: sx(b.from + (lastOpen ? binMs / 2 : 0)).toFixed(1), y: H - B + 18, text: lastOpen ? b.from + '+' : b.from }, s);
    });
    if (!openEnd) svg('text', { class: 'rcd-tick rcd-tick--mid', x: sx(x1).toFixed(1), y: H - B + 18, text: x1 }, s);
    svg('line', { class: 'rcd-axis', x1: L, x2: W - R, y1: H - B, y2: H - B }, s);
    svg('text', { class: 'rcd-axis-title rcd-tick--mid', x: (L + W - R) / 2, y: H - 10, text: 'Length of pause (ms)' }, s);
    svg('text', { class: 'rcd-axis-title', x: 6, y: T - 30, text: 'Fixations' }, s);

    const tip = U.tip(wrap);
    const base = H - B;
    bins.forEach((b, i) => {
      const xa = sx(b.from) + 1, xb = sx(b.from + binMs) - 1, w = Math.max(1, xb - xa), top = sy(b.count), r = Math.min(4, w / 2, Math.max(0, base - top));
      if (b.count > 0) {
        svg('path', { class: 'rcd-bar', d: 'M' + xa.toFixed(1) + ' ' + base + 'V' + (top + r).toFixed(1) + 'q0 ' + (-r) + ' ' + r + ' ' + (-r) + 'h' + (w - 2 * r).toFixed(1) + 'q' + r + ' 0 ' + r + ' ' + r + 'V' + base + 'z' }, s);
      }
      const hit = svg('rect', { class: 'rcd-hit', x: sx(b.from).toFixed(1), y: T, width: (sx(b.from + binMs) - sx(b.from)).toFixed(1), height: base - T }, s);
      const open = openEnd && i === bins.length - 1;
      hit.addEventListener('pointermove', (e) => {
        tip.show(e.clientX, e.clientY, open ? b.from + ' ms or longer' : b.from + '–' + (b.from + binMs) + ' ms', [
          ['Fixations', String(b.count), 'rcd-key--bar'], ['Share', Math.round(100 * b.count / totalN) + '%'],
        ]);
      });
      hit.addEventListener('pointerleave', () => tip.hide());
    });

    // mean (solid) and median (dashed), labelled on opposite sides so they never collide
    const marks = [];
    if (fin(m.meanFixMs)) marks.push({ v: m.meanFixMs, label: 'Mean ' + Math.round(m.meanFixMs) + ' ms', cls: 'rcd-mark--mean' });
    if (fin(m.medianFixMs)) marks.push({ v: m.medianFixMs, label: 'Median ' + Math.round(m.medianFixMs) + ' ms', cls: 'rcd-mark--median' });
    marks.sort((p, q) => p.v - q.v);
    marks.forEach((k, i) => {
      const x = sx(k.v), leftSide = marks.length === 2 ? i === 0 : x > (L + W - R) / 2;
      svg('line', { class: 'rcd-mark ' + k.cls, x1: x.toFixed(1), x2: x.toFixed(1), y1: T - 12, y2: base }, s);
      svg('text', { class: 'rcd-mark__label ' + (leftSide ? 'rcd-tick--end' : ''), x: (x + (leftSide ? -6 : 6)).toFixed(1), y: T - 8 - (marks.length === 2 && Math.abs(sx(marks[1].v) - sx(marks[0].v)) < 4 && i === 1 ? 14 : 0), text: k.label }, s);
    });

    wrap.appendChild(U.legend([
      ['rcd-key--bar', 'Fixations'],
      range ? ['rcd-key--range', 'Typical range, ' + range[0] + '–' + range[1] + ' ms'] : null,
      marks.length ? ['rcd-key--mean', 'Mean'] : null,
      marks.length > 1 ? ['rcd-key--median', 'Median (dashed)'] : null,
    ]));
    container.appendChild(wrap);
    return { destroy() { tip.destroy(); } };
  }

  RC.histogram = { render };
})();
