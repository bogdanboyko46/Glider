/*
 * charts/lineTimeline.js — time on each line against the time expected from the reader's own pace.
 * RCCharts.lineTimeline.render(container, { analysis }, opts)      opts: { onHoverLine(index|null) }
 * Built from HTML rows so the labels stay crisp at any width.
 */
(function () {
  'use strict';
  const RC = (window.RCCharts = window.RCCharts || {});
  const NOOP = () => {};

  function render(container, data, opts) {
    const U = RC.util;
    if (!U || !container) return { destroy: NOOP };
    opts = opts || {};
    const { h, clamp, fin } = U;
    const a = (data && data.analysis) || {};
    const lines = (Array.isArray(a.lines) ? a.lines : []).filter((l) => l && fin(l.timeMs));
    container.textContent = '';
    if (!lines.length) { container.appendChild(U.empty('No line timings were recorded.')); return { destroy: NOOP }; }

    const max = Math.max.apply(null, lines.map((l) => Math.max(l.timeMs, fin(l.expectedMs) ? l.expectedMs : 0)).concat([1])) * 1.06;
    const wrap = h('div', { class: 'rcd-lines' });
    const tip = U.tip(wrap);
    const hover = (i) => { if (typeof opts.onHoverLine === 'function') { try { opts.onHoverLine(i); } catch (e) { /* listener's problem */ } } };
    const list = h('ol', { class: 'rcd-lines__list' });

    for (const l of lines) {
      const n = (fin(l.index) ? l.index : lines.indexOf(l)) + 1;
      const exp = fin(l.expectedMs) ? l.expectedMs : null;
      const fill = h('span', { class: 'rcd-lines__fill' });
      fill.style.width = clamp(100 * l.timeMs / max, 0.8, 100).toFixed(1) + '%';
      const track = h('div', {
        class: 'rcd-lines__track', role: 'img',
        'aria-label': 'Line ' + n + ': ' + U.secs(l.timeMs) + (exp !== null ? ', expected about ' + U.secs(exp) : '') + (l.rereads ? ', re-read ' + l.rereads + (l.rereads === 1 ? ' time' : ' times') : '') + (l.flagged ? ', much slower than your pace' : ''),
      }, [fill]);
      if (exp !== null) {
        const mark = h('span', { class: 'rcd-lines__exp' });
        mark.style.left = clamp(100 * exp / max, 0, 100).toFixed(1) + '%';
        track.appendChild(mark);
      }
      const tags = h('span', { class: 'rcd-lines__tags' }, [
        l.rereads ? h('span', { class: 'rcd-tag rcd-tag--reread' }, [U.icon('back', 13), 'Re-read' + (l.rereads > 1 ? ' ×' + l.rereads : '')]) : null,
        l.slowest ? h('span', { class: 'rcd-tag' + (l.flagged ? ' rcd-tag--slow' : '') }, [l.flagged ? U.icon('clock', 13) : null, 'Slowest']) : null,
      ]);
      const row = h('li', { class: 'rcd-lines__row' + (l.flagged ? ' is-flagged' : '') + (l.slowest ? ' is-slowest' : '') }, [
        h('span', { class: 'rcd-lines__name', text: 'Line ' + n }),
        track,
        h('span', { class: 'rcd-lines__val', text: U.secs(l.timeMs) }),
        h('span', { class: 'rcd-lines__ratio', text: fin(l.ratio) && l.ratio > 0 ? l.ratio.toFixed(2) + '×' : U.DASH }),
        tags,
      ]);
      row.addEventListener('pointermove', (e) => {
        tip.show(e.clientX, e.clientY, 'Line ' + n, [
          ['Text', String(l.text || '').length > 46 ? String(l.text).slice(0, 44) + '…' : String(l.text || U.DASH)],
          ['Time on line', U.secs(l.timeMs), 'rcd-key--bar'],
          exp !== null ? ['Expected', U.secs(exp), 'rcd-key--exp'] : null,
          ['Fixations', fin(l.fixations) ? String(l.fixations) : U.DASH],
          ['Re-reads', fin(l.rereads) ? String(l.rereads) : U.DASH],
        ]);
      });
      row.addEventListener('pointerenter', () => hover(fin(l.index) ? l.index : n - 1));
      row.addEventListener('pointerleave', () => { tip.hide(); hover(null); });
      list.appendChild(row);
    }
    wrap.appendChild(list);
    wrap.appendChild(U.legend([['rcd-key--bar', 'Time on the line'], ['rcd-key--exp', 'Expected from your own pace'], ['rcd-key--ratio', 'Number at the right: time ÷ expected']]));

    const slow = lines.find((l) => l.slowest);
    if (slow) {
      const n = (fin(slow.index) ? slow.index : lines.indexOf(slow)) + 1;
      wrap.appendChild(h('div', { class: 'rcd-callout' + (slow.flagged ? ' is-flagged' : '') }, [
        h('span', { class: 'rcd-callout__icon' }, [U.icon('clock', 22)]),
        h('div', null, [
          h('p', { class: 'rcd-callout__title', text: slow.flagged
            ? 'Line ' + n + ' held your eyes ' + (fin(slow.ratio) ? slow.ratio.toFixed(2) + '×' : 'much') + ' longer than your own pace'
            : 'Line ' + n + ' was your slowest, and still close to your own pace' }),
          slow.text ? h('blockquote', { class: 'rcd-callout__quote', text: '“' + slow.text + '”' }) : null,
          h('p', { class: 'rcd-note', text: U.secs(slow.timeMs) + ' on this line, against about ' + U.secs(slow.expectedMs) + ' expected' + (slow.rereads ? ', with ' + slow.rereads + (slow.rereads === 1 ? ' re-read.' : ' re-reads.') : '.') }),
        ]),
      ]));
    }
    container.appendChild(wrap);
    return { destroy() { tip.destroy(); } };
  }

  RC.lineTimeline = { render };
})();
