import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion, useScroll, useSpring, useTransform, AnimatePresence } from 'motion/react';
import {
  ArrowRight, Envelope, Cpu, ShieldCheck, Bank, CheckCircle, XCircle, LockKey, Fingerprint,
  Scales, Robot, Plus, Minus, GithubLogo, Waveform,
} from '@phosphor-icons/react';
import { Seismograph } from '../components/Seismograph.jsx';
import { KineticText, Magnetic, TiltCard, CountUp, useSmoothScroll } from '../components/fx.jsx';

const Hero3D = lazy(() => import('../components/Hero3D.jsx'));
function webglOk() { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } }

const ease = [0.16, 1, 0.3, 1];
const APP = '/app'; // full page load: the app needs cross-origin isolation headers

function Reveal({ children, delay = 0, className = '' }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.7, delay, ease }}
    >
      {children}
    </motion.div>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-line/70 bg-bg/80 backdrop-blur-md">
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 md:px-8">
        <a href="/" className="flex items-center gap-2 text-[1.05rem] font-semibold tracking-tight">
          <Waveform size={22} weight="bold" className="text-accent" />
          Tremor
        </a>
        <div className="hidden items-center gap-8 text-sm text-ink-2 md:flex">
          <a href="#how" className="hover:text-ink">How it works</a>
          <a href="#privacy" className="hover:text-ink">Privacy</a>
          <a href="#trust" className="hover:text-ink">Trust model</a>
          <a href="#faq" className="hover:text-ink">FAQ</a>
        </div>
        <a href={APP} className="btn btn-primary !py-2 !px-4 text-sm">Prove a receipt</a>
      </nav>
    </header>
  );
}

// Illustrative feed for the hero visual (example data, labelled as such).
const FEED = [
  { real: true, merchant: 'Uber', domain: 'uber.com', amount: '₹412.00', when: 'Trip, 14 Nov' },
  { real: false, merchant: 'Image upload', domain: 'no signature', amount: '₹9,800.00', when: 'AI-generated receipt' },
  { real: true, merchant: 'Swiggy', domain: 'swiggy.in', amount: '₹1,249.50', when: 'Team lunch, 15 Nov' },
  { real: false, merchant: 'Edited email', domain: 'body hash mismatch', amount: '₹2,412.00', when: 'Amount changed by hand' },
  { real: true, merchant: 'Amazon.in', domain: 'amazon.in', amount: '₹2,999.00', when: 'Office supplies' },
];

