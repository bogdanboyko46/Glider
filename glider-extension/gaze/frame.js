/*
 * frame.js — runs inside the extension-origin iframe the content script injects.
 * Owns the webcam + MediaPipe Face Landmarker and streams compact feature
 * vectors to the content script over a private MessagePort. No video or
 * images ever leave this frame.
 */
(() => {
  'use strict';
  const { FaceLandmarker, FilesetResolver } = self.Vision;
  const { extractFeatures } = self.GazeCore;
  const video = document.getElementById('v');
  const statusEl = document.getElementById('s');
  const dot = document.getElementById('dot');
  const nonce = location.hash.slice(1);
  let port = null, landmarker = null, stream = null, running = false, lastVideoTime = -1;
  let frames = 0, fpsT = performance.now(), fps = 0;

  const post = (msg) => port && port.postMessage(msg);
  const status = (state, detail = '') => {
    statusEl.textContent = detail || state;
    post({ type: 'status', state, detail });
  };

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (port || !d || d.type !== 'gr-init' || d.nonce !== nonce || !e.ports[0]) return;
    port = e.ports[0];
    port.onmessage = (ev) => {
      if (ev.data && ev.data.type === 'stop') stop();
    };
    boot().catch((err) => {
      console.error('[gaze] boot failed', err);
      status('error', String((err && err.message) || err).split('\n')[0].slice(0, 160));
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

  async function boot() {
    status('loading', 'opening camera…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' },
        audio: false,
      });
    } catch (err) {
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') return status('needs-permission', 'camera permission needed');
      if (name === 'NotFoundError' || name === 'OverconstrainedError') return status('error', 'no camera found');
      throw err;
    }
    video.srcObject = stream;
    await video.play();
    // What the camera actually delivered (it may ignore the ideal constraints).
    try {
      const track = stream.getVideoTracks()[0];
      const st = track.getSettings();
      post({ type: 'camera', settings: { width: st.width, height: st.height, frameRate: st.frameRate, deviceLabel: track.label, videoWidth: video.videoWidth, videoHeight: video.videoHeight } });
    } catch (_) { /* settings unavailable */ }
    status('loading', 'loading face model…');
    try { landmarker = await createLandmarker('GPU'); }
    catch (e) { console.warn('[gaze] GPU delegate failed, using CPU', e); landmarker = await createLandmarker('CPU'); }
    running = true;
    status('ready', 'tracking');
    schedule();
  }

  function schedule() {
    if (!running) return;
    if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(tick);
    else setTimeout(tick, 30);
  }

  function tick() {
    if (!running) return;
    try {
      if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        const res = landmarker.detectForVideo(video, performance.now());
        const lm = res.faceLandmarks && res.faceLandmarks[0];
        frames++;
        const now = performance.now();
        if (now - fpsT > 1000) { fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now; }
        if (!lm || lm.length < 478) {
          dot.className = 'off';
          post({ type: 'f', face: false, fps });
        } else {
          const blend = res.faceBlendshapes && res.faceBlendshapes[0] && res.faceBlendshapes[0].categories;
          const mat = res.facialTransformationMatrixes && res.facialTransformationMatrixes[0] && res.facialTransformationMatrixes[0].data;
          const { f, head, blink } = extractFeatures(lm, blend, mat, video.videoWidth, video.videoHeight);
          dot.className = blink ? 'warn' : 'on';
          post({ type: 'f', face: true, f, head, blink, fps });
        }
      }
    } catch (err) {
      console.error('[gaze] frame error', err);
    }
    schedule();
  }

  function stop() {
    running = false;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (landmarker) landmarker.close();
    status('stopped', 'stopped');
  }
  window.addEventListener('pagehide', stop);
})();
