import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion, useScroll, useTransform, useInView, useMotionValueEvent, AnimatePresence } from 'motion/react';
import { ArrowUpRight, ArrowRight, Waveform, GithubLogo, Plus, Minus, CheckCircle, XCircle } from '@phosphor-icons/react';
import { Magnetic, useSmoothScroll } from '../components/fx.jsx';
import { APP_URL } from '../lib/site.js';

const Hero3D = lazy(() => import('../components/Hero3D.jsx'));
function webglOk() { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } }

const ease = [0.16, 1, 0.3, 1];
const APP = APP_URL; // full page load: the app needs cross-origin isolation headers

/* ------------------------------------------------------------------ motion primitives */

function Reveal({ children, delay = 0, className = '', y = 24 }) {
  const reduce = useReducedMotion();
  return (
    <motion.div className={className} initial={reduce ? false : { opacity: 0, y }} whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }} transition={{ duration: 0.9, delay, ease }}>
      {children}
    </motion.div>
  );
}

/** Giant word whose letters sharpen out of a blur, one after another. */
function BlurWord({ text, className = '' }) {
  const ref = useRef(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const reduce = useReducedMotion();
  return (
    <span ref={ref} aria-label={text} className={`inline-block ${className}`}>
      {[...text].map((ch, i) => (
        <motion.span key={i} aria-hidden="true" className="inline-block"
          initial={reduce ? false : { opacity: 0, filter: 'blur(18px)', y: '12%' }}
          animate={inView ? { opacity: 1, filter: 'blur(0px)', y: '0%' } : undefined}
          transition={{ duration: 1.1, delay: i * 0.06, ease }}>
          {ch === ' ' ? ' ' : ch}
        </motion.span>
      ))}
    </span>
  );
}

function Word({ children, range, progress }) {
  const opacity = useTransform(progress, range, [0.16, 1]);
  return <motion.span style={{ opacity }} className="mr-[0.25em] inline-block">{children}</motion.span>;
}

/** Paragraph that fills in word by word as it scrolls through the viewport. */
function WordReveal({ text, className = '' }) {
  const ref = useRef(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 0.88', 'end 0.5'] });
  const words = text.split(' ');
  if (reduce) return <p className={className}>{text}</p>;
  return (
    <p ref={ref} className={className} aria-label={text}>
      {words.map((w, i) => <Word key={i} progress={scrollYProgress} range={[i / words.length, (i + 1) / words.length]}>{w}</Word>)}
    </p>
  );
}

/** Twinkling starfield on a 2D canvas, for the night sections. */
function StarField({ className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current, ctx = c.getContext('2d');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let stars = [], raf, w = 0, h = 0;
    const resize = () => {
      w = c.clientWidth; h = c.clientHeight; c.width = w * dpr; c.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stars = Array.from({ length: Math.round((w * h) / 2600) }, () => ({ x: Math.random() * w, y: Math.random() * h, r: Math.random() * 1.1 + 0.2, p: Math.random() * 6 }));
    };
    const draw = (t) => {
      ctx.clearRect(0, 0, w, h);
      for (const s of stars) { ctx.globalAlpha = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(t / 900 + s.p)); ctx.fillStyle = '#fff'; ctx.fillRect(s.x, s.y, s.r, s.r); }
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    const ro = new ResizeObserver(resize); ro.observe(c); resize(); raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);
  return <canvas ref={ref} aria-hidden="true" className={`pointer-events-none absolute inset-0 h-full w-full ${className}`} />;
}

/* ------------------------------------------------------------------ nav */

const LINKS = [['#proof', 'Proof'], ['#privacy', 'Privacy'], ['#how', 'How it works'], ['#trust', 'Trust'], ['#faq', 'FAQ']];

function Nav() {
  return (
    <header className="fixed inset-x-0 top-3 z-50 px-3 md:top-4 md:px-6">
      <nav className="mx-auto flex h-14 max-w-[1320px] items-center justify-between rounded-full border border-white/10 bg-[#0b0b0b]/85 pr-2 pl-5 backdrop-blur-xl">
        <a href="/" className="flex items-center gap-2 text-[1.02rem] font-medium tracking-tight text-ink"><Waveform size={20} weight="bold" className="text-accent" />tremor</a>
        <ul className="hidden items-center gap-7 text-sm text-ink-2 lg:flex">
          {LINKS.map(([h, l]) => <li key={h}><a href={h} className="transition-colors hover:text-ink">{l}</a></li>)}
        </ul>
        <a href={APP} className="btn btn-primary !py-2.5 !px-4 !text-sm">Launch app <ArrowUpRight size={14} weight="bold" /></a>
      </nav>
    </header>
  );
}

/* ------------------------------------------------------------------ hero */

// Illustrative feed for the hero (example data).
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
  const textY = useTransform(scrollYProgress, [0, 1], ['0%', '30%']);
  const textO = useTransform(scrollYProgress, [0, 0.7], [1, 0]);
  useEffect(() => { const id = setInterval(() => setI((x) => (x + 1) % FEED.length), 4200); return () => clearInterval(id); }, []);
  const r = FEED[i];
  const labels = ['No email leaves your device', 'Proven with zero knowledge', 'Paid in USDC on Base'];
  return (
    <section ref={ref} className="ember relative isolate min-h-[100dvh] overflow-hidden">
      {use3d && <div className="absolute inset-0 -z-10"><Suspense fallback={null}><Hero3D feed={FEED} index={i} scroll={scrollYProgress} /></Suspense></div>}
      {!use3d && <StarField className="-z-10" />}

      <motion.div style={reduce ? {} : { y: textY, opacity: textO }} className="mx-auto flex min-h-[100dvh] max-w-[1320px] flex-col justify-between px-5 pt-28 pb-10 md:px-8 md:pt-32 md:pb-14">
        <div className="flex items-start justify-between gap-8">
          <ul className="micro grid gap-1.5 text-ink-2">
            {labels.map((l, k) => (
              <motion.li key={l} className="tag" initial={reduce ? false : { opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.8, delay: 0.3 + k * 0.1, ease }}>{l}</motion.li>
            ))}
          </ul>
          <motion.p initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1, delay: 0.6 }} className="hidden max-w-[30ch] text-right text-[.95rem] leading-snug text-ink-2 md:block">
            An expense agent that pays a receipt only when the merchant’s own email signature proves the total.
          </motion.p>
        </div>

        <div className="grid items-end gap-8 md:grid-cols-[1fr_auto]">
          <div>
            <div className="micro mb-5 flex h-5 items-center gap-2 text-ink-2" aria-live="polite">
              <AnimatePresence mode="wait">
                <motion.span key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.35, ease }} className="flex items-center gap-2">
                  {r.real ? <CheckCircle size={14} weight="fill" className="text-ok" /> : <XCircle size={14} weight="fill" className="text-bad" />}
                  <span className="text-ink">{r.merchant} {r.amount}</span><span>{r.real ? `signed by ${r.domain}` : r.domain}</span>
                </motion.span>
              </AnimatePresence>
            </div>
            <h1 className="display text-[clamp(3.4rem,9.6vw,9.5rem)] text-ink" aria-label="Signed. Proven. Paid.">
              {['Signed.', 'Proven.', 'Paid.'].map((w, k) => (
                <span key={w} className="block overflow-hidden pb-[0.06em]">
                  <motion.span className="block" initial={reduce ? false : { y: '105%' }} animate={{ y: '0%' }} transition={{ duration: 1.1, delay: 0.15 + k * 0.1, ease }}>{w}</motion.span>
                </span>
              ))}
            </h1>
          </div>
          <motion.div initial={reduce ? false : { opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.9, delay: 0.7, ease }} className="flex flex-wrap gap-2 md:justify-end md:pb-4">
            <Magnetic href={APP} className="btn btn-primary">Prove a receipt <ArrowRight size={16} weight="bold" /></Magnetic>
            <Magnetic href="#proof" strength={0.2} className="btn btn-ghost bg-black/20 backdrop-blur">How it works</Magnetic>
          </motion.div>
        </div>
      </motion.div>
    </section>
  );
}

