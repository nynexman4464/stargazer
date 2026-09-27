#!/usr/bin/env python3
"""Validate the 1km Bortle model against the 62 anchors BEFORE full build.

Model (SHIPPED normalization, unchanged):
  - Walker on 20km coarse grid: d^-3, d in cell units, 0.5 < d <= 5, sqrt
  - art = 0.11 * local_1km + 0.05 * walker_interp
  - SQM = 22 - 2.5*log10(1 + art/0.174)
  - Bortle via shipped breaks (astro.js): [21.90,1],[21.70,2],[21.40,3],[20.90,4],
    [19.45,5],[18.70,6],[18.20,7],[17.70,8]

local_1km = 2x2 mean of native VIIRS around the anchor's 1km cell center.
"""
import json
import math
import os
import sys

import h5py
import numpy as np
from scipy.ndimage import convolve, map_coordinates, uniform_filter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'mercator-2025'))
from merc_grid import (
    XMIN, YMAX, COLS, ROWS, COARSE_M, R_MERC, y_to_lat,
    K1, K2, WALKER_P, WALKER_RMAX_CELLS, WALKER_SQRT,
    artificial_to_sqm, quantize,
)

# Shipped runtime Bortle breaks (src/lib/astro.js, commit e308743)
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
FINE1K_M = 1000.0
PER1K = 20

def lat_to_y(lat):
    s = np.sin(np.radians(lat))
    s = np.clip(s, -0.999999, 0.999999)
    return R_MERC * np.log((1 + s) / (1 - s)) / 2

def build_walker(coarse_mean):
    r = int(math.ceil(WALKER_RMAX_CELLS))
    yy, xx = np.mgrid[-r:r+1, -r:r+1]
    d = np.sqrt(xx**2 + yy**2)
    kernel = np.zeros((2*r+1, 2*r+1))
    m = (d > 0.5) & (d <= WALKER_RMAX_CELLS)
    kernel[m] = d[m] ** (-WALKER_P)
    filled = np.nan_to_num(coarse_mean, nan=0.0)
    w = convolve(filled, kernel, mode='constant', cval=0.0)
    if WALKER_SQRT:
        w = np.sqrt(np.maximum(w, 0.0))
    return w

def walker_at(walker_grid, lon, lat):
    """Bilinear sample of Walker grid at lon/lat."""
    x = math.radians(lon) * R_MERC
    y = lat_to_y(lat)
    cc = (x - XMIN) / COARSE_M - 0.5
    cr = (YMAX - y) / COARSE_M - 0.5
    c0, r0 = math.floor(cc), math.floor(cr)
    if not (0 <= c0 < COLS - 1 and 0 <= r0 < ROWS - 1):
        return np.nan
    dx, dy = cc - c0, cr - r0
    b00 = walker_grid[r0, c0]; b10 = walker_grid[r0, c0+1]
    b01 = walker_grid[r0+1, c0]; b11 = walker_grid[r0+1, c0+1]
    if not all(np.isfinite([b00, b10, b01, b11])):
        return np.nan
    return b00*(1-dx)*(1-dy) + b10*dx*(1-dy) + b01*(1-dx)*dy + b11*dx*dy

# Cache tiles
_tile_cache = {}
def get_tile(h, v):
    key = (h, v)
    if key not in _tile_cache:
        path = os.path.join(TILE_DIR, f"VJ146A4.A2025001.h{h:02d}v{v:02d}.002.*.h5")
        import glob
        matches = glob.glob(path)
        if not matches:
            return None
        with h5py.File(matches[0], 'r') as f:
            df = f["HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data Fields"]
            rad = df[LAYER][:].astype(np.float64)
            lat = df["lat"][:]
            lon = df["lon"][:]
        rad[rad == FILL] = np.nan
        # 2x2 mean for 1km local
        valid = np.isfinite(rad).astype(np.float64)
        rf = uniform_filter(np.nan_to_num(rad, nan=0.0), size=2, mode='constant', cval=0.0)
        vf = uniform_filter(valid, size=2, mode='constant', cval=0.0)
        with np.errstate(invalid='ignore', divide='ignore'):
            mean2x2 = np.where(vf > 0.5, rf / np.maximum(vf, 1e-9), np.nan)
        _tile_cache[key] = (mean2x2, valid, lat, lon)
        # Keep cache small
        if len(_tile_cache) > 8:
            _tile_cache.pop(next(iter(_tile_cache)))
    return _tile_cache[key]

