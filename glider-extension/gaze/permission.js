// Granting the camera here gives the permission to the extension's own origin,
// so the tracking iframe can use the camera on every site without re-prompting.
document.getElementById('go').addEventListener('click', async () => {
  const msg = document.getElementById('msg');
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true });
    s.getTracks().forEach((t) => t.stop());
    msg.className = 'ok';
    msg.textContent = 'Camera enabled. You can close this tab: eye tracking starts by itself on the page you were reading.';
    // Tell the pages that are waiting. The time, not just `true`, so that the change is seen every
    // time (a storage change fires only when the value changes). gaze-reader.js listens for this
    // key on every page and starts the camera again.
    chrome.storage.local.set({ grCameraGranted: Date.now() });
  } catch (e) {
    const name = e && e.name;
    msg.className = 'bad';
    msg.textContent = name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No camera was found. Plug one in or switch it on, then try again.'
      : name === 'NotReadableError' || name === 'AbortError' ? 'The camera is being used by another app. Close it, then try again.'
        : 'Camera was blocked (' + name + '). Click the camera icon in the address bar to allow it, then try again.';
  }
});
