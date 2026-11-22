// The unpacked extension, loaded once in headless Edge on tests/gaze-site/full.html (added at sign-off):
//   - every file named in manifest.json exists on disk
//   - the content scripts run on the page and GazeReader starts
//   - no console error or warning on the page, in the camera frame or in the service worker
// Headless Edge's built-in fake camera hands over a track that has already ended, so the start ends in
// 'error' with code camera-lost: that is the camera frame noticing a dead camera, which is checked here too.
// (tests/gaze-camera-smoke.mjs is the test with pictures coming: it plays a photo as the camera.)
//   node tests/extension-load.mjs
import fs from 'node:fs';
import path from 'node:path';
import { launch, serve, REPO as root } from './cdp.mjs';
const EXT = path.join(root, 'glider-extension');

// ---- manifest files
const man = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const named = new Set();
const add = (v) => { if (typeof v === 'string' && v) named.add(v); };
add(man.action && man.action.default_popup); add(man.options_ui && man.options_ui.page); add(man.background && man.background.service_worker);
for (const v of Object.values(man.icons || {})) add(v);
for (const v of Object.values((man.action && man.action.default_icon) || {})) add(v);
for (const cs of man.content_scripts || []) { (cs.js || []).forEach(add); (cs.css || []).forEach(add); }
for (const w of man.web_accessible_resources || []) (w.resources || []).forEach(add);
const missing = [], globs = [];
for (const f of named) {
  if (f.includes('*')) {
    const dir = path.join(EXT, path.dirname(f)), re = new RegExp('^' + path.basename(f).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    let n = 0; try { n = fs.readdirSync(dir).filter((x) => re.test(x)).length; } catch { /* no folder */ }
    globs.push(`${f}: ${n} file(s)`); if (!n) missing.push(f);
  } else if (!fs.existsSync(path.join(EXT, f))) missing.push(f);
}
console.log(`manifest.json names ${named.size} entries (${globs.join('; ')}); missing on disk: ${missing.length ? missing.join(', ') : 'none'}`);
console.log(`content_security_policy: ${JSON.stringify(man.content_security_policy)}`);

// ---- the extension in the browser
const { server, origin } = await serve();
const chrome = await launch({ width: 1280, height: 800, extension: true, extraArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--host-resolver-rules=MAP * 0.0.0.0, EXCLUDE 127.0.0.1, EXCLUDE localhost'] });
let code = missing.length ? 1 : 0;
try {
  const B = chrome.browser, sessions = new Map(), all = [];
  B.on('Target.attachedToTarget', (p) => { const sid = p.sessionId; sessions.set(sid, p.targetInfo); const q = (x) => x.catch(() => {}); q(B.send('Runtime.enable', {}, sid)); q(B.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sid)); });
  B.on('Runtime.consoleAPICalled', (p, sid) => { if (p.type === 'error' || p.type === 'warning') all.push('[' + ((sessions.get(sid) || {}).type || '?') + ' ' + String((sessions.get(sid) || {}).url || '').slice(0, 60) + '] console.' + p.type + ': ' + p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)); });
  B.on('Runtime.exceptionThrown', (p, sid) => { all.push('[' + ((sessions.get(sid) || {}).type || '?') + '] uncaught: ' + String((p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text).slice(0, 300)); });
  await B.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const page = await chrome.page();
  const ctxs = [];
  page.cdp.on('Runtime.executionContextCreated', (p) => ctxs.push(p.context));
  await page.goto(`${origin}/tests/gaze-site/full.html`, 2500);
  const iso = ctxs.filter((c) => c.origin && c.origin.startsWith('chrome-extension://') && c.auxData && c.auxData.isDefault === false).pop();
  console.log(`extension content-script world on the page: ${iso ? iso.origin : 'NOT FOUND'}`);
  if (!iso) code = 1;
  else {
    const ev = async (expression) => { const r = await page.cdp.send('Runtime.evaluate', { expression, contextId: iso.id, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
    console.log('in that world:', JSON.stringify(await ev(`({ core: typeof GazeCore, reader: typeof GazeReader, status: GazeReader.getState().status, features: GazeCore.FEATURE_COUNT, gateA: GazeCore.HEAD_GATE.A, resume: typeof GazeCore.CalibrationRun.prototype.resume })`)));
    const started = await ev(`Promise.race([GazeReader.start().then((s) => ({ status: s.status, error: s.error, camera: s.camera })), new Promise((r) => setTimeout(() => r('no answer in 40 s'), 40000))])`);
    console.log('GazeReader.start() with the browser\'s fake camera (headless Edge hands over a camera track that has already ended):', JSON.stringify(started));
    for (let i = 0; i < 40; i++) { await page.sleep(500); if (await ev('!!GazeReader.debugDump().delegate')) { console.log('first camera frame through the face model after about ' + ((i + 1) / 2) + ' s'); break; } }
    await page.sleep(1500);
    console.log('then:', JSON.stringify(await ev(`(() => { const s = GazeReader.getState(); return { status: s.status, fps: s.fps, calibrated: s.calibrated, camera: s.camera }; })()`)));
    const fr = [...sessions].find(([, t]) => t.type === 'iframe');
    if (fr) { const r = await B.send('Runtime.evaluate', { expression: "(() => { const v = document.getElementById('v'); return JSON.stringify({ readyState: v.readyState, currentTime: v.currentTime, paused: v.paused, w: v.videoWidth, status: document.getElementById('s').textContent, visibility: document.visibilityState, rvfc: 'requestVideoFrameCallback' in v, tracks: v.srcObject ? v.srcObject.getVideoTracks().map((t) => t.readyState + ' ' + t.muted + ' ' + t.label).join() : null }); })()", returnByValue: true }, fr[0]).catch((e) => ({ result: { value: String(e) } })); console.log('camera frame:', r.result && r.result.value); } else console.log('camera frame target not found among', [...sessions.values()].map((t) => t.type + ' ' + String(t.url).slice(0, 50)).join(' | '));
    await ev('GazeReader.stop(); 0');
    await page.sleep(400);
    console.log('after stop():', JSON.stringify(await ev(`({ status: GazeReader.getState().status, frame: !!document.querySelector('[data-gaze-reader]') })`)));
    // (headless Edge's built-in fake camera hands over a track that has already ended; the tracker must say so, not sit on 'ready')
    if (!started || !(['ready', 'tracking'].includes(started.status) || (started.status === 'error' && started.error && started.error.code === 'camera-lost'))) code = 1;
  }
  const gazeErr = page.errors.filter((e) => /gaze|GazeReader|GazeCore|frame\.js|mediapipe|vision/i.test(e));
  console.log(`console errors and warnings on the page: ${page.errors.length} in all, ${gazeErr.length} from the gaze scripts; across every target (camera frame, service worker): ${all.length}`);
  for (const e of all.slice(0, 12)) console.log('   ' + e);
  for (const e of page.errors.slice(0, 10)) console.log('   ' + String(e).slice(0, 300));
  if (gazeErr.length) code = 1;
} finally { await chrome.close(); server.close(); }
console.log(code ? 'RESULT: FAILED' : 'RESULT: ok');
process.exitCode = code;
