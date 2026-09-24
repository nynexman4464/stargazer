#!/usr/bin/env python3
"""Fine (0.05-degree) Bortle patches for every bright area of the 2025 Black Marble grid.

Why: the 0.25-degree global grid smears bright city cores with surrounding dark
land/water, so dense cities read ~2 Bortle classes darker than ground truth
(Boston reads 6, published 8). Instead of hand-picking N metros, every coarse
cell at SQM <= 21.0 (byte <= 100), plus a 1-cell dilation halo, gets a 5x5 patch
of 0.05-degree cells automatically. One pass over the 540 VJ146A4 tiles
accumulates 0.05-degree mean radiance inside the patches.

The same k1/k2/sigma model as the coarse grid converts radiance to SQM bytes,
so fine and coarse values share one calibration.

Output: src/data/bortleFine.js --
  { step: 0.05, per: 5, index: base64(uint32LE coarse keys r*1440+c, sorted),
    data: base64(25 bytes per patch, same order as index) }
255 = no coverage. ~0.7M fine cells total (~0.9 MB base64).
"""
import base64
import glob
import json
import math
import os
import sys
import time

import h5py
import numpy as np
from scipy.ndimage import binary_dilation, map_coordinates

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bm_grid import (COLS, FILL, LAYER, ROWS, artificial_to_sqm, quantize,
                     smooth_normalized, sqm_to_bortle)

TILE_DIR = "/home/hatch/workspace/data/blackmarble/tiles_2025"
HERE = os.path.dirname(os.path.abspath(__file__))
COARSE_Q = os.path.join(HERE, "full2025_q.npy")
COARSE_MEAN = os.path.join(HERE, "full2025_mean_rad.npy")
ANCHORS = "/home/hatch/workspace/stargazer/tools/bortle-grid/anchors.json"
OUT_JS = "/home/hatch/workspace/stargazer/src/data/bortleFine.js"

K1, K2, SIGMA = 0.1179, 0.0642, 0.5
# True coarse build geometry (matches shipped bortleGrid.js metadata).
C_LATMAX = 85.0541668645001
C_LONMIN = -180.00000000000003
C_STEP = 0.25
# Fine geometry: 5x5 fine cells per coarse cell, aligned to the coarse grid.
F_STEP = 0.05
PER = 5
BRIGHT_BYTE = 100  # SQM <= 21.0: cities, suburbs, towns


def find_patches():
    q = np.load(COARSE_Q)
    bright = (q != 255) & (q <= BRIGHT_BYTE)
    dil = binary_dilation(bright, iterations=1)
    rr, cc = np.nonzero(dil)
    keys = sorted(int(r) * COLS + int(c) for r, c in zip(rr, cc))
    print(f"{bright.sum():,} bright coarse cells -> {len(keys):,} patches "
          f"({len(keys) * PER * PER / 1e6:.2f}M fine cells)", flush=True)
    return keys


def accumulate(keys):
    # Fine mask: the 5x5 fine block of each patched coarse cell.
    keyset = set(keys)
    F_ROWS, F_COLS = ROWS * PER, COLS * PER
    mask = np.zeros((F_ROWS, F_COLS), dtype=bool)
    for k in keys:
        r, c = divmod(k, COLS)
        mask[r * PER:(r + 1) * PER, c * PER:(c + 1) * PER] = True
    print(f"mask covers {mask.sum() / 1e6:.2f}M fine cells", flush=True)
    mflat = mask.ravel()
    sum_g = np.zeros((F_ROWS, F_COLS), np.float32)
    cnt_g = np.zeros((F_ROWS, F_COLS), np.float32)
    files = sorted(glob.glob(os.path.join(TILE_DIR, "*.h5")))
    assert len(files) == 540, f"expected 540 tiles, found {len(files)}"
    t0 = time.time()
    for i, p in enumerate(files):
        with h5py.File(p, "r") as f:
            df = f["HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data Fields"]
            rad = df[LAYER][:]
            lat = df["lat"][:]
            lon = df["lon"][:]
        valid = (rad != FILL) & np.isfinite(rad)
        # Bin to fine cells aligned with the coarse grid: coarse cell (r, c)
        # spans lat [C_LATMAX-(r+1)*.25, C_LATMAX-r*.25]; fine row =
        # r*5 + floor((cell_north_edge - lat) / 0.05).
        r1d = np.floor((C_LATMAX - lat) / C_STEP).astype(np.int64)
        c1d = np.floor((lon - C_LONMIN) / C_STEP).astype(np.int64) % COLS
        ok = valid & (r1d[:, None] >= 0) & (r1d[:, None] < ROWS)
        rr, cc = np.nonzero(ok)
        # Fine cell inside coarse cell (r1d[rr], c1d[cc]): offset from the
        # cell's north/west edge, clipped for fp safety at boundaries.
        fr = r1d[rr] * PER + np.clip(
            np.floor((C_LATMAX - r1d[rr] * C_STEP - lat[rr]) / F_STEP).astype(np.int64),
            0, PER - 1)
        fc = c1d[cc] * PER + np.clip(
            np.floor((lon[cc] - (C_LONMIN + c1d[cc] * C_STEP)) / F_STEP).astype(np.int64),
            0, PER - 1)
        idx = fr * F_COLS + fc
        m = mflat[idx]
        if m.any():
            pos = np.nonzero(m)[0]
            vals = rad[ok][pos].astype(np.float64)
            np.add.at(sum_g.ravel(), idx[m], vals)
            np.add.at(cnt_g.ravel(), idx[m], 1)
        if (i + 1) % 60 == 0:
            print(f"  {i + 1}/{len(files)} ({time.time() - t0:.0f}s)", flush=True)
    print(f"accumulated in {time.time() - t0:.0f}s; "
          f"{np.count_nonzero(cnt_g) / 1e6:.2f}M fine cells have data", flush=True)
    return sum_g, cnt_g, mask, keyset


