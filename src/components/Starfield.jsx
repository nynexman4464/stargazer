import { useEffect, useRef } from 'react';

/* Static starfield — drawn once on mount (and on resize). No animation loop. */
export default function Starfield() {
  const ref = useRef(null);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const x = c.getContext('2d');

    const draw = () => {
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
        const sx = Math.random() * c.width;
        const sy = Math.random() * c.height;
        const r = (Math.random() * 1.4 + 0.3) * dpr;
        x.globalAlpha = 0.25 + Math.random() * 0.55;
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
