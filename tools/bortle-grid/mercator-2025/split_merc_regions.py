"""Split the Web-Mercator Bortle grid into regional files for lazy loading.

Regions: 8 longitude bands x 4 latitude bands = 32 regions.
- Lon bands: 45° each: [-180,-135], [-135,-90], [-90,-45], [-45,0], [0,45], [45,90], [90,135], [135,180]
- Lat bands (degrees): [40, 85], [10, 40], [-20, 10], [-60, -20]

Each region gets:
- A coarse grid subset (20km cells)
- The fine patches whose coarse cell falls in the region

Output: src/data/bortle/{region_id}/coarse.js and fine.js
Region IDs: r{latIdx}{lonIdx}, e.g., r00 = north-west
"""
import numpy as np
import base64
import os
import math

# Load the full grids
q = np.load('/tmp/merc_coarse_q.npy')  # (rows, cols) uint8
print(f"Coarse: {q.shape}")

fk = np.load('/tmp/merc_fine_keys.npy')  # uint32
fd = np.load('/tmp/merc_fine_data.npy')  # (n, 25) uint8
print(f"Fine: {len(fk)} patches")

# Grid metadata (from merc_grid.py)
import sys
sys.path.insert(0, os.path.dirname(__file__))
from merc_grid import XMIN, YMAX, COARSE_M, FINE_M, ROWS, COLS, PER

# Define regions in lon/lat, convert to meters
# Lon bands: [-180,-90], [-90,0], [0,90], [90,180]
# Lat bands (approx, in degrees): [20, 85], [-20, 20], [-60, -20]
# Convert lat to Web Mercator Y
def lat_to_y(lat):
    R = 6378137.0
    s = math.sin(math.radians(lat))
    s = max(-0.9999999, min(0.9999999, s))
    return R * math.log((1+s)/(1-s)) / 2

def lon_to_x(lon):
    R = 6378137.0
    return math.radians(lon) * R

LON_BANDS = [(-180,-135), (-135,-90), (-90,-45), (-45,0), (0,45), (45,90), (90,135), (135,180)]
LAT_BANDS = [(40, 85), (10, 40), (-20, 10), (-60, -20)]  # (south, north)

regions = []
for li, (lat_s, lat_n) in enumerate(LAT_BANDS):
    y_s = lat_to_y(lat_s)
    y_n = lat_to_y(lat_n)
    for oi, (lon_w, lon_e) in enumerate(LON_BANDS):
        x_w = lon_to_x(lon_w)
        x_e = lon_to_x(lon_e)
        # Convert to grid cell ranges
        # Col: (x - XMIN) / COARSE_M
        # Row: (YMAX - y) / COARSE_M
        c0 = max(0, int((x_w - XMIN) / COARSE_M))
        c1 = min(COLS, int((x_e - XMIN) / COARSE_M) + 1)
        r0 = max(0, int((YMAX - y_n) / COARSE_M))
        r1 = min(ROWS, int((YMAX - y_s) / COARSE_M) + 1)
        rid = f"r{li}{oi}"
        regions.append({
            'id': rid,
            'lon': (lon_w, lon_e),
            'lat': (lat_s, lat_n),
            'r0': r0, 'r1': r1, 'c0': c0, 'c1': c1,
        })
        print(f"{rid}: lon {lon_w} to {lon_e}, lat {lat_s} to {lat_n} -> "
              f"rows {r0}-{r1}, cols {c0}-{c1}")

# Output directory
OUT = '/home/hatch/workspace/stargazer/src/data/bortle'
os.makedirs(OUT, exist_ok=True)

# Build a map from coarse key to region
# For fine patches: key = r*COLS + c, find which region contains (r,c)
def find_region(r, c):
    for reg in regions:
        if reg['r0'] <= r < reg['r1'] and reg['c0'] <= c < reg['c1']:
            return reg['id']
    return None

# Split coarse
for reg in regions:
    rid = reg['id']
    r0, r1, c0, c1 = reg['r0'], reg['r1'], reg['c0'], reg['c1']
    sub = q[r0:r1, c0:c1]
    # Encode as base64
    b64 = base64.b64encode(sub.tobytes()).decode('ascii')
    # Metadata: region bounds in meters, grid offset
    xMin = XMIN + c0 * COARSE_M
    yMax = YMAX - r0 * COARSE_M
    js = f"""// Bortle coarse grid region {rid}: lon {reg['lon'][0]} to {reg['lon'][1]}, lat {reg['lat'][0]} to {reg['lat'][1]}
// Generated from Black Marble 2025. Lazy-loaded by src/lib/bortleRegions.js
export const BORTLE_COARSE_{rid.upper()} = {{
  id: '{rid}',
  rows: {sub.shape[0]},
  cols: {sub.shape[1]},
  cellM: {COARSE_M},
  xMin: {xMin},
  yMax: {yMax},
  // Global offset (for fine patch key calculation)
  r0: {r0},
  c0: {c0},
  globalRows: {ROWS},
  globalCols: {COLS},
  data: '{b64}',
}};
"""
    rdir = os.path.join(OUT, rid)
    os.makedirs(rdir, exist_ok=True)
    with open(os.path.join(rdir, 'coarse.js'), 'w') as f:
        f.write(js)
    print(f"Wrote {rid}/coarse.js ({len(b64)//1024} KB)")

# Split fine patches by region
from collections import defaultdict
fine_by_region = defaultdict(list)
for i, key in enumerate(fk):
    r = int(key // COLS)
    c = int(key % COLS)
    rid = find_region(r, c)
    if rid:
        # Store local key (relative to region) and data
        # Local key: (r - r0) * region_cols + (c - c0)
        # But for simplicity, keep global key and let JS map it
        fine_by_region[rid].append((int(key), fd[i]))

for reg in regions:
    rid = reg['id']
    patches = fine_by_region.get(rid, [])
    rdir = os.path.join(OUT, rid)
    if not patches:
        # Empty region
        js = f"""// Bortle fine patches region {rid}: no patches
export const BORTLE_FINE_{rid.upper()} = {{
  id: '{rid}',
  count: 0,
  per: {PER},
  cellM: {FINE_M},
  index: '',
  data: '',
}};
"""
    else:
        keys = np.array([p[0] for p in patches], dtype='<u4')
        data = np.stack([p[1] for p in patches])  # (n, 25)
        idx_b64 = base64.b64encode(keys.tobytes()).decode('ascii')
        dat_b64 = base64.b64encode(data.tobytes()).decode('ascii')
        js = f"""// Bortle fine patches region {rid}: {len(patches)} patches
// Generated from Black Marble 2025. Lazy-loaded by src/lib/bortleRegions.js
export const BORTLE_FINE_{rid.upper()} = {{
  id: '{rid}',
  count: {len(patches)},
  per: {PER},
  cellM: {FINE_M},
  index: '{idx_b64}',
  data: '{dat_b64}',
}};
"""
    with open(os.path.join(rdir, 'fine.js'), 'w') as f:
        f.write(js)
    print(f"Wrote {rid}/fine.js ({len(patches)} patches)")

print("\nDone!")
