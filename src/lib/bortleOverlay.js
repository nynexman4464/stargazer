import { BORTLE_GRID } from '../data/bortleGrid.js';
import { sqmToBortle } from './astro.js';

/* Render the bundled Bortle grid as a heatmap image for the Leaflet map.
   One column per 0.25-degree grid column; rows are remapped into
   Web-Mercator space (see below). Colors follow the same Bortle class
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

/* Leaflet's L.imageOverlay stretches its image linearly between the
   projected (Web-Mercator) corners of the lat/lon bounds — but the grid is
   linear in latitude, not in Mercator-y. Painting the grid rows 1:1 onto
   the canvas would render every city ~30 degrees too far north (Boston's
   glow lands past Hudson Bay; what shows over Boston is Venezuela).
   So each canvas row is placed by inverse-Mercator: canvas row j shows the
   grid row whose latitude sits at that row's Mercator position, exactly
   undoing Leaflet's stretch. Longitude is linear in both spaces, so columns
   map 1:1. Constants mirror Leaflet's SphericalMercator, clamp included. */
const MERC_R = 6378137;
const MERC_MAX_LAT = 85.0511287798;
function mercY(lat) {
  const c = Math.max(-MERC_MAX_LAT, Math.min(MERC_MAX_LAT, lat));
  const s = Math.sin((c * Math.PI) / 180);
  return (MERC_R * Math.log((1 + s) / (1 - s))) / 2;
}
function mercLat(y) {
  return ((2 * Math.atan(Math.exp(y / MERC_R)) - Math.PI / 2) * 180) / Math.PI;
}

const COLS = 1440;
const ROWS = 1160; // 2x the grid: keeps full 0.25-degree source detail at the equator

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

let _url = null;
/* Paint the grid once and return a data URL for L.imageOverlay. The ~1.7M
   pixel fill takes a fraction of a second; call it lazily on first toggle
   so it never slows the initial page load. */
export function bortleOverlayUrl() {
  if (_url) return _url;
  const g = BORTLE_GRID;
  const bytes = gridBytes();
  const lut = colorLut();
  const yNorth = mercY(g.latMax);
  const ySouth = mercY(g.latMax - g.rows * g.step);
  const canvas = document.createElement('canvas');
  canvas.width = COLS;
  canvas.height = ROWS;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(COLS, ROWS);
  const d = img.data;
  for (let j = 0; j < ROWS; j++) {
    // Source grid row for this canvas row, via inverse-Mercator.
    const y = yNorth - ((j + 0.5) / ROWS) * (yNorth - ySouth);
    const lat = mercLat(y);
    const srcRow = Math.max(
      0,
      Math.min(g.rows - 1, Math.round((g.latMax - lat) / g.step)),
    );
    const rowOff = srcRow * g.cols;
    const pxOff = j * COLS;
    for (let c = 0; c < COLS; c++) {
      const lo = bytes[rowOff + c] * 4;
      const o = (pxOff + c) * 4;
      d[o] = lut[lo];
      d[o + 1] = lut[lo + 1];
      d[o + 2] = lut[lo + 2];
      d[o + 3] = lut[lo + 3];
    }
  }
  ctx.putImageData(img, 0, 0);
  _url = canvas.toDataURL();
  return _url;
}
