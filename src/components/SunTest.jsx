import { useEffect, useMemo, useState } from 'react';
import { Card } from '@astryxdesign/core/Card';
import { Heading } from '@astryxdesign/core/Text';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Icon } from '@astryxdesign/core/Icon';
import { Telescope } from 'lucide-react';
import { sunRaDec, lookTrack, pathPointAt, compass, fmtTime } from '../lib/astro.js';
import SkyView from './SkyView.jsx';

/* Aim test (Alex, 2026-10-22): follow mode felt hard to point
   at the real target, with the sensor itself confirmed fine.
   The Sun is the one sky target with a ground truth you can
   check in daylight — its direction is known exactly, and you
   can line the phone up on it by its shadow. This card opens
   the sky view on the Sun with a live position, so the aim
   readout and guidance can be compared against reality: if
   they miss, the size and direction of the miss is the bug. */
export default function SunTest({ loc }) {
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  const track = useMemo(() => {
    if (!loc || loc.lat == null) return null;
    const base = new Date();
    const anchor = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 12);
    return lookTrack((d) => sunRaDec(d), anchor, loc, { startH: -12, hours: 24, daytime: true });
  }, [loc]);
  if (!track || !track.peak) return null;
  const now = new Date(nowMs);
  const live = track.posAt ? track.posAt(now) : null;
  const up = live && live.alt > 0;
  return (
    <Card>
      <VStack gap={2}>
        <HStack gap={2} vAlign="center" hAlign="between">
          <Heading level={3}>Aim test — the Sun</Heading>
          <IconButton
            icon={<Icon icon={Telescope} size="sm" />}
            label="Sky chart for the Sun (aim test)"
            variant="ghost"
            size="sm"
            onClick={() => setOpen(true)}
          />
        </HStack>
        <Text type="supporting">
          {up
            ? `Right now the Sun is ${compass(live.az)}, up ${Math.round(live.alt)}°. Open the sky view, tap “Point my phone at it”, and hold the back of the phone toward the Sun — line it up by the phone’s shadow, never by looking at it. The aim readout should land on the Sun’s real direction; if it misses, how far off and which way is the bug.`
            : `The Sun is down right now${track.set ? ` — it set at ${fmtTime(track.set.time)}` : ''}. This test needs daylight.`}
        </Text>
      </VStack>
      {open && (
        <SkyView
          isOpen
          onClose={() => setOpen(false)}
          title="Sun — aim test"
          subtitle="The Sun, right now"
          targets={[{
            label: 'Sun',
            path: track.path,
            peak: track.peak,
            rise: track.rise,
            set: track.set,
            nowFn: (n) => {
              const onTrack = pathPointAt(track.path, n);
              if (onTrack) return onTrack;
              const p = track.posAt ? track.posAt(n) : null;
              return p && p.alt > 0 ? p : null;
            },
          }]}
          atTime={now}
          loc={loc}
        />
      )}
    </Card>
  );
}
