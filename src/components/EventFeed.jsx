import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Text';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Grid } from '@astryxdesign/core/Grid';
import { Token } from '@astryxdesign/core/Token';
import { SegmentedControl } from '@astryxdesign/core/SegmentedControl';
import { SegmentedControlItem } from '@astryxdesign/core/SegmentedControl';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Icon } from '@astryxdesign/core/Icon';
import { House, Car, Plane, Sparkles, Eclipse, Orbit, Star, Cloud, CloudOff, Moon, Telescope } from 'lucide-react';
import { TIER_META, TYPE_META, fmtDate, countdown, DAY } from '../lib/astro.js';

const TIER_ICON = { backyard: House, drive: Car, expedition: Plane };
const TIER_COLOR = { backyard: 'green', drive: 'orange', expedition: 'red' };
const TYPE_ICON = { shower: Sparkles, eclipse: Eclipse, planet: Orbit, comet: Star };
const FACTOR_ICON = { cloud: Cloud, cloudOff: CloudOff, moon: Moon };

function scoreVariant(label) {
  return label === 'Go' ? 'success' : label === 'Maybe' ? 'warning' : 'error';
}

function EventCard({ ev, score }) {
  const dateStr =
    ev.end && ev.end - ev.date > 2 * DAY
      ? `${fmtDate(ev.date)} – ${fmtDate(ev.end)}`
      : fmtDate(ev.date);
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
        <Text weight="semibold">
          {dateStr} <Text type="supporting" weight="normal">{countdown(ev.date)}</Text>
        </Text>
        <Text type="large" weight="semibold">
          {ev.title}
        </Text>
        <Text type="supporting">{ev.desc}</Text>
        {score ? (
          <VStack gap={1}>
            <ProgressBar
              label={`Go score for ${ev.title}`}
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
        ) : (
          <Text type="supporting">Beyond the 15-day forecast — tier says it all.</Text>
        )}
      </VStack>
  );
}

export default function EventFeed({ events, scores, loaded, tier, setTier, type, setType }) {
  const counts = {};
  events.forEach((e) => {
    if (tier === 'all' || e.tier === tier) counts[e.type] = (counts[e.type] || 0) + 1;
  });
  const types = Object.keys(TYPE_META).filter((t) => counts[t]);
  const list = events.filter(
    (e) => (tier === 'all' || e.tier === tier) && (type === 'all' || e.type === type),
  );

  return (
    <Card padding={4}>
      <VStack gap={3}>
        <Heading level={2}>Upcoming events</Heading>
        <SegmentedControl
          value={tier}
          onChange={(v) => {
            setTier(v);
            setType('all');
          }}
          label="Filter by trip tier"
          layout="fill"
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
        <SegmentedControl value={type} onChange={setType} label="Filter by event type" layout="fill">
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
          <Grid columns={{ minWidth: 300 }} gap={3}>
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
          <Grid columns={{ minWidth: 300 }} gap={3}>
            {list.map((e) => (
              <EventCard key={e.id} ev={e} score={scores[e.id]} />
            ))}
          </Grid>
        )}
      </VStack>
    </Card>
  );
}
