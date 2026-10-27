/* STARGAZER — astronomy math, event engine, scoring. Pure logic, no JSX.
 * (Ported faithfully from the original vanilla app.js.) */
import {
  propagate,
  gstime,
  eciToEcf,
  ecfToLookAngles,
} from 'satellite.js';
import { getRegionSync, ensureRegion, sampleRegionByte } from './bortleRegions.js';

/* ============================== config ============================== */
export const DEFAULT_LOC = { name: 'Medford, MA', lat: 42.4184, lon: -71.1062, tz: 'America/New_York' };
// Medford Bortle 8 inferred from Sky & Telescope zenith SQM in adjacent Arlington (17.9)
// and Cambridge (17.3-17.4) — no published Medford measurement. Only shown while home is Medford.
export const HOME_BORTLE = {
  value: '8',
  source:
    'Inferred from Sky & Telescope zenith SQM readings in adjacent Arlington and Cambridge; no Medford measurement published.',
};

/* SQM -> Bortle breakpoints. Tightened 2026-09-25 after comparison against
   lightpollutionmap.info: their Bortle 1 requires SQM >= 21.99 (vs our old
   21.76), and our old scale handed out Bortle 1 to areas that aren't truly
   pristine. These breaks sit between Wikipedia's loose scale and their
   strict one. Kept in one place so the satellite-grid estimate and any
   future use share it. */
const BORTLE_BREAKS = [
  [21.90, 1], [21.70, 2], [21.40, 3], [20.90, 4],
  [19.45, 5], [18.70, 6], [18.20, 7], [17.70, 8],
];
export function sqmToBortle(sqm) {
  for (const [edge, cls] of BORTLE_BREAKS) if (sqm >= edge) return cls;
  return 9;
}

/* Estimated Bortle class from the Black Marble 2025 satellite grid, split into
   32 lazy-loaded regions (see bortleRegions.js). The grid stores zenith SQM
   as 0.05-mag bytes (255 = unknown). Returns { value, sqm, estimated: true,
   source }, or null when the region isn't loaded yet or the cell is unknown. */
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
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  // Try the sync cache first; if the region isn't loaded, trigger the load
  // in the background and return null (caller should use the async version
  // or subscribe to region updates for a live value).
  let region = getRegionSync(lat, lon);
  if (!region) {
    ensureRegion(lat, lon);
    return null;
  }
  const q = sampleRegionByte(region, lat, lon);
  if (q == null) return null;
  return bortleResult(q, 'Black Marble 2025');
}

/* Async version: ensures the region is loaded before sampling. */
export async function estimateBortleAsync(lat, lon) {
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  const region = await ensureRegion(lat, lon);
  if (!region) return null;
  const q = sampleRegionByte(region, lat, lon);
  if (q == null) return null;
  return bortleResult(q, 'Black Marble 2025');
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
/* Display timezone: clock times render in the VIEWED
   location's timezone, not the viewer's (Alex, 2026-10-27 —
   a Cape Town eclipse's 12:30 PM transit read as "6:30 AM"
   from Boston). App sets this from the current location;
   locations carry an IANA tz (geocoder results include one;
   older saves get it resolved once via resolveLocTimeZone).
   Calendar-date labels (fmtDate) deliberately stay in the
   viewer's own day semantics — catalog event dates are day
   anchors, not instants — while fmtDateLoc below serves the
   places that format a real instant's date (satellite
   passes), where the date must agree with the tz-shifted
   time beside it. */
let displayTz = null;
export function setDisplayTimeZone(tz) {
  if (tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      displayTz = tz;
      return;
    } catch {}
  }
  displayTz = null;
}
export function getDisplayTimeZone() {
  return displayTz;
}
export function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: displayTz || undefined });
}
export function fmtDate(d) {
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
export function fmtDateLoc(d) {
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: displayTz || undefined });
}
/* The calendar day of an instant in the display timezone, as
   a comparable YYYY-MM-DD key (pass day-grouping). */
export function dayKeyTz(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: displayTz || undefined,
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
/* The UTC instant of local midnight starting the calendar
   day that contains `date` in an IANA timezone (null when
   the tz is missing or invalid). Solved from the zone's
   wall-clock reading with two refinement passes. Track
   windows anchor to this so a far-away location's day is
   covered in ITS day, not the viewer's — the old 9 PM
   browser-local anchor opened the Nov 2030 South Africa
   solar track at 7:00 AM local, cutting the first 100
   minutes of the Sun's path (Alex, 2026-10-27). */
export function zonedDayStart(date, tz) {
  if (!date || !tz) return null;
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    const partsOf = (d) => Object.fromEntries(dtf.formatToParts(d).map((p) => [p.type, p.value]));
    const wallAsUtc = (d) => {
      const p = partsOf(d);
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    };
    const p0 = partsOf(date);
    const dayUtc = Date.UTC(+p0.year, +p0.month - 1, +p0.day);
    let utc = dayUtc - (wallAsUtc(new Date(dayUtc)) - dayUtc);
    utc = dayUtc - (wallAsUtc(new Date(utc)) - utc);
    return new Date(utc);
  } catch {
    return null;
  }
}

/* Resolve a location's IANA timezone from its coordinates
   (Open-Meteo, timezone=auto) — for saved locations that
   predate tz storage. Null on any failure; callers fall back
   to the viewer's timezone, i.e. the old behavior. */
