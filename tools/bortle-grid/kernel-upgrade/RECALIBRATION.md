# Walker Kernel Recalibration — 2026-09-25

## Why recalibrate
The first Walker calibration (p=2.5, rmax=200km, k1=0.09, k2=0.025, linear)
was done against the OLD Bortle breaks. After the breaks were tightened
(commit e308743), the linear Walker pushed 5 dark-sky sites
(anza-borrego, antelope-island, florissant, kissimmee-prairie, pickett)
from B2-3 to B4-5. Full-grid score: 52/62 vs 56/62 for old grid on new breaks.

## Root cause
The unnormalized walker sum has extreme dynamic range: Antelope Island
(25km from SLC, local radiance 0 on water) had walker_sum=36 while Rutland
(100km+ from cities) had walker_sum=1.27 — a 28x ratio. A linear k2 cannot
simultaneously lift Rutland to B2 and keep Antelope Island at B3.

## Solution
- Faster falloff: p=3.0 (was 2.5), shorter range: rmax=150km (was 200km)
- sqrt transform on walker_sum before K2 weighting: compresses dynamic
  range (sqrt(36)=6 vs sqrt(1.27)=1.13, a 5x ratio instead of 28x)
- k1=0.11, k2=0.05

## Results (CONUS patch, NEW breaks)
- Anchor score: **59/62** (old Gaussian on new breaks: 55/62 on patch)
- Rutland VT: B3 (was B1, target >= 2)
- Boundary Waters: B1, Boston: B8, NYC: B8 coarse (B9 at fine res)
- Five sites: anza-borrego B3, antelope-island B4, florissant B3,
  kissimmee-prairie B3, pickett B3 — all within +/-1 of known (hits)

Note: NYC reads B8 on the 25km coarse grid but B9 at 5km fine resolution
(the old model shows the same coarse/fine split: 17.82 vs 17.65).

## Final parameters (2026-09-25, second iteration)
- p=3.0, rmax=5 cells (125km), k1=0.11, k2=0.05, sqrt transform
- 57/62 anchors on CONUS patch (old Gaussian: 55/62)
- All constraints met: Rutland B2-3, Boundary Waters B1, Boston B8,
  five sites all within +/-1 (anza-borrego B3, antelope-island B4,
  florissant B3, kissimmee-prairie B3, pickett B3)
- Shorter rmax (125km vs 150km) was needed to keep pristine sites (BW)
  at B1 while still lifting marginal sites (Rutland) to B2+
