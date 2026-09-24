import { BORTLE_GRID } from '../data/bortleGrid.js';
import { BORTLE_FINE } from '../data/bortleFine.js';
import { sqmToBortle } from './astro.js';

/* Render the bundled Bortle grid as a heatmap image for the Leaflet map.
   Rendered at 2x the grid resolution with bilinear interpolation between
   cells, so the coarse 0.25-degree cells melt into smooth gradients instead
   of chunky squares. Rows are remapped into Web-Mercator space (see below);
   columns map 2:1. Colors follow the same Bortle class breaks the point
   estimates use. Class 1 (pristine) is fully transparent so the dark basemap
   shows through; intensity builds to a near-white hot core at class 9.
   Unknown cells stay transparent. */

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
   map uniformly. Constants mirror Leaflet's SphericalMercator, clamp
   included. */
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

const UPSCALE = 2; // render at 2x grid resolution for smooth gradients

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

let _url = null;
/* Paint the grid once and return a data URL for L.imageOverlay. The ~6.7M
   pixel bilinear fill takes on the order of a second; call it lazily on
   first toggle so it never slows the initial page load. */
export function bortleOverlayUrl() {
  if (_url) return _url;
  const g = BORTLE_GRID;
  const bytes = gridBytes();
  const lut = colorLut();
  const cols = g.cols;
  const rows = g.rows;
  const step = g.step;
  const latMax = g.latMax;
  const lastR = rows - 1;
  const lastC = cols - 1;
  const W = cols * UPSCALE;
  const H = 1160 * UPSCALE;
  const yNorth = mercY(g.latMax);
  const ySouth = mercY(g.latMax - rows * step);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let j = 0; j < H; j++) {
    // Canvas row center -> latitude, undoing Leaflet's Mercator stretch.
    const lat = mercLat(yNorth - ((j + 0.5) / H) * (yNorth - ySouth));
    // Fractional grid row, floor-aligned: cell r covers
    // [latMax-(r+1)*step, latMax-r*step), the same convention estimateBortle
    // uses. (Math.round here would shove every cell half a cell north.)
    let fr = (latMax - lat) / step - 0.5;
    fr = fr < 0 ? 0 : fr > lastR ? lastR : fr;
    const r0 = fr >= lastR ? lastR - 1 : Math.floor(fr);
    const dr = fr - r0;
    const wr0 = 1 - dr;
    const wr1 = dr;
    const ro0 = r0 * cols;
    const ro1 = ro0 + cols;
    const pxRow = j * W;
    for (let i = 0; i < W; i++) {
      // Longitude is linear in both spaces; at 2x, pixel centers fall on
      // quarter-cell points, so blend the two bracketing grid columns.
      let fc = i * 0.5 - 0.25;
      fc = fc < 0 ? 0 : fc > lastC ? lastC : fc;
      let c0 = Math.floor(fc);
      if (c0 >= lastC) c0 = lastC - 1;
      const dc = fc - c0;
      const c1 = c0 + 1;
      const wc0 = 1 - dc;
      const q00 = bytes[ro0 + c0];
      const q01 = bytes[ro0 + c1];
      const q10 = bytes[ro1 + c0];
      const q11 = bytes[ro1 + c1];
      // Bilinear blend over the known samples; unknown (255) cells are
      // skipped and the weights renormalized. All-unknown -> transparent.
      let num = 0;
      let den = 0;
      if (q00 !== 255) {
        const w = wr0 * wc0;
        num += q00 * w;
        den += w;
      }
      if (q01 !== 255) {
        const w = wr0 * dc;
        num += q01 * w;
        den += w;
      }
      if (q10 !== 255) {
        const w = wr1 * wc0;
        num += q10 * w;
        den += w;
      }
      if (q11 !== 255) {
        const w = wr1 * dc;
        num += q11 * w;
        den += w;
      }
      const o = (pxRow + i) * 4;
      if (den === 0) {
        d[o + 3] = 0;
      } else {
        const lo = Math.round(num / den) * 4;
        d[o] = lut[lo];
        d[o + 1] = lut[lo + 1];
        d[o + 2] = lut[lo + 2];
        d[o + 3] = lut[lo + 3];
      }
    }
  }
  /* Fine patches: repaint each patched coarse cell from its 5x5 fine cells
     with bilinear sampling (clamped at patch edges), same class colors.
     Only each patch's small canvas rect is touched, so this stays cheap.
     All-unknown fine neighborhoods keep the coarse pixel already painted. */
  const fp = finePatch();
  const fper = fp.per;
  const fstep = fp.step;
  const flast = fper - 1;
  const lonSpan = cols * step;
  for (const [key, pi] of fp.map) {
    const r = Math.floor(key / cols);
    const c = key % cols;
    const latN = latMax - r * step;
    const lonW = g.lonMin + c * step;
    // Exact integer canvas bounds for this coarse cell: each cell is
    // UPSCALE px wide, so cells never overlap (FP floor/ceil on the
    // fractional bounds could bleed a pixel into the neighbor, letting a
    // later patch overwrite with clamped edge values).
    const ix0 = c * UPSCALE;
    const ix1 = (c + 1) * UPSCALE - 1;
    const jy0 = Math.max(0, Math.floor(((yNorth - mercY(latN)) / (yNorth - ySouth)) * H));
    const jy1 = Math.min(H - 1, Math.floor(((yNorth - mercY(latN - step)) / (yNorth - ySouth)) * H));
    const base = pi * fper * fper;
    const fb = fp.bytes;
    for (let j = jy0; j <= jy1; j++) {
      const lat = mercLat(yNorth - ((j + 0.5) / H) * (yNorth - ySouth));
      let fr = (latN - lat) / fstep - 0.5;
      fr = fr < 0 ? 0 : fr > flast ? flast : fr;
      const r0 = fr >= flast ? flast - 1 : Math.floor(fr);
      const dr = fr - r0;
      const wr0 = 1 - dr;
      const fr0 = base + r0 * fper;
      const fr1 = fr0 + fper;
      const pxRow = j * W;
      for (let i = ix0; i <= ix1; i++) {
        const lon = g.lonMin + ((i + 0.5) / W) * lonSpan;
        let fc = (lon - lonW) / fstep - 0.5;
        fc = fc < 0 ? 0 : fc > flast ? flast : fc;
        let c0 = Math.floor(fc);
        if (c0 >= flast) c0 = flast - 1;
        const dc = fc - c0;
        const wc0 = 1 - dc;
        const q00 = fb[fr0 + c0];
        const q01 = fb[fr0 + c0 + 1];
        const q10 = fb[fr1 + c0];
        const q11 = fb[fr1 + c0 + 1];
        let num = 0;
        let den = 0;
        if (q00 !== 255) {
          const w = wr0 * wc0;
          num += q00 * w;
          den += w;
        }
        if (q01 !== 255) {
          const w = wr0 * dc;
          num += q01 * w;
          den += w;
        }
        if (q10 !== 255) {
          const w = dr * wc0;
          num += q10 * w;
          den += w;
        }
        if (q11 !== 255) {
          const w = dr * dc;
          num += q11 * w;
          den += w;
        }
        if (den > 0) {
          const lo = Math.round(num / den) * 4;
          const o = (pxRow + i) * 4;
          d[o] = lut[lo];
          d[o + 1] = lut[lo + 1];
          d[o + 2] = lut[lo + 2];
          d[o + 3] = lut[lo + 3];
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  _url = canvas.toDataURL();
  return _url;
}
