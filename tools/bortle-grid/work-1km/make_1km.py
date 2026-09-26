#!/usr/bin/env python3
"""Build production 1km Bortle fine grid for Stargazer.

1km radiance (2x2 mean of native VIIRS) + SHIPPED Walker model
(d in 20km cell units, K1=0.11, K2=0.05, p=3.0, rmax=5 cells, sqrt).

Output: per-region 1km patch files (20x20 cells per coarse patch),
  gitignored build artifacts in work-1km/regions/.
"""
import base64
import glob
import math
import os
import re
import sys
import time
from collections import defaultdict

import h5py
import numpy as np
from scipy.ndimage import convolve, map_coordinates, uniform_filter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'mercator-2025'))
from merc_grid import (
    XMIN, YMAX, COLS, ROWS, COARSE_M, R_MERC, y_to_lat,
    K1, K2, WALKER_P, WALKER_RMAX_CELLS, WALKER_SQRT,
    artificial_to_sqm, quantize, UNKNOWN,
)

TILE_DIR = "/home/hatch/workspace/data/blackmarble/tiles_2025"
LAYER = "AllAngle_Composite_Snow_Free"
FILL = -999.9
FINE1K_M = 1000.0
PER1K = 20  # 1km cells per 20km coarse cell
OUT_DIR = os.path.join(HERE, 'regions')
REPO = "/home/hatch/workspace/stargazer"

# Region bounds (from src/lib/bortleRegions.js)
LON_BANDS = [-180, -135, -90, -45, 0, 45, 90, 135, 180]
LAT_BANDS = [85, 40, 10, -20, -60]

def lat_to_y(lat):
    s = np.sin(np.radians(np.asarray(lat)))
    s = np.clip(s, -0.999999, 0.999999)
    return R_MERC * np.log((1 + s) / (1 - s)) / 2

def region_id_for(lat, lon):
    ln = lon
    while ln < -180: ln += 360
    while ln > 180: ln -= 360
    if lat > 85 or lat < -60: return None
    lonIdx = next((i for i in range(8) if LON_BANDS[i] <= ln < LON_BANDS[i+1]), 7 if ln == 180 else -1)
    if lonIdx == -1: return None
    latIdx = next((i for i in range(4) if LAT_BANDS[i] >= lat > LAT_BANDS[i+1]), -1)
    if latIdx == -1: return None
    return f"r{latIdx}{lonIdx}"

def load_patch_keys():
    """Load (r, c) -> (region_id, patch_idx_in_region) from shipped fine.js."""
    patch_info = {}  # (r, c) -> (rid, idx)
    for path in sorted(glob.glob(os.path.join(REPO, 'src/data/bortle/r*/fine.js'))):
        rid = path.split('/')[-2]
        js = open(path).read()
        m = re.search(r"count: (\d+)", js)
        count = int(m.group(1))
        if count == 0:
            continue
        m2 = re.search(r"index: '([A-Za-z0-9+/=]+)'", js)
        idx = np.frombuffer(base64.b64decode(m2.group(1)), dtype=np.uint32)
        assert len(idx) == count, f"{rid}: index len {len(idx)} != {count}"
        for i, k in enumerate(idx):
            r, c = divmod(int(k), COLS)
            patch_info[(r, c)] = (rid, i)
    print(f"Loaded {len(patch_info)} patches from shipped fine.js", flush=True)
    return patch_info

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

