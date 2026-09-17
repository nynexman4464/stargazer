import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Text';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { Token } from '@astryxdesign/core/Token';
import { Tooltip } from '@astryxdesign/core/Tooltip';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { List, ListItem } from '@astryxdesign/core/List';
import { haversine } from '../lib/astro.js';
import DarkSkyMap from './DarkSkyMap.jsx';
import { Term } from './Term.jsx';

const BORTLE_EXPLAINER =
  'Bortle scale: 1 = pristine dark sky, 9 = inner city. Lower is darker.';

/* Nationwide certified dark-sky places, nearest first, with sourced Bortle ratings. */
export default function DarkSkySpots({ spots, loc, away }) {
  const withDist = spots
    .map((s) => ({ ...s, dist: haversine(loc.lat, loc.lon, s.lat, s.lon) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 6);

  return (
    <Card padding={4}>
      <VStack gap={3}>
        <VStack gap={1}>
          <Heading level={2}>Dark-sky drives</Heading>
          <Text type="supporting">
            <Term term="Bortle scale">Bortle</Term> ratings are published values where they exist, estimates otherwise — hover a
            rating for its source.
          </Text>
          {away && (
            <Text type="supporting">
              You're away from home — these are the nearest certified dark-sky places in the
              country, shown by distance from where you are now.
            </Text>
          )}
        </VStack>
        {spots.length > 0 && (
          <VStack gap={1}>
            <DarkSkyMap spots={withDist} loc={loc} />
            <Text type="supporting">
              Glow is city lights (NASA Black Marble) — the darker the area, the darker the
              sky. Blue dots are the drives below; the gold dot is you.
            </Text>
          </VStack>
        )}
        {!spots.length ? (
          <VStack gap={2}>
            <Skeleton height={64} />
            <Skeleton height={64} />
          </VStack>
        ) : (
          <List hasDividers density="balanced">
            {withDist.map((s) => (
              <ListItem
                key={s.name}
                label={<Text weight="semibold">{s.name}</Text>}
                description={
                  <VStack gap={1}>
                    {s.highlights && <Text type="supporting">{s.highlights}</Text>}
                    {s.access && <Text type="supporting">Parking: {s.access}</Text>}
                  </VStack>
                }
                endContent={
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
                }
              />
            ))}
          </List>
        )}
      </VStack>
    </Card>
  );
}
