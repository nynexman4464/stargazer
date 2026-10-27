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
  DAY,
  fetchTLE,
  computePasses,
  passScore,
  brightnessWords,
  fmtTime,
  fmtDate,
  fmtDateLoc,
  dayKeyTz,
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
        {satName} — {fmtDateLoc(p.start)} pass
      </Text>
      <Text type="supporting">
        Appears {fmtTime(p.start)} in the {compass(p.startAz)} · peaks{' '}
        {Math.round(p.maxEl)}° at {fmtTime(p.maxT)} · disappears {fmtTime(p.end)}{' '}
        toward the {compass(p.endAz)}.
      </Text>
      {p.track && p.track.length > 1 && (
        <VStack gap={1}>
          {/* Visible minutes only — the track also carries the
              in-shadow extension points the sky view draws dotted;
              this card stays the visible pass, minute by minute. */}
          {p.track.filter((s) => s.vis !== false).map((s) => (
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

/* Bright flyovers: visible-pass predictions for ISS / Tiangong /
   Hubble, tabbed by DATE (Alex, 2026-10-26: tabs by date instead
   of by satellite — 'what's on Tuesday' is how you plan around a
   pass, and one night's passes read in time order). Each pass
   gets a 0-100 visibility score from peak elevation, the
   satellite's typical visual magnitude, and forecast cloud
   cover at pass time. A date tab's badge is that day's best
   score at a glance. */
export default function PassesPanel({ loc, bundledTles, fromDate }) {
  const [dayKey, setDayKey] = useState(null);
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
                // Tag the satellite onto each pass: the list
                // mixes satellites now that tabs are dates.
                return { ...p, score: sc.score, label: sc.label, norad: s.norad, satName: s.name };
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

  // Group every satellite's passes by calendar day in the
  // viewed location's timezone (the same tz fmtTime renders),
  // so a pass's day tab and its clock time never disagree.
  const days = (() => {
    if (!allPasses) return [];
    const byDay = new Map();
    for (const list of Object.values(allPasses)) {
      for (const p of list) {
        const d = p.start;
        const key = dayKeyTz(d);
        if (!byDay.has(key)) {
          byDay.set(key, {
            key,
            date: d,
            passes: [],
          });
        }
        byDay.get(key).passes.push(p);
      }
    }
    const out = [...byDay.values()].sort((a, b) => a.date - b.date);
    for (const d of out) d.passes.sort((a, b) => a.start - b.start);
    return out;
  })();
  const selDay = days.find((d) => d.key === dayKey) || days[0] || null;
  const passes = selDay ? selDay.passes : null;
  // Satellites resolve one by one; the panel is still loading
  // until each has either delivered passes or failed.
  const resolvedCount =
    (allPasses ? Object.keys(allPasses).length : 0) + failedSats.length;
  const loading = resolvedCount < SATS.length;
  const allFailed = failedSats.length === SATS.length;
  const failedNames = SATS.filter((s) => failedSats.includes(s.norad))
    .map((s) => s.name)
    .join(', ');

  // Best-scoring pass of a day, for the tab badge.
  const bestOf = (list) =>
    list.length ? list.reduce((a, b) => (a.score >= b.score ? a : b)) : null;
  const scoreVariant = (label) =>
    label === 'Excellent' ? 'success' : label === 'Good' ? 'warning' : 'neutral';
  const dayLabel = (d) => {
    if (fromDate) return fmtDate(d.date);
    const diff = Math.round((Date.parse(dayKeyTz(d.date)) - Date.parse(dayKeyTz(new Date()))) / DAY);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return fmtDateLoc(d.date);
  };

  return (
    <Card padding={4}>
      <VStack gap={3}>
        <VStack gap={1}>
          <Heading level={2}>Bright flyovers</Heading>
          <Text type="supporting">
            ISS · Tiangong · Hubble —{' '}
            {fromDate ? `3 days from ${fmtDate(fromDate)}` : 'next 3 days'}, by day. Tab badge
            is the day's best visibility score (0–100): height, brightness, clouds.
          </Text>
        </VStack>
        <VStack gap={3}>
          <TabList
            value={selDay ? selDay.key : ''}
            onChange={(v) => setDayKey(v)}
            role="tablist"
            aria-label="Day"
          >
            {days.map((d) => {
              const best = bestOf(d.passes);
              return (
                <Tab
                  key={d.key}
                  value={d.key}
                  label={dayLabel(d)}
                  panelId={`passes-${d.key}`}
                  endContent={
                    best ? (
                      <Badge label={`${best.score}`} variant={scoreVariant(best.label)} />
                    ) : null
                  }
                />
              );
            })}
          </TabList>
        <div id={selDay ? `passes-${selDay.key}` : 'passes-none'} role="tabpanel">
            {allFailed ? (
              <Text type="supporting">
                Could not load orbital data (CelesTrak unreachable). Try again later.
              </Text>
            ) : loading && passes === null ? (
              <VStack gap={2}>
                <Skeleton height={56} />
                <Skeleton height={56} />
                <Text type="supporting">Computing orbits…</Text>
              </VStack>
            ) : !passes || passes.length === 0 ? (
              <EmptyState
                title={`No good visible passes`}
                description={`Nothing makes a good visible pass ${
                  fromDate ? `in the 3 days from ${fmtDate(fromDate)}` : 'in the next 3 days'
                } from ${loc.name}.`}
                icon={<Icon icon={Satellite} size="lg" color="secondary" />}
                isCompact
              />
            ) : (
              <List hasDividers density="balanced">
                {passes.map((p, i) => {
                  const dur = Math.round((p.end - p.start) / 60000);
                  const label = `${p.satName} · ${fmtTime(p.start)}`;
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
                          at {fmtTime(p.maxT)} · <Mag value={p.mag} exclude={p.satName}>mag {p.mag}</Mag> ({brightnessWords(p.mag)}) · {dur} min · score {p.score} — {p.label.toLowerCase()}
                        </Text>
                      }
                      endContent={
                        <HStack gap={1} vAlign="center">
                          {p.track?.length > 1 && (
                            <IconButton
                              icon={<Icon icon={Telescope} size="sm" />}
                              label={`Sky chart for this ${p.satName} pass`}
                              variant="ghost"
                              size="sm"
                              onClick={() => setSkyPass(p)}
                            />
                          )}
                          <HoverCard
                            label={`${p.satName} pass track`}
                            content={<PassTrack p={p} satName={p.satName} />}
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
            {failedSats.length > 0 && !allFailed && passes && passes.length > 0 && (
              <Text type="supporting">
                Could not load orbital data for {failedNames} — any of its passes are missing
                above.
              </Text>
            )}
          </div>
          </VStack>
      </VStack>
      {skyPass && (
        <SkyView
          isOpen
          onClose={() => setSkyPass(null)}
          title={`${skyPass.satName} — find in the sky`}
          subtitle={`${fmtDateLoc(skyPass.start)} · appears ${fmtTime(skyPass.start)} in the ${compass(skyPass.startAz)} · peaks ${Math.round(skyPass.maxEl)}° at ${fmtTime(skyPass.maxT)}`}
          targets={[{
            label: skyPass.satName,
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
