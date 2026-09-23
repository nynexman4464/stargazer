import { useEffect, useRef, useState } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Heading';
import { List, ListItem } from '@astryxdesign/core/List';
import { Skeleton } from '@astryxdesign/core/Skeleton';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { planetVisibility, compass, fmtDate, fmtTime } from '../lib/astro.js';
import { Mag } from './Term.jsx';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export default function PlanetsPanel({ loc, asOf }) {
  const [rows, setRows] = useState(null);
  const wxCache = useRef({});

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    wxCache.current = {};
    const t = setTimeout(async () => {
      const r = await planetVisibility(asOf || new Date(), loc, wxCache.current);
      if (!cancelled) setRows(r);
    }, 30);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [loc, asOf]);

  return (
    <Card padding={4}>
      <VStack gap={3}>
        <VStack gap={1}>
          <Heading level={2}>{asOf ? 'Planets that night' : 'Planets tonight'}</Heading>
          <Text type="supporting">
            How well each planet shows from {loc.name}
            {asOf ? ` on ${fmtDate(asOf)}` : ''} — height, brightness, moonlight, clouds.
            Same 0–100 scale as go scores.
          </Text>
        </VStack>
        {rows === null ? (
          <VStack gap={2}>
            <Skeleton height={44} />
            <Skeleton height={44} />
            <Skeleton height={44} />
          </VStack>
        ) : (
          <List hasDividers density="balanced">
            {rows.map((p) => (
              <ListItem
                key={p.name}
                label={cap(p.name)}
                description={
                  p.best ? (
                    <Text type="supporting">
                      Best {fmtTime(p.best.time)} — look {compass(p.best.az)},{' '}
                      {Math.round(p.best.alt)}° up ·{' '}
                      <Mag value={p.mag} exclude={cap(p.name)}>mag {p.mag}</Mag>
                      {p.cloudNote === 'forecast unavailable' ? '' : ` · ${p.cloudNote}`}
                    </Text>
                  ) : (
                    <Text type="supporting">{p.altNote}</Text>
                  )
                }
                endContent={
                  <VStack gap={0} hAlign="end">
                    <Text type="large" weight="semibold" hasTabularNumbers>{p.score}</Text>
                    <Text type="supporting">{p.label}</Text>
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
