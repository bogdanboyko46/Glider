"""The five-card deck with cards 2 and 3 filmed live: the real extension on the sample course page.
   python showcase/build_live_deck.py [out.pptx]

   Same deck as build_cards.py (cards 1, 4 and 5 unchanged, from their scene recordings), except that
   the windows on cards 2 and 3 are the live recordings, on the sample course page, made by live-capture.mjs and live2media.py
   (out/live-panel.gif on card 2; live-wordlens.gif and live-lookalike.gif on card 3). Cards 2 and 3 run as long
   as their longest recording, so no real footage is cut or sped up.
   Needs: out/card-0N.png and cards.json (render_cards.mjs), the scene GIFs for s0-title, s5-stuck,
   s6-simplify and s9-close (record.py), the live GIFs, python-pptx and Pillow.
"""
import json, os, sys
from lxml import etree
from PIL import Image, ImageSequence
from pptx import Presentation
from pptx.util import Inches, Emu
from pptx.enum.shapes import MSO_SHAPE

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
dest = next((a for a in sys.argv[1:] if a.endswith('.pptx')), os.path.join(HERE, 'Glider-showcase-live.pptx'))
RECTS = {int(k): v for k, v in json.load(open(os.path.join(OUT, 'cards.json'))).items()}
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
WINDOW = (369, 36, 921, 504)   # where the browser window sits in a 960 x 540 scene recording


def gif_seconds(path):
    im = Image.open(path)
    return sum(f.info.get('duration', 67) for f in ImageSequence.Iterator(im)) / 1000


def live(name):
    return os.path.join(OUT, f'live-{name}.gif')


def card_secs(*names):
    # as long as the longest recording, without its final hold, plus a short beat
    return round(max(gif_seconds(live(n)) - 1.5 for n in names) + 0.6, 1)


CARDS = [
    ('full', 's0-title', 4.6, 'Glider is a Chrome extension built for dyslexic readers. It reshapes any web page to suit how you read, and steps in when you get stuck.'),
    (2, [live('panel')], card_secs('panel'),
     'Filmed live: the Glider extension running on a sample course reading page. Glider is opened from the mark on the side of the screen and the reading lens is switched on: more space between letters, words and lines, and a bold start to every word. Then colours that tell b, d, p and q apart, the Atkinson Hyperlegible font, and the size and spacing sliders, set to 130%, 1, 5 and 2.3.'),
    (3, [live('wordlens'), live('lookalike')], card_secs('wordlens', 'lookalike'),
     'Filmed live on the same course page. Rest on a long word, like "accumulate", and the lens says how hard it is to read, shows the sound of each chunk, sounds it out, and gives its meaning. A word that is easy to mix up, like "affect", lists its look-alikes with a short meaning each.'),
    (4, [['s5-stuck', 's6-simplify']], 14.3, 'With eye tracking on, the camera notices the lines that slow your eyes, and those lines are shown again in plainer words. The gaze in this recording is simulated.'),
    ('full', 's9-close', 4.6, 'Read at your pace.'),
]


def window_gif(names, size, out):
    """As in build_cards.py: cut the browser window out of scene GIFs, back to back, at the box's size."""
    frames, durs = [], []
    for name in names:
        im = Image.open(os.path.join(OUT, name + '.gif'))
        step = 2 if len(names) > 1 else 1
        pending = 0
        for i, f in enumerate(ImageSequence.Iterator(im)):
            pending += f.info.get('duration', 67)
            if i % step:
                continue
            frames.append(f.convert('RGB').crop(WINDOW).resize(size, Image.LANCZOS).quantize(colors=128, method=Image.MEDIANCUT, dither=Image.Dither.NONE))
            durs.append(0)
            if len(durs) > 1:
                durs[-2] += pending - f.info.get('duration', 67)
            pending = f.info.get('duration', 67)
        durs[-1] += pending
        durs[-1] = 500 if name != names[-1] else 1500
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=durs, loop=0, optimize=False, disposal=1)
    return out


def advance(slide, seconds):
    tr = etree.Element('{%s}transition' % P, spd='med', advClick='1', advTm=str(int(seconds * 1000)))
    etree.SubElement(tr, '{%s}fade' % P)
    anchor = slide._element.find('{%s}clrMapOvr' % P)
    (anchor if anchor is not None else slide._element.find('{%s}cSld' % P)).addnext(tr)


def rounded(pic, r):
    pic.auto_shape_type = MSO_SHAPE.ROUNDED_RECTANGLE
    geom = pic._element.spPr.find('{%s}prstGeom' % A)
    av = geom.find('{%s}avLst' % A)
    if av is None:
        av = etree.SubElement(geom, '{%s}avLst' % A)
    etree.SubElement(av, '{%s}gd' % A, name='adj', fmla='val %d' % int(16 / min(r['w'], r['h']) * 100000))


prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
blank = prs.slide_layouts[6]
px = prs.slide_width / 1280
total = 0.0
for kind, src, secs, note in CARDS:
    slide = prs.slides.add_slide(blank)
    if kind == 'full':
        slide.shapes.add_picture(os.path.join(OUT, src + '.gif'), 0, 0, width=prs.slide_width, height=prs.slide_height)
    else:
        slide.shapes.add_picture(os.path.join(OUT, f'card-{kind:02d}.png'), 0, 0, width=prs.slide_width, height=prs.slide_height)
        for i, (item, r) in enumerate(zip(src, RECTS[kind])):
            gif = item if isinstance(item, str) else window_gif(item, (r['w'], r['h']), os.path.join(OUT, f'card-{kind:02d}-{i + 1}.gif'))
            pic = slide.shapes.add_picture(gif, Emu(int(r['x'] * px)), Emu(int(r['y'] * px)), width=Emu(int(r['w'] * px)), height=Emu(int(r['h'] * px)))
            rounded(pic, r)
    slide.notes_slide.notes_text_frame.text = note
    advance(slide, secs)
    total += secs
    print(f'card {len(prs.slides)}: {secs:.1f} s')
prs.save(dest)
print('saved', dest, f'{os.path.getsize(dest) / 1e6:.1f} MB | runs {total:.1f} s', '(limit 75)' if total <= 75 else '(OVER the 75 s limit)')
