/* 1km Bortle grid loader (DreamHost MySQL backend).
 *
 * The 1km grid lives in MySQL as binary chunks served by api/bortle.php.
 * This module fetches a region's chunks, decodes them, and samples them
 * with the same bilinear logic as the 4km fine patches. It is an optional
 * refinement layer: 1km -> 4km fine -> coarse.
 *
 * Chunk binary format (little-endian, see make_1km.py):
 *   [magic 4s='B1K1'][ver u32][per u32=20][cellM u32=1000][count u32]
 *   [index: count x u32 global coarse keys][data: count*400 u8 quant bytes]
 * Quant byte: round((sqm-16)/0.05); 255 = no data.
 *
 * API base defaults to same-origin /api/bortle.php; override with
 * window.BORTLE_1KM_API (e.g. a DreamHost URL) before import.
 */

import { regionIdFor, getRegionSync, ensureRegion } from './bortleRegions.js';

const PER = 20; // 1km cells per 20km coarse cell
const CELL_M = 1000;
const MERC_R = 6378137;

function apiBase() {
  if (typeof window !== 'undefined' && window.BORTLE_1KM_API) {
    return window.BORTLE_1KM_API;
  }
  return '/api/bortle.php';
}

function mercToLat(y) {
  return ((2 * Math.atan(Math.exp(y / MERC_R)) - Math.PI / 2) * 180) / Math.PI;
}
function mercToLon(x) {
  return (x / MERC_R) * 180 / Math.PI;
}
function latLonToMerc(lat, lon) {
  const x = (lon * Math.PI) / 180 * MERC_R;
  const s = Math.sin((lat * Math.PI) / 180);
  const sc = Math.max(-0.9999999, Math.min(0.9999999, s));
  const y = (MERC_R * Math.log((1 + sc) / (1 - sc))) / 2;
  return [x, y];
}

// ---- manifest (fetched once) ----
let _manifestPromise = null;
function fetchManifest() {
  if (!_manifestPromise) {
    _manifestPromise = fetch(`${apiBase()}?manifest=1`)
      .then((r) => {
        if (!r.ok) throw new Error(`manifest ${r.status}`);
        return r.json();
      })
      .catch(() => null);
  }
  return _manifestPromise;
}

// ---- per-region cache: rid -> {per, cellM, map, bytes} or Promise ----
const _cache = new Map();

function decodeChunk(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(
    dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'B1K1') throw new Error('bad chunk magic');
  const per = dv.getUint32(8, true);
  const cellM = dv.getUint32(12, true);
  const count = dv.getUint32(16, true);
  if (per !== PER || cellM !== CELL_M) throw new Error('bad chunk geometry');
  const keys = new Uint32Array(buf, 20, count);
  const data = new Uint8Array(buf, 20 + count * 4, count * PER * PER);
  const map = new Map();
  for (let i = 0; i < count; i++) map.set(keys[i], i);
  return { per, cellM, map, bytes: data };
}

/* Ensure the 1km data for a region is loaded. Resolves to the decoded
   region {per, cellM, map, bytes}, or null when unavailable. Never throws;
   failures fall back to 4km. */
