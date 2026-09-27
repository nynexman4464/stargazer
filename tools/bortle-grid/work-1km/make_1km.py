#!/usr/bin/env python3
"""Build production 1km Bortle fine grid for Stargazer.

Model (validated 2026-09-26 on 98 anchors: 85/97 overall, urban 25/28):
  local   = 7x7 median of native VIIRS 2025 radiance (NaN-aware, >=25 valid px)
  walker  = SHIPPED normalization (d in 20km cell units, K1=0.11, K2=0.05,
            p=3.0, rmax=5 cells, sqrt)
  art     = K1*local + K2*walker
  sqm     = 22 - 2.5*log10(1 + art/0.174), clipped [16, 22], quantized 0.05

Coverage: same patch footprint as the shipped 4km fine grid (patch keys read
from src/data/bortle/*/fine.js), each patch refined to 20x20 cells at 1km.

Output (OUTSIDE the repo, destined for MySQL via the PHP upload API):
  ~/workspace/data/bortle-1km/
    <rid>_q<qi>.bin   binary chunks, <=2MB each
    manifest.json     region -> chunks with bboxes, byte sizes, patch counts

Binary chunk format (little-endian):
  [magic 4s='B1K1'][ver u32=1][per u32=20][cellM u32=1000][count u32]
  [index: count x u32 global coarse keys][data: count*400 u8 quant bytes]
Quant byte: round((sqm-16)/0.05); 255 = no data.
"""
import base64
import glob
import json
import math
import os
import re
import struct
import sys
import time
import warnings
from collections import defaultdict

import h5py
import numpy as np
from scipy.ndimage import convolve, map_coordinates

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'mercator-2025'))
from merc_grid import (
    XMIN, YMAX, COLS, ROWS, COARSE_M, R_MERC,
    K1, K2, WALKER_P, WALKER_RMAX_CELLS, WALKER_SQRT,
)

TILE_DIR = "/home/hatch/workspace/data/blackmarble/tiles_2025"
LAYER = "AllAngle_Composite_Snow_Free"
FILL = -999.9
FINE1K_M = 1000.0
PER1K = 20  # 1km cells per 20km coarse cell
OUT_DIR = "/home/hatch/workspace/data/bortle-1km"
REPO = "/home/hatch/workspace/stargazer"
MAX_CHUNK = 2 * 1024 * 1024  # 2MB per chunk file
MED_K = 5          # 11x11 window (was 7x7): covers ~11km to bridge the gap
                   # between local median and Walker start (10km), eliminating
                   # the dark ring without double-counting the center.
MED_MIN_VALID = 25  # >= n*n/2 valid pixels (matches validation)

LON_BANDS = [-180, -135, -90, -45, 0, 45, 90, 135, 180]
LAT_BANDS = [85, 40, 10, -20, -60]


def lat_to_y(lat):
    s = np.sin(np.radians(np.asarray(lat)))
    s = np.clip(s, -0.999999, 0.999999)
    return R_MERC * np.log((1 + s) / (1 - s)) / 2


def y_to_lat(y):
    return np.degrees(2 * np.arctan(np.exp(np.asarray(y) / R_MERC)) - np.pi / 2)


def region_bbox(rid):
    """Region id -> (south, west, north, east) in degrees."""
    lat_idx, lon_idx = int(rid[1]), int(rid[2])
    return (LAT_BANDS[lat_idx + 1], LON_BANDS[lon_idx],
            LAT_BANDS[lat_idx], LON_BANDS[lon_idx + 1])


def load_patch_keys():
    """Load (r, c) -> (region_id, patch_idx_in_region) from shipped fine.js."""
    patch_info = {}
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
    # SHIPPED Walker: 0.5 < d <= 5 (hole prevents double-counting local).
    # The 11x11 local median now covers ~11km, bridging to the Walker's 10km start.
    m = (d > 0.5) & (d <= WALKER_RMAX_CELLS)
    kernel[m] = d[m] ** (-WALKER_P)
    filled = np.nan_to_num(coarse_mean, nan=0.0)
    w = convolve(filled, kernel, mode='constant', cval=0.0)
    if WALKER_SQRT:
        w = np.sqrt(np.maximum(w, 0.0))
    return w


