"""Web Mercator grid definition for Bortle data.

Coarse: 25km cells, Fine: 5km cells (5x5 per coarse).
Covers 85.05N to 59.95S (same as degree grid), full 360 deg longitude.
"""
import math

R_MERC = 6378137.0

# Bounds in meters (from lat/lon bounds of degree grid)
XMIN = -20037508.342789244
XMAX = 20037508.342789244

def lat_to_y(lat_deg):
    s = math.sin(math.radians(lat_deg))
    return R_MERC * math.log((1 + s) / (1 - s)) / 2

def y_to_lat(y):
    return math.degrees(2 * math.atan(math.exp(y / R_MERC)) - math.pi / 2)

# Match the degree grid's lat range: 85.0541668645001 to -59.9458331354999
LATMAX = 85.0541668645001
LATMIN = LATMAX - 580 * 0.25
YMAX = lat_to_y(LATMAX)
YMIN = lat_to_y(LATMIN)

# Cell sizes (meters)
COARSE_M = 20000
FINE_M = 4000  # COARSE_M / 5
PER = 5  # fine cells per coarse cell

# Grid dimensions
COLS = math.ceil((XMAX - XMIN) / COARSE_M)
ROWS = math.ceil((YMAX - YMIN) / COARSE_M)

# Adjust bounds to fit exact cells (pad slightly)
XMAX_ADJ = XMIN + COLS * COARSE_M
YMIN_ADJ = YMAX - ROWS * COARSE_M

print(f"Mercator grid: {COLS} x {ROWS} = {COLS*ROWS/1e6:.2f}M coarse cells")
print(f"X: [{XMIN:.0f}, {XMAX_ADJ:.0f}], Y: [{YMIN_ADJ:.0f}, {YMAX:.0f}]")
print(f"Fine: {COLS*PER} x {ROWS*PER} = {COLS*PER*ROWS*PER/1e6:.2f}M fine cells")

# SQM conversion (same as bm_grid.py)
NATURAL_MCD = 0.174
UNKNOWN = 255

def artificial_to_sqm(art):
    import numpy as np
    with np.errstate(divide="ignore", invalid="ignore"):
        sqm = 22.0 - 2.5 * np.log10(1.0 + art / NATURAL_MCD)
    return np.clip(sqm, 16.0, 22.0)

def quantize(sqm):
    import numpy as np
    q = np.full(sqm.shape, UNKNOWN, dtype=np.uint8)
    ok = np.isfinite(sqm)
    q[ok] = np.round((sqm[ok] - 16.0) / 0.05).astype(np.uint8)
    return q

# K1/K2 model — Walker-law skyglow kernel (recalibrated 2026-09-25 against
# tighter Bortle breaks, see kernel-upgrade/RECALIBRATION.md).
# art = K1 * local + K2 * sqrt(walker_sum), where walker_sum is the
# unnormalized d^(-3.0) convolution over 150km. The sqrt compresses the
# dynamic range: without it, sites near bright cities (e.g. Antelope Island
# 25km from SLC) get 28x the regional term of marginal dark sites (Rutland),
# making them impossible to satisfy simultaneously with a linear model.
K1, K2 = 0.11, 0.05
WALKER_P = 3.0
WALKER_RMAX_CELLS = 5  # 125km at 25km cells
WALKER_SQRT = True  # apply sqrt to walker_sum before K2 weighting
