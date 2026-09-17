import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HStack } from '@astryxdesign/core/HStack';
import { Text } from '@astryxdesign/core/Text';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Icon } from '@astryxdesign/core/Icon';
import { ZoomIn, ZoomOut, Maximize2, X } from 'lucide-react';

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const DOUBLE_TAP_MS = 300;

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/* Fullscreen map viewer with zoom controls, drag-to-pan, pinch-to-zoom and
   double-tap to zoom. Built custom (rather than Astryx's Lightbox) because
   the eclipse path maps need explicit on-screen zoom buttons and pinch on
   mobile — the stock Lightbox only zooms via double-click/keyboard. */
export default function MapLightbox({ src, alt, caption, isOpen, onClose }) {
  const [view, setView] = useState({ s: 1, x: 0, y: 0 });
  const [nat, setNat] = useState(null); // natural image size, for pan clamping
  const stageRef = useRef(null);
  const pointers = useRef(new Map());
  const gesture = useRef(null);
  const lastTap = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;

  // Fresh view each time the lightbox opens (or the image changes).
  useEffect(() => {
    if (isOpen) {
      setView({ s: 1, x: 0, y: 0 });
      setNat(null);
    }
  }, [isOpen, src]);

  // Escape closes; background page can't scroll while open.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [isOpen, onClose]);

  // Keep the image from being dragged out of view. Coordinates are relative
  // to the stage center, matching the CSS transform below.
  const clampPan = useCallback(
    (s, x, y) => {
      const stage = stageRef.current;
      if (!stage || !nat) return { x, y };
      const r = stage.getBoundingClientRect();
      const fit = Math.min(r.width / nat.w, r.height / nat.h);
      const dw = nat.w * fit * s;
      const dh = nat.h * fit * s;
      const mx = Math.max(0, (dw - r.width) / 2);
      const my = Math.max(0, (dh - r.height) / 2);
      return { x: clamp(x, -mx, mx), y: clamp(y, -my, my) };
    },
    [nat],
  );

  // Zoom keeping the content point under (cx, cy) fixed. (cx, cy) are in
  // stage-center-relative px.
  const zoomAt = useCallback(
    (cx, cy, factor) => {
      const { s, x, y } = viewRef.current;
      const ns = clamp(s * factor, MIN_SCALE, MAX_SCALE);
      if (ns === s) return;
      const k = ns / s;
      const c = clampPan(ns, cx - (cx - x) * k, cy - (cy - y) * k);
      setView({ s: ns, ...c });
    },
    [clampPan],
  );

  const reset = useCallback(() => setView({ s: 1, x: 0, y: 0 }), []);

  const stagePoint = (clientX, clientY) => {
    const r = stageRef.current.getBoundingClientRect();
    return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
  };

  const onPointerDown = (e) => {
    stageRef.current.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      const p = stagePoint(e.clientX, e.clientY);
      gesture.current = {
        mode: 'pan',
        sx: e.clientX,
        sy: e.clientY,
        x0: viewRef.current.x,
        y0: viewRef.current.y,
        moved: false,
        tapX: p.x,
        tapY: p.y,
      };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const m = stagePoint((a.x + b.x) / 2, (a.y + b.y) / 2);
      gesture.current = {
        mode: 'pinch',
        d0: Math.hypot(a.x - b.x, a.y - b.y),
        s0: viewRef.current.s,
        mx0: m.x,
        my0: m.y,
        x0: viewRef.current.x,
        y0: viewRef.current.y,
      };
    }
  };

  const onPointerMove = (e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    if (g.mode === 'pan' && pointers.current.size === 1) {
      const dx = e.clientX - g.sx;
      const dy = e.clientY - g.sy;
      if (Math.hypot(dx, dy) > 6) g.moved = true;
      if (viewRef.current.s > MIN_SCALE) {
        const c = clampPan(viewRef.current.s, g.x0 + dx, g.y0 + dy);
        setView({ s: viewRef.current.s, ...c });
      }
    } else if (g.mode === 'pinch' && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d1 = Math.hypot(a.x - b.x, a.y - b.y);
      if (d1 < 1 || g.d0 < 1) return;
      const m = stagePoint((a.x + b.x) / 2, (a.y + b.y) / 2);
      const ns = clamp(g.s0 * (d1 / g.d0), MIN_SCALE, MAX_SCALE);
      const k = ns / g.s0;
      const c = clampPan(ns, m.x - (g.mx0 - g.x0) * k, m.y - (g.my0 - g.y0) * k);
      setView({ s: ns, ...c });
      g.moved = true;
    }
  };

  const onPointerUp = (e) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g && g.mode === 'pan' && pointers.current.size === 0) {
      const now = Date.now();
      if (!g.moved && now - lastTap.current < DOUBLE_TAP_MS) {
        // Double-tap toggles between fit and 2.5x, anchored at the tap.
        if (viewRef.current.s <= MIN_SCALE + 0.01) zoomAt(g.tapX, g.tapY, 2.5);
        else reset();
        lastTap.current = 0;
      } else if (!g.moved) {
        lastTap.current = now;
      }
      gesture.current = null;
    } else if (pointers.current.size === 1) {
      // Pinch ended with one finger still down: re-anchor it as a pan so
      // the image doesn't jump.
      const [p] = [...pointers.current.values()];
      gesture.current = {
        mode: 'pan',
        sx: p.x,
        sy: p.y,
        x0: viewRef.current.x,
        y0: viewRef.current.y,
        moved: true,
      };
    } else if (pointers.current.size === 0) {
      gesture.current = null;
    }
  };

  // Wheel zoom on desktop (non-passive so we can prevent page scroll).
  useEffect(() => {
    if (!isOpen) return;
    const stage = stageRef.current;
    const onWheel = (e) => {
      e.preventDefault();
      const p = stagePoint(e.clientX, e.clientY);
      zoomAt(p.x, p.y, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [isOpen, zoomAt]);

  if (!isOpen) return null;
  return createPortal(
    <div className="sg-lightbox" role="dialog" aria-modal="true" aria-label={alt}>
      <div className="sg-lightbox-backdrop" onClick={onClose} />
      <div
        ref={stageRef}
        className="sg-lightbox-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          className="sg-lightbox-img"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` }}
          onLoad={(e) =>
            setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })
          }
        />
      </div>
      <HStack gap={1} vAlign="center" className="sg-lightbox-topbar">
          <Text type="supporting" className="sg-lightbox-pct">
            {Math.round(view.s * 100)}%
          </Text>
          <IconButton
            icon={<Icon icon={ZoomOut} size="sm" />}
            label="Zoom out"
            variant="ghost"
            size="sm"
            isDisabled={view.s <= MIN_SCALE + 0.01}
            onClick={() => zoomAt(0, 0, 1 / 1.5)}
          />
          <IconButton
            icon={<Icon icon={ZoomIn} size="sm" />}
            label="Zoom in"
            variant="ghost"
            size="sm"
            isDisabled={view.s >= MAX_SCALE - 0.01}
            onClick={() => zoomAt(0, 0, 1.5)}
          />
          <IconButton
            icon={<Icon icon={Maximize2} size="sm" />}
            label="Reset zoom"
            variant="ghost"
            size="sm"
            isDisabled={view.s <= MIN_SCALE + 0.01}
            onClick={reset}
          />
          <IconButton
            icon={<Icon icon={X} size="sm" />}
            label="Close map viewer"
            variant="ghost"
            size="sm"
            onClick={onClose}
          />
        </HStack>
      {caption && (
        <Text type="supporting" className="sg-lightbox-caption">
          {caption}
        </Text>
      )}
    </div>,
    document.body,
  );
}