export async function resolveLocTimeZone(loc) {
  if (!loc || loc.lat == null || loc.lon == null) return null;
  try {
    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&timezone=auto&forecast_days=1`,
    );
    const j = await r.json();
    return typeof j?.timezone === 'string' ? j.timezone : null;
  } catch {
    return null;
  }
}
/* fmtDate with the year appended when the date is a year or
   more out (Alex, 2026-10-26: in Upcoming events, dates 1+
   year out include the year — "Sun, Jan 14" otherwise reads
   as this coming January). The 365-day threshold mirrors
   countdown()'s switch to its "Ny Nd" form. */
export function fmtDateFar(d, ref = new Date()) {
  const base = fmtDate(d);
  return d - ref >= 365 * DAY ? `${base}, ${d.getFullYear()}` : base;
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
/* Cloud climatology cache: a Lambda + S3 cache-aside endpoint
   (cloudformation/clim-cache.yaml) holding the reduced 366-day
   climatology per ~1 km cell, computed once for everyone.
   Any failure falls through to the live archive fetch below. */
export const CLIM_ENDPOINT = 'https://ygte66nowa5k6y5okuav6xiksi0lrbql.lambda-url.us-east-1.on.aws/';

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
      radiantRa: showers?.radiants?.[s.name]?.ra ?? null,
      radiantDec: showers?.radiants?.[s.name]?.dec ?? null,
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

/* Is the Sun above the horizon for any part of a computed
   solar eclipse at this location? The Besselian geometry
   alone says only that the Moon's shadow reaches the ground
   — it happily reports a full set of contacts for a shadow
   pass in the middle of the night (Jul 2028 from South
   Africa: contacts with the Sun 30-55 degrees below the
   horizon, while the event card correctly said not visible
   and the estimate drew the diagram anyway — Alex,
   2026-10-27). Samples the Sun's altitude at the contacts
   and midway between them; -0.83 degrees is the conventional
   horizon for the Sun's center (its radius plus refraction). */
export function sunUpDuringEvent(c, loc) {
  if (!c || !c.visible || !loc || loc.lat == null) return false;
  const pts = [c.c1, c.max, c.c4].filter(Boolean);
  const samples = [...pts];
  for (let i = 0; i + 1 < pts.length; i++) {
    samples.push(new Date((pts[i].getTime() + pts[i + 1].getTime()) / 2));
  }
  return samples.some((d) => {
    const s = sunRaDec(d);
    return altAz(s.ra, s.dec, d, loc.lat, loc.lon).alt > -0.83;
  });
}

/* The sunrise or sunset nearest to a moment (scans ±12h) —
   for saying how far an eclipse moment sits from daylight,
   e.g. "about 3h 18m before sunrise". */
export function nearestSunCrossing(date, loc) {
  const step = 5 * 60e3;
  const t0 = date.getTime();
  let best = null;
  let prevT = t0 - 12 * 3600e3;
  let prevA = sunElev(new Date(prevT), loc.lat, loc.lon);
  for (let t = prevT + step; t <= t0 + 12 * 3600e3; t += step) {
    const a = sunElev(new Date(t), loc.lat, loc.lon);
    if ((prevA <= 0 && a > 0) || (prevA > 0 && a <= 0)) {
      if (!best || Math.abs(t - t0) < Math.abs(best.time.getTime() - t0)) {
        best = { time: new Date(t), rising: a > 0 };
      }
    }
    prevT = t; prevA = a;
  }
  return best;
}

/* Expedition-tier events are total solar eclipses: only worth a go-score when
   the eclipse is at all visible (even partially) from the viewer's location.
   Each total solar eclipse record carries `vis`, a generous lat/lon bounding
   box covering the full partial-visibility zone (sources documented in the
   data file's _note). Missing data or location -> visible: a score is never
   hidden without evidence. When the event carries Besselian
   circumstances, they overrule the box: the shadow may pass
   over a boxed location entirely at night. */
export function eclipseVisibleFrom(ev, loc) {
  const vis = ev.vis;
  if (!vis || !loc || loc.lat == null || loc.lon == null) return true;
  const inBox = (
    loc.lat >= vis.lat[0] &&
    loc.lat <= vis.lat[1] &&
    loc.lon >= vis.lon[0] &&
    loc.lon <= vis.lon[1]
  );
  if (!inBox) return false;
  if (ev.solar && ev.circ) {
    const c = solarCircumstances(ev.circ, (ev.id || '').slice(-10), loc.lat, loc.lon);
    if (c) return sunUpDuringEvent(c, loc);
  }
  return true;
}

/* ---- Eclipse estimates for one location (Alex, 2026-10-26) ----
   Solar: local circumstances computed in the browser from the
   eclipse's polynomial Besselian elements (NASA GSFC, Fred
   Espenak) carried in ev.circ — contacts, maximum, magnitude
   and obscuration for the viewer's exact location. Validated
   2026-10-26 against published circumstances for 2028 Jan 26
   and 2029 Jan 14 (times within a minute, magnitudes within
   0.005). Two conventions matter: the hour angle is
   H = mu + lon(east) (NASA tabulates mu against west-positive
   longitude), and the local magnitude that matches published
   values divides by (L1* + L2*) = twice the Sun's apparent
   radius, because NASA's L2 is signed (rs - rm).
   Lunar: circumstances are global, so ev.circ carries
   Espenak's published contact times (TD) and magnitudes from
   EclipseWise; the location-specific part — Moon altitude at
   each contact, moonrise/moonset during the event — is
   composed here from the app's own Moon positions. */
function besselPoly(c, t) {
  return c[0] + t * (c[1] + t * (c[2] + t * (c[3] || 0)));
}

export function solarCircumstances(circ, isoDate, lat, lon) {
  if (!circ || lat == null || lon == null) return null;
  const dayMs = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(dayMs)) return null;
  const elAt = (t) => ({
    x: besselPoly(circ.x, t), y: besselPoly(circ.y, t),
    d: besselPoly(circ.d, t) * RAD, mu: besselPoly(circ.mu, t),
    l1: besselPoly(circ.l1, t), l2: besselPoly(circ.l2, t),
  });
  const phi = lat * RAD;
  const u = Math.atan(0.99664719 * Math.tan(phi));
  const rhoSin = 0.99664719 * Math.sin(u), rhoCos = Math.cos(u);
  const obsAt = (t) => {
    const el = elAt(t);
    const H = (el.mu + lon) * RAD;
    const sd = Math.sin(el.d), cd = Math.cos(el.d);
    const xi = rhoCos * Math.sin(H);
    const eta = rhoSin * cd - rhoCos * Math.cos(H) * sd;
    const zeta = rhoSin * sd + rhoCos * Math.cos(H) * cd;
    return { el, xi, eta, zeta };
  };
  const clearance = (t, umbral) => {
    const { el, xi, eta, zeta } = obsAt(t);
    const L = umbral
      ? Math.abs(el.l2 - zeta * circ.tanF2)
      : el.l1 - zeta * circ.tanF1;
    return Math.hypot(el.x - xi, el.y - eta) - L;
  };
  const bisect = (a, b, umbral) => {
    let fa = clearance(a, umbral);
    for (let i = 0; i < 60; i++) {
      const m = (a + b) / 2, fm = clearance(m, umbral);
      if (fa * fm <= 0) b = m; else { a = m; fa = fm; }
    }
    return (a + b) / 2;
  };
  const step = 1 / 30;
  let best = { t: 0, c: Infinity };
  const samples = [];
  for (let t = -4; t <= 4.0001; t += step) {
    const c = clearance(t, false);
    samples.push([t, c]);
    if (c < best.c) best = { t, c };
  }
  if (best.c >= 0) {
    /* A true miss: report how far off it is, in Sun widths
       (edge to edge at closest approach), so a "not visible"
       can say whether it was close (Alex, 2026-10-27). */
    const o = obsAt(best.t);
    const l1 = o.el.l1 - o.zeta * circ.tanF1;
    const l2 = o.el.l2 - o.zeta * circ.tanF2;
    const rsM = (l1 + l2) / 2, rmM = (l1 - l2) / 2;
    const sM = Math.hypot(o.el.x - o.xi, o.el.y - o.eta);
    return {
      visible: false,
      missAt: new Date(dayMs + (circ.t0 + best.t) * 3600000 - circ.dT * 1000),
      missGapWidths: (sM - (rsM + rmM)) / (2 * rsM),
    };
  }
  let ga = best.t - step, gb = best.t + step;
  for (let i = 0; i < 80; i++) {
    const m1 = ga + (gb - ga) * 0.381966, m2 = ga + (gb - ga) * 0.618034;
    if (clearance(m1, false) < clearance(m2, false)) gb = m2; else ga = m1;
  }
  const tMax = (ga + gb) / 2;
  const contacts = (umbral) => {
    let enter = null, exit = null;
    for (let i = 0; i < samples.length - 1; i++) {
      const [t1] = samples[i], [t2] = samples[i + 1];
      const c1v = clearance(t1, umbral), c2v = clearance(t2, umbral);
      if (c1v >= 0 && c2v < 0 && t2 <= tMax + 1e-9) enter = bisect(t1, t2, umbral);
      if (c1v < 0 && c2v >= 0 && t1 >= tMax - step) exit = bisect(t1, t2, umbral);
    }
    return [enter, exit];
  };
  const [c1, c4] = contacts(false);
  let c2 = null, c3 = null;
  if (clearance(tMax, true) < 0) [c2, c3] = contacts(true);
  const { el, xi, eta, zeta } = obsAt(tMax);
  const L1s = el.l1 - zeta * circ.tanF1;
  const L2s = el.l2 - zeta * circ.tanF2;
  const s = Math.hypot(el.x - xi, el.y - eta);
  /* NASA's L2 is signed as (rs - rm) in these units — positive
     for annular, negative for total — so L1 + L2 = 2*rs (the
     Sun's apparent radius, doubled) and L1 - L2 = 2*rm. The
     magnitude below is the canonical fraction of the Sun's
     diameter covered; the radii feed the area overlap. */
  const magnitude = (L1s - s) / (L1s + L2s);
  const rs = (L1s + L2s) / 2, rm = (L1s - L2s) / 2;
  let obscuration = 0;
  if (s <= Math.abs(rm - rs)) obscuration = Math.min(rs, rm) ** 2 / rs ** 2;
  else if (s < rm + rs) {
    const a1 = rs * rs * Math.acos((s * s + rs * rs - rm * rm) / (2 * s * rs));
    const a2 = rm * rm * Math.acos((s * s + rm * rm - rs * rs) / (2 * s * rm));
    const a3 = 0.5 * Math.sqrt((-s + rs + rm) * (s + rs - rm) * (s - rs + rm) * (s + rs + rm));
    obscuration = (a1 + a2 - a3) / (Math.PI * rs * rs);
  }
  /* The Moon's center relative to the Sun's at any instant,
     in Sun radii, in the Besselian plane's own coordinates
     (x eastward along the celestial equator, y toward
     celestial north) — feeds the estimate's contact-strip
     diagram. Position AND distance must come from this one
     frame: an earlier version took the distance here but the
     direction from the app's geocentric RA/Dec positions,
     whose ~1-degree parallax offset (several Sun radii at
     this scale) bent the drawn path into a steep fake bow
     (Alex, 2026-10-27). At C1/C4 the magnitude is exactly
     1 + moonR — the discs are tangent by construction. */
  const vecAt = (t) => {
    const o = obsAt(t);
    const l1 = o.el.l1 - o.zeta * circ.tanF1;
    const l2 = o.el.l2 - o.zeta * circ.tanF2;
    const rs = (l1 + l2) / 2;
    return { dx: (o.el.x - o.xi) / rs, dy: (o.el.y - o.eta) / rs };
  };
  const toDate = (tTT) => new Date(dayMs + (circ.t0 + tTT) * 3600000 - circ.dT * 1000);
  return {
    visible: true,
    c1: c1 !== null ? toDate(c1) : null,
    c2: c2 !== null ? toDate(c2) : null,
    c3: c3 !== null ? toDate(c3) : null,
    c4: c4 !== null ? toDate(c4) : null,
    /* The central phase's character HERE: signed L2 at the
       observer is positive for annular, negative for total
       (a hybrid eclipse can be one here and the other
       elsewhere along its path). */
    central: c2 !== null ? (L2s > 0 ? 'annular' : 'total') : null,
    max: toDate(tMax),
    magnitude,
    obscuration,
    strip: [
      ...(c1 !== null ? [{ key: 'c1', ...vecAt(c1) }] : []),
      ...(c2 !== null ? [{ key: 'c2', ...vecAt(c2) }] : []),
      { key: 'max', dx: (el.x - xi) / rs, dy: (el.y - eta) / rs },
      ...(c3 !== null ? [{ key: 'c3', ...vecAt(c3) }] : []),
      ...(c4 !== null ? [{ key: 'c4', ...vecAt(c4) }] : []),
    ],
    moonR: rm / rs,
  };
}

/* Published lunar contacts are TD time-of-day on the eclipse's
   TD calendar date. Anchor on the greatest-eclipse time and
   place every contact by its signed offset from it (wrapping
   at 12h), so post-midnight contacts land on the right day. */
export function lunarCircumstances(circ, isoDate) {
  if (!circ || !circ.contactsTD || !circ.contactsTD.greatest) return null;
  const dayMs = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(dayMs)) return null;
  const tod = (s) => {
    const [h, m, sec] = s.split(':').map(Number);
    return ((h * 60 + m) * 60 + (sec || 0)) * 1000;
  };
  const gTod = tod(circ.contactsTD.greatest);
  const at = (key) => {
    const raw = circ.contactsTD[key];
    if (!raw) return null;
    let off = tod(raw) - gTod;
    if (off > 12 * 3600000) off -= 24 * 3600000;
    if (off < -12 * 3600000) off += 24 * 3600000;
    return new Date(dayMs + gTod + off - circ.dT * 1000);
  };
  return {
    p1: at('p1'), u1: at('u1'), u2: at('u2'), greatest: at('greatest'),
    u3: at('u3'), u4: at('u4'), p4: at('p4'),
    penMag: circ.penMag, umbMag: circ.umbMag,
  };
}

function centralDurText(ms) {
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`;
}

/* The sky view's "Eclipse estimate" block: per-location lines
   for an eclipse event, or null when the event carries no
   circumstance data. locName labels whose sky it is. */
export function eclipseEstimate(ev, loc, locName) {
  if (!ev || ev.type !== 'eclipse' || !ev.circ || !loc || loc.lat == null) return null;
  const isoDate = (ev.id || '').slice(-10);
  const where = locName || 'your location';
  /* timeanddate's animated "what it looks like from here"
     page for this eclipse and location (Alex, 2026-10-27).
     Their /eclipse/in/@lat,lon?iso=YYYYMMDD form takes raw
     coordinates — verified live, no city slug needed. */
  const animUrl = `https://www.timeanddate.com/eclipse/in/@${Number(loc.lat.toFixed(4))},${Number(loc.lon.toFixed(4))}?iso=${isoDate.replace(/-/g, '')}`;
  const altNote = (body, date) => {
    const eq = body === 'sun' ? sunRaDec(date) : moonEquatorial(date);
    const { alt, az } = altAz(eq.ra, eq.dec, date, loc.lat, loc.lon);
    if (alt < -0.5) return 'below the horizon';
    if (alt < 6) return `just ${Math.max(0, Math.round(alt))}° up toward the ${compass(az)} — find a clear horizon`;
    return `${Math.round(alt)}° up toward the ${compass(az)}`;
  };
  if (ev.solar) {
    const c = solarCircumstances(ev.circ, isoDate, loc.lat, loc.lon);
    if (!c) return null;
    if (!c.visible) {
      const gap = c.missGapWidths;
      const gapRounded = gap == null ? null : Math.round(gap * 2) / 2;
      const gapText = gap == null ? null
        : gap < 0.75 ? 'about half a Sun-width'
        : gapRounded === 1 ? 'about 1 Sun-width'
        : `about ${gapRounded} Sun-widths`;
      return {
        heading: `Eclipse estimate — ${where}`,
        lines: [
          'Not visible from here: the Moon’s shadow never reaches your sky for this eclipse.',
          ...(gapText && c.missAt
            ? [`Closest approach is ${fmtTime(c.missAt)} — the Moon’s edge passes ${gapText} from the Sun’s edge in your sky.`]
            : []),
        ],
        animUrl,
        credit: 'Computed from NASA Besselian elements — eclipse predictions by Fred Espenak, NASA GSFC.',
      };
    }
    if (!sunUpDuringEvent(c, loc)) {
      /* Not a miss in alignment — a miss in timing. Say how
         far off it was: when greatest eclipse happens, how
         deep the Sun is, how far that is from daylight, and
         what the coverage would have been (Alex, 2026-10-27:
         "Is it just a near miss? Should we show how far off
         or something?"). */
      const eq = sunRaDec(c.max);
      const depth = Math.max(1, Math.round(-altAz(eq.ra, eq.dec, c.max, loc.lat, loc.lon).alt));
      const cross = nearestSunCrossing(c.max, loc);
      let rel = '';
      if (cross) {
        const mins = Math.round(Math.abs(cross.time.getTime() - c.max.getTime()) / 60000);
        const dur = mins >= 60 ? `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m` : `${mins} minutes`;
        rel = cross.rising
          ? ` — about ${dur} before sunrise (${fmtTime(cross.time)})`
          : ` — about ${dur} after sunset (${fmtTime(cross.time)})`;
      }
      return {
        heading: `Eclipse estimate — ${where}`,
        lines: [
          'Not visible from here: the Moon’s shadow passes over you at night, while the Sun is below the horizon.',
          `Greatest eclipse is at ${fmtTime(c.max)}, with the Sun ${depth}° below the horizon${rel}. The alignment is real — the Moon would cover about ${Math.round(c.obscuration * 100)}% of the Sun if it happened in daylight.`,
        ],
        animUrl,
        credit: 'Computed from NASA Besselian elements — eclipse predictions by Fred Espenak, NASA GSFC.',
      };
    }
    const lines = [];
    const central = c.c2 && c.c3;
    if (central) {
      const word = c.central === 'annular' ? 'Annularity' : 'Totality';
      lines.push(`C2–C3 — ${word}: ${fmtTime(c.c2)} – ${fmtTime(c.c3)} (${centralDurText(c.c3 - c.c2)})`);
    }
    if (c.c1) lines.push(`C1 — Partial phase begins: ${fmtTime(c.c1)} — Sun ${altNote('sun', c.c1)}`);
    lines.push(
      `Greatest — Maximum: ${fmtTime(c.max)} — magnitude ${c.magnitude.toFixed(2)}, about ${Math.round(c.obscuration * 100)}% of the Sun’s disk covered; Sun ${altNote('sun', c.max)}`,
    );
    if (c.c4) lines.push(`C4 — Partial phase ends: ${fmtTime(c.c4)} — Sun ${altNote('sun', c.c4)}`);
    /* Contact-strip diagram, sharing the lunar figure's
       model (fixed body at center, Moon discs at the
       contacts along its path). Positions arrive from the
       Besselian circumstances in plane coordinates
       (east/north, Sun radii) and are rotated here by each
       instant's parallactic angle, so the figure shows the
       eclipse the way it will actually look in the sky —
       "up" toward the zenith, not celestial north (the
       timeanddate presentation Alex pointed at, 2026-10-27;
       the view rotates ~30 degrees across a long event, so
       each disc takes its own instant's angle). */
    const codes = { c1: 'C1', c2: 'C2', max: 'Greatest', c3: 'C3', c4: 'C4' };
    const dates = { c1: c.c1, c2: c.c2, max: c.max, c3: c.c3, c4: c.c4 };
    const discs = c.strip.map((pt) => {
      const sunEq = sunRaDec(dates[pt.key]);
      const H = (lstDeg(dates[pt.key], loc.lon) - sunEq.ra) * RAD;
      const dec = sunEq.dec * RAD, la = loc.lat * RAD;
      const q = Math.atan2(
        Math.sin(H),
        Math.tan(la) * Math.cos(dec) - Math.sin(dec) * Math.cos(H),
      );
      const E = pt.dx, N = pt.dy;
      return {
        code: codes[pt.key],
        sx: -E * Math.cos(q) + N * Math.sin(q),
        sy: -(E * Math.sin(q) + N * Math.cos(q)),
        greatest: pt.key === 'max',
      };
    });
    return {
      heading: `Eclipse estimate — ${where}`,
      lines,
      diagram: {
        kind: 'solar',
        discs,
        moonR: c.moonR,
        caption: 'The Moon’s path across the Sun — each disc is the Moon at a contact point, shown the way it will look in the sky.',
      },
      animUrl,
      credit: 'Computed from NASA Besselian elements — eclipse predictions by Fred Espenak, NASA GSFC.',
    };
  }
  const c = lunarCircumstances(ev.circ, isoDate);
  if (!c || !c.greatest) return null;
  const kind = ev.title.toLowerCase().includes('total')
    ? 'Total'
    : ev.title.toLowerCase().includes('partial') ? 'Partial' : 'Penumbral';
  const shade = kind === 'Total'
    ? 'the Moon passes fully through Earth’s dark inner shadow'
    : kind === 'Partial'
      ? 'part of the Moon enters Earth’s dark inner shadow'
      : 'the Moon passes only through Earth’s faint outer shadow — expect a soft shading on one side, no dark bite';
  const lines = [];
  const stepLines = [
    ['p1', 'P1', 'Earth’s faint outer shadow first touches the Moon'],
    ['u1', 'U1', 'The dark inner shadow first touches the Moon'],
    ['u2', 'U2', 'Totality begins — the whole Moon is in the dark shadow'],
    ['greatest', null, null],
    ['u3', 'U3', 'Totality ends'],
    ['u4', 'U4', 'The dark inner shadow leaves the Moon'],
    ['p4', 'P4', 'Earth’s shadow leaves the Moon completely'],
  ];
  for (const [key, code, label] of stepLines) {
    if (!c[key]) continue;
    if (key === 'greatest') {
      lines.push(`Greatest eclipse: ${fmtTime(c.greatest)} — ${shade}; Moon ${altNote('moon', c.greatest)}`);
    } else {
      lines.push(`${code} — ${label}: ${fmtTime(c[key])} — Moon ${altNote('moon', c[key])}`);
    }
  }
  /* Moonrise/moonset inside the event window — e.g. the
     Feb 2027 penumbral peaks just after moonrise in New
     England, which is the whole story of that eclipse there. */
  if (c.p1 && c.p4) {
    const eq0 = moonEquatorial(c.p1);
    let prev = altAz(eq0.ra, eq0.dec, c.p1, loc.lat, loc.lon).alt;
    for (let t = c.p1.getTime() + 300000; t <= c.p4.getTime(); t += 300000) {
      const eq = moonEquatorial(new Date(t));
      const a = altAz(eq.ra, eq.dec, new Date(t), loc.lat, loc.lon).alt;
      if (prev < 0 && a >= 0) lines.push(`The Moon rises at ${fmtTime(new Date(t))}, already in eclipse.`);
      if (prev >= 0 && a < 0) lines.push(`The Moon sets at ${fmtTime(new Date(t))}, before the eclipse ends.`);
      prev = a;
    }
  }
  const magLine = kind === 'Penumbral'
    ? `Penumbral magnitude ${c.penMag.toFixed(2)} — how deeply the Moon dips into the faint shadow (1.0 would just touch the dark shadow).`
    : `Umbral magnitude ${c.umbMag.toFixed(2)} — how deeply the Moon enters the dark shadow (1.0 = fully inside).`;
  lines.push(magLine);
  /* The diagram Alex asked to match (the NASA bulletin
     figure he sent, 2026-10-27): Earth's shadow circles
     fixed, and the Moon drawn at each contact point along
     its path — positions from the elements' x/y polynomials
     evaluated at each contact's TD instant, in Earth radii,
     mirrored into screen coords (north up, so the Moon
     travels right to left as in the bulletin). */
  const diagram = ev.circ.x && ev.circ.f3
    ? (() => {
        const dayMs = Date.parse(`${isoDate}T00:00:00Z`);
        const posAt = (date) => {
          const t = (date.getTime() + ev.circ.dT * 1000 - dayMs) / 3600000 - ev.circ.t0;
          return { x: besselPoly(ev.circ.x, t), y: besselPoly(ev.circ.y, t) };
        };
        const discs = [];
        for (const [key, code] of [
          ['p1', 'P1'], ['u1', 'U1'], ['u2', 'U2'], ['greatest', 'Greatest'],
          ['u3', 'U3'], ['u4', 'U4'], ['p4', 'P4'],
        ]) {
          if (!c[key]) continue;
          const p = posAt(c[key]);
          /* Normalized to Moon radii so the sky view's one
             diagram renderer serves both eclipse kinds
             (solar is normalized to Sun radii). */
          discs.push({
            code,
            sx: -p.x / ev.circ.f3,
            sy: -p.y / ev.circ.f3,
            greatest: key === 'greatest',
          });
        }
        return {
          kind: 'lunar',
          discs,
          penR: ev.circ.f1 / ev.circ.f3,
          umbR: ev.circ.f2 / ev.circ.f3,
          moonR: 1,
          caption: 'The Moon’s path through Earth’s shadow — each disc is the Moon at a contact point (north up). The dark circle is the umbra, the faint one the penumbra.',
        };
      })()
    : null;
  return {
    heading: `Eclipse estimate — ${where}`,
    lines,
    diagram,
    animUrl,
    credit: 'Contact times and magnitudes: Fred Espenak, EclipseWise.com.',
  };
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
export function loadCloudClimatology(loc) {
  const key = climKey(loc);
  // Cache the in-flight PROMISE, not just the result: the boot
  // kick, the scores pipeline and the Moon panel can all ask in
  // the same first seconds and must share ONE archive fetch
  // (Alex, 2026-10-26: first load was slow partly because this
  // 20-year request serialized and duplicated).
  const hit = climMemCache.get(key);
  if (hit) return hit;
  const p = loadCloudClimatologyInner(loc, key);
  climMemCache.set(key, p);
  // A failed fetch must not poison the cache — the next caller
  // retries, as before promise-caching.
  p.catch(() => {
    if (climMemCache.get(key) === p) climMemCache.delete(key);
  });
  return p;
}

async function loadCloudClimatologyInner(loc, key) {
  try {
    const raw = hasStorage() && localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.daily) && parsed.daily.length === 366) {
        return parsed.daily;
      }
    }
  } catch {
    /* corrupted cache — fall through to a fresh fetch */
  }
  /* Our own cache first: one shared copy per cell instead of
     every visitor live-hitting the 20-year archive (Alex,
     2026-10-26). A miss on the endpoint still costs one
     archive fetch, but only for the first visitor to a cell,
     ever. Any endpoint failure falls through to the direct
     archive fetch below, unchanged. */
  if (CLIM_ENDPOINT) {
    try {
      const cCtrl = new AbortController();
      const cTimer = setTimeout(() => cCtrl.abort(), 35000);
      const cRes = await fetch(`${CLIM_ENDPOINT}?lat=${loc.lat}&lon=${loc.lon}`, { signal: cCtrl.signal });
      clearTimeout(cTimer);
      if (cRes.ok) {
        const cJson = await cRes.json();
        if (cJson && Array.isArray(cJson.daily) && cJson.daily.length === 366) {
          try {
            if (hasStorage()) localStorage.setItem(key, JSON.stringify({ daily: cJson.daily }));
          } catch {
            /* quota — the in-memory cache still covers this session */
          }
          return cJson.daily;
        }
      }
    } catch {
      /* endpoint unavailable — direct archive fetch below */
    }
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
  // The track also carries the above-horizon points where the
  // satellite is NOT visible — before it lights up and after it
  // winks out, mostly time spent in Earth's shadow (or with the
  // sky not dark yet, or still low). The sky view draws those
  // stretches dotted, ISS Detector style: the station is up there
  // flying that line, it just is not lit. Points carry vis:true
  // on the visible run and vis:false off it; pass start/end/peak
  // stay the VISIBLE window, exactly as before.
  let pre = []; // above-horizon, not-yet-visible points, awaiting a pass
  let lastVis = null; // most recent visible sample, for exact track ends
  const pushPt = (arr, d, el, az, vis, force = false) => {
    const last = arr[arr.length - 1];
    if (force || !last || d - last.time >= 60000) arr.push({ time: d, alt: el, az, vis });
  };
  // The visible run's final sample belongs on the track even when
  // it lands inside the minute spacing, so the drawn line (and its
  // end time label) ends where visibility actually ends.
  const flushVis = () => {
    if (!cur || !cur.inVis || !lastVis) return;
    const last = cur.track[cur.track.length - 1];
    if (!last || last.time.getTime() !== lastVis.time.getTime()) {
      cur.track.push({ ...lastVis, vis: true });
    }
  };
  const finish = (needDuration) => {
    flushVis();
    // Qualification (Alex, 2026-10-22): listed if the pass is
    // genuinely visible for over a minute. The peak bar used
    // to be 18°, which silently dropped real passes ISS
    // Detector shows — the Oct 24 ISS peaks at 17°, magnitude
    // -2, perfectly seeable. 12° is the visibility floor
    // itself (a sample only counts as visible above it), so
    // this no longer hides anything the model calls visible;
    // the pass score carries the quality signal instead.
    if (cur && cur.maxEl > 12 && (!needDuration || cur.end - cur.start > 60000)) {
      delete cur.inVis;
      passes.push(cur);
    }
    cur = null;
    lastVis = null;
  };
  for (let t = now; t < end; t += step) {
    const d = new Date(t);
    const pv = propagate(satrec, d);
    if (!pv || !pv.position) {
      finish(true);
      pre = [];
      continue;
    }
    const gmst = gstime(d);
    const ecf = eciToEcf(pv.position, gmst);
    const look = ecfToLookAngles(observerGd, ecf);
    const el = look.elevation / RAD;
    const az = look.azimuth / RAD;
    if (el <= 0) {
      // Below the horizon: any open pass is complete, and the
      // pre-visible buffer belonged to a span that has ended.
      finish(true);
      pre = [];
      continue;
    }
    const dark = sunElev(d, lat, lon) < -6;
    // cylindrical Earth shadow test for satellite sunlight
    const sd = sunDirECF(d);
    const r2 = ecf.x ** 2 + ecf.y ** 2 + ecf.z ** 2;
    const s = ecf.x * sd.x + ecf.y * sd.y + ecf.z * sd.z;
    const sunlit = !(s < 0 && r2 - s * s < 6371 * 6371);
    const visible = el > 12 && dark && sunlit;
    if (visible) {
      lastVis = { time: d, alt: el, az };
      if (!cur) {
        cur = { start: d, maxEl: el, maxT: d, end: d, startAz: az, endAz: az, mag, track: [...pre], inVis: true };
        pre = [];
        pushPt(cur.track, d, el, az, true, true);
      } else {
        cur.end = d;
        cur.endAz = az;
        if (el > cur.maxEl) {
          cur.maxEl = el;
          cur.maxT = d;
        }
        // Minute-by-minute positions for the pass hover card (the
        // glance line only carries start -> end direction and the
        // peak). Entering the visible run (first point, or back
        // from a shadow gap) is forced so the solid line starts
        // exactly where visibility does.
        const entering = !cur.inVis;
        cur.inVis = true;
        pushPt(cur.track, d, el, az, true, entering);
      }
    } else if (cur) {
      // Above the horizon but not visible: the dotted continuation.
      // flushVis inside the first such call pins the solid line's
      // end; the first shadow point is forced so the dotted line
      // starts right where the solid one stops.
      const wasVis = cur.inVis;
      if (wasVis) flushVis();
      pushPt(cur.track, d, el, az, false, wasVis);
      cur.inVis = false;
    } else {
      pushPt(pre, d, el, az, false);
    }
  }
  finish(false);
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

/* ============================== where to look ============================== */
/* Direction + height above the horizon for an event's object on its own
   night: a glanceable peak (best time, compass direction, angle) plus the
   full track for a hover card. Pure geometry — no network — built on the
   same altAz() the planet visibility and satellite passes use. */

/* The Sun's sky coordinates (RA/Dec in degrees) — the same math sunElev()
   uses for elevation, exposed for altAz(). */
export function sunRaDec(date) {
  const JD = date.getTime() / DAY + 2440587.5;
  const n = JD - 2451545.0;
  const L = (((280.46 + 0.9856474 * n) % 360) + 360) % 360;
  const g = (357.528 + 0.9856003 * n) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  return {
    ra: rev(Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)) / RAD),
    dec: Math.asin(Math.sin(eps) * Math.sin(lambda)) / RAD,
  };
}

