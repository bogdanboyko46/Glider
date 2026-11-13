"""Web preview of the five-card deck (published as an artifact with showcase/out as its file root).
   python showcase/make_reel_cards.py <output.html>
"""
import io, json, os, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
rects = {int(k): v for k, v in json.load(open(os.path.join(OUT, 'cards.json'))).items()}
for n in (2, 3, 4):
    Image.open(os.path.join(OUT, f'card-{n:02d}.png')).convert('RGB').resize((1280, 720), Image.LANCZOS).save(os.path.join(OUT, f'cardweb-{n:02d}.jpg'), quality=88)
for name in ('s0-title', 's9-close'):
    im = Image.open(os.path.join(OUT, name + '.gif')); im.seek(im.n_frames - 1); im.convert('RGB').save(os.path.join(OUT, name + '-thumb.jpg'), quality=85)
cards = [
    dict(name='Glider', secs=4.6, bg='s0-title.gif', thumb='s0-title-thumb.jpg', recs=[]),
    dict(name='The lens, tuned from the edge', secs=7.8, bg='cardweb-02.jpg', thumb='cardweb-02.jpg', recs=[dict(gif=f'card-02-{i + 1}.gif', **r) for i, r in enumerate(rects[2])]),
    dict(name='Help with the hard words', secs=7.8, bg='cardweb-03.jpg', thumb='cardweb-03.jpg', recs=[dict(gif=f'card-03-{i + 1}.gif', **r) for i, r in enumerate(rects[3])]),
    dict(name='Stuck, then simpler', secs=14.3, bg='cardweb-04.jpg', thumb='cardweb-04.jpg', recs=[dict(gif=f'card-04-{i + 1}.gif', **r) for i, r in enumerate(rects[4])]),
    dict(name='Read at your pace', secs=4.6, bg='s9-close.gif', thumb='s9-close-thumb.jpg', recs=[]),
]
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
.screen { position: relative; border-radius: 16px; overflow: hidden; background: #eef2ea; box-shadow: 0 0 0 1px var(--rule), 0 30px 60px -30px rgba(20, 40, 30, .5); aspect-ratio: 16 / 9; }
.screen img.bg { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.screen img.rec { position: absolute; display: block; border-radius: 1.3%; }
.bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.bar button { all: unset; cursor: pointer; padding: 9px 18px; border-radius: 999px; background: var(--accent); color: var(--accent-ink); font: 700 15px/1 "Lexend", sans-serif; }
.bar button.quiet { background: var(--card); color: var(--fg); box-shadow: 0 0 0 1px var(--rule); }
.bar button:focus-visible, .thumb:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.bar .now { font-size: 14.5px; color: var(--fg2); }
.strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
.thumb { all: unset; cursor: pointer; display: grid; gap: 5px; }
.thumb img { width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 9px; box-shadow: 0 0 0 1px var(--rule); display: block; }
.thumb[aria-current="true"] img { box-shadow: 0 0 0 2.5px var(--accent); }
.thumb b { font: 500 13px/1.3 "Lexend", sans-serif; color: var(--fg); }
.thumb small { font-size: 12.5px; color: var(--fg2); }
</style>
<div class="wrap">
  <header style="display:grid;gap:10px">
    <h1>Glider showcase: five cards</h1>
    <p>The first deck's look, condensed to five cards with connected features sharing a card, and each card composed differently. Press play to run it the way PowerPoint will.</p>
    <div class="facts" id="facts"></div>
  </header>
  <section style="display:grid;gap:12px">
    <div class="screen" id="screen"><img class="bg" id="bg" alt=""></div>
    <div class="bar"><button id="play">Play the deck</button><button class="quiet" id="prev">Back</button><button class="quiet" id="next">Next</button><span class="now" id="now"></span></div>
    <div class="strip" id="strip"></div>
  </section>
  <section style="display:grid;gap:10px">
    <h2>Known differences from the app, to nitpick next</h2>
    <ul>
      <li>The windows are the first deck's drawn scenes, not recordings of the extension. The edge mark in them is right, but the panel, the word lens and the look-alike card are simplified versions of the real ones.</li>
      <li>Card 2 still shows a power button beside the logo for a moment; the app now opens the panel from the logo itself.</li>
      <li>Card 4 uses the earlier simulated gaze dot and the three-line correction, not the newer take with the student in the camera box and the whole-sentence correction.</li>
    </ul>
  </section>
</div>
<script>
const CARDS = __CARDS__;
const screen = document.getElementById('screen'), bg = document.getElementById('bg');
let at = 0, timer = 0, playing = false;
const total = CARDS.reduce((s, x) => s + x.secs, 0);
document.getElementById('facts').innerHTML = [`${CARDS.length} cards`, `runs ${Math.round(total)} seconds`, 'limit 75 seconds', 'cards advance by themselves'].map((t) => `<span>${t}</span>`).join('');
document.getElementById('strip').innerHTML = CARDS.map((s, i) => `<button class="thumb" data-i="${i}"><img src="${s.thumb}" alt="" loading="lazy"><b>${i + 1}. ${s.name}</b><small>${s.secs} s</small></button>`).join('');
function show(i) {
  at = (i + CARDS.length) % CARDS.length;
  const s = CARDS[at], stamp = '?' + Date.now();
  bg.src = ''; bg.src = s.bg + (s.bg.endsWith('.gif') ? stamp : ''); bg.alt = s.name;
  screen.querySelectorAll('.rec').forEach((x) => x.remove());
  for (const r of s.recs) {
    const im = document.createElement('img'); im.className = 'rec'; im.alt = ''; im.src = r.gif + stamp;
    im.style.left = (r.x / 12.8) + '%'; im.style.top = (r.y / 7.2) + '%'; im.style.width = (r.w / 12.8) + '%'; im.style.height = (r.h / 7.2) + '%';
    screen.appendChild(im);
  }
  document.getElementById('now').textContent = `Card ${at + 1} of ${CARDS.length}: ${s.name}`;
  document.querySelectorAll('.thumb').forEach((t, k) => t.setAttribute('aria-current', k === at));
  clearTimeout(timer);
  if (playing) timer = setTimeout(() => { if (at === CARDS.length - 1) stop(); else show(at + 1); }, s.secs * 1000);
}
function stop() { playing = false; clearTimeout(timer); document.getElementById('play').textContent = 'Play the deck'; }
document.getElementById('play').onclick = () => { if (playing) { stop(); return; } playing = true; document.getElementById('play').textContent = 'Stop'; show(0); };
document.getElementById('next').onclick = () => { stop(); show(at + 1); };
document.getElementById('prev').onclick = () => { stop(); show(at - 1); };
document.getElementById('strip').onclick = (e) => { const t = e.target.closest('.thumb'); if (t) { stop(); show(+t.dataset.i); } };
show(0);
</script>
'''
io.open(sys.argv[1], 'w', encoding='utf-8', newline='\n').write(HTML.replace('__CARDS__', json.dumps(cards)))
files = sorted({c['bg'] for c in cards} | {c['thumb'] for c in cards} | {r['gif'] for c in cards for r in c['recs']})
print(json.dumps(files))
print(round(sum(os.path.getsize(os.path.join(OUT, f)) for f in files) / 1e6, 1), 'MB')
