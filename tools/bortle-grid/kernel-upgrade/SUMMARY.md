# Skyglow Kernel Upgrade — Calibration Results

## Chosen Kernel
**Walker-law propagation kernel**: w(d) = d^(-p), p=2.5, r_max=8 cells (200km)
- Center cell excluded (d <= 0.5); k1*local handles the center
- Unnormalized weighted sum (physical: skyglow is sum of contributions, not average)
- Applied via scipy.ndimage.convolve on the 25km Web-Mercator grid
- No latitude correction needed (Mercator grid is uniform in meters)

## Model
art = k1 * local + k2 * walker_sum
- k1 = 0.09, k2 = 0.025 (best trade-off found)

## Results

### Anchor Score (62 ground-truth anchors, CONUS patch)
- OLD model (Gaussian σ=2.75 cells, k1=0.1179, k2=0.0642): **54/62**
- NEW model (Walker p=2.5, rmax=8, k1=0.09, k2=0.025): **53/62**
- Difference: -1 point (within noise, but technically a regression)

### Problem Spots (the reason for this work)
| Location | Old | New | Target |
|----------|-----|-----|--------|
| Rutland VT area (43.6, -72.62) | 21.89 / B1 | 21.6x / B2 | B2-3 (FIXED) |
| Boundary Waters (truly dark) | 22.00 / B1 | 22.00 / B1 | B1 (preserved) |
| Boston downtown | 18.12 / B7 | ~17.7 / B8 | B8-9 (improved) |
| NYC | 17.18 / B9 | 16.9x / B9 | B9 (preserved) |

### Anchor Miss Comparison
OLD misses (8): race-point, anza-borrego, bryce-canyon, zion, south-llano-river,
                 buffalo-river, newport, san-jose-ca
NEW misses (9): joshua-tree, anza-borrego, bryce-canyon, antelope-island,
                 south-llano-river, staunton-river, kissimmee-prairie,
                 buffalo-river, newport

Shared misses (5): anza-borrego, bryce-canyon, south-llano-river, buffalo-river, newport
Fixed by NEW (3): race-point, zion, san-jose-ca
Broken by NEW (4): joshua-tree, antelope-island, staunton-river, kissimmee-prairie

## Iteration Summary
Tested on CONUS patch (334x179 cells, 21 VIIRS tiles, 11s to accumulate):
- p ∈ {2.0, 2.5, 3.0}
- rmax ∈ {6, 8, 12, 16} cells (150-400km)
- k1 ∈ {0.06, 0.07, 0.08, 0.09, 0.095, 0.10, 0.105, 0.11, 0.1179}
- k2 ∈ {0.01, 0.015, 0.02, 0.025, 0.03, 0.035, 0.04, 0.05, 0.06, 0.08}

Best without Rutland constraint: 55/62 (p=3.0, rmax=8, k1=0.1179, k2=0.02)
  - But Rutland stays B1 (doesn't fix the problem)

Best with Rutland>=B2 constraint: 53/62 (p=2.5, rmax=8, k1=0.09, k2=0.025)
  - Rutland B2 (fixes problem), BW B1, Boston B8

## Recommendation
The Walker kernel successfully fixes the reported dark-area optimism (Rutland B1→B2)
while preserving truly dark sites and bright cities. However, it costs 1 anchor point
(53/62 vs 54/62 on CONUS; task reports 55-56/62 baseline on full grid).

This is a judgment call: the anchor set underrepresents "marginal" dark areas like
Rutland (rural but within 200km of cities). The 1-point difference is likely noise,
but per the task instructions, I am reporting back rather than shipping a regression.

If Alex approves the trade-off, the full pipeline is ready:
1. Modify make_merc_coarse.py: replace gaussian_filter with Walker convolution
2. Run make_merc_coarse.py (full 540 tiles)
3. Run make_merc_fine.py (28k patches)
4. Run split_merc_regions.py (32 regions)
5. Validate, commit, push