def main():
    t0 = time.time()
    os.makedirs(OUT_DIR, exist_ok=True)

    print("Loading patch keys...", flush=True)
    patch_info = load_patch_keys()
    # Group patches by region for output
    region_patches = defaultdict(list)  # rid -> [(r, c)]
    for (r, c), (rid, _) in patch_info.items():
        region_patches[rid].append((r, c))
    for rid in region_patches:
        region_patches[rid].sort()

    print("Loading coarse mean + Walker...", flush=True)
    coarse_mean = np.load(os.path.join(HERE, 'coarse_mean_20km.npy'))
    walker = build_walker(coarse_mean)
    print(f"Walker done ({time.time()-t0:.0f}s)", flush=True)

    # Output accumulators: per region, list of (key, 400 uint8)
    # We'll accumulate in dicts then write.
    # For memory: process tile by tile, accumulate into per-region arrays.
    n_patches = len(patch_info)
    # Map (r,c) -> linear patch index for output ordering (per region)
    # Actually, we'll store per-region: keys array + data array (n_reg_patches x 400)
    reg_data = {}
    reg_keys = {}
    for rid, plist in region_patches.items():
        n = len(plist)
        reg_data[rid] = np.full((n, PER1K*PER1K), 255, dtype=np.uint8)
        reg_keys[rid] = np.array([r*COLS + c for r, c in plist], dtype=np.uint32)
        # Map (r,c) -> (rid, idx_in_region)
    patch_loc = {}
    for rid, plist in region_patches.items():
        for i, (r, c) in enumerate(plist):
            patch_loc[(r, c)] = (rid, i)

    # Tile map
    files = sorted(glob.glob(os.path.join(TILE_DIR, "*.h5")))
    assert len(files) == 540, f"expected 540 tiles, found {len(files)}"
    tile_map = {}
    for p in files:
        m = re.search(r"\.h(\d{2})v(\d{2})\.", os.path.basename(p))
        if m:
            tile_map[(int(m.group(1)), int(m.group(2)))] = p

    # Process tiles
    total_cells = 0
    for ti, ((h, v), path) in enumerate(sorted(tile_map.items())):
        lon_min, lon_max = h*10 - 180, h*10 - 170
        lat_max, lat_min = 90 - v*10, 90 - v*10 - 10
        # Coarse cell range overlapping this tile
        x0 = math.radians(lon_min) * R_MERC
        x1 = math.radians(lon_max) * R_MERC
        y0 = lat_to_y(lat_min)
        y1 = lat_to_y(lat_max)
        c0 = max(0, int((x0 - XMIN) / COARSE_M) - 1)
        c1 = min(COLS, int(math.ceil((x1 - XMIN) / COARSE_M)) + 1)
        r0 = max(0, int((YMAX - y1) / COARSE_M) - 1)
        r1 = min(ROWS, int(math.ceil((YMAX - y0) / COARSE_M)) + 1)
        # Find patches in range
        patches_here = []
        for r in range(r0, r1):
            for c in range(c0, c1):
                if (r, c) in patch_loc:
                    patches_here.append((r, c))
        if not patches_here:
            continue

        # Load tile, apply 2x2 mean
        with h5py.File(path, 'r') as f:
            df = f["HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data Fields"]
            rad = df[LAYER][:].astype(np.float64)
        rad[rad == FILL] = np.nan
        valid = np.isfinite(rad).astype(np.float64)
        rf = uniform_filter(np.nan_to_num(rad, nan=0.0), size=2, mode='constant', cval=0.0)
        vf = uniform_filter(valid, size=2, mode='constant', cval=0.0)
        with np.errstate(invalid='ignore', divide='ignore'):
            mean2x2 = np.where(vf > 0.5, rf / np.maximum(vf, 1e-9), np.nan)

        # 1km cell centers for these patches (vectorized)
        # For patch (r,c), cell (fr,fc): x = XMIN + (c*20 + fc + 0.5)*1000
        pr = np.array([p[0] for p in patches_here])
        pc = np.array([p[1] for p in patches_here])
        fr = np.arange(PER1K)
        fc = np.arange(PER1K)
        # Shape (n_p, 20, 20)
        xc = XMIN + (pc[:, None, None]*PER1K + fc[None, None, :] + 0.5) * FINE1K_M
        yr = YMAX - (pr[:, None, None]*PER1K + fr[None, :, None] + 0.5) * FINE1K_M
        lon_c = np.degrees(xc / R_MERC)
        lat_c = np.degrees(2*np.arctan(np.exp(yr / R_MERC)) - np.pi/2)
        # Tile pixel coords
        px = (lon_c - lon_min) / 10 * 2400
        py = (lat_max - lat_c) / 10 * 2400
        # Sample 2x2-mean radiance
        local = map_coordinates(mean2x2, [py.ravel(), px.ravel()],
                                order=1, mode='constant', cval=np.nan).reshape(-1, PER1K, PER1K)
        # Walker at cell centers (bilinear from coarse grid)
        # Coarse coords: cc = (x - XMIN)/COARSE_M - 0.5
        cc = (xc - XMIN) / COARSE_M - 0.5
        cr = (YMAX - yr) / COARSE_M - 0.5
        # map_coordinates on walker (row 0 = north)
        regional = map_coordinates(walker, [cr.ravel(), cc.ravel()],
                                   order=1, mode='constant', cval=np.nan).reshape(-1, PER1K, PER1K)
        # Model
        with np.errstate(invalid='ignore', divide='ignore'):
            art = K1 * np.maximum(local, 0.0) + K2 * np.maximum(regional, 0.0)
            sqm = 22.0 - 2.5*np.log10(1.0 + art / 0.174)
            sqm = np.clip(sqm, 16.0, 22.0)
        q = np.full(sqm.shape, 255, dtype=np.uint8)
        ok = np.isfinite(sqm) & np.isfinite(local)
        q[ok] = np.round((sqm[ok] - 16.0) / 0.05).astype(np.uint8)
        # Store
        for pi, (r, c) in enumerate(patches_here):
            rid, idx = patch_loc[(r, c)]
            # Only fill cells that are valid; keep 255 for no-data
            # (q already 255 where not ok)
            cur = reg_data[rid][idx]
            new = q[pi].ravel()
            # Merge: prefer valid over 255 (tiles overlap at edges)
            mask = (cur == 255) & (new != 255)
            cur[mask] = new[mask]
        total_cells += len(patches_here) * 400
        if (ti+1) % 60 == 0:
            print(f"  {ti+1}/{len(tile_map)} tiles ({time.time()-t0:.0f}s)", flush=True)

    print(f"Accumulated {total_cells/1e6:.1f}M cell-samples in {time.time()-t0:.0f}s", flush=True)
    # Write per-region files
    manifest = {}
    for rid in sorted(reg_data):
        data = reg_data[rid]
        keys = reg_keys[rid]
        n = len(keys)
        valid_cells = np.count_nonzero(data != 255)
        print(f"{rid}: {n} patches, {valid_cells/1e6:.2f}M valid cells", flush=True)
        # Binary format: [magic 4][ver 4][per 4][cellM 4][count 4][index u32][data u8]
        import struct
        header = struct.pack('<4sIIII', b'B1K1', 1, PER1K, int(FINE1K_M), n)
        blob = header + keys.tobytes() + data.tobytes()
        # Split if > 10MB
        MAX_BYTES = 10*1024*1024
        out_sub = os.path.join(OUT_DIR, rid)
        os.makedirs(out_sub, exist_ok=True)
        if len(blob) <= MAX_BYTES:
            fn = f"fine1k.bin"
            open(os.path.join(out_sub, fn), 'wb').write(blob)
            manifest[rid] = [fn]
            print(f"  wrote {fn} ({len(blob)/1e6:.1f} MB)", flush=True)
        else:
            # Split by latitude halves until under limit
            # Simple: split patches into chunks
            n_chunks = (len(blob) + MAX_BYTES - 1) // MAX_BYTES
            # Split into n_chunks x 2 for margin (quarters)
            n_chunks = min(n_chunks * 2, 8)
            chunk_size = (n + n_chunks - 1) // n_chunks
            fns = []
            for qi in range(n_chunks):
                s = qi*chunk_size
                e = min(n, s+chunk_size)
                if s >= e: break
                qkeys = keys[s:e]
                qdata = data[s:e]
                qn = len(qkeys)
                qheader = struct.pack('<4sIIII', b'B1K1', 1, PER1K, int(FINE1K_M), qn)
                qblob = qheader + qkeys.tobytes() + qdata.tobytes()
                fn = f"fine1k_q{qi}.bin"
                open(os.path.join(out_sub, fn), 'wb').write(qblob)
                fns.append(fn)
                print(f"  wrote {fn} ({len(qblob)/1e6:.1f} MB)", flush=True)
            manifest[rid] = fns
    import json
    json.dump(manifest, open(os.path.join(OUT_DIR, 'manifest.json'), 'w'), indent=1)
    print(f"Done in {time.time()-t0:.0f}s. Manifest: {len(manifest)} regions.", flush=True)

if __name__ == '__main__':
    main()
