/* Lazy-loading Bortle grid regions.
 *
 * The Web-Mercator Bortle grid is split into 32 regions (8 lon bands x 4 lat
 * bands). Each region has a coarse grid file (~100KB) and a fine patches file
 * (0-450KB). Regions are loaded on demand via dynamic import() and cached.
 *
 * Region IDs: r{latIdx}{lonIdx}
 * - Lon bands (45°): [-180,-135], [-135,-90], [-90,-45], [-45,0], [0,45], [45,90], [90,135], [135,180]
 * - Lat bands: [40,85], [10,40], [-20,10], [-60,-20]
 */

const LON_BANDS = [-180, -135, -90, -45, 0, 45, 90, 135, 180];
const LAT_BANDS = [85, 40, 10, -20, -60]; // north to south

/* Map lat/lon to a region ID, or null if outside coverage. */
export function regionIdFor(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  // Normalize lon to [-180, 180]
  let ln = lon;
  while (ln < -180) ln += 360;
  while (ln > 180) ln -= 360;
  if (lat > 85 || lat < -60) return null;

  let lonIdx = -1;
  for (let i = 0; i < 8; i++) {
    if (ln >= LON_BANDS[i] && ln < LON_BANDS[i + 1]) {
      lonIdx = i;
      break;
    }
  }
  if (lonIdx === -1) {
    // Edge case: lon == 180
    if (ln === 180) lonIdx = 7;
    else return null;
  }

  let latIdx = -1;
  for (let i = 0; i < 4; i++) {
    if (lat <= LAT_BANDS[i] && lat > LAT_BANDS[i + 1]) {
      latIdx = i;
      break;
    }
  }
  if (latIdx === -1) return null;

  return `r${latIdx}${lonIdx}`;
}

// Cache: rid -> { coarse, fine } (decoded) or Promise (loading)
const _cache = new Map();
// Subscribers for when a region loads: rid -> Set<callback>
const _subscribers = new Map();

