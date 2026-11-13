"""Turn a real-app capture (showcase/out/_real_<name>/) into showcase/out/<name>.gif using the true frame times.
   python showcase/real2gif.py r1-lens [more names]      options: --width 800
"""
import glob, json, os, sys
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
args = sys.argv[1:]
width = int(args[args.index('--width') + 1]) if '--width' in args else 800
names = [a for a in args if not a.startswith('--') and not a.isdigit()]

def frames_of(name):
    d = os.path.join(OUT, '_real_' + name)
    files = sorted(glob.glob(os.path.join(d, 'f*.png')))
    times = json.load(open(os.path.join(d, 'times.json')))
    return files, times

if __name__ == '__main__':
    for name in names:
        files, times = frames_of(name)
        frames = []
        for f in files:
            im = Image.open(f).convert('RGB')
            frames.append(im.resize((width, round(im.height * width / im.width)), Image.LANCZOS))
        durs = [max(20, times[i + 1] - times[i]) for i in range(len(times) - 1)] + [1400]
        pal = [f.quantize(colors=160, method=Image.MEDIANCUT, dither=Image.Dither.NONE) for f in frames]
        out = os.path.join(OUT, name + '.gif')
        pal[0].save(out, save_all=True, append_images=pal[1:], duration=durs, loop=0, optimize=False, disposal=1)
        Image.open(files[-1]).save(os.path.join(OUT, name + '-poster.png'))
        print(name, len(frames), 'frames', round(os.path.getsize(out) / 1e6, 2), 'MB')
