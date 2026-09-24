#!/usr/bin/env python3
"""Build the full 2025 Black Marble Bortle grid from all 540 VJ146A4 tiles.

Pipeline (calibrated on 2015 tiles vs Falchi grid):
  1. Accumulate per-tile AllAngle_Composite_Snow_Free radiance into 0.25-deg
     sum/count grids (checkpointed every 25 tiles; resumable).
  2. mean radiance -> two-term model:
       artificial (mcd/m^2) = k1*raw + k2*gaussian_smooth(raw, sigma=0.5 deg)
     with k1=0.1179, k2=0.0642 (OLS fit vs Falchi grid, R^2=0.95).
  3. SQM = 22-2.5*log10(1+art/0.174), clip [16,22], quantize 0.05-mag bytes.
  4. Validate at 62 anchors; emit .npy + .js (NOT into src/data/).

Outputs go to this directory (blackmarble-2025/).
"""
import glob
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bm_grid import (COLS, ROWS, accumulate_tile, artificial_to_sqm,
                     quantize, mean_radiance, smooth_normalized,
                     sqm_to_bortle, validate_anchors)

TILE_DIR = "/home/hatch/workspace/data/blackmarble/tiles_2025"
OUT = os.path.dirname(os.path.abspath(__file__))
CKPT_EVERY = 25

# calibrated two-term model (2015 BM vs Falchi grid)
# sigma=0.5 beats sigma=1.0 on 2025 validation (55/62 vs 54/62) and avoids
# long-range glow overprediction at dark sites near metros.
K1, K2, SIGMA = 0.1179, 0.0642, 0.5


def ckpt_paths():
    return (os.path.join(OUT, "full2025_sum.npy"),
            os.path.join(OUT, "full2025_cnt.npy"),
            os.path.join(OUT, "full2025_done.json"))


def main():
    t0 = time.time()
    files = sorted(glob.glob(os.path.join(TILE_DIR, "*.h5")))
    assert len(files) == 540, f"expected 540 tiles, found {len(files)}"
    sum_p, cnt_p, done_p = ckpt_paths()
    if os.path.exists(sum_p) and os.path.exists(done_p):
        sum_grid = np.load(sum_p)
        cnt_grid = np.load(cnt_p)
        done = set(json.load(open(done_p)))
        print(f"resumed: {len(done)}/540 tiles already done")
    else:
        sum_grid = np.zeros((ROWS, COLS), np.float64)
        cnt_grid = np.zeros((ROWS, COLS), np.float64)
        done = set()

    todo = [p for p in files if os.path.basename(p) not in done]
    print(f"{len(todo)} tiles to process")
    for i, p in enumerate(todo):
        base = os.path.basename(p)
        try:
            n = accumulate_tile(p, sum_grid, cnt_grid)
        except Exception as e:  # noqa: BLE001 - checkpoint and re-raise
            np.save(sum_p, sum_grid); np.save(cnt_p, cnt_grid)
            json.dump(sorted(done), open(done_p, "w"))
            raise RuntimeError(f"failed on {base}: {e}") from e
        done.add(base)
        if (i + 1) % CKPT_EVERY == 0 or (i + 1) == len(todo):
            np.save(sum_p, sum_grid); np.save(cnt_p, cnt_grid)
            json.dump(sorted(done), open(done_p, "w"))
            el = time.time() - t0
            print(f"  [{len(done)}/540] checkpointed ({el/60:.1f} min elapsed)",
                  flush=True)

    mean = mean_radiance(sum_grid, cnt_grid)
    np.save(os.path.join(OUT, "full2025_mean_rad.npy"), mean)
    cov = np.count_nonzero(np.isfinite(mean))
    print(f"coverage: {cov:,}/{ROWS*COLS:,} cells ({cov/(ROWS*COLS)*100:.1f}%)")

    print("smoothing...")
    sm = smooth_normalized(mean, SIGMA)
    s = np.nan_to_num(sm, nan=0.0)
    art = np.full(mean.shape, np.nan)
    fin = np.isfinite(mean)
    art[fin] = K1 * mean[fin] + K2 * s[fin]
    art = np.maximum(art, 0.0)
    np.save(os.path.join(OUT, "full2025_artificial_mcd.npy"), art)

    q = quantize(artificial_to_sqm(art))
    np.save(os.path.join(OUT, "full2025_q.npy"), q)
    known = np.count_nonzero(q != 255)
    print(f"quantized: {known:,} known cells")

    hits, total, rows = validate_anchors(q)
    print(f"\n2025 grid validation: {hits}/{total} anchors within +/-1 class")
    rep = [f"{hits}/{total} within +/-1 (baseline 54/62)", ""]
    rep.append(f"{'anchor':28s} {'known':>5s} {'pred':>5s} {'sqm':>6s}")
    for aid, known_b, pred, okc, sqm_v in rows:
        flag = "" if (okc or okc is None) else "  <-- MISS"
        ks = str(known_b) if known_b is not None else "-"
        ps = str(pred) if pred is not None else "-"
        ss = f"{sqm_v:.2f}" if sqm_v is not None else "-"
        rep.append(f"{aid:28s} {ks:>5s} {ps:>5s} {ss:>6s}{flag}")
    open(os.path.join(OUT, "full2025_validation.txt"), "w").write("\n".join(rep) + "\n")
    print("\n".join(rep))
    print(f"\ndone in {(time.time()-t0)/60:.1f} min")


if __name__ == "__main__":
    main()
