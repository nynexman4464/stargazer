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
import { loadJSON, compass, fmtTime, devicePointing, quatAim, slerpQuat, dirVec, azElOf, frameFrom, clampFrameEl, screenPoint, grabPan } from '../lib/astro.js';
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
const quant = (v) => Math.round(v * 20) / 20; // 0.05-degree steps for the memoized window — fine enough that a slow drag doesn't step visibly (0.2-degree steps were ~1px jumps)

/* "Find it in the sky" view: the SkyWindow for one target, plus
   optional live phone pointing. Presentation (extras.css): a
   fullscreen sheet on small screens; on wide screens a centered
   modal panel with the window large at left and guidance in a
   side column — the phone-sized portrait window looked lost on
   a desktop monitor (Alex, 2026-10-21). Follow mode reads the phone's
   orientation (direction + tilt from devicePointing) and aims the
   window where the back of the phone points, ISS Detector style.
   Magnetic bearings are corrected to true north for this location.

   Smoothness pipeline. First choice is the phone's FUSED
   orientation (AbsoluteOrientationSensor): the OS blends gyro,
   accelerometer and magnetometer into one quaternion — the same
   rotation-vector source native finder apps use, and far
   steadier than raw events. The fusion already did the filtering
   work, so the rAF loop adds only a fixed frame-scale slerp
   (tau 60ms) against sample shimmer, then converts to az/el.
   Where the fused sensor does not exist (iOS, Firefox), the
   fallback is deviceorientation Euler events through a
   median-of-3 spike filter and low-pass into target refs, eased
   in the same loop.
   The window receives the aim quantized and is memoized, so a
   still phone re-renders almost nothing. Dragging grabs manual
   control, pinch and buttons set the view width. Everything
   degrades to a framed, draggable window where no compass is
   available. */
