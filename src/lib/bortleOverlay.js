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

// Byte value -> [r, g, b, a] as a flat Uint8Array, so the per-pixel loop is
// a few indexed reads with no allocation.
let _lut = null;
function colorLut() {
  if (!_lut) {
    const lut = new Uint8Array(256 * 4);
    for (let q = 0; q < 255; q++) {
      const [r, g, b, a] = RAMP[sqmToBortle(16 + q * 0.05)];
      const o = q * 4;
      lut[o] = r;
      lut[o + 1] = g;
      lut[o + 2] = b;
      lut[o + 3] = a;
    }
    _lut = lut; // q=255 stays [0,0,0,0]: transparent
  }
  return _lut;
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

/* Sample the SQM byte (0-254) at a lat/lon: fine patch first (bilinear over
   its 5x5 cells), falling back to coarse-grid bilinear. Returns 255 when
   the location has no coverage. */
function sampleBortleByte(lat, lon) {
  const g = BORTLE_GRID;
  const step = g.step;
  const cols = g.cols;
  const rows = g.rows;
  let c = Math.floor((lon - g.lonMin) / step);
  let r = Math.floor((g.latMax - lat) / step);
  if (c < 0 || c >= cols || r < 0 || r >= rows) return 255;

  const fp = finePatch();
  const pi = fp.map.get(r * cols + c);
  if (pi !== undefined) {
    const fper = fp.per;
    const fstep = fp.step;
    const flast = fper - 1;
    const latN = g.latMax - r * step;
    const lonW = g.lonMin + c * step;
    let fr = (latN - lat) / fstep - 0.5;
    let fc = (lon - lonW) / fstep - 0.5;
    fr = fr < 0 ? 0 : fr > flast ? flast : fr;
    fc = fc < 0 ? 0 : fc > flast ? flast : fc;
    const r0 = fr >= flast ? flast - 1 : Math.floor(fr);
    const c0 = fc >= flast ? flast - 1 : Math.floor(fc);
    const dr = fr - r0;
    const dc = fc - c0;
    const base = pi * fper * fper;
    const fb = fp.bytes;
    const q00 = fb[base + r0 * fper + c0];
    const q01 = fb[base + r0 * fper + c0 + 1];
    const q10 = fb[base + (r0 + 1) * fper + c0];
    const q11 = fb[base + (r0 + 1) * fper + c0 + 1];
    let num = 0;
    let den = 0;
    if (q00 !== 255) {
      const w = (1 - dr) * (1 - dc);
      num += q00 * w;
      den += w;
    }
    if (q01 !== 255) {
      const w = (1 - dr) * dc;
      num += q01 * w;
      den += w;
    }
    if (q10 !== 255) {
      const w = dr * (1 - dc);
      num += q10 * w;
      den += w;
    }
    if (q11 !== 255) {
      const w = dr * dc;
      num += q11 * w;
      den += w;
    }
    if (den > 0) return Math.round(num / den);
  }

  // Coarse grid, bilinear between cell centers.
  const bytes = gridBytes();
  const lastR = rows - 1;
  const lastC = cols - 1;
  let fr = (g.latMax - lat) / step - 0.5;
  let fc = (lon - g.lonMin) / step - 0.5;
  fr = fr < 0 ? 0 : fr > lastR ? lastR : fr;
  fc = fc < 0 ? 0 : fc > lastC ? lastC : fc;
  const r0 = fr >= lastR ? lastR - 1 : Math.floor(fr);
  const c0 = fc >= lastC ? lastC - 1 : Math.floor(fc);
  const dr = fr - r0;
  const dc = fc - c0;
  const q00 = bytes[r0 * cols + c0];
  const q01 = bytes[r0 * cols + c0 + 1];
  const q10 = bytes[(r0 + 1) * cols + c0];
  const q11 = bytes[(r0 + 1) * cols + c0 + 1];
  let num = 0;
  let den = 0;
  if (q00 !== 255) {
    const w = (1 - dr) * (1 - dc);
    num += q00 * w;
    den += w;
  }
  if (q01 !== 255) {
    const w = (1 - dr) * dc;
    num += q01 * w;
    den += w;
  }
  if (q10 !== 255) {
    const w = dr * (1 - dc);
    num += q10 * w;
    den += w;
  }
  if (q11 !== 255) {
    const w = dr * dc;
    num += q11 * w;
    den += w;
  }
  return den > 0 ? Math.round(num / den) : 255;
}

/* Paint one Web-Mercator tile (x, y, z) into the given square canvas. */
export function paintBortleTile(x, y, z, canvas) {
  const size = canvas.width;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const lut = colorLut();

  const n = 2 ** z;
  const lonWest = (x / n) * 360 - 180;
  const lonSpan = 360 / n;
  const yTop = Math.PI * MERC_R - (y / n) * 2 * Math.PI * MERC_R;
  const ySpan = (2 * Math.PI * MERC_R) / n;

  // Lat/lon at each pixel center; rows share a lat, columns share a lon.
  for (let j = 0; j < size; j++) {
    const lat = mercLat(yTop - ((j + 0.5) / size) * ySpan);
    const rowOff = j * size;
    for (let i = 0; i < size; i++) {
      const lon = lonWest + ((i + 0.5) / size) * lonSpan;
      const q = sampleBortleByte(lat, lon);
      const o = (rowOff + i) * 4;
      const lo = q * 4;
      d[o] = lut[lo];
      d[o + 1] = lut[lo + 1];
      d[o + 2] = lut[lo + 2];
      d[o + 3] = lut[lo + 3];
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
