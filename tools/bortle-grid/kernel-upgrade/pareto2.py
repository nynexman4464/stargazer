"""Pareto for p=2.5 and rmax=12 variants."""
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

def make_walker(p, rmax):
    r = int(math.ceil(rmax))
    yy, xx = np.mgrid[-r:r+1, -r:r+1]
    d = np.sqrt(xx**2 + yy**2)
    k = np.zeros((2*r+1, 2*r+1))
    m = (d > 0.5) & (d <= rmax)
    k[m] = d[m] ** (-p)
    return k

anchors = json.load(open('/home/hatch/workspace/stargazer/tools/bortle-grid/anchors.json'))
anchor_cells = []
for a in anchors:
    if a.get('known_bortle') is None: continue
    rr, cc = latlon_to_cell(a['lat'], a['lon'])
    if 0 <= rr < PROWS and 0 <= cc < PCOLS:
        anchor_cells.append((a['id'], a['known_bortle'], rr, cc))

rut_r, rut_c = latlon_to_cell(43.60, -72.62)
bw_r, bw_c = latlon_to_cell(47.90, -91.86)
bos_r, bos_c = latlon_to_cell(42.36, -71.06)

for p, rmax in [(2.5, 8), (2.5, 12), (3.0, 12)]:
    print(f"\n=== p={p}, rmax={rmax} ===", flush=True)
    wsum = convolve(filled, make_walker(p, rmax), mode='constant', cval=0.0)
    rut_wsum = wsum[rut_r, rut_c]
    print(f"Rutland wsum={rut_wsum:.1f}", flush=True)
    
    best_ok = None
    for k1 in [0.08, 0.09, 0.10, 0.1179]:
        for k2 in [0.02, 0.03, 0.04, 0.05]:
            hits = 0
            for aid, known, rr, cc in anchor_cells:
                local = max(mean[rr, cc], 0) if np.isfinite(mean[rr, cc]) else 0
                art = k1 * local + k2 * wsum[rr, cc]
                if abs(sqm_to_bortle(art_to_sqm(art)) - known) <= 1:
                    hits += 1
            rut_local = max(mean[rut_r, rut_c], 0)
            b_rut = sqm_to_bortle(art_to_sqm(k1 * rut_local + k2 * rut_wsum))
            bw_local = max(mean[bw_r, bw_c], 0)
            b_bw = sqm_to_bortle(art_to_sqm(k1 * bw_local + k2 * wsum[bw_r, bw_c]))
            bos_local = max(mean[bos_r, bos_c], 0)
            b_bos = sqm_to_bortle(art_to_sqm(k1 * bos_local + k2 * wsum[bos_r, bos_c]))
            ok = (b_rut >= 2) and (b_bw == 1) and (b_bos >= 7)
            if ok and (best_ok is None or hits > best_ok[0]):
                best_ok = (hits, k1, k2, b_rut, b_bw, b_bos)
    if best_ok:
        print(f"BEST OK: {best_ok[0]}/62 at k1={best_ok[1]}, k2={best_ok[2]} "
              f"(Rut B{best_ok[3]}, BW B{best_ok[4]}, Bos B{best_ok[5]})", flush=True)
    else:
        print("No OK params found", flush=True)
