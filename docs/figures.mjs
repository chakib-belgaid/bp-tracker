// Regenerates the README figures from the real pipeline: node docs/figures.mjs
// (macOS: uses `sips` for PNG/JPEG encoding)
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { readImage, writeBmp } from '../test/img.mjs';
const ocr = createRequire(import.meta.url)('../ocr.js');

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, 'img');
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fig-'));
const fixture = (f) => path.join(here, '..', 'test', 'fixtures', f);

function save(name, img) {
  const bmp = path.join(tmp, name + '.bmp');
  writeBmp(bmp, img);
  execFileSync('sips', ['-s', 'format', 'png', bmp, '--out', path.join(out, name + '.png')], { stdio: 'ignore' });
  console.log('wrote docs/img/' + name + '.png', `${img.width}x${img.height}`);
}
const blank = (w, h, v = 255) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(v) });
function put(img, x, y, [r, g, b]) {
  x = Math.round(x); y = Math.round(y);
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const i = (y * img.width + x) * 4; img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
}
function rect(img, x0, y0, x1, y1, col, t = 2) {
  for (let k = 0; k < t; k++) {
    for (let x = x0; x <= x1; x++) { put(img, x, y0 + k, col); put(img, x, y1 - k, col); }
    for (let y = y0; y <= y1; y++) { put(img, x0 + k, y, col); put(img, x1 - k, y, col); }
  }
}
function paste(dst, src, ox, oy, scale = 1) {
  for (let y = 0; y < src.height * scale; y++) for (let x = 0; x < src.width * scale; x++) {
    const i = (Math.floor(y / scale) * src.width + Math.floor(x / scale)) * 4;
    put(dst, ox + x, oy + y, [src.data[i], src.data[i + 1], src.data[i + 2]]);
  }
}
function hstack(imgs, gap = 16) {
  const H = Math.max(...imgs.map((i) => i.height)), W = imgs.reduce((a, i) => a + i.width, 0) + gap * (imgs.length - 1);
  const o = blank(W, H);
  let x = 0;
  for (const i of imgs) { paste(o, i, x, Math.round((H - i.height) / 2)); x += i.width + gap; }
  return o;
}
const fit = (img, h) => ocr.resize(img, Math.max(img.width, img.height) * h / img.height);
const gray = (vals, w, h, f) => {
  const o = blank(w, h);
  for (let p = 0; p < w * h; p++) { const v = f(vals[p]); o.data[p * 4] = o.data[p * 4 + 1] = o.data[p * 4 + 2] = v; }
  return o;
};
const RED = [220, 40, 40], BLUE = [40, 90, 220], GREEN = [20, 160, 60];

// ---- 1. the pipeline on one photo ----
const photo = ocr.resize(readImage(fixture('126-81-81-a.jpg')), 1600);
const r = ocr.recognize(photo);
const { lcd, ratio, mask, w, h, rows, anchor, read } = r.debug;

const withBox = { ...photo, data: new Uint8ClampedArray(photo.data) };
rect(withBox, lcd.x, lcd.y, lcd.x + lcd.w, lcd.y + lcd.h, [255, 60, 60], 10);
const step1 = fit(withBox, 500);

// ink map: pixel relative to its local background (white = background)
const step2 = fit(gray(ratio, w, h, (v) => Math.max(0, Math.min(255, 255 - (128 - v) * 2))), 500);

// binary mask + rows, "mmHg" anchor and digit cells
const m = gray(mask, w, h, (v) => (v ? 0 : 255));
for (const row of rows) if (row) rect(m, 0, row[0], w - 1, row[1], RED, 2);
if (anchor) rect(m, anchor.x0 - 2, anchor.y0 - 2, anchor.x1 + 2, anchor.y1 + 2, BLUE, 2);
for (const rr of read) if (rr) for (const d of rr.digits) rect(m, d.cell.x0, d.cell.y0, d.cell.x1, d.cell.y1, GREEN, 2);
const step3 = fit(m, 500);
save('pipeline', hstack([step1, step2, step3], 24));

// ---- 2. digit crops the network sees ----
const crops = [];
for (const rr of read) if (rr) for (const d of rr.digits) {
  const c = ocr.cropInk(ratio, w, h, d.cell);
  crops.push(gray(c, ...ocr.getNet().meta.crop, (v) => 255 - v));
}
const [CW, CH] = ocr.getNet().meta.crop;
const sheet = blank(crops.length * (CW * 5 + 10) - 10, CH * 5);
crops.forEach((c, k) => { paste(sheet, c, k * (CW * 5 + 10), 0, 5); rect(sheet, k * (CW * 5 + 10), 0, k * (CW * 5 + 10) + CW * 5 - 1, CH * 5 - 1, [190, 190, 190], 1); });
save('crops', sheet);

// ---- 3. why not a plain threshold: global Otsu on grey vs. local-background ratio ----
const p2 = ocr.resize(readImage(fixture('126-81-81-b.jpg')), 1600);
const r2 = ocr.recognize(p2);
const L = r2.debug.lcd;
const lcdCrop = blank(L.w, L.h);
for (let y = 0; y < L.h; y++) for (let x = 0; x < L.w; x++) {
  const s = ((L.y + y) * p2.width + L.x + x) * 4, d = (y * L.w + x) * 4;
  lcdCrop.data[d] = p2.data[s]; lcdCrop.data[d + 1] = p2.data[s + 1]; lcdCrop.data[d + 2] = p2.data[s + 2];
}
const g = new Uint8Array(L.w * L.h);
for (let p = 0; p < g.length; p++) g[p] = (lcdCrop.data[p * 4] + lcdCrop.data[p * 4 + 1] + lcdCrop.data[p * 4 + 2]) / 3;
const hist = new Array(256).fill(0); g.forEach((v) => hist[v]++);
let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
let sB = 0, wB = 0, best = 0, thr = 128;
for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = g.length - wB; if (!wF) break; sB += t * hist[t]; const d = sB / wB - (sum - sB) / wF; if (wB * wF * d * d > best) { best = wB * wF * d * d; thr = t; } }
const naive = gray(g, L.w, L.h, (v) => (v < thr ? 0 : 255));
const ours = gray(r2.debug.mask, r2.debug.w, r2.debug.h, (v) => (v ? 0 : 255));
save('threshold', hstack([fit(lcdCrop, 360), fit(naive, 360), fit(ours, 360)], 24));

// ---- 4. real scans: different backlights, glare, faint digits ----
const backup = path.join(here, '..', 'test', 'fixtures', 'backup');
const pick = ['121-79-90-1792956060000.jpg', '138-81-97-1793008020000.jpg', '130-73-108-1792481220000.jpg', '126-75-93-1792742220000.jpg', '139-83-91-1792391520000.jpg'];
if (fs.existsSync(backup)) save('scans', hstack(pick.filter((f) => fs.existsSync(path.join(backup, f))).map((f) => fit(readImage(path.join(backup, f)), 240)), 12));
else console.log('skipped scans.png (test/fixtures/backup not present)');
