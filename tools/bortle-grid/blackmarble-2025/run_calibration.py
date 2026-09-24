#!/usr/bin/env python3
"""Calibrate Black Marble -> SQM conversion on 9 representative VNP46A4 2015 tiles.

1. Accumulate 9 tiles (bright urban -> dark rural/desert) into a 0.25-deg
   mean-radiance grid (partial globe).
2. For each smoothing sigma, fit the radiance->artificial-brightness scale
   factor k against the shipped Falchi-2016 grid (dequantized) on all
   overlapping well-lit cells: k = median(art_mcd / rad_smooth).
3. Validate each (k, sigma) at the 62 anchors (only anchors with coverage).
"""
import glob
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bm_grid import (COLS, ROWS, accumulate_tile, artificial_to_sqm,
                     grid_to_quantized_sqm, load_falchi_grid, mean_radiance,
                     smooth_normalized, sqm_to_bortle, sample_grid,
                     validate_anchors)

TILE_DIR = "/home/hatch/workspace/data/blackmarble/tiles_2015_cal"
OUT = os.path.dirname(os.path.abspath(__file__))
SIGMAS = [0.0, 0.5, 1.0]

def main():
    t0 = time.time()
    files = sorted(glob.glob(os.path.join(TILE_DIR, "*.h5")))
    print(f"{len(files)} calibration tiles")
    sum_grid = np.zeros((ROWS, COLS), np.float64)
    cnt_grid = np.zeros((ROWS, COLS), np.float64)
    for i, p in enumerate(files):
        n = accumulate_tile(p, sum_grid, cnt_grid)
        print(f"  [{i+1}/{len(files)}] {os.path.basename(p)}: {n:,} valid px",
              flush=True)
    mean = mean_radiance(sum_grid, cnt_grid)
    cov = np.count_nonzero(np.isfinite(mean))
    print(f"partial grid: {cov:,} / {ROWS*COLS:,} cells have data "
          f"({time.time()-t0:.0f}s)")

    falchi_sqm, falchi_art = load_falchi_grid()
    print("Falchi grid loaded")

    # direct-coverage anchor set: anchors whose cell has unsmoothed data
    q0, _ = grid_to_quantized_sqm(mean, 1.0, 0.0)
    anchors = json.load(open("/home/hatch/workspace/stargazer/tools/bortle-grid/anchors.json"))
    direct_ids = set()
    for a in anchors:
        if a.get("known_bortle") is not None and sample_grid(q0, a["lon"], a["lat"]) is not None:
            direct_ids.add(a["id"])
    print(f"anchors with DIRECT (unsmoothed) coverage: {len(direct_ids)}")

    summary = {}
    for sigma in SIGMAS:
        sm = smooth_normalized(mean, sigma) if sigma > 0 else mean
        ok = (np.isfinite(sm) & np.isfinite(falchi_art)
              & (falchi_art > 0.05) & (sm > 0.05))
        ratios = falchi_art[ok] / sm[ok]
        k = float(np.median(ratios))
        q1, q3 = float(np.percentile(ratios, 25)), float(np.percentile(ratios, 75))
        print(f"\nsigma={sigma} deg: n={ok.sum():,} cells  "
              f"k=median(art/rad)={k:.4f}  IQR=[{q1:.4f},{q3:.4f}]")

        q, _ = grid_to_quantized_sqm(mean, k, sigma)
        hits, total, rows = validate_anchors(q)
        # fair comparison: only direct-coverage anchors
        dhits = dtotal = 0
        misses = []
        for aid, known, pred, okc, s in rows:
            if aid not in direct_ids:
                continue
            dtotal += 1
            if abs(pred - known) <= 1:
                dhits += 1
            else:
                misses.append((aid, known, pred, s))
        print(f"  all anchors w/ any coverage: {hits}/{total}; "
              f"direct-coverage only: {dhits}/{dtotal}")
        for aid, known, pred, s in misses:
            print(f"    MISS {aid:28s} known={known} pred={pred} sqm={s}")
        summary[sigma] = (k, dhits, dtotal)

        np.save(os.path.join(OUT, f"cal2015_q_sigma{sigma}_k{k:.4f}.npy"), q)

    print("\n=== SUMMARY (direct-coverage anchors) ===")
    for sigma in SIGMAS:
        k, dh, dt = summary[sigma]
        print(f"  sigma={sigma}: k={k:.4f}  {dh}/{dt} = {dh/dt*100:.0f}%")

    # also dump the raw (unsmoothed) mean radiance for inspection
    np.save(os.path.join(OUT, "cal2015_mean_rad_raw.npy"), mean)
    print(f"\ndone in {time.time()-t0:.0f}s")

if __name__ == "__main__":
    main()
