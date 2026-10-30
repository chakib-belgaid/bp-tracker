"""Shared pieces: crop format, synthetic seven-segment renderer, model, real-data loader."""
from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageDraw, ImageFilter
from torch import nn

# Crop format (keep in sync with train/export_real.mjs and digitnet.js): the digit cell is
# padded by 15% on every side and resized to CROP_W x CROP_H. Pixels are an "ink map":
# 0 = background, 255 = darkest ink, independent of the backlight colour.
CROP_W, CROP_H = 24, 32  # both divisible by 8: three 2x2 pools drop no pixels
PAD = 0.15
NOT_DIGIT = 10
NUM_CLASSES = 11
HERE = Path(__file__).parent

# segments: a b c d e f g
DIGIT_SEGS = {
    0: "1111110", 1: "0110000", 2: "1101101", 3: "1111001", 4: "0110011",
    5: "1011011", 6: "1011111", 7: "1110000", 8: "1111111", 9: "1111011",
}
# displays differ on the optional tails of 6 (a), 7 (f) and 9 (d)
VARIANTS = {6: ["0011111"], 7: ["1110010"], 9: ["1110011"]}


def segment_polys(w: float, h: float, t: float, gap: float, bevel: bool):
    """Polygons of the 7 segments for an upright digit of size w x h, stroke t."""
    L, R, T, M, B = t / 2, w - t / 2, t / 2, h / 2, h - t / 2
    k = t / 2 if bevel else 0.0

    def horiz(x0, x1, y):
        if bevel:
            return [(x0, y), (x0 + k, y - t / 2), (x1 - k, y - t / 2), (x1, y), (x1 - k, y + t / 2), (x0 + k, y + t / 2)]
        return [(x0 + t / 2, y - t / 2), (x1 - t / 2, y - t / 2), (x1 - t / 2, y + t / 2), (x0 + t / 2, y + t / 2)]

    def vert(x, y0, y1):
        if bevel:
            return [(x, y0), (x + t / 2, y0 + k), (x + t / 2, y1 - k), (x, y1), (x - t / 2, y1 - k), (x - t / 2, y0 + k)]
        return [(x - t / 2, y0 + t / 2), (x + t / 2, y0 + t / 2), (x + t / 2, y1 - t / 2), (x - t / 2, y1 - t / 2)]

    return [
        horiz(L + gap, R - gap, T),  # a
        vert(R, T + gap, M - gap),   # b
        vert(R, M + gap, B - gap),   # c
        horiz(L + gap, R - gap, B),  # d
        vert(L, M + gap, B - gap),   # e
        vert(L, T + gap, M - gap),   # f
        horiz(L + gap, R - gap, M),  # g
    ]


class Style:
    """One random 'display font' plus rendering conditions, shared by a digit and its neighbours."""

    def __init__(self, rng: random.Random):
        self.aspect = rng.uniform(0.42, 0.68)         # upright width / height
        self.thick = rng.uniform(0.07, 0.17)          # stroke / height
        self.gap = rng.uniform(0.0, 0.045)            # gap between segments / height
        self.slant = rng.choice([0.0, rng.uniform(0.02, 0.2)])  # x shift per unit of height
        self.bevel = rng.random() < 0.7
        self.hollow = rng.random() < 0.15             # only segment outlines visible
        self.ink = rng.uniform(0.25, 1.0)             # segment darkness
        self.ink_jitter = rng.uniform(0.0, 0.25)      # per-segment variation
        self.ghost = rng.choice([0.0, rng.uniform(0.0, 0.12)])  # "off" segments faintly visible
        self.blur = rng.choice([rng.uniform(0, 0.6), rng.uniform(0.6, 1.6), rng.uniform(1.6, 3.5)] if rng.random() < 0.15 else [rng.uniform(0, 0.6), rng.uniform(0.6, 1.6)])
        self.noise = rng.uniform(0.0, 0.07)
        self.variants = {d: rng.random() < 0.3 for d in VARIANTS}


def segs_for(digit: int, style: Style, rng: random.Random) -> str:
    if digit in VARIANTS and style.variants[digit]:
        return VARIANTS[digit][0]
    return DIGIT_SEGS[digit]


