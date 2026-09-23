#!/usr/bin/env python3
"""Build Stargazer's estimated-Bortle grid from the World Atlas 2016 GeoTIFF.

Source: Falchi et al. 2016, "The new world atlas of artificial night sky
brightness" (doi:10.5880/GFZ.1.4.2016.001), CC BY-NC 4.0. File:
World_Atlas_2015.tif — 30 arcsec, artificial zenith brightness in mcd/m^2
(natural sky NOT included; nodata ~= -3.4e38).

Pipeline (same physics both validating projects used):
  1. Downsample by MEAN in linear brightness (mcd/m^2), not in magnitudes.
  2. Add natural zenith 0.174 mcd/m^2 and convert:
       SQM = 22.0 - 2.5*log10(1 + artificial/0.174), clamped to [16, 22]
     so "no light" -> exactly 22.0 mag/arcsec^2.
  3. Quantize SQM to 0.05 mag steps in one byte (255 = unknown).
  4. The app maps SQM -> Bortle with the conventional breakpoints; the
     byte grid stays dumb so breakpoints can change without regenerating.

Outputs:
  - validation table: full-res vs 0.5-deg vs 0.25-deg estimates at every
    known anchor (59 dark-sky sites + Medford + spot checks)
  - src/data/bortleGrid.js : base64 byte grid + provenance header
"""
import base64
import json
import math
import sys

import numpy as np
import rasterio
from rasterio.enums import Resampling

NATURAL_MCD = 0.174  # paper's own scale: 0.174 mcd/m^2 == 22.00 mag/arcsec^2
UNKNOWN = 255

# Conventional SQM -> Bortle breakpoints (Wikipedia Bortle scale table;
# 8/9 split at 17.5 is the common converter approximation).
BORTLE_BREAKS = [
    (21.76, 1), (21.60, 2), (21.30, 3), (20.80, 4),
    (19.25, 5), (18.50, 6), (18.00, 7), (17.50, 8),
]


def sqm_to_bortle(sqm):
    for edge, cls in BORTLE_BREAKS:
        if sqm >= edge:
            return cls
    return 9


def artificial_to_sqm(art):
    """art: artificial mcd/m^2 (linear). Returns SQM mag/arcsec^2 or nan."""
    with np.errstate(divide="ignore", invalid="ignore"):
        sqm = 22.0 - 2.5 * np.log10(1.0 + art / NATURAL_MCD)
    return np.clip(sqm, 16.0, 22.0)


def quantize(sqm):
    q = np.full(sqm.shape, UNKNOWN, dtype=np.uint8)
    ok = np.isfinite(sqm)
    q[ok] = np.round((sqm[ok] - 16.0) / 0.05).astype(np.uint8)
    return q


def dequantize(q):
    sqm = np.full(q.shape, np.nan)
    ok = q != UNKNOWN
    sqm[ok] = 16.0 + q[ok].astype(float) * 0.05
    return sqm


