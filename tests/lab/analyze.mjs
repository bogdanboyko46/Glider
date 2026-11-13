#!/usr/bin/env node
// Offline analysis of Gaze Lab recordings.
//   node tests/lab/analyze.mjs <file|latest> [more files...] [--json] [--cal <file-with-dump>]
//   node tests/lab/analyze.mjs --compare <fileA> <fileB> [--json] [--cal <file>]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LAB_DIR } from './lib/util.mjs';
import { analyze } from './lib/analysis.mjs';
import { render, renderCompare, headline } from './lib/report.mjs';

const REC_DIR = path.join(LAB_DIR, 'recordings');

function startedMs(rec, file) {
  const s = rec && rec.startedAt;
  if (typeof s === 'number' && Number.isFinite(s)) return s;
  if (typeof s === 'string') { const d = Date.parse(s); if (Number.isFinite(d)) return d; }
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}
function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { __error: `cannot read ${file}: ${e.message}` }; }
}
const hasTrain = (rec) => !!(rec && rec.dump && rec.dump.train && Array.isArray(rec.dump.train.X) && rec.dump.train.X.length > 10);
function jsonFiles(dir) { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f)); } catch { return []; } }
function latest() {
  const fl = jsonFiles(REC_DIR).map((f) => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m);
  return fl.length ? fl[0].f : null;
}
/** Newest earlier recording (same folder, then tests/lab/recordings) that carries dump.train. */
function findCal(file, rec) {
  const t = startedMs(rec, file); let best = null;
  const dirs = [...new Set([path.dirname(path.resolve(file)), REC_DIR])];
  for (const dir of dirs) for (const f of jsonFiles(dir)) {
    if (path.resolve(f) === path.resolve(file)) continue;
    let size = 0; try { size = fs.statSync(f).size; } catch { continue; }
    if (size < 2000) continue;
    const r = load(f); if (!hasTrain(r)) continue;
    const ts = startedMs(r, f); if (ts > t) continue;
    if (!best || ts > best.ts) best = { ts, rec: r, name: path.basename(f) };
  }
  return best;
}

export function analyzeFile(file, calFile = null) {
  const rec = load(file); const name = path.basename(file);
  if (rec.__error) return { file: name, ok: false, error: rec.__error };
  let cal = null;
  if (calFile) { const c = load(calFile); cal = hasTrain(c) ? { rec: c, name: path.basename(calFile) + ' (--cal)' } : null; }
  // --cal overrides only when given; otherwise fall back to an earlier recording when this one has no train set
  if (calFile && cal && hasTrain(rec)) rec.dump = { ...rec.dump, train: null };
  if (!cal && !hasTrain(rec)) cal = findCal(file, rec);
  const R = analyze(rec, { cal, name });
  if (calFile && !cal) R.calWarning = `--cal ${calFile} has no dump.train; ignored`;
  return R;
}

function main(argv) {
  const args = []; let json = false, cal = null, compare = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true; else if (a === '--compare') compare = true; else if (a === '--cal') cal = argv[++i]; else args.push(a);
  }
  if (!args.length) { console.error('usage: node tests/lab/analyze.mjs <file|latest> [more files...] [--json] [--cal <file>]\n       node tests/lab/analyze.mjs --compare <fileA> <fileB>'); return 2; }
  const files = [];
  for (const a of args) {
    if (a === 'latest') { const l = latest(); if (!l) { console.error(`no recordings in ${REC_DIR}`); return 1; } files.push(l); } else files.push(a);
  }
  if (compare) {
    if (files.length !== 2) { console.error('--compare needs exactly two files'); return 2; }
    const [A, B] = files.map((f) => analyzeFile(f, cal));
    for (const r of [A, B]) if (!r.ok) { console.error(r.error); return 1; }
    if (json) console.log(JSON.stringify({ a: A.file, b: B.file, rows: headline(A).map((r, i) => ({ name: r[0], a: r[1], b: headline(B)[i][1] })) }, null, 1));
    else console.log(renderCompare(A, B));
    return 0;
  }
  const results = files.map((f) => analyzeFile(f, cal));
  if (json) console.log(JSON.stringify(results.length === 1 ? results[0] : results, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 1));
  else console.log(results.map((r) => render(r) + (r.calWarning ? '\nWARNING: ' + r.calWarning : '')).join('\n\n'));
  return results.every((r) => r.ok) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
