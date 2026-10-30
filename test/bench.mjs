// Node benchmark, same method as test/bench.html: warm-up, then the variants alternated, medians.
//   node test/bench.mjs [photo] [--rounds 20]
import path from 'path';
import { createRequire } from 'module';
import { readImage } from './img.mjs';

const args = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const photoPath = args.find((a) => !a.startsWith('--')) || path.join(here, 'fixtures', '126-81-81-a.jpg');
const rounds = +(args[args.indexOf('--rounds') + 1] || 0) || 20;
const ocr = createRequire(import.meta.url)('../ocr.js');

const img = ocr.resize(readImage(photoPath), 1600);
const median = (v) => v.slice().sort((a, b) => a - b)[v.length >> 1];
const variants = [['rules only', { noNet: true }], ['with DigitNet', {}]];
for (let i = 0; i < 3; i++) for (const [, o] of variants) ocr.recognize(img, o); // warm-up (JIT)
const times = Object.fromEntries(variants.map(([n]) => [n, []]));
for (let i = 0; i < rounds; i++) {
  for (const [n, o] of variants) {
    const t = performance.now(); ocr.recognize(img, o); times[n].push(performance.now() - t);
  }
}
for (const [n] of variants) console.log(`full photo, ${n}: median ${median(times[n]).toFixed(0)} ms (min ${Math.min(...times[n]).toFixed(0)}, max ${Math.max(...times[n]).toFixed(0)})`);

const net = ocr.getNet();
const pix = new Uint8Array(net.meta.crop[0] * net.meta.crop[1]).map((_, i) => (i * 37) % 255);
for (let i = 0; i < 200; i++) net.predict(pix);
const per = [];
for (let r = 0; r < 9; r++) { const t = performance.now(); for (let i = 0; i < 500; i++) net.predict(pix); per.push((performance.now() - t) / 500); }
console.log(`DigitNet (${net.meta.crop.join('x')}, ${net.meta.params} params): median ${median(per).toFixed(3)} ms per digit`);
console.log(`Node ${process.version}`);
