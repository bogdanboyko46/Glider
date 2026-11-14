"""Lay a frame of the live recordings into each rendered layout variation, for review.
   python showcase/preview_variants.py [at=0.6]   -> showcase/out/variants/preview-N-vV.png
   Card 2 gets live-panel.mp4; card 3 gets live-wordlens.mp4 then live-lookalike.mp4 (in window order).
"""
import json, os, subprocess, sys
import imageio_ffmpeg
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
VAR = os.path.join(OUT, 'variants')
AT = float(sys.argv[1]) if len(sys.argv) > 1 else 0.6
CLIPS = {'2': ['live-panel.mp4'], '3': ['live-wordlens.mp4', 'live-lookalike.mp4']}
SCALE = 1.25


def frame(clip):
    path = os.path.join(OUT, clip)
    png = os.path.join(VAR, f'_{clip}.png')
    if not os.path.exists(png):
        ff = imageio_ffmpeg.get_ffmpeg_exe()
        dur = float(next(l for l in subprocess.run([ff, '-i', path], capture_output=True, text=True).stderr.splitlines() if 'Duration' in l).split('Duration:')[1].split(',')[0].split(':')[-1])
        subprocess.run([ff, '-y', '-loglevel', 'error', '-ss', str(dur * AT), '-i', path, '-frames:v', '1', png], check=True)
    return Image.open(png).convert('RGB')


rects = json.load(open(os.path.join(VAR, 'rects.json')))
for key, rs in rects.items():
    n, v = key.split('-')
    im = Image.open(os.path.join(VAR, f'card-{n}-v{v}.png')).convert('RGB')
    for clip, r in zip(CLIPS[n], rs):
        box = [round(r[k] * SCALE) for k in ('x', 'y', 'w', 'h')]
        mask = Image.new('L', box[2:], 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, box[2] - 1, box[3] - 1), radius=round(16 * SCALE), fill=255)
        im.paste(frame(clip).resize(box[2:], Image.LANCZOS), box[:2], mask)
    im.save(os.path.join(VAR, f'preview-{n}-v{v}.png'))
    print('preview', n, v)
