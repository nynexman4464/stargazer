import { memo, useMemo } from 'react';
import { altAz, moonEquatorial, fmtTime, compass, frameFrom } from '../lib/astro.js';

/* The window view, ISS Detector style: the screen is a window onto
   the patch of sky it is aimed at. The caller supplies the view
   center (azimuth + height above the horizon) and the horizontal
   field of view; everything is projected gnomonically (tangent
   plane), the projection real sky apps use — straight lines stay
   straight and the view pans naturally in both axes as the center
   moves. Below the horizon a ground band fills in, a ring at screen
   center marks exactly where the view is aimed, and when the main
   target is outside the frame an arrow at the edge points to it.

   Rendering notes (this redraws at frame rate in follow mode):
   the component is memoized and the caller quantizes the center,
   so still frames cost nothing; all line work (constellations and
   target tracks) is clipped to the frame and merged into a handful
   of <path> elements instead of hundreds of nodes; and projected
   points are never trusted raw — gnomonic projection sends
   near-edge points to enormous coordinates, which used to smear
   a fat streak across the view. */

const W = 400;
const H = 520;
const M = 40; // clip margin outside the frame
const DEG = Math.PI / 180;

// Unit vector in East/North/Up coordinates for an az/el direction.
function dirOf(az, el) {
  const a = az * DEG, e = el * DEG;
  return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/* Liang–Barsky clip of a segment to the frame plus margin.
   Returns [x1, y1, x2, y2] or null when fully outside. */
function clipSeg(x1, y1, x2, y2) {
  let t0 = 0, t1 = 1;
  const dx = x2 - x1, dy = y2 - y1;
  const ps = [-dx, dx, -dy, dy];
  const qs = [x1 + M, W + M - x1, y1 + M, H + M - y1];
  for (let i = 0; i < 4; i++) {
    if (ps[i] === 0) {
      if (qs[i] < 0) return null;
    } else {
      const t = qs[i] / ps[i];
      if (ps[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
  }
  return [x1 + t0 * dx, y1 + t0 * dy, x1 + t1 * dx, y1 + t1 * dy];
}

export default memo(function SkyWindow({ sky, atTime, loc, targets, center, fov = 55, up = null }) {
  const skyAltAz = useMemo(() => {
    if (!sky || !loc || !atTime) return null;
    const altazOf = ([ra, dec]) => altAz(ra, dec, atTime, loc.lat, loc.lon);
    return {
      stars: sky.stars.map((s) => ({ ...altazOf(s), mag: s[2] })),
      named: sky.named.map((s) => ({ ...altazOf(s), mag: s[2], name: s[3] })),
      lines: sky.lines.map((line) => line.map((pt) => altazOf(pt))),
      labels: sky.labels.map((s) => ({ ...altazOf(s), name: s[2] })),
      moon: (() => { const m = moonEquatorial(atTime); return altAz(m.ra, m.dec, atTime, loc.lat, loc.lon); })(),
    };
  }, [sky, atTime, loc]);

  if (!skyAltAz || !center) return null;

  // The frame: center direction from az/el; screen-up from the
  // caller's carried up vector when there is one (a drag in
  // progress transports it rigidly, which is what keeps the field
  // from spinning near the zenith), else world up via frameFrom's
  // fallbacks.
  const { C, U, R: Rv } = frameFrom(dirOf(center.az, center.el), up || null);
  const f = (W / 2) / Math.tan((fov / 2) * DEG);
  const maxAng = Math.atan(Math.hypot(W / 2, H / 2) / f) / DEG + 4;
  const cosMin = Math.cos(maxAng * DEG);

  // Project one alt-az direction; null when outside the frame cone.
  // minDot can be lowered for line endpoints, whose segments are then
  // clipped to the frame instead of being drawn to wild coordinates.
  const proj = (alt, az, minDot = cosMin) => {
    const D = dirOf(az, alt);
    const den = dot(D, C);
    if (den < minDot) return null;
    return {
      x: W / 2 + (f * dot(D, Rv)) / den,
      y: H / 2 - (f * dot(D, U)) / den,
      den,
    };
  };
  const segPath = (parts, pa, pb) => {
    const s = clipSeg(pa.x, pa.y, pb.x, pb.y);
    if (s) parts.push(`M${s[0].toFixed(1)},${s[1].toFixed(1)} L${s[2].toFixed(1)},${s[3].toFixed(1)}`);
  };

  // Ground below the horizon. The horizon is a great circle, so in
  // this projection it is a straight line, and the ground is the
  // frame rectangle clipped to the below-horizon half-plane
  // (Sutherland–Hodgman, in tangent-plane units). Sampling horizon
  // points and clamping their projections instead used to fold
  // the polygon into a stray triangle across the sky when the
  // horizon sat near or beyond the frame edge (Alex's recording,
  // 2026-10-21: a wedge over the stars while looking up at 70-88
  // degrees, where no ground belongs at all).
  const ground = (() => {
    const hw = (W / 2 + M) / f, hh = (H / 2 + M) / f;
    const rect = [[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]];
    // Up-component of the direction at tangent coords (x, y);
    // below the horizon iff negative.
    const val = (x, y) => C[2] + x * Rv[2] + y * U[2];
    const poly = [];
    const line = [];
    for (let i = 0; i < 4; i++) {
      const a = rect[i], b = rect[(i + 1) % 4];
      const va = val(a[0], a[1]), vb = val(b[0], b[1]);
      if (va <= 0) poly.push(a);
      if ((va < 0 && vb > 0) || (va > 0 && vb < 0)) {
        const t = va / (va - vb);
        const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        poly.push(p);
        line.push(p);
      }
    }
    if (poly.length < 3) return null;
    const toPx = ([x, y]) => `${(W / 2 + f * x).toFixed(0)},${(H / 2 - f * y).toFixed(0)}`;
    return {
      points: poly.map(toPx).join(' '),
      line: line.length === 2 ? line.map(toPx).join(' ') : null,
    };
  })();
  const groundEl = ground ? (
    <g>
      <polygon points={ground.points} fill="var(--color-background-card)" opacity="0.92" />
      {ground.line && (
        <polyline points={ground.line} fill="none" stroke="var(--color-border-emphasized)" strokeWidth="1.5" />
      )}
    </g>
  ) : null;

  // Below-horizon sky stays DRAWN (Alex looks down there on purpose —
  // tracks after set, positions before rise) but faded: the same
  // ground polygon again as a translucent wash over the sky content,
  // rendered late, with the horizon line re-stroked on top so the
  // boundary stays crisp. Content above the line is untouched.
  const belowFadeEl = ground ? (
    <g>
      <polygon points={ground.points} fill="var(--color-background-card)" opacity="0.62" />
      {ground.line && (
        <polyline points={ground.line} fill="none" stroke="var(--color-border-emphasized)" strokeWidth="1.5" />
      )}
    </g>
  ) : null;

  const starEls = [];
  skyAltAz.stars.forEach((s, i) => {
    const p = proj(s.alt, s.az);
    if (!p) return;
    starEls.push(
      <circle key={`s${i}`} cx={p.x} cy={p.y}
        r={Math.max(0.8, 2.6 - 0.42 * s.mag)}
        fill="var(--color-text-primary)"
        opacity={Math.max(0.3, 1 - s.mag * 0.12)} />,
    );
  });

  // Constellation stick figures as ONE path of clipped segments.
  const lineParts = [];
  skyAltAz.lines.forEach((line) => {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      const pa = proj(a.alt, a.az, 0.05);
      const pb = proj(b.alt, b.az, 0.05);
      if (pa && pb) segPath(lineParts, pa, pb);
    }
  });
  const linesEl = lineParts.length ? (
    <path d={lineParts.join(' ')} stroke="var(--color-text-secondary)" strokeWidth="1" opacity="0.4" fill="none" />
  ) : null;

  const labelEls = [];
  skyAltAz.labels.forEach((s, i) => {
    const p = proj(s.alt, s.az);
    if (!p || p.x < -30 || p.x > W + 30 || p.y < -16 || p.y > H + 16) return;
    labelEls.push(
      <text key={`c${i}`} x={p.x} y={p.y} textAnchor="middle" fontSize="10"
        fill="var(--color-text-gray)" opacity="0.95">{s.name}</text>,
    );
  });
  skyAltAz.named.forEach((s, i) => {
    if (s.mag > 1.6) return;
    const p = proj(s.alt, s.az);
    if (!p || p.x < -30 || p.x > W + 30 || p.y < -16 || p.y > H + 16) return;
    labelEls.push(
      <text key={`n${i}`} x={p.x + 6} y={p.y - 6} fontSize="10"
        fill="var(--color-text-secondary)">{s.name}</text>,
    );
  });

  let moonEl = null;
  const m = skyAltAz.moon;
  if (m.alt > -2 && !targets.some((t) => t.label === 'Moon')) {
    const p = proj(m.alt, m.az);
    if (p) {
      moonEl = (
        <g>
          <circle cx={p.x} cy={p.y} r="7" fill="var(--color-text-yellow)" opacity="0.9" />
          <text x={p.x + 10} y={p.y + 3} fontSize="10" fill="var(--color-text-secondary)">Moon</text>
        </g>
      );
    }
  }

  const targetEls = [];
  targets.forEach((t, ti) => {
    if (t.path && t.path.length > 1) {
      // The track as clipped segments in one path; points behind the
      // view break the chain rather than streaking across it.
      // Satellite tracks carry vis flags (computePasses): segments
      // touching a not-visible point — the satellite above the
      // horizon but in Earth's shadow, or the sky still too bright
      // — are drawn DOTTED, ISS Detector style, the rest solid.
      const parts = [];
      const dottedParts = [];
      let prev = null;
      let prevPt = null;
      t.path.forEach((pt) => {
        const p = pt.alt > -2 ? proj(pt.alt, pt.az, 0.05) : null;
        if (p && prev) {
          segPath(prevPt.vis === false || pt.vis === false ? dottedParts : parts, prev, p);
        }
        prev = p;
        prevPt = pt;
      });
      if (parts.length) {
        targetEls.push(
          <path key={`tp${ti}`} d={parts.join(' ')}
            fill="none" stroke="var(--color-icon-accent)" strokeWidth="2.5"
            strokeLinejoin="round" strokeLinecap="round" opacity="0.9" />,
        );
      }
      if (dottedParts.length) {
        targetEls.push(
          <path key={`tpd${ti}`} d={dottedParts.join(' ')}
            fill="none" stroke="var(--color-icon-accent)" strokeWidth="2.5"
            strokeLinejoin="round" strokeLinecap="round" strokeDasharray="0.1 6" opacity="0.55" />,
        );
      }
      // Start/end times at the ends of the line, ISS Detector style
      // (the old radar chart had these; the window rewrite dropped
      // them — Alex asked for them back, 2026-10-21). The ends are
      // the first/last points of the VISIBLE run: satellite tracks
      // continue dotted past them to the horizon, unlabeled. A
      // label shows only when its end is actually in frame;
      // panning or zooming out to the end brings it in. Labels
      // tuck inside at the frame edges so the time never clips.
      const visPts = t.path.filter((pt) => pt.alt > 0 && pt.vis !== false);
      const abovePts = visPts.length > 1 ? visPts : t.path.filter((pt) => pt.alt > 0);
      if (abovePts.length > 1) {
        [abovePts[0], abovePts[abovePts.length - 1]].forEach((pt, ei) => {
          const p = proj(pt.alt, pt.az);
          if (!p || p.x < 4 || p.x > W - 4 || p.y < 8 || p.y > H - 8) return;
          const anchor = p.x < 52 ? 'start' : p.x > W - 52 ? 'end' : 'middle';
          const tx = anchor === 'start' ? p.x + 7 : anchor === 'end' ? p.x - 7 : p.x;
          const ty = p.y >= 30 ? p.y - 8 : p.y + 15;
          targetEls.push(
            <g key={`te${ti}-${ei}`}>
              <circle cx={p.x} cy={p.y} r="3" fill="var(--color-background-body)" stroke="var(--color-icon-accent)" strokeWidth="2" />
              <text x={tx} y={ty} textAnchor={anchor} fontSize="9.5" fill="var(--color-text-secondary)">
                {fmtTime(pt.time)}
              </text>
            </g>,
          );
        });
      }
    }
    // Two markers, deliberately distinct: the gold dot is the PEAK
    // (labeled with the target name and peak time); the accent dot
    // is where the target is RIGHT NOW, labeled "now". They often
    // sit close together near the peak — the labels keep them from
    // reading as one dot.
    let peakP = null;
    if (t.peak && t.peak.alt > 0) {
      peakP = proj(t.peak.alt, t.peak.az);
      if (peakP) {
        targetEls.push(
          <g key={`tg${ti}`}>
            <circle cx={peakP.x} cy={peakP.y} r="6" fill="var(--color-text-yellow)" stroke="var(--color-background-body)" strokeWidth="2" />
            <text x={peakP.x} y={peakP.y - 12} textAnchor="middle" fontSize="12" fontWeight="bold" fill="var(--color-text-primary)">
              {t.label}
            </text>
            <text x={peakP.x} y={peakP.y + 20} textAnchor="middle" fontSize="10" fill="var(--color-text-secondary)">
              {fmtTime(t.peak.time)}
            </text>
          </g>,
        );
      }
    }
    if (t.live && t.live.alt > -2) {
      const p = proj(t.live.alt, t.live.az);
      if (p) {
        const nearPeak = peakP && Math.hypot(peakP.x - p.x, peakP.y - p.y) < 34;
        targetEls.push(
          <g key={`tl${ti}`}>
            <circle cx={p.x} cy={p.y} r="10" fill="var(--color-icon-accent)" opacity="0.25" />
            <circle cx={p.x} cy={p.y} r="4.5" fill="var(--color-icon-accent)" stroke="var(--color-background-body)" strokeWidth="1.5" />
            {nearPeak ? (
              <text x={p.x} y={p.y + 19} textAnchor="middle" fontSize="9.5" fill="var(--color-text-secondary)">now</text>
            ) : (
              <text x={p.x + 9} y={p.y + 3} fontSize="9.5" fill="var(--color-text-secondary)">now</text>
            )}
          </g>,
        );
      }
    }
  });

  // Edge arrow for the main target when it is outside the frame:
  // direction from the view axes, pinned near the frame edge, label
  // beside it — the "it's thataway" cue from the finder apps.
  let arrowEl = null;
  const primary = targets[0];
  const ref = primary && (primary.live && primary.live.alt > -5 ? primary.live : primary.peak);
  if (primary && ref) {
    const D = dirOf(ref.az, ref.alt);
    const den = dot(D, C);
    if (den < cosMin) {
      const rx = dot(D, Rv), uy = dot(D, U);
      const ang = Math.atan2(-uy, rx);
      const ax = W / 2 + Math.cos(ang) * (W / 2 - 36);
      const ay = H / 2 + Math.sin(ang) * (H / 2 - 46);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const tip = [ax + ca * 13, ay + sa * 13];
      const bc = [ax - ca * 6, ay - sa * 6];
      const b1 = [bc[0] - sa * 7.5, bc[1] + ca * 7.5];
      const b2 = [bc[0] + sa * 7.5, bc[1] - ca * 7.5];
      arrowEl = (
        <g>
          <polygon points={`${tip[0]},${tip[1]} ${b1[0]},${b1[1]} ${b2[0]},${b2[1]}`} fill="var(--color-warning)" />
          <text x={ax} y={ay + (ay > H - 110 ? -20 : 26)} textAnchor="middle" fontSize="11.5"
            fontWeight="bold" fill="var(--color-text-primary)">{primary.label}</text>
        </g>
      );
    }
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="sg-skywindow" role="img"
      aria-label="Window view: the patch of sky the view is aimed at, horizon and ground when looking low">
      <defs>
        <linearGradient id="sg-win-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-background-body)" />
          <stop offset="78%" stopColor="var(--color-background-muted)" />
          <stop offset="100%" stopColor="var(--color-background-muted)" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width={W} height={H} fill="url(#sg-win-grad)" />
      {groundEl}
      {linesEl}
      {starEls}
      {labelEls}
      {moonEl}
      {targetEls}
      {belowFadeEl}
      {arrowEl}
      <text x={W / 2} y="20" textAnchor="middle" fontSize="11.5" fill="var(--color-text-secondary)">
        {compass(center.az)} · up {Math.round(center.el)}°
      </text>
      {/* The aim ring: fixed at screen center, the sky moves under it. */}
      <g opacity="0.9">
        <circle cx={W / 2} cy={H / 2} r="26" fill="none" stroke="var(--color-text-secondary)" strokeWidth="1.5" />
        <circle cx={W / 2} cy={H / 2} r="2" fill="var(--color-text-secondary)" />
        <line x1={W / 2 - 34} y1={H / 2} x2={W / 2 - 28} y2={H / 2} stroke="var(--color-text-secondary)" strokeWidth="1.5" />
        <line x1={W / 2 + 28} y1={H / 2} x2={W / 2 + 34} y2={H / 2} stroke="var(--color-text-secondary)" strokeWidth="1.5" />
        <line x1={W / 2} y1={H / 2 - 34} x2={W / 2} y2={H / 2 - 28} stroke="var(--color-text-secondary)" strokeWidth="1.5" />
        <line x1={W / 2} y1={H / 2 + 28} x2={W / 2} y2={H / 2 + 34} stroke="var(--color-text-secondary)" strokeWidth="1.5" />
      </g>
    </svg>
  );
});
