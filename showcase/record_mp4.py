"""Record one showcase scene as a full-HD 60 fps MP4 (H.264), for slides that need really smooth motion.
   python showcase/record_mp4.py t2-gemini      -> showcase/out/<scene>.mp4 and <scene>-poster.png / -first.png
   Uses the ffmpeg binary bundled with the imageio-ffmpeg package. One headless browser at a time.
"""
import glob, os, shutil, subprocess, sys, time
import imageio_ffmpeg

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
FPS = 60

def record(name):
    frames = os.path.join(OUT, '_frames_' + name)
    shutil.rmtree(frames, ignore_errors=True)
    env = dict(os.environ, SHOT_SCALE='1.5')
    for _ in range(10):
        r = subprocess.run(['node', os.path.join(HERE, 'shot.mjs'), os.path.join(HERE, name + '.html'), 'all', frames, str(FPS)], capture_output=True, text=True, env=env)
        if r.returncode == 3: time.sleep(8); continue
        break
    print((r.stdout or r.stderr).strip().splitlines()[-1], flush=True)
    files = sorted(glob.glob(os.path.join(frames, 'f*.png')))
    if not files: return
    shutil.copy(files[-1], os.path.join(OUT, name + '-poster.png')); shutil.copy(files[0], os.path.join(OUT, name + '-first.png'))
    out = os.path.join(OUT, name + '.mp4')
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-y', '-loglevel', 'error', '-framerate', str(FPS), '-i', os.path.join(frames, 'f%04d.png'),
                    '-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
                    '-movflags', '+faststart', out], check=True)
    shutil.rmtree(frames, ignore_errors=True)
    print(name, 'mp4', round(os.path.getsize(out) / 1e6, 2), 'MB', len(files), 'frames at', FPS, 'fps', flush=True)

if __name__ == '__main__':
    for n in sys.argv[1:]: record(n)
