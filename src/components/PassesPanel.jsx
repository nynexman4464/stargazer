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
export default function PassesPanel({ loc }) {
  const [norad, setNorad] = useState(SATS[0].norad);
  const [allPasses, setAllPasses] = useState(null); // null = loading, else { [norad]: scored passes }
  const [failedSats, setFailedSats] = useState([]);
  const wxCache = useRef({});

  useEffect(() => {
    let cancelled = false;
    setAllPasses(null);
    setFailedSats([]);
    wxCache.current = {};
    // let the first paint happen before the (synchronous) orbital math runs
    const t = setTimeout(async () => {
      // Fetch the TLEs one satellite at a time: CelesTrak throttles bursts
      // per IP, and the last request in a parallel burst is the one that
      // tends to fail. (Cached TLEs return instantly, so this is only slow
      // on the first load of the day.)
      const tleById = {};
      for (const s of SATS) {
        try {
          tleById[s.norad] = await fetchTLE(s.norad);
        } catch {
          tleById[s.norad] = null;
        }
      }
      const results = await Promise.all(
        SATS.map(async (s) => {
          try {
            const tle = tleById[s.norad];
            if (!tle) throw new Error('no TLE');
            const satrec = twoline2satrec(tle[0], tle[1]);
            const passes = computePasses(satrec, loc.lat, loc.lon, 72);
            const scored = await Promise.all(
              passes.map(async (p) => {
                const sc = await passScore(p, s.mag, loc, wxCache.current);
                return { ...p, score: sc.score, label: sc.label };
              }),
            );
            return [s.norad, scored];
          } catch {
            return [s.norad, null];
          }
        }),
      );
      if (cancelled) return;
      const map = {};
      const failed = [];
      for (const [id, passes] of results) {
        if (passes === null) failed.push(id);
        else map[id] = passes;
      }
      setFailedSats(failed);
      setAllPasses(map);
    }, 30);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [loc]);

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
