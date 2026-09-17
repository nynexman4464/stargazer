import { useEffect, useRef, useState } from 'react';
import { twoline2satrec } from 'satellite.js';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Text';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { TabList, Tab } from '@astryxdesign/core/TabList';
import { Badge } from '@astryxdesign/core/Badge';
import { List } from '@astryxdesign/core/List';
import { ListItem } from '@astryxdesign/core/List';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Icon } from '@astryxdesign/core/Icon';
import { Satellite } from 'lucide-react';
import {
  SATS,
  fetchTLE,
  computePasses,
  passScore,
  fmtTime,
  fmtDate,
  countdown,
  compass,
} from '../lib/astro.js';

/* Bright flyovers: ISS / Tiangong / Hubble tabs with visible-pass predictions.
   Each pass gets a 0-100 visibility score from peak elevation, the satellite's
   typical visual magnitude, and forecast cloud cover at pass time. Tabs show
   the best score at a glance. */
export default function PassesPanel({ loc, bundledTles }) {
  const [norad, setNorad] = useState(SATS[0].norad);
  const [allPasses, setAllPasses] = useState(null); // null = loading, else { [norad]: scored passes }
  const [failedSats, setFailedSats] = useState([]);
  const wxCache = useRef({});

  useEffect(() => {
    // Wait for the bundled TLEs (loaded by the app boot) so the first
    // attempt never needs the network when the site ships fresh data.
    if (!bundledTles) return;
    let cancelled = false;
    setAllPasses(null);
    setFailedSats([]);
    wxCache.current = {};
    // let the first paint happen before the (synchronous) orbital math runs
    const t = setTimeout(async () => {
      // Fetch the three TLEs in parallel: each request carries its own 15s
      // timeout plus retries with backoff, so a throttled request rides it
      // out while the others proceed. Each satellite's tab fills in as soon
      // as its own data arrives instead of waiting for the slowest one.
      // (Cached TLEs return instantly, so this is only slow on the first
      // load of the day.)
      await Promise.all(
        SATS.map(async (s) => {
          try {
            const [l1, l2] = await fetchTLE(s.norad, bundledTles);
            if (cancelled) return;
            const satrec = twoline2satrec(l1, l2);
            const passes = computePasses(satrec, loc.lat, loc.lon, 72);
            const scored = await Promise.all(
              passes.map(async (p) => {
                const sc = await passScore(p, s.mag, loc, wxCache.current);
                return { ...p, score: sc.score, label: sc.label };
              }),
            );
            if (cancelled) return;
            setAllPasses((prev) => ({ ...(prev || {}), [s.norad]: scored }));
          } catch {
            if (cancelled) return;
            setFailedSats((prev) => (prev.includes(s.norad) ? prev : [...prev, s.norad]));
          }
        }),
      );
    }, 30);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [loc, bundledTles]);

  const satName = SATS.find((s) => s.norad === norad)?.name || '';
  const passes = allPasses?.[norad] ?? null;
  const failed = failedSats.includes(norad);

  // Best-scoring pass per satellite, for the tab badges.
  const bestPass = (id) => {
    const p = allPasses?.[id];
    if (!p || p.length === 0) return null;
    return p.reduce((a, b) => (a.score >= b.score ? a : b));
  };
  const scoreVariant = (label) =>
    label === 'Excellent' ? 'success' : label === 'Good' ? 'warning' : 'neutral';

  return (
    <Card padding={4}>
      <VStack gap={3}>
        <VStack gap={1}>
          <Heading level={2}>Bright flyovers</Heading>
          <Text type="supporting">ISS · Tiangong · Hubble — next 3 days. Tab badge is the visibility score (0–100): height, brightness, clouds.</Text>
        </VStack>
        <VStack gap={3}>
          <TabList
            value={String(norad)}
            onChange={(v) => setNorad(Number(v))}
            role="tablist"
            aria-label="Satellite"
          >
            {SATS.map((s) => {
              const best = bestPass(s.norad);
              return (
                <Tab
                  key={s.norad}
                  value={String(s.norad)}
                  label={s.name}
                  panelId={`passes-${s.norad}`}
                  endContent={
                    best !== null ? (
                      <Badge label={`${best.score}`} variant={scoreVariant(best.label)} />
                    ) : null
                  }
                />
              );
            })}
          </TabList>
        <div id={`passes-${norad}`} role="tabpanel">
            {failed ? (
              <Text type="supporting">
                Could not load orbital data (CelesTrak unreachable). Try again later.
              </Text>
            ) : passes === null ? (
              <VStack gap={2}>
                <Skeleton height={56} />
                <Skeleton height={56} />
                <Text type="supporting">Computing orbits…</Text>
              </VStack>
            ) : passes.length === 0 ? (
              <EmptyState
                title={`No good visible passes`}
                description={`${satName} won't make a good visible pass in the next 3 days from ${loc.name}.`}
                icon={<Icon icon={Satellite} size="lg" color="secondary" />}
                isCompact
              />
            ) : (
              <List hasDividers density="balanced">
                {passes.map((p, i) => {
                  const dur = Math.round((p.end - p.start) / 60000);
                  const label = `${fmtDate(p.start)} · ${fmtTime(p.start)}`;
                  return (
                    <ListItem
                      key={i}
                      label={
                        <Text weight="semibold">
                          {label}{' '}
                          <Text type="supporting" weight="normal">
                            {countdown(p.start) === 'now' ? 'visible now!' : countdown(p.start)}
                          </Text>
                        </Text>
                      }
                      description={
                        <Text type="supporting">
                          {compass(p.startAz)} → {compass(p.endAz)} · peaks {Math.round(p.maxEl)}°
                          at {fmtTime(p.maxT)} · {dur} min · score {p.score} — {p.label.toLowerCase()}
                        </Text>
                      }
                      endContent={
                        <VStack gap={0} hAlign="end">
                          <Text type="large" weight="semibold" hasTabularNumbers>
                            {Math.round(p.maxEl)}°
                          </Text>
                          <Text type="supporting">max elev</Text>
                        </VStack>
                      }
                    />
                  );
                })}
              </List>
            )}
          </div>
          </VStack>
      </VStack>
    </Card>
  );
}
