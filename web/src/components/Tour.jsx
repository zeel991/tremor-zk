import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { ArrowLeft, ArrowRight, X } from '@phosphor-icons/react';

/* Guided product tour: dims the page, spotlights one element (found by [data-tour="id"]) and
   explains it in a small card with Back / Next / Skip. Keyboard: arrows, Enter, Esc.
   Steps whose element isn't on screen (e.g. hidden on phones) are skipped. */

const ease = [0.16, 1, 0.3, 1];
const PAD = 8;

function rectOf(id) {
  const el = document.querySelector(`[data-tour="${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { el, top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
}

export function Tour({ steps, open, onClose, onFinish }) {
  const reduce = useReducedMotion();
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const [vw, setVw] = useState(() => window.innerWidth);
  const visible = open ? steps.filter((s) => !s.target || rectOf(s.target)) : steps;
  const step = visible[Math.min(i, visible.length - 1)];
  const last = i >= visible.length - 1;

  useEffect(() => { if (open) setI(0); }, [open]);

  const measure = useCallback(() => {
    setVw(window.innerWidth);
    setRect(step?.target ? rectOf(step.target) : null);
  }, [step]);

  // Bring the target into view, then measure; keep measuring while the page moves.
  useLayoutEffect(() => {
    if (!open || !step) return;
    const r = step.target && rectOf(step.target);
    if (r) {
      const off = r.top < 80 || r.top + r.height > window.innerHeight - 220;
      if (off) r.el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    }
    measure();
    const t = setTimeout(measure, 380);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { clearTimeout(t); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [open, step, measure, reduce]);

  const next = useCallback(() => { if (last) { onClose(); onFinish?.(step); } else setI((x) => x + 1); }, [last, onClose, onFinish, step]);
  const back = useCallback(() => setI((x) => Math.max(0, x - 1)), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, next, back, onClose]);

  if (!open || !step) return null;

  // Card placement: docked at the bottom on phones; otherwise below the target, or above if no room.
  const mobile = vw < 640;
  const CARD_W = Math.min(380, vw - 32);
  let style;
  if (mobile || !rect) {
    style = mobile ? { left: 16, right: 16, bottom: 16 } : { left: '50%', top: '50%', transform: 'translate(-50%,-50%)', width: CARD_W };
  } else {
    const below = rect.top + rect.height + 12;
    const fitsBelow = below + 230 < window.innerHeight;
    const left = Math.max(16, Math.min(rect.left, vw - CARD_W - 16));
    style = fitsBelow ? { top: below, left, width: CARD_W } : { top: Math.max(16, rect.top - 12 - 230), left, width: CARD_W };
  }

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      {/* Spotlight: a hole in a dark overlay made with a huge box-shadow. Clicks outside do nothing. */}
      {rect ? (
        <motion.div
          className="pointer-events-none absolute rounded-xl border border-accent/80"
          initial={false}
          animate={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
          transition={reduce ? { duration: 0 } : { duration: 0.4, ease }}
          style={{ boxShadow: '0 0 0 9999px rgba(5,5,5,.72)' }}
        />
      ) : <div className="absolute inset-0 bg-[rgba(5,5,5,.72)]" />}

      <AnimatePresence mode="wait">
        <motion.div
          key={i}
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? undefined : { opacity: 0, y: -6 }}
          transition={{ duration: 0.25, ease }}
          className="absolute rounded-2xl border border-line bg-bg-2 p-5 text-ink shadow-[0_20px_60px_rgba(0,0,0,.5)]"
          style={style}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="micro text-accent">Step {i + 1} of {visible.length}</span>
            <button onClick={onClose} aria-label="Close the guide" className="grid size-8 place-items-center rounded-full text-ink-3 hover:bg-white/5 hover:text-ink"><X size={16} /></button>
          </div>
          <h3 id="tour-title" className="mt-2 text-lg font-medium tracking-tight">{step.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-ink-2">{step.body}</p>
          <div className="mt-4 flex gap-1.5" aria-hidden="true">
            {visible.map((_, k) => <span key={k} className={`h-1 flex-1 rounded-full ${k <= i ? 'bg-accent' : 'bg-line'}`} />)}
          </div>
          <div className="mt-5 flex items-center justify-between gap-3">
            {i > 0 ? <button onClick={back} className="btn btn-ghost !px-4 !py-2 text-sm"><ArrowLeft size={15} /> Back</button> : <button onClick={onClose} className="text-sm text-ink-3 hover:text-ink">Skip guide</button>}
            <button onClick={next} autoFocus className="btn btn-primary !px-4 !py-2 text-sm">{last ? (step.cta || 'Done') : <>Next <ArrowRight size={15} weight="bold" /></>}</button>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/** Small first-visit invitation, bottom corner. */
export function TourPrompt({ show, onStart, onDismiss }) {
  const reduce = useReducedMotion();
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 16 }}
          transition={{ duration: 0.4, ease, delay: reduce ? 0 : 0.8 }}
          className="fixed inset-x-4 bottom-4 z-50 rounded-2xl border border-line bg-bg-2 p-4 shadow-[0_20px_60px_rgba(0,0,0,.5)] sm:left-auto sm:right-6 sm:bottom-6 sm:w-[340px]"
          role="status"
        >
          <div className="text-sm font-medium">New to Tremor?</div>
          <p className="mt-1 text-sm text-ink-2">A 30-second guide shows where everything is, then runs the demo for you.</p>
          <div className="mt-3 flex items-center gap-3">
            <button onClick={onStart} className="btn btn-primary !px-4 !py-2 text-sm">Take the tour</button>
            <button onClick={onDismiss} className="text-sm text-ink-3 hover:text-ink">Not now</button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
