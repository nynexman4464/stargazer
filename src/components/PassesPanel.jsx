import { useEffect, useState } from 'react';
import { twoline2satrec } from 'satellite.js';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Text';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { TabList, Tab } from '@astryxdesign/core/TabList';
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
  passQuality,
  fmtTime,
  fmtDate,
  countdown,
  compass,
} from '../lib/astro.js';

/* Bright flyovers: ISS / Tiangong / Hubble tabs with visible-pass predictions. */
export default function PassesPanel({ loc }) {
  const [norad, setNorad] = useState(SATS[0].norad);
  const [passes, setPasses] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPasses(null);
    setFailed(false);
    // let the tab switch paint before the (synchronous) orbital math runs
    const t = setTimeout(async () => {
      try {
        const [l1, l2] = await fetchTLE(norad);
        if (cancelled) return;
        const satrec = twoline2satrec(l1, l2);
        const p = computePasses(satrec, loc.lat, loc.lon, 72);
        if (!cancelled) setPasses(p);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }, 30);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [norad, loc]);

  const satName = SATS.find((s) => s.norad === norad)?.name || '';

  return (
    <Card padding={4}>
      <VStack gap={3}>
        <VStack gap={1}>
          <Heading level={2}>Bright flyovers</Heading>
          <Text type="supporting">ISS · Tiangong · Hubble — next 3 days</Text>
        </VStack>
          <VStack gap={3}>
            <TabList
              value={String(norad)}
              onChange={(v) => setNorad(Number(v))}
              role="tablist"
              aria-label="Satellite"
            >
              {SATS.map((s) => (
                <Tab key={s.norad} value={String(s.norad)} label={s.name} panelId={`passes-${s.norad}`} />
              ))}
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
                            at {fmtTime(p.maxT)} · {dur} min · {passQuality(p.maxEl)}
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
