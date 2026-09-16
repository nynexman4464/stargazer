import { useEffect, useRef } from 'react';

/* Static starfield — drawn once on mount (and on resize). No animation loop.
   Star positions come from a seeded PRNG so the pattern is identical on every
   draw; a resize never reshuffles the sky. */
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default function Starfield() {
  const ref = useRef(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const x = c.getContext('2d');

    const draw = () => {
      const rand = mulberry32(20260916);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (!w || !h) return;
      c.width = w * dpr;
      c.height = h * dpr;
      x.clearRect(0, 0, c.width, c.height);
      // star color from the theme token so it stays on-palette
      const star =
        getComputedStyle(document.documentElement)
          .getPropertyValue('--color-text-primary')
          .trim() || '#dfe6ff';
      const n = Math.min(220, Math.floor((w * h) / 2200));
      for (let i = 0; i < n; i++) {
        const sx = rand() * c.width;
        const sy = rand() * c.height;
        const r = (rand() * 1.4 + 0.3) * dpr;
        x.globalAlpha = 0.25 + rand() * 0.55;
        x.fillStyle = star;
        x.beginPath();
        x.arc(sx, sy, r, 0, 7);
        x.fill();
      }
      x.globalAlpha = 1;
    };

    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, []);

  return <canvas ref={ref} className="sg-stars" aria-hidden="true" />;
}
