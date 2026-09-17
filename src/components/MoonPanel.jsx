import { useEffect, useState } from 'react';
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
  moonPhaseImage,
  nextMoonPhase,
  nextFullMoon,
  fullMoonName,
  fmtDate,
  countdown,
  loadJSON,
} from '../lib/astro.js';

const base = import.meta.env.BASE_URL;

/* The Moon, full-width: realistic phase photos (Jay Tanner render set),
   current phase + illumination, the next phase coming up, and the next
   full moon's traditional name — with a Blood Moon note when a total
   lunar eclipse lines up with it. */
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
        <HStack gap={5} vAlign="center" wrap="wrap" hAlign="between">
          <HStack gap={4} vAlign="center">
            <img
              src={`${base}${moonPhaseImage(phase)}`}
              alt={`The moon right now: ${name}`}
              className="sg-moon-photo"
            />
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
              </VStack>
            </HStack>
          )}
          <VStack gap={1}>
            <Text type="label" color="secondary">
              {isFullNow ? "Tonight's full moon" : 'Next full moon'}
            </Text>
            <HStack gap={2} vAlign="center">
              <Token label={fullMoonName(fullDate)} color="default" />
              {bloodMoon && <Token label="Blood Moon" color="red" />}
            </HStack>
            {bloodMoon && (
              <Text type="supporting">
                A total lunar eclipse that night — the moon will glow red where it's dark.
              </Text>
            )}
          </VStack>
        </HStack>
      </VStack>
    </Card>
  );
}
