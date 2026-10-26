import { useState } from 'react';
import { HoverCard } from '@astryxdesign/core/HoverCard';
import { HStack } from '@astryxdesign/core/HStack';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Text } from '@astryxdesign/core/Text';
import { VStack } from '@astryxdesign/core/VStack';
import { Compass, Telescope } from 'lucide-react';
import { compass, fmtTime, pathPointAt } from '../lib/astro.js';
import SkyView from './SkyView.jsx';

/* Where to look for an event's object(s): a glanceable line per object —
   "Orionids radiant peaks 5:00 AM — look S, 64° up" — with the full track
   (rise/set, hourly direction + angle, viewing notes) in a hover card,
   tap on touch, anchored to the line itself. Same pattern as GoScore.
   Data comes from eventLook() in astro.js; positions are for the event's
   own night at the user's location. */

function peakQualifier(look) {
  const { peak, peakInDark } = look.track;
  if (!peak || peakInDark) return '';
  if (peak.sun >= 0) return ' (in daylight)';
  if (peak.sun >= -6) return ' (in twilight)';
  return '';
}

function glanceText(look, locName) {
  const { track } = look;
  if (track.neverUp) {
    return `${look.label} never gets above the horizon from ${locName} that night`;
  }
  const p = track.peak;
  return `${look.label} peaks ${fmtTime(p.time)} — look ${compass(p.az)}, ${Math.round(p.alt)}° up${peakQualifier(look)}`;
}

function LookDetails({ look, whenText, locName }) {
  const { track } = look;
  return (
    <VStack gap={2}>
      <Text weight="semibold">
        {look.label} — where to look{whenText ? ` · ${whenText}` : ''}
      </Text>
      {track.neverUp ? (
        <Text type="supporting">
          It stays below the horizon from {locName} all night.
        </Text>
      ) : (
        <>
          <Text type="supporting">
            Highest: {fmtTime(track.peak.time)} — {compass(track.peak.az)},{' '}
            {Math.round(track.peak.alt)}° above the horizon{peakQualifier(look)}.
          </Text>
          {(track.rise || track.set || track.upAllWindow) && (
            <Text type="supporting">
              {track.upAllWindow
                ? 'Up all night — it never sets from here.'
                : [
                    track.rise
                      ? `Rises ${fmtTime(track.rise.time)} in the ${compass(track.rise.az)}`
                      : 'Already up in the evening',
                    track.set ? `sets ${fmtTime(track.set.time)}` : 'still up at dawn',
                  ].join(' · ')}
              .
            </Text>
          )}
          {track.samples.length > 1 && (
            <VStack gap={1}>
              {track.samples.map((s) => (
                <HStack key={s.time.getTime()} hAlign="between" vAlign="center" gap={3}>
                  <Text type="supporting">{fmtTime(s.time)}</Text>
                  <Text type="supporting" weight="semibold">
                    {s.alt < 0
                      ? 'below the horizon'
                      : `${compass(s.az)} · ${Math.round(s.alt)}° up`}
                  </Text>
                </HStack>
              ))}
            </VStack>
          )}
        </>
      )}
      {look.note && <Text type="supporting">{look.note}</Text>}
    </VStack>
  );
}

export default function WhereToLook({ looks, whenText, locName, loc, detail }) {
  const [skyLook, setSkyLook] = useState(null);
  if (!looks || looks.length === 0) return null;
  const place = locName || 'your location';
  return (
    <VStack gap={1}>
      {looks.map((look) => (
        <HStack key={look.label} gap={1} vAlign="center">
          <HoverCard
            label={`${look.label}: where to look`}
            content={<LookDetails look={look} whenText={whenText} locName={place} />}
            placement="above"
            touchTrigger="tap"
          >
            <HStack gap={1} vAlign="center">
              <Icon icon={Compass} size="sm" color="secondary" />
              <Text type="supporting">{glanceText(look, place)}</Text>
            </HStack>
          </HoverCard>
          {loc && look.track?.peak && look.track?.path?.length > 1 && (
            <IconButton
              icon={<Icon icon={Telescope} size="sm" />}
              label={`Sky chart for ${look.label}`}
              variant="ghost"
              size="sm"
              onClick={() => setSkyLook(look)}
            />
          )}
        </HStack>
      ))}
      {skyLook && (
        <SkyView
          isOpen
          onClose={() => setSkyLook(null)}
          title={`${skyLook.label} — find in the sky`}
          subtitle={whenText}
          targets={[{
            label: skyLook.label,
            path: skyLook.track.path,
            peak: skyLook.track.peak,
            rise: skyLook.track.rise,
            set: skyLook.track.set,
            // "Where it is right now": inside this event's passage,
            // interpolate the track; outside it (the object up this
            // morning on last night's passage, say), compute the
            // position directly — but only while it is actually up.
            nowFn: (now) => {
              const onTrack = pathPointAt(skyLook.track.path, now);
              if (onTrack) return onTrack;
              const p = skyLook.track.posAt ? skyLook.track.posAt(now) : null;
              return p && p.alt > 0 ? p : null;
            },
          }]}
          atTime={skyLook.track.peak?.time}
          loc={loc}
          detail={detail}
        />
      )}
    </VStack>
  );
}
