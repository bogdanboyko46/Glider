"""The whole showcase as five slides, each slide ONE full-slide animated GIF (nothing else on the slide).
   python showcase/build_gif_deck.py [out.pptx]          -> showcase/Glider-showcase-gif.pptx and showcase/out/deck-N.gif

   1 the opening        t2-gemini.html, rendered frame by frame (shot.mjs) at 1920 x 1080
   2 lines stop crowding  card-02.png with the live recording live-panel.mp4 in its window
   3 hard words         card-03.png with live-wordlens.mp4 and live-lookalike.mp4 in its windows
   4 eye tracking       out/fullrec/eyetrack-clip.mp4, full slide
   5 the close          s9-close.gif
   Needs: the files above (render_cards.mjs, live-capture.mjs + live2media.py, record.py), Pillow, python-pptx, imageio-ffmpeg.
"""
import glob, json, os, shutil, subprocess, sys, time
import imageio_ffmpeg
from lxml import etree
from PIL import Image, ImageDraw
from pptx import Presentation
from pptx.util import Inches

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
TMP = os.path.join(OUT, '_deckgif')
FF = imageio_ffmpeg.get_ffmpeg_exe()
dest = next((a for a in sys.argv[1:] if a.endswith('.pptx')), os.path.join(HERE, 'Glider-showcase-gif.pptx'))
RECTS = {int(k): v for k, v in json.load(open(os.path.join(OUT, 'cards.json'))).items()}
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
W, H = 1600, 900            # cards 2 to 5; card 1 is 1920 x 1080
K = W / 1280


def save(frames, fps, path, hold=1.5, loop=True):
    """Encode RGB frames as a GIF with ffmpeg: one shared palette, and only the pixels that change are stored."""
    d = os.path.join(TMP, 'enc')
    shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    for i, f in enumerate(frames):
        f.save(os.path.join(d, f'f{i:05d}.png'), compress_level=1)
    vf = f'tpad=stop_mode=clone:stop_duration={hold},split[a][b];[a]palettegen=max_colors=200:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle'
    subprocess.run([FF, '-y', '-loglevel', 'error', '-framerate', str(fps), '-i', os.path.join(d, 'f%05d.png'), '-filter_complex', vf, '-loop', '0' if loop else '-1', path], check=True)
    secs = len(frames) / fps
    print(os.path.basename(path), f'{os.path.getsize(path) / 1e6:.1f} MB, {len(frames)} frames, {secs:.1f} s', flush=True)
    return secs


def shot_frames(scene, fps, scale):
    d = os.path.join(TMP, scene)
    shutil.rmtree(d, ignore_errors=True)
    for _ in range(10):
        r = subprocess.run(['node', os.path.join(HERE, 'shot.mjs'), os.path.join(HERE, scene + '.html'), 'all', d, str(fps)], capture_output=True, text=True, env=dict(os.environ, SHOT_SCALE=str(scale)))
        if r.returncode == 3: time.sleep(8); continue
        break
    files = sorted(glob.glob(os.path.join(d, 'f*.png')))
    if not files: raise SystemExit(scene + ' not rendered: ' + (r.stdout or r.stderr)[-300:])
    return [Image.open(f).convert('RGB') for f in files]


def video_frames(path, fps, size=None, crop=None):
    """Frames of a video as RGB images, at a fixed rate."""
    d = os.path.join(TMP, os.path.splitext(os.path.basename(path))[0])
    shutil.rmtree(d, ignore_errors=True); os.makedirs(d)
    vf = [f'fps={fps}'] + ([f'crop={crop}'] if crop else []) + ([f'scale={size[0]}:{size[1]}:flags=lanczos'] if size else [])
    subprocess.run([FF, '-y', '-loglevel', 'error', '-i', path, '-vf', ','.join(vf), os.path.join(d, 'f%05d.png')], check=True)
    return [Image.open(f).convert('RGB') for f in sorted(glob.glob(os.path.join(d, 'f*.png')))]


def card_opening():
    return save(shot_frames('t2-gemini', 33.33333, 1.5), 33.33333, os.path.join(OUT, 'deck-1.gif'), hold=3, loop=False)


def card_live(n, clips, fps=25):
    bg = Image.open(os.path.join(OUT, f'card-{n:02d}.png')).convert('RGB').resize((W, H), Image.LANCZOS)
    layers = []
    for clip, r in zip(clips, RECTS[n]):
        box = (round(r['x'] * K), round(r['y'] * K), round(r['w'] * K), round(r['h'] * K))
        mask = Image.new('L', (box[2], box[3]), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, box[2] - 1, box[3] - 1), radius=round(16 * K), fill=255)
        layers.append((video_frames(os.path.join(OUT, clip), fps, (box[2], box[3])), box, mask))
    frames = []
    for i in range(max(len(l[0]) for l in layers)):
        im = bg.copy()
        for fr, box, mask in layers:
            im.paste(fr[min(i, len(fr) - 1)], (box[0], box[1]), mask)
        frames.append(im)
    return save(frames, fps, os.path.join(OUT, f'deck-{n}.gif'))


def card_eyes(fps=25):
    # 1920 x 1128 recording: trim 48 px off the top (part of the tab strip) to make it 16:9
    fr = video_frames(os.path.join(OUT, 'fullrec', 'eyetrack-clip.mp4'), fps, (W, H), '1920:1080:0:48')
    return save(fr, fps, os.path.join(OUT, 'deck-4.gif'))


def card_close():
    return save(shot_frames('s9-close', 25, 1.25), 25, os.path.join(OUT, 'deck-5.gif'), hold=3, loop=False)


NOTES = [
    'Glider is a Chrome extension made with dyslexia in mind. It reshapes any web page to suit how you read, and steps in when you get stuck.',
    'Filmed live: the real extension on a sample course page. Opened from the mark on the side of the screen; then colours for b d p q, the Hyperlegible font, and size and spacing.',
    'Filmed live on the same page. Rest on a long word: how hard it is, its chunks and sounds, sound it out, its meaning. Look-alike words come with a quick meaning each.',
    'With eye tracking on, Glider notices a paragraph being read twice and shows it again in plainer words. Left to right comes from the webcam; which line the dot is on is staged for this clip.',
    'Made with dyslexia in mind.',
]

if __name__ == '__main__':
    os.makedirs(TMP, exist_ok=True)
    secs = [card_opening(), card_live(2, ['live-panel.mp4']), card_live(3, ['live-wordlens.mp4', 'live-lookalike.mp4']), card_eyes(), card_close()]
    secs = [round(s + (1.2 if i in (0, 4) else 0.4), 1) for i, s in enumerate(secs)]   # a beat on the finished frame before moving on
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    for i, s in enumerate(secs):
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        slide.shapes.add_picture(os.path.join(OUT, f'deck-{i + 1}.gif'), 0, 0, width=prs.slide_width, height=prs.slide_height)
        slide.notes_slide.notes_text_frame.text = NOTES[i]
        tr = etree.Element('{%s}transition' % P, spd='med', advClick='1', advTm=str(int(s * 1000)))
        etree.SubElement(tr, '{%s}fade' % P)
        anchor = slide._element.find('{%s}clrMapOvr' % P)
        (anchor if anchor is not None else slide._element.find('{%s}cSld' % P)).addnext(tr)
    prs.save(dest)
    shutil.rmtree(TMP, ignore_errors=True)
    total = sum(secs)
    print('slides', secs, '| saved', dest, f'{os.path.getsize(dest) / 1e6:.1f} MB | runs {total:.1f} s', '(limit 75)' if total <= 75 else '(OVER the 75 s limit)')