def build_patch_bytes(sum_g, cnt_g, mask, keys):
    F_ROWS, F_COLS = ROWS * PER, COLS * PER
    midx = np.nonzero(mask.ravel())[0]
    cnt = cnt_g.ravel()[midx]
    has = cnt > 0
    local = np.full(midx.shape, np.nan)
    local[has] = sum_g.ravel()[midx][has] / cnt[has]
    # Blurred term: Gaussian-blur the coarse mean, sample at fine centers.
    coarse_mean = np.load(COARSE_MEAN)
    sm = smooth_normalized(coarse_mean, SIGMA)
    num = np.nan_to_num(sm, nan=0.0) * np.isfinite(sm)
    den = np.isfinite(sm).astype(np.float64)
    ys, xs = np.nonzero(mask)
    lat = C_LATMAX - (ys / PER + 0.5 / PER) * C_STEP
    lon = C_LONMIN + (xs / PER + 0.5 / PER) * C_STEP
    cr = (C_LATMAX - lat) / C_STEP - 0.5
    cc = (lon - C_LONMIN) / C_STEP - 0.5
    bnum = map_coordinates(num, [cr, cc], order=1, mode="constant", cval=0.0)
    bden = map_coordinates(den, [cr, cc], order=1, mode="constant", cval=0.0)
    blurred = np.full(ys.shape, np.nan)
    okb = bden > 1e-9
    blurred[okb] = bnum[okb] / bden[okb]
    blurred[~np.isfinite(blurred)] = local[~np.isfinite(blurred)]
    art = K1 * np.maximum(local, 0.0) + K2 * np.maximum(blurred, 0.0)
    qb = quantize(artificial_to_sqm(art))  # 255 where NaN (no coverage)
    fine = np.full((F_ROWS, F_COLS), 255, np.uint8)
    fine.ravel()[midx] = qb
    # Pack patches in key order.
    data = np.empty((len(keys), PER * PER), np.uint8)
    for i, k in enumerate(keys):
        r, c = divmod(k, COLS)
        data[i] = fine[r * PER:(r + 1) * PER, c * PER:(c + 1) * PER].ravel()
    return data


def sample_patch(keys, data, lon, lat):
    c = int(math.floor((lon - C_LONMIN) / C_STEP))
    r = int(math.floor((C_LATMAX - lat) / C_STEP))
    if not (0 <= c < COLS and 0 <= r < ROWS):
        return None
    import bisect
    i = bisect.bisect_left(keys, r * COLS + c)
    if i >= len(keys) or keys[i] != r * COLS + c:
        return None
    lat_n = C_LATMAX - r * C_STEP
    lon_w = C_LONMIN + c * C_STEP
    fr = int(math.floor((lat_n - lat) / F_STEP))
    fc = int(math.floor((lon - lon_w) / F_STEP))
    if not (0 <= fr < PER and 0 <= fc < PER):
        return None
    v = data[i, fr * PER + fc]
    return None if v == 255 else 16.0 + float(v) * 0.05


def validate(keys, data):
    spots = [(42.36, -71.06, "Boston downtown"), (42.4184, -71.1062, "Medford MA"),
             (40.7128, -74.006, "NYC"), (41.8781, -87.6298, "Chicago"),
             (34.0522, -118.2437, "Los Angeles"), (51.5074, -0.1278, "London")]
    print("\nspot checks (fine patches):")
    for la, lo, name in spots:
        s = sample_patch(keys, data, lo, la)
        print(f"  {name:16s} SQM {s if s is None else round(s, 2)} -> "
              f"Bortle {s and sqm_to_bortle(s)}")
    print("\nanchor validation (known Bortle vs fine prediction):")
    anchors = json.load(open(ANCHORS))
    hits = total = 0
    for a in anchors:
        known = a.get("known_bortle")
        if known is None:
            continue
        s = sample_patch(keys, data, a["lon"], a["lat"])
        if s is None:
            continue
        pred = sqm_to_bortle(s)
        total += 1
        if abs(pred - known) <= 1:
            hits += 1
        else:
            print(f"  MISS {a['id']:28s} known={known} pred={pred} sqm={s:.2f}")
    print(f"  {hits}/{total} within +/-1 class")


def emit_js(keys, data):
    index = np.array(keys, dtype="<u4")
    idx_b64 = base64.b64encode(index.tobytes()).decode("ascii")
    dat_b64 = base64.b64encode(np.ascontiguousarray(data).tobytes()).decode("ascii")
    js = ("// Generated by tools/bortle-grid/blackmarble-2025/make_fine.py -- do not edit.\n"
          "// Fine (0.05-degree) Bortle patches: 5x5 fine cells for every coarse cell\n"
          "// at SQM <= 21.0 (+1-cell halo). index: uint32LE coarse keys (r*1440+c),\n"
          "// sorted; data: 25 SQM bytes per patch in index order, 255 = no coverage.\n"
          "export const BORTLE_FINE = {\n"
          f"  step: {F_STEP},\n"
          f"  per: {PER},\n"
          f"  count: {len(keys)},\n"
          f"  index: '{idx_b64}',\n"
          f"  data: '{dat_b64}',\n"
          "};\n")
    open(OUT_JS, "w").write(js)
    print(f"wrote {OUT_JS} ({os.path.getsize(OUT_JS) / 1e6:.2f} MB)")


def main():
    t0 = time.time()
    keys = find_patches()
    sum_g, cnt_g, mask, _ = accumulate(keys)
    data = build_patch_bytes(sum_g, cnt_g, mask, keys)
    validate(keys, data)
    emit_js(keys, data)
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
