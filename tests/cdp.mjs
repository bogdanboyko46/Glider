// Minimal Chrome DevTools Protocol driver (no dependencies; Node 22+).
// Launches a throwaway Chrome, serves the repository over localhost, and
// exposes a few helpers for end-to-end checks and screenshots.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const EXTENSION = process.env.GLIDER_EXTENSION || join(REPO, 'glider-extension');

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
// Branded Chrome no longer honours --load-extension; Edge still does, so the
// real-extension run uses Edge unless BROWSER_WITH_EXTENSION says otherwise.
const EXTENSION_BROWSER = process.env.BROWSER_WITH_EXTENSION || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function serve(root = REPO) {
  const server = createServer(async (req, res) => {
    try {
      const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([\\/])+/, '');
      const file = join(root, path);
      if (!file.startsWith(root)) throw new Error('outside root');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

export async function launch({ width = 1280, height = 800, extension = false, headless = true } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'glider-chrome-'));
  const args = [
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--mute-audio', `--window-size=${width},${height}`,
    '--force-device-scale-factor=1', '--hide-scrollbars',
  ];
  if (headless) args.push('--headless=new');
  if (extension) {
    args.push(`--load-extension=${EXTENSION}`, `--disable-extensions-except=${EXTENSION}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch');
  }
  args.push('about:blank');

  const proc = spawn(extension ? EXTENSION_BROWSER : CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((ok, fail) => {
    let buffer = '';
    const timer = setTimeout(() => fail(new Error('Chrome did not start: ' + buffer.slice(-400))), 20000);
    proc.stderr.on('data', (chunk) => {
      buffer += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (m) { clearTimeout(timer); ok(m[1]); }
    });
    proc.on('exit', (code) => { clearTimeout(timer); fail(new Error('Chrome exited early: ' + code)); });
  });

  const port = new URL(wsUrl).port;
  const browser = await connect(wsUrl);

  async function close() {
    try { await browser.send('Browser.close'); } catch { /* already gone */ }
    await sleep(400);
    try { proc.kill(); } catch { /* already gone */ }
    await sleep(300);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  async function page(url) {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const info = list.find((t) => t.id === targetId);
    const cdp = await connect(info.webSocketDebuggerUrl);
    const errors = [];
    cdp.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text));
    cdp.on('Runtime.consoleAPICalled', (p) => {
      if (p.type === 'error' || p.type === 'warning') errors.push(`[console.${p.type}] ` + p.args.map((a) => a.value ?? a.description).join(' '));
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

    const api = {
      cdp,
      errors,
      async goto(target, settle = 900) {
        const loaded = new Promise((ok) => cdp.once('Page.loadEventFired', ok));
        await cdp.send('Page.navigate', { url: target });
        await Promise.race([loaded, sleep(20000)]);
        await sleep(settle);
      },
      async eval(expression) {
        const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
      },
      async shot(file, clip) {
        const params = { format: 'png' };
        if (clip) params.clip = { ...clip, scale: clip.scale || 1 };
        const { data } = await cdp.send('Page.captureScreenshot', params);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, Buffer.from(data, 'base64'));
        return file;
      },
      async move(x, y) {
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      },
      async click(x, y, count = 1) {
        await api.move(x, y);
        for (let i = 1; i <= count; i += 1) {
          await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: i });
          await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: i });
        }
      },
      async drag(x1, y1, x2, y2) {
        await api.move(x1, y1);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
        for (let i = 1; i <= 8; i += 1) {
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: x1 + ((x2 - x1) * i) / 8, y: y1 + ((y2 - y1) * i) / 8, button: 'left', buttons: 1,
          });
          await sleep(16);
        }
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
      },
      async key(key, { alt = false, code } = {}) {
        const base = { key, code: code || key, modifiers: alt ? 1 : 0, windowsVirtualKeyCode: keyCode(key) };
        await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      },
      sleep,
    };
    if (url) await api.goto(url);
    return api;
  }

  return { page, close, browser, port };
}

function keyCode(key) {
  const map = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Escape: 27, Enter: 13, Tab: 9, ' ': 32 };
  if (map[key]) return map[key];
  return key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0;
}

function connect(url) {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const listeners = new Map();
    const api = {
      send(method, params = {}) {
        const n = (id += 1);
        ws.send(JSON.stringify({ id: n, method, params }));
        return new Promise((res, rej) => pending.set(n, { res, rej, method }));
      },
      on(event, fn) { (listeners.get(event) || listeners.set(event, []).get(event)).push(fn); },
      once(event, fn) {
        const wrap = (p) => { listeners.set(event, (listeners.get(event) || []).filter((f) => f !== wrap)); fn(p); };
        api.on(event, wrap);
      },
      close() { ws.close(); },
    };
    ws.addEventListener('open', () => ok(api));
    ws.addEventListener('error', () => fail(new Error('CDP socket error: ' + url)));
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej, method } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`${method}: ${msg.error.message}`));
        else res(msg.result);
      } else if (msg.method) {
        for (const fn of listeners.get(msg.method) || []) fn(msg.params);
      }
    });
  });
}

/** Helpers evaluated in the page to reach into the dock's shadow root. */
export const IN_PAGE = `
  window.__ll = {
    root() { return document.querySelector('#glider-root').shadowRoot; },
    q(sel) { return this.root().querySelector(sel); },
    rect(sel) {
      const el = typeof sel === 'string' ? (this.q(sel) || document.querySelector(sel)) : sel;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    },
    token(word, nth = 0) {
      const all = [...document.querySelectorAll('.glider-token')].filter((t) => t.textContent.toLowerCase() === word.toLowerCase());
      return all[nth] || null;
    },
  };
`;
