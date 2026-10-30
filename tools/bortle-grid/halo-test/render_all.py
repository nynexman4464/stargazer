#!/usr/bin/env python3
"""
Unified renderer for the Stargazer halo-test comparison page
(public/halo-test/index.html).

Rebuilds all 6 PNGs (2 locations x 3 resolutions) with IDENTICAL code so every
panel uses the same colormap, transparency, model, and data handling:

- "current (4km)": replicates src/lib/bortleOverlay.js sampleBortleByte against
  the shipped region data (src/data/bortle/r*/), then the unified colormap.
- "mid-res (1km)" / "full-res (500m)": VIIRS VJ146A4 2025 AllAngle Snow-Free at
  native 15 arc-sec with the K1/K2/Walker skyglow model. 1km = 2x2 mean of the
  native radiance grid before the model is applied.
- Colormap: discrete Bortle ramp (same as the page legend). Bortle 1 is fully
  transparent, classes 2-9 are opaque. All output as RGBA PNG.

Model (identical for 1km/500m):
    art = 0.11 * local + 0.05 * sqrt(Walker)
    Walker = sum of 4km-cell radiance * d^-3, d in physical km, d <= 125 km
             (computed on a 4km Web-Mercator grid, bilinearly interpolated)
    SQM = 22 - 2.5 * log10(1 + art / 0.174)

Usage:
    python3 render_all.py

Outputs (relative to repo root):
    public/halo-test/potsdam_current.png
    public/halo-test/potsdam_1km.png
    public/halo-test/potsdam_fullres.png
    public/halo-test/bakken_current.png
    public/halo-test/bakken_1km.png
    public/halo-test/bakken_fullres.png
"""

import base64
import glob
import math
import os
import re
import sys

import h5py
import numpy as np
from PIL import Image
from scipy.ndimage import convolve, map_coordinates

# ---------------------------------------------------------------------------
# Paths & constants
# ---------------------------------------------------------------------------

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
OUT_DIR = os.path.join(REPO_ROOT, "public", "halo-test")
DATA_DIR = os.path.join(REPO_ROOT, "src", "data", "bortle")
TILE_DIR = "/home/hatch/workspace/data/blackmarble/tiles_2025"
VIIRS_LAYER = "AllAngle_Composite_Snow_Free"

R_MERC = 6378137.0

# Skyglow model
K1 = 0.11
K2 = 0.05
NATURAL = 0.174          # mcd/m^2
WALKER_MAX_KM = 125.0
WALKER_POWER = 3.0
WALKER_CELL_M = 4000.0

# SQM -> Bortle breaks (src/lib/astro.js, shipped)
BORTLE_BREAKS = [(21.90, 1), (21.70, 2), (21.40, 3), (20.90, 4),
                 (19.45, 5), (18.70, 6), (18.20, 7), (17.70, 8)]

# Discrete Bortle ramp (public/halo-test/index.html legend)
RAMP = {
    1: (48, 70, 170), 2: (48, 70, 170), 3: (36, 130, 205),
    4: (36, 175, 170), 5: (105, 195, 95), 6: (225, 210, 75),
    7: (242, 150, 45), 8: (236, 85, 50), 9: (255, 238, 238),
}

# Wide bounds: [[south, west], [north, east]]
POTSDAM_BOUNDS = [[43.85, -75.95], [45.55, -73.95]]
BAKKEN_BOUNDS = [[47.05, -104.5], [49.05, -101.8]]

# Output pixel sizes (Web-Mercator meters)
PX_500M = 500.0
PX_1KM = 1000.0
PX_CURRENT = 150.0   # oversampled for smooth display of the 4km shipped data

# Probes: (name, lat, lon)
POTSDAM_PROBES = [
    ("Potsdam center", 44.6699, -74.9813),
    ("10km north of Potsdam", 44.76, -74.9813),
    ("Parishville", 44.628, -74.814),
]
BAKKEN_PROBES = [
    ("Bakken flare A", 48.042, -103.463),
    ("Bakken flare B", 48.229, -103.375),
    ("Bakken dark spot", 47.85, -102.85),
]


