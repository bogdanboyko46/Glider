"""Turn live recordings (showcase/out/_live_<scene>/) into deck media, with a browser window frame.
   python showcase/live2media.py lens tune wordlens lookalike [--fps 25] [--speed tune=1.25]

   For each scene writes, in showcase/out/:
     live-<scene>.mp4        800 x 678, real time, for the web player
     live-<scene>.gif        sized for the deck's window boxes, for the .pptx
     live-<scene>-poster.png the last frame
   The page frames are the real recording; only the frame around them (tab, address bar with the
   page's real address, Glider's icon in the toolbar) is drawn here.
   Needs Pillow and imageio-ffmpeg (pip install imageio-ffmpeg).
"""
import glob, json, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
ICON = os.path.join(HERE, '..', 'glider-extension', 'icons', 'icon32.png')
BAR = 78
args = sys.argv[1:]
FPS = int(args[args.index('--fps') + 1]) if '--fps' in args else 25
SPEED = {}
if '--speed' in args:
    for pair in args[args.index('--speed') + 1].split(','):
        k, v = pair.split('=')
        SPEED[k] = float(v)
names = [a for i, a in enumerate(args) if not a.startswith('--') and (i == 0 or args[i - 1] not in ('--fps', '--speed'))]
GIF_SIZE = (708, 600)   # 1.25 x the deck's largest window box (566 x 480): sharp in the .pptx, not huge


def font(size, bold=False):
    for name in (['segoeuib.ttf', 'arialbd.ttf'] if bold else ['segoeui.ttf', 'arial.ttf']):
        p = os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts', name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def chrome_bar(width, url, title):
    """A plain Chromium-style top bar: one tab, the address, the extension's icon."""
    bar = Image.new('RGB', (width, BAR), '#dee3ea')
    d = ImageDraw.Draw(bar)
    # tab strip
    d.ellipse((14, 14, 24, 24), fill='#ff5f57'); d.ellipse((30, 14, 40, 24), fill='#febc2e'); d.ellipse((46, 14, 56, 24), fill='#28c840')
    d.rounded_rectangle((70, 6, 330, 40), radius=9, fill='#ffffff')
    d.rectangle((70, 30, 330, 40), fill='#ffffff')
    d.rounded_rectangle((82, 14, 98, 30), radius=3, fill='#f3f3f3', outline='#c8c8c8')
    d.text((86, 13), (title[:1] or 'P').upper(), font=font(12, True), fill='#222')
    d.text((106, 13), title if len(title) < 30 else title[:28] + '…', font=font(13), fill='#202124')
    d.text((310, 12), '×', font=font(14), fill='#5f6368')
    # address row
    d.rectangle((0, 40, width, BAR), fill='#ffffff')
    # back, forward (greyed), reload: drawn as shapes so they do not depend on the font
    for x0, col, flip in ((18, '#5f6368', 1), (48, '#b6bbc2', -1)):
        cx = x0 + 7
        d.line((cx - 7 * flip, 59, cx + 7 * flip, 59), fill=col, width=2)
        d.line((cx - 7 * flip, 59, cx - 2 * flip, 54), fill=col, width=2)
        d.line((cx - 7 * flip, 59, cx - 2 * flip, 64), fill=col, width=2)
    d.arc((76, 52, 90, 66), 40, 340, fill='#5f6368', width=2)
    d.polygon([(88, 50), (92, 56), (85, 56)], fill='#5f6368')
    d.rounded_rectangle((110, 46, width - 70, 72), radius=13, fill='#eef1f5')
    lock = 126
    if url.startswith('https://'):   # a padlock only for a secure page; the local test page is plain http
        d.rounded_rectangle((lock, 56, lock + 9, 65), radius=2, fill='#5f6368')
        d.arc((lock + 1, 50, lock + 8, 60), 180, 360, fill='#5f6368', width=2)
    else:
        d.ellipse((lock - 1, 52, lock + 11, 64), outline='#5f6368', width=2)
        d.line((lock + 5, 56, lock + 5, 61), fill='#5f6368', width=2)
    host, _, rest = url.replace('https://', '').replace('http://', '').partition('/')
    d.text((lock + 18, 50), host, font=font(14), fill='#202124')
    w = d.textlength(host, font=font(14))
    d.text((lock + 18 + w, 50), '/' + rest, font=font(14), fill='#6b7280')
    # Glider in the toolbar (the extension's own icon), pinned
    if os.path.exists(ICON):
        icon = Image.open(ICON).convert('RGBA').resize((20, 20), Image.LANCZOS)
        d.rounded_rectangle((width - 58, 47, width - 32, 71), radius=6, fill='#e8f0e8')
        bar.paste(icon, (width - 55, 49), icon)
    d.text((width - 24, 47), '⋮', font=font(17), fill='#5f6368')
    d.line((0, BAR - 1, width, BAR - 1), fill='#d3d7dd')
    return bar


def frames_of(name):
    d = os.path.join(OUT, '_live_' + name)
    meta = json.load(open(os.path.join(d, 'times.json')))
    files = sorted(glob.glob(os.path.join(d, 'f*.jpg')))
    return files, meta


def timeline(files, meta, speed):
    """Real frame times -> a frame for each tick at FPS (the latest painted frame at that moment)."""
    times = [t / speed for t in meta['times']]
    length = max(meta.get('length', 0) / speed, times[-1] + 400)
    out, j = [], 0
    for k in range(int(length / 1000 * FPS) + 1):
        t = k * 1000 / FPS
        while j + 1 < len(times) and times[j + 1] <= t:
            j += 1
        out.append(files[j])
    return out


def write_mp4(path, frames):
    import imageio_ffmpeg
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    w, h = frames[0].size
    p = subprocess.Popen([exe, '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{w}x{h}', '-r', str(FPS), '-i', '-',
                          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'slow', '-movflags', '+faststart', path], stdin=subprocess.PIPE)
    for f in frames:
        p.stdin.write(f.tobytes())
    p.stdin.close()
    p.wait()


def write_gif(path, frames):
    small = [f.resize(GIF_SIZE, Image.LANCZOS) for f in frames[::2]]          # half the frames: smooth enough, half the size
    pal = [f.quantize(colors=200, method=Image.MEDIANCUT, dither=Image.Dither.NONE) for f in small]
    durs = [round(2000 / FPS)] * len(pal)
    durs[-1] = 1500                                                            # hold the end before it loops
    pal[0].save(path, save_all=True, append_images=pal[1:], duration=durs, loop=0, optimize=False, disposal=1)


for name in names:
    files, meta = frames_of(name)
    bar = chrome_bar(Image.open(files[0]).width, meta['url'], meta.get('title') or meta['url'])
    cache, frames = {}, []
    for f in timeline(files, meta, SPEED.get(name, 1.0)):
        if f not in cache:
            page = Image.open(f).convert('RGB')
            im = Image.new('RGB', (page.width, page.height + BAR), '#ffffff')
            im.paste(bar, (0, 0)); im.paste(page, (0, BAR))
            cache[f] = im
        frames.append(cache[f])
    mp4 = os.path.join(OUT, f'live-{name}.mp4')
    gif = os.path.join(OUT, f'live-{name}.gif')
    write_mp4(mp4, frames)
    write_gif(gif, frames)
    frames[-1].save(os.path.join(OUT, f'live-{name}-poster.png'))
    print(f'{name}: {len(frames) / FPS:.1f} s at {FPS} fps | mp4 {os.path.getsize(mp4) / 1e6:.2f} MB | gif {os.path.getsize(gif) / 1e6:.2f} MB')
