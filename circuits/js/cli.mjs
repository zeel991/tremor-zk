#!/usr/bin/env node
// ReceiptProof CLI fallback (SPEC 3): prove a receipt .eml locally with native-speed bb.js, then
// optionally submit. The email never leaves this machine; only {vaultId, circuit, proof, pubs, note}.
//
//   node cli.mjs prove <receipt.eml> --identity receiptproof-identity.json [--vault 0] [--template auto]
//                [--key-txt "v=DKIM1; p=..."] [--out claim.json] [--submit https://agent.example] [--note "..."]
//
// identity.json is what the web app exports ("Export salt"): {inbox, wallet, salt}.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import dns from 'node:dns/promises';
import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend, Barretenberg } from '@aztec/bb.js';
import { parseEmail, verifyWithModulus, modulusFromTxt } from './lib/dkim-verify.mjs';
import { buildInputs } from './lib/inputs.mjs';
import { TEMPLATES } from './lib/templates.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
if (argv[0] !== 'prove' || !argv[1]) { console.error(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 8).join('\n')); process.exit(2); }

const id = JSON.parse(fs.readFileSync(flag('identity', 'receiptproof-identity.json')));
const parsed = parseEmail(fs.readFileSync(argv[1], 'latin1'));
const sig = parsed.sigs.find((s) => s.tags.a === 'rsa-sha256');
if (!sig) throw new Error('no rsa-sha256 DKIM signature');
let txt = flag('key-txt');
if (!txt) {
  const name = `${sig.tags.s}._domainkey.${sig.tags.d}`;
  try { txt = (await dns.resolveTxt(name)).map((r) => r.join('')).find((r) => /p=/.test(r)); } catch {}
  if (!txt) {
    const r = await fetch(`https://archive.zk.email/api/key?domain=${encodeURIComponent(sig.tags.d)}`);
    txt = (await r.json()).find?.((x) => x.selector === sig.tags.s)?.value;
  }
  if (!txt) throw new Error(`no DKIM key for ${name} in DNS or the zk-email archive; pass --key-txt`);
}
const dkim = verifyWithModulus(parsed, sig, modulusFromTxt(txt));
console.error(`DKIM ok: d=${dkim.signingDomain} s=${dkim.selector} (${dkim.modulusLength}-bit)`);
const body = new TextDecoder('latin1').decode(dkim.body);
const tplArg = flag('template', 'auto');
const templateId = tplArg === 'auto' ? +Object.entries(TEMPLATES).find(([, t]) => body.includes(t.anchor))?.[0] : +tplArg;
if (!templateId) throw new Error('no merchant template matched; pass --template');
const vaultId = +flag('vault', '0');
const b = buildInputs(dkim, { templateId, salt: id.salt, recipient: id.wallet, vaultId });
if (b.meta.toAddress.toLowerCase() !== String(id.inbox).toLowerCase()) console.error(`warning: email To is ${b.meta.toAddress}, identity inbox is ${id.inbox}`);
const circuit = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, `../target/${b.circuit}.json`)));
let t = Date.now(); const { witness } = await new Noir(circuit).execute(b.inputs);
const api = await Barretenberg.new({ threads: os.cpus().length, logger: () => {} });
const be = new UltraHonkBackend(circuit.bytecode, api);
const proof = await be.generateProof(witness, { verifierTarget: 'evm' });
if (!(await be.verifyProof(proof, { verifierTarget: 'evm' }))) throw new Error('local verification failed');
await api.destroy();
console.error(`proved ${TEMPLATES[templateId].name} ${b.meta.amountText} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
const claim = { vaultId, circuit: b.circuit === 'receipt_rsa1024' ? 'rsa1024' : 'rsa2048', proof: '0x' + Buffer.from(proof.proof).toString('hex'), pubs: proof.publicInputs };
const note = flag('note'); if (note) claim.note = note;
fs.writeFileSync(flag('out', 'claim.json'), JSON.stringify(claim));
console.error(`wrote ${flag('out', 'claim.json')} (fields: ${Object.keys(claim).join(', ')})`);
const submit = flag('submit');
if (submit) {
  const r = await fetch(`${submit.replace(/\/$/, '')}/api/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(claim) });
  console.log(r.status, await r.text());
}
