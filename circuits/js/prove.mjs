// Prove a fixture with the full circuit (UltraHonk ZK, keccak/evm target = zkVerify V5_0 format).
// Usage: node prove.mjs [fixture=good_inr] [templateId=100] [threads]
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { UltraHonkBackend, Barretenberg } from '@aztec/bb.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { inputsFor, receipt } from './test/helpers.mjs';
const [fx = 'good_inr', tid = '100', th] = process.argv.slice(2);
const threads = +th || os.cpus().length;
const circuit = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../target/receipt_rsa2048.json')));
const { inputs } = inputsFor(fx, +tid);
let t = Date.now(); const { witness } = await receipt().execute(inputs); const wt = Date.now() - t;
const api = await Barretenberg.new({ threads, logger: () => {} });
const be = new UltraHonkBackend(circuit.bytecode, api);
t = Date.now(); const proof = await be.generateProof(witness, { verifierTarget: 'evm' }); const pt = Date.now() - t;
t = Date.now(); const ok = await be.verifyProof(proof, { verifierTarget: 'evm' }); const vt = Date.now() - t;
const vk = await be.getVerificationKey({ verifierTarget: 'evm' });
const vkHash = '0x' + Buffer.from(keccak_256(Buffer.concat([Buffer.from([3]), Buffer.from(vk)]))).toString('hex');
const outDir = path.resolve(import.meta.dirname, '../target');
fs.writeFileSync(path.join(outDir, `proof-${fx}.json`), JSON.stringify({ proof: Buffer.from(proof.proof).toString('hex'), publicInputs: proof.publicInputs, vk: Buffer.from(vk).toString('hex'), vkHash }));
fs.writeFileSync(path.join(outDir, 'receipt_rsa2048.vk'), Buffer.from(vk));
console.log(JSON.stringify({ fixture: fx, threads, witness_ms: wt, prove_ms: pt, verify_ms: vt, verified: ok, proof_bytes: proof.proof.length, vk_bytes: vk.length, vkHash, pubs: proof.publicInputs.length }));
await api.destroy();
