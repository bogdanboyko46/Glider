/*
 * frame.js — runs inside the extension-origin iframe the content script injects.
 * Owns the webcam + MediaPipe Face Landmarker and streams compact feature
 * vectors to the content script over a private MessagePort. No video or
 * images ever leave this frame. Everything it loads (the face model, the wasm)
 * comes from the extension's own package: nothing is fetched from the network.
 *
 * Messages to the content script:
 *   {type:'status', state, detail, code?}   state: loading | ready | needs-permission | error | stopped
 *       code (with needs-permission and error) says which problem it is:
 *       camera-permission  not allowed yet (the permission page asks for it)
 *       camera-blocked     the user or a policy has blocked the camera for this extension
 *       camera-in-use      another program holds the camera
 *       no-camera          no camera is plugged in or switched on
 *       camera-timeout     the camera did not answer within LOAD_TIMEOUT_MS
 *       camera-lost        the camera was open and then stopped by itself (unplugged, taken by the system)
 *       model-load         the face model or its wasm could not be loaded (detail has the reason)
 *       model-timeout      ... or did not finish loading within LOAD_TIMEOUT_MS
 *   {type:'camera', settings}                what the camera delivers
 *   {type:'perf', delegate, modelFps, tried} which delegate runs the face model and how fast (see chooseDelegate)
 *   {type:'f', ...}                          one per camera frame
 */
