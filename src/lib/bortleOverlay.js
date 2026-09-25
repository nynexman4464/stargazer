import { sqmToBortle } from './astro.js';
import {
  regionIdFor,
  ensureRegion,
  getRegionSync,
  getRegionByIdSync,
  ensureRegionById,
  sampleRegionByte,
} from './bortleRegions.js';

/* Bortle heatmap as a Leaflet tile layer. Tiles (256px) are rendered on
   demand at the map's zoom: each pixel samples the 20km Web-Mercator coarse
   grid and, where they exist, the 4km fine patches, from lazy-loaded regional
   files. The grid is defined in Web-Mercator meters, so cells are square on
   the map (no latitude-dependent stretching). Colors follow the same Bortle
   class breaks the point estimates use. Class 1 (pristine) is fully
   transparent so the dark basemap shows through; intensity builds to a
   near-white hot core at class 9. Unknown cells stay transparent. */

const RAMP = {
  1: [0, 0, 0, 0],
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

/* Bilinearly sample the fine patch at (xM, yM) meters, or null if no patch.
   Returns a float byte value. Values are at cell centers (half-cell offset). */
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

  // Find regions, ensure they're loaded
  const rids = regionsForBounds(south, west, north, east);
  let allLoaded = true;
  const regions = new Map();
  for (const rid of rids) {
    // We need lat/lon to get the region; use the center
    const centerLat = (south + north) / 2;
    const centerLon = (west + east) / 2;
    // Actually, getRegionSync needs lat/lon; we'll use a representative point
    // For simplicity, ensure by rid directly via a helper
    // (We'll add a ensureRegionById to bortleRegions.js)
    const region = getRegionByIdSync(rid);
    if (region) {
      regions.set(rid, region);
    } else {
      allLoaded = false;
      ensureRegionById(rid);
    }
  }

  if (!allLoaded) {
    // Not all regions loaded yet; return false so caller can retry
    return false;
  }

  // Paint the tile with bilinear interpolation for smooth gradients.
  // Fine patches (4km) take precedence where available; coarse (20km) fills in.
  for (let j = 0; j < size; j++) {
    const yM = yTop - ((j + 0.5) / size) * tileSpan;
    const rowOff = j * size;
    for (let i = 0; i < size; i++) {
      const xM = xLeft + ((i + 0.5) / size) * tileSpan;
      const o = (rowOff + i) * 4;
      // Find the region for fine patch lookup
      const lat = mercToLat(yM);
      const lon = mercToLon(xM);
      const rid = regionIdFor(lat, lon);
      const region = rid ? regions.get(rid) : null;
      let q = null;
      if (region) {
        q = sampleFineBilinear(xM, yM, region);
      }
      if (q == null) {
        q = sampleCoarseBilinear(xM, yM, regions);
      }
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
  return true;
}

/* Leaflet tile layer for the heatmap. Handles async region loading by
   re-requesting tiles when their regions arrive. */
export function createBortleTileLayer(L) {
  const BortleTiles = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      const size = this.getTileSize();
      tile.width = size.x;
      tile.height = size.y;
      const painted = paintBortleTile(coords.x, coords.y, coords.z, tile);
      if (!painted) {
        // Regions are loading; when they arrive, redraw this tile
        // We'll use a simple approach: set a timeout to retry
        // (A more robust approach would subscribe to region load events)
        const layer = this;
        const retry = () => {
          const ok = paintBortleTile(coords.x, coords.y, coords.z, tile);
          if (ok) {
            done(null, tile);
          } else {
            setTimeout(retry, 200);
          }
        };
        setTimeout(retry, 200);
        // Return the (empty) tile immediately; done() will be called when painted
        return tile;
      }
      // Synchronous path: already painted
      if (done) done(null, tile);
      return tile;
    },
  });
  return new BortleTiles({
    tileSize: TILE_SIZE,
    maxZoom: TILE_MAX_ZOOM,
    opacity: 0.85,
    interactive: false,
    pane: 'overlayPane',
  });
}
