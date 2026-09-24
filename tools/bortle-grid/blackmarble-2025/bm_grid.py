"""Shared pipeline: Black Marble annual tiles -> 0.25-deg estimated-Bortle grid.

Matches the grid geometry of tools/bortle-grid/make_grid.py (the shipped
Falchi-2016 grid) so outputs are drop-in comparable:
  cols=1440, rows=580, lonMin=-180, latMax=85.0541668645001, step=0.25
  SQM = 22 - 2.5*log10(1 + artificial/0.174), clipped [16,22]
  quantize to 0.05-mag bytes, 255 = unknown
  SQM -> Bortle breakpoints identical to make_grid.py

Tile -> cell mapping uses the sinusoidal inversion verified against the
tiles' own structure (the 1D lon array in the files is the *equatorial*
reference longitude per column, NOT true pixel longitude; true pixel
longitude is X/(R*cos(lat))).

Radiance handling: AllAngle_Composite_Snow_Free (nW/cm^2/sr), fill -999.9
masked. Slightly negative values are kept (noise around zero; unbiased mean),
matching "no light -> SQM 22.0" after the clip. Per-cell means are plain
arithmetic means: sinusoidal pixels are equal-area.
"""
import base64
import json
import math
import os
import re

import h5py
import numpy as np
from scipy.ndimage import gaussian_filter

# --- sinusoidal tile geometry ------------------------------------------------
R_EARTH = 6371007.181
PIX_M = 463.31271653
X0 = -20015086.796
Y0 = 10007543.398
TILE_PX = 2400
FILL = -999.9
LAYER = "AllAngle_Composite_Snow_Free"

# --- output grid geometry (identical to shipped bortleGrid.js) ----------------
COLS, ROWS = 1440, 580
LONMIN = -180.00000000000003
LATMAX = 85.0541668645001
STEP = 0.25

# --- SQM conversion (identical to make_grid.py) -------------------------------
NATURAL_MCD = 0.174
UNKNOWN = 255
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


HV_RE = re.compile(r"\.h(\d{2})v(\d{2})\.")


def tile_hv(path):
    m = HV_RE.search(os.path.basename(path))
    return int(m.group(1)), int(m.group(2))


def accumulate_tile(path, sum_grid, cnt_grid, layer=LAYER):
    """Add one tile's valid radiance pixels into sum/cnt grids (float64).

    Tiles are regular 10x10-degree equirectangular grids (15 arcsec pixels);
    per-pixel lat/lon come straight from the file's 1D lat/lon arrays
    (verified: the arrays geolocate cities exactly; the sinusoidal formula
    does NOT apply to this product).
    """
    with h5py.File(path, "r") as f:
        df = f["HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data Fields"]
        rad = df[layer][:]
        lat = df["lat"][:]
        lon = df["lon"][:]
    valid = (rad != FILL) & np.isfinite(rad)

    gr1d = np.floor((LATMAX - lat) / STEP).astype(np.int64)
    gc1d = np.floor((lon - LONMIN) / STEP).astype(np.int64) % COLS
    ok = valid & (gr1d[:, None] >= 0) & (gr1d[:, None] < ROWS)
    rr, cc = np.nonzero(ok)
    idx = gr1d[rr] * COLS + gc1d[cc]
    np.add.at(sum_grid.ravel(), idx, rad[ok].astype(np.float64).ravel())
    np.add.at(cnt_grid.ravel(), idx, 1)
    return int(ok.sum())


def mean_radiance(sum_grid, cnt_grid):
    mean = np.full(sum_grid.shape, np.nan)
    ok = cnt_grid > 0
    mean[ok] = sum_grid[ok] / cnt_grid[ok]
    return mean


def smooth_normalized(mean_rad, sigma_deg):
    """Gaussian smooth in linear radiance space, normalized for NaN cells.

    sigma_deg is in degrees; converted to pixels (0.25 deg/cell). NaN cells
    (no observations) are treated as zero-weight so coastlines/ocean gaps
    don't dilute lit cells; output stays NaN where there was no data.
    """
    sigma_px = sigma_deg / STEP
    filled = np.nan_to_num(mean_rad, nan=0.0)
    w = np.isfinite(mean_rad).astype(np.float64)
    sm = gaussian_filter(filled, sigma_px, mode="reflect")
    sw = gaussian_filter(w, sigma_px, mode="reflect")
    out = np.full(mean_rad.shape, np.nan)
    ok = sw > 1e-9
    out[ok] = sm[ok] / sw[ok]
    return out


def grid_to_quantized_sqm(mean_rad, k, sigma_deg):
    """mean_rad (nW/cm^2/sr) -> smoothed -> artificial mcd/m^2 -> SQM bytes."""
    sm = smooth_normalized(mean_rad, sigma_deg) if sigma_deg > 0 else mean_rad
    art = np.full(sm.shape, np.nan)
    ok = np.isfinite(sm)
    art[ok] = k * np.maximum(sm[ok], 0.0)
    return quantize(artificial_to_sqm(art)), sm


def sample_grid(q, lon, lat):
    """Sample quantized grid at lon/lat; returns SQM float or None."""
    c = int(math.floor((lon - LONMIN) / STEP))
    r = int(math.floor((LATMAX - lat) / STEP))
    if not (0 <= c < COLS and 0 <= r < ROWS):
        return None
    v = q[r, c]
    return None if v == UNKNOWN else 16.0 + float(v) * 0.05


def validate_anchors(q, anchors_path="/home/hatch/workspace/stargazer/tools/bortle-grid/anchors.json"):
    """Returns (hits, total, rows) with per-anchor predicted vs known Bortle."""
    anchors = json.load(open(anchors_path))
    hits = total = 0
    rows = []
    for a in anchors:
        known = a.get("known_bortle")
        s = sample_grid(q, a["lon"], a["lat"])
        pred = sqm_to_bortle(s) if s is not None else None
        if known is not None and pred is not None:
            total += 1
            ok = abs(pred - known) <= 1
            hits += ok
        else:
            ok = None
        rows.append((a["id"], known, pred, ok,
                     round(s, 2) if s is not None else None))
    return hits, total, rows


def load_falchi_grid(js_path="/home/hatch/workspace/stargazer/src/data/bortleGrid.js"):
    """Dequantize the shipped Falchi grid -> (sqm float grid, artificial mcd/m^2)."""
    import re as _re
    js = open(js_path).read()
    b64 = _re.search(r"data: '([A-Za-z0-9+/=]+)'", js).group(1)
    q = np.frombuffer(base64.b64decode(b64), dtype=np.uint8).reshape(ROWS, COLS)
    sqm = dequantize(q)
    art = np.full(sqm.shape, np.nan)
    ok = np.isfinite(sqm)
    art[ok] = NATURAL_MCD * (10.0 ** ((22.0 - sqm[ok]) / 2.5) - 1.0)
    return sqm, art
