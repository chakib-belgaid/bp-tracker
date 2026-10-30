"""Build the Hugging Face dataset folder from the test fixtures and the exported digit crops.

    node export_real.mjs && uv run python make_dataset.py [out_dir]   (default: data/hf)

Two configs, both with the same dev / test split as the README results (by photo):
  readings/<split>/  display photos + metadata.csv (systolic, diastolic, pulse)
  digits/<split>/    24x32 ink-map crops + metadata.csv (label 0-9, row, position)
Files are renamed (reading_001, ...) and re-encoded without metadata: no timestamps are kept.
"""
from __future__ import annotations

import csv
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

from PIL import Image

from common import HERE

ROOT = HERE.parent
FIXTURES = ROOT / "test" / "fixtures"


def split_of(source: str) -> str:
    # identical to common.load_real, so the published split matches the README numbers
    return "dev" if int(hashlib.sha1(source.encode()).hexdigest(), 16) % 2 == 0 else "test"


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "data" / "hf"
    shutil.rmtree(out, ignore_errors=True)

    photos = []
    for f in sorted(FIXTURES.rglob("*.jpg")):
        m = re.match(r"^(\d+)-(\d+)-(\d+|x)-(.+)$", f.stem)
        if not m:
            continue
        ts = int(m.group(4)) if m.group(4).isdigit() else None
        photos.append({"path": f, "source": f.stem, "sys": int(m.group(1)), "dia": int(m.group(2)),
                       "pulse": None if m.group(3) == "x" else int(m.group(3)), "ts": ts})
    # order: app scans by time, then the full-size photos; ids reveal nothing else
    photos.sort(key=lambda p: (p["ts"] is None, p["ts"] or 0, p["source"]))
    ids = {}
    rows = {"dev": [], "test": []}
    for i, p in enumerate(photos, 1):
        rid = f"reading_{i:03d}"
        ids[p["source"]] = rid
        split = split_of(p["source"])
        img = Image.open(p["path"]).convert("RGB")
        dst = out / "readings" / split / f"{rid}.jpg"
        dst.parent.mkdir(parents=True, exist_ok=True)
        img.save(dst, quality=95)  # re-encoded: no EXIF / metadata
        rows[split].append({"file_name": dst.name, "reading_id": rid, "systolic": p["sys"], "diastolic": p["dia"],
                            "pulse": p["pulse"] if p["pulse"] is not None else "",
                            "image_kind": "full photo" if p["ts"] is None else "app scan (display crop, 160 px)",
                            "width": img.width, "height": img.height})
    for split, rs in rows.items():
        with open(out / "readings" / split / "metadata.csv", "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rs[0].keys()))
            w.writeheader()
            w.writerows(rs)

    idx = json.loads((HERE / "data" / "real" / "index.json").read_text())
    drows = {"dev": [], "test": []}
    for k, e in enumerate(idx, 1):
        split = split_of(e["source"])
        name = f"digit_{k:04d}.png"
        dst = out / "digits" / split / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        Image.open(HERE / "data" / "real" / e["file"]).save(dst)
        drows[split].append({"file_name": name, "label": e["label"], "reading_id": ids[e["source"]],
                             "row": {"sys": "systolic", "dia": "diastolic", "pulse": "pulse"}[e["row"]], "position": e["pos"]})
    for split, rs in drows.items():
        with open(out / "digits" / split / "metadata.csv", "w", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=list(rs[0].keys()))
            w.writeheader()
            w.writerows(rs)

    shutil.copy(HERE / "DATASET_CARD.md", out / "README.md")
    n_r = {s: len(v) for s, v in rows.items()}
    n_d = {s: len(v) for s, v in drows.items()}
    print(f"readings {n_r}  digits {n_d}  -> {out}")


if __name__ == "__main__":
    main()