function decodeCoarse(mod, rid) {
  const key = `BORTLE_COARSE_${rid.toUpperCase()}`;
  const c = mod[key];
  const bin = atob(c.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return {
    id: rid,
    rows: c.rows,
    cols: c.cols,
    cellM: c.cellM,
    xMin: c.xMin,
    yMax: c.yMax,
    r0: c.r0,
    c0: c.c0,
    globalCols: c.globalCols,
    bytes,
  };
}

function decodeFine(mod, rid) {
  const key = `BORTLE_FINE_${rid.toUpperCase()}`;
  const f = mod[key];
  if (f.count === 0) {
    return { id: rid, count: 0, per: f.per, cellM: f.cellM, map: new Map(), bytes: new Uint8Array(0) };
  }
  const idxBin = atob(f.index);
  const idxBytes = new Uint8Array(idxBin.length);
  for (let i = 0; i < idxBin.length; i++) idxBytes[i] = idxBin.charCodeAt(i);
  const keys = new Uint32Array(idxBytes.buffer);
  const datBin = atob(f.data);
  const bytes = new Uint8Array(datBin.length);
  for (let i = 0; i < datBin.length; i++) bytes[i] = datBin.charCodeAt(i);
  const map = new Map();
  for (let i = 0; i < f.count; i++) map.set(keys[i], i);
  return { id: rid, count: f.count, per: f.per, cellM: f.cellM, map, bytes };
}

/* Ensure the region for lat/lon is loaded. Returns a promise that resolves
   to the decoded region { coarse, fine }, or null if outside coverage. */
export function ensureRegion(lat, lon) {
  const rid = regionIdFor(lat, lon);
  if (!rid) return Promise.resolve(null);

  const cached = _cache.get(rid);
  if (cached) {
    // Already loaded or loading
    return cached instanceof Promise ? cached : Promise.resolve(cached);
  }

  const promise = Promise.all([
    import(`../data/bortle/${rid}/coarse.js`),
    import(`../data/bortle/${rid}/fine.js`),
  ]).then(([coarseMod, fineMod]) => {
    const region = {
      coarse: decodeCoarse(coarseMod, rid),
      fine: decodeFine(fineMod, rid),
    };
    _cache.set(rid, region);
    // Notify subscribers
    const subs = _subscribers.get(rid);
    if (subs) {
      subs.forEach(cb => cb(region));
      _subscribers.delete(rid);
    }
    return region;
  }).catch(err => {
    _cache.delete(rid);
    throw err;
  });

  _cache.set(rid, promise);
  return promise;
}

/* Get a loaded region synchronously, or null if not yet loaded. */
export function getRegionSync(lat, lon) {
  const rid = regionIdFor(lat, lon);
  if (!rid) return null;
  const cached = _cache.get(rid);
  if (cached && !(cached instanceof Promise)) return cached;
  return null;
}

/* Subscribe to be notified when a region loads. Returns an unsubscribe fn. */
export function onRegionLoad(lat, lon, callback) {
  const rid = regionIdFor(lat, lon);
  if (!rid) return () => {};
  const region = getRegionSync(lat, lon);
  if (region) {
    // Already loaded, call immediately (async to be consistent)
    setTimeout(() => callback(region), 0);
    return () => {};
  }
  if (!_subscribers.has(rid)) _subscribers.set(rid, new Set());
  _subscribers.get(rid).add(callback);
  // Ensure it's loading
  ensureRegion(lat, lon);
  return () => {
    const subs = _subscribers.get(rid);
    if (subs) subs.delete(callback);
  };
}

/* Ensure a region is loaded by ID (for tile renderer which works in meters).
   Returns a promise that resolves to the decoded region. */
export function ensureRegionById(rid) {
  const cached = _cache.get(rid);
  if (cached) {
    return cached instanceof Promise ? cached : Promise.resolve(cached);
  }
  const promise = Promise.all([
    import(`../data/bortle/${rid}/coarse.js`),
    import(`../data/bortle/${rid}/fine.js`),
  ]).then(([coarseMod, fineMod]) => {
    const region = {
      coarse: decodeCoarse(coarseMod, rid),
      fine: decodeFine(fineMod, rid),
    };
    _cache.set(rid, region);
    const subs = _subscribers.get(rid);
    if (subs) {
      subs.forEach(cb => cb(region));
      _subscribers.delete(rid);
    }
    return region;
  }).catch(err => {
    _cache.delete(rid);
    throw err;
  });
  _cache.set(rid, promise);
  return promise;
}

/* Get a loaded region by ID synchronously, or null if not yet loaded. */
export function getRegionByIdSync(rid) {
  const cached = _cache.get(rid);
  if (cached && !(cached instanceof Promise)) return cached;
  return null;
}

/* Sample the SQM byte from a loaded region at lat/lon.
   Returns the byte (0-254), or null if no coverage. */
export function sampleRegionByte(region, lat, lon) {
  const { coarse, fine } = region;
  const MERC_R = 6378137;
  const x = (lon * Math.PI) / 180 * MERC_R;
  const s = Math.sin((lat * Math.PI) / 180);
  const sc = Math.max(-0.9999999, Math.min(0.9999999, s));
  const y = (MERC_R * Math.log((1 + sc) / (1 - sc))) / 2;

  // Fine patch lookup (global coarse coordinates)
  // Global col/row: need to map region-local to global
  // Region has r0, c0 (global offset), and globalCols for key calculation
  const globalC = Math.floor((x - coarse.xMin) / coarse.cellM) + coarse.c0;
  const globalR = Math.floor((coarse.yMax - y) / coarse.cellM) + coarse.r0;

  // Check if in region bounds
  const localC = globalC - coarse.c0;
  const localR = globalR - coarse.r0;
  if (localC < 0 || localC >= coarse.cols || localR < 0 || localR >= coarse.rows) {
    return null;
  }

  // Fine: global key = globalR * globalCols + globalC
  const per = fine.per;
  const fkey = globalR * coarse.globalCols + globalC;
  const pi = fine.map.get(fkey);
  if (pi !== undefined) {
    const cm = coarse.cellM;
    const fm = fine.cellM;
    // Fine cell within the patch
    // Coarse cell origin in meters: xMin + (globalC - c0)*cm? No...
    // Actually: coarse.xMin is region xMin. Global X of coarse cell (globalC):
    // X = XMIN_global + globalC * cm. We don't have XMIN_global here, but we have:
    // coarse.xMin = XMIN_global + coarse.c0 * cm
    // So X of cell globalC = coarse.xMin + (globalC - coarse.c0) * cm
    const cellX = coarse.xMin + (globalC - coarse.c0) * cm;
    const cellYTop = coarse.yMax - (globalR - coarse.r0) * cm;
    const fr = Math.floor((cellYTop - y) / fm);
    const fc = Math.floor((x - cellX) / fm);
    if (fr >= 0 && fr < per && fc >= 0 && fc < per) {
      const q = fine.bytes[pi * per * per + fr * per + fc];
      if (q !== 255) return q;
      // If fine says 255 (water), fall through to coarse? Or return null?
      // Original code: fine is authoritative, 255 means transparent.
      // For point estimates, 255 means "no data" -> fall back to coarse?
      // Actually in astro.js, sampleFineByte returns null for 255, then falls back to coarse.
      // Let's do the same: if fine cell is 255, try coarse.
    }
  }

  // Coarse fallback
  const q = coarse.bytes[localR * coarse.cols + localC];
  return q === 255 ? null : q;
}