def local_1km(lon, lat):
    """2x2-mean VIIRS radiance at the 1km cell containing (lon, lat)."""
    h = int(math.floor((lon + 180) / 10))
    v = int(math.floor((90 - lat) / 10))
    t = get_tile(h, v)
    if t is None:
        return np.nan
    mean2x2, valid, tlat, tlon = t
    lon_min, lat_max = h*10 - 180, 90 - v*10
    # 1km cell center in Mercator -> tile pixel
    x = math.radians(lon) * R_MERC
    y = lat_to_y(lat)
    # Find 1km cell containing this point
    fc_global = math.floor((x - XMIN) / FINE1K_M)
    # Cell center
    xc = XMIN + (fc_global + 0.5) * FINE1K_M
    # y: row from north
    # Use lat/lon of cell center
    lon_c = math.degrees(xc / R_MERC)
    # For y, invert: need lat at cell center. Approximate via y_to_lat.
    # Actually compute the cell's y range and take center.
    # Simpler: sample mean2x2 at the anchor's pixel location (the 2x2 filter
    # already gives ~1km mean around each pixel).
    px = (lon - lon_min) / 10 * 2400
    py = (lat_max - lat) / 10 * 2400
    val = map_coordinates(mean2x2, [[py], [px]], order=1, mode='constant', cval=np.nan)[0]
    return val

def main():
    print("Loading coarse mean radiance...", flush=True)
    coarse_mean = np.load(os.path.join(HERE, 'coarse_mean_20km.npy'))
    print(f"Coarse shape: {coarse_mean.shape}", flush=True)

    print("Computing Walker convolution...", flush=True)
    walker = build_walker(coarse_mean)
    print("Walker done.", flush=True)

    anchors = json.load(open(os.path.join(HERE, '..', 'anchors.json')))
    hits = total = 0
    rows = []
    for a in anchors:
        known = a.get('known_bortle')
        if known is None:
            continue
        total += 1
        loc = local_1km(a['lon'], a['lat'])
        reg = walker_at(walker, a['lon'], a['lat'])
        if not np.isfinite(loc) or not np.isfinite(reg):
            pred = None
            ok = False
        else:
            art = K1 * max(loc, 0.0) + K2 * max(reg, 0.0)
            sqm = float(artificial_to_sqm(np.array([art]))[0])
            pred = sqm_to_bortle(sqm)
            ok = abs(pred - known) <= 1
        hits += ok
        rows.append((a['id'], known, pred, ok,
                     round(float(artificial_to_sqm(np.array([K1*max(loc,0.0)+K2*max(reg,0.0)]))[0]), 2)
                     if np.isfinite(loc) and np.isfinite(reg) else None))

    print(f"\nAnchor score: {hits}/{total}", flush=True)
    print("\nMisses:", flush=True)
    for rid, known, pred, ok, sqm in rows:
        if not ok:
            print(f"  {rid}: known={known} pred={pred} sqm={sqm}", flush=True)
    # Save full results
    json.dump([{'id': r[0], 'known': r[1], 'pred': r[2], 'ok': r[3], 'sqm': r[4]} for r in rows],
              open(os.path.join(HERE, 'anchor_validation.json'), 'w'), indent=1)
    print(f"\nFull results saved.", flush=True)
    return hits, total

if __name__ == '__main__':
    hits, total = main()
    sys.exit(0 if hits >= 58 else 1)