def window_median_at(rad, px, py, k=MED_K, batch=200_000):
    """Vectorized 7x7 NaN-aware window median at float pixel coords.

    Matches validate_expanded.window_median exactly: median of finite values
    in the window, NaN when fewer than n*n/2 pixels are valid.
    rad: 2D float64 with NaN for invalid. px, py: 1D float arrays.
    """
    n = 2 * k + 1
    H, W = rad.shape
    p = np.pad(rad, k, mode='constant', constant_values=np.nan)
    s0, s1 = p.strides
    win = np.lib.stride_tricks.as_strided(
        p, shape=(H, W, n, n), strides=(s0, s1, s0, s1))
    xi_u = np.round(px).astype(np.int64)
    yi_u = np.round(py).astype(np.int64)
    # Points outside the tile are NaN here; the neighboring tile (which also
    # processes this patch via its +/-1 coarse-cell overlap) fills them.
    in_range = (xi_u >= 0) & (xi_u < W) & (yi_u >= 0) & (yi_u < H)
    out = np.full(xi_u.shape, np.nan)
    if not np.any(in_range):
        return out
    idx = np.nonzero(in_range)[0]
    xi = xi_u[idx]
    yi = yi_u[idx]
    res = np.full(len(idx), np.nan)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        for s in range(0, len(idx), batch):
            e = min(len(idx), s + batch)
            w = win[yi[s:e], xi[s:e]]  # (b, n, n)
            cnt = np.sum(~np.isnan(w), axis=(1, 2))
            med = np.nanmedian(w, axis=(1, 2))
            med[cnt < MED_MIN_VALID] = np.nan
            res[s:e] = med
    out[idx] = res
    return out


def patch_bbox_lonlat(keys):
    """keys: array of global coarse keys -> (south, west, north, east) degrees."""
    r = keys // COLS
    c = keys % COLS
    x0 = XMIN + c * COARSE_M
    x1 = x0 + COARSE_M
    y1 = YMAX - r * COARSE_M
    y0 = y1 - COARSE_M
    west = float(np.degrees(x0.min() / R_MERC))
    east = float(np.degrees(x1.max() / R_MERC))
    south = float(y_to_lat(y0.min()))
    north = float(y_to_lat(y1.max()))
    return [round(south, 3), round(west, 3), round(north, 3), round(east, 3)]


