// Read-aloud check with the browser's REAL speech engine (audio muted).
// Confirms that word highlighting advances with the voice.
//   node tests/tts.mjs
import { launch, serve, IN_PAGE } from './cdp.mjs';

const { server, origin } = await serve();
const chrome = await launch({ width: 1280, height: 800 });
let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };

try {
  const page = await chrome.page();
  await page.goto(`${origin}/demo/sample-assignment.html?harness`, 1500);
  await page.eval('localStorage.clear()');
  await page.goto(`${origin}/demo/sample-assignment.html?harness`, 1500);
  await page.eval(IN_PAGE);

  const voices = await page.eval(`speechSynthesis.getVoices().map((v) => v.name + (v.localService ? ' (local)' : ' (remote)'))`);
  console.log('voices:', voices.join(', ') || 'none');

  // Count real boundary events by wrapping speak().
  await page.eval(`(() => { window.__b = 0; const speak = speechSynthesis.speak.bind(speechSynthesis);
    speechSynthesis.speak = (u) => { const orig = u.onboundary; u.onboundary = (e) => { window.__b += 1; if (orig) orig(e); }; speak(u); }; })()`);

  await page.eval(`(() => { const p = document.querySelectorAll('.reading p')[1]; const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); })()`);
  await page.eval('Glider.app.toggleReading()');

  const seen = [];
  for (let i = 0; i < 24; i += 1) {
    await page.sleep(250);
    seen.push(await page.eval(`(() => { const t = document.querySelector('.glider-speaking'); return t ? t.textContent : ''; })()`));
  }
  const distinct = [...new Set(seen.filter(Boolean))];
  const boundaries = await page.eval('window.__b');
  console.log('highlighted over 6s:', distinct.join(' '));
  console.log('real boundary events:', boundaries, boundaries ? '(voice-driven highlight)' : '(estimated-pace fallback in use)');
  check('speech started', (await page.eval('Glider.app.tts.state')) === 'playing');
  check('highlight advances through the words in order', distinct.length >= 6 && distinct[0].toLowerCase() === 'most', distinct.slice(0, 8).join(' '));

  await page.eval('Glider.app.update({ ttsRate: 1.5 })');
  await page.sleep(1500);
  check('changing speed mid-sentence keeps reading', (await page.eval('Glider.app.tts.state')) === 'playing' && !!(await page.eval(`!!document.querySelector('.glider-speaking')`)));

  await page.eval('Glider.app.tts.stop()');
  await page.sleep(300);
  check('stop clears the highlight and restores the page', (await page.eval(`document.querySelectorAll('.glider-speaking, .glider-wrap').length`)) === 0);
  check('no page errors', page.errors.length === 0, page.errors.join(' || '));
} catch (error) {
  failed += 1;
  console.log('FAIL  run completed -> ' + (error.stack || error));
} finally {
  await chrome.close();
  server.close();
}
process.exit(failed ? 1 : 0);
