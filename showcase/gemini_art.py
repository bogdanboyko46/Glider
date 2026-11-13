"""Generate text-free slide backgrounds with Gemini's image model.
   python showcase/gemini_art.py <name> "<prompt>" [--model gemini-3-pro-image]
   Uses GEMINI_API_KEY from the environment. Writes showcase/art/<name>.png
   Only the prompt text is sent; no project files.
"""
import base64, json, os, sys, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
STYLE = (' Wide 16:9 background image for a presentation slide. Abstract and calm, premium editorial look. '
         'Colour palette limited to pale sage green, warm cream, soft white and a little deep forest green. '
         'Soft natural light, subtle paper grain. Absolutely no text, no letters, no numbers, no logos, no user interface, no people.')

def make(name, prompt, model='gemini-3-pro-image'):
    key = os.environ['GEMINI_API_KEY']
    body = {'contents': [{'parts': [{'text': prompt + STYLE}]}],
            'generationConfig': {'responseModalities': ['IMAGE'], 'imageConfig': {'aspectRatio': '16:9'}}}
    req = urllib.request.Request(f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}',
                                 data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    try:
        data = json.load(urllib.request.urlopen(req, timeout=180))
    except urllib.error.HTTPError as e:
        print(name, 'HTTP', e.code, e.read().decode()[:300]); return False
    for part in data.get('candidates', [{}])[0].get('content', {}).get('parts', []):
        blob = part.get('inlineData') or part.get('inline_data')
        if blob:
            os.makedirs(os.path.join(HERE, 'art'), exist_ok=True)
            ext = 'jpg' if 'jpeg' in blob.get('mimeType', blob.get('mime_type', '')) else 'png'
            out = os.path.join(HERE, 'art', f'{name}.{ext}')
            open(out, 'wb').write(base64.b64decode(blob['data']))
            print(name, 'saved', out, round(os.path.getsize(out) / 1e6, 2), 'MB'); return True
    print(name, 'no image in reply:', json.dumps(data)[:300]); return False

if __name__ == '__main__':
    a = sys.argv[1:]
    model = a[a.index('--model') + 1] if '--model' in a else 'gemini-3-pro-image'
    make(a[0], a[1], model)
