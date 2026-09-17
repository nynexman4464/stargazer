import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@astryxdesign/core/AppShell';
import { Layout } from '@astryxdesign/core/Layout';
import { LayoutContent } from '@astryxdesign/core/Layout';
import { VStack } from '@astryxdesign/core/VStack';
import { Grid, GridSpan } from '@astryxdesign/core/Grid';
import { Text } from '@astryxdesign/core/Text';
import TopBar from './components/TopBar.jsx';
import LocationDialog from './components/LocationDialog.jsx';
import TonightHero from './components/TonightHero.jsx';
import AuroraPanel from './components/AuroraPanel.jsx';
import PassesPanel from './components/PassesPanel.jsx';
import EventFeed from './components/EventFeed.jsx';
import DarkSkySpots from './components/DarkSkySpots.jsx';
import Glossary from './components/Glossary.jsx';
import MoonPanel from './components/MoonPanel.jsx';
import {
  DAY,
  loadLoc,
  saveLoc,
  loadHome,
  saveHome,
  loadLastAway,
  saveLastAway,
  isAway,
  loadJSON,
  loadTles,
  normalizeEvents,
  goScore,
  loadCloudClimatology,
  typicalCloud,
  startOfDay,
} from './lib/astro.js';

const base = import.meta.env.BASE_URL;

