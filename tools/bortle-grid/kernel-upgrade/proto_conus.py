"""Accumulate VIIRS mean radiance for CONUS patch (25-50N, 65-125W)."""
import glob
import math
import os
import re
import sys
import time

import h5py
import numpy as np
from scipy.ndimage import map_coordinates

sys.path.insert(0, '/home/hatch/workspace/stargazer/tools/bortle-grid/mercator-2025')
from merc_grid import R_MERC, COARSE_M

TILE_DIR = "/home/hatch/workspace/data/blackmarble/tiles_2025"
LAYER = "AllAngle_Composite_Snow_Free"

PATCH_LONMIN, PATCH_LONMAX = -125.0, -65.0
PATCH_LATMIN, PATCH_LATMAX = 25.0, 50.0

def lat_to_y(lat_deg):
    s = np.sin(np.radians(np.asarray(lat_deg, dtype=float)))
    s = np.clip(s, -0.999999, 0.999999)
    return R_MERC * np.log((1 + s) / (1 - s)) / 2

def lon_to_x(lon_deg):
    return np.radians(np.asarray(lon_deg, dtype=float)) * R_MERC

PX0 = lon_to_x(PATCH_LONMIN)
PX1 = lon_to_x(PATCH_LONMAX)
PY1 = lat_to_y(PATCH_LATMIN)
PY0 = lat_to_y(PATCH_LATMAX)
PCOLS = int(math.ceil((PX1 - PX0) / COARSE_M))
PROWS = int(math.ceil((PY0 - PY1) / COARSE_M))
print(f"CONUS patch: {PCOLS} x {PROWS} cells")

def main():
    t0 = time.time()
    # Tiles: h05-h11, v04-v06
    want_h = [f"h{h:02d}" for h in range(5, 12)]
    want_v = [f"v{v:02d}" for v in range(4, 7)]
    files = sorted(glob.glob(os.path.join(TILE_DIR, "*.h5")))
    tfiles = []
    for f in files:
        base = os.path.basename(f)
        m = re.search(r"\.(h\d{2})(v\d{2})\.", base)
        if m and m.group(1) in want_h and m.group(2) in want_v:
            tfiles.append(f)
    print(f"Using {len(tfiles)} tiles", flush=True)
    
    sum_g = np.zeros((PROWS, PCOLS), np.float64)
    cnt_g = np.zeros((PROWS, PCOLS), np.float64)
    
    xs = PX0 + (np.arange(PCOLS) + 0.5) * COARSE_M
    ys = PY0 - (np.arange(PROWS) + 0.5) * COARSE_M
    xx, yy = np.meshgrid(xs, ys)
    lon_t = np.degrees(xx / R_MERC)
    lat_t = np.degrees(2 * np.arctan(np.exp(yy / R_MERC)) - np.pi / 2)
    
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
    
    mean = np.full((PROWS, PCOLS), np.nan)
    has = cnt_g > 0
    mean[has] = sum_g[has] / cnt_g[has]
    print(f"Coverage: {np.count_nonzero(has)}/{PROWS*PCOLS} cells", flush=True)
    np.save('/tmp/conus_patch_mean.npy', mean)
    # Save geometry for coordinate mapping
    np.save('/tmp/conus_patch_geom.npy', np.array([PX0, PY0, PCOLS, PROWS]))
    print(f"Saved in {time.time()-t0:.0f}s", flush=True)

if __name__ == '__main__':
    main()
