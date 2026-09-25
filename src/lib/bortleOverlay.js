import { sqmToBortle } from './astro.js';
import {
  regionIdFor,
  ensureRegion,
  getRegionSync,
  getRegionByIdSync,
  ensureRegionById,
  sampleRegionByte,
} from './bortleRegions.js';

/* Preload all regions intersecting a lat/lon bounding box (with a small halo
   so edge tiles have their neighbors). Returns a promise that resolves when
   all are loaded (or failed). */
export function preloadRegionsForBounds(south, west, north, east) {
  // Expand by ~0.5 degrees to cover tiles straddling the edge
  const pad = 0.5;
  const rids = regionsForBounds(south - pad, west - pad, north + pad, east + pad);
  return Promise.all(rids.map((rid) => ensureRegionById(rid).catch(() => null)));
}

/* Bortle heatmap as a Leaflet tile layer. Tiles (256px) are rendered on
   demand at the map's zoom: each pixel samples the 20km Web-Mercator coarse
   grid and, where they exist, the 4km fine patches, from lazy-loaded regional
   files. The grid is defined in Web-Mercator meters, so cells are square on
   the map (no latitude-dependent stretching). Colors follow the same Bortle
   class breaks the point estimates use. Class 1 (pristine) is fully
   transparent so the dark basemap shows through; intensity builds to a
   near-white hot core at class 9. Unknown cells stay transparent. */

const RAMP = {
  1: [48, 70, 170, 24],
  2: [48, 70, 170, 56],
  3: [36, 130, 205, 88],
  4: [36, 175, 170, 118],
  5: [105, 195, 95, 148],
  6: [225, 210, 75, 172],
  7: [242, 150, 45, 196],
  8: [236, 85, 50, 218],
  9: [255, 238, 238, 238],
};

/* Web-Mercator helpers (mirror Leaflet's SphericalMercator). */
const MERC_R = 6378137;
const MERC_WORLD = 2 * Math.PI * MERC_R; // 40075016.68557849
const MERC_LIMIT = 20037508.342789244;

function mercToLat(y) {
  return ((2 * Math.atan(Math.exp(y / MERC_R)) - Math.PI / 2) * 180) / Math.PI;
}

function mercToLon(x) {
  return (x / MERC_R) * 180 / Math.PI;
}

const TILE_SIZE = 256;
const TILE_MAX_ZOOM = 12;

/* Byte thresholds for Bortle classes (sqm = 16 + byte*0.05), from BORTLE_BREAKS
   in astro.js. Used for smooth color interpolation across class edges. */
const BYTE_BREAKS = [
  [115.2, 1], [112.0, 2], [106.0, 3], [96.0, 4],
  [65.0, 5], [50.0, 6], [40.0, 7], [30.0, 8],
];

/* Smoothly interpolated [r,g,b,a] for a float SQM byte. Blends between class
   colors near boundaries so steep gradients don't render as sharp stripes. */
function byteColor(b) {
  for (let i = 0; i < BYTE_BREAKS.length; i++) {
    const [edge, cls] = BYTE_BREAKS[i];
    if (b >= edge) {
      if (i === 0) return RAMP[1];
      const [prevEdge, prevCls] = BYTE_BREAKS[i - 1];
      const t = (b - edge) / (prevEdge - edge);
      const c0 = RAMP[cls];
      const c1 = RAMP[prevCls];
      return [
        c0[0] + (c1[0] - c0[0]) * t,
        c0[1] + (c1[1] - c0[1]) * t,
        c0[2] + (c1[2] - c0[2]) * t,
        c0[3] + (c1[3] - c0[3]) * t,
      ];
    }
  }
  return RAMP[9];
}

