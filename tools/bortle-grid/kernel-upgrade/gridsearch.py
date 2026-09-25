"""Grid search k1/k2 to maximize anchor hits for Walker kernels."""
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

def make_walker(p, rmax):
    r = int(math.ceil(rmax))
    yy, xx = np.mgrid[-r:r+1, -r:r+1]
    d = np.sqrt(xx**2 + yy**2)
    k = np.zeros((2*r+1, 2*r+1))
    m = (d > 0.5) & (d <= rmax)
    k[m] = d[m] ** (-p)
    return k

# Load
geom = np.load('/tmp/conus_patch_geom.npy')
PX0, PY0, PCOLS, PROWS = geom
PCOLS, PROWS = int(PCOLS), int(PROWS)
mean = np.load('/tmp/conus_patch_mean.npy')
filled = np.nan_to_num(mean, nan=0.0)

anchors = json.load(open('/home/hatch/workspace/stargazer/tools/bortle-grid/anchors.json'))
anchor_cells = []
for a in anchors:
    if a.get('known_bortle') is None: continue
    x = math.radians(a['lon']) * R_MERC
    s = math.sin(math.radians(a['lat']))
    y = R_MERC * math.log((1 + s) / (1 - s)) / 2
    c = int((x - PX0) / COARSE_M)
    r = int((PY0 - y) / COARSE_M)
    if 0 <= r < PROWS and 0 <= c < PCOLS:
        anchor_cells.append((a['id'], a['known_bortle'], r, c))

print(f"Anchors: {len(anchor_cells)}", flush=True)

# Precompute walker sums
walker_sums = {}
for p, rmax in [(2.5, 8), (3.0, 8), (2.5, 12), (3.0, 12)]:
    print(f"Computing Walker p={p} rmax={rmax}...", flush=True)
    walker_sums[(p, rmax)] = convolve(filled, make_walker(p, rmax), mode='constant', cval=0.0)

# Grid search
for (p, rmax), ws in walker_sums.items():
    best = (0, None, None)
    # k1 around 0.08-0.12, k2 around 0.03-0.06
    for k1 in [0.07, 0.08, 0.09, 0.10, 0.11, 0.12]:
        for k2 in [0.03, 0.035, 0.04, 0.045, 0.05, 0.055, 0.06]:
            hits = 0
            for aid, known, r, c in anchor_cells:
                local = max(mean[r, c], 0) if np.isfinite(mean[r, c]) else 0
                art = k1 * local + k2 * ws[r, c]
                pred = sqm_to_bortle(art_to_sqm(art))
                if abs(pred - known) <= 1:
                    hits += 1
            if hits > best[0]:
                best = (hits, k1, k2)
    print(f"p={p}, rmax={rmax}: best {best[0]}/{len(anchor_cells)} at k1={best[1]}, k2={best[2]}", flush=True)