# ---------------------------------------------------------------------------
# Web-Mercator helpers
# ---------------------------------------------------------------------------

def lat_to_y(lat):
    s = math.sin(math.radians(lat))
    s = max(-0.9999999, min(0.9999999, s))
    return R_MERC * math.log((1 + s) / (1 - s)) / 2


def y_to_lat(y):
    return math.degrees(2 * math.atan(math.exp(y / R_MERC)) - math.pi / 2)


def lon_to_x(lon):
    return math.radians(lon) * R_MERC


def x_to_lon(x):
    return math.degrees(x / R_MERC)


def bounds_to_merc(bounds):
    (south, west), (north, east) = bounds
    return lon_to_x(west), lat_to_y(south), lon_to_x(east), lat_to_y(north)


# ---------------------------------------------------------------------------
# Bortle class / color
# ---------------------------------------------------------------------------

def sqm_to_bortle(sqm):
    for edge, cls in BORTLE_BREAKS:
        if sqm >= edge:
            return cls
    return 9


def class_to_rgba(cls):
    r, g, b = RAMP[cls]
    a = 0 if cls == 1 else 255
    return (r, g, b, a)


def sqm_grid_to_rgba(sqm_grid):
    """Vectorized SQM -> RGBA. NaN SQM (no data) -> fully transparent."""
    out = np.zeros(sqm_grid.shape + (4,), dtype=np.uint8)
    valid = np.isfinite(sqm_grid)
    sqm = np.clip(sqm_grid[valid], 16.0, 22.0)
    # BORTLE_BREAKS edges are descending; find the first edge <= sqm.
    edges = np.array([e for e, _ in BORTLE_BREAKS])  # descending
    idx = np.searchsorted(-edges, -sqm)  # ascending search on negated edges
    classes = np.where(idx < len(edges), idx + 1, 9).astype(np.int32)
    ramp_arr = np.array([RAMP[c] for c in range(1, 10)], dtype=np.uint8)
    out[valid, 0:3] = ramp_arr[classes - 1]
    out[valid, 3] = np.where(classes == 1, 0, 255).astype(np.uint8)
    return out

# ---------------------------------------------------------------------------
# Shipped region data (Python port of src/lib/bortleRegions.js decoding)
# ---------------------------------------------------------------------------

LON_BANDS = [-180, -135, -90, -45, 0, 45, 90, 135, 180]
LAT_BANDS = [85, 40, 10, -20, -60]  # north to south


def region_id_for(lat, lon):
    ln = lon
    while ln < -180:
        ln += 360
    while ln > 180:
        ln -= 360
    if lat > 85 or lat < -60:
        return None
    lon_idx = None
    for i in range(8):
        if LON_BANDS[i] <= ln < LON_BANDS[i + 1]:
            lon_idx = i
            break
    if lon_idx is None:
        if ln == 180:
            lon_idx = 7
        else:
            return None
    lat_idx = None
    for i in range(4):
        if LAT_BANDS[i] >= lat > LAT_BANDS[i + 1]:
            lat_idx = i
            break
    if lat_idx is None:
        return None
    return f"r{lat_idx}{lon_idx}"


def _parse_js_object(path):
    """Extract key: value pairs (numbers and 'quoted' strings) from a JS module."""
    with open(path) as f:
        text = f.read()
    out = {}
    for m in re.finditer(r"(\w+):\s*('(?:[^'\\]|\\.)*'|[\d.\-]+)", text):
        key, val = m.group(1), m.group(2)
        if val.startswith("'"):
            out[key] = val[1:-1]
        else:
            out[key] = float(val) if "." in val else int(val)
    return out


