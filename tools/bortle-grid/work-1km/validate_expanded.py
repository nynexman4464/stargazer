#!/usr/bin/env python3
"""Validate 1km local-filter variants AND the shipped 4km model against the
EXPANDED anchor set (63 original + 35 new = 98).

Models (all use the SHIPPED Walker normalization: d in 20km cell units,
d^-3, 0.5 < d <= 5, sqrt, K1=0.11, K2=0.05):
  - 4km_shipped : bilinear center-sample of native VIIRS + Walker (replicates
                  make_merc_fine.py local sampling at the anchor)
  - 1km_2x2mean: uniform_filter 2x2 mean of native VIIRS + Walker (as validated
                  before, 48/62 on original set)
  - 1km_med3/5/7/9: median of native VIIRS in n x n window + Walker

Bortle via shipped breaks: [21.90,1],[21.70,2],[21.40,3],[20.90,4],
[19.45,5],[18.70,6],[18.20,7],[17.70,8].
"""
import glob
import json
import math
import os
import sys
import time

import h5py
import numpy as np
from scipy.ndimage import convolve, map_coordinates, uniform_filter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'mercator-2025'))
from merc_grid import (
    XMIN, YMAX, COLS, ROWS, COARSE_M, R_MERC,
    K1, K2, WALKER_P, WALKER_RMAX_CELLS, WALKER_SQRT,
    artificial_to_sqm,
)

BORTLE_BREAKS = [(21.90, 1), (21.70, 2), (21.40, 3), (20.90, 4),
                 (19.45, 5), (18.70, 6), (18.20, 7), (17.70, 8)]

def sqm_to_bortle(sqm):
    for edge, cls in BORTLE_BREAKS:
        if sqm >= edge:
            return cls
    return 9

TILE_DIR = "/home/hatch/workspace/data/blackmarble/tiles_2025"
LAYER = "AllAngle_Composite_Snow_Free"
FILL = -999.9

VARIANTS = ['4km_shipped', '1km_2x2mean', '1km_med3', '1km_med5',
            '1km_med7', '1km_med9']

def lat_to_y(lat):
    s = np.clip(np.sin(np.radians(lat)), -0.999999, 0.999999)
    return R_MERC * np.log((1 + s) / (1 - s)) / 2

def build_walker(coarse_mean):
    r = int(math.ceil(WALKER_RMAX_CELLS))
    yy, xx = np.mgrid[-r:r+1, -r:r+1]
    d = np.sqrt(xx**2 + yy**2)
    kernel = np.zeros((2*r+1, 2*r+1))
    m = (d > 0.5) & (d <= WALKER_RMAX_CELLS)
    kernel[m] = d[m] ** (-WALKER_P)
    w = convolve(np.nan_to_num(coarse_mean, nan=0.0), kernel,
                 mode='constant', cval=0.0)
    return np.sqrt(np.maximum(w, 0.0)) if WALKER_SQRT else w

def walker_at(walker_grid, lon, lat):
    x = math.radians(lon) * R_MERC
    y = lat_to_y(lat)
    cc = (x - XMIN) / COARSE_M - 0.5
    cr = (YMAX - y) / COARSE_M - 0.5
    c0, r0 = math.floor(cc), math.floor(cr)
    if not (0 <= c0 < COLS - 1 and 0 <= r0 < ROWS - 1):
        return np.nan
    dx, dy = cc - c0, cr - r0
    b = walker_grid[r0:r0+2, c0:c0+2]
    if not np.all(np.isfinite(b)):
        return np.nan
    return (b[0,0]*(1-dx)*(1-dy) + b[0,1]*dx*(1-dy) +
            b[1,0]*(1-dx)*dy + b[1,1]*dx*dy)