/* ------------------------------------------------------------------ sticky receipt track */

const TRACK = [
  ['0', 'Bytes of your email sent'],
  ['~16 s', 'To prove in a browser'],
  ['9', 'Public values, nothing else'],
];

function MiniReceipt({ stamp }) {
  const scale = useTransform(stamp, [0, 1], [1.4, 1]);
  return (
    <div className="relative h-[230px] w-[188px] rounded-[10px] bg-gradient-to-br from-[#fbfbf7] to-[#dfe0d7] p-4 text-paper-ink shadow-[0_40px_60px_-20px_rgba(20,22,10,.45),0_10px_20px_-10px_rgba(20,22,10,.3)] md:h-[270px] md:w-[220px]">
      <div className="text-[15px] font-medium">Swiggy</div>
      <div className="micro mt-1 !text-[.55rem] text-paper-ink-2">Team lunch · 15 Nov</div>
      <div className="mt-5 grid gap-2.5">{[80, 64, 72, 50].map((w, k) => <div key={k} className="flex justify-between"><span className="h-1.5 rounded bg-paper-line" style={{ width: `${w}%` }} /><span className="h-1.5 w-6 rounded bg-paper-line" /></div>)}</div>
      <div className="dash-t mt-6 flex items-baseline justify-between pt-3"><span className="text-[11px] text-paper-ink-2">Total</span><span className="text-[22px] font-light tracking-tight">₹1,249.50</span></div>
      <div className="micro mt-4 !text-[.5rem] leading-relaxed text-paper-ink-2">DKIM d=swiggy.in a=rsa-sha256</div>
      <motion.div style={{ opacity: stamp, scale, rotate: -12, x: '-50%' }} className="micro absolute top-[38%] left-1/2 rounded-full border-2 border-[#3f6212] px-3 py-1 !text-[.8rem] text-[#3f6212]">Proven</motion.div>
    </div>
  );
}

