import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  Waveform, IdentificationCard, Envelope, Cpu, PaperPlaneTilt, CheckCircle, XCircle, WarningCircle,
  UploadSimple, DownloadSimple, ArrowRight, ArrowSquareOut, MagnifyingGlass, ListBullets, CircleNotch, Copy, Compass,
} from '@phosphor-icons/react';
import { Seismograph } from '../components/Seismograph.jsx';
import { Tour, TourPrompt } from '../components/Tour.jsx';
import { loadConfig, CONFIG } from '../lib/config.js';
import { computeToCommit, proveInWorker } from '../lib/prover.js';
import { resolveKey } from '../lib/keys.js';
import { verifyPayout } from '../lib/chain.js';
import { parseEmail, verifyWithModulus } from '@rp/dkim-verify.mjs';
import { buildInputs } from '@rp/inputs.mjs';
import { TEMPLATES } from '@rp/templates.mjs';
import { HOME_URL, APP_BASE } from '../lib/site.js';

const ease = [0.16, 1, 0.3, 1];
const LS = 'tremor.identity.v1';
const BN254 = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (u8) => '0x' + Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
const short = (h, n = 6) => (h.length > 2 * n + 3 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);
const money = (minor, cur) => `${Number(cur) === 840 ? '$' : '₹'}${(Number(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const loadId = () => { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch { return null; } };
const saveId = (x) => { try { localStorage.setItem(LS, JSON.stringify(x)); } catch {} };
function newSalt() { const b = crypto.getRandomValues(new Uint8Array(32)); b[0] &= 0x1f; return hex(b); }

async function api(path, body) {
  const r = await fetch(CONFIG.agentUrl + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) { const e = new Error(typeof data === 'string' ? data : data.error || r.statusText); e.status = r.status; e.data = data; throw e; }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

/** Wait until a Base Sepolia tx is mined, so anything dated after this moment is after it on chain too. */
async function waitForTx(hash, timeoutMs = 90000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    try {
      const j = await fetch(CONFIG.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }) }).then((r) => r.json());
      if (j.result) { if (j.result.status !== '0x1') throw new Error('The registration transaction reverted.'); return j.result; }
    } catch (e) { if (/reverted/.test(e.message)) throw e; }
    await sleep(1500);
  }
  throw new Error('Registration is taking longer than usual. Try again in a minute.');
}

/** Register a commitment with the sandbox vault and wait for it to be mined (409 = already registered). */
async function registerId(id) {
  try {
    const r = await api('/api/register', { vaultId: 0, toCommit: '0x' + BigInt(id.toCommit).toString(16), wallet: id.wallet });
    if (r.txHash) await waitForTx(r.txHash);
    return { ...id, registered: true, registerTx: r.txHash };
  } catch (e) {
    if (e.status === 409) return { ...id, registered: true };
    throw e;
  }
}

async function makeIdentity(inbox, wallet, prev) {
  const addr = inbox.trim().toLowerCase();
  const salt = prev && prev.inbox === addr ? prev.salt : newSalt();
  const toCommit = await computeToCommit(addr, salt);
  return { inbox: addr, wallet: wallet.trim(), salt, toCommit: toCommit.toString() };
}

/** Parse an .eml, find the merchant's key, verify DKIM and match a template. All on this device. */
async function checkReceipt(raw) {
  const parsed = parseEmail(raw);
  const sig = parsed.sigs.find((s) => s.tags.a === 'rsa-sha256');
  if (!sig) throw new Error('No rsa-sha256 DKIM signature in this email.');
  const key = await resolveKey(sig.tags.d, sig.tags.s);
  if (!key.modulus) throw new Error(`No DKIM key found for ${sig.tags.d} (selector ${sig.tags.s}).`);
  const dkim = verifyWithModulus(parsed, sig, key.modulus);
  const body = new TextDecoder('latin1').decode(dkim.body);
  const tpl = Object.entries(TEMPLATES).find(([, t]) => body.includes(t.anchor));
  if (!tpl) throw new Error('This merchant’s receipt layout isn’t supported yet.');
  const amountText = /([0-9][0-9,]*(?:\.[0-9]{2})?)/.exec(body.split(tpl[1].anchor)[1] || '')?.[1] || '?';
  const hdr = (n) => parsed.headers.find(([k]) => k.toLowerCase() === n)?.[1]?.trim() || '';
  return {
    dkim, templateId: +tpl[0], merchant: tpl[1].name, verified: tpl[1].verified,
    domain: sig.tags.d, selector: sig.tags.s, bits: dkim.modulusLength,
    amountText: `${tpl[1].currency === 840 ? '$' : '₹'}${amountText}`, to: hdr('to'), date: hdr('date'), sources: key.sources,
  };
}

/** How far a claim has got: 1 agent, 2 queued, 3 verified on zkVerify, 4 aggregated to Base, 5 paid. */
function claimStage(c) {
  if (!c) return 0;
  if (c.status === 'PAID') return 5;
  if (c.status === 'AGGREGATED' || c.status === 'SETTLE_SENT' || c.kurierStatus === 'Aggregated') return 4;
  if (['IncludedInBlock', 'Finalized', 'AggregationPending'].includes(c.kurierStatus)) return 3;
  return c.kurierStatus ? 2 : 1;
}
const isTerminal = (c) => /PAID|FAIL|REJECT|FLAG/.test(c?.status || '');

function friendly(e) {
  if (e?.status === 429) return 'The sandbox’s daily limit for this network has been reached. Please try again tomorrow, or use your own receipt below.';
  if (e?.status === 502 || e?.status === 503) return `The agent couldn’t reach Base Sepolia just now (${e.data?.error || e.status}). Please try again in a moment.`;
  return e?.data?.error ? `${e.data.error}${e.data.reasons?.length ? `: ${e.data.reasons.join(', ')}` : ''}` : String(e?.message || e);
}

const PUBS = [
  ['pubkey_hash', 'Merchant DKIM key, hashed'], ['nullifier', 'Salted, one claim per email'], ['template_id', 'Merchant layout matched'],
  ['amount_minor', 'The proven total'], ['currency', 'ISO 4217 code'], ['sent_at', 'Signed Date header'],
  ['to_commit', 'Your salted inbox commitment'], ['recipient', 'Wallet the vault must pay'], ['vault_id', 'Company vault'],
];

/* ---------------- shell ---------------- */
function Shell({ tab, setTab, onGuide, children }) {
  const tabs = [['prove', 'Prove', Cpu], ['verify', 'Verify a payout', MagnifyingGlass], ['activity', 'Activity', ListBullets]];
  return (
    <div className="min-h-[100dvh] [background:radial-gradient(70%_45%_at_100%_100%,color-mix(in_srgb,var(--ember)_22%,transparent),transparent_70%),var(--bg)] bg-fixed">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-bg/80 backdrop-blur-md">
        <div className="mx-auto grid h-16 max-w-[1400px] grid-cols-[auto_1fr_auto] items-center gap-4 px-4 md:grid-cols-[1fr_auto_1fr] md:px-6">
          <a href={HOME_URL} className="flex items-center gap-4"><span className="flex items-center gap-2 text-[1.02rem] font-medium tracking-tight"><Waveform size={20} weight="bold" className="text-accent" />tremor</span><span className="micro hidden leading-tight text-ink-3 lg:block">Prove a<br />receipt</span></a>
          <nav data-tour="tabs" className="flex justify-center gap-1 rounded-full border border-ink/40 p-1">
            {tabs.map(([id, label, Icon]) => (
              <button key={id} data-tour={`tab-${id}`} onClick={() => setTab(id)} aria-label={label} className={`micro flex items-center gap-2 rounded-full px-3 py-2 transition-colors ${tab === id ? 'bg-accent text-accent-ink' : 'text-ink-2 hover:text-ink'}`}>
                <Icon size={13} weight="bold" className="sm:hidden" /><span className={`box hidden sm:inline-block ${tab === id ? '!border-accent-ink !bg-accent-ink' : ''}`} /><span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-4 justify-self-end">
            <span data-tour="network" className="micro hidden text-ink-3 lg:block">{CONFIG.network}</span>
            <button onClick={onGuide} data-tour="guide" aria-label="Open the guide" className="micro flex items-center gap-2 rounded-full border border-ink/40 px-3 py-2 text-ink-2 transition-colors hover:border-ink hover:text-ink"><Compass size={14} weight="bold" /><span className="hidden sm:inline">Guide</span></button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1400px] px-4 py-8 md:px-6 md:py-12">{children}</main>
    </div>
  );
}

function Status({ kind = 'info', children }) {
  const map = { ok: [CheckCircle, 'text-ok'], bad: [XCircle, 'text-bad'], warn: [WarningCircle, 'text-accent'], info: [CircleNotch, 'text-ink-3 animate-spin'] };
  const [Icon, cls] = map[kind];
  return <div className="flex items-start gap-2 text-sm"><Icon size={18} weight={kind === 'info' ? 'regular' : 'fill'} className={`mt-0.5 shrink-0 ${cls}`} /><div className="min-w-0 break-words">{children}</div></div>;
}

/* ---------------- prove flow ---------------- */
const STEPS = [
  ['identity', 'Your inbox', IdentificationCard],
  ['receipt', 'Receipt', Envelope],
  ['proof', 'Proof', Cpu],
  ['submit', 'Submit', PaperPlaneTilt],
];

function Rail({ step, done, go }) {
  return (
    <ol className="flex gap-2 md:flex-col md:gap-1">
      {STEPS.map(([id, label, Icon], i) => {
        const active = step === id, isDone = done[id];
        const reachable = i === 0 || done[STEPS[i - 1][0]];
        return (
          <li key={id} className="flex-1 md:flex-none">
            <button disabled={!reachable} onClick={() => go(id)}
              className={`relative flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm transition-colors disabled:opacity-40 ${active ? 'text-ink' : 'text-ink-2 hover:text-ink'}`}>
              {active && <motion.span layoutId="rail-active" transition={{ type: 'spring', stiffness: 380, damping: 32 }} className="absolute inset-0 -z-10 rounded-xl border border-accent/60" />}
              <span className={`grid size-7 shrink-0 place-items-center rounded-full border ${isDone ? 'border-transparent bg-accent text-accent-ink' : active ? 'border-accent text-accent' : 'border-line'}`}>
                {isDone ? <CheckCircle size={16} weight="bold" /> : <Icon size={15} />}
              </span>
              <span className="hidden md:block"><span className="micro block text-ink-3">( 0{i + 1} )</span><span className="micro mt-0.5 block !text-[.74rem] text-ink">{label}</span></span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function Panel({ title, sub, children }) {
  const reduce = useReducedMotion();
  return (
    <motion.section initial={reduce ? false : { opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease }} className="frame bg-bg p-6 md:p-8">
      <div className="flex items-start justify-between gap-4">
        <h2 className="display text-[clamp(1.9rem,4vw,3.4rem)]">{title}</h2>
        <span className="grip mt-2 text-ink-3"><i /><i /><i /><i /><i /><i /></span>
      </div>
      {sub && <p className="mt-4 max-w-[60ch] text-ink-2">{sub}</p>}
      <div className="mt-7">{children}</div>
    </motion.section>
  );
}

function IdentityStep({ identity, onDone }) {
  const [inbox, setInbox] = useState(identity?.inbox || '');
  const [wallet, setWallet] = useState(identity?.wallet || '');
  const [err, setErr] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    const er = {};
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inbox.trim())) er.inbox = 'Enter the address your receipts are sent to.';
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet.trim())) er.wallet = 'Enter a 0x wallet address (40 hex characters).';
    setErr(er); if (Object.keys(er).length) return;
    setBusy(true); setMsg(['info', 'Computing your commitment with the same Noir code the circuit uses…']);
    try {
      let id = await makeIdentity(inbox, wallet, identity);
      setMsg(['info', 'Registering it with the sandbox vault on Base Sepolia (a few seconds)…']);
      id = await registerId(id);
      saveId(id);
      setMsg(['ok', 'Commitment registered with the sandbox vault.']);
      onDone(id);
    } catch (e3) { setMsg(['bad', friendly(e3)]); } finally { setBusy(false); }
  };
  return (
    <Panel title="Who gets paid" sub="Tremor binds a receipt to your inbox without ever learning it. Your browser makes a secret salt and publishes only a commitment.">
      <form onSubmit={submit} className="grid gap-5 md:max-w-xl" noValidate>
        <div className="field">
          <label htmlFor="inbox">Inbox the receipt was sent to</label>
          <input id="inbox" type="email" autoComplete="email" value={inbox} onChange={(e) => setInbox(e.target.value)} placeholder="you@company.com" />
          {err.inbox ? <span className="err">{err.inbox}</span> : <span className="help">Stays in this browser. Only Poseidon2(inbox, salt) leaves it.</span>}
        </div>
        <div className="field">
          <label htmlFor="wallet">Wallet for the USDC payout</label>
          <input id="wallet" value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="0x…" spellCheck="false" className="mono" />
          {err.wallet ? <span className="err">{err.wallet}</span> : <span className="help">The proof binds this address, so a stolen proof pays nobody else.</span>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-primary" disabled={busy}>{busy ? <CircleNotch size={18} className="animate-spin" /> : null} Register</button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => { setInbox(`judge-${randHex(3).slice(2)}@tremor.in`); setWallet(randHex(20)); }}>Use demo details</button>
          {identity && <span className="mono text-xs text-ink-3">current: {short('0x' + BigInt(identity.toCommit).toString(16))}</span>}
        </div>
        {msg && <Status kind={msg[0]}>{msg[1]}</Status>}
      </form>
    </Panel>
  );
}

function ReceiptCard({ r }) {
  return (
    <div className="overflow-hidden rounded-[14px] border border-line bg-bg">
      <div className="flex items-center justify-between border-b border-line px-5 py-3 text-xs text-ink-3">
        <span className="mono">{r.domain}</span><span>selector <span className="mono">{r.selector}</span></span>
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-y-1 p-5">
        <div className="text-lg font-semibold">{r.merchant}</div>
        <div className="mono text-2xl tracking-tight">{r.amountText}</div>
        <div className="text-sm text-ink-3">to {r.to}</div>
        <div className="text-right text-sm text-ink-3">{r.date}</div>
      </div>
      <div className="grid gap-2 border-t border-line px-5 py-4">
        <Status kind="ok">DKIM signature valid ({r.bits}-bit RSA)</Status>
        {r.sources.map((s) => (
          <div key={s.name} className="flex items-center justify-between text-xs text-ink-3">
            <span>{s.name}</span><span className={s.status === 'found' ? 'text-ok' : ''}>{s.status === 'found' ? 'key found' : s.status === 'none' ? 'not listed' : 'unreachable'}</span>
          </div>
        ))}
        {!r.verified && <Status kind="warn">This merchant template hasn't been checked against real mail yet.</Status>}
      </div>
    </div>
  );
}

function ReceiptStep({ identity, onDone }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [rec, setRec] = useState(null);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef(null);
  const use = useCallback(async (raw) => {
    setRec(null); setMsg(['info', 'Checking the DKIM signature on this device…']);
    try { const r = await checkReceipt(raw); setRec(r); setMsg(null); onDone(r); }
    catch (e) { setMsg(['bad', String(e.message || e)]); }
  }, [onDone]);
  const sample = async () => {
    setBusy(true);
    try { const eml = await api('/api/sample-receipt', { to: identity.inbox }); await use(typeof eml === 'string' ? eml : eml.eml); }
    catch (e) { setMsg(['bad', friendly(e)]); }
    finally { setBusy(false); }
  };
  const onFile = async (f) => { if (f) use(new Uint8Array(await f.arrayBuffer())); };
  return (
    <Panel title="Add a receipt email" sub="Use a signed sample from the Tremor test merchant, or drop a real receipt saved as .eml. Nothing is uploaded.">
      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <div className="grid content-start gap-4">
          <button onClick={sample} disabled={busy} className="btn btn-primary w-fit">{busy && <CircleNotch size={18} className="animate-spin" />} Get a signed sample (₹49)</button>
          <div
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files[0]); }}
            onClick={() => fileRef.current?.click()} role="button" tabIndex={0}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileRef.current?.click()}
            className={`grid cursor-pointer place-items-center gap-2 rounded-2xl border border-dashed p-10 text-center transition-colors ${drag ? 'border-accent bg-accent/5' : 'border-line hover:border-ink-3'}`}>
            <UploadSimple size={26} className="text-ink-3" />
            <div className="font-medium">Drop a receipt .eml here</div>
            <div className="text-sm text-ink-3">In Gmail: open the email, then Download message.</div>
            <input ref={fileRef} type="file" accept=".eml,message/rfc822" className="hidden" onChange={(e) => onFile(e.target.files[0])} />
          </div>
          {msg && <Status kind={msg[0]}>{msg[1]}</Status>}
        </div>
        <div>{rec ? <ReceiptCard r={rec} /> : (
          <div className="hidden h-full min-h-[260px] place-items-center rounded-[14px] border border-line p-8 text-center text-sm text-ink-3 lg:grid">
            The checked receipt appears here: merchant, total, date, and which key sources vouched for it.
          </div>
        )}</div>
      </div>
    </Panel>
  );
}

const PHASES = [['witness', 'Solving the circuit'], ['backend', 'Loading the prover'], ['prove', 'Generating the ZK proof'], ['verify', 'Verifying it locally']];

function ProofStep({ identity, receipt, onDone, proof }) {
  const seis = useRef(null);
  const [phase, setPhase] = useState({});
  const [state, setState] = useState(proof ? 'done' : 'idle');
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);
  const t0 = useRef(0);
  const run = async () => {
    setState('running'); setErr(null); setPhase({}); setNote(null); t0.current = performance.now();
    try {
      const { inputs, meta, circuit } = buildInputs(receipt.dkim, { templateId: receipt.templateId, salt: identity.salt, recipient: identity.wallet, vaultId: 0 });
      if (meta.toAddress.toLowerCase() !== identity.inbox) setNote(`This email was sent to ${meta.toAddress}, not ${identity.inbox}. The vault will refuse to pay it.`);
      const r = await proveInWorker(inputs, (k, ms) => {
        if (k === 'fallback') { setNote('This browser blocks the parallel prover, so Tremor is proving on one thread. It takes a little longer.'); return; }
        setPhase((p) => ({ ...p, [k]: ms })); seis.current?.pulse(0.25);
      }, { circuit });
      if (r.publicInputs.some((p) => BigInt(p) >= BN254)) throw new Error('A public input is out of range.');
      seis.current?.pulse(1.4);
      setState('done');
      onDone({ ...r, circuit: circuit === 'receipt_rsa1024' ? 'rsa1024' : 'rsa2048', seconds: (performance.now() - t0.current) / 1000 });
    } catch (e) { setState('idle'); setErr(String(e.message || e)); seis.current?.flat(); }
  };
  return (
    <Panel title="Prove it, on this device" sub="The circuit checks the signature, the total, the date and your inbox. Only the proof and nine public values come out.">
      <div className="relative overflow-hidden rounded-[14px] border border-line bg-bg">
        <Seismograph ref={seis} height={120} />
        <AnimatePresence>
          {state === 'done' && [0, 1, 2].map((k) => (
            <motion.span key={`ring-${k}-${proof?.seconds}`} aria-hidden="true"
              initial={{ scale: 0.2, opacity: 0.7 }} animate={{ scale: 6, opacity: 0 }}
              transition={{ duration: 1.6, delay: k * 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="pointer-events-none absolute top-1/2 left-1/2 -mt-10 -ml-10 size-20 rounded-full border-2 border-accent" />
          ))}
        </AnimatePresence>
      </div>
      <div className="mt-6 grid gap-6 md:grid-cols-[1fr_auto] md:items-start">
        <ol className="grid gap-3">
          {PHASES.map(([k, label]) => {
            const done = phase[k] != null, active = state === 'running' && !done && PHASES.findIndex(([x]) => phase[x] == null) === PHASES.findIndex(([x]) => x === k);
            return (
              <li key={k} className="flex items-center gap-3 text-sm">
                {done || (state === 'done') ? <CheckCircle size={18} weight="fill" className="text-ok" /> : active ? <CircleNotch size={18} className="animate-spin text-accent" /> : <span className="size-[18px] rounded-full border border-line" />}
                <span className={done || state === 'done' ? 'text-ink' : 'text-ink-3'}>{label}</span>
                {done && <span className="mono text-xs text-ink-3">{(phase[k] / 1000).toFixed(1)} s</span>}
              </li>
            );
          })}
        </ol>
        <button onClick={run} disabled={state === 'running'} className="btn btn-primary">{state === 'running' ? <><CircleNotch size={18} className="animate-spin" /> Proving</> : state === 'done' ? 'Prove again' : <>Generate proof <ArrowRight size={18} weight="bold" /></>}</button>
      </div>
      <div className="mt-5 grid gap-2">
        {note && <Status kind="warn">{note}</Status>}
        {err && <Status kind="bad">{err}</Status>}
        {proof && state === 'done' && <Status kind="ok">Proof ready: {proof.proof.length.toLocaleString()} bytes in {proof.seconds.toFixed(1)} s, verified locally.</Status>}
      </div>
      {proof && (
        <div className="mt-8 overflow-hidden rounded-[14px] border border-line">
          <div className="border-b border-line px-5 py-3 text-sm text-ink-3">The nine public values (everything a verifier learns)</div>
          <div className="divide-y divide-line">
            {proof.publicInputs.map((p, i) => {
              const v = BigInt(p);
              const val = i === 3 ? money(v, BigInt(proof.publicInputs[4])) : i === 5 ? new Date(Number(v) * 1000).toISOString().replace('.000Z', 'Z') : i === 4 ? (Number(v) === 840 ? 'USD (840)' : 'INR (356)') : i === 2 || i === 8 ? v.toString() : short('0x' + v.toString(16), 8);
              return (
                <motion.div key={i} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.25 + i * 0.06, duration: 0.45, ease }} className="grid grid-cols-[1fr_auto] gap-x-4 px-5 py-3 text-sm md:grid-cols-[180px_1fr_auto]">
                  <span className="mono">{PUBS[i][0]}</span>
                  <span className="hidden text-ink-3 md:block">{PUBS[i][1]}</span>
                  <span className="mono text-right">{val}</span>
                </motion.div>
              );
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}

const STAGES = [['RECEIVED', 'Agent checks policy and the vault'], ['Queued', 'Queued for zkVerify'], ['IncludedInBlock', 'Verified on zkVerify'], ['Aggregated', 'Aggregated to Base'], ['PAID', 'USDC paid by the vault']];

function SubmitStep({ proof }) {
  const [note, setNote] = useState('');
  const [res, setRes] = useState(null);
  const [claim, setClaim] = useState(null);
  const [busy, setBusy] = useState(false);
  const body = { vaultId: 0, circuit: proof.circuit, proof: hex(proof.proof), pubs: proof.publicInputs, ...(note.trim() ? { note: note.trim() } : {}) };
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }));
    a.download = 'tremor-claim.json'; a.click();
  };
  const submit = async () => {
    setBusy(true); setRes(null);
    try { const r = await api('/api/claim', body); setRes({ ok: true, ...r }); if (r.claimId) follow(r.claimId); }
    catch (e) {
      setRes({ ok: false, error: friendly(e) });
    } finally { setBusy(false); }
  };
  const follow = async (id) => {
    try { const c = await api(`/api/claim/${id}`); setClaim(c); if (!isTerminal(c)) setTimeout(() => follow(id), 6000); }
    catch { setTimeout(() => follow(id), 8000); }
  };
  const reached = claim ? claimStage(claim) : res?.ok ? 1 : 0;
  return (
    <Panel title="Submit for payment" sub="The agent checks your company's policy and the vault's rules first, then sends the proof to zkVerify. The vault pays only after zkVerify confirms it.">
      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <div className="grid content-start gap-5">
          <div className="field">
            <label htmlFor="note">Note for your manager (optional)</label>
            <input id="note" maxLength={280} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Client dinner, Bengaluru" />
            <span className="help">The only free text Tremor receives, and only if you add it.</span>
          </div>
          <div className="flex flex-wrap gap-3">
            <button onClick={submit} disabled={busy} className="btn btn-primary">{busy && <CircleNotch size={18} className="animate-spin" />} Submit proof</button>
            <button onClick={download} className="btn btn-ghost"><DownloadSimple size={18} /> Download claim</button>
          </div>
          {res?.ok && <Status kind={res.decision === 'REJECT' ? 'bad' : 'ok'}>Decision: {res.decision}{res.reasons?.length ? ` (${res.reasons.join(', ')})` : ''}{res.explanation ? `. ${res.explanation}` : ''}</Status>}
          {res && !res.ok && <Status kind="bad">{res.error}</Status>}
          {claim && /FAIL|FLAG/.test(claim.status) && <Status kind="bad">Claim {claim.status}{claim.error ? `: ${claim.error}` : ''}</Status>}
        </div>
        <ol className="grid content-start gap-0 rounded-[14px] border border-line p-5">
          {STAGES.map(([, label], i) => (
            <li key={label} className="flex items-center gap-3 py-2.5 text-sm">
              {i < reached ? <CheckCircle size={18} weight="fill" className="text-ok" /> : i === reached && res?.ok ? <CircleNotch size={18} className="animate-spin text-accent" /> : <span className="size-[18px] rounded-full border border-line" />}
              <span className={i < reached ? 'text-ink' : 'text-ink-3'}>{label}</span>
              {i === 2 && claim?.zkvTx && <a className="ml-auto text-accent" href={`${CONFIG.zkvExplorer}/extrinsic/${claim.zkvTx}`} target="_blank" rel="noreferrer"><ArrowSquareOut size={16} /></a>}
              {i === 4 && claim?.baseTx && <a className="ml-auto text-accent" href={`${CONFIG.explorer}/tx/${claim.baseTx}`} target="_blank" rel="noreferrer"><ArrowSquareOut size={16} /></a>}
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}

const DEMO = [
  ['id', 'Create a throwaway inbox and wallet'],
  ['reg', 'Register them with the sandbox vault'],
  ['rcpt', 'Get a receipt signed by the test merchant'],
  ['dkim', 'Check its DKIM signature on this device'],
  ['prove', 'Prove it in this tab'],
  ['agent', 'Agent checks policy and the vault'],
  ['zkv', 'Verified on zkVerify'],
  ['agg', 'Aggregated to Base'],
  ['paid', 'USDC paid by the vault'],
];

function TxLink({ href, children }) {
  return <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">{children}<ArrowSquareOut size={13} /></a>;
}

/** One click: identity → registration → signed sample → DKIM → proof → agent → zkVerify → Base → USDC. */
function Demo({ onIdentity, onVerify }) {
  const [st, setSt] = useState({});
  const [info, setInfo] = useState({});
  const [err, setErr] = useState(null);
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!running) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [running]);
  const mark = (k, v, extra) => { setSt((s) => ({ ...s, [k]: v })); if (extra !== undefined) setInfo((i) => ({ ...i, [k]: extra })); };

  const run = async () => {
    setRunning(true); setErr(null); setSt({}); setInfo({}); setStarted(Date.now());
    let k = 'id';
    try {
      mark(k, 'run');
      let id = await makeIdentity(`judge-${randHex(3).slice(2)}@tremor.in`, randHex(20), null);
      id.demo = true;
      mark(k, 'ok', <span className="mono">{id.inbox} → {short(id.wallet)}</span>);

      k = 'reg'; mark(k, 'run');
      id = await registerId(id); saveId(id); onIdentity(id);
      mark(k, 'ok', id.registerTx ? <TxLink href={`${CONFIG.explorer}/tx/${id.registerTx}`}>registerFor tx {short(id.registerTx)}</TxLink> : 'already registered');

      k = 'rcpt'; mark(k, 'run');
      const eml = await api('/api/sample-receipt', { to: id.inbox, amount: 25 });
      mark(k, 'ok', 'Tremor Test Merchant · ₹25.00');

      k = 'dkim'; mark(k, 'run');
      const r = await checkReceipt(typeof eml === 'string' ? eml : eml.eml);
      mark(k, 'ok', `d=${r.domain} · s=${r.selector} · RSA-${r.bits}`);

      k = 'prove'; mark(k, 'run');
      const t0 = performance.now();
      const { inputs, circuit } = buildInputs(r.dkim, { templateId: r.templateId, salt: id.salt, recipient: id.wallet, vaultId: 0 });
      const p = await proveInWorker(inputs, () => {}, { circuit });
      mark(k, 'ok', `UltraHonk ZK, ${p.proof.length.toLocaleString()} bytes in ${((performance.now() - t0) / 1000).toFixed(1)} s, verified locally`);

      k = 'agent'; mark(k, 'run');
      const res = await api('/api/claim', { vaultId: 0, circuit: circuit === 'receipt_rsa1024' ? 'rsa1024' : 'rsa2048', proof: hex(p.proof), pubs: p.publicInputs });
      if (res.decision !== 'APPROVE') throw new Error(`Agent decision ${res.decision}${res.reasons?.length ? `: ${res.reasons.join(', ')}` : ''}`);
      mark(k, 'ok', res.explanation || 'APPROVE');

      k = 'zkv'; mark(k, 'run');
      for (;;) {
        const c = await api(`/api/claim/${res.claimId}`).catch(() => null);
        if (c) {
          const s = claimStage(c);
          if (s >= 3) mark('zkv', 'ok', c.zkvTx ? <TxLink href={`${CONFIG.zkvExplorer}/extrinsic/${c.zkvTx}`}>zkVerify tx {short(c.zkvTx)}</TxLink> : undefined);
          if (s === 3) mark('agg', 'run', 'zkVerify publishes aggregations to Base every few minutes');
          if (s >= 4) { mark('agg', 'ok', `aggregation ${c.aggregationId}`); mark('paid', 'run', 'relayer is sending vault.claim'); }
          if (c.status === 'PAID') {
            mark('paid', 'ok', <span className="flex flex-wrap items-center gap-3"><TxLink href={`${CONFIG.explorer}/tx/${c.baseTx}`}>Base tx {short(c.baseTx)}</TxLink><button onClick={() => onVerify(c.baseTx)} className="text-accent underline">verify this payout</button></span>);
            break;
          }
          k = s >= 4 ? 'paid' : s >= 3 ? 'agg' : 'zkv';
          if (/FAIL|REJECT|FLAG/.test(c.status)) throw new Error(`Claim ${c.status}${c.error ? `: ${c.error}` : ''}`);
        }
        await sleep(5000);
      }
    } catch (e) { mark(k, 'bad'); setErr(friendly(e)); } finally { setRunning(false); }
  };

  useEffect(() => {
    const go = () => { if (!running) run(); };
    window.addEventListener('tremor:run-demo', go);
    return () => window.removeEventListener('tremor:run-demo', go);
  });

  const secs = started ? Math.round(((running ? now : Date.now()) - started) / 1000) : 0;
  const allOk = st.paid === 'ok';
  return (
    <section className="frame mb-8 overflow-hidden bg-bg p-6 md:p-8">
      <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr] lg:gap-10">
        <div className="grid content-start gap-5">
          <span className="micro tag text-accent">One click · Volta → Base Sepolia</span>
          <h2 className="display text-[clamp(1.9rem,4vw,3.4rem)]">Watch a receipt get paid.</h2>
          <p className="max-w-[52ch] text-ink-2">Tremor makes a throwaway inbox and wallet, asks the test merchant for a signed receipt, proves it in this tab, and follows it through zkVerify to a real USDC payout on Base Sepolia. No wallet, no gas, nothing to install.</p>
          <div className="flex flex-wrap items-center gap-4">
            <button data-tour="demo-run" onClick={run} disabled={running} className="btn btn-primary">{running ? <><CircleNotch size={18} className="animate-spin" /> Running · {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</> : allOk ? 'Run it again' : <>Run the full demo <ArrowRight size={18} weight="bold" /></>}</button>
            <span className="text-sm text-ink-3">About 5 minutes, mostly zkVerify aggregating to Base. Keep this tab open.</span>
          </div>
          {err && <Status kind="bad">{err}</Status>}
          {allOk && <Status kind="ok">Paid. Every step above is on a public chain: open the links, or verify the payout yourself.</Status>}
        </div>
        <ol data-tour="demo-steps" className="grid content-start rounded-[14px] border border-line p-2">
          {DEMO.map(([k, label]) => (
            <li key={k} className="flex items-start gap-3 rounded-lg px-3 py-2.5 text-sm">
              <span className="mt-0.5 shrink-0">
                {st[k] === 'ok' ? <CheckCircle size={18} weight="fill" className="text-ok" /> : st[k] === 'run' ? <CircleNotch size={18} className="animate-spin text-accent" /> : st[k] === 'bad' ? <XCircle size={18} weight="fill" className="text-bad" /> : <span className="block size-[18px] rounded-full border border-line" />}
              </span>
              <span className="min-w-0">
                <span className={st[k] ? 'text-ink' : 'text-ink-3'}>{label}</span>
                {info[k] && <span className="mt-0.5 block break-words text-xs text-ink-3">{info[k]}</span>}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function Prove({ onVerify }) {
  const [identity, setIdentity] = useState(loadId);
  const [receipt, setReceipt] = useState(null);
  const [proof, setProof] = useState(null);
  const [step, setStep] = useState(identity ? 'receipt' : 'identity');
  const done = { identity: !!identity, receipt: !!receipt, proof: !!proof, submit: false };
  return (
    <>
    <Demo onIdentity={(id) => { setIdentity(id); setReceipt(null); setProof(null); setStep('receipt'); }} onVerify={onVerify} />
    <div className="micro mb-4 text-ink-3">Or step by step, with your own receipt</div>
    <div data-tour="manual" className="grid gap-6 md:grid-cols-[220px_1fr] md:gap-10">
      <aside className="md:sticky md:top-24 md:self-start"><Rail step={step} done={done} go={setStep} /></aside>
      <div>
        {step === 'identity' && <IdentityStep identity={identity} onDone={(id) => { setIdentity(id); setReceipt(null); setProof(null); setStep('receipt'); }} />}
        {step === 'receipt' && <ReceiptStep identity={identity} onDone={(r) => { setReceipt(r); setProof(null); }} />}
        {step === 'proof' && <ProofStep identity={identity} receipt={receipt} proof={proof} onDone={setProof} />}
        {step === 'submit' && proof && <SubmitStep proof={proof} />}
        <div className="mt-6 flex justify-end">
          {step === 'receipt' && receipt && <button className="btn btn-primary" onClick={() => setStep('proof')}>Continue to proof <ArrowRight size={18} weight="bold" /></button>}
          {step === 'proof' && proof && <button className="btn btn-primary" onClick={() => setStep('submit')}>Continue to submit <ArrowRight size={18} weight="bold" /></button>}
        </div>
      </div>
    </div>
    </>
  );
}

/* ---------------- verify + activity ---------------- */
function Verify({ initialTx }) {
  const [tx, setTx] = useState(initialTx || '');
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const check = async (h) => {
    setErr(''); setRes(null);
    if (!/^0x[0-9a-fA-F]{64}$/.test(h.trim())) { setErr('Enter a 0x transaction hash (64 hex characters).'); return; }
    setBusy(true);
    try { setRes(await verifyPayout(h.trim())); } catch (e2) { setErr(e2.shortMessage || e2.message); } finally { setBusy(false); }
  };
  const run = (e) => { e.preventDefault(); check(tx); };
  useEffect(() => { if (initialTx) check(initialTx); }, [initialTx]);
  return (
    <Panel title="Verify a payout yourself" sub="Paste a Tremor payout transaction. Your browser decodes it, recomputes the zkVerify statement from its public values and asks zkVerify's contract on Base whether that exact statement was verified.">
      <form onSubmit={run} className="flex flex-col gap-3 md:flex-row" noValidate>
        <div className="field flex-1">
          <label htmlFor="tx">Base Sepolia transaction hash</label>
          <input id="tx" className="mono" value={tx} onChange={(e) => setTx(e.target.value)} placeholder="0x…" spellCheck="false" />
          {err && <span className="err">{err}</span>}
        </div>
        <button className="btn btn-primary self-start md:mt-7" disabled={busy}>{busy && <CircleNotch size={18} className="animate-spin" />} Verify</button>
      </form>
      {res && (
        <ol className="mt-8 grid gap-4">
          {res.steps.map((s) => <li key={s.title}><Status kind={s.ok ? 'ok' : 'bad'}><div>{s.title}</div><div className="mono mt-1 text-xs text-ink-3">{s.detail}</div></Status></li>)}
          <li className="rounded-xl border border-line p-4"><Status kind={res.ok ? 'ok' : 'bad'}>{res.ok ? 'This payout is backed by a zkVerify-verified receipt proof.' : 'This payout failed verification.'}</Status></li>
        </ol>
      )}
    </Panel>
  );
}

function Activity() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => api('/api/recent').then((d) => alive && (setRows(d.claims || []), setErr(false))).catch(() => alive && setErr(true));
    load(); const id = setInterval(load, 20000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return (
    <Panel title="Recent claims" sub="Public fields only. Employees appear as a short commitment, never a name or inbox.">
      {err && <Status kind="warn">The Tremor agent isn't reachable right now.</Status>}
      {!err && rows === null && <div className="grid gap-3">{[0, 1, 2].map((i) => <div key={i} className="h-12 animate-pulse rounded-xl bg-bg-2" />)}</div>}
      {rows && rows.length === 0 && <div className="rounded-xl border border-dashed border-line p-10 text-center text-ink-3">No claims yet. Prove a sample receipt to see the first one here.</div>}
      {rows && rows.length > 0 && (
        <div className="divide-y divide-line rounded-xl border border-line">
          {rows.map((c) => (
            <div key={c.id} className="grid grid-cols-2 gap-2 px-4 py-3 text-sm md:grid-cols-5">
              <span className="text-ink-3">{new Date(c.createdAt).toLocaleString()}</span>
              <span>{c.merchant || c.templateId}</span>
              <span className="mono">{money(c.amountMinor, c.currency)}</span>
              <span className="mono text-ink-3">{c.employee}</span>
              <span>{c.status || c.decision}</span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

const TOUR_KEY = 'tremor.tour.v1';
const TOUR = [
  { title: 'Welcome to Tremor', body: 'Tremor pays an expense only when a zero-knowledge proof shows the merchant’s own email signature covers the total. This guide takes about 30 seconds.' },
  { target: 'tabs', title: 'Three places to go', body: 'Prove is where receipts get proven and paid. Verify a payout lets anyone check a payment on chain. Activity lists recent claims.' },
  { target: 'demo-run', title: 'The fastest way in', body: 'One click runs everything with a signed sample receipt: no wallet, no gas, nothing to install. The USDC goes to a throwaway wallet made for you.' },
  { target: 'demo-steps', title: 'Follow every step', body: 'Each step ticks off as it happens and links to its transaction on zkVerify and Base. A full run takes about 5 minutes, mostly zkVerify aggregating to Base.' },
  { target: 'manual', title: 'Or bring your own receipt', body: 'Step by step: register an inbox and wallet, drop a receipt saved as .eml, prove it in the tab, then submit. The email itself never leaves your browser.' },
  { target: 'tab-verify', title: 'Check any payout yourself', body: 'Paste a payout transaction and your browser recomputes the zkVerify statement and asks zkVerify’s contract on Base whether it was verified. No trust in Tremor needed.' },
  { target: 'tab-activity', title: 'See recent claims', body: 'Public fields only: merchant, amount, status, and a short commitment instead of a name or inbox.' },
  { target: 'network', title: 'Testnet today', body: 'Proofs are verified on zkVerify’s Volta testnet and paid in test USDC on Base Sepolia. Mainnet follows once zkVerify enables the sound ZK proof type there.' },
  { target: 'guide', title: 'Ready when you are', body: 'You can reopen this guide any time from here. Start the demo now?', cta: 'Run the demo', run: true },
];

export default function AppPage() {
  const [tour, setTour] = useState(false);
  const [prompt, setPrompt] = useState(false);
  const seenTour = () => { try { return localStorage.getItem(TOUR_KEY) === '1'; } catch { return true; } };
  const markSeen = () => { try { localStorage.setItem(TOUR_KEY, '1'); } catch {} };
  const startTour = () => { markSeen(); setPrompt(false); setTab('prove'); setTimeout(() => setTour(true), 250); };
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState(() => (location.hash === '#verify' ? 'verify' : location.hash === '#activity' ? 'activity' : 'prove'));
  const [verifyTx, setVerifyTx] = useState(null);
  useEffect(() => { document.title = 'Tremor app'; loadConfig().then(() => setReady(true)); }, []);
  useEffect(() => { if (ready && !seenTour()) setPrompt(true); }, [ready]);
  useEffect(() => { history.replaceState(null, '', tab === 'prove' ? APP_BASE : `${APP_BASE}#${tab}`); }, [tab]);
  return (
    <Shell tab={tab} setTab={setTab} onGuide={startTour}>
      {!ready ? <div className="h-64 animate-pulse rounded-2xl bg-bg-2" /> : (
        <AnimatePresence mode="wait">
          <motion.div key={tab} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            {tab === 'prove' && <Prove onVerify={(h) => { setVerifyTx(h); setTab('verify'); }} />}
            {tab === 'verify' && <Verify initialTx={verifyTx} />}
            {tab === 'activity' && <Activity />}
          </motion.div>
        </AnimatePresence>
      )}
      <Tour steps={TOUR} open={tour} onClose={() => setTour(false)} onFinish={(st) => { if (st?.run) setTimeout(() => window.dispatchEvent(new Event('tremor:run-demo')), 300); }} />
      <TourPrompt show={prompt && !tour} onStart={startTour} onDismiss={() => { markSeen(); setPrompt(false); }} />
    </Shell>
  );
}
