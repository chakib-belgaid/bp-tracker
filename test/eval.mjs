// Accuracy report for the OCR.
//   node test/eval.mjs                       -> every image in test/fixtures (named SYS-DIA-PULSE-*.jpg)
//   node test/eval.mjs backup.json           -> every scanned thumbnail in an app backup, vs your saved values
//   node test/eval.mjs backup.json --extract -> also copy those thumbnails into test/fixtures/backup/
// Flags: --augment (also try rotated / shrunk / dimmed / recompressed copies), --no-anchor, --no-net, -v
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { readImage, readDataUrl, toJpegAndBack } from './img.mjs';
const ocr = createRequire(import.meta.url)('../ocr.js');

const here = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const backup = args.find((a) => a.endsWith('.json'));
const extract = args.includes('--extract');
const verbose = args.includes('-v');
const opts = { noAnchor: args.includes('--no-anchor'), noNet: args.includes('--no-net') };

function rotate(im, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), { width: w, height: h } = im, o = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x - w / 2, dy = y - h / 2, sx = Math.round(c * dx + s * dy + w / 2), sy = Math.round(-s * dx + c * dy + h / 2), d = (y * w + x) * 4;
    if (sx >= 0 && sy >= 0 && sx < w && sy < h) { const q = (sy * w + sx) * 4; o[d] = im.data[q]; o[d + 1] = im.data[q + 1]; o[d + 2] = im.data[q + 2]; }
    o[d + 3] = 255;
  }
  return { width: w, height: h, data: o };
}
function dim(im, f) { const o = new Uint8ClampedArray(im.data); for (let i = 0; i < o.length; i += 4) { o[i] *= f; o[i + 1] *= f; o[i + 2] *= f; } return { ...im, data: o }; }
const AUGMENTS = [
  ['rot-8', (im) => rotate(im, -8)], ['rot-4', (im) => rotate(im, -4)], ['rot+4', (im) => rotate(im, 4)], ['rot+8', (im) => rotate(im, 8)],
  ['small', (im) => ocr.resize(im, Math.max(im.width, im.height) * 0.6)], ['dim', (im) => dim(im, 0.6)], ['jpeg40', (im) => toJpegAndBack(im, 40)],
];

const cases = [];
if (backup) {
  const data = JSON.parse(fs.readFileSync(backup, 'utf8'));
  for (const r of data.readings || []) {
    const parts = r.parts && r.parts.length ? r.parts : [r];
    for (const p of parts) {
      if (!p.thumb || !p.sys || !p.dia) continue;
      cases.push({ name: `${p.sys}-${p.dia}-${p.pulse ?? 'x'}-${p.ts}`, want: p, load: () => readDataUrl(p.thumb), thumb: p.thumb, ts: p.ts, saved: p.ocr });
    }
  }
} else {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(path.join(here, 'fixtures'))) {
    const m = path.basename(f).match(/^(\d+)-(\d+)-(\d+|x)-/);
    if (m) cases.push({ name: path.relative(here, f), want: { sys: +m[1], dia: +m[2], pulse: m[3] === 'x' ? null : +m[3] }, load: () => readImage(f) });
  }
}
if (!cases.length) { console.log('No cases found.'); process.exit(1); }
if (args.includes('--augment')) {
  for (const c of cases.slice()) for (const [tag, fn] of AUGMENTS) {
    let cached;
    cases.push({ ...c, name: `${c.name} [${tag}]`, thumb: null, load: () => (cached ??= fn(c.load())) });
  }
}

const fields = ['sys', 'dia', 'pulse'];
const stats = { all: 0, sys: 0, dia: 0, pulse: 0, pulseN: 0, noRead: 0 };
const failures = [];
for (const c of cases) {
  let r;
  try { r = ocr.recognize(c.load(), opts); } catch (e) { r = { error: e.message }; }
  const ok = {};
  for (const f of fields) ok[f] = c.want[f] == null || r[f] === c.want[f];
  if (ok.sys) stats.sys++;
  if (ok.dia) stats.dia++;
  if (c.want.pulse != null) { stats.pulseN++; if (ok.pulse) stats.pulse++; }
  if (r.sys == null && r.dia == null) stats.noRead++;
  const pass = fields.every((f) => ok[f]);
  if (pass) stats.all++; else failures.push({ c, r, ok });
  if (verbose || !pass) {
    const got = fields.map((f) => (ok[f] ? r[f] : `\x1b[31m${r[f]}\x1b[0m`)).join('/');
    const anchor = r.debug && r.debug.anchor ? ' mmHg' : '';
    console.log(`${pass ? 'ok  ' : 'FAIL'} want ${c.want.sys}/${c.want.dia}/${c.want.pulse ?? '-'}  got ${got}${anchor}  ${c.name}`);
  }
  if (extract && c.thumb) {
    const dir = path.join(here, 'fixtures', 'backup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${c.name}.jpg`), Buffer.from(c.thumb.split(',')[1], 'base64'));
  }
}
const pct = (a, b) => `${a}/${b} (${Math.round(100 * a / b)}%)`;
console.log(`\nall three right: ${pct(stats.all, cases.length)}`);
console.log(`sys ${pct(stats.sys, cases.length)}  dia ${pct(stats.dia, cases.length)}  pulse ${stats.pulseN ? pct(stats.pulse, stats.pulseN) : '-'}  nothing read: ${stats.noRead}`);
if (extract) console.log(`thumbnails written to test/fixtures/backup/`);
process.exitCode = failures.length ? 1 : 0;
