import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import geomagnetism from 'geomagnetism';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading, Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Icon } from '@astryxdesign/core/Icon';
import { X } from 'lucide-react';
import { loadJSON, compass, fmtTime } from '../lib/astro.js';
import SkyChart from './SkyChart.jsx';

const base = import.meta.env.BASE_URL;
let skyCache = null;
function loadSky() {
  if (!skyCache) skyCache = loadJSON(`${base}data/sky.json`);
  return skyCache;
}

/* Fullscreen "find it in the sky" view: the SkyChart for one target,
   plus optional live phone pointing. Follow mode reads the phone's
   compass (with permission where the browser requires it), corrects
   magnetic north to true north for this location, and rotates the
   chart so the way the user is facing is up, with turn-left/right
   guidance to the target. Phone compasses are rough (about ±10° on a
   good day) — this gets the user to the right patch of sky, and the
   constellations do the rest. Everything degrades to a plain north-up
   chart where no compass is available (desktop, denied permission). */
export default function SkyView({ isOpen, onClose, title, subtitle, targets, atTime, loc }) {
  const [sky, setSky] = useState(null);
  const [follow, setFollow] = useState(false);
  const [heading, setHeading] = useState(null);
  const [orientMsg, setOrientMsg] = useState(null);
  const [, setTick] = useState(0);
  const handlerRef = useRef(null);
  const smoothRef = useRef(null);
  const lastSetRef = useRef(0);
  const gotSignalRef = useRef(false);

  // Magnetic declination here (negative = magnetic north west of true).
  const decl = useMemo(() => {
    if (!loc || loc.lat == null) return 0;
    try {
      return geomagnetism.model().point([loc.lat, loc.lon]).decl || 0;
    } catch {
      return 0;
    }
  }, [loc]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    loadSky()
      .then((j) => { if (!cancelled) setSky(j); })
      .catch(() => { if (!cancelled) setSky(null); });
    const id = setInterval(() => setTick((t) => t + 1), 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, [isOpen]);

  const stopFollow = () => {
    if (handlerRef.current) {
      window.removeEventListener('deviceorientationabsolute', handlerRef.current, true);
      window.removeEventListener('deviceorientation', handlerRef.current, true);
      handlerRef.current = null;
    }
    setFollow(false);
    setHeading(null);
    smoothRef.current = null;
    gotSignalRef.current = false;
  };

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      stopFollow();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, onClose]);

  const startFollow = async () => {
    setOrientMsg(null);
    if (typeof DeviceOrientationEvent === 'undefined') {
      setOrientMsg('This browser does not share a compass — the chart stays north-up.');
      return;
    }
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') {
          setOrientMsg('Compass permission was not granted — the chart stays north-up.');
          return;
        }
      } catch {
        setOrientMsg('Compass permission failed — the chart stays north-up.');
        return;
      }
    }
    const onOrient = (e) => {
      let raw = null;
      if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
        raw = e.webkitCompassHeading;
      } else if (e.alpha != null) {
        raw = (360 - e.alpha) % 360;
      }
      if (raw == null) return;
      gotSignalRef.current = true;
      const trueH = ((raw + decl) % 360 + 360) % 360;
      const rad = (trueH * Math.PI) / 180;
      const s = smoothRef.current || { x: Math.sin(rad), y: Math.cos(rad) };
      s.x += 0.3 * (Math.sin(rad) - s.x);
      s.y += 0.3 * (Math.cos(rad) - s.y);
      smoothRef.current = s;
      const now = Date.now();
      if (now - lastSetRef.current > 150) {
        lastSetRef.current = now;
        setHeading(((Math.atan2(s.x, s.y) * 180) / Math.PI + 360) % 360);
      }
    };
    handlerRef.current = onOrient;
    window.addEventListener('deviceorientationabsolute', onOrient, true);
    window.addEventListener('deviceorientation', onOrient, true);
    setFollow(true);
    setTimeout(() => {
      if (!gotSignalRef.current) {
        setOrientMsg('No compass signal so far — some browsers only share it over a secure connection or after location is allowed. The chart stays north-up until it arrives.');
      }
    }, 3000);
  };

  if (!isOpen) return null;

  const withLive = (targets || []).map((t) => ({
    ...t,
    live: t.nowFn ? t.nowFn(new Date()) : null,
  }));
  const primary = withLive[0];
  const refPoint = primary?.live || primary?.peak;
  let guidance = null;
  if (primary && refPoint && refPoint.alt > 0) {
    const when = primary.live ? 'right now' : `at ${fmtTime(refPoint.time)}`;
    if (follow && heading != null) {
      const diff = ((refPoint.az - heading + 540) % 360) - 180;
      guidance = Math.abs(diff) <= 7
        ? `You are facing ${primary.label} — look up about ${Math.round(refPoint.alt)}°`
        : `Turn ${diff > 0 ? 'right' : 'left'} ${Math.abs(Math.round(diff))}°, then look up about ${Math.round(refPoint.alt)}° for ${primary.label}`;
    } else {
      guidance = `${primary.label}: face ${compass(refPoint.az)}, look up ${Math.round(refPoint.alt)}° ${when}`;
    }
  } else if (primary) {
    guidance = `${primary.label} is below the horizon at the time shown.`;
  }

  return createPortal(
    <div className="sg-skyview" role="dialog" aria-modal="true" aria-label={title}>
      <HStack gap={2} vAlign="start" hAlign="between" className="sg-skyview-head">
        <VStack gap={0}>
          <Heading level={2}>{title}</Heading>
          {subtitle && <Text type="supporting">{subtitle}</Text>}
        </VStack>
        <IconButton
          icon={<Icon icon={X} size="sm" />}
          label="Close sky chart"
          variant="ghost"
          size="sm"
          onClick={onClose}
        />
      </HStack>
      <div className="sg-skyview-body">
        {sky ? (
          <SkyChart sky={sky} atTime={atTime} loc={loc} targets={withLive} heading={heading} follow={follow} />
        ) : (
          <Text type="supporting">Loading the stars…</Text>
        )}
      </div>
      <VStack gap={2} className="sg-skyview-foot">
        {guidance && <Text weight="semibold">{guidance}</Text>}
        <HStack gap={2} vAlign="center">
          <Button
            variant={follow ? 'secondary' : 'primary'}
            size="sm"
            label={follow ? 'Stop following my phone' : 'Point my phone at it'}
            onClick={follow ? stopFollow : startFollow}
          />
        </HStack>
        {orientMsg && <Text type="supporting">{orientMsg}</Text>}
        <Text type="supporting">
          {follow
            ? `Chart turns with you, top is the way you face. Phone compasses are rough (about 10°) — use the constellations for the final match. Magnetic north here is about ${Math.abs(decl).toFixed(0)}° ${decl < 0 ? 'west' : 'east'} of true north; corrected above.`
            : 'The whole sky overhead: straight up in the center, the horizon at the rim. North is at the top unless you turn on phone pointing.'}
        </Text>
      </VStack>
    </div>,
    document.body,
  );
}