export default function App() {
  const [loc, setLoc] = useState(loadLoc);
  const [home, setHome] = useState(loadHome);
  const [lastAway, setLastAway] = useState(() => {
    const saved = loadLastAway();
    if (saved) return saved;
    // Seed from the current spot so travelers who are already away
    // get an Away option in the menu on first run.
    const cur = loadLoc();
    return isAway(cur, loadHome()) ? cur : null;
  });
  const [tier, setTier] = useState('all');
  const [type, setType] = useState('all');
  const [range, setRange] = useState('all');
  const [events, setEvents] = useState([]);
  const [spots, setSpots] = useState([]);
  const [scores, setScores] = useState({});
  const [sources, setSources] = useState('');
  const [tles, setTles] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [locOpen, setLocOpen] = useState(false);
  /* Viewing date ("fast forward"): null = today. A picked date re-anchors
     the hero, event feed, moon panel, and flyovers onto that day. */
  const [viewDate, setViewDate] = useState(null);
  const anchorDay = useMemo(() => (viewDate ? startOfDay(viewDate) : null), [viewDate]);
  const weatherCache = useRef({});

  const away = isAway(loc, home);

  /* ---- data boot ---- */
  useEffect(() => {
    (async () => {
      const [showers, eclipses, conjs, comets, spotsData, man, tlesData] = await Promise.all([
        loadJSON(`${base}data/showers.json`),
        loadJSON(`${base}data/eclipses.json`),
        loadJSON(`${base}data/conjunctions.json`),
        loadJSON(`${base}data/comets.json`),
        loadJSON(`${base}data/darksky.json`),
        loadJSON(`${base}data/_manifest.json`),
        loadTles(`${base}data/tles.json`),
      ]);
      setEvents(normalizeEvents(showers, eclipses, conjs, comets));
      setSpots(spotsData?.sites || []);
      setTles(tlesData);
      if (man?.sources) setSources('Data: ' + man.sources.join(' · '));
      setLoaded(true);
    })();
  }, []);

  /* ---- go-scores (async, non-blocking) ----
     Today: the nearest events, as before. Fast-forwarded: the events in the
     hero's 3-day viewing window. Beyond ~15 days there's no forecast, so
     those are skipped (goScore returns null there anyway). */
  useEffect(() => {
    weatherCache.current = {};
    setScores({});
  }, [loc]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let targets;
      if (anchorDay) {
        const start = anchorDay.getTime();
        const end = start + 3 * DAY;
        targets = events.filter((e) => {
          const t = e.date instanceof Date ? e.date.getTime() : new Date(e.date).getTime();
          return t >= start && t < end;
        });
        // Empty window: the hero falls back to the next event on/after the
        // viewing date, so score that instead of leaving it unscored.
        if (targets.length === 0) {
          const next = events.find((e) => {
            const t = e.date instanceof Date ? e.date.getTime() : new Date(e.date).getTime();
            return t >= start;
          });
          if (next) targets = [next];
        }
      } else {
        targets = events.slice(0, 8);
      }
      for (const e of targets.slice(0, 8)) {
        if (cancelled) return;
        if ((e.date - Date.now()) / DAY >= 15) continue;
        const sc = await goScore(e, loc, weatherCache.current);
        if (cancelled || !sc) continue;
        setScores((prev) => (prev[e.id] ? prev : { ...prev, [e.id]: sc }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [events, loc, anchorDay]);

  /* ---- cloud climatology (historical typical cloudiness) ----
     For a fast-forwarded hero pick beyond the ~15-day forecast, there is no
     go-score; instead we show the historical typical cloud cover for that
     time of year, clearly labeled as an estimate, not a forecast. */
  const [climDaily, setClimDaily] = useState(null);
  const [climFailed, setClimFailed] = useState(false);
  const pickBeyondForecast = !!pick && (pick.date - Date.now()) / DAY > 15;
  useEffect(() => {
    setClimDaily(null);
    setClimFailed(false);
    if (!anchorDay || !pickBeyondForecast) return;
    let cancelled = false;
    (async () => {
      try {
        const daily = await loadCloudClimatology(loc);
        if (!cancelled) setClimDaily(daily);
      } catch {
        if (!cancelled) setClimFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // pick identity is stable (same event object) unless the chosen event changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchorDay, loc, pick]);
  const histCloud =
    pickBeyondForecast && pick ? typicalCloud(climDaily, pick.date) : null;
  const histCloudLoading = pickBeyondForecast && climDaily == null && !climFailed;

  /* ---- location ---- */
  const applyLoc = useCallback(
    (next) => {
      setLoc(next);
      saveLoc(next);
      if (isAway(next, home)) {
        saveLastAway(next);
        setLastAway({ ...next });
      }
      setLocOpen(false);
    },
    [home],
  );

  const backHome = useCallback(() => {
    saveLoc(home);
    setLoc({ ...home });
    setLocOpen(false);
  }, [home]);

  const goAway = useCallback(() => {
    if (!lastAway) return;
    saveLoc(lastAway);
    setLoc({ ...lastAway });
  }, [lastAway]);

  const setHomeHere = useCallback(() => {
    const next = { ...loc };
    saveHome(next);
    setHome(next);
  }, [loc]);

  /* ---- hero pick ----
     Today: soonest events as before. Fast-forwarded: the best-scoring event
     in the 3-day window starting on the viewing date — or, when that window
     is empty, the next event on/after the viewing date (mirroring Today's
     fallback to the next upcoming event). */
  const heroCands = (() => {
    if (!anchorDay) {
      const nowMs = Date.now();
      return events.filter((e) => e.date - nowMs < 60 * 3600000 && e.date - nowMs > -6 * 3600000);
    }
    const start = anchorDay.getTime();
    const end = start + 3 * DAY;
    return events.filter((e) => {
      const t = e.date instanceof Date ? e.date.getTime() : new Date(e.date).getTime();
      return t >= start && t < end;
    });
  })();
  // Next event on/after the viewing date (events are future-filtered and
  // date-sorted). For Today this is just events[0], as before.
  const nextAfterAnchor = (() => {
    if (!anchorDay) return events[0];
    const start = anchorDay.getTime();
    return events.find((e) => {
      const t = e.date instanceof Date ? e.date.getTime() : new Date(e.date).getTime();
      return t >= start;
    });
  })();
  const pick =
    heroCands
      .filter((e) => scores[e.id])
      .sort((a, b) => scores[b.id].score - scores[a.id].score)[0] ||
    heroCands[0] ||
    nextAfterAnchor ||
    null;
  const pickIsTonight = !anchorDay && !!pick && heroCands.includes(pick);

  return (
    <>
      <AppShell
        height="auto"
        contentPadding={0}
        topNav={
          <TopBar
            locName={loc.name}
            away={away}
            home={home}
            awayLoc={lastAway}
            onSelectHome={backHome}
            onSelectAway={goAway}
            onOpenLocation={() => setLocOpen(true)}
            viewDate={viewDate}
            onViewDate={setViewDate}
          />
        }
      >
        <Layout contentWidth={960} padding={4} height="auto">
          <LayoutContent>
            <VStack gap={4}>
              <Grid columns={{ minWidth: 320, max: 2 }} gap={4} width="100%">
                <GridSpan columns="full">
                  <TonightHero
                    pick={pick}
                    score={pick ? scores[pick.id] : null}
                    isTonight={pickIsTonight}
                    viewDate={viewDate}
                    histCloud={histCloud}
                    histCloudLoading={histCloudLoading}
                  />
                </GridSpan>
                <AuroraPanel loc={loc} viewDate={viewDate} />
                <PassesPanel loc={loc} bundledTles={tles} fromDate={anchorDay} />
                <GridSpan columns="full">
                  <MoonPanel asOf={anchorDay} />
                </GridSpan>
                <GridSpan columns="full">
                  <EventFeed
                    events={events}
                    scores={scores}
                    loaded={loaded}
                    tier={tier}
                    setTier={setTier}
                    type={type}
                    setType={setType}
                    range={range}
                    setRange={setRange}
                    anchor={anchorDay}
                  />
                </GridSpan>
                <GridSpan columns="full">
                  <DarkSkySpots spots={spots} loc={loc} away={away} />
                </GridSpan>
                <GridSpan columns="full">
                  <Glossary />
                </GridSpan>
              </Grid>
              <VStack gap={1} hAlign="center">
                <Text type="supporting" justify="center">
                  In memory of <strong>Jack Horkheimer</strong> (1938–2010), whose five minutes on
                  PBS taught a generation to <em>keep looking up</em>.
                </Text>
                {sources && (
                  <Text type="supporting" justify="center">
                    {sources}
                  </Text>
                )}
              </VStack>
            </VStack>
          </LayoutContent>
        </Layout>
      </AppShell>
      <LocationDialog
        open={locOpen}
        onOpenChange={setLocOpen}
        loc={loc}
        home={home}
        onPick={applyLoc}
        onBackHome={backHome}
        onSetHome={setHomeHere}
      />
    </>
  );
}
