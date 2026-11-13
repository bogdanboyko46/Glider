"""Build the Glider showcase deck, version 2.
   python showcase/build_deck2.py [out.pptx]

   Each slide = a static layout rendered on a Gemini-generated background (showcase/out/slide-NN.png, from
   render_slides.mjs) with a recording of the REAL extension laid into its screen box (showcase/out/_real_<name>/).
   Veo clips in showcase/veo/ (vA.mp4 before slide 2, vB.mp4 before slide 8, vC.mp4 before slide 10) are added when present.
   Slides advance by themselves; the running time is printed (limit 75 s).
"""
import glob, json, os, sys
from lxml import etree
from PIL import Image
from pptx import Presentation
from pptx.util import Inches, Emu
from pptx.enum.shapes import MSO_SHAPE

HERE = os.path.dirname(os.path.abspath(__file__))
OUT, VEO = os.path.join(HERE, 'out'), os.path.join(HERE, 'veo')
dest = next((a for a in sys.argv[1:] if a.endswith('.pptx')), os.path.join(HERE, 'Glider-showcase.pptx'))
RECTS = {int(k): v for k, v in json.load(open(os.path.join(OUT, 'slides.json'))).items()}
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'

# slide number -> (seconds, recording, crop box in capture pixels or None, speaker note)
PLAN = {
    1: (3.5, None, None, 'Glider is a Chrome extension built for dyslexic readers. It reshapes any web page to suit how you read, and steps in when you get stuck.'),
    2: (4.0, None, None, 'Most pages are tight lines and long words, with no way to slow them down.'),
    3: (4.0, None, None, 'Glider is a reading lens for dyslexia. It works on the pages you already use.'),
    4: (7.4, 'r1-lens', None, 'Press the logo on the side of the screen, switch the lens on, and the page opens up: more space between letters, words and lines, and a bold start to every word. This is a recording of the real extension.'),
    5: (7.4, 'r2-tune', None, 'The same panel sets size and spacing. Recording of the real extension.'),
    6: (7.2, 'r3-wordlens', (80, 110, 640, 460), 'Rest on a long word and it splits into chunks, each with its sound underneath. The lens says how hard the word is to read, Sound it out lights each chunk in turn, and Meaning opens the definition inside the same lens. Real extension; the audio is not in this recording.'),
    7: (6.2, 'r4-lookalike', (0, 60, 640, 460), 'Words that are easy to mix up get a quiet underline and a quick meaning for each. Real extension.'),
    8: (8.2, ('r56', 3600, 11600), None, 'With eye tracking on, the camera notices the lines that slow your eyes. In this recording the reader, the face in the camera box and the gaze path are simulated; the interface is the real one.'),
    9: (8.7, ('r56', 12800, 21300), None, 'Those lines are shown again in plainer words, right where you are reading. Showing it without a click is a setting; by default Glider stops at the Simpler version button you see appear first.'),
    10: (3.5, None, None, 'Read at your pace.'),
}
VEO_BEFORE = {2: ('vA', 4.0), 8: ('vB', 4.0), 10: ('vC', 3.0)}

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

def recording_gif(name, crop, size, slide_no):
    """Real-app frames -> a GIF the size of the screen box, every second frame, true timings."""
    window = None
    if isinstance(name, tuple): name, window = name[0], name[1:]
    d = os.path.join(OUT, '_real_' + name)
    files = sorted(glob.glob(os.path.join(d, 'f*.png')))
    if not files: return None
    times = json.load(open(os.path.join(d, 'times.json')))
    keep = [i for i in range(len(files)) if not window or window[0] <= times[i] <= window[1]]
    pick = keep[::2]
    frames, durs = [], []
    for k, i in enumerate(pick):
        im = Image.open(files[i]).convert('RGB')
        if crop: im = im.crop(crop)
        frames.append(im.resize(size, Image.LANCZOS).quantize(colors=128, method=Image.MEDIANCUT, dither=Image.Dither.NONE))
        nxt = pick[k + 1] if k + 1 < len(pick) else None
        durs.append(max(20, times[nxt] - times[i]) if nxt is not None else 1500)
    out = os.path.join(OUT, f'final-{slide_no:02d}.gif')
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=durs, loop=0, optimize=False, disposal=1)
    return out

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
blank = prs.slide_layouts[6]
px = prs.slide_width / 1280
total, log, missing = 0.0, [], []
for n in range(1, 11):
    if n in VEO_BEFORE:
        clip, secs = VEO_BEFORE[n]
        path = os.path.join(VEO, clip + '.mp4')
        if os.path.exists(path):
            s = prs.slides.add_slide(blank)
            poster = os.path.join(VEO, clip + '.png')
            mv = s.shapes.add_movie(path, 0, 0, prs.slide_width, prs.slide_height, poster_frame_image=poster if os.path.exists(poster) else None, mime_type='video/mp4')
            autoplay(s, mv.shape_id); advance(s, secs); total += secs; log.append(f'{clip} {secs}s')
    secs, rec, crop, note = PLAN[n]
    slide = prs.slides.add_slide(blank)
    slide.shapes.add_picture(os.path.join(OUT, f'slide-{n:02d}.png'), 0, 0, width=prs.slide_width, height=prs.slide_height)
    if rec:
        r = RECTS[n]
        gif = recording_gif(rec, crop, (r['w'], r['h']), n)
        if gif:
            pic = slide.shapes.add_picture(gif, Emu(int(r['x'] * px)), Emu(int(r['y'] * px)), width=Emu(int(r['w'] * px)), height=Emu(int(r['h'] * px)))
            pic.auto_shape_type = MSO_SHAPE.ROUNDED_RECTANGLE
            geom = pic._element.spPr.find('{http://schemas.openxmlformats.org/drawingml/2006/main}prstGeom')
            av = geom.find('{http://schemas.openxmlformats.org/drawingml/2006/main}avLst')
            if av is None: av = etree.SubElement(geom, '{http://schemas.openxmlformats.org/drawingml/2006/main}avLst')
            etree.SubElement(av, '{http://schemas.openxmlformats.org/drawingml/2006/main}gd', name='adj', fmla='val %d' % int(14 / min(r['w'], r['h']) * 100000))
        else:
            missing.append(f'slide {n}: {rec}')
    slide.notes_slide.notes_text_frame.text = note
    advance(slide, secs); total += secs; log.append(f'{n}:{secs}s')
prs.save(dest)
print('saved', dest, f'{os.path.getsize(dest) / 1e6:.1f} MB')
print('slides', len(prs.slides), '| runs', f'{total:.1f} s', '(limit 75)' if total <= 75 else '(OVER the 75 s limit)')
print(' '.join(log))
print('recordings not found yet:', missing or 'none')
