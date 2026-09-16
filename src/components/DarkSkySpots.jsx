import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Text';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Token } from '@astryxdesign/core/Token';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { haversine } from '../lib/astro.js';

const BORTLE_EXPLAINER =
  'Bortle scale: 1 = pristine dark sky, 9 = inner city. Lower is darker.';

/* New England dark-sky picks, nearest first, with sourced Bortle ratings. */
export default function DarkSkySpots({ spots, loc, away }) {
  const withDist = spots
    .map((s) => ({ ...s, dist: haversine(loc.lat, loc.lon, s.lat, s.lon) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 6);

  return (
    <section aria-label="Dark-sky drives">
      <VStack gap={2}>
        <VStack gap={1}>
          <Heading level={2}>Dark-sky drives</Heading>
          <Text type="supporting">
            Bortle ratings are published values where they exist, estimates otherwise — hover a
            rating for its source.
          </Text>
          {away && (
            <Text type="supporting">
              You're away from home — these are our New England dark-sky picks, shown by distance
              from where you are now.
            </Text>
          )}
        </VStack>
        {!spots.length ? (
          <VStack gap={2}>
            <Skeleton height={64} />
            <Skeleton height={64} />
          </VStack>
        ) : (
          <VStack gap={2}>
            {withDist.map((s) => (
              <Card key={s.name} padding={3}>
                <HStack gap={3} vAlign="center" hAlign="between">
                  <VStack gap={1}>
                    <Text weight="semibold">{s.name}</Text>
                    {s.highlights && <Text type="supporting">{s.highlights}</Text>}
                    {s.access && (
                      <Text type="supporting">Parking: {s.access}</Text>
                    )}
                  </VStack>
                  <VStack gap={1} hAlign="end">
                    <Tooltip content={s.bortle_source || BORTLE_EXPLAINER}>
                      <Token label={`Bortle ${s.bortle || '~?'}`} color="blue" />
                    </Tooltip>
                    <Text type="supporting" hasTabularNumbers>
                      {away
                        ? `${Math.round(s.dist)} mi from you`
                        : s.drive_from_medford
                          ? `~${s.drive_from_medford} from home`
                          : `${Math.round(s.dist)} mi`}
                    </Text>
                  </VStack>
                </HStack>
              </Card>
            ))}
          </VStack>
        )}
      </VStack>
    </section>
  );
}
