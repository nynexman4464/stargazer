/* STARGAZER — astronomy math, event engine, scoring. Pure logic, no JSX.
 * (Ported faithfully from the original vanilla app.js.) */
import {
  propagate,
  gstime,
  eciToEcf,
  ecfToLookAngles,
} from 'satellite.js';
import { BORTLE_GRID } from '../data/bortleGrid.js';
import { BORTLE_FINE } from '../data/bortleFine.js';

/* ============================== config ============================== */
export const DEFAULT_LOC = { name: 'Medford, MA', lat: 42.4184, lon: -71.1062 };
// Medford Bortle 8 inferred from Sky & Telescope zenith SQM in adjacent Arlington (17.9)
// and Cambridge (17.3-17.4) — no published Medford measurement. Only shown while home is Medford.
export const HOME_BORTLE = {
  value: '8',
  source:
    'Inferred from Sky & Telescope zenith SQM readings in adjacent Arlington and Cambridge; no Medford measurement published.',
};

/* Conventional SQM -> Bortle breakpoints (Wikipedia's Bortle scale table;
   the 8/9 split at 17.5 is the common converter approximation). Kept in one
   place so the satellite-grid estimate and any future use share it. */
const BORTLE_BREAKS = [
  [21.76, 1], [21.60, 2], [21.30, 3], [20.80, 4],
  [19.25, 5], [18.50, 6], [18.00, 7], [17.50, 8],
];
export function sqmToBortle(sqm) {
  for (const [edge, cls] of BORTLE_BREAKS) if (sqm >= edge) return cls;
  return 9;
}

/* Estimated Bortle class from the bundled Black Marble 2025 satellite grid.
   The grid stores zenith SQM as 0.05-mag bytes (255 = unknown); the byte is
   decoded lazily once. Returns { value, sqm, estimated: true, source }, or
   null when the coordinates fall outside the grid or on an unknown cell. */
