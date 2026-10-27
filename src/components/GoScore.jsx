import { HoverCard } from '@astryxdesign/core/HoverCard';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { ScoreBreakdown } from './ScoreFactors.jsx';

/* Go/Maybe/Nope -> bar color. Single source of truth for the hero and feed. */
export function scoreVariant(label) {
  return label === 'Go' ? 'success' : label === 'Maybe' ? 'warning' : 'error';
}

/* A go score with its full math one hover away: the hover card (tap on
   touch) is anchored to the meter itself and shows the breakdown table —
   base score, each factor's point delta, and the total. Shared by the hero
   and the event feed. */
/* The unscored card's stand-in (Alex, 2026-10-27: the
   missing bar made card heights ragged). Expedition
   eclipses that aren't visible from the viewing location
   get no score by design — a percentage from a place that
   can't see the event would be a lie, and a literal 0
   would read as hopeless weather. So: the same bar
   footprint, disabled and neutral, an empty track, and a
   dash where the percentage goes. Rendered only once
   scoring has settled, so it never flashes mid-load. */
export function GoScorePlaceholder({ estimated, locName }) {
  const label = estimated ? 'Est. go score' : 'Go score';
  return (
    <HoverCard
      label="Why there is no go score"
      content={
        <Text>
          No go score — this event isn&apos;t visible from {locName || 'your location'}, and a
          score only makes sense where it can actually be seen.
        </Text>
      }
      placement="above"
      hasHoverIndication={false}
      touchTrigger="tap"
    >
      <ProgressBar
        label={label}
        value={0}
        variant="neutral"
        isDisabled
        hasValueLabel
        formatValueLabel={() => '—'}
      />
    </HoverCard>
  );
}

export default function GoScore({ score, exclude }) {
  if (!score) return null;
  const label = score.estimated ? 'Est. go score' : 'Go score';
  return (
    <HoverCard
      label={`${label}: score breakdown`}
      content={
        <VStack gap={2}>
          <Text weight="semibold">
            {label}: {score.score}%
          </Text>
          <ScoreBreakdown score={score} exclude={exclude} />
        </VStack>
      }
      placement="above"
      hasHoverIndication={false}
      touchTrigger="tap"
    >
      <ProgressBar
        label={label}
        value={score.score}
        hasValueLabel
        variant={scoreVariant(score.label)}
      />
    </HoverCard>
  );
}
