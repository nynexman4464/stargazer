import { HoverCard } from '@astryxdesign/core/HoverCard';
import { ProgressBar } from '@astryxdesign/core/ProgressBar';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import ScoreFactors from './ScoreFactors.jsx';

/* Go/Maybe/Nope -> bar color. Single source of truth for the hero and feed. */
export function scoreVariant(label) {
  return label === 'Go' ? 'success' : label === 'Maybe' ? 'warning' : 'error';
}

/* A go score that keeps the factor breakdown one hover away: hovering (or
   tapping, on touch) the score opens the "why" in a hover card, so cards
   stay glanceable and the details are inspectable. Shared by the hero and
   the event feed. */
export default function GoScore({ score, exclude }) {
  if (!score) return null;
  const label = score.estimated ? 'Est. go score' : 'Go score';
  return (
    <HoverCard
      label={`${label}: score breakdown`}
      content={
        <VStack gap={1}>
          <Text weight="semibold">
            {label}: {score.score}%
          </Text>
          <ScoreFactors factors={score.factors} exclude={exclude} />
        </VStack>
      }
      hasHoverIndication={false}
      touchTrigger="tap"
    >
      <VStack gap={1}>
        <Text type="label" color="secondary">
          {label}
        </Text>
        <ProgressBar
          value={score.score}
          hasValueLabel
          variant={scoreVariant(score.label)}
        />
      </VStack>
    </HoverCard>
  );
}