/* Get all region IDs that intersect a lat/lon bounding box. */
function regionsForBounds(south, west, north, east) {
  const ids = new Set();
  // Sample the corners and center to find regions
  // (regions are large, so corners+center is sufficient)
  const lats = [south, (south + north) / 2, north];
  const lons = [west, (west + east) / 2, east];
  for (const lat of lats) {
    for (const lon of lons) {
      const rid = regionIdFor(lat, lon);
      if (rid) ids.add(rid);
    }
  }
  return [...ids];
}

/* Sample the Bortle byte at (xM, yM) meters, matching the pre-split renderer.
   Fine patches (4km) take precedence where they exist: if any of the 4
   surrounding fine cells has valid data, the result is fine-only (bilinear).
   Otherwise, falls back to coarse (20km) bilinear. This preserves the crisp
   city detail of the original instead of washing it out by blending. */
function sampleBortleByte(xM, yM, regions) {
  const lat = mercToLat(yM);
  const lon = mercToLon(xM);
  const rid = regionIdFor(lat, lon);
  if (!rid) return null;
  const region = regions.get(rid);
  if (!region) return null;
  const { coarse, fine } = region;
  const cm = coarse.cellM;
  const fm = fine.cellM;
  const per = fine.per;

  // Fine: bilinear over 4km grid (cell centers at integer - 0.5)
  const localFxf = (xM - coarse.xMin) / fm;
  const localFyf = (coarse.yMax - yM) / fm;
  const frg = localFyf - 0.5;
  const fcg = localFxf - 0.5;
  const fr0 = Math.floor(frg);
  const fc0 = Math.floor(fcg);
  const dr = frg - fr0;
  const dc = fcg - fc0;

  // Helper: get fine cell value at region-local fine coords (fr, fc).
  // Crosses region boundaries: the fine patch for a global cell may be stored
  // in a neighboring region's map (the generator assigns overlap cells to the
  // first region in its list, not necessarily the one regionIdFor returns).
  // Searches all loaded regions for the patch by its global key.
  const getFine = (fr, fc) => {
    const lc = Math.floor(fc / per);
    const lr = Math.floor(fr / per);
    const globalC = lc + coarse.c0;
    const globalR = lr + coarse.r0;
    const fkey = globalR * coarse.globalCols + globalC;
    // Find which loaded region has this patch
    let targetRegion = null;
    let pi = undefined;
    for (const [, reg] of regions) {
      const idx = reg.fine.map.get(fkey);
      if (idx !== undefined) {
        targetRegion = reg;
        pi = idx;
        break;
      }
    }
    if (!targetRegion) return null;
    // Convert to target-region local fine coords via global space
    const gfc = fc + coarse.c0 * per;
    const gfr = fr + coarse.r0 * per;
    const tfc = gfc - targetRegion.coarse.c0 * per;
    const tfr = gfr - targetRegion.coarse.r0 * per;
    const tlc = Math.floor(tfc / per);
    const tlr = Math.floor(tfr / per);
    const pfc = tfc - tlc * per;
    const pfr = tfr - tlr * per;
    if (pfr < 0 || pfr >= per || pfc < 0 || pfc >= per) return null;
    const q = targetRegion.fine.bytes[pi * per * per + Math.floor(pfr) * per + Math.floor(pfc)];
    return q === 255 ? null : q;
  };

  let fnum = 0, fden = 0, hasFine = false;
  const fq00 = getFine(fr0, fc0);
  if (fq00 != null) { hasFine = true; const w = (1-dr)*(1-dc); fnum += fq00*w; fden += w; }
  const fq01 = getFine(fr0, fc0+1);
  if (fq01 != null) { hasFine = true; const w = (1-dr)*dc; fnum += fq01*w; fden += w; }
  const fq10 = getFine(fr0+1, fc0);
  if (fq10 != null) { hasFine = true; const w = dr*(1-dc); fnum += fq10*w; fden += w; }
  const fq11 = getFine(fr0+1, fc0+1);
  if (fq11 != null) { hasFine = true; const w = dr*dc; fnum += fq11*w; fden += w; }

  // Coarse sampler (bilinear between 20km cell centers), shared by the
  // fallback path and the fine-edge blend below.
  const sampleCoarse = () => {
    const localCf = (xM - coarse.xMin) / cm;
    const localRf = (coarse.yMax - yM) / cm;
    const cr = localCf - 0.5;
    const cc = localRf - 0.5;
    const lastR = coarse.rows - 1;
    const lastC = coarse.cols - 1;
    const crc = Math.max(0, Math.min(lastR, cr));
    const ccc = Math.max(0, Math.min(lastC, cc));
    const r0 = crc >= lastR ? lastR - 1 : Math.floor(crc);
    const c0 = ccc >= lastC ? lastC - 1 : Math.floor(ccc);
    const cdr = crc - r0;
    const cdc = ccc - c0;
    const getCoarse = (r, c) => {
      if (r >= 0 && r < coarse.rows && c >= 0 && c < coarse.cols) {
        const q = coarse.bytes[r * coarse.cols + c];
        return q === 255 ? null : q;
      }
      const cellXM = coarse.xMin + (c + 0.5) * cm;
      const cellYM = coarse.yMax - (r + 0.5) * cm;
      const cellLat = mercToLat(cellYM);
      const cellLon = mercToLon(cellXM);
      const nrid = regionIdFor(cellLat, cellLon);
      const nregion = nrid ? regions.get(nrid) : null;
      if (!nregion) return null;
      return sampleRegionByte(nregion, cellLat, cellLon);
    };
    let cnum = 0, cden = 0;
    const b00 = getCoarse(r0, c0);
    if (b00 != null) { const w = (1-cdr)*(1-cdc); cnum += b00*w; cden += w; }
    const b01 = getCoarse(r0, c0+1);
    if (b01 != null) { const w = (1-cdr)*cdc; cnum += b01*w; cden += w; }
    const b10 = getCoarse(r0+1, c0);
    if (b10 != null) { const w = cdr*(1-cdc); cnum += b10*w; cden += w; }
    const b11 = getCoarse(r0+1, c0+1);
    if (b11 != null) { const w = cdr*cdc; cnum += b11*w; cden += w; }
    return cden > 0 ? cnum / cden : null;
  };

  // Fine is authoritative where it fully covers the pixel. At patch edges
  // (partial fine coverage), blend with coarse to avoid a hard line where
  // crisp fine city data meets smooth coarse rural data.
  if (hasFine) {
    const fineVal = fden > 0 ? fnum / fden : null;
    if (fden < 0.99 && fineVal != null) {
      const coarseVal = sampleCoarse();
      if (coarseVal != null) {
        return fineVal * fden + coarseVal * (1 - fden);
      }
    }
    return fineVal;
  }

  return sampleCoarse();
}