export function ensure1kmRegion(rid) {
  const cached = _cache.get(rid);
  if (cached) return cached instanceof Promise ? cached : Promise.resolve(cached);

  const promise = (async () => {
    try {
      const manifest = await fetchManifest();
      const reg = manifest?.regions?.[rid];
      if (!reg || !reg.chunks?.length) return null;
      const parts = [];
      for (const ch of reg.chunks) {
        const url = `${apiBase()}?region=${encodeURIComponent(ch.id)}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`chunk ${ch.id} ${r.status}`);
        parts.push(decodeChunk(await r.arrayBuffer()));
      }
      // Merge chunks into one map+bytes (keys are unique across chunks)
      const map = new Map();
      let total = 0;
      for (const p of parts) total += p.map.size;
      const bytes = new Uint8Array(total * PER * PER);
      let pi = 0;
      for (const p of parts) {
        for (const [key, idx] of p.map) {
          map.set(key, pi);
          bytes.set(p.bytes.subarray(idx * PER * PER, (idx + 1) * PER * PER),
                    pi * PER * PER);
          pi++;
        }
      }
      const region = { per: PER, cellM: CELL_M, map, bytes };
      _cache.set(rid, region);
      return region;
    } catch {
      _cache.delete(rid);
      return null;
    }
  })();
  _cache.set(rid, promise);
  return promise;
}

export function get1kmRegionSync(rid) {
  const c = _cache.get(rid);
  return c instanceof Promise || !c ? null : c;
}

/* Preload 1km data for all regions intersecting a lat/lon bbox. */
export function preload1kmForBounds(south, west, north, east) {
  const pad = 0.5;
  const s = south - pad, n = north + pad, w = west - pad, e = east + pad;
  const rids = new Set();
  // Sample the bbox corners/center to find regions (regions are large)
  for (const lat of [s, (s + n) / 2, n]) {
    for (const lon of [w, (w + e) / 2, e]) {
      const rid = regionIdFor(lat, lon);
      if (rid) rids.add(rid);
    }
  }
  return Promise.all([...rids].map((rid) => ensure1kmRegion(rid).catch(() => null)));
}

// ---- sampling ----

/* Bilinear 1km sample at Web-Mercator meters. Returns a quant byte or null.
   Uses the sync cache; call ensure1kmRegion/preload first. Falls back to null
   (caller tries 4km) when 1km data isn't loaded. Crosses region boundaries
   like the 4km sampler. */
export function sample1kmBilinear(xM, yM) {
  const lat = mercToLat(yM);
  const lon = mercToLon(xM);
  const rid = regionIdFor(lat, lon);
  if (!rid) return null;
  const reg4 = getRegionSync(lat, lon);
  if (!reg4) return null;
  const { coarse } = reg4;

  const fm = CELL_M;
  const per = PER;
  const flc = (xM - coarse.xMin) / fm;
  const flr = (coarse.yMax - yM) / fm;
  const frg = flr - 0.5;
  const fcg = flc - 0.5;
  const fr0 = Math.floor(frg);
  const fc0 = Math.floor(fcg);
  const dr = frg - fr0;
  const dc = fcg - fc0;

  // Global 1km coords (20 per coarse cell)
  const getCell = (fr, fc) => {
    const gfc = fc + coarse.c0 * per;
    const gfr = fr + coarse.r0 * per;
    const globalC = Math.floor(gfc / per);
    const globalR = Math.floor(gfr / per);
    const fkey = globalR * coarse.globalCols + globalC;
    for (const [, reg] of _cache) {
      if (reg instanceof Promise) continue;
      const pi = reg.map.get(fkey);
      if (pi !== undefined) {
        const pfc = gfc - globalC * per;
        const pfr = gfr - globalR * per;
        if (pfc < 0 || pfc >= per || pfr < 0 || pfr >= per) return null;
        const q = reg.bytes[pi * per * per + pfr * per + pfc];
        return q === 255 ? null : q;
      }
    }
    return null;
  };

  let num = 0, den = 0;
  const q00 = getCell(fr0, fc0);
  if (q00 != null) { const w = (1 - dr) * (1 - dc); num += q00 * w; den += w; }
  const q01 = getCell(fr0, fc0 + 1);
  if (q01 != null) { const w = (1 - dr) * dc; num += q01 * w; den += w; }
  const q10 = getCell(fr0 + 1, fc0);
  if (q10 != null) { const w = dr * (1 - dc); num += q10 * w; den += w; }
  const q11 = getCell(fr0 + 1, fc0 + 1);
  if (q11 != null) { const w = dr * dc; num += q11 * w; den += w; }
  return den > 0 ? num / den : null;
}

/* Point sample: 1km bilinear if loaded, else null. Nearest-cell (no
   interpolation) would also be fine for popups; bilinear matches the map. */
export function sample1kmByte(lat, lon) {
  const [xM, yM] = latLonToMerc(lat, lon);
  return sample1kmBilinear(xM, yM);
}

/* Async point sample: ensures both the 4km region (for coarse geometry)
   and the 1km region are loaded, then samples. Returns byte or null. */
export async function sample1kmByteAsync(lat, lon) {
  const rid = regionIdFor(lat, lon);
  if (!rid) return null;
  const [reg4] = await Promise.all([ensureRegion(lat, lon), ensure1kmRegion(rid)]);
  if (!reg4) return null;
  return sample1kmBilinear(...latLonToMerc(lat, lon));
}
