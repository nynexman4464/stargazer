"""Test Walker-law kernels on the New England patch.

Compares kernel shapes and fits k1/k2 against Falchi grid.
"""
import math
import os
import sys
import time

import numpy as np
from scipy.ndimage import convolve

sys.path.insert(0, '/home/hatch/workspace/stargazer/tools/bortle-grid/mercator-2025')
sys.path.insert(0, '/home/hatch/workspace/stargazer/tools/bortle-grid/blackmarble-2025')
from merc_grid import XMIN, YMAX, COARSE_M, R_MERC
from bm_grid import load_falchi_grid, COLS as FCOLS, ROWS as FROWS, LONMIN as FLONMIN, LATMAX as FLATMAX, STEP as FSTEP

PATCH_LONMIN, PATCH_LONMAX = -76.0, -68.0
PATCH_LATMIN, PATCH_LATMAX = 40.0, 47.0

def make_walker_kernel(p, r_max_cells):
    """Walker-law kernel: w(d) = d^-p for 0 < d <= r_max. Center = 0."""
    r = int(math.ceil(r_max_cells))
    size = 2 * r + 1
    yy, xx = np.mgrid[-r:r+1, -r:r+1]
    d = np.sqrt(xx**2 + yy**2)
    k = np.zeros((size, size))
    m = (d > 0) & (d <= r_max_cells)
    k[m] = d[m] ** (-p)
    return k

def walker_sum(mean_rad, p, r_max_cells):
    """Unnormalized weighted sum with Walker kernel. NaN-aware."""
    k = make_walker_kernel(p, r_max_cells)
    filled = np.nan_to_num(mean_rad, nan=0.0)
    w = np.isfinite(mean_rad).astype(np.float64)
    # Convolve radiance and weight separately
    s = convolve(filled, k, mode='constant', cval=0.0)
    # For the weight, convolve the mask with the same kernel
    # (this gives the sum of weights where data exists)
    return s, k

def patch_cell_latlon():
    """Lat/lon of patch cell centers."""
    mean = np.load('/tmp/ne_patch_mean.npy')
    pr, pc = mean.shape
    # Reconstruct from proto.py geometry
    PX0 = math.radians(PATCH_LONMIN) * R_MERC
    PY0 = R_MERC * math.log((1 + math.sin(math.radians(PATCH_LATMAX))) /
                            (1 - math.sin(math.radians(PATCH_LATMAX)))) / 2
    xs = PX0 + (np.arange(pc) + 0.5) * COARSE_M
    ys = PY0 - (np.arange(pr) + 0.5) * COARSE_M
    xx, yy = np.meshgrid(xs, ys)
    lon = np.degrees(xx / R_MERC)
    lat = np.degrees(2 * np.arctan(np.exp(yy / R_MERC)) - np.pi / 2)
    return lat, lon

def falchi_art_on_patch():
    """Sample Falchi artificial brightness at patch cells."""
    print("Loading Falchi grid...", flush=True)
    _, falchi_art = load_falchi_grid()
    lat, lon = patch_cell_latlon()
    # Bilinear sample falchi_art at (lat, lon)
    # Falchi grid: rows 0..579, cols 0..1439, latmax 85.054..., lonmin -180, step 0.25
    fr = (FLATMAX - lat) / FSTEP - 0.5
    fc = (lon - FLONMIN) / FSTEP - 0.5
    from scipy.ndimage import map_coordinates
    # falchi_art has NaN for unknown; fill with 0 for sampling
    fa = np.nan_to_num(falchi_art, nan=0.0)
    sampled = map_coordinates(fa, [fr.ravel(), fc.ravel()],
                              order=1, mode='constant', cval=0.0).reshape(lat.shape)
    # Also check validity
    valid = np.isfinite(falchi_art)
    vs = map_coordinates(valid.astype(float), [fr.ravel(), fc.ravel()],
                         order=1, mode='constant', cval=0.0).reshape(lat.shape)
    sampled[vs < 0.5] = np.nan
    return sampled

def fit_k1k2(local, wsum, target):
    """OLS fit: target = k1*local + k2*wsum. Returns (k1, k2, r2)."""
    ok = np.isfinite(local) & np.isfinite(wsum) & np.isfinite(target)
    # Focus on well-lit cells like the original, but include some dark ones
    # Original used art > 0.05; we'll use a lower threshold to weight dark areas
    ok = ok & (target > 0.01) & (local >= 0)
    X = np.column_stack([local[ok], wsum[ok]])
    y = target[ok]
    # OLS via lstsq
    coef, res, _, _ = np.linalg.lstsq(X, y, rcond=None)
    k1, k2 = coef
    yhat = X @ coef
    ss_res = ((y - yhat) ** 2).sum()
    ss_tot = ((y - y.mean()) ** 2).sum()
    r2 = 1 - ss_res / ss_tot
    return k1, k2, r2, ok.sum()

if __name__ == '__main__':
    mean = np.load('/tmp/ne_patch_mean.npy')
    print(f"Patch mean loaded: {mean.shape}", flush=True)
    
    falchi = falchi_art_on_patch()
    print(f"Falchi sampled: {np.count_nonzero(np.isfinite(falchi))} valid cells", flush=True)
    
    # Test kernel parameters
    for p in [2.0, 2.5, 3.0]:
        for rmax in [6, 8, 10]:  # cells; 8 cells = 200km
            t0 = time.time()
            wsum, k = walker_sum(mean, p, rmax)
            k1, k2, r2, n = fit_k1k2(np.maximum(mean, 0), wsum, falchi)
            print(f"p={p}, rmax={rmax} ({rmax*25}km): k1={k1:.4f}, k2={k2:.6f}, R2={r2:.4f}, n={n} ({time.time()-t0:.1f}s)",
                  flush=True)
