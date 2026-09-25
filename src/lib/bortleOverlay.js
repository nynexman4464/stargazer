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

  // Paint the tile
  // Cache the last used region to avoid repeated lookups
  let lastRid = null;
  let lastRegion = null;
  for (let j = 0; j < size; j++) {
    const yM = yTop - ((j + 0.5) / size) * tileSpan;
    const lat = mercToLat(yM);
    const rowOff = j * size;
    for (let i = 0; i < size; i++) {
      const xM = xLeft + ((i + 0.5) / size) * tileSpan;
      const lon = mercToLon(xM);
      const rid = regionIdFor(lat, lon);
      let region = null;
      if (rid === lastRid) {
        region = lastRegion;
      } else if (rid) {
        region = regions.get(rid) || getRegionByIdSync(rid);
        lastRid = rid;
        lastRegion = region;
      }
      const o = (rowOff + i) * 4;
      if (!region) {
        d[o + 3] = 0;
        continue;
      }
      const q = sampleRegionByte(region, lat, lon);
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
