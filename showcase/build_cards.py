"""Five-card Glider deck, built from the first deck's scenes.
   python showcase/build_cards.py [out.pptx]

   1 title (s0-title.gif)   2 the lens + tuned from the edge   3 hear any word + look-alike words
   4 it sees you stuck, then it gets simpler (one window, the two scenes back to back)   5 close (s9-close.gif)
   Cards 2 to 4 are rendered by cards.html; the browser window of each recorded scene is cut out of its GIF
   and laid into the card. Slides advance by themselves. Needs showcase/out/card-0N.png and cards.json (render_cards.mjs).
"""
import json, os, sys
from lxml import etree
from PIL import Image, ImageSequence
from pptx import Presentation
from pptx.util import Inches, Emu
from pptx.enum.shapes import MSO_SHAPE

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
dest = next((a for a in sys.argv[1:] if a.endswith('.pptx')), os.path.join(HERE, 'Glider-showcase.pptx'))
RECTS = {int(k): v for k, v in json.load(open(os.path.join(OUT, 'cards.json'))).items()}
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
WINDOW = (369, 36, 921, 504)   # where the browser window sits in a 960 x 540 scene recording (default layout)

CARDS = [
    ('video', 't2-gemini', 9.3, 'Glider is a Chrome extension built for dyslexic readers. It reshapes any web page to suit how you read, and steps in when you get stuck.'),
    (2, [['s1-lens'], ['s2-tune']], 7.8, 'One switch opens the page up: more space between letters, words and lines, and a bold start to every word. Size and spacing are set from the logo on the side of the screen.'),
    (3, [['s3-wordlens'], ['s4-lookalike']], 7.8, 'Rest on a long word and it splits into chunks, each with its sound. Words that are easy to mix up get a quiet underline and a quick meaning for each.'),
    (4, [['s5-stuck', 's6-simplify']], 14.3, 'With eye tracking on, the camera notices the lines that slow your eyes, and those lines are shown again in plainer words. The gaze in this recording is simulated.'),
    ('full', 's9-close', 4.6, 'Made with dyslexia in mind.'),
]

def window_gif(names, size, out):
    """Cut the browser window out of one or more scene GIFs, back to back, at the size of the card's box."""
    frames, durs = [], []
    for name in names:
        im = Image.open(os.path.join(OUT, name + '.gif'))
        step = 2 if len(names) > 1 else 1   # the long back-to-back card keeps every second frame to stay a sensible size
        pending = 0
        for i, f in enumerate(ImageSequence.Iterator(im)):
            pending += f.info.get('duration', 67)
            if i % step: continue
            frames.append(f.convert('RGB').crop(WINDOW).resize(size, Image.LANCZOS).quantize(colors=128, method=Image.MEDIANCUT, dither=Image.Dither.NONE))
            durs.append(0)
            if len(durs) > 1: durs[-2] += pending - f.info.get('duration', 67)
            pending = f.info.get('duration', 67)
        durs[-1] += pending
        durs[-1] = 500 if name != names[-1] else 1500   # a short beat between two scenes, a hold at the very end
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=durs, loop=0, optimize=False, disposal=1)
    return out

def autoplay(slide, spid):
    old = slide._element.find('{%s}timing' % P)
    if old is not None: slide._element.remove(old)
    slide._element.append(etree.fromstring(f'''<p:timing xmlns:p="{P}"><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>
      <p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>
        <p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst><p:childTnLst>
          <p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>
            <p:par><p:cTn id="5" presetID="1" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="afterEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>
              <p:cmd type="call" cmd="playFrom(0.0)"><p:cBhvr><p:cTn id="6" dur="1" fill="hold"/><p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cBhvr></p:cmd>
            </p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>
      </p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>
      <p:video><p:cMediaNode vol="0" mute="1"><p:cTn id="7" fill="hold" display="0"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cMediaNode></p:video>
    </p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'''))

def advance(slide, seconds):
    tr = etree.Element('{%s}transition' % P, spd='med', advClick='1', advTm=str(int(seconds * 1000)))
    etree.SubElement(tr, '{%s}fade' % P)
    anchor = slide._element.find('{%s}clrMapOvr' % P)
    (anchor if anchor is not None else slide._element.find('{%s}cSld' % P)).addnext(tr)

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
blank = prs.slide_layouts[6]
px = prs.slide_width / 1280
total = 0.0
for kind, src, secs, note in CARDS:
    slide = prs.slides.add_slide(blank)
    if kind == 'video':   # a 60 fps MP4 (record_mp4.py) that starts by itself; its first frame is the poster
        mv = slide.shapes.add_movie(os.path.join(OUT, src + '.mp4'), 0, 0, prs.slide_width, prs.slide_height, poster_frame_image=os.path.join(OUT, src + '-first.png'), mime_type='video/mp4')
        autoplay(slide, mv.shape_id)
    elif kind == 'full':
        slide.shapes.add_picture(os.path.join(OUT, src + '.gif'), 0, 0, width=prs.slide_width, height=prs.slide_height)
    else:
        slide.shapes.add_picture(os.path.join(OUT, f'card-{kind:02d}.png'), 0, 0, width=prs.slide_width, height=prs.slide_height)
        for i, (names, r) in enumerate(zip(src, RECTS[kind])):
            gif = window_gif(names, (r['w'], r['h']), os.path.join(OUT, f'card-{kind:02d}-{i + 1}.gif'))
            pic = slide.shapes.add_picture(gif, Emu(int(r['x'] * px)), Emu(int(r['y'] * px)), width=Emu(int(r['w'] * px)), height=Emu(int(r['h'] * px)))
            pic.auto_shape_type = MSO_SHAPE.ROUNDED_RECTANGLE
            geom = pic._element.spPr.find('{%s}prstGeom' % A)
            av = geom.find('{%s}avLst' % A)
            if av is None: av = etree.SubElement(geom, '{%s}avLst' % A)
            etree.SubElement(av, '{%s}gd' % A, name='adj', fmla='val %d' % int(16 / min(r['w'], r['h']) * 100000))
    slide.notes_slide.notes_text_frame.text = note
    advance(slide, secs); total += secs
prs.save(dest)
print('saved', dest, f'{os.path.getsize(dest) / 1e6:.1f} MB')
print('cards', len(prs.slides), '| runs', f'{total:.1f} s', '(limit 75)' if total <= 75 else '(OVER the 75 s limit)')
