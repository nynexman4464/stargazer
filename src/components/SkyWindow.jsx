import { useMemo } from 'react';
import { altAz, moonEquatorial, fmtTime, compass } from '../lib/astro.js';

/* The window view, ISS Detector style: the screen is a window onto
   the patch of sky it is aimed at. The caller supplies the view
   center (azimuth + height above the horizon) and the horizontal
   field of view; everything is projected gnomonically (tangent
   plane), the projection real sky apps use — straight lines stay
   straight and the view pans naturally in both axes as the center
   moves. Below the horizon a ground band fills in, a ring at screen
   center marks exactly where the view is aimed, and when the main
   target is outside the frame an arrow at the edge points to it.
   Per-frame cost is tiny (only the slice of sky in front of the
   phone is drawn), which is what lets follow mode glide. */

const W = 400;
const H = 520;
const DEG = Math.PI / 180;

// Unit vector in East/North/Up coordinates for an az/el direction.
function dirOf(az, el) {
  const a = az * DEG, e = el * DEG;
  return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export default function SkyWindow({ sky, atTime, loc, targets, center, fov = 55 }) {
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

  const C = dirOf(center.az, center.el);
  const up0 = [0, 0, 1];
  const U = norm([up0[0] - dot(up0, C) * C[0], up0[1] - dot(up0, C) * C[1], up0[2] - dot(up0, C) * C[2]]);
  const Rv = norm(cross(C, U));
  const f = (W / 2) / Math.tan((fov / 2) * DEG);
  const maxAng = Math.atan(Math.hypot(W / 2, H / 2) / f) / DEG + 4;
  const cosMin = Math.cos(maxAng * DEG);

  // Project one alt-az direction; null when outside the frame cone.
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

  // Ground below the horizon: sample the el=0 line across the view,
  // fill from it down to the bottom edge, stroke the horizon itself.
  const horizonPts = [];
  for (let off = -115; off <= 115; off += 5) {
    const D = dirOf(center.az + off, 0);
    const den = dot(D, C);
    if (den < 0.3) continue;
    horizonPts.push({
      x: Math.max(-800, Math.min(W + 800, W / 2 + (f * dot(D, Rv)) / den)),
      y: Math.max(-800, Math.min(H + 800, H / 2 - (f * dot(D, U)) / den)),
    });
  }
  const groundEl = horizonPts.length > 1 ? (
    <g>
      <polygon
        points={`${horizonPts.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ')} ${W},${H} 0,${H}`}
        fill="var(--color-background-card)"
        opacity="0.92"
      />
      <polyline
        points={horizonPts.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ')}
        fill="none" stroke="var(--color-border-emphasized)" strokeWidth="1.5"
      />
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

  const lineEls = [];
  skyAltAz.lines.forEach((line, li) => {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i];
      const pa = proj(a.alt, a.az, cosMin * 0.9);
      const pb = proj(b.alt, b.az, cosMin * 0.9);
      if (!pa || !pb) continue;
      if (Math.hypot(pa.x - pb.x, pa.y - pb.y) > 430) continue;
      lineEls.push(
        <line key={`l${li}-${i}`} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
          stroke="var(--color-text-secondary)" strokeWidth="1" opacity="0.4" />,
      );
    }
  });

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
      // Split the track where it leaves the frame.
      let run = [];
      const flush = () => {
        if (run.length > 1) {
          targetEls.push(
            <polyline key={`tp${ti}-${targetEls.length}`}
              points={run.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
              fill="none" stroke="var(--color-icon-accent)" strokeWidth="2.5"
              strokeLinejoin="round" strokeLinecap="round" opacity="0.9" />,
          );
        }
        run = [];
      };
      t.path.forEach((pt) => {
        const p = pt.alt > -2 ? proj(pt.alt, pt.az, cosMin * 0.9) : null;
        if (p) run.push(p);
        else flush();
      });
      flush();
    }
    if (t.peak && t.peak.alt > 0) {
      const p = proj(t.peak.alt, t.peak.az);
      if (p) {
        targetEls.push(
          <g key={`tg${ti}`}>
            <circle cx={p.x} cy={p.y} r="6" fill="var(--color-text-yellow)" stroke="var(--color-background-body)" strokeWidth="2" />
            <text x={p.x} y={p.y - 12} textAnchor="middle" fontSize="12" fontWeight="bold" fill="var(--color-text-primary)">
              {t.label}
            </text>
            <text x={p.x} y={p.y + 20} textAnchor="middle" fontSize="10" fill="var(--color-text-secondary)">
              {fmtTime(t.peak.time)}
            </text>
          </g>,
        );
      }
    }
    if (t.live && t.live.alt > -2) {
      const p = proj(t.live.alt, t.live.az);
      if (p) {
        targetEls.push(
          <g key={`tl${ti}`}>
            <circle cx={p.x} cy={p.y} r="11" fill="var(--color-text-yellow)" opacity="0.3" />
            <circle cx={p.x} cy={p.y} r="5" fill="var(--color-text-yellow)" stroke="var(--color-background-body)" strokeWidth="1.5" />
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
      {lineEls}
      {starEls}
      {labelEls}
      {moonEl}
      {targetEls}
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
}