def load_region(rid):
    """Decode one region's coarse grid and fine patches (mirrors JS decode)."""
    c = _parse_js_object(os.path.join(DATA_DIR, rid, "coarse.js"))
    coarse_bytes = np.frombuffer(base64.b64decode(c["data"]), dtype=np.uint8)
    coarse = {
        "rows": int(c["rows"]), "cols": int(c["cols"]),
        "cellM": float(c["cellM"]), "xMin": float(c["xMin"]),
        "yMax": float(c["yMax"]), "r0": int(c["r0"]), "c0": int(c["c0"]),
        "globalCols": int(c["globalCols"]), "bytes": coarse_bytes,
    }
    f = _parse_js_object(os.path.join(DATA_DIR, rid, "fine.js"))
    count = int(f["count"])
    per = int(f["per"])
    if count == 0:
        fine = {"count": 0, "per": per, "cellM": float(f["cellM"]),
                "map": {}, "bytes": np.zeros(0, dtype=np.uint8)}
    else:
        keys = np.frombuffer(base64.b64decode(f["index"]), dtype="<u4")
        data = np.frombuffer(base64.b64decode(f["data"]), dtype=np.uint8)
        fine = {"count": count, "per": per, "cellM": float(f["cellM"]),
                "map": {int(k): i for i, k in enumerate(keys)}, "bytes": data}
    return {"coarse": coarse, "fine": fine}


def load_regions_for_bounds(bounds, pad_deg=0.5):
    """Load all regions intersecting the (padded) lat/lon bounds."""
    (south, west), (north, east) = bounds
    rids = set()
    for lat in (south - pad_deg, (south + north) / 2, north + pad_deg):
        for lon in (west - pad_deg, (west + east) / 2, east + pad_deg):
            rid = region_id_for(lat, lon)
            if rid:
                rids.add(rid)
    regions = {}
    for rid in sorted(rids):
        regions[rid] = load_region(rid)
        print(f"  loaded region {rid}", flush=True)
    return regions


# ---------------------------------------------------------------------------
# sampleBortleByte port (src/lib/bortleOverlay.js)
# ---------------------------------------------------------------------------

def _sample_region_byte(region, lat, lon):
    """Port of sampleRegionByte in bortleRegions.js (coarse cross-region)."""
    coarse, fine = region["coarse"], region["fine"]
    x = lon_to_x(lon)
    y = lat_to_y(lat)
    globalC = math.floor((x - coarse["xMin"]) / coarse["cellM"]) + coarse["c0"]
    globalR = math.floor((coarse["yMax"] - y) / coarse["cellM"]) + coarse["r0"]
    localC = globalC - coarse["c0"]
    localR = globalR - coarse["r0"]
    if not (0 <= localC < coarse["cols"] and 0 <= localR < coarse["rows"]):
        return None
    per = fine["per"]
    fkey = globalR * coarse["globalCols"] + globalC
    pi = fine["map"].get(fkey)
    if pi is not None:
        cm, fm = coarse["cellM"], fine["cellM"]
        cellX = coarse["xMin"] + (globalC - coarse["c0"]) * cm
        cellYTop = coarse["yMax"] - (globalR - coarse["r0"]) * cm
        fr = math.floor((cellYTop - y) / fm)
        fc = math.floor((x - cellX) / fm)
        if 0 <= fr < per and 0 <= fc < per:
            q = fine["bytes"][pi * per * per + fr * per + fc]
            if q != 255:
                return float(q)
    q = coarse["bytes"][localR * coarse["cols"] + localC]
    return None if q == 255 else float(q)


