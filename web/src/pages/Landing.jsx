import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  motion, useReducedMotion, useScroll, useSpring, useTransform, useVelocity, useMotionValue,
  useAnimationFrame, useInView, AnimatePresence,
} from 'motion/react';
import { ArrowUpRight, ArrowDown, ArrowRight, Waveform, GithubLogo, CheckCircle, XCircle, Plus, Minus } from '@phosphor-icons/react';
import { Seismograph } from '../components/Seismograph.jsx';
import { Magnetic, CountUp, useSmoothScroll } from '../components/fx.jsx';

const Hero3D = lazy(() => import('../components/Hero3D.jsx'));
function webglOk() { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } }

const ease = [0.16, 1, 0.3, 1];
const APP = '/app'; // full page load: the app needs cross-origin isolation headers
const SECTIONS = [['how', 'Process'], ['privacy', 'Privacy'], ['trust', 'Trust'], ['faq', 'FAQ']];

/* ------------------------------------------------------------------ primitives */

function Reveal({ children, delay = 0, className = '', y = 28 }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.8, delay, ease }}
    >
      {children}
    </motion.div>
  );
}

/** One line of display type that rises out of a mask. */
function MaskLine({ children, delay = 0, className = '' }) {
  const reduce = useReducedMotion();
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, amount: 0.3 }); // observe the mask, not the hidden line
  return (
    <span ref={ref} className="block overflow-hidden pb-[0.04em]">
      <motion.span
        className={`block ${className}`}
        initial={reduce ? false : { y: '105%' }}
        animate={inView ? { y: '0%' } : undefined}
        transition={{ duration: 1, delay, ease }}
      >
        {children}
      </motion.span>
    </span>
  );
}

const wrap = (min, max, v) => { const r = max - min; return ((((v - min) % r) + r) % r) + min; };

/** Marquee whose speed and direction follow the scroll velocity. */
function VelocityMarquee({ children, base = 3, className = '' }) {
  const reduce = useReducedMotion();
  const baseX = useMotionValue(0);
  const { scrollY } = useScroll();
  const vel = useSpring(useVelocity(scrollY), { damping: 50, stiffness: 400 });
  const factor = useTransform(vel, [0, 1000], [0, 5], { clamp: false });
  const dir = useRef(1);
  const x = useTransform(baseX, (v) => `${wrap(-50, 0, v)}%`);
  useAnimationFrame((_, delta) => {
    if (reduce) return;
    let move = dir.current * base * (delta / 1000);
    const f = factor.get();
    if (f < 0) dir.current = -1; else if (f > 0) dir.current = 1;
    move += dir.current * move * f;
    baseX.set(baseX.get() + move);
  });
  return (
    <div aria-hidden="true" className={`overflow-hidden whitespace-nowrap ${className}`}>
      <motion.div style={{ x }} className="flex w-max">
        <div className="flex shrink-0">{children}</div>
        <div className="flex shrink-0">{children}</div>
      </motion.div>
    </div>
  );
}