def load_tile(h, v):
    matches = glob.glob(os.path.join(
        TILE_DIR, f"VJ146A4.A2025001.h{h:02d}v{v:02d}.002.*.h5"))
    if not matches:
        return None
    with h5py.File(matches[0], 'r') as f:
        df = f["HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data Fields"]
        rad = df[LAYER][:].astype(np.float32)
    rad[rad == FILL] = np.nan
    valid = np.isfinite(rad).astype(np.float32)
    radf = np.nan_to_num(rad, nan=0.0).astype(np.float64)
    # 2x2 mean (replicates previous validation exactly)
    rf = uniform_filter(radf, size=2, mode='constant', cval=0.0)
    vf = uniform_filter(valid.astype(np.float64), size=2,
                        mode='constant', cval=0.0)
    with np.errstate(invalid='ignore', divide='ignore'):
        mean2x2 = np.where(vf > 0.5, rf / np.maximum(vf, 1e-9), np.nan)
    return rad.astype(np.float64), mean2x2

def window_median(rad, px, py, k):
    n = 2 * k + 1
    xi, yi = int(round(px)), int(round(py))
    x0, x1 = max(0, xi-k), min(rad.shape[1], xi+k+1)
    y0, y1 = max(0, yi-k), min(rad.shape[0], yi+k+1)
    w = rad[y0:y1, x0:x1]
    v = w[np.isfinite(w)]
    if v.size < n * n / 2:
        return np.nan
    return float(np.median(v))

