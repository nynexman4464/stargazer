"""Find (k1,k2) that maximizes anchors subject to Rutland >= B2."""
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

# Walker p=3.0, rmax=8
r = 8
yy, xx = np.mgrid[-r:r+1, -r:r+1]
d = np.sqrt(xx**2 + yy**2)
wk = np.zeros((2*r+1, 2*r+1))
m = (d > 0.5) & (d <= 8)
wk[m] = d[m] ** (-3.0)
wsum = convolve(filled, wk, mode='constant', cval=0.0)

anchors = json.load(open('/home/hatch/workspace/stargazer/tools/bortle-grid/anchors.json'))
anchor_cells = []
for a in anchors:
    if a.get('known_bortle') is None: continue
    rr, cc = latlon_to_cell(a['lat'], a['lon'])
    if 0 <= rr < PROWS and 0 <= cc < PCOLS:
        anchor_cells.append((a['id'], a['known_bortle'], rr, cc))

# Rutland cell
rut_r, rut_c = latlon_to_cell(43.60, -72.62)
rut_local = max(mean[rut_r, rut_c], 0)
rut_wsum = wsum[rut_r, rut_c]
print(f"Rutland: local={rut_local:.3f}, wsum={rut_wsum:.1f}", flush=True)

# Also check Boundary Waters (must stay B1) and Boston (must stay B8+)
bw_r, bw_c = latlon_to_cell(47.90, -91.86)
bos_r, bos_c = latlon_to_cell(42.36, -71.06)

results = []
for k1 in [0.06, 0.07, 0.08, 0.09, 0.10, 0.1179]:
    for k2 in [0.02, 0.03, 0.04, 0.05, 0.06, 0.08]:
        # Anchor hits
        hits = 0
        for aid, known, rr, cc in anchor_cells:
            local = max(mean[rr, cc], 0) if np.isfinite(mean[rr, cc]) else 0
            art = k1 * local + k2 * wsum[rr, cc]
            if abs(sqm_to_bortle(art_to_sqm(art)) - known) <= 1:
                hits += 1
        # Rutland
        art_rut = k1 * rut_local + k2 * rut_wsum
        b_rut = sqm_to_bortle(art_to_sqm(art_rut))
        # Boundary Waters (must be B1)
        bw_local = max(mean[bw_r, bw_c], 0)
        art_bw = k1 * bw_local + k2 * wsum[bw_r, bw_c]
        b_bw = sqm_to_bortle(art_to_sqm(art_bw))
        # Boston (must be >= B7)
        bos_local = max(mean[bos_r, bos_c], 0)
        art_bos = k1 * bos_local + k2 * wsum[bos_r, bos_c]
        b_bos = sqm_to_bortle(art_to_sqm(art_bos))
        
        ok = (b_rut >= 2) and (b_bw == 1) and (b_bos >= 7)
        flag = "OK " if ok else "   "
        results.append((hits, k1, k2, b_rut, b_bw, b_bos, ok))
        print(f"{flag}k1={k1:.4f} k2={k2:.3f}: anchors {hits}/62, Rutland B{b_rut}, BW B{b_bw}, Bos B{b_bos}",
              flush=True)

# Best among OK
ok_results = [r for r in results if r[6]]
ok_results.sort(reverse=True)
print(f"\nBest with Rutland>=B2, BW=B1, Bos>=B7:", flush=True)
for r in ok_results[:5]:
    print(f"  {r[0]}/62 at k1={r[1]:.4f}, k2={r[2]:.3f} (Rut B{r[3]}, BW B{r[4]}, Bos B{r[5]})", flush=True)
