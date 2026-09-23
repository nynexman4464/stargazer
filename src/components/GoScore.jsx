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
export default function GoScore({ score, exclude }) {
  if (!score) return null;
  const label = score.estimated ? 'Est. go score' : 'Go score';
  return (
    <VStack gap={1}>
      <Text type="label" color="secondary">
        {label}
      </Text>
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
          value={score.score}
          hasValueLabel
          variant={scoreVariant(score.label)}
        />
      </HoverCard>
    </VStack>
  );
}
