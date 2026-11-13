"""Record showcase scenes to animated GIFs (one headless browser at a time).
   python showcase/record.py s1-lens s2-tune ...     (no arguments: every s*.html)
   Output: showcase/out/<scene>.gif, <scene>-poster.png (last frame), <scene>-first.png
"""
import glob, os, shutil, subprocess, sys, time
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
# REC_FPS / REC_W override the defaults, e.g. REC_FPS=25 REC_W=1920 SHOT_SCALE=1.5 for a full-HD recording
FPS = int(os.environ.get('REC_FPS', 15))
SIZE = (int(os.environ.get('REC_W', 960)), int(os.environ.get('REC_W', 960)) * 9 // 16)

def record(name):
    src = os.path.join(HERE, name + '.html')
    frames_dir = os.path.join(OUT, '_frames_' + name)
    shutil.rmtree(frames_dir, ignore_errors=True)
    for attempt in range(8):
        r = subprocess.run(['node', os.path.join(HERE, 'shot.mjs'), src, 'all', frames_dir, str(FPS)], capture_output=True, text=True)
        if r.returncode == 3:  # another test browser is running
            time.sleep(6); continue
        break
    print(name, (r.stdout or r.stderr).strip().splitlines()[-1] if (r.stdout or r.stderr).strip() else 'no output', flush=True)
    files = sorted(glob.glob(os.path.join(frames_dir, 'f*.png')))
    if not files:
        return False
    frames = [Image.open(f).convert('RGB').resize(SIZE, Image.LANCZOS) for f in files]
    Image.open(files[-1]).save(os.path.join(OUT, name + '-poster.png'))
    Image.open(files[0]).save(os.path.join(OUT, name + '-first.png'))
    pal = [f.quantize(colors=160, method=Image.MEDIANCUT, dither=Image.Dither.NONE) for f in frames]
    # hold the last frame a little so a looping GIF does not snap back at once
    durations = [round(1000 / FPS)] * len(pal)
    durations[-1] = 1400
    pal[0].save(os.path.join(OUT, name + '.gif'), save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=False, disposal=1)
    shutil.rmtree(frames_dir, ignore_errors=True)
    print(name, 'gif', round(os.path.getsize(os.path.join(OUT, name + '.gif')) / 1e6, 2), 'MB', len(pal), 'frames', flush=True)
    return True

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    names = sys.argv[1:] or sorted(os.path.splitext(os.path.basename(p))[0] for p in glob.glob(os.path.join(HERE, 's*.html')))
    for n in names:
        record(n)
