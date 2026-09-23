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
import { House, Car, Plane, Sparkles, Eclipse, Orbit, Star } from 'lucide-react';
import ScoreFactors from './ScoreFactors.jsx';
import Starfield from './Starfield.jsx';
import { TermText } from './Term.jsx';
import { TIER_META, TYPE_META, DAY, fmtDate, countdown, moonIllum, moonName, eventImage, eclipseVisibleFrom, planetVisibilityFactors } from '../lib/astro.js';

const TIER_ICON = { backyard: House, drive: Car, expedition: Plane };
const TIER_COLOR = { backyard: 'green', drive: 'orange', expedition: 'red' };
const TYPE_ICON = { shower: Sparkles, eclipse: Eclipse, planet: Orbit, comet: Star };

function scoreVariant(label) {
  return label === 'Go' ? 'success' : label === 'Maybe' ? 'warning' : 'error';
}

export default function TonightHero({ pick, score, isTonight, viewDate, loc, planetRows, visWhen }) {
  const notVisible =
    pick && pick.tier === 'expedition' && !eclipseVisibleFrom(pick, loc);
  // Tonight's (viewing date's) visibility for the pick's planets — the go
  // score above is for the event night, this is for the night in progress.
  const visFactors = pick && pick.type === 'planet'
    ? planetVisibilityFactors(planetRows, pick.bodies, visWhen)
    : null;
  // Everything in this card refers to the pick's own date — never mix
  // tonight's moon/conditions with a future event's. The full current-moon
  // picture lives in the Moon panel below.
  const moon = pick ? moonIllum(pick.date) : 0;
  const img = pick ? eventImage(pick) : null;
  const kicker = viewDate ? `Viewing · ${fmtDate(viewDate)}` : isTonight ? "Tonight's sky" : 'Coming up';
  const beyondForecast = !!pick && (pick.date - Date.now()) / DAY > 15;
  return (
    <Card className="sg-hero" padding={4}>
      <VStack gap={3}>
        <Text type="label" color="accent">
          {kicker}
        </Text>
        <Starfield />
        <VStack gap={3} className="sg-hero-content">
            {!pick ? (
              viewDate ? (
                <VStack gap={2}>
                  <Heading level={1} type="display-2">
                    Quiet skies
                  </Heading>
                  <Text color="secondary">
                    Nothing in the catalog for {fmtDate(viewDate)} through{' '}
                    {fmtDate(new Date(viewDate.getTime() + 2 * DAY))}. The feed
                    below still lists everything coming up — or pick another date.
                  </Text>
                </VStack>
              ) : (
                <VStack gap={2}>
                  <Skeleton height={24} width="60%" />
                  <Skeleton height={16} width="90%" />
                  <Skeleton height={16} width="75%" />
                </VStack>
              )
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
                <HStack gap={3} vAlign="center">
                  {img && <img src={img} alt="" className="sg-hero-img" />}
                  <VStack gap={0} style={{ minWidth: 0 }}>
                    <Heading level={1} type="display-2">
                      <TermText text={pick.title} exclude={pick.bodies} />
                    </Heading>
                  </VStack>
                </HStack>
                <Text color="secondary"><TermText text={pick.desc} exclude={pick.bodies} /></Text>
                <Grid columns={{ minWidth: 220 }} gap={3}>
                  <VStack gap={1}>
                    <Text type="label" color="secondary">
                      When
                    </Text>
                    <Text weight="semibold">
                      {fmtDate(pick.date)} · {countdown(pick.date)}
                    </Text>
                    <Text type="supporting">
                      Moon that night: {Math.round(moon * 100)}% {moonName(moon)}
                    </Text>
                  </VStack>
                  <VStack gap={3}>
                    <VStack gap={1}>
                      <Text type="label" color="secondary">
                        {score?.estimated ? 'Est. go score' : 'Go score'}
                      </Text>
                      {score ? (
                        <VStack gap={1}>
                          <ProgressBar
                            value={score.score}
                            hasValueLabel
                            variant={scoreVariant(score.label)}
                          />
                        </VStack>
                      ) : notVisible ? (
                        <Text type="supporting">
                          Not visible from {loc?.name || 'your location'} — worth traveling for.
                        </Text>
                      ) : beyondForecast ? (
                        <Text type="supporting">Too far out — forecasts only reach about two weeks.</Text>
                      ) : (
                        <Text type="supporting">Scoring the sky…</Text>
                      )}
                    </VStack>
                    <VStack gap={1}>
                      <Text type="label" color="secondary">
                        Conditions
                      </Text>
                      {score ? (
                        <ScoreFactors factors={score.factors} exclude={pick.bodies} />
                      ) : (
                        <Text type="supporting">—</Text>
                      )}
                    </VStack>
                  </VStack>
                </Grid>
                {visFactors && (
                  <VStack gap={1}>
                    <Text type="label" color="secondary">
                      Visibility {visWhen}
                    </Text>
                    <ScoreFactors factors={visFactors} exclude={pick.bodies} />
                  </VStack>
                )}
              </>
            )}
          </VStack>
      </VStack>
    </Card>
  );
}
