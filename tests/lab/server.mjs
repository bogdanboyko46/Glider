// Gaze Lab server: static page + recording sink. Zero dependencies.
//   node tests/lab/server.mjs
import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { readFile, mkdir, rename, rm, readdir, stat, appendFile, access } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, 'site');
const RECORDINGS = join(HERE, 'recordings');
const INSTRUCTION = join(HERE, 'instruction.json');
const HOST = '127.0.0.1';
const PORT = 8377;
const MAX_BODY = 80 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

const clean = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
const exists = (f) => access(f).then(() => true, () => false);

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** Stream the request body to a file; rejects past `limit` bytes. */
function receiveToFile(req, file, limit) {
  return new Promise((ok, fail) => {
    const out = createWriteStream(file);
    let bytes = 0;
    let done = false;
    const end = (err) => {
      if (done) return;
      done = true;
      if (err) { req.unpipe(out); out.destroy(); fail(err); } else ok(bytes);
    };
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) end(Object.assign(new Error('body too large'), { code: 413 }));
    });
    req.on('error', end);
    req.on('aborted', () => end(new Error('request aborted')));
    out.on('error', end);
    out.on('finish', () => end());
    req.pipe(out);
  });
}

async function readSmallBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw Object.assign(new Error('body too large'), { code: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function postRecording(req, res, url) {
  await mkdir(RECORDINGS, { recursive: true });
  const tmp = join(RECORDINGS, `.incoming-${randomBytes(6).toString('hex')}.tmp`);
  try {
    const bytes = await receiveToFile(req, tmp, MAX_BODY);
    let task = url.searchParams.get('task');
    let label = url.searchParams.get('label');
    if (!task) {
      // No hint in the query string: read the task and label from the body.
      const body = JSON.parse(await readFile(tmp, 'utf8'));
      task = body.task;
      label = label ?? body.label;
    }
    task = clean(task) || 'unknown';
    label = clean(label);
    const base = `${stamp()}-${task}${label ? '-' + label : ''}`;
    let name = `${base}.json`;
    for (let i = 2; await exists(join(RECORDINGS, name)); i += 1) name = `${base}-${i}.json`;
    await rename(tmp, join(RECORDINGS, name));
    const rel = `tests/lab/recordings/${name}`;
    console.log(`RECORDING ${rel} ${bytes} bytes`);
    json(res, 200, { ok: true, file: rel, bytes });
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    json(res, err.code === 413 ? 413 : 400, { ok: false, error: String(err.message || err) });
  }
}

async function listRecordings() {
  let names = [];
  try { names = await readdir(RECORDINGS); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const s = await stat(join(RECORDINGS, name)).catch(() => null);
    if (s) out.push({ name, bytes: s.size, mtime: s.mtimeMs });
  }
  out.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? 1 : -1));
  return out;
}

async function serveStatic(res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = resolve(SITE, '.' + normalize(rel));
  if (file !== SITE && !file.startsWith(SITE + sep)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'cache-control': 'no-store' }).end('not found');
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const route = `${req.method} ${url.pathname}`;
    if (route === 'POST /api/recording') return await postRecording(req, res, url);
    if (route === 'GET /api/instruction') {
      let text = '{ "seq": 0 }';
      try {
        const raw = await readFile(INSTRUCTION, 'utf8');
        JSON.parse(raw); // a half-written file falls back to seq 0
        text = raw;
      } catch { /* missing or invalid */ }
      return json(res, 200, text);
    }
    if (route === 'GET /api/recordings') return json(res, 200, await listRecordings());
    if (route === 'POST /api/note') {
      const body = JSON.parse(await readSmallBody(req) || '{}');
      const text = String(body.text ?? '').replace(/\s+/g, ' ').trim();
      await mkdir(RECORDINGS, { recursive: true });
      await appendFile(join(RECORDINGS, 'notes.log'), `${new Date().toISOString()} ${text}\n`);
      console.log(`NOTE ${text}`);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(res, url.pathname);
    res.writeHead(405).end('method not allowed');
  } catch (err) {
    if (!res.headersSent) json(res, 500, { ok: false, error: String(err.message || err) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => console.log(`Gaze Lab: http://${HOST}:${PORT}/`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
