"""Generate Web Mercator coarse Bortle grid (25km cells) from Black Marble tiles.

Processes each VIIRS tile, reprojects to Mercator target cells.
"""
import glob
import math
import os
import re
import sys
import time

import h5py
import numpy as np
from scipy.ndimage import convolve, map_coordinates

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from merc_grid import (
    XMIN, YMAX, XMAX_ADJ, YMIN_ADJ, COLS, ROWS, COARSE_M,
    K1, K2, WALKER_P, WALKER_RMAX_CELLS, WALKER_SQRT,
    artificial_to_sqm, quantize, y_to_lat,
)

TILE_DIR = "/home/hatch/workspace/data/blackmarble/tiles_2025"
LAYER = "AllAngle_Composite_Snow_Free"
HV_RE = re.compile(r"\.h(\d{2})v(\d{2})\.")

R_MERC = 6378137.0

def tile_latlon_bounds(h, v):
    """Return (lon_min, lon_max, lat_min, lat_max) for tile h,v."""
    lon_min = h * 10 - 180
    lat_max = 90 - v * 10
    return lon_min, lon_min + 10, lat_max - 10, lat_max

def lat_to_y(lat_deg):
    s = np.sin(np.radians(lat_deg))
    # Clip to avoid inf at poles
    s = np.clip(s, -0.999999, 0.999999)
    return R_MERC * np.log((1 + s) / (1 - s)) / 2