def sample_bortle_byte(xM, yM, regions):
    """Port of sampleBortleByte in bortleOverlay.js. Returns float byte or None."""
    lat = y_to_lat(yM)
    lon = x_to_lon(xM)
    rid = region_id_for(lat, lon)
    if not rid or rid not in regions:
        return None
    region = regions[rid]
    coarse, fine = region["coarse"], region["fine"]
    cm, fm, per = coarse["cellM"], fine["cellM"], fine["per"]

    localFxf = (xM - coarse["xMin"]) / fm
    localFyf = (coarse["yMax"] - yM) / fm
    frg = localFyf - 0.5
    fcg = localFxf - 0.5
    fr0 = math.floor(frg)
    fc0 = math.floor(fcg)
    dr = frg - fr0
    dc = fcg - fc0

    def get_fine(fr, fc):
        lc = math.floor(fc / per)
        lr = math.floor(fr / per)
        globalC = lc + coarse["c0"]
        globalR = lr + coarse["r0"]
        fkey = globalR * coarse["globalCols"] + globalC
        target = None
        pi = None
        for reg in regions.values():
            idx = reg["fine"]["map"].get(fkey)
            if idx is not None:
                target, pi = reg, idx
                break
        if target is None:
            return None
        gfc = fc + coarse["c0"] * per
        gfr = fr + coarse["r0"] * per
        tfc = gfc - target["coarse"]["c0"] * per
        tfr = gfr - target["coarse"]["r0"] * per
        tlc = math.floor(tfc / per)
        tlr = math.floor(tfr / per)
        pfc = tfc - tlc * per
        pfr = tfr - tlr * per
        if not (0 <= pfr < per and 0 <= pfc < per):
            return None
        q = target["fine"]["bytes"][pi * per * per + math.floor(pfr) * per + math.floor(pfc)]
        return None if q == 255 else float(q)

    def sample_coarse():
        localCf = (xM - coarse["xMin"]) / cm
        localRf = (coarse["yMax"] - yM) / cm
        cr = localRf - 0.5
        cc = localCf - 0.5
        lastR = coarse["rows"] - 1
        lastC = coarse["cols"] - 1
        crc = max(0, min(lastR, cr))
        ccc = max(0, min(lastC, cc))
        r0 = lastR - 1 if crc >= lastR else math.floor(crc)
        c0 = lastC - 1 if ccc >= lastC else math.floor(ccc)
        cdr = crc - r0
        cdc = ccc - c0

        def get_coarse(r, c):
            if 0 <= r < coarse["rows"] and 0 <= c < coarse["cols"]:
                q = coarse["bytes"][r * coarse["cols"] + c]
                return None if q == 255 else float(q)
            cellXM = coarse["xMin"] + (c + 0.5) * cm
            cellYM = coarse["yMax"] - (r + 0.5) * cm
            nrid = region_id_for(y_to_lat(cellYM), x_to_lon(cellXM))
            nregion = regions.get(nrid) if nrid else None
            if not nregion:
                return None
            return _sample_region_byte(nregion, y_to_lat(cellYM), x_to_lon(cellXM))

        cnum, cden = 0.0, 0.0
        for (r, c, w) in ((r0, c0, (1 - cdr) * (1 - cdc)),
                          (r0, c0 + 1, (1 - cdr) * cdc),
                          (r0 + 1, c0, cdr * (1 - cdc)),
                          (r0 + 1, c0 + 1, cdr * cdc)):
            b = get_coarse(r, c)
            if b is not None:
                cnum += b * w
                cden += w
        return cnum / cden if cden > 0 else None

    fnum, fden, has_fine = 0.0, 0.0, False
    for (fr, fc, w) in ((fr0, fc0, (1 - dr) * (1 - dc)),
                        (fr0, fc0 + 1, (1 - dr) * dc),
                        (fr0 + 1, fc0, dr * (1 - dc)),
                        (fr0 + 1, fc0 + 1, dr * dc)):
        q = get_fine(fr, fc)
        if q is not None:
            has_fine = True
            fnum += q * w
            fden += w

    if has_fine:
        fine_val = fnum / fden if fden > 0 else None
        if fden < 0.99 and fine_val is not None:
            coarse_val = sample_coarse()
            if coarse_val is not None:
                return fine_val * fden + coarse_val * (1 - fden)
        return fine_val
    return sample_coarse()

