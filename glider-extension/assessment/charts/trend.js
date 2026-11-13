/*
 * charts/trend.js — a small single-series line chart for values over time (one measure per chart,
 * used as small multiples). RCCharts.trend.render(container, spec)
 *   spec: { title, points: [{ x, y|null, label }], format(v), xLabels: [first, last], range: [lo, hi]|null,
 *           dots: bool (mark every point), unit: string }
 */
(function () {
  'use strict';
  const RC = (window.RCCharts = window.RCCharts || {});
  const NOOP = () => {};

  function render(container, spec) {
    const U = RC.util;
    if (!U || !container) return { destroy: NOOP };
    const { h, svg, clamp, fin } = U;
    spec = spec || {};
    const all = (Array.isArray(spec.points) ? spec.points : []).filter((p) => p && fin(p.x));
    const pts = all.filter((p) => fin(p.y));
    const fmt = typeof spec.format === 'function' ? spec.format : (v) => String(Math.round(v * 10) / 10);
    container.textContent = '';
    if (!pts.length) { container.appendChild(U.empty('Not enough data yet.')); return { destroy: NOOP }; }

    const W = 360, H = 176, L = 40, R = 46, T = 14, B = 28;
    const range = Array.isArray(spec.range) && fin(spec.range[0]) && fin(spec.range[1]) ? spec.range : null;
    const xs = all.map((p) => p.x), ys = pts.map((p) => p.y);
    const xa = Math.min.apply(null, xs), xb = Math.max.apply(null, xs);
    let lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
    if (range) {            // keep the typical band in view when the data is near it
      const span = Math.max(hi - lo, range[1] - range[0]);
      if (range[0] > lo - span && range[1] < hi + span) { lo = Math.min(lo, range[0]); hi = Math.max(hi, range[1]); }
    }
    if (hi - lo < 1e-9) { const pad = Math.abs(hi) * 0.1 || 1; lo -= pad; hi += pad; }
    const padV = (hi - lo) * 0.12;
    lo -= padV; hi += padV;
    const sx = (x) => (xb > xa ? L + (W - L - R) * (x - xa) / (xb - xa) : (L + W - R) / 2);
    const sy = (y) => H - B - (H - B - T) * clamp((y - lo) / (hi - lo), 0, 1);

    const first = pts[0], last = pts[pts.length - 1];
    const wrap = h('div', { class: 'rcd-trendchart' });
    const s = svg('svg', {
      class: 'rcd-svg', viewBox: '0 0 ' + W + ' ' + H, role: 'img',
      'aria-label': (spec.title || 'Trend') + ': ' + pts.length + ' points, from ' + fmt(first.y) + ' to ' + fmt(last.y) +
        '. Lowest ' + fmt(Math.min.apply(null, ys)) + ', highest ' + fmt(Math.max.apply(null, ys)) + '.',
    });
    wrap.appendChild(s);

    if (range) {
      const ya = sy(Math.min(range[1], hi)), yb = sy(Math.max(range[0], lo));
      if (yb > ya) svg('rect', { class: 'rcd-range-band', x: L, y: ya.toFixed(1), width: W - L - R, height: (yb - ya).toFixed(1) }, s);
    }
    for (const v of U.ticks(lo, hi, 3)) {
      svg('line', { class: 'rcd-grid', x1: L, x2: W - R, y1: sy(v).toFixed(1), y2: sy(v).toFixed(1) }, s);
      svg('text', { class: 'rcd-tick rcd-tick--end', x: L - 6, y: (sy(v) + 4).toFixed(1), text: Math.round(v * 100) / 100 }, s);
    }
    const xl = Array.isArray(spec.xLabels) ? spec.xLabels : [];
    if (xl[0]) svg('text', { class: 'rcd-tick', x: L, y: H - 8, text: xl[0] }, s);
    if (xl[1] && xb > xa) svg('text', { class: 'rcd-tick rcd-tick--end', x: W - R, y: H - 8, text: xl[1] }, s);

    // the line, broken at missing values
    let d = '', pen = false;
    for (const p of all) {
      if (!fin(p.y)) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + sx(p.x).toFixed(1) + ' ' + sy(p.y).toFixed(1);
      pen = true;
    }
    if (pts.length > 1) svg('path', { class: 'rcd-trend__line', d }, s);
    if (spec.dots || pts.length === 1) for (const p of pts) if (p !== last) svg('circle', { class: 'rcd-trend__dot', cx: sx(p.x).toFixed(1), cy: sy(p.y).toFixed(1), r: 3.5 }, s);
    svg('circle', { class: 'rcd-trend__last', cx: sx(last.x).toFixed(1), cy: sy(last.y).toFixed(1), r: 5 }, s);
    svg('text', { class: 'rcd-trend__value', x: Math.min(W - 2, sx(last.x) + 9).toFixed(1), y: (sy(last.y) + 4).toFixed(1), text: fmt(last.y) }, s);

    const cur = svg('g', { visibility: 'hidden' }, s);
    const curLine = svg('line', { class: 'rcd-cursor', y1: T, y2: H - B }, cur);
    const curDot = svg('circle', { class: 'rcd-cursor__dot', r: 5 }, cur);
    const hit = svg('rect', { class: 'rcd-hit', x: L - 8, y: 0, width: W - L - R + 16, height: H - B + 4 }, s);
    const tip = U.tip(wrap);
    hit.addEventListener('pointermove', (e) => {
      const x = U.pt(s, e, W, H).x;
      let best = pts[0], bd = Infinity;
      for (const p of pts) { const dd = Math.abs(sx(p.x) - x); if (dd < bd) { bd = dd; best = p; } }
      const px = sx(best.x).toFixed(1);
      curLine.setAttribute('x1', px); curLine.setAttribute('x2', px);
      curDot.setAttribute('cx', px); curDot.setAttribute('cy', sy(best.y).toFixed(1));
      cur.setAttribute('visibility', 'visible');
      tip.show(e.clientX, e.clientY, best.label || '', [
        [spec.title || 'Value', fmt(best.y) + (spec.unit ? ' ' + spec.unit : ''), 'rcd-key--cur'],
        range ? ['Typical range', fmt(range[0]) + '–' + fmt(range[1]), 'rcd-key--range'] : null,
      ]);
    });
    hit.addEventListener('pointerleave', () => { cur.setAttribute('visibility', 'hidden'); tip.hide(); });

    container.appendChild(wrap);
    return { destroy() { tip.destroy(); } };
  }

  RC.trend = { render };
})();