def main():
    t0 = time.time()
    files = sorted(glob.glob(os.path.join(TILE_DIR, "*.h5")))
    print(f"Found {len(files)} tiles", flush=True)

    # Target grid accumulators
    sum_grid = np.zeros((ROWS, COLS), dtype=np.float64)
    cnt_grid = np.zeros((ROWS, COLS), dtype=np.float64)

    for fi, path in enumerate(files):
        m = HV_RE.search(os.path.basename(path))
        if not m:
            continue
        h, v = int(m.group(1)), int(m.group(2))
        lon_min, lon_max, lat_min, lat_max = tile_latlon_bounds(h, v)

        # Convert tile bounds to Mercator meters
        x0 = math.radians(lon_min) * R_MERC
        x1 = math.radians(lon_max) * R_MERC
        y0 = lat_to_y(lat_min)
        y1 = lat_to_y(lat_max)

        # Find target cell range
        c0 = max(0, int((x0 - XMIN) / COARSE_M))
        c1 = min(COLS, int(math.ceil((x1 - XMIN) / COARSE_M)))
        # Note: y decreases as row increases (YMAX at row 0)
        r0 = max(0, int((YMAX - y1) / COARSE_M))
        r1 = min(ROWS, int(math.ceil((YMAX - y0) / COARSE_M)))

        if c0 >= c1 or r0 >= r1:
            continue

        # Target cell centers in meters
        ncols = c1 - c0
        nrows = r1 - r0
        xs = XMIN + (np.arange(c0, c1) + 0.5) * COARSE_M
        ys = YMAX - (np.arange(r0, r1) + 0.5) * COARSE_M
        xx, yy = np.meshgrid(xs, ys)

        # Convert to lat/lon
        lon_t = np.degrees(xx / R_MERC)
        # Inverse mercator (vectorized)
        lat_t = np.degrees(2 * np.arctan(np.exp(yy / R_MERC)) - np.pi / 2)

        # Convert lat/lon to source tile pixels
        # Tile: 10x10 deg, 2400x2400, lon_min to lon_min+10, lat_max-10 to lat_max
        src_x = (lon_t - lon_min) / 10 * 2400
        src_y = (lat_max - lat_t) / 10 * 2400

        # Load tile and sample
        with h5py.File(path, 'r') as f:
            ds = f[f'HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data Fields/{LAYER}']
            # Read the whole tile (2400x2400 float32 = 23MB, ok)
            rad = ds[:].astype(np.float64)
            rad[rad > 60000] = np.nan

            # Sample via map_coordinates (order=1, bilinear)
            # map_coordinates expects (row, col) = (y, x)
            sampled = map_coordinates(
                np.nan_to_num(rad, nan=0.0),
                [src_y.ravel(), src_x.ravel()],
                order=1, mode='constant', cval=0.0
            ).reshape(nrows, ncols)

            # Also need a validity mask (where source was not NaN)
            valid_src = np.isfinite(rad)
            # For simplicity, consider sampled valid if the bilinear weights
            # were mostly from valid pixels. We'll approximate by checking
            # if the center pixel was valid.
            # (A more precise method would propagate the mask, but this is ok
            # for a prototype; the full version should do it properly.)
            # Actually, let's do it properly: sample the valid mask too.
            valid_sampled = map_coordinates(
                valid_src.astype(np.float64),
                [src_y.ravel(), src_x.ravel()],
                order=1, mode='constant', cval=0.0
            ).reshape(nrows, ncols)

            # Only keep where >50% of the bilinear footprint was valid
            ok = valid_sampled > 0.5
            sum_grid[r0:r1, c0:c1][ok] += sampled[ok]
            cnt_grid[r0:r1, c0:c1][ok] += 1

        if (fi + 1) % 60 == 0:
            print(f"  {fi+1}/{len(files)} ({time.time()-t0:.0f}s)", flush=True)

    print(f"Accumulated in {time.time()-t0:.0f}s", flush=True)
    print(f"Cells with data: {np.count_nonzero(cnt_grid) / 1e6:.2f}M / {ROWS*COLS/1e6:.2f}M", flush=True)

    # Compute mean radiance
    mean_rad = np.full((ROWS, COLS), np.nan)
    has = cnt_grid > 0
    mean_rad[has] = sum_grid[has] / cnt_grid[has]

    # Save the mean for the fine generator (and debugging)
    np.save('/tmp/merc_coarse_mean.npy', mean_rad)
    print("Saved /tmp/merc_coarse_mean.npy", flush=True)

    # Apply K1/K2 model with Walker-law skyglow kernel.
    # w(d) = d^(-p) for 0.5 < d <= rmax cells, center excluded (k1*local
    # handles the center). Unnormalized weighted sum: skyglow is a sum of
    # contributions, not an average. Calibrated 2026-09-25 (kernel-upgrade/).
    print("Applying Walker skyglow kernel...", flush=True)
    r = int(math.ceil(WALKER_RMAX_CELLS))
    yy, xx = np.mgrid[-r:r+1, -r:r+1]
    d = np.sqrt(xx**2 + yy**2)
    kernel = np.zeros((2*r+1, 2*r+1))
    m = (d > 0.5) & (d <= WALKER_RMAX_CELLS)
    kernel[m] = d[m] ** (-WALKER_P)
    print(f"  kernel {kernel.shape}, sum={kernel.sum():.1f}", flush=True)

    filled = np.nan_to_num(mean_rad, nan=0.0)
    walker_sum = convolve(filled, kernel, mode='constant', cval=0.0)
    if WALKER_SQRT:
        walker_sum = np.sqrt(np.maximum(walker_sum, 0.0))

    art = K1 * np.maximum(mean_rad, 0.0) + K2 * np.maximum(walker_sum, 0.0)
    # Where mean_rad is NaN (oceans etc.), fall back to the regional term so
    # coastal waters still show nearby city glow.
    nan_art = ~np.isfinite(art)
    art[nan_art] = (K1 + K2) * np.maximum(walker_sum[nan_art], 0.0)

    sqm = artificial_to_sqm(art)
    qb = quantize(sqm)

    print(f"Quantized: {np.count_nonzero(qb != 255) / 1e6:.2f}M cells with data", flush=True)
    print(f"SQM range: {np.nanmin(sqm):.2f} to {np.nanmax(sqm):.2f}", flush=True)

    np.save('/tmp/merc_coarse_q.npy', qb)
    print("Saved /tmp/merc_coarse_q.npy", flush=True)
    print(f"Total time: {time.time()-t0:.0f}s", flush=True)

if __name__ == '__main__':
    main()
