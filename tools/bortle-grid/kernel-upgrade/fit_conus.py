"""Fit Walker kernel on CONUS patch using all anchors."""
import json
import math
import sys
import time

import numpy as np
from scipy.ndimage import convolve

sys.path.insert(0, '/home/hatch/workspace/stargazer/tools/bortle-grid/mercator-2025')
from merc_grid import R_MERC, COARSE_M

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
    m = (d > 0.5) & (d <= r_max_cells)
    k[m] = d[m] ** (-p)
    return k

def get_anchor_cells():
    """Map anchors to CONUS patch cells."""
    geom = np.load('/tmp/conus_patch_geom.npy')
    PX0, PY0, PCOLS, PROWS = geom
    PCOLS, PROWS = int(PCOLS), int(PROWS)
    
    anchors = json.load(open('/home/hatch/workspace/stargazer/tools/bortle-grid/anchors.json'))
    result = []
    for a in anchors:
        if a.get('known_bortle') is None:
            continue
        # Convert lat/lon to patch cell
        x = math.radians(a['lon']) * R_MERC
        s = math.sin(math.radians(a['lat']))
        y = R_MERC * math.log((1 + s) / (1 - s)) / 2
        c = int((x - PX0) / COARSE_M)
        r = int((PY0 - y) / COARSE_M)
        if 0 <= r < PROWS and 0 <= c < PCOLS:
            result.append((a['id'], a['known_bortle'], r, c))
    return result

def main():
    mean = np.load('/tmp/conus_patch_mean.npy')
    print(f"CONUS mean: {mean.shape}", flush=True)
    
    anchors = get_anchor_cells()
    print(f"Anchors in CONUS: {len(anchors)}", flush=True)
    
    # Precompute walker sums for each (p, rmax)
    results = []
    for p in [2.0, 2.5, 3.0]:
        for rmax in [8, 12, 16]:
            t0 = time.time()
            k = make_walker_kernel(p, rmax)
            filled = np.nan_to_num(mean, nan=0.0)
            ws = convolve(filled, k, mode='constant', cval=0.0)
            
            X = []
            y = []
            for aid, known, r, c in anchors:
                local = max(mean[r, c], 0) if np.isfinite(mean[r, c]) else 0
                regional = ws[r, c]
                target = sqm_to_art(BORTLE_SQM[known])
                X.append([local, regional])
                y.append(target)
            X = np.array(X)
            y = np.array(y)
            coef, _, _, _ = np.linalg.lstsq(X, y, rcond=None)
            k1, k2 = coef
            yhat = X @ coef
            r2 = 1 - ((y - yhat)**2).sum() / ((y - y.mean())**2).sum()
            # Also compute anchor hit rate (within 1 Bortle class)
            hits = 0
            for i, (aid, known, r, c) in enumerate(anchors):
                pred_art = k1 * X[i, 0] + k2 * X[i, 1]
                pred_sqm = 22.0 - 2.5 * math.log10(1 + pred_art / NATURAL)
                pred_sqm = max(16.0, min(22.0, pred_sqm))
                # Convert to Bortle
                for edge, cls in [(21.76, 1), (21.60, 2), (21.30, 3), (20.80, 4),
                                  (19.25, 5), (18.50, 6), (18.00, 7), (17.50, 8)]:
                    if pred_sqm >= edge:
                        pred_b = cls
                        break
                else:
                    pred_b = 9
                if abs(pred_b - known) <= 1:
                    hits += 1
            print(f"p={p}, rmax={rmax} ({rmax*25}km): k1={k1:.4f}, k2={k2:.7f}, "
                  f"R2={r2:.3f}, anchors {hits}/{len(anchors)} ({time.time()-t0:.1f}s)",
                  flush=True)
            results.append((p, rmax, k1, k2, hits))

if __name__ == '__main__':
    main()