/* One planet's sky coordinates at a moment (bodyEquatorial is the engine
   behind planetEphemeris, which only snapshots one date for all planets). */
export function planetRaDec(name, date) {
  const e = bodyEquatorial(name.toLowerCase(), dayNumber(date));
  return { ra: e.ra, dec: e.dec };
}

/* A comet's sky coordinates from its orbital elements
   (comets.json `orbit`: q, e, i, node, argPeri in degrees/AU, tpJd = Julian
   date of perihelion). Two-body Kepler motion — degree-level accuracy,
   plenty for where-to-look guidance. Elongation (degrees from the Sun) is
   included because comets near the Sun live or die by it. */
export function cometEquatorial(orbit, date) {
  const a = orbit.q / (1 - orbit.e);
  const n = 0.9856076686 / Math.pow(a, 1.5); // mean motion, deg/day
  const jd = date.getTime() / DAY + 2440587.5;
  const M = rev(n * (jd - orbit.tpJd)) * RAD;
  // Newton on Kepler's equation; high-eccentricity comets need a better
  // first guess and more iterations than the planets' keplerE allows.
  let E = orbit.e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 50; k++) {
    const dE = (E - orbit.e * Math.sin(E) - M) / (1 - orbit.e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-9) break;
  }
  const xv = a * (Math.cos(E) - orbit.e);
  const yv = a * Math.sqrt(1 - orbit.e * orbit.e) * Math.sin(E);
  const v = Math.atan2(yv, xv);
  const r = Math.hypot(xv, yv);
  const N = orbit.node * RAD, inc = orbit.i * RAD, vw = v + orbit.argPeri * RAD;
  const xh = r * (Math.cos(N) * Math.cos(vw) - Math.sin(N) * Math.sin(vw) * Math.cos(inc));
  const yh = r * (Math.sin(N) * Math.cos(vw) + Math.cos(N) * Math.sin(vw) * Math.cos(inc));
  const zh = r * Math.sin(vw) * Math.sin(inc);
  // Geocentric: add the Sun's heliocentric position, exactly as
  // bodyEquatorial does for the planets, then rotate ecliptic -> equatorial.
  const d = dayNumber(date);
  const sun = helioEcliptic(ORBITAL_ELEMENTS.sun, d);
  const lonsun = rev(sun.vDeg + sun.wDeg);
  const xs = sun.r * Math.cos(lonsun * RAD), ys = sun.r * Math.sin(lonsun * RAD);
  const xg = xh + xs, yg = yh + ys, zg = zh;
  const ecl = (23.4393 - 3.563e-7 * d) * RAD;
  const xe = xg, ye = yg * Math.cos(ecl) - zg * Math.sin(ecl), ze = yg * Math.sin(ecl) + zg * Math.cos(ecl);
  const ra = rev(Math.atan2(ye, xe) / RAD);
  const dec = Math.atan2(ze, Math.hypot(xe, ye)) / RAD;
  const s = sunRaDec(date);
  return { ra, dec, elong: angularSep(ra, dec, s.ra, s.dec) };
}

