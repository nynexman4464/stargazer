#!/usr/bin/env python3
"""Validate 0.5-deg grids built with block percentiles instead of the mean.

A 0.5-deg cell over a city mixes the bright core with dark surroundings, so
the mean reads too dark (NYC -> Bortle 6). A high percentile answers "how
bright is the bright part of this cell" instead. Compare p50/p75/p90 against
anchors to see if any percentile keeps cities honest without breaking dark
sites. Reads the 3GB TIFF in strips to stay in RAM.
"""
import json
import numpy as np
import rasterio
from rasterio.windows import Window

NATURAL_MCD = 0.174
BORTLE_BREAKS = [
    (21.76, 1), (21.60, 2), (21.30, 3), (20.80, 4),
    (19.25, 5), (18.50, 6), (18.00, 7), (17.50, 8),
]


def sqm_to_bortle(sqm):
    for edge, cls in BORTLE_BREAKS:
        if sqm >= edge:
            return cls
    return 9


def main():
    src = rasterio.open("World_Atlas_2015.tif")
    west, south, east, north = src.bounds
    step = 0.5
    cols = int(round((east - west) / step))
    rows = int(round((north - south) / step))
    lonMin, latMax = west, north
    # grid cells don't align to integer native pixels (145.05 deg tall), so
    # map each cell to native rows/cols with rounded boundaries (60-61 px)
    te, re_ = src.transform.e, abs(src.transform.e)
    tf, ta, tc = src.transform.f, src.transform.a, src.transform.c

    def row_range(gr):
        y0 = int(round((latMax - gr * step - tf) / te))
        y1 = int(round((latMax - (gr + 1) * step - tf) / te))
        return y0, y1

    def col_range(gc):
        x0 = int(round((lonMin + gc * step - tc) / ta))
        x1 = int(round((lonMin + (gc + 1) * step - tc) / ta))
        return x0, x1

    pcts = [50, 75, 90]
    grids = {p: np.full((rows, cols), np.nan) for p in pcts}
    chunk_gr = 10  # grid rows per read; ~100MB float32 per chunk
    for gr0 in range(0, rows, chunk_gr):
        gr1 = min(rows, gr0 + chunk_gr)
        ya, _ = row_range(gr0)
        _, yb = row_range(gr1 - 1)
        yb = min(yb, src.height)
        blk = src.read(1, window=Window(0, ya, src.width, yb - ya)).astype(np.float32)
        blk[(blk == src.nodata) | (blk < 0)] = np.nan
        for gr in range(gr0, gr1):
            r0, r1 = row_range(gr)
            for gc in range(cols):
                c0, c1 = col_range(gc)
                sub = blk[r0 - ya:r1 - ya, c0:c1]
                with np.errstate(all="ignore"):
                    for p in pcts:
                        grids[p][gr, gc] = np.nanpercentile(sub, p)
        print(f"rows {gr0}/{rows}", flush=True)

    anchors = json.load(open("anchors.json"))
    print(f"\n{'id':28s} {'known':>5s} " + " ".join(f"p{p:>6d}" for p in pcts))
    for a in anchors:
        c = int((a["lon"] - west) / step)
        r = int((north - a["lat"]) / step)
        cells = []
        for p in pcts:
            v = grids[p][r, c]
            if np.isfinite(v):
                sqm = max(16.0, min(22.0, 22.0 - 2.5 * np.log10(1.0 + v / NATURAL_MCD)))
                cells.append(f"{sqm_to_bortle(sqm):>7d}")
            else:
                cells.append(f"{'-':>7s}")
        k = a["known_bortle"]
        print(f"{a['id']:28s} {str(k) if k is not None else '-':>5s} " + " ".join(cells))

    for p in pcts:
        h = n = 0
        for a in anchors:
            k = a["known_bortle"]
            if k is None:
                continue
            c = int((a["lon"] - west) / step)
            r = int((north - a["lat"]) / step)
            v = grids[p][r, c]
            if not np.isfinite(v):
                continue
            sqm = max(16.0, min(22.0, 22.0 - 2.5 * np.log10(1.0 + v / NATURAL_MCD)))
            n += 1
            if abs(sqm_to_bortle(sqm) - k) <= 1:
                h += 1
        print(f"p{p}: {h}/{n} within +/-1")


if __name__ == "__main__":
    main()
