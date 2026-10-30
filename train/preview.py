"""Save a sheet of synthetic samples (top) next to real crops (bottom) to eyeball the generator."""
import random
import sys

import numpy as np
from PIL import Image

from common import CROP_H, CROP_W, load_real, render

out = sys.argv[1] if len(sys.argv) > 1 else "preview.png"
rng = random.Random(1)
cols, s = 30, 3
synth = [render(i % 11, rng) for i in range(cols * 8)]
real, _, _ = load_real("dev")
tiles = synth + list(real[: cols * 4])
rows = (len(tiles) + cols - 1) // cols
sheet = Image.new("L", (cols * (CROP_W + 2) * s, rows * (CROP_H + 2) * s), 255)
for k, t in enumerate(tiles):
    im = Image.fromarray(255 - t).resize((CROP_W * s, CROP_H * s), Image.NEAREST)
    sheet.paste(im, ((k % cols) * (CROP_W + 2) * s, (k // cols) * (CROP_H + 2) * s))
sheet.save(out)
print("saved", out, "(synthetic rows 1-8, label = column % 11 with 10 = not a digit; real rows 9-12)")
