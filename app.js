/* STARGAZER — "what's worth looking up for" */
'use strict';

/* ============================== config ============================== */
const DEFAULT_LOC = { name: 'Medford, MA', lat: 42.4184, lon: -71.1062 };
// Medford Bortle 8 inferred from Sky & Telescope zenith SQM in adjacent Arlington (17.9)
// and Cambridge (17.3-17.4) — no published Medford measurement. Only shown while home is Medford.
const HOME_BORTLE = { value: '8',
  source: 'Inferred from Sky & Telescope zenith SQM readings in adjacent Arlington and Cambridge; no Medford measurement published.' };
const SATS = [
  { norad: 25544, name: 'ISS' },
  { norad: 48274, name: 'Tiangong' },
  { norad: 20580, name: 'Hubble' },
];
const TIER_META = {
  backyard:   { label: 'Backyard',       icon: '🏠', blurb: 'Step outside tonight.' },
  drive:      { label: 'Dark-sky drive', icon: '🚗', blurb: 'Worth an hour in the car.' },
  expedition: { label: 'Expedition',     icon: '✈️', blurb: 'Once in a decade. Book travel.' },
};
const TYPE_META = {
  shower:      { label: 'Showers',  icon: '☄️', blurb: 'Meteor showers: bits of comet dust burning up. Best after midnight.' },
  eclipse:     { label: 'Eclipses', icon: '🌑', blurb: 'Solar and lunar eclipses: shadows lining up between sun, Earth, and moon.' },
  planet:      { label: 'Planets',  icon: '🪐', blurb: 'Oppositions (planet at its best) and conjunctions (planets close together in the sky).' },
  comet:       { label: 'Comets',   icon: '💫', blurb: 'Visiting ice-balls from the outer solar system. Bright ones are rare.' },
};

const state = {
  loc: loadLoc(),
  home: loadHome(),
  tier: 'all',
  type: 'all',
  events: [],
  spots: [],
  sat: SATS[0],
  passes: [],
  weatherCache: {},
  scores: {},
};

function loadHome() {
  try {
    const s = JSON.parse(localStorage.getItem('stargazer.home'));
    if (s && typeof s.lat === 'number') return s;
  } catch (e) {}
  return { ...DEFAULT_LOC };
}
function saveHome() { localStorage.setItem('stargazer.home', JSON.stringify(state.home)); }
function isAway() {
  return haversine(state.home.lat, state.home.lon, state.loc.lat, state.loc.lon) > 50;
}

function loadLoc() {
  try {
    const s = JSON.parse(localStorage.getItem('stargazer.loc'));
    if (s && typeof s.lat === 'number') return s;
  } catch (e) {}
  return { ...DEFAULT_LOC };
}
function saveLoc() { localStorage.setItem('stargazer.loc', JSON.stringify(state.loc)); }

/* ============================== astronomy utils ============================== */
const RAD = Math.PI / 180, DAY = 86400000;

function moonIllum(date) {
  const synodic = 29.53058867;
  const ref = Date.UTC(2000, 0, 6, 18, 14) / DAY;
  let age = (date.getTime() / DAY - ref) % synodic;
  if (age < 0) age += synodic;
  return (1 - Math.cos(2 * Math.PI * age / synodic)) / 2;
}
function moonName(illum) {
  if (illum < 0.06) return 'new moon';
  if (illum < 0.4) return 'crescent moon';
  if (illum < 0.6) return 'half moon';
  if (illum < 0.94) return 'gibbous moon';
  return 'full moon';
}