function ReceiptTrack() {
  const ref = useRef(null);
  const reduce = useReducedMotion();
  const { scrollYProgress: p } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  const left = useTransform(p, [0, 0.28, 0.4, 0.62, 0.74, 1], ['16.667%', '16.667%', '50%', '50%', '83.333%', '83.333%']);
  const bar = useTransform(p, [0, 0.28, 0.4, 0.62, 0.74, 1], ['0%', '0%', '33.333%', '33.333%', '66.667%', '66.667%']);
  const rotY = useTransform(p, [0, 0.28, 0.4, 0.62, 0.74, 1], [-18, -18, 342, 342, 702, 702]);
  const rotZ = useTransform(p, [0, 0.5, 1], [-8, 6, -4]);
  const stamp = useTransform(p, [0.05, 0.15], [0, 1]);
  const [active, setActive] = useState(0);
  useMotionValueEvent(p, 'change', (v) => setActive(v < 0.34 ? 0 : v < 0.68 ? 1 : 2));
  return (
    <section ref={ref} className="relative h-[300vh] bg-paper text-paper-ink">
      <div className="sticky top-0 flex h-[100dvh] flex-col justify-end overflow-hidden px-3 pb-6 md:px-6 md:pb-10">
        <div className="micro absolute top-24 left-5 text-paper-ink-2 md:left-8"><span className="tag">What leaves your device</span></div>
        <div className="relative mx-auto w-full max-w-[1320px]">
          <motion.div style={{ left: reduce ? '50%' : left, x: '-50%' }} className="absolute bottom-full [perspective:1100px]">
            <svg aria-hidden="true" viewBox="0 0 400 200" className="absolute bottom-0 left-1/2 w-[300px] -translate-x-1/2 md:w-[400px]">
              <path d="M10 200 A190 190 0 0 1 390 200" fill="none" stroke="var(--paper-line)" strokeDasharray="2 7" strokeWidth="1.5" />
              <path d="M40 200 A160 160 0 0 1 360 200" fill="none" stroke="var(--paper-line)" strokeWidth="1" />
              <rect x="20" y="118" width="9" height="9" fill="var(--accent)" stroke="#9fb52c" />
              <rect x="370" y="118" width="9" height="9" fill="var(--accent)" stroke="#9fb52c" />
            </svg>
            <motion.div style={reduce ? {} : { rotateY: rotY, rotateZ: rotZ }} className="relative mb-10 [transform-style:preserve-3d] md:mb-14">
              <MiniReceipt stamp={stamp} />
            </motion.div>
          </motion.div>
          <div className="dash-t dash-b relative grid grid-cols-3">
            <motion.div style={{ left: bar }} className="absolute -top-px h-[2px] w-1/3 bg-[#a3bd1f]" />
            {TRACK.map(([n, l], k) => (
              <div key={l} className={`grid h-[26vh] min-h-[150px] place-items-center text-center ${k ? 'dash-l' : ''}`}>
                <div className={`transition-opacity duration-500 ${active === k ? 'opacity-100' : 'opacity-25'}`}>
                  <div className="display text-[clamp(2.2rem,6vw,5rem)]">{n}</div>
                  <div className="micro mt-2 !text-[.58rem] text-paper-ink-2 md:!text-[.68rem]"><span className="tag">{l}</span></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ chapters (paper) */

function Chapter({ id, n, word, list, listTitle, body, children }) {
  return (
    <section id={id} className="scroll-mt-20 bg-paper text-paper-ink">
      <div className="mx-auto max-w-[1320px] px-5 pt-24 pb-24 md:px-8 md:pt-36 md:pb-32">
        <div className="flex items-start justify-between gap-6">
          <h2 className="display text-[clamp(4.2rem,15vw,13rem)] text-paper-ink"><BlurWord text={word} /></h2>
          <span className="micro mt-3 rounded-full border border-paper-line px-2.5 py-1 text-paper-ink-2">{n}</span>
        </div>
        <div className="mt-14 grid gap-12 md:mt-20 md:grid-cols-[0.8fr_1.2fr]">
          <div>
            <div className="micro flex items-center gap-2 text-paper-ink"><span className="size-1.5 bg-paper-ink" />{listTitle}</div>
            <ul className="micro mt-6 grid gap-3 text-paper-ink-2">
              {list.map((l, k) => <Reveal key={l} delay={k * 0.05} y={8}><li>{String(k + 1).padStart(2, '0')} / {l}</li></Reveal>)}
            </ul>
          </div>
          <WordReveal text={body} className="text-[1.45rem] leading-[1.28] font-normal tracking-tight md:text-[2rem]" />
        </div>
        {children}
      </div>
    </section>
  );
}

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

function Privacy() {
  return (
    <Chapter id="privacy" n="02" word="Privacy" listTitle="Stays in your browser"
      list={['Headers, body, order details', 'Your inbox address', 'Card digits and address', 'The RSA signature', 'Your secret salt']}
      body="The email is parsed and proven inside your browser tab. The server receives the proof and nine public values, and rejects any request that carries anything else. A test enforces it.">
      <Reveal className="mt-16 grid gap-4 md:mt-24 md:grid-cols-[0.8fr_1.2fr]">
        <div className="micro self-end text-paper-ink-2"><span className="tag">The whole request</span></div>
        <div className="overflow-hidden rounded-[22px] bg-[#0d0d0d] text-ink shadow-[0_30px_60px_-30px_rgba(0,0,0,.5)]">
          <div className="micro flex items-center justify-between border-b border-white/10 px-6 py-3 text-ink-3"><span>tremor-agent</span><span className="flex gap-1.5"><i className="size-2 rounded-full bg-white/20" /><i className="size-2 rounded-full bg-white/20" /><i className="size-2 rounded-full bg-accent" /></span></div>
          <pre className="mono overflow-x-auto p-6 text-[12.5px] leading-6 text-ink-2">{SAMPLE_REQUEST}</pre>
        </div>
      </Reveal>
    </Chapter>
  );
}

/* ------------------------------------------------------------------ night: merchants + process */

const LINES = ['A ride home with Uber.', 'Team lunch on Swiggy.', 'Dinner on Zomato.', 'Office supplies from Amazon.', 'Any merchant that signs its mail.'];

function Line({ text }) {
  const ref = useRef(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });
  const opacity = useTransform(scrollYProgress, [0.2, 0.5, 0.8], [0.18, 1, 0.18]);
  const blur = useTransform(scrollYProgress, [0.2, 0.5, 0.8], ['blur(3px)', 'blur(0px)', 'blur(3px)']);
  return <motion.li ref={ref} style={{ opacity, filter: blur }}>{text}</motion.li>;
}

const STEPS = [
  ['Drop the email', 'Open the .eml in your browser. Its DKIM signature is checked against the merchant’s key, on your device.'],
  ['Prove it in the tab', 'A Noir circuit proves the signature, the total, the date and your inbox. About 15 seconds in a modern browser.'],
  ['zkVerify checks it', 'Only the proof and nine public values are submitted. zkVerify verifies it and aggregates the result to Base.'],
  ['The vault pays', 'A contract re-checks key, wallet, date, caps and nullifier, then sends USDC. No person in the loop.'],
];

function Night() {
  return (
    <section id="how" className="relative isolate scroll-mt-20 overflow-hidden [background:radial-gradient(90%_60%_at_100%_100%,color-mix(in_srgb,var(--ember)_70%,transparent),transparent_60%),var(--bg)]">
      <StarField />
      <div className="relative mx-auto max-w-[1320px] px-5 py-28 md:px-8 md:py-40">
        <ul className="mx-auto grid max-w-[34ch] gap-2 text-center text-[1.5rem] leading-snug tracking-tight text-ink md:text-[2.1rem]">
          {LINES.map((l) => <Line key={l} text={l} />)}
        </ul>
        <div className="mt-28 flex items-end justify-between gap-6 md:mt-40">
          <h2 className="display text-[clamp(2.6rem,6.4vw,6rem)]">Inbox to USDC,<br /><span className="text-ink-3">in four checks.</span></h2>
          <span className="micro hidden rounded-full border border-white/15 px-2.5 py-1 text-ink-2 md:block">03</span>
        </div>
        <div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map(([t, d], k) => (
            <Reveal key={t} delay={k * 0.08}>
              <div className="group relative h-full overflow-hidden rounded-[22px] border border-white/10 bg-white/[0.04] p-6 backdrop-blur-md transition-colors hover:border-accent/50">
                <div aria-hidden="true" className="pointer-events-none absolute -top-16 -right-16 size-40 rounded-full bg-accent/0 blur-2xl transition-colors duration-500 group-hover:bg-accent/25" />
                <div className="micro flex items-center justify-between text-ink-3"><span className="tag">Step {String(k + 1).padStart(2, '0')}</span><span className="size-1.5 bg-accent" /></div>
                <h3 className="mt-16 text-[1.55rem] font-light tracking-tight">{t}</h3>
                <p className="mt-3 text-sm leading-relaxed text-ink-2">{d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ trust grid */

const TRUST = [
  ['DKIM · RSA-2048', 'Signature inside the proof', 'The merchant’s RSA signature over the canonical headers and the body hash, with the total parsed from the signed bytes. One edited digit and no proof exists.'],
  ['UltraHonk · V5_0', 'The sound ZK flavour', 'zkVerify’s own verifier marks the older ZK flavours unsound, so we don’t use them. Live on Volta today, mainnet by config once enabled there.'],
  ['Base · 10 checks', 'Paid by a contract', 'Key, payee, window, caps, FX, nullifier and the zkVerify aggregation, each with its own error, before any USDC moves.'],
  ['Policy · EIP-712', 'An agent with no wallet power', 'Plain-English policy is compiled once to typed rules. The agent approves or flags; amount, payee and merchant come from the proof.'],
];

function Trust() {
  return (
    <section id="trust" className="scroll-mt-20 bg-paper text-paper-ink">
      <div className="mx-auto max-w-[1320px] px-5 pt-24 pb-10 md:px-8 md:pt-36">
        <div className="flex items-start justify-between gap-6">
          <h2 className="display text-[clamp(4.2rem,15vw,13rem)]"><BlurWord text="Trust" /></h2>
          <span className="micro mt-3 rounded-full border border-paper-line px-2.5 py-1 text-paper-ink-2">04</span>
        </div>
        <p className="mt-6 max-w-[48ch] text-lg text-paper-ink-2">Built so nobody has to take our word for it. 216 tests across the circuit, the contract and the agent.</p>
      </div>
      <div className="dash-t mx-auto grid max-w-[1320px] md:grid-cols-2">
        {TRUST.map(([tag, t, d], k) => (
          <Reveal key={t} delay={(k % 2) * 0.08} className={`dash-b px-5 py-10 md:px-8 md:py-14 ${k % 2 ? 'md:border-l md:border-dashed md:border-paper-line' : ''}`}>
            <div className="micro text-paper-ink-2"><span className="tag">{tag}</span></div>
            <h3 className="mt-10 text-[1.9rem] font-light tracking-tight md:text-[2.4rem]">{t}</h3>
            <p className="mt-3 max-w-[50ch] leading-relaxed text-paper-ink-2">{d}</p>
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
  ['Is this on mainnet?', 'Not yet. It runs end to end on testnet today: proofs verified on zkVerify’s Volta and paid in USDC by the vault on Base Sepolia. Tremor switches to mainnet when zkVerify enables the sound ZK proof type there.'],
];

function Faq() {
  const [open, setOpen] = useState(0);
  return (
    <section id="faq" className="scroll-mt-20 bg-paper text-paper-ink">
      <div className="mx-auto grid max-w-[1320px] gap-12 px-5 py-24 md:grid-cols-[0.8fr_1.2fr] md:px-8 md:py-36">
        <div>
          <span className="micro rounded-full border border-paper-line px-2.5 py-1 text-paper-ink-2">05</span>
          <h2 className="display mt-8 text-[clamp(3rem,6vw,5.5rem)]">Questions,<br /><span className="text-paper-ink-2">answered plainly.</span></h2>
        </div>
        <div className="dash-t">
          {FAQ.map(([q, a], i) => (
            <div key={q} className="dash-b">
              <button onClick={() => setOpen(open === i ? -1 : i)} className="flex w-full items-center justify-between gap-6 py-6 text-left text-lg tracking-tight md:text-xl" aria-expanded={open === i}>
                <span className="flex items-baseline gap-5"><span className="micro text-paper-ink-2">{String(i + 1).padStart(2, '0')}</span>{q}</span>
                <span className={`grid size-8 shrink-0 place-items-center rounded-full border transition-colors ${open === i ? 'border-paper-ink bg-paper-ink text-paper' : 'border-paper-line'}`}>{open === i ? <Minus size={14} /> : <Plus size={14} />}</span>
              </button>
              <AnimatePresence initial={false}>
                {open === i && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.4, ease }} className="overflow-hidden">
                    <p className="max-w-[60ch] pb-7 pl-[2.6rem] leading-relaxed text-paper-ink-2">{a}</p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ final + footer */

function FinalCta() {
  return (
    <section className="ember relative isolate overflow-hidden">
      <StarField className="-z-10" />
      <div className="mx-auto max-w-[1320px] px-5 pt-32 pb-16 md:px-8 md:pt-44">
        <Reveal>
          <div className="micro text-ink-2"><span className="tag">Sandbox · Volta → Base Sepolia</span></div>
          <h2 className="display mt-8 max-w-[14ch] text-[clamp(3.2rem,8.4vw,8.5rem)]">Try it with a signed sample.</h2>
          <div className="mt-12 flex flex-wrap items-center gap-3">
            <Magnetic href={APP} className="btn btn-primary">Prove a receipt <ArrowRight size={16} weight="bold" /></Magnetic>
            <span className="max-w-[40ch] text-sm text-ink-2">One click: the test merchant signs a receipt, your browser proves it, and the vault pays real testnet USDC on Base Sepolia.</span>
          </div>
        </Reveal>
        <footer className="mt-32 grid gap-6 border-t border-white/15 pt-8 text-sm text-ink-2 md:grid-cols-3">
          <a href="/" className="flex items-center gap-2 text-ink"><Waveform size={18} weight="bold" className="text-accent" />tremor</a>
          <div className="flex gap-6 md:justify-center">
            <a href={APP} className="hover:text-ink">App</a>
            <a href={`${APP_URL}#verify`} className="hover:text-ink">Verify a payout</a>
            <a href="https://github.com/zeel991" className="flex items-center gap-1 hover:text-ink"><GithubLogo size={15} />GitHub</a>
          </div>
          <div className="md:text-right">Built on zkVerify for Agent Games 2026</div>
        </footer>
      </div>
    </section>
  );
}

export default function Landing() {
  useSmoothScroll();
  useEffect(() => { document.title = 'Tremor: receipts that can’t be faked'; }, []);
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <ReceiptTrack />
        <Chapter id="proof" n="01" word="Proof" listTitle="One proof shows"
          list={['Merchant DKIM signature', 'The signed total', 'The signed date', 'Your inbox, hidden', 'One claim per email']}
          body="A photo of a receipt proves nothing. The email it arrived in proves everything: the merchant signs it with DKIM, and one changed digit breaks the signature. Tremor turns that signature into a zero-knowledge proof your employer can pay against." />
        <Privacy />
        <Night />
        <Trust />
        <Faq />
        <FinalCta />
      </main>
    </>
  );
}
