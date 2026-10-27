import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '@astryxdesign/core/AppShell';
import { Layout } from '@astryxdesign/core/Layout';
import { LayoutContent } from '@astryxdesign/core/Layout';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Grid, GridSpan } from '@astryxdesign/core/Grid';
import { Text } from '@astryxdesign/core/Text';
import { Link } from '@astryxdesign/core/Link';
import { Icon } from '@astryxdesign/core/Icon';
import { Code } from 'lucide-react';
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
  setDisplayTimeZone,
  resolveLocTimeZone,
  normalizeEvents,
  isFaintLunar,
  goScore,
  estimatedGoScore,
  loadCloudClimatology,
  startOfDay,
  planetVisibility,
  matchDarkSkySite,
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
  // Display timezone follows the viewed location (Alex,
  // 2026-10-27): clock times render in the location's own
  // timezone, not the viewer's. Locations picked from search
  // carry a tz; older saves get theirs resolved once from
  // coordinates and persisted with the location. The tick
  // state exists only to re-render once the tz lands.
  // NOTE: this effect must stay BELOW the state declarations
  // it depends on — its deps array is evaluated during render,
  // and referencing lastAway above its useState crashed the
  // app at load with a TDZ ReferenceError (2026-10-27).
  const [, setDisplayTzTick] = useState(0);
  useEffect(() => {
    if (loc?.tz) {
      setDisplayTimeZone(loc.tz);
      setDisplayTzTick((n) => n + 1);
      return;
    }
    setDisplayTimeZone(null);
    setDisplayTzTick((n) => n + 1);
    if (!loc || loc.lat == null) return;
    let cancelled = false;
    resolveLocTimeZone(loc).then((tz) => {
      if (cancelled || !tz) return;
      const withTz = { ...loc, tz };
      setLoc(withTz);
      saveLoc(withTz);
      if (!isAway(withTz, home)) {
        setHome(withTz);
        saveHome(withTz);
      }
      if (lastAway && lastAway.lat === loc.lat && lastAway.lon === loc.lon) {
        setLastAway(withTz);
        saveLastAway(withTz);
      }
    });
    return () => { cancelled = true; };
  }, [loc, home, lastAway]);
  const [tier, setTier] = useState('all');
  // The Type menu is a checkbox list now: event types the
  // user has unchecked. Empty = all types shown (the
  // default), matching the old type === 'all'.
  const [hiddenTypes, setHiddenTypes] = useState(() => new Set());
  const [range, setRange] = useState('all');
  // Faint (penumbral) lunar eclipses are hidden by default —
  // a subtle smudge, not worth list space next to totals;
  // the feed's filter bar can show them again.
  const [showFaint, setShowFaint] = useState(false);
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
  /* One nightly planet-visibility computation for the viewing date, shared
     by the hero and every planet event card (each picks out its own planets). */
  const [planetRows, setPlanetRows] = useState(null);
  const planetWx = useRef({});
  const visWhen = anchorDay ? 'that night' : 'tonight';
  useEffect(() => {
    let cancelled = false;
    setPlanetRows(null);
    planetWx.current = {};
    const t = setTimeout(async () => {
      const r = await planetVisibility(anchorDay || new Date(), loc, planetWx.current);
      if (!cancelled) setPlanetRows(r);
    }, 30);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [loc, anchorDay]);

  const away = isAway(loc, home);

  /* ---- data boot ---- */
  useEffect(() => {
    // Kick the 20-year climatology fetch NOW, in parallel with
    // everything else (Alex, 2026-10-26: on first load it used
    // to start only after the events arrived and then block the
    // scoring pipeline — the hero's number waited on the
    // slowest archive request Open-Meteo serves). The promise
    // is cached inside loadCloudClimatology, so later callers
    // share this fetch. The location a mid-session change picks
    // fetches its own, on demand, as before.
    loadCloudClimatology(loc).catch(() => {});
    (async () => {
      const [showers, eclipses, conjs, comets, spotsData, man] = await Promise.all([
        loadJSON(`${base}data/showers.json`),
        loadJSON(`${base}data/eclipses.json`),
        loadJSON(`${base}data/conjunctions.json`),
        loadJSON(`${base}data/comets.json`),
        loadJSON(`${base}data/darksky.json`),
        loadJSON(`${base}data/_manifest.json`),
      ]);
      setEvents(normalizeEvents(showers, eclipses, conjs, comets));
      setSpots(spotsData?.sites || []);
      if (man?.sources) setSources('Data: ' + man.sources.join(' · '));
      setLoaded(true);
    })();
    // Satellite elements are NOT part of the boot gate: only
    // the flyovers panel needs them, and it already shows its
    // own computing state. The Lambda round trip (cold starts
    // can run seconds) used to hold the events — and the hero —
    // hostage on every first load.
    loadTles(`${base}data/tles.json`).then((t) => setTles(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      /* Start the climatology fetch but do NOT await it yet:
         the forecast scores below are what the hero is usually
         waiting on, and they used to queue behind a 20-year
         archive download they never use (Alex, 2026-10-26).
         Estimates (events beyond the forecast range) are pure
         math once the archive lands, so they apply last — the
         two sets are disjoint (>15d vs <=15d), so applying in
         this order changes no result. */
      const climPromise = loadCloudClimatology(loc).catch(() => null);
      /* Forecast scores for the hero candidates (existing behavior). */
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
      /* Estimated scores for everything beyond the forecast
         range, pure math once the archive data is in. */
      const climDaily = await climPromise;
      if (cancelled || !climDaily) return;
      const est = {};
      for (const e of events) {
        if ((e.date - Date.now()) / DAY > 15) {
          const sc = estimatedGoScore(e, climDaily, loc);
          if (sc) est[e.id] = sc;
        }
      }
      if (!cancelled) setScores((prev) => ({ ...est, ...prev }));
    })();
    return () => {
      cancelled = true;
    };
  }, [events, loc, anchorDay]);

  /* ---- location ---- */
  const applyLoc = useCallback(
    (next) => {
      let loc = next;
      // A searched or map-picked place near a certified dark-sky destination
      // inherits its published Bortle rating instead of the grid estimate.
      if (!next.bortle && typeof next.lat === 'number' && spots.length) {
        const site = matchDarkSkySite(next.lat, next.lon, next.name, spots);
        if (site) {
          loc = { ...next, bortle: site.bortle, bortleSource: site.bortle_source };
        }
      }
      setLoc(loc);
      saveLoc(loc);
      if (isAway(loc, home)) {
        saveLastAway(loc);
        setLastAway({ ...loc });
      }
      setLocOpen(false);
    },
    [home, spots],
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

  /* The list the hero and the feed both draw from: faint
     lunar eclipses removed unless the user asked for them. */
  const feedEvents = showFaint ? events : events.filter((e) => !isFaintLunar(e));

  /* ---- hero pick ----
     Today: soonest events as before. Fast-forwarded: the best-scoring event
     in the 3-day window starting on the viewing date — or, when that window
     is empty, the next event on/after the viewing date (mirroring Today's
     fallback to the next upcoming event). */
  const heroCands = (() => {
    if (!anchorDay) {
      const nowMs = Date.now();
      return feedEvents.filter((e) => e.date - nowMs < 60 * 3600000 && e.date - nowMs > -6 * 3600000);
    }
    const start = anchorDay.getTime();
    const end = start + 3 * DAY;
    return feedEvents.filter((e) => {
      const t = e.date instanceof Date ? e.date.getTime() : new Date(e.date).getTime();
      return t >= start && t < end;
    });
  })();
  // Next event on/after the viewing date (events are future-filtered and
  // date-sorted). For Today this is just events[0], as before.
  const nextAfterAnchor = (() => {
    if (!anchorDay) return feedEvents[0];
    const start = anchorDay.getTime();
    return feedEvents.find((e) => {
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
  // "Tonight's sky" only when the pick's own night is the night in
  // progress: its date is today, or yesterday's date in the small hours
  // before dawn. Membership in heroCands is NOT the test — that pool
  // reaches 60 hours out, so a Wednesday shower picked on Monday was
  // getting labeled "Tonight's sky". Anything further out is "Coming up".
  const pickIsTonight = (() => {
    if (anchorDay || !pick) return false;
    const now = new Date();
    const todayStart = startOfDay(now).getTime();
    const pickDay = startOfDay(pick.date).getTime();
    if (pickDay === todayStart) return true;
    return pickDay === todayStart - DAY && now.getTime() < todayStart + 6 * 3600000;
  })();

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
                    loc={loc}
                    planetRows={planetRows}
                    visWhen={visWhen}
                  />
                </GridSpan>
                <AuroraPanel loc={loc} viewDate={viewDate} />
                <PassesPanel loc={loc} bundledTles={tles} fromDate={anchorDay} />
                <GridSpan columns="full">
                  <MoonPanel asOf={anchorDay} loc={loc} />
                </GridSpan>
                <GridSpan columns="full">
                  <EventFeed
                    events={feedEvents}
                    scores={scores}
                    loaded={loaded}
                    tier={tier}
                    setTier={setTier}
                    hiddenTypes={hiddenTypes}
                    setHiddenTypes={setHiddenTypes}
                    range={range}
                    setRange={setRange}
                    showFaint={showFaint}
                    setShowFaint={setShowFaint}
                    anchor={anchorDay}
                    loc={loc}
                    planetRows={planetRows}
                    visWhen={visWhen}
                  />
                </GridSpan>
                <GridSpan columns="full">
                  <DarkSkySpots spots={spots} loc={loc} away={away} onPickLocation={applyLoc} />
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
                <HStack gap={1} vAlign="center" hAlign="center">
                  <Icon icon={Code} size="sm" color="secondary" />
                  <Link
                    href="https://github.com/nynexman4464/stargazer"
                    target="_blank"
                  >
                    Stargazer on GitHub
                  </Link>
                </HStack>
                <Text type="supporting" justify="center">
                  Build {__GIT_SHA__} ·{' '}
                  {new Date(__BUILD_TIME__).toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    timeZone: 'America/New_York',
                  })}
                </Text>
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
