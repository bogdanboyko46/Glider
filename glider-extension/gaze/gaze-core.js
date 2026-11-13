/*
 * gaze-core.js — pure math for webcam gaze tracking (no DOM, no Chrome APIs).
 * Loaded as a classic script in both the camera iframe and the content script,
 * and require()-able from Node for tests.
 *
 *   extractFeatures  MediaPipe face landmarks -> feature vector
 *   Ridge            calibrated regression: features -> screen (x, y)
 *   OneEuro          jitter filter for the on-screen gaze dot
 *   FixationDetector online dispersion-based fixation detection
 *   LineHMM          "line locking": decodes which text line is being read
 *   mergeLineRects   Range.getClientRects() -> one rect per visual line
 *   summarizeBaseline  one read of the baseline passage -> reading pace + tau
 *   tauFromCv        the reader's own variability -> personal struggle threshold
 *   struggleDecision observed vs. baseline-expected times + tau -> struggling or not
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- features
  // MediaPipe Face Landmarker indices (478-point mesh with irises).
  const EYE_A = { c1: 33, c2: 133, up: 159, lo: 145 };   // corners run image-left -> image-right
  const EYE_B = { c1: 362, c2: 263, up: 386, lo: 374 };
  const IRIS_1 = 468, IRIS_2 = 473;
  const BLEND_KEYS = [
    'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookUpLeft', 'eyeLookUpRight',
    'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight',
  ];

  function pt(lm, i, vw, vh) { return [lm[i].x * vw, lm[i].y * vh]; }
  function mid(a, b) { return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  function eyeFeat(lm, eye, iris, vw, vh) {
    const c1 = pt(lm, eye.c1, vw, vh), c2 = pt(lm, eye.c2, vw, vh);
    const up = pt(lm, eye.up, vw, vh), lo = pt(lm, eye.lo, vw, vh);
    const w = dist(c1, c2) || 1e-6;
    const ux = [(c2[0] - c1[0]) / w, (c2[1] - c1[1]) / w];   // along the eye
    const px = [-ux[1], ux[0]];                               // perpendicular (vertical-ish)
    const m = mid(c1, c2), lm2 = mid(up, lo);
    const rx = iris[0] - m[0], ry = iris[1] - m[1];
    const lx = iris[0] - lm2[0], ly = iris[1] - lm2[1];
    return {
      u: (rx * ux[0] + ry * ux[1]) / w,      // horizontal iris position in the eye
      v: (rx * px[0] + ry * px[1]) / w,      // vertical iris position vs. corners
      vl: (lx * px[0] + ly * px[1]) / w,     // vertical iris position vs. lids
      open: dist(up, lo) / w,                // lid opening (lids follow vertical gaze)
      center: m,
    };
  }

  /**
   * @param lm          landmarks[0] from FaceLandmarker (478 {x,y,z}, normalized)
   * @param blend       faceBlendshapes[0].categories (may be undefined)
   * @param matrixData  facialTransformationMatrixes[0].data (16 numbers, may be undefined)
   * @param vw, vh      video size in px (to undo aspect-ratio squash)
   * @returns {{f:number[], head:{cx:number,cy:number,s:number}, blink:boolean}}
   */
  function extractFeatures(lm, blend, matrixData, vw, vh) {
    const i1 = pt(lm, IRIS_1, vw, vh), i2 = pt(lm, IRIS_2, vw, vh);
    const mA = mid(pt(lm, EYE_A.c1, vw, vh), pt(lm, EYE_A.c2, vw, vh));
    const mB = mid(pt(lm, EYE_B.c1, vw, vh), pt(lm, EYE_B.c2, vw, vh));
    // Pair irises to eyes by proximity (robust to index-convention differences).
    const straight = dist(i1, mA) + dist(i2, mB) <= dist(i1, mB) + dist(i2, mA);
    const A = eyeFeat(lm, EYE_A, straight ? i1 : i2, vw, vh);
    const B = eyeFeat(lm, EYE_B, straight ? i2 : i1, vw, vh);

    const bs = {};
    if (blend) for (const c of blend) bs[c.categoryName] = c.score;
    const blink = (bs.eyeBlinkLeft || 0) > 0.45 || (bs.eyeBlinkRight || 0) > 0.45 ||
      (A.open + B.open) / 2 < 0.12;

    const um = (A.u + B.u) / 2, vm = (A.v + B.v) / 2, vlm = (A.vl + B.vl) / 2, om = (A.open + B.open) / 2;
    const headC = mid(A.center, B.center);
    const head = { cx: headC[0] / vw, cy: headC[1] / vh, s: dist(A.center, B.center) / vw };

    const f = [
      A.u, A.v, A.vl, A.open, B.u, B.v, B.vl, B.open,
      um, vm, vlm, om, um * um, vm * vm, um * vm, vlm * vlm, um * vlm,
    ];
    for (const k of BLEND_KEYS) f.push(bs[k] || 0);
    const M = matrixData && matrixData.length === 16 ? matrixData : new Array(16).fill(0);
    for (let i = 0; i < 16; i++) f.push(M[i]);
    f.push(head.cx, head.cy, head.s);
    return { f, head, blink };
  }

  // ------------------------------------------------------------------- ridge
  function solve(A, b) {
    // Gaussian elimination with partial pivoting. A: d×d (array of Float64Array), b: d. Mutates copies.
    const d = b.length;
    const M = A.map((r) => Float64Array.from(r));
    const y = Float64Array.from(b);
    for (let c = 0; c < d; c++) {
      let p = c;
      for (let r = c + 1; r < d; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (p !== c) { [M[p], M[c]] = [M[c], M[p]]; [y[p], y[c]] = [y[c], y[p]]; }
      const piv = M[c][c] || 1e-12;
      for (let r = c + 1; r < d; r++) {
        const k = M[r][c] / piv;
        if (k === 0) continue;
        for (let j = c; j < d; j++) M[r][j] -= k * M[c][j];
        y[r] -= k * y[c];
      }
    }
    const w = new Float64Array(d);
    for (let r = d - 1; r >= 0; r--) {
      let s = y[r];
      for (let j = r + 1; j < d; j++) s -= M[r][j] * w[j];
      w[r] = s / (M[r][r] || 1e-12);
    }
    return w;
  }

  class Ridge {
    constructor() { this.ready = false; }

    /**
     * @param X       n × D raw features
     * @param Y       n × 2 targets (screen x, y)
     * @param groups  n group ids (calibration point) for leave-one-point-out CV; optional
     * @param lambdas candidate penalties (picked by CV when ≥4 groups)
     */
    fit(X, Y, groups, lambdas = [0.03, 0.1, 0.3, 1, 3, 10, 30, 100]) {
      const n = X.length, D = X[0].length;
      const mean = new Float64Array(D), sd = new Float64Array(D);
      for (const r of X) for (let j = 0; j < D; j++) mean[j] += r[j] / n;
      for (const r of X) for (let j = 0; j < D; j++) sd[j] += (r[j] - mean[j]) ** 2 / n;
      const keep = [];
      for (let j = 0; j < D; j++) { sd[j] = Math.sqrt(sd[j]); if (sd[j] > 1e-9) keep.push(j); }
      const d = keep.length;
      const Z = X.map((r) => { const z = new Float64Array(d); for (let k = 0; k < d; k++) z[k] = (r[keep[k]] - mean[keep[k]]) / sd[keep[k]]; return z; });
      const yMean = [0, 0];
      for (const t of Y) { yMean[0] += t[0] / n; yMean[1] += t[1] / n; }

      // Per-group Gram matrices so CV folds are cheap: G_fold = G_all − G_group.
      const gid = groups || X.map((_, i) => i % 5);
      const ids = [...new Set(gid)];
      const zero = () => Array.from({ length: d }, () => new Float64Array(d));
      const G = new Map(), B = new Map();
      for (const g of ids) { G.set(g, zero()); B.set(g, [new Float64Array(d), new Float64Array(d)]); }
      const Gall = zero(), Ball = [new Float64Array(d), new Float64Array(d)];
      for (let i = 0; i < n; i++) {
        const z = Z[i], g = G.get(gid[i]), b = B.get(gid[i]);
        const ty0 = Y[i][0] - yMean[0], ty1 = Y[i][1] - yMean[1];
        for (let a = 0; a < d; a++) {
          const za = z[a];
          b[0][a] += za * ty0; b[1][a] += za * ty1;
          for (let c = a; c < d; c++) g[a][c] += za * z[c];
        }
      }
      for (const g of ids) {
        const m = G.get(g);
        for (let a = 0; a < d; a++) for (let c = a; c < d; c++) { m[c][a] = m[a][c]; Gall[a][c] += m[a][c]; if (c !== a) Gall[c][a] += m[a][c]; }
        const b = B.get(g);
        for (let a = 0; a < d; a++) { Ball[0][a] += b[0][a]; Ball[1][a] += b[1][a]; }
      }
      const fitW = (Gm, Bm, lam) => {
        const A = Gm.map((r, i) => { const c = Float64Array.from(r); c[i] += lam; return c; });
        return [solve(A, Bm[0]), solve(A, Bm[1])];
      };

      let best = lambdas[Math.floor(lambdas.length / 2)], cvErr = null;
      if (ids.length >= 4) {
        let bestErr = Infinity;
        for (const lam of lambdas) {
          let se = 0, cnt = 0;
          for (const g of ids) {
            const Gf = Gall.map((r, a) => r.map((v, c) => v - G.get(g)[a][c]));
            const Bf = [0, 1].map((k) => Ball[k].map((v, a) => v - B.get(g)[k][a]));
            const [wx, wy] = fitW(Gf, Bf, lam);
            for (let i = 0; i < n; i++) {
              if (gid[i] !== g) continue;
              let px = yMean[0], py = yMean[1];
              for (let a = 0; a < d; a++) { px += Z[i][a] * wx[a]; py += Z[i][a] * wy[a]; }
              se += (px - Y[i][0]) ** 2 + (py - Y[i][1]) ** 2; cnt++;
            }
          }
          const err = Math.sqrt(se / cnt);
          if (err < bestErr) { bestErr = err; best = lam; }
        }
        cvErr = bestErr;
      }
      const [wx, wy] = fitW(Gall, Ball, best);
      Object.assign(this, { ready: true, keep, mean: Array.from(mean), sd: Array.from(sd), yMean, wx: Array.from(wx), wy: Array.from(wy), lambda: best, cvErr, n });
      return this;
    }

    predict(f) {
      let x = this.yMean[0], y = this.yMean[1];
      for (let k = 0; k < this.keep.length; k++) {
        const j = this.keep[k];
        const z = (f[j] - this.mean[j]) / this.sd[j];
        x += z * this.wx[k]; y += z * this.wy[k];
      }
      return [x, y];
    }

    toJSON() { const { keep, mean, sd, yMean, wx, wy, lambda, cvErr, n } = this; return { keep, mean, sd, yMean, wx, wy, lambda, cvErr, n }; }
    static fromJSON(o) { const r = new Ridge(); Object.assign(r, o, { ready: true }); return r; }
  }

  // ----------------------------------------------------------------- 1€ filter
  class OneEuro {
    constructor(minCutoff = 0.6, beta = 0.004, dCutoff = 1.0) { Object.assign(this, { minCutoff, beta, dCutoff }); this.reset(); }
    reset() { this.x = null; this.dx = 0; this.t = null; }
    static alpha(cutoff, dt) { const tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
    filter(v, tMs) {
      if (this.x === null) { this.x = v; this.t = tMs; return v; }
      const dt = Math.max(1e-3, (tMs - this.t) / 1000); this.t = tMs;
      const dv = (v - this.x) / dt;
      this.dx += OneEuro.alpha(this.dCutoff, dt) * (dv - this.dx);
      const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
      this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
      return this.x;
    }
  }

  // ---------------------------------------------------------- fixation detect
  /**
   * Online dispersion-threshold (I-DT) detector. Long fixations are emitted in
   * chunks of `maxDur` ms so downstream logic stays real-time.
   */
  class FixationDetector {
    constructor({ dispersion = 90, minDur = 120, maxDur = 350, maxGap = 160 } = {}) {
      Object.assign(this, { dispersion, minDur, maxDur, maxGap });
      this.win = null; this.hist = [];
    }
    reset() { this.win = null; this.hist = []; }
    _emit() {
      const w = this.win;
      if (!w || w.t1 - w.t0 < this.minDur) return null;
      return { x: w.sx / w.n, y: w.sy / w.n, t: w.t0, dur: w.t1 - w.t0, n: w.n };
    }
    _start(t, x, y) { this.win = { t0: t, t1: t, n: 1, sx: x, sy: y, minX: x, maxX: x, minY: y, maxY: y }; }
    /** @returns completed fixation or null */
    push(t, x, y) {
      // median-of-3 pre-filter knocks out single-frame spikes
      this.hist.push([x, y]); if (this.hist.length > 3) this.hist.shift();
      if (this.hist.length === 3) {
        const xs = this.hist.map((p) => p[0]).sort((a, b) => a - b);
        const ys = this.hist.map((p) => p[1]).sort((a, b) => a - b);
        x = xs[1]; y = ys[1];
      }
      let out = null;
      const w = this.win;
      if (!w || t - w.t1 > this.maxGap) { out = this._emit(); this._start(t, x, y); return out; }
      const minX = Math.min(w.minX, x), maxX = Math.max(w.maxX, x);
      const minY = Math.min(w.minY, y), maxY = Math.max(w.maxY, y);
      if ((maxX - minX) + (maxY - minY) > this.dispersion) {
        out = this._emit(); this._start(t, x, y); return out;
      }
      Object.assign(w, { minX, maxX, minY, maxY, t1: t, n: w.n + 1, sx: w.sx + x, sy: w.sy + y });
      if (w.t1 - w.t0 >= this.maxDur) {
        out = this._emit();
        const cx = w.sx / w.n, cy = w.sy / w.n;
        this.win = { t0: t, t1: t, n: 1, sx: cx, sy: cy, minX: Math.min(cx, x), maxX: Math.max(cx, x), minY: Math.min(cy, y), maxY: Math.max(cy, y) };
      }
      return out;
    }
  }

  // ------------------------------------------------------------ line locking
  /**
   * Hidden Markov model over the lines of one paragraph. Readers move through
   * lines in order and a "return sweep" (large leftward jump) almost always means
   * a line change, so the decoded line is far more reliable than nearest-line-to-y.
   */
  class LineHMM {
    /** @param drift shared {y:number} offset estimate; pass the same object to every paragraph's HMM */
    constructor(drift = { y: 0 }) { this.belief = null; this.prevX = null; this.drift = drift; }
    reset() { this.belief = null; this.prevX = null; }

    /**
     * @param lines  [{top,bottom,left,right}] viewport coords, in reading order
     * @param fx,fy  fixation centroid
     * @param sx,sy  tracker error (px, 1σ) horizontally / vertically
     * @param enteredFromAbove  hint used only when (re)initializing
     * @returns {{line:number, conf:number, returnSweep:boolean}}
     */
    update(lines, fx, fy, sx, sy, enteredFromAbove = false) {
      const n = lines.length;
      if (!n) return { line: -1, conf: 0, returnSweep: false };
      const rawY = fy;
      fy -= this.drift.y;                                   // online drift correction
      const left = Math.min(...lines.map((l) => l.left)), right = Math.max(...lines.map((l) => l.right));
      const width = Math.max(1, right - left);
      const emis = new Float64Array(n);
      for (let j = 0; j < n; j++) {
        const l = lines[j], cy = (l.top + l.bottom) / 2;
        let e = Math.exp(-0.5 * ((fy - cy) / sy) ** 2);
        if (fx > l.right + 2 * sx || fx < l.left - 2 * sx) e *= 0.3;   // e.g. short last line
        emis[j] = e + 1e-9;
      }
      let prior;
      let returnSweep = false;
      if (!this.belief || this.belief.length !== n) {
        prior = new Float64Array(n).fill(1);
        if (enteredFromAbove) prior[0] = 3;
      } else {
        const dx = this.prevX === null ? 0 : fx - this.prevX;
        returnSweep = dx < -0.4 * width;
        prior = new Float64Array(n);
        const b = this.belief;
        for (let i = 0; i < n; i++) {
          if (b[i] < 1e-6) continue;
          const T = new Float64Array(n);
          const others = n > 1 ? 1 / (n - 1) : 0;
          if (returnSweep) {
            for (let j = 0; j < n; j++) T[j] = 0.12 * others;
            if (i + 1 < n) T[i + 1] += 0.6; else T[i] += 0.6;
            if (i - 1 >= 0) T[i - 1] += 0.18; else T[i] += 0.18;
            T[i] += 0.1;
          } else {
            for (let j = 0; j < n; j++) T[j] = 0.05 * others;
            T[i] += 0.82;
            if (i + 1 < n) T[i + 1] += 0.08; else T[i] += 0.08;
            if (i - 1 >= 0) T[i - 1] += 0.05; else T[i] += 0.05;
          }
          for (let j = 0; j < n; j++) prior[j] += b[i] * T[j];
        }
      }
      const post = new Float64Array(n);
      let s = 0;
      for (let j = 0; j < n; j++) { post[j] = prior[j] * emis[j]; s += post[j]; }
      let best = 0;
      for (let j = 0; j < n; j++) { post[j] /= s || 1; if (post[j] > post[best]) best = j; }
      this.belief = post; this.prevX = fx;
      // Confident assignments teach us the tracker's current vertical bias (head drift,
      // calibration error). Clamp so one bad decode can't run away.
      if (post[best] > 0.7) {
        const cy = (lines[best].top + lines[best].bottom) / 2;
        const resid = Math.max(-sy, Math.min(sy, rawY - cy));
        this.drift.y += 0.12 * (resid - this.drift.y);
      }
      return { line: best, conf: post[best], returnSweep };
    }
  }

  /** Collapse Range.getClientRects() fragments into one rect per visual line. */
  function mergeLineRects(rects) {
    const rs = Array.from(rects).filter((r) => r.width > 1 && r.height > 1)
      .map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right }))
      .sort((a, b) => a.top - b.top || a.left - b.left);
    const lines = [];
    for (const r of rs) {
      const cy = (r.top + r.bottom) / 2;
      const h = r.bottom - r.top;
      const L = lines.find((l) => Math.abs((l.top + l.bottom) / 2 - cy) < 0.5 * Math.min(h, l.bottom - l.top));
      if (L) { L.top = Math.min(L.top, r.top); L.bottom = Math.max(L.bottom, r.bottom); L.left = Math.min(L.left, r.left); L.right = Math.max(L.right, r.right); }
      else lines.push({ ...r });
    }
    return lines.sort((a, b) => a.top - b.top);
  }

  // ------------------------------------------------- reading baseline and tau
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const TAU_MIN = 1.6, TAU_MAX = 3.0, TAU_DEFAULT = 2.0;

  /**
   * Personal struggle threshold from the reader's own line-to-line variability
   * during the baseline passage. A steady reader gets a tight threshold (help
   * arrives sooner); an erratic one gets a loose threshold, so their normal
   * variation is not mistaken for trouble.
   * @param cv coefficient of variation of per-line ms-per-word
   */
  function tauFromCv(cv) {
    if (!Number.isFinite(cv) || cv < 0) cv = 0;
    return clamp(TAU_MIN + (TAU_MAX - TAU_MIN) * (cv / 0.6), TAU_MIN, TAU_MAX);
  }

  /**
   * Turn one read of the baseline passage into the reader's baseline.
   * @param lines       [{words, dwellMs}] per visual line, from gaze
   * @param clockMs     wall-clock time the passage was on screen
   * @param totalWords  words in the passage
   * @param regressions confident jumps back to an earlier line
   */
  function summarizeBaseline({ lines = [], clockMs = 0, totalWords = 0, regressions = 0 }) {
    const seen = lines.filter((l) => l.dwellMs > 0 && l.words > 0);
    const gazeMs = seen.reduce((a, l) => a + l.dwellMs, 0);
    const gazeWords = seen.reduce((a, l) => a + l.words, 0);
    const covered = lines.length ? seen.length / lines.length : 0;
    const gazeOk = covered >= 0.6 && clockMs > 0 && gazeMs >= 0.5 * clockMs && gazeMs <= 1.3 * clockMs && gazeWords > 0;
    const source = gazeOk ? 'gaze' : 'clock';
    const ms = gazeOk ? gazeMs : clockMs;
    const words = gazeOk ? gazeWords : totalWords;
    const wpm = clamp(ms > 0 ? words / (ms / 60000) : 0, 40, 600);

    // Very short lines (the tail of a paragraph) give wild ms-per-word values.
    const rates = seen.filter((l) => l.words >= 3).map((l) => l.dwellMs / l.words);
    let cv = 0;
    if (rates.length >= 3) {
      const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
      const sd = Math.sqrt(rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length);
      cv = mean > 0 ? sd / mean : 0;
    }
    return {
      wpm, msPerWord: 60000 / wpm, cv, regressionRate: lines.length ? regressions / lines.length : 0,
      tau: tauFromCv(cv), words: totalWords, lines: lines.length, ms: Math.round(ms), source,
    };
  }

  /**
   * Is the reader struggling right now? Times are compared with what this
   * reader's baseline pace predicts; tau is how many times slower counts.
   * @returns {{reason: null|'stuck-line'|'rereading'|'slow-paragraph', severity: number, ratio: number}}
   */
  function struggleDecision({ onLineMs = 0, expLineMs = 0, paraMs = 0, expParaMs = 0, finished = false, backtracks = 0, tau = TAU_DEFAULT, regressionRate = 0 }) {
    const lineRatio = expLineMs > 0 ? onLineMs / expLineMs : 0;
    const paraRatio = !finished && expParaMs > 0 ? paraMs / expParaMs : 0;
    const ratio = Math.max(lineRatio, paraRatio);
    const needBack = regressionRate > 0.35 ? 3 : 2;   // habitual re-readers need one more jump back
    let reason = null, severity = 0;
    if (onLineMs > Math.max(2000, tau * expLineMs)) {
      reason = 'stuck-line';
      severity = Math.min(1, onLineMs / (3 * tau * Math.max(expLineMs, 600)));
    } else if (backtracks >= needBack) {
      reason = 'rereading';
      severity = Math.min(1, backtracks / (needBack + 2));
    } else if (!finished && paraMs > Math.max(4000, 1.1 * tau * expParaMs)) {
      reason = 'slow-paragraph';
      severity = Math.min(1, paraMs / (2.5 * tau * Math.max(expParaMs, 1)));
    }
    return { reason, severity, ratio };
  }

  const api = {
    extractFeatures, Ridge, OneEuro, FixationDetector, LineHMM, mergeLineRects, solve,
    tauFromCv, summarizeBaseline, struggleDecision, TAU_MIN, TAU_MAX, TAU_DEFAULT,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GazeCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
