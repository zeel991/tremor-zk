// Runs the prover off the main thread. Inside a worker, bb.js can use its plain 'Wasm' backend
// (Atomics.wait is allowed here) and spawn its thread pool directly.
import { prove } from './prover.js';
self.onmessage = async ({ data }) => {
  try {
    const r = await prove(data.inputs, (step, ms) => self.postMessage({ type: 'step', step, ms }), { threads: data.threads, backend: data.backend ?? 'Wasm' });
    self.postMessage({ type: 'done', result: { proof: r.proof, publicInputs: r.publicInputs, vk: r.vk, threads: r.threads } });
  } catch (e) { self.postMessage({ type: 'error', error: String(e?.message || e) }); }
};