function HeroVisual() {
  const seis = useRef(null);
  const [i, setI] = useState(0);
  const reduce = useReducedMotion();
  useEffect(() => {
    const id = setInterval(() => setI((x) => (x + 1) % FEED.length), 3200);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    const r = FEED[i];
    const t = setTimeout(() => (r.real ? seis.current?.pulse(1.1) : seis.current?.flat()), 650);
    return () => clearTimeout(t);
  }, [i]);
  const r = FEED[i];
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-bg-2">
      <div className="flex items-center justify-between border-b border-line px-5 py-3 text-xs text-ink-3">
        <span>Example verification feed</span>
        <span className="mono">DKIM · zero knowledge</span>
      </div>
      <Seismograph ref={seis} height={190} />
      <div className="relative h-[168px] border-t border-line p-5">
        <AnimatePresence mode="wait">
          <motion.div
            key={i}
            initial={reduce ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -10 }}
            transition={{ duration: 0.45, ease }}
            className="grid grid-cols-[1fr_auto] gap-y-2"
          >
            <div>
              <div className="text-lg font-semibold">{r.merchant}</div>
              <div className="text-sm text-ink-3">{r.when}</div>
            </div>
            <div className="mono text-right text-2xl tracking-tight">{r.amount}</div>
            <div className="col-span-2 mt-3 flex items-center gap-2 text-sm">
              {r.real ? (
                <><CheckCircle size={18} weight="fill" className="text-ok" /><span>Signed by <span className="mono">{r.domain}</span>. Proven and payable.</span></>
              ) : (
                <><XCircle size={18} weight="fill" className="text-bad" /><span>Rejected: <span className="mono">{r.domain}</span>.</span></>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function Hero() {
  const reduce = useReducedMotion();
  const [i, setI] = useState(0);
  const [use3d] = useState(() => !reduce && webglOk());
  useEffect(() => { const id = setInterval(() => setI((x) => (x + 1) % FEED.length), 4200); return () => clearInterval(id); }, []);
  const r = FEED[i];
  return (
    <section className="relative isolate min-h-[calc(100dvh-4rem)] overflow-hidden">
      {use3d && (
        <div className="absolute inset-0 -z-10">
          <Suspense fallback={null}><Hero3D feed={FEED} index={i} /></Suspense>
          <div className="pointer-events-none absolute inset-0 hidden bg-[radial-gradient(ellipse_at_20%_45%,var(--bg)_0%,color-mix(in_srgb,var(--bg)_70%,transparent)_38%,transparent_70%)] md:block" />
          <div className="pointer-events-none absolute inset-x-0 top-0 h-[55%] bg-gradient-to-b from-bg via-bg/80 to-transparent md:hidden" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-bg to-transparent" />
        </div>
      )}
      <div className="mx-auto grid min-h-[calc(100dvh-4rem)] max-w-7xl items-start gap-12 px-4 pt-12 pb-[24rem] md:items-center md:grid-cols-[1.05fr_1fr] md:px-8 md:pt-16 md:pb-16">
        <div>
          <h1 className="text-5xl leading-[1.02] font-semibold tracking-tighter md:text-6xl lg:text-7xl">
            <KineticText text="Receipts that can't be faked." accent={[2]} />
          </h1>
          <motion.p initial={reduce ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.45, ease }} className="mt-6 max-w-[34ch] text-lg leading-relaxed text-ink-2">
            Tremor pays expenses only when the merchant's own email signature proves the total. Your inbox stays private.
          </motion.p>
          <motion.div initial={reduce ? false : { opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.6, ease }} className="mt-9 flex flex-wrap gap-3">
            <Magnetic href={APP} className="btn btn-primary">Prove a receipt <ArrowRight size={18} weight="bold" /></Magnetic>
            <Magnetic href="#how" strength={0.2} className="btn btn-ghost bg-bg/40 backdrop-blur">See how it works</Magnetic>
          </motion.div>
          {use3d && (
            <div className="mt-12 h-7" aria-live="polite">
              <AnimatePresence mode="wait">
                <motion.div key={i} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.4, ease }} className="flex items-center gap-2 text-sm text-ink-2">
                  {r.real ? <CheckCircle size={18} weight="fill" className="text-ok" /> : <XCircle size={18} weight="fill" className="text-bad" />}
                  <span className="text-ink">{r.merchant} {r.amount}</span>
                  <span className="text-ink-3">{r.real ? `signed by ${r.domain}` : `rejected: ${r.domain}`}</span>
                </motion.div>
              </AnimatePresence>
            </div>
          )}
        </div>
        {!use3d && <HeroVisual />}
      </div>
    </section>
  );
}

function Wordmark() {
  const ref = useRef(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });
  const x = useTransform(scrollYProgress, [0, 1], ['8%', '-22%']);
  const marquee = ['uber.com', 'DKIM rsa-sha256', 'swiggy.in', 'Noir', 'amazon.in', 'UltraHonk V5_0', 'zomato.com', 'zkVerify', 'Base', 'USDC'];
  return (
    <div ref={ref} aria-hidden="true" className="relative overflow-hidden border-y border-line">
      <div className="overflow-hidden border-b border-line py-3">
        <motion.div animate={reduce ? {} : { x: ['0%', '-50%'] }} transition={{ duration: 28, ease: 'linear', repeat: Infinity }} className="mono flex w-max gap-10 text-sm text-ink-3">
          {[...marquee, ...marquee].map((m, k) => <span key={k} className="flex items-center gap-10">{m}<span className="text-accent">/</span></span>)}
        </motion.div>
      </div>
      <motion.div style={{ x: reduce ? 0 : x }} className="select-none whitespace-nowrap px-2 font-semibold leading-[0.78] tracking-[-0.06em] text-[clamp(5rem,24vw,24rem)] text-transparent [-webkit-text-stroke:1px_color-mix(in_srgb,var(--ink-3)_45%,transparent)] translate-y-[14%]">
        TREMOR TREMOR
      </motion.div>
    </div>
  );
}

