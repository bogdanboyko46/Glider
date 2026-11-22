// Gaze Lab page. All UI lives in an open shadow root on #lab-root so the
// Glider extension (which restyles text in the main document) cannot move it.
(() => {
  'use strict';

  const FAKE = new URLSearchParams(location.search).has('fake');
  const LANDMARKS = new URLSearchParams(location.search).has('landmarks');
  const BLOCK_ID = 'lab-p1';
  const now = () => performance.now();
  const r1 = (n) => Math.round(n * 10) / 10;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

  // ------------------------------------------------------------ bridge
  class Bridge {
    constructor() {
      this.seq = 0;
      this.pending = new Map();
      this.handlers = new Map();
      this.sink = null; // the running task's events array
      document.addEventListener('glider-lab:reply', (e) => {
        let msg;
        try { msg = JSON.parse(e.detail); } catch { return; }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || 'command failed'));
      });
      document.addEventListener('glider-lab:data', (e) => {
        let msg;
        try { msg = JSON.parse(e.detail); } catch { return; }
        for (const ev of msg.batch || []) {
          if (this.sink) this.sink.push(ev);
          for (const fn of this.handlers.get(ev.k) || []) fn(ev);
          for (const fn of this.handlers.get('*') || []) fn(ev);
        }
      });
    }

    cmd(name, args = {}, timeoutMs = 5000) {
      const id = `c${(this.seq += 1)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${name}: no reply within ${timeoutMs} ms`));
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timer });
        document.dispatchEvent(new CustomEvent('glider-lab:cmd', { detail: JSON.stringify({ id, cmd: name, args }) }));
      });
    }

    on(k, fn) {
      if (!this.handlers.has(k)) this.handlers.set(k, []);
      this.handlers.get(k).push(fn);
    }

    record(events) { this.sink = events; }
  }

  // ------------------------------------------------- fake extension (?fake=1)
  const fake = { target: null };
  function installFake() {
    let streaming = false;
    let batch = [];
    let fakeCalAt = null;
    let lastFix = 0;
    let lastStatus = 0;
    let fixN = 0;
    let gx = innerWidth / 2;
    let gy = innerHeight / 2;
    const noise = (s) => (Math.random() + Math.random() + Math.random() - 1.5) * s;
    const state = () => ({ status: 'tracking', calibrated: true, accuracy: { px: 40, fake: true }, wpm: 0, fps: 30, drifted: false, baseline: null, tau: 0, struggling: false });
    const reply = (id, result, delay = 5) => setTimeout(() => {
      document.dispatchEvent(new CustomEvent('glider-lab:reply', { detail: JSON.stringify({ id, ok: true, result }) }));
    }, delay);
    document.addEventListener('glider-lab:cmd', (e) => {
      const { id, cmd, args } = JSON.parse(e.detail);
      if (cmd === 'hello') return reply(id, { version: 'fake', state: state() });
      if (cmd === 'stream') {
        streaming = !!(args && args.on);
        if (streaming) batch.push({ k: 'camera', t: now(), settings: { width: 640, height: 480, frameRate: 30, fake: true } });
        return reply(id, { streaming });
      }
      if (cmd === 'calibrate') {
        // as the extension does: one 'caldot' event per dot (two of the calibration, two of the check after the fit)
        const t = now();
        [['dots', 'cal', 0, 0.06, 0.08], ['dots', 'val', 100, 0.25, 0.22], ['check', 'check', 300, 0.4, 0.4], ['check', 'check', 301, 0.84, 0.3]].forEach(([seg, role, g, fx, fy], i) => {
          batch.push({ k: 'caldot', t: t + 150 * i, i, g, seg, role, x: Math.round(fx * innerWidth), y: Math.round(fy * innerHeight), tShow: t + 150 * i, tSampleStart: t + 150 * i + 50, tSampleEnd: t + 150 * i + 140, frames: 3, settled: true });
        });
        fakeCalAt = Date.now();
        return reply(id, { accuracy: state().accuracy }, 800);
      }
      if (cmd === 'state') return reply(id, state());
      if (cmd === 'dump') {
        return reply(id, { state: state(), accuracy: state().accuracy, model: { fake: true }, train: { X: [], Y: [], G: [] }, calibHead: null, calibScreen: null, baseline: null, camera: { width: 640, height: 480, frameRate: 30 }, tau: 0, calibratedAt: fakeCalAt });
      }
      return reply(id, null);
    });
    setInterval(() => {
      if (!streaming) return;
      const t = now();
      const tg = fake.target || { x: innerWidth / 2, y: innerHeight / 2 };
      gx += (tg.x - gx) * 0.5;
      gy += (tg.y - gy) * 0.5;
      const f = [];
      for (let i = 0; i < 44; i += 1) f.push(r1(Math.random() * 100) / 100);
      batch.push({ k: 'raw', t, face: true, blink: Math.random() < 0.02, f, head: { cx: 0.5, cy: 0.5, s: 0.2 }, fps: 30 });
      const x = r1(gx + noise(30));
      const y = r1(gy + noise(30));
      batch.push({ k: 'gaze', t, x, y, rawX: x, rawY: y });
      if (t - lastFix > 240) {
        lastFix = t;
        batch.push({ k: 'fix', t, x: r1(gx + noise(12)), y: r1(gy + noise(12)), dur: 220, n: (fixN += 1) });
        if (tg.line != null) batch.push({ k: 'line', t, el: BLOCK_ID, line: tg.line, conf: 0.8 });
      }
      if (t - lastStatus > 1000) { lastStatus = t; batch.push({ k: 'status', t, state: state() }); }
    }, 33);
    setInterval(() => {
      if (!batch.length) return;
      const out = batch;
      batch = [];
      document.dispatchEvent(new CustomEvent('glider-lab:data', { detail: JSON.stringify({ batch: out }) }));
    }, 100);
  }

  // ------------------------------------------------------------ text
  const PASSAGES = [
    'The path to the lake begins behind the old mill and runs beside a narrow stream for most of the way. In spring the water is high and fast, and small birds work along the banks looking for insects. Walkers usually stop at the wooden bridge, where the stream turns east and the trees open up. From there the ground rises gently through a field of long grass. On a clear morning you can see the far shore from the top of the rise, a thin dark line under the hills. The last part of the walk is the easiest. The path is wide and flat, the air smells of pine, and the sound of the water grows a little louder with every step. Most people reach the shore in under an hour, sit on the flat grey stones for a while, and then follow the same path home before the light begins to fade.',
    'Baking bread at home takes more patience than skill. You begin with flour, water, salt and a small amount of yeast, and you mix them in a large bowl until no dry patches remain. The dough then needs to rest. During the first hour very little seems to happen, but inside the bowl the yeast is slowly waking up and filling the dough with tiny pockets of air. After the rest you fold the dough over itself a few times, cover it with a cloth, and leave it again. A warm kitchen speeds things up, while a cold one slows them down, and neither is a problem if you are willing to wait. When the dough has doubled in size you shape it, let it rise once more, and place it in a hot oven. Half an hour later the whole house smells wonderful, and the loaf sounds hollow when you tap it underneath.',
    'A small town library is often busier than visitors expect. The doors open at nine, and by ten the long table near the window is usually full. Some people come to read the morning papers, some come to use the computers, and a few come simply because the room is warm and quiet. The shelves are arranged by subject, with stories on the ground floor and history, science and travel on the floor above. Children have their own corner with low chairs and a bright rug, and on Saturday mornings someone reads aloud to whoever turns up. Borrowing a book is simple. You show your card at the desk, the date is stamped inside the cover, and the book is yours for three weeks. If nobody else is waiting for it you can keep it longer, and many people do, returning months later with a smile and a small apology.',
  ];

  /** Words and lines of a block, in viewport px, from Range client rects. */
  function measureBlock(p, pitch) {
    const words = [];
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let node;
    let openEnd = false; // the previous fragment ran to the end of its text node
    while ((node = walker.nextNode())) {
      const re = /\S+/g;
      let m;
      let any = false;
      while ((m = re.exec(node.data))) {
        any = true;
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        const rects = range.getClientRects();
        if (!rects.length) continue;
        const a = rects[0];
        const b = rects[rects.length - 1];
        const prev = words[words.length - 1];
        if (m.index === 0 && openEnd && prev && Math.abs(prev.top - a.top) < 2) {
          // A word split across elements (e.g. wrapped half-words): merge.
          prev.text += m[0];
          prev.right = b.right;
        } else {
          words.push({ text: m[0], left: a.left, right: b.right, top: a.top, bottom: a.bottom });
        }
        openEnd = m.index + m[0].length === node.data.length;
      }
      if (!any && node.data.length) openEnd = false;
    }
    const lines = [];
    let cur = null;
    for (const w of words) {
      const cy = (w.top + w.bottom) / 2;
      if (!cur || Math.abs(cy - cur.cy) > pitch * 0.5) {
        cur = { cy, textTop: w.top, textBottom: w.bottom, left: w.left, right: w.right, words: [] };
        lines.push(cur);
      }
      cur.left = Math.min(cur.left, w.left);
      cur.right = Math.max(cur.right, w.right);
      cur.textTop = Math.min(cur.textTop, w.top);
      cur.textBottom = Math.max(cur.textBottom, w.bottom);
      cur.words.push({ text: w.text, left: r1(w.left), right: r1(w.right) });
    }
    return lines.map((l) => {
      const cy = (l.textTop + l.textBottom) / 2;
      return {
        top: r1(cy - pitch / 2), bottom: r1(cy + pitch / 2), left: r1(l.left), right: r1(l.right),
        textTop: r1(l.textTop), textBottom: r1(l.textBottom), words: l.words,
      };
    });
  }

  // ------------------------------------------------------------ UI shell
  const host = document.getElementById('lab-root');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <link rel="stylesheet" href="lab.css">
    <div class="home">
      <h1>Gaze Lab</h1>
      <div class="fake" ${FAKE ? '' : 'hidden'}>FAKE MODE (?fake=1): synthetic data, no extension, no camera. For smoke tests only.</div>
      <div class="banner" hidden>Glider extension not detected on this page. Reload the extension in chrome://extensions, then reload this page.</div>
      <div class="strip">
        <span class="chip" data-s="ext">extension: checking</span>
        <span class="chip" data-s="tracker">tracker: ?</span>
        <span class="chip" data-s="calib">calibrated: ?</span>
        <span class="chip" data-s="cam">camera: ?</span>
        <button data-a="start">Start tracker</button>
        <button data-a="stop">Stop tracker</button>
        <button data-a="dump">Dump now</button>
      </div>
      <div class="coach" hidden>
        <div class="text"></div>
        <div class="meta"></div>
        <div class="count" hidden></div>
      </div>
      <h2>Setup</h2>
      <div class="setup">
        <label>Screen diagonal (in)<input type="number" step="0.1" data-p="screenDiagIn"></label>
        <label>Distance (cm)<input type="number" step="1" data-p="distanceCm"></label>
        <label class="inline"><input type="checkbox" data-p="glasses">Glasses</label>
        <label>Lighting<input type="text" data-p="lighting" placeholder="e.g. daylight, lamp left"></label>
        <label>Label<input type="text" data-p="label" placeholder="free label"></label>
      </div>
      <h2>Benchmark session</h2>
      <div class="row"><button data-a="session">Run the benchmark session (about 6 minutes)</button>
        <span class="desc">camera 15 s, calibrate, validate, read along at 64 px and at 32 px line spacing, four head positions, validate again. Seven recordings; then run <code>node tests/bench/gaze-bench.mjs --real-only</code>.</span></div>
      <h2>Tasks</h2>
      <div class="tasks"></div>
      <h2>Last result</h2>
      <div class="result">Nothing run yet.</div>
      <h2>Notes</h2>
      <div class="row"><textarea class="notes" placeholder="Anything worth telling the coach. Also stored in the next recording."></textarea><button data-a="note">Send note</button></div>
    </div>
    <div class="stage" hidden>
      <div class="msg" hidden></div>
      <div class="cross" hidden></div>
      <div class="dot" hidden></div>
      <div class="hl" hidden></div>
      <p id="${BLOCK_ID}" hidden></p>
      <div class="margin" hidden></div>
      <div class="marks"></div>
      <div class="stagefoot"></div>
    </div>`;
  const q = (sel) => root.querySelector(sel);
  const ui = {
    home: q('.home'), stage: q('.stage'), msg: q('.msg'), cross: q('.cross'), dot: q('.dot'), hl: q('.hl'),
    block: q('#' + BLOCK_ID), margin: q('.margin'), marks: q('.marks'), foot: q('.stagefoot'),
    banner: q('.banner'), result: q('.result'), tasks: q('.tasks'), notes: q('.notes'), coach: q('.coach'),
  };
  const chip = (name, text, cls = '') => {
    const el = q(`[data-s="${name}"]`);
    el.textContent = text;
    el.className = 'chip ' + cls;
  };
  function showMsg(html) { ui.msg.innerHTML = html; ui.msg.hidden = false; }
  function hideMsg() { ui.msg.hidden = true; }
  function resetStage() {
    for (const el of [ui.msg, ui.cross, ui.dot, ui.hl, ui.block, ui.margin]) el.hidden = true;
    ui.block.textContent = '';
    ui.marks.textContent = '';
    ui.foot.textContent = '';
    fake.target = null;
  }

  // setup form, remembered in localStorage
  const SETUP_KEY = 'gaze-lab-setup';
  function loadSetup() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(SETUP_KEY) || '{}'); } catch { /* unavailable */ }
    for (const el of root.querySelectorAll('[data-p]')) {
      const v = saved[el.dataset.p];
      if (v == null) continue;
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    }
  }
  function readSetup() {
    const out = {};
    for (const el of root.querySelectorAll('[data-p]')) {
      if (el.type === 'checkbox') out[el.dataset.p] = el.checked;
      else if (el.type === 'number') out[el.dataset.p] = el.value === '' ? null : Number(el.value);
      else out[el.dataset.p] = el.value;
    }
    return out;
  }
  ui.home.addEventListener('change', (e) => {
    if (!e.target.dataset || !e.target.dataset.p) return;
    try { localStorage.setItem(SETUP_KEY, JSON.stringify(readSetup())); } catch { /* unavailable */ }
  });
  function physical() {
    const s = readSetup();
    return { screenDiagIn: s.screenDiagIn, distanceCm: s.distanceCm, glasses: !!s.glasses, lighting: s.lighting || '' };
  }
  function env() {
    return {
      ua: navigator.userAgent, viewport: { w: innerWidth, h: innerHeight },
      screen: { w: screen.width, h: screen.height, availW: screen.availWidth, availH: screen.availHeight },
      dpr: devicePixelRatio, screenX: window.screenX, screenY: window.screenY, outerW: outerWidth, outerH: outerHeight,
    };
  }
  /** px -> degrees of visual angle, or null when the setup form is incomplete. */
  function degFn() {
    const p = physical();
    if (!(p.screenDiagIn > 0) || !(p.distanceCm > 0)) return null;
    const pxPerCm = Math.hypot(screen.width, screen.height) / (p.screenDiagIn * 2.54);
    return (px) => (Math.atan(px / pxPerCm / p.distanceCm) * 180) / Math.PI;
  }

  // ------------------------------------------------------------ task runtime
  class Abort extends Error {}
  const bridge = new Bridge();
  let current = null;
  let lastRaw = 0;
  let lastState = null;
  let lastCamera = null;

  function makeCtx(name, params, opts) {
    let rejectAbort;
    const aborted = new Promise((_, rej) => { rejectAbort = rej; });
    aborted.catch(() => {});
    const ctx = {
      name, params, auto: !!opts.auto, truth: [], events: [], layout: null, extra: {},
      keyHandler: null, noAbort: false,
      abort() { rejectAbort(new Abort('aborted')); },
      race(p) { return Promise.race([p, aborted]); },
      sleep(ms) { return ctx.race(new Promise((r) => setTimeout(r, ms))); },
      /** Resolves with { key, t } on the next of `keys`. In auto mode it answers by itself. */
      waitKey(keys) {
        if (ctx.auto) return ctx.sleep(60).then(() => ({ key: keys[0], t: now() }));
        return ctx.race(new Promise((res) => {
          ctx.keyHandler = (key, t) => {
            if (!keys.includes(key)) return;
            ctx.keyHandler = null;
            res({ key, t });
          };
        }));
      },
    };
    return ctx;
  }

  window.addEventListener('keydown', (e) => {
    if (!current || e.repeat) return;
    const key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (key === 'Escape') {
      if (!current.noAbort) { e.preventDefault(); current.abort(); }
      return;
    }
    if (current.keyHandler) {
      if (key === 'Space') e.preventDefault();
      current.keyHandler(key, e.timeStamp > 0 ? e.timeStamp : now());
    }
  }, true);

  async function intro(ctx, html) {
    showMsg(`${html}<div class="hint">Press Space to begin. Esc aborts and discards the run.</div>`);
    await ctx.waitKey(['Space']);
    hideMsg();
  }

  /** Show the dot at each point in turn; pushes one target truth entry per point. */
  async function runTargets(ctx, pts, dwellMs, settleMs, extra = {}) {
    ui.dot.hidden = false;
    for (const p of pts) {
      ui.dot.style.left = p.x + 'px';
      ui.dot.style.top = p.y + 'px';
      fake.target = { x: p.x, y: p.y };
      const tShow = now();
      await ctx.sleep(dwellMs);
      ctx.truth.push({ kind: 'target', id: p.id, x: p.x, y: p.y, tShow, tSettle: tShow + settleMs, tEnd: now(), ...extra });
    }
    ui.dot.hidden = true;
    fake.target = null;
  }
  const fracPoints = (fracs, prefix = 'p') => fracs.map(([fx, fy], i) => ({
    id: `${prefix}${i}-${Math.round(fx * 100)}-${Math.round(fy * 100)}`, x: Math.round(fx * innerWidth), y: Math.round(fy * innerHeight),
  }));
  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Error statistics for a list of target truth entries against gaze events. */
  function targetStats(targets, events) {
    const gaze = events.filter((e) => e.k === 'gaze');
    const deg = degFn();
    const per = [];
    const ax = [];
    const ay = [];
    const ad = [];
    for (const t of targets) {
      const s = gaze.filter((g) => g.t >= t.tSettle && g.t <= t.tEnd);
      if (!s.length) { per.push({ id: t.id, x: t.x, y: t.y, n: 0 }); continue; }
      const mx = mean(s.map((g) => g.x));
      const my = mean(s.map((g) => g.y));
      for (const g of s) { ax.push(Math.abs(g.x - t.x)); ay.push(Math.abs(g.y - t.y)); ad.push(Math.hypot(g.x - t.x, g.y - t.y)); }
      per.push({
        id: t.id, x: t.x, y: t.y, n: s.length, meanX: r1(mx), meanY: r1(my),
        errX: r1(mx - t.x), errY: r1(my - t.y), err: r1(Math.hypot(mx - t.x, my - t.y)),
        scatter: r1(Math.sqrt(mean(s.map((g) => (g.x - mx) ** 2 + (g.y - my) ** 2)))),
      });
    }
    const seen = per.filter((p) => p.n);
    const worst = seen.reduce((w, p) => (!w || p.err > w.err ? p : w), null);
    const out = {
      samples: ad.length, targets: per.length, targetsWithData: seen.length,
      maeXpx: r1(mean(ax)), maeYpx: r1(mean(ay)), meanErrPx: r1(mean(ad)),
      meanTargetErrPx: r1(mean(seen.map((p) => p.err))), meanScatterPx: r1(mean(seen.map((p) => p.scatter))),
      worst: worst ? { id: worst.id, err: worst.err } : null, per,
    };
    if (deg) {
      out.maeXdeg = r1(deg(out.maeXpx) * 10) / 10;
      out.maeYdeg = r1(deg(out.maeYpx) * 10) / 10;
      out.meanErrDeg = r1(deg(out.meanErrPx) * 10) / 10;
    }
    return out;
  }
  function statsLine(s) {
    if (!s.samples) return 'no gaze samples (is the tracker calibrated?)';
    const d = s.meanErrDeg != null ? ` | ${s.meanErrDeg} deg (H ${s.maeXdeg}, V ${s.maeYdeg})` : '';
    return `mean error ${s.meanErrPx} px (H ${s.maeXpx}, V ${s.maeYpx})${d} | scatter ${s.meanScatterPx} px | ${s.samples} samples, ${s.targetsWithData}/${s.targets} targets`;
  }
  function errorMap(per) {
    const w = innerWidth;
    const h = innerHeight;
    const parts = per.map((p) => {
      const tgt = `<circle cx="${p.x}" cy="${p.y}" r="${w / 130}" fill="#1d5fb4"/>`;
      if (!p.n) return tgt + `<text x="${p.x + 12}" y="${p.y + 5}" font-size="${w / 60}" fill="#b3261e">no data</text>`;
      return `${tgt}<line x1="${p.x}" y1="${p.y}" x2="${p.meanX}" y2="${p.meanY}" stroke="#b3261e" stroke-width="${w / 400}"/>`
        + `<circle cx="${p.meanX}" cy="${p.meanY}" r="${Math.max(p.scatter, 3)}" fill="rgba(179,38,30,.15)" stroke="#b3261e" stroke-width="${w / 800}"/>`;
    });
    return `<svg viewBox="0 0 ${w} ${h}" width="420" height="${Math.round((420 * h) / w)}">${parts.join('')}</svg>`;
  }

  // reading helpers
  async function setupReading(ctx) {
    const { pitch, fontPx, lines, widthPx, passage = 0 } = ctx.params;
    const p = ui.block;
    const left = Math.max(60, Math.round((innerWidth - widthPx) / 2));
    const top = Math.max(30, Math.round((innerHeight - lines * pitch) / 2));
    Object.assign(p.style, { left: left + 'px', top: top + 'px', width: widthPx + 'px', fontSize: fontPx + 'px', lineHeight: pitch + 'px' });
    const all = [];
    for (let i = 0; i < PASSAGES.length; i += 1) all.push(...PASSAGES[(passage + i) % PASSAGES.length].split(/\s+/));
    p.textContent = all.join(' ');
    p.hidden = false;
    p.style.visibility = 'hidden';
    if (document.fonts && document.fonts.ready) await ctx.race(document.fonts.ready);
    const keep = measureBlock(p, pitch).slice(0, lines).reduce((n, l) => n + l.words.length, 0);
    p.textContent = all.slice(0, keep).join(' ');
    await bridge.cmd('setRoot', { hostSelector: '#lab-root' }).catch((err) => { ctx.extra.setRootError = String(err.message); });
    await ctx.sleep(500); // let the extension pick the block up before measuring
    p.style.visibility = '';
    const measured = measureBlock(p, pitch);
    ctx.layout = { blocks: [{ id: BLOCK_ID, pitch, fontPx, left, top, widthPx, lines: measured }] };
    if (measured.length && measured[measured.length - 1].bottom > innerHeight) ctx.extra.warning = 'block taller than the viewport';
    return measured;
  }
  function lineStats(ctx) {
    const lines = ctx.layout ? ctx.layout.blocks[0].lines : [];
    const truth = ctx.truth.filter((t) => t.kind === 'line');
    const at = (t) => truth.find((l) => t >= l.t0 && t <= l.t1);
    let fixN = 0;
    let fixOk = 0;
    let lineN = 0;
    let lineOk = 0;
    for (const ev of ctx.events) {
      if (ev.k !== 'fix' && ev.k !== 'line') continue;
      const tr = at(ev.t);
      if (!tr) continue;
      if (ev.k === 'fix') {
        let best = -1;
        let bestD = Infinity;
        lines.forEach((l, i) => { const d = Math.abs((l.top + l.bottom) / 2 - ev.y); if (d < bestD) { bestD = d; best = i; } });
        fixN += 1;
        if (best === tr.line) fixOk += 1;
      } else {
        lineN += 1;
        if (ev.el === BLOCK_ID && ev.line === tr.line) lineOk += 1;
      }
    }
    return {
      lines: lines.length, truthLines: truth.length, fixations: fixN, fixNearestLineAcc: fixN ? r1((100 * fixOk) / fixN) : null,
      lineEvents: lineN, lineEventAcc: lineN ? r1((100 * lineOk) / lineN) : null,
    };
  }
  function lineStatsText(s) {
    return [
      `${s.lines} lines laid out, ${s.truthLines} truth line spans`,
      `fixations on the true line (nearest-line): ${s.fixNearestLineAcc == null ? 'no fix events' : s.fixNearestLineAcc + ' % of ' + s.fixations}`,
      `line events matching the true line: ${s.lineEventAcc == null ? 'no line events' : s.lineEventAcc + ' % of ' + s.lineEvents}`,
    ];
  }
  function placeMargin(line, text) {
    ui.margin.hidden = false;
    ui.margin.textContent = text;
    ui.margin.style.left = line.left - 52 + 'px';
    ui.margin.style.top = (line.top + line.bottom) / 2 - 5 + 'px';
  }
  /** Self-paced reading: Space ends a line; optional S (stall) and R (re-read) keys. */
  async function selfPaced(ctx, lines, { stall = false, rereadFrom = 0 } = {}) {
    let cur = 0;
    let mark = now();
    let stallT0 = null;
    let reread = null;
    const keys = stall ? ['Space', 's', 'r'] : ['Space'];
    while (cur < lines.length) {
      const l = lines[cur];
      fake.target = { x: (l.left + l.right) / 2, y: (l.top + l.bottom) / 2, line: cur };
      placeMargin(l, `${cur + 1}/${lines.length}`);
      const { key, t } = await ctx.waitKey(keys);
      ctx.truth.push({ kind: 'key', key, t });
      if (key === 'Space') {
        ctx.truth.push({ kind: 'line', block: BLOCK_ID, line: cur, t0: mark, t1: t });
        if (reread) { reread.t1 = t; reread = null; }
        mark = t;
        cur += 1;
      } else if (key === 's') {
        if (stallT0 == null) stallT0 = t;
        else { ctx.truth.push({ kind: 'phase', name: 'stall', line: cur, t0: stallT0, t1: t }); stallT0 = null; }
      } else if (key === 'r') {
        reread = { kind: 'phase', name: 'reread', line: rereadFrom, t0: t, t1: t };
        ctx.truth.push(reread);
        cur = Math.min(rereadFrom, lines.length - 1);
        mark = t;
      }
    }
    if (stallT0 != null) ctx.truth.push({ kind: 'phase', name: 'stall', line: lines.length - 1, t0: stallT0, t1: now() });
  }

  // ------------------------------------------------------------ tasks
  const READ = { pitch: 64, fontPx: 22, lines: 8, widthPx: 760 };
  const TASKS = {
    camera: {
      desc: 'Stare at a centre cross for 15 s. Measures frame rate, face loss and blinks.',
      defaults: { durationMs: 15000 },
      intro: () => 'Look at the cross in the centre of the screen and keep still until it disappears.',
      async run(ctx) {
        const x = Math.round(innerWidth / 2);
        const y = Math.round(innerHeight / 2);
        ui.cross.hidden = false;
        fake.target = { x, y };
        const tShow = now();
        await ctx.sleep(ctx.params.durationMs);
        ctx.truth.push({ kind: 'target', id: 'centre', x, y, tShow, tSettle: tShow + 700, tEnd: now() });
        ui.cross.hidden = true;
      },
      summary(ctx, rec) {
        const raw = ctx.events.filter((e) => e.k === 'raw');
        const cam = ctx.events.filter((e) => e.k === 'camera').pop();
        const settings = (cam && cam.settings) || (rec.dump && rec.dump.camera) || lastCamera || null;
        const pct = (n) => (raw.length ? r1((100 * n) / raw.length) : null);
        const data = {
          frames: raw.length, fps: r1(raw.length / (rec.durationMs / 1000)),
          faceLostPct: pct(raw.filter((e) => !e.face).length), blinkPct: pct(raw.filter((e) => e.blink).length), camera: settings,
        };
        return { data, lines: [`${data.frames} frames, ${data.fps} fps`, `face lost ${data.faceLostPct} %, blink ${data.blinkPct} %`, `camera: ${JSON.stringify(settings)}`] };
      },
    },
    calibrate: {
      desc: 'Runs the extension\'s own calibration flow, then dumps the model.',
      defaults: { baseline: false },
      intro: () => 'Calibration. The extension will show its own full-screen dots: follow them with your eyes and keep your head still.',
      async run(ctx) {
        ctx.noAbort = true; // Esc belongs to the extension's calibration UI here
        ui.stage.hidden = true;
        const t0 = now();
        try {
          ctx.extra.result = await bridge.cmd('calibrate', { baseline: !!ctx.params.baseline }, 240000);
        } catch (err) {
          ctx.extra.error = String(err.message);
        }
        ctx.truth.push({ kind: 'phase', name: 'calibrate', t0, t1: now() });
        // The calibration's own dots as truth: where each dot was and which stretch of it counted ('caldot'
        // events from the extension). The five dots of the check after the fit were never shown to the
        // model, so they are 'target' entries as well (phase 'check'): the analyzer and
        // tests/bench/gaze-bench.mjs score them like a short validate task.
        await new Promise((r) => setTimeout(r, 250)); // the last batch of events
        for (const e of ctx.events.filter((ev) => ev.k === 'caldot')) {
          ctx.truth.push({ kind: 'caldot', id: `${e.seg}-${e.g}`, seg: e.seg, role: e.role, x: e.x, y: e.y, tShow: e.tShow, tSettle: e.tSampleStart, tEnd: e.tSampleEnd, frames: e.frames, settled: e.settled });
          if (e.seg === 'check') ctx.truth.push({ kind: 'target', id: `check-${e.g}`, x: e.x, y: e.y, tShow: e.tShow, tSettle: e.tSampleStart, tEnd: e.tSampleEnd, phase: 'check' });
        }
        ui.stage.hidden = false;
        ctx.noAbort = false;
      },
      summary(ctx, rec) {
        const accuracy = (rec.dump && rec.dump.accuracy) ?? (ctx.extra.result && ctx.extra.result.accuracy) ?? null;
        const data = { accuracy, result: ctx.extra.result ?? null, error: ctx.extra.error ?? null, caldots: ctx.truth.filter((t) => t.kind === 'caldot').length };
        const v = accuracy && accuracy.validation;
        return { data, lines: [ctx.extra.error ? `calibrate failed: ${ctx.extra.error}` : 'calibration finished', v ? `check: ${v.message} (typical error ${v.errPx} px, about ${v.errDeg} deg)` : 'check: none', `${data.caldots} calibration dots stored as truth`, `accuracy: ${JSON.stringify(accuracy)}`] };
      },
    },
    validate: {
      desc: 'A dot jumps to 13 points (3x3 grid at 10/50/90 % plus 4 inner at 30/70 %). Measures gaze error per point.',
      defaults: { points: 13, dwellMs: 1800, settleMs: 700, extras: [] },
      intro: () => 'A blue dot will jump around the screen. Look at its white centre each time and hold your gaze there until it moves. Keep your head still.',
      async run(ctx) {
        const { points, dwellMs, settleMs, extras } = ctx.params;
        const fr = [];
        for (const fy of [0.1, 0.5, 0.9]) for (const fx of [0.1, 0.5, 0.9]) fr.push([fx, fy]);
        for (const fy of [0.3, 0.7]) for (const fx of [0.3, 0.7]) fr.push([fx, fy]);
        let pts = shuffle(fracPoints(fr, 'v'));
        if (points > 0 && points < pts.length) pts = pts.slice(0, points);
        if (Array.isArray(extras) && extras.length) pts = pts.concat(shuffle(fracPoints(extras, 'x')));
        await runTargets(ctx, pts, dwellMs, settleMs);
      },
      summary(ctx) {
        const s = targetStats(ctx.truth.filter((t) => t.kind === 'target'), ctx.events);
        const lines = [statsLine(s)];
        if (s.worst) lines.push(`worst point ${s.worst.id}: ${s.worst.err} px`);
        for (const p of s.per) lines.push(p.n ? `  ${p.id}: err ${p.err} px (dx ${p.errX}, dy ${p.errY}), scatter ${p.scatter}, n ${p.n}` : `  ${p.id}: no samples`);
        return { data: s, lines, html: errorMap(s.per) };
      },
    },
    headshift: {
      desc: 'Four head positions (as calibrated, lean left, lean back, slouch), each followed by a 5-point check.',
      defaults: { dwellMs: 1800, settleMs: 700 },
      intro: () => 'Four short rounds. Before each round you get an instruction about how to sit. Take the position, press Space, then follow the dot <b>with your eyes only</b> and stay in that position.',
      async run(ctx) {
        const phases = [
          ['baseline', 'Sit as you did for calibration'],
          ['lean-left', 'Lean about 3 cm to the left and stay there'],
          ['lean-back', 'Lean back about 5 cm and stay there'],
          ['slouch', 'Slouch a little, as you would after ten minutes'],
        ];
        for (const [name, prompt] of phases) {
          const tPrompt = now();
          showMsg(`${esc(prompt)}<div class="hint">Press Space when you are in position.</div>`);
          await ctx.waitKey(['Space']);
          hideMsg();
          const t0 = now();
          const pts = shuffle(fracPoints([[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]], name + '-'));
          await runTargets(ctx, pts, ctx.params.dwellMs, ctx.params.settleMs, { phase: name });
          ctx.truth.push({ kind: 'phase', name, prompt, tPrompt, t0, t1: now() });
        }
      },
      summary(ctx) {
        const data = {};
        const lines = [];
        for (const ph of ctx.truth.filter((t) => t.kind === 'phase')) {
          const s = targetStats(ctx.truth.filter((t) => t.kind === 'target' && t.phase === ph.name), ctx.events);
          data[ph.name] = s;
          lines.push(`${ph.name}: ${statsLine(s)}`);
        }
        return { data, lines };
      },
    },
    'lines-paced': {
      desc: 'Read along with a highlight that moves word by word at a fixed pace.',
      defaults: { ...READ, wpm: 150, passage: 0 },
      intro: (p) => `A short text will appear. A yellow highlight moves from word to word at about ${p.wpm} words per minute. Read along with it, silently, keeping your eyes on the highlighted word.`,
      async run(ctx) {
        const lines = await setupReading(ctx);
        const words = [];
        lines.forEach((l, li) => l.words.forEach((w, wi) => words.push({ ...w, li, wi, top: l.textTop, bottom: l.textBottom, cy: (l.top + l.bottom) / 2 })));
        if (!words.length) return;
        const unit = ((60000 / ctx.params.wpm) * words.length) / words.reduce((s, w) => s + w.text.length + 1, 0);
        const place = (w) => {
          Object.assign(ui.hl.style, { left: w.left - 3 + 'px', top: w.top - 2 + 'px', width: w.right - w.left + 6 + 'px', height: w.bottom - w.top + 4 + 'px' });
          fake.target = { x: (w.left + w.right) / 2, y: w.cy, line: w.li };
        };
        ui.hl.hidden = false;
        place(words[0]);
        await ctx.sleep(1200); // pre-roll on the first word, not part of the truth
        const start = now();
        let due = start;
        let lineT0 = start;
        for (let i = 0; i < words.length; i += 1) {
          const w = words[i];
          place(w);
          const t0 = now();
          due += (w.text.length + 1) * unit;
          await ctx.sleep(Math.max(0, due - now()));
          const t1 = now();
          ctx.truth.push({ kind: 'word', block: BLOCK_ID, line: w.li, word: w.wi, text: w.text, x: r1((w.left + w.right) / 2), t0, t1 });
          if (i === words.length - 1 || words[i + 1].li !== w.li) {
            ctx.truth.push({ kind: 'line', block: BLOCK_ID, line: w.li, t0: lineT0, t1 });
            lineT0 = t1;
          }
        }
        ui.hl.hidden = true;
      },
      summary(ctx) { const s = lineStats(ctx); return { data: s, lines: lineStatsText(s) }; },
    },
    'lines-self': {
      desc: 'Read at your own pace; press Space at the end of every line.',
      defaults: { ...READ, passage: 1 },
      intro: () => 'A short text will appear. Read it silently at your own pace. <b>Press Space each time you finish a line</b>, then carry on with the next line. A small counter at the left shows the line you are on.',
      async run(ctx) {
        const lines = await setupReading(ctx);
        await selfPaced(ctx, lines);
      },
      summary(ctx) { const s = lineStats(ctx); return { data: s, lines: lineStatsText(s) }; },
    },
    stall: {
      desc: 'Self-paced reading with a deliberate ~6 s stall on one line and two lines re-read twice.',
      defaults: { ...READ, passage: 2, stallLine: 4, rereadLines: [6, 7] },
      intro: (p) => {
        const [a, b] = p.rereadLines;
        return `<div class="small">Read at your own pace and <b>press Space at the end of every line</b>, as before. Two extra things:<br><br>`
          + `1. On <b>line ${p.stallLine}</b>, stop part-way and stare at one word for about 6 seconds. Press <b>S</b> when you stop and <b>S</b> again when you carry on.<br><br>`
          + `2. Read <b>lines ${a} and ${b}</b>, then press <b>R</b> and jump back to the start of line ${a}. Do this twice (so you read lines ${a} and ${b} three times in all), then finish the text.<br><br>`
          + `Small marks at the left show these lines.</div>`;
      },
      async run(ctx) {
        const lines = await setupReading(ctx);
        const { stallLine, rereadLines } = ctx.params;
        const mark = (n, text) => {
          const l = lines[n - 1];
          if (!l) return;
          const el = document.createElement('div');
          el.className = 'mark';
          el.textContent = text;
          el.style.left = l.left - 100 + 'px';
          el.style.top = (l.top + l.bottom) / 2 - 5 + 'px';
          ui.marks.appendChild(el);
        };
        mark(stallLine, 'stall');
        for (const n of rereadLines) mark(n, 're-read');
        ui.foot.textContent = 'Space = end of line   S = stall begins / ends   R = jumped back';
        await selfPaced(ctx, lines, { stall: true, rereadFrom: Math.max(0, rereadLines[0] - 1) });
      },
      summary(ctx) {
        const s = lineStats(ctx);
        const ph = ctx.truth.filter((t) => t.kind === 'phase');
        s.stalls = ph.filter((p) => p.name === 'stall').map((p) => ({ line: p.line, ms: Math.round(p.t1 - p.t0) }));
        s.rereads = ph.filter((p) => p.name === 'reread').length;
        s.struggleEvents = ctx.events.filter((e) => e.k === 'struggle').map((e) => ({ t: r1(e.t), reason: e.reason, line: e.line }));
        return { data: s, lines: [...lineStatsText(s), `stalls marked: ${JSON.stringify(s.stalls)}, re-reads marked: ${s.rereads}`, `struggle events from the tracker: ${s.struggleEvents.length} ${JSON.stringify(s.struggleEvents.slice(0, 6))}`] };
      },
    },
  };

  // ------------------------------------------------------------ run + save
  async function save(rec) {
    const qs = `?task=${encodeURIComponent(rec.task)}&label=${encodeURIComponent(rec.label || '')}`;
    const res = await fetch('/api/recording' + qs, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) });
    const out = await res.json();
    if (!out.ok) throw new Error(out.error || 'save failed');
    return out;
  }
  function baseRecording(task, params) {
    return {
      v: 1, task, label: readSetup().label || '', startedAt: new Date().toISOString(), durationMs: 0,
      env: env(), physical: physical(), params, truth: [], layout: null, events: [], dump: null, notes: ui.notes.value || '',
    };
  }
  function showResult(head, cls, lines = [], html = '') {
    ui.result.innerHTML = `<div class="${cls}">${esc(head)}</div><pre>${esc(lines.join('\n'))}</pre>${html}`;
  }
  let lastRecording = null;
  async function saveAndShow(rec, summary) {
    lastRecording = rec;
    try {
      const out = await save(rec);
      showResult(`Saved ${out.file} (${out.bytes} bytes)`, 'saved', [`task ${rec.task}, ${rec.events.length} events, ${rec.truth.length} truth entries, ${Math.round(rec.durationMs)} ms`, ...summary.lines], summary.html || '');
      return { ok: true, file: out.file, summary: summary.data, events: rec.events.length, truth: rec.truth.length };
    } catch (err) {
      showResult(`NOT SAVED: ${err.message}`, 'err', ['The recording is still in memory. Is the server running?', ...summary.lines], '<button data-a="download">Download recording as a file</button>');
      return { ok: false, error: String(err.message), summary: summary.data };
    }
  }

  async function runTask(name, params = {}, opts = {}) {
    const def = TASKS[name];
    if (!def) throw new Error('unknown task ' + name);
    if (current) throw new Error('a task is already running');
    const ctx = makeCtx(name, { ...def.defaults, ...params }, opts);
    current = ctx;
    resetStage();
    ui.home.hidden = true;
    ui.stage.hidden = false;
    const reading = name === 'lines-paced' || name === 'lines-self' || name === 'stall';
    try {
      await bridge.cmd('setWidget', { visible: false }).catch(() => {});
      await bridge.cmd('stream', { on: true }).catch((err) => { ctx.extra.streamError = String(err.message); });
      await intro(ctx, def.intro(ctx.params));
      // No camera frames arriving: ask the tracker to start (ignored if it cannot).
      if (name !== 'calibrate' && now() - lastRaw > 1500) {
        ctx.extra.autoStart = await bridge.cmd('start', {}, 20000).then(() => 'ok', (err) => String(err.message));
        await ctx.sleep(300);
      }
      const rec = baseRecording(name, ctx.params);
      const t0 = now();
      rec.t0 = t0;
      bridge.record(ctx.events);
      await def.run(ctx);
      await ctx.sleep(150); // let the last batch arrive
      bridge.record(null);
      rec.durationMs = now() - t0;
      resetStage();
      showMsg('Saving...');
      rec.dump = await bridge.cmd('dump', {}, 15000).catch((err) => ({ error: String(err.message) }));
      rec.session = sessionOf(rec.dump);
      if (opts.sequence) rec.sequence = opts.sequence;
      rec.truth = ctx.truth;
      rec.layout = ctx.layout;
      rec.events = ctx.events;
      if (Object.keys(ctx.extra).length) rec.extra = ctx.extra;
      const summary = def.summary(ctx, rec);
      rec.summary = summary.data;
      return await saveAndShow(rec, summary);
    } catch (err) {
      if (err instanceof Abort) {
        showResult(`Aborted: ${name} discarded, nothing saved.`, 'err');
        return { ok: false, aborted: true };
      }
      showResult(`Task ${name} failed: ${err.message}`, 'err', [String(err.stack || '')]);
      throw err;
    } finally {
      bridge.record(null);
      current = null;
      if (reading) await bridge.cmd('setRoot', { hostSelector: null }).catch(() => {});
      await bridge.cmd('setWidget', { visible: true }).catch(() => {});
      resetStage();
      ui.stage.hidden = true;
      ui.home.hidden = false;
    }
  }

  /* Which calibration a recording was made on. The id comes from the calibration itself (the time it
     was finished, which the extension keeps with it and gives back in every dump), so every recording
     made on one calibration carries the same id, across page reloads too. Before any calibration: null. */
  function sessionOf(dump) {
    const at = dump && dump.calibratedAt;
    return at ? { id: 'cal-' + at, calibratedAt: new Date(at).toISOString() } : { id: null, calibratedAt: null };
  }

  /* The benchmark session: the fixed sequence that gives tests/bench/gaze-bench.mjs its REAL rows.
     About six minutes: camera 15 s, calibrate, validate, read along at a 64 px and at a 32 px line
     spacing, the four head positions, validate again. Every step is saved as its own recording, with
     `sequence: { name: 'benchmark', step, of, run }`. A step that fails or is aborted ends the session. */
  const SESSION = [
    ['camera', { durationMs: 15000 }],
    ['calibrate', { baseline: false }],
    ['validate', {}],
    ['lines-paced', { pitch: 64, fontPx: 22 }],
    ['lines-paced', { pitch: 32, fontPx: 18 }],
    ['headshift', {}],
    ['validate', {}],
  ];
  async function runSession(opts = {}) {
    const run = Date.now().toString(36), out = [];
    for (let i = 0; i < SESSION.length; i += 1) {
      const [name, params] = SESSION[i];
      const res = await runTask(name, params, { ...opts, sequence: { name: 'benchmark', step: i + 1, of: SESSION.length, run } }).catch((err) => ({ ok: false, error: String(err.message) }));
      out.push({ task: name, ...res });
      if (!res || !res.ok) {
        showResult(`Benchmark session stopped at step ${i + 1} of ${SESSION.length} (${name}): ${res && res.aborted ? 'aborted' : (res && res.error) || 'failed'}.`, 'err', out.map((r, k) => `${k + 1}. ${r.task}: ${r.ok ? r.file : 'not saved'}`));
        return { ok: false, steps: out };
      }
    }
    showResult(`Benchmark session saved: ${out.length} recordings.`, 'saved', [...out.map((r, k) => `${k + 1}. ${r.task}: ${r.file}`), '', 'Now, in a terminal at the checkout root:', '  node tests/bench/gaze-bench.mjs --real-only     (the REAL rows alone, in a second)', '  node tests/bench/gaze-bench.mjs                 (the whole benchmark with the REAL rows under it)']);
    return { ok: true, steps: out };
  }

  async function dumpNow() {
    const rec = baseRecording('dump', {});
    rec.dump = await bridge.cmd('dump', {}, 15000).catch((err) => ({ error: String(err.message) }));
    rec.session = sessionOf(rec.dump);
    const d = rec.dump || {};
    return saveAndShow(rec, { data: { accuracy: d.accuracy ?? null }, lines: [d.error ? `dump failed: ${d.error}` : `accuracy: ${JSON.stringify(d.accuracy ?? null)}`] });
  }

  // ------------------------------------------------------------ home wiring
  function buildTasks() {
    for (const [name, def] of Object.entries(TASKS)) {
      const row = document.createElement('div');
      row.className = 'task';
      row.dataset.task = name;
      const inputs = Object.entries(def.defaults).map(([k, v]) => {
        if (typeof v === 'boolean') return `<label class="inline"><input type="checkbox" data-k="${k}" data-t="b" ${v ? 'checked' : ''}>${k}</label>`;
        if (typeof v === 'number') return `<label>${k}<input type="number" data-k="${k}" data-t="n" value="${v}"></label>`;
        return `<label>${k}<input type="text" data-k="${k}" data-t="j" value="${esc(JSON.stringify(v))}"></label>`;
      }).join('');
      row.innerHTML = `<button data-run="${name}">${name}</button><div class="params">${inputs}</div><div class="desc">${esc(def.desc)}</div>`;
      ui.tasks.appendChild(row);
    }
  }
  function readParams(name) {
    const out = {};
    for (const el of root.querySelectorAll(`.task[data-task="${name}"] [data-k]`)) {
      const k = el.dataset.k;
      if (el.dataset.t === 'b') out[k] = el.checked;
      else if (el.dataset.t === 'n') { if (el.value !== '') out[k] = Number(el.value); } else {
        try { out[k] = JSON.parse(el.value); } catch { /* keep the default */ }
      }
    }
    return out;
  }
  function fillParams(name, params) {
    for (const el of root.querySelectorAll(`.task[data-task="${name}"] [data-k]`)) {
      if (!(el.dataset.k in params)) continue;
      const v = params[el.dataset.k];
      if (el.dataset.t === 'b') el.checked = !!v;
      else if (el.dataset.t === 'n') el.value = v;
      else el.value = JSON.stringify(v);
    }
  }
  const start = (name, params, opts) => runTask(name, params, opts).catch((err) => { console.error(err); return { ok: false, error: String(err.message) }; });

  root.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    t.blur(); // so Space during a task never re-clicks it
    if (t.dataset.run) {
      // Coach params that have no form field ride along; the form wins for the rest.
      const coachParams = coach.inst && coach.inst.task === t.dataset.run ? coach.inst.params || {} : {};
      start(t.dataset.run, { ...coachParams, ...readParams(t.dataset.run) });
    } else if (t.dataset.a === 'session') runSession().catch((err) => { console.error(err); });
    else if (t.dataset.a === 'dump') dumpNow();
    else if (t.dataset.a === 'start') bridge.cmd('start', {}, 20000).then(() => refreshState(), (err) => showResult('start failed: ' + err.message, 'err'));
    else if (t.dataset.a === 'stop') bridge.cmd('stop', {}, 8000).then(() => refreshState(), (err) => showResult('stop failed: ' + err.message, 'err'));
    else if (t.dataset.a === 'note') sendNote();
    else if (t.dataset.a === 'download' && lastRecording) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(lastRecording)], { type: 'application/json' }));
      a.download = `gaze-lab-${lastRecording.task}.json`;
      a.click();
    }
  });
  async function sendNote() {
    const text = ui.notes.value.trim();
    if (!text) return;
    try {
      await fetch('/api/note', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      ui.notes.value = '';
      ui.notes.placeholder = 'Sent: ' + text.slice(0, 80);
    } catch (err) { showResult('note not sent: ' + err.message, 'err'); }
  }

  // status strip
  function showState(state) {
    if (!state) return;
    lastState = state;
    chip('tracker', `tracker: ${state.status ?? '?'}${state.drifted ? ' (drifted)' : ''}`);
    const acc = state.accuracy == null ? '' : ` (${typeof state.accuracy === 'object' ? JSON.stringify(state.accuracy) : state.accuracy})`;
    chip('calib', `calibrated: ${state.calibrated ? 'yes' : 'no'}${acc}`, state.calibrated ? 'ok' : 'bad');
    showCamera();
  }
  function showCamera() {
    const s = lastCamera;
    const fps = lastState && lastState.fps != null ? `, ${r1(lastState.fps)} fps` : '';
    chip('cam', s ? `camera: ${s.width ?? '?'}x${s.height ?? '?'}${s.frameRate ? ' @' + r1(s.frameRate) : ''}${fps}` : `camera: ?${fps}`);
  }
  bridge.on('status', (ev) => showState(ev.state));
  bridge.on('camera', (ev) => { lastCamera = ev.settings || null; showCamera(); });
  bridge.on('raw', (ev) => { lastRaw = ev.t; });
  const refreshState = () => bridge.cmd('state', {}, 3000).then(showState, () => {});

  let connected = false;
  async function connect() {
    for (;;) {
      try {
        const res = await bridge.cmd('hello', {}, 1500);
        connected = true;
        ui.banner.hidden = true;
        chip('ext', `extension: ${FAKE ? 'FAKE' : 'detected'}${res && res.version ? ' v' + res.version : ''}`, 'ok');
        showState(res && res.state);
        // ?landmarks=1 (lab only, off by default): every raw frame also carries 24 face landmarks (`lmk`: eye corners,
        // lids, both irises, nose bridge and tip, cheeks, forehead, chin; x, y, z as MediaPipe gives them). It adds
        // about 0.6 KB a frame to a recording. The camera frame learns of it when it starts, so a running tracker is restarted.
        if (LANDMARKS && !FAKE) {
          await bridge.cmd('init', { labLandmarks: true }).catch(() => {});
          if (res && res.state && !['idle', 'error', 'needs-permission'].includes(res.state.status)) { await bridge.cmd('stop', {}, 8000).catch(() => {}); await bridge.cmd('start', {}, 30000).catch(() => {}); }
          chip('ext', `extension: detected${res && res.version ? ' v' + res.version : ''}, landmarks on`, 'ok');
        }
        if (!current) await bridge.cmd('stream', { on: true }).catch(() => {});
        return;
      } catch {
        // The banner goes up after the first 1.5 s miss; keep trying quietly.
        ui.banner.hidden = false;
        chip('ext', 'extension: not detected', 'bad');
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }

  // coach panel
  const coach = { seq: 0, inst: null, timer: null };
  function cancelCountdown() {
    clearInterval(coach.timer);
    coach.timer = null;
    q('.coach .count').hidden = true;
  }
  function applyInstruction(inst) {
    coach.seq = inst.seq;
    coach.inst = inst;
    cancelCountdown();
    ui.coach.hidden = false;
    q('.coach .text').textContent = inst.text || '';
    q('.coach .meta').textContent = `Coach instruction #${inst.seq}${inst.task ? ' | task: ' + inst.task : ''}${inst.params ? ' | params: ' + JSON.stringify(inst.params) : ''}`;
    for (const row of root.querySelectorAll('.task')) row.classList.toggle('hot', row.dataset.task === inst.task);
    if (inst.task && TASKS[inst.task]) {
      if (inst.params) fillParams(inst.task, inst.params);
      if (inst.autostart) {
        let n = 3;
        const count = q('.coach .count');
        count.hidden = false;
        count.textContent = `Starting ${inst.task} in ${n}...`;
        coach.timer = setInterval(() => {
          n -= 1;
          if (n > 0) { count.textContent = `Starting ${inst.task} in ${n}...`; return; }
          cancelCountdown();
          if (!current) start(inst.task, { ...(inst.params || {}), ...readParams(inst.task) });
        }, 1000);
      }
    }
  }
  async function pollCoach() {
    if (current) return; // never change the screen under a running task
    try {
      const inst = await (await fetch('/api/instruction', { cache: 'no-store' })).json();
      if (inst && typeof inst.seq === 'number' && inst.seq !== coach.seq && inst.seq !== 0) applyInstruction(inst);
    } catch { /* server away; try again next tick */ }
  }

  if (FAKE) installFake();
  buildTasks();
  loadSetup();
  connect();
  pollCoach();
  setInterval(pollCoach, 2000);

  window.__lab = {
    bridge, TASKS, fake: FAKE,
    /** run(task, params, { auto: true }) skips every "press a key" step. Resolves with { ok, file, summary }. */
    run: (task, params, opts) => runTask(task, params, opts),
    /** session({ auto: true }): the benchmark session; resolves with { ok, steps: [{ task, ok, file }] }. */
    session: (opts) => runSession(opts), SESSION,
    dump: dumpNow,
    get last() { return lastRecording; },
    get connected() { return connected; },
    measureBlock,
  };
})();
