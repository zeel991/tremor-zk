# Buildability spike (2026-11-15)
Reproduces SPEC.md §18. The ported circuit and the measurements come from these files.

- `zkemail-noir1-port.patch`: diff against `zkemail/zkemail.nr` @ `8264758` (v2.0.0). Ports it to Noir 1.0.0.
- `vendor_deps.py`: vendors git dependencies as local paths.
  - Bumps to sha256 v0.3.0, poseidon v0.4.0, nodash v0.46.0 and base64 v0.5.1.
  - Uses zkPassport's `noir_rsa v0.12.1` and `noir-bignum v0.11.0-1`. The lib Nargo.toml in the patch points at those.
  - Rewrites nested `x.nr` modules to `x/mod.nr`, as a noir_wasm workaround.
- `compile.mjs`: compiles with `@noir-lang/noir_wasm@1.0.0`.
- `inputs.cjs`: generates inputs with `@zk-email/zkemail-nr@2.0.0`. Then recompute `redc = floor(2^(2*2048+6)/n)` for bignum v0.11.
- `prove.mjs`: proves and verifies with `@aztec/bb.js@5.3.0`, `verifierTarget: 'evm'` (ZK + keccak), backend `Wasm`.

## Added 2026-11-15 (second pass)
- `g1b/`: G1b harness. `run.sh` clones zkVerify's `ultrahonk_verifier` v0.4.0 and verifies our proof (`data/`, the full receipt circuit on fixture good_inr) plus three tamper cases with `ours.rs`.
- `browser-bench.js`: the page script used for the browser timing in SPEC §5.5. Bundle it with Vite (`vite-plugin-node-polyfills`, workers `format: 'es'`) and serve it with COOP `same-origin` + COEP `require-corp`. The `threads > 1` setting hung in that setup, so the timing is single-threaded.