function Problem() {
  return (
    <section className="mx-auto max-w-7xl px-4 py-24 md:px-8 md:py-32">
      <Reveal>
        <p className="max-w-[22ch] text-4xl leading-[1.1] font-semibold tracking-tight md:text-5xl">
          A photo of a receipt proves nothing. <span className="text-ink-3">The email it arrived in proves everything.</span>
        </p>
      </Reveal>
      <Reveal delay={0.1} className="mt-10 grid gap-8 text-ink-2 md:grid-cols-2 md:gap-16">
        <p className="leading-relaxed">
          Image models now write receipts with the right logo, layout and tax lines. A reviewer can't tell them apart, and a PDF can't say where it came from.
        </p>
        <p className="leading-relaxed">
          Uber, Swiggy and Amazon sign every receipt email with DKIM, an RSA signature from their domain over the headers and body. Change one digit and the signature breaks. Tremor turns that signature into proof.
        </p>
      </Reveal>
    </section>
  );
}

const STEPS = [
  { icon: Envelope, title: 'Drop the receipt email', body: 'Open the .eml in your browser. It is parsed and checked against the merchant’s DKIM key, on your device.' },
  { icon: Cpu, title: 'Prove it in the tab', body: 'A Noir circuit proves the signature, the total, the date and your inbox. About 11 seconds, single threaded.' },
  { icon: ShieldCheck, title: 'zkVerify checks the proof', body: 'Only the proof and nine public values are submitted. zkVerify verifies it and aggregates the result to Base.' },
  { icon: Bank, title: 'The vault pays you', body: 'A contract re-checks the merchant key, your wallet, the date, the caps and the nullifier, then sends USDC.' },
];

function StackCard({ step, i, total, progress }) {
  const reduce = useReducedMotion();
  const start = i / total, end = (i + 1) / total;
  const scale = useTransform(progress, [start, end, 1], [1, 0.92, 0.92 - (total - i) * 0.01]);
  const rotX = useTransform(progress, [start, end], [0, 8]);
  const shade = useTransform(progress, [start, end], [0, 0.6]);
  return (
    <div className="sticky h-[62vh]" style={{ zIndex: i + 1, top: `calc(5.5rem + ${i * 1.4}rem)` }}>
      <motion.div
        style={reduce ? {} : { scale, rotateX: rotX, transformPerspective: 1200 }}
        className="relative h-full origin-top overflow-hidden rounded-3xl border border-line bg-bg-2 p-8 md:p-12"
      >
        <div className="flex h-full flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="grid size-12 place-items-center rounded-2xl bg-accent text-accent-ink"><step.icon size={24} weight="bold" /></span>
            <span className="mono text-sm text-ink-3">{i + 1} / {total}</span>
          </div>
          <div>
            <h3 className="max-w-[18ch] text-3xl font-semibold tracking-tight md:text-5xl">{step.title}</h3>
            <p className="mt-4 max-w-[52ch] text-lg leading-relaxed text-ink-2">{step.body}</p>
          </div>
        </div>
        <div className="pointer-events-none absolute -right-24 -bottom-24 size-72 rounded-full bg-accent/10 blur-3xl" />
        {!reduce && i < total - 1 && <motion.div aria-hidden="true" style={{ opacity: shade }} className="pointer-events-none absolute inset-0 bg-bg" />}
      </motion.div>
    </div>
  );
}

