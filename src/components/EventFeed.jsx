import { useState } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Text';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Grid } from '@astryxdesign/core/Grid';
import { Token } from '@astryxdesign/core/Token';
import { Button } from '@astryxdesign/core/Button';
import { SegmentedControl } from '@astryxdesign/core/SegmentedControl';
import { SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Icon } from '@astryxdesign/core/Icon';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { House, Car, Plane, Sparkles, Eclipse, Orbit, Star, Cloud, CloudOff, Moon, Telescope, Map } from 'lucide-react';
import { TIER_META, TYPE_META, RANGE_META, inTimeRange, fmtDate, countdown, DAY, eventImage } from '../lib/astro.js';

const TIER_ICON = { backyard: House, drive: Car, expedition: Plane };
const TIER_COLOR = { backyard: 'green', drive: 'orange', expedition: 'red' };
const TYPE_ICON = { shower: Sparkles, eclipse: Eclipse, planet: Orbit, comet: Star };
const FACTOR_ICON = { cloud: Cloud, cloudOff: CloudOff, moon: Moon };

function scoreVariant(label) {
  return label === 'Go' ? 'success' : label === 'Maybe' ? 'warning' : 'error';
}

function EventCard({ ev, score }) {
  const [mapOpen, setMapOpen] = useState(false);
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
              {ev.title}
            </Text>
          </VStack>
        </HStack>
        <Text type="supporting">{ev.desc}</Text>
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
                <img src={ev.map} alt={`NASA eclipse path map for ${ev.title}`} loading="lazy" className="sg-eclipse-map" />
                <Text type="supporting">
                  {ev.solar
                    ? 'Dark band: where the total or annular eclipse is visible. Map: NASA.'
                    : 'White area: where the eclipse is visible. Map: NASA.'}
                </Text>
              </VStack>
            )}
          </VStack>
        )}
        {score && (
          <VStack gap={1}>
            <ProgressBar
              label="Go score"
              value={score.score}
              hasValueLabel
              variant={scoreVariant(score.label)}
            />
            <HStack gap={3}>
              {score.factors.map((f, i) => (
                <HStack key={i} gap={1} vAlign="center">
                  <Icon icon={FACTOR_ICON[f.icon] || Cloud} size="sm" color="secondary" />
                  <Text type="supporting">{f.text}</Text>
                </HStack>
              ))}
            </HStack>
          </VStack>
        )}
      </VStack>
  );
}

export default function EventFeed({ events, scores, loaded, tier, setTier, type, setType, range, setRange, anchor }) {
  // Responsive contract: below 640px the filter rows can't fit all segments,
  // so they hug content and scroll inside the card instead of forcing the page
  // wider; the event cards stack in a single column.
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

  // minWidth: 0 lets this Card (a grid item) shrink below its content's
  // intrinsic width on narrow screens; the filter rows scroll instead.
  return (
    <Card padding={4} style={{ minWidth: 0 }}>
      <VStack gap={3}>
        <Heading level={2}>{anchor ? `Events · from ${fmtDate(anchor)}` : 'Upcoming events'}</Heading>
        <SegmentedControl
          value={tier}
          onChange={pickTier}
          label="Filter by trip tier"
          layout={isNarrow ? undefined : 'fill'}
          style={isNarrow ? { overflowX: 'auto' } : undefined}
        >
          <SegmentedControlItem value="all" label="All" />
          {Object.entries(TIER_META).map(([k, m]) => (
            <SegmentedControlItem
              key={k}
              value={k}
              label={m.label}
              icon={<Icon icon={TIER_ICON[k]} size="sm" />}
            />
          ))}
        </SegmentedControl>
        <SegmentedControl
          value={range}
          onChange={pickRange}
          label="Filter by time range"
          layout={isNarrow ? undefined : 'fill'}
          style={isNarrow ? { overflowX: 'auto' } : undefined}
        >
          {Object.entries(RANGE_META).map(([k, m]) => (
            <SegmentedControlItem key={k} value={k} label={m.label} />
          ))}
        </SegmentedControl>
        <SegmentedControl
          value={type}
          onChange={pickType}
          label="Filter by event type"
          layout={isNarrow ? undefined : 'fill'}
          style={isNarrow ? { overflowX: 'auto' } : undefined}
        >
          <SegmentedControlItem value="all" label="All" />
          {types.map((t) => (
            <SegmentedControlItem
              key={t}
              value={t}
              label={`${TYPE_META[t].label} · ${counts[t]}`}
              icon={<Icon icon={TYPE_ICON[t]} size="sm" />}
            />
          ))}
        </SegmentedControl>
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
                <EventCard key={e.id} ev={e} score={scores[e.id]} />
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
