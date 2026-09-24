import { BORTLE_GRID } from '../data/bortleGrid.js';
import { sqmToBortle } from './astro.js';

/* Render the bundled Bortle grid as a heatmap image for the Leaflet map.
   One pixel per 0.25-degree cell (1440x580), colored by Bortle class with
   the same class breaks the point estimates use. Class 1 (pristine) is
   fully transparent so the dark basemap shows through; intensity builds
   to a near-white hot core at class 9. Unknown cells stay transparent. */

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

/* Geographic bounds of the grid, as Leaflet [[south, west], [north, east]]. */
export function bortleOverlayBounds() {
  const g = BORTLE_GRID;
  return [
    [g.latMax - g.rows * g.step, g.lonMin],
    [g.latMax, g.lonMin + g.cols * g.step],
  ];
}

let _url = null;
/* Paint the grid once and return a data URL for L.imageOverlay. The ~835k
   pixel fill takes well under a second; call it lazily on first toggle so
   it never slows the initial page load. */
export function bortleOverlayUrl() {
  if (_url) return _url;
  const g = BORTLE_GRID;
  const bytes = gridBytes();
  const canvas = document.createElement('canvas');
  canvas.width = g.cols;
  canvas.height = g.rows;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(g.cols, g.rows);
  const d = img.data;
  for (let i = 0; i < bytes.length; i++) {
    const q = bytes[i];
    const o = i * 4;
    if (q === 255) continue; // unknown: stays transparent
    const [r, gg, b, a] = RAMP[sqmToBortle(16 + q * 0.05)];
    d[o] = r;
    d[o + 1] = gg;
    d[o + 2] = b;
    d[o + 3] = a;
  }
  ctx.putImageData(img, 0, 0);
  _url = canvas.toDataURL();
  return _url;
}
