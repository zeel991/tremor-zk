import { useEffect, useRef } from 'react';
import { motion, useMotionValue, useSpring, useTransform, useReducedMotion, useInView, animate } from 'motion/react';
import Lenis from 'lenis';

const ease = [0.16, 1, 0.3, 1];

/** Smooth scrolling (Lenis). Off under reduced motion. Anchor links keep working. */
export function useSmoothScroll() {
  const reduce = useReducedMotion();
  useEffect(() => {
    if (reduce) return;
    const lenis = new Lenis({ duration: 1.15, smoothWheel: true });
    let raf;
    const loop = (t) => { lenis.raf(t); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    const onClick = (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (!a) return;
      const el = document.querySelector(a.getAttribute('href'));
      if (el) { e.preventDefault(); lenis.scrollTo(el, { offset: -72 }); }
    };
    document.addEventListener('click', onClick);
    return () => { cancelAnimationFrame(raf); document.removeEventListener('click', onClick); lenis.destroy(); };
  }, [reduce]);
}

/** Headline that rises word by word out of a mask. Text stays real text for a11y and SEO. */
export function KineticText({ text, accent = [], className = '', delay = 0 }) {
  const reduce = useReducedMotion();
  const words = text.split(' ');
  return (
    <span className={className} aria-label={text}>
      {words.map((w, i) => (
        <span key={i} aria-hidden="true" className="inline-block overflow-hidden pb-[0.08em] align-bottom">
          <motion.span
            className={`inline-block ${accent.includes(i) ? 'text-accent' : ''}`}
            initial={reduce ? false : { y: '110%', rotate: 6 }}
            animate={{ y: '0%', rotate: 0 }}
            transition={{ duration: 0.9, delay: delay + i * 0.07, ease }}
          >
            {w}
          </motion.span>
          {i < words.length - 1 && ' '}
        </span>
      ))}
    </span>
  );
}

/** Button/link that leans toward the cursor (spring physics, motion values only). */
export function Magnetic({ children, strength = 0.35, className = '', ...rest }) {
  const ref = useRef(null);
  const reduce = useReducedMotion();
  const x = useMotionValue(0), y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 220, damping: 16, mass: 0.4 });
  const sy = useSpring(y, { stiffness: 220, damping: 16, mass: 0.4 });
  const onMove = (e) => {
    if (reduce) return;
    const r = ref.current.getBoundingClientRect();
    x.set((e.clientX - (r.left + r.width / 2)) * strength);
    y.set((e.clientY - (r.top + r.height / 2)) * strength);
  };
  const reset = () => { x.set(0); y.set(0); };
  return (
    <motion.a ref={ref} style={{ x: sx, y: sy }} onMouseMove={onMove} onMouseLeave={reset} className={className} {...rest}>
      {children}
    </motion.a>
  );
}

/** Card that tilts in 3D under the cursor with a spotlight following it. */
export function TiltCard({ children, className = '', max = 9 }) {
  const ref = useRef(null);
  const reduce = useReducedMotion();
  const px = useMotionValue(0.5), py = useMotionValue(0.5);
  const rx = useSpring(useTransform(py, [0, 1], [max, -max]), { stiffness: 160, damping: 18 });
  const ry = useSpring(useTransform(px, [0, 1], [-max, max]), { stiffness: 160, damping: 18 });
  const glowX = useTransform(px, (v) => `${v * 100}%`);
  const glowY = useTransform(py, (v) => `${v * 100}%`);
  const onMove = (e) => {
    if (reduce) return;
    const r = ref.current.getBoundingClientRect();
    px.set((e.clientX - r.left) / r.width); py.set((e.clientY - r.top) / r.height);
  };
  return (
    <motion.div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={() => { px.set(0.5); py.set(0.5); }}
      style={{ rotateX: reduce ? 0 : rx, rotateY: reduce ? 0 : ry, transformPerspective: 900, '--gx': glowX, '--gy': glowY }}
      className={`group relative [transform-style:preserve-3d] ${className}`}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{ background: 'radial-gradient(420px circle at var(--gx) var(--gy), color-mix(in srgb, var(--accent) 16%, transparent), transparent 60%)' }}
      />
      <div className="relative [transform:translateZ(28px)]">{children}</div>
    </motion.div>
  );
}

/** Number that counts up when it scrolls into view. Keeps decimals and suffix from the source string. */
export function CountUp({ value, className = '' }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const reduce = useReducedMotion();
  const m = /^([\d.]+)(.*)$/.exec(value) || [null, value, ''];
  const target = parseFloat(m[1]); const suffix = m[2]; const decimals = (m[1].split('.')[1] || '').length;
  useEffect(() => {
    if (!inView || !ref.current || Number.isNaN(target)) return;
    if (reduce) { ref.current.textContent = value; return; }
    const c = animate(0, target, { duration: 1.6, ease, onUpdate: (v) => { if (ref.current) ref.current.textContent = v.toFixed(decimals) + suffix; } });
    return () => c.stop();
  }, [inView, target, suffix, decimals, value, reduce]);
  return <span ref={ref} className={className}>{Number.isNaN(target) ? value : `0${suffix}`}</span>;
}
