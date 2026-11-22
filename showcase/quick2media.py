"""Turn the stand-alone live recording (showcase/out/_live_quick/) into a 16:9 clip with a browser window frame.
   python showcase/quick2media.py [scene] [--speed 1.15] [--fps 30]        scene: quick (default) or showcase

   Writes, in showcase/out/:
     live-quick.mp4         16:9, the page frames at the size they were filmed, under a browser bar
     live-quick.gif         960 x 540
     live-quick-poster.png  the last frame
   The page frames are the real recording (live-capture.mjs quick); only the bar above them is drawn here,
   the same bar as live2media.py, at the scale the page was filmed at.
"""
import glob, json, os, subprocess, sys
import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
ICON = os.path.join(HERE, '..', 'glider-extension', 'icons', 'icon128.png')
args = sys.argv[1:]
FPS = int(args[args.index('--fps') + 1]) if '--fps' in args else 30
SPEED = float(args[args.index('--speed') + 1]) if '--speed' in args else 1.0
NAME = next((a for i, a in enumerate(args) if not a.startswith('--') and (i == 0 or args[i - 1] not in ('--fps', '--speed', '--address'))), 'quick')
ADDRESS = args[args.index('--address') + 1] if '--address' in args else None   # shown in the bar instead of the local test server's address
CAP_H = 60          # CSS px: the caption band under the page, when the scene noted captions (live-capture.mjs: scene.cues)


def caption_band(width, k, text):
    band = Image.new('RGB', (width, round(CAP_H * k)), '#20352a')
    d = ImageDraw.Draw(band)
    f = None
    for name in ('seguisb.ttf', 'segoeuib.ttf', 'arialbd.ttf'):
        p = os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts', name)
        if os.path.exists(p):
            f = ImageFont.truetype(p, round(23 * k)); break
    f = f or ImageFont.load_default()
    w = d.textlength(text, font=f)
    d.text(((width - w) / 2, band.height / 2), text, font=f, fill='#f1f6ee', anchor='lm')
    return band


def font(size, bold=False):
    for name in (['segoeuib.ttf', 'arialbd.ttf'] if bold else ['segoeui.ttf', 'arial.ttf']):
        p = os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts', name)
        if os.path.exists(p):
            return ImageFont.truetype(p, round(size))
    return ImageFont.load_default()


def chrome_bar(width, k, url, title):
    """live2media.py's bar, every measure times k."""
    S = lambda *v: tuple(round(x * k) for x in v)
    bar_h = round(78 * k)
    bar = Image.new('RGB', (width, bar_h), '#dee3ea')
    d = ImageDraw.Draw(bar)
    for x0 in (14, 30, 46):
        d.ellipse(S(x0, 14, x0 + 10, 24), fill='#bcc1c7')
    d.rounded_rectangle(S(70, 6, 330, 40), radius=round(9 * k), fill='#ffffff')
    d.rectangle(S(70, 30, 330, 40), fill='#ffffff')
    d.rounded_rectangle(S(82, 14, 98, 30), radius=round(3 * k), fill='#f3f3f3', outline='#c8c8c8')
    d.text(S(86, 13), (title[:1] or 'P').upper(), font=font(12 * k, True), fill='#222')
    d.text(S(106, 13), title if len(title) < 30 else title[:28] + '…', font=font(13 * k), fill='#202124')
    d.text(S(310, 12), '×', font=font(14 * k), fill='#5f6368')
    d.rectangle((0, round(40 * k), width, bar_h), fill='#ffffff')
    lw = max(2, round(2 * k))
    for x0, col, flip in ((18, '#5f6368', 1), (48, '#b6bbc2', -1)):
        cx = x0 + 7
        d.line(S(cx - 7 * flip, 59, cx + 7 * flip, 59), fill=col, width=lw)
        d.line(S(cx - 7 * flip, 59, cx - 2 * flip, 54), fill=col, width=lw)
        d.line(S(cx - 7 * flip, 59, cx - 2 * flip, 64), fill=col, width=lw)
    d.arc(S(76, 52, 90, 66), 40, 340, fill='#5f6368', width=lw)
    d.polygon([S(88, 50), S(92, 56), S(85, 56)], fill='#5f6368')
    right = width / k
    d.rounded_rectangle(S(110, 46, right - 70, 72), radius=round(13 * k), fill='#eef1f5')
    lock = 126
    d.ellipse(S(lock - 1, 52, lock + 11, 64), outline='#5f6368', width=lw)   # plain http: an "i", not a padlock
    d.line(S(lock + 5, 56, lock + 5, 61), fill='#5f6368', width=lw)
    host, _, rest = url.replace('https://', '').replace('http://', '').partition('/')
    f14 = font(14 * k)
    d.text(S(lock + 18, 50), host, font=f14, fill='#202124')
    d.text((round((lock + 18) * k + d.textlength(host, font=f14)), round(50 * k)), '/' + rest, font=f14, fill='#6b7280')
    if os.path.exists(ICON):
        icon = Image.open(ICON).convert('RGBA').resize(S(20, 20), Image.LANCZOS)
        d.rounded_rectangle(S(right - 58, 47, right - 32, 71), radius=round(6 * k), fill='#e8f0e8')
        bar.paste(icon, S(right - 55, 49), icon)
    for y0 in (53, 59, 65):                       # the menu's three dots, drawn (the font has no such glyph)
        d.ellipse(S(right - 19.5, y0 - 1.5, right - 16.5, y0 + 1.5), fill='#5f6368')
    d.line((0, bar_h - 1, width, bar_h - 1), fill='#d3d7dd')
    return bar


