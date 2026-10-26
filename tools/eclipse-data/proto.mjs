// Prototype: solar eclipse local circumstances from NASA
// polynomial Besselian elements. Validated against published
// circumstances before this math moves into src/lib/astro.js.
const DEG = Math.PI / 180;

const ECLIPSES = {
  '2028-01-26': {
    t0: 15.0, dT: 76.3, tanF1: 0.0047501, tanF2: 0.0047264,
    x: [-0.2052830, 0.4742570, -0.0000390, -0.0000053],
    y: [0.3402800, 0.1738587, 0.0000968, -0.0000021],
    d: [-18.7282505, 0.0100740, 0.0000050, 0],
    l1: [0.5741170, 0.0000420, -0.0000099, 0],
    l2: [0.0278400, 0.0000418, -0.0000099, 0],
    mu: [41.891281, 14.998960, 0, 0],
    dateUTC: Date.UTC(2028, 0, 26),
  },
  '2029-01-14': {
    t0: 17.0, dT: 76.9, tanF1: 0.0047541, tanF2: 0.0047304,
    x: [-0.4074440, 0.5081525, -0.0000393, -0.0000065],
    y: [0.9810550, 0.1455283, 0.0000921, -0.0000020],
    d: [-21.1630096, 0.0072410, 0.0000060, 0],
    l1: [0.5626660, 0.0001189, -0.0000109, 0],
    l2: [0.0164460, 0.0001183, -0.0000108, 0],
    mu: [72.692886, 14.997630, 0, 0],
    dateUTC: Date.UTC(2029, 0, 14),
  },
};

const poly = (c, t) => c[0] + t * (c[1] + t * (c[2] + t * (c[3] || 0)));

function elementsAt(ecl, t) {
  return {
    x: poly(ecl.x, t), y: poly(ecl.y, t),
    d: poly(ecl.d, t) * DEG, mu: poly(ecl.mu, t),
    l1: poly(ecl.l1, t), l2: poly(ecl.l2, t),
  };
}

// Observer coords in the fundamental plane at TT hour-offset t.
function observerAt(ecl, lat, lonEast, t) {
  const el = elementsAt(ecl, t);
  const phi = lat * DEG;
  const u = Math.atan(0.99664719 * Math.tan(phi));
  const rhoSin = 0.99664719 * Math.sin(u);
  const rhoCos = Math.cos(u);
  // NASA's polynomial elements use the hour-angle convention
  // H = mu - lon(WEST positive) = mu + lon(east positive).
  const H = (el.mu + lonEast) * DEG;
  const sd = Math.sin(el.d), cd = Math.cos(el.d);
  return {
    el,
    xi: rhoCos * Math.sin(H),
    eta: rhoSin * cd - rhoCos * Math.cos(H) * sd,
    zeta: rhoSin * sd + rhoCos * Math.cos(H) * cd,
  };
}

// Signed clearance: distance of shadow axis from observer minus
// the penumbral radius at the observer's plane. <0 = in shadow.
function clearance(ecl, lat, lon, t, umbral = false) {
  const { el, xi, eta, zeta } = observerAt(ecl, lat, lon, t);
  const L = umbral
    ? Math.abs(el.l2 - zeta * ecl.tanF2)
    : el.l1 - zeta * ecl.tanF1;
  const dx = el.x - xi, dy = el.y - eta;
  return Math.hypot(dx, dy) - L;
}

function bisect(ecl, lat, lon, a, b, umbral) {
  let fa = clearance(ecl, lat, lon, a, umbral);
  for (let i = 0; i < 60; i++) {
    const m = (a + b) / 2, fm = clearance(ecl, lat, lon, m, umbral);
    if (fa * fm <= 0) b = m; else { a = m; fa = fm; }
  }
  return (a + b) / 2;
}

