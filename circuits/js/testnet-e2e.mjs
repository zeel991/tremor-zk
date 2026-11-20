#!/usr/bin/env node
// Testnet end-to-end payout for the sandbox vault (vault 0, Base Sepolia, zkVerify Volta).
//
//   node testnet-e2e.mjs prepare   register a test employee, fetch a fresh signed sample receipt, prove it
//   node testnet-e2e.mjs run       needs KURIER_API_KEY in ../../testnet-wallets.env: register the VKs with
//                                  Kurier (assert hashes), set the Worker secret, submit the claim, wait for PAID
//
// State goes to ../../.e2e/ (gitignored). Secrets are read from testnet-wallets.env and never printed.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend, Barretenberg } from '@aztec/bb.js';
import { parseEmail, verifyWithModulus } from './lib/dkim-verify.mjs';
import { buildInputs } from './lib/inputs.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const TARGET = path.resolve(import.meta.dirname, '../target');
const OUT = path.join(ROOT, '.e2e');
const AGENT = 'https://tremor-agent.agent-games-gatekeeper.workers.dev';
const KURIER = 'https://api-testnet.kurier.xyz/api/v1';
const RPC = 'https://sepolia.base.org';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const INBOX = 'sandbox-e2e@tremor.in';
const AMOUNT_INR = 25;
const BN254_R = 21888242871839275222594008174247212346651728263045756527864620449578941558337n;

fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, 'testnet-wallets.env'), 'utf8').split('\n')
  .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
const save = (f, o) => fs.writeFileSync(path.join(OUT, f), JSON.stringify(o, null, 2), { mode: 0o600 });
const load = (f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8'));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const circuit = (n) => JSON.parse(fs.readFileSync(path.join(TARGET, `${n}.json`), 'utf8'));
async function api(p, body) {
  const r = await fetch(AGENT + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
async function usdcBalance(a) {
  const data = '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0');
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDC, data }, 'latest'] }) });
  return BigInt((await r.json()).result);
}

