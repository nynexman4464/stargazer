"""Old model anchor score on CONUS patch (fair baseline)."""
import json
import math
import sys

import numpy as np
from scipy.ndimage import gaussian_filter

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

# Old model blur
filled = np.nan_to_num(mean, nan=0.0)
mask = np.isfinite(mean).astype(np.float64)
bnum = gaussian_filter(filled * mask, sigma=2.75)
bden = gaussian_filter(mask, sigma=2.75)
blur = np.full(mean.shape, np.nan)
okb = bden > 1e-9
blur[okb] = bnum[okb] / bden[okb]

anchors = json.load(open('/home/hatch/workspace/stargazer/tools/bortle-grid/anchors.json'))
hits = total = 0
misses = []
for a in anchors:
    if a.get('known_bortle') is None: continue
    x = math.radians(a['lon']) * R_MERC
    s = math.sin(math.radians(a['lat']))
    y = R_MERC * math.log((1 + s) / (1 - s)) / 2
    c = int((x - PX0) / COARSE_M)
    r = int((PY0 - y) / COARSE_M)
    if not (0 <= r < PROWS and 0 <= c < PCOLS): continue
    local = max(mean[r, c], 0) if np.isfinite(mean[r, c]) else 0
    b = blur[r, c] if np.isfinite(blur[r, c]) else 0
    art = 0.1179 * local + 0.0642 * max(b, 0)
    pred = sqm_to_bortle(art_to_sqm(art))
    total += 1
    if abs(pred - a['known_bortle']) <= 1:
        hits += 1
    else:
        misses.append((a['id'], a['known_bortle'], pred))

print(f"OLD model on CONUS: {hits}/{total}", flush=True)
for m in misses:
    print(f"  MISS {m[0]}: known={m[1]} pred={m[2]}", flush=True)