/* Unified bilinear sampler: treats the grid as a global fine (4km) grid.
   DEPRECATED: Use sampleBortleByte instead (fine-first, not blended). */
function sampleUnifiedBilinear(xM, yM, regions) {
  // Find the region containing this point
  const lat = mercToLat(yM);
  const lon = mercToLon(xM);
  const rid = regionIdFor(lat, lon);
  if (!rid) return null;
  const region = regions.get(rid);
  if (!region) return null;
  const { coarse, fine } = region;
  const cm = coarse.cellM;
  const fm = fine.cellM;
  const per = fine.per; // 5

  // Position in fine-cell coordinates (global, within region)
  // Fine cell (fr,fc) covers [fc,fc+1]x[fr,fr+1], value at center.
  const localFxf = (xM - coarse.xMin) / fm;
  const localFyf = (coarse.yMax - yM) / fm;
  
  const fc0 = Math.floor(localFxf - 0.5);
  const fr0 = Math.floor(localFyf - 0.5);
  const tx = (localFxf - 0.5) - fc0;
  const ty = (localFyf - 0.5) - fr0;

  // Helper: get the fine-grid value at (fr, fc) in region-local fine coords
  // Returns the byte, or null if no coverage.
  const getFineValue = (fr, fc) => {
    // Map to coarse cell
    const lc = Math.floor(fc / per);
    const lr = Math.floor(fr / per);
    if (lc < 0 || lc >= coarse.cols || lr < 0 || lr >= coarse.rows) {
      // Outside region; try adjacent region via lat/lon
      const cellXM = coarse.xMin + (fc + 0.5) * fm;
      const cellYM = coarse.yMax - (fr + 0.5) * fm;
      const cellLat = mercToLat(cellYM);
      const cellLon = mercToLon(cellXM);
      const nrid = regionIdFor(cellLat, cellLon);
      const nregion = nrid ? regions.get(nrid) : null;
      if (!nregion) return null;
      // Recursively sample (but avoid infinite recursion by using coarse only)
      const nq = sampleRegionByte(nregion, cellLat, cellLon);
      return nq;
    }
    // Check if this coarse cell has a fine patch
    const globalC = lc + coarse.c0;
    const globalR = lr + coarse.r0;
    const fkey = globalR * coarse.globalCols + globalC;
    const pi = fine.map.get(fkey);
    if (pi !== undefined) {
      // In a patch: get the fine cell value
      const pfr = fr - lr * per;
      const pfc = fc - lc * per;
      if (pfr >= 0 && pfr < per && pfc >= 0 && pfc < per) {
        const q = fine.bytes[pi * per * per + pfr * per + pfc];
        return q === 255 ? null : q;
      }
    }
    // Not in a patch: use the coarse cell value
    const q = coarse.bytes[lr * coarse.cols + lc];
    return q === 255 ? null : q;
  };

  const q00 = getFineValue(fr0, fc0);
  const q10 = getFineValue(fr0, fc0 + 1);
  const q01 = getFineValue(fr0 + 1, fc0);
  const q11 = getFineValue(fr0 + 1, fc0 + 1);
  
  const samples = [q00, q10, q01, q11];
  const weights = [(1-tx)*(1-ty), tx*(1-ty), (1-tx)*ty, tx*ty];
  let sum = 0, wsum = 0;
  for (let i = 0; i < 4; i++) {
    if (samples[i] != null) {
      sum += samples[i] * weights[i];
      wsum += weights[i];
    }
  }
  return wsum === 0 ? null : sum / wsum;
}

