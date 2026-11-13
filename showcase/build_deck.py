"""Build the Glider showcase deck.
   python showcase/build_deck.py [out.pptx] [--title b] [--lens b] [--tune b] [--word b] [--finale b]

   Product shots are the frame-accurate recordings in showcase/out/*.gif.
   Cinematic shots are Veo clips dropped in showcase/veo/ as vA.mp4, vB.mp4, vC.mp4; a slide whose clip
   is missing falls back to a recorded card (A) or is left out (B, C).
   Every slide advances by itself. The total running time is printed; the limit is 75 seconds.
"""
import os, sys
from lxml import etree
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor

HERE = os.path.dirname(os.path.abspath(__file__))
OUT, VEO = os.path.join(HERE, 'out'), os.path.join(HERE, 'veo')
args = sys.argv[1:]
alt = lambda name, base: base + '-b' if (name in args and args[args.index(name) + 1:args.index(name) + 2] == ['b']) else base
dest = next((a for a in args if a.endswith('.pptx')), os.path.join(HERE, 'Glider-showcase.pptx'))
HOLD = 0.6   # recorded GIFs hold their last frame 1.4 s; move on before they loop

N = {
    'title': 'Glider is a Chrome extension for students with dyslexia. It reshapes any web page so it is easier to read, and steps in when you get stuck.',
    'problem': 'Course pages and articles are built for fast readers: tight lines, long words, no way to slow the page down.',
    'what': 'One switch. It works on the pages students already use, with no account and nothing to set up.',
    'lens': 'Turn the lens on and the page opens up: more space between letters, words and lines, and the start of each word in bold. Turn it off and the page is exactly as it was.',
    'tune': 'Glider sits at the edge of the screen. Press the mark to switch the lens; press the power button beside it to set size and spacing.',
    'word': 'Hover a long word and it breaks into chunks, each with the sound it makes written underneath. Tap a chunk to hear it, or have the whole word sounded out.',
    'look': 'Words that are easy to mix up get a quiet underline. Hover one and each word in the group shows a few-word meaning.',
    'eyes': 'With eye tracking on, Glider learns your normal pace from a short calibration.',
    'stuck': 'When your eyes linger on the same lines well past your pace, Glider knows where the trouble is. The gaze dot in this recording is a simulation of the tracker signal.',
    'simple': 'Those lines are shown again in plainer words, right where you are reading. Showing it automatically is a setting; by default Glider offers it first. The page itself is not changed.',
    'glide': 'Reading at your own pace.',
    'close': 'The lens, the word help and the eye tracking run in the browser. Glider is free to try today.',
}
# kind, source, seconds, note key, caption
PLAN = [
    ('gif', alt('--title', 's0-title'), 4.0, 'title', None),
    ('veo', 'vA', 4.0, 'problem', 'The web is dense.'),
    ('gif', 'sb-what', 4.0, 'what', None),
    ('gif', alt('--lens', 's1-lens'), 7.0, 'lens', None),
    ('gif', alt('--tune', 's2-tune'), 7.0, 'tune', None),
    ('gif', alt('--word', 's3-wordlens'), 7.0, 'word', None),
    ('gif', 's4-lookalike', 6.0, 'look', None),
    ('veo', 'vB', 4.0, 'eyes', None),
    ('gif', 's5-stuck', 8.0, 'stuck', None),
    ('gif', alt('--finale', 's6-simplify'), 8.5, 'simple', None),
    ('veo', 'vC', 3.0, 'glide', None),
    ('gif', 's9-close', 4.0, 'close', None),
]
FALLBACK = {'vA': ('sa-problem', 4.0)}   # recorded card used while a Veo clip is missing

P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
def autoplay(slide, spid):
    """Make the video on this slide start by itself (what PowerPoint writes for Start: Automatically)."""
    old = slide._element.find('{%s}timing' % P)
    if old is not None: slide._element.remove(old)
    xml = f'''<p:timing xmlns:p="{P}"><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst>
      <p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>
        <p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst><p:childTnLst>
          <p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>
            <p:par><p:cTn id="5" presetID="1" presetClass="mediacall" presetSubtype="0" fill="hold" nodeType="afterEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>
              <p:cmd type="call" cmd="playFrom(0.0)"><p:cBhvr><p:cTn id="6" dur="1" fill="hold"/><p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cBhvr></p:cmd>
            </p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>
      </p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq>
      <p:video><p:cMediaNode vol="0" mute="1"><p:cTn id="7" fill="hold" display="0"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst></p:cTn><p:tgtEl><p:spTgt spid="{spid}"/></p:tgtEl></p:cMediaNode></p:video>
    </p:childTnLst></p:cTn></p:par></p:tnLst></p:timing>'''
    slide._element.append(etree.fromstring(xml))

prs = Presentation()
prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
blank = prs.slide_layouts[6]
total, used, skipped = 0.0, [], []
for kind, src, secs, key, caption in PLAN:
    video = os.path.join(VEO, src + '.mp4')
    if kind == 'veo' and not os.path.exists(video):
        if src in FALLBACK: kind, (src, secs), caption = 'gif', FALLBACK[src], None
        else: skipped.append(src); continue
    slide = prs.slides.add_slide(blank)
    bg = slide.background.fill; bg.solid(); bg.fore_color.rgb = RGBColor(0xEE, 0xF2, 0xEA)
    if kind == 'gif':
        gif = os.path.join(OUT, src + '.gif')
        if not os.path.exists(gif): skipped.append(src + ' (no recording)'); continue
        slide.shapes.add_picture(gif, 0, 0, width=prs.slide_width, height=prs.slide_height)
        wait = secs + HOLD
    else:
        poster = os.path.join(VEO, src + '.png')
        movie = slide.shapes.add_movie(video, 0, 0, prs.slide_width, prs.slide_height, poster_frame_image=poster if os.path.exists(poster) else None, mime_type='video/mp4')
        autoplay(slide, movie.shape_id)
        if caption:
            box = slide.shapes.add_textbox(Inches(.8), Inches(5.6), Inches(9), Inches(1.2))
            run = box.text_frame.paragraphs[0].add_run(); run.text = caption
            run.font.size, run.font.bold, run.font.name = Pt(54), True, 'Segoe UI'
            run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        wait = secs
    slide.notes_slide.notes_text_frame.text = N[key]
    tr = etree.Element('{%s}transition' % P, spd='med', advClick='1', advTm=str(int(wait * 1000)))
    etree.SubElement(tr, '{%s}fade' % P)
    anchor = slide._element.find('{%s}clrMapOvr' % P)
    (anchor if anchor is not None else slide._element.find('{%s}cSld' % P)).addnext(tr)
    total += wait; used.append(f'{src} {wait:.1f}s')
prs.save(dest)
print('saved', dest, f'{os.path.getsize(dest) / 1e6:.1f} MB')
print('slides', len(used), '| runs', f'{total:.1f} s', '(limit 75)' if total <= 75 else '(OVER the 75 s limit)')
print(' | '.join(used))
print('left out:', skipped or 'nothing')
