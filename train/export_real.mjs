// Cut the digits out of real scans (labelled with the values you saved) for testing the
// classifier. Uses the current OCR pipeline to find rows and digit cells.
//   node train/export_real.mjs [backup.json ...]   (default: every image in test/fixtures)
// Writes train/data/real/<n>.pgm (ink map, 0 = background, 255 = darkest ink) + index.json.
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { readImage, readDataUrl } from '../test/img.mjs';
const ocr = createRequire(import.meta.url)('../ocr.js');

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, 'data', 'real');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const CROP_W = 24, CROP_H = 32; // keep in sync with train/common.py and ocr.js

// Source images: fixtures named SYS-DIA-PULSE-*, or the scans inside backups.
const sources = [];
const backups = process.argv.slice(2);
if (backups.length) {
  for (const b of backups) for (const r of JSON.parse(fs.readFileSync(b, 'utf8')).readings || []) {
    for (const p of (r.parts && r.parts.length ? r.parts : [r])) {
      if (p.thumb && p.sys && p.dia) sources.push({ id: `${p.sys}-${p.dia}-${p.pulse ?? 'x'}-${p.ts}`, want: p, load: () => readDataUrl(p.thumb) });
    }
  }
} else {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(path.join(here, '..', 'test', 'fixtures'))) {
    const m = path.basename(f).match(/^(\d+)-(\d+)-(\d+|x)-/);
    if (m) sources.push({ id: path.basename(f, path.extname(f)), want: { sys: +m[1], dia: +m[2], pulse: m[3] === 'x' ? null : +m[3] }, load: () => readImage(f) });
  }
}

const cropInk = (ratio, w, h, c) => Buffer.from(ocr.cropInk(ratio, w, h, c, [CROP_W, CROP_H]));

const index = [];
let n = 0, rowsUsed = 0, rowsSkipped = 0;
for (const s of sources) {
  const r = ocr.recognize(s.load(), { noNet: true });
  if (!r.debug || !r.debug.read) { rowsSkipped += 3; continue; }
  const { read, ratio, w, h } = r.debug;
  ['sys', 'dia', 'pulse'].forEach((field, i) => {
    const want = s.want[field], rr = read[i];
    // only rows where the pipeline found exactly as many digit cells as the true value has
    if (want == null || !rr || rr.digits.length !== String(want).length) { rowsSkipped++; return; }
    rowsUsed++;
    String(want).split('').forEach((ch, k) => {
      const file = `${n++}.pgm`;
      const pix = cropInk(ratio, w, h, rr.digits[k].cell);
      fs.writeFileSync(path.join(out, file), Buffer.concat([Buffer.from(`P5\n${CROP_W} ${CROP_H}\n255\n`), pix]));
      const d = rr.digits[k];
      index.push({ file, label: +ch, source: s.id, row: field, pos: k, ocr: d.segValue !== undefined ? d.segValue : d.value });
    });
  });
}
fs.writeFileSync(path.join(out, 'index.json'), JSON.stringify(index, null, 1));
const counts = Array(10).fill(0); index.forEach((e) => counts[e.label]++);
console.log(`${index.length} digits from ${sources.length} scans (rows used ${rowsUsed}, skipped ${rowsSkipped})`);
console.log('per digit:', counts.map((c, d) => `${d}:${c}`).join(' '));
console.log('7-bar decoder already right on', index.filter((e) => e.ocr === e.label).length, 'of them');
