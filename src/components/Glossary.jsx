import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Text';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { CollapsibleGroup, Collapsible } from '@astryxdesign/core/Collapsible';
import { GLOSSARY } from '../lib/astro.js';

/* Sky talk — the jargon, translated. */
export default function Glossary() {
  return (
    <Card padding={4} id="sky-talk">
      <VStack gap={3}>
        <VStack gap={1}>
          <Heading level={2}>Sky talk</Heading>
          <Text type="supporting">the jargon, translated</Text>
        </VStack>
        <CollapsibleGroup type="multiple" hasDividers>
          {GLOSSARY.map(([term, def]) => (
            <Collapsible key={term} value={term} trigger={term}>
              <Text color="secondary">{def}</Text>
            </Collapsible>
          ))}
        </CollapsibleGroup>
      </VStack>
    </Card>
  );
}
