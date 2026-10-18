/* BP Log — offline blood pressure + medication tracker. All data stays in IndexedDB. */
(function () {
  'use strict';

  // ---------- storage ----------
  const STORES = ['readings', 'meds', 'doses'];
  let dbPromise;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('bp-tracker', 1);
        req.onupgradeneeded = () => {
          for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function run(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const result = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      tx.onerror = () => reject(tx.error);
    });
  }
  const all = (s) => run(s, 'readonly', (st) => st.getAll());
  const put = (s, v) => run(s, 'readwrite', (st) => st.put(v));
  const del = (s, id) => run(s, 'readwrite', (st) => st.delete(id));
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k !== null && k !== undefined) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const timeStr = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const localInput = (t) => `${dayKey(t)}T${timeStr(t)}`;
  const fmtDay = (t) => new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const today = () => dayKey(Date.now());

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { t.hidden = true; }, 2500);
  }

  // AHA 2017 categories; status colours always ship with a text label
  function category(sys, dia) {
    if (sys > 180 || dia > 120) return { label: 'Crisis', cls: 'critical' };
    if (sys >= 140 || dia >= 90) return { label: 'Stage 2', cls: 'critical' };
    if (sys >= 130 || dia >= 80) return { label: 'Stage 1', cls: 'serious' };
    if (sys >= 120) return { label: 'Elevated', cls: 'warning' };
    return { label: 'Normal', cls: 'good' };
  }
  const statusEl = (r) => { const c = category(r.sys, r.dia); return el('span', { class: `status ${c.cls}` }, c.label); };

  function avg(list, key) {
    const v = list.map((r) => r[key]).filter((x) => typeof x === 'number');
    return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
  }

  // ---------- state ----------
  let readings = [], meds = [], doses = [];
  let range = 30;
  async function load() {
    [readings, meds, doses] = await Promise.all(STORES.map(all));
    readings.sort((a, b) => b.ts - a.ts);
    doses.sort((a, b) => b.ts - a.ts);
    meds.sort((a, b) => a.created - b.created);
    render();
  }

  // ---------- tabs ----------
  function showTab() {
    const name = (location.hash || '#today').slice(1);
    const known = ['today', 'history', 'meds', 'data'].includes(name) ? name : 'today';
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${known}`));
    document.querySelectorAll('nav.bottom a').forEach((a) => a.classList.toggle('active', a.dataset.tab === known));
    if (known === 'history') renderChart();
    if (known === 'data') renderStorage();
  }
  window.addEventListener('hashchange', showTab);

  // ---------- render ----------
  function render() {
    renderLatest();
    renderTodayMeds();
    renderHistory();
    renderMeds();
    showTab();
  }

  function stat(label, value) {
    return el('div', { class: 'stat' }, el('div', { class: 'label' }, label), el('div', { class: 'value' }, value ?? '–'));
  }

  function renderLatest() {
    const box = $('#latest');
    box.replaceChildren();
    const r = readings[0];
    if (!r) {
      box.append(el('h2', {}, 'No readings yet'), el('p', { class: 'muted' }, 'Take a photo of your monitor after a measurement — the numbers are read on the phone, offline.'));
    } else {
      box.append(
        el('div', { class: 'reading-hero' },
          el('span', { class: 'bp' }, `${r.sys}/${r.dia}`),
          r.pulse ? el('span', { class: 'pulse' }, `${r.pulse} bpm`) : null,
          statusEl(r)),
        el('div', { class: 'when' }, `Latest · ${fmtDay(r.ts)} ${timeStr(r.ts)}`));
    }
    const week = readings.filter((x) => x.ts > Date.now() - 7 * 864e5);
    const s = avg(week, 'sys'), d = avg(week, 'dia');
    $('#averages').replaceChildren(
      stat('7-day avg', s ? `${s}/${d}` : null),
      stat('Avg pulse', avg(week, 'pulse')),
      stat('Readings (7d)', week.length));
  }

  function slotsFor(med) { return med.times && med.times.length ? med.times : ['']; }

  function renderTodayMeds() {
    const list = $('#today-meds');
    list.replaceChildren();
    $('#no-meds').hidden = meds.length > 0;
    const t = today();
    const items = [];
    for (const m of meds) for (const slot of slotsFor(m)) items.push({ m, slot });
    items.sort((a, b) => (a.slot || '99').localeCompare(b.slot || '99'));
    for (const { m, slot } of items) {
      const taken = doses.find((x) => x.date === t && x.medId === m.id && (x.slot || '') === slot);
      const cb = el('input', { type: 'checkbox', checked: !!taken });
      cb.addEventListener('change', async () => {
        if (cb.checked) {
          await put('doses', { id: uid(), medId: m.id, medName: m.name, dose: m.dose || '', slot, date: t, ts: Date.now() });
        } else if (taken) {
          await del('doses', taken.id);
        }
        load();
      });
      list.append(el('li', {}, el('label', {}, cb,
        el('div', { class: 'main' },
          el('div', { class: 'title' }, `${m.name}${m.dose ? ' · ' + m.dose : ''}`),
          el('div', { class: 'sub' }, taken ? `Taken at ${timeStr(taken.ts)}` : (slot ? `Due ${slot}` : 'Once a day'))))));
    }
  }

  function inRange(list) {
    return range ? list.filter((r) => r.ts > Date.now() - range * 864e5) : list;
  }

  function renderHistory() {
    const list = $('#history-list');
    list.replaceChildren();
    const rs = inRange(readings);
    if (!rs.length) list.append(el('li', { class: 'muted' }, 'No readings in this range.'));
    let lastDay = '';
    for (const r of rs) {
      const d = dayKey(r.ts);
      if (d !== lastDay) { list.append(el('li', { class: 'day-head' }, fmtDay(r.ts))); lastDay = d; }
      list.append(el('li', { onclick: () => openEditor(r) },
        r.thumb ? el('img', { class: 'thumb', src: r.thumb, alt: '' }) : null,
        el('div', { class: 'main' },
          el('div', { class: 'title' }, `${r.sys}/${r.dia}`, r.pulse ? el('span', { class: 'muted' }, `  ·  ${r.pulse} bpm`) : null),
          el('div', { class: 'sub' }, timeStr(r.ts) + (r.parts && r.parts.length > 1 ? ` · avg of ${r.parts.length}` : '') + (r.note ? ` · ${r.note}` : ''))),
        statusEl(r)));
    }
    const s = avg(rs, 'sys'), dd = avg(rs, 'dia');
    $('#range-stats').replaceChildren(
      stat('Average', s ? `${s}/${dd}` : null),
      stat('Avg pulse', avg(rs, 'pulse')),
      stat('Readings', rs.length));
    if ($('#tab-history').classList.contains('active')) renderChart();
  }

  function renderMeds() {
    const list = $('#med-list');
    list.replaceChildren();
    if (!meds.length) list.append(el('li', { class: 'muted' }, 'Nothing yet — add your first medication below.'));
    for (const m of meds) {
      list.append(el('li', {},
        el('div', { class: 'main' },
          el('div', { class: 'title' }, m.name),
          el('div', { class: 'sub' }, [m.dose, m.times && m.times.length ? m.times.join(', ') : 'once a day'].filter(Boolean).join(' · '))),
        el('button', { class: 'btn small danger', onclick: async () => {
          if (!confirm(`Remove ${m.name}? Its past dose log is kept.`)) return;
          await del('meds', m.id); load();
        } }, 'Remove')));
    }
    const dl = $('#dose-list');
    dl.replaceChildren();
    if (!doses.length) dl.append(el('li', { class: 'muted' }, 'Doses you tick on the Today tab appear here.'));
    for (const x of doses.slice(0, 60)) {
      dl.append(el('li', {}, el('div', { class: 'main' },
        el('div', { class: 'title' }, `${x.medName}${x.dose ? ' · ' + x.dose : ''}`),
        el('div', { class: 'sub' }, `${fmtDay(x.ts)} ${timeStr(x.ts)}${x.slot ? ` (scheduled ${x.slot})` : ''}`))));
    }
  }

  $('#med-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const times = String(f.get('times') || '').split(/[,\s]+/).map((t) => t.trim()).filter(Boolean)
      .map((t) => { const m = t.match(/^(\d{1,2})(?::?(\d{2}))?$/); return m ? `${pad(Math.min(23, +m[1]))}:${m[2] || '00'}` : null; })
      .filter(Boolean).sort();
    await put('meds', { id: uid(), name: String(f.get('name')).trim(), dose: String(f.get('dose') || '').trim(), times, created: Date.now() });
    e.target.reset();
    toast('Medication added');
    load();
  });

  document.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
    range = +b.dataset.range;
    document.querySelectorAll('[data-range]').forEach((x) => x.classList.toggle('active', x === b));
    renderHistory();
  }));

  // ---------- chart (SVG, single mmHg axis) ----------
  function renderChart() {
    const box = $('#chart');
    const W = box.clientWidth || 320, H = box.clientHeight || 220;
    const pts = inRange(readings).slice().sort((a, b) => a.ts - b.ts);
    const m = { l: 30, r: 34, t: 10, b: 22 };
    const ns = 'http://www.w3.org/2000/svg';
    if (!pts.length) {
      box.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text class="empty" x="${W / 2}" y="${H / 2}" text-anchor="middle">No readings in this range</text></svg>`;
      return;
    }
    let lo = Math.min(...pts.map((p) => p.dia)), hi = Math.max(...pts.map((p) => p.sys));
    lo = Math.floor((Math.min(lo, 80) - 10) / 10) * 10;
    hi = Math.ceil((Math.max(hi, 130) + 10) / 10) * 10;
    let t0 = pts[0].ts, t1 = pts[pts.length - 1].ts;
    if (t1 - t0 < 864e5) { t0 -= 432e5; t1 += 432e5; }
    const x = (t) => m.l + (t - t0) / (t1 - t0) * (W - m.l - m.r);
    const y = (v) => m.t + (hi - v) / (hi - lo) * (H - m.t - m.b);
    const step = (hi - lo) > 100 ? 40 : 20;
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Blood pressure chart">`;
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    }
    // stage-1 thresholds as reference lines
    for (const v of [130, 80]) s += `<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    // x ticks: ~4 dates
    const n = Math.min(4, pts.length);
    for (let i = 0; i < n; i++) {
      const t = t0 + (t1 - t0) * (n === 1 ? 0.5 : i / (n - 1));
      const anchor = n === 1 ? 'middle' : i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
      s += `<text x="${x(t)}" y="${H - 4}" text-anchor="${anchor}">${new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</text>`;
    }
    const path = (key) => 'M' + pts.map((p) => `${x(p.ts).toFixed(1)},${y(p[key]).toFixed(1)}`).join('L');
    s += `<path class="line" d="${path('sys')}" stroke="var(--sys)"/><path class="line" d="${path('dia')}" stroke="var(--dia)"/>`;
    if (pts.length <= 60) {
      for (const p of pts) {
        s += `<circle class="dot" cx="${x(p.ts)}" cy="${y(p.sys)}" r="4" fill="var(--sys)"/><circle class="dot" cx="${x(p.ts)}" cy="${y(p.dia)}" r="4" fill="var(--dia)"/>`;
      }
    }
    const last = pts[pts.length - 1];
    s += `<text class="endlabel" x="${x(last.ts) + 8}" y="${y(last.sys) + 4}">${last.sys}</text><text class="endlabel" x="${x(last.ts) + 8}" y="${y(last.dia) + 4}">${last.dia}</text>`;
    s += `<line class="cross" id="cross" y1="${m.t}" y2="${H - m.b}" visibility="hidden"/>`;
    s += `<rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent" id="hit"/></svg>`;
    box.innerHTML = s;

    const svg = box.querySelector('svg'), cross = svg.querySelector('#cross'), tip = $('#tooltip');
    const move = (ev) => {
      const rect = svg.getBoundingClientRect();
      const px = (ev.clientX - rect.left) * (W / rect.width);
      let best = pts[0];
      for (const p of pts) if (Math.abs(x(p.ts) - px) < Math.abs(x(best.ts) - px)) best = p;
      cross.setAttribute('x1', x(best.ts)); cross.setAttribute('x2', x(best.ts)); cross.setAttribute('visibility', 'visible');
      const row = (color, val, label) => el('div', { class: 'r' }, el('i', { class: 'key', style: `background:${color}` }), el('b', {}, val), el('span', {}, label));
      tip.replaceChildren(
        el('div', { class: 't' }, `${fmtDay(best.ts)} ${timeStr(best.ts)}`),
        row('var(--sys)', best.sys, 'systolic'),
        row('var(--dia)', best.dia, 'diastolic'),
        best.pulse ? el('div', { class: 'r' }, el('i', { class: 'key' }), el('b', {}, best.pulse), el('span', {}, 'bpm')) : null);
      tip.hidden = false;
      const card = box.parentElement.getBoundingClientRect();
      const left = rect.left - card.left + x(best.ts) * rect.width / W;
      tip.style.left = Math.max(8, Math.min(card.width - tip.offsetWidth - 8, left - tip.offsetWidth / 2)) + 'px';
      tip.style.top = (rect.top - card.top + 4) + 'px';
    };
    const leave = () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerdown', move);
    svg.addEventListener('pointerleave', leave);
  }
  window.addEventListener('resize', () => { if ($('#tab-history').classList.contains('active')) renderChart(); });

  // ---------- reading editor + OCR ----------
  const dlg = $('#editor'), form = $('#reading-form');
  let editing = null, pendingThumb = null, pendingSource = 'manual';
  // Measurements already taken for the reading being entered; saved as their average.
  let series = [];

  const num = (v) => (v === '' ? null : Number(v));
  const fmtPart = (p) => `${p.sys}/${p.dia}${p.pulse ? ` · ${p.pulse} bpm` : ''}`;
  const fieldsEmpty = () => form.elements.sys.value === '' && form.elements.dia.value === '' && form.elements.pulse.value === '';
  const currentPart = () => {
    const p = { sys: num(form.elements.sys.value), dia: num(form.elements.dia.value), pulse: num(form.elements.pulse.value) };
    return p.sys && p.dia ? p : null;
  };
  function averageOf(parts) {
    const pulses = parts.filter((p) => p.pulse);
    const mean = (list, k) => Math.round(list.reduce((a, p) => a + p[k], 0) / list.length);
    return { sys: mean(parts, 'sys'), dia: mean(parts, 'dia'), pulse: pulses.length ? mean(pulses, 'pulse') : null };
  }
  // Every measurement in the series, including the one still in the fields.
  function seriesParts() {
    const cur = currentPart();
    return cur ? [...series, cur] : series.slice();
  }

  function renderSeries() {
    const n = series.length;
    $('#series').hidden = !n;
    $('#series-list').replaceChildren(...series.map((p, i) => el('li', {},
      el('span', {}, `${i + 1}.`), el('b', {}, fmtPart(p)),
      el('button', { type: 'button', class: 'btn small', 'aria-label': `Remove measurement ${i + 1}`, onclick: () => { series.splice(i, 1); renderSeries(); } }, 'Remove'))));
    $('#series-current').textContent = `Measurement ${n + 1}`;
    const parts = seriesParts();
    const avgEl = $('#series-avg');
    avgEl.hidden = parts.length < 2;
    if (parts.length >= 2) avgEl.textContent = `Average of ${parts.length}: ${fmtPart(averageOf(parts))}`;
    // with earlier measurements, the fields may stay empty (e.g. a failed last scan)
    const optional = n > 0 && fieldsEmpty();
    form.elements.sys.required = form.elements.dia.required = !optional;
    $('#save-reading').textContent = parts.length >= 2 ? `Save average (${parts.length})` : 'Save';
  }
  for (const f of ['sys', 'dia', 'pulse']) form.elements[f].addEventListener('input', renderSeries);

  function clearFields() {
    for (const f of ['sys', 'dia', 'pulse']) { form.elements[f].value = ''; form.elements[f].classList.remove('check'); }
  }

  function openEditor(existing, opts) {
    opts = opts || {};
    editing = existing || null;
    series = [];
    pendingThumb = existing ? existing.thumb || null : null;
    pendingSource = existing ? existing.source : (opts.scan ? 'scan' : 'manual');
    form.reset();
    $('#editor-title').textContent = existing ? 'Edit reading' : opts.scan ? 'Check the scanned values' : 'New reading';
    $('#delete-reading').hidden = !existing;
    $('#scan-preview').hidden = !opts.scan;
    $('#series-add').hidden = !!existing;
    for (const f of ['sys', 'dia', 'pulse']) {
      form.elements[f].value = existing && existing[f] != null ? existing[f] : '';
      form.elements[f].classList.remove('check');
    }
    form.elements.note.value = existing ? existing.note || '' : '';
    form.elements.ts.value = localInput(existing ? existing.ts : opts.ts || Date.now());
    renderSeries();
    if (existing && existing.parts && existing.parts.length > 1) {
      $('#series-avg').hidden = false;
      $('#series-avg').textContent = `Average of ${existing.parts.length}: ${existing.parts.map(fmtPart).join(', ')}`;
    }
    if (!dlg.open) dlg.showModal();
  }

  $('#manual-btn').addEventListener('click', () => openEditor(null));

  // Move the values in the fields into the series. Returns false if they are not complete yet.
  function pushCurrent() {
    const cur = currentPart();
    if (!cur) {
      if (!fieldsEmpty() || !series.length) {
        form.elements.sys.required = form.elements.dia.required = true;
        form.reportValidity();
        return false;
      }
      return true; // nothing typed, earlier measurements exist: just take another one
    }
    series.push(cur);
    clearFields();
    renderSeries();
    return true;
  }
  for (const id of ['#next-scan-btn', '#next-pick-btn']) {
    // check the current values before the picker opens; they move into the series once a photo is chosen
    $(id).addEventListener('click', (e) => { if (e.target.tagName !== 'INPUT' && !currentPart() && !(fieldsEmpty() && series.length)) { e.preventDefault(); pushCurrent(); } });
  }
  for (const id of ['#next-scan', '#next-pick']) {
    $(id).addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file && pushCurrent()) handleImage(file, { append: true });
    });
  }
  $('#next-manual').addEventListener('click', () => {
    if (!pushCurrent()) return;
    $('#scan-preview').hidden = true;
    form.elements.sys.focus();
  });

  // don't lose a series to a stray Cancel or Esc
  const keepSeries = (e) => {
    const n = seriesParts().length;
    if (series.length && !confirm(n === 1 ? 'Discard this measurement?' : `Discard these ${n} measurements?`)) e.preventDefault();
  };
  dlg.addEventListener('cancel', keepSeries);
  form.querySelector('button[value=cancel]').addEventListener('click', keepSeries);

  dlg.addEventListener('close', async () => {
    const action = dlg.returnValue;
    if (action === 'save') {
      const parts = seriesParts();
      const vals = parts.length >= 2 ? averageOf(parts) : {
        sys: num(form.elements.sys.value), dia: num(form.elements.dia.value), pulse: num(form.elements.pulse.value),
      };
      const rec = {
        id: editing ? editing.id : uid(),
        ts: new Date(form.elements.ts.value).getTime() || Date.now(),
        ...vals,
        note: form.elements.note.value.trim(),
        source: pendingSource,
        thumb: pendingThumb,
      };
      if (parts.length >= 2) rec.parts = parts;
      else if (editing && editing.parts) rec.parts = editing.parts;
      await put('readings', rec);
      toast(parts.length >= 2 ? `Saved average ${rec.sys}/${rec.dia} (${parts.length} measurements)` : `Saved ${rec.sys}/${rec.dia}`);
      load();
    } else if (action === 'delete' && editing) {
      if (confirm('Delete this reading?')) { await del('readings', editing.id); toast('Reading deleted'); load(); }
    }
    series = [];
    dlg.returnValue = '';
  });

  async function handleImage(file, opts) {
    if (!file) return;
    if (opts && opts.append) {
      // next measurement of a series: keep the dialog, time and note
      $('#editor-title').textContent = 'Check the scanned values';
      $('#scan-preview').hidden = false;
      if (pendingSource === 'manual') pendingSource = 'scan';
      clearFields();
      renderSeries();
    } else {
      openEditor(null, { scan: true, ts: file.lastModified || Date.now() });
    }
    const status = $('#scan-status');
    status.className = 'scan-status';
    status.textContent = 'Reading the display…';
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.src = url;
      await img.decode();
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, c.width, c.height);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const res = window.BpOcr.recognize(ctx.getImageData(0, 0, c.width, c.height));

      // preview: the detected display (or the whole photo if not found)
      const lcd = res.debug && res.debug.lcd;
      const crop = lcd ? { x: Math.max(0, lcd.x - lcd.w * 0.05), y: Math.max(0, lcd.y - lcd.h * 0.05), w: lcd.w * 1.1, h: lcd.h * 1.1 } : { x: 0, y: 0, w: c.width, h: c.height };
      crop.w = Math.min(crop.w, c.width - crop.x); crop.h = Math.min(crop.h, c.height - crop.y);
      const pv = $('#preview-canvas');
      pv.width = Math.round(crop.w); pv.height = Math.round(crop.h);
      pv.getContext('2d').drawImage(c, crop.x, crop.y, crop.w, crop.h, 0, 0, pv.width, pv.height);
      const tc = document.createElement('canvas');
      const ts = 160 / Math.max(crop.w, crop.h);
      tc.width = Math.round(crop.w * ts); tc.height = Math.round(crop.h * ts);
      tc.getContext('2d').drawImage(c, crop.x, crop.y, crop.w, crop.h, 0, 0, tc.width, tc.height);
      pendingThumb = tc.toDataURL('image/jpeg', 0.7);

      const plausible = { sys: [60, 260], dia: [30, 160], pulse: [30, 220] };
      let doubtful = 0;
      for (const f of ['sys', 'dia', 'pulse']) {
        const v = res[f];
        const ok = typeof v === 'number' && v >= plausible[f][0] && v <= plausible[f][1];
        form.elements[f].value = typeof v === 'number' ? v : '';
        form.elements[f].classList.toggle('check', !ok);
        if (!ok) doubtful++;
      }
      if (res.sys != null && res.dia != null && res.sys <= res.dia) { form.elements.sys.classList.add('check'); form.elements.dia.classList.add('check'); doubtful++; }
      if (!lcd) { status.className = 'scan-status warn'; status.textContent = 'Could not find the display. Enter the numbers manually.'; }
      else if (doubtful) { status.className = 'scan-status warn'; status.textContent = 'Some values could not be read — please check the highlighted fields.'; }
      else { status.className = 'scan-status ok'; status.textContent = 'Read from photo — compare with the display, then save.'; }
      renderSeries();
    } catch (err) {
      status.className = 'scan-status warn';
      status.textContent = 'Could not read this image. Enter the numbers manually.';
      console.error(err);
    }
  }
  for (const id of ['#scan-input', '#pick-input']) {
    $(id).addEventListener('change', (e) => { handleImage(e.target.files[0]); e.target.value = ''; });
  }

  // ---------- export / import ----------
  function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function download(name, text, type) {
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  const stamp = () => today();

  $('#export-readings').addEventListener('click', () => {
    const rows = [['datetime', 'date', 'time', 'systolic', 'diastolic', 'pulse', 'category', 'note', 'source', 'measurements']];
    for (const r of readings.slice().sort((a, b) => a.ts - b.ts)) {
      const parts = r.parts && r.parts.length > 1 ? r.parts.map((p) => `${p.sys}/${p.dia}${p.pulse ? '/' + p.pulse : ''}`).join('; ') : '';
      rows.push([localInput(r.ts), dayKey(r.ts), timeStr(r.ts), r.sys, r.dia, r.pulse, category(r.sys, r.dia).label, r.note, r.source, parts]);
    }
    download(`bp-readings-${stamp()}.csv`, rows.map((r) => r.map(csvCell).join(',')).join('\n'), 'text/csv');
  });
  $('#export-doses').addEventListener('click', () => {
    const rows = [['datetime', 'date', 'time', 'medication', 'dose', 'scheduled']];
    for (const x of doses.slice().sort((a, b) => a.ts - b.ts)) rows.push([localInput(x.ts), dayKey(x.ts), timeStr(x.ts), x.medName, x.dose, x.slot]);
    download(`medication-log-${stamp()}.csv`, rows.map((r) => r.map(csvCell).join(',')).join('\n'), 'text/csv');
  });
  $('#export-json').addEventListener('click', () => {
    download(`bp-backup-${stamp()}.json`, JSON.stringify({ app: 'bp-tracker', version: 1, readings, meds, doses }, null, 1), 'application/json');
  });

  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim()));
  }

  $('#import-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    let added = 0;
    try {
      if (file.name.toLowerCase().endsWith('.json') || text.trim().startsWith('{')) {
        const data = JSON.parse(text);
        for (const s of STORES) for (const item of data[s] || []) {
          if (item && item.id) { await put(s, item); added++; }
        }
      } else {
        const [head, ...body] = parseCsv(text);
        const col = (name) => head.findIndex((h) => h.trim().toLowerCase() === name);
        const iDt = col('datetime'), iD = col('date'), iT = col('time'), iS = col('systolic'), iDi = col('diastolic'), iP = col('pulse'), iN = col('note');
        if (iS < 0 || iDi < 0) throw new Error('CSV needs systolic and diastolic columns');
        const seen = new Set(readings.map((r) => `${r.ts}|${r.sys}|${r.dia}`));
        for (const r of body) {
          const ts = new Date(iDt >= 0 ? r[iDt] : `${r[iD]}T${r[iT] || '00:00'}`).getTime();
          const sys = +r[iS], dia = +r[iDi];
          if (!ts || !sys || !dia || seen.has(`${ts}|${sys}|${dia}`)) continue;
          await put('readings', { id: uid(), ts, sys, dia, pulse: iP >= 0 && r[iP] ? +r[iP] : null, note: iN >= 0 ? r[iN] : '', source: 'import' });
          seen.add(`${ts}|${sys}|${dia}`); added++;
        }
      }
      toast(`Imported ${added} item${added === 1 ? '' : 's'}`);
      load();
    } catch (err) {
      toast('Import failed: ' + err.message);
    }
  });

  async function renderStorage() {
    const info = $('#storage-info');
    let txt = `${readings.length} readings, ${meds.length} medications, ${doses.length} logged doses.`;
    if (navigator.storage && navigator.storage.persisted) {
      const persisted = await navigator.storage.persisted();
      txt += persisted ? ' Storage is persistent (the browser will not clear it automatically).' : ' Storage is not marked persistent yet — install the app to the home screen to protect it.';
    }
    info.textContent = txt;
  }

  // ---------- offline ----------
  function updateOnline() { $('#offline-badge').hidden = navigator.onLine; }
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  load().catch((e) => { console.error(e); toast('Could not open the local database'); });
})();
