"""Emit Web Mercator Bortle grids as JS modules (replacing bortleGrid.js / bortleFine.js)."""
import base64
import sys
import os
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from merc_grid import XMIN, YMAX, COLS, ROWS, COARSE_M, FINE_M, PER

def to_b64(arr):
    return base64.b64encode(arr.tobytes()).decode('ascii')

def main():
    # Coarse
    print("Loading coarse...", flush=True)
    qb = np.load('/tmp/merc_coarse_q.npy')
    assert qb.shape == (ROWS, COLS), f"Shape {qb.shape} != {(ROWS, COLS)}"
    coarse_b64 = to_b64(qb)
    print(f"Coarse base64: {len(coarse_b64)/1024:.0f} KB", flush=True)

    # Fine
    print("Loading fine...", flush=True)
    keys = np.load('/tmp/merc_fine_keys.npy')
    data = np.load('/tmp/merc_fine_data.npy')
    count = len(keys)
    print(f"Fine patches: {count}", flush=True)
    # Keys as uint32 LE bytes, data as uint8
    keys_b64 = to_b64(keys.astype('<u4'))
    data_b64 = to_b64(data)
    print(f"Fine index base64: {len(keys_b64)/1024:.0f} KB", flush=True)
    print(f"Fine data base64: {len(data_b64)/1024:.0f} KB", flush=True)

    source = ('Estimated from 2025 satellite data (NASA Black Marble VJ146A4, '
              'calibrated against the World Atlas of Artificial Night Sky Brightness, '
              'Falchi et al. 2016). Grid in Web Mercator meters (25km coarse, 5km fine).')

    # Emit bortleGrid.js
    grid_js = f"""// Web Mercator Bortle grid (25km cells). Generated from 2025 Black Marble.
// See tools/bortle-grid/mercator-2025/.
export const BORTLE_GRID = {{
  cols: {COLS},
  rows: {ROWS},
  xMin: {XMIN},
  yMax: {YMAX},
  cellM: {COARSE_M},
  source: '{source}',
  data: '{coarse_b64}',
}};
"""
    out_grid = '/home/hatch/workspace/stargazer/src/data/bortleGrid.js'
    with open(out_grid, 'w') as f:
        f.write(grid_js)
    print(f"Wrote {out_grid} ({os.path.getsize(out_grid)/1024/1024:.2f} MB)", flush=True)

    # Emit bortleFine.js
    fine_js = f"""// Web Mercator fine Bortle patches (5km cells, 5x5 per coarse). Generated from 2025 Black Marble.
// See tools/bortle-grid/mercator-2025/.
export const BORTLE_FINE = {{
  cellM: {FINE_M},
  per: {PER},
  count: {count},
  index: '{keys_b64}',
  data: '{data_b64}',
}};
"""
    out_fine = '/home/hatch/workspace/stargazer/src/data/bortleFine.js'
    with open(out_fine, 'w') as f:
        f.write(fine_js)
    print(f"Wrote {out_fine} ({os.path.getsize(out_fine)/1024/1024:.2f} MB)", flush=True)

if __name__ == '__main__':
    main()