/* Bilinearly sample the fine patch at (xM, yM) meters, or null if no patch.
   Returns a float byte value. Values are at cell centers (half-cell offset).
   DEPRECATED: Use sampleUnifiedBilinear instead. */
function sampleFineBilinear(xM, yM, region) {
  const { coarse, fine } = region;
  if (fine.count === 0) return null;
  const cm = coarse.cellM;
  const fm = fine.cellM;
  const per = fine.per;
  
  // Global coarse cell
  const localCf = (xM - coarse.xMin) / cm;
  const localRf = (coarse.yMax - yM) / cm;
  const lc = Math.floor(localCf);
  const lr = Math.floor(localRf);
  if (lc < 0 || lc >= coarse.cols || lr < 0 || lr >= coarse.rows) return null;
  
  const globalC = lc + coarse.c0;
  const globalR = lr + coarse.r0;
  const fkey = globalR * coarse.globalCols + globalC;
  const pi = fine.map.get(fkey);
  if (pi === undefined) return null;

  // Position within the coarse cell, in fine-cell units.
  // Fine cell (fr,fc) covers [fc,fc+1]x[fr,fr+1], value at center.
  const fx = (localCf - lc) * per;
  const fy = (localRf - lr) * per;
  const fc0 = Math.floor(fx - 0.5);
  const fr0 = Math.floor(fy - 0.5);
  const tx = (fx - 0.5) - fc0;
  const ty = (fy - 0.5) - fr0;

  // Sample 4 fine cells with clamping at patch edges
  const getFine = (fr, fc) => {
    const cr = Math.max(0, Math.min(per - 1, fr));
    const cc = Math.max(0, Math.min(per - 1, fc));
    const q = fine.bytes[pi * per * per + cr * per + cc];
    return q === 255 ? null : q;
  };
  
  const q00 = getFine(fr0, fc0);
  const q10 = getFine(fr0, fc0 + 1);
  const q01 = getFine(fr0 + 1, fc0);
  const q11 = getFine(fr0 + 1, fc0 + 1);
  
  const samples = [q00, q10, q01, q11];
  const weights = [(1-tx)*(1-ty), tx*(1-ty), (1-tx)*ty, tx*ty];
  let sum = 0, wsum = 0;
  for (let i = 0; i < 4; i++) {
    if (samples[i] != null) {
      sum += samples[i] * weights[i];
      wsum += weights[i];
    }
  }
  return wsum === 0 ? null : sum / wsum;
}

