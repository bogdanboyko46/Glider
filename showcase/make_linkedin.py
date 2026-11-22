"""One tall (4:5) video for a LinkedIn post: the opening, the live showcase, then the opening's end card.
   python showcase/make_linkedin.py [out.mp4]      -> showcase/out/glider-linkedin.mp4 (1080 x 1350, 60 fps) and its poster

   Needs: out/t2-gemini.mp4 (record_mp4.py t2-gemini) and out/live-showcase.mp4, filmed tall:
     LIVE_W=720 LIVE_H=822 LIVE_DSF=1.5 GLIDER_DSF=1.5 LIVE_PAGE=/demo/hard-reading.html node showcase/live-capture.mjs showcase
     python showcase/quick2media.py showcase --no-captions --speed 1.3 --fps 60 --address example.com/tenancy-agreement
   The opening is a 16:9 scene: it sits in the middle of the tall frame on its own background colour.
"""
import os, re, subprocess, sys
import imageio_ffmpeg
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
FF = imageio_ffmpeg.get_ffmpeg_exe()
OPEN, SHOW = os.path.join(OUT, 't2-gemini.mp4'), os.path.join(OUT, 'live-showcase.mp4')
dest = next((a for a in sys.argv[1:] if a.endswith('.mp4')), os.path.join(OUT, 'glider-linkedin.mp4'))
FADE = 0.4                  # seconds of cross-fade at each join
A_END = 5.5                 # the opening up to here: the sentence has opened, the word lens has come and gone
C0, C1 = 5.9, 9.6           # then, after the showcase, the rest of it: "Glider" and its mark


def seconds(path):
    err = subprocess.run([FF, '-i', path], capture_output=True, text=True).stderr
    h, m, s = re.search(r'Duration: (\d+):(\d+):([\d.]+)', err).groups()
    return int(h) * 3600 + int(m) * 60 + float(s)


probe = os.path.join(OUT, '_open0.png')
TO_RGB = 'scale=1080:-2:flags=lanczos:in_color_matrix=bt709,format=gbrp'   # the opening, at the frame's width, as RGB
subprocess.run([FF, '-y', '-loglevel', 'error', '-i', OPEN, '-vf', TO_RGB, '-frames:v', '1', probe], check=True)
colour = '0x%02X%02X%02X' % Image.open(probe).convert('RGB').getpixel((8, 8))   # the opening's background, exactly as it decodes: the bands above and below must not show
os.remove(probe)
show = seconds(SHOW)
off1 = A_END - FADE
off2 = off1 + show - FADE
fc = (f'[0:v]{TO_RGB},crop=iw:ih-4:0:2,pad=1080:1350:0:372:color={colour},split[o1][o2];'   # the scaled scene's outermost rows come out a shade off: trim them
      f'[o1]trim=0:{A_END},setpts=PTS-STARTPTS,fps=60,settb=AVTB[a];'
      f'[o2]trim={C0}:{C1},setpts=PTS-STARTPTS,fps=60,settb=AVTB[c];'
      f'[1:v]format=gbrp,setpts=PTS-STARTPTS,fps=60,settb=AVTB[b];'
      f'[a][b]xfade=transition=fade:duration={FADE}:offset={off1:.3f}[ab];'
      f'[ab][c]xfade=transition=fade:duration={FADE}:offset={off2:.3f},scale=out_color_matrix=bt709,format=yuv420p[v]')
subprocess.run([FF, '-y', '-loglevel', 'error', '-i', OPEN, '-i', SHOW, '-filter_complex', fc, '-map', '[v]', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
                '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', '-r', '60', dest], check=True)
subprocess.run([FF, '-y', '-loglevel', 'error', '-ss', f'{off1 + 9:.2f}', '-i', dest, '-frames:v', '1', dest[:-4] + '-poster.png'], check=True)
print(f'saved {dest} | background {colour} | showcase {show:.1f} s | runs {seconds(dest):.1f} s | {os.path.getsize(dest) / 1e6:.2f} MB')