/* Track one sky position across a window around an anchor time.
   raDecAt(date) -> { ra, dec } (degrees); fixed positions (a shower
   radiant) just ignore the date, moving bodies (Moon, comet) recompute.
   Returns the peak — highest point while the Sun is below `darkBelow`
   (degrees; -6 matches the "dark" test elsewhere), falling back to the
   highest point overall — plus rise/set crossings and hourly samples.
   `daytime` tracks (the Sun itself) ignore darkness entirely.
   `daylightSamples` tracks (the Moon) keep their hourly samples in
   daylight too — the Moon is a daytime target, so its list runs from
   rise to set instead of from sunset. Rise/set are found by walking
   out from the peak across a wider scan, so a rise that happened
   before the window opens (an afternoon moonrise, say) is still
   reported with its real time instead of "already up". */
export function lookTrack(raDecAt, anchor, loc, { startH = -6, hours = 24, darkBelow = -6, daytime = false, daylightSamples = false } = {}) {
  const step = 10 * 60e3;
  const t0 = anchor.getTime() + startH * 3600e3;
  const pts = [];
  for (let t = t0; t <= t0 + hours * 3600e3; t += step) {
    const date = new Date(t);
    const { ra, dec } = raDecAt(date);
    const aa = altAz(ra, dec, date, loc.lat, loc.lon);
    pts.push({ time: date, alt: aa.alt, az: aa.az, sun: sunElev(date, loc.lat, loc.lon) });
  }
  const up = pts.filter((p) => p.alt > 0);
  const darkUp = up.filter((p) => daytime || p.sun < darkBelow);
  const peakPool = darkUp.length ? darkUp : up;
  const peak = peakPool.length
    ? peakPool.reduce((a, b) => (b.alt > a.alt ? b : a))
    : null;
  // Rise/set for the passage the peak belongs to: walk out from the peak
  // over a wider scan than the display window. The window alone misses
  // rises that fall just before it opens — the Moon rises around 2:50 PM
  // on a first-quarter evening, minutes before the 3 PM window start,
  // which used to read as "already up in the evening" with no rise time.
  let rise = null, set = null;
  if (peak) {
    const span = 30 * 3600e3;
    const wide = [];
    for (let t = peak.time.getTime() - span; t <= peak.time.getTime() + span; t += step) {
      const date = new Date(t);
      const { ra, dec } = raDecAt(date);
      const aa = altAz(ra, dec, date, loc.lat, loc.lon);
      wide.push({ time: date, alt: aa.alt, az: aa.az });
    }
    for (let i = 1; i < wide.length; i++) {
      const upCross = wide[i - 1].alt <= 0 && wide[i].alt > 0;
      const downCross = wide[i - 1].alt > 0 && wide[i].alt <= 0;
      if (wide[i].time <= peak.time && upCross) rise = wide[i];
      if (wide[i].time > peak.time && downCross && !set) set = wide[i];
    }
  }
  // Hourly samples for the hover card: night objects only while the Sun is
  // down (a radiant that's still up at noon is not a viewing target), the
  // Sun only while it's up, and daylight-sample tracks (the Moon) for as
  // long as they're up, day or night.
  let samples = pts.filter(
    (p) =>
      p.time.getMinutes() === 0 &&
      p.alt > -3 &&
      (daytime ? p.alt > 0 : daylightSamples ? true : p.sun < 0),
  );
  // Keep only the passage the peak belongs to, with an hour's grace on
  // each side for the "below the horizon" cue rows. A wide window can
  // otherwise mix in the tail of the previous passage (a waning Moon
  // still up in the morning) ahead of that night's rise.
  if (rise || set) {
    const lo = rise ? rise.time.getTime() - 3600e3 : -Infinity;
    const hi = set ? set.time.getTime() + 3600e3 : Infinity;
    samples = samples.filter((p) => p.time.getTime() >= lo && p.time.getTime() <= hi);
  }
  // The passage as a plottable path (10-minute points above the horizon,
  // same passage restriction) for the sky chart's track line.
  const path = pts.filter((p) => {
    if (p.alt <= 0) return false;
    if (rise && p.time.getTime() < rise.time.getTime() - step) return false;
    if (set && p.time.getTime() > set.time.getTime()) return false;
    return true;
  });
  return {
    peak,
    peakInDark: !!peak && (daytime || peak.sun < darkBelow),
    rise,
    set,
    upAllWindow: up.length === pts.length,
    neverUp: up.length === 0,
    samples,
    path,
    // Position at ANY moment, from the same coordinate source as the
    // track — including moments outside this track's passage. The sky
    // view's "now" dot needs it: the morning before an event night,
    // the object is up on the PREVIOUS passage, and interpolating
    // this track's path rightly returns nothing there.
    posAt: (date) => {
      const { ra, dec } = raDecAt(date);
      const aa = altAz(ra, dec, date, loc.lat, loc.lon);
      return { time: date, alt: aa.alt, az: aa.az };
    },
  };
}

