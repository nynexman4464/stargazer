#!/usr/bin/env python3
"""Simulate a REAL 1km build: sample the local filter at 1km Mercator cell
centers (not at the anchor point), then score the containing cell's value.
This replicates what built 1km data would return via sampleRegionByte.

Compares: shipped (actual data), 1km_2x2mean cell-sampled, 1km_med7 cell-sampled.
"""
import glob
import json
import math
import os
import sys

import h5py
import numpy as np
from scipy.ndimage import map_coordinates, uniform_filter

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'tools', 'bortle-grid', 'mercator-2025'))
from merc_grid import (
    XMIN, YMAX, COLS, ROWS, COARSE_M, R_MERC,
    K1, K2, WALKER_P, WALKER_RMAX_CELLS, WALKER_SQRT,
    artificial_to_sqm,
)
from scipy.ndimage import convolve

BORTLE_BREAKS = [(21.90, 1), (21.70, 2), (21.40, 3), (20.90, 4),
                 (19.45, 5), (18.70, 6), (18.20, 7), (17.70, 8)]

def sqm_to_bortle(sqm):
    for edge, cls in BORTLE_BREAKS:
        if sqm >= edge:
            return cls
    return 9

TILE_DIR = "/home/hatch/workspace/data/blackmarble/tiles_2025"
LAYER = "AllAngle_Composite_Snow_Free"
FINE1K_M = 1000.0

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

def y_to_lat(y):
    return math.degrees(2 * math.atan(math.exp(y / R_MERC)) - math.pi / 2)

def load_tile(h, v):
    matches = glob.glob(os.path.join(
        TILE_DIR, f"VJ146A4.A2025001.h{h:02d}v{v:02d}.002.*.h5"))
    if not matches:
        return None
    with h5py.File(matches[0], 'r') as f:
        df = f["HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data Fields"]
        rad = df[LAYER][:].astype(np.float64)
    rad[rad == -999.9] = np.nan
    valid = np.isfinite(rad).astype(np.float64)
    radf = np.nan_to_num(rad, nan=0.0)
    rf = uniform_filter(radf, size=2, mode='constant', cval=0.0)
    vf = uniform_filter(valid, size=2, mode='constant', cval=0.0)
    with np.errstate(invalid='ignore', divide='ignore'):
        mean2x2 = np.where(vf > 0.5, rf / np.maximum(vf, 1e-9), np.nan)
    return rad, mean2x2

def sample_at(rad, mean2x2, lon, lat, variant):
    """Sample local filter at lon/lat (used for 1km CELL CENTERS)."""
    # find tile for this lon/lat
    h = int(math.floor((lon + 180) / 10))
    v = int(math.floor((90 - lat) / 10))
    return h, v, lon, lat  # caller handles tile loading

