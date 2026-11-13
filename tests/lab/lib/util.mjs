// Shared helpers for the Gaze Lab offline toolkit: loads the real tracker core and small statistics.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
export const LAB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_DIR = path.resolve(LAB_DIR, '..', '..');
export const C = require(path.join(REPO_DIR, 'glider-extension', 'gaze', 'gaze-core.js'));

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
export const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
export const rms = (a) => (a.length ? Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length) : NaN);
export const mae = (a) => (a.length ? a.reduce((s, v) => s + Math.abs(v), 0) / a.length : NaN);
export function quantile(a, p) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y); const i = p * (s.length - 1); const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
export const median = (a) => quantile(a, 0.5);
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Pooled autocorrelation of residuals. `groups` is an array of series; each series is an array of
 * {t, r} already centred on its own group mean. A pair (i, i+k) only counts when the time between
 * the two frames is close to k frame intervals (so dropped frames do not fake a lag).
 */
export function pooledAutocorr(groups, k, dtMed) {
  let num = 0, den = 0, n = 0, nAll = 0, den0 = 0;
  for (const g of groups) {
    for (let i = 0; i < g.length; i++) { den0 += g[i].r * g[i].r; nAll++; }
    for (let i = 0; i + k < g.length; i++) {
      const dt = g[i + k].t - g[i].t;
      if (dtMed > 0 && (dt > (k + 0.6) * dtMed || dt < (k - 0.6) * dtMed)) continue;
      num += g[i].r * g[i + k].r; den += (g[i].r * g[i].r + g[i + k].r * g[i + k].r) / 2; n++;
    }
  }
  return n >= 8 && den > 0 ? num / den : NaN;
}

/** Effective number of independent frames in an n-frame mean given autocorrelations rho[1..n-1]. */
export function effectiveN(n, rho) {
  let s = 1;
  for (let k = 1; k < n; k++) { const r = isNum(rho[k]) ? rho[k] : 0; s += 2 * (1 - k / n) * r; }
  return n / Math.max(s, 1e-6);
}

export function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
export function mkRng(seed) {
  const u = mulberry32(seed); let spare = null;
  const g = () => { if (spare !== null) { const s = spare; spare = null; return s; } let a, b, r; do { a = 2 * u() - 1; b = 2 * u() - 1; r = a * a + b * b; } while (r >= 1 || r === 0); const m = Math.sqrt(-2 * Math.log(r) / r); spare = b * m; return a * m; };
  return { u, g, U: (a, b) => a + (b - a) * u() };
}

export const f0 = (v) => (isNum(v) ? String(Math.round(v)) : 'n/a');
export const f1 = (v) => (isNum(v) ? v.toFixed(1) : 'n/a');
export const f2 = (v) => (isNum(v) ? v.toFixed(2) : 'n/a');
export const f3 = (v) => (isNum(v) ? v.toFixed(3) : 'n/a');
export const f4 = (v) => (isNum(v) ? v.toFixed(4) : 'n/a');
export const pct = (v) => (isNum(v) ? (100 * v).toFixed(1) + '%' : 'n/a');
