"""
Draws the WorldView application icon and writes apps/desktop/build/icon.png (512 px) and
icon.ico (16–256 px), the files electron-builder embeds in WorldView.exe and the installer.

An original mark in the app's own palette: a globe (teal, the map's vessel colour) with an
equator and meridians, crossed by a tilted orbit (violet, the satellite colour) carrying
one bright point. Drawn at 4096 px and downsampled, so every size is antialiased.

    python3 tools/dev/icon/make-icon.py        # needs Pillow
"""
import math
import os
from PIL import Image, ImageDraw

S = 4096
BG = (11, 18, 32, 255)          # --wv-bg family, a deep navy
RIM = (30, 41, 59, 255)
GLOBE = (45, 212, 191, 255)     # vessel teal (#2dd4bf)
GLOBE_FILL = (13, 42, 52, 255)
ORBIT = (167, 139, 250, 255)    # satellite violet (#a78bfa)
POINT = (240, 249, 255, 255)

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Rounded-square tile.
pad = int(S * 0.04)
d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=int(S * 0.22), fill=BG, outline=RIM, width=int(S * 0.012))

cx, cy = S / 2, S / 2
r = S * 0.30
w = int(S * 0.034)

# Globe disc, then its outline, equator and two meridians.
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GLOBE_FILL)
thin = int(w * 0.62)
d.line([cx - r, cy, cx + r, cy], fill=GLOBE, width=thin)
d.line([cx, cy - r, cx, cy + r], fill=GLOBE, width=thin)
d.ellipse([cx - r * 0.56, cy - r, cx + r * 0.56, cy + r], outline=GLOBE, width=thin)
d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=GLOBE, width=w)

# A tilted orbit around the globe, drawn as a rotated ellipse on its own layer.
orbit = Image.new('RGBA', (S, S), (0, 0, 0, 0))
od = ImageDraw.Draw(orbit)
a, b = S * 0.43, S * 0.14
od.ellipse([cx - a, cy - b, cx + a, cy + b], outline=ORBIT, width=int(w * 0.8))
# The part of the orbit behind the globe is hidden: mask the back half inside the disc.
mask = Image.new('L', (S, S), 0)
md = ImageDraw.Draw(mask)
md.rectangle([0, 0, S, cy], fill=255)          # upper half of the (unrotated) ellipse = far side
md.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
back = Image.new('L', (S, S), 0)
ImageDraw.Draw(back).rectangle([0, 0, S, cy], fill=255)
inside = Image.new('L', (S, S), 0)
ImageDraw.Draw(inside).ellipse([cx - r * 1.02, cy - r * 1.02, cx + r * 1.02, cy + r * 1.02], fill=255)
hide = Image.composite(inside, Image.new('L', (S, S), 0), back)  # far side ∩ disc
alpha = orbit.getchannel('A')
alpha = Image.composite(Image.new('L', (S, S), 0), alpha, hide)
orbit.putalpha(alpha)
# The satellite: on the near side, lower right of the orbit.
t = math.radians(35)
px, py = cx + a * math.cos(t), cy + b * math.sin(t)
pr = S * 0.045
od = ImageDraw.Draw(orbit)
od.ellipse([px - pr * 1.6, py - pr * 1.6, px + pr * 1.6, py + pr * 1.6], fill=(167, 139, 250, 110))
od.ellipse([px - pr, py - pr, px + pr, py + pr], fill=POINT)
orbit = orbit.rotate(-24, resample=Image.BICUBIC, center=(cx, cy))
img = Image.alpha_composite(img, orbit)

root = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
out = os.path.join(root, 'apps', 'desktop', 'build')
os.makedirs(out, exist_ok=True)
img.resize((512, 512), Image.LANCZOS).save(os.path.join(out, 'icon.png'), optimize=True)
sizes = [16, 24, 32, 48, 64, 128, 256]
img.resize((256, 256), Image.LANCZOS).save(os.path.join(out, 'icon.ico'), sizes=[(s, s) for s in sizes])
print('wrote', os.path.join(out, 'icon.png'), 'and icon.ico')