def main():
    tif_path = sys.argv[1] if len(sys.argv) > 1 else "World_Atlas_2015.tif"
    src = rasterio.open(tif_path)
    print(f"raster: {src.width}x{src.height}, bounds={src.bounds}, nodata={src.nodata}")

    anchors = json.load(open("anchors.json"))

    # --- full-resolution spot check at every anchor -----------------------
    print("\nfull-res sample at anchors:")
    full = {}
    for a in anchors:
        try:
            v = list(src.sample([(a["lon"], a["lat"])]))[0][0]
        except Exception as e:  # outside coverage
            v = float("nan")
        if not np.isfinite(v) or v < 0 or (src.nodata is not None and v == src.nodata):
            full[a["id"]] = None
        else:
            full[a["id"]] = float(artificial_to_sqm(np.array([v]))[0])

    # --- downsampled grids -------------------------------------------------
    west, south, east, north = src.bounds
    results = {}
    for step, tag in [(0.5, "0.5deg"), (0.25, "0.25deg")]:
        cols = int(round((east - west) / step))
        rows = int(round((north - south) / step))
        arr = src.read(
            1, out_shape=(rows, cols), resampling=Resampling.average, masked=True
        )
        data = arr.filled(np.nan).astype(np.float64)
        if src.nodata is not None:
            # belt-and-braces: exact nodata equality or negatives -> unknown
            data[data == src.nodata] = np.nan
        data[data < 0] = np.nan
        sqm = artificial_to_sqm(data)
        q = quantize(sqm)
        results[tag] = (q, cols, rows, west, north, step)
        known = np.count_nonzero(q != UNKNOWN)
        print(f"{tag}: {cols}x{rows} = {q.size} cells, {known} known "
              f"({q.nbytes/1024:.0f} KB, ~{len(base64.b64encode(q.tobytes()))/1024:.0f} KB base64)")

    # --- validation ---------------------------------------------------------
    print("\nvalidation (known -> full-res -> 0.5deg -> 0.25deg):")
    print(f"{'id':28s} {'known':>5s} {'full':>5s} {'0.5':>5s} {'0.25':>5s}")
    hits = {"full": [0, 0], "0.5deg": [0, 0], "0.25deg": [0, 0]}
    for a in anchors:
        known = a.get("known_bortle")
        row = [f"{a['id']:28s}"]
        vals = {}
        f = full[a["id"]]
        vals["full"] = sqm_to_bortle(f) if f is not None else None
        for tag in ["0.5deg", "0.25deg"]:
            q, cols, rows, west, north, step = results[tag]
            c = int((a["lon"] - west) / step)
            r = int((north - a["lat"]) / step)
            if 0 <= c < cols and 0 <= r < rows and q[r, c] != UNKNOWN:
                s = 16.0 + float(q[r, c]) * 0.05
                vals[tag] = sqm_to_bortle(s)
            else:
                vals[tag] = None
        for tag in ["full", "0.5deg", "0.25deg"]:
            v = vals[tag]
            row.append(f"{v if v is not None else '-':>5}")
            if known is not None and v is not None:
                hits[tag][1] += 1
                if abs(v - known) <= 1:
                    hits[tag][0] += 1
        kstr = f"{known}" if known is not None else "-"
        print(f"{row[0]} {kstr:>5s} {row[1]} {row[2]} {row[3]}")
    for tag, (h, n) in hits.items():
        print(f"{tag}: {h}/{n} anchors within +/-1 class of known value")

    # --- emit the JS module -------------------------------------------------
    # 0.25deg is the pick: same overall hit rate as 0.5deg (54/62 vs 52/62
    # within +/-1), but far better on populated places (NYC 8 vs 6, San Jose
    # 6 vs 5, Medford 6 vs 5) — 0.5deg cells wash cities out with their dark
    # surroundings. Percentile variants of 0.5deg didn't beat it. Costs 1.1MB
    # raw (~0.4MB gzipped) vs 273KB; accepted for the accuracy.
    tag = "0.25deg"
    q, cols, rows, west, north, step = results[tag]
    b64 = base64.b64encode(q.tobytes()).decode("ascii")
    js = f"""/* Estimated sky-brightness grid for Stargazer. GENERATED — do not edit.
 * Regenerate with tools/bortle-grid/make_grid.py (see tools/bortle-grid/README.md).
 *
 * Source: Falchi et al. 2016, "The new world atlas of artificial night sky
 * brightness", Science Advances 2:e1600377 — Supplement via GFZ Data Services,
 * doi:10.5880/GFZ.1.4.2016.001, CC BY-NC 4.0. Data vintage: VIIRS 2015.
 * Method: 30-arcsec artificial zenith brightness (mcd/m^2) downsampled by mean
 * in LINEAR brightness to a {step}-degree grid; natural zenith 0.174 mcd/m^2
 * added; SQM = 22.0 - 2.5*log10(1 + artificial/0.174), clamped [16,22],
 * quantized to 0.05 mag steps. 255 = unknown (ocean gaps / outside coverage).
 * The app maps SQM to Bortle classes; known site ratings always take
 * precedence over this grid.
 */
export const BORTLE_GRID = {{
  cols: {cols},
  rows: {rows},
  lonMin: {west},
  latMax: {north},
  step: {step},
  source: 'Estimated from 2016 satellite data (World Atlas of Artificial Night Sky Brightness, Falchi et al. 2016).',
  data: '{b64}',
}};
"""
    out = "../src/data/bortleGrid.js"
    open(out, "w").write(js)
    print(f"\nwrote {out} ({len(js)/1024:.0f} KB) using {tag} grid")


if __name__ == "__main__":
    main()
