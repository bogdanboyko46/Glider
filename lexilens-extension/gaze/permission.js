// Granting the camera here gives the permission to the extension's own origin,
// so the tracking iframe can use the camera on every site without re-prompting.
document.getElementById('go').addEventListener('click', async () => {
  const msg = document.getElementById('msg');
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true });
    s.getTracks().forEach((t) => t.stop());
    msg.className = 'ok';
    msg.textContent = 'Camera enabled. You can close this tab and reload the page you were reading.';
    chrome.storage.local.set({ grCameraGranted: true });
  } catch (e) {
    msg.className = 'bad';
    msg.textContent = 'Camera was blocked (' + e.name + '). Click the camera icon in the address bar to allow it, then try again.';
  }
});