export function localCircumstances(ecl, lat, lon) {
  // Scan t0 +/- 4h TT for the minimum clearance and contact brackets.
  const step = 1 / 30; // 2 min
  let best = { t: 0, c: Infinity };
  const samples = [];
  for (let t = -4; t <= 4.0001; t += step) {
    const c = clearance(ecl, lat, lon, t);
    samples.push([t, c]);
    if (c < best.c) best = { t, c };
  }
  if (best.c >= 0) return { visible: false, minClearance: best.c };
  // Golden-section refine of the minimum.
  let a = best.t - step, b = best.t + step;
  for (let i = 0; i < 80; i++) {
    const m1 = a + (b - a) * 0.381966, m2 = a + (b - a) * 0.618034;
    if (clearance(ecl, lat, lon, m1) < clearance(ecl, lat, lon, m2)) b = m2; else a = m1;
  }
  const tMax = (a + b) / 2;
  // Contacts: sign changes of clearance before/after tMax.
  let c1 = null, c4 = null;
  for (let i = 0; i < samples.length - 1; i++) {
    const [t1, c1v] = samples[i], [t2, c2v] = samples[i + 1];
    if (c1v >= 0 && c2v < 0 && t2 <= tMax + 1e-9) c1 = bisect(ecl, lat, lon, t1, t2, false);
    if (c1v < 0 && c2v >= 0 && t1 >= tMax - step) c4 = bisect(ecl, lat, lon, t1, t2, false);
  }
  // Magnitude at max from apparent-radii relation:
  // L1* = rm + rs, L2* = rm - rs (signed) in the same units.
  const { el, xi, eta, zeta } = observerAt(ecl, lat, lon, tMax);
  const L1s = el.l1 - zeta * ecl.tanF1;
  const L2s = el.l2 - zeta * ecl.tanF2;
  const s = Math.hypot(el.x - xi, el.y - eta);
  // Matches NASA/timeanddate published local magnitudes
  // (validated 2026-10-26: 4 cases across 2 eclipses within
  // 0.005; dividing by (L1s - L2s) ran ~5% high on all).
  const magnitude = (L1s - s) / (L1s + L2s);
  const rs = (L1s - L2s) / 2, rm = (L1s + L2s) / 2;
  // Circle-overlap obscuration (area fraction of the Sun covered).
  let obsc = 0;
  const d = s;
  if (d >= rm + rs) obsc = 0;
  else if (d <= Math.abs(rm - rs)) obsc = (Math.min(rs, rm) ** 2) / (rs ** 2);
  else {
    const a1 = rs * rs * Math.acos((d * d + rs * rs - rm * rm) / (2 * d * rs));
    const a2 = rm * rm * Math.acos((d * d + rm * rm - rs * rs) / (2 * d * rm));
    const a3 = 0.5 * Math.sqrt((-d + rs + rm) * (d + rs - rm) * (d - rs + rm) * (d + rs + rm));
    obsc = (a1 + a2 - a3) / (Math.PI * rs * rs);
  }
  const toDate = (tTT) => new Date(ecl.dateUTC + (ecl.t0 + tTT) * 3600000 - ecl.dT * 1000);
  return {
    visible: true,
    c1: c1 !== null ? toDate(c1) : null,
    max: toDate(tMax),
    c4: c4 !== null ? toDate(c4) : null,
    magnitude, obscuration: obsc,
  };
}

const fmt = (dt) => dt ? dt.toISOString().slice(11, 16) + ' UTC' : '—';
const cases = [
  ['2028-01-26', 'Medford MA', 42.4184, -71.1062, 'expect mag ~0.086, C1 14:28, max 15:12, C4 15:58 UTC'],
  ['2029-01-14', 'Medford MA', 42.4184, -71.1062, 'expect mag ~0.51'],
  ['2029-01-14', 'Washington DC', 38.9072, -77.0369, 'expect mag 0.531, max 17:43 UTC'],
  ['2029-01-14', 'El Segundo CA', 33.9192, -118.4165, 'expect C1 15:07, max 16:21, C4 17:45 UTC, mag 0.616'],
  ['2029-01-14', 'Chicago IL', 41.8781, -87.6298, 'no published check — sanity only'],
  ['2028-01-26', 'Madrid ES', 40.4168, -3.7038, 'annular path passes Iberia — expect central/annular'],
];
for (const [id, name, lat, lon, note] of cases) {
  const r = localCircumstances(ECLIPSES[id], lat, lon);
  console.log(`${id} ${name}: visible=${r.visible}` +
    (r.visible ? ` C1 ${fmt(r.c1)} max ${fmt(r.max)} C4 ${fmt(r.c4)} mag ${r.magnitude.toFixed(3)} obsc ${(r.obscuration * 100).toFixed(1)}%` : '') +
    `  (${note})`);
}