# ---------------------------------------------------------------------------
# VIIRS native sampling + K1/K2/Walker model
# ---------------------------------------------------------------------------

HV_RE = re.compile(r"\.h(\d{2})v(\d{2})\.")


def tile_latlon_bounds(h, v):
    lon_min = h * 10 - 180
    lat_max = 90 - v * 10
    return lon_min, lon_min + 10, lat_max - 10, lat_max


def build_viirs_mosaic(lat_min, lat_max, lon_min, lon_max):
    """Mosaic VIIRS AllAngle Snow-Free tiles at native 15 arc-sec.

    Returns (rad, mlat0, mlon0) where rad[row, col] covers
    [mlat0, mlat0 + rows*15asec] x [mlon0, mlon0 + cols*15asec],
    rows increasing downward (north to south). Fill -> 0.
    """
    ASE = 15.0 / 3600.0
    # Snap bounds outward to tile grid
    files = sorted(glob.glob(os.path.join(TILE_DIR, "*.h5")))
    wanted = {}
    for path in files:
        m = HV_RE.search(os.path.basename(path))
        if not m:
            continue
        h, v = int(m.group(1)), int(m.group(2))
        tlon0, tlon1, tlat0, tlat1 = tile_latlon_bounds(h, v)
        if tlon1 < lon_min or tlon0 > lon_max or tlat1 < lat_min or tlat0 > lat_max:
            continue
        wanted[(h, v)] = path
    if not wanted:
        raise RuntimeError("no VIIRS tiles found for bounds")
    print(f"  mosaicking {len(wanted)} VIIRS tiles", flush=True)

    # Mosaic extent snapped to 15 arc-sec
    mlat1 = math.ceil(lat_max / ASE) * ASE
    mlat0 = math.floor(lat_min / ASE) * ASE
    mlon0 = math.floor(lon_min / ASE) * ASE
    mlon1 = math.ceil(lon_max / ASE) * ASE
    nrows = int(round((mlat1 - mlat0) / ASE))
    ncols = int(round((mlon1 - mlon0) / ASE))
    rad = np.zeros((nrows, ncols), dtype=np.float32)

    for (h, v), path in sorted(wanted.items()):
        tlon0, tlon1, tlat0, tlat1 = tile_latlon_bounds(h, v)
        with h5py.File(path, "r") as f:
            ds = f[f"HDFEOS/GRIDS/VIIRS_Grid_DNB_2d/Data Fields/{VIIRS_LAYER}"]
            tile = ds[:].astype(np.float32)
        tile[tile < 0] = 0.0  # fill / invalid -> 0
        # Tile row 0 = tlat1 (north). Place into mosaic, clipping to bounds.
        r0 = int(round((mlat1 - tlat1) / ASE))
        c0 = int(round((tlon0 - mlon0) / ASE))
        tr0, tc0 = max(0, -r0), max(0, -c0)  # start offset inside tile
        r0c, c0c = max(0, r0), max(0, c0)    # start offset inside mosaic
        r1c = min(nrows, r0 + 2400)
        c1c = min(ncols, c0 + 2400)
        if r1c <= r0c or c1c <= c0c:
            continue
        tr1 = tr0 + (r1c - r0c)
        tc1 = tc0 + (c1c - c0c)
        rad[r0c:r1c, c0c:c1c] = np.maximum(rad[r0c:r1c, c0c:c1c],
                                           tile[tr0:tr1, tc0:tc1])
    return rad, mlat0, mlon0, ASE


