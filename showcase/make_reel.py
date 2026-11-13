"""Write the web preview page for the deck (published as an artifact with showcase/out as its file root).
   python showcase/make_reel.py <output.html>
"""
import io, json, os, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
rects = {int(k): v for k, v in json.load(open(os.path.join(OUT, 'slides.json'))).items()}
names = ['Title', 'Pages crowd you', 'A lens for dyslexia', 'Lines stop crowding you', 'Set it your way', 'Hear the hard word',
         "Their, there, they're", 'It sees you stuck', 'Then it gets simpler', 'Read at your pace']
secs = [3.5, 4, 4, 7.4, 7.4, 7.2, 6.2, 8.2, 8.7, 3.5]
for n in range(1, 11):   # lighter copies of the slide layouts for the web
    Image.open(os.path.join(OUT, f'slide-{n:02d}.png')).convert('RGB').resize((1280, 720), Image.LANCZOS).save(os.path.join(OUT, f'web-{n:02d}.jpg'), quality=86)
slides = [dict(n=n, name=names[n - 1], secs=secs[n - 1], bg=f'web-{n:02d}.jpg', gif=(f'final-{n:02d}.gif' if n in rects else ''), rect=rects.get(n)) for n in range(1, 11)]

HTML = r'''<title>Glider Showcase Reel</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lexend:wght@500;700&family=Atkinson+Hyperlegible:wght@400;700&display=swap">
<style>
:root { --bg: #eef2ea; --fg: #20352a; --fg2: #566b5c; --card: #f8faf5; --rule: #d6dfce; --accent: #2f6b4a; --accent-ink: #fff; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #131a16; --fg: #e8f0e8; --fg2: #9db0a2; --card: #1b2520; --rule: #2c3a31; --accent: #8fd0a6; --accent-ink: #10201a; color-scheme: dark; } }
:root[data-theme="dark"] { --bg: #131a16; --fg: #e8f0e8; --fg2: #9db0a2; --card: #1b2520; --rule: #2c3a31; --accent: #8fd0a6; --accent-ink: #10201a; color-scheme: dark; }
* { box-sizing: border-box; }
body { background: var(--bg); color: var(--fg); font: 16px/1.55 "Atkinson Hyperlegible", "Segoe UI", system-ui, sans-serif;
  padding-block: 36px 80px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.wrap { max-width: 1180px; margin: 0 auto; display: grid; gap: 22px; }
h1 { margin: 0; font: 700 clamp(30px, 5vw, 44px)/1.08 "Lexend", sans-serif; letter-spacing: -.02em; text-wrap: balance; }
p, li { color: var(--fg2); } p { margin: 0; max-width: 70ch; }
ul { margin: 0; padding-left: 20px; display: grid; gap: 5px; max-width: 72ch; }
h2 { margin: 8px 0 0; font: 700 22px/1.2 "Lexend", sans-serif; }
.facts { display: flex; flex-wrap: wrap; gap: 10px; }
.facts span { padding: 6px 13px; border-radius: 999px; background: var(--card); box-shadow: 0 0 0 1px var(--rule); font-size: 14.5px; color: var(--fg); }
.screen { position: relative; border-radius: 16px; overflow: hidden; background: var(--card); box-shadow: 0 0 0 1px var(--rule), 0 30px 60px -30px rgba(20, 40, 30, .5); aspect-ratio: 16 / 9; }
.screen img.bg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.screen img.rec { position: absolute; display: block; border-radius: 1.1%; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.bar button { all: unset; cursor: pointer; padding: 9px 18px; border-radius: 999px; background: var(--accent); color: var(--accent-ink); font: 700 15px/1 "Lexend", sans-serif; }
.bar button.quiet { background: var(--card); color: var(--fg); box-shadow: 0 0 0 1px var(--rule); }
.bar button:focus-visible, .thumb:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.bar .now { font-size: 14.5px; color: var(--fg2); }
.strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.thumb { all: unset; cursor: pointer; display: grid; gap: 5px; }
.thumb img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 9px; box-shadow: 0 0 0 1px var(--rule); display: block; }
.thumb[aria-current="true"] img { box-shadow: 0 0 0 2.5px var(--accent); }
.thumb b { font: 500 13px/1.3 "Lexend", sans-serif; color: var(--fg); }
.thumb small { font-size: 12.5px; color: var(--fg2); }
</style>
<div class="wrap">
  <header style="display:grid;gap:10px">
    <h1>Glider showcase reel, redesigned</h1>
    <p>Ten slides, ten different layouts, no slide counters. Backgrounds are generated with Gemini; every moving screen is a recording of the real extension. Press play to run it the way PowerPoint will.</p>
    <div class="facts" id="facts"></div>
  </header>
  <section style="display:grid;gap:12px">
    <div class="screen"><img class="bg" id="bg" alt=""><img class="rec" id="rec" alt="" hidden></div>
    <div class="bar"><button id="play">Play the deck</button><button class="quiet" id="prev">Back</button><button class="quiet" id="next">Next</button><span class="now" id="now"></span></div>
    <div class="strip" id="strip"></div>
  </section>
  <section style="display:grid;gap:10px">
    <h2>What is real and what is not</h2>
    <ul>
      <li>Slides 4 to 9 show the shipped interface, recorded while a script moved the pointer.</li>
      <li>On the eye-tracking slides the reader is scripted: the face in the camera box is a generated image, and the amber ring marking the gaze is drawn by the recording, not by the product.</li>
      <li>The simplified text is the product's own offline rewrite. It appears without a click here because that setting was switched on; by default the product stops at the "Simpler version" button.</li>
      <li>The word-lens recording has no sound.</li>
    </ul>
  </section>
</div>
<script>
const SLIDES = __SLIDES__;
const bg = document.getElementById('bg'), rec = document.getElementById('rec');
let at = 0, timer = 0, playing = false;
const total = SLIDES.reduce((s, x) => s + x.secs, 0);
document.getElementById('facts').innerHTML = [`${SLIDES.length} slides`, `runs ${Math.round(total)} seconds`, 'limit 75 seconds', 'slides advance by themselves'].map((t) => `<span>${t}</span>`).join('');
document.getElementById('strip').innerHTML = SLIDES.map((s, i) => `<button class="thumb" data-i="${i}"><img src="${s.bg}" alt="" loading="lazy"><b>${i + 1}. ${s.name}</b><small>${s.secs} s${s.gif ? ', real recording' : ''}</small></button>`).join('');
function show(i) {
  at = (i + SLIDES.length) % SLIDES.length;
  const s = SLIDES[at];
  bg.src = s.bg; bg.alt = s.name;
  if (s.gif) { const r = s.rect; rec.hidden = false; rec.src = ''; rec.src = s.gif + '?' + Date.now();
    rec.style.left = (r.x / 12.8) + '%'; rec.style.top = (r.y / 7.2) + '%'; rec.style.width = (r.w / 12.8) + '%'; rec.style.height = (r.h / 7.2) + '%'; }
  else rec.hidden = true;
  document.getElementById('now').textContent = `Slide ${at + 1} of ${SLIDES.length}: ${s.name}`;
  document.querySelectorAll('.thumb').forEach((t, k) => t.setAttribute('aria-current', k === at));
  clearTimeout(timer);
  if (playing) timer = setTimeout(() => { if (at === SLIDES.length - 1) stop(); else show(at + 1); }, s.secs * 1000);
}
function stop() { playing = false; clearTimeout(timer); document.getElementById('play').textContent = 'Play the deck'; }
document.getElementById('play').onclick = () => { if (playing) { stop(); return; } playing = true; document.getElementById('play').textContent = 'Stop'; show(0); };
document.getElementById('next').onclick = () => { stop(); show(at + 1); };
document.getElementById('prev').onclick = () => { stop(); show(at - 1); };
document.getElementById('strip').onclick = (e) => { const t = e.target.closest('.thumb'); if (t) { stop(); show(+t.dataset.i); } };
show(0);
</script>
'''
io.open(sys.argv[1], 'w', encoding='utf-8', newline='\n').write(HTML.replace('__SLIDES__', json.dumps(slides)))
files = [s['bg'] for s in slides] + [s['gif'] for s in slides if s['gif']]
print(json.dumps(files))
print(round(sum(os.path.getsize(os.path.join(OUT, f)) for f in files) / 1e6, 1), 'MB')
