// Fills the app's IndexedDB with demo data for screenshots (see docs/screenshots.md).
// Synthetic: 30 days of morning / evening readings (some averaged from 2-3 measurements),
// two medications and their dose log. Real: the most recent readings use real display scans
// (their thumbnails and values) when `scans` is given: [{ url, sys, dia, pulse }, ...].
// Usage in the app's page: (await import('/docs/demo-seed.js')).default(scans)
export default async function seedDemo(scans = []) {
  let s = 42;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) * 1.4;
  const uid = () => 'demo-' + Math.floor(rnd() * 1e12).toString(36);
  const dayStart = (d) => { const t = new Date(); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() - d); return t.getTime(); };
  const at = (d, h, m) => dayStart(d) + (h * 60 + m) * 6e4;
  const average = (parts) => {
    const used = parts.length >= 3 ? parts.slice(1) : parts; // same rule as the app
    const mean = (k) => Math.round(used.reduce((a, p) => a + p[k], 0) / used.length);
    return { sys: mean('sys'), dia: mean('dia'), pulse: mean('pulse') };
  };
  const toDataUrl = async (url) => {
    const blob = await (await fetch(url)).blob();
    return new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
  };

  const readings = [];
  // real scans: one per slot, newest first (today evening, today morning, yesterday evening, ...)
  const slots = [];
  for (let d = 0; d < 30; d++) { slots.push([d, 20, 10 + Math.round(rnd() * 30)]); slots.push([d, 7, 20 + Math.round(rnd() * 30)]); }
  const nowMs = Date.now();
  const past = slots.filter(([d, h, m]) => at(d, h, m) < nowMs);
  for (let i = 0; i < scans.length && i < past.length; i++) {
    const [d, h, m] = past[i], sc = scans[i];
    const part = { ts: at(d, h, m), sys: sc.sys, dia: sc.dia, pulse: sc.pulse, thumb: await toDataUrl(sc.url), source: 'scan' };
    readings.push({ id: uid(), note: '', source: 'scan', parts: [part], ...average([part]), ts: part.ts, thumb: part.thumb });
  }
  // synthetic history for the rest
  for (const [d, h, m] of past.slice(scans.length)) {
    if (rnd() < 0.15) continue; // a skipped measurement now and then
    const base = { sys: 123 + 5 * Math.sin(d / 4) + (h < 12 ? 3 : -2) + gauss() * 4, dia: 78 + 2 * Math.sin(d / 4) + gauss() * 3, pulse: 72 + gauss() * 5 };
    const n = rnd() < 0.35 ? (rnd() < 0.5 ? 2 : 3) : 1;
    const parts = [];
    for (let k = 0; k < n; k++) {
      const first = k === 0 && n >= 3 ? 6 : 0; // the first of 3 reads high
      parts.push({ ts: at(d, h, m) + k * 70e3, sys: Math.round(base.sys + first + gauss() * 2), dia: Math.round(base.dia + gauss() * 1.5), pulse: Math.round(base.pulse + gauss() * 2), thumb: null, source: 'manual' });
    }
    readings.push({ id: uid(), note: rnd() < 0.08 ? 'after coffee' : '', source: 'manual', parts, ...average(parts), ts: parts[0].ts, thumb: null });
  }

  const meds = [
    { id: 'demo-med-1', name: 'Amlodipine', dose: '5 mg', times: ['08:00'], created: 1 },
    { id: 'demo-med-2', name: 'Vitamin D', dose: '1000 IU', times: ['20:00'], created: 2 },
  ];
  const doses = [];
  for (let d = 0; d < 30; d++) {
    for (const med of meds) {
      const [hh, mm] = med.times[0].split(':').map(Number);
      const ts = at(d, hh, mm) + Math.round(rnd() * 25) * 6e4;
      if (ts > nowMs || rnd() < 0.06) continue;
      const day = new Date(ts);
      const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      doses.push({ id: uid(), medId: med.id, medName: med.name, dose: med.dose, slot: med.times[0], date, ts });
    }
  }

  const db = await new Promise((res, rej) => { const q = indexedDB.open('bp-tracker', 2); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    q.onupgradeneeded = () => { for (const st of ['readings', 'meds', 'doses', 'settings']) if (!q.result.objectStoreNames.contains(st)) q.result.createObjectStore(st, { keyPath: 'id' }); }; });
  const tx = db.transaction(['readings', 'meds', 'doses'], 'readwrite');
  for (const st of ['readings', 'meds', 'doses']) tx.objectStore(st).clear();
  readings.forEach((r) => tx.objectStore('readings').put(r));
  meds.forEach((r) => tx.objectStore('meds').put(r));
  doses.forEach((r) => tx.objectStore('doses').put(r));
  await new Promise((r) => { tx.oncomplete = r; });
  db.close();
  return { readings: readings.length, real: Math.min(scans.length, past.length), doses: doses.length };
}
