import { useEffect, useRef, useState } from 'react';
import { twoline2satrec } from 'satellite.js';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Text';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { TabList, Tab } from '@astryxdesign/core/TabList';
import { Badge } from '@astryxdesign/core/Badge';
import { Token } from '@astryxdesign/core/Token';
import { List } from '@astryxdesign/core/List';
import { ListItem } from '@astryxdesign/core/List';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HoverCard } from '@astryxdesign/core/HoverCard';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Satellite, Clock, Telescope } from 'lucide-react';
import {
  SATS,
  fetchTLE,
  computePasses,
  passScore,
  brightnessWords,
  fmtTime,
  fmtDate,
  countdown,
  isImminent,
  compass,
  pathPointAt,
} from '../lib/astro.js';
import { Mag } from './Term.jsx';
import SkyView from './SkyView.jsx';

/* Full track for one pass, in a hover card anchored to the pass's peak
   angle: appears/peaks/disappears plus the minute-by-minute direction
   and height, so the glance line can stay one line long. */
function PassTrack({ p, satName }) {
  return (
    <VStack gap={2}>
      <Text weight="semibold">
        {satName} — {fmtDate(p.start)} pass
      </Text>
      <Text type="supporting">
        Appears {fmtTime(p.start)} in the {compass(p.startAz)} · peaks{' '}
        {Math.round(p.maxEl)}° at {fmtTime(p.maxT)} · disappears {fmtTime(p.end)}{' '}
        toward the {compass(p.endAz)}.
      </Text>
      {p.track && p.track.length > 1 && (
        <VStack gap={1}>
          {p.track.map((s) => (
            <HStack key={s.time.getTime()} hAlign="between" vAlign="center" gap={3}>
              <Text type="supporting">{fmtTime(s.time)}</Text>
              <Text type="supporting" weight="semibold">
                {compass(s.az)} · {Math.round(s.alt)}° up
              </Text>
            </HStack>
          ))}
        </VStack>
      )}
    </VStack>
  );
}

/* Bright flyovers: ISS / Tiangong / Hubble tabs with visible-pass predictions.
   Each pass gets a 0-100 visibility score from peak elevation, the satellite's
   typical visual magnitude, and forecast cloud cover at pass time. Tabs show
   the best score at a glance. */
export default function PassesPanel({ loc, bundledTles, fromDate }) {
  const [norad, setNorad] = useState(SATS[0].norad);
  const [skyPass, setSkyPass] = useState(null);
  const [allPasses, setAllPasses] = useState(null); // null = loading, else { [norad]: scored passes }
  const [failedSats, setFailedSats] = useState([]);
  const wxCache = useRef({});
  // Fast-forwarded: propagate orbits from the viewing date instead of now.
  const fromMs = fromDate ? fromDate.getTime() : null;

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
            const passes = computePasses(satrec, loc.lat, loc.lon, 72, s.mag, fromMs);
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
  }, [loc, bundledTles, fromMs]);

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
          <Text type="supporting">
            ISS · Tiangong · Hubble —{' '}
            {fromDate ? `3 days from ${fmtDate(fromDate)}` : 'next 3 days'}. Tab badge is the
            visibility score (0–100): height, brightness, clouds.
          </Text>
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
                description={`${satName} won't make a good visible pass ${
                  fromDate ? `in the 3 days from ${fmtDate(fromDate)}` : 'in the next 3 days'
                } from ${loc.name}.`}
                icon={<Icon icon={Satellite} size="lg" color="secondary" />}
                isCompact
              />
            ) : (
              <List hasDividers density="balanced">
                {passes.map((p, i) => {
                  const dur = Math.round((p.end - p.start) / 60000);
                  const label = `${fmtDate(p.start)} · ${fmtTime(p.start)}`;
                  const cd = countdown(p.start);
                  const live = cd === 'now';
                  // Imminent passes (under 24h out, or in progress) get the
                  // countdown as a token so they stand out; farther passes
                  // keep it as plain inline text.
                  const soon = live || isImminent(p.start);
                  return (
                    <ListItem
                      key={i}
                      label={
                        <HStack gap={2} vAlign="center">
                          <Text weight="semibold">{label}</Text>
                          {soon ? (
                            <Token
                              size="sm"
                              color={live ? 'green' : 'default'}
                              label={live ? 'visible now!' : cd}
                              icon={<Icon icon={Clock} size="sm" />}
                            />
                          ) : (
                            <Text type="supporting" weight="normal">
                              {cd}
                            </Text>
                          )}
                        </HStack>
                      }
                      description={
                        <Text type="supporting">
                          {compass(p.startAz)} → {compass(p.endAz)} · peaks {Math.round(p.maxEl)}°
                          at {fmtTime(p.maxT)} · <Mag value={p.mag} exclude={satName}>mag {p.mag}</Mag> ({brightnessWords(p.mag)}) · {dur} min · score {p.score} — {p.label.toLowerCase()}
                        </Text>
                      }
                      endContent={
                        <HStack gap={1} vAlign="center">
                          {p.track?.length > 1 && (
                            <IconButton
                              icon={<Icon icon={Telescope} size="sm" />}
                              label={`Sky chart for this ${satName} pass`}
                              variant="ghost"
                              size="sm"
                              onClick={() => setSkyPass(p)}
                            />
                          )}
                          <HoverCard
                            label={`${satName} pass track`}
                            content={<PassTrack p={p} satName={satName} />}
                            placement="above"
                            hasHoverIndication={false}
                            touchTrigger="tap"
                          >
                            <VStack gap={0} hAlign="end">
                              <Text type="large" weight="semibold" hasTabularNumbers>
                                {Math.round(p.maxEl)}°
                              </Text>
                              <Text type="supporting">max elev</Text>
                            </VStack>
                          </HoverCard>
                        </HStack>
                      }
                    />
                  );
                })}
              </List>
            )}
          </div>
          </VStack>
      </VStack>
      {skyPass && (
        <SkyView
          isOpen
          onClose={() => setSkyPass(null)}
          title={`${satName} — find in the sky`}
          subtitle={`${fmtDate(skyPass.start)} · appears ${fmtTime(skyPass.start)} in the ${compass(skyPass.startAz)} · peaks ${Math.round(skyPass.maxEl)}° at ${fmtTime(skyPass.maxT)}`}
          targets={[{
            label: satName,
            path: skyPass.track,
            peak: {
              time: skyPass.maxT,
              alt: skyPass.maxEl,
              az: (skyPass.track.reduce((best, s) =>
                Math.abs(s.time - skyPass.maxT) < Math.abs(best.time - skyPass.maxT) ? s : best,
              skyPass.track[0])).az,
            },
            nowFn: (now) => pathPointAt(skyPass.track, now),
          }]}
          atTime={skyPass.maxT}
          loc={loc}
        />
      )}
    </Card>
  );
}