d = os.path.join(OUT, '_live_' + NAME)
meta = json.load(open(os.path.join(d, 'times.json')))
files = sorted(glob.glob(os.path.join(d, 'f*.jpg')))
pw, ph = Image.open(files[0]).size
k = pw / (meta.get('width') or 1280)            # device pixels per CSS pixel of the take
bar = chrome_bar(pw, k, ADDRESS or meta['url'], meta.get('title') or meta['url'])
cues = [] if '--no-captions' in args else sorted(meta.get('cues') or [], key=lambda c: c['t'])   # --no-captions: the page alone, no band under it
cap_h = round(CAP_H * k) if cues else 0
bands = {c['text']: caption_band(pw, k, c['text']) for c in cues}
size = (pw, ph + bar.height + cap_h)
size = (size[0] - size[0] % 2, size[1] - size[1] % 2)

times = [t / SPEED for t in meta['times']]
length = max(meta.get('length', 0) / SPEED, times[-1] + 300)
ticks, j = [], 0
for n in range(int(length / 1000 * FPS) + 1):
    t = n * 1000 / FPS
    while j + 1 < len(times) and times[j + 1] <= t:
        j += 1
    ticks.append(j)

mp4 = os.path.join(OUT, f'live-{NAME}.mp4')
gif = os.path.join(OUT, f'live-{NAME}.gif')
exe = imageio_ffmpeg.get_ffmpeg_exe()
p = subprocess.Popen([exe, '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{size[0]}x{size[1]}', '-r', str(FPS), '-i', '-',
                      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17', '-preset', 'slow', '-movflags', '+faststart', mp4], stdin=subprocess.PIPE)
last_j, last_cue, base, im = -1, None, None, None
for n_tick, j in enumerate(ticks):
    if j != last_j:
        base = Image.new('RGB', (pw, ph + bar.height + cap_h), '#ffffff')
        base.paste(bar, (0, 0)); base.paste(Image.open(files[j]).convert('RGB'), (0, bar.height))
        last_j = j; last_cue = None
    if cues:
        now = n_tick * 1000 / FPS * SPEED                      # the moment in the take's own time
        cue = next((c['text'] for c in reversed(cues) if c['t'] <= now), cues[0]['text'])
        if cue != last_cue:
            base.paste(bands[cue], (0, ph + bar.height)); last_cue = cue
    im = base.crop((0, 0, size[0], size[1]))
    p.stdin.write(im.tobytes())
p.stdin.close(); p.wait()
im.save(os.path.join(OUT, f'live-{NAME}-poster.png'))
subprocess.run([exe, '-y', '-loglevel', 'error', '-i', mp4, '-filter_complex',
                'fps=15,scale=iw/2:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=200:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle', gif], check=True)
print(f'{NAME}: {len(ticks) / FPS:.1f} s at {FPS} fps, {size[0]} x {size[1]} | mp4 {os.path.getsize(mp4) / 1e6:.2f} MB | gif {os.path.getsize(gif) / 1e6:.2f} MB')
