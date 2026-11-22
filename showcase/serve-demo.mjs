// A small local web server for recording Glider on the demo pages with the real extension and a real camera.
//   node showcase/serve-demo.mjs          then open http://localhost:8378/tenancy-agreement
// Serves the repository on port 8378 (Ctrl+C stops it). Short addresses for the demo pages:
//   /tenancy-agreement -> demo/hard-reading.html      /how-plants-make-food -> demo/reading.html
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8378);
const SHORT = { '/': 'demo/hard-reading.html', '/tenancy-agreement': 'demo/hard-reading.html', '/how-plants-make-food': 'demo/reading.html' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = join(ROOT, normalize(SHORT[path] || path).replace(/^([\/])+/, ''));
    if (!file.startsWith(ROOT)) throw new Error('outside the repository');
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end('not found'); }
}).listen(PORT, '127.0.0.1', () => console.log(`Glider demo pages on http://localhost:${PORT}/tenancy-agreement  (Ctrl+C to stop)`));
