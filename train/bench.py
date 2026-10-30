"""Training / inference speed, CPU vs MPS, and PyTorch predictions for the JS parity check.

    uv run python bench.py              # prints a markdown table, writes data/py_preds.json
"""
from __future__ import annotations

import json
import time

import numpy as np
import torch
from torch import nn

from common import HERE, DigitNet, load_real, to_tensor
from train import synth
import weights_io


def train_epoch_time(device: str, X, Y, batch=256, epochs=3):
    torch.manual_seed(0)
    model = DigitNet().to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3)
    loss_fn = nn.CrossEntropyLoss()
    times = []
    for _ in range(epochs):
        t = time.perf_counter()
        perm = torch.randperm(len(X))
        for i in range(0, len(X), batch):
            idx = perm[i:i + batch]
            loss = loss_fn(model(X[idx].to(device)), Y[idx].to(device))
            opt.zero_grad()
            loss.backward()
            opt.step()
        if device == "mps":
            torch.mps.synchronize()
        times.append(time.perf_counter() - t)
    return times  # first epoch includes warm-up


@torch.no_grad()
def infer_time(device: str, model: DigitNet, x: torch.Tensor, batch: int, reps=50):
    model = model.to(device)
    xb = x[:batch].to(device)
    for _ in range(5):
        model(xb)
    if device == "mps":
        torch.mps.synchronize()
    t = time.perf_counter()
    for _ in range(reps):
        model(xb)
    if device == "mps":
        torch.mps.synchronize()
    return (time.perf_counter() - t) / reps / batch * 1e3  # ms per digit


def main():
    xs, ys = synth(150_000, 0)
    X, Y = to_tensor(xs), torch.from_numpy(ys)
    rows = []
    for dev in ["cpu", "mps"]:
        t = train_epoch_time(dev, X, Y)
        rows.append((dev, t[0], float(np.mean(t[1:]))))
    print("| device | first epoch (warm-up) | later epochs |\n|---|---|---|")
    for dev, first, rest in rows:
        print(f"| {dev} | {first:.1f} s | {rest:.1f} s |")

    model = weights_io.load_model()
    rx, ry, meta = load_real()
    x = to_tensor(rx)
    print("\n| device | batch 1 (ms/digit) | batch 388 (ms/digit) |\n|---|---|---|")
    for dev in ["cpu", "mps"]:
        print(f"| {dev} | {infer_time(dev, model, x, 1):.3f} | {infer_time(dev, model, x, len(x)):.4f} |")

    model = model.cpu()
    with torch.no_grad():
        p = torch.softmax(model(x), 1).numpy()
    out = [{"file": m["file"], "label": int(y), "split": m["split"], "pred": int(pp.argmax()), "prob": [float(v) for v in pp]}
           for m, y, pp in zip(meta, ry, p)]
    (HERE / "data" / "py_preds.json").write_text(json.dumps(out))
    acc = {s: np.mean([o["pred"] == o["label"] for o in out if o["split"] == s]) for s in ["dev", "test"]}
    print(f"\nPyTorch accuracy: dev {acc['dev']:.4f}  test {acc['test']:.4f}  -> data/py_preds.json")


if __name__ == "__main__":
    main()
