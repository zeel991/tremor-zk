import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

/**
 * Live seismograph line. Calm noise by default; `pulse(strength)` injects a decaying spike
 * (a verified receipt), `flat()` dampens it (a fake). Animation lives on a canvas, outside React state.
 */
export const Seismograph = forwardRef(function Seismograph({ className = '', height = 160, intensity = 1 }, ref) {
  const canvas = useRef(null);
  const energy = useRef(0);
  const damp = useRef(1);

  useImperativeHandle(ref, () => ({
    pulse(strength = 1) { energy.current = Math.min(1.6, energy.current + strength); damp.current = 1; },
    flat() { damp.current = 0.15; },
  }));

  useEffect(() => {
    const c = canvas.current;
    const ctx = c.getContext('2d');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf, t = 0, w = 0, h = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const points = [];
    const resize = () => {
      w = c.clientWidth; h = c.clientHeight;
      c.width = w * dpr; c.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      points.length = Math.ceil(w / 3) + 2; points.fill(0);
    };
    const ro = new ResizeObserver(resize); ro.observe(c); resize();
    const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff5b22';
    const line = () => getComputedStyle(document.documentElement).getPropertyValue('--line').trim() || '#26282b';

    const draw = () => {
      t += 1;
      const e = energy.current;
      // next sample: small noise plus a burst when energy is high
      // calm tremor: smooth low-frequency wobble plus jitter, so the line visibly lives
      const noise = (Math.sin(t * 0.07) * 2.2 + Math.sin(t * 0.23) * 1.4 + (Math.random() - 0.5) * 4) * intensity * damp.current;
      const burst = e > 0.02 ? Math.sin(t * 0.9) * e * (h * 0.38) * (0.6 + Math.random() * 0.4) : 0;
      points.push(noise + burst);
      points.shift();
      energy.current *= 0.955;
      if (damp.current < 1) damp.current = Math.min(1, damp.current + 0.004);

      ctx.clearRect(0, 0, w, h);
      // baseline grid
      ctx.strokeStyle = line(); ctx.lineWidth = 1; ctx.beginPath();
      for (let y = h * 0.25; y < h; y += h * 0.25) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();
      // trace
      ctx.strokeStyle = accent(); ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.beginPath();
      points.forEach((p, i) => { const x = i * 3, y = h / 2 + p; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke();
      // write head
      const last = points[points.length - 1];
      ctx.fillStyle = accent(); ctx.beginPath(); ctx.arc((points.length - 1) * 3, h / 2 + last, 3, 0, Math.PI * 2); ctx.fill();
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [intensity]);

  return <canvas ref={canvas} className={`block w-full ${className}`} style={{ height }} aria-hidden="true" />;
});
