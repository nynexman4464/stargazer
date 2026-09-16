/* STARGAZER — astronomy math, event engine, scoring. Pure logic, no JSX.
 * (Ported faithfully from the original vanilla app.js.) */
import {
  propagate,
  gstime,
  eciToEcf,
  ecfToLookAngles,
} from 'satellite.js';

/* ============================== config ============================== */
export const DEFAULT_LOC = { name: 'Medford, MA', lat: 42.4184, lon: -71.1062 };
// Medford Bortle 8 inferred from Sky & Telescope zenith SQM in adjacent Arlington (17.9)
// and Cambridge (17.3-17.4) — no published Medford measurement. Only shown while home is Medford.
export const HOME_BORTLE = {
  value: '8',
  source:
    'Inferred from Sky & Telescope zenith SQM readings in adjacent Arlington and Cambridge; no Medford measurement published.',
};
export const SATS = [
  { norad: 25544, name: 'ISS' },
  { norad: 48274, name: 'Tiangong' },
  { norad: 20580, name: 'Hubble' },
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
export const GLOSSARY = [
  ['Bortle scale', '1-to-9 rating of light pollution. 1 is pristine desert darkness, 9 is downtown. Lower means darker.'],
  ['Magnitude', 'How bright something looks — and it\u2019s backwards: lower (or negative) means brighter. Venus is about \u22124; the faintest stars most people can see are around 6.'],
  ['Opposition', 'A planet sits opposite the sun in our sky — so it\u2019s at its closest, brightest, and up all night. The best time to look at it.'],
  ['Conjunction', 'Two planets (or the moon and a planet) appear close together in the sky. Just a line-of-sight thing — they\u2019re still millions of miles apart.'],
  ['Perihelion', 'When a comet is closest to the sun. Usually its brightest moment — unless it\u2019s so close to the sun we can\u2019t see it at all.'],
  ['Penumbral eclipse', 'The moon drifts through Earth\u2019s faint outer shadow. Just a subtle shading — the least dramatic kind of lunar eclipse.'],
  ['Radiant', 'The patch of sky meteors appear to fly out from during a shower. Named after its constellation — Perseids radiate from Perseus.'],
  ['Go score', 'Our 0\u2013100 \u201cshould you go outside\u201d rating, built from cloud cover, moonlight, and how special the event is.'],
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
  if (d > 1) return `in ${d}d ${h % 24}h`;
  if (h > 1) return `in ${h}h ${Math.floor(ms / 60000) % 60}m`;
  const m = Math.max(1, Math.floor(ms / 60000));
  return `in ${m}m`;
}
export function isoDay(d) {
  return (
    d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
  );
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
export async function cloudCover(date, loc, cache) {
  const key = isoDay(date);
  if (cache[key] !== undefined) return cache[key];
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat.toFixed(3)}&longitude=${loc.lon.toFixed(3)}` +
      `&hourly=cloud_cover&start_date=${key}&end_date=${key}&timezone=auto`;
    const r = await fetch(url);
    const j = await r.json();
    const times = j.hourly.time;
    const vals = j.hourly.cloud_cover;
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
    cache[key] = best;
    return best;
  } catch {
    return null;
  }
}

export async function goScore(ev, loc, cache) {
  const daysOut = (ev.date - Date.now()) / DAY;
  if (daysOut > 15) return null; // beyond forecast range
  const cloud = await cloudCover(ev.date, loc, cache);
  const illum = moonIllum(ev.date);
  let score = 55;
  const factors = [];
  if (cloud === null) {
    factors.push({ icon: 'cloudOff', text: 'forecast unavailable' });
  } else {
    factors.push({ icon: 'cloud', text: `${cloud}% clouds` });
    if (cloud < 15) score += 28;
    else if (cloud < 40) score += 14;
    else if (cloud < 70) score -= 8;
    else score -= 28;
  }
  const moonSensitive = ev.type === 'shower' || ev.type === 'comet';
  if (moonSensitive) {
    factors.push({ icon: 'moon', text: `${Math.round(illum * 100)}% ${moonName(illum)}` });
    if (illum > 0.75) score -= 20;
    else if (illum > 0.5) score -= 10;
    else if (illum < 0.25) score += 6;
  }
  if (ev.tier === 'drive') score += 6;
  if (ev.tier === 'expedition') score += 10;
  score = Math.max(5, Math.min(99, Math.round(score)));
  return { score, factors, label: score >= 78 ? 'Go' : score >= 55 ? 'Maybe' : 'Risky' };
}

/* ============================== aurora ============================== */
/* Pure verdict builder — kp, ovation probability near observer, observer latitude.
 * Keeps the plain-language copy in one testable place. */
export function auroraVerdict(kp, prob, lat) {
  // Kp runs 0-9, a global gauge of geomagnetic activity.
  const kps = `Kp ${kp.toFixed(1)}`;
  let verdict, sub, band;
  if (lat >= 55) {
    // Auroral zone (e.g. Fairbanks): the observer sits under the aurora's
    // usual ring, so even modest activity can light it up after dark.
    if (kp >= 4) {
      band = 'possible';
      verdict = 'Good chance — look north after dark.';
      sub = `${kps} is active, and you're right under the aurora's usual ring around the North Pole. If the sky is dark and clear, look north.`;
    } else if (kp >= 2) {
      band = 'quiet';
      verdict = 'Possible if the sky cooperates.';
      sub = `${kps} is middling. You're sitting under the aurora's usual ring, so even modest activity can light it up once it's properly dark.`;
    } else {
      band = 'quiet';
      verdict = 'Quiet for now.';
      sub = `${kps} — calm space weather, and the ring overhead is quiet. (Kp runs 0–9; this far north, even a 2 or 3 can put on a show after dark.)`;
    }
  } else if (kp >= 7) {
    band = 'storm';
    verdict = 'Get outside — aurora likely visible from here.';
    sub = `${kps} is storm-level. The northern lights can reach well south of their usual ring tonight — look north, away from city lights.`;
  } else if (kp >= 5.5) {
    band = 'possible';
    verdict = 'Possible — watch the northern horizon.';
    sub = `${kps}. Strong enough to drag the aurora's usual ring around the North Pole down toward you — you might catch a glow low in the north if skies are dark and clear.`;
  } else if (kp >= 4) {
    band = 'quiet';
    verdict = 'Quiet for now.';
    sub = `${kps}. The aurora is sticking to its usual ring around the North Pole. Check back when activity picks up.`;
  } else {
    band = 'quiet';
    verdict = 'Quiet for now.';
    sub = `${kps} — calm space weather. The aurora's ring is parked around the Arctic, far north of us. (Kp runs 0–9; about 5 is when it gets interesting this far south.)`;
  }
  if (prob !== null && prob !== undefined && prob > 5) {
    sub += ` NOAA's model puts aurora probability near you at ~${Math.round(prob)}%.`;
  }
  if (lat < 40 && kp < 7) {
    band = 'south';
    verdict = 'Too far south tonight.';
    sub = `${kps}. From here you'd need a serious storm (Kp 8+) to pull the aurora down this far.`;
  }
  return { verdict, sub, band };
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
async function utcOffsetSeconds(loc) {
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
        const v = auroraVerdict(kp, null, loc.lat);
        return { label: w.label, kp, verdict: v.verdict, band: v.band };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/* ============================== satellite passes ============================== */
export async function fetchTLE(norad) {
  const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${norad}&FORMAT=TLE`);
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
}

/* satrec: built by the caller via satellite.js twoline2satrec (kept injectable for tests) */
export function computePasses(satrec, lat, lon, hours) {
  // NOTE: satellite.js v5+ ecfToLookAngles takes observer as geodetic (radians), not ECF
  const observerGd = { latitude: lat * RAD, longitude: lon * RAD, height: 0.05 };
  const step = 30 * 1000;
  const now = Date.now();
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
      if (!cur) cur = { start: d, maxEl: el, maxT: d, end: d, startAz: az, endAz: az };
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