/* For an eclipse, the moment that matters is greatest eclipse,
   not the body's daily culmination — lookTrack's peak is the
   culmination, which put the Jul 2028 eclipse's sky-view
   guidance (and peak marker) at solar noon, 6:30 AM in the
   viewer's timezone, instead of at the eclipse (Alex,
   2026-10-27). Swap the track's peak for the body's position
   at greatest eclipse when circumstances are available; the
   rest of the track (path, rise/set, samples) is unchanged. */
/* Mark an eclipse track's path with the satellite-style
   visibility flags the sky chart already renders: points
   inside the eclipse span (first to last contact) stay
   solid, the rest of the body's day goes dotted (Alex,
   2026-10-27 — "show dotted line for entire sun movement
   for times outside of eclipse, similar to how we handle
   satellites in earth shadow"). When circumstances exist
   but there is no local span (a shadow miss, or contacts
   that fall while the body is down), every point is
   dotted — the honest picture. No circumstances, no
   marking: the track stays plain. */
export function markEclipseSpan(track, circ, from, to) {
  if (!track || !track.path || !circ) return track;
  const a = from ? from.getTime() : null;
  const b = to ? to.getTime() : null;
  const path = track.path.map((p) => ({
    ...p,
    vis: a != null && b != null ? (p.time.getTime() >= a && p.time.getTime() <= b) : false,
  }));
  return { ...track, path };
}

