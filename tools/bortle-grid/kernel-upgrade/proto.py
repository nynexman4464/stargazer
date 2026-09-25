"""Prototype Walker-law skyglow kernel on a New England test patch.

Patch: 40-47N, 68-76W. Accumulates VIIRS mean radiance for the patch from the
4 covering tiles, then tests kernel parameters.
"""
import glob
import math
import os
import re
import sys
import time

import h5py
import numpy as np
from scipy.ndimage import convolve

sys.path.insert(0, '/home/hatch/workspace/stargazer/tools/bortle-grid/mercator-2025')
from merc_grid import XMIN, YMAX, COARSE_M, artificial_to_sqm, quantize

TILE_DIR = "/home/hatch/workspace/data/blackmarble/tiles_2025"
LAYER = "AllAngle_Composite_Snow_Free"
R_MERC = 6378137.0

# New England patch bounds
PATCH_LONMIN, PATCH_LONMAX = -76.0, -68.0
PATCH_LATMIN, PATCH_LATMAX = 40.0, 47.0

def lat_to_y(lat_deg):
    s = np.sin(np.radians(np.asarray(lat_deg, dtype=float)))
    s = np.clip(s, -0.999999, 0.999999)
    return R_MERC * np.log((1 + s) / (1 - s)) / 2

def lon_to_x(lon_deg):
    return np.radians(np.asarray(lon_deg, dtype=float)) * R_MERC

# Patch grid in Mercator meters, 25km cells
PX0 = lon_to_x(PATCH_LONMIN)
PX1 = lon_to_x(PATCH_LONMAX)
PY1 = lat_to_y(PATCH_LATMIN)
PY0 = lat_to_y(PATCH_LATMAX)
PCOLS = int(math.ceil((PX1 - PX0) / COARSE_M))
PROWS = int(math.ceil((PY0 - PY1) / COARSE_M))
print(f"Patch: {PCOLS} x {PROWS} cells at 25km")

def accumulate_patch():
    """Accumulate mean radiance for the patch from covering tiles."""
    # Tiles covering the patch: h10v04, h11v04, h10v05, h11v05
    want = {('h10v04'), ('h11v04'), ('h10v05'), ('h11v05')}
    files = sorted(glob.glob(os.path.join(TILE_DIR, "*.h5")))
    tfiles = [f for f in files if any(w in os.path.basename(f) for w in want)]
    print(f"Using {len(tfiles)} tiles")
    
    sum_g = np.zeros((PROWS, PCOLS), np.float64)
    cnt_g = np.zeros((PROWS, PCOLS), np.float64)
    
    # Patch cell centers in meters
    xs = PX0 + (np.arange(PCOLS) + 0.5) * COARSE_M
    ys = PY0 - (np.arange(PROWS) + 0.5) * COARSE_M
    xx, yy = np.meshgrid(xs, ys)
    lon_t = np.degrees(xx / R_MERC)
    lat_t = np.degrees(2 * np.arctan(np.exp(yy / R_MERC)) - np.pi / 2)
    
    from scipy.ndimage import map_coordinates
    for path in tfiles:
        base = os.path.basename(path)
        m = re.search(r"\.h(\d{2})v(\d{2})\.", base)
        h, v = int(m.group(1)), int(m.group(2))
        lon_min, lat_max = h * 10 - 180, 90 - v * 10
        
        src_x = (lon_t - lon_min) / 10 * 2400
        src_y = (lat_max - lat_t) / 10 * 2400
        
        with h5py.File(path, 'r') as f:
            ds = f[f'HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data Fields/{LAYER}']
            rad = ds[:].astype(np.float64)
            rad[rad > 60000] = np.nan
            
            # Only sample where source coords are in-bounds
            valid_src = np.isfinite(rad)
            inb = (src_x >= 0) & (src_x < 2400) & (src_y >= 0) & (src_y < 2400)
            
            sampled = map_coordinates(
                np.nan_to_num(rad, nan=0.0),
                [src_y.ravel(), src_x.ravel()],
                order=1, mode='constant', cval=0.0).reshape(PROWS, PCOLS)
            vsampled = map_coordinates(
                valid_src.astype(np.float64),
                [src_y.ravel(), src_x.ravel()],
                order=1, mode='constant', cval=0.0).reshape(PROWS, PCOLS)
            
            ok = inb & (vsampled > 0.5)
            sum_g[ok] += sampled[ok]
            cnt_g[ok] += 1
        print(f"  {base} done", flush=True)
    
    mean = np.full((PROWS, PCOLS), np.nan)
    has = cnt_g > 0
    mean[has] = sum_g[has] / cnt_g[has]
    print(f"Patch coverage: {np.count_nonzero(has)}/{PROWS*PCOLS} cells")
    return mean

if __name__ == '__main__':
    t0 = time.time()
    mean = accumulate_patch()
    np.save('/tmp/ne_patch_mean.npy', mean)
    print(f"Saved /tmp/ne_patch_mean.npy in {time.time()-t0:.0f}s")