def main():
    t0 = time.time()
    os.makedirs(OUT_DIR, exist_ok=True)

    print("Loading patch keys...", flush=True)
    patch_info = load_patch_keys()
    region_patches = defaultdict(list)
    for (r, c), (rid, _) in patch_info.items():
        region_patches[rid].append((r, c))
    for rid in region_patches:
        region_patches[rid].sort()

    print("Loading coarse mean + Walker...", flush=True)
    coarse_mean = np.load(os.path.join(HERE, 'coarse_mean_20km.npy'))
    walker = build_walker(coarse_mean)
    print(f"Walker done ({time.time()-t0:.0f}s)", flush=True)

    reg_data = {}
    reg_keys = {}
    patch_loc = {}
    for rid, plist in region_patches.items():
        n = len(plist)
        reg_data[rid] = np.full((n, PER1K * PER1K), 255, dtype=np.uint8)
        reg_keys[rid] = np.array([r * COLS + c for r, c in plist], dtype=np.uint32)
        for i, (r, c) in enumerate(plist):
            patch_loc[(r, c)] = (rid, i)

    files = sorted(glob.glob(os.path.join(TILE_DIR, "*.h5")))
    assert len(files) == 540, f"expected 540 tiles, found {len(files)}"
    tile_map = {}
    for p in files:
        m = re.search(r"\.h(\d{2})v(\d{2})\.", os.path.basename(p))
        if m:
            tile_map[(int(m.group(1)), int(m.group(2)))] = p

    total_cells = 0
    for ti, ((h, v), path) in enumerate(sorted(tile_map.items())):
        lon_min, lon_max = h*10 - 180, h*10 - 170
        lat_max, lat_min = 90 - v*10, 90 - v*10 - 10
        x0 = math.radians(lon_min) * R_MERC
        x1 = math.radians(lon_max) * R_MERC
        y0 = lat_to_y(lat_min)
        y1 = lat_to_y(lat_max)
        c0 = max(0, int((x0 - XMIN) / COARSE_M) - 1)
        c1 = min(COLS, int(math.ceil((x1 - XMIN) / COARSE_M)) + 1)
        r0 = max(0, int((YMAX - y1) / COARSE_M) - 1)
        r1 = min(ROWS, int(math.ceil((YMAX - y0) / COARSE_M)) + 1)
        patches_here = [(r, c) for r in range(r0, r1) for c in range(c0, c1)
                        if (r, c) in patch_loc]
        if not patches_here:
            continue

        with h5py.File(path, 'r') as f:
            df = f["HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data Fields"]
            rad = df[LAYER][:].astype(np.float64)
        rad[rad == FILL] = np.nan

        # 1km cell centers for these patches.
        # xc is (n_p, 1, 20), yr is (n_p, 20, 1); broadcast both to (n_p, 20, 20)
        # so every (fr, fc) cell gets its true center. (An earlier version
        # sampled the raveled (n_p,1,20)/(n_p,20,1) arrays directly, which
        # mismatched row/col coordinates.)
        n_p = len(patches_here)
        pr = np.array([p[0] for p in patches_here])
        pc = np.array([p[1] for p in patches_here])
        fr = np.arange(PER1K)
        fc = np.arange(PER1K)
        xc = XMIN + (pc[:, None, None]*PER1K + fc[None, None, :] + 0.5) * FINE1K_M
        yr = YMAX - (pr[:, None, None]*PER1K + fr[None, :, None] + 0.5) * FINE1K_M
        xc = np.broadcast_to(xc, (n_p, PER1K, PER1K))
        yr = np.broadcast_to(yr, (n_p, PER1K, PER1K))
        lon_c = np.degrees(xc / R_MERC)
        lat_c = np.degrees(2*np.arctan(np.exp(yr / R_MERC)) - np.pi/2)
        px = (lon_c - lon_min) / 10 * 2400
        py = (lat_max - lat_c) / 10 * 2400

        # 7x7 median local term (vectorized, matches validation exactly)
        local = window_median_at(rad, px.ravel(), py.ravel()).reshape(-1, PER1K, PER1K)

        # Walker at cell centers (bilinear from coarse grid)
        cc = (xc - XMIN) / COARSE_M - 0.5
        cr = (YMAX - yr) / COARSE_M - 0.5
        regional = map_coordinates(walker, [cr.ravel(), cc.ravel()],
                                   order=1, mode='constant',
                                   cval=np.nan).reshape(-1, PER1K, PER1K)
        # Model
        with np.errstate(invalid='ignore', divide='ignore'):
            art = K1 * np.maximum(local, 0.0) + K2 * np.maximum(regional, 0.0)
            sqm = 22.0 - 2.5*np.log10(1.0 + art / 0.174)
            sqm = np.clip(sqm, 16.0, 22.0)
        q = np.full(sqm.shape, 255, dtype=np.uint8)
        ok = np.isfinite(sqm) & np.isfinite(local)
        q[ok] = np.round((sqm[ok] - 16.0) / 0.05).astype(np.uint8)

        for pi, (r, c) in enumerate(patches_here):
            rid, idx = patch_loc[(r, c)]
            cur = reg_data[rid][idx]
            new = q[pi].ravel()
            mask = (cur == 255) & (new != 255)
            cur[mask] = new[mask]
        total_cells += len(patches_here) * 400
        if (ti+1) % 60 == 0:
            print(f"  {ti+1}/{len(tile_map)} tiles ({time.time()-t0:.0f}s)", flush=True)

    print(f"Accumulated {total_cells/1e6:.1f}M cell-samples in {time.time()-t0:.0f}s",
          flush=True)

    # Write per-region chunks (<=2MB each) + manifest
    manifest = {
        "version": 1, "magic": "B1K1", "per": PER1K, "cellM": int(FINE1K_M),
        "quantum": 0.05, "sqmBase": 16.0,
        "model": "7x7 median VIIRS 2025 + shipped Walker (K1=0.11 K2=0.05 p=3 rmax=5 sqrt)",
        "regions": {},
    }
    total_bytes = 0
    for rid in sorted(reg_data):
        data = reg_data[rid]
        keys = reg_keys[rid]
        n = len(keys)
        valid_cells = int(np.count_nonzero(data != 255))
        per_patch = 404  # 4-byte key + 400 data bytes
        chunk_n = max(1, (MAX_CHUNK - 20) // per_patch)
        chunks = []
        qi = 0
        for s in range(0, n, chunk_n):
            e = min(n, s + chunk_n)
            qkeys, qdata = keys[s:e], data[s:e]
            qn = len(qkeys)
            blob = (struct.pack('<4sIIII', b'B1K1', 1, PER1K, int(FINE1K_M), qn)
                    + qkeys.tobytes() + qdata.tobytes())
            cid = f"{rid}_q{qi}"
            fn = f"{cid}.bin"
            with open(os.path.join(OUT_DIR, fn), 'wb') as f:
                f.write(blob)
            chunks.append({
                "id": cid, "file": fn, "bytes": len(blob), "patches": qn,
                "bbox": patch_bbox_lonlat(qkeys),
            })
            total_bytes += len(blob)
            qi += 1
        manifest["regions"][rid] = {
            "bbox": list(region_bbox(rid)),
            "chunks": chunks,
        }
        print(f"{rid}: {n} patches, {valid_cells/1e6:.2f}M valid cells, "
              f"{len(chunks)} chunks", flush=True)

    with open(os.path.join(OUT_DIR, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=1)
    n_chunks = sum(len(r["chunks"]) for r in manifest["regions"].values())
    print(f"Done in {time.time()-t0:.0f}s. {len(manifest['regions'])} regions, "
          f"{n_chunks} chunks, {total_bytes/1e6:.1f} MB total.", flush=True)


if __name__ == '__main__':
    main()
