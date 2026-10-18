// Offline seven-segment OCR for backlit blood-pressure monitor displays.
// Works on any ImageData-like object {width, height, data: RGBA}.
// No dependencies, no network: runs in the browser and in Node (for tests).
(function (root) {
  'use strict';

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
  function rotateMask(mask, w, h, deg) {
    const t = deg * Math.PI / 180, sn = Math.sin(t), cs = Math.cos(t);
    const out = new Uint8Array(w * h), cx = w / 2, cy = h / 2;
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
    return mask;
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

  // Drop dark blobs touching the crop edge (bezel, shadows) and huge blobs.
  function clearBorderBlobs(mask, w, h) {
    const { boxes, label } = components(mask, w, h, 0);
    const kill = new Set();
    for (const b of boxes) {
      if (b.x0 === 0 || b.y0 === 0 || b.x1 === w - 1 || b.y1 === h - 1 || b.area > w * h * 0.08) kill.add(b.id);
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
  function fillHoles(mask, w, h, maxArea) {
    const inv = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) inv[p] = mask[p] ? 0 : 1;
    const { boxes, label } = components(inv, w, h, 0);
    const fill = new Set();
    for (const b of boxes) {
      if (b.area <= maxArea && b.x0 > 0 && b.y0 > 0 && b.x1 < w - 1 && b.y1 < h - 1) fill.add(b.id);
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
    if (bw < digitW * 0.45) return { value: 1, segs: '0110000' };
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
    return { value: value === undefined ? null : value, segs, scores };
  }

  // Split a text row into digit boxes using the vertical projection.
  function rowBoxes(mask, w, row, xMin) {
    const [ry0, ry1] = row;
    const rh = ry1 - ry0 + 1;
    const prof = new Float32Array(w);
    for (let x = xMin; x < w; x++) {
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

  function decodeRow(mask, w, row, boxes, slant) {
    if (!boxes.length) return null;
    const digitW = Math.max(...boxes.map(b => b.x1 - b.x0 + 1));
    const digits = boxes.map(b => decodeDigit(mask, w, { ...b, y0: row[0], y1: row[1] }, digitW, slant));
    const value = digits.some(d => d.value === null) || digits.length > 3 ? null : Number(digits.map(d => d.value).join(''));
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

  function recognize(input, opts) {
    opts = opts || {};
    const img = resize(input, 1600);
    const lcd = opts.lcd || findLcd(img);
    if (!lcd) return { ok: false, error: 'Display not found' };
    // trim the LCD bezel a little
    const inset = { x: lcd.x + Math.round(lcd.w * 0.02), y: lcd.y + Math.round(lcd.h * 0.02), w: Math.round(lcd.w * 0.96), h: Math.round(lcd.h * 0.96) };
    const lcdImg = scaleTo(crop(img, inset), 500);
    const { width: w, height: h } = lcdImg;
    let mask = binarize(lcdImg);
    clearBorderBlobs(mask, w, h);
    // straighten tilted photos so text rows are horizontal
    const angle = estimateSkew(mask, w, h);
    if (Math.abs(angle) > 0.4) {
      mask = rotateMask(mask, w, h, angle);
      clearBorderBlobs(mask, w, h);
    }
    // close tiny breaks in faint, outline-only segments, then fill them in
    mask = close(mask, w, h);
    fillHoles(mask, w, h, w * h * 0.004);

    // The numbers occupy the right side of the display; labels/icons are on the left.
    const xMin = Math.round(w * 0.38);
    const rowProf = new Float32Array(h);
    for (let y = 0; y < h; y++) {
      let c = 0;
      for (let x = xMin; x < w; x++) c += mask[y * w + x];
      rowProf[y] = c;
    }
    // any empty scan line splits rows (keeps the small "mmHg" label apart from the pulse)
    const rows = bands(rowProf, 0, 1)
      .filter(([a, b]) => b - a + 1 > h * 0.06);
    // SYS / DIA / PULSE are the three tallest text rows, in vertical order
    const tallest = rows.slice().sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, 3)
      .sort((a, b) => a[0] - b[0]);
    const rowInfo = tallest.map(row => ({ row, boxes: rowBoxes(mask, w, row, xMin) }));
    const slant = estimateSlant(mask, w, rowInfo);
    const read = rowInfo.map(r => decodeRow(mask, w, r.row, r.boxes, slant));
    const [sys, dia, pulse] = read.map(r => (r ? r.value : null));
    const ok = [sys, dia, pulse].every(v => v !== null) && sys > dia;
    return {
      ok, sys, dia, pulse,
      debug: { lcd, angle, rows, tallest, read, mask, w, h },
    };
  }

  const api = { recognize, findLcd, binarize, resize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BpOcr = api;
})(typeof self !== 'undefined' ? self : this);