export function withEclipsePeak(ev, loc, track) {
  if (!ev || !ev.circ || !track) return track;
  const isoDate = (ev.id || '').slice(-10);
  let when = null, raDecAt = null;
  if (ev.solar) {
    const c = solarCircumstances(ev.circ, isoDate, loc.lat, loc.lon);
    if (c && c.max) { when = c.max; raDecAt = sunRaDec; }
  } else {
    const c = lunarCircumstances(ev.circ, isoDate);
    if (c && c.greatest) { when = c.greatest; raDecAt = moonEquatorial; }
  }
  if (!when) return track;
  const eq = raDecAt(when);
  const aa = altAz(eq.ra, eq.dec, when, loc.lat, loc.lon);
  const sun = sunElev(when, loc.lat, loc.lon);
  return {
    ...track,
    peak: { time: when, alt: aa.alt, az: aa.az, sun },
    peakInDark: ev.solar ? true : sun < -6,
  };
}

/* Interpolate a track path (lookTrack path or a satellite pass track —
   both are {time, alt, az} point lists) at an arbitrary moment, for the
   sky chart's live "where it is right now" dot. Azimuth takes the short
   way around the 360/0 seam. Null when the moment is outside the path. */
export function pathPointAt(path, date) {
  if (!path || path.length < 2) return null;
  const t = date.getTime();
  if (t < path[0].time.getTime() || t > path[path.length - 1].time.getTime()) return null;
  for (let i = 1; i < path.length; i++) {
    if (path[i].time.getTime() >= t) {
      const a = path[i - 1], b = path[i];
      const f = (t - a.time.getTime()) / (b.time.getTime() - a.time.getTime());
      let dAz = b.az - a.az;
      if (dAz > 180) dAz -= 360;
      if (dAz < -180) dAz += 360;
      return { time: date, alt: a.alt + (b.alt - a.alt) * f, az: (a.az + dAz * f + 360) % 360 };
    }
  }
  return null;
}

