"""Generate Web Mercator fine Bortle patches (5km cells) for bright areas.

Sparse 5x5 patches per bright coarse cell (SQM <= 21.0 + 1-cell halo).
Same K1/K2 model as coarse, sampled at fine resolution.
"""
import glob
import math
import os
import re
import sys
import time

import h5py
import numpy as np
from scipy.ndimage import map_coordinates

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from merc_grid import (
    XMIN, YMAX, COLS, ROWS, COARSE_M, FINE_M, PER,
    K1, K2, artificial_to_sqm, quantize,
)

TILE_DIR = "/home/hatch/workspace/data/blackmarble/tiles_2025"
LAYER = "AllAngle_Composite_Snow_Free"
HV_RE = re.compile(r"\.h(\d{2})v(\d{2})\.")
R_MERC = 6378137.0

def tile_latlon_bounds(h, v):
    lon_min = h * 10 - 180
    lat_max = 90 - v * 10
    return lon_min, lon_min + 10, lat_max - 10, lat_max

def lat_to_y(lat_deg):
    s = np.sin(np.radians(lat_deg))
    s = np.clip(s, -0.999999, 0.999999)
    return R_MERC * np.log((1 + s) / (1 - s)) / 2

def main():
    t0 = time.time()

    # Load coarse quantized to find bright cells
    print("Loading coarse grid...", flush=True)
    qb = np.load('/tmp/merc_coarse_q.npy')
    print(f"Coarse shape: {qb.shape}", flush=True)

    # Bright cells: SQM <= 21.0 => byte <= (21.0-16)/0.05 = 100
    bright = (qb != 255) & (qb <= 100)
    print(f"Bright coarse cells: {np.count_nonzero(bright)}", flush=True)

    # Add 1-cell halo via dilation
    from scipy.ndimage import binary_dilation
    mask = binary_dilation(bright, structure=np.ones((3, 3)))
    print(f"Cells with halo: {np.count_nonzero(mask)}", flush=True)

    # Get list of (row, col) for masked cells
    rows, cols = np.nonzero(mask)
    n_patches = len(rows)
    print(f"Generating {n_patches} fine patches...", flush=True)

    # Load coarse mean for the blurred term
    coarse_mean = np.load('/tmp/merc_coarse_mean.npy')

    # For the blurred term at fine centers: we need the Gaussian-blurred
    # coarse mean sampled at fine resolution. We'll compute the blurred
    # coarse grid once, then sample it.
    from scipy.ndimage import gaussian_filter
    print("Computing blurred coarse for K2 term...", flush=True)
    filled = np.nan_to_num(coarse_mean, nan=0.0)
    cmask = np.isfinite(coarse_mean).astype(np.float64)
    bnum = gaussian_filter(filled * cmask, sigma=2.75)
    bden = gaussian_filter(cmask, sigma=2.75)
    blurred_coarse = np.full_like(coarse_mean, np.nan)
    okb = bden > 1e-9
    blurred_coarse[okb] = bnum[okb] / bden[okb]

    # Group fine cells by source tile for efficient sampling
    # Each fine cell: 5km, center in meters -> lat/lon -> tile/pixel

    # Precompute all fine cell centers
    # For patch (r, c), fine cells are at:
    #   x = XMIN + (c*PER + fc + 0.5) * FINE_M, fc=0..4
    #   y = YMAX - (r*PER + fr + 0.5) * FINE_M, fr=0..4

    # We'll process in batches by tile to avoid loading all tiles at once.
    # Instead: for each tile, find which fine cells it covers.

    files = sorted(glob.glob(os.path.join(TILE_DIR, "*.h5")))
    tile_map = {}
    for path in files:
        m = HV_RE.search(os.path.basename(path))
        if m:
            tile_map[(int(m.group(1)), int(m.group(2)))] = path
    print(f"Tile map: {len(tile_map)} tiles", flush=True)

    # Output: patch data (n_patches x 25 uint8)
    patch_data = np.full((n_patches, PER * PER), 255, dtype=np.uint8)
    patch_keys = np.array([rows[i] * COLS + cols[i] for i in range(n_patches)], dtype=np.uint32)
    # Sort by key for efficient lookup (like the original)
    order = np.argsort(patch_keys)
    patch_keys = patch_keys[order]
    rows, cols = rows[order], cols[order]
    # Note: patch_data is still in original order; we'll fill it sorted
    # Actually, let's keep it simple and fill in sorted order
    patch_data_sorted = np.full((n_patches, PER * PER), 255, dtype=np.uint8)

    # For each tile, process the fine cells it contains
    # To avoid O(n_patches * n_tiles), we'll invert: for each fine cell,
    # compute its tile, then group.

    print("Assigning fine cells to tiles...", flush=True)
    # Total fine cells: n_patches * 25
    # This could be large (if 100k patches, 2.5M cells). Let's do it in chunks.

    # Precompute fine cell centers for all patches (vectorized)
    # Shape: (n_patches, 5, 5)
    fc = np.arange(PER)
    fr = np.arange(PER)
    # x centers: XMIN + (c*PER + fc + 0.5) * FINE_M
    # Use broadcasting
    xc = XMIN + (cols[:, None, None] * PER + fc[None, None, :] + 0.5) * FINE_M
    # y centers: YMAX - (r*PER + fr + 0.5) * FINE_M
    yr = YMAX - (rows[:, None, None] * PER + fr[None, :, None] + 0.5) * FINE_M
    # Broadcast to (n_patches, PER, PER) for consistent indexing
    xc = np.broadcast_to(xc, (n_patches, PER, PER))
    yr = np.broadcast_to(yr, (n_patches, PER, PER))

    # Convert to lat/lon (vectorized)
    lon_f = np.degrees(xc / R_MERC)
    lat_f = np.degrees(2 * np.arctan(np.exp(yr / R_MERC)) - np.pi / 2)

    # Determine tile for each fine cell
    h_idx = np.floor((lon_f + 180) / 10).astype(int)
    v_idx = np.floor((90 - lat_f) / 10).astype(int)
    # Clip to valid range
    h_idx = np.clip(h_idx, 0, 35)
    v_idx = np.clip(v_idx, 0, 17)

    # Group by tile
    from collections import defaultdict
    tile_cells = defaultdict(list)
    # Iterate over patches and fine cells (this is O(n_patches*25), which is ok)
    print("Grouping...", flush=True)
    for pi in range(n_patches):
        for fri in range(PER):
            for fci in range(PER):
                h, v = h_idx[pi, fri, fci], v_idx[pi, fri, fci]
                tile_cells[(h, v)].append((pi, fri, fci))

    print(f"Fine cells grouped into {len(tile_cells)} tiles", flush=True)

    # Process each tile
    for ti, ((h, v), cells) in enumerate(tile_cells.items()):
        path = tile_map.get((h, v))
        if not path:
            continue
        lon_min, lon_max, lat_min, lat_max = tile_latlon_bounds(h, v)

        with h5py.File(path, 'r') as f:
            ds = f[f'HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data Fields/{LAYER}']
            rad = ds[:].astype(np.float64)
            rad[rad > 60000] = np.nan
            valid_src = np.isfinite(rad)

            # Collect lat/lon for these cells
            lats = np.array([lat_f[pi, fri, fci] for pi, fri, fci in cells])
            lons = np.array([lon_f[pi, fri, fci] for pi, fri, fci in cells])

            # Convert to pixel
            src_x = (lons - lon_min) / 10 * 2400
            src_y = (lat_max - lats) / 10 * 2400

            # Sample radiance
            sampled = map_coordinates(
                np.nan_to_num(rad, nan=0.0),
                [src_y, src_x],
                order=1, mode='constant', cval=0.0
            )
            valid_s = map_coordinates(
                valid_src.astype(np.float64),
                [src_y, src_x],
                order=1, mode='constant', cval=0.0
            )

            # Sample blurred coarse at fine centers
            # Convert fine cell meters to coarse cell indices
            # Coarse col = floor((x - XMIN) / COARSE_M), row = floor((YMAX - y) / COARSE_M)
            # We have the patch (r,c) and fine (fr,fc), so coarse is just (r,c)
            # But for the blurred term, we sample the blurred_coarse grid
            # at the fine cell's location (bilinear).
            # Coarse grid coordinates: col = (x - XMIN)/COARSE_M - 0.5, row = (YMAX - y)/COARSE_M - 0.5
            # We can compute from the patch indices directly:
            # Fine cell (pi, fr, fc) corresponds to coarse (rows[pi], cols[pi])
            # The fine cell center in coarse-cell coordinates:
            #   cc = cols[pi] + (fc + 0.5)/PER - 0.5
            #   cr = rows[pi] + (fr + 0.5)/PER - 0.5

            for idx, (pi, fri, fci) in enumerate(cells):
                if valid_s[idx] < 0.5:
                    continue
                local = sampled[idx]
                # Blurred term: sample blurred_coarse at fine center
                cc = cols[pi] + (fci + 0.5) / PER - 0.5
                cr = rows[pi] + (fri + 0.5) / PER - 0.5
                # Bilinear sample from blurred_coarse
                # (simplified: use nearest for now, or do bilinear)
                # Let's do bilinear properly
                c0i, r0i = int(math.floor(cc)), int(math.floor(cr))
                c1i, r1i = c0i + 1, r0i + 1
                # Check bounds
                if not (0 <= c0i < COLS - 1 and 0 <= r0i < ROWS - 1):
                    continue
                dx, dy = cc - c0i, cr - r0i
                b00 = blurred_coarse[r0i, c0i]
                b10 = blurred_coarse[r0i, c1i]
                b01 = blurred_coarse[r1i, c0i]
                b11 = blurred_coarse[r1i, c1i]
                if not (np.isfinite(b00) and np.isfinite(b10) and np.isfinite(b01) and np.isfinite(b11)):
                    # Fall back to local if blurred not available
                    blurred_val = local
                else:
                    blurred_val = (b00 * (1-dx) * (1-dy) + b10 * dx * (1-dy) +
                                   b01 * (1-dx) * dy + b11 * dx * dy)

                art = K1 * max(local, 0.0) + K2 * max(blurred_val, 0.0)
                sqm = artificial_to_sqm(np.array([art]))[0]
                qb_val = quantize(np.array([sqm]))[0]
                patch_data_sorted[pi, fri * PER + fci] = qb_val

        if (ti + 1) % 50 == 0:
            print(f"  {ti+1}/{len(tile_cells)} tiles ({time.time()-t0:.0f}s)", flush=True)

    print(f"Fine patches done in {time.time()-t0:.0f}s", flush=True)
    print(f"Non-255 values: {np.count_nonzero(patch_data_sorted != 255) / 1e6:.2f}M", flush=True)

    # Save
    np.save('/tmp/merc_fine_keys.npy', patch_keys)
    np.save('/tmp/merc_fine_data.npy', patch_data_sorted)
    print("Saved /tmp/merc_fine_keys.npy and /tmp/merc_fine_data.npy", flush=True)

if __name__ == '__main__':
    main()