def main():
    t0 = time.time()
    print("Loading anchors...", flush=True)
    a1 = json.load(open(os.path.join(HERE, '..', 'anchors.json')))
    a2 = json.load(open(os.path.join(HERE, '..', 'anchors_expanded.json')))
    anchors = [a for a in a1 + a2 if a.get('known_bortle') is not None]
    print(f"{len(anchors)} anchors (63 orig + 35 new, "
          f"{len(a1)-len([a for a in a1 if a.get('known_bortle') is not None])} skipped)",
          flush=True)

    print("Loading coarse mean + building Walker...", flush=True)
    coarse_mean = np.load(os.path.join(HERE, 'coarse_mean_20km.npy'))
    walker = build_walker(coarse_mean)
    print(f"Walker done ({time.time()-t0:.0f}s).", flush=True)

    # Group anchors by tile
    from collections import defaultdict
    by_tile = defaultdict(list)
    for a in anchors:
        h = int(math.floor((a['lon'] + 180) / 10))
        v = int(math.floor((90 - a['lat']) / 10))
        lon_min, lat_max = h*10 - 180, 90 - v*10
        px = (a['lon'] - lon_min) / 10 * 2400
        py = (lat_max - a['lat']) / 10 * 2400
        by_tile[(h, v)].append((a, px, py))

    results = []
    for ti, ((h, v), items) in enumerate(sorted(by_tile.items())):
        t = load_tile(h, v)
        if t is None:
            for a, px, py in items:
                results.append({'id': a['id'], 'known': a['known_bortle'],
                                'set': 'orig' if a in a1 else 'new',
                                'pred': {v_: None for v_ in VARIANTS},
                                'sqm': {v_: None for v_ in VARIANTS}})
            continue
        rad, mean2x2 = t
        for a, px, py in items:
            reg = walker_at(walker, a['lon'], a['lat'])
            loc = {}
            # 4km shipped: bilinear center-sample of native VIIRS
            c = map_coordinates(np.nan_to_num(rad, nan=0.0), [[py], [px]],
                                order=1, mode='constant', cval=np.nan)[0]
            vc = map_coordinates(np.isfinite(rad).astype(float), [[py], [px]],
                                 order=1, mode='constant', cval=0.0)[0]
            loc['4km_shipped'] = c if vc > 0.5 else np.nan
            loc['1km_2x2mean'] = map_coordinates(
                mean2x2, [[py], [px]], order=1,
                mode='constant', cval=np.nan)[0]
            for name, k in [('1km_med3', 1), ('1km_med5', 2),
                            ('1km_med7', 3), ('1km_med9', 4)]:
                loc[name] = window_median(rad, px, py, k)
            pred, sqm = {}, {}
            for v_ in VARIANTS:
                l = loc[v_]
                if np.isfinite(l) and np.isfinite(reg):
                    art = K1 * max(l, 0.0) + K2 * max(reg, 0.0)
                    s = float(artificial_to_sqm(np.array([art]))[0])
                    sqm[v_] = round(s, 2)
                    pred[v_] = sqm_to_bortle(s)
                else:
                    sqm[v_] = None
                    pred[v_] = None
            results.append({'id': a['id'], 'known': a['known_bortle'],
                            'set': 'orig' if a in a1 else 'new',
                            'sqm_meas': a.get('sqm'),
                            'pred': pred, 'sqm': sqm})
        del rad, mean2x2
        if (ti + 1) % 10 == 0:
            print(f"  {ti+1}/{len(by_tile)} tiles ({time.time()-t0:.0f}s)",
                  flush=True)

    json.dump(results, open(os.path.join(HERE, 'anchor_validation_expanded.json'),
                            'w'), indent=1)

    # ---- Scoring ----
    boston_ids = {'boston-common', 'cambridge-common', 'danehy-park',
                  'arlington-ma', 'lincoln-ma'}

    def score(rows, variant, exclude=()):
        hits = tot = 0
        for r in rows:
            if r['id'] in exclude or r['pred'][variant] is None:
                continue
            tot += 1
            if abs(r['pred'][variant] - r['known']) <= 1:
                hits += 1
        return hits, tot

    print("\n=== Overall scores (98 anchors) ===")
    for v_ in VARIANTS:
        h, t = score(results, v_)
        print(f"  {v_:14s} {h}/{t} = {h/t*100:.1f}%")

    print("\n=== Excluding 5 Boston snow-cover anchors ===")
    for v_ in VARIANTS:
        h, t = score(results, v_, exclude=boston_ids)
        print(f"  {v_:14s} {h}/{t} = {h/t*100:.1f}%")

    print("\n=== By set: original 63 vs new 35 ===")
    for label, sel in [('orig', lambda r: r['set'] == 'orig'),
                       ('new ', lambda r: r['set'] == 'new')]:
        rows = [r for r in results if sel(r)]
        parts = []
        for v_ in VARIANTS:
            h, t = score(rows, v_)
            parts.append(f"{v_.split('_',1)[1] if '_' in v_ else v_}:{h}/{t}")
        print(f"  {label} " + "  ".join(parts))

    print("\n=== Urban (known>=5) vs dark (known<=3) ===")
    for label, sel in [('urban>=5', lambda r: r['known'] >= 5),
                       ('dark <=3', lambda r: r['known'] <= 3)]:
        rows = [r for r in results if sel(r)]
        print(f"  {label} (n={len(rows)})")
        for v_ in VARIANTS:
            h, t = score(rows, v_)
            print(f"    {v_:14s} {h}/{t} = {h/t*100:.1f}%")

    print("\n=== Prior 14 dark misses: 1km_2x2mean vs 4km_shipped ===")
    prev = json.load(open(os.path.join(HERE, 'anchor_validation.json')))
    prev_dark_miss = {r['id'] for r in prev
                      if not r['ok'] and r['known'] <= 3}
    by_id = {r['id']: r for r in results}
    for rid in sorted(prev_dark_miss):
        r = by_id.get(rid)
        if r is None:
            continue
        p1, p4 = r['pred']['1km_2x2mean'], r['pred']['4km_shipped']
        k = r['known']
        print(f"  {rid}: known={k} 1km={p1} 4km={p4} "
              f"({'STILL MISS' if p1 is not None and abs(p1-k) > 1 else 'fixed'}/"
              f"{'4kmmiss' if p4 is not None and abs(p4-k) > 1 else '4kmok'})")

    print("\n=== Potsdam check ===")
    for rid in ('potsdam',):
        r = by_id.get(rid)
        if r:
            print(f"  {rid}: known={r['known']} " +
                  " ".join(f"{v_}={r['pred'][v_]}/{r['sqm'][v_]}"
                            for v_ in VARIANTS))

    print(f"\nDone in {time.time()-t0:.0f}s. Full results: "
          f"anchor_validation_expanded.json", flush=True)

if __name__ == '__main__':
    main()
