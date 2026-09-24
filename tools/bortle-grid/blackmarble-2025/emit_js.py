#!/usr/bin/env python3
"""Emit the 2025 Black Marble grid as a bortleGrid.js-compatible module.

Reads full2025_q.npy (uint8, 580x1440, 255=unknown) and writes
bortleGrid-2025.js in THIS directory with identical geometry constants and
format to src/data/bortleGrid.js. Does NOT touch the shipped file; Alex
decides whether to swap after seeing the validation numbers.
"""
import base64
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bm_grid import COLS, ROWS, LONMIN, LATMAX, STEP

OUT = os.path.dirname(os.path.abspath(__file__))


def main():
    q = np.load(os.path.join(OUT, "full2025_q.npy"))
    assert q.shape == (ROWS, COLS) and q.dtype == np.uint8
    known = np.count_nonzero(q != 255)
    b64 = base64.b64encode(q.tobytes()).decode("ascii")
    js = f"""/* Estimated sky-brightness grid for Stargazer. GENERATED — do not edit.
 * Regenerate with tools/bortle-grid/blackmarble-2025/run_full.py.
 *
 * Source: NASA Black Marble annual nighttime lights, VJ146A4 (NOAA-20 VIIRS),
 * year 2025. Layer: AllAngle_Composite_Snow_Free radiance (nW/cm^2/sr).
 * Method: per-tile radiances averaged in LINEAR space to a {STEP}-degree
 * grid; artificial zenith brightness = k1*local + k2*gaussian(sigma=0.5 deg)
 * with k1=0.1179, k2=0.0642 fitted by OLS against the Falchi et al. 2016
 * World Atlas grid (VIIRS 2015) on ~7k well-lit cells (R^2=0.95);
 * natural zenith 0.174 mcd/m^2 added; SQM = 22.0 - 2.5*log10(1 + art/0.174),
 * clamped [16,22], quantized to 0.05 mag steps. 255 = unknown (no data).
 * The app maps SQM to Bortle classes; known site ratings always take
 * precedence over this grid.
 */
export const BORTLE_GRID = {{
  cols: {COLS},
  rows: {ROWS},
  lonMin: {LONMIN},
  latMax: {LATMAX},
  step: {STEP},
  source: 'Estimated from 2025 satellite data (NASA Black Marble VJ146A4, calibrated against the World Atlas of Artificial Night Sky Brightness, Falchi et al. 2016).',
  data: '{b64}',
}};
"""
    out = os.path.join(OUT, "bortleGrid-2025.js")
    open(out, "w").write(js)
    print(f"wrote {out} ({len(js)/1024:.0f} KB), {known:,}/{q.size:,} cells known")


if __name__ == "__main__":
    main()
