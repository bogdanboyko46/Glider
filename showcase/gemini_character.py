"""Generate the student character for the eye tracking card with Gemini's image model, then its eye and mood frames.
   python showcase/gemini_character.py base            -> showcase/art/char/base.jpg
   python showcase/gemini_character.py frames          -> the nine eye / mood frames and a blink, edited from base.jpg
   python showcase/gemini_character.py web             -> 640px copies in showcase/char/ for the page
   Uses GEMINI_API_KEY. Only the prompt text and the generated character picture are sent; no project files.
"""
import base64, json, os, sys, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ART = os.path.join(HERE, 'art', 'char')
MODEL = 'gemini-3-pro-image'

BASE = ('A head-and-shoulders portrait of a friendly teenage student character, about 14 years old, in the polished style of a modern animated film: '
        'smooth soft shading, clean shapes, appealing proportions, large expressive eyes with clearly visible whites and dark irises. '
        'Warm light-brown skin that is exactly the same tone on the face, ears and neck. Natural, slightly tousled short dark brown hair with soft highlights. '
        'A deep forest green crew-neck sweater. Facing the viewer straight on, head level, as seen by a laptop webcam, eyes looking straight ahead at the screen, '
        'calm neutral expression with a closed relaxed mouth. Centred, the whole head and both shoulders inside the frame with space above the hair. '
        'Plain flat pale sage green background (#b9cdb4), soft even studio light, no shadows on the background. '
        'High resolution, crisp, very clean. No text, no letters, no logos, no glasses, no headphones, no hands, nothing drawn over the face.')
KEEP = (' Keep everything else exactly identical to the input picture: the same character, face shape, skin tone, hair, sweater, pose, framing, lighting, '
        'style and plain sage background, pixel for pixel. Do not move or resize the head. No text, nothing drawn over the face.')
LOOK = {'l': 'looking toward the left edge of the picture', 'c': 'looking straight ahead', 'r': 'looking toward the right edge of the picture'}
MOOD = {
    'n': 'The expression stays calm and neutral.',
    's': 'Change the expression to mildly puzzled and stuck: the eyebrows drawn slightly together and lowered, a small crooked closed mouth, slight squint. Subtle, not exaggerated.',
    'h': 'Change the expression to quiet relief: eyebrows relaxed and slightly raised, a small warm closed-mouth smile. Subtle, not exaggerated.',
}

def call(parts, size='2K'):
    key = os.environ['GEMINI_API_KEY']
    cfg = {'responseModalities': ['IMAGE'], 'imageConfig': {'aspectRatio': '1:1'}}
    if size: cfg['imageConfig']['imageSize'] = size
    req = urllib.request.Request(f'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent?key={key}',
                                 data=json.dumps({'contents': [{'parts': parts}], 'generationConfig': cfg}).encode(), headers={'Content-Type': 'application/json'})
    try:
        data = json.load(urllib.request.urlopen(req, timeout=240))
    except urllib.error.HTTPError as e:
        msg = e.read().decode()[:300]
        if size: return call(parts, None)          # retry once without an explicit size
        raise RuntimeError(f'HTTP {e.code} {msg}')
    for part in data.get('candidates', [{}])[0].get('content', {}).get('parts', []):
        blob = part.get('inlineData') or part.get('inline_data')
        if blob: return base64.b64decode(blob['data'])
    raise RuntimeError('no image in reply: ' + json.dumps(data)[:300])

def save(name, raw):
    os.makedirs(ART, exist_ok=True)
    out = os.path.join(ART, name + '.jpg')
    from PIL import Image
    import io
    Image.open(io.BytesIO(raw)).convert('RGB').save(out, quality=94)
    print(name, 'saved', round(os.path.getsize(out) / 1e6, 2), 'MB', flush=True)

def frame(name, instruction):
    src = base64.b64encode(open(os.path.join(ART, 'base.jpg'), 'rb').read()).decode()
    try:
        save(name, call([{'inlineData': {'mimeType': 'image/jpeg', 'data': src}}, {'text': instruction + KEEP}]))
    except Exception as e:
        print(name, 'FAILED', e, flush=True)

if __name__ == '__main__':
    what = sys.argv[1]
    if what == 'base':
        save('base', call([{'text': BASE}]))
    elif what == 'frames':
        jobs = []
        for m, mood in MOOD.items():
            for d, look in LOOK.items():
                if m == 'n' and d == 'c': continue      # that is the base picture itself
                jobs.append((f'{m}-{d}', f'Edit this picture: change only the eyes so the irises are {look} (the head does not turn). {mood}'))
        jobs.append(('blink', 'Edit this picture: change only the eyes so that both eyelids are gently closed, as in the middle of a blink. The expression stays calm and neutral.'))
        only = sys.argv[2:]
        if only: jobs = [j for j in jobs if j[0] in only]
        with ThreadPoolExecutor(4) as ex: list(ex.map(lambda j: frame(*j), jobs))
    elif what == 'web':
        from PIL import Image
        out = os.path.join(HERE, 'char'); os.makedirs(out, exist_ok=True)
        for f in sorted(os.listdir(ART)):
            name = 'n-c.jpg' if f == 'base.jpg' else f
            Image.open(os.path.join(ART, f)).convert('RGB').resize((640, 640), Image.LANCZOS).save(os.path.join(out, name), quality=88)
            print('web', name, flush=True)
