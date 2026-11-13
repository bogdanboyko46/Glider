/*
 * charts/staircase.js — gaze x over time (sawtooth), gaze y over time (staircase), fixation strip, blinks.
 * RCCharts.staircase.render(container, { session, analysis }, opts)
 *   opts: { onHover(tMs|null), onSeek(tMs) }
 *   returns { setCursor(tMs|null), destroy() }      setCursor drives the playhead from the replay
 */
(function () {
  'use strict';
  const RC = (window.RCCharts = window.RCCharts || {});
  const NOOP = () => {};

  function render(container, data, opts) {
    const U = RC.util;
    if (!U || !container) return { setCursor: NOOP, destroy: NOOP };
    opts = opts || {};
    const { h, svg, clamp, fin } = U;
    const session = (data && data.session) || {}, a = (data && data.analysis) || {};
    const gaze = (Array.isArray(session.gaze) ? session.gaze : []).filter((g) => g && fin(g.t) && fin(g.x) && fin(g.y));
    const fx = (Array.isArray(a.fixations) ? a.fixations : []).filter((f) => f && fin(f.t) && fin(f.dur) && fin(f.x) && fin(f.y));
    const allFx = Array.isArray(a.fixations) ? a.fixations : [];
    const lineRects = Array.isArray(session.lineRects) ? session.lineRects.filter((l) => l && fin(l.top) && fin(l.bottom)) : [];
    const blinks = (Array.isArray(a.blinks) ? a.blinks : []).filter((b) => b && fin(b.t));
    const b = a.bounds;
    container.textContent = '';
    if (gaze.length < 2 || !b || !fin(b.left) || !fin(b.right) || !fin(b.top) || !fin(b.bottom)) {
      container.appendChild(U.empty('No gaze samples were recorded for this chart.'));
      return { setCursor: NOOP, destroy: NOOP };
    }
    const kindAll = U.kinds(a);
    const kindOf = (f) => kindAll[allFx.indexOf(f)] || 'forward';
    const fk = fx.map(kindOf);

    const W = 1100, H = 412, L = 70, R = 18;
    const PX = { y0: 30, y1: 148 }, PY = { y0: 184, y1: 322 }, PF = { y0: 346, y1: 364 };
    const lastG = gaze[gaze.length - 1].t, lastF = fx.length ? fx[fx.length - 1].t + fx[fx.length - 1].dur : 0;
    const total = Math.max(1, fin(a.readMs) ? a.readMs : 0, lastG, lastF);
    const padX = 0.06 * (b.right - b.left || 1), padY = 0.08 * (b.bottom - b.top || 1);
    const xd = [b.left - padX, b.right + padX], yd = [b.top - padY, b.bottom + padY];
    const sx = (t) => L + (W - L - R) * clamp(t / total, 0, 1);
    const yx = (x) => PX.y1 - (PX.y1 - PX.y0) * clamp((x - xd[0]) / ((xd[1] - xd[0]) || 1), 0, 1);     // right edge of the line at the top
    const yy = (y) => PY.y0 + (PY.y1 - PY.y0) * clamp((y - yd[0]) / ((yd[1] - yd[0]) || 1), 0, 1);     // top of the page at the top

    const wrap = h('div', { class: 'rcd-stair' });
    const regN = fk.filter((k) => k === 'regress').length;
    const s = svg('svg', {
      class: 'rcd-svg rcd-stair__svg', viewBox: '0 0 ' + W + ' ' + H, role: 'img', tabindex: 0,
      'aria-label': 'Reading rhythm over ' + U.secs(total) + '. Horizontal gaze position forms a sawtooth, one tooth per line; vertical position steps down ' +
        lineRects.length + ' lines. ' + fx.length + ' fixations, ' + regN + ' after a jump back, ' + blinks.length + ' blinks. Use the left and right arrow keys to move through time.',
    });
    wrap.appendChild(s);

    const pid = U.uid('rcd-hatch');
    const defs = svg('defs', null, s);
    const pat = svg('pattern', { id: pid, patternUnits: 'userSpaceOnUse', width: 6, height: 6, patternTransform: 'rotate(45)' }, defs);
    svg('rect', { width: 6, height: 6, class: 'rcd-fill-regress' }, pat);
    svg('rect', { width: 2.2, height: 6, fill: '#fff', opacity: 0.6 }, pat);

    // panels, grid, axis
    for (const p of [PX, PY]) svg('rect', { class: 'rcd-plot', x: L, y: p.y0, width: W - L - R, height: p.y1 - p.y0, rx: 6 }, s);
    svg('text', { class: 'rcd-axis-title', x: L, y: PX.y0 - 9, text: 'Across the line' }, s);
    svg('text', { class: 'rcd-axis-title', x: L, y: PY.y0 - 9, text: 'Down the page' }, s);
    svg('text', { class: 'rcd-axis-title', x: L, y: PF.y0 - 7, text: 'Fixations' }, s);
    svg('text', { class: 'rcd-tick rcd-tick--end', x: L - 8, y: PX.y0 + 12, text: 'Line end' }, s);
    svg('text', { class: 'rcd-tick rcd-tick--end', x: L - 8, y: PX.y1 - 4, text: 'Line start' }, s);
    const stepL = lineRects.length > 12 ? Math.ceil(lineRects.length / 8) : 1;
    lineRects.forEach((l, i) => {
      const y = yy((l.top + l.bottom) / 2);
      svg('line', { class: 'rcd-grid', x1: L, x2: W - R, y1: y.toFixed(1), y2: y.toFixed(1) }, s);
      if (i % stepL === 0) svg('text', { class: 'rcd-tick rcd-tick--end', x: L - 8, y: (y + 4).toFixed(1), text: 'Line ' + (i + 1) }, s);
    });
    for (const tv of U.ticks(0, total / 1000, 9)) {
      const x = sx(tv * 1000);
      svg('line', { class: 'rcd-grid rcd-grid--v', x1: x.toFixed(1), x2: x.toFixed(1), y1: PX.y0, y2: PF.y1 }, s);
      svg('text', { class: 'rcd-tick rcd-tick--mid', x: x.toFixed(1), y: PF.y1 + 23, text: tv + ' s' }, s);
    }
    svg('text', { class: 'rcd-axis-title rcd-tick--mid', x: (L + W - R) / 2, y: H - 6, text: 'Time since the read began' }, s);

    // blinks: a band through every panel plus a marker on top, never colour alone
    for (const bl of blinks) {
      const x = sx(bl.t), w = Math.max(2.5, sx(bl.t + (fin(bl.dur) ? bl.dur : 150)) - x);
      svg('rect', { class: 'rcd-blink', x: x.toFixed(1), y: PX.y0, width: w.toFixed(1), height: PF.y1 - PX.y0 }, s);
      svg('path', { class: 'rcd-blink__mark', d: 'M' + (x + w / 2 - 5).toFixed(1) + ' ' + (PF.y1 + 9) + 'h10l-5 -7z' }, s);
    }

    // raw gaze, broken where the samples stop (blinks, lost face)
    let dX = '', dY = '', prevT = -1e9;
    for (const g of gaze) {
      const cmd = g.t - prevT > 130 ? 'M' : 'L';
      const x = sx(g.t).toFixed(1);
      dX += cmd + x + ' ' + yx(g.x).toFixed(1);
      dY += cmd + x + ' ' + yy(g.y).toFixed(1);
      prevT = g.t;
    }
    svg('path', { class: 'rcd-stair__raw', d: dX }, s);
    svg('path', { class: 'rcd-stair__raw', d: dY }, s);

    // fixations: a segment on each curve and a bar on the strip
    const gf = svg('g', null, s);
    fx.forEach((f, i) => {
      const k = fk[i], x1 = sx(f.t), x2 = Math.max(x1 + 1.5, sx(f.t + f.dur));
      const ax = yx(f.x).toFixed(1), ay = yy(f.y).toFixed(1);
      svg('line', { class: 'rcd-stair__fix rcd-stroke-' + k, x1: x1.toFixed(1), x2: x2.toFixed(1), y1: ax, y2: ax }, gf);
      svg('line', { class: 'rcd-stair__fix rcd-stroke-' + k, x1: x1.toFixed(1), x2: x2.toFixed(1), y1: ay, y2: ay }, gf);
      const r = svg('rect', { class: 'rcd-stair__bar rcd-fill-' + k, x: x1.toFixed(1), y: k === 'regress' ? PF.y0 - 5 : PF.y0, width: Math.max(1.5, x2 - x1 - 1).toFixed(1), height: k === 'regress' ? PF.y1 - PF.y0 + 5 : PF.y1 - PF.y0, rx: 2 }, gf);
      if (k === 'regress') r.style.fill = 'url(#' + pid + ')';
    });

    // playhead (from the replay) and hover cursor
    const head = svg('line', { class: 'rcd-stair__head', y1: PX.y0 - 4, y2: PF.y1 + 4, visibility: 'hidden' }, s);
    const cur = svg('g', { visibility: 'hidden' }, s);
    const curLine = svg('line', { class: 'rcd-cursor', y1: PX.y0, y2: PF.y1 }, cur);
    const curA = svg('circle', { class: 'rcd-cursor__dot', r: 5 }, cur), curB = svg('circle', { class: 'rcd-cursor__dot', r: 5 }, cur);
    const hit = svg('rect', { class: 'rcd-hit', x: L, y: PX.y0 - 10, width: W - L - R, height: PF.y1 - PX.y0 + 20 }, s);

    wrap.appendChild(U.legend([
      ['rcd-key--raw', 'Raw gaze'],
      ['rcd-key--forward', 'Fixation after a forward move'],
      ['rcd-key--regress', 'Fixation after a jump back'],
      ['rcd-key--sweep', 'First fixation on a new line'],
      fk.indexOf('off') >= 0 ? ['rcd-key--off', 'Away from the text'] : null,
      blinks.length ? ['rcd-key--blink', 'Blink'] : null,
    ]));
    container.appendChild(wrap);
    const tip = U.tip(wrap);

    function nearestGaze(t) {
      let lo = 0, hi = gaze.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (gaze[mid].t < t) lo = mid + 1; else hi = mid; }
      if (lo > 0 && Math.abs(gaze[lo - 1].t - t) < Math.abs(gaze[lo].t - t)) lo--;
      return gaze[lo];
    }
    function fixAt(t) {
      let best = -1;
      for (let i = 0; i < fx.length; i++) { if (fx[i].t <= t) best = i; else break; }
      return best >= 0 && t <= fx[best].t + fx[best].dur + 60 ? best : -1;
    }
    let dead = false, kbT = null;
    function showAt(t, clientX, clientY) {
      t = clamp(t, 0, total);
      const x = sx(t).toFixed(1), g = nearestGaze(t), i = fixAt(t);
      curLine.setAttribute('x1', x); curLine.setAttribute('x2', x);
      curA.setAttribute('cx', x); curA.setAttribute('cy', yx(g.x).toFixed(1));
      curB.setAttribute('cx', x); curB.setAttribute('cy', yy(g.y).toFixed(1));
      cur.setAttribute('visibility', 'visible');
      const f = i >= 0 ? fx[i] : null;
      const bl = blinks.find((q) => t >= q.t && t <= q.t + (fin(q.dur) ? q.dur : 150));
      tip.show(clientX, clientY, U.secs(t), [
        f ? ['Fixation', '#' + (allFx.indexOf(f) + 1) + ', ' + Math.round(f.dur) + ' ms', 'rcd-key--' + fk[i]] : ['Fixation', bl ? 'blink' : 'between pauses'],
        f ? ['Line', f.line >= 0 ? String(f.line + 1) : 'off the text'] : null,
        f ? ['Movement', U.KIND_LABEL[fk[i]] || 'Forward'] : null,
      ]);
      if (typeof opts.onHover === 'function') { try { opts.onHover(t); } catch (e) { /* listener's problem */ } }
    }
    function hide() {
      cur.setAttribute('visibility', 'hidden');
      tip.hide();
      if (typeof opts.onHover === 'function') { try { opts.onHover(null); } catch (e) { /* listener's problem */ } }
    }
    const tOf = (e) => clamp((U.pt(s, e, W, H).x - L) / (W - L - R), 0, 1) * total;
    hit.addEventListener('pointermove', (e) => { if (!dead) showAt(tOf(e), e.clientX, e.clientY); });
    hit.addEventListener('pointerleave', () => { if (!dead) hide(); });
    hit.addEventListener('click', (e) => { if (!dead && typeof opts.onSeek === 'function') { try { opts.onSeek(tOf(e)); } catch (err) { /* listener's problem */ } } });
    s.addEventListener('keydown', (e) => {
      if (dead) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        kbT = clamp((kbT == null ? 0 : kbT) + (e.key === 'ArrowRight' ? 1 : -1) * total / 80, 0, total);
        const r = s.getBoundingClientRect();
        showAt(kbT, r.left + r.width * sx(kbT) / W, r.top + r.height * 0.3);
      } else if (e.key === 'Enter' && kbT != null && typeof opts.onSeek === 'function') {
        try { opts.onSeek(kbT); } catch (err) { /* listener's problem */ }
      } else if (e.key === 'Escape') hide();
    });
    s.addEventListener('blur', () => { if (!dead && kbT != null) { kbT = null; hide(); } });

    return {
      setCursor(t) {
        if (dead) return;
        if (t == null || !fin(t)) { head.setAttribute('visibility', 'hidden'); return; }
        const x = sx(t).toFixed(1);
        head.setAttribute('x1', x); head.setAttribute('x2', x);
        head.setAttribute('visibility', t >= total ? 'hidden' : 'visible');
      },
      destroy() { dead = true; tip.destroy(); },
    };
  }

  RC.staircase = { render };
})();
