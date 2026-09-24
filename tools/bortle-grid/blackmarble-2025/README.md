# 2025 Black Marble Bortle Grid — build notes

**Status: candidate built, validated, NOT shipped.** `src/data/bortleGrid.js`
(the 2016 Falchi grid) is untouched. Alex decides after seeing the numbers.

## What this is

A drop-in replacement for the shipped `bortleGrid.js`, built from NASA Black
Marble 2025 annual nighttime lights (VJ146A4, NOAA-20 VIIRS) instead of the
2016 World Atlas (Falchi et al., VIIRS 2015). Same geometry, same byte format.

## Pipeline

- `bm_grid.py` — shared code: tile accumulation (linear-space), Gaussian
  smoothing, the two-term model, SQM conversion, 0.05-mag quantization,
  anchor sampling/validation.
- `run_calibration.py` — processed 14 representative 2015 tiles, compared
  against the shipped Falchi grid, chose the winning model.
- `run_full.py` — resumable 540-tile processor (checkpoints every 25 tiles).
- `emit_js.py` — writes `bortleGrid-2025.js` in the shipped module's format.

## Method (the short version)

Per-tile `AllAngle_Composite_Snow_Free` radiances (nW/cm^2/sr) are averaged in
LINEAR space onto the 0.25-degree grid. Artificial zenith brightness is then:

    art = k1 * local_radiance + k2 * gaussian_smooth(radiance, sigma=0.5 deg)

with k1=0.1179, k2=0.0642 fitted by least squares against the Falchi grid on
~7,000 well-lit cells (R^2 = 0.95). Then the standard Stargazer conversion:
natural zenith 0.174 mcd/m^2 added, SQM = 22 - 2.5*log10(1 + art/0.174),
clamped to [16, 22], quantized to 0.05-mag bytes, 255 = unknown.

Why two terms: local radiance alone underestimates city outskirts (a dark
pixel next to a bright city still has sky glow). The smoothed term adds the
nearby-city glow. Sigma 0.5 deg (~55 km) beat 1.0 deg on validation and
avoids smearing metro glow hundreds of km into dark-sky country.

## Why not the obvious approaches

- Pure linear rescale of radiance failed (37/43 on calibration): it can't
  reproduce Falchi's city-vs-outskirts contrast.
- A global radiance-percentile transform was tried and dropped: it destroyed
  the bright-city peaks (Dallas 34 -> mapped wrong) while fixing nothing.

## Validation vs 62 anchors

| Grid | Within +/-1 Bortle |
|---|---|
| Falchi 2016 (shipped) | 54/62 |
| Black Marble 2025 (this) | **55/62** |

Fixed by 2025: florissant (1->3, known 3), enchanted-rock (1->2, known 3).

New misses in 2025: buffalo-river (known 2, pred 4 — the one true regression;
2016 read 3, within tolerance). race-point (4->2), zion (3->1), newport (3->1)
and south-llano-river (3->1) miss in BOTH grids — same wrongness as 2016, not
new damage. Shared misses (both grids): medford-ma (8->6), san-jose-ca (8->6).

Cherry Springs: both grids predict Bortle 1 (known/published 2) — within
tolerance in both, unchanged by this rebuild.

## Caveats

- VIIRS sees the 2015->2025 LED streetlight conversion as dimming (LEDs emit
  less in the band VIIRS measures), so some cities read slightly darker than
  the human eye would judge. The anchor misses at medford/san-jose are
  unchanged from 2016, so this isn't worse — just not fixed.
- Unknown cells (255) only above 80N (Arctic, no Black Marble data). The 2016
  grid has no unknowns; the app already handles unknown gracefully.
- The k1/k2 fit inherits the Falchi model's assumptions; this is a
  recalibration to newer data, not an independent ground-truth measurement.

## Files

- `bortleGrid-2025.js` — the candidate grid (1.1 MB, same format as shipped)
- `full2025_q.npy` — quantized grid (uint8, 580x1440)
- `full2025_mean_rad.npy` — mean radiance grid (float64)
- `full2025_validation.txt` — per-anchor validation report
- `full2025_sum.npy`, `full2025_cnt.npy`, `full2025_done.json` — checkpoints
- `cal2015_*.npy` — 2015 calibration intermediates

## Attribution

Source: NASA Black Marble annual nighttime lights, VJ146A4 (NOAA-20 VIIRS),
year 2025, via LAADS DAAC. Layer: AllAngle_Composite_Snow_Free.
Calibrated against the World Atlas of Artificial Night Sky Brightness
(Falchi et al. 2016, Science Advances), CC BY-NC 4.0 — the non-commercial
note in the repo README still applies if Stargazer ever goes commercial.
