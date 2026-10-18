# BP Log

Offline blood-pressure and medication tracker. You take a photo of your monitor, the phone reads
SYS / DIA / pulse from the display, and the reading is saved locally. No server, no account,
no network needed after the first load.

## What it does

- **Scan**: take a photo of the monitor (or pick one from the gallery). `ocr.js` finds the backlit
  display, straightens tilted photos, and decodes the seven-segment digits. Plain JavaScript, no
  libraries or model files. You always get to check and correct the values before saving.
- **Average several measurements**: in the reading dialog, use *Photo*, *Gallery* or *Type* under
  "Add a measurement to average" to take 2–3 readings in a row. One reading is saved with their
  average, and the individual values are kept (shown in the editor and in the CSV `measurements` column).
- **Track**: latest reading with its AHA category, 7-day averages, and a history chart and list
  (7 / 30 / 90 days / all). Tap a reading to edit or delete it.
- **Medication**: add meds with their times (e.g. `08:00, 20:00`) and tick them off on the Today
  tab. Every tick is saved in the dose log.
- **Data**: export readings and the dose log as CSV, or everything as a JSON backup. You can import
  both formats again.

Data is stored in the browser's IndexedDB on the phone. Export a backup now and then.

## Run it

It's a static site, so any web server works:

```bash
python3 -m http.server 8766 --directory .
```

Then open http://localhost:8766.

### On Android

The camera works through a normal file picker. Installing to the home screen and offline mode
need **HTTPS**. The easiest way is GitHub Pages:

1. Push this folder to a GitHub repo.
2. Go to Settings → Pages and deploy from the branch root.
3. Open the `https://<you>.github.io/<repo>/` URL in Chrome on Android, then choose ⋮ → **Add to Home screen** (or **Install app**).

Netlify, Cloudflare Pages and similar hosts work too. Only the code is hosted. Your readings never
leave the phone.

## OCR test bench

Open `test/index.html` (served over http). It runs the parser on the photos in `test/fixtures/` and
shows the black-and-white image the OCR actually reads. Name a fixture `SYS-DIA-PULSE-whatever.jpg`
and it gets checked automatically. You can also use the file picker on that page to try new photos.

Photo tips: fill most of the frame with the monitor and avoid strong glare on the display.
Some tilt is fine (about ±10° was tested).

## Files

| File | Purpose |
|---|---|
| `index.html`, `style.css`, `app.js` | the app (tabs, editor, chart, export/import) |
| `ocr.js` | seven-segment display reader (browser + Node) |
| `sw.js`, `manifest.webmanifest`, `icon*` | offline caching and installability |
| `test/` | OCR test bench + sample photos |
