// JS forward pass vs PyTorch on every real digit crop (run train/bench.py first).
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const net = require('../digitnet.js').create(require('../digitnet-weights.js'));
const py = JSON.parse(fs.readFileSync(path.join(here, 'data', 'py_preds.json'), 'utf8'));
let same = 0, maxDiff = 0;
const acc = { dev: [0, 0], test: [0, 0] };
const crops = py.map((e) => { const b = fs.readFileSync(path.join(here, 'data', 'real', e.file)); return b.subarray(b.length - net.meta.crop[0] * net.meta.crop[1]); });
py.forEach((e, i) => {
  const p = net.predict(crops[i]);
  let k = 0; for (let c = 1; c < p.length; c++) if (p[c] > p[k]) k = c;
  if (k === e.pred) same++;
  p.forEach((v, c) => { maxDiff = Math.max(maxDiff, Math.abs(v - e.prob[c])); });
  acc[e.split][0] += k === e.label; acc[e.split][1]++;
});
const t = process.hrtime.bigint();
const reps = 20;
for (let r = 0; r < reps; r++) for (const c of crops) net.predict(c);
const ms = Number(process.hrtime.bigint() - t) / 1e6 / (reps * crops.length);
console.log(`same prediction as PyTorch: ${same}/${py.length}   max probability difference: ${maxDiff.toExponential(1)}`);
console.log(`JS accuracy: dev ${(acc.dev[0] / acc.dev[1]).toFixed(4)}  test ${(acc.test[0] / acc.test[1]).toFixed(4)}`);
console.log(`JS (Node ${process.version}) per digit: ${ms.toFixed(3)} ms`);
