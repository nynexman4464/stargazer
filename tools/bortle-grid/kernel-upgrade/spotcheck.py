"""Spot-check old vs new model at problem locations."""
import math
import sys

import numpy as np
from scipy.ndimage import convolve, gaussian_filter

sys.path.insert(0, '/home/hatch/workspace/stargazer/tools/bortle-grid/mercator-2025')
from merc_grid import R_MERC, COARSE_M

NATURAL = 0.174
BORTLE_BREAKS = [(21.76, 1), (21.60, 2), (21.30, 3), (20.80, 4),
                 (19.25, 5), (18.50, 6), (18.00, 7), (17.50, 8)]
def sqm_to_bortle(sqm):
    for edge, cls in BORTLE_BREAKS:
        if sqm >= edge: return cls
    return 9

def art_to_sqm(art):
    return max(16.0, min(22.0, 22.0 - 2.5 * math.log10(1 + art / NATURAL)))

# Load CONUS patch
geom = np.load('/tmp/conus_patch_geom.npy')
PX0, PY0, PCOLS, PROWS = geom
PCOLS, PROWS = int(PCOLS), int(PROWS)
mean = np.load('/tmp/conus_patch_mean.npy')

def latlon_to_cell(lat, lon):
    x = math.radians(lon) * R_MERC
    s = math.sin(math.radians(lat))
    y = R_MERC * math.log((1 + s) / (1 - s)) / 2
    c = int((x - PX0) / COARSE_M)
    r = int((PY0 - y) / COARSE_M)
    return r, c

# Old model: k1=0.1179, k2=0.0642, gaussian sigma=2.75 cells
print("Computing old-model blurred...", flush=True)
filled = np.nan_to_num(mean, nan=0.0)
mask = np.isfinite(mean).astype(np.float64)
bnum = gaussian_filter(filled * mask, sigma=2.75)
bden = gaussian_filter(mask, sigma=2.75)
old_blur = np.full(mean.shape, np.nan)
okb = bden > 1e-9
old_blur[okb] = bnum[okb] / bden[okb]

# New model: Walker p=2.5, rmax=8, k1/k2 from fit
def make_walker(p, rmax):
    r = int(math.ceil(rmax))
    yy, xx = np.mgrid[-r:r+1, -r:r+1]
    d = np.sqrt(xx**2 + yy**2)
    k = np.zeros((2*r+1, 2*r+1))
    m = (d > 0.5) & (d <= rmax)
    k[m] = d[m] ** (-p)
    return k

print("Computing Walker sums...", flush=True)
wk25 = convolve(filled, make_walker(2.5, 8), mode='constant', cval=0.0)
wk30 = convolve(filled, make_walker(3.0, 8), mode='constant', cval=0.0)

spots = [
    ("Rutland VT area", 43.60, -72.62, "should be 2-3, old says 1"),
    ("Plattsburgh NY", 44.70, -73.45, "city 20k, should be 4-5, old says 1"),
    ("Boston downtown", 42.36, -71.06, "should stay 8-9"),
    ("Boundary Waters", 47.90, -91.86, "should stay 1"),
    ("Cherry Springs", 41.66, -77.82, "known 2"),
    ("Medford MA", 42.4184, -71.1062, "known 8 (has special-case)"),
]

print(f"\n{'Spot':20s} {'Old':>12s} {'W2.5':>12s} {'W3.0':>12s}  Note")
for name, la, lo, note in spots:
    r, c = latlon_to_cell(la, lo)
    if not (0 <= r < PROWS and 0 <= c < PCOLS):
        print(f"{name:20s} OUT OF PATCH")
        continue
    local = max(mean[r, c], 0) if np.isfinite(mean[r, c]) else 0
    
    # Old
    ob = old_blur[r, c] if np.isfinite(old_blur[r, c]) else 0
    art_old = 0.1179 * local + 0.0642 * max(ob, 0)
    sqm_old = art_to_sqm(max(art_old, 0))
    
    # New W2.5 (k1=0.0866, k2=0.0421)
    art_w25 = 0.0866 * local + 0.0421 * wk25[r, c]
    sqm_w25 = art_to_sqm(max(art_w25, 0))
    
    # New W3.0 (k1=0.0831, k2=0.0482)
    art_w30 = 0.0831 * local + 0.0482 * wk30[r, c]
    sqm_w30 = art_to_sqm(max(art_w30, 0))
    
    print(f"{name:20s} {sqm_old:.2f}/B{sqm_to_bortle(sqm_old):d}   "
          f"{sqm_w25:.2f}/B{sqm_to_bortle(sqm_w25):d}   "
          f"{sqm_w30:.2f}/B{sqm_to_bortle(sqm_w30):d}  {note}")
