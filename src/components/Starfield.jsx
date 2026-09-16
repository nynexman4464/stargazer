import { useEffect, useRef } from 'react';

/* Slow-drifting starfield. The star layout comes from a seeded PRNG so the
   pattern is identical on every load and never reshuffles; the stars then
   drift almost imperceptibly in one direction (a few pixels per second,
   wrapping at the edges), like the sky turning overhead. No twinkling.
   Honors prefers-reduced-motion with a single static frame, and pauses
   drawing while the hero is offscreen. */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DRIFT_PX_PER_SEC = 2.5;

export default function Starfield() {
  const ref = useRef(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const x = c.getContext('2d');
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let stars = [];
    let starColor = '#dfe6ff';
    let raf = 0;
    let onscreen = true;

    // Fixed sky layout; per-star speed varies slightly for a hint of depth.
    const layout = () => {
      const rand = mulberry32(20260916);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (!w || !h) return;
      c.width = w * dpr;
      c.height = h * dpr;
      starColor =
        getComputedStyle(document.documentElement)
          .getPropertyValue('--color-text-primary')
          .trim() || '#dfe6ff';
      const n = Math.min(220, Math.floor((w * h) / 2200));
      stars = [];
      for (let i = 0; i < n; i++) {
        const speed = DRIFT_PX_PER_SEC * dpr * (0.7 + rand() * 0.6);
        stars.push({
          bx: rand() * c.width,
          by: rand() * c.height,
          r: (rand() * 1.4 + 0.3) * dpr,
          a: 0.25 + rand() * 0.55,
          vx: speed,
          vy: -speed * 0.25,
        });
      }
    };

    const draw = (tSec) => {
      x.clearRect(0, 0, c.width, c.height);
      x.fillStyle = starColor;
      for (const s of stars) {
        let sx = (s.bx + s.vx * tSec) % c.width;
        let sy = (s.by + s.vy * tSec) % c.height;
        if (sx < 0) sx += c.width;
        if (sy < 0) sy += c.height;
        x.globalAlpha = s.a;
        x.beginPath();
        x.arc(sx, sy, s.r, 0, 7);
        x.fill();
      }
      x.globalAlpha = 1;
    };

    layout();
    if (reduceMotion) {
      draw(0);
    } else {
      const frame = (now) => {
        if (onscreen) draw(now / 1000);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    }

    const io = new IntersectionObserver(([entry]) => {
      onscreen = entry.isIntersecting;
    });
    io.observe(c);
    // Re-fit the canvas whenever its size changes for any reason (content
    // loading, window resize, URL bar showing/hiding). Without this, the
    // backing store can end up smaller than the element and the browser
    // stretches the bitmap — stars turn into streaks.
    const ro = new ResizeObserver(() => layout());
    ro.observe(c);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="sg-stars" aria-hidden="true" />;
}
