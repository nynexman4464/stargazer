import { useMemo } from 'react';
import { altAz, moonEquatorial, fmtTime } from '../lib/astro.js';

/* The overhead sky as a circle, ISS Detector "radar" style: center is
   straight up (the zenith), the rim is the horizon, rings mark 30 and
   60 degrees up. Everything — bright stars, constellation stick figures,
   the Moon, and each target's path across the sky — is projected from
   altitude/azimuth with the same altAz() the rest of the app uses, so
   the chart always agrees with the text tracks.

   Follow mode does NOT re-project: the sky is always drawn north-up
   and the whole group is rotated with one CSS transform, eased at
   frame rate by SkyView. That is what keeps motion smooth (the
   finder apps glide the same way) — re-projecting 900 stars per
   sensor tick stepped visibly. The layers are memoized so a rotation
   frame re-renders almost nothing. The aim reticle is drawn outside
   the rotated group, in screen coordinates, so it stays upright. */

const CX = 180;
const CY = 180;
const R = 156;
const DEG = Math.PI / 180;

function project(alt, az, rot = 0) {
  const r = ((90 - alt) / 90) * R;
  const a = (az - rot) * DEG;
  return { x: CX + r * Math.sin(a), y: CY - r * Math.cos(a) };
}

export default function SkyChart({ sky, atTime, loc, targets, heading = null, follow = false, pointer = null }) {
  // Degrees the drawn sky is rotated on screen (clockwise-positive
  // azimuth frame): when following, the faced direction goes to the top.
  const effRot = follow && heading != null ? heading : 0;

  // Star/line/label positions in alt-az for atTime (north-up; rotation
  // is applied by the group transform, never here).
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

  // All north-up sky layers, built once per (sky snapshot, targets)
  // change — never per rotation frame.
  const layers = useMemo(() => {
    if (!skyAltAz) return null;
    const starEls = [];
    skyAltAz.stars.forEach((s, i) => {
      if (s.alt < -1) return;
      const p = project(s.alt, s.az);
      starEls.push(
        <circle
          key={`s${i}`}
          cx={p.x}
          cy={p.y}
          r={Math.max(0.7, 2.3 - 0.38 * s.mag)}
          fill="var(--color-text-primary)"
          opacity={Math.max(0.3, 1 - s.mag * 0.12)}
        />,
      );
    });
    const lineEls = [];
    skyAltAz.lines.forEach((line, li) => {
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i];
        if (a.alt < -2 || b.alt < -2) continue;
        const pa = project(Math.max(a.alt, -1), a.az);
        const pb = project(Math.max(b.alt, -1), b.az);
        lineEls.push(
          <line key={`l${li}-${i}`} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
            stroke="var(--color-text-secondary)" strokeWidth="1" opacity="0.4" />,
        );
      }
    });
    const labelEls = [];
    skyAltAz.labels.forEach((s, i) => {
      if (s.alt < 12) return;
      const p = project(s.alt, s.az);
      labelEls.push(
        <text key={`c${i}`} x={p.x} y={p.y} textAnchor="middle" fontSize="8.5"
          fill="var(--color-text-gray)" opacity="0.95">{s.name}</text>,
      );
    });
    skyAltAz.named.forEach((s, i) => {
      if (s.alt < 2 || s.mag > 1.4) return;
      const p = project(s.alt, s.az);
      labelEls.push(
        <text key={`n${i}`} x={p.x + 5} y={p.y - 5} fontSize="8.5"
          fill="var(--color-text-secondary)">{s.name}</text>,
      );
    });
    let moonEl = null;
    const m = skyAltAz.moon;
    if (m.alt > 0 && !targets.some((t) => t.label === 'Moon')) {
      const p = project(m.alt, m.az);
      moonEl = (
        <g>
          <circle cx={p.x} cy={p.y} r="6" fill="var(--color-text-yellow)" opacity="0.9" />
          <text x={p.x + 9} y={p.y + 3} fontSize="8.5" fill="var(--color-text-secondary)">Moon</text>
        </g>
      );
    }
    const targetEls = [];
    targets.forEach((t, ti) => {
      if (t.path && t.path.length > 1) {
        const pts = t.path.filter((p) => p.alt > 0).map((p) => project(p.alt, p.az));
        if (pts.length > 1) {
          targetEls.push(
            <polyline key={`tp${ti}`}
              points={pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
              fill="none" stroke="var(--color-icon-accent)" strokeWidth="2.5"
              strokeLinejoin="round" strokeLinecap="round" opacity="0.9" />,
          );
          const first = pts[0], last = pts[pts.length - 1];
          targetEls.push(
            <circle key={`ts${ti}`} cx={first.x} cy={first.y} r="3" fill="var(--color-background-body)" stroke="var(--color-icon-accent)" strokeWidth="2" />,
            <circle key={`te${ti}`} cx={last.x} cy={last.y} r="3" fill="var(--color-background-body)" stroke="var(--color-icon-accent)" strokeWidth="2" />,
            <text key={`tsl${ti}`} x={first.x} y={first.y - 7} textAnchor="middle" fontSize="8.5" fill="var(--color-text-secondary)">
              {fmtTime(t.path[0].time)}
            </text>,
            <text key={`tel${ti}`} x={last.x} y={last.y + 14} textAnchor="middle" fontSize="8.5" fill="var(--color-text-secondary)">
              {fmtTime(t.path[t.path.length - 1].time)}
            </text>,
          );
        }
      }
      if (t.peak && t.peak.alt > 0) {
        const p = project(t.peak.alt, t.peak.az);
        targetEls.push(
          <g key={`tg${ti}`}>
            <circle cx={p.x} cy={p.y} r="5.5" fill="var(--color-text-yellow)" stroke="var(--color-background-body)" strokeWidth="2" />
            <text x={p.x} y={p.y - 11} textAnchor="middle" fontSize="10.5" fontWeight="bold" fill="var(--color-text-primary)">
              {t.label}
            </text>
            <text x={p.x} y={p.y + 18} textAnchor="middle" fontSize="8.5" fill="var(--color-text-secondary)">
              {fmtTime(t.peak.time)}
            </text>
          </g>,
        );
      }
      if (t.live && t.live.alt > 0) {
        const p = project(t.live.alt, t.live.az);
        targetEls.push(
          <g key={`tl${ti}`}>
            <circle cx={p.x} cy={p.y} r="10" fill="var(--color-text-yellow)" opacity="0.3" />
            <circle cx={p.x} cy={p.y} r="4.5" fill="var(--color-text-yellow)" stroke="var(--color-background-body)" strokeWidth="1.5" />
          </g>,
        );
      }
    });
    const cardinals = [['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([t, az]) => {
      const a = az * DEG;
      const x = CX + (R + 13) * Math.sin(a);
      const y = CY - (R + 13) * Math.cos(a);
      return (
        <text key={t} x={x} y={y + 4} textAnchor="middle" fontSize="12" fontWeight="bold"
          fill="var(--color-text-primary)">{t}</text>
      );
    });
    const crossEls = [0, 90, 180, 270].map((az) => {
      const a = project(90, az), b = project(0, az);
      return <line key={az} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--color-border)" strokeWidth="1" />;
    });
    return { starEls, lineEls, labelEls, moonEl, targetEls, cardinals, crossEls };
  }, [skyAltAz, targets]);

  if (!layers) return null;

  const ringLabel = (alt, dx) => {
    const p = project(alt, 0); // top of the chart, whichever way it faces
    return (
      <text x={p.x + dx} y={p.y - 2} fontSize="8" fill="var(--color-text-gray)">
        {alt}°
      </text>
    );
  };

  // Where the phone itself is pointing (follow mode): a reticle the user
  // walks onto the target. Screen coordinates (rotation applied here in
  // the projection), drawn outside the rotated group so it stays upright.
  // Below the horizon it parks on the rim, faded.
  const pointerEl = pointer ? (() => {
    const below = pointer.el < 0;
    const p = project(Math.max(pointer.el, 0), pointer.az, effRot);
    return (
      <g opacity={below ? 0.45 : 1}>
        <circle cx={p.x} cy={p.y} r="11" fill="none" stroke="var(--color-warning)" strokeWidth="2" />
        <circle cx={p.x} cy={p.y} r="2.2" fill="var(--color-warning)" />
        <line x1={p.x - 16} y1={p.y} x2={p.x - 6} y2={p.y} stroke="var(--color-warning)" strokeWidth="2" />
        <line x1={p.x + 6} y1={p.y} x2={p.x + 16} y2={p.y} stroke="var(--color-warning)" strokeWidth="2" />
        <line x1={p.x} y1={p.y - 16} x2={p.x} y2={p.y - 6} stroke="var(--color-warning)" strokeWidth="2" />
        <line x1={p.x} y1={p.y + 6} x2={p.x} y2={p.y + 16} stroke="var(--color-warning)" strokeWidth="2" />
      </g>
    );
  })() : null;

  // Small triangle on the rim marking the faced direction (top center
  // while following).
  const facingEl = heading != null ? (() => {
    const p = project(0, heading, effRot);
    const tip = project(-7, heading, effRot);
    return (
      <polygon
        points={`${tip.x},${tip.y} ${p.x - 7},${p.y} ${p.x + 7},${p.y}`}
        transform={`rotate(${(heading - effRot + 360) % 360} ${p.x} ${p.y})`}
        fill="var(--color-warning)"
      />
    );
  })() : null;

  return (
    <svg viewBox="0 0 360 360" className="sg-skychart" role="img"
      aria-label="Sky chart: the whole sky overhead, horizon at the rim, straight up in the center">
      <defs>
        <clipPath id="sg-sky-clip">
          <circle cx={CX} cy={CY} r={R} />
        </clipPath>
      </defs>
      <circle cx={CX} cy={CY} r={R} fill="var(--color-background-muted)" />
      <g
        style={{
          transform: `rotate(${-effRot}deg)`,
          transformOrigin: `${CX}px ${CY}px`,
          transformBox: 'view-box',
        }}
      >
        <g clipPath="url(#sg-sky-clip)">
          {layers.lineEls}
          {layers.starEls}
          {layers.labelEls}
          {layers.moonEl}
          {layers.targetEls}
          {layers.crossEls}
        </g>
        {layers.cardinals}
      </g>
      <circle cx={CX} cy={CY} r={R / 3} fill="none" stroke="var(--color-border)" strokeWidth="1" />
      <circle cx={CX} cy={CY} r={(2 * R) / 3} fill="none" stroke="var(--color-border)" strokeWidth="1" />
      <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--color-border-emphasized)" strokeWidth="1.5" />
      {ringLabel(60, 4)}
      {ringLabel(30, 4)}
      {facingEl}
      {pointerEl}
    </svg>
  );
}
