// Offline seven-segment OCR for backlit blood-pressure monitor displays.
// Works on any ImageData-like object {width, height, data: RGBA}.
// No dependencies, no network: runs in the browser and in Node (for tests).
// Digits are read by a tiny neural network (digitnet.js + digitnet-weights.js) when it is
// loaded and confident, otherwise by checking which of the 7 segments are lit.
(function (root) {
  'use strict';

  // ---- optional neural digit classifier ----
  // default crop size; the loaded model's own size (weights meta.crop) takes precedence
  const CROP_W = 24, CROP_H = 32, CROP_PAD = 0.15, NOT_DIGIT = 10; // keep in sync with train/common.py
  let net;
  function getNet() {
    if (net === undefined) {
      try {
        const node = typeof module !== 'undefined' && module.exports;
        const lib = node ? require('./digitnet.js') : root.DigitNet;
        const weights = node ? require('./digitnet-weights.js') : root.DigitNetWeights;
        net = lib && weights ? lib.create(weights) : null;
      } catch (e) { net = null; }
    }
    return net;
  }

  // Ink map of a digit cell (0 = background, 255 = darkest ink), padded by CROP_PAD on every
  // side and resized to the model's crop size (CROP_W x CROP_H by default). `ratio` is the pixel / local-background map from
  // binarize (128 = background), so the crop does not depend on the backlight colour.
  function cropInk(ratio, w, h, c, size) {
    const [CW, CH] = size || (getNet() ? getNet().meta.crop : [CROP_W, CROP_H]);
    const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
    const X0 = c.x0 - cw * CROP_PAD, Y0 = c.y0 - ch * CROP_PAD, SW = cw * (1 + 2 * CROP_PAD), SH = ch * (1 + 2 * CROP_PAD);
    const at = (x, y) => {
      x = Math.min(w - 1, Math.max(0, x)); y = Math.min(h - 1, Math.max(0, y));
      return Math.max(0, Math.min(255, (128 - ratio[y * w + x]) * 2));
    };
    const out = new Uint8Array(CW * CH);
    for (let j = 0; j < CH; j++) for (let i = 0; i < CW; i++) {
      const fx = X0 + (i + 0.5) * SW / CW - 0.5, fy = Y0 + (j + 0.5) * SH / CH - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const v = (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
      out[j * CW + i] = Math.round(v);
    }
    return out;
  }

  // Segment order: a (top), b (top-right), c (bottom-right), d (bottom),
  // e (bottom-left), f (top-left), g (middle)
  const DIGITS = {
    '1111110': 0, '0110000': 1, '1101101': 2, '1111001': 3, '0110011': 4,
    '1011011': 5, '1011111': 6, '1110000': 7, '1111111': 8, '1111011': 9,
    // common variants: 6 / 7 / 9 without their optional tail segment
    '0011111': 6, '1110010': 7, '1110011': 9,
  };

  function resize(img, maxDim) {
    const s = Math.min(1, maxDim / Math.max(img.width, img.height));
    if (s === 1) return img;
    const w = Math.round(img.width * s), h = Math.round(img.height * s);
    const out = new Uint8ClampedArray(w * h * 4);
    // box filter downscale
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y / s), y1 = Math.max(y0 + 1, Math.floor((y + 1) / s));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x / s), x1 = Math.max(x0 + 1, Math.floor((x + 1) / s));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = y0; yy < y1 && yy < img.height; yy++) {
          for (let xx = x0; xx < x1 && xx < img.width; xx++) {
            const i = (yy * img.width + xx) * 4;
            r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
          }
        }
        const o = (y * w + x) * 4;
        out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
      }
    }
    return { width: w, height: h, data: out };
  }

  // Bilinear resample so the longest side equals `dim` (up- or down-scaling).
  function scaleTo(img, dim) {
    const s = dim / Math.max(img.width, img.height);
    if (s < 1) return resize(img, dim);
    const w = Math.round(img.width * s), h = Math.round(img.height * s);
    const out = new Uint8ClampedArray(w * h * 4), W = img.width, H = img.height;
    for (let y = 0; y < h; y++) {
      const fy = Math.min(H - 1, (y + 0.5) / s - 0.5), y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(H - 1, y0 + 1), ty = Math.max(0, fy - y0);
      for (let x = 0; x < w; x++) {
        const fx = Math.min(W - 1, (x + 0.5) / s - 0.5), x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(W - 1, x0 + 1), tx = Math.max(0, fx - x0);
        for (let c = 0; c < 3; c++) {
          const a = img.data[(y0 * W + x0) * 4 + c], b = img.data[(y0 * W + x1) * 4 + c];
          const d = img.data[(y1 * W + x0) * 4 + c], e = img.data[(y1 * W + x1) * 4 + c];
          out[(y * w + x) * 4 + c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
        }
        out[(y * w + x) * 4 + 3] = 255;
      }
    }
    return { width: w, height: h, data: out };
  }

  // Projection-profile deskew: the angle (degrees) that makes rows sharpest.
  function estimateSkew(mask, w, h) {
    const pts = [];
    // horizontal edges (top/bottom of segments, underlines) line up on rows
    for (let y = 1; y < h; y++) for (let x = 0; x < w; x++) if (mask[y * w + x] !== mask[(y - 1) * w + x]) pts.push(x, y);
    let best = 0, bestScore = -1;
    for (let a = -15; a <= 15; a += 0.25) {
      const t = a * Math.PI / 180, sn = Math.sin(t), cs = Math.cos(t);
      const hist = new Float32Array(h * 2);
      for (let i = 0; i < pts.length; i += 2) {
        const yy = Math.round(-pts[i] * sn + pts[i + 1] * cs + h * 0.5);
        if (yy >= 0 && yy < hist.length) hist[yy]++;
      }
      let score = 0;
      for (const v of hist) score += v * v;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  }

  // Rotate a binary mask by `deg` around its centre (nearest neighbour).
  function rotateMask(mask, w, h, deg, fill) {
    const t = deg * Math.PI / 180, sn = Math.sin(t), cs = Math.cos(t);
    const out = new Uint8Array(w * h).fill(fill || 0), cx = w / 2, cy = h / 2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // inverse mapping: output pixel -> source pixel
        const dx = x - cx, dy = y - cy;
        const sx = Math.round(cs * dx - sn * dy + cx), sy = Math.round(sn * dx + cs * dy + cy);
        if (sx >= 0 && sy >= 0 && sx < w && sy < h) out[y * w + x] = mask[sy * w + sx];
      }
    }
    return out;
  }

  function channelMax(img) {
    const n = img.width * img.height, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const d = img.data;
      out[i] = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
    }
    return out;
  }

  function otsu(values) {
    const hist = new Array(256).fill(0);
    for (const v of values) hist[v]++;
    const total = values.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  // Connected components (4-neighbour) on a binary mask. Returns boxes.
  function components(mask, w, h, minArea) {
    const label = new Int32Array(w * h), boxes = [], stack = [];
    let next = 1;
    for (let p = 0; p < w * h; p++) {
      if (!mask[p] || label[p]) continue;
      const box = { x0: w, y0: h, x1: -1, y1: -1, area: 0, id: next };
      label[p] = next; stack.push(p);
      while (stack.length) {
        const q = stack.pop(), x = q % w, y = (q / w) | 0;
        box.area++;
        if (x < box.x0) box.x0 = x; if (x > box.x1) box.x1 = x;
        if (y < box.y0) box.y0 = y; if (y > box.y1) box.y1 = y;
        if (x > 0 && mask[q - 1] && !label[q - 1]) { label[q - 1] = next; stack.push(q - 1); }
        if (x < w - 1 && mask[q + 1] && !label[q + 1]) { label[q + 1] = next; stack.push(q + 1); }
        if (y > 0 && mask[q - w] && !label[q - w]) { label[q - w] = next; stack.push(q - w); }
        if (y < h - 1 && mask[q + w] && !label[q + w]) { label[q + w] = next; stack.push(q + w); }
      }
      if (box.area >= minArea) boxes.push(box);
      next++;
    }
    return { boxes, label };
  }

  // 1. Locate the backlit LCD: largest bright blob.
  function findLcd(img) {
    const small = resize(img, 400);
    const v = channelMax(small);
    // the backlit LCD is the brightest (often saturated) area of the photo
    const sorted = Array.from(v).sort((a, b) => a - b);
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const thr = Math.max(otsu(v), 120, p99 * 0.85);
    const mask = new Uint8Array(v.length);
    for (let i = 0; i < v.length; i++) mask[i] = v[i] > thr ? 1 : 0;
    const { boxes } = components(mask, small.width, small.height, 50);
    if (!boxes.length) return null;
    // prefer large, filled, roughly rectangular blobs
    boxes.sort((a, b) => b.area - a.area);
    const b = boxes[0], sx = img.width / small.width, sy = img.height / small.height;
    return {
      x: Math.round(b.x0 * sx), y: Math.round(b.y0 * sy),
      w: Math.round((b.x1 - b.x0 + 1) * sx), h: Math.round((b.y1 - b.y0 + 1) * sy),
    };
  }

  function crop(img, r) {
    const out = new Uint8ClampedArray(r.w * r.h * 4);
    for (let y = 0; y < r.h; y++) {
      const src = ((r.y + y) * img.width + r.x) * 4;
      out.set(img.data.subarray(src, src + r.w * 4), y * r.w * 4);
    }
    return { width: r.w, height: r.h, data: out };
  }

  // 2. Binarize the LCD: segments are darker than their surroundings.
  function binarize(img) {
    const { width: w, height: h } = img, n = w * h;
    const gray = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const d = img.data;
      gray[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
    }
    // Background estimate = grey-level closing (max then min filter) with a
    // window wider than a segment stroke. Segments vanish from it, while uneven
    // backlight, vignetting and the bezel are preserved.
    const r = Math.max(4, Math.round(w / 28));
    const bg = minMax(minMax(gray, w, h, r, true), w, h, r, false);
    const ratio = new Uint8Array(n);
    for (let i = 0; i < n; i++) ratio[i] = Math.min(255, Math.round(gray[i] / (bg[i] || 1) * 128));
    // contrast differs a lot between photos: pick the cut automatically
    const thr = Math.min(118, Math.max(77, otsu(ratio)));
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = ratio[i] < thr ? 1 : 0;
    return { mask, ratio };
  }

  // Separable sliding max (isMax) / min filter with radius r.
  function minMax(src, w, h, r, isMax) {
    const pick = isMax ? Math.max : Math.min;
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = src[y * w + x];
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) v = pick(v, src[y * w + k]);
        tmp[y * w + x] = v;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let v = tmp[y * w + x];
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) v = pick(v, tmp[k * w + x]);
        out[y * w + x] = v;
      }
    }
    return out;
  }

  // Drop dark blobs touching the crop edge (bezel, shadows) and huge blobs. At the bottom
  // edge only long runs go: the bottom bar of a PULSE digit can touch it.
  function clearBorderBlobs(mask, w, h) {
    const { boxes, label } = components(mask, w, h, 0);
    const kill = new Set();
    for (const b of boxes) {
      const sides = b.x0 === 0 || b.y0 === 0 || b.x1 === w - 1;
      const bottomRun = b.y1 === h - 1 && b.x1 - b.x0 + 1 > w * 0.15;
      if (sides || bottomRun || b.area > w * h * 0.08) kill.add(b.id);
    }
    for (let p = 0; p < w * h; p++) if (kill.has(label[p])) mask[p] = 0;
  }

  // Binary closing with a 3x3 cross (dilate then erode).
  function close(mask, w, h) {
    const op = (src, val) => {
      const out = new Uint8Array(src);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        if (src[p - 1] === val || src[p + 1] === val || src[p - w] === val || src[p + w] === val) out[p] = val;
      }
      return out;
    };
    return op(op(mask, 1), 0);
  }

  // Low-contrast photos sometimes only show segment outlines: fill small enclosed holes.
  // Only thin / elongated holes (the inside of an outlined segment) are filled; the
  // roughly square counters inside small 0, 6, 8, 9 digits are kept open.
  function fillHoles(mask, w, h, maxArea) {
    const inv = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) inv[p] = mask[p] ? 0 : 1;
    const { boxes, label } = components(inv, w, h, 0);
    const fill = new Set();
    for (const b of boxes) {
      const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
      const thin = Math.min(bw, bh) <= Math.max(3, w * 0.012) || Math.max(bw, bh) >= Math.min(bw, bh) * 2.5;
      if (thin && b.area <= maxArea && b.x0 > 0 && b.y0 > 0 && b.x1 < w - 1 && b.y1 < h - 1) fill.add(b.id);
    }
    for (let p = 0; p < w * h; p++) if (fill.has(label[p])) mask[p] = 1;
  }

  // Group runs of a 1-D profile into bands where profile > thr.
  function bands(profile, thr, minGap) {
    const out = [];
    let start = -1, lastOn = -1;
    for (let i = 0; i < profile.length; i++) {
      if (profile[i] > thr) {
        if (start < 0) start = i;
        else if (i - lastOn > minGap) { out.push([start, lastOn]); start = i; }
        lastOn = i;
      }
    }
    if (start >= 0) out.push([start, lastOn]);
    return out;
  }

  function density(mask, w, x0, y0, x1, y1) {
    x0 = Math.round(x0); x1 = Math.round(x1); y0 = Math.round(y0); y1 = Math.round(y1);
    let on = 0, n = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { n++; on += mask[y * w + x] || 0; }
    return n ? on / n : 0;
  }

  // 3. Decode one digit given its box. slant = x shift per pixel going up.
  function decodeDigit(mask, w, box, digitW, slant) {
    const { x0, x1, y0, y1 } = box, h = y1 - y0 + 1;
    const bw = x1 - x0 + 1;
    // the digit's full cell (a "1" only lights the right side of it). In a row of only "1"s
    // the widest box is a lone stroke, so fall back to a typical digit width for the row.
    const cellW = digitW > h * 0.35 ? digitW : Math.round(h * 0.55);
    const cell = { x0: x1 - cellW + 1, x1, y0, y1 };
    if (bw < digitW * 0.45 || bw < h * 0.3) return { value: 1, segs: '0110000', cell };
    // use the typical (slanted) digit width anchored on the right edge;
    // W is the upright width once the italic shift is removed
    const L = x1 - digitW + 1, W = Math.max(digitW * 0.5, digitW - slant * h);
    // x offset for slanted (italic) digits at a given y
    const sx = (y) => slant * (y1 - y);
    const t = 0.18; // relative thickness of the sampling window
    const zones = [
      // [cx, cy, halfW, halfH] in relative coords
      [0.5, 0.06, 0.22, t / 2.5], // a
      [0.88, 0.27, t / 2, 0.12],  // b
      [0.88, 0.73, t / 2, 0.12],  // c
      [0.5, 0.94, 0.22, t / 2.5], // d
      [0.12, 0.73, t / 2, 0.12],  // e
      [0.12, 0.27, t / 2, 0.12],  // f
      [0.5, 0.5, 0.22, t / 2.5],  // g
    ];
    const scores = zones.map(([cx, cy, hw, hh]) => {
      const yc = y0 + cy * h, xc = L + cx * W + sx(yc);
      return +density(mask, w, xc - hw * W, yc - hh * h, xc + hw * W, yc + hh * h).toFixed(2);
    });
    // segment is "on" relative to the strongest segment of this digit
    const cut = Math.max(0.12, Math.max(...scores) * 0.3);
    const segs = scores.map(d => (d > cut ? '1' : '0')).join('');
    const value = DIGITS[segs];
    return { value: value === undefined ? null : value, segs, scores, cell };
  }

  // Split a text row into digit boxes using the vertical projection.
  function rowBoxes(mask, w, row, xMin, xMax) {
    const [ry0, ry1] = row;
    const rh = ry1 - ry0 + 1;
    const prof = new Float32Array(w);
    for (let x = xMin; x <= xMax; x++) {
      let c = 0;
      for (let y = ry0; y <= ry1; y++) c += mask[y * w + x];
      prof[x] = c;
    }
    const cols = bands(prof, 0, Math.max(1, Math.round(rh * 0.03)));
    // tighten each column to its vertical extent, drop specks and edge noise
    return cols.map(([x0, x1]) => {
      let y0 = ry1, y1 = ry0, on = 0;
      for (let y = ry0; y <= ry1; y++) for (let x = x0; x <= x1; x++) {
        if (mask[y * w + x]) { on++; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
      return { x0, x1, y0, y1, on };
    }).filter(b => {
      const bh = b.y1 - b.y0 + 1, bw = b.x1 - b.x0 + 1;
      return bh > rh * 0.7 && bw > rh * 0.04 && b.on > bh * 1.5;
    });
  }

  // Text rows inside [y0, y1] x [x0, x1]: any empty scan line splits rows.
  function textRows(mask, w, y0, y1, x0, x1, minH) {
    if (y1 <= y0) return [];
    const prof = new Float32Array(y1 - y0 + 1);
    for (let y = y0; y <= y1; y++) {
      let c = 0;
      for (let x = x0; x <= x1; x++) c += mask[y * w + x];
      prof[y - y0] = c;
    }
    return bands(prof, 0, 1).map(([a, b]) => [a + y0, b + y0]).filter(([a, b]) => b - a + 1 > minH);
  }

  // Find the printed "mmHg" label between the DIA and PULSE rows: 3-5 small glyphs of similar
  // height, side by side on one line, in the lower part of the display. Returns its box and
  // u = glyph height, or null.
  function findMmHg(mask, w, h, xMin) {
    const { boxes } = components(mask, w, h, 4);
    const glyphs = boxes.filter((b) => {
      const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
      return b.x1 >= xMin && b.y0 > h * 0.4 && b.y1 < h * 0.95 &&
        bh >= h * 0.012 && bh <= h * 0.06 && bw <= w * 0.08 && bw >= 2;
    }).sort((a, b) => a.x0 - b.x0);
    let best = null;
    for (let i = 0; i < glyphs.length; i++) {
      // grow a run of neighbours on the same line
      const run = [glyphs[i]];
      for (let j = i + 1; j < glyphs.length; j++) {
        const last = run[run.length - 1], g = glyphs[j];
        const lh = last.y1 - last.y0 + 1;
        const cy = (g.y0 + g.y1) / 2, lcy = (last.y0 + last.y1) / 2;
        if (g.x0 - last.x1 > lh * 1.2) break;
        if (Math.abs(cy - lcy) > lh * 0.6) continue;
        run.push(g);
      }
      if (run.length < 3 || run.length > 6) continue;
      const box = {
        x0: Math.min(...run.map((g) => g.x0)), x1: Math.max(...run.map((g) => g.x1)),
        y0: Math.min(...run.map((g) => g.y0)), y1: Math.max(...run.map((g) => g.y1)),
      };
      const bw = box.x1 - box.x0 + 1, bh = box.y1 - box.y0 + 1;
      if (bw < w * 0.08 || bw > w * 0.35 || bw < bh * 2.2) continue;
      // tall digit strokes must exist both above and below the label
      const colStroke = (ya, yb) => {
        let n = 0;
        for (let y = Math.max(0, ya); y <= Math.min(h - 1, yb); y++) for (let x = box.x0; x <= box.x1; x++) n += mask[y * w + x];
        return n;
      };
      if (!colStroke(box.y0 - h * 0.15, box.y0 - 1) || !colStroke(box.y1 + 1, box.y1 + h * 0.15)) continue;
      // prefer the right-most label (digits are right-aligned with it)
      if (!best || box.x1 > best.x1) best = { ...box, u: Math.max(...run.map((g) => g.y1 - g.y0 + 1)), glyphs: run.length };
    }
    return best;
  }

  // nn: { ratio, h } to let the neural classifier read each digit cell (or null)
  function decodeRow(mask, w, row, boxes, slant, nn) {
    if (!boxes.length) return null;
    // numbers are right-aligned: keep the right-most group (drops e.g. the memory index)
    const rh = row[1] - row[0] + 1;
    const group = [boxes[boxes.length - 1]];
    for (let i = boxes.length - 2; i >= 0 && group.length < 3; i--) {
      if (group[0].x0 - boxes[i].x1 > rh * 0.85) break;
      group.unshift(boxes[i]);
    }
    boxes = group;
    const digitW = Math.max(...boxes.map(b => b.x1 - b.x0 + 1));
    let digits = boxes.map(b => decodeDigit(mask, w, { ...b, y0: row[0], y1: row[1] }, digitW, slant));
    const model = nn && getNet();
    if (model) {
      digits = digits.map((d) => {
        const p = model.predict(cropInk(nn.ratio, w, nn.h, d.cell));
        let k = 0;
        for (let c = 1; c < p.length; c++) if (p[c] > p[k]) k = c;
        const out = { ...d, segValue: d.value, nnClass: k, nnProb: +p[k].toFixed(3) };
        if (p[k] >= 0.6) out.value = k === NOT_DIGIT ? null : k;
        if (k === NOT_DIGIT && p[k] >= 0.6) out.notDigit = true;
        return out;
      });
    }
    // a mark left of the number that is not a digit (the heart / memory icon) is dropped
    while (digits.length > 1 && (digits[0].notDigit || (digits[0].value === null && boxes[1].x0 - boxes[0].x1 > rh * 0.3))) {
      digits = digits.slice(1); boxes = boxes.slice(1);
    }
    const value = digits.some(d => d.value === null) ? null : Number(digits.map(d => d.value).join(''));
    return { value, digits, boxes, slant };
  }

  // For narrow "1"-like strokes the stroke centre drifts with y if italic.
  // Measured on every row and shared: all digits use the same italic font.
  function estimateSlant(mask, w, rows) {
    const vals = [];
    for (const { row: [y0, y1], boxes } of rows) for (const b of boxes) {
      if ((b.x1 - b.x0 + 1) >= (y1 - y0) * 0.3) continue;
      const centre = (yy) => {
        let s = 0, n = 0;
        for (let y = yy - 2; y <= yy + 2; y++) for (let x = b.x0; x <= b.x1; x++) if (mask[y * w + x]) { s += x; n++; }
        return n ? s / n : null;
      };
      const ya = y0 + Math.round((y1 - y0) * 0.15), yb = y0 + Math.round((y1 - y0) * 0.85);
      const ca = centre(ya), cb = centre(yb);
      if (ca !== null && cb !== null) vals.push((ca - cb) / (yb - ya));
    }
    if (!vals.length) return 0.07; // typical LCD italic
    vals.sort((a, b) => a - b);
    return Math.max(-0.1, Math.min(0.25, vals[vals.length >> 1]));
  }

  // Row geometry of the display, as fractions of its height (measured on real scans).
  const LAYOUT = { sys: 0.27, dia: 0.54, pulse: 0.86, digitH: 0.23, pulseRatio: 0.75 };

  // Pick the SYS / DIA / PULSE rows. Candidates are the ink bands of the row profile,
  // unions of neighbouring bands (a digit can be cut by a thin gap) and halves of
  // over-tall bands (two rows touching). Each (SYS, DIA, PULSE) triple is scored on:
  // SYS and DIA equally tall, PULSE ~3/4 of that, rows near their usual place, the
  // "mmHg" label (if found) between DIA and PULSE, and no tall ink left unexplained.
  function chooseRows(mask, w, h, xMin, xMax, anchor) {
    const prof = new Float32Array(h);
    let maxP = 0;
    for (let y = 0; y < h; y++) {
      let c = 0;
      for (let x = xMin; x <= xMax; x++) c += mask[y * w + x];
      prof[y] = c; if (c > maxP) maxP = c;
    }
    let bs = bands(prof, Math.max(0, maxP * 0.03), 1).filter(([a, b]) => b - a + 1 >= h * 0.02);
    // the clock / date line at the very top is never part of SYS
    if (bs.length && (bs[0][0] + bs[0][1]) / 2 < h * 0.13 && bs[0][1] - bs[0][0] + 1 < h * 0.15) bs = bs.slice(1);
    const key = (r) => r[0] + ':' + r[1];
    const cands = new Map();
    const add = (r) => { if (r[1] - r[0] + 1 >= h * 0.06) cands.set(key(r), r); };
    for (let i = 0; i < bs.length; i++) {
      for (let j = i; j < bs.length && j <= i + 3; j++) {
        if (j > i && bs[j][0] - bs[j - 1][1] > h * 0.04) break;
        add([bs[i][0], bs[j][1]]);
      }
    }
    for (const r of [...cands.values()]) {
      const rh = r[1] - r[0] + 1;
      if (rh < h * 0.3) continue;
      // split at the emptiest line in the middle part
      let at = -1, low = Infinity;
      for (let y = r[0] + Math.round(rh * 0.3); y <= r[0] + Math.round(rh * 0.7); y++) if (prof[y] < low) { low = prof[y]; at = y; }
      if (at > 0) { add([r[0], at - 1]); add([at + 1, r[1]]); }
    }
    const list = [...cands.values()].sort((p, q) => p[0] - q[0]);
    const tall = bs.filter(([a, b]) => b - a + 1 >= h * 0.08);
    const sq = (v) => v * v;
    const ht = (r) => r[1] - r[0] + 1;
    const mid = (r) => (r[0] + r[1]) / 2 / h;
    let best = null;
    for (const S of list) for (const D of list) {
      if (D[0] <= S[1]) continue;
      const hs = ht(S), hd = ht(D), big = (hs + hd) / 2;
      let base = sq((hs - hd) / Math.max(hs, hd) / 0.1) + sq((big / h - LAYOUT.digitH) / 0.06) +
        sq((mid(S) - LAYOUT.sys) / 0.08) + sq((mid(D) - LAYOUT.dia) / 0.08);
      if (anchor && D[1] > anchor.y1) base += 50;
      if (best && base >= best.cost) continue;
      for (const P of [null, ...list]) {
        if (P && P[0] <= D[1]) continue;
        let cost = base;
        if (P) {
          cost += sq(Math.max(0, Math.abs(ht(P) / big - LAYOUT.pulseRatio) - 0.1) / 0.08) + sq((mid(P) - LAYOUT.pulse) / 0.1);
          if (anchor && P[0] < anchor.y0) cost += 50;
        } else cost += 8; // pulse can be faint; it is searched for again below
        // tall ink bands below the clock that no chosen row covers
        for (const t of tall) {
          if (t[1] < S[0] - h * 0.02) continue;
          const covered = [S, D, P].some((r) => r && t[0] >= r[0] - 2 && t[1] <= r[1] + 2);
          if (!covered) cost += 4 * ht(t) / (h * 0.1);
        }
        if (!best || cost < best.cost) best = { cost, rows: [S, D, P] };
      }
    }
    return best ? best.rows : [null, null, null];
  }

  // Re-binarize one region with its own threshold (faint rows, uneven backlight).
  function localMask(ratio, w, h, x0, y0, x1, y1, thr) {
    if (!thr) {
      const vals = [];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) vals.push(ratio[y * w + x]);
      thr = Math.min(122, Math.max(70, otsu(vals)));
    }
    const m = new Uint8Array(w * h);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) m[y * w + x] = ratio[y * w + x] < thr ? 1 : 0;
    return m;
  }

  function recognize(input, opts) {
    opts = opts || {};
    const img = resize(input, 1600);
    const lcd = opts.lcd || findLcd(img);
    if (!lcd) return { ok: false, error: 'Display not found' };
    // trim the bezel off the sides and top, but not the bottom: the PULSE digits sit right
    // at the bottom edge of the lit area
    const ix = Math.round(lcd.w * 0.02), iy = Math.round(lcd.h * 0.02);
    const inset = { x: lcd.x + ix, y: lcd.y + iy, w: lcd.w - 2 * ix, h: Math.min(img.height - lcd.y - iy, lcd.h - iy + Math.round(lcd.h * 0.01)) };
    const lcdImg = scaleTo(crop(img, inset), 500);
    const { width: w, height: h } = lcdImg;
    let { mask, ratio } = binarize(lcdImg);
    clearBorderBlobs(mask, w, h);
    // straighten tilted photos so text rows are horizontal
    const angle = estimateSkew(mask, w, h);
    if (Math.abs(angle) > 0.4) {
      mask = rotateMask(mask, w, h, angle);
      ratio = rotateMask(ratio, w, h, angle, 128);
      clearBorderBlobs(mask, w, h);
    }
    const clean = (m) => { m = close(m, w, h); fillHoles(m, w, h, w * h * 0.004); return m; };
    // close tiny breaks in faint, outline-only segments, then fill them in
    mask = clean(mask);

    // The numbers occupy the right side of the display; labels/icons are on the left.
    const xMin = Math.round(w * 0.38);
    const anchor = opts.noAnchor ? null : findMmHg(mask, w, h, xMin);
    // digits end a little right of the "mmHg" label, which drops bezel noise further right
    const xMax = anchor ? Math.min(w - 1, anchor.x1 + anchor.u * 2) : w - 1;
    const rows = chooseRows(mask, w, h, xMin, xMax, anchor);

    // No pulse row in the global mask: look again below DIA with a local threshold.
    if (rows[1] && !rows[2]) {
      const y0 = Math.max(rows[1][1] + Math.round(h * 0.04), anchor ? anchor.y1 + 1 : 0), y1 = h - 2;
      if (y1 - y0 > h * 0.08) {
        const m = localMask(ratio, w, h, xMin, y0, xMax, y1);
        clearBorderBlobs(m, w, h);
        const lm = clean(m);
        const found = textRows(lm, w, y0, y1, xMin, xMax, h * 0.08).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
        if (found) { rows[2] = found; for (let y = y0; y <= y1; y++) for (let x = xMin; x <= xMax; x++) mask[y * w + x] = lm[y * w + x]; }
      }
    }

    // Tighten each row to the typical top / bottom of its digit boxes (a row band can
    // include a bit of the clock, the "mmHg" label or the next row).
    const median = (v) => { const a = v.slice().sort((p, q) => p - q); return a[a.length >> 1]; };
    for (let i = 0; i < 3; i++) {
      if (!rows[i]) continue;
      const bx = rowBoxes(mask, w, rows[i], xMin, xMax);
      if (bx.length < 2) continue;
      // highest top / lowest bottom, ignoring boxes that stick out far past the others
      // (a "1" or "4" has no top bar, so the median would cut the top of the other digits)
      const tol = (rows[i][1] - rows[i][0]) * 0.12, m0 = median(bx.map(b => b.y0)), m1 = median(bx.map(b => b.y1));
      rows[i] = [Math.min(...bx.map(b => b.y0).filter(y => y >= m0 - tol)), Math.max(...bx.map(b => b.y1).filter(y => y <= m1 + tol))];
    }
    const rowInfo = rows.map(row => ({ row, boxes: row ? rowBoxes(mask, w, row, xMin, xMax) : [] }));
    // SYS and DIA digits are right-aligned with each other: a box starting right of where
    // the other big row ends is the display edge or glare, not a digit. (PULSE is smaller and
    // sits a little further right, so it is left alone.)
    rowInfo.forEach((ri, i) => {
      if (i === 2) return;
      const ends = rowInfo.filter((o, j) => j !== i && j !== 2 && o.boxes.length).map(o => o.boxes[o.boxes.length - 1].x1);
      if (!ends.length || !ri.boxes.length) return;
      const edge = Math.max(...ends);
      ri.boxes = ri.boxes.filter(b => b.x0 < edge - (ri.row[1] - ri.row[0]) * 0.05);
    });
    const slant = estimateSlant(mask, w, rowInfo.filter(r => r.row));
    const nn = opts.noNet ? null : { ratio, h };
    const read = rowInfo.map(r => (r.row ? decodeRow(mask, w, r.row, r.boxes, slant, nn) : null));
    // A row that did not decode to a plausible value: retry it with thresholds of its own,
    // from its Otsu cut to increasingly lenient ones (faint PULSE digits).
    const RANGE = [[60, 260], [30, 160], [30, 220]];
    const plausible = (r, i) => r && r.value !== null && r.value >= RANGE[i][0] && r.value <= RANGE[i][1] &&
      // SYS is always above DIA (retries with lenient thresholds must not "invent" a value)
      (i !== 0 || !read[1] || read[1].value === null || r.value > read[1].value);
    [1, 2, 0].forEach((i) => {
      const r = read[i], row = rows[i];
      if (!row || plausible(r, i)) return;
      const pad = Math.round((row[1] - row[0]) * 0.08);
      const y0 = Math.max(1, row[0] - pad), y1 = Math.min(h - 2, row[1] + pad);
      for (const thr of [0, 104, 110, 116, 122]) {
        const lm = clean(localMask(ratio, w, h, xMin, y0, xMax, y1, thr));
        const r2 = decodeRow(lm, w, row, rowBoxes(lm, w, row, xMin, xMax), slant, nn);
        if (plausible(r2, i)) { read[i] = { ...r2, local: thr || 'otsu' }; return; }
      }
    });
    const [sys, dia, pulse] = read.map(r => (r ? r.value : null));
    const ok = [sys, dia, pulse].every(v => v !== null) && sys > dia;
    return {
      ok, sys, dia, pulse,
      debug: { lcd, angle, anchor, tallest: rows.filter(Boolean), rows, read, mask, ratio, w, h },
    };
  }

  const api = { recognize, findLcd, binarize, resize, cropInk, getNet, version: 4 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BpOcr = api;
})(typeof self !== 'undefined' ? self : this);
