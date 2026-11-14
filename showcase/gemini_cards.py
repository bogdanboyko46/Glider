"""Ask Gemini to redesign the layouts of cards 2 and 3 (the live-footage slides) as several variations.
   python showcase/gemini_cards.py [feedback.txt]     -> writes showcase/cards-gemini.html  (open ?n=2&v=1 .. ?n=3&v=3)
   Uses GEMINI_API_KEY. Sends: cards.html, base.css, and pictures of the deck as it is (slides 1 to 5).
   The pictures are read from the scratch folder given in SLIDES (default showcase/out/_slides).
"""
import base64, glob, io, json, os, re, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
rd = lambda p: io.open(os.path.join(HERE, p), encoding='utf-8').read()
MODEL = 'gemini-3.1-pro-preview'
SLIDES = os.environ.get('SLIDES', os.path.join(HERE, 'out', '_slides'))

BRIEF = f'''You are redesigning two slides of a five-slide presentation for Glider, a Chrome extension made with dyslexia in mind. The deck is shown at a hackathon in front of judges.

Pictures attached, in order: s1 (the opening slide, end frame), s2 and s3 (the two slides you are redesigning, as they are now), s4 (eye-tracking slide, a full-screen recording) and s5 (the closing slide).

The look of the deck is set by slides 1 and 5: a plain sage background (#eef2ea), one big Lexend headline in dark green (#20352a), a single quiet supporting line, generous empty space, and the Glider mark (five rounded horizontal strokes, right-aligned, the middle one longer and green #2f6b4a). Calm, confident, nothing extra.

THE PROBLEM with slides 2 and 3 as they are now: the empty space is filled with small add-ons that look odd and cluttered: the short dash + label tags ("Colour b d p q", "Hyperlegible font", "Size and spacing", "Hear any word", "Words that look alike"), the "Filmed live: the real extension on a course page" notes in the corners, and on slide 3 a stray fragment of the logo strokes peeking out next to the lower window. Remove all of these. The owner does not want little labels floating in the white space.

WHAT EACH SLIDE MUST KEEP
- Slide 2: headline "Lines stop crowding you." and ONE browser window (a live screen recording is laid into it later).
- Slide 3: headline "Help with the hard words." and TWO browser windows (two live recordings).
- At most one short supporting sentence per slide, in the muted colour (#566b5c). You may rewrite it, plainly, in the voice of slides 1 and 5. Slide 2 is about Glider making the page easier to read: colours that tell b d p q apart, a more readable font, and size and spacing set to suit you. Slide 3 is about resting on a hard word: Glider says how hard it is to read, splits it into chunks you can hear, sounds it out and gives its meaning; look-alike words like affect and effect get a quick meaning each.
- You may use the Glider mark as a quiet design element if it fits the look of slides 1 and 5, but deliberately and whole, never as a clipped fragment.

THE WINDOWS (contract with the build script, keep exactly)
- Each window is an empty <div class="screen"> positioned absolutely. Its height must be width * 624 / 736 (the recordings' shape), rounded. The recording, which already includes its own browser top bar, is pasted into that box with 16px rounded corners, so draw no browser bar yourself and put nothing inside the box.
- Windows must lie fully inside the 1280 x 720 page with at least 24px to spare at every edge, and must not cover any text. On slide 3 the two windows may overlap each other.
- The windows should be as large as the layout allows: the footage is the proof that the product is real, and small text in it must stay legible. Slide 2's window should be at least 600px wide; slide 3's at least 470px wide each.
- Keep the existing script mechanism: collect every window rectangle {{x, y, w, h}} in order and write JSON.stringify(rects) to document.body.dataset.rects at the end.

VARIATIONS
Make THREE clearly different layouts for each slide, selected by the URL query: ?n=2 or ?n=3 and v=1, 2 or 3. For example (your call, but make them genuinely different compositions, all in the deck's look):
- v=1: headline and one line stacked on one side, the window(s) large on the other.
- v=2: headline centred or across the top, window(s) centred below, very symmetric and quiet.
- v=3: a bolder editorial composition, e.g. a very large headline, windows overlapping or offset, the Glider mark used as an anchor.
Slides 2 and 3 with the same v should feel like a pair (same system), and every variation must sit naturally between slides 1 and 4/5.

RULES
- 1280 x 720 page, link base.css, fonts from base.css only (Lexend for headlines, Atkinson for body). No external resources, no images, no emoji, no animation (these are still backgrounds).
- Nothing clipped at the page edge, no overlapping text, no text over a window.

OUTPUT
Return the complete HTML file (one file holding all six layouts) and nothing else: no explanation, no markdown fences.

===== current cards.html =====
{rd('cards.html')}

===== base.css =====
{rd('base.css')}
'''


def api_key():
    """The key as saved for the user (setx), so a newly set key works without restarting the app; else the process's own."""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment') as k:
            return winreg.QueryValueEx(k, 'GEMINI_API_KEY')[0].strip()
    except Exception:
        return os.environ['GEMINI_API_KEY'].strip()


def ask(parts, images=()):
    img = [{'inline_data': {'mime_type': 'image/png', 'data': base64.b64encode(open(f, 'rb').read()).decode()}} for f in images]
    body = {'contents': [{'role': 'user', 'parts': [{'text': p} for p in parts] + img}], 'generationConfig': {'temperature': 0.7}}
    req = urllib.request.Request(f'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent',
                                 data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'x-goog-api-key': api_key()})
    try:
        data = json.load(urllib.request.urlopen(req, timeout=600))
    except urllib.error.HTTPError as e:
        print('HTTP', e.code, e.read().decode()[:400]); sys.exit(1)
    text = ''.join(p.get('text', '') for p in data['candidates'][0]['content']['parts'])
    text = re.sub(r'^\s*```(?:html)?\s*', '', text); text = re.sub(r'\s*```\s*$', '', text)
    return text.strip() + '\n', data.get('usageMetadata', {})


if __name__ == '__main__':
    parts = [BRIEF]
    pics = [os.path.join(SLIDES, f) for f in ('s1b.png', 's2a.png', 's3a.png', 's4a.png', 's5b.png')]
    if len(sys.argv) > 1:
        parts += ['===== YOUR PREVIOUS OUTPUT (cards-gemini.html) =====\n' + rd('cards-gemini.html'),
                  '===== REVIEW OF THE RENDERED RESULT: fix these and return the complete corrected file, nothing else =====\n' + io.open(sys.argv[1], encoding='utf-8').read()]
        pics += sys.argv[2:]
    html, usage = ask(parts, pics)
    io.open(os.path.join(HERE, 'cards-gemini.html'), 'w', encoding='utf-8', newline='\n').write(html)
    print('wrote cards-gemini.html', len(html), 'chars; model', MODEL, '; tokens', usage.get('promptTokenCount'), '->', usage.get('candidatesTokenCount'))
