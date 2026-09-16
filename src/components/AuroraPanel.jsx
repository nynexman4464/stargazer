import { useEffect, useState } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Text';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { loadAuroraData } from '../lib/astro.js';

const BAND_DOT = { storm: 'error', possible: 'warning', quiet: 'success', south: 'neutral' };

function TrendBars({ recent }) {
  return (
    <HStack gap={1} vAlign="end" aria-label="Recent Kp trend">
      {recent.map((k, i) => (
        <Tooltip key={i} content={`${k.hour}:00 — Kp ${k.value.toFixed(1)}`}>
          <div
            className={`sg-kpbar${k.value >= 7 ? ' sg-hot' : k.value >= 5 ? ' sg-warm' : ''}`}
            role="img"
            aria-label={`${k.hour}:00, Kp ${k.value.toFixed(1)}`}
          >
            <i style={{ height: `${Math.max(6, (k.value / 9) * 100)}%` }} />
          </div>
        </Tooltip>
      ))}
    </HStack>
  );
}

export default function AuroraPanel({ loc }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(false);
    (async () => {
      try {
        const d = await loadAuroraData(loc);
        if (!cancelled) setData(d);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loc]);

  return (
    <section aria-label="Aurora now">
      <VStack gap={2}>
        <HStack gap={2} vAlign="center">
          <Heading level={2}>Aurora now</Heading>
          {!error && (
            <HStack gap={1} vAlign="center">
              <StatusDot variant="accent" label="Live space weather data" isPulsing />
              <Text type="supporting">live</Text>
            </HStack>
          )}
        </HStack>
        <Card padding={4}>
          {error ? (
            <VStack gap={1}>
              <Text weight="semibold">Aurora data unavailable right now.</Text>
              <Text type="supporting">NOAA feed could not be reached. Try again later.</Text>
            </VStack>
          ) : !data ? (
            <VStack gap={2}>
              <Skeleton height={20} width="40%" />
              <Skeleton height={16} width="90%" />
              <Skeleton height={16} width="70%" />
            </VStack>
          ) : (
            <VStack gap={3}>
              <HStack gap={3} vAlign="center">
                <Text type="display-1" hasTabularNumbers>
                  {data.kp.toFixed(1)}
                </Text>
                <VStack gap={1}>
                  <Tooltip content="0-to-9 scale of geomagnetic storm strength. 5+ means aurora might reach New England; 7+ means get outside now.">
                    <Text type="label" color="secondary">
                      Planetary K-index
                    </Text>
                  </Tooltip>
                  <HStack gap={2} vAlign="center">
                    <StatusDot variant={BAND_DOT[data.band]} label={data.verdict} />
                    <Text weight="semibold">{data.verdict}</Text>
                  </HStack>
                </VStack>
              </HStack>
              <Text type="supporting">{data.sub}</Text>
              <TrendBars recent={data.recent} />
            </VStack>
          )}
        </Card>
      </VStack>
    </section>
  );
}
