// One still frame of a showcase scene, or a whole recording.
//   node showcase/shot.mjs showcase/s1-lens.html 3200 out.png      one frame at 3200 ms
//   node showcase/shot.mjs showcase/s1-lens.html all outDir [fps]  every frame as PNG (default 15 fps)
// Scenes are pure CSS animations: every animation is paused and seeked, so frames are exact.
// Memory is tight on this machine: this refuses to start while another test browser is running.
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { launch, serve, REPO } from '../tests/cdp.mjs';

const [file, when, out, fpsArg] = process.argv.slice(2);
if (!file || !when || !out) { console.error('usage: node showcase/shot.mjs <scene.html> <ms|all> <out.png|outDir> [fps]'); process.exit(2); }
try {
  const n = execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe' OR Name='msedge.exe'\\" | Where-Object { $_.CommandLine -match 'glider-chrome|lexilens-chrome' } | Measure-Object).Count"`, { encoding: 'utf8' }).trim();
  if (Number(n) > 0) { console.error('BUSY: another test browser is running; wait a few seconds and retry.'); process.exit(3); }
} catch (_) { /* cannot check: carry on */ }

const { server, origin } = await serve();
const chrome = await launch({ width: 1280, height: 720 });
try {
  const page = await chrome.page();
  const rel = relative(REPO, resolve(file)).replace(/\\/g, '/');
  await page.goto(`${origin}/${rel}${process.env.SHOT_HASH || ""}`, 1200);
  await page.eval(`document.fonts.ready.then(() => 1)`);
  const duration = Number(await page.eval(`document.documentElement.dataset.duration || 8000`));
  // SHOT_SCALE=1.5 records the 1280 x 720 scene at 1920 x 1080 (sharp text for a big screen)
  const scale = Number(process.env.SHOT_SCALE) || 1, clip = scale === 1 ? undefined : { x: 0, y: 0, width: 1280, height: 720, scale };
  const seek = (t) => page.eval(`(() => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = ${t}; } return 1; })()`);
  if (when === 'all') {
    const fps = Number(fpsArg) || 15;
    mkdirSync(out, { recursive: true });
    const frames = Math.round((duration / 1000) * fps);
    for (let i = 0; i <= frames; i++) { await seek((i * 1000) / fps); await page.shot(join(out, `f${String(i).padStart(4, '0')}.png`), clip); }
    console.log(`frames ${frames + 1} duration ${duration} fps ${fps} errors ${JSON.stringify(page.errors)}`);
  } else {
    await seek(Number(when));
    await page.shot(resolve(out), clip);
    console.log(`shot at ${when} ms of ${duration}; errors ${JSON.stringify(page.errors)}`);
  }
} finally { await chrome.close(); server.close(); }
