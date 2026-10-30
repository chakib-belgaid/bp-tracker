"""Show the real-dev digits the current weights get wrong (crop sheet + list)."""
import sys

import numpy as np
import torch
from PIL import Image

from common import CROP_H, CROP_W, DigitNet, load_real, to_tensor
import weights_io

split = sys.argv[1] if len(sys.argv) > 1 else "dev"
out = sys.argv[2] if len(sys.argv) > 2 else "misses.png"
model = weights_io.load_model()
x, y, meta = load_real(split)
with torch.no_grad():
    p = torch.softmax(model(to_tensor(x)), 1).numpy()
pred = p.argmax(1)
bad = np.where(pred != y)[0]
s = 4
sheet = Image.new("L", (max(1, len(bad)) * (CROP_W + 2) * s, (CROP_H + 2) * s), 255)
for k, i in enumerate(bad):
    sheet.paste(Image.fromarray(255 - x[i]).resize((CROP_W * s, CROP_H * s), Image.NEAREST), (k * (CROP_W + 2) * s, 0))
    m = meta[i]
    print(f"{k:2d} want {y[i]} got {pred[i]} ({p[i, pred[i]]:.2f})  {m['source']} {m['row']}#{m['pos']}  7-bar said {m['ocr']}")
sheet.save(out)
print(f"{len(bad)} misses of {len(y)} -> {out}")
