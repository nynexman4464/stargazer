import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { Cloud, CloudOff, Moon, Eye, Telescope, Car, Plane } from 'lucide-react';
import { TermText } from './Term.jsx';

/* Single source of truth for go-score factor icons. */
export const FACTOR_ICON = {
  cloud: Cloud,
  cloudOff: CloudOff,
  moon: Moon,
  eye: Eye,
  telescope: Telescope,
  car: Car,
  plane: Plane,
};

function FactorRow({ factor, exclude }) {
  return (
    <HStack gap={1} vAlign="center">
      <Icon icon={FACTOR_ICON[factor.icon] || Cloud} size="sm" color="secondary" />
      <Text type="supporting">
        <TermText text={factor.text} exclude={exclude} />
      </Text>
    </HStack>
  );
}

/* The "why this score" factor rows, shared by the hero and the event feed.
   `exclude` (body names) keeps magnitude hovers from comparing a body to
   itself. */
export default function ScoreFactors({ factors, exclude }) {
  if (!factors) return null;
  return (
    <VStack gap={1}>
      {factors.map((f, i) => (
        <FactorRow key={i} factor={f} exclude={exclude} />
      ))}
    </VStack>
  );
}

/* The go-score math as a table: base score, each factor's point delta, and
   the total. Rendered inside the go-score hover card. */
export function ScoreBreakdown({ score, exclude }) {
  if (!score) return null;
  const base = score.base ?? 55;
  const raw = base + score.factors.reduce((s, f) => s + (f.delta || 0), 0);
  const fmtDelta = (d) => (d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '—');
  return (
    <VStack gap={1}>
      <HStack hAlign="between" vAlign="center" gap={3}>
        <Text type="supporting">Base score</Text>
        <Text type="supporting" weight="semibold">
          {base}
        </Text>
      </HStack>
      {score.factors.map((f, i) => (
        <HStack key={i} hAlign="between" vAlign="center" gap={3}>
          <FactorRow factor={f} exclude={exclude} />
          <Text type="supporting" weight="semibold">
            {fmtDelta(f.delta)}
          </Text>
        </HStack>
      ))}
      <HStack hAlign="between" vAlign="center" gap={3}>
        <Text weight="semibold">Total</Text>
        <Text weight="semibold">{score.score}%</Text>
      </HStack>
      {raw !== score.score && (
        <Text type="supporting">Kept within 5–99.</Text>
      )}
    </VStack>
  );
}