let _gridBytes = null;
function gridBytes() {
  if (!_gridBytes) {
    const bin = atob(BORTLE_GRID.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    _gridBytes = bytes;
  }
  return _gridBytes;
}
/* Fine 0.05-degree Bortle patches (BORTLE_FINE): a 5x5 patch of fine cells for
   every coarse cell at SQM <= 21.0 (plus a 1-cell halo). The coarse grid
   fills in everywhere else. Decoded lazily once, like the coarse grid. */
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
/* Fine-patch SQM byte at lat/lon, or null when the coarse cell has no patch
   or the fine cell has no coverage (falls back to the coarse grid). */
function sampleFineByte(lat, lon) {
  const g = BORTLE_GRID;
  const c = Math.floor((lon - g.lonMin) / g.step);
  const r = Math.floor((g.latMax - lat) / g.step);
  if (c < 0 || c >= g.cols || r < 0 || r >= g.rows) return null;
  const f = finePatch();
  const pi = f.map.get(r * g.cols + c);
  if (pi === undefined) return null;
  const per = f.per;
  const st = f.step;
  const fr = Math.floor((g.latMax - r * g.step - lat) / st);
  const fc = Math.floor((lon - (g.lonMin + c * g.step)) / st);
  if (fr < 0 || fr >= per || fc < 0 || fc >= per) return null;
  const q = f.bytes[pi * per * per + fr * per + fc];
  return q === 255 ? null : q;
}
function bortleResult(q, source) {
  /* Classify from the exact stored quantum (16 + q*0.05), not the rounded
     display value: rounding 17.45 to 17.5 first would flip borderline cells
     a class brighter than the heatmap (which classifies exact bytes). */
  const sqmExact = 16 + q * 0.05;
  const sqm = Math.round(sqmExact * 100) / 100;
  return {
    value: String(sqmToBortle(sqmExact)),
    sqm,
    estimated: true,
    source: `${source || 'Estimated Bortle class from satellite data.'} A planning guide, not a measurement.`,
  };
}
export function estimateBortle(lat, lon) {
  const g = BORTLE_GRID;
  if (!g || !g.data || typeof lat !== 'number' || typeof lon !== 'number') return null;
  const fq = sampleFineByte(lat, lon);
  if (fq != null) return bortleResult(fq, g.source);
  const c = Math.floor((lon - g.lonMin) / g.step);
  const r = Math.floor((g.latMax - lat) / g.step);
  if (c < 0 || c >= g.cols || r < 0 || r >= g.rows) return null;
  const q = gridBytes()[r * g.cols + c];
  if (q === 255) return null;
  return bortleResult(q, g.source);
}

/* Short display label for a bortleForLoc result: 'Bortle 8', or
   'Est. Bortle 5' for satellite-grid estimates. Empty string when null. */
export function bortleLabel(b) {
  if (!b) return '';
  return `${b.estimated ? 'Est. ' : ''}Bortle ${b.value}`;
}

/* Bortle rating for a viewing location:
   - a dark-sky destination picked from the map carries its published rating
   - Medford (the default home) is Bortle 8, inferred from nearby SQM readings
   - anywhere else with grid coverage: estimated from the satellite grid
   Returns { value, source, estimated } or null when nothing is known. */
export function bortleForLoc(loc) {
  if (!loc) return null;
  if (loc.bortle) {
    return {
      value: loc.bortle,
      source: loc.bortleSource || 'Published Bortle rating for this dark-sky destination.',
      estimated: false,
    };
  }
  if (
    typeof loc.lat === 'number' &&
    haversine(loc.lat, loc.lon, DEFAULT_LOC.lat, DEFAULT_LOC.lon) < 10
  ) {
    return { ...HOME_BORTLE, estimated: false };
  }
  return estimateBortle(loc.lat, loc.lon);
}

/* A searched or map-picked place that lands on (or right next to) a certified
   dark-sky destination inherits that destination's published Bortle rating
   instead of the satellite-grid estimate, so "Glacier National Park" and the
   map's Glacier dot agree. haversine() returns miles. Sites come from
   public/data/darksky.json. */
export function matchDarkSkySite(lat, lon, name, sites) {
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Array.isArray(sites)) return null;
  const n = (name || '').toLowerCase();
  let best = null;
  let bestD = Infinity;
  for (const s of sites) {
    if (typeof s.lat !== 'number' || typeof s.lon !== 'number' || !s.bortle) continue;
    const d = haversine(lat, lon, s.lat, s.lon);
    const sn = s.name.toLowerCase();
    const nameHit = n.length > 3 && (n.includes(sn) || sn.includes(n));
    if ((nameHit && d <= 60) || d <= 15) {
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
  }
  return best;
}
export const SATS = [
  // mag: typical peak visual magnitude (lower = brighter). ISS can flare to
  // -5.9; Tiangong runs about -2 to -3; Hubble (~mag 1.5-3) is usually a
  // binocular target. Used for visibility scoring and shown on each pass.
  { norad: 25544, name: 'ISS', mag: -4 },
  { norad: 48274, name: 'Tiangong', mag: -2.5 },
  { norad: 20580, name: 'Hubble', mag: 2 },
];
export const TIER_META = {
  backyard: { label: 'Backyard', blurb: 'Step outside tonight.' },
  drive: { label: 'Dark-sky drive', blurb: 'Worth an hour in the car.' },
  expedition: { label: 'Expedition', blurb: 'Once in a decade. Book travel.' },
};
export const TYPE_META = {
  shower: { label: 'Showers', blurb: 'Meteor showers: bits of comet dust burning up. Best after midnight.' },
  eclipse: { label: 'Eclipses', blurb: 'Solar and lunar eclipses: shadows lining up between sun, Earth, and moon.' },
  planet: { label: 'Planets', blurb: 'Planets at their closest and brightest, or planets appearing close together in the sky.' },
  comet: { label: 'Comets', blurb: 'Visiting ice-balls from the outer solar system. Bright ones are rare.' },
};
export const RANGE_META = {
  '1m': { label: '1 mo', blurb: 'Next month' },
  '3m': { label: '3 mo', blurb: 'Next 3 months' },
  year: { label: 'This yr', blurb: 'Rest of this year' },
  nextyear: { label: 'Next yr', blurb: 'Next calendar year' },
  '5y': { label: '5 yrs', blurb: 'Next 5 years' },
  '10y': { label: '10 yrs', blurb: 'Next 10 years' },
  all: { label: 'All', blurb: 'Everything upcoming' },
};

/* Whether an event falls inside a time-range filter. 'year'/'nextyear' are
 * calendar years; the rest are windows from the reference point. Without an
 * anchor the reference is now and events are already future-filtered, so only
 * the upper bound (and next year's lower bound) matters. With a viewing-date
 * anchor, the windows rebase onto that day and events before it are cut. */
export function inTimeRange(ev, range, anchor) {
  const d = ev.date instanceof Date ? ev.date.getTime() : new Date(ev.date).getTime();
  const ref = anchor ? startOfDay(anchor) : new Date();
  if (anchor && d < ref.getTime()) return false;
  if (!range || range === 'all') return true;
  const t = ref.getTime();
  if (range === '1m') return d <= t + 30 * DAY;
  if (range === '3m') return d <= t + 90 * DAY;
  if (range === 'year') return d <= new Date(ref.getFullYear(), 11, 31, 23, 59, 59).getTime();
  if (range === 'nextyear') {
    const y = ref.getFullYear() + 1;
    return d >= new Date(y, 0, 1).getTime() && d <= new Date(y, 11, 31, 23, 59, 59).getTime();
  }
  if (range === '5y' || range === '10y') {
    const end = new Date(ref);
    end.setFullYear(end.getFullYear() + (range === '5y' ? 5 : 10));
    return d <= end.getTime();
  }
  return true;
}

/* Illustration for an event card / hero: per-planet portraits for planet
 * Event art uses real NASA public-domain photos (see README > Imagery), not AI art.
 * events (first planet named in the title), sun/moon for eclipses, a meteor
 * for showers, a comet for comets. Returns a public/ path or null. */
const EVENT_PLANETS = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
export function eventImage(ev) {
  if (!ev) return null;
  if (ev.type === 'planet') {
    const t = (ev.title || '').toLowerCase();
    const p = EVENT_PLANETS.find((name) => t.includes(name));
    return p ? `/img/events/${p}.jpg` : null;
  }
  if (ev.type === 'eclipse') return ev.solar ? '/img/events/sun.jpg' : '/img/events/moon.jpg';
  if (ev.type === 'shower') return '/img/events/meteor.jpg';
  if (ev.type === 'comet') return '/img/events/comet.jpg';
  return null;
}
export const GLOSSARY = [
  ['Bortle scale', '1-to-9 rating of light pollution. 1 is pristine desert darkness, 9 is downtown. Lower means darker.'],
  ['Magnitude', 'How bright something looks — and it\u2019s backwards: lower (or negative) means brighter. Venus is about \u22124; the faintest stars most people can see are around 6.'],
  ['Opposition', 'A planet sits opposite the sun in our sky — so it\u2019s at its closest, brightest, and up all night. The best time to look at it.'],
  ['Conjunction', 'Two planets (or the moon and a planet) appear close together in the sky. Just a line-of-sight thing — they\u2019re still millions of miles apart.'],
  ['Perihelion', 'When a comet is closest to the sun. Usually its brightest moment — unless it\u2019s so close to the sun we can\u2019t see it at all.'],
  ['Eclipse kinds', 'The labels the app uses. Faint: the moon only skims Earth\u2019s outer shadow \u2014 just a subtle smudge of shading, the least dramatic kind. Partial: part of the moon or sun goes dark, like a bite taken out. Total: the whole moon turns red, or the sun is completely covered. Ring-of-fire: the moon lines up with the sun but is too far away to cover it fully, leaving a bright ring.'],
  ['Radiant', 'The patch of sky meteors appear to fly out from during a shower. Named after its constellation — Perseids radiate from Perseus.'],
  ['Go score', 'Our 0\u2013100 \u201cshould you go outside\u201d rating, built from cloud cover, moonlight, and how special the event is.'],
  ['Visibility score', 'The 0\u2013100 number on each planet row: how well that planet shows from your spot that night. Built from how high it climbs while the sky is dark, how bright it is, moonlight, and the cloud forecast. 78+ is Great, 55+ is Fair, below that is Poor.'],
  ['Kp index', '0-to-9 scale of geomagnetic storm strength. Higher numbers mean the aurora reaches further from the poles.'],
];

/* ============================== location storage ============================== */
const hasStorage = () => typeof localStorage !== 'undefined';
export function loadLoc() {
  try {
    const s = JSON.parse(localStorage.getItem('stargazer.loc'));
    if (s && typeof s.lat === 'number') return s;
  } catch {}
  return { ...DEFAULT_LOC };
}
export function saveLoc(loc) {
  if (hasStorage()) localStorage.setItem('stargazer.loc', JSON.stringify(loc));
}
export function loadHome() {
  try {
    const s = JSON.parse(localStorage.getItem('stargazer.home'));
    if (s && typeof s.lat === 'number') return s;
  } catch {}
  return { ...DEFAULT_LOC };
}
export function saveHome(home) {
  if (hasStorage()) localStorage.setItem('stargazer.home', JSON.stringify(home));
}
/* Last away spot, so the location menu can flip back to it after a trip home. */
export function loadLastAway() {
  try {
    const s = JSON.parse(localStorage.getItem('stargazer.away'));
    if (s && typeof s.lat === 'number') return s;
  } catch {}
  return null;
}
export function saveLastAway(loc) {
  if (hasStorage()) localStorage.setItem('stargazer.away', JSON.stringify(loc));
}
export function isAway(loc, home) {
  return haversine(home.lat, home.lon, loc.lat, loc.lon) > 50;
}

/* ============================== astronomy utils ============================== */
export const RAD = Math.PI / 180;
export const DAY = 86400000;

export function moonIllum(date) {
  const synodic = 29.53058867;
  const ref = Date.UTC(2000, 0, 6, 18, 14) / DAY;
  let age = (date.getTime() / DAY - ref) % synodic;
  if (age < 0) age += synodic;
  return (1 - Math.cos((2 * Math.PI * age) / synodic)) / 2;
}
export function moonName(illum) {
  if (illum < 0.06) return 'new moon';
  if (illum < 0.4) return 'crescent moon';
  if (illum < 0.6) return 'half moon';
  if (illum < 0.94) return 'gibbous moon';
  return 'full moon';
}

/* Moon phase as a 0–1 cycle (0 = new, 0.25 = first quarter, 0.5 = full, 0.75 = last quarter). */
export const SYNODIC_MONTH = 29.53058867;
const NEW_MOON_REF = Date.UTC(2000, 0, 6, 18, 14) / DAY; // a known new moon, in days
export function moonPhase(date) {
  let p = ((date.getTime() / DAY - NEW_MOON_REF) / SYNODIC_MONTH) % 1;
  if (p < 0) p += 1;
  return {
    phase: p,
    illum: (1 - Math.cos(2 * Math.PI * p)) / 2,
    age: p * SYNODIC_MONTH,
  };
}
const PHASE_NAMES = [
  'New Moon',
  'Waxing Crescent',
  'First Quarter',
  'Waxing Gibbous',
  'Full Moon',
  'Waning Gibbous',
  'Last Quarter',
  'Waning Crescent',
];
export function moonPhaseName(phase) {
  return PHASE_NAMES[Math.floor((((phase + 1 / 16) % 1) * 8)) % 8];
}
/* Next upcoming new / first-quarter / full / last-quarter moon. */
const MAJOR_PHASES = [
  { p: 0, name: 'New Moon' },
  { p: 0.25, name: 'First Quarter' },
  { p: 0.5, name: 'Full Moon' },
  { p: 0.75, name: 'Last Quarter' },
];
export function nextMoonPhase(date) {
  const { phase } = moonPhase(date);
  let best = null;
  for (const m of MAJOR_PHASES) {
    let dp = (m.p - phase) % 1;
    if (dp < 0) dp += 1;
    if (dp < 1e-4) continue; // we're in it right now — look ahead instead
    const days = dp * SYNODIC_MONTH;
    if (!best || days < best.inDays) {
      best = { name: m.name, phase: m.p, inDays: days, date: new Date(date.getTime() + days * DAY) };
    }
  }
  return best;
}
/* Traditional full-moon names. September/October honor the Harvest Moon rule:
   the full moon nearest the autumn equinox gets the name. */
const FULL_MOON_NAMES = [
  'Wolf Moon', 'Snow Moon', 'Worm Moon', 'Pink Moon', 'Flower Moon', 'Strawberry Moon',
  'Buck Moon', 'Sturgeon Moon', null, null, 'Beaver Moon', 'Cold Moon',
];
export function fullMoonName(fullMoonDate) {
  const m = fullMoonDate.getMonth();
  if (m !== 8 && m !== 9) return FULL_MOON_NAMES[m];
  const equinox = Date.UTC(fullMoonDate.getFullYear(), 8, 22, 12);
  const cands = [-1, 0, 1].map((k) => fullMoonDate.getTime() + k * SYNODIC_MONTH * DAY);
  const nearest = cands.reduce((a, b) =>
    Math.abs(a - equinox) < Math.abs(b - equinox) ? a : b,
  );
  const isHarvest = Math.abs(nearest - fullMoonDate.getTime()) < DAY;
  if (m === 8) return isHarvest ? 'Harvest Moon' : 'Corn Moon';
  return isHarvest ? 'Harvest Moon' : "Hunter's Moon";
}
/* Next full moon on/after the given date. */
export function nextFullMoon(date) {
  const { phase } = moonPhase(date);
  let dp = (0.5 - phase) % 1;
  if (dp < 0) dp += 1;
  return new Date(date.getTime() + dp * SYNODIC_MONTH * DAY);
}

/* Bundled realistic moon photo for a phase: Jay Tanner's 1-degree render set
   (CC BY-SA 3.0, via Wikimedia Commons), sampled every 10 degrees into
   public/img/moon/phase-000.jpg … phase-350.jpg. */
export function moonPhaseImage(phase) {
  const p = (((phase % 1) + 1) % 1) * 36;
  const deg = (Math.round(p) % 36) * 10;
  return `img/moon/phase-${String(deg).padStart(3, '0')}.jpg`;
}
/* solar position -> observer sun elevation in degrees */
export function sunElev(date, lat, lon) {
  const JD = date.getTime() / DAY + 2440587.5;
  const n = JD - 2451545.0;
  const L = (((280.46 + 0.9856474 * n) % 360) + 360) % 360;
  const g = (357.528 + 0.9856003 * n) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const RA = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const GMST = (((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24;
  const HA = ((((GMST + lon / 15) % 24) * 15 - RA / RAD) * RAD) ;
  const latR = lat * RAD;
  return (
    Math.asin(
      Math.sin(dec) * Math.sin(latR) +
        Math.cos(dec) * Math.cos(latR) * Math.cos(HA),
    ) / RAD
  );
}
/* unit vector toward the sun in ECF coords */
export function sunDirECF(date) {
  const JD = date.getTime() / DAY + 2440587.5;
  const n = JD - 2451545.0;
  const L = (((280.46 + 0.9856474 * n) % 360) + 360) % 360;
  const g = (357.528 + 0.9856003 * n) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const RA = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const GMST = ((((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24) / 24 * 2 * Math.PI;
  const x = Math.cos(dec) * Math.cos(RA);
  const y = Math.cos(dec) * Math.sin(RA);
  const z = Math.sin(dec);
  return {
    x: x * Math.cos(GMST) + y * Math.sin(GMST),
    y: -x * Math.sin(GMST) + y * Math.cos(GMST),
    z,
  };
}
export function compass(azDeg) {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16];
}
export function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
export function fmtDate(d) {
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
export function countdown(to) {
  const ms = to - Date.now();
  if (ms < 0) return 'now';
  const h = Math.floor(ms / 3600000);
  const d = Math.floor(h / 24);
  if (d >= 365) return `in ${Math.floor(d / 365)}y ${d % 365}d`;
  if (d > 1) return `in ${d}d ${h % 24}h`;
  if (h > 1) return `in ${h}h ${Math.floor(ms / 60000) % 60}m`;
  const m = Math.max(1, Math.floor(ms / 60000));
  return `in ${m}m`;
}
/* True when `to` is within the next 24 hours (or already started). */
export function isImminent(to) {
  return to - Date.now() < 24 * 3600 * 1000;
}
export function isoDay(d) {
  return (
    d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  );
}
/* Local-midnight start of the given day. */
export function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
export function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
export function haversine(lat1, lon1, lat2, lon2) {
  const dLa = (lat2 - lat1) * RAD;
  const dLo = (lon2 - lon1) * RAD;
  const a =
    Math.sin(dLa / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLo / 2) ** 2;
  return 2 * 3959 * Math.asin(Math.sqrt(a));
}

/* ============================== data loading ============================== */
export async function loadJSON(path) {
  try {
    const r = await fetch(path);
    if (!r.ok) throw 0;
    return await r.json();
  } catch {
    return null;
  }
}

/* TLE backend cache (AWS Lambda + S3, see cloudformation/tle-cache.yaml).
 * When set, the app fetches fresh TLEs from this endpoint at boot; the
 * bundled data/tles.json file remains the offline fallback. */
export const TLE_ENDPOINT = 'https://5qqsnsuufj6mxadrc4g67vqohe0vkkgg.lambda-url.us-east-1.on.aws/';

export async function loadTles(bundledPath) {
  if (TLE_ENDPOINT) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(TLE_ENDPOINT, { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) {
        const j = await r.json();
        if (j && j.tles && j.tles['25544'] && j.tles['48274'] && j.tles['20580']) return j;
      }
    } catch (e) {
      console.warn('TLE endpoint unreachable, using bundled file:', e?.message || e);
    }
  }
  return loadJSON(bundledPath);
}

const ECLIPSE_TYPE_PLAIN = {
  penumbral: 'Faint',
  partial: 'Partial',
  total: 'Total',
  annular: 'Ring-of-fire',
};

export function normalizeEvents(showers, eclipses, conjs, comets) {
  const out = [];
  const push = (e) => {
    const date = e.date instanceof Date ? e.date : new Date(e.date + 'T21:00:00');
    if (isNaN(date)) return;
    out.push({ ...e, date });
  };
  // meteor showers — all backyard events
  (showers?.events || []).forEach((s) =>
    push({
      ...s,
      kind: 'shower',
      type: 'shower',
      tier: 'backyard',
      title: `${s.name} meteor shower`,
      desc: [
        s.peak_night ? `Peak night ${s.peak_night}.` : '',
        s.rate ? `Rates: ${s.rate}.` : '',
        s.note || '',
        s.moon ? `Moon: ${s.moon}.` : '',
      ]
        .filter(Boolean)
        .join(' '),
    }),
  );
  // eclipses — show NE-visible ones plus total solar eclipses anywhere (expedition-worthy)
  const allEcl = [
    ...(eclipses?.solar || []).map((e) => ({ ...e, solar: true })),
    ...(eclipses?.lunar || []).map((e) => ({ ...e, solar: false })),
  ];
  allEcl.forEach((e) => {
    const ne = !!e.new_england;
    if (!ne && !(e.solar && e.type === 'total')) return; // not worth tracking
    const tier =
      e.solar && e.type === 'total'
        ? 'expedition'
        : !e.solar && e.type === 'total'
          ? 'drive'
          : 'backyard';
    push({
      ...e,
      kind: 'eclipse',
      type: 'eclipse',
      tier,
      // plain-language type names ("penumbral"/"annular" mean nothing to most people)
      title: `${ECLIPSE_TYPE_PLAIN[e.type] || cap(e.type)} ${e.solar ? 'solar' : 'lunar'} eclipse`,
      desc: [e.ne_note || '', e.regions ? `Where: ${e.regions}` : ''].filter(Boolean).join(' '),
    });
  });
  // planetary pairings & closest-approach nights — backyard
  (conjs?.events || []).forEach((c) =>
    push({ ...c, kind: c.kind, type: 'planet', tier: 'backyard', title: c.title, desc: c.detail }),
  );
  // comets — only credible prospects make the list; notes are honest about visibility
  (comets?.events || []).forEach((c) => {
    const per = new Date(c.perihelion + 'T12:00:00');
    push({
      ...c,
      kind: 'comet',
      type: 'comet',
      tier: 'backyard',
      title: isNaN(per) ? c.name : `${c.name} — closest to the sun ${fmtDate(per)}`,
      desc: [c.magnitude_peak ? `Peak magnitude ${c.magnitude_peak}.` : '', c.note || '']
        .filter(Boolean)
        .join(' '),
    });
  });
  // keep events whose night hasn't passed
  const now = Date.now() - DAY;
  return out.filter((e) => e.date.getTime() > now).sort((a, b) => a.date - b.date);
}

/* ============================== weather / scoring ============================== */
/* Fetch one day of hourly cloud cover from Open-Meteo, cached by day. */
async function hourlyCloud(dayKey, loc, cache) {
  if (cache[dayKey] !== undefined) return cache[dayKey];
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat.toFixed(3)}&longitude=${loc.lon.toFixed(3)}` +
      `&hourly=cloud_cover&start_date=${dayKey}&end_date=${dayKey}&timezone=auto`;
    const r = await fetch(url);
    const j = await r.json();
    const entry = { times: j.hourly.time, vals: j.hourly.cloud_cover };
    cache[dayKey] = entry;
    return entry;
  } catch {
    return null;
  }
}

export async function cloudCover(date, loc, cache) {
  const day = await hourlyCloud(isoDay(date), loc, cache);
  if (!day) return null;
  const { times, vals } = day;
  // prefer 10pm local, fall back to darkest hour available
  let best = vals[Math.floor(vals.length / 2)];
  let bestScore = 1e9;
  times.forEach((t, i) => {
    const hr = parseInt(t.slice(11, 13), 10);
    const dist = Math.min(Math.abs(hr - 22), 24 - Math.abs(hr - 22));
    if (dist < bestScore) {
      bestScore = dist;
      best = vals[i];
    }
  });
  return best;
}

/* Cloud cover at the hour nearest the given time, in the observer's timezone. */
export async function cloudCoverAt(date, loc, cache) {
  const off = await utcOffsetSeconds(loc);
  const shift = (off ?? 0) * 1000;
  // location-local day of the pass: shift the clock so UTC getters read the
  // observer's wall time (same trick as the aurora outlook)
  const d = new Date(date.getTime() + shift);
  const dayKey =
    d.getUTCFullYear() +
    '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getUTCDate()).padStart(2, '0');
  const day = await hourlyCloud(dayKey, loc, cache);
  if (!day) return null;
  // Open-Meteo hourly times are location wall-clock; parsing them as UTC puts
  // them on the same wall-clock scale as the shifted pass instant.
  const targetWall = date.getTime() + shift;
  let best = day.vals[0];
  let bestDiff = Infinity;
  day.times.forEach((t, i) => {
    const diff = Math.abs(Date.parse(t + 'Z') - targetWall);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = day.vals[i];
    }
  });
  return best;
}

/* Visibility score for a satellite pass (0-100): height in the sky, typical
   visual magnitude, and forecast cloud cover at pass time. */
export async function passScore(pass, mag, loc, cache) {
  const cloud = await cloudCoverAt(pass.maxT, loc, cache);
  const factors = [];
  let score = 50;
  // height in the sky
  const el = Math.round(pass.maxEl);
  if (pass.maxEl > 60) score += 22;
  else if (pass.maxEl > 35) score += 12;
  else if (pass.maxEl > 25) score += 4;
  else score -= 8;
  factors.push({ icon: 'angle', text: `peaks ${el}°` });
  // brightness (lower magnitude = brighter)
  if (mag <= -3) score += 14;
  else if (mag <= -1) score += 7;
  else if (mag <= 1) score -= 2;
  else score -= 10;
  factors.push({ icon: 'star', text: `magnitude ${mag > 0 ? '+' : ''}${mag}` });
  // predicted weather
  if (cloud === null) {
    factors.push({ icon: 'cloudOff', text: 'forecast unavailable' });
  } else {
    factors.push({ icon: 'cloud', text: `${cloud}% clouds` });
    if (cloud < 15) score += 14;
    else if (cloud < 40) score += 6;
    else if (cloud < 70) score -= 10;
    else score -= 22;
  }
  score = Math.max(5, Math.min(99, Math.round(score)));
  return { score, factors, label: score >= 75 ? 'Excellent' : score >= 55 ? 'Good' : 'Poor' };
}

/* Shared scoring core: cloud % (forecast or historical), exact moon math, and
   tier bonus. cloudText is the human-readable cloud factor line. */
/* Brightness bands shared by event go-scores and planet visibility: dimmer
   targets score lower. Bands assume suburban skies — about mag 4 is the
   naked-eye limit from a place like Medford. */
export function magBand(mag) {
  const magLabel = `magnitude ${mag}`;
  if (mag <= 4) {
    return {
      delta: 4,
      factor: { icon: 'eye', text: `${magLabel} — bright, an easy naked-eye target` },
    };
  }
  if (mag <= 6) {
    return {
      delta: -4,
      factor: {
        icon: 'eye',
        text: `${magLabel} — too faint for the naked eye from town; needs dark skies or binoculars`,
      },
    };
  }
  if (mag <= 10) {
    return {
      delta: -10,
      factor: { icon: 'telescope', text: `${magLabel} — needs binoculars or a telescope` },
    };
  }
  return {
    delta: -18,
    factor: { icon: 'telescope', text: `${magLabel} — telescope only` },
  };
}

function scoreCore(ev, cloud, cloudText) {
  const illum = moonIllum(ev.date);
  const BASE_SCORE = 55;
  let score = BASE_SCORE;
  const factors = [];
  /* Every factor records its point delta so the UI can render the full
     breakdown table (base score, weather +/-, ...). */
  const push = (icon, text, delta) => {
    factors.push({ icon, text, delta: delta || 0 });
    score += delta || 0;
  };
  if (cloud === null) {
    push('cloudOff', cloudText, 0);
  } else {
    let d = 0;
    if (cloud < 15) d = 28;
    else if (cloud < 40) d = 14;
    else if (cloud < 70) d = -8;
    else d = -28;
    push('cloud', cloudText, d);
  }
  const moonSensitive = ev.type === 'shower' || ev.type === 'comet';
  if (moonSensitive) {
    let d = 0;
    if (illum > 0.75) d = -20;
    else if (illum > 0.5) d = -10;
    else if (illum < 0.25) d = 6;
    push('moon', `${Math.round(illum * 100)}% ${moonName(illum)}`, d);
  }
  /* Brightness: a target you can't see with the naked eye from a lit backyard
     is a lesser candidate. ev.mag is the limiting magnitude (dimmest body
     that matters). */
  if (Number.isFinite(ev.mag)) {
    const mb = magBand(ev.mag);
    push(mb.factor.icon, mb.factor.text, mb.delta);
  }
  if (ev.tier === 'drive') push('car', 'Dark-sky drive — worth an hour in the car', 6);
  if (ev.tier === 'expedition') push('plane', 'Expedition — once in a decade, worth traveling for', 10);
  const raw = Math.round(score);
  score = Math.max(5, Math.min(99, raw));
  return {
    score,
    base: BASE_SCORE,
    factors,
    label: score >= 78 ? 'Go' : score >= 55 ? 'Maybe' : 'Risky',
  };
}

/* Expedition-tier events are total solar eclipses: only worth a go-score when
   the eclipse is at all visible (even partially) from the viewer's location.
   Each total solar eclipse record carries `vis`, a generous lat/lon bounding
   box covering the full partial-visibility zone (sources documented in the
   data file's _note). Missing data or location -> visible: a score is never
   hidden without evidence. */
export function eclipseVisibleFrom(ev, loc) {
  const vis = ev.vis;
  if (!vis || !loc || loc.lat == null || loc.lon == null) return true;
  return (
    loc.lat >= vis.lat[0] &&
    loc.lat <= vis.lat[1] &&
    loc.lon >= vis.lon[0] &&
    loc.lon <= vis.lon[1]
  );
}

export async function goScore(ev, loc, cache) {
  if (ev.tier === 'expedition' && !eclipseVisibleFrom(ev, loc)) return null;
  const daysOut = (ev.date - Date.now()) / DAY;
  if (daysOut > 15) return null; // beyond forecast range
  const cloud = await cloudCover(ev.date, loc, cache);
  return {
    ...scoreCore(ev, cloud, cloud === null ? 'forecast unavailable' : `${cloud}% clouds`),
    estimated: false,
  };
}

/* Estimated go-score for dates beyond the forecast range: the same scoring,
   but the cloud term comes from the 20-year historical climatology
   (loadCloudClimatology) instead of a forecast. The moon term is exact for
   any date. Returns { ...score, estimated: true } — callers must label it
   as an estimate, never as a forecast. */
export function estimatedGoScore(ev, climDaily, loc) {
  if (ev.tier === 'expedition' && !eclipseVisibleFrom(ev, loc)) return null;
  const cloud = typicalCloud(climDaily, ev.date);
  if (cloud === null) return null;
  return {
    ...scoreCore(ev, cloud, `historically ${cloud}% cloudy`),
    estimated: true,
  };
}

/* ============================== cloud climatology ============================== */
/* Historical "typical cloudiness" for dates beyond the ~15-day forecast.
   Open-Meteo's archive API (ERA5 reanalysis) gives daily mean cloud cover for
   2001–2020; we average by day-of-year with a ±7-day smoothing window, so each
   date gets an effectively weekly-granularity historical estimate. Same data
   provider as the app's forecasts. Cached in localStorage per location —
   the 20-year period is fixed, so the cache never goes stale.
   This is a historical estimate, never a forecast; callers must say so. */
const CLIM_START = '2001-01-01';
const CLIM_END = '2020-12-31';
const CLIM_SMOOTH_DAYS = 7;
const climMemCache = new Map();

function climKey(loc) {
  return `stargazer.clim.v1.${loc.lat.toFixed(2)}.${loc.lon.toFixed(2)}`;
}

function dayOfYear(y, m, d) {
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const ml = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let doy = d;
  for (let i = 0; i < m - 1; i++) doy += ml[i];
  return doy; // 1..366
}

/* Smoothed day-of-year climatology: array of 366 values (index 0 = Jan 1),
   each the mean daily cloud-cover % for that day ± CLIM_SMOOTH_DAYS across
   all 20 years. Null where the archive had no data. */
export async function loadCloudClimatology(loc) {
  const key = climKey(loc);
  if (climMemCache.has(key)) return climMemCache.get(key);
  try {
    const raw = hasStorage() && localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.daily) && parsed.daily.length === 366) {
        climMemCache.set(key, parsed.daily);
        return parsed.daily;
      }
    }
  } catch {
    /* corrupted cache — fall through to a fresh fetch */
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  let daily;
  try {
    const url =
      `https://archive-api.open-meteo.com/v1/archive?latitude=${loc.lat.toFixed(3)}` +
      `&longitude=${loc.lon.toFixed(3)}&start_date=${CLIM_START}&end_date=${CLIM_END}` +
      `&daily=cloud_cover_mean&timezone=auto`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`climatology fetch failed: ${res.status}`);
    const j = await res.json();
    const times = j?.daily?.time || [];
    const vals = j?.daily?.cloud_cover_mean || [];
    const buckets = Array.from({ length: 367 }, () => []);
    for (let i = 0; i < times.length; i++) {
      const v = vals[i];
      if (v == null) continue;
      const [y, m, d] = times[i].split('-').map(Number);
      buckets[dayOfYear(y, m, d)].push(v);
    }
    daily = [];
    for (let doy = 1; doy <= 366; doy++) {
      let sum = 0;
      let n = 0;
      for (let k = -CLIM_SMOOTH_DAYS; k <= CLIM_SMOOTH_DAYS; k++) {
        let q = doy + k;
        if (q < 1) q += 365;
        if (q > 366) q -= 365;
        for (const v of buckets[q]) {
          sum += v;
          n++;
        }
      }
      daily.push(n ? sum / n : null);
    }
  } finally {
    clearTimeout(timer);
  }
  try {
    if (hasStorage()) localStorage.setItem(key, JSON.stringify({ daily }));
  } catch {
    /* quota — the in-memory cache still covers this session */
  }
  climMemCache.set(key, daily);
  return daily;
}

/* Typical historical cloud-cover % for a date from a loaded climatology
   (see loadCloudClimatology). Returns a rounded 0–100 number, or null. */
export function typicalCloud(daily, date) {
  if (!daily) return null;
  const doy = dayOfYear(date.getFullYear(), date.getMonth() + 1, date.getDate());
  const v = daily[doy - 1];
  return v == null ? null : Math.round(v);
}

/* ============================== aurora ============================== */
/* Pure verdict builder — kp, ovation probability near observer, observer latitude.
 * Keeps the plain-language copy in one testable place. */
export function auroraVerdict(kp, prob, lat) {
  // Kp runs 0-9, a global gauge of geomagnetic activity.
  const kps = `Kp ${kp.toFixed(1)}`;
  // Southern-hemisphere observers get mirrored copy: the aurora's ring is
  // around the South Pole, storms pull it *up* toward the equator, and you
  // look south — not north.
  const south = lat < 0;
  const alat = Math.abs(lat);
  const pole = south ? 'South' : 'North';
  const polar = south ? 'Antarctica' : 'the Arctic';
  const towardYou = south ? 'up' : 'down';
  const lookDir = south ? 'south' : 'north';
  const lights = south ? 'southern lights' : 'northern lights';
  const farSide = south ? 'north' : 'south';
  let verdict, sub, band;
  if (alat >= 55) {
    // Auroral zone (e.g. Fairbanks, or Ushuaia down south): the observer
    // sits under the aurora's usual ring, so even modest activity can light
    // it up after dark.
    if (kp >= 4) {
      band = 'possible';
      verdict = `Good chance — look ${lookDir} after dark.`;
      sub = `${kps} is active, and you're right under the aurora's usual ring around the ${pole} Pole. If the sky is dark and clear, look ${lookDir}.`;
    } else if (kp >= 2) {
      band = 'quiet';
      verdict = 'Possible if the sky cooperates.';
      sub = `${kps} is middling. You're sitting under the aurora's usual ring, so even modest activity can light it up once it's properly dark.`;
    } else {
      band = 'quiet';
      verdict = 'Quiet for now.';
      sub = `${kps} — calm space weather, and the ring overhead is quiet. (Kp runs 0–9; this close to the pole, even a 2 or 3 can put on a show after dark.)`;
    }
  } else if (kp >= 7) {
    band = 'storm';
    verdict = 'Get outside — aurora likely visible from here.';
    sub = `${kps} is storm-level. The ${lights} can reach well ${farSide} of their usual ring tonight — look ${lookDir}, away from city lights.`;
  } else if (kp >= 5.5) {
    band = 'possible';
    verdict = `Possible — watch the ${lookDir}ern horizon.`;
    sub = `${kps}. Strong enough to drag the aurora's usual ring around the ${pole} Pole ${towardYou} toward you — you might catch a glow low in the ${lookDir} if skies are dark and clear.`;
  } else if (kp >= 4) {
    band = 'quiet';
    verdict = 'Quiet for now.';
    sub = `${kps}. The aurora is sticking to its usual ring around the ${pole} Pole. Check back when activity picks up.`;
  } else {
    band = 'quiet';
    verdict = 'Quiet for now.';
    sub = `${kps} — calm space weather. The aurora's ring is parked around ${polar}, far ${lookDir} of us. (Kp runs 0–9; about 5 is when it gets interesting this far ${farSide}.)`;
  }
  if (prob !== null && prob !== undefined && prob > 5) {
    sub += ` NOAA's model puts aurora probability near you at ~${Math.round(prob)}%.`;
  }
  if (alat < 40 && kp < 7) {
    band = 'south';
    verdict = south ? 'Too far north tonight.' : 'Too far south tonight.';
    sub = `${kps}. From here you'd need a serious storm (Kp 8+) to pull the aurora ${towardYou} this far.`;
  }
  return { verdict, sub, band };
}

/* Forecast-flavored aurora verdict for the Outlook rows. Phrased as a
 * prediction, never repeating the "right now" wording, and honest about why
 * a middling Kp number still means nothing for mid-latitudes. */
export function auroraOutlookVerdict(kp, lat) {
  const south = lat < 0;
  const alat = Math.abs(lat);
  const lookDir = south ? 'south' : 'north';
  const farSide = south ? 'north' : 'south';
  if (alat >= 55) {
    // Auroral zone: the observer sits under the aurora's usual ring.
    if (kp >= 4) return { verdict: `Good chance — look ${lookDir} after dark.`, band: 'possible' };
    if (kp >= 2) return { verdict: 'Possible if the sky cooperates.', band: 'quiet' };
    return { verdict: 'Nothing expected.', band: 'quiet' };
  }
  if (alat < 40) {
    if (kp >= 8)
      return {
        verdict: `Could reach this far ${farSide} — get outside.`,
        band: 'storm',
      };
    return { verdict: `Unlikely to reach this far ${farSide}.`, band: 'quiet' };
  }
  if (kp >= 7) return { verdict: 'Could reach us — get outside.', band: 'storm' };
  if (kp >= 5) return { verdict: `Might reach us — look ${lookDir}.`, band: 'possible' };
  if (kp >= 3) return { verdict: south ? 'Only visible down south.' : 'Only visible up north.', band: 'quiet' };
  return { verdict: 'Nothing expected for us.', band: 'quiet' };
}

export async function loadAuroraData(loc) {
  const [kpR, kp3hR, ovR] = await Promise.all([
    fetch('https://services.swpc.noaa.gov/json/planetary_k_index_1m.json'),
    fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'),
    fetch('https://services.swpc.noaa.gov/json/ovation_aurora_latest.json'),
  ]);
  const kpJ = await kpR.json();
  const valid = kpJ.filter((k) => k.kp_index !== null && k.kp_index !== undefined);

  // Headline number + trend: the steadier 3-hourly planetary Kp (the same one
  // NOAA's own dashboard shows), not the jumpy 1-minute estimate. Falls back
  // to the 1-minute feed if the 3-hourly product is unreachable.
  let series = null;
  try {
    const h3 = await kp3hR.json();
    const rows = h3.filter((r) => r.Kp !== null && r.Kp !== undefined);
    if (rows.length) {
      series = rows.slice(-8).map((r) => ({
        value: parseFloat(r.Kp),
        hour: new Date(r.time_tag).getHours(),
      }));
    }
  } catch {}
  if (!series || !series.length) {
    series = valid.slice(-8).map((k) => ({
      value: parseFloat(k.kp_index),
      hour: new Date(k.time_tag).getHours(),
    }));
  }
  if (!series.length) throw new Error('no Kp data');
  const kp = series[series.length - 1].value;

  // aurora probability near observer from ovation grid. Grid longitudes run
  // 0-359, so convert the observer's -180..180 longitude first — otherwise
  // every location in the Americas matches the wrong side of the planet.
  let prob = null;
  try {
    const ov = await ovR.json();
    const lon360 = ((loc.lon % 360) + 360) % 360;
    let bestD = 1e9;
    for (const [clon, clat, v] of ov.coordinates) {
      let dl = Math.abs(clon - lon360);
      dl = Math.min(dl, 360 - dl);
      const d = dl * dl + (clat - loc.lat) ** 2;
      if (d < bestD) {
        bestD = d;
        prob = v;
      }
    }
  } catch {}

  return { kp, prob, recent: series, ...auroraVerdict(kp, prob, loc.lat) };
}

const tzOffsetCache = {};

/* Seconds east of UTC for the observer's location, via Open-Meteo. Needed so
 * "tonight" means tonight where the observer is, not where the browser is. */
export async function utcOffsetSeconds(loc) {
  const key = `${loc.lat.toFixed(1)},${loc.lon.toFixed(1)}`;
  if (tzOffsetCache[key] !== undefined) return tzOffsetCache[key];
  try {
    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat.toFixed(3)}&longitude=${loc.lon.toFixed(3)}&current=temperature_2m&timezone=auto`,
    );
    const j = await r.json();
    tzOffsetCache[key] = j.utc_offset_seconds ?? null;
  } catch {
    tzOffsetCache[key] = null;
  }
  return tzOffsetCache[key];
}

/* Tonight + tomorrow night aurora outlook from NOAA's 3-day Kp forecast
 * (the same predicted values behind their aurora dashboard). Returns [] if
 * the forecast or the location timezone is unavailable. */
export async function loadAuroraOutlook(loc) {
  try {
    const [fr, off] = await Promise.all([
      fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json'),
      utcOffsetSeconds(loc),
    ]);
    if (off === null || off === undefined) return [];
    const j = await fr.json();
    const pred = j
      .filter((x) => x.observed === 'predicted' && x.kp !== null && x.kp !== undefined)
      .map((x) => ({ time: new Date(`${x.time_tag}Z`), kp: parseFloat(x.kp) }));
    if (!pred.length) return [];

    // "tonight" = 6pm–6am location-local time. Shift clock so UTC getters read
    // the observer's wall time, then compare in shifted milliseconds.
    const nowL = Date.now() + off * 1000;
    const d = new Date(nowL);
    const midnightL = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const windows = [
      { label: 'Tonight', start: midnightL + 18 * 3600e3, end: midnightL + 30 * 3600e3 },
      { label: 'Tomorrow night', start: midnightL + 42 * 3600e3, end: midnightL + 54 * 3600e3 },
    ];
    return windows
      .map((w) => {
        const inWin = pred.filter((p) => {
          const tL = p.time.getTime() + off * 1000;
          return tL >= w.start && tL < w.end;
        });
        if (!inWin.length) return null;
        const kp = Math.max(...inWin.map((p) => p.kp));
        const v = auroraOutlookVerdict(kp, loc.lat);
        return { label: w.label, kp, verdict: v.verdict, band: v.band };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/* Max predicted Kp for the night of the given date (6pm–6am observer-local),
 * from NOAA's 3-day Kp forecast. Returns { kp, verdict, band }, or null when
 * the forecast doesn't reach that night. */
export async function loadAuroraForecastNight(loc, date) {
  try {
    const [fr, off] = await Promise.all([
      fetch('https://services.swpc.noaa.gov/products/noaa-planetary-k-index-forecast.json'),
      utcOffsetSeconds(loc),
    ]);
    if (off === null || off === undefined) return null;
    const j = await fr.json();
    const pred = j
      .filter((x) => x.observed === 'predicted' && x.kp !== null && x.kp !== undefined)
      .map((x) => ({ time: new Date(`${x.time_tag}Z`), kp: parseFloat(x.kp) }));
    if (!pred.length) return null;

    // Night window on the shifted clock, where UTC getters read the
    // observer's wall time (same trick as loadAuroraOutlook).
    const midnightL = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    const start = midnightL + 18 * 3600e3;
    const end = midnightL + 30 * 3600e3;
    const inWin = pred.filter((p) => {
      const tL = p.time.getTime() + off * 1000;
      return tL >= start && tL < end;
    });
    if (!inWin.length) return null;
    const kp = Math.max(...inWin.map((p) => p.kp));
    const v = auroraOutlookVerdict(kp, loc.lat);
    return { kp, verdict: v.verdict, band: v.band };
  } catch {
    return null;
  }
}

/* ============================== satellite passes ============================== */
/* --- CelesTrak TLE fetching, hardened ---
 * CelesTrak throttles aggressively per IP: bursts of requests sometimes hang
 * or come back as errors, and the last request in a parallel burst tends to
 * be the one that fails. So each fetch gets a 15s timeout, 3 attempts with
 * backoff, and results are cached in localStorage (fresh for 24h, usable
 * stale for 7 days — TLEs stay good enough for pass predictions for days).
 * Only when there is no cached data at all does this throw. */
const TLE_TTL = 24 * 3600 * 1000;
const TLE_STALE_OK = 7 * 24 * 3600 * 1000;
// Bundled TLEs ship with the site as an offline fallback; the Lambda
// endpoint (TLE_ENDPOINT above) is the primary fresh source when configured.
const BUNDLED_TTL = 48 * 3600 * 1000;
const tleKey = (norad) => `sg-tle-${norad}`;

function readTleCache(norad) {
  if (!hasStorage()) return null;
  try {
    const raw = localStorage.getItem(tleKey(norad));
    if (!raw) return null;
    const { t, l1, l2 } = JSON.parse(raw);
    if (!t || !l1 || !l2) return null;
    return { t, l1, l2 };
  } catch {
    return null;
  }
}

function writeTleCache(norad, l1, l2) {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(tleKey(norad), JSON.stringify({ t: Date.now(), l1, l2 }));
  } catch {
    /* private mode etc — caching is best-effort */
  }
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function rawTleFetch(norad) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${norad}&FORMAT=TLE`, {
      signal: ctrl.signal,
    });
    const t = await r.text();
    const lines = t
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const l1 = lines.find((l) => l.startsWith('1 '));
    const l2 = lines.find((l) => l.startsWith('2 '));
    if (!l1 || !l2) throw new Error('bad TLE');
    return [l1, l2];
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchTLE(norad, bundled) {
  const cached = readTleCache(norad);
  if (cached && Date.now() - cached.t < TLE_TTL) return [cached.l1, cached.l2];
  // TLEs bundled with the site (refreshed daily): no network needed.
  const b = bundled?.tles?.[String(norad)];
  const bTime = bundled?.updated ? Date.parse(bundled.updated) : NaN;
  if (b && b[0] && b[1] && !isNaN(bTime) && Date.now() - bTime < BUNDLED_TTL) {
    writeTleCache(norad, b[0], b[1]); // seed the device cache
    return [b[0], b[1]];
  }
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(attempt * 1500);
    try {
      const [l1, l2] = await rawTleFetch(norad);
      writeTleCache(norad, l1, l2);
      return [l1, l2];
    } catch (e) {
      lastErr = e;
    }
  }
  // CelesTrak unreachable: reuse a stale TLE rather than failing outright.
  if (cached && Date.now() - cached.t < TLE_STALE_OK) return [cached.l1, cached.l2];
  throw lastErr || new Error('TLE unavailable');
}

/* satrec: built by the caller via satellite.js twoline2satrec (kept injectable for tests).
 * mag: the satellite's typical peak visual magnitude, stamped onto each pass. */
export function computePasses(satrec, lat, lon, hours, mag, from) {
  // NOTE: satellite.js v5+ ecfToLookAngles takes observer as geodetic (radians), not ECF
  const observerGd = { latitude: lat * RAD, longitude: lon * RAD, height: 0.05 };
  const step = 30 * 1000;
  const now = from ? new Date(from).getTime() : Date.now();
  const end = now + hours * 3600000;
  const passes = [];
  let cur = null;
  for (let t = now; t < end; t += step) {
    const d = new Date(t);
    const pv = propagate(satrec, d);
    if (!pv || !pv.position) {
      cur = null;
      continue;
    }
    const gmst = gstime(d);
    const ecf = eciToEcf(pv.position, gmst);
    const look = ecfToLookAngles(observerGd, ecf);
    const el = look.elevation / RAD;
    const az = look.azimuth / RAD;
    const dark = sunElev(d, lat, lon) < -6;
    // cylindrical Earth shadow test for satellite sunlight
    const sd = sunDirECF(d);
    const r2 = ecf.x ** 2 + ecf.y ** 2 + ecf.z ** 2;
    const s = ecf.x * sd.x + ecf.y * sd.y + ecf.z * sd.z;
    const sunlit = !(s < 0 && r2 - s * s < 6371 * 6371);
    const visible = el > 12 && dark && sunlit;
    if (visible) {
      if (!cur) cur = { start: d, maxEl: el, maxT: d, end: d, startAz: az, endAz: az, mag };
      else {
        cur.end = d;
        cur.endAz = az;
        if (el > cur.maxEl) {
          cur.maxEl = el;
          cur.maxT = d;
        }
      }
    } else if (cur) {
      if (cur.maxEl > 18 && cur.end - cur.start > 60000) passes.push(cur);
      cur = null;
    }
  }
  if (cur && cur.maxEl > 18) passes.push(cur);
  return passes.slice(0, 6);
}

export function passQuality(maxEl) {
  return maxEl > 60 ? 'Overhead — excellent' : maxEl > 35 ? 'High — great' : 'Low — decent';
}

/* Plain-language brightness for a visual magnitude (lower = brighter). */
export function brightnessWords(mag) {
  if (mag <= -3) return 'very bright';
  if (mag < 0) return 'bright';
  if (mag < 3) return 'dim';
  return 'faint';
}

/* ============================== planet visibility ============================== */
/* Planet positions after Paul Schlyter's "How to compute planetary positions"
   (after van Flandern & Pulkkinen): about 1 arcminute for the planets,
   1-2 for the Moon — plenty for "where to look" guidance and visibility
   scoring. https://stjarnhimlen.se/comp/ppcomp.html
   d = days since 2000 Jan 0.0 (= 1999 Dec 31 00:00 UT). */

/* Orbital elements as [N0,N1, i0,i1, w0,w1, a0,a1, e0,e1, M0,M1]:
   node, inclination, perihelion argument, semi-major axis, eccentricity,
   mean anomaly — each a value at 2000 Jan 0.0 plus a per-day rate. */
const ORBITAL_ELEMENTS = {
  sun: [0, 0, 0, 0, 282.9404, 4.70935e-5, 1.0, 0, 0.016709, -1.151e-9, 356.047, 0.9856002585],
  moon: [125.1228, -0.0529538083, 5.1454, 0, 318.0634, 0.1643573223, 60.2666, 0, 0.0549, 0, 115.3654, 13.0649929509],
  mercury: [48.3313, 3.24587e-5, 7.0047, 5.0e-8, 29.1241, 1.01444e-5, 0.387098, 0, 0.205635, 5.59e-10, 168.6562, 4.0923344368],
  venus: [76.6799, 2.4659e-5, 3.3946, 2.75e-8, 54.891, 1.38374e-5, 0.72333, 0, 0.006773, -1.302e-9, 48.0052, 1.6021302244],
  mars: [49.5574, 2.11081e-5, 1.8497, -1.78e-8, 286.5016, 2.92961e-5, 1.523688, 0, 0.093405, 2.516e-9, 18.6021, 0.5240207766],
  jupiter: [100.4542, 2.76854e-5, 1.303, -1.557e-7, 273.8777, 1.64505e-5, 5.20256, 0, 0.048498, 4.469e-9, 19.895, 0.0830853001],
  saturn: [113.6634, 2.3898e-5, 2.4886, -1.081e-7, 339.3939, 2.97661e-5, 9.55475, 0, 0.055546, -9.499e-9, 316.967, 0.0334442282],
  uranus: [74.0005, 1.3978e-5, 0.7733, 1.9e-8, 96.6612, 3.0565e-5, 19.18171, -1.55e-8, 0.047318, 7.45e-9, 142.5905, 0.011725806],
  neptune: [131.7806, 3.0173e-5, 1.77, -2.55e-7, 272.8461, -6.027e-6, 30.05826, 3.313e-8, 0.008606, 2.15e-9, 260.2471, 0.005995147],
};
export const PLANET_NAMES = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];

/* Normalize degrees to [0, 360). */
function rev(x) {
  return (((x % 360) + 360) % 360);
}

export function dayNumber(date) {
  return date.getTime() / DAY - 10956;
}

function keplerE(Mdeg, e) {
  const M = Mdeg * RAD;
  let E = M + e * Math.sin(M) * (1 + e * Math.cos(M));
  for (let k = 0; k < 8; k++) {
    E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  }
  return E;
}

/* Heliocentric ecliptic position (AU for planets/sun, Earth radii for the Moon). */
function helioEcliptic(el, d) {
  const N = rev(el[0] + el[1] * d) * RAD;
  const i = (el[2] + el[3] * d) * RAD;
  const w = rev(el[4] + el[5] * d) * RAD;
  const a = el[6] + el[7] * d;
  const e = el[8] + el[9] * d;
  const M = rev(el[10] + el[11] * d);
  const E = keplerE(M, e);
  const xv = a * (Math.cos(E) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const v = Math.atan2(yv, xv);
  const r = Math.hypot(xv, yv);
  const vw = v + w;
  return {
    xh: r * (Math.cos(N) * Math.cos(vw) - Math.sin(N) * Math.sin(vw) * Math.cos(i)),
    yh: r * (Math.sin(N) * Math.cos(vw) + Math.cos(N) * Math.sin(vw) * Math.cos(i)),
    zh: r * Math.sin(vw) * Math.sin(i),
    r, vDeg: v / RAD, wDeg: w / RAD, M, Ndeg: N / RAD,
  };
}

function perturbTerms(lon, lat, terms) {
  const s = (x) => Math.sin(x * RAD);
  const c = (x) => Math.cos(x * RAD);
  for (const [kind, coeff, arg, isLat] of terms) {
    const v = coeff * (kind === 's' ? s(arg) : c(arg));
    if (isLat) lat += v;
    else lon += v;
  }
  return [lon, lat];
}

function bodyEquatorial(name, d) {
  const el = ORBITAL_ELEMENTS[name];
  const ecl = (23.4393 - 3.563e-7 * d) * RAD;
  const sun = helioEcliptic(ORBITAL_ELEMENTS.sun, d);
  const b = helioEcliptic(el, d);
  let lon = rev(Math.atan2(b.yh, b.xh) / RAD);
  let lat = Math.atan2(b.zh, Math.hypot(b.xh, b.yh)) / RAD;
  if (name === 'moon') {
    const Ms = sun.M, Mm = b.M, Nm = b.Ndeg, ws = sun.wDeg, wm = b.wDeg;
    const Ls = Ms + ws, Lm = Mm + wm + Nm;
    const D = Lm - Ls, F = Lm - Nm;
    [lon] = perturbTerms(lon, 0, [
      ['s', -1.274, Mm - 2 * D], ['s', 0.658, 2 * D], ['s', -0.186, Ms],
      ['s', -0.059, 2 * Mm - 2 * D], ['s', -0.057, Mm - 2 * D + Ms],
      ['s', 0.053, Mm + 2 * D], ['s', 0.046, 2 * D - Ms], ['s', 0.041, Mm - Ms],
      ['s', -0.035, D], ['s', -0.031, Mm + Ms], ['s', -0.015, 2 * F - 2 * D],
      ['s', 0.011, Mm - 4 * D],
    ]);
    [, lat] = perturbTerms(0, lat, [
      ['s', -0.173, F - 2 * D, true], ['s', -0.055, Mm - F - 2 * D, true],
      ['s', -0.046, Mm + F - 2 * D, true], ['s', 0.033, F + 2 * D, true],
      ['s', 0.017, 2 * Mm + F, true],
    ]);
  } else if (name === 'jupiter' || name === 'saturn' || name === 'uranus') {
    const Mj = rev(ORBITAL_ELEMENTS.jupiter[10] + ORBITAL_ELEMENTS.jupiter[11] * d);
    const Ms = rev(ORBITAL_ELEMENTS.saturn[10] + ORBITAL_ELEMENTS.saturn[11] * d);
    if (name === 'jupiter') {
      [lon] = perturbTerms(lon, 0, [
        ['s', -0.332, 2 * Mj - 5 * Ms - 67.6], ['s', -0.056, 2 * Mj - 2 * Ms + 21],
        ['s', 0.042, 3 * Mj - 5 * Ms + 21], ['s', -0.036, Mj - 2 * Ms],
        ['c', 0.022, Mj - Ms], ['s', 0.023, 2 * Mj - 3 * Ms + 52],
        ['s', -0.016, Mj - 5 * Ms - 69],
      ]);
    } else if (name === 'saturn') {
      [lon, lat] = perturbTerms(lon, lat, [
        ['s', 0.812, 2 * Mj - 5 * Ms - 67.6], ['c', -0.229, 2 * Mj - 4 * Ms - 2],
        ['s', 0.119, Mj - 2 * Ms - 3], ['s', 0.046, 2 * Mj - 6 * Ms - 69],
        ['s', 0.014, Mj - 3 * Ms + 32], ['c', -0.02, 2 * Mj - 4 * Ms - 2, true],
        ['s', 0.018, 2 * Mj - 6 * Ms - 49, true],
      ]);
    } else {
      const Mu = rev(ORBITAL_ELEMENTS.uranus[10] + ORBITAL_ELEMENTS.uranus[11] * d);
      [lon] = perturbTerms(lon, 0, [
        ['s', 0.04, Ms - 2 * Mu + 6], ['s', 0.035, Ms - 3 * Mu + 33],
        ['s', -0.015, Mj - Mu + 20],
      ]);
    }
  }
  const lr = lon * RAD, br = lat * RAD;
  const xh = b.r * Math.cos(lr) * Math.cos(br);
  const yh = b.r * Math.sin(lr) * Math.cos(br);
  const zh = b.r * Math.sin(br);
  const lonsun = rev(sun.vDeg + sun.wDeg);
  const xs = sun.r * Math.cos(lonsun * RAD), ys = sun.r * Math.sin(lonsun * RAD);
  let xg, yg, zg;
  if (name === 'moon') {
    xg = xh; yg = yh; zg = zh;
  } else {
    xg = xh + xs; yg = yh + ys; zg = zh;
  }
  const xe = xg, ye = yg * Math.cos(ecl) - zg * Math.sin(ecl), ze = yg * Math.sin(ecl) + zg * Math.cos(ecl);
  const R = Math.hypot(xg, yg, zg);
  const ra = rev(Math.atan2(ye, xe) / RAD);
  const dec = Math.atan2(ze, Math.hypot(xe, ye)) / RAD;
  /* Sun separation and phase angle (deg). Skipped for the Moon (its distance
     is in Earth radii, not AU, and nothing consumes its elongation). */
  let elong = null, FV = null;
  if (name !== 'moon') {
    const s = sun.r, r = b.r;
    const clamp = (x) => Math.max(-1, Math.min(1, x));
    elong = Math.acos(clamp((s * s + R * R - r * r) / (2 * s * R))) / RAD;
    FV = Math.acos(clamp((r * r + R * R - s * s) / (2 * r * R))) / RAD;
  }
  return { ra, dec, r: b.r, R, elong, FV, lon, lat };
}

/* Visual magnitude from helio/geocentric distances (AU) and phase angle (deg). */
function planetMagnitude(name, r, R, FV, d, lon, lat) {
  const base = 5 * Math.log10(r * R);
  switch (name) {
    case 'mercury': return -0.36 + base + 0.027 * FV + 2.2e-13 * FV ** 6;
    case 'venus': return -4.34 + base + 0.013 * FV + 4.2e-7 * FV ** 3;
    case 'mars': return -1.51 + base + 0.016 * FV;
    case 'jupiter': return -9.25 + base + 0.014 * FV;
    case 'saturn': {
      const ir = 28.06 * RAD, Nr = (169.51 + 3.82e-5 * d) * RAD;
      const B = Math.asin(
        Math.sin(lat * RAD) * Math.cos(ir) - Math.cos(lat * RAD) * Math.sin(ir) * Math.sin(lon * RAD - Nr),
      );
      const ring = -2.6 * Math.sin(Math.abs(B)) + 1.2 * Math.sin(B) ** 2;
      return -9.0 + base + 0.044 * FV + ring;
    }
    case 'uranus': return -7.15 + base + 0.001 * FV;
    case 'neptune': return -6.9 + base + 0.001 * FV;
    default: return NaN;
  }
}

export function planetEphemeris(date) {
  const d = dayNumber(date);
  return PLANET_NAMES.map((name) => {
    const e = bodyEquatorial(name, d);
    return { name, ra: e.ra, dec: e.dec, elong: e.elong, mag: planetMagnitude(name, e.r, e.R, e.FV, d, e.lon, e.lat) };
  });
}

export function moonEquatorial(date) {
  const m = bodyEquatorial('moon', dayNumber(date));
  return { ra: m.ra, dec: m.dec };
}

function lstDeg(date, lon) {
  const n = date.getTime() / DAY + 2440587.5 - 2451545.0;
  const gmst = (((18.697374558 + 24.06570982441908 * n) % 24) + 24) % 24;
  return gmst * 15 + lon;
}

export function altAz(raDeg, decDeg, date, lat, lon) {
  const ha = (lstDeg(date, lon) - raDeg) * RAD;
  const dec = decDeg * RAD, la = lat * RAD;
  const x = Math.cos(ha) * Math.cos(dec);
  const y = Math.sin(ha) * Math.cos(dec);
  const z = Math.sin(dec);
  const xhor = x * Math.sin(la) - z * Math.cos(la);
  const yhor = y;
  const zhor = x * Math.cos(la) + z * Math.sin(la);
  return {
    alt: Math.asin(Math.max(-1, Math.min(1, zhor))) / RAD,
    az: rev(Math.atan2(yhor, xhor) / RAD + 180),
  };
}

export function angularSep(ra1, dec1, ra2, dec2) {
  const s = Math.sin(dec1 * RAD) * Math.sin(dec2 * RAD)
    + Math.cos(dec1 * RAD) * Math.cos(dec2 * RAD) * Math.cos((ra1 - ra2) * RAD);
  return Math.acos(Math.max(-1, Math.min(1, s))) / RAD;
}

/* The observer-local "night of `date`": 6 PM to 6 AM as UTC millisecond
   bounds. When `date` is today and it's still before 6 AM, the night in
   progress started yesterday evening, so anchor to the previous day. */
function nightWindow(date, off) {
  const shift = off * 1000;
  const dl = new Date(date.getTime() + shift);
  const nowL = new Date(Date.now() + shift);
  let midnightL = Date.UTC(dl.getUTCFullYear(), dl.getUTCMonth(), dl.getUTCDate());
  const isToday =
    dl.getUTCFullYear() === nowL.getUTCFullYear() &&
    dl.getUTCMonth() === nowL.getUTCMonth() &&
    dl.getUTCDate() === nowL.getUTCDate();
  if (isToday && dl.getUTCHours() < 6) midnightL -= DAY;
  return { t0: midnightL + 18 * 3600e3 - shift, t1: midnightL + 30 * 3600e3 - shift };
}

/* Worst forecast cloud cover over a time window, from Open-Meteo hourly data
   (fetches each calendar day the window touches). */
async function maxCloudWindow(t0, t1, loc, off, cache) {
  const shift = off * 1000;
  const keys = new Set();
  for (let t = t0; t <= t1; t += 12 * 3600e3) {
    const d = new Date(t + shift);
    keys.add(
      d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0')
    );
  }
  let max = 0, found = false;
  for (const k of keys) {
    const day = await hourlyCloud(k, loc, cache);
    if (!day) continue;
    for (let i = 0; i < day.times.length; i++) {
      // Open-Meteo hourly times are location wall-clock; parsing them as UTC
      // puts them on the same wall-clock scale as the shifted window bounds.
      const utc = Date.parse(day.times[i] + 'Z') - shift;
      if (utc >= t0 && utc <= t1) {
        found = true;
        if (day.vals[i] > max) max = day.vals[i];
      }
    }
  }
  return found ? max : null;
}

/* Factor rows for a planet event's bodies, sharing one planetVisibility
   computation across the event cards and the hero:
   "Neptune visibility 85 (Great) tonight — best 2:40 AM, look S, 57° up ·
   magnitude 7.8". The trailing "magnitude N.N" is auto-wrapped into a Mag
   hover by TermText. */
export function planetVisibilityFactors(planetRows, bodies, visWhen) {
  if (!planetRows) return null;
  const byName = Object.fromEntries(planetRows.map((r) => [r.name, r]));
  const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const out = (bodies || [])
    .map((b) => b.toLowerCase())
    .filter((n) => byName[n])
    .map((n) => {
      const r = byName[n];
      const detail = r.best
        ? `best ${fmtTime(r.best.time)}, look ${compass(r.best.az)}, ${Math.round(r.best.alt)}° up`
        : r.altNote;
      return {
        icon: r.mag <= 6 ? 'eye' : 'telescope',
        text: `${cap1(n)} visibility ${r.score} (${r.label}) ${visWhen} — ${detail} · magnitude ${r.mag}`,
      };
    });
  return out.length ? out : null;
}
/* Nightly planet visibility: for each planet, the best dark-sky viewing
   geometry on the observer-local night of `date` (6 PM to 6 AM local), plus
   a 0-100 visibility score (78+ Great, 55+ Fair, below that Poor).
   Positions are exact math for any date; only the cloud term depends on the
   forecast (omitted when none is available). */
export async function planetVisibility(date, loc, wxCache = {}) {
  let off = await utcOffsetSeconds(loc);
  if (off == null) off = -date.getTimezoneOffset() * 60;
  const { t0, t1 } = nightWindow(date, off);
  const eph = planetEphemeris(new Date((t0 + t1) / 2));
  const rows = eph.map((p) => ({
    name: p.name, mag: Math.round(p.mag * 10) / 10, best: null, maxAlt: -90,
  }));
  // Only the rest of the night counts: past hours are gone.
  const scanStart = Math.max(t0, Date.now());
  for (let t = scanStart; t <= t1; t += 20 * 60e3) {
    const dt = new Date(t);
    const dark = sunElev(dt, loc.lat, loc.lon) < -6;
    eph.forEach((p, i) => {
      const aa = altAz(p.ra, p.dec, dt, loc.lat, loc.lon);
      const r = rows[i];
      if (aa.alt > r.maxAlt) r.maxAlt = aa.alt;
      if (dark && aa.alt > 0 && (!r.best || aa.alt > r.best.alt)) {
        r.best = { time: dt, alt: aa.alt, az: aa.az };
      }
    });
  }
  // Clouds at each planet's best hour (what you'd actually look through);
  // worst-of-night only as a fallback when it never comes up.
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const cloud = rows[i].best
      ? await cloudCoverAt(rows[i].best.time, loc, wxCache)
      : await maxCloudWindow(t0, t1, loc, off, wxCache);
    out.push({ ...rows[i], ...scorePlanet(rows[i], eph[i], cloud, loc) });
  }
  return out.sort((a, b) => b.score - a.score);
}

function scorePlanet(row, eph, cloud, loc) {
  let score = 50;
  let altNote;
  if (!row.best) {
    score -= 45;
    altNote = row.maxAlt > 0 ? "only up while the sun's up" : 'below the horizon tonight';
  } else {
    const a = Math.round(row.best.alt);
    if (a < 10) { score -= 18; altNote = `peaks ${a}° — very low`; }
    else if (a < 20) { score -= 6; altNote = `peaks ${a}° — low`; }
    else if (a < 35) { score += 8; altNote = `peaks ${a}°`; }
    else if (a < 55) { score += 15; altNote = `peaks ${a}° — nice and high`; }
    else { score += 22; altNote = `peaks ${a}° — nearly overhead`; }
  }
  /* Brightness (same bands as event go-scores). */
  score += magBand(row.mag).delta;
  /* Moonlight at the planet's best hour. */
  let moonNote = null;
  if (row.best) {
    const moon = moonEquatorial(row.best.time);
    const maa = altAz(moon.ra, moon.dec, row.best.time, loc.lat, loc.lon);
    const illum = moonIllum(row.best.time);
    const pct = Math.round(illum * 100);
    if (maa.alt < 0) moonNote = "moon's down at the best hour";
    else {
      const sep = Math.round(angularSep(moon.ra, moon.dec, eph.ra, eph.dec));
      if (illum > 0.5 && sep < 25) { score -= 12; moonNote = `${pct}% moon only ${sep}° away — washes out the sky`; }
      else if (illum > 0.5 && sep < 60) { score -= 5; moonNote = `bright ${pct}% moon ${sep}° away`; }
      else if (illum > 0.25) { score -= 2; moonNote = `${pct}% ${moonName(illum)} ${sep}° away`; }
      else moonNote = `${pct}% ${moonName(illum)} — dark skies`;
    }
  }
  /* Clouds (same bands as go-scores). */
  let cloudNote;
  if (cloud === null) cloudNote = 'forecast unavailable';
  else {
    cloudNote = `${cloud}% clouds`;
    if (cloud < 15) score += 28;
    else if (cloud < 40) score += 14;
    else if (cloud < 70) score -= 8;
    else score -= 28;
  }
  score = Math.max(5, Math.min(99, Math.round(score)));
  return {
    score,
    label: score >= 78 ? 'Great' : score >= 55 ? 'Fair' : 'Poor',
    altNote, moonNote, cloudNote,
  };
}
