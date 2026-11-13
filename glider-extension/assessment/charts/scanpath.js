/*
 * charts/scanpath.js — the scanpath replay. RCCharts.scanpath.render(container, { session, analysis }, opts)
 *   opts: { reducedMotion: bool, autoplay: bool (default true), onTick(tMs) }
 *   returns { play(), pause(), seek(tMs), showAll(), highlight(tMs|null), highlightLine(index|null), destroy() }
 * Nodes are created once; playback only toggles classes and moves one dot.
 */
(function () {
  'use strict';
  const RC = (window.RCCharts = window.RCCharts || {});
  const NOOP = () => {};
  const inert = () => ({ play: NOOP, pause: NOOP, seek: NOOP, showAll: NOOP, highlight: NOOP, highlightLine: NOOP, destroy: NOOP });

  // sequential single-hue ramp for the heatmap: [alpha stop, r, g, b, out alpha]
  const RAMP = [[0, 190, 212, 244, 0], [0.3, 128, 168, 228, 0.46], [0.65, 36, 86, 166, 0.62], [1, 22, 46, 104, 0.74]];
  function buildLut() {
    const lut = new Uint8ClampedArray(256 * 4);
    for (let i = 0; i < 256; i++) {
      const a = i / 255;
      let k = 1;
      while (k < RAMP.length - 1 && a > RAMP[k][0]) k++;
      const p = RAMP[k - 1], q = RAMP[k], f = Math.min(1, Math.max(0, (a - p[0]) / ((q[0] - p[0]) || 1)));
      for (let c = 0; c < 3; c++) lut[i * 4 + c] = p[c + 1] + (q[c + 1] - p[c + 1]) * f;
      lut[i * 4 + 3] = 255 * (p[4] + (q[4] - p[4]) * f);
    }
    return lut;
  }

  function render(container, data, opts) {
    const U = RC.util;
    if (!U || !container) return inert();
    opts = opts || {};
    const { h, svg, clamp, fin } = U;
    const session = (data && data.session) || {}, a = (data && data.analysis) || {};
    const fx = Array.isArray(a.fixations) ? a.fixations : [];
    const lineRects = Array.isArray(session.lineRects) ? session.lineRects.filter((l) => l && fin(l.left) && fin(l.top) && fin(l.right) && fin(l.bottom)) : [];
    const words = Array.isArray(session.wordBoxes) ? session.wordBoxes.filter((w) => w && fin(w.left) && fin(w.top) && fin(w.right) && fin(w.bottom)) : [];
    let b = a.bounds;
    if (!b || !fin(b.left) || !fin(b.right) || !fin(b.top) || !fin(b.bottom)) {
      b = lineRects.length ? {
        left: Math.min.apply(null, lineRects.map((l) => l.left)), right: Math.max.apply(null, lineRects.map((l) => l.right)),
        top: Math.min.apply(null, lineRects.map((l) => l.top)), bottom: Math.max.apply(null, lineRects.map((l) => l.bottom)),
      } : null;
    }
    container.textContent = '';
    if (!fx.length || !b || !(b.right > b.left) || !(b.bottom > b.top)) {
      container.appendChild(U.empty('No eye movements were recorded for the replay.'));
      return inert();
    }

    const PAD = 54;
    const vb = { x: b.left - PAD, y: b.top - PAD, w: b.right - b.left + 2 * PAD, h: b.bottom - b.top + 2 * PAD };
    const px = (f) => clamp(fin(f.x) ? f.x : vb.x, vb.x + 16, vb.x + vb.w - 16);
    const py = (f) => clamp(fin(f.y) ? f.y : vb.y, vb.y + 16, vb.y + vb.h - 16);
    const rad = (f) => clamp(5 + 0.62 * Math.sqrt(Math.max(0, fin(f.dur) ? f.dur : 0)), 8, 30);
    const ft = (f) => (fin(f.t) ? f.t : 0), fd = (f) => (fin(f.dur) ? f.dur : 0);
    const kinds = U.kinds(a);
    const last = fx[fx.length - 1];
    const total = Math.max(1, fin(a.readMs) ? a.readMs : 0, ft(last) + fd(last));
    const maxDur = Math.max.apply(null, fx.map(fd).concat([1]));
    const reduced = opts.reducedMotion != null ? !!opts.reducedMotion
      : !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    // ---------------------------------------------------------------- DOM
    const root = h('div', { class: 'rcd-scan', 'data-mode': 'scan' });
    const stage = h('div', { class: 'rcd-scan__stage' });
    stage.style.aspectRatio = vb.w.toFixed(1) + ' / ' + vb.h.toFixed(1);
    const canvas = h('canvas', { class: 'rcd-scan__heat', 'aria-hidden': 'true' });
    const m = a.metrics || {};
    const s = svg('svg', {
      class: 'rcd-svg rcd-scan__svg', viewBox: [vb.x, vb.y, vb.w, vb.h].map((v) => v.toFixed(1)).join(' '), role: 'img',
      'aria-label': 'Scanpath replay. ' + fx.length + ' fixations over ' + lineRects.length + ' lines in ' + U.secs(total) + ', with ' +
        (fin(m.regressions) ? m.regressions : kinds.filter((k) => k === 'regress').length) + ' jumps back.',
    });
    stage.appendChild(canvas);
    stage.appendChild(s);

    const lineHi = svg('rect', { class: 'rcd-scan__linehi', rx: 8, visibility: 'hidden' }, s);
    const gWords = svg('g', { class: 'rcd-scan__words' }, s);
    const fontPx = session.passage && fin(session.passage.fontPx) ? session.passage.fontPx : null;
    const lineText = lineRects.length > 0 && lineRects.every((l) => typeof l.text === 'string' && l.text);
    if (words.length && !lineText) {
      for (const w of words) {
        const hh = w.bottom - w.top, fs = clamp(fontPx || hh / 1.3, 6, Math.max(6, hh));
        const t = svg('text', { x: w.left.toFixed(1), y: (w.top + hh / 2 + fs * 0.34).toFixed(1), 'font-size': fs.toFixed(1), text: w.text == null ? '' : w.text }, gWords);
        if (w.right - w.left > 2) { t.setAttribute('textLength', (w.right - w.left).toFixed(1)); t.setAttribute('lengthAdjust', 'spacingAndGlyphs'); }
      }
    } else {
      for (const l of lineRects) {
        const hh = l.bottom - l.top, fs = clamp(fontPx || hh / 1.3, 6, Math.max(6, hh));
        const t = svg('text', { x: l.left.toFixed(1), y: (l.top + hh / 2 + fs * 0.34).toFixed(1), 'font-size': fs.toFixed(1), text: l.text == null ? '' : l.text }, gWords);
        if (l.right - l.left > 2) { t.setAttribute('textLength', (l.right - l.left).toFixed(1)); t.setAttribute('lengthAdjust', 'spacing'); }
      }
    }

    const gPaths = svg('g', { class: 'rcd-scan__paths' }, s);
    const gSacc = svg('g', null, gPaths), gFix = svg('g', null, gPaths);
    const sacL = [], fixG = [];
    for (let i = 0; i < fx.length; i++) {
      const f = fx[i], k = kinds[i] || 'forward';
      if (i > 0) {
        const p = fx[i - 1], sk = kinds[i - 1] === 'off' && k !== 'off' ? 'off' : k;
        sacL.push(svg('line', { class: 'rcd-sacc rcd-sacc--' + sk, x1: px(p).toFixed(1), y1: py(p).toFixed(1), x2: px(f).toFixed(1), y2: py(f).toFixed(1) }, gSacc));
      }
      const g = svg('g', { class: 'rcd-fix rcd-fix--' + k, 'data-i': i }, gFix);
      svg('circle', { cx: px(f).toFixed(1), cy: py(f).toFixed(1), r: rad(f).toFixed(1) }, g);
      svg('text', { x: px(f).toFixed(1), y: (py(f) + 3.6).toFixed(1), text: i + 1 }, g);
      fixG.push(g);
    }
    const ring = svg('circle', { class: 'rcd-scan__ring', r: 20, visibility: 'hidden' }, s);
    const dot = svg('circle', { class: 'rcd-scan__dot', r: 6, visibility: 'hidden' }, s);

    // controls
    const playBtn = h('button', { type: 'button', class: 'rc-btn rc-btn--primary rcd-scan__play' });
    const playLabel = h('span', { text: 'Play' });
    let playIcon = U.icon('play', 16);
    playBtn.appendChild(playIcon); playBtn.appendChild(playLabel);
    const slider = h('input', { type: 'range', class: 'rcd-scan__slider', min: 0, max: Math.round(total), step: 10, value: 0, 'aria-label': 'Replay position' });
    const timeLbl = h('span', { class: 'rcd-scan__time', text: '' });
    const group = (label, items, cur, onPick) => {
      const g = h('div', { class: 'rcd-seg', role: 'group', 'aria-label': label });
      const btns = items.map(([val, text]) => {
        const bt = h('button', { type: 'button', class: 'rcd-seg__btn', 'aria-pressed': val === cur ? 'true' : 'false', text });
        bt.addEventListener('click', () => { btns.forEach((x) => x.setAttribute('aria-pressed', x === bt ? 'true' : 'false')); onPick(val); });
        g.appendChild(bt);
        return bt;
      });
      return g;
    };
    const controls = h('div', { class: 'rcd-scan__controls rcd-noprint' }, [
      h('div', { class: 'rcd-scan__transport' }, [playBtn, slider, timeLbl]),
      h('div', { class: 'rcd-scan__options' }, [
        group('Playback speed', [[0.5, '0.5×'], [1, '1×'], [2, '2×'], [4, '4×']], 1, (v) => { speed = v; }),
        group('View', [['scan', 'Scanpath'], ['heat', 'Heatmap'], ['both', 'Both']], 'scan', (v) => { mode = v; root.setAttribute('data-mode', v); if (v !== 'scan') heatTo(shown); }),
      ]),
    ]);

    // side panel: live readout + legend
    const rTitle = h('p', { class: 'rcd-scan__now', text: '' });
    const rv = {};
    const dl = h('dl', { class: 'rcd-scan__facts' });
    for (const [k, label] of [['time', 'Time'], ['line', 'Line'], ['dur', 'Pause'], ['kind', 'Movement']]) {
      rv[k] = h('dd', { text: U.DASH });
      dl.appendChild(h('div', null, [h('dt', { text: label }), rv[k]]));
    }
    const side = h('aside', { class: 'rcd-scan__side', 'aria-label': 'Current fixation' }, [
      h('div', { class: 'rcd-scan__readout', 'aria-live': 'off' }, [rTitle, dl]),
      U.legend([
        ['rcd-key--forward', 'Forward movement'],
        ['rcd-key--regress', 'Jump back (dashed)'],
        ['rcd-key--sweep', 'Move to a new line'],
        ['rcd-key--off', 'Away from the text'],
        ['rcd-key--size', 'Bigger circle, longer pause'],
        ['rcd-key--heat', 'Heatmap: where time was spent'],
      ]),
    ]);
    root.appendChild(h('div', { class: 'rcd-scan__main' }, [stage, controls]));
    root.appendChild(side);
    container.appendChild(root);
    const tip = U.tip(stage);

    // ---------------------------------------------------------------- state
    let T = 0, playing = false, speed = 1, mode = 'scan', shown = 0, nowI = -1, hlI = -1, raf = 0, lastTs = 0, dead = false, lastLbl = '', infoI = -2;

    function upper(t) {            // number of fixations that have started by t
      let lo = 0, hi = fx.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (ft(fx[mid]) <= t) lo = mid + 1; else hi = mid; }
      return lo;
    }
    function info(i) {
      if (i === infoI) return;
      infoI = i;
      const f = fx[i];
      if (!f) { rTitle.textContent = 'Press play to start'; rv.time.textContent = rv.line.textContent = rv.dur.textContent = rv.kind.textContent = U.DASH; return; }
      rTitle.textContent = 'Fixation ' + (i + 1) + ' of ' + fx.length;
      rv.time.textContent = U.secs(ft(f));
      rv.line.textContent = f.line >= 0 ? 'Line ' + (f.line + 1) : 'Off the text';
      rv.dur.textContent = Math.round(fd(f)) + ' ms';
      rv.kind.textContent = i === 0 ? 'Start' : (U.KIND_LABEL[kinds[i]] || 'Forward');
    }
    function setShown(n) {
      if (n === shown) return;
      const lo = Math.min(n, shown), hi = Math.max(n, shown), on = n > shown;
      for (let i = lo; i < hi; i++) {
        fixG[i].classList.toggle('is-on', on);
        if (i > 0) sacL[i - 1].classList.toggle('is-on', on);
      }
      if (nowI >= 0 && fixG[nowI]) fixG[nowI].classList.remove('is-now');
      nowI = n - 1;
      if (nowI >= 0) fixG[nowI].classList.add('is-now');
      shown = n;
      if (mode !== 'scan') heatTo(n);
    }
    function update() {
      const n = upper(T);
      setShown(n);
      if (hlI < 0) info(n - 1);
      if (n > 0 && T < total) {
        const f = fx[n - 1], g = fx[n], end = ft(f) + fd(f);
        let x = px(f), y = py(f);
        if (g && T > end && ft(g) > end) { const k = clamp((T - end) / (ft(g) - end), 0, 1); x += (px(g) - x) * k; y += (py(g) - y) * k; }
        dot.setAttribute('cx', x.toFixed(1)); dot.setAttribute('cy', y.toFixed(1));
        dot.setAttribute('visibility', 'visible');
      } else dot.setAttribute('visibility', 'hidden');
      slider.value = String(Math.round(T));
      const lbl = (T / 1000).toFixed(1) + ' / ' + U.secs(total);
      if (lbl !== lastLbl) { lastLbl = lbl; timeLbl.textContent = lbl; }
    }
    function setPlaying(p) {
      if (dead || p === playing) return;
      playing = p;
      const ni = U.icon(p ? 'pause' : 'play', 16);
      playBtn.replaceChild(ni, playIcon); playIcon = ni;
      playLabel.textContent = p ? 'Pause' : (T >= total ? 'Replay' : 'Play');
      if (p) { lastTs = 0; raf = requestAnimationFrame(frame); } else if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }
    function frame(ts) {
      raf = 0;
      if (dead || !playing) return;
      const dt = lastTs ? Math.min(100, ts - lastTs) : 0;
      lastTs = ts;
      T = Math.min(total, T + dt * speed);
      update();
      if (typeof opts.onTick === 'function') { try { opts.onTick(T); } catch (e) { /* listener's problem */ } }
      if (T >= total) { setPlaying(false); return; }
      raf = requestAnimationFrame(frame);
    }
    function seek(t, keepPlaying) {
      if (dead) return;
      if (!keepPlaying) setPlaying(false);
      T = clamp(fin(t) ? t : 0, 0, total);
      update();
      if (!playing) playLabel.textContent = T >= total ? 'Replay' : 'Play';
    }

    // ---------------------------------------------------------------- heatmap
    let hctx = null, actx = null, acc = null, heatN = 0, lut = null;
    const HW = 440, HH = Math.max(40, Math.round(HW * vb.h / vb.w));
    try {
      canvas.width = HW; canvas.height = HH;
      hctx = canvas.getContext('2d');
      acc = document.createElement('canvas');
      acc.width = HW; acc.height = HH;
      actx = acc.getContext('2d', { willReadFrequently: true });
      lut = buildLut();
    } catch (e) { hctx = actx = null; }
    function heatTo(n) {
      if (!hctx || !actx) return;
      try {
        if (n < heatN) { actx.clearRect(0, 0, HW, HH); heatN = 0; }
        const R = HW * 0.062;
        for (let i = heatN; i < n; i++) {
          const f = fx[i], x = (px(f) - vb.x) / vb.w * HW, y = (py(f) - vb.y) / vb.h * HH;
          const al = 0.1 + 0.4 * clamp(fd(f) / maxDur, 0, 1);
          const g = actx.createRadialGradient(x, y, 0, x, y, R);
          g.addColorStop(0, 'rgba(0,0,0,' + al.toFixed(3) + ')');
          g.addColorStop(0.5, 'rgba(0,0,0,' + (al * 0.45).toFixed(3) + ')');
          g.addColorStop(1, 'rgba(0,0,0,0)');
          actx.fillStyle = g;
          actx.fillRect(x - R, y - R, 2 * R, 2 * R);
        }
        heatN = n;
        const src = actx.getImageData(0, 0, HW, HH).data, out = hctx.createImageData(HW, HH), d = out.data;
        for (let i = 3; i < src.length; i += 4) {
          const al = src[i];
          if (al < 4) continue;
          const j = al * 4;
          d[i - 3] = lut[j]; d[i - 2] = lut[j + 1]; d[i - 1] = lut[j + 2]; d[i] = lut[j + 3];
        }
        hctx.putImageData(out, 0, 0);
      } catch (e) { hctx = null; }
    }

    // ---------------------------------------------------------------- events
    playBtn.addEventListener('click', () => {
      if (playing) { setPlaying(false); return; }
      if (T >= total) { T = 0; update(); }
      setPlaying(true);
    });
    slider.addEventListener('input', () => { seek(Number(slider.value), playing); });
    s.addEventListener('pointermove', (e) => {
      const g = e.target && e.target.closest ? e.target.closest('[data-i]') : null;
      if (!g) { tip.hide(); return; }
      const i = Number(g.getAttribute('data-i')), f = fx[i];
      if (!f) { tip.hide(); return; }
      tip.show(e.clientX, e.clientY, 'Fixation ' + (i + 1), [
        ['Time', U.secs(ft(f))], ['Pause', Math.round(fd(f)) + ' ms'],
        ['Line', f.line >= 0 ? String(f.line + 1) : 'off the text'],
        ['Movement', i === 0 ? 'Start' : (U.KIND_LABEL[kinds[i]] || 'Forward'), 'rcd-key--' + (kinds[i] || 'forward')],
      ]);
    });
    s.addEventListener('pointerleave', () => tip.hide());

    let io = null;
    const wantAuto = opts.autoplay !== false && !reduced;
    if (wantAuto && typeof window.IntersectionObserver === 'function') {
      io = new window.IntersectionObserver((entries) => {
        if (dead || !io || !entries.some((en) => en.isIntersecting)) return;
        io.disconnect(); io = null;
        seek(0); setPlaying(true);
      }, { threshold: 0.45 });
      io.observe(stage);
    }

    // start with the whole path drawn: a complete picture for print and for reduced motion
    T = total;
    update();
    playLabel.textContent = 'Play';

    return {
      play() { if (!dead && !playing) { if (T >= total) { T = 0; update(); } setPlaying(true); } },
      pause() { setPlaying(false); },
      seek(t) { if (io) { io.disconnect(); io = null; } seek(t); },
      showAll() { if (io) { io.disconnect(); io = null; } seek(total); },
      highlight(t) {
        if (dead) return;
        if (t == null || !fin(t)) { hlI = -1; ring.setAttribute('visibility', 'hidden'); infoI = -2; info(shown - 1); return; }
        const i = clamp(upper(t) - 1, 0, fx.length - 1), f = fx[i];
        hlI = i;
        ring.setAttribute('cx', px(f).toFixed(1)); ring.setAttribute('cy', py(f).toFixed(1));
        ring.setAttribute('r', (rad(f) + 8).toFixed(1));
        ring.setAttribute('visibility', 'visible');
        info(i);
      },
      highlightLine(i) {
        if (dead) return;
        const l = i == null ? null : lineRects[i];
        if (!l) { lineHi.setAttribute('visibility', 'hidden'); return; }
        lineHi.setAttribute('x', (l.left - 10).toFixed(1)); lineHi.setAttribute('y', (l.top - 6).toFixed(1));
        lineHi.setAttribute('width', (l.right - l.left + 20).toFixed(1)); lineHi.setAttribute('height', (l.bottom - l.top + 12).toFixed(1));
        lineHi.setAttribute('visibility', 'visible');
      },
      destroy() {
        dead = true; playing = false;
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        if (io) { io.disconnect(); io = null; }
        tip.destroy();
      },
    };
  }

  RC.scanpath = { render };
})();
