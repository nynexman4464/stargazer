"""Final spot checks with chosen parameters: p=3.0, rmax=8, k1=0.1179, k2=0.02."""
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
    art = max(art, 0)
    return max(16.0, min(22.0, 22.0 - 2.5 * math.log10(1 + art / NATURAL)))

geom = np.load('/tmp/conus_patch_geom.npy')
PX0, PY0, PCOLS, PROWS = geom
PCOLS, PROWS = int(PCOLS), int(PROWS)
mean = np.load('/tmp/conus_patch_mean.npy')
filled = np.nan_to_num(mean, nan=0.0)

def latlon_to_cell(lat, lon):
    x = math.radians(lon) * R_MERC
    s = math.sin(math.radians(lat))
    y = R_MERC * math.log((1 + s) / (1 - s)) / 2
    return int((PY0 - y) / COARSE_M), int((x - PX0) / COARSE_M)

# Old blur
mask = np.isfinite(mean).astype(np.float64)
bnum = gaussian_filter(filled * mask, sigma=2.75)
bden = gaussian_filter(mask, sigma=2.75)
old_blur = np.full(mean.shape, np.nan)
okb = bden > 1e-9
old_blur[okb] = bnum[okb] / bden[okb]

# New Walker p=3.0, rmax=8
r = 8
yy, xx = np.mgrid[-r:r+1, -r:r+1]
d = np.sqrt(xx**2 + yy**2)
wk = np.zeros((2*r+1, 2*r+1))
m = (d > 0.5) & (d <= 8)
wk[m] = d[m] ** (-3.0)
wsum = convolve(filled, wk, mode='constant', cval=0.0)

K1, K2_OLD, K2_NEW = 0.1179, 0.0642, 0.02

spots = [
    ("Rutland VT area", 43.60, -72.62, "want B2-3 (old B1)"),
    ("Between Rut/Leb", 43.381, -72.823, "Alex's screenshot spot"),
    ("Plattsburgh NY", 44.70, -73.45, "want B4-5"),
    ("Boston downtown", 42.36, -71.06, "want B8-9"),
    ("NYC", 40.7128, -74.006, "want B9"),
    ("Boundary Waters", 47.90, -91.86, "want B1 (stay dark)"),
    ("Big Bend", 29.3282, -103.20614, "want B1 (stay dark)"),
    ("Cherry Springs", 41.66, -77.82, "known B2"),
]

print(f"{'Spot':20s} {'Old':>10s} {'New':>10s}  Note")
for name, la, lo, note in spots:
    rr, cc = latlon_to_cell(la, lo)
    if not (0 <= rr < PROWS and 0 <= cc < PCOLS):
        print(f"{name:20s} OUT OF PATCH"); continue
    local = max(mean[rr, cc], 0) if np.isfinite(mean[rr, cc]) else 0
    ob = old_blur[rr, cc] if np.isfinite(old_blur[rr, cc]) else 0
    
    art_old = K1 * local + K2_OLD * max(ob, 0)
    art_new = K1 * local + K2_NEW * wsum[rr, cc]
    sqm_old = art_to_sqm(art_old)
    sqm_new = art_to_sqm(art_new)
    print(f"{name:20s} {sqm_old:5.2f}/B{sqm_to_bortle(sqm_old)}   "
          f"{sqm_new:5.2f}/B{sqm_to_bortle(sqm_new)}  {note}")
