import { useEffect, useState } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Text';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { StatusDot } from '@astryxdesign/core/StatusDot';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { loadAuroraData, loadAuroraOutlook, loadAuroraForecastNight } from '../lib/astro.js';
import { fmtDate, isoDay } from '../lib/astro.js';

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

export default function AuroraPanel({ loc, viewDate }) {
  const [data, setData] = useState(null);
  const [outlook, setOutlook] = useState([]);
  // Future-night forecast: { kp, verdict, band }, or 'none' when the
  // forecast doesn't reach the selected date.
  const [forecast, setForecast] = useState(null);
  const [error, setError] = useState(false);

  const isFuture = !!viewDate;
  const dateKey = viewDate ? isoDay(viewDate) : 'live';

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setOutlook([]);
    setForecast(null);
    setError(false);
    (async () => {
      try {
        if (viewDate) {
          const f = await loadAuroraForecastNight(loc, viewDate);
          if (!cancelled) setForecast(f ?? 'none');
        } else {
          const [d, o] = await Promise.all([loadAuroraData(loc), loadAuroraOutlook(loc)]);
          if (!cancelled) {
            setData(d);
            setOutlook(o);
          }
        }
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc, dateKey]);

  return (
    <Card padding={4}>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center">
          <Heading level={2}>{isFuture ? 'Aurora forecast' : 'Aurora now'}</Heading>
          {!error && !isFuture && (
            <HStack gap={1} vAlign="center">
              <StatusDot variant="accent" label="Live space weather data" isPulsing />
              <Text type="supporting">live</Text>
            </HStack>
          )}
        </HStack>
          {error ? (
            <VStack gap={1}>
              <Text weight="semibold">Aurora data unavailable right now.</Text>
              <Text type="supporting">NOAA feed could not be reached. Try again later.</Text>
            </VStack>
          ) : isFuture ? (
            forecast === 'none' ? (
              <VStack gap={1}>
                <Text weight="semibold">No aurora predictions that far out.</Text>
                <Text type="supporting">
                  NOAA's Kp forecast only reaches about three days ahead.
                </Text>
              </VStack>
            ) : !forecast ? (
              <VStack gap={2}>
                <Skeleton height={20} width="40%" />
                <Skeleton height={16} width="90%" />
                <Skeleton height={16} width="70%" />
              </VStack>
            ) : (
              <VStack gap={3}>
                <HStack gap={3} vAlign="center">
                  <Text type="large" size="4xl">
                    {forecast.kp.toFixed(1)}
                  </Text>
                  <VStack gap={1}>
                    <Tooltip
                      content={
                        loc.lat >= 55
                          ? '0-to-9 scale of geomagnetic storm strength. This far north, even a 2 or 3 can put on a show after dark; 5+ means a strong display overhead.'
                          : '0-to-9 scale of geomagnetic storm strength. 5+ means aurora might reach New England; 7+ means get outside now.'
                      }
                    >
                      <Text type="label" color="secondary">
                        Predicted peak K-index
                      </Text>
                    </Tooltip>
                    <HStack gap={2} vAlign="center">
                      <StatusDot variant={BAND_DOT[forecast.band]} label={forecast.verdict} />
                      <Text weight="semibold">{forecast.verdict}</Text>
                    </HStack>
                  </VStack>
                </HStack>
                <Text type="supporting">
                  Forecast for the night of {fmtDate(viewDate)} — the strongest
                  predicted 3-hour stretch between 6pm and 6am.
                </Text>
              </VStack>
            )
          ) : !data ? (
            <VStack gap={2}>
              <Skeleton height={20} width="40%" />
              <Skeleton height={16} width="90%" />
              <Skeleton height={16} width="70%" />
            </VStack>
          ) : (
            <VStack gap={3}>
              <HStack gap={3} vAlign="center">
                <Text type="large" size="4xl">
                  {data.kp.toFixed(1)}
                </Text>
                <VStack gap={1}>
                  <Tooltip
                    content={
                      loc.lat >= 55
                        ? '0-to-9 scale of geomagnetic storm strength. This far north, even a 2 or 3 can put on a show after dark; 5+ means a strong display overhead.'
                        : '0-to-9 scale of geomagnetic storm strength. 5+ means aurora might reach New England; 7+ means get outside now.'
                    }
                  >
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
              {outlook.length > 0 && (
                <VStack gap={1}>
                  <Text type="label" color="secondary">
                    Outlook
                  </Text>
                  {outlook.map((o) => (
                    <HStack key={o.label} gap={2} vAlign="center">
                      <StatusDot variant={BAND_DOT[o.band]} label={o.label} />
                      <Text>
                        <strong>{o.label}</strong> — Kp up to {o.kp.toFixed(1)}. {o.verdict}
                      </Text>
                    </HStack>
                  ))}
                </VStack>
              )}
              <TrendBars recent={data.recent} />
            </VStack>
          )}
      </VStack>
    </Card>
  );
}