def draw_digit(draw: ImageDraw.ImageDraw, segs: str, x0: float, y0: float, w: float, h: float,
               style: Style, rng: random.Random, scale: float):
    """Draw one slanted digit whose upright box is (x0, y0, w, h) in render pixels."""
    t = style.thick * h
    polys = segment_polys(w, h, t, style.gap * h, style.bevel)
    for on, poly in zip(segs, polys):
        if on == "1":
            v = style.ink * (1 - rng.uniform(0, style.ink_jitter))
        else:
            v = style.ghost
        if v <= 0.01:
            continue
        pts = [(x0 + px + style.slant * (h - py), y0 + py) for px, py in poly]
        col = int(255 * min(1.0, v))
        if style.hollow and on == "1":
            draw.polygon(pts, fill=int(col * rng.uniform(0.0, 0.35)), outline=None)
            draw.line(pts + [pts[0]], fill=col, width=max(1, int(round(scale * rng.uniform(0.6, 1.4)))))
        else:
            draw.polygon(pts, fill=col)


def render(label: int, rng: random.Random, style: Style | None = None) -> np.ndarray:
    """Render one CROP_W x CROP_H ink-map sample of class `label` (0-9 or NOT_DIGIT)."""
    style = style or Style(rng)
    S = 4  # supersampling
    W, H = CROP_W * S, CROP_H * S
    img = Image.new("L", (W, H), 0)
    draw = ImageDraw.Draw(img)

    # the cell the OCR pipeline would hand us: inner 1/(1+2*PAD) of the crop, with jitter
    cw, ch = W / (1 + 2 * PAD), H / (1 + 2 * PAD)
    cx, cy = (W - cw) / 2, (H - ch) / 2
    jx, jy, js = rng.uniform(-0.06, 0.06) * cw, rng.uniform(-0.05, 0.05) * ch, rng.uniform(0.9, 1.08)
    cw2, ch2 = cw * js, ch * rng.uniform(0.92, 1.06)
    cx += jx + (cw - cw2) / 2
    cy += jy + (ch - ch2) / 2

    # The cell spans the slanted digit: width = w + slant*h. Its aspect is decided by the
    # crop resize, so we fit the digit into the cell and let the style's aspect only shape
    # the stroke proportions.
    h = ch2
    w = max(cw2 - style.slant * h, cw2 * 0.4)
    spacing = rng.uniform(0.12, 0.45) * cw2

    def neighbour(dx):
        d = rng.randrange(10)
        draw_digit(draw, segs_for(d, style, rng), cx + dx, cy, w, h, style, rng, S)

    if rng.random() < 0.6:
        neighbour(-(cw2 + spacing))
    if rng.random() < 0.6:
        neighbour(cw2 + spacing)

    if label == NOT_DIGIT:
        kind = rng.random()
        if kind < 0.2:
            pass  # empty cell (noise only)
        elif kind < 0.45:
            # one or two segments that do not form a digit
            segs = ["0"] * 7
            for i in rng.sample(range(7), rng.choice([1, 1, 2])):
                segs[i] = "1"
            s = "".join(segs)
            if s not in DIGIT_SEGS.values():
                draw_digit(draw, s, cx, cy, w, h, style, rng, S)
        elif kind < 0.65:
            # a digit far off-centre (bad cell)
            d = rng.randrange(10)
            off = rng.choice([-1, 1]) * rng.uniform(0.45, 0.8) * cw2
            draw_digit(draw, segs_for(d, style, rng), cx + off, cy + rng.uniform(-0.3, 0.3) * ch2, w, h, style, rng, S)
        elif kind < 0.8:
            # heart / icon blob
            r = rng.uniform(0.15, 0.35) * cw2
            ox, oy = cx + rng.uniform(0.2, 0.8) * cw2, cy + rng.uniform(0.3, 0.8) * ch2
            col = int(255 * style.ink)
            draw.ellipse([ox - r, oy - r, ox, oy], fill=col)
            draw.ellipse([ox, oy - r, ox + r, oy], fill=col)
            draw.polygon([(ox - r, oy - r / 2), (ox + r, oy - r / 2), (ox, oy + r)], fill=col)
        else:
            # small text (like "mmHg") and specks
            for _ in range(rng.randint(2, 6)):
                bx, by = cx + rng.uniform(0, cw2), cy + rng.uniform(0, ch2)
                bw, bh = rng.uniform(0.05, 0.25) * cw2, rng.uniform(0.05, 0.15) * ch2
                draw.rectangle([bx, by, bx + bw, by + bh], fill=int(255 * style.ink * rng.uniform(0.4, 1)))
    else:
        if label == 1 and rng.random() < 0.2:
            # a row of only "1"s: the cell is the stroke itself
            t = style.thick * h
            draw_digit(draw, DIGIT_SEGS[1], cx + cw2 / 2 - (w - t / 2) - style.slant * h / 2, cy, w, h, style, rng, S)
        else:
            draw_digit(draw, segs_for(label, style, rng), cx, cy, w, h, style, rng, S)

    # small text intruding at the top / bottom of the crop (the "mmHg" label, the clock)
    if rng.random() < 0.15:
        y = rng.choice([rng.uniform(0, cy * 0.8), rng.uniform(cy + ch2 * 1.0, H - 2)])
        x = rng.uniform(0, W * 0.6)
        draw.rectangle([x, y, x + rng.uniform(0.2, 0.6) * W, y + rng.uniform(0.02, 0.06) * H], fill=int(255 * style.ink * 0.7))

    img = img.resize((CROP_W, CROP_H), Image.BOX)
    if style.blur > 0.05:
        img = img.filter(ImageFilter.GaussianBlur(style.blur))
    a = np.asarray(img, dtype=np.float32) / 255.0

    # glare: wipe out the ink in a soft ellipse
    if rng.random() < 0.08:
        yy, xx = np.mgrid[0:CROP_H, 0:CROP_W]
        gx, gy = rng.uniform(0, CROP_W), rng.uniform(0, CROP_H)
        rx, ry = rng.uniform(3, 9), rng.uniform(3, 12)
        g = np.exp(-(((xx - gx) / rx) ** 2 + ((yy - gy) / ry) ** 2))
        a *= 1 - rng.uniform(0.5, 1.0) * g
    # uneven background, noise, specks
    yy, xx = np.mgrid[0:CROP_H, 0:CROP_W]
    a += rng.uniform(-0.05, 0.12) * (xx / CROP_W * rng.uniform(-1, 1) + yy / CROP_H * rng.uniform(-1, 1))
    a += np.random.default_rng(rng.randrange(2**32)).normal(0, style.noise, a.shape)
    for _ in range(rng.choice([0, 0, 1, 3])):
        a[rng.randrange(CROP_H), rng.randrange(CROP_W)] += rng.uniform(0.3, 1.0)
    return (np.clip(a, 0, 1) * 255).astype(np.uint8)