/* Bilinearly sample the coarse grid at (xM, yM) meters.
   Returns a float byte value, or null if no coverage.
   Handles region boundaries by looking up each of the 4 surrounding cells
   in its own region. Values are at cell CENTERS, so we offset by half a cell. */
function sampleCoarseBilinear(xM, yM, regions) {
  // Find the region containing this point
  const lat = mercToLat(yM);
  const lon = mercToLon(xM);
  const rid = regionIdFor(lat, lon);
  if (!rid) return null;
  const region = regions.get(rid);
  if (!region) return null;
  const { coarse } = region;
  const cm = coarse.cellM;

  // Cell coordinates (fractional). Cell (r,c) covers [c,c+1]x[r,r+1],
  // with its value at the center (c+0.5, r+0.5).
  const localCf = (xM - coarse.xMin) / cm;
  const localRf = (coarse.yMax - yM) / cm;
  
  // Find the 4 surrounding cell centers
  const c0 = Math.floor(localCf - 0.5);
  const r0 = Math.floor(localRf - 0.5);
  const fx = (localCf - 0.5) - c0;
  const fy = (localRf - 0.5) - r0;

  // Sample the 4 corners, handling region boundaries
  // For each corner, compute its global coordinates, then find its region
  const samples = [];
  for (let dr = 0; dr <= 1; dr++) {
    for (let dc = 0; dc <= 1; dc++) {
      const lr = r0 + dr;
      const lc = c0 + dc;
      // Check if in this region's bounds
      let q = null;
      if (lr >= 0 && lr < coarse.rows && lc >= 0 && lc < coarse.cols) {
        q = coarse.bytes[lr * coarse.cols + lc];
        if (q === 255) q = null;
      } else {
        // Neighbor is in an adjacent region; find it via lat/lon
        // Compute the meter coordinates of this cell's center
        const cellXM = coarse.xMin + (lc + 0.5) * cm;
        const cellYM = coarse.yMax - (lr + 0.5) * cm;
        const cellLat = mercToLat(cellYM);
        const cellLon = mercToLon(cellXM);
        const nrid = regionIdFor(cellLat, cellLon);
        const nregion = nrid ? regions.get(nrid) : null;
        if (nregion) {
          q = sampleRegionByte(nregion, cellLat, cellLon);
        }
      }
      samples.push(q);
    }
  }

  // Bilinear interpolation, ignoring nulls (renormalize weights)
  // samples order: (0,0), (0,1), (1,0), (1,1) -> weights: (1-fx)(1-fy), fx(1-fy), (1-fx)fy, fx*fy
  const weights = [
    (1 - fx) * (1 - fy),
    fx * (1 - fy),
    (1 - fx) * fy,
    fx * fy,
  ];
  let sum = 0;
  let wsum = 0;
  for (let i = 0; i < 4; i++) {
    if (samples[i] != null) {
      sum += samples[i] * weights[i];
      wsum += weights[i];
    }
  }
  if (wsum === 0) return null;
  return sum / wsum;
}