/* Where the phone itself is pointing, from a DeviceOrientation event's
   alpha/beta/gamma (degrees). Builds the spec rotation (intrinsic
   Z-X'-Y'') and takes the direction the back of the phone faces —
   hold the phone up in front of you and that is your line of sight
   over the top of it, which is how the finder apps aim. Returns
   { az, el } in the event's own (magnetic-north) frame; callers add
   the local declination to get true bearings. Earth frame from the
   rotation is x East, y North, z Up. */
export function devicePointing(alpha, beta, gamma) {
  if (alpha == null || beta == null || gamma == null) return null;
  const a = alpha * RAD, b = beta * RAD, g = gamma * RAD;
  // R = Rz(a) Rx(b) Ry(g), applied to the device back vector (0,0,-1).
  const x1 = -Math.sin(g);
  const y1 = Math.cos(g) * Math.sin(b);
  const z1 = -Math.cos(g) * Math.cos(b);
  const x = x1 * Math.cos(a) - y1 * Math.sin(a);
  const y = x1 * Math.sin(a) + y1 * Math.cos(a);
  const el = Math.asin(Math.max(-1, Math.min(1, z1))) / RAD;
  const az = rev(Math.atan2(x, y) / RAD);
  return { az, el };
}

/* The same aim from a fused orientation quaternion — the
   AbsoluteOrientationSensor reading ([x, y, z, w], the rotation
   that carries device axes into Earth axes: x east, y north,
   z up; the OS sensor fusion behind Android's rotation vector).
   The back of the phone is device (0,0,-1), which under R(q) is
   the negated third column of the rotation matrix. Must agree
   with devicePointing on the equivalent Euler orientation —
   node-tested over a spread of poses. Returns { az, el } in the
   magnetic frame, like devicePointing. */
export function quatAim(q) {
  if (!q || q.length < 4) return null;
  const [x, y, z, w] = q;
  const bx = -2 * (x * z + w * y);
  const by = -2 * (y * z - w * x);
  const bz = 2 * (x * x + y * y) - 1;
  const el = Math.asin(Math.max(-1, Math.min(1, bz))) / RAD;
  const az = rev(Math.atan2(bx, by) / RAD);
  return { az, el };
}

/* Spherical interpolation between two orientation quaternions —
   the correct way to smooth orientation: no Euler wrap, no gimbal
   artifacts, constant angular speed. t in [0, 1]. */
export function slerpQuat(qa, qb, t) {
  let [ax, ay, az, aw] = qa;
  const [bx, by, bz, bw] = qb;
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  // Take the short way around: q and -q are the same orientation.
  const s = dot < 0 ? -1 : 1;
  dot = Math.abs(dot);
  if (dot > 0.9995) {
    // Nearly identical: linear blend + normalize is accurate here.
    const r = [
      ax + (s * bx - ax) * t,
      ay + (s * by - ay) * t,
      az + (s * bz - az) * t,
      aw + (s * bw - aw) * t,
    ];
    const l = Math.hypot(r[0], r[1], r[2], r[3]) || 1;
    return [r[0] / l, r[1] / l, r[2] / l, r[3] / l];
  }
  const theta = Math.acos(Math.min(1, dot));
  const sinT = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sinT;
  const wb = Math.sin(t * theta) / sinT;
  return [
    wa * ax + wb * s * bx,
    wa * ay + wb * s * by,
    wa * az + wb * s * bz,
    wa * aw + wb * s * bw,
  ];
}

/* Dragging the sky window: exact grab. Axis-separated az/el steps
   cannot track a finger — at 55 degrees up a degree of azimuth is
   only about half a degree of sky, and prescribed rotations around
   the camera axes swing the center off its elevation — so instead
   the gesture remembers the sky direction it grabbed and, on every
   move, steps the view center so that direction stays under the
   finger (grabPan below: one Jacobian feedback step per move).
   Screen offsets are in tangent-plane units: (pixels from the
   frame center) / (focal length in pixels), y up. The frame is the
   same one SkyWindow projects with: C the center direction, U the
   screen-up direction, R = C x U. */
/* View frames as direction vectors. A frame is { C, U }: C the
   view-center direction, U the screen-up direction, both unit
   vectors in East/North/Up coordinates; R = C x U completes it.
   Frames are CARRIED (rotated rigidly) while dragging rather than
   re-derived from az/el at every step: a frame rebuilt from az/el
   takes its up from world up, and world up's projection onto the
   view is undefined at the zenith — pass within a few degrees of
   overhead and the rebuilt up whips around, spinning the whole
   field (Alex's screen recording, 2026-10-21: at up 84-85 the
   readout whipped SW-WNW-NW-NNE while the field rotated under
   small drags). A carried frame crosses the zenith smoothly;
   only the az/el readout is ill-conditioned there, which is
   geometry, not a bug. */
export function dirVec(az, el) {
  const a = az * RAD, e = el * RAD;
  return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
}

export function azElOf(C) {
  return {
    az: ((Math.atan2(C[0], C[1]) / RAD) % 360 + 360) % 360,
    el: Math.asin(Math.max(-1, Math.min(1, C[2]))) / RAD,
  };
}

function perpOf(C, hint) {
  if (!hint) return null;
  const d = hint[0] * C[0] + hint[1] * C[1] + hint[2] * C[2];
  const v = [hint[0] - d * C[0], hint[1] - d * C[1], hint[2] - d * C[2]];
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-6 ? [v[0] / l, v[1] / l, v[2] / l] : null;
}

/* Build a full frame from a center direction and an optional up
   hint (a carried up from a drag, or the phone's real up). With
   no usable hint, up falls back to world up, then to north at the
   zenith itself, where world up has no projection left. */
export function frameFrom(C, upHint) {
  const U = perpOf(C, upHint) || perpOf(C, [0, 0, 1]) || perpOf(C, [0, 1, 0]) || [1, 0, 0];
  let R = [C[1] * U[2] - C[2] * U[1], C[2] * U[0] - C[0] * U[2], C[0] * U[1] - C[1] * U[0]];
  const lr = Math.hypot(R[0], R[1], R[2]) || 1;
  R = [R[0] / lr, R[1] / lr, R[2] / lr];
  return { C, U, R };
}

/* Rotate a whole frame rigidly around an axis. */
export function rotateFrame(frame, axis, ang) {
  return frameFrom(rotAround(frame.C, axis, ang), rotAround(frame.U, axis, ang));
}

/* Keep a frame's center elevation inside [lo, hi] by rotating the
   whole frame around its own right axis — rigidly, so the carried
   up survives the clamp. */
