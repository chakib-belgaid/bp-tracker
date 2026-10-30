// Tiny CNN digit classifier (forward pass only), trained by train/train.py.
// Input: CROP_W x CROP_H ink map (0 = background, 255 = darkest ink), see BpOcr.cropInk.
// Output: probabilities for classes 0-9 and 10 = "not a digit". No dependencies.
(function (root) {
  'use strict';

  function decode(b64) {
    let bytes;
    if (typeof Buffer !== 'undefined') bytes = Buffer.from(b64, 'base64');
    else { const s = atob(b64); bytes = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i); }
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }

  // 3x3 convolution, padding 1, + ReLU. input [cin][h][w], weight [cout][cin][3][3]
  function convRelu(input, cin, h, w, weight, bias, cout) {
    const out = new Float32Array(cout * h * w);
    for (let o = 0; o < cout; o++) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = bias[o];
        for (let c = 0; c < cin; c++) {
          const wb = ((o * cin + c) * 3) * 3, ib = c * h * w;
          for (let ky = 0; ky < 3; ky++) {
            const yy = y + ky - 1;
            if (yy < 0 || yy >= h) continue;
            for (let kx = 0; kx < 3; kx++) {
              const xx = x + kx - 1;
              if (xx < 0 || xx >= w) continue;
              s += weight[wb + ky * 3 + kx] * input[ib + yy * w + xx];
            }
          }
        }
        out[(o * h + y) * w + x] = s > 0 ? s : 0;
      }
    }
    return out;
  }

  function maxPool2(input, c, h, w) {
    const oh = h >> 1, ow = w >> 1, out = new Float32Array(c * oh * ow);
    for (let k = 0; k < c; k++) for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
      const b = k * h * w + 2 * y * w + 2 * x;
      out[(k * oh + y) * ow + x] = Math.max(input[b], input[b + 1], input[b + w], input[b + w + 1]);
    }
    return out;
  }

  function create(weights) {
    const t = {};
    for (const [name, v] of Object.entries(weights.tensors)) t[name] = decode(v.data);
    const [W, H] = weights.meta.crop;
    const layers = [['features.0', 1, 8], ['features.3', 8, 16], ['features.6', 16, 32]];
    const classes = weights.meta.classes;
    return {
      meta: weights.meta,
      // pixels: Uint8Array / array of W*H ink values (0..255). Returns Float32Array of probabilities.
      predict(pixels) {
        let x = new Float32Array(W * H);
        for (let i = 0; i < x.length; i++) x[i] = pixels[i] / 255;
        let h = H, w = W;
        for (const [name, cin, cout] of layers) {
          x = maxPool2(convRelu(x, cin, h, w, t[name + '.weight'], t[name + '.bias'], cout), cout, h, w);
          h >>= 1; w >>= 1;
        }
        const lw = t['head.2.weight'], lb = t['head.2.bias'], n = x.length;
        const logits = new Float32Array(classes);
        let max = -Infinity;
        for (let o = 0; o < classes; o++) {
          let s = lb[o];
          for (let i = 0; i < n; i++) s += lw[o * n + i] * x[i];
          logits[o] = s; if (s > max) max = s;
        }
        let sum = 0;
        for (let o = 0; o < classes; o++) { logits[o] = Math.exp(logits[o] - max); sum += logits[o]; }
        for (let o = 0; o < classes; o++) logits[o] /= sum;
        return logits;
      },
    };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DigitNet = api;
})(typeof self !== 'undefined' ? self : this);
