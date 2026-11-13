/*
 * charts/radar.js — the five-score reading profile, with the previous test overlaid when there is one.
 * RCCharts.radar.render(container, { profile, previous, previousLabel })
 */
(function () {
  'use strict';
  const RC = (window.RCCharts = window.RCCharts || {});
  const NOOP = () => {};
  const AXES = [
    ['speed', 'Speed', 'Words a minute against the typical range'],
    ['fluency', 'Fluency', 'Few jumps back and few re-read lines'],
    ['efficiency', 'Efficiency', 'Few stops per word'],
    ['steadiness', 'Steadiness', 'Steady gaze and a still head'],
    ['comprehension', 'Comprehension', 'Share of questions answered correctly'],
  ];

  function render(container, data) {
    const U = RC.util;
    if (!U || !container) return { destroy: NOOP };
    const { h, svg, clamp, fin } = U;
    const p = (data && data.profile) || null, prev = (data && data.previous) || null;
    container.textContent = '';
    if (!p || !AXES.some((a) => fin(p[a[0]]))) { container.appendChild(U.empty('No profile is available for this read.')); return { destroy: NOOP }; }
    const hasPrev = !!prev && AXES.some((a) => fin(prev[a[0]]));

    const W = 540, H = 400, cx = W / 2, cy = 204, R = 132, n = AXES.length;
    const ang = (i) => -Math.PI / 2 + (2 * Math.PI * i) / n;
    const at = (i, v) => { const r = R * clamp(fin(v) ? v : 0, 0, 100) / 100; return [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))]; };
    const poly = (v) => AXES.map((_, i) => at(i, typeof v === 'number' ? v : v[AXES[i][0]]).map((q) => q.toFixed(1)).join(',')).join(' ');

    const wrap = h('div', { class: 'rcd-radar' });
    const s = svg('svg', {
      class: 'rcd-svg', viewBox: '0 0 ' + W + ' ' + H, role: 'img',
      'aria-label': 'Reading profile. ' + AXES.map((a) => a[1] + ' ' + (fin(p[a[0]]) ? Math.round(p[a[0]]) : 'not available')).join(', ') + '.' +
        (hasPrev ? ' Previous test: ' + AXES.map((a) => a[1] + ' ' + (fin(prev[a[0]]) ? Math.round(prev[a[0]]) : 'not available')).join(', ') + '.' : ''),
    });
    wrap.appendChild(s);

    // typical band (scores 50 to 85) as a ring, then the grid
    svg('path', { class: 'rcd-range-band', 'fill-rule': 'evenodd', d: 'M' + poly(85).replace(/ /g, 'L') + 'Z M' + poly(50).replace(/ /g, 'L') + 'Z' }, s);
    for (const v of [25, 50, 75, 100]) svg('polygon', { class: 'rcd-grid rcd-grid--ring' + (v === 100 ? ' rcd-grid--outer' : ''), points: poly(v) }, s);
    AXES.forEach((_, i) => { const e = at(i, 100); svg('line', { class: 'rcd-grid', x1: cx, y1: cy, x2: e[0].toFixed(1), y2: e[1].toFixed(1) }, s); });
    for (const v of [50, 100]) svg('text', { class: 'rcd-tick rcd-radar__ring', x: cx + 5, y: (cy - R * v / 100 + 12).toFixed(1), text: v }, s);

    if (hasPrev) svg('polygon', { class: 'rcd-radar__prev', points: poly(prev) }, s);
    svg('polygon', { class: 'rcd-radar__cur', points: poly(p) }, s);

    const tip = U.tip(wrap);
    AXES.forEach((a, i) => {
      const v = p[a[0]], c = Math.cos(ang(i)), sn = Math.sin(ang(i));
      const lx = cx + (R + 16) * c, ly = cy + (R + 16) * sn;
      const anchor = Math.abs(c) < 0.2 ? 'middle' : c > 0 ? 'start' : 'end';
      const dy = sn < -0.5 ? -18 : sn > 0.5 ? 12 : -4;
      svg('text', { class: 'rcd-radar__label', x: lx.toFixed(1), y: (ly + dy).toFixed(1), 'text-anchor': anchor, text: a[1] }, s);
      svg('text', { class: 'rcd-radar__score', x: lx.toFixed(1), y: (ly + dy + 19).toFixed(1), 'text-anchor': anchor, text: fin(v) ? Math.round(v) : U.DASH }, s);
      if (hasPrev && fin(prev[a[0]])) { const q = at(i, prev[a[0]]); svg('circle', { class: 'rcd-radar__prevdot', cx: q[0].toFixed(1), cy: q[1].toFixed(1), r: 3.5 }, s); }
      const d = at(i, v);
      if (fin(v)) svg('circle', { class: 'rcd-radar__dot', cx: d[0].toFixed(1), cy: d[1].toFixed(1), r: 5 }, s);
      const hit = svg('circle', { class: 'rcd-hit', cx: d[0].toFixed(1), cy: d[1].toFixed(1), r: 20 }, s);
      hit.addEventListener('pointermove', (e) => {
        tip.show(e.clientX, e.clientY, a[1], [
          ['This test', fin(v) ? String(Math.round(v)) : U.DASH, 'rcd-key--cur'],
          hasPrev ? ['Previous test', fin(prev[a[0]]) ? String(Math.round(prev[a[0]])) : U.DASH, 'rcd-key--prev'] : null,
          [a[2], ''],
        ]);
      });
      hit.addEventListener('pointerleave', () => tip.hide());
    });

    wrap.appendChild(U.legend([
      ['rcd-key--cur', 'This test'],
      hasPrev ? ['rcd-key--prev', 'Previous test' + (data.previousLabel ? ' (' + data.previousLabel + ')' : '') + ', dashed'] : null,
      ['rcd-key--range', 'Typical range (scores 50–85)'],
    ]));
    wrap.appendChild(h('p', { class: 'rcd-note', text: 'Speed, fluency, efficiency and steadiness are scored against the typical range for the age group. Comprehension is the share of questions answered correctly.' }));
    container.appendChild(wrap);
    return { destroy() { tip.destroy(); } };
  }

  RC.radar = { render };
})();
