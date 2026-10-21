import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import geomagnetism from 'geomagnetism';
import { VStack } from '@astryxdesign/core/VStack';
import { HStack } from '@astryxdesign/core/HStack';
import { Heading, Text } from '@astryxdesign/core/Text';
import { Button } from '@astryxdesign/core/Button';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Icon } from '@astryxdesign/core/Icon';
import { X, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { loadJSON, compass, fmtTime, devicePointing } from '../lib/astro.js';
import SkyWindow from './SkyWindow.jsx';

const base = import.meta.env.BASE_URL;
let skyCache = null;
function loadSky() {
  if (!skyCache) skyCache = loadJSON(`${base}data/sky.json`);
  return skyCache;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
const quant = (v) => Math.round(v * 5) / 5; // 0.2-degree steps for the memoized window

/* Fullscreen "find it in the sky" view: the SkyWindow for one target,
   plus optional live phone pointing. Follow mode reads the phone's
   orientation (direction + tilt from devicePointing) and aims the
   window where the back of the phone points, ISS Detector style.
   Magnetic bearings are corrected to true north for this location.

   Smoothness pipeline (phone compasses are noisy, especially
   indoors — raw azimuth can spike 20 degrees between samples):
   sensor events pass a median-of-3 spike filter and a low-pass
   into target refs only; a requestAnimationFrame loop eases the
   displayed aim toward the target; the window receives the aim
   quantized to 0.2 degrees and is memoized, so a still phone
   re-renders nothing. Dragging grabs manual control, pinch and
   buttons set the view width. Everything degrades to a framed,
   draggable window where no compass is available. */
export default function SkyView({ isOpen, onClose, title, subtitle, targets, atTime, loc }) {
  const [sky, setSky] = useState(null);
  const [follow, setFollow] = useState(false);
  const [heading, setHeading] = useState(null);
  const [pointing, setPointing] = useState(null);
  const [orientMsg, setOrientMsg] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [winCenter, setWinCenter] = useState(null);
  const [fov, setFov] = useState(55);
  const handlerRef = useRef(null);
  const targetHeadingRef = useRef(null);
  const targetPointRef = useRef(null);
  const pointSamplesRef = useRef([]);
  const dispHeadingRef = useRef(null);
  const dispPointRef = useRef(null);
  const gotSignalRef = useRef(false);
  const stageRef = useRef(null);
  const pointers = useRef(new Map());
  const gesture = useRef(null);
  const lastTap = useRef(0);

  // Magnetic declination here (negative = magnetic north west of true).
  const decl = useMemo(() => {
    if (!loc || loc.lat == null) return 0;
    try {
      return geomagnetism.model().point([loc.lat, loc.lon]).decl || 0;
    } catch {
      return 0;
    }
  }, [loc]);

  // Stable across the per-frame follow renders; refreshes on the
  // 15-second tick so the memoized window layers stay valid.
  const withLive = useMemo(
    () => (targets || []).map((t) => ({ ...t, live: t.nowFn ? t.nowFn(new Date(nowMs)) : null })),
    [targets, nowMs],
  );

  // Where the window is aimed: the phone while following, else a
  // dragged center, else framed on the main target.
  const primaryTarget = withLive[0] || null;
  const primaryPos = primaryTarget
    ? (primaryTarget.live && primaryTarget.live.alt > -5 ? primaryTarget.live : primaryTarget.peak)
    : null;
  const winCenterResolved = follow && pointing
    ? { az: pointing.az, el: clamp(pointing.el, -15, 75) }
    : winCenter || (primaryPos
      ? { az: primaryPos.az, el: clamp(primaryPos.alt, -10, 70) }
      : { az: 180, el: 30 });

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    loadSky()
      .then((j) => { if (!cancelled) setSky(j); })
      .catch(() => { if (!cancelled) setSky(null); });
    const id = setInterval(() => setNowMs(Date.now()), 15000);
    return () => { cancelled = true; clearInterval(id); };
  }, [isOpen, title]);

  const stopFollow = useCallback(() => {
    if (handlerRef.current) {
      window.removeEventListener('deviceorientationabsolute', handlerRef.current, true);
      window.removeEventListener('deviceorientation', handlerRef.current, true);
      handlerRef.current = null;
    }
    // Freeze the window where the phone was aimed, so stopping
    // follow does not snap the view back to the target framing.
    if (dispPointRef.current) {
      setWinCenter({ az: dispPointRef.current.az, el: clamp(dispPointRef.current.el, -15, 75) });
    }
    setFollow(false);
    setHeading(null);
    setPointing(null);
    targetHeadingRef.current = null;
    targetPointRef.current = null;
    pointSamplesRef.current = [];
    dispHeadingRef.current = null;
    dispPointRef.current = null;
    gotSignalRef.current = false;
  }, []);

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
  }, [isOpen, onClose, stopFollow]);

  /* Frame-rate easing: while following, glide the displayed heading
     and pointing toward the filtered sensor targets, snapping the
     last fraction of a degree. */
  useEffect(() => {
    if (!follow) return;
    let raf = 0;
    let last = performance.now();
    let shownH = null;
    let shownP = null;
    const step = (t) => {
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      const kh = 1 - Math.exp(-dt / 0.09);
      const kp = 1 - Math.exp(-dt / 0.17);
      const th = targetHeadingRef.current;
      if (th != null) {
        if (dispHeadingRef.current == null) dispHeadingRef.current = th;
        else {
          const d = ((th - dispHeadingRef.current + 540) % 360) - 180;
          dispHeadingRef.current = Math.abs(d) < 0.04
            ? th
            : ((dispHeadingRef.current + d * kh) % 360 + 360) % 360;
        }
        if (shownH == null || Math.abs(((dispHeadingRef.current - shownH + 540) % 360) - 180) > 0.02) {
          shownH = dispHeadingRef.current;
          setHeading(shownH);
        }
      }
      const tp = targetPointRef.current;
      if (tp) {
        if (!dispPointRef.current) dispPointRef.current = { ...tp };
        else {
          const dp = dispPointRef.current;
          const d = ((tp.az - dp.az + 540) % 360) - 180;
          dp.az = Math.abs(d) < 0.04 ? tp.az : ((dp.az + d * kp) % 360 + 360) % 360;
          dp.el = Math.abs(tp.el - dp.el) < 0.04 ? tp.el : dp.el + (tp.el - dp.el) * kp;
        }
        const dp = dispPointRef.current;
        if (!shownP || Math.abs(dp.az - shownP.az) > 0.02 || Math.abs(dp.el - shownP.el) > 0.02) {
          shownP = { ...dp };
          setPointing(shownP);
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [follow]);

  const startFollow = async () => {
    setOrientMsg(null);
    if (typeof DeviceOrientationEvent === 'undefined') {
      setOrientMsg('This browser does not share a compass — the view stays as framed.');
      return;
    }
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        if (res !== 'granted') {
          setOrientMsg('Compass permission was not granted — the view stays as framed.');
          return;
        }
      } catch {
        setOrientMsg('Compass permission failed — the view stays as framed.');
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
      if (raw == null && e.alpha == null) return;
      gotSignalRef.current = true;
      if (raw != null) {
        targetHeadingRef.current = ((raw + decl) % 360 + 360) % 360;
      }
      // Tilt: where the back of the phone is aimed (az/el, magnetic
      // frame), through a median-of-3 spike filter and a low-pass —
      // raw phone compasses spike hard, and the view must not.
      if (e.alpha != null && e.beta != null && e.gamma != null) {
        const p = devicePointing(e.alpha, e.beta, e.gamma);
        if (p) {
          const sample = { az: ((p.az + decl) % 360 + 360) % 360, el: p.el };
          const buf = pointSamplesRef.current;
          buf.push(sample);
          if (buf.length > 3) buf.shift();
          let med = sample;
          if (buf.length === 3) {
            const [s0, s1, s2] = buf;
            const rel = (a) => ((a - s0.az + 540) % 360) - 180;
            const medRel = [0, rel(s1.az), rel(s2.az)].sort((x, y) => x - y)[1];
            const medEl = [s0.el, s1.el, s2.el].sort((x, y) => x - y)[1];
            med = { az: ((s0.az + medRel) % 360 + 360) % 360, el: medEl };
          }
          const prev = targetPointRef.current;
          if (!prev) {
            targetPointRef.current = med;
          } else {
            const d = ((med.az - prev.az + 540) % 360) - 180;
            targetPointRef.current = {
              az: ((prev.az + d * 0.35) % 360 + 360) % 360,
              el: prev.el + (med.el - prev.el) * 0.35,
            };
          }
        }
      }
    };
    handlerRef.current = onOrient;
    window.addEventListener('deviceorientationabsolute', onOrient, true);
    window.addEventListener('deviceorientation', onOrient, true);
    setFollow(true);
    setTimeout(() => {
      if (!gotSignalRef.current) {
        setOrientMsg('No compass signal so far — some browsers only share it over a secure connection or after location is allowed. The view follows once it arrives.');
      }
    }, 3000);
  };

  /* ---- drag to look around, pinch to set the view width ---- */
  const onPointerDown = (e) => {
    if (e.target.closest('button')) return; // zoom controls keep their clicks
    stageRef.current.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Grabbing the window takes manual control back from follow mode
    // (stopFollow freezes the current aim as the manual center).
    if (follow) stopFollow();
    if (pointers.current.size === 1) {
      gesture.current = {
        mode: 'winpan',
        sx: e.clientX, sy: e.clientY,
        az0: winCenterResolved.az, el0: winCenterResolved.el,
        az: winCenterResolved.az, el: winCenterResolved.el,
        moved: false, tapX: e.clientX, tapY: e.clientY,
      };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = {
        mode: 'winpinch',
        d0: Math.hypot(a.x - b.x, a.y - b.y),
        fov0: fov,
        az0: winCenterResolved.az, el0: winCenterResolved.el,
        az: winCenterResolved.az, el: winCenterResolved.el,
        moved: true,
      };
    }
  };

  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.mode === 'winpan' && pointers.current.size === 1) {
      const dx = e.clientX - g.sx;
      const dy = e.clientY - g.sy;
      if (Math.hypot(dx, dy) > 6) g.moved = true;
      if (g.moved) {
        // Grab-the-sky dragging: the sky follows the finger in both
        // axes. Sideways, the aim center moves opposite the drag;
        // vertically, dragging down pulls the sky down, which aims
        // the center HIGHER (screen y runs down, elevation up — the
        // signs differ, and matching them felt reversed).
        const rect = stageRef.current.getBoundingClientRect();
        const dpp = fov / rect.width;
        const az = ((g.az0 - dx * dpp) % 360 + 360) % 360;
        const el = clamp(g.el0 + dy * dpp, -15, 78);
        g.az = az;
        g.el = el;
        setWinCenter({ az, el });
      }
    } else if (g.mode === 'winpinch' && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d1 = Math.hypot(a.x - b.x, a.y - b.y);
      if (d1 < 1 || g.d0 < 1) return;
      setFov(clamp(g.fov0 * (g.d0 / d1), 28, 95));
      g.moved = true;
    }
  };

  const onPointerUp = (e) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (!g) return;
    if (pointers.current.size === 0) {
      if (g.mode === 'winpan' && !g.moved) {
        const now = Date.now();
        if (now - lastTap.current < 300) {
          // Double-tap re-frames on the target and resets the width.
          setWinCenter(null);
          setFov(55);
          lastTap.current = 0;
        } else {
          lastTap.current = now;
        }
      }
      gesture.current = null;
    } else if (pointers.current.size === 1) {
      const [p] = [...pointers.current.values()];
      gesture.current = {
        mode: 'winpan',
        sx: p.x, sy: p.y,
        az0: g.az ?? g.az0, el0: g.el ?? g.el0,
        az: g.az ?? g.az0, el: g.el ?? g.el0,
        moved: true,
      };
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e) => {
      e.preventDefault();
      setFov((prev) => clamp(prev * (e.deltaY < 0 ? 0.9 : 1.11), 28, 95));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [isOpen, sky]);

  if (!isOpen) return null;

  const primary = withLive[0];
  const refPoint = primary?.live || primary?.peak;
  let guidance = null;
  if (primary && refPoint && refPoint.alt > 0) {
    const when = primary.live ? 'right now' : `at ${fmtTime(refPoint.time)}`;
    if (follow && pointing) {
      const dAz = ((refPoint.az - pointing.az + 540) % 360) - 180;
      const dEl = refPoint.alt - pointing.el;
      if (Math.abs(dAz) <= 5 && Math.abs(dEl) <= 5) {
        guidance = `That is it — ${primary.label} should be right around the center ring. Look up from the phone.`;
      } else {
        const parts = [];
        if (Math.abs(dAz) > 4) parts.push(`turn ${dAz > 0 ? 'right' : 'left'} ${Math.abs(Math.round(dAz))}°`);
        if (Math.abs(dEl) > 4) parts.push(`tilt ${dEl > 0 ? 'up' : 'down'} ${Math.abs(Math.round(dEl))}°`);
        guidance = parts.length
          ? `${parts.join(' · ')} — until ${primary.label} reaches the center ring`
          : `Nearly there — small adjustments center ${primary.label}`;
      }
    } else if (follow && heading != null) {
      const diff = ((refPoint.az - heading + 540) % 360) - 180;
      guidance = Math.abs(diff) <= 7
        ? `You are facing ${primary.label} — look up about ${Math.round(refPoint.alt)}°`
        : `Turn ${diff > 0 ? 'right' : 'left'} ${Math.abs(Math.round(diff))}°, then look up about ${Math.round(refPoint.alt)}° for ${primary.label}`;
    } else {
      // No live position means the object is not up right now (the
      // Moon at 6 AM, say) — say so, with when it comes back, rather
      // than silently showing only the peak marker.
      let notUp = '';
      if (primary.nowFn && !primary.live) {
        if (primary.rise && nowMs < primary.rise.time.getTime()) {
          notUp = ` It is not up right now — it rises ${fmtTime(primary.rise.time)}.`;
        } else if (primary.set && nowMs > primary.set.time.getTime()) {
          notUp = ` It is not up right now — it set at ${fmtTime(primary.set.time)}.`;
        }
      }
      guidance = `${primary.label}: face ${compass(refPoint.az)}, look up ${Math.round(refPoint.alt)}° ${when}.${notUp}`;
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
          label="Close sky view"
          variant="ghost"
          size="sm"
          onClick={onClose}
        />
      </HStack>
      <div
        ref={stageRef}
        className="sg-skyview-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {!sky ? (
          <Text type="supporting">Loading the stars…</Text>
        ) : (
          <SkyWindow
            sky={sky}
            atTime={atTime}
            loc={loc}
            targets={withLive}
            center={{ az: quant(winCenterResolved.az), el: quant(winCenterResolved.el) }}
            fov={Math.round(fov * 2) / 2}
          />
        )}
        <HStack gap={1} vAlign="center" className="sg-skyview-zoom">
          <Text type="supporting">{`${Math.round(fov)}° wide`}</Text>
          <IconButton
            icon={<Icon icon={ZoomOut} size="sm" />}
            label="Zoom out"
            variant="ghost"
            size="sm"
            isDisabled={fov >= 94.5}
            onClick={() => setFov((p) => clamp(p * 1.35, 28, 95))}
          />
          <IconButton
            icon={<Icon icon={ZoomIn} size="sm" />}
            label="Zoom in"
            variant="ghost"
            size="sm"
            isDisabled={fov <= 28.5}
            onClick={() => setFov((p) => clamp(p / 1.35, 28, 95))}
          />
          <IconButton
            icon={<Icon icon={Maximize2} size="sm" />}
            label="Reset zoom"
            variant="ghost"
            size="sm"
            isDisabled={fov === 55 && winCenter == null}
            onClick={() => { setFov(55); setWinCenter(null); }}
          />
        </HStack>
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
            ? `The view follows your phone: aim until the target sits in the center ring — the arrow points to it while it is off-screen. Magnetic north here is about ${Math.abs(decl).toFixed(0)}° ${decl < 0 ? 'west' : 'east'} of true north, corrected above. Phone compasses wobble, worst indoors; outdoors away from metal they settle.`
            : 'The patch of sky this view is aimed at, framed on the target. Drag to look around, pinch to widen or narrow the view; double-tap re-frames on the target. The ring marks the exact center.'}
        </Text>
      </VStack>
    </div>,
    document.body,
  );
}
