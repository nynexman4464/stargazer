import { BORTLE_GRID } from '../data/bortleGrid.js';
import { BORTLE_FINE } from '../data/bortleFine.js';
import { sqmToBortle } from './astro.js';

/* Bortle heatmap as a Leaflet tile layer. Tiles (256px) are rendered on
   demand at the map's zoom: each pixel samples the coarse 25km Web-Mercator
   grid (bilinear) and, where they exist, the 5km fine patches. The grid is
   defined in Web-Mercator meters, so cells are square on the map (no
   latitude-dependent stretching). Colors follow the same Bortle class breaks
   the point estimates use. Class 1 (pristine) is fully transparent so the
   dark basemap shows through; intensity builds to a near-white hot core at
   class 9. Unknown cells stay transparent. */

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

function latLonToMerc(lat, lon) {
  const x = (lon * Math.PI) / 180 * MERC_R;
  const s = Math.sin((lat * Math.PI) / 180);
  // Clamp to avoid inf at poles
  const sc = Math.max(-0.9999999, Math.min(0.9999999, s));
  const y = (MERC_R * Math.log((1 + sc) / (1 - sc))) / 2;
  return { x, y };
}

function mercToLat(y) {
  return ((2 * Math.atan(Math.exp(y / MERC_R)) - Math.PI / 2) * 180) / Math.PI;
}

function mercToLon(x) {
  return (x / MERC_R) * 180 / Math.PI;
}

const TILE_SIZE = 256;
const TILE_MAX_ZOOM = 12;

