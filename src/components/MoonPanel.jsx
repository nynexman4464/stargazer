import { useEffect, useId, useState } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Text';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Token } from '@astryxdesign/core/Token';
import {
  DAY,
  moonPhase,
  moonPhaseName,
  nextMoonPhase,
  nextFullMoon,
  fullMoonName,
  fmtDate,
  countdown,
  loadJSON,
} from '../lib/astro.js';

const base = import.meta.env.BASE_URL;

/* Moon disc drawn for the exact phase: the lit limb plus a terminator ellipse
   whose width follows the phase angle. Waning phases are the waxing drawing
   mirrored. Craters are clipped to the lit region. */
function PhaseDisc({ phase, size = 104 }) {
  const clipId = useId().replace(/:/g, '');
  const p = phase <= 0.5 ? phase : 1 - phase; // waxing-equivalent
  const waning = phase > 0.5 && phase < 1;
  const cosT = Math.cos(2 * Math.PI * p);
  const rx = Math.abs(50 * cosT);
  const sweep = cosT >= 0 ? 1 : 0; // crescent: terminator bulges toward the lit limb
  const lit = `M 50 0 A 50 50 0 0 1 50 100 A ${rx.toFixed(2)} 50 0 0 ${sweep} 50 0 Z`;
  const disc = (
    <>
      <circle
        cx="50"
        cy="50"
        r="49"
        fill="rgba(255,255,255,0.07)"
        stroke="rgba(255,255,255,0.18)"
        strokeWidth="1.5"
      />
      {p > 0.004 && (
        <g clipPath={`url(#${clipId})`}>
          <circle cx="50" cy="50" r="49" fill="#E9E5D8" />
          <circle cx="34" cy="38" r="7" fill="rgba(0,0,0,0.07)" />
          <circle cx="62" cy="60" r="9" fill="rgba(0,0,0,0.06)" />
          <circle cx="48" cy="74" r="5" fill="rgba(0,0,0,0.08)" />
          <circle cx="68" cy="32" r="4" fill="rgba(0,0,0,0.07)" />
          <circle cx="40" cy="58" r="3" fill="rgba(0,0,0,0.06)" />
        </g>
      )}
      <clipPath id={clipId}>
        <path d={lit} />
      </clipPath>
    </>
  );
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role="img"
      aria-label={`Moon phase illustration: ${moonPhaseName(phase)}`}
    >
      {waning ? <g transform="translate(100,0) scale(-1,1)">{disc}</g> : disc}
    </svg>
  );
}

export default function MoonPanel() {
  const now = new Date();
  const { phase, illum } = moonPhase(now);
  const name = moonPhaseName(phase);
  const upcoming = nextMoonPhase(now);
  const isFullNow = phase > 0.46 && phase < 0.54;
  // The full moon we're featuring: tonight's if it's full now, else the next one.
  const [fullTs] = useState(() =>
    (isFullNow ? now : nextFullMoon(now)).getTime(),
  );
  const fullDate = new Date(fullTs);
  const [bloodMoon, setBloodMoon] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const j = await loadJSON(`${base}data/eclipses.json`);
        const hit = (j?.lunar || []).some(
          (e) =>
            e.type === 'total' &&
            Math.abs(new Date(e.date + 'T12:00:00') - fullTs) < 1.5 * DAY,
        );
        if (!cancelled) setBloodMoon(hit);
      } catch {
        /* eclipse catalog unavailable — just skip the blood-moon note */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fullTs]);

  return (
    <Card padding={4}>
      <VStack gap={3}>
        <Heading level={2}>The Moon</Heading>
        <HStack gap={4} vAlign="center">
          <PhaseDisc phase={phase} />
          <VStack gap={1}>
            <Text type="label" color="secondary">
              Right now
            </Text>
            <Text weight="semibold" size="lg">
              {name}
            </Text>
            <Text type="supporting">{Math.round(illum * 100)}% lit</Text>
          </VStack>
        </HStack>
        {upcoming && (
          <HStack gap={3} vAlign="center">
            <PhaseDisc phase={upcoming.phase} size={56} />
            <VStack gap={1}>
              <Text type="label" color="secondary">
                Up next
              </Text>
              <Text weight="semibold">
                {upcoming.name} — {fmtDate(upcoming.date)}
              </Text>
              <Text type="supporting">{countdown(upcoming.date)}</Text>
            </VStack>
          </HStack>
        )}
        <HStack gap={2} vAlign="center">
          <Text type="label" color="secondary">
            {isFullNow ? "Tonight's full moon" : 'Next full moon'}
          </Text>
          <Token label={fullMoonName(fullDate)} color="default" />
          {bloodMoon && <Token label="Blood Moon" color="red" />}
        </HStack>
        {bloodMoon && (
          <Text type="supporting">
            A total lunar eclipse that night — the moon will glow red where it's dark.
          </Text>
        )}
      </VStack>
    </Card>
  );
}
