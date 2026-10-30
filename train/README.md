# DigitNet: a tiny seven-segment digit classifier

The BP Log app reads blood-pressure monitor displays offline. Once the parser in `../ocr.js` has
found the rows and digit boxes, this small network reads each digit. The network is trained
**only on synthetic digits** and tested on real ones.

| | |
|---|---|
| Input | 24×32 "ink map" of one digit cell (0 = background, 255 = darkest ink), padded 15% |
| Output | 11 classes: digits 0–9 and "not a digit" (icons, specks, misplaced boxes) |
| Architecture | 3 × (3×3 conv → ReLU → 2×2 max-pool), 8/16/32 channels, then linear 384 → 11 |
| Size | 10,123 parameters (40 KB float32, 54 KB as base64 in `../digitnet-weights.js`) |
| Inference | plain JavaScript (`../digitnet.js`), about 0.6 ms per digit on an Apple M5 and 1 ms on an Android phone, no dependencies |
| Training data | 150,000 generated samples (`common.py: render`) |

## Results

The test set is real digits from 55 photos of one monitor (an upper-arm BP monitor with a
green/yellow backlit LCD). They are split by photo into **dev**, used while tuning the
generator, and **test**, used only for the final number.

| Digits | 7-segment rule decoder | DigitNet |
|---|---|---|
| dev (201) | 96.0% | 98.5% |
| test (187) | 95.7% | **99.5%** |

On a whole reading (SYS, DIA and pulse all correct), the app's parser goes from 85% to 91%
on these photos. With rotated, shrunk, dimmed and recompressed copies of every photo
(`node test/eval.mjs --augment`), it goes from 73% to 83%. Most remaining errors come from
finding the rows, not from reading digits.

## Synthetic data

`render()` draws a seven-segment digit in a random "display font", then degrades it:
- **Font:** stroke width, segment gaps, slant, bevelled or square ends.
- **Display:** filled or hollow segments, faint "off" segments, the optional tails of 6/7/9.
- **Photo:** blur, noise, glare, uneven background, contrast.
- **Surroundings:** neighbouring digits, text cut into the crop (like "mmHg").
- **Pipeline errors:** cells that are slightly off, as the box finder produces.

`uv run python preview.py` saves a sheet of generated samples next to real ones.

## Reproduce

```bash
cd train
uv sync                                   # PyTorch (MPS on Apple Silicon), NumPy, Pillow
node export_real.mjs                      # real digit crops from ../test/fixtures -> data/real
uv run python train.py                    # ~1 min on an M-series Mac, writes ../digitnet-weights.js
uv run python misses.py test              # list / render the test digits it gets wrong
cd .. && node test/eval.mjs [--no-net]    # whole-reading accuracy with / without the network
```

On an Apple M5, an epoch of 150,000 samples takes 2.8 s on MPS against 15.8 s on the CPU
(`uv run python bench.py`). For reading one digit at a time the CPU is faster (0.14 vs 0.25 ms):
the GPU only pays off on large batches.

## Limits

- The real test set comes from **one** monitor. Other fonts are covered only by the
  generator's variety. Testing on public sets such as SSDN or the Oxford BP/glucose meter
  photos would be the next step.
- The network only reads digits. Finding the rows in `ocr.js` still uses rules tuned to this
  monitor's layout.