class DigitNet(nn.Module):
    """~10k parameters. Plain conv / relu / max-pool / linear so the JS port stays tiny."""

    FEATURES = 32 * (CROP_H // 8) * (CROP_W // 8)

    def __init__(self):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1, 8, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),    # 8 x 16 x 12
            nn.Conv2d(8, 16, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),   # 16 x 8 x 6
            nn.Conv2d(16, 32, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),  # 32 x 4 x 3
        )
        self.head = nn.Sequential(nn.Flatten(), nn.Dropout(0.2), nn.Linear(self.FEATURES, NUM_CLASSES))

    def forward(self, x):
        return self.head(self.features(x))


def load_real(split: str | None = None):
    """Real digit crops exported by export_real.mjs. split: 'dev', 'test' or None (all).
    The split is by scan (never mixes digits of one photo) and fixed by a hash of its id."""
    root = HERE / "data" / "real"
    idx = json.loads((root / "index.json").read_text())
    xs, ys, meta = [], [], []
    for e in idx:
        h = int(hashlib.sha1(e["source"].encode()).hexdigest(), 16) % 2
        part = "dev" if h == 0 else "test"
        if split and part != split:
            continue
        img = Image.open(root / e["file"])
        xs.append(np.asarray(img, dtype=np.uint8))
        ys.append(e["label"])
        meta.append({**e, "split": part})
    return np.stack(xs), np.array(ys), meta


def pick_device() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def seed_all(seed: int):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)


def to_tensor(x: np.ndarray) -> torch.Tensor:
    return torch.from_numpy(x.astype(np.float32) / 255.0).unsqueeze(1)


__all__ = [
    "CROP_W", "CROP_H", "NOT_DIGIT", "NUM_CLASSES", "Style", "render", "DigitNet", "load_real",
    "pick_device", "seed_all", "to_tensor",
]
