import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { Cloud, CloudOff, Moon, Eye, Telescope } from 'lucide-react';
import { TermText } from './Term.jsx';

/* Single source of truth for go-score factor icons. */
const FACTOR_ICON = {
  cloud: Cloud,
  cloudOff: CloudOff,
  moon: Moon,
  eye: Eye,
  telescope: Telescope,
};

/* The "why this score" factor rows, shared by the hero and the event feed.
   `exclude` (body names) keeps magnitude hovers from comparing a body to
   itself. */
export default function ScoreFactors({ factors, exclude }) {
  if (!factors) return null;
  return (
    <VStack gap={1}>
      {factors.map((f, i) => (
        <HStack key={i} gap={1} vAlign="center">
          <Icon icon={FACTOR_ICON[f.icon] || Cloud} size="sm" color="secondary" />
          <Text type="supporting">
            <TermText text={f.text} exclude={exclude} />
          </Text>
        </HStack>
      ))}
    </VStack>
  );
}