/** Section header: hairline, two-line uppercase title left, micro label centre, arrow right. */
function SectionHead({ title, label, id }) {
  return (
    <div id={id} className="mx-auto max-w-[1400px] scroll-mt-6 px-4 md:px-6">
      <div className="grid grid-cols-[1fr_auto] items-start gap-4 border-t border-accent/40 pt-4 md:grid-cols-[1fr_1fr_1fr]">
        <h2 className="max-w-[18ch] text-[1.05rem] leading-[1.05] font-medium uppercase tracking-tight md:text-[1.35rem]">{title}</h2>
        <span className="micro hidden text-ink-3 md:block md:text-center">{label}</span>
        <ArrowDown size={16} className="justify-self-end text-ink-2" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ top bar + dock */

function TopBar() {
  return (
    <header className="absolute inset-x-0 top-0 z-30">
      <nav className="mx-auto grid h-16 max-w-[1400px] grid-cols-[auto_1fr_auto] items-center gap-6 px-4 md:grid-cols-[1fr_auto_1fr] md:px-6">
        <div className="flex items-center gap-5">
          <a href="/" className="display text-[1.35rem] text-ink">Tremor</a>
          <span className="micro hidden leading-tight text-ink-3 lg:block">Receipts that<br />prove themselves</span>
        </div>
        <Waveform size={22} weight="bold" className="hidden text-accent md:block" />
        <div className="flex items-center justify-end gap-6">
          <ul className="micro hidden items-center gap-5 text-ink-2 md:flex">
            {SECTIONS.map(([id, l]) => (
              <li key={id}><a href={`#${id}`} className="flex items-center gap-2 hover:text-accent"><span className="box" />{l}</a></li>
            ))}
          </ul>
          <a href={APP} className="btn btn-ghost !py-2 !px-4">Launch app</a>
        </div>
      </nav>
    </header>
  );
}

function Dock() {
  const [active, setActive] = useState(null);
  const [show, setShow] = useState(false);
  const reduce = useReducedMotion();
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > window.innerHeight * 0.7);
    onScroll(); window.addEventListener('scroll', onScroll, { passive: true });
    const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && setActive(e.target.id)), { rootMargin: '-40% 0px -55% 0px' });
    SECTIONS.forEach(([id]) => { const el = document.getElementById(id); if (el) io.observe(el); });
    return () => { window.removeEventListener('scroll', onScroll); io.disconnect(); };
  }, []);
  return (
    <AnimatePresence>
      {show && (
        <motion.nav
          initial={reduce ? { opacity: 0 } : { y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={reduce ? { opacity: 0 } : { y: 80, opacity: 0 }}
          transition={{ duration: 0.5, ease }}
          className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-max items-center gap-1 rounded-full border border-ink/40 bg-bg/85 p-1.5 backdrop-blur-md"
        >
          {SECTIONS.map(([id, l]) => (
            <a key={id} href={`#${id}`} aria-label={l} className={`micro flex items-center gap-2 rounded-full px-2.5 py-2 transition-colors sm:px-3 ${active === id ? 'text-accent' : 'text-ink-2 hover:text-ink'}`}>
              <span className={`box ${active === id ? 'box-on' : ''}`} /><span className={active === id ? '' : 'hidden sm:inline'}>{l}</span>
            </a>
          ))}
          <a href={APP} className="btn btn-primary ml-1 !py-2 !px-3.5 !text-[.66rem]">App <ArrowUpRight size={12} weight="bold" /></a>
        </motion.nav>
      )}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------ hero */

// Illustrative feed for the hero visual (example data, labelled as such).
const FEED = [
  { real: true, merchant: 'Uber', domain: 'uber.com', amount: '₹412.00', when: 'Trip, 14 Nov' },
  { real: false, merchant: 'Image upload', domain: 'no signature', amount: '₹9,800.00', when: 'AI-generated receipt' },
  { real: true, merchant: 'Swiggy', domain: 'swiggy.in', amount: '₹1,249.50', when: 'Team lunch, 15 Nov' },
  { real: false, merchant: 'Edited email', domain: 'body hash mismatch', amount: '₹2,412.00', when: 'Amount changed by hand' },
  { real: true, merchant: 'Amazon.in', domain: 'amazon.in', amount: '₹2,999.00', when: 'Office supplies' },
];

function Hero() {
  const reduce = useReducedMotion();
  const [i, setI] = useState(0);
  const [use3d] = useState(() => !reduce && webglOk());
  const ref = useRef(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  const lift = useTransform(scrollYProgress, [0, 1], ['0%', '-18%']);
  const fade = useTransform(scrollYProgress, [0, 0.8], [1, 0]);
  useEffect(() => { const id = setInterval(() => setI((x) => (x + 1) % FEED.length), 4200); return () => clearInterval(id); }, []);
  const r = FEED[i];
  const size = 'text-[clamp(2rem,10.6vw,12rem)]';
  return (
    <section ref={ref} className="relative isolate flex min-h-[100dvh] flex-col overflow-hidden">
      <TopBar />
      {use3d && (
        <motion.div style={{ opacity: fade }} className="absolute inset-x-0 top-[26%] -z-10 h-[46%] md:inset-0 md:h-auto">
          <Suspense fallback={null}><Hero3D feed={FEED} index={i} /></Suspense>
        </motion.div>
      )}
      {/* halftone patch, shaped like a fading cloud on the right */}
      <div aria-hidden="true" className="halftone pointer-events-none absolute -right-10 top-10 -z-20 h-[70%] w-[55%] opacity-60 [mask-image:radial-gradient(closest-side,black,transparent)]" />

      <motion.div style={{ y: reduce ? 0 : lift }} className="mx-auto w-full max-w-[1400px] flex-1 px-4 pt-24 md:px-6 md:pt-28">
        <h1 aria-label="Receipts that can't be faked" className={`display ${size}`}>
          <MaskLine className="outline">Receipts</MaskLine>
          <MaskLine delay={0.08} className="text-accent">That can’t</MaskLine>
          <MaskLine delay={0.16}><span className="text-ink">Be</span> <span className="outline-ink">faked</span></MaskLine>
        </h1>
      </motion.div>

      <div className="mx-auto w-full max-w-[1400px] px-4 pb-8 md:px-6">
        <div className="grid items-end gap-6 border-t border-accent/40 pt-5 md:grid-cols-[1fr_1.2fr_1fr]">
          <div className="h-6" aria-live="polite">
            <AnimatePresence mode="wait">
              <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.4, ease }} className="micro flex items-center gap-2 text-ink-2">
                {r.real ? <CheckCircle size={14} weight="fill" className="text-ok" /> : <XCircle size={14} weight="fill" className="text-bad" />}
                <span className="text-ink">{r.merchant} {r.amount}</span>
                <span className="truncate">{r.real ? `signed by ${r.domain}` : r.domain}</span>
              </motion.div>
            </AnimatePresence>
          </div>
          <motion.p initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1, delay: 0.5 }} className="micro mx-auto max-w-[52ch] text-center leading-relaxed text-ink-2 md:!text-[.72rem]">
            Tremor pays an expense only when the merchant’s own email signature proves the total. Proven in your browser with zero knowledge, verified on zkVerify, paid in USDC on Base.
          </motion.p>
          <div className="flex flex-wrap gap-2 md:justify-end">
            <Magnetic href={APP} className="btn btn-primary">Prove a receipt <ArrowRight size={14} weight="bold" /></Magnetic>
            <Magnetic href="#how" strength={0.2} className="btn btn-ghost">How it works</Magnetic>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ bands */

function Band() {
  const words = ['Proven', 'not trusted', 'Signed', 'not scanned', 'Private', 'not shared'];
  return (
    <VelocityMarquee base={2.2} className="border-y border-accent/30 py-4 md:py-6">
      {words.map((w, k) => (
        <span key={k} className={`display flex items-center px-4 text-[clamp(2.4rem,7vw,6.5rem)] md:px-8 ${k % 2 ? 'outline' : 'text-accent'}`}>
          {w}<span className="ml-8 text-[.4em] text-ink md:ml-16">✦</span>
        </span>
      ))}
    </VelocityMarquee>
  );
}

/* ------------------------------------------------------------------ problem + proof panel */

function Problem() {
  return (
    <section className="py-24 md:py-36">
      <SectionHead title={<>A photo proves<br />nothing</>} label="The problem" />
      <div className="mx-auto grid max-w-[1400px] gap-10 px-4 pt-14 md:grid-cols-[1.4fr_1fr] md:px-6 md:pt-20">
        <h3 className="display text-[clamp(2.2rem,5.4vw,5.6rem)]">
          <MaskLine>Image models</MaskLine>
          <MaskLine delay={0.06} className="outline">fake receipts.</MaskLine>
          <MaskLine delay={0.12} className="text-accent">Signatures</MaskLine>
          <MaskLine delay={0.18}>don’t lie.</MaskLine>
        </h3>
        <Reveal delay={0.15} className="grid content-end gap-6 text-ink-2 md:pb-3">
          <p className="max-w-[48ch] leading-relaxed">Image models now write receipts with the right logo, layout and tax lines. A reviewer can’t tell them apart, and a PDF can’t say where it came from.</p>
          <p className="max-w-[48ch] leading-relaxed">Uber, Swiggy and Amazon sign every receipt email with DKIM, an RSA signature from their domain over the headers and body. Change one digit and the signature breaks. Tremor turns that signature into proof.</p>
        </Reveal>
      </div>
    </section>
  );
}

const PROVES = [
  ['Signature', 'The email was signed by the merchant key the vault trusts. RSA-2048, checked inside the circuit.'],
  ['Total', 'The signed body contains the merchant’s total line, and the amount is parsed from those bytes.'],
  ['Date', 'The signed Date header, parsed to Unix time with its zone, so caps and windows hold.'],
  ['Inbox', 'It went to your registered address, committed with a salt. The address itself stays hidden.'],
  ['Once', 'A salted nullifier marks the receipt spent. The merchant can’t compute it or link it to you.'],
];

function ProofPanel() {
  return (
    <section className="mx-auto max-w-[1400px] px-2 md:px-4">
      <Reveal className="rounded-[22px] bg-paper p-5 text-paper-ink md:rounded-[28px] md:p-10">
        <div className="flex items-start justify-between gap-6">
          <h2 className="display text-[clamp(2rem,4.6vw,4.4rem)]">One proof<br />shows five things</h2>
          <span className="micro hidden text-right text-paper-ink/60 md:block">Noir circuit<br />UltraHonk ZK · V5_0</span>
        </div>
        <div className="mt-10 grid border-t border-paper-ink/20 sm:grid-cols-2 lg:grid-cols-5 md:mt-16">
          {PROVES.map(([t, d], k) => (
            <motion.div
              key={t}
              initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.4 }} transition={{ duration: 0.6, delay: k * 0.07, ease }}
              className="group relative border-b border-paper-ink/20 py-6 pr-6 sm:[&:nth-child(odd)]:border-r lg:border-b-0 lg:border-r lg:last:border-r-0 lg:pl-5 lg:first:pl-0"
            >
              <div className="micro flex items-center justify-between text-paper-ink/55"><span>( 0{k + 1} )</span><span className="box" /></div>
              <div className="display mt-10 text-[1.8rem] transition-colors group-hover:text-[#b4387f] md:mt-16">{t}</div>
              <p className="mt-3 text-sm leading-relaxed text-paper-ink/70">{d}</p>
            </motion.div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}

/* ------------------------------------------------------------------ process (sticky stack) */

const STEPS = [
  ['Drop the email', 'Open the .eml in your browser. It is parsed and checked against the merchant’s DKIM key, on your device.'],
  ['Prove it in the tab', 'A Noir circuit proves the signature, the total, the date and your inbox. About 4 seconds with threads, 11 on one.'],
  ['zkVerify checks it', 'Only the proof and nine public values are submitted. zkVerify verifies it and aggregates the result to Base.'],
  ['The vault pays', 'A contract re-checks the merchant key, your wallet, the date, the caps and the nullifier, then sends USDC.'],
];

function StackCard({ step, i, total, progress }) {
  const reduce = useReducedMotion();
  const start = i / total, end = (i + 1) / total;
  const scale = useTransform(progress, [start, end], [1, 0.9]);
  const rotX = useTransform(progress, [start, end], [0, 10]);
  const shade = useTransform(progress, [start, end], [0, 0.7]);
  return (
    <div className="sticky h-[74vh] md:h-[64vh]" style={{ zIndex: i + 1, top: `calc(2rem + ${i * 1.6}rem)` }}>
      <motion.div style={reduce ? {} : { scale, rotateX: rotX, transformPerspective: 1200 }} className="frame relative h-full origin-top overflow-hidden bg-bg p-6 md:p-10">
        <div aria-hidden="true" className="halftone pointer-events-none absolute -right-20 -bottom-20 size-[28rem] opacity-50 [mask-image:radial-gradient(closest-side,black,transparent)]" />
        <div className="relative flex h-full flex-col justify-between">
          <div className="flex items-start justify-between">
            <span className="micro text-ink-3">Step</span>
            <span className="grip text-ink-3"><i /><i /><i /><i /><i /><i /></span>
          </div>
          <div className="display outline text-[clamp(5rem,16vw,13rem)] leading-[.8]">0{i + 1}</div>
          <div className="grid gap-4 border-t border-ink/20 pt-5 md:grid-cols-[1fr_1fr] md:items-end">
            <h3 className="display text-[clamp(1.9rem,4vw,3.6rem)]">{step[0]}</h3>
            <p className="max-w-[46ch] leading-relaxed text-ink-2">{step[1]}</p>
          </div>
        </div>
        {!reduce && i < total - 1 && <motion.div aria-hidden="true" style={{ opacity: shade }} className="pointer-events-none absolute inset-0 bg-bg" />}
      </motion.div>
    </div>
  );
}

function How() {
  const ref = useRef(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  return (
    <section className="pt-24 md:pt-36">
      <SectionHead id="how" title={<>From inbox<br />to USDC</>} label="Process" />
      <div className="mx-auto max-w-[1400px] px-4 pt-10 md:px-6">
        <p className="micro max-w-[60ch] leading-relaxed text-ink-2">Every step is checkable. Nothing in the chain trusts our server with the amount, the payee or the merchant.</p>
      </div>
      <div ref={ref} className="relative mx-auto mt-10 grid max-w-[1400px] gap-[12vh] px-4 pb-24 md:px-6">
        {STEPS.map((s, i) => <StackCard key={s[0]} step={s} i={i} total={STEPS.length} progress={scrollYProgress} />)}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ privacy (rows) */

const LEAVES = [
  ['One proof', '9,920 bytes of UltraHonk ZK'],
  ['Nine values', 'key hash, nullifier, template, amount, currency, date, inbox commitment, payee, vault'],
  ['Nothing else', 'any other field is rejected by the server, and a test enforces it'],
];
const KEPT = ['Headers, body and order details', 'Your inbox address', 'Card digits and delivery address', 'The RSA signature itself', 'Your secret salt'];
const SAMPLE_REQUEST = `POST /api/claim
{
  "vaultId": 0,
  "circuit": "rsa2048",
  "proof": "0x0000…a91f",
  "pubs": [
    "pubkey_hash   0x2278f9b1…f3bc",
    "nullifier     0x15d57872…acfa",
    "template_id   100",
    "amount_minor  124950",
    "currency      356",
    "sent_at       1794725553",
    "to_commit     0x01af3ceb…4f29",
    "recipient     0x…00aa",
    "vault_id      0"
  ]
}`;

function Row({ title, note, k }) {
  return (
    <motion.li
      initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true, amount: 0.5 }} transition={{ duration: 0.6, delay: k * 0.05 }}
      className="group relative overflow-hidden border-b border-accent/30"
    >
      <span aria-hidden="true" className="absolute inset-0 origin-bottom scale-y-0 bg-accent transition-transform duration-500 ease-[cubic-bezier(.16,1,.3,1)] group-hover:scale-y-100" />
      <div className="relative flex items-center justify-between gap-6 px-4 py-4 md:px-6 md:py-6">
        <div className="min-w-0">
          <div className="display text-[clamp(2.3rem,7.4vw,7rem)] text-ink transition-[color,transform] duration-500 group-hover:translate-x-3 group-hover:text-accent-ink">{title}</div>
          <div className="micro mt-2 max-w-[70ch] text-ink-3 transition-colors group-hover:text-accent-ink/70">{note}</div>
        </div>
        <ArrowUpRight size={52} weight="bold" className="shrink-0 text-ink transition-transform duration-500 group-hover:rotate-45 group-hover:text-accent-ink" />
      </div>
    </motion.li>
  );
}

function Privacy() {
  return (
    <section className="pt-12 pb-24 md:pb-36">
      <SectionHead id="privacy" title={<>All that leaves<br />your device</>} label="Privacy" />
      <ul className="mx-auto mt-10 max-w-[1400px] border-t border-accent/30">
        {LEAVES.map(([t, n], k) => <Row key={t} title={t} note={n} k={k} />)}
      </ul>
      <div className="mx-auto mt-14 grid max-w-[1400px] gap-4 px-4 md:grid-cols-[0.9fr_1.1fr] md:px-6">
        <Reveal className="frame p-6 md:p-8">
          <div className="micro flex items-center justify-between text-ink-3"><span>Stays in your browser</span><span className="grip"><i /><i /><i /><i /></span></div>
          <ul className="mt-8 grid gap-4">
            {KEPT.map((k, n) => (
              <li key={k} className="flex items-baseline gap-4 border-b border-ink/10 pb-4 text-lg last:border-0">
                <span className="micro text-accent">0{n + 1}</span>{k}
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal delay={0.08} className="frame overflow-hidden">
          <div className="micro flex items-center justify-between border-b border-ink/20 px-6 py-3 text-ink-3"><span>The whole request</span><span className="box box-on" /></div>
          <pre className="mono overflow-x-auto p-6 text-[12.5px] leading-6 text-ink-2">{SAMPLE_REQUEST}</pre>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ trust (case files) */

const TRUST = [
  {
    t: 'Signature in the circuit',
    what: 'RSA-2048 over the canonical headers, the body hash from the signed DKIM tag, and the total parsed from the signed bytes.',
    why: 'One edited digit and no proof exists. The merchant’s key does the vouching, not us.',
    tags: ['DKIM', 'RSA-2048', 'Noir'],
  },
  {
    t: 'The sound ZK flavour',
    what: 'UltraHonk V5_0 on zkVerify. Its own verifier source marks the older ZK flavours unsound, so we don’t use them.',
    why: 'Live on the Volta testnet today. Tremor switches to mainnet by config when zkVerify enables V5_0 there.',
    tags: ['UltraHonk', 'V5_0', 'zkVerify'],
  },
  {
    t: 'Paid by a contract',
    what: 'Ten ordered checks on Base, each with its own error, before any USDC moves: key, payee, window, caps, FX, nullifier, aggregation.',
    why: 'Anyone can paste a payout into the app and recheck the zkVerify aggregation from their own browser.',
    tags: ['Base', 'USDC', '10 checks'],
  },
  {
    t: 'An agent with no wallet power',
    what: 'Company policy, written in plain English, is compiled once to typed rules. The agent can approve or flag.',
    why: 'Amount, payee and merchant come from the proof. A stolen agent key can withhold, never redirect.',
    tags: ['Policy', 'EIP-712', 'Agent'],
  },
];

function CaseFile({ c, k }) {
  return (
    <Reveal className="grid gap-3 md:grid-cols-[3rem_1fr]">
      <div className="micro pt-3 text-ink-3">0{k + 1}</div>
      <div className="frame group overflow-hidden p-5 md:p-8">
        <div aria-hidden="true" className="halftone pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-700 group-hover:opacity-30 [mask-image:linear-gradient(110deg,transparent_35%,black)]" />
        <div className="relative flex items-start justify-between gap-6">
          <h3 className="display text-[clamp(2rem,5.6vw,5.2rem)] transition-colors duration-500 group-hover:text-accent">{c.t}</h3>
          <span className="grip mt-2 hidden text-ink-3 md:grid"><i /><i /><i /><i /><i /><i /></span>
        </div>
        <div className="relative mt-8 grid gap-6 border-t border-ink/20 pt-5 text-sm md:grid-cols-[1fr_1fr_auto]">
          <div><div className="micro text-ink-3">What</div><p className="mt-2 max-w-[48ch] leading-relaxed text-ink-2">{c.what}</p></div>
          <div><div className="micro text-ink-3">Why it matters</div><p className="mt-2 max-w-[48ch] leading-relaxed text-ink-2">{c.why}</p></div>
          <ul className="micro flex flex-wrap content-start gap-2 md:max-w-[12rem] md:justify-end">
            {c.tags.map((t) => <li key={t} className="rounded-full border border-ink/30 px-2.5 py-1 text-ink-2">{t}</li>)}
          </ul>
        </div>
      </div>
    </Reveal>
  );
}

function Trust() {
  return (
    <section className="pb-24 md:pb-36">
      <SectionHead id="trust" title={<>Nobody has to<br />take our word</>} label="Trust model" />
      <div className="mx-auto mt-10 grid max-w-[1400px] gap-5 px-4 md:px-6">
        {TRUST.map((c, k) => <CaseFile key={c.t} c={c} k={k} />)}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ numbers */

const NUMBERS = [
  ['1.8s', 'to prove natively on 10 threads'],
  ['3.8s', 'to prove in a browser with threads'],
  ['9', 'public values leave your device'],
  ['211', 'tests across circuit, contract and agent'],
];

function Numbers() {
  return (
    <section className="border-y border-accent/30">
      <div className="mx-auto grid max-w-[1400px] grid-cols-2 md:grid-cols-4">
        {NUMBERS.map(([n, l], i) => (
          <Reveal key={l} delay={i * 0.06} className={`border-accent/30 px-4 py-10 md:px-6 md:py-14 ${i % 2 ? '' : 'border-r'} ${i < 2 ? 'border-b md:border-b-0' : ''} md:border-r md:last:border-r-0`}>
            <div className="micro text-ink-3">( 0{i + 1} )</div>
            <CountUp value={n} className="display mt-6 block text-[clamp(3rem,7vw,6.5rem)] text-accent" />
            <div className="micro mt-3 max-w-[24ch] leading-relaxed text-ink-2">{l}</div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ faq */

const FAQ = [
  ['Does Tremor see my email?', 'No. The email is parsed and proven inside your browser tab. The server receives the proof and nine public values, and rejects any request that carries anything else.'],
  ['What exactly does the proof show?', 'That the email was signed by the merchant key the vault trusts, that the signed body contains the merchant’s total line with this amount, when it was sent, and that it went to your registered inbox.'],
  ['What does it not show?', 'Whether the purchase was for business, whether you paid personally, or whether it was refunded later. Your company’s policy and normal audit still cover those.'],
  ['Who decides which merchant keys count?', 'Each company’s vault keeps its own list. New keys activate after 24 hours, with the full key on chain so anyone can compare it with DNS. These merchants don’t use DNSSEC yet, so this can’t be fully trustless today.'],
  ['Which merchants work?', 'Any merchant whose receipt layout has a template. The sandbox uses a Tremor test merchant. Uber, Swiggy, Zomato and Amazon.in templates are being checked against real receipts.'],
  ['Is this on mainnet?', 'Not yet. The sound ZK proof type runs on zkVerify’s Volta testnet today. Tremor switches to mainnet when zkVerify enables it there.'],
];

function Faq() {
  const [open, setOpen] = useState(0);
  return (
    <section className="py-24 md:py-36">
      <SectionHead id="faq" title={<>Questions,<br />answered plainly</>} label="FAQ" />
      <div className="mx-auto mt-10 grid max-w-[1400px] gap-3 px-4 md:grid-cols-2 md:px-6">
        {FAQ.map(([q, a], i) => (
          <div key={q} className={`frame self-start transition-colors ${open === i ? 'border-accent' : ''}`}>
            <button onClick={() => setOpen(open === i ? -1 : i)} className="flex w-full items-start justify-between gap-6 p-5 text-left md:p-6" aria-expanded={open === i}>
              <span>
                <span className="micro block text-ink-3">Q / 0{i + 1}</span>
                <span className="mt-3 block text-lg font-medium uppercase leading-snug tracking-tight md:text-xl">{q}</span>
              </span>
              {open === i ? <Minus size={18} className="mt-1 shrink-0 text-accent" /> : <Plus size={18} className="mt-1 shrink-0 text-ink-3" />}
            </button>
            <AnimatePresence initial={false}>
              {open === i && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.4, ease }} className="overflow-hidden">
                  <p className="max-w-[62ch] px-5 pb-6 leading-relaxed text-ink-2 md:px-6">{a}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ final cta + footer */

function FinalCta() {
  const seis = useRef(null);
  return (
    <section className="relative overflow-hidden pb-10">
      <VelocityMarquee base={-2.6} className="py-2">
        {['Ready', 'to prove', 'a receipt?', 'Ready', 'to prove', 'a receipt?'].map((w, k) => (
          <span key={k} className={`display px-3 text-[clamp(3.4rem,13vw,12rem)] md:px-6 ${k % 2 ? 'text-accent' : 'outline-ink'}`}>{w}</span>
        ))}
      </VelocityMarquee>
      <div className="mx-auto mt-10 grid max-w-[1400px] gap-3 px-4 md:grid-cols-[1fr_1fr_1.2fr] md:px-6">
        {[
          ['Sample receipt', 'The sandbox signs a test receipt addressed to your inbox with its own DKIM key.'],
          ['Prove in the tab', 'Check the signature and make a real UltraHonk ZK proof in your browser.'],
        ].map(([t, d], k) => (
          <Reveal key={t} delay={k * 0.06} className="frame p-6">
            <div className="micro flex items-center justify-between text-ink-3"><span>( 0{k + 1} ) {t}</span><span className="grip"><i /><i /><i /><i /></span></div>
            <p className="mt-10 text-lg leading-snug">{d}</p>
          </Reveal>
        ))}
        <Reveal delay={0.12} className="frame relative overflow-hidden">
          <div className="pointer-events-none absolute inset-x-0 bottom-0 opacity-70"><Seismograph ref={seis} height={120} intensity={0.8} /></div>
          <a href={APP} onMouseEnter={() => seis.current?.pulse(1)} className="group relative flex h-full min-h-[11rem] flex-col justify-between p-6">
            <span className="micro text-ink-3">( 03 ) Start</span>
            <span className="display flex items-center justify-between text-[clamp(2rem,3.6vw,3.2rem)] transition-colors group-hover:text-accent">
              Prove a receipt <ArrowUpRight size={40} weight="bold" className="transition-transform duration-500 group-hover:rotate-45" />
            </span>
          </a>
        </Reveal>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="overflow-hidden border-t border-accent/30">
      <div className="mx-auto grid max-w-[1400px] gap-6 px-4 py-8 md:grid-cols-3 md:px-6">
        <div className="micro text-ink-3">Built on zkVerify<br />for Agent Games 2026</div>
        <div className="micro flex gap-6 text-ink-2 md:justify-center">
          <a href={APP} className="flex items-center gap-2 hover:text-accent"><span className="box" />App</a>
          <a href="/app#verify" className="flex items-center gap-2 hover:text-accent"><span className="box" />Verify a payout</a>
          <a href="https://github.com/zeel991" className="flex items-center gap-2 hover:text-accent"><GithubLogo size={12} />GitHub</a>
        </div>
        <div className="micro text-ink-3 md:text-right">Testnet · Volta → Base Sepolia</div>
      </div>
      <Reveal y={60} className="px-2">
        <div aria-hidden="true" className="display select-none text-center text-[clamp(3.6rem,15.4vw,21rem)] leading-[.82] text-accent">Tremor</div>
      </Reveal>
    </footer>
  );
}

export default function Landing() {
  useSmoothScroll();
  useEffect(() => { document.title = 'Tremor: receipts that can’t be faked'; }, []);
  return (
    <div className="grain">
      <main>
        <Hero />
        <Band />
        <Problem />
        <ProofPanel />
        <How />
        <Privacy />
        <Trust />
        <Numbers />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
      <Dock />
    </div>
  );
}
