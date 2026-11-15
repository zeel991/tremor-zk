// Prove a fixture with the full circuit (UltraHonk ZK, keccak/evm target = zkVerify V5_0 format).
// Usage: node prove.mjs [fixture=good_inr] [templateId=100] [threads]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { UltraHonkBackend, Barretenberg } from '@aztec/bb.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { Noir } from '@noir-lang/noir_js';
import { buildInputs } from './lib/inputs.mjs';
import { parseAndVerify } from './lib/dkim.mjs';
import { FIX, SALT, RECIPIENT } from './test/helpers.mjs';
const [fx = 'good_inr', tid = '100', th] = process.argv.slice(2);
const threads = +th || os.cpus().length;
const keyFile = fx.includes('1024') ? 'ci_dkim_1024_TEST_ONLY.json' : 'ci_dkim_TEST_ONLY.json';
const dk = parseAndVerify(fs.readFileSync(path.join(FIX, `${fx}.eml`)), JSON.parse(fs.readFileSync(path.join(FIX, keyFile))).privateKeyPem);
const built = buildInputs(dk, { templateId: +tid, salt: SALT, recipient: RECIPIENT, vaultId: 0 });
const circuit = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, `../target/${built.circuit}.json`)));
let t = Date.now(); const { witness } = await new Noir(circuit).execute(built.inputs); const wt = Date.now() - t;
const api = await Barretenberg.new({ threads, logger: () => {} });
const be = new UltraHonkBackend(circuit.bytecode, api);
t = Date.now(); const proof = await be.generateProof(witness, { verifierTarget: 'evm' }); const pt = Date.now() - t;
t = Date.now(); const ok = await be.verifyProof(proof, { verifierTarget: 'evm' }); const vt = Date.now() - t;
const vk = await be.getVerificationKey({ verifierTarget: 'evm' });
const vkHash = '0x' + Buffer.from(keccak_256(Buffer.concat([Buffer.from([3]), Buffer.from(vk)]))).toString('hex');
const outDir = path.resolve(import.meta.dirname, '../target');
fs.writeFileSync(path.join(outDir, `proof-${fx}.json`), JSON.stringify({ proof: Buffer.from(proof.proof).toString('hex'), publicInputs: proof.publicInputs, vk: Buffer.from(vk).toString('hex'), vkHash }));
fs.writeFileSync(path.join(outDir, `${built.circuit}.vk`), Buffer.from(vk));
const hf = path.join(outDir, 'vk-hashes.json'); const hashes = fs.existsSync(hf) ? JSON.parse(fs.readFileSync(hf)) : {}; hashes[built.circuit] = vkHash; fs.writeFileSync(hf, JSON.stringify(hashes, null, 2));
console.log(JSON.stringify({ circuit: built.circuit, fixture: fx, threads, witness_ms: wt, prove_ms: pt, verify_ms: vt, verified: ok, proof_bytes: proof.proof.length, vk_bytes: vk.length, vkHash, pubs: proof.publicInputs.length }));
await api.destroy();
