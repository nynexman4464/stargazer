import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Text';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Grid } from '@astryxdesign/core/Grid';
import { Token } from '@astryxdesign/core/Token';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Icon } from '@astryxdesign/core/Icon';
import { House, Car, Plane, Sparkles, Eclipse, Orbit, Star, Cloud, CloudOff, Moon } from 'lucide-react';
import Starfield from './Starfield.jsx';
import { TIER_META, TYPE_META, fmtDate, countdown, moonIllum, moonName } from '../lib/astro.js';

const TIER_ICON = { backyard: House, drive: Car, expedition: Plane };
const TIER_COLOR = { backyard: 'green', drive: 'orange', expedition: 'red' };
const TYPE_ICON = { shower: Sparkles, eclipse: Eclipse, planet: Orbit, comet: Star };
const FACTOR_ICON = { cloud: Cloud, cloudOff: CloudOff, moon: Moon };

function scoreVariant(label) {
  return label === 'Go' ? 'success' : label === 'Maybe' ? 'warning' : 'error';
}

export default function TonightHero({ pick, score }) {
  return (
    <section aria-label="Tonight's sky">
      <VStack gap={2}>
        <Text type="label" color="accent">
          Tonight's sky
        </Text>
        <Card className="sg-hero" padding={4}>
          <Starfield />
          <VStack gap={3} className="sg-hero-content">
            {!pick ? (
              <VStack gap={2}>
                <Skeleton height={24} width="60%" />
                <Skeleton height={16} width="90%" />
                <Skeleton height={16} width="75%" />
              </VStack>
            ) : (
              <>
                <HStack gap={2}>
                  <Token
                    label={TIER_META[pick.tier]?.label || pick.tier}
                    color={TIER_COLOR[pick.tier] || 'default'}
                    icon={<Icon icon={TIER_ICON[pick.tier] || House} size="sm" />}
                  />
                  <Token
                    label={TYPE_META[pick.type]?.label || pick.type}
                    icon={<Icon icon={TYPE_ICON[pick.type]} size="sm" />}
                  />
                </HStack>
                <Heading level={1} type="display-2">
                  {pick.title}
                </Heading>
                <Text color="secondary">{pick.desc}</Text>
                <Grid columns={{ minWidth: 220 }} gap={3}>
                  <VStack gap={1}>
                    <Text type="label" color="secondary">
                      When
                    </Text>
                    <Text weight="semibold">
                      {fmtDate(pick.date)} · {countdown(pick.date)}
                    </Text>
                    <Text type="supporting">
                      Moon tonight: {Math.round(moonIllum(new Date()) * 100)}%{' '}
                      {moonName(moonIllum(new Date()))}
                    </Text>
                  </VStack>
                  <VStack gap={1}>
                    <Text type="label" color="secondary">
                      Go score
                    </Text>
                    {score ? (
                      <ProgressBar
                        label="Go score"
                        value={score.score}
                        hasValueLabel
                        variant={scoreVariant(score.label)}
                      />
                    ) : (
                      <Text type="supporting">Scoring the sky…</Text>
                    )}
                  </VStack>
                  <VStack gap={1}>
                    <Text type="label" color="secondary">
                      Conditions
                    </Text>
                    {score ? (
                      <VStack gap={1}>
                        {score.factors.map((f, i) => (
                          <HStack key={i} gap={1} vAlign="center">
                            <Icon icon={FACTOR_ICON[f.icon] || Cloud} size="sm" color="secondary" />
                            <Text type="supporting">{f.text}</Text>
                          </HStack>
                        ))}
                      </VStack>
                    ) : (
                      <Text type="supporting">—</Text>
                    )}
                  </VStack>
                </Grid>
              </>
            )}
          </VStack>
        </Card>
      </VStack>
    </section>
  );
}