let _bytes = null;
function gridBytes() {
  if (!_bytes) {
    const bin = atob(BORTLE_GRID.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    _bytes = bytes;
  }
  return _bytes;
}

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

/* Geographic bounds of the grid, as Leaflet [[south, west], [north, east]].
   Converts the Web-Mercator meter bounds back to lat/lon. */
export function bortleOverlayBounds() {
  const g = BORTLE_GRID;
  const yMin = g.yMax - g.rows * g.cellM;
  const xMax = g.xMin + g.cols * g.cellM;
  return [
    [mercToLat(yMin), mercToLon(g.xMin)],
    [mercToLat(g.yMax), mercToLon(xMax)],
  ];
}

/* Fine 5km patches (BORTLE_FINE), decoded lazily once. index holds
   uint32LE coarse keys (r*cols+c); data holds 25 SQM bytes per patch
   (255 = no coverage) in index order. */
let _fine = null;
function finePatch() {
  if (!_fine) {
    const f = BORTLE_FINE;
    const n = f.count;
    const idxBin = atob(f.index);
    const idxBytes = new Uint8Array(idxBin.length);
    for (let i = 0; i < idxBin.length; i++) idxBytes[i] = idxBin.charCodeAt(i);
    const keys = new Uint32Array(idxBytes.buffer); // little-endian, matches <u4
    const datBin = atob(f.data);
    const bytes = new Uint8Array(datBin.length);
    for (let i = 0; i < datBin.length; i++) bytes[i] = datBin.charCodeAt(i);
    const map = new Map();
    for (let i = 0; i < n; i++) map.set(keys[i], i);
    _fine = { per: f.per, cellM: f.cellM, map, bytes };
  }
  return _fine;
}

/* Sample the SQM byte (0-254) at fine-grid coordinates (frg, fcg in units
   of fine cells). Returns 255 when the location has no coverage.
   NOTE: No tent filter — the Web-Mercator grid has square cells, so there
   is no stripe artifact to suppress. The data is sampled as-is. */
function getFineCell(frg, fcg) {
  const g = BORTLE_GRID;
  const per = 5;
  const r = Math.floor(frg / per);
  const c = Math.floor(fcg / per);
  if (r < 0 || r >= g.rows || c < 0 || c >= g.cols) return 255;
  const pi = finePatch().map.get(r * g.cols + c);
  if (pi === undefined) return 255;
  const fr = Math.floor(frg - r * per);
  const fc = Math.floor(fcg - c * per);
  if (fr < 0 || fr >= per || fc < 0 || fc >= per) return 255;
  const bytes = finePatch().bytes;
  const q = bytes[pi * per * per + fr * per + fc];
  return q;
}

/* Sample the SQM byte at Web-Mercator meters (x, y). Fine patches first
   (bilinear over the 5km grid), falling back to coarse-grid bilinear.
   Returns 255 when the location has no coverage, or a float for smooth
   color interpolation. */
function sampleBortleByteMerc(x, y) {
  const g = BORTLE_GRID;
  const fCellM = BORTLE_FINE.cellM; // 5000

  // Fine: bilinear over 5km grid (cell centers on integers)
  const frg = (g.yMax - y) / fCellM - 0.5;
  const fcg = (x - g.xMin) / fCellM - 0.5;
  const fr0 = Math.floor(frg);
  const fc0 = Math.floor(fcg);
  const dr = frg - fr0;
  const dc = fcg - fc0;
  let num = 0;
  let den = 0;
  let hasFine = false;
  const q00 = getFineCell(fr0, fc0);
  if (q00 !== 255) {
    hasFine = true;
    const w = (1 - dr) * (1 - dc);
    num += q00 * w;
    den += w;
  }
  const q01 = getFineCell(fr0, fc0 + 1);
  if (q01 !== 255) {
    hasFine = true;
    const w = (1 - dr) * dc;
    num += q01 * w;
    den += w;
  }
  const q10 = getFineCell(fr0 + 1, fc0);
  if (q10 !== 255) {
    hasFine = true;
    const w = dr * (1 - dc);
    num += q10 * w;
    den += w;
  }
  const q11 = getFineCell(fr0 + 1, fc0 + 1);
  if (q11 !== 255) {
    hasFine = true;
    const w = dr * dc;
    num += q11 * w;
    den += w;
  }
  // In a patched region, fine is authoritative: if it says no data (water),
  // stay transparent rather than smearing the bright coarse mean over it.
  if (hasFine) return den > 0 ? num / den : 255;

  // Coarse grid, bilinear between cell centers (25km cells).
  const cellM = g.cellM;
  const cols = g.cols;
  const rows = g.rows;
  const bytes = gridBytes();
  const lastR = rows - 1;
  const lastC = cols - 1;
  let cr = (g.yMax - y) / cellM - 0.5;
  let cc = (x - g.xMin) / cellM - 0.5;
  cr = cr < 0 ? 0 : cr > lastR ? lastR : cr;
  cc = cc < 0 ? 0 : cc > lastC ? lastC : cc;
  const r0 = cr >= lastR ? lastR - 1 : Math.floor(cr);
  const c0 = cc >= lastC ? lastC - 1 : Math.floor(cc);
  const cdr = cr - r0;
  const cdc = cc - c0;
  const b00 = bytes[r0 * cols + c0];
  const b01 = bytes[r0 * cols + c0 + 1];
  const b10 = bytes[(r0 + 1) * cols + c0];
  const b11 = bytes[(r0 + 1) * cols + c0 + 1];
  let cnum = 0;
  let cden = 0;
  if (b00 !== 255) {
    const w = (1 - cdr) * (1 - cdc);
    cnum += b00 * w;
    cden += w;
  }
  if (b01 !== 255) {
    const w = (1 - cdr) * cdc;
    cnum += b01 * w;
    cden += w;
  }
  if (b10 !== 255) {
    const w = cdr * (1 - cdc);
    cnum += b10 * w;
    cden += w;
  }
  if (b11 !== 255) {
    const w = cdr * cdc;
    cnum += b11 * w;
    cden += w;
  }
  return cden > 0 ? cnum / cden : 255;
}

/* Sample the SQM byte at lat/lon (converts to Web-Mercator meters first).
   Used for point estimates (popups). For tile rendering, use
   sampleBortleByteMerc directly. */
function sampleBortleByte(lat, lon) {
  const { x, y } = latLonToMerc(lat, lon);
  return sampleBortleByteMerc(x, y);
}

/* Paint one Web-Mercator tile (x, y, z) into the given square canvas.
   Samples the grid directly in meters — no lat/lon conversion needed,
   since both the tile and the grid are in Web Mercator. */
export function paintBortleTile(x, y, z, canvas) {
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;

  const n = 2 ** z;
  const xLeft = (x / n) * MERC_WORLD - MERC_LIMIT;
  const yTop = MERC_LIMIT - (y / n) * MERC_WORLD;
  const tileSpan = MERC_WORLD / n;

  for (let j = 0; j < size; j++) {
    const yM = yTop - ((j + 0.5) / size) * tileSpan;
    const rowOff = j * size;
    for (let i = 0; i < size; i++) {
      const xM = xLeft + ((i + 0.5) / size) * tileSpan;
      const q = sampleBortleByteMerc(xM, yM);
      const o = (rowOff + i) * 4;
      if (q === 255) {
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
}

/* Leaflet tile layer for the heatmap. */
export function createBortleTileLayer(L) {
  const b = bortleOverlayBounds();
  const BortleTiles = L.GridLayer.extend({
    createTile(coords) {
      const tile = document.createElement('canvas');
      const size = this.getTileSize();
      tile.width = size.x;
      tile.height = size.y;
      paintBortleTile(coords.x, coords.y, coords.z, tile);
      return tile;
    },
  });
  return new BortleTiles({
    tileSize: TILE_SIZE,
    bounds: L.latLngBounds(b[0], b[1]),
    maxZoom: TILE_MAX_ZOOM,
    opacity: 0.85,
    interactive: false,
    pane: 'overlayPane',
  });
}

// Re-export for astro.js point estimates
export { sampleBortleByte, latLonToMerc };
