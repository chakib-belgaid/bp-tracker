// Image I/O for Node tests (macOS: uses `sips` to decode JPEG/PNG/WebP to BMP).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

export function readBmp(file) {
  const b = fs.readFileSync(file);
  const off = b.readUInt32LE(10), w = b.readInt32LE(18), hRaw = b.readInt32LE(22), Bpp = b.readUInt16LE(28) / 8;
  const h = Math.abs(hRaw), stride = Math.ceil(w * Bpp / 4) * 4, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = hRaw > 0 ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const s = off + sy * stride + x * Bpp, d = (y * w + x) * 4;
      data[d] = b[s + 2]; data[d + 1] = b[s + 1]; data[d + 2] = b[s]; data[d + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

export function writeBmp(file, img) {
  const { width: w, height: h, data } = img, stride = Math.ceil(w * 3 / 4) * 4, size = 54 + stride * h, b = Buffer.alloc(size);
  b.write('BM', 0); b.writeUInt32LE(size, 2); b.writeUInt32LE(54, 10); b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18); b.writeInt32LE(-h, 22); b.writeUInt16LE(1, 26); b.writeUInt16LE(24, 28); b.writeUInt32LE(stride * h, 34);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4, d = 54 + y * stride + x * 3;
    b[d] = data[s + 2]; b[d + 1] = data[s + 1]; b[d + 2] = data[s];
  }
  fs.writeFileSync(file, b);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bpocr-'));
let n = 0;
export function readImage(file) {
  const out = path.join(tmp, `${n++}.bmp`);
  execFileSync('sips', ['-s', 'format', 'bmp', file, '--out', out], { stdio: 'ignore' });
  return readBmp(out);
}
export function readDataUrl(url) {
  const m = url.match(/^data:image\/(\w+);base64,(.*)$/);
  const f = path.join(tmp, `${n++}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
  fs.writeFileSync(f, Buffer.from(m[2], 'base64'));
  return readImage(f);
}
export function toJpegAndBack(img, quality = 70) {
  const a = path.join(tmp, `${n++}.bmp`), j = path.join(tmp, `${n++}.jpg`);
  writeBmp(a, img);
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality), a, '--out', j], { stdio: 'ignore' });
  return readImage(j);
}
