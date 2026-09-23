import { useEffect, useRef, useState } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Text';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Grid } from '@astryxdesign/core/Grid';
import { Token } from '@astryxdesign/core/Token';
import { Button } from '@astryxdesign/core/Button';
import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@astryxdesign/core/DropdownMenu';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Icon } from '@astryxdesign/core/Icon';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { House, Car, Plane, Sparkles, Eclipse, Orbit, Star, Telescope, Map, CalendarDays, Maximize2 } from 'lucide-react';
import { TIER_META, TYPE_META, RANGE_META, inTimeRange, fmtDate, fmtTime, countdown, compass, DAY, eventImage, eclipseVisibleFrom, planetVisibility } from '../lib/astro.js';
import MapLightbox from './MapLightbox.jsx';
import ScoreFactors from './ScoreFactors.jsx';
import { TermText } from './Term.jsx';

const TIER_ICON = { backyard: House, drive: Car, expedition: Plane };
const TIER_COLOR = { backyard: 'green', drive: 'orange', expedition: 'red' };
const TYPE_ICON = { shower: Sparkles, eclipse: Eclipse, planet: Orbit, comet: Star };

function scoreVariant(label) {
  return label === 'Go' ? 'success' : label === 'Maybe' ? 'warning' : 'error';
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function EventCard({ ev, score, loc, planetRows, visWhen }) {
  const [mapOpen, setMapOpen] = useState(false);
  const [lightbox, setLightbox] = useState(false);
  const notVisible = ev.tier === 'expedition' && !eclipseVisibleFrom(ev, loc);
  /* Tonight's (viewing date's) visibility for this card's planets, integrated
     as factor rows: best time, where to look, and the 0-100 visibility score. */
  let visFactors = null;
  if (ev.type === 'planet' && planetRows) {
    const byName = Object.fromEntries(planetRows.map((r) => [r.name, r]));
    visFactors = (ev.bodies || [])
      .map((b) => b.toLowerCase())
      .filter((n) => byName[n])
      .map((n) => {
        const r = byName[n];
        const detail = r.best
          ? `best ${fmtTime(r.best.time)}, look ${compass(r.best.az)}, ${Math.round(r.best.alt)}° up`
          : r.altNote;
        return {
          icon: r.mag <= 6 ? 'eye' : 'telescope',
          text: `${cap(n)} visibility ${r.score} (${r.label}) ${visWhen} — ${detail}`,
        };
      });
    if (visFactors.length === 0) visFactors = null;
  }
  const mapCaption = ev.solar
    ? 'Dark band: where the total or annular eclipse is visible. Map: NASA.'
    : 'White area: where the eclipse is visible. Map: NASA.';
  const dateStr =
    ev.end && ev.end - ev.date > 2 * DAY
      ? `${fmtDate(ev.date)} – ${fmtDate(ev.end)}`
      : fmtDate(ev.date);
  const img = eventImage(ev);
  return (
    <VStack gap={2}>
      <HStack gap={2}>
        <Token
            label={TIER_META[ev.tier]?.label || ev.tier}
            color={TIER_COLOR[ev.tier] || 'default'}
            size="sm"
            icon={<Icon icon={TIER_ICON[ev.tier] || House} size="sm" />}
          />
          <Token
            label={TYPE_META[ev.type]?.label || ev.type}
            size="sm"
            icon={<Icon icon={TYPE_ICON[ev.type]} size="sm" />}
          />
        </HStack>
        <HStack gap={3} vAlign="center">
          {img && <img src={img} alt="" loading="lazy" className="sg-event-thumb" />}
          <VStack gap={1}>
            <Text weight="semibold">
              {dateStr} <Text type="supporting" weight="normal">{countdown(ev.date)}</Text>
            </Text>
            <Text type="large" weight="semibold">
              <TermText text={ev.title} exclude={ev.bodies} />
            </Text>
          </VStack>
        </HStack>
        <Text type="supporting"><TermText text={ev.desc} exclude={ev.bodies} /></Text>
        {ev.type === 'eclipse' && ev.map && (
          <VStack gap={2}>
            <HStack>
              <Button
                variant="ghost"
                size="sm"
                label={mapOpen ? 'Hide path map' : 'Show path map'}
                icon={<Icon icon={Map} size="sm" />}
                onClick={() => setMapOpen((v) => !v)}
              />
            </HStack>
            {mapOpen && (
              <VStack gap={1}>
                <div
                  className="sg-map-thumb"
                  onClick={() => setLightbox(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setLightbox(true);
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={`Enlarge eclipse path map for ${ev.title}`}
                >
                  <img
                    src={ev.map}
                    alt={`NASA eclipse path map for ${ev.title}`}
                    loading="lazy"
                    draggable={false}
                    className="sg-eclipse-map"
                  />
                  <span className="sg-map-thumb-badge" aria-hidden="true">
                    <Icon icon={Maximize2} size="sm" color="secondary" />
                  </span>
                </div>
                <Text type="supporting">{mapCaption}</Text>
              </VStack>
            )}
          </VStack>
        )}
        {ev.type === 'eclipse' && ev.map && (
          <MapLightbox
            src={ev.map}
            alt={`NASA eclipse path map for ${ev.title}`}
            caption={mapCaption}
            isOpen={lightbox}
            onClose={() => setLightbox(false)}
          />
        )}
        {score && (
          <VStack gap={1}>
            <ProgressBar
              label={score.estimated ? 'Est. go score' : 'Go score'}
              value={score.score}
              hasValueLabel
              variant={scoreVariant(score.label)}
            />
            <ScoreFactors factors={score.factors} exclude={ev.bodies} />
          </VStack>
        )}
        {visFactors && <ScoreFactors factors={visFactors} exclude={ev.bodies} />}
        {!score && notVisible && (
          <Text type="supporting">
            Not visible from {loc?.name || 'your location'} — worth traveling for.
          </Text>
        )}
      </VStack>
  );
}

export default function EventFeed({ events, scores, loaded, tier, setTier, type, setType, range, setRange, anchor, loc }) {
  // Responsive contract: below 640px the filter bar wraps onto multiple lines
  // and the event cards stack in a single column.
  const isNarrow = useMediaQuery('(max-width: 640px)');
  const inScope = (e) =>
    (tier === 'all' || e.tier === tier) && inTimeRange(e, range, anchor);
  const counts = {};
  events.forEach((e) => {
    if (inScope(e)) counts[e.type] = (counts[e.type] || 0) + 1;
  });
  const types = Object.keys(TYPE_META).filter((t) => counts[t]);
  const list = events.filter(
    (e) => inScope(e) && (type === 'all' || e.type === type),
  );
  // The feed shows the first page of cards; "Load more" reveals the rest.
  // Reset to the first page whenever the filters (or viewing date) change.
  const PAGE_SIZE = 20;
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [prevAnchor, setPrevAnchor] = useState(anchor);
  if (prevAnchor !== anchor) {
    setPrevAnchor(anchor);
    setVisible(PAGE_SIZE);
  }
  const shown = list.slice(0, visible);
  const remaining = list.length - shown.length;
  const pickTier = (v) => {
    setTier(v);
    setType('all');
    setVisible(PAGE_SIZE);
  };
  const pickType = (v) => {
    setType(v);
    setVisible(PAGE_SIZE);
  };
  const pickRange = (v) => {
    setRange(v);
    setVisible(PAGE_SIZE);
  };
  const resetFilters = () => {
    setTier('all');
    setType('all');
    setRange('all');
    setVisible(PAGE_SIZE);
  };
  const isFiltered = tier !== 'all' || type !== 'all' || range !== 'all';

  /* One nightly planet-visibility computation for the viewing date, shared by
     every planet event card below (each card picks out its own planets). */
  const [planetRows, setPlanetRows] = useState(null);
  const planetWx = useRef({});
  useEffect(() => {
    let cancelled = false;
    setPlanetRows(null);
    planetWx.current = {};
    const t = setTimeout(async () => {
      const r = await planetVisibility(anchor || new Date(), loc, planetWx.current);
      if (!cancelled) setPlanetRows(r);
    }, 30);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [loc, anchor]);
  const visWhen = anchor ? 'that night' : 'tonight';

  // Filter bar: one compact row of dropdown clauses (tier / when / type) plus
  // the result count and a reset, instead of three full-width segmented rows.
  const filterBar = (
    <HStack gap={2} vAlign="center" wrap="wrap">
      <DropdownMenu
        presentation="adaptive"
        hasChevron
        button={{
          variant: 'secondary',
          size: 'sm',
          label: tier === 'all' ? 'All tiers' : TIER_META[tier].label,
          icon: <Icon icon={TIER_ICON[tier] || Telescope} size="sm" />,
          'aria-label': 'Filter by trip tier',
        }}
      >
        <DropdownMenuRadioGroup label="Trip tier" value={tier} onChange={pickTier}>
          <DropdownMenuRadioItem value="all" label="All tiers" icon={Telescope} />
          {Object.entries(TIER_META).map(([k, m]) => (
            <DropdownMenuRadioItem
              key={k}
              value={k}
              label={m.label}
              description={m.blurb}
              icon={TIER_ICON[k]}
            />
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenu>
      <DropdownMenu
        presentation="adaptive"
        hasChevron
        button={{
          variant: 'secondary',
          size: 'sm',
          label: range === 'all' ? 'All time' : RANGE_META[range].label,
          icon: <Icon icon={CalendarDays} size="sm" />,
          'aria-label': 'Filter by time range',
        }}
      >
        <DropdownMenuRadioGroup label="Time range" value={range} onChange={pickRange}>
          {Object.entries(RANGE_META).map(([k, m]) => (
            <DropdownMenuRadioItem
              key={k}
              value={k}
              label={k === 'all' ? 'All time' : m.label}
              description={m.blurb}
            />
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenu>
      <DropdownMenu
        presentation="adaptive"
        hasChevron
        button={{
          variant: 'secondary',
          size: 'sm',
          label: type === 'all' ? 'All types' : TYPE_META[type].label,
          icon: <Icon icon={TYPE_ICON[type] || Sparkles} size="sm" />,
          'aria-label': 'Filter by event type',
        }}
      >
        <DropdownMenuRadioGroup label="Event type" value={type} onChange={pickType}>
          <DropdownMenuRadioItem value="all" label="All types" icon={Sparkles} />
          {types.map((t) => (
            <DropdownMenuRadioItem
              key={t}
              value={t}
              label={TYPE_META[t].label}
              description={`${counts[t]} event${counts[t] === 1 ? '' : 's'}`}
              icon={TYPE_ICON[t]}
            />
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenu>
      <Text type="supporting">
        {list.length} event{list.length === 1 ? '' : 's'}
      </Text>
      {isFiltered && (
        <Button variant="ghost" size="sm" label="Reset" onClick={resetFilters} />
      )}
    </HStack>
  );

  // minWidth: 0 lets this Card (a grid item) shrink below its content's
  // intrinsic width on narrow screens.
  return (
    <Card padding={4} style={{ minWidth: 0 }}>
      <VStack gap={3}>
        <Heading level={2}>{anchor ? `Events · from ${fmtDate(anchor)}` : 'Upcoming events'}</Heading>
        {filterBar}
        {!loaded ? (
          <Grid columns={isNarrow ? 1 : { minWidth: 300 }} gap={3}>
            {[0, 1, 2].map((i) => (
              <VStack key={i} gap={2}>
                <Skeleton height={20} width="70%" />
                <Skeleton height={16} width="95%" />
                <Skeleton height={16} width="80%" />
              </VStack>
            ))}
          </Grid>
        ) : list.length === 0 ? (
          <EmptyState
            title="No events match these filters"
            description="The universe is vast — try widening the net."
            icon={<Icon icon={Telescope} size="lg" color="secondary" />}
          />
        ) : (
          <VStack gap={3}>
            <Grid columns={isNarrow ? 1 : { minWidth: 300 }} gap={3}>
              {shown.map((e) => (
                <EventCard key={e.id} ev={e} score={scores[e.id]} loc={loc} planetRows={planetRows} visWhen={visWhen} />
              ))}
            </Grid>
            {remaining > 0 && (
              <HStack justify="center">
                <Button
                  label={`Load more (${remaining} remaining)`}
                  onClick={() => setVisible((v) => v + PAGE_SIZE)}
                />
              </HStack>
            )}
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
