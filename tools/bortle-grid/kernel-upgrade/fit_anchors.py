"""Fit Walker kernel k1/k2 against the 62 ground-truth anchors.

Uses Bortle->SQM midpoints as targets. Tests (p, r_max) combinations.
"""
import json
import math
import os
import sys
import time

import numpy as np
from scipy.ndimage import convolve

sys.path.insert(0, '/home/hatch/workspace/stargazer/tools/bortle-grid/mercator-2025')
from merc_grid import R_MERC, COARSE_M

PATCH_LONMIN, PATCH_LONMAX = -76.0, -68.0
PATCH_LATMIN, PATCH_LATMAX = 40.0, 47.0

# Bortle class -> SQM midpoint (from BORTLE_BREAKS ranges)
BORTLE_SQM = {1: 21.88, 2: 21.68, 3: 21.45, 4: 21.05, 5: 20.02,
              6: 18.88, 7: 18.25, 8: 17.75, 9: 16.75}
NATURAL = 0.174

def sqm_to_art(sqm):
    return NATURAL * (10.0 ** ((22.0 - sqm) / 2.5) - 1.0)

def make_walker_kernel(p, r_max_cells):
    r = int(math.ceil(r_max_cells))
    size = 2 * r + 1
    yy, xx = np.mgrid[-r:r+1, -r:r+1]
    d = np.sqrt(xx**2 + yy**2)
    k = np.zeros((size, size))
    m = (d > 0.5) & (d <= r_max_cells)  # exclude center (d<0.5), k1 handles it
    k[m] = d[m] ** (-p)
    return k

def walker_sum(mean_rad, p, r_max_cells):
    k = make_walker_kernel(p, r_max_cells)
    filled = np.nan_to_num(mean_rad, nan=0.0)
    return convolve(filled, k, mode='constant', cval=0.0)

def patch_coords():
    """Return (lat_grid, lon_grid) for patch cells."""
    mean = np.load('/tmp/ne_patch_mean.npy')
    pr, pc = mean.shape
    PX0 = math.radians(PATCH_LONMIN) * R_MERC
    PY0 = R_MERC * math.log((1 + math.sin(math.radians(PATCH_LATMAX))) /
                            (1 - math.sin(math.radians(PATCH_LATMAX)))) / 2
    xs = PX0 + (np.arange(pc) + 0.5) * COARSE_M
    ys = PY0 - (np.arange(pr) + 0.5) * COARSE_M
    xx, yy = np.meshgrid(xs, ys)
    lon = np.degrees(xx / R_MERC)
    lat = np.degrees(2 * np.arctan(np.exp(yy / R_MERC)) - np.pi / 2)
    return lat, lon

def get_anchors_in_patch():
    """Anchors within the patch bounds."""
    anchors = json.load(open('/home/hatch/workspace/stargazer/tools/bortle-grid/anchors.json'))
    lat_g, lon_g = patch_coords()
    pr, pc = lat_g.shape
    result = []
    for a in anchors:
        if a.get('known_bortle') is None:
            continue
        # Find nearest patch cell
        dlat = np.abs(lat_g - a['lat'])
        dlon = np.abs(lon_g - a['lon'])
        dist = np.sqrt(dlat**2 + dlon**2)
        r, c = np.unravel_index(np.argmin(dist), dist.shape)
        if dist[r, c] > 0.2:  # too far from patch
            continue
        result.append((a['id'], a['known_bortle'], r, c, a['lat'], a['lon']))
    return result

def main():
    mean = np.load('/tmp/ne_patch_mean.npy')
    print(f"Patch: {mean.shape}", flush=True)
    
    anchors = get_anchors_in_patch()
    print(f"Anchors in patch: {len(anchors)}", flush=True)
    for aid, known, r, c, la, lo in anchors:
        print(f"  {aid}: known={known} at cell ({r},{c})", flush=True)
    
    # Build target array from anchors
    # For fitting, we need local and regional at each anchor
    print("\nTesting kernel parameters...", flush=True)
    for p in [2.0, 2.5, 3.0]:
        for rmax in [6, 8, 12]:
            ws = walker_sum(mean, p, rmax)
            # Collect (local, regional, target_art) for anchors
            X = []
            y = []
            for aid, known, r, c, la, lo in anchors:
                local = max(mean[r, c], 0) if np.isfinite(mean[r, c]) else 0
                regional = ws[r, c] if np.isfinite(ws[r, c]) else 0
                target = sqm_to_art(BORTLE_SQM[known])
                X.append([local, regional])
                y.append(target)
            X = np.array(X)
            y = np.array(y)
            # OLS
            coef, _, _, _ = np.linalg.lstsq(X, y, rcond=None)
            k1, k2 = coef
            # R²
            yhat = X @ coef
            ss_res = ((y - yhat) ** 2).sum()
            ss_tot = ((y - y.mean()) ** 2).sum()
            r2 = 1 - ss_res / ss_tot if ss_tot > 0 else 0
            print(f"  p={p}, rmax={rmax} ({rmax*25}km): k1={k1:.4f}, k2={k2:.6f}, R2={r2:.3f}, n={len(y)}",
                  flush=True)

if __name__ == '__main__':
    main()
