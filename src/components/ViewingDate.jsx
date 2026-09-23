import { useState } from 'react';
import { Popover } from '@astryxdesign/core/Popover';
import { Button } from '@astryxdesign/core/Button';
import { Calendar } from '@astryxdesign/core/Calendar';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { useMediaQuery } from '@astryxdesign/core/hooks';
import { CalendarDays } from 'lucide-react';
import { DAY, fmtDate, isoDay, startOfDay } from '../lib/astro.js';

/* How far ahead the viewing date may go: forecasts run ~2 weeks and TLEs go
   stale, so a month keeps every section honest. */
export const VIEWING_MAX_DAYS = 30;

/* Header control: a "time machine" for the page. Defaults to Today (null);
   picking a date re-anchors the hero, event feed, moon panel, and flyovers
   onto that day. Aurora stays live — it's intrinsically now-casting. */
export default function ViewingDate({ viewDate, onChange }) {
  const [open, setOpen] = useState(false);
  // Bounds for the picker, fixed for the session.
  const [todayIso] = useState(() => isoDay(new Date()));
  const [maxIso] = useState(() => isoDay(new Date(Date.now() + VIEWING_MAX_DAYS * DAY)));
  // On phones the popover gets an explicit width so the month grid can't
  // size it past the viewport.
  const isCompact = useMediaQuery('(max-width: 639px)');

  const pick = (next) => {
    onChange(next);
    setOpen(false);
  };
  const quick = (daysOut) => {
    if (daysOut === 0) return pick(null);
    const d = startOfDay(new Date(Date.now() + daysOut * DAY));
    pick(d);
  };
  const pickIso = (iso) => {
    if (!iso || iso <= todayIso) return pick(null);
    const [y, m, dd] = iso.split('-').map(Number);
    pick(new Date(y, m - 1, dd));
  };

  return (
    <Popover
      isOpen={open}
      onOpenChange={setOpen}
      placement="below"
      alignment="end"
      label="Choose a viewing date"
      width={isCompact ? 'min(94vw, 340px)' : undefined}
      content={
        <VStack gap={3} padding={isCompact ? 2 : 3}>
          <HStack gap={2} wrap="wrap">
            <Button
              label="Today"
              variant={viewDate ? 'ghost' : 'secondary'}
              onClick={() => quick(0)}
            />
            <Button label="Tomorrow" variant="ghost" onClick={() => quick(1)} />
            <Button label="+1 wk" variant="ghost" onClick={() => quick(7)} />
            <Button label="+1 mo" variant="ghost" onClick={() => quick(30)} />
          </HStack>
          <Calendar
            mode="single"
            value={viewDate ? isoDay(viewDate) : todayIso}
            min={todayIso}
            max={maxIso}
            onChange={(iso) => pickIso(iso)}
          />
          <Text type="supporting">
            Forecasts and flyover orbits only reach about a month out.
          </Text>
        </VStack>
      }
    >
      <Button
        variant="secondary"
        size="sm"
        label={viewDate ? fmtDate(viewDate) : 'Today'}
        icon={<Icon icon={CalendarDays} size="sm" />}
        aria-label="Viewing date"
        tooltip={viewDate ? 'Viewing a future date — tap to change' : 'Viewing today — tap to fast-forward'}
      />
    </Popover>
  );
}
