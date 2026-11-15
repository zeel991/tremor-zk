// In-browser ZK prover: noir_js witness + bb.js UltraHonk (ZK, evm/keccak target = zkVerify V5_0).
import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend, Barretenberg } from '@aztec/bb.js';

const cache = {};
async function circuit(name) {
  cache[name] ??= fetch(`/circuits/${name}.json`).then((r) => r.json());
  return cache[name];
}

/** Run the commit circuit (registration): to_commit for an inbox address + salt. */
export async function computeToCommit(address, salt) {
  const bytes = Array.from(new TextEncoder().encode(address.trim())).map(String);
  if (bytes.length > 124) throw new Error('Address longer than 124 bytes');
  const len = bytes.length; while (bytes.length < 124) bytes.push('0');
  const { returnValue } = await new Noir(await circuit('commit')).execute({ addr: { storage: bytes, len: String(len) }, salt });
  return BigInt(returnValue);
}

/**
 * @param inputs circuit inputs from buildInputs()
 * @param onStep (label, ms) progress callback
 */
export async function prove(inputs, onStep = () => {}, opts = {}) {
  const c = await circuit('receipt_rsa2048');
  let t = performance.now();
  const { witness } = await new Noir(c).execute(inputs);
  onStep('witness', performance.now() - t);
  const threads = opts.threads ?? Math.min(navigator.hardwareConcurrency || 4, 8);
  const isolated = globalThis.crossOriginIsolated;
  t = performance.now();
  const api = await Barretenberg.new({ threads: isolated ? threads : 1, ...(opts.backend ? { backend: opts.backend } : {}), logger: opts.logger || (() => {}) });
  onStep('backend', performance.now() - t);
  try {
    const be = new UltraHonkBackend(c.bytecode, api);
    t = performance.now();
    const proof = await be.generateProof(witness, { verifierTarget: 'evm' });
    onStep('prove', performance.now() - t);
    t = performance.now();
    const ok = await be.verifyProof(proof, { verifierTarget: 'evm' });
    onStep('verify', performance.now() - t);
    if (!ok) throw new Error('Local proof verification failed');
    const vk = await be.getVerificationKey({ verifierTarget: 'evm' });
    return { proof: proof.proof, publicInputs: proof.publicInputs, vk, threads: isolated ? threads : 1 };
  } finally { await api.destroy(); }
}

/** Prove in a dedicated worker (keeps the page responsive). Multithreaded first; if the thread pool
 *  doesn't come up within `backendTimeoutMs` (some embedded browsers block nested workers), fall back
 *  to one thread. */
export async function proveInWorker(inputs, onStep = () => {}, opts = {}) {
  const threads = opts.threads ?? Math.min(navigator.hardwareConcurrency || 4, 8);
  if (threads > 1 && globalThis.crossOriginIsolated) {
    try { return await runWorker(inputs, onStep, threads, opts.backendTimeoutMs ?? 12000); }
    catch (e) { if (!/backend timeout/.test(e.message)) throw e; onStep('fallback', 0); }
  }
  return runWorker(inputs, onStep, 1, 0);
}
function runWorker(inputs, onStep, threads, backendTimeoutMs) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./prove.worker.js', import.meta.url), { type: 'module' });
    let timer = null;
    const arm = () => { if (backendTimeoutMs) timer = setTimeout(() => { w.terminate(); reject(new Error('backend timeout')); }, backendTimeoutMs); };
    w.onmessage = ({ data }) => {
      if (data.type === 'step') { if (data.step === 'witness') arm(); if (data.step === 'backend') clearTimeout(timer); onStep(data.step, data.ms); }
      else { clearTimeout(timer); w.terminate(); data.type === 'done' ? resolve(data.result) : reject(new Error(data.error)); }
    };
    w.onerror = (e) => { clearTimeout(timer); w.terminate(); reject(new Error(e.message || 'prover worker crashed')); };
    w.postMessage({ inputs, threads });
  });
}