export function clampFrameEl(frame, lo, hi) {
  const { el } = azElOf(frame.C);
  if (el >= lo && el <= hi) return { C: frame.C, U: frame.U };
  const lim = el < lo ? lo : hi;
  const fr = frameFrom(frame.C, frame.U);
  const d = (Math.abs(lim - el) * Math.PI) / 180;
  const a = rotateFrame(fr, fr.R, d);
  const b = rotateFrame(fr, fr.R, -d);
  return Math.abs(azElOf(a.C).el - lim) <= Math.abs(azElOf(b.C).el - lim) ? a : b;
}

function rotAround(v, axis, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const d = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
  return [
    v[0] * c + (axis[1] * v[2] - axis[2] * v[1]) * s + axis[0] * d * (1 - c),
    v[1] * c + (axis[2] * v[0] - axis[0] * v[2]) * s + axis[1] * d * (1 - c),
    v[2] * c + (axis[0] * v[1] - axis[1] * v[0]) * s + axis[2] * d * (1 - c),
  ];
}

/* The sky direction shown at a screen offset from a view frame. */
export function screenPoint(frame, nx, ny) {
  const { C, U, R } = frameFrom(frame.C, frame.U);
  const P = [
    C[0] + nx * R[0] + ny * U[0],
    C[1] + nx * R[1] + ny * U[1],
    C[2] + nx * R[2] + ny * U[2],
  ];
  const l = Math.hypot(P[0], P[1], P[2]) || 1;
  return [P[0] / l, P[1] / l, P[2] / l];
}

function uvOf(P, fr) {
  const d = P[0] * fr.C[0] + P[1] * fr.C[1] + P[2] * fr.C[2];
  return {
    u: (P[0] * fr.R[0] + P[1] * fr.R[1] + P[2] * fr.R[2]) / d,
    v: (P[0] * fr.U[0] + P[1] * fr.U[1] + P[2] * fr.U[2]) / d,
  };
}

/* One feedback step toward the view frame that puts sky direction
   P at screen offset (nx, ny): measure P's current offset, take a
   single Jacobian step (numeric 2x2, from rotating the frame
   around its up and right axes), clamped small. Called once per
   pointer move, so the error is re-measured from the true position
   every event — that feedback is what makes it track a finger
   exactly. The frame is transported by the step's own rotations,
   never rebuilt from az/el, so the step stays smooth through the
   zenith patch where an az/el-parametrized frame folds. */
export function grabPan(frame, P, nx, ny) {
  const fr = frameFrom(frame.C, frame.U);
  if ((P[0] * fr.C[0] + P[1] * fr.C[1] + P[2] * fr.C[2]) < 0.05) return { C: fr.C, U: fr.U };
  const { u, v } = uvOf(P, fr);
  const eu = nx - u, ev = ny - v;
  if (Math.abs(eu) < 1e-7 && Math.abs(ev) < 1e-7) return { C: fr.C, U: fr.U };
  const h = 1e-4;
  const a1 = uvOf(P, frameFrom(rotAround(fr.C, fr.U, h), fr.U));
  const a2 = uvOf(P, rotateFrame(fr, fr.R, h));
  const j00 = (a1.u - u) / h, j10 = (a1.v - v) / h;
  const j01 = (a2.u - u) / h, j11 = (a2.v - v) / h;
  const det = j00 * j11 - j01 * j10;
  if (Math.abs(det) < 1e-4) return { C: fr.C, U: fr.U };
  const clampStep = (x) => Math.max(-0.08, Math.min(0.08, x));
  const tU = clampStep((eu * j11 - ev * j01) / det);
  const tR = clampStep((j00 * ev - j10 * eu) / det);
  const step1 = frameFrom(rotAround(fr.C, fr.U, tU), fr.U);
  const out = rotateFrame(step1, step1.R, tR);
  return { C: out.C, U: out.U };
}

/* Where-to-look for one normalized event, as an array of
   { label, track, note } — one entry per object (two for a conjunction).
   Returns null when the event's object has no computable position. */
export function eventLook(ev, loc) {
  if (!ev || !loc || loc.lat == null || loc.lon == null) return null;
  const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  if (ev.type === 'shower') {
    if (ev.radiantRa == null || ev.radiantDec == null) return null;
    const ra = ev.radiantRa, dec = ev.radiantDec;
    return [{
      label: `${ev.name} radiant`,
      track: lookTrack(() => ({ ra, dec }), ev.date, loc),
      note: 'Meteors stream out from the radiant in every direction — don’t stare straight at it. Look about halfway up the sky, a little off to one side of it, where the streaks run longest.',
    }];
  }
  if (ev.type === 'planet') {
    const looks = (ev.bodies || []).map((b) => ({
      label: cap1(b),
      track: lookTrack((d) => planetRaDec(b, d), ev.date, loc),
      note: null,
    }));
    return looks.length ? looks : null;
  }
  if (ev.type === 'eclipse' && !ev.solar) {
    const iso = (ev.id || '').slice(-10);
    const circ = ev.circ ? lunarCircumstances(ev.circ, iso) : null;
    return [{
      label: 'Moon',
      // The Moon is up in daylight too: widen the window to that morning
      // and keep samples from rise to set, not just after sunset.
      // Anchor the window on the TRUE greatest instant, not
      // ev.date: catalog dates are UT dates, so an early-UTC
      // eclipse (greatest 03:22 UTC) happens the PREVIOUS
      // local evening in the Americas — anchoring on ev.date
      // drew the next night's passage while the estimate and
      // peak described the real one (found 2026-10-27 when
      // the contact-span marking found no overlap).
      track: withEclipsePeak(ev, loc, markEclipseSpan(
        lookTrack((d) => moonEquatorial(d), circ?.greatest || ev.date, loc, { startH: -15, hours: 30, daylightSamples: true }),
        circ, circ?.p1, circ?.p4,
      )),
      note: null,
    }];
  }
  if (ev.type === 'eclipse' && ev.solar) {
    const visible = eclipseVisibleFrom(ev, loc);
    const iso = (ev.id || '').slice(-10);
    const circ = ev.circ ? solarCircumstances(ev.circ, iso, loc.lat, loc.lon) : null;
    /* Scan the LOCATION's eclipse day, not the viewer's:
       the window anchors at local midnight of the day
       containing greatest eclipse (in the location's own
       timezone) when the tz is known, with an hour of
       margin each side; the passage restriction inside
       lookTrack trims any spill into the adjacent days.
       Without a tz, fall back to the old browser-day scan. */
    /* The day's anchor instant: greatest eclipse when
       visible, the max-eclipse instant at night (atMax), or
       closest approach on a miss (missAt) — the latter two
       were missing here at first, so not-visible eclipses
       silently fell back to the viewer's day and their Sun
       tracks started at 7 AM in South Africa (Alex,
       2026-10-27). */
    const anchorInstant = circ ? (circ.max || circ.atMax || circ.missAt || null) : null;
    const dayStart = anchorInstant && loc.tz ? zonedDayStart(anchorInstant, loc.tz) : null;
    const scanned = dayStart
      ? lookTrack((d) => sunRaDec(d), dayStart, loc, { startH: -1, hours: 26, daytime: true })
      : lookTrack((d) => sunRaDec(d), ev.date, loc, { startH: -21, hours: 24, daytime: true });
    return [{
      label: 'Sun',
      track: withEclipsePeak(ev, loc, markEclipseSpan(scanned, circ, circ?.c1, circ?.c4)),
      note: visible
        ? 'A daytime event — this is the Sun’s path across your sky that day. The solid stretch of the line is the eclipse itself, first contact to last; dotted is the rest of the Sun’s day. Never look at the Sun without eclipse glasses or a proper solar filter.'
        : `This eclipse isn’t visible from ${loc.name || 'your location'} — this is the Sun’s path at home that day.`,
    }];
  }
  if (ev.type === 'comet') {
    if (!ev.orbit) return null;
    const track = lookTrack((d) => cometEquatorial(ev.orbit, d), ev.date, loc, { darkBelow: 0 });
    const { elong } = cometEquatorial(ev.orbit, ev.date);
    return [{
      label: ev.name,
      track,
      note: `Only about ${Math.round(elong)}° from the Sun at perihelion — a twilight target at best, low in the glow just after sunset or before sunrise.`,
    }];
  }
  return null;
}
