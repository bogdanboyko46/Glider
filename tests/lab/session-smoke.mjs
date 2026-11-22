// Smoke test of the lab's benchmark session, on the lab page's built-in fake bridge (?fake=1: no
// extension, no camera, synthetic numbers). It checks the plumbing only: the seven steps run in
// order, each is saved as its own recording, a calibrate recording stores the calibration dots as
// truth, and every recording made after the calibration carries its session id.
//
//   node tests/lab/session-smoke.mjs
//
// The lab server is started on a spare port with --recordings pointing at a temp folder, so nothing
// is written into tests/lab/recordings. Server and browser are closed at the end.
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = await mkdtemp(join(tmpdir(), 'gaze-lab-smoke-'));
const port = 8400 + Math.floor(Math.random() * 400);
const server = spawn(process.execPath, [join(HERE, 'server.mjs'), '--recordings', dir, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
server.stdout.on('data', (c) => { serverOut += c; });
server.stderr.on('data', (c) => { serverOut += c; });
let chrome = null;
try {
  for (let i = 0; i < 40 && !/Gaze Lab: http/.test(serverOut); i += 1) await sleep(100);
  if (!/Gaze Lab: http/.test(serverOut)) throw new Error('the lab server did not start: ' + serverOut.slice(0, 300));
  chrome = await launch({ width: 1280, height: 800 });
  const page = await chrome.page();
  await page.goto(`http://127.0.0.1:${port}/?fake=1`, 1200);
  check('the lab page offers the benchmark session and lists its seven steps', await page.eval(`!!document.getElementById('lab-root').shadowRoot.querySelector('[data-a="session"]') && __lab.SESSION.map((s) => s[0]).join() === 'camera,calibrate,validate,lines-paced,lines-paced,headshift,validate'`));
  // shorter steps than a person gets, the same sequence
  await page.eval(`(() => { const S = __lab.SESSION; S[0][1].durationMs = 600; for (const i of [2, 5, 6]) Object.assign(S[i][1], { dwellMs: 250, settleMs: 80 }); S[2][1].points = 5; S[6][1].points = 5; for (const i of [3, 4]) Object.assign(S[i][1], { wpm: 1500, lines: 3 }); return 0; })()`);
  const out = await page.eval(`Promise.race([__lab.session({ auto: true }), new Promise((r) => setTimeout(() => r({ ok: false, error: 'timed out' }), 150000))])`);
  check('the session runs its seven steps to the end and saves each', !!out && out.ok && out.steps.length === 7 && out.steps.every((s) => s.ok && /\.json$/.test(s.file)), JSON.stringify(out && out.steps ? out.steps.map((s) => `${s.task}:${s.ok ? 'saved' : s.error || 'failed'}`) : out));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const recs = [];
  for (const f of files) recs.push({ f, ...JSON.parse(await readFile(join(dir, f), 'utf8')) });
  recs.sort((a, b) => a.sequence.step - b.sequence.step);
  check('seven recordings in the folder given to the server, numbered as one run', recs.length === 7 && recs.every((r, i) => r.sequence && r.sequence.name === 'benchmark' && r.sequence.step === i + 1 && r.sequence.of === 7 && r.sequence.run === recs[0].sequence.run), files.join(', '));
  const cal = recs[1] || {}, dots = (cal.truth || []).filter((t) => t.kind === 'caldot'), targets = (cal.truth || []).filter((t) => t.kind === 'target');
  check("the calibrate recording keeps the calibration's dots as truth, and the check dots also as targets", cal.task === 'calibrate' && dots.length === 4 && dots.every((d) => Number.isFinite(d.x) && Number.isFinite(d.tSettle) && d.tEnd > d.tSettle && d.seg && d.role) && targets.length === 2 && targets.every((t) => t.phase === 'check'),
    `${dots.length} caldot entries (${dots.map((d) => d.seg).join(', ')}), ${targets.length} targets`);
  const ids = recs.map((r) => r.session && r.session.id);
  check('every recording from the calibration on carries the same session id; the one before it has none', ids[0] === null && !!ids[1] && /^cal-\d+$/.test(ids[1]) && ids.slice(1).every((id) => id === ids[1]), ids.join(', '));
  check('the two read-along steps use a 64 px and a 32 px line spacing', recs[3].params.pitch === 64 && recs[4].params.pitch === 32 && recs[3].layout && recs[4].layout && recs[4].layout.blocks[0].pitch === 32, `${recs[3].params.pitch}, ${recs[4].params.pitch}`);
  check('no page errors or warnings', page.errors.length === 0, page.errors.slice(0, 4).join(' || '));
} catch (error) {
  check('test run completed', false, error.stack || String(error));
} finally {
  if (chrome) await chrome.close();
  server.kill();
  await sleep(300);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed; the lab server is stopped and the temp folder deleted`);
process.exit(failed ? 1 : 0);