async function prepare() {
  const wallet = env.EMPLOYEE_ADDRESS; if (!wallet) throw new Error('EMPLOYEE_ADDRESS missing in testnet-wallets.env');
  let id = fs.existsSync(path.join(OUT, 'identity.json')) ? load('identity.json') : null;
  if (!id) {
    const salt = (BigInt('0x' + crypto.randomBytes(32).toString('hex')) % BN254_R).toString();
    const bytes = Array.from(new TextEncoder().encode(INBOX)).map(String); const len = bytes.length; while (bytes.length < 124) bytes.push('0');
    const { returnValue } = await new Noir(circuit('commit')).execute({ addr: { storage: bytes, len: String(len) }, salt });
    id = { inbox: INBOX, wallet, salt, toCommit: BigInt(returnValue).toString() };
    save('identity.json', id);
  }
  log('employee wallet', wallet, 'toCommit', '0x' + BigInt(id.toCommit).toString(16).slice(0, 12) + '…');
  if (!id.registered) {
    const r = await api('/api/register', { vaultId: 0, toCommit: '0x' + BigInt(id.toCommit).toString(16), wallet });
    log('register', r.status, JSON.stringify(r.body));
    if (!(r.status >= 200 && r.status < 300) && r.status !== 409) throw new Error('registration failed');
    id.registered = true; id.registerResult = r.body; save('identity.json', id);
    log('waiting 20 s so the receipt is dated after the on-chain registration'); await sleep(20000);
  }
  const s = await fetch(AGENT + '/api/sample-receipt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: INBOX, amount: AMOUNT_INR }) });
  if (s.status !== 200) throw new Error(`sample-receipt ${s.status}: ${await s.text()}`);
  const eml = Buffer.from(await s.arrayBuffer()); fs.writeFileSync(path.join(OUT, 'receipt.eml'), eml, { mode: 0o600 });
  const key = (await api('/api/sandbox-key')).body;
  const parsed = parseEmail(eml.toString('latin1'));
  const sig = parsed.sigs.find((x) => x.tags.a === 'rsa-sha256');
  const dkim = verifyWithModulus(parsed, sig, BigInt(key.modulus));
  log(`DKIM ok d=${dkim.signingDomain} s=${dkim.selector}`);
  const b = buildInputs(dkim, { templateId: 100, salt: id.salt, recipient: wallet, vaultId: 0 });
  const c = circuit(b.circuit); const t = Date.now();
  const { witness } = await new Noir(c).execute(b.inputs);
  const bb = await Barretenberg.new({ threads: os.cpus().length, logger: () => {} });
  const be = new UltraHonkBackend(c.bytecode, bb);
  const proof = await be.generateProof(witness, { verifierTarget: 'evm' });
  const ok = await be.verifyProof(proof, { verifierTarget: 'evm' }); await bb.destroy();
  if (!ok) throw new Error('local verification failed');
  if (BigInt(proof.publicInputs[6]) !== BigInt(id.toCommit)) throw new Error('toCommit in proof does not match the registered one');
  save('claim.json', { vaultId: 0, circuit: b.circuit === 'receipt_rsa1024' ? 'rsa1024' : 'rsa2048', proof: '0x' + Buffer.from(proof.proof).toString('hex'), pubs: proof.publicInputs });
  log(`proved ${b.meta.amountText} INR in ${((Date.now() - t) / 1000).toFixed(1)} s; claim saved to .e2e/claim.json`);
}

async function run() {
  const key = env.KURIER_API_KEY; if (!key) throw new Error('add KURIER_API_KEY=... to testnet-wallets.env first');
  const scrub = (s) => String(s).split(key).join('***');
  const want = JSON.parse(fs.readFileSync(path.join(ROOT, 'circuits/vk-hashes.json'), 'utf8'));
  for (const n of ['receipt_rsa2048', 'receipt_rsa1024']) {
    const vk = '0x' + fs.readFileSync(path.join(TARGET, `${n}.vk`)).toString('hex');
    const r = await fetch(`${KURIER}/register-vk/${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ proofType: 'ultrahonk', proofOptions: { version: 'V5_0', variant: 'ZK' }, vk }) });
    const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch {}
    const got = j.vkHash || j.meta?.vkHash;
    log('register-vk', n, r.status, got || scrub(txt).slice(0, 200));
    if (got && got.toLowerCase() !== want[n].toLowerCase()) throw new Error(`vkHash mismatch for ${n}: ${got} != ${want[n]}`);
    if (!got && !/already/i.test(txt)) throw new Error('register-vk failed');
  }
  const sp = spawnSync('npx', ['wrangler', 'secret', 'put', 'KURIER_API_KEY'], { cwd: path.join(ROOT, 'agent'), input: key, encoding: 'utf8' });
  log('worker secret KURIER_API_KEY', sp.status === 0 ? 'set' : 'FAILED ' + scrub(sp.stderr).slice(-300));
  if (sp.status !== 0) throw new Error('wrangler secret put failed');
  await sleep(8000);

  const wallet = load('identity.json').wallet; const before = await usdcBalance(wallet);
  let rec = fs.existsSync(path.join(OUT, 'record.json')) ? load('record.json') : {};
  if (!rec.claimId) {
    const r = await api('/api/claim', load('claim.json'));
    log('claim', r.status, JSON.stringify(r.body).slice(0, 400));
    rec = { claimId: r.body.id || r.body.claimId, submitResponse: r.body, usdcBefore: before.toString() }; save('record.json', rec);
    if (!rec.claimId) throw new Error('claim not accepted');
  }
  let last = '';
  for (let i = 0; i < 180; i++) { // up to ~90 min; aggregation on Volta can take a while
    const c = (await api(`/api/claim/${rec.claimId}`)).body;
    const line = `${c.status} kurier=${c.kurierStatus ?? c.kurier_status ?? ''} zkv=${c.zkvTx ?? c.zkv_tx ?? ''} agg=${c.aggregationId ?? c.aggregation_id ?? ''} base=${c.baseTx ?? c.base_tx ?? ''}`;
    if (line !== last) { log(line); last = line; }
    Object.assign(rec, { last: c }); save('record.json', rec);
    if (['PAID', 'SETTLE_FAILED', 'REJECTED', 'FAILED', 'FLAGGED'].includes(c.status)) break;
    await sleep(30000);
  }
  const after = await usdcBalance(wallet);
  rec.usdcAfter = after.toString(); save('record.json', rec);
  log(`employee USDC ${before} -> ${after} (+${after - before} base units). Record: .e2e/record.json`);
}

const cmd = process.argv[2];
if (cmd === 'prepare') await prepare(); else if (cmd === 'run') await run();
else { console.error('usage: node testnet-e2e.mjs prepare|run'); process.exit(2); }