function How() {
  const ref = useRef(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  return (
    <section id="how" className="scroll-mt-20 border-t border-line">
      <div className="mx-auto max-w-7xl px-4 pt-24 md:px-8 md:pt-32">
        <Reveal><h2 className="max-w-[20ch] text-4xl font-semibold tracking-tight md:text-6xl">From inbox to USDC, without showing the email.</h2></Reveal>
        <Reveal delay={0.1}><p className="mt-5 max-w-[48ch] text-lg text-ink-2">Every step is checkable. Nothing in the chain trusts our server with the amount, the payee or the merchant.</p></Reveal>
      </div>
      <div ref={ref} className="relative mx-auto mt-14 grid max-w-5xl gap-[10vh] px-4 pb-32 md:px-8">
        {STEPS.map((s, i) => <StackCard key={s.title} step={s} i={i} total={STEPS.length} progress={scrollYProgress} />)}
      </div>
    </section>
  );
}

const SAMPLE_REQUEST = `{
  "vaultId": 0,
  "circuit": "rsa2048",
  "proof": "0x0000…a91f  (9,920 bytes)",
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

function Privacy() {
  const kept = ['Headers, body and order details', 'Your inbox address', 'Card digits and delivery address', 'The RSA signature itself', 'Your secret salt'];
  return (
    <section id="privacy" className="mx-auto max-w-7xl scroll-mt-20 px-4 py-24 md:px-8 md:py-32">
      <Reveal>
        <h2 className="max-w-[20ch] text-4xl font-semibold tracking-tight md:text-5xl">This is everything that leaves your device.</h2>
      </Reveal>
      <div className="mt-12 grid gap-6 md:grid-cols-[0.8fr_1.2fr]">
        <Reveal className="rounded-2xl border border-line p-7">
          <div className="flex items-center gap-2 text-sm text-ink-3"><LockKey size={18} /> Stays in your browser</div>
          <ul className="mt-5 grid gap-3 text-lg">
            {kept.map((k) => <li key={k} className="flex gap-3"><span className="mt-2.5 h-px w-4 shrink-0 bg-accent" />{k}</li>)}
          </ul>
        </Reveal>
        <Reveal delay={0.08} className="overflow-hidden rounded-2xl border border-line bg-bg-2">
          <div className="border-b border-line px-6 py-3 text-sm text-ink-3">POST /api/claim · the whole request</div>
          <pre className="mono overflow-x-auto p-6 text-[13px] leading-6 text-ink-2">{SAMPLE_REQUEST}</pre>
          <div className="border-t border-line px-6 py-3 text-sm text-ink-3">Any other field is rejected by the server, and a test enforces it.</div>
        </Reveal>
      </div>
    </section>
  );
}

function Trust() {
  return (
    <section id="trust" className="scroll-mt-20 border-t border-line">
      <div className="mx-auto max-w-7xl px-4 py-24 md:px-8 md:py-32">
        <Reveal><h2 className="max-w-[22ch] text-4xl font-semibold tracking-tight md:text-5xl">Built so nobody has to take our word for it.</h2></Reveal>
        <div className="mt-12 grid gap-4 md:grid-cols-6">
          <Reveal className="md:col-span-4 md:row-span-2"><TiltCard className="h-full overflow-hidden rounded-2xl bg-accent p-7 text-accent-ink" max={5}>
            <Fingerprint size={34} weight="duotone" />
            <h3 className="mt-16 text-3xl font-semibold tracking-tight md:text-4xl">The merchant's signature is checked inside the proof.</h3>
            <p className="mt-4 max-w-[48ch] opacity-85">RSA-2048 over the canonical headers, the body hash from the signed DKIM tag, and the total parsed from the signed bytes. One edited digit and no proof exists.</p>
          </TiltCard></Reveal>
          <Reveal delay={0.05} className="md:col-span-2"><TiltCard className="h-full rounded-2xl border border-line p-7">
            <Scales size={26} className="text-accent" />
            <h3 className="mt-6 text-lg font-semibold">One claim per email</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">A salted nullifier marks each receipt spent. The merchant can't compute it, so it can't link the claim back to you.</p>
          </TiltCard></Reveal>
          <Reveal delay={0.1} className="md:col-span-2"><TiltCard className="h-full rounded-2xl border border-line bg-bg-2 p-7">
            <ShieldCheck size={26} className="text-accent" />
            <h3 className="mt-6 text-lg font-semibold">The sound ZK flavour</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">UltraHonk V5_0 on zkVerify. Its own source marks the older ZK flavours unsound, so we don't use them.</p>
          </TiltCard></Reveal>
          <Reveal delay={0.05} className="overflow-hidden rounded-2xl border border-line md:col-span-3">
            <div className="p-7 pb-0">
              <Bank size={26} className="text-accent" />
              <h3 className="mt-6 text-lg font-semibold">Paid by a contract, not a person</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-2">Ten ordered checks on Base, each with its own error, before any USDC moves.</p>
            </div>
            <Seismograph height={90} intensity={0.6} />
          </Reveal>
          <Reveal delay={0.1} className="md:col-span-3"><TiltCard className="h-full rounded-2xl border border-line bg-bg-2 p-7">
            <Robot size={26} className="text-accent" />
            <h3 className="mt-6 text-lg font-semibold">An agent that can't redirect money</h3>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">Your company's policy, written in plain English, is compiled once to typed rules. The agent can approve or flag. The amount, payee and merchant come from the proof.</p>
          </TiltCard></Reveal>
        </div>
      </div>
    </section>
  );
}

const NUMBERS = [
  ['1.8 s', 'to prove natively on 10 threads'],
  ['11 s', 'to prove in one browser thread'],
  ['9', 'public values leave your device'],
  ['210', 'tests across circuit, contract and agent'],
];

function Numbers() {
  return (
    <section className="border-y border-line bg-bg-2/40">
      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-y-10 px-4 py-16 md:grid-cols-4 md:px-8">
        {NUMBERS.map(([n, l], i) => (
          <Reveal key={l} delay={i * 0.05}>
            <CountUp value={n} className="mono block text-5xl tracking-tight md:text-6xl" />
            <div className="mt-2 max-w-[22ch] text-sm text-ink-3">{l}</div>
          </Reveal>
        ))}
      </div>
    </section>
  );
}

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
    <section id="faq" className="mx-auto grid max-w-7xl scroll-mt-20 gap-12 px-4 py-24 md:grid-cols-[0.8fr_1.2fr] md:px-8 md:py-32">
      <Reveal><h2 className="text-4xl font-semibold tracking-tight md:text-5xl">Questions, answered plainly.</h2></Reveal>
      <div className="divide-y divide-line border-y border-line">
        {FAQ.map(([q, a], i) => (
          <div key={q}>
            <button onClick={() => setOpen(open === i ? -1 : i)} className="flex w-full items-center justify-between gap-6 py-5 text-left text-lg font-medium" aria-expanded={open === i}>
              {q}
              {open === i ? <Minus size={18} className="shrink-0 text-accent" /> : <Plus size={18} className="shrink-0 text-ink-3" />}
            </button>
            <AnimatePresence initial={false}>
              {open === i && (
                <motion.p initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.35, ease }} className="overflow-hidden">
                  <span className="block max-w-[62ch] pb-6 leading-relaxed text-ink-2">{a}</span>
                </motion.p>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>
    </section>
  );
}

function FinalCta() {
  const seis = useRef(null);
  return (
    <section className="relative overflow-hidden border-t border-line">
      <div className="pointer-events-none absolute inset-x-0 bottom-0 opacity-60"><Seismograph ref={seis} height={220} intensity={0.8} /></div>
      <div className="relative mx-auto max-w-7xl px-4 py-28 md:px-8 md:py-36">
        <Reveal>
          <h2 className="max-w-[16ch] text-5xl leading-[1.02] font-semibold tracking-tighter md:text-7xl">Try it with a signed sample receipt.</h2>
          <p className="mt-6 max-w-[46ch] text-lg text-ink-2">The sandbox signs a test receipt addressed to your inbox. You check it and prove it end to end in your browser.</p>
          <Magnetic href={APP} onMouseEnter={() => seis.current?.pulse(0.9)} className="btn btn-primary mt-9">Prove a receipt <ArrowRight size={18} weight="bold" /></Magnetic>
        </Reveal>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-10 text-sm text-ink-3 md:flex-row md:items-center md:justify-between md:px-8">
        <div className="flex items-center gap-2 text-ink"><Waveform size={18} weight="bold" className="text-accent" /> Tremor</div>
        <div>Built on zkVerify for Agent Games 2026.</div>
        <div className="flex gap-6">
          <a href={APP} className="hover:text-ink">App</a>
          <a href="/app#verify" className="hover:text-ink">Verify a payout</a>
          <a href="https://github.com/zeel991" className="flex items-center gap-1 hover:text-ink"><GithubLogo size={16} /> GitHub</a>
        </div>
      </div>
    </footer>
  );
}

export default function Landing() {
  useSmoothScroll();
  useEffect(() => { document.title = 'Tremor: receipts that can’t be faked'; }, []);
  return (
    <div className="grain">
      <Nav />
      <main>
        <Hero />
        <Wordmark />
        <Problem />
        <How />
        <Privacy />
        <Trust />
        <Numbers />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
