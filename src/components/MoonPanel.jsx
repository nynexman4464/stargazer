import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Text';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Token } from '@astryxdesign/core/Token';
import { Icon } from '@astryxdesign/core/Icon';
import { Cloud } from 'lucide-react';
import {
  DAY,
  moonPhase,
  moonPhaseName,
  moonPhaseImage,
  nextMoonPhase,
  nextFullMoon,
  fullMoonName,
  fmtDate,
  countdown,
  loadJSON,
  cloudCover,
  loadCloudClimatology,
  typicalCloud,
  lookTrack,
  moonEquatorial,
} from '../lib/astro.js';
import WhereToLook from './WhereToLook.jsx';

const base = import.meta.env.BASE_URL;

/* Cloud conditions for a moon-viewing night: the forecast when the date is
   within range, otherwise the historical typical ("historically 43% cloudy").
   Returns null when neither is available. */
async function moonConditions(date, loc, cache) {
  const fc = await cloudCover(date, loc, cache);
  if (fc != null) return `${Math.round(fc)}% clouds`;
  try {
    const clim = await loadCloudClimatology(loc);
    const t = typicalCloud(clim, date);
    if (t != null) return `historically ${t}% cloudy`;
  } catch {
    /* climatology unavailable — no conditions line */
  }
  return null;
}

/* The Moon, full-width: realistic phase photos (Jay Tanner render set),
   current phase + illumination, the next phase coming up, and the next
   full moon's traditional name — with a Blood Moon note when a total
   lunar eclipse lines up with it. Tonight's and the upcoming phase's
   cloud conditions ride along, since clouds decide whether the moon is
   actually worth looking at. */
export default function MoonPanel({ asOf, loc }) {
  // Fast-forwarded: show the moon "that night" — the viewing date at 9pm local.
  const ref = asOf
    ? new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate(), 21)
    : new Date();
  const { phase, illum } = moonPhase(ref);
  // Where the Moon is that night: peak time + direction + angle at a
  // glance, full track in the hover card (same component as the events).
  const moonLooks = useMemo(() => {
    if (!loc || loc.lat == null) return null;
    const base = asOf || new Date();
    const anchor = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 21);
    // The Moon is up in daylight too: widen the window to that morning and
    // keep samples from rise to set, not just after sunset.
    return [{ label: 'Moon', track: lookTrack((d) => moonEquatorial(d), anchor, loc, { startH: -15, hours: 30, daylightSamples: true }), note: null }];
  }, [loc, asOf]);
  const upcoming = nextMoonPhase(ref);
  // The featured full moon is a MOMENT, not a multi-day window
  // (Alex, 2026-10-24: the old phase-range test, 0.46-0.54,
  // crowned three different nights as 'tonight's full moon' and
  // dated this lunation's Hunter's Moon to Saturday when the
  // actual moment is Sunday 11:35 PM — flatly contradicting the
  // Up next row). Tonight is the full-moon night only when a
  // full moment falls on tonight's own date (the same date the
  // Up next row prints, so the panel tells one story); the
  // night after a full moon features the NEXT one ahead, never
  // yesterday's under a 'next' label.
  const nextFull = nextFullMoon(ref);
  const prevFull = nextFullMoon(new Date(ref.getTime() - 30 * DAY));
  const sameDate = (a, b) => a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
  const fullMoment = sameDate(prevFull, ref) ? prevFull : nextFull;
  const isFullTonight = sameDate(fullMoment, ref);
  const fullTs = fullMoment.getTime();
  const fullDate = new Date(fullTs);
  // Phase name for the big label: 'Full Moon' on the full
  // moon's own night; 'Nearly Full Moon' when it is 97%+ lit on
  // the nights either side (Alex: 'should we be saying nearly
  // full moon since the real full moon is tomorrow' — yes);
  // the standard phase names otherwise.
  const name = isFullTonight
    ? 'Full Moon'
    : illum >= 0.97
      ? 'Nearly Full Moon'
      : moonPhaseName(phase);
  const [bloodMoon, setBloodMoon] = useState(false);
  const [tonightCond, setTonightCond] = useState(null);
  const [nextCond, setNextCond] = useState(null);
  const wxCache = useRef({});
  const refMs = ref.getTime();
  const upcomingMs = upcoming ? upcoming.date.getTime() : 0;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!loc) return;
      const [t, n] = await Promise.all([
        moonConditions(new Date(refMs), loc, wxCache.current),
        upcomingMs ? moonConditions(new Date(upcomingMs), loc, wxCache.current) : null,
      ]);
      if (!cancelled) {
        setTonightCond(t);
        setNextCond(n);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loc, refMs, upcomingMs]);

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
        <HStack gap={5} vAlign="center" wrap="wrap" hAlign="between">
          <HStack gap={4} vAlign="center">
            <img
              src={`${base}${moonPhaseImage(phase)}`}
              alt={`The moon ${asOf ? 'that night' : 'right now'}: ${name}`}
              className="sg-moon-photo"
            />
            <VStack gap={1}>
              <Text type="label" color="secondary">
                {asOf ? `That night · ${fmtDate(asOf)}` : 'Right now'}
              </Text>
              <Text weight="semibold" size="lg">
                {name}
              </Text>
              <Text type="supporting">{Math.round(illum * 100)}% lit</Text>
              {tonightCond && (
                <HStack gap={1} vAlign="center">
                  <Icon icon={Cloud} size="sm" color="secondary" />
                  <Text type="supporting">{tonightCond}</Text>
                </HStack>
              )}
            </VStack>
          </HStack>
          {upcoming && (
            <HStack gap={3} vAlign="center">
              <img
                src={`${base}${moonPhaseImage(upcoming.phase)}`}
                alt={`Coming up: ${upcoming.name}`}
                loading="lazy"
                className="sg-moon-photo-sm"
              />
              <VStack gap={1}>
                <Text type="label" color="secondary">
                  Up next
                </Text>
                <Text weight="semibold">
                  {upcoming.name} — {fmtDate(upcoming.date)}
                </Text>
                <Text type="supporting">{countdown(upcoming.date)}</Text>
                {nextCond && (
                  <HStack gap={1} vAlign="center">
                    <Icon icon={Cloud} size="sm" color="secondary" />
                    <Text type="supporting">{nextCond}</Text>
                  </HStack>
                )}
              </VStack>
            </HStack>
          )}
          <VStack gap={1}>
            <Text type="label" color="secondary">
              {isFullTonight ? "Tonight's full moon" : 'Next full moon'}
            </Text>
            <HStack gap={2} vAlign="center">
              <Token label={fullMoonName(fullDate)} color="default" />
              {bloodMoon && <Token label="Blood Moon" color="red" />}
            </HStack>
            <Text type="supporting">{fmtDate(fullDate)}</Text>
            {bloodMoon && (
              <Text type="supporting">
                A total lunar eclipse that night — the moon will glow red where it's dark.
              </Text>
            )}
          </VStack>
        </HStack>
        {moonLooks && (
          <VStack gap={1}>
            <Text type="label" color="secondary">
              Where to look {asOf ? `· ${fmtDate(asOf)}` : '· tonight'}
            </Text>
            <WhereToLook
              looks={moonLooks}
              whenText={asOf ? `night of ${fmtDate(asOf)}` : 'tonight'}
              locName={loc?.name}
              loc={loc}
            />
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