export default function SkyView({ isOpen, onClose, title, subtitle, targets, atTime, loc }) {
  const [sky, setSky] = useState(null);
  const [follow, setFollow] = useState(false);
  const [heading, setHeading] = useState(null);
  const [pointing, setPointing] = useState(null);
  const [orientMsg, setOrientMsg] = useState(null);
  const [sensorSrc, setSensorSrc] = useState(null); // 'fused' | 'euler' — which source the follow loop is actually using, shown in the follow copy so a phone test can report it
  const [cameraOn, setCameraOn] = useState(false); // camera pass-through: the phone's rear camera behind the chart (Alex, 2026-10-22)
  const [cameraMsg, setCameraMsg] = useState(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [winCenter, setWinCenter] = useState(null);
  const [frameUp, setFrameUp] = useState(null); // the sky window's carried screen-up vector while dragging (null = derive from world up)
  const [fov, setFov] = useState(55);
  const handlerRef = useRef(null);
  const sensorRef = useRef(null);
  const quatRef = useRef(null);
  const quatTimeRef = useRef(0);
  const absSeenRef = useRef(false);
  const smoothQuatRef = useRef(null);
  const fusedRef = useRef(false);
  const targetHeadingRef = useRef(null);
  const targetPointRef = useRef(null);
  const pointSamplesRef = useRef([]);
  const dispHeadingRef = useRef(null);
  const dispPointRef = useRef(null);
  const gotSignalRef = useRef(false);
  const stageRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
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
    ? { az: pointing.az, el: clamp(pointing.el, -50, 85) }
    : winCenter || (primaryPos
      ? { az: primaryPos.az, el: clamp(primaryPos.alt, -50, 70) }
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
    if (sensorRef.current) {
      try { sensorRef.current.stop(); } catch { /* already stopped */ }
      sensorRef.current = null;
    }
    fusedRef.current = false;
    quatRef.current = null;
    quatTimeRef.current = 0;
    absSeenRef.current = false;
    setSensorSrc(null);
    smoothQuatRef.current = null;
    setFrameUp(null);
    // Freeze the window where the phone was aimed, so stopping
    // follow does not snap the view back to the target framing.
    if (dispPointRef.current) {
      setWinCenter({ az: dispPointRef.current.az, el: clamp(dispPointRef.current.el, -50, 85) });
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

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraOn(false);
  }, []);

  // The video element mounts when cameraOn flips; attach the
  // stream then (it cannot be attached before the element exists).
  useEffect(() => {
    if (cameraOn && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [cameraOn]);

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
      stopCamera();
    };
  }, [isOpen, onClose, stopFollow, stopCamera]);

  /* Frame-rate smoothing while following. Fused source (when its
     readings are actually fresh — a sensor that starts and then
     goes silent must not freeze the view): slerp the smoothed
     quaternion toward the latest reading with one fixed tau,
     convert, done — the slerp IS the filter. Euler fallback:
     glide the displayed heading and pointing toward the filtered
     sensor targets, snapping the last fraction of a degree.
     State updates only when the displayed aim actually moved.
     (A hold-steady deadband on the displayed aim was tried in
     fadb6f8 and reverted the same night: at the target it made
     fine corrections stick, then jump — worse, per Alex.) */
  useEffect(() => {
    if (!follow) return;
    let raf = 0;
    let last = performance.now();
    let shownH = null;
    let shownP = null;
    let srcShown = null;
    const step = (t) => {
      const dt = Math.min(0.1, (t - last) / 1000);
      last = t;
      const fusedLive = fusedRef.current && quatRef.current
        && performance.now() - quatTimeRef.current < 1000;
      const srcNow = fusedLive ? 'fused'
        : ((targetPointRef.current || targetHeadingRef.current) ? 'euler' : null);
      if (srcNow && srcNow !== srcShown) { srcShown = srcNow; setSensorSrc(srcNow); }
      if (fusedLive) {
        const raw = quatRef.current;
        if (raw) {
          if (!smoothQuatRef.current) {
            smoothQuatRef.current = [...raw];
          } else {
            // The fused feed needs almost no help — the OS fusion
            // already did the filtering work (that was the point
            // of switching to it). What remains is slow magnetic
            // wander indoors, which no filter removes without
            // adding lag, plus 60Hz sample shimmer. So: one fixed
            // frame-scale slerp (tau 60ms) that only takes the
            // shimmer off. Earlier adaptive schemes (tau keyed to
            // lag, then to turning speed) both ended up syrupy or
            // veto-prone; predictable and light beats clever here.
            smoothQuatRef.current = slerpQuat(smoothQuatRef.current, raw, 1 - Math.exp(-dt / 0.06));
          }
          const aim = quatAim(smoothQuatRef.current);
          if (aim) {
            const azT = ((aim.az + decl) % 360 + 360) % 360;
            dispHeadingRef.current = azT;
            dispPointRef.current = { az: azT, el: aim.el };
          }
        }
      } else {
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
        }
      }
      if (dispHeadingRef.current != null
        && (shownH == null || Math.abs(((dispHeadingRef.current - shownH + 540) % 360) - 180) > 0.02)) {
        shownH = dispHeadingRef.current;
        setHeading(shownH);
      }
      const dp = dispPointRef.current;
      if (dp && (!shownP || Math.abs(dp.az - shownP.az) > 0.02 || Math.abs(dp.el - shownP.el) > 0.02)) {
        shownP = { ...dp };
        setPointing(shownP);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [follow, decl]);

  const startFollow = async () => {
    setOrientMsg(null);
    setFrameUp(null); // follow framing is az/el-based; drop any carried up
    let eulerStarted = false;
    const startEuler = () => {
      if (eulerStarted || handlerRef.current) return;
      eulerStarted = true;
      handlerRef.current = onOrient;
      window.addEventListener('deviceorientationabsolute', onOrient, true);
      // Android Chrome fires BOTH event types for the same
      // physical readings, and running both through the median
      // and low-pass filters double-processes every sample.
      // Prefer the absolute event; add the plain one only if
      // the absolute one stays silent.
      setTimeout(() => {
        if (handlerRef.current === onOrient && !absSeenRef.current) {
          window.addEventListener('deviceorientation', onOrient, true);
        }
      }, 1200);
    };
    const onOrient = (e) => {
      if (e.type === 'deviceorientationabsolute') absSeenRef.current = true;
      else if (absSeenRef.current) return; // duplicate of an absolute reading
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
    // The Euler flow, permission step included — taken only when
    // there is no fused sensor. iOS needs the permission dance.
    // It must NOT run first: desktop Chrome ships a
    // requestPermission that answers 'not granted' on sensor-less
    // machines even though that says nothing about the fused
    // sensor, and asking it first used to veto follow mode before
    // the fused attempt ever ran.
    const startEulerFlow = async () => {
      if (typeof DeviceOrientationEvent === 'undefined') {
        setOrientMsg('This browser does not share a compass — the view stays as framed.');
        return false;
      }
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        try {
          const res = await DeviceOrientationEvent.requestPermission();
          if (res !== 'granted') {
            setOrientMsg('Compass permission was not granted — the view stays as framed.');
            return false;
          }
        } catch {
          setOrientMsg('Compass permission failed — the view stays as framed.');
          return false;
        }
      }
      startEuler();
      return true;
    };
    // Fused orientation first: the OS sensor fusion (gyro +
    // accelerometer + magnetometer) as one quaternion — the same
    // source native finder apps use, and much steadier than the
    // Euler events, which stay as the fallback for browsers
    // without the sensor (iOS, Firefox) or if it errors out.
    let fusedStarted = false;
    if ('AbsoluteOrientationSensor' in window) {
      try {
        const sensor = new AbsoluteOrientationSensor({ frequency: 60 });
        sensor.addEventListener('reading', () => {
          if (sensor.quaternion) {
            quatRef.current = [...sensor.quaternion];
            quatTimeRef.current = performance.now();
            gotSignalRef.current = true;
          }
        });
        sensor.addEventListener('error', () => {
          if (sensorRef.current === sensor) {
            sensorRef.current = null;
            fusedRef.current = false;
            quatRef.current = null;
            smoothQuatRef.current = null;
            startEuler();
          }
        });
        sensor.start();
        sensorRef.current = sensor;
        fusedRef.current = true;
        fusedStarted = true;
      } catch {
        fusedStarted = false;
      }
    }
    if (fusedStarted) {
      setFollow(true);
      // Run the Euler events as a hot spare from the start
      // (Alex, 2026-10-22: follow 'randomly stopped tracking'
      // twice in one session). The render loop prefers the
      // fused feed whenever its readings are fresh and uses
      // the spare only the moment they stall — a wedged or
      // background-throttled sensor no longer freezes the
      // view mid-session, and the source line in the follow
      // copy shows the switch when it happens.
      startEuler();
      setTimeout(() => {
        if (!gotSignalRef.current) {
          setOrientMsg('No compass signal so far — some browsers only share it over a secure connection or after location is allowed. The view follows once it arrives.');
        }
      }, 3000);
      return;
    }
    if (!(await startEulerFlow())) return;
    setFollow(true);
    setTimeout(() => {
      if (!gotSignalRef.current) {
        setOrientMsg('No compass signal so far — some browsers only share it over a secure connection or after location is allowed. The view follows once it arrives.');
      }
    }, 3000);
  };

  /* Camera pass-through (Alex, 2026-10-22): the phone's rear
     camera behind the chart, so you hold the phone at the sky
     and the track, landmarks and horizon line lie over the real
     view. Follow starts with it — a pass-through chart that
     does not track the phone would be pointless. Follow is
     kicked off first and synchronously, so iOS still counts
     its compass-permission ask as part of this tap. The stream
     stops with the toggle or when the view closes. */
  const startCamera = async () => {
    setCameraMsg(null);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraMsg('This browser does not offer a camera feed, so pass-through stays off.');
      return;
    }
    if (!follow) void startFollow();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOn(true);
    } catch {
      setCameraMsg('Camera permission was not granted — pass-through stays off.');
    }
  };

  /* ---- drag to look around, pinch to set the view width ---- */
  // The rendered sky frame in screen terms: its center and the
  // projection's focal length in pixels, from the SVG element
  // itself (the stage around it is bigger than the sky).
  const svgFrame = () => {
    const svg = stageRef.current?.querySelector('svg');
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width < 10) return null;
    return {
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      fPx: (rect.width / 2) / Math.tan(((fov / 2) * Math.PI) / 180),
    };
  };
  const screenOffset = (fr, x, y) => ({
    nx: (x - fr.cx) / fr.fPx,
    ny: -(y - fr.cy) / fr.fPx,
  });

  const onPointerDown = (e) => {
    if (e.target.closest('button')) return; // zoom controls keep their clicks
    stageRef.current.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Grabbing the window takes manual control back from follow mode
    // (stopFollow freezes the current aim as the manual center).
    if (follow) stopFollow();
    if (pointers.current.size === 1) {
      // Remember the sky direction under the finger; every move
      // then solves for the frame that keeps it there (grabPan).
      // The gesture carries the frame's up vector with it — that
      // is what keeps the field steady near the zenith.
      const fr = svgFrame();
      const off = fr ? screenOffset(fr, e.clientX, e.clientY) : null;
      const vf = frameFrom(dirVec(winCenterResolved.az, winCenterResolved.el), frameUp);
      gesture.current = {
        mode: 'winpan',
        sx: e.clientX, sy: e.clientY,
        grab: off ? screenPoint(vf, off.nx, off.ny) : null,
        C: vf.C, U: vf.U,
        moved: false, tapX: e.clientX, tapY: e.clientY,
      };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const cur = gesture.current;
      const vf = cur && cur.C
        ? { C: cur.C, U: cur.U }
        : frameFrom(dirVec(winCenterResolved.az, winCenterResolved.el), frameUp);
      gesture.current = {
        mode: 'winpinch',
        d0: Math.hypot(a.x - b.x, a.y - b.y),
        fov0: fov,
        C: vf.C, U: vf.U,
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
      if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 6) g.moved = true;
      if (g.moved && g.grab) {
        const fr = svgFrame();
        if (fr) {
          const off = screenOffset(fr, e.clientX, e.clientY);
          // Transport the frame, then bound its elevation by
          // rotating the whole frame (rigidly — up survives).
          const next = clampFrameEl(grabPan({ C: g.C, U: g.U }, g.grab, off.nx, off.ny), -50, 88);
          g.C = next.C;
          g.U = next.U;
          setFrameUp(next.U);
          setWinCenter(azElOf(next.C));
        }
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
          setFrameUp(null);
          setFov(55);
          lastTap.current = 0;
        } else {
          lastTap.current = now;
        }
      }
      gesture.current = null;
    } else if (pointers.current.size === 1) {
      // Pinch ends with one finger still down: re-grab the sky
      // under that finger at the current center and keep panning.
      const [p] = [...pointers.current.values()];
      const fr = svgFrame();
      const off = fr ? screenOffset(fr, p.x, p.y) : null;
      gesture.current = {
        mode: 'winpan',
        sx: p.x, sy: p.y,
        grab: off ? screenPoint({ C: g.C, U: g.U }, off.nx, off.ny) : null,
        C: g.C, U: g.U,
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
    <div
      className="sg-skyview"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="sg-skyview-panel">
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
        {cameraOn && (
          <video ref={videoRef} className="sg-skyview-video" autoPlay playsInline muted aria-hidden="true" />
        )}
        {!sky ? (
          <Text type="supporting">Loading the stars…</Text>
        ) : (
          <SkyWindow
            sky={sky}
            atTime={atTime}
            loc={loc}
            targets={withLive}
            center={{ az: quant(winCenterResolved.az), el: quant(winCenterResolved.el) }}
            up={frameUp}
            fov={Math.round(fov * 2) / 2}
            cameraOn={cameraOn}
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
            onClick={() => { setFov(55); setWinCenter(null); setFrameUp(null); }}
          />
        </HStack>
      </div>
      <VStack gap={2} className="sg-skyview-foot">
        {guidance && (
          <div className="sg-skyview-guidance">
            <Text weight="semibold">{guidance}</Text>
          </div>
        )}
        <HStack gap={2} vAlign="center">
          <Button
            variant={follow ? 'secondary' : 'primary'}
            size="sm"
            label={follow ? 'Stop following my phone' : 'Point my phone at it'}
            onClick={follow ? stopFollow : startFollow}
          />
          <Button
            variant="secondary"
            size="sm"
            label={cameraOn ? 'Stop camera' : 'Camera pass-through'}
            onClick={cameraOn ? stopCamera : startCamera}
          />
        </HStack>
        {orientMsg && <Text type="supporting">{orientMsg}</Text>}
        {cameraMsg && <Text type="supporting">{cameraMsg}</Text>}
        {cameraOn && (
          <Text type="supporting">
            Camera pass-through: your phone’s camera shows behind the chart. Phone cameras differ, so line the chart’s horizon up with the real horizon — pinch wider or narrower until they sit on each other, and the compass markers on the line point the way.
          </Text>
        )}
        <Text type="supporting">
          {follow
            ? `The view follows your phone: aim until the target sits in the center ring — the arrow points to it while it is off-screen. Magnetic north here is about ${Math.abs(decl).toFixed(0)}° ${decl < 0 ? 'west' : 'east'} of true north, corrected above. Phone compasses wobble, worst indoors; outdoors away from metal they settle.${sensorSrc ? ` Sensor source: ${sensorSrc === 'fused' ? 'fused sensors (gyro + compass)' : 'compass events only'}.` : ''}`
            : 'The patch of sky this view is aimed at, framed on the target. Drag to look around, pinch to widen or narrow the view; double-tap re-frames on the target. The ring marks the exact center.'}
        </Text>
        {primary?.path?.some((p) => p.vis === false) && (
          <Text type="supporting">
            Dotted line: the satellite is above the horizon there but not visible — in Earth’s shadow, or the sky still too bright. It lights up where the line turns solid.
          </Text>
        )}
      </VStack>
      </div>
    </div>,
    document.body,
  );
}
