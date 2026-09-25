import { BORTLE_GRID } from '../data/bortleGrid.js';
import { BORTLE_FINE } from '../data/bortleFine.js';
import { sqmToBortle } from './astro.js';

/* Bortle heatmap as a Leaflet tile layer. Tiles (256px) are rendered on
   demand at the map's zoom: each pixel samples the coarse 0.25-degree grid
   (bilinear) and, where they exist, the 0.05-degree fine patches. Zooming
   in reveals true fine detail instead of a smeared global image, and only
   the visible viewport is ever painted. Colors follow the same Bortle class
   breaks the point estimates use. Class 1 (pristine) is fully transparent
   so the dark basemap shows through; intensity builds to a near-white hot
   core at class 9. Unknown cells stay transparent. */

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
function mercLat(y) {
  return ((2 * Math.atan(Math.exp(y / MERC_R)) - Math.PI / 2) * 180) / Math.PI;
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

/* Geographic bounds of the grid, as Leaflet [[south, west], [north, east]]. */
export function bortleOverlayBounds() {
  const g = BORTLE_GRID;
  return [
    [g.latMax - g.rows * g.step, g.lonMin],
    [g.latMax, g.lonMin + g.cols * g.step],
  ];
}

/* Fine 0.05-degree patches (BORTLE_FINE), decoded lazily once. index holds
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
    _fine = { per: f.per, step: f.step, map, bytes };
  }
  return _fine;
}

/* Sample the SQM byte (0-254) at a lat/lon: fine patches first (bilinear
   over the global 0.05-degree grid, blending across patch boundaries),
   falling back to coarse-grid bilinear. Returns 255 when the location has
   no coverage. */
function getFineCell(frg, fcg) {
  const g = BORTLE_GRID;
  const per = 5;
  const r = Math.floor(frg / per);
  const c = Math.floor(fcg / per);
  if (r < 0 || r >= g.rows || c < 0 || c >= g.cols) return 255;
  const pi = finePatch().map.get(r * g.cols + c);
  if (pi === undefined) return 255;
  const fr = frg - r * per;
  const fc = fcg - c * per;
  if (fr < 0 || fr >= per || fc < 0 || fc >= per) return 255;
  // 3x3 tent filter to suppress single-cell spikes (e.g. one very bright
  // 0.05-degree cell creating a sharp white stripe). Center weight 6,
  // edge weight 2, corner weight 1 — preserves the bright core while
  // softening outliers. Missing cells (255) are skipped and the blend
  // renormalizes.
  const bytes = finePatch().bytes;
  const base = pi * per * per;
  let num = 0;
  let den = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const nr = fr + dr;
      const nc = fc + dc;
      if (nr < 0 || nr >= per || nc < 0 || nc >= per) continue;
      const q = bytes[base + nr * per + nc];
      if (q === 255) continue;
      const w = dr === 0 && dc === 0 ? 6 : dr === 0 || dc === 0 ? 2 : 1;
      num += q * w;
      den += w;
    }
  }
  return den > 0 ? num / den : 255;
}

function sampleBortleByte(lat, lon) {
  const g = BORTLE_GRID;
  const fstep = 0.05;

  // Fine: bilinear over global 0.05-degree coordinates (cell centers on
  // integers). Neighbors may live in adjacent patches; missing cells (255)
  // are skipped and the blend renormalizes. Returns a float for smooth
  // color interpolation (255 = no coverage).
  const frg = (g.latMax - lat) / fstep - 0.5;
  const fcg = (lon - g.lonMin) / fstep - 0.5;
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

  // Coarse grid, bilinear between cell centers.
  const step = g.step;
  const cols = g.cols;
  const rows = g.rows;
  const bytes = gridBytes();
  const lastR = rows - 1;
  const lastC = cols - 1;
  let cr = (g.latMax - lat) / step - 0.5;
  let cc = (lon - g.lonMin) / step - 0.5;
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

/* Paint one Web-Mercator tile (x, y, z) into the given square canvas. */
export function paintBortleTile(x, y, z, canvas) {
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;

  const n = 2 ** z;
  const lonWest = (x / n) * 360 - 180;
  const lonSpan = 360 / n;
  const yTop = Math.PI * MERC_R - (y / n) * 2 * Math.PI * MERC_R;
  const ySpan = (2 * Math.PI * MERC_R) / n;

  // Lat/lon at each pixel center; rows share a lat, columns share a lon.
  // Colors are smoothly interpolated (not quantized) so class boundaries
  // render as gradients, not sharp stripes.
  for (let j = 0; j < size; j++) {
    const lat = mercLat(yTop - ((j + 0.5) / size) * ySpan);
    const rowOff = j * size;
    for (let i = 0; i < size; i++) {
      const lon = lonWest + ((i + 0.5) / size) * lonSpan;
      const q = sampleBortleByte(lat, lon);
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
