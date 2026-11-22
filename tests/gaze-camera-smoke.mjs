// Smoke test of the REAL camera path: the unpacked extension in headless Edge, with the browser's
// fake camera device playing one still photo of a face. Everything between getUserMedia and the
// calibration card runs as it does on a laptop: gaze/frame.html, the packaged MediaPipe model and
// wasm, the MessagePort, gaze-reader.js inside the content-script world, the dock's "Adaptive" switch.
//
//   node tests/gaze-camera-smoke.mjs
//
// What it cannot show: accuracy. The photo's eyes never move, so the calibration ends in a clear
// failure or a poor result, and either is accepted here. A hang is not.
//
// The photo (fetched at run time, never stored in the repository, deleted afterwards):
//   NASA portrait of astronaut Ellen Ochoa, public domain (a work of the US federal government).
//   Page:   https://commons.wikimedia.org/wiki/File:Ellen_Ochoa.jpg
//   Second choice, same source and licence: https://commons.wikimedia.org/wiki/File:Mae_Carol_Jemison.jpg
//   The 960 px thumbnail is used (about 0.1 MB, limit 1 MB). The test asks the Commons API for the
//   file's licence on every run and uses it only when it says public domain or CC0.
// If no such picture can be fetched (no network), the test prints one SKIPPED line and exits 0.
//
// The picture is drawn into a 1280 x 720 frame by the browser itself and saved as a one-frame
// .mjpeg in the OS temp folder, which is what --use-file-for-fake-video-capture plays.
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, serve } from './cdp.mjs';