(() => {
  'use strict';
  /* No network from this frame. The vendored MediaPipe bundle (vendor/vision_bundle.js) contains a
     usage logger that POSTs to https://odml.pa.googleapis.com/v1/log once a minute and when a
     landmarker is closed (found by tests/gaze-camera-smoke.mjs). It sends no picture, but Glider says
     it runs entirely on this device, so every way out is shut here, before MediaPipe is used: only
     this extension's own files (and blob: / data: addresses) may be fetched. The logger takes the
     refusal as a failed send and switches itself off. frame.html carries a connect-src policy as the
     second lock. `blocked` counts the refusals; the reader's debugDump().perf shows it. */
  let blocked = 0;
  const own = (u) => { try { const x = new URL(String((u && u.url) || u), location.href); return x.origin === location.origin || x.protocol === 'blob:' || x.protocol === 'data:'; } catch (_) { return false; } };
  const refuse = () => { blocked++; try { if (port) port.postMessage({ type: 'blocked', n: blocked }); } catch (_) { /* no port yet */ } return new TypeError('network access is switched off in the camera frame'); };
  const realFetch = self.fetch.bind(self), realOpen = XMLHttpRequest.prototype.open, realBeacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
  self.fetch = (input, init) => (own(input) ? realFetch(input, init) : Promise.reject(refuse()));
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { if (!own(url)) throw refuse(); return realOpen.call(this, method, url, ...rest); };
  if (realBeacon) navigator.sendBeacon = (url, data) => (own(url) ? realBeacon(url, data) : (refuse(), false));
  for (const name of ['WebSocket', 'EventSource', 'WebTransport', 'RTCPeerConnection']) { try { if (name in self) self[name] = function () { throw refuse(); }; } catch (_) { /* not replaceable here */ } }

  const { FaceLandmarker, FilesetResolver } = self.Vision;
  const { extractFeatures } = self.GazeCore;
  const video = document.getElementById('v');
  const statusEl = document.getElementById('s');
  const dot = document.getElementById('dot');
  const nonce = location.hash.slice(1);
  const LOAD_TIMEOUT_MS = 20000;
  // Lab only (GazeReader.init({ labLandmarks: true }) -> gr-init): also send a small subset of the face landmarks.
  const LAB_LANDMARKS = [33, 133, 159, 145, 362, 263, 386, 374, 468, 469, 470, 471, 472, 473, 474, 475, 476, 477, 168, 1, 234, 454, 10, 152];
  let port = null, landmarker = null, stream = null, running = false, lastVideoTime = -1, labLandmarks = false;
  let delegate = null;   // 'GPU' or 'CPU': which one the face model ended up running on
  let frames = 0, fpsT = performance.now(), fps = 0;

  const post = (msg) => port && port.postMessage(msg);
  const status = (state, detail = '', code) => {
    statusEl.textContent = detail || state;
    post(code ? { type: 'status', state, detail, code } : { type: 'status', state, detail });
  };
  const reason = (err) => String((err && err.message) || err).split('\n')[0].slice(0, 160);
  /** Rejects with an error carrying `code` when `promise` has not settled after LOAD_TIMEOUT_MS. */
  function withTimeout(promise, code, what) {
    let timer;
    const late = new Promise((_, fail) => { timer = setTimeout(() => fail(Object.assign(new Error(what + ' did not answer within ' + LOAD_TIMEOUT_MS / 1000 + ' seconds'), { code })), LOAD_TIMEOUT_MS); });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (port || !d || d.type !== 'gr-init' || d.nonce !== nonce || !e.ports[0]) return;
    port = e.ports[0];
    labLandmarks = !!d.labLandmarks;
    port.onmessage = (ev) => {
      if (ev.data && ev.data.type === 'stop') stop();
    };
    boot().catch((err) => {
      console.warn('[gaze] could not start:', reason(err));
      release();
      status('error', reason(err), (err && err.code) || 'model-load');
    });
  });

  async function createLandmarker(delegate) {
    const fileset = await FilesetResolver.forVisionTasks(chrome.runtime.getURL('gaze/vendor/wasm'));
    return FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: chrome.runtime.getURL('gaze/vendor/face_landmarker.task'), delegate },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
  }

  /** Why the camera could not be opened, as a status the reader can put into words. */
  async function cameraProblem(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      let state = 'prompt';
      try { state = (await navigator.permissions.query({ name: 'camera' })).state; } catch (_) { /* cannot ask: treat as not allowed yet */ }
      return state === 'denied' ? ['needs-permission', 'camera blocked', 'camera-blocked'] : ['needs-permission', 'camera permission needed', 'camera-permission'];
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return ['error', 'no camera found', 'no-camera'];
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return ['error', 'camera in use by another app', 'camera-in-use'];
    if (err && err.code === 'camera-timeout') return ['error', reason(err), 'camera-timeout'];
    return null;
  }

  async function boot() {
    status('loading', 'opening camera…');
    let asked = null;
    try {
      asked = navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' },
        audio: false,
      });
      stream = await withTimeout(asked, 'camera-timeout', 'the camera');
      video.srcObject = stream;
      await withTimeout(video.play(), 'camera-timeout', 'the camera');
    } catch (err) {
      // The timeout only stops the waiting. A camera (or a permission prompt) that answers after it would
      // hand over a live stream nobody holds: the camera light on under "the camera did not answer".
      // Whatever arrives late is stopped at once. (A stream that came in time is in `stream`; release() stops it.)
      if (asked) asked.then((late) => { if (late && late !== stream) late.getTracks().forEach((t) => t.stop()); }, () => { /* it failed after all */ });
      const p = await cameraProblem(err);
      release();
      if (!p) throw Object.assign(new Error('camera: ' + reason(err)), { code: 'camera-error' });
      return status(...p);
    }
    // A camera that stops by itself (unplugged, taken away by the system, the laptop slept) sends no more
    // pictures and no error either: without this the reader would sit on 'tracking' with nothing coming.
    // (Stopping the track ourselves, in release(), does not fire 'ended'.)
    const live = stream.getVideoTracks()[0];
    const lost = () => {
      if (!stream || stream.getVideoTracks()[0] !== live) return;
      running = false;
      release();
      closeLandmarkers();
      status('error', 'the camera stopped', 'camera-lost');
    };
    if (live) {
      live.addEventListener('ended', lost);
      if (live.readyState === 'ended') { lost(); return; }   // it stopped before anybody was listening
    }
    // What the camera actually delivered (it may ignore the ideal constraints).
    try {
      const track = stream.getVideoTracks()[0];
      const st = track.getSettings();
      post({ type: 'camera', settings: { width: st.width, height: st.height, frameRate: st.frameRate, deviceLabel: track.label, videoWidth: video.videoWidth, videoHeight: video.videoHeight } });
    } catch (_) { /* settings unavailable */ }
    status('loading', 'loading face model…');
    try { landmarker = await withTimeout(createLandmarker('GPU'), 'model-timeout', 'the face model'); delegate = 'GPU'; }
    catch (e) {
      console.warn('[gaze] GPU delegate failed, using CPU:', reason(e));
      status('loading', 'loading face model (CPU)…');
      try { landmarker = await withTimeout(createLandmarker('CPU'), 'model-timeout', 'the face model'); delegate = 'CPU'; perf.tried.push({ delegate: 'GPU', error: reason(e) }); perf.cpuTried = true; }
      catch (e2) { throw Object.assign(new Error(reason(e2)), { code: e2.code || 'model-load' }); }
    }
    if (!stream) { closeLandmarkers(); return; }   // stopped while the model was loading
    running = true;
    frames = 0; fpsT = performance.now();   // the frame rate is counted from here, not from when the page loaded (the model's loading time is not a slow camera)
    status('ready', 'tracking');
    schedule();
  }

  function schedule() {
    if (!running) return;
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(tick);
    else setTimeout(tick, 30);
    if (!watchdog) watchdog = setInterval(watch, 40);
  }
  /* requestVideoFrameCallback only fires for frames the browser actually shows. When the camera picture is covered
     (the calibration screen lies over the widget) Chrome stops showing it and the callbacks fall to about one a
     second: seen on a real camera, the calibration starved. So a timer looks at the video as well and runs the
     model on any new picture the callback has not delivered within 80 ms. */
  let watchdog = null, lastRun = 0, viaTimer = 0;
  function watch() {
    if (!running) { clearInterval(watchdog); watchdog = null; return; }
    if (performance.now() - lastRun > 80) { viaTimer++; work(performance.now(), null); }
  }

  /* When the camera took the frame, on this frame's performance.now() clock. requestVideoFrameCallback
     reports it as metadata.captureTime for a local camera; a value that is missing, in the future or
     more than half a second old is not believed, and the time just before the face model ran is used
     (which still leaves the model's own run time out of the timestamp). */
  function captureTime(meta, before) {
    const c = meta && meta.captureTime;
    if (typeof c === 'number' && Number.isFinite(c) && c <= before + 1 && before - c < 500) return { tc: Math.min(c, before), tsrc: 'capture' };
    return { tc: before, tsrc: 'now' };
  }

  /* GPU or CPU. The face model starts on the GPU. Its speed is the time one detectForVideo call takes,
     averaged over the first PERF_FRAMES frames without the first PERF_WARMUP (shader compilation). If
     that comes to under PERF_MIN_FPS frames a second, a CPU landmarker is made once, timed the same
     way, and the faster of the two is kept; the other is closed. Timing the call, not counting camera
     frames, keeps a camera that is slow in a dark room from being mistaken for a slow GPU. */
  const PERF_FRAMES = 30, PERF_WARMUP = 5, PERF_MIN_FPS = 10;
  const perf = { n: 0, sum: 0, tried: [], cpuTried: false, decided: false, spare: null, switching: false };
  function measure(ms) {
    if (perf.decided || perf.switching) return;
    perf.n++;
    if (perf.n > PERF_WARMUP) perf.sum += ms;
    if (perf.n < PERF_FRAMES) return;
    const modelFps = Math.round(10 * 1000 / Math.max(0.1, perf.sum / (PERF_FRAMES - PERF_WARMUP))) / 10;
    perf.tried.push({ delegate, modelFps });
    perf.n = 0; perf.sum = 0;
    if (delegate === 'GPU' && !perf.cpuTried && modelFps < PERF_MIN_FPS) {
      perf.cpuTried = true; perf.switching = true;
      createLandmarker('CPU').then((cpu) => {
        if (!running) { cpu.close(); return; }
        perf.spare = landmarker; landmarker = cpu; delegate = 'CPU'; perf.switching = false;
      }).catch((e) => { console.warn('[gaze] CPU delegate failed, staying on GPU:', reason(e)); perf.tried.push({ delegate: 'CPU', error: reason(e) }); perf.switching = false; finish(); });
      return;
    }
    if (delegate === 'CPU' && perf.spare) {
      const gpu = perf.tried.find((t) => t.delegate === 'GPU' && t.modelFps);
      // (the CPU has to be really faster to be kept: equal speeds stay on the GPU)
      if (gpu && gpu.modelFps >= modelFps) { landmarker.close(); landmarker = perf.spare; delegate = 'GPU'; } else perf.spare.close();
      perf.spare = null;
    }
    finish();
  }
  function finish() {
    perf.decided = true;
    const mine = perf.tried.filter((t) => t.delegate === delegate && t.modelFps).pop();
    post({ type: 'perf', delegate, modelFps: mine ? mine.modelFps : null, tried: perf.tried, blocked });
  }

  function tick(now, meta) { work(now, meta); schedule(); }
  function work(_now, meta) {
    if (!running) return;
    try {
      if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const before = performance.now();
        lastRun = before;
        const { tc, tsrc } = captureTime(meta, before);
        const res = landmarker.detectForVideo(video, before);
        const lm = res.faceLandmarks && res.faceLandmarks[0];
        frames++;
        const now = performance.now();
        measure(now - before);
        if (now - fpsT > 1000) { fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now; }
        if (!lm || lm.length < 478) {
          dot.className = 'off';
          post({ type: 'f', face: false, fps, tc, ts: performance.now(), tsrc, delegate });
        } else {
          const blend = res.faceBlendshapes && res.faceBlendshapes[0] && res.faceBlendshapes[0].categories;
          const mat = res.facialTransformationMatrixes && res.facialTransformationMatrixes[0] && res.facialTransformationMatrixes[0].data;
          const { f, head, blink, lids } = extractFeatures(lm, blend, mat, video.videoWidth, video.videoHeight);
          dot.className = blink ? 'warn' : 'on';
          // tc: capture time, ts: send time, both on this frame's clock. The reader takes ts - tc (the
          // frame's age) off its own clock at arrival, since the two documents do not share a time origin.
          // lids: the two blink scores and the lid opening behind `blink`; the reader decides about blinks with them (BlinkDetector).
          // fw: the face's width as a share of the picture's (cheek to cheek), for the quality gate.
          const msg = { type: 'f', face: true, f, head, blink, lids, fw: Math.abs(lm[454].x - lm[234].x), fps, tc, ts: performance.now(), tsrc, delegate, viaTimer };
          if (labLandmarks) msg.lmk = LAB_LANDMARKS.map((i) => [Math.round(lm[i].x * 1e5) / 1e5, Math.round(lm[i].y * 1e5) / 1e5, Math.round(lm[i].z * 1e5) / 1e5]);
          post(msg);
        }
      }
    } catch (err) {
      console.error('[gaze] frame error', err);
    }
  }

  function closeLandmarkers() {
    for (const l of [landmarker, perf.spare]) { try { if (l) l.close(); } catch (_) { /* already closed */ } }
    landmarker = null; perf.spare = null;
  }
  /** Let go of the camera. */
  function release() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    try { video.srcObject = null; } catch (_) { /* gone */ }
  }
  function stop() {
    running = false;
    release();
    closeLandmarkers();
    status('stopped', 'stopped');
  }
  window.addEventListener('pagehide', stop);
})();