/* solar position -> observer sun elevation in degrees */
function sunElev(date, lat, lon) {
  const JD = date.getTime() / DAY + 2440587.5;
  const n = JD - 2451545.0;
  const L = ((280.460 + 0.9856474 * n) % 360 + 360) % 360;
  const g = (357.528 + 0.9856003 * n) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const RA = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const GMST = ((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24;
  const HA = (((GMST + lon / 15) % 24) * 15 - RA / RAD) * RAD;
  const latR = lat * RAD;
  return Math.asin(
    Math.sin(dec) * Math.sin(latR) + Math.cos(dec) * Math.cos(latR) * Math.cos(HA)
  ) / RAD;
}
/* unit vector toward the sun in ECF coords */
function sunDirECF(date) {
  const JD = date.getTime() / DAY + 2440587.5;
  const n = JD - 2451545.0;
  const L = ((280.460 + 0.9856474 * n) % 360 + 360) % 360;
  const g = (357.528 + 0.9856003 * n) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const RA = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const GMST = (((18.697374558 + 24.06570982441908 * n) % 24 + 24) % 24) / 24 * 2 * Math.PI;
  // equatorial -> ECF rotation by GMST
  const x = Math.cos(dec) * Math.cos(RA), y = Math.cos(dec) * Math.sin(RA), z = Math.sin(dec);
  return {
    x: x * Math.cos(GMST) + y * Math.sin(GMST),
    y: -x * Math.sin(GMST) + y * Math.cos(GMST),
    z,
  };
}
function compass(azDeg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16];
}
function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function fmtDate(d) {
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
function countdown(to) {
  const ms = to - Date.now();
  if (ms < 0) return 'now';
  const h = Math.floor(ms / 3600000), d = Math.floor(h / 24);
  if (d > 1) return `in ${d}d ${h % 24}h`;
  if (h > 1) return `in ${h}h ${Math.floor(ms / 60000) % 60}m`;
  const m = Math.max(1, Math.floor(ms / 60000));
  return `in ${m}m`;
}
function isoDay(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* ============================== data loading ============================== */
async function loadJSON(path) {
  try {
    const r = await fetch(path);
    if (!r.ok) throw 0;
    return await r.json();
  } catch (e) { return null; }
}

function normalizeEvents(showers, eclipses, conjs, comets) {
  const out = [];
  const push = (e) => {
    const date = e.date instanceof Date ? e.date : new Date(e.date + 'T21:00:00');
    if (isNaN(date)) return;
    out.push({ ...e, date });
  };
  // meteor showers — all backyard events
  (showers?.events || []).forEach(s => push({
    ...s, kind: 'shower', type: 'shower', tier: 'backyard',
    title: `${s.name} meteor shower`,
    desc: [
      s.peak_night ? `Peak night ${s.peak_night}.` : '',
      s.rate ? `Rates: ${s.rate}.` : '',
      s.note || '',
      s.moon ? `Moon: ${s.moon}.` : '',
    ].filter(Boolean).join(' '),
  }));
  // eclipses — show NE-visible ones plus total solar eclipses anywhere (expedition-worthy)
  const allEcl = [...(eclipses?.solar || []).map(e => ({ ...e, solar: true })),
                  ...(eclipses?.lunar || []).map(e => ({ ...e, solar: false }))];
  allEcl.forEach(e => {
    const ne = !!e.new_england;
    if (!ne && !(e.solar && e.type === 'total')) return; // not worth tracking
    const tier = (e.solar && e.type === 'total') ? 'expedition'
      : (!e.solar && e.type === 'total') ? 'drive'
      : 'backyard';
    push({
      ...e, kind: 'eclipse', type: 'eclipse', tier,
      title: `${cap(e.type)} ${e.solar ? 'solar' : 'lunar'} eclipse`,
      desc: [e.ne_note || '', e.regions ? `Where: ${e.regions}` : ''].filter(Boolean).join(' '),
    });
  });
  // planetary conjunctions & oppositions — backyard
  (conjs?.events || []).forEach(c => push({
    ...c, kind: c.kind, type: 'planet', tier: 'backyard',
    title: c.title, desc: c.detail,
  }));
  // comets — only credible prospects make the list; notes are honest about visibility
  (comets?.events || []).forEach(c => {
    const per = new Date(c.perihelion + 'T12:00:00');
    push({
      ...c, kind: 'comet', type: 'comet', tier: 'backyard',
      title: isNaN(per) ? c.name : `${c.name} — perihelion ${fmtDate(per)}`,
      desc: [c.magnitude_peak ? `Peak magnitude ${c.magnitude_peak}.` : '', c.note || ''].filter(Boolean).join(' '),
    });
  });
  // keep events whose night hasn't passed
  const now = Date.now() - DAY;
  return out.filter(e => e.date.getTime() > now).sort((a, b) => a.date - b.date);
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ============================== weather / scoring ============================== */
async function cloudCover(date) {
  const key = isoDay(date);
  if (state.weatherCache[key] !== undefined) return state.weatherCache[key];
  try {
    const { lat, lon } = state.loc;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
      `&hourly=cloud_cover&start_date=${key}&end_date=${key}&timezone=auto`;
    const r = await fetch(url);
    const j = await r.json();
    const times = j.hourly.time, vals = j.hourly.cloud_cover;
    // prefer 10pm local, fall back to darkest hour available
    let best = vals[Math.floor(vals.length / 2)], bestScore = 1e9;
    times.forEach((t, i) => {
      const hr = parseInt(t.slice(11, 13), 10);
      const dist = Math.min(Math.abs(hr - 22), 24 - Math.abs(hr - 22));
      if (dist < bestScore) { bestScore = dist; best = vals[i]; }
    });
    state.weatherCache[key] = best;
    return best;
  } catch (e) { return null; }
}

async function goScore(ev) {
  const daysOut = (ev.date - Date.now()) / DAY;
  if (daysOut > 15) return null; // beyond forecast range
  const cloud = await cloudCover(ev.date);
  const illum = moonIllum(ev.date);
  let score = 55;
  const factors = [];
  if (cloud === null) {
    factors.push(['☁️', 'forecast unavailable']);
  } else {
    factors.push(['☁️', `${cloud}% clouds`]);
    if (cloud < 15) score += 28;
    else if (cloud < 40) score += 14;
    else if (cloud < 70) score -= 8;
    else score -= 28;
  }
  const moonSensitive = ev.type === 'shower' || ev.type === 'comet';
  if (moonSensitive) {
    factors.push(['🌙', `${Math.round(illum * 100)}% ${moonName(illum)}`]);
    if (illum > 0.75) score -= 20;
    else if (illum > 0.5) score -= 10;
    else if (illum < 0.25) score += 6;
  }
  if (ev.tier === 'drive') score += 6;
  if (ev.tier === 'expedition') score += 10;
  score = Math.max(5, Math.min(99, Math.round(score)));
  return { score, factors, label: score >= 78 ? 'Go' : score >= 55 ? 'Maybe' : 'Risky' };
}

/* ============================== aurora (NOAA) ============================== */
async function loadAurora() {
  const verdictEl = document.getElementById('auroraVerdict');
  const subEl = document.getElementById('auroraSub');
  const fcEl = document.getElementById('kpForecast');
  try {
    const [kpR, ovR] = await Promise.all([
      fetch('https://services.swpc.noaa.gov/json/planetary_k_index_1m.json'),
      fetch('https://services.swpc.noaa.gov/json/ovation_aurora_latest.json'),
    ]);
    const kpJ = await kpR.json();
    const valid = kpJ.filter(k => k.kp_index !== null && k.kp_index !== undefined);
    const cur = valid[valid.length - 1];
    const kp = parseFloat(cur.kp_index);
    document.getElementById('kpValue').textContent = kp.toFixed(1);

    // aurora probability near observer from ovation grid
    let prob = null;
    try {
      const ov = await ovR.json();
      const { lat, lon } = state.loc;
      let bestD = 1e9;
      for (const [clon, clat, v] of ov.coordinates) {
        const d = (clon - lon) ** 2 + (clat - lat) ** 2;
        if (d < bestD) { bestD = d; prob = v; }
      }
    } catch (e) {}

    const lat = state.loc.lat;
    let verdict, sub;
    if (kp >= 7) {
      verdict = '🌌 Get outside — aurora likely visible from here.';
      sub = `Kp ${kp.toFixed(1)} is storm-level. Look north, away from city lights. This is the real deal.`;
    } else if (kp >= 5.5) {
      verdict = '👀 Possible — watch the northern horizon.';
      sub = `Kp ${kp.toFixed(1)}. From ${state.loc.name} you might catch a glow low in the north if skies are dark and clear.`;
    } else if (kp >= 4) {
      verdict = '😴 Quiet for now.';
      sub = `Kp ${kp.toFixed(1)} — aurora is hugging the Arctic. Check back during stronger activity.`;
    } else {
      verdict = '😴 Quiet for now.';
      sub = `Kp ${kp.toFixed(1)} — the oval is far north tonight.`;
    }
    if (prob !== null && prob > 5) {
      sub += ` Model puts aurora probability near you at ~${Math.round(prob)}%.`;
    }
    if (lat < 40 && kp < 7) {
      verdict = '😴 Too far south tonight.';
      sub = `Kp ${kp.toFixed(1)} — you'd need a serious storm (Kp 8+) for aurora this far south.`;
    }
    verdictEl.textContent = verdict;
    subEl.textContent = sub;

    // recent trend bars
    const recent = valid.slice(-8);
    fcEl.innerHTML = recent.map(k => {
      const v = parseFloat(k.kp_index);
      const t = new Date(k.time_tag);
      return `<div class="kp-day">${t.getHours()}:00<b>${v.toFixed(1)}</b></div>`;
    }).join('');
  } catch (e) {
    verdictEl.textContent = 'Aurora data unavailable right now.';
    subEl.textContent = 'NOAA feed could not be reached. Try again later.';
    document.getElementById('auroraLive').style.display = 'none';
  }
}

/* ============================== satellite passes ============================== */
async function fetchTLE(norad) {
  const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?CATNR=${norad}&FORMAT=TLE`);
  const t = await r.text();
  const lines = t.trim().split('\n').map(s => s.trim()).filter(Boolean);
  const l1 = lines.find(l => l.startsWith('1 ')), l2 = lines.find(l => l.startsWith('2 '));
  if (!l1 || !l2) throw new Error('bad TLE');
  return [l1, l2];
}

function computePasses(satrec, lat, lon, hours) {
  // NOTE: satellite.js v5 ecfToLookAngles takes observer as geodetic (radians), not ECF
  const observerGd = { latitude: lat * RAD, longitude: lon * RAD, height: 0.05 };
  const step = 30 * 1000, now = Date.now(), end = now + hours * 3600000;
  const passes = [];
  let cur = null;
  for (let t = now; t < end; t += step) {
    const d = new Date(t);
    const pv = satellite.propagate(satrec, d);
    if (!pv || !pv.position) { cur = null; continue; }
    const gmst = satellite.gstime(d);
    const ecf = satellite.eciToEcf(pv.position, gmst);
    const look = satellite.ecfToLookAngles(observerGd, ecf);
    const el = look.elevation / RAD, az = look.azimuth / RAD;
    const dark = sunElev(d, lat, lon) < -6;
    // cylindrical Earth shadow test for satellite sunlight
    const sd = sunDirECF(d);
    const r2 = ecf.x ** 2 + ecf.y ** 2 + ecf.z ** 2;
    const s = ecf.x * sd.x + ecf.y * sd.y + ecf.z * sd.z;
    const sunlit = !(s < 0 && (r2 - s * s) < 6371 * 6371);
    const visible = el > 12 && dark && sunlit;
    if (visible) {
      if (!cur) cur = { start: d, maxEl: el, maxT: d, end: d, startAz: az, endAz: az };
      else {
        cur.end = d; cur.endAz = az;
        if (el > cur.maxEl) { cur.maxEl = el; cur.maxT = d; }
      }
    } else if (cur) {
      if (cur.maxEl > 18 && (cur.end - cur.start) > 60000) passes.push(cur);
      cur = null;
    }
  }
  if (cur && cur.maxEl > 18) passes.push(cur);
  return passes.slice(0, 6);
}

async function loadPasses() {
  const list = document.getElementById('passList');
  const tabs = document.getElementById('satTabs');
  tabs.innerHTML = SATS.map(s =>
    `<button class="sat-tab${s.norad === state.sat.norad ? ' active' : ''}" data-norad="${s.norad}">${s.name}</button>`).join('');
  tabs.querySelectorAll('.sat-tab').forEach(b => b.onclick = () => {
    state.sat = SATS.find(s => s.norad == b.dataset.norad);
    loadPasses();
  });

  if (typeof satellite === 'undefined') {
    list.innerHTML = '<div class="muted">Orbit library failed to load — check your connection and refresh.</div>';
    return;
  }
  list.innerHTML = '<div class="muted">Computing orbits…</div>';
  try {
    const [l1, l2] = await fetchTLE(state.sat.norad);
    const satrec = satellite.twoline2satrec(l1, l2);
    const passes = computePasses(satrec, state.loc.lat, state.loc.lon, 72);
    if (!passes.length) {
      list.innerHTML = `<div class="muted">No good visible passes for ${state.sat.name} in the next 3 days from ${state.loc.name}.</div>`;
      return;
    }
    list.innerHTML = passes.map(p => {
      const dur = Math.round((p.end - p.start) / 60000);
      const quality = p.maxEl > 60 ? 'Overhead — excellent' : p.maxEl > 35 ? 'High — great' : 'Low — decent';
      return `<div class="pass-card glass">
        <div class="pass-time"><div class="d">${fmtDate(p.start).split(',')[0]}</div><div class="t">${fmtTime(p.start)}</div></div>
        <div class="pass-info"><div class="name">${state.sat.name} ${countdown(p.start) === 'now' ? '· visible now!' : '· ' + countdown(p.start)}</div>
        <div class="detail">${compass(p.startAz)} → ${compass(p.endAz)} · peaks ${Math.round(p.maxEl)}° at ${fmtTime(p.maxT)} · ${dur} min · ${quality}</div></div>
        <div class="pass-score"><div class="v">${Math.round(p.maxEl)}°</div><div class="k">max elev</div></div>
      </div>`;
    }).join('');
  } catch (e) {
    list.innerHTML = '<div class="muted">Could not load orbital data (CelesTrak unreachable). Try again later.</div>';
  }
}

/* ============================== rendering ============================== */
function tierBadge(t) {
  const m = TIER_META[t] || TIER_META.backyard;
  return `<span class="tier-badge ${t}">${m.icon} ${m.label}</span>`;
}

function eventCard(ev) {
  const sc = state.scores[ev.id];
  const dateStr = ev.end && ev.end - ev.date > 2 * DAY
    ? `${fmtDate(ev.date)} – ${fmtDate(ev.end)}` : fmtDate(ev.date);
  return `<article class="event-card glass" data-id="${ev.id}">
    <div class="event-top">${tierBadge(ev.tier)}
      <span class="type-chip">${TYPE_META[ev.type]?.icon || ''} ${TYPE_META[ev.type]?.label || ev.type}</span></div>
    <div class="event-date"><span class="big">${dateStr}</span><span class="cd">${countdown(ev.date)}</span></div>
    <div class="event-title">${ev.title}</div>
    <div class="event-desc">${ev.desc || ev.description || ''}</div>
    ${sc ? `<div class="go-bar"><i style="width:${sc.score}%"></i></div>
    <div class="event-factors"><span><b>${sc.score}</b> · ${sc.label}</span>
      ${sc.factors.map(f => `<span>${f[0]} ${f[1]}</span>`).join('')}</div>`
    : `<div class="event-factors"><span>Beyond the 15-day forecast — tier says it all.</span></div>`}
  </article>`;
}

function renderEvents() {
  const grid = document.getElementById('eventGrid');
  const list = state.events.filter(e =>
    (state.tier === 'all' || e.tier === state.tier) &&
    (state.type === 'all' || e.type === state.type));
  if (!list.length) {
    grid.innerHTML = '<div class="muted">No events match these filters. The universe is vast — try widening the net.</div>';
    return;
  }
  grid.innerHTML = list.map(eventCard).join('');
}

function renderTypeRow() {
  const row = document.getElementById('typeRow');
  const counts = {};
  state.events.forEach(e => { if (state.tier === 'all' || e.tier === state.tier) counts[e.type] = (counts[e.type] || 0) + 1; });
  const types = Object.keys(TYPE_META).filter(t => counts[t]);
  row.innerHTML = `<button class="type-chip${state.type === 'all' ? ' active' : ''}" data-type="all">All</button>` +
    types.map(t => `<button class="type-chip${state.type === t ? ' active' : ''}" data-type="${t}" title="${TYPE_META[t].blurb}">${TYPE_META[t].icon} ${TYPE_META[t].label} · ${counts[t]}</button>`).join('');
  row.querySelectorAll('.type-chip').forEach(b => b.onclick = () => { state.type = b.dataset.type; renderTypeRow(); renderEvents(); });
}

async function renderTonight() {
  const card = document.getElementById('tonightCard');
  const soon = state.events.filter(e => e.date - Date.now() < 60 * 3600000 && e.date - Date.now() > -6 * 3600000);
  // score near-term events
  for (const e of soon.slice(0, 6)) {
    if (!state.scores[e.id]) state.scores[e.id] = await goScore(e);
  }
  let pick = soon.filter(e => state.scores[e.id]).sort((a, b) => state.scores[b.id].score - state.scores[a.id].score)[0];
  if (!pick) pick = state.events[0];
  if (!pick) { card.innerHTML = '<div class="hero-loading">Event data is still loading…</div>'; return; }
  const sc = state.scores[pick.id];
  const m = TIER_META[pick.tier];
  card.innerHTML = `
    <div class="hero-top">${tierBadge(pick.tier)}
      <span class="type-chip">${TYPE_META[pick.type]?.icon || ''} ${TYPE_META[pick.type]?.label || ''}</span></div>
    <div class="hero-title">${pick.title}</div>
    <div class="hero-sub">${pick.desc || pick.description || ''} ${m ? `<br><br><em>${m.icon} ${m.blurb}</em>` : ''}</div>
    <div class="hero-meta">
      <div class="hero-stat"><div class="k">When</div><div class="v">${fmtDate(pick.date)} · ${countdown(pick.date)}</div></div>
      ${sc ? `<div class="hero-stat"><div class="k">Go score</div>
        <div class="score-ring" style="--p:${sc.score / 100}"><span>${sc.score}</span></div></div>
      <div class="hero-stat"><div class="k">Conditions</div><div class="v" style="font-size:15px;font-weight:600;line-height:1.7">${sc.factors.map(f => `${f[0]} ${f[1]}`).join('<br>')}</div></div>` : ''}
    </div>`;
}

function renderSpots() {
  const el = document.getElementById('spotList');
  if (!state.spots.length) { el.innerHTML = '<div class="muted">Spot data loading…</div>'; return; }
  const away = isAway();
  const withDist = state.spots.map(s => ({ ...s, dist: haversine(state.loc.lat, state.loc.lon, s.lat, s.lon) }))
    .sort((a, b) => a.dist - b.dist).slice(0, 6);
  const awayNote = away
    ? `<div class="muted" style="padding:0 4px 6px">You're away from home — these are our New England dark-sky picks, shown by distance from where you are now.</div>` : '';
  el.innerHTML = awayNote + withDist.map(s => `
    <div class="spot-card glass">
      <div><div class="name">${s.name}</div>
      <div class="meta">${s.highlights || ''}</div>
      ${s.access ? `<div class="meta" style="margin-top:6px;opacity:.75">🅿️ ${s.access}</div>` : ''}</div>
      <div class="go"><span class="bortle" title="${s.bortle_source || 'Bortle scale: 1 = pristine dark sky, 9 = inner city. Lower is darker.'}">Bortle ${s.bortle || '~?'}</span>
      <div class="drive">${away ? `${Math.round(s.dist)} mi from you` : (s.drive_from_medford ? `~${s.drive_from_medford} from home` : `${Math.round(s.dist)} mi`)}</div></div>
    </div>`).join('');
}
function haversine(lat1, lon1, lat2, lon2) {
  const dLa = (lat2 - lat1) * RAD, dLo = (lon2 - lon1) * RAD;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLo / 2) ** 2;
  return 2 * 3959 * Math.asin(Math.sqrt(a));
}

/* ============================== location ============================== */
function renderLocStatus() {
  const el = document.getElementById('locStatus');
  if (!el) return;
  const away = isAway();
  const miFromHome = Math.round(haversine(state.home.lat, state.home.lon, state.loc.lat, state.loc.lon));
  const homeIsMedford = haversine(state.home.lat, state.home.lon, DEFAULT_LOC.lat, DEFAULT_LOC.lon) < 10;
  el.innerHTML = `
    <div class="loc-line"><span class="k">Home</span><span>${state.home.name}${homeIsMedford ? ` <span class="bortle" title="${HOME_BORTLE.source}">Bortle ${HOME_BORTLE.value}</span>` : ''}</span></div>
    <div class="loc-line"><span class="k">Viewing</span><span>${state.loc.name}${away ? '<em class="away-tag">away</em>' : ''}</span></div>
    ${away ? `<div class="loc-away-note">${miFromHome.toLocaleString()} mi from home — sky data below is for where you are right now.</div>` : ''}
    <div class="loc-btns">
      ${away ? `<button type="button" class="btn ghost" id="backHomeBtn">Back home</button>` : ''}
      <button type="button" class="btn ghost" id="setHomeBtn">Set current as home</button>
    </div>`;
  const bh = document.getElementById('backHomeBtn');
  if (bh) bh.onclick = () => { state.loc = { ...state.home }; saveLoc(); applyLoc(); };
  document.getElementById('setHomeBtn').onclick = () => {
    state.home = { ...state.loc }; saveHome(); applyLoc();
  };
}

function bindLocation() {
  const dlg = document.getElementById('locationDialog');
  const input = document.getElementById('locSearch');
  const results = document.getElementById('locResults');
  document.getElementById('locationBtn').onclick = () => { renderLocStatus(); dlg.showModal(); input.value = ''; results.innerHTML = ''; };
  document.getElementById('geoBtn').onclick = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude: lat, longitude: lon } = pos.coords;
      state.loc = { name: 'Current location', lat, lon };
      try {
        const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=&count=1&format=json`);
      } catch (e) {}
      // reverse-name via big free geocoder is overkill; keep generic label
      try {
        const rg = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
        const j = await rg.json();
        state.loc.name = [j.city, j.principalSubdivisionCode].filter(Boolean).join(', ') || 'Current location';
      } catch (e) {}
      saveLoc(); applyLoc(); renderLocStatus(); dlg.close();
    });
  };
  let t;
  input.oninput = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { results.innerHTML = ''; return; }
      try {
        const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=5&language=en&format=json`);
        const j = await r.json();
        results.innerHTML = (j.results || []).map((g, i) =>
          `<button class="loc-result" data-i="${i}">${g.name}<small>${[g.admin1, g.country].filter(Boolean).join(', ')}</small></button>`).join('');
        results.querySelectorAll('.loc-result').forEach(b => b.onclick = () => {
          const g = j.results[+b.dataset.i];
          state.loc = { name: `${g.name}, ${g.country_code || ''}`.replace(/, $/, ''), lat: g.latitude, lon: g.longitude };
          saveLoc(); applyLoc(); renderLocStatus(); dlg.close();
        });
      } catch (e) { results.innerHTML = '<div class="muted">Search failed — check connection.</div>'; }
    }, 300);
  };
}
function applyLoc() {
  const away = isAway();
  document.getElementById('locationLabel').textContent = state.loc.name + (away ? ' · away' : '');
  state.weatherCache = {};
  state.scores = {};
  renderLocStatus(); renderSpots(); loadPasses(); loadAurora(); renderTonight(); renderEvents();
}