def main():
    a1 = json.load(open(os.path.join(REPO, 'tools', 'bortle-grid', 'anchors.json')))
    a2 = json.load(open(os.path.join(REPO, 'tools', 'bortle-grid', 'anchors_expanded.json')))
    anchors = [a for a in a1 + a2 if a.get('known_bortle') is not None]
    sh = {r['id']: r for r in json.load(
        open(os.path.join(HERE, 'shipped_validation_expanded.json')))}

    print("Building Walker...", flush=True)
    coarse_mean = np.load(os.path.join(HERE, 'coarse_mean_20km.npy'))
    walker = build_walker(coarse_mean)

    # For each anchor: 1km cell center in Mercator meters
    jobs = []
    for a in anchors:
        x = math.radians(a['lon']) * R_MERC
        y = lat_to_y(a['lat'])
        fc = math.floor((x - XMIN) / FINE1K_M)
        # row from north: use YMAX
        fr = math.floor((YMAX - y) / FINE1K_M)
        xc = XMIN + (fc + 0.5) * FINE1K_M
        yc = YMAX - (fr + 0.5) * FINE1K_M
        lon_c = math.degrees(xc / R_MERC)
        lat_c = y_to_lat(yc)
        jobs.append((a, lon_c, lat_c))

    from collections import defaultdict
    by_tile = defaultdict(list)
    for a, lon_c, lat_c in jobs:
        h = int(math.floor((lon_c + 180) / 10))
        v = int(math.floor((90 - lat_c) / 10))
        lon_min, lat_max = h*10 - 180, 90 - v*10
        px = (lon_c - lon_min) / 10 * 2400
        py = (lat_max - lat_c) / 10 * 2400
        by_tile[(h, v)].append((a, px, py, lon_c, lat_c))

    results = []
    for (h, v), items in sorted(by_tile.items()):
        t = load_tile(h, v)
        if t is None:
            for a, px, py, loc_, lac_ in items:
                results.append((a, None, None))
            continue
        rad, mean2x2 = t
        for a, px, py, lon_c, lat_c in items:
            reg = walker_at(walker, a['lon'], a['lat'])
            vals = {}
            # 2x2 mean at cell center
            m2 = map_coordinates(mean2x2, [[py], [px]], order=1,
                                 mode='constant', cval=np.nan)[0]
            # 7x7 median at cell center
            xi, yi = int(round(px)), int(round(py))
            w = rad[max(0, yi-3):yi+4, max(0, xi-3):xi+4]
            vv = w[np.isfinite(w)]
            med7 = float(np.median(vv)) if vv.size >= 25 else np.nan
            for name, l in [('cell_2x2', m2), ('cell_med7', med7)]:
                if np.isfinite(l) and np.isfinite(reg):
                    art = K1 * max(l, 0.0) + K2 * max(reg, 0.0)
                    s = float(artificial_to_sqm(np.array([art]))[0])
                    vals[name] = (round(s, 2), sqm_to_bortle(s))
                else:
                    vals[name] = (None, None)
            results.append((a, vals, reg))
        del rad, mean2x2

    print("\n=== 1km cell-center simulation vs shipped (98 anchors) ===",
          flush=True)
    for name in ['cell_2x2', 'cell_med7']:
        h = t = 0
        for a, vals, reg in results:
            if vals is None or vals[name][1] is None:
                continue
            t += 1
            h += abs(vals[name][1] - a['known_bortle']) <= 1
        print(f"  1km_{name}: {h}/{t} = {h/t*100:.1f}%", flush=True)
    hs = sum(1 for r in sh.values() if r['ok'])
    ts = sum(1 for r in sh.values() if r['pred'] is not None)
    print(f"  shipped   : {hs}/{ts} = {hs/ts*100:.1f}%", flush=True)

    print("\n=== Urban / dark breakdown ===", flush=True)
    for label, sel in [('urban>=5', lambda a: a['known_bortle'] >= 5),
                       ('dark <=3', lambda a: a['known_bortle'] <= 3)]:
        print(f"  {label}:", flush=True)
        for name in ['cell_2x2', 'cell_med7']:
            h = t = 0
            for a, vals, reg in results:
                if not sel(a) or vals is None or vals[name][1] is None:
                    continue
                t += 1
                h += abs(vals[name][1] - a['known_bortle']) <= 1
            print(f"    1km_{name}: {h}/{t} = {h/t*100:.1f}%", flush=True)
        h = t = 0
        for a, vals, reg in results:
            if not sel(a):
                continue
            r = sh[a['id']]
            if r['pred'] is None:
                continue
            t += 1
            h += r['ok']
        print(f"    shipped   : {h}/{t} = {h/t*100:.1f}%", flush=True)

    print("\n=== Per-anchor: shipped vs 1km cell_med7 (misses only) ===",
          flush=True)
    for a, vals, reg in results:
        r = sh[a['id']]
        s_ok = r['ok']
        m7 = vals['cell_med7'][1] if vals else None
        m_ok = (abs(m7 - a['known_bortle']) <= 1) if m7 is not None else None
        if not s_ok or m_ok is False:
            print(f"  {a['id']}: known={a['known_bortle']} "
                  f"shipped={r['pred']}({'ok' if s_ok else 'MISS'}) "
                  f"1km_med7={m7}({'ok' if m_ok else 'MISS' if m_ok is False else 'nodata'})",
                  flush=True)

    json.dump([{'id': a['id'], 'known': a['known_bortle'],
                'cell_2x2': vals['cell_2x2'] if vals else None,
                'cell_med7': vals['cell_med7'] if vals else None}
               for a, vals, reg in results],
              open(os.path.join(HERE, 'cellcenter_validation.json'), 'w'), indent=1)
    print("\nSaved: cellcenter_validation.json", flush=True)

if __name__ == '__main__':
    main()
