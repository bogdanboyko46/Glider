"""Ask Gemini to revise the opening scene (t2-opens.html) to the owner's notes.
   python showcase/gemini_title.py [feedback.txt [picture.png ...]]     -> writes showcase/t2-gemini.html
   Uses GEMINI_API_KEY. Sends: the scene file, base.css, and a dump of the real word lens's markup and styles.
   With a feedback file, it sends Gemini its own previous output plus the feedback and asks for a corrected file.
"""
import base64, io, json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
rd = lambda p: io.open(os.path.join(HERE, p), encoding='utf-8').read()
MODEL = 'gemini-3.1-pro-preview'
dump = json.load(open(os.path.join(HERE, 'out', '_lens-dump.json'), encoding='utf-8'))

BRIEF = f'''You are editing one animated title slide for a product called Glider, a reading lens for dyslexic readers. The slide opens a live demo in front of 200 people.

Below is the current scene file (t2-opens.html), the stylesheet it links (base.css), and an exact dump of the shipped product's "word lens" popup as it renders for the word "should".

KEEP EXACTLY AS IT IS
- The first frame: the sentence "Reading should not be this much work." in Georgia, 86px, at left 110px / top 200px, starting cramped and grey with the same starting letter-spacing, word-spacing and line-height as the current file. Same position, same compression.
- The page size (1280 x 720), the sage background, base.css, and the end card layout: the word "Glider" huge at left, a motto line under it, five logo strokes reaching in from the right edge with the middle one green.
- The recording contract: <html data-duration="NNNN"> in milliseconds; ALL motion is CSS @keyframes animations sequenced with animation-delay and animation-fill-mode: both. No JavaScript timers, no requestAnimationFrame, no transitions triggered by script, no external resources. The only script allowed is static set-up that runs once at load (the current file uses one to wrap word starts in <b>).

CHANGE
1. The opened state must be the product's real formatting. In the product, word starts are bold by this rule: 1 letter for words of 1-3 letters, 2 letters for 4-5 letters, otherwise ceil(40% of the letters). End state of the sentence: letter-spacing 0.073em, word-spacing 0.24em, line-height 1.9, colour #20352a, word starts font-weight 700.
2. Everything changes in ONE motion. In the current file the spacing opens first and the bold starts pop afterwards; instead the bold word starts must arrive during the same single smooth opening (about 1.2s, same easing family), with no second beat and nothing snapping at the end. Georgia has no intermediate weights, so bring the bold in gracefully inside that same motion (for example by cross-fading a regular and a bold copy of each word start, or another technique you judge cleaner) rather than switching weight at the end.
3. After the sentence has opened, a pointer (an SVG arrow like a mouse cursor, dark green #20352a with a white outline) glides in and rests on the word "should". The word gets the product's hover highlight (background rgba(255, 216, 77, 0.45), small radius), and the product's word lens appears just above the word, growing out of the word (transform-origin at the bottom centre, a quick scale and fade of about 0.25s). Rebuild that lens faithfully in static HTML and CSS from the dump below: same structure, colours, radii, shadows, type sizes and weights, the "Easy to read" chip with its green dot, the outlined "A1" tag, the single chunk pill "should" over "shuud", and the two buttons "Hear word" (filled, with a speaker icon) and "Meaning" (outlined, with an open-book icon). The dump was measured where the sentence was 41px; this slide's sentence is 86px, so scale every lens dimension by 2.1 so the lens has the same size relative to the text. Hold the lens for about 2 seconds, then the pointer leaves and the lens fades.
4. Then the sentence lifts away and the end card plays as now, with these differences: remove any rule or line under "Glider"; the motto is: Made with <b>dyslexia</b> in mind.
5. Total length at most 10 seconds. Set data-duration to match.

QUALITY
- It must look clean and smooth at high resolution: no layout jumps, no text reflowing mid-animation other than the sentence opening itself, no overlapping text, nothing clipped at the edges of 1280 x 720. The sentence wraps onto two lines when opened; make sure the lens and pointer land on "should" where it actually is in the opened layout (first line, second word).
- Do not use the words or look of a generic template. No emoji, no exclamation marks.

OUTPUT
Return the complete revised HTML file and nothing else: no explanation, no markdown fences.

===== t2-opens.html =====
{rd('t2-opens.html')}

===== base.css =====
{rd('base.css')}

===== REAL WORD LENS, element tree with computed styles (sizes in CSS px at 41px sentence text; positions are in a 640 x 360 viewport and are only for relative layout) =====
{dump['tree']}

===== REAL WORD LENS, inner HTML (icons are inline SVG; reuse their paths) =====
{dump['html']}

===== THE WORD BEING HOVERED =====
highlight background {dump['word']['background']}, border-radius {dump['word']['radius']} at 41px text (scale by 2.1)
'''

def ask(parts, images=()):
    img = [{'inline_data': {'mime_type': 'image/png', 'data': base64.b64encode(open(f, 'rb').read()).decode()}} for f in images]
    body = {'contents': [{'role': 'user', 'parts': [{'text': p} for p in parts] + img}], 'generationConfig': {'temperature': 0.4}}
    req = urllib.request.Request(f'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={os.environ["GEMINI_API_KEY"]}',
                                 data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    try:
        data = json.load(urllib.request.urlopen(req, timeout=600))
    except urllib.error.HTTPError as e:
        print('HTTP', e.code, e.read().decode()[:400]); sys.exit(1)
    text = ''.join(p.get('text', '') for p in data['candidates'][0]['content']['parts'])
    text = re.sub(r'^\s*```(?:html)?\s*', '', text); text = re.sub(r'\s*```\s*$', '', text)
    return text.strip() + '\n', data.get('usageMetadata', {})

if __name__ == '__main__':
    parts = [BRIEF]
    if len(sys.argv) > 1:
        parts += ['===== YOUR PREVIOUS OUTPUT (t2-gemini.html) =====\n' + rd('t2-gemini.html'),
                  '===== REVIEW OF THE RENDERED RESULT: fix these and return the complete corrected file, nothing else =====\n' + io.open(sys.argv[1], encoding='utf-8').read()]
    html, usage = ask(parts, sys.argv[2:])   # any further arguments are PNG pictures sent along with the review
    io.open(os.path.join(HERE, 't2-gemini.html'), 'w', encoding='utf-8', newline='\n').write(html)
    print('wrote t2-gemini.html', len(html), 'chars; model', MODEL, '; tokens', usage.get('promptTokenCount'), '->', usage.get('candidatesTokenCount'))