def sample_mosaic(rad, mlat0, mlon0, ase, lats, lons):
    """Bilinear sample of the mosaic at (lats, lons). Arrays in, array out."""
    # mosaic row 0 = north (mlat0 + nrows*ase)
    nrows, ncols = rad.shape
    mlat1 = mlat0 + nrows * ase
    py = (mlat1 - lats) / ase - 0.5
    px = (lons - mlon0) / ase - 0.5
    return map_coordinates(rad, [py.ravel(), px.ravel()],
                           order=1, mode="constant", cval=0.0).reshape(lats.shape)


def walker_kernel(cell_m=WALKER_CELL_M, max_km=WALKER_MAX_KM, power=WALKER_POWER):
    r = int(math.ceil(max_km * 1000.0 / cell_m))
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    d_km = (cell_m / 1000.0) * np.sqrt(xx ** 2 + yy ** 2)
    k = np.zeros_like(d_km)
    m = (d_km > 0) & (d_km <= max_km)
    k[m] = d_km[m] ** (-power)
    return k


def apply_model(local_rad, walker):
    art = K1 * local_rad + K2 * np.sqrt(np.maximum(walker, 0.0))
    with np.errstate(divide="ignore", invalid="ignore"):
        sqm = 22.0 - 2.5 * np.log10(1.0 + art / NATURAL)
    return np.clip(sqm, 16.0, 22.0)


def _merc_grid_bilinear(grid, x0, y1, cell_m, xs, ys):
    """Bilinear sample of a Web-Mercator grid (row 0 = north) at (xs, ys)."""
    py = (y1 - ys) / cell_m - 0.5
    px = (xs - x0) / cell_m - 0.5
    return map_coordinates(grid, [py.ravel(), px.ravel()],
                           order=1, mode="constant", cval=np.nan).reshape(xs.shape)

# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def _even(n):
    n = int(round(n))
    return n if n % 2 == 0 else n + 1