/* ============================== starfield ============================== */
function starfield() {
  const c = document.getElementById('starfield'), x = c.getContext('2d');
  let W, H, stars = [], meteors = [];
  function size() {
    W = c.width = innerWidth * devicePixelRatio; H = c.height = innerHeight * devicePixelRatio;
    c.style.width = innerWidth + 'px'; c.style.height = innerHeight + 'px';
    stars = Array.from({ length: Math.min(240, innerWidth / 5) }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: (Math.random() * 1.4 + 0.3) * devicePixelRatio,
      p: Math.random() * Math.PI * 2, s: 0.5 + Math.random() * 1.5,
    }));
  }
  size(); addEventListener('resize', size);
  function frame(t) {
    x.clearRect(0, 0, W, H);
    for (const s of stars) {
      const a = 0.25 + 0.55 * Math.abs(Math.sin(t / 1000 * s.s + s.p));
      x.globalAlpha = a; x.fillStyle = '#dfe6ff';
      x.beginPath(); x.arc(s.x, s.y, s.r, 0, 7); x.fill();
    }
    x.globalAlpha = 1;
    if (Math.random() < 0.006 && meteors.length < 2) {
      meteors.push({ x: Math.random() * W * 0.7 + W * 0.15, y: Math.random() * H * 0.3, vx: -9 * devicePixelRatio, vy: 4 * devicePixelRatio, life: 1 });
    }
    meteors = meteors.filter(m => m.life > 0);
    for (const m of meteors) {
      m.x += m.vx; m.y += m.vy; m.life -= 0.02;
      const g = x.createLinearGradient(m.x, m.y, m.x - m.vx * 8, m.y - m.vy * 8);
      g.addColorStop(0, `rgba(255,255,255,${0.9 * m.life})`); g.addColorStop(1, 'rgba(255,255,255,0)');
      x.strokeStyle = g; x.lineWidth = 2 * devicePixelRatio;
      x.beginPath(); x.moveTo(m.x, m.y); x.lineTo(m.x - m.vx * 8, m.y - m.vy * 8); x.stroke();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/* ============================== init ============================== */
async function init() {
  starfield();
  bindLocation();
  document.getElementById('locationLabel').textContent = state.loc.name;

  document.querySelectorAll('.tier-chip').forEach(b => b.onclick = () => {
    document.querySelectorAll('.tier-chip').forEach(o => o.classList.remove('active'));
    b.classList.add('active');
    state.tier = b.dataset.tier; state.type = 'all';
    renderTypeRow(); renderEvents(); renderTonight();
  });

  const [showers, eclipses, conjs, comets, spots] = await Promise.all([
    loadJSON('data/showers.json'), loadJSON('data/eclipses.json'),
    loadJSON('data/conjunctions.json'), loadJSON('data/comets.json'),
    loadJSON('data/darksky.json'),
  ]);
  state.events = normalizeEvents(showers, eclipses, conjs, comets);
  state.spots = spots?.sites || [];

  renderTypeRow(); renderEvents(); renderSpots(); renderTonight();
  loadAurora(); loadPasses();

  // score the next few events for the feed (async, non-blocking)
  (async () => {
    for (const e of state.events.slice(0, 8)) {
      if ((e.date - Date.now()) / DAY < 15 && !state.scores[e.id]) {
        state.scores[e.id] = await goScore(e);
      }
    }
    renderEvents(); renderTonight();
  })();

  const man = await loadJSON('data/_manifest.json');
  if (man && man.sources) {
    document.getElementById('sourceLine').textContent = 'Data: ' + man.sources.join(' · ');
  }
}

document.addEventListener('DOMContentLoaded', init);