/* Paint one Web-Mercator tile (x, y, z) into the given square canvas.
   Returns true if the tile was fully painted, false if some regions are
   still loading (caller should retry when they arrive). */
export function paintBortleTile(x, y, z, canvas) {
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;

  const n = 2 ** z;
  const xLeft = (x / n) * MERC_WORLD - MERC_LIMIT;
  const yTop = MERC_LIMIT - (y / n) * MERC_WORLD;
  const tileSpan = MERC_WORLD / n;

  // Tile bounds in lat/lon
  const west = mercToLon(xLeft);
  const east = mercToLon(xLeft + tileSpan);
  const north = mercToLat(yTop);
  const south = mercToLat(yTop - tileSpan);

  // Find regions. Pad the bounds so the bilinear sampler can cross region
  // boundaries (it needs the neighboring region's data for edge pixels).
  // Paint with whatever is cached; missing regions leave transparent pixels.
  // The layer redraws when they arrive (see below).
  const pad = 0.5; // degrees, covers the 20km coarse cell halo
  const rids = regionsForBounds(south - pad, west - pad, north + pad, east + pad);
  const regions = new Map();
  const missing = [];
  for (const rid of rids) {
    const region = getRegionByIdSync(rid);
    if (region) {
      regions.set(rid, region);
    } else {
      missing.push(rid);
      ensureRegionById(rid);
    }
  }

  // Paint the tile with the pre-split renderer logic: fine-first (4km) where
  // patches exist, coarse (20km) bilinear elsewhere. Preserves crisp city
  // detail without washing out at patch boundaries.
  for (let j = 0; j < size; j++) {
    const yM = yTop - ((j + 0.5) / size) * tileSpan;
    const rowOff = j * size;
    for (let i = 0; i < size; i++) {
      const xM = xLeft + ((i + 0.5) / size) * tileSpan;
      const o = (rowOff + i) * 4;
      const q = sampleBortleByte(xM, yM, regions);
      if (q == null) {
        d[o + 3] = 0;
      } else {
        const [r, g, b, a] = byteColor(q);
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
        d[o + 3] = a;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  // Return the list of region IDs that were missing (for redraw subscription).
  // Empty array means the tile is fully painted.
  return missing;
}

/* Leaflet tile layer for the heatmap. Tiles paint synchronously with cached
   regions; when a tile needs regions that aren't loaded yet, it paints what
   it can and subscribes to redraw when they arrive. */
export function createBortleTileLayer(L) {
  const pendingRedraws = new Set(); // region IDs we're waiting on
  let layer = null;

  const BortleTiles = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      const size = this.getTileSize();
      tile.width = size.x;
      tile.height = size.y;
      // Synchronous paint: uses cached regions, missing ones stay transparent.
      // Returns the list of missing region IDs (empty if fully painted).
      let missing = [];
      try {
        missing = paintBortleTile(coords.x, coords.y, coords.z, tile) || [];
      } catch (e) {
        console.warn('Bortle tile paint failed', e);
      }
      // If regions were missing, ensure we redraw when they load.
      for (const rid of missing) {
        if (!pendingRedraws.has(rid)) {
          pendingRedraws.add(rid);
          ensureRegionById(rid).then(
            () => {
              pendingRedraws.delete(rid);
              if (layer && layer._map) layer.redraw();
            },
            () => pendingRedraws.delete(rid),
          );
        }
      }
      // Always signal completion — but asynchronously. Leaflet hasn't finished
      // registering the tile when createTile returns, so a synchronous done()
      // gets ignored and the tile never gets the 'loaded' class.
      setTimeout(() => { if (done) done(null, tile); }, 0);
      return tile;
    },
  });
  layer = new BortleTiles({
    tileSize: TILE_SIZE,
    maxZoom: TILE_MAX_ZOOM,
    opacity: 0.85,
    interactive: false,
    pane: 'overlayPane',
  });
  return layer;
}