def render_location(name, bounds, probes, out_prefix):
    (south, west), (north, east) = bounds
    print(f"== {name} ==", flush=True)
    x0, y0, x1, y1 = bounds_to_merc(bounds)
    width_m, height_m = x1 - x0, y1 - y0

    # --- shipped 4km data ---
    print("loading shipped regions...", flush=True)
    regions = load_regions_for_bounds(bounds)

    # --- VIIRS mosaic (bounds + Walker halo) ---
    halo_lat = WALKER_MAX_KM / 111.32 + 0.1
    halo_lon = WALKER_MAX_KM / (111.32 * math.cos(math.radians((south + north) / 2))) + 0.1
    mlat0 = south - halo_lat
    mlat1 = north + halo_lat
    mlon0 = west - halo_lon
    mlon1 = east + halo_lon
    print("building VIIRS mosaic...", flush=True)
    rad, mla0, mlo0, ase = build_viirs_mosaic(mlat0, mlat1, mlon0, mlon1)

    # --- 4km Walker grid over padded meter bounds ---
    px0, py0, px1, py1 = lon_to_x(mlon0), lat_to_y(mlat0), lon_to_x(mlon1), lat_to_y(mlat1)
    wnx = int(math.ceil((px1 - px0) / WALKER_CELL_M))
    wny = int(math.ceil((py1 - py0) / WALKER_CELL_M))
    wx = px0 + (np.arange(wnx) + 0.5) * WALKER_CELL_M
    wy = py1 - (np.arange(wny) + 0.5) * WALKER_CELL_M
    wxx, wyy = np.meshgrid(wx, wy)
    wlat = np.vectorize(y_to_lat)(wyy)
    wlon = np.vectorize(x_to_lon)(wxx)
    print(f"sampling {wnx}x{wny} Walker cells...", flush=True)
    wrad = sample_mosaic(rad, mla0, mlo0, ase, wlat, wlon)
    print("convolving Walker kernel...", flush=True)
    walker = convolve(np.nan_to_num(wrad, nan=0.0).astype(np.float64),
                      walker_kernel(), mode="constant", cval=0.0)

    def walker_at(xs, ys):
        return _merc_grid_bilinear(walker, px0, py1, WALKER_CELL_M, xs, ys)

    results = {}

    # --- 500m / 1km model grids in LAT/LON space at native 15 arc-sec ---
    # ("500m" is the approximate name; the output is the native VIIRS grid,
    # 1km is the 2x2 block mean. This preserves point-source peaks.)
    ASE_DEG = 15.0 / 3600.0
    # Snap bounds outward to the 15 arc-sec grid
    glat0 = math.floor(south / ASE_DEG) * ASE_DEG
    glat1 = math.ceil(north / ASE_DEG) * ASE_DEG
    glon0 = math.floor(west / ASE_DEG) * ASE_DEG
    glon1 = math.ceil(east / ASE_DEG) * ASE_DEG
    gnrows = int(round((glat1 - glat0) / ASE_DEG))
    gncols = int(round((glon1 - glon0) / ASE_DEG))
    # Native radiance = mosaic resampled onto the snapped grid (nearest: the
    # mosaic is already at 15 arc-sec, so this is an exact reindexing).
    print(f"building native {gncols}x{gnrows} radiance grid...", flush=True)
    mlat1_m = mla0 + rad.shape[0] * ase
    # mosaic pixel (r,c) -> lat = mlat1_m - (r+0.5)*ase, lon = mlo0 + (c+0.5)*ase
    # target pixel (i,j) center: lat = glat1 - (i+0.5)*ASE_DEG
    ti = ((mlat1_m - (glat1 - (np.arange(gnrows) + 0.5) * ASE_DEG)) / ase - 0.5)
    tj = (((glon0 + (np.arange(gncols) + 0.5) * ASE_DEG) - mlo0) / ase - 0.5)
    tii = np.clip(np.round(ti).astype(int), 0, rad.shape[0] - 1)
    tjj = np.clip(np.round(tj).astype(int), 0, rad.shape[1] - 1)
    local500 = rad[np.ix_(tii, tjj)]
    # 1km = 2x2 mean of native (trim to even)
    enr, enc = (gnrows // 2) * 2, (gncols // 2) * 2
    local1k = local500[:enr, :enc].reshape(enr // 2, 2, enc // 2, 2).mean(axis=(1, 3))

    # Walker interpolated at pixel centers (convert lat/lon -> meters)
    def walker_for_latlon(clat, clon):
        cxx, cyy = np.meshgrid(clon, clat)
        return walker_at(np.vectorize(lon_to_x)(cxx),
                         np.vectorize(lat_to_y)(cyy))

    print("rendering 500m...", flush=True)
    clat500 = glat1 - (np.arange(gnrows) + 0.5) * ASE_DEG
    clon500 = glon0 + (np.arange(gncols) + 0.5) * ASE_DEG
    sqm500 = apply_model(local500, walker_for_latlon(clat500, clon500))
    Image.fromarray(sqm_grid_to_rgba(sqm500), "RGBA").save(
        os.path.join(OUT_DIR, f"{out_prefix}_fullres.png"))

    print("rendering 1km...", flush=True)
    nr1, nc1 = enr // 2, enc // 2
    clat1k = glat1 - (np.arange(nr1) + 0.5) * 2 * ASE_DEG
    clon1k = glon0 + (np.arange(nc1) + 0.5) * 2 * ASE_DEG
    sqm1k = apply_model(local1k, walker_for_latlon(clat1k, clon1k))
    Image.fromarray(sqm_grid_to_rgba(sqm1k), "RGBA").save(
        os.path.join(OUT_DIR, f"{out_prefix}_1km.png"))

    # --- current (4km shipped) panel at 150m/px ---
    cx = _even(width_m / PX_CURRENT)
    cy = _even(height_m / PX_CURRENT)
    print(f"rendering shipped 4km at {cx}x{cy} (this takes a while)...", flush=True)
    sqm_cur = np.full((cy, cx), np.nan)
    # Loop in chunks for progress; per-pixel Python loop (faithful port).
    CHUNK = 200
    for r0 in range(0, cy, CHUNK):
        r1 = min(cy, r0 + CHUNK)
        ys = y1 - (np.arange(r0, r1) + 0.5) * PX_CURRENT
        for c0 in range(0, cx, CHUNK):
            c1 = min(cx, c0 + CHUNK)
            xs = x0 + (np.arange(c0, c1) + 0.5) * PX_CURRENT
            for j, yM in enumerate(ys):
                for i, xM in enumerate(xs):
                    b = sample_bortle_byte(xM, yM, regions)
                    if b is not None:
                        sqm_cur[r0 + j, c0 + i] = 16.0 + b * 0.05
        print(f"  rows {r0}-{r1}/{cy}", flush=True)
    Image.fromarray(sqm_grid_to_rgba(sqm_cur), "RGBA").save(
        os.path.join(OUT_DIR, f"{out_prefix}_current.png"))

    # --- probes ---
    # 4km: exact shipped sampler. 500m/1km: model evaluated at the probe on the
    # native grids (500m = nearest native cell, 1km = bilinear on 2x2 means).
    print("probes (SQM):", flush=True)
    for pname, plat, plon in probes:
        pxM, pyM = lon_to_x(plon), lat_to_y(plat)
        b = sample_bortle_byte(pxM, pyM, regions)
        cur = 16.0 + b * 0.05 if b is not None else float("nan")
        w = float(walker_at(np.array([[pxM]]), np.array([[pyM]]))[0, 0])
        # 500m: nearest native cell
        fi = (glat1 - plat) / ASE_DEG - 0.5
        fj = (plon - glon0) / ASE_DEG - 0.5
        ii = int(np.clip(round(fi), 0, gnrows - 1))
        jj = int(np.clip(round(fj), 0, gncols - 1))
        v500 = float(apply_model(np.array([local500[ii, jj]]),
                                 np.array([w]))[0])
        # 1km: bilinear on the 2x2-mean grid
        gi = (glat1 - plat) / (2 * ASE_DEG) - 0.5
        gj = (plon - glon0) / (2 * ASE_DEG) - 0.5
        i0, j0 = math.floor(gi), math.floor(gj)
        di, dj = gi - i0, gj - j0
        vals = []
        for (ai, aj, wt) in ((i0, j0, (1 - di) * (1 - dj)),
                             (i0, j0 + 1, (1 - di) * dj),
                             (i0 + 1, j0, di * (1 - dj)),
                             (i0 + 1, j0 + 1, di * dj)):
            if 0 <= ai < nr1 and 0 <= aj < nc1:
                vals.append(local1k[ai, aj] * wt)
        loc1k = sum(vals) if vals else 0.0
        v1k = float(apply_model(np.array([loc1k]), np.array([w]))[0])
        results[pname] = (cur, v1k, v500)
        print(f"  {pname:24s} 4km={cur:6.2f}  1km={v1k:6.2f}  500m={v500:6.2f}",
              flush=True)
    return results


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    all_probes = {}
    all_probes.update(render_location("Potsdam, NY", POTSDAM_BOUNDS,
                                      POTSDAM_PROBES, "potsdam"))
    all_probes.update(render_location("Bakken, ND", BAKKEN_BOUNDS,
                                      BAKKEN_PROBES, "bakken"))
    print("\nDone. PNGs written to", OUT_DIR)
    # Verify RGBA + transparency consistency
    for f in sorted(glob.glob(os.path.join(OUT_DIR, "*_*.png"))):
        img = Image.open(f)
        a = np.array(img)[:, :, 3]
        uniq = np.unique(a)
        print(f"  {os.path.basename(f)}: {img.mode} {img.size}, "
              f"alpha values: {uniq.tolist()[:5]}{'...' if len(uniq) > 5 else ''}")


if __name__ == "__main__":
    main()
