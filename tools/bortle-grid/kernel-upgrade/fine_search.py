"""Fine grid search + miss list comparison."""
import json
import math
import sys

import numpy as np
from scipy.ndimage import convolve

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

# p=2.5, rmax=8 Walker
r = 8
yy, xx = np.mgrid[-r:r+1, -r:r+1]
d = np.sqrt(xx**2 + yy**2)
wk = np.zeros((2*r+1, 2*r+1))
m = (d > 0.5) & (d <= 8)
wk[m] = d[m] ** (-2.5)
wsum = convolve(filled, wk, mode='constant', cval=0.0)

anchors = json.load(open('/home/hatch/workspace/stargazer/tools/bortle-grid/anchors.json'))
anchor_cells = []
for a in anchors:
    if a.get('known_bortle') is None: continue
    rr, cc = latlon_to_cell(a['lat'], a['lon'])
    if 0 <= rr < PROWS and 0 <= cc < PCOLS:
        anchor_cells.append((a['id'], a['known_bortle'], rr, cc))

rut_r, rut_c = latlon_to_cell(43.60, -72.62)

def eval_params(k1, k2):
    hits = 0
    misses = []
    for aid, known, rr, cc in anchor_cells:
        local = max(mean[rr, cc], 0) if np.isfinite(mean[rr, cc]) else 0
        art = k1 * local + k2 * wsum[rr, cc]
        pred = sqm_to_bortle(art_to_sqm(art))
        if abs(pred - known) <= 1:
            hits += 1
        else:
            misses.append(aid)
    rut_local = max(mean[rut_r, rut_c], 0)
    b_rut = sqm_to_bortle(art_to_sqm(k1 * rut_local + k2 * wsum[rut_r, rut_c]))
    return hits, b_rut, misses

# Fine search around k1=0.1, k2=0.02
print("Fine search p=2.5, rmax=8:", flush=True)
best = None
for k1 in [0.09, 0.095, 0.10, 0.105, 0.11]:
    for k2 in [0.015, 0.02, 0.025, 0.03]:
        hits, b_rut, misses = eval_params(k1, k2)
        ok = "OK " if b_rut >= 2 else "   "
        print(f"{ok}k1={k1:.3f} k2={k2:.3f}: {hits}/62, Rutland B{b_rut}", flush=True)
        if b_rut >= 2 and (best is None or hits > best[0]):
            best = (hits, k1, k2, misses)

print(f"\nBest with Rutland>=B2: {best[0]}/62 at k1={best[1]}, k2={best[2]}", flush=True)
print(f"Misses: {best[3]}", flush=True)