const PHOTOS = ['File:Ellen_Ochoa.jpg', 'File:Mae_Carol_Jemison.jpg'];
const UA = 'gaze-camera-smoke-test/1.0 (automated test)';
const CLIP = { w: 1280, h: 720 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const note = (text) => console.log(`      ${text}`);

/** A public-domain or CC0 face photo under 1 MB, or a reason why there is none. */
async function fetchPhoto() {
  let why = 'no candidate';
  for (const title of PHOTOS) {
    try {
      const api = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=640&iiextmetadatafilter=LicenseShortName|License|Copyrighted&format=json`;
      const meta = await (await fetch(api, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) })).json();
      const info = Object.values(meta.query.pages)[0].imageinfo[0], ext = info.extmetadata || {};
      const licence = String((ext.License && ext.License.value) || '').toLowerCase(), short = String((ext.LicenseShortName && ext.LicenseShortName.value) || '');
      if (!(licence === 'pd' || licence === 'cc0' || /^public domain$|^cc0/i.test(short))) { why = `${title}: licence is "${short || licence}", not public domain or CC0`; continue; }
      const res = await fetch(info.thumburl.split('?')[0], { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) { why = `${title}: HTTP ${res.status}`; continue; }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > 1024 * 1024 || bytes.length < 5000 || bytes[0] !== 0xff || bytes[1] !== 0xd8) { why = `${title}: not a JPEG under 1 MB (${bytes.length} bytes)`; continue; }
      return { bytes, title, licence: short || licence, page: info.descriptionurl };
    } catch (e) { why = `${title}: ${String((e && e.message) || e).slice(0, 120)}`; }
  }
  return { why };
}

const photo = await fetchPhoto();
if (!photo.bytes) { console.log(`SKIPPED  no freely licensed face photo could be fetched (${photo.why})`); process.exit(0); }
const clip = join(tmpdir(), `glider-camera-smoke-${process.pid}.mjpeg`);
if (/\s/.test(clip)) { console.log(`SKIPPED  the OS temp folder has a space in its path (${tmpdir()}), which the browser's fake-camera switch cannot take`); process.exit(0); }
note(`photo: ${photo.title}, ${photo.licence}, ${photo.bytes.length} bytes, ${photo.page}`);

const started = Date.now();
const { server, origin } = await serve();
const chrome = await launch({
  width: 1280, height: 720, extension: true,
  extraArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${clip}`],
});
const B = chrome.browser;

// ---- every target, from its first instruction: network, console, execution contexts
const sessions = new Map();     // sessionId -> { type, url, contexts: [] }
const requests = [];            // { url, type, session }
const consoleErrors = [];
const waiters = [];
// --use-fake-ui-for-media-stream allows every camera request, so "not allowed yet" has to be played: while
// denyCamera is set, a new gaze/frame.html gets a getUserMedia that rejects with NotAllowedError. Everything
// after that rejection is the extension's own code and pages.
let denyCamera = false;
const DENY = `if (location.protocol === 'chrome-extension:' && location.pathname === '/gaze/frame.html') navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));`;
// A slow GPU, played the same way: while slowGpu is set, a face model made with the GPU delegate takes 130 ms more
// for every picture (under 8 a second). The CPU model is left as it is. frame.js sees only the time the call takes.
let slowGpu = false;
const SLOW_GPU = `if (location.protocol === 'chrome-extension:' && location.pathname === '/gaze/frame.html') { let V; Object.defineProperty(self, 'Vision', { configurable: true, get() { return V; }, set(v) { V = v;
  const make = v.FaceLandmarker.createFromOptions.bind(v.FaceLandmarker);
  v.FaceLandmarker.createFromOptions = async (fileset, o) => { const lm = await make(fileset, o);
    if (o.baseOptions.delegate === 'GPU') { const detect = lm.detectForVideo.bind(lm); lm.detectForVideo = (...a) => { const t = performance.now(); while (performance.now() - t < 130) { /* busy */ } return detect(...a); }; }
    return lm; }; } }); }`;
const wake = () => { for (const w of waiters.splice(0)) w(); };
async function until(fn, ms, step = 100) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await Promise.race([sleep(step), new Promise((r) => waiters.push(r))]); } }

B.on('Target.attachedToTarget', (p) => {
  const sid = p.sessionId, info = p.targetInfo;
  sessions.set(sid, { type: info.type, url: info.url, targetId: info.targetId, contexts: [], gone: false });
  const quiet = (pr) => pr.catch(() => {});
  quiet(B.send('Network.enable', {}, sid));
  quiet(B.send('Runtime.enable', {}, sid));
  if (info.type === 'page' || info.type === 'iframe') quiet(B.send('Page.enable', {}, sid));
  // (first run only) the camera frame's getUserMedia answers as the browser does when the camera has not been allowed
  if (denyCamera && info.type === 'iframe') quiet(B.send('Page.addScriptToEvaluateOnNewDocument', { source: DENY }, sid));
  if (slowGpu && info.type === 'iframe') quiet(B.send('Page.addScriptToEvaluateOnNewDocument', { source: SLOW_GPU }, sid));
  quiet(B.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sid));
  quiet(B.send('Runtime.runIfWaitingForDebugger', {}, sid));
  wake();
});
B.on('Target.detachedFromTarget', (p) => { const s = sessions.get(p.sessionId); if (s) s.gone = true; wake(); });
B.on('Target.targetInfoChanged', (p) => { for (const s of sessions.values()) if (s.targetId === p.targetInfo.targetId) s.url = p.targetInfo.url; });
B.on('Network.requestWillBeSent', (p, sid) => { requests.push({ url: p.request.url, type: p.type, session: sid }); });
B.on('Runtime.executionContextCreated', (p, sid) => { const s = sessions.get(sid); if (s) { s.contexts.push(p.context); wake(); } });
B.on('Runtime.executionContextsCleared', (_p, sid) => { const s = sessions.get(sid); if (s) s.contexts = []; });
// MediaPipe's wasm writes its own progress lines to stderr, which the browser shows as console errors ("INFO: Created TensorFlow Lite XNNPACK delegate for CPU.").
const MEDIAPIPE_LOG = /^(INFO|WARNING|[IW]\d{4})\b|Created TensorFlow Lite|XNNPACK|gl_context|GL version|Graph successfully started|OpenGL error checking|face_landmarker_graph|inference_feedback_manager/;
const mediapipeLines = [];
B.on('Runtime.consoleAPICalled', (p, sid) => {
  const text = p.args.map((a) => a.value ?? a.description ?? '').join(' ');
  if (text.startsWith('[smoke]')) { smokeLog.push(text); wake(); return; }
  if (p.type !== 'error') return;
  if (MEDIAPIPE_LOG.test(text)) { mediapipeLines.push(text); return; }
  consoleErrors.push(`[${(sessions.get(sid) || {}).type}] ${text.slice(0, 300)}`);
});
B.on('Runtime.exceptionThrown', (p, sid) => { consoleErrors.push(`[${(sessions.get(sid) || {}).type}] uncaught: ${(p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text}`.slice(0, 400)); });
const smokeLog = [];

async function evalIn(sid, expression, contextId) {
  const r = await B.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true, ...(contextId ? { contextId } : {}) }, sid);
  if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
}
const key = async (sid, k, code) => {
  const base = { key: k, code, windowsVirtualKeyCode: k === ' ' ? 32 : 27 };
  await B.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base }, sid);
  await B.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sid);
};

let clipWritten = false;
try {
  await B.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  // ---- the page, and the camera clip drawn by the browser
  const { targetId } = await B.send('Target.createTarget', { url: 'about:blank' });
  const pageSid = await until(() => [...sessions].find(([, s]) => s.targetId === targetId)?.[0], 10000);
  if (!pageSid) throw new Error('the test page did not attach');
  const jpeg = await evalIn(pageSid, `(async () => {
    const img = new Image(); img.src = 'data:image/jpeg;base64,${photo.bytes.toString('base64')}'; await img.decode();
    const c = document.createElement('canvas'); c.width = ${CLIP.w}; c.height = ${CLIP.h};
    const g = c.getContext('2d'); g.fillStyle = '#8a8f96'; g.fillRect(0, 0, c.width, c.height);
    // the portrait 1700 px wide puts the face at about a fifth of the picture's width with the eyes near the middle: a normal seat at a laptop
    const w = 1700, h = w * img.naturalHeight / img.naturalWidth;
    g.drawImage(img, (c.width - w) / 2, 330 - 0.275 * h, w, h);
    return c.toDataURL('image/jpeg', 0.92).split(',')[1];
  })()`);
  const frame = Buffer.from(jpeg, 'base64');
  await writeFile(clip, Buffer.concat(Array.from({ length: 8 }, () => frame)));
  clipWritten = true;
  note(`camera clip: ${CLIP.w} x ${CLIP.h}, ${frame.length} bytes a frame, ${clip}`);

  await sleep(1500);   // let the extension's service worker register
  await B.send('Page.navigate', { url: `${origin}/tests/gaze-site/article.html` }, pageSid);
  // The content scripts' own world on the page; its origin is the extension's address. (The browser has
  // extensions of its own with service workers, so the first chrome-extension:// worker is not ours.)
  const world = await until(() => sessions.get(pageSid).contexts.find((c) => c.auxData && c.auxData.type === 'isolated' && c.name === 'Glider' && /^chrome-extension:\/\/[a-p]{32}$/.test(c.origin || '')), 20000);
  if (!world) throw new Error('the content scripts did not run on the test page: does this browser still take --load-extension?');
  const EXT = world.origin + '/';
  const ext = (expr) => evalIn(pageSid, expr, world.id);
  await until(() => ext(`typeof GazeReader === 'object' && !!(globalThis.Glider && Glider.app && Glider.app.ready)`).catch(() => false), 15000, 250);
  check('the unpacked extension runs on the page: GazeReader and the dock are there, the tracker is off', await ext(`typeof GazeReader === 'object' && typeof GazeCore === 'object' && GazeReader.getState().status === 'idle' && !!document.querySelector('#glider-root')`));

  await ext(`(() => {
    globalThis.__s = { status: [], camera: [], raw: [], rawN: 0, faces: 0, caldot: [], acc: [], t0: performance.now() };
    GazeReader.on('status', (s) => { if (__s.status[__s.status.length - 1] !== s.status) __s.status.push(s.status); });
    GazeReader.on('camera', (c) => __s.camera.push(JSON.parse(JSON.stringify(c))));
    GazeReader.on('raw', (r) => { __s.rawN++; if (r.face) __s.faces++; if (__s.raw.length < 60) __s.raw.push({ face: r.face, blink: r.blink, n: r.f ? r.f.length : 0, finite: !!r.f && r.f.every(Number.isFinite), head: r.head, fps: r.fps, pose: r.f ? GazeCore.poseOf(r.f) : null }); });
    GazeReader.on('caldot', (d) => __s.caldot.push({ seg: d.seg, frames: d.frames }));
    GazeReader.on('accuracy', (a) => __s.acc.push(JSON.parse(JSON.stringify(a))));
    return 0; })()`);

  // ---- first run: the camera is not allowed yet. The reader must say so, and go on by itself once
  // gaze/permission.html has been given the camera (no reload, no second flip of the switch).
  const state = () => ext(`(() => { const s = GazeReader.getState(); return { status: s.status, error: s.error }; })()`);
  const settled = (ms) => until(async () => { const s = await state(); return s.status !== 'starting' && s.status !== 'idle' ? s : null; }, ms, 250);
  denyCamera = true;
  await ext(`Glider.app.update({ on: true, gaze: true }); 0`);   // the dock's Adaptive switch, as a reader flips it
  {
    const blocked = await settled(45000);
    denyCamera = false;
    if (blocked && blocked.status === 'needs-permission') {
      check('camera not allowed yet (played at getUserMedia): the tracker says so and waits, it does not hang', ['camera-blocked', 'camera-permission'].includes(blocked.error && blocked.error.code), `needs-permission, ${blocked.error && blocked.error.code}: "${blocked.error && blocked.error.text}"`);
      const { targetId: permId } = await B.send('Target.createTarget', { url: EXT + 'gaze/permission.html' });
      const permSid = await until(() => [...sessions].find(([, s]) => s.targetId === permId)?.[0], 10000);
      await until(() => evalIn(permSid, `!!document.getElementById('go')`).catch(() => false), 10000);
      await evalIn(permSid, `document.getElementById('go').click(); 0`);
      const said = await until(() => evalIn(permSid, `document.getElementById('msg').textContent`).catch(() => ''), 15000);
      const again = await until(async () => { const s = await state(); return ['ready', 'tracking', 'error'].includes(s.status) ? s : null; }, 45000, 250);
      check('camera allowed on the permission page: the tracker starts by itself on the page that was waiting', /Camera enabled/.test(said || '') && !!again && ['ready', 'tracking'].includes(again.status), `permission page: "${said}"; tracker: ${again ? again.status : 'no change'}`);
      await B.send('Target.closeTarget', { targetId: permId }).catch(() => {});
    } else check('camera not allowed yet (played at getUserMedia): the tracker says so and waits, it does not hang', false, `the refusal did not reach the camera frame: status ${blocked && blocked.status}`);
  }
  const tStart = Date.now();
  const first = await until(() => ext(`(() => { const s = GazeReader.getState(); return s.status !== 'starting' && s.status !== 'idle' ? { status: s.status, error: s.error } : null; })()`), 45000, 250);
  check("the Adaptive switch starts the tracker and the status leaves 'starting'", !!first && ['ready', 'tracking'].includes(first.status), first ? `${first.status}${first.error ? ' (' + first.error.code + ': ' + first.error.detail + ')' : ''}` : "still 'starting' after 45 s");
  if (!first || !['ready', 'tracking'].includes(first.status)) throw new Error('the tracker did not start: ' + JSON.stringify(first));

  const frameSession = () => [...sessions].find(([, s]) => s.type === 'iframe' && !s.gone && s.url.startsWith(EXT + 'gaze/frame.html'));
  const fs0 = await until(frameSession, 5000);
  const cam0 = await until(() => ext(`__s.camera.length ? __s.camera[0] : null`), 5000);
  check('the camera opened from the fake device and reports the clip resolution', !!cam0 && cam0.settings && cam0.settings.width === CLIP.w && cam0.settings.height === CLIP.h && cam0.settings.videoWidth === CLIP.w, JSON.stringify(cam0 && cam0.settings));

  const model = (re) => requests.filter((r) => re.test(r.url));
  const task = model(/face_landmarker\.task$/), wasm = model(/vision_wasm_internal\.wasm$/), loader = model(/vision_wasm_internal\.js$/);
  check('the face model and the wasm loaded from files packaged in the extension', task.length >= 1 && wasm.length >= 1 && loader.length >= 1 && [...task, ...wasm, ...loader].every((r) => r.url.startsWith(EXT + 'gaze/vendor/')),
    [...task, ...wasm, ...loader].map((r) => r.url.replace(EXT, 'chrome-extension://<id>/')).filter((u, i, a) => a.indexOf(u) === i).join(', '));

  const raw = await until(() => ext(`__s.raw.length >= 45 ? __s.raw : null`), 30000, 250);
  const faces = (raw || []).filter((r) => r.face);
  check('raw frames arrive with face:true and at least 44 finite numbers', !!raw && faces.length >= 30 && faces.every((r) => r.n >= 44 && r.finite && r.head && Number.isFinite(r.head.cx) && Number.isFinite(r.head.s)),
    raw ? `${faces.length} of ${raw.length} frames with a face, ${faces[0] ? faces[0].n : 0} numbers each, head ${JSON.stringify(faces[0] && faces[0].head)}` : `only ${await ext('__s.rawN')} frames in 30 s`);

  // (sign-off) The head-aware model reads MediaPipe's face matrix as column-major, in cm, with the camera looking along -z.
  // poseFromMatrix refuses anything else (a row-major matrix has its translation where zeros must be), so a pose on every
  // real frame, with the face in front of the camera and roughly upright, is that convention seen on the real model.
  const posed = faces.filter((r) => r.pose), R2D = 180 / Math.PI, p0 = posed[0];
  check('the real face matrix is read as a head pose on every face frame: in front of the camera along -z, roughly upright',
    faces.length >= 30 && posed.length === faces.length && posed.every((r) => r.pose.tz < -15 && r.pose.tz > -150 && Math.abs(r.pose.tx) < -r.pose.tz && Math.abs(r.pose.ty) < -r.pose.tz && Math.abs(r.pose.yaw) * R2D < 35 && Math.abs(r.pose.pitch) * R2D < 35 && Math.abs(r.pose.roll) * R2D < 35),
    p0 ? `${posed.length} of ${faces.length} frames with a pose; first: tz ${p0.pose.tz.toFixed(1)} cm, tx ${p0.pose.tx.toFixed(1)}, ty ${p0.pose.ty.toFixed(1)}, yaw ${(p0.pose.yaw * R2D).toFixed(1)}, pitch ${(p0.pose.pitch * R2D).toFixed(1)}, roll ${(p0.pose.roll * R2D).toFixed(1)} degrees; eye distance ${(100 * p0.head.s).toFixed(1)} % of the picture width` : 'no frame with a pose');

  // the delegate trial needs 30 frames (and 30 more when the GPU was slow and the CPU is tried)
  const perf = await until(() => ext(`GazeReader.debugDump().perf`), 30000, 250);
  const camNow = await ext(`GazeReader.getState().camera`);
  const dump0 = await ext(`(() => { const d = GazeReader.debugDump(); return { timeSource: d.timeSource, delegate: d.delegate, quality: d.quality, face: d.face, fps: d.state.fps }; })()`);
  check('the camera status reports the delegate and the frame rate', !!perf && ['GPU', 'CPU'].includes(perf.delegate) && perf.modelFps > 0 && !!camNow && camNow.delegate === perf.delegate && camNow.fps > 0,
    `${JSON.stringify(camNow)}; tried ${JSON.stringify(perf && perf.tried)}; frame times from '${dump0.timeSource}'; face ${JSON.stringify(dump0.face)}; quality warnings [${dump0.quality}]`);

  // ---- calibration: it has to end. With a photo the eyes never move, so a failure or a poor result is the honest outcome.
  await ext(`globalThis.__cal = null; GazeReader.calibrate({ baseline: false }).then((a) => { __cal = { ok: true, acc: a }; }, (e) => { __cal = { ok: false, error: String((e && e.message) || e) }; }); 0`);
  const deadline = Date.now() + 150000;
  let pressed = 0, escaped = 0, cal = null, lastDots = -1, dotsAt = Date.now();
  for (;;) {
    const st = await ext(`({ cal: __cal, dots: __s.caldot.length, acc: __s.acc.length, status: GazeReader.getState().status })`);
    if (st.cal) { cal = st.cal; break; }
    if (Date.now() > deadline) break;
    if (st.dots !== lastDots) { lastDots = st.dots; dotsAt = Date.now(); }
    // Space on the first card until the dots begin, and again when no dot has finished for 4 s (the card before the head
    // segment waits for it); once the result card is up, Esc leaves it (Space on a "poor" card would calibrate again)
    if (st.acc > escaped && Date.now() - pressed > 800) { await key(pageSid, 'Escape', 'Escape'); escaped = st.acc; pressed = Date.now(); }
    else if (!st.acc && (!st.dots || Date.now() - dotsAt > 4000) && Date.now() - pressed > 1200) { await key(pageSid, ' ', 'Space'); pressed = Date.now(); }
    await sleep(250);
  }
  const after = await ext(`({ status: GazeReader.getState().status, dots: __s.caldot.length, check: __s.caldot.filter((d) => d.seg === 'check').length, acc: __s.acc[0] || null })`);
  const v = cal && cal.ok && cal.acc && cal.acc.validation;
  check('the calibration ran to an end state (a clear failure or a poor result is fine with a photo; a hang is not)',
    !!cal && (cal.ok ? !!v && typeof v.grade === 'string' && after.status === 'tracking' : typeof cal.error === 'string' && cal.error.length > 5 && ['ready', 'tracking', 'paused'].includes(after.status)),
    cal ? (cal.ok ? `finished: "${v && v.message}" (${v && v.errPx} px); ${after.dots} dots, ${after.check} of them check dots; status ${after.status}` : `clear failure: "${cal.error}"; ${after.dots} dots shown; status ${after.status}`) : `no end after 150 s: ${JSON.stringify(after)}`);

  // ---- the MediaPipe bundle's usage logger posts to a Google address once a minute: the camera frame must refuse it
  await until(() => Date.now() - tStart > 66000, 70000, 500);
  const refused = await until(() => ext(`GazeReader.debugDump().blockedRequests`), 8000, 500);
  check("MediaPipe's usage logger tried to send and the camera frame refused it", refused >= 1, `${refused || 0} network call(s) refused in the camera frame, ${Math.round((Date.now() - tStart) / 1000)} s after the start`);

  // ---- stop releases the camera
  const fs1 = frameSession();
  let hooked = null;
  if (fs1) {
    hooked = await evalIn(fs1[0], `(() => { const v = document.getElementById('v'), tr = v.srcObject ? v.srcObject.getTracks() : []; for (const t of tr) { const stop = t.stop.bind(t); t.stop = () => { stop(); console.log('[smoke] track ' + t.readyState); }; } return tr.map((t) => t.readyState).join(); })()`).catch((e) => 'error: ' + e.message);
  }
  await ext(`Glider.app.update({ gaze: false }); 0`);
  const ended = await until(() => smokeLog.includes('[smoke] track ended'), 4000);
  const gone = await until(() => !frameSession(), 5000);
  const idle = await ext(`({ status: GazeReader.getState().status, widget: !!document.querySelector('[data-gaze-reader]') })`);
  check('switching Adaptive off stops the camera track and removes the camera frame', hooked === 'live' && idle.status === 'idle' && !idle.widget && !!gone && !!ended,
    `track before: ${hooked}; ${ended ? 'the frame stopped its track (readyState ended)' : 'no stop seen from the frame'}; camera frame ${gone ? 'gone' : 'still there'}; status ${idle.status}`);

  // ---- a slow GPU: the camera frame tries the CPU once and keeps the faster of the two
  slowGpu = true;
  await ext(`__s.rawN = 0; __s.faces = 0; Glider.app.update({ gaze: true }); 0`);
  const perf2 = await until(async () => { const p = await ext(`GazeReader.debugDump().perf`).catch(() => null); return p && p.tried && p.tried.length >= 2 ? p : null; }, 90000, 300);
  slowGpu = false;
  await sleep(1500);
  const run2 = await ext(`({ status: GazeReader.getState().status, camera: GazeReader.getState().camera, rawN: __s.rawN, faces: __s.faces })`);
  const [gpu, cpu] = perf2 ? perf2.tried : [];
  check('a GPU under 10 pictures a second (played): the camera frame tries the CPU once, keeps the faster one and goes on tracking',
    !!perf2 && gpu.delegate === 'GPU' && gpu.modelFps < 10 && cpu.delegate === 'CPU' && cpu.modelFps > gpu.modelFps && perf2.delegate === 'CPU' && perf2.tried.length === 2 && run2.camera && run2.camera.delegate === 'CPU' && ['ready', 'tracking'].includes(run2.status) && run2.faces > 30,
    perf2 ? `GPU ${gpu.modelFps} a second, CPU ${cpu.modelFps} a second, kept ${perf2.delegate}; status ${run2.status}, ${run2.faces} frames with a face` : `no second delegate was tried: ${JSON.stringify(run2)}`);
  await ext(`Glider.app.update({ gaze: false }); 0`);
  await until(() => !frameSession(), 5000);

  // ---- nothing left the extension
  await sleep(500);
  const allowed = (u) => u.startsWith(EXT) || u.startsWith(origin + '/') || /^(data|blob|about|chrome-extension|chrome|edge|devtools):/.test(u);
  const outside = requests.filter((r) => !allowed(r.url));
  const fromExt = requests.filter((r) => r.url.startsWith(EXT)).length;
  check('zero network requests leave the extension origin (the test page itself is served from this computer)', outside.length === 0 && fromExt > 5,
    outside.length ? outside.slice(0, 5).map((r) => r.url.slice(0, 120)).join(' | ') : `${requests.length} requests seen across ${sessions.size} targets: ${fromExt} to the extension's own files, ${requests.filter((r) => r.url.startsWith(origin + '/')).length} to the test page's server on this computer, ${requests.filter((r) => /^(data|blob):/.test(r.url)).length} data: or blob: addresses, ${requests.filter((r) => !r.url.startsWith(EXT) && /^(about|chrome-extension|chrome|edge|devtools):/.test(r.url)).length} inside the browser itself (its own pages and built-in extensions), 0 to the network`);
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' || ') || (mediapipeLines.length ? `(${mediapipeLines.length} progress lines that MediaPipe writes to stderr were not counted: ${[...new Set(mediapipeLines.map((l) => '"' + l.slice(0, 70) + '"'))].slice(0, 3).join(', ')})` : ''));
} catch (error) {
  check('test run completed', false, error.stack || String(error));
} finally {
  await chrome.close();
  server.close();
  if (clipWritten) await rm(clip, { force: true }).catch(() => {});
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${((Date.now() - started) / 1000).toFixed(1)} s; temp clip deleted`);
process.exit(failed.length ? 1 : 0);
