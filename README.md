# Tremor — expense receipts that prove themselves

**An expense agent that pays a receipt only when a zero-knowledge proof shows the merchant's own DKIM email signature covers that total.** The proof is made in the employee's browser, verified on zkVerify, and paid in USDC by a vault on Base. The receipt email never leaves the device.

**[Try it in one click → app.tremor.in](https://app.tremor.in)** · [Site](https://tremor.in) · [Agent endpoint](https://tremor-agent.agent-games-gatekeeper.workers.dev/api/agent) · [Design spec](SPEC.md) · Built for zkVerify Agent Games 2026 (Wildcard) · MIT

---

## At a glance

| | |
|---|---|
| **Problem** | Image models fake receipt photos and PDFs in seconds, and neither format can prove where it came from. Expense teams end up trusting pictures. |
| **Who it helps** | Finance teams paying expense claims, and employees who shouldn't have to hand over their inbox to get reimbursed. |
| **What the agent does** | Takes a proof plus 9 public values, runs on-chain pre-checks and the company's expense policy, submits the proof to zkVerify, and settles the payout on Base once zkVerify's aggregation is published. |
| **The checkable claim** | "This exact total was in an email signed by this merchant's DKIM key, sent at this time to this registered inbox, and has never been claimed before." [Exact statement ↓](#what-the-proof-establishes) |
| **Live** | Web app, agent and vault are live on **zkVerify Volta → Base Sepolia**. **6 payouts settled**, 0 failed. [All transactions ↓](#live-payouts) |
| **Verifiable by you** | Every payout can be re-checked from public chain data alone, in the app or from a terminal. [How ↓](#verify-it-yourself) |
| **Tested** | **216 tests, all passing**: 28 circuit (14 attack cases), 50 contract (4 forked against zkVerify's real Base Sepolia contract), 138 agent (incl. a full local end-to-end payout). |

## See it work in 60 seconds

1. Open **[app.tremor.in](https://app.tremor.in)** and press **Run the full demo**. No wallet, no gas, nothing to install. A short guided tour is one click away too.
2. Your browser makes a throwaway inbox and wallet, registers them with the sandbox vault, asks the Tremor test merchant for a DKIM-signed receipt, checks the signature, and **proves it in the tab** (UltraHonk ZK, ~8–16 s in Chrome).
3. The agent applies the expense policy and approves; Kurier submits the proof to zkVerify; zkVerify aggregates it to Base; the vault pays USDC to the throwaway wallet. About 5 minutes end to end, mostly aggregation.
4. A **proof-of-payment card** then lists every transaction hash in full, and your own browser reads Base Sepolia to confirm the USDC `Transfer` from the vault, the wallet's balance, the published aggregation root, and the zkVerify statement.

Prefer your own receipt? Use the step-by-step flow under the demo and drop a `.eml`. Everything runs in the tab.

## How this entry meets the Wildcard criteria

| Criterion | Where to look |
|---|---|
| **Useful problem** | AI-faked receipts are a real cost for every company that reimburses expenses; email receipts are already signed by the merchant, and Tremor turns that signature into proof. [The problem ↓](#the-problem) |
| **Working implementation** | A live one-click demo that ends in a real USDC payout, six settled payouts on public chains, a public agent endpoint, and 216 passing tests. [Live payouts ↓](#live-payouts) |
| **Clear explanation** | The claim flow, the exact proven statement, what the agent can and cannot do, trust assumptions and limits are all written down below. [Can and cannot ↓](#what-the-agent-can-and-cannot-do) |
| **Verifiability** | zkVerify makes the core claim checkable: anyone can confirm a payout was backed by a verified receipt proof without trusting Tremor. Uses the **sound** UltraHonk `V5_0` flavour. [Why V5_0 ↓](#why-zkverify-and-which-proof-type) |
| **Public share** | Public repo, public site, public app and public agent endpoint. |

## The problem

- A photo or PDF of a receipt proves nothing: one edited digit looks exactly like the real thing, and generating a convincing receipt now takes seconds.
- The **email** a receipt arrives in is different. Merchants like Uber, Swiggy, Zomato and Amazon sign every email with **DKIM**: an RSA signature over the headers and a hash of the body. Change one character and the signature breaks.
- But forwarding that email to your employer reveals everything else in it: your home address, the items, card digits, your inbox.

Tremor proves the signature, the total, the date and your inbox **without revealing the email**, and lets a contract pay against that proof.

## What the proof establishes

The Noir circuit (`circuits/receipt_rsa2048`, plus a 1024-bit variant) proves all of these at once:

| Proven | How |
|---|---|
| The email is signed by the merchant's DKIM key | RSA-2048 PKCS#1 v1.5 over the canonicalised header (zk-email), with `signature < modulus` |
| The signed body contains the merchant's total line | Body hash in the signed `bh=` tag; partial SHA-256 for the prefix; the template anchor bytes sit immediately before the amount |
| The amount | Parsed in-circuit (`1,249.50` → 124950 paise); the next byte must end the number |
| When it was sent | The signed `Date:` header, RFC 5322, parsed to Unix time with its zone |
| Which inbox it went to | `To:` address, lower-cased, committed as `Poseidon2(addr, salt)` |
| It's claimed once | Salted nullifier `Pedersen(signature, salt)`: the merchant can't recompute it |
| Who gets paid, which vault | `recipient` and `vault_id` are public outputs, so a stolen proof pays nobody else |

**Public outputs (9):** `pubkey_hash, nullifier, template_id, amount_minor, currency, sent_at, to_commit, recipient, vault_id`.

**Never leaves the browser:** headers, body, order details, card digits, your inbox address, your salt, the RSA signature. The agent's API refuses any field other than `{vaultId, circuit, proof, pubs, note?}`, and a test enforces it.

## How a claim flows

```
employee browser                       Tremor agent (Cloudflare Worker)        zkVerify           Base
────────────────                       ────────────────────────────────        ────────           ────
register: Poseidon2(inbox, salt) ───▶  relayer: vault.registerFor() ──────────────────────────▶  ReceiptVault
drop receipt .eml
  verify DKIM (key from vault, DNS)
  prove in a Web Worker (UltraHonk)
POST /api/claim {proof, 9 pubs} ────▶  1 pre-checks vs the vault on chain
                                       2 company policy (typed rules)
                                       3 submit via Kurier ─────────────────▶ verify V5_0 ZK
                                                                              aggregate ───────▶ root published
                                       4 sign EIP-712 decision
                                       5 relayer: vault.claim() ───────────────────────────────▶ re-check 10 steps,
                                                                                                  pay USDC
```

1. **Register.** The browser computes `to_commit` with the same Noir code as the circuit; the vault maps it to the employee's wallet. In the sandbox a relayer pays the gas.
2. **Prove.** The browser verifies DKIM with the key from the vault's on-chain list (cross-checked against DNS and the zk-email archive), then proves in a Web Worker.
3. **Agent.** Cheap on-chain pre-checks first (key, payee, window, caps, FX, nullifier), then the company's plain-English policy, compiled once into typed rules and evaluated deterministically. The LLM only writes the explanation and judges whether a required note fits, flagging on doubt.
4. **zkVerify.** The proof goes through Kurier as `{proofType: ultrahonk, version: V5_0, variant: ZK}`, is verified, and is aggregated to Base.
5. **Vault.** `claim()` recomputes the statement leaf, checks it against zkVerify's aggregation on Base, re-checks every rule in 10 ordered steps (each with its own custom error), and pays USDC.

## What the agent can and cannot do

| The agent **can** | The agent **cannot** |
|---|---|
| Reject or flag a claim (bad key, unregistered inbox, over a cap, stale, duplicate, policy breach) | Change the amount, the payee or the merchant: they come from the proof |
| Explain its decision in plain language | Pay a claim zkVerify hasn't verified: the vault checks the aggregation itself |
| Submit proofs and settle approved claims | Redirect money if its key is stolen: the vault pays only `recipient` from the proof |
| Apply the company's soft policy (notes, weekdays, monthly limits) | Override the vault's hard rules (key list, caps, FX timelock, nullifier) |
| Read any inbox: it never sees one | |

## Live payouts

All on **zkVerify Volta** and **Base Sepolia**. Each payout is ₹25.00 paid as **0.297619 USDC** at the vault's ₹84/USD policy rate.

| # | zkVerify proof | Aggregation | Base payout |
|---|---|---|---|
| 1 | [`0x28b3…8743`](https://zkverify-testnet.subscan.io/extrinsic/0x28b30606a26a241bff03f95d88948502a71210e1eef9d09f98b2830e8f248743) | 67329 | [`0xfa73…9d28`](https://base-sepolia.blockscout.com/tx/0xfa73d4cd4a065541ae5454f3a38f67d49201e19e3ec6282db38eadc3ac479d28) |
| 2 | [`0xa5d2…b6c1`](https://zkverify-testnet.subscan.io/extrinsic/0xa5d2258ef41102d4aa718f3fb3f1a4ee9a9c0ff94334177ca1ba39cb6c94b6c1) | 67584 | [`0xd82f…cb46`](https://base-sepolia.blockscout.com/tx/0xd82f503eb5cf7d3cb66e810a8be3a3814af3afbf5aa28feb17c60ef9a0a4cb46) |
| 3 | [`0x267d…d8a1`](https://zkverify-testnet.subscan.io/extrinsic/0x267d3bc5ba553fff5bf3f9d1beb7713376bc91b059492f23680e2e7394fed8a1) | 67585 | [`0x07cd…fdec`](https://base-sepolia.blockscout.com/tx/0x07cda656bdad71fe7007ac99e815fc67c0b710bf7e23fb5ed781debb6540fdec) |
| 4 | [`0x5950…2b5f`](https://zkverify-testnet.subscan.io/extrinsic/0x59508e867f726c9774aef996d27e783694aa25a4dc80d1f52258a0a2430f2b5f) | 67639 | [`0x9fb8…a52e`](https://base-sepolia.blockscout.com/tx/0x9fb8b3df421e598990682597bac33a5855fe504f9a6be62654ac2862b201a52e) |
| 5 | [`0x862f…75a9`](https://zkverify-testnet.subscan.io/extrinsic/0x862fbcd23d7f66ff4aba13cdbafb3ac58041a6b44553a1e4d370eec7444875a9) | 67642 | [`0x3c81…e7d5`](https://base-sepolia.blockscout.com/tx/0x3c8192b1eb912c3109a3a53c3416ea24f674b3ddf929d725d8f2166da4f3e7d5) |
| 6 | [`0x3320…30b9`](https://zkverify-testnet.subscan.io/extrinsic/0x33207755cd5f1ab497d1b694bfd2b39e53e465910dec7b65e58504e311de30b9) | 67643 | [`0xd7a6…6890`](https://base-sepolia.blockscout.com/tx/0xd7a6fd7ee6e74be45b594b11cf5df0d0574b27eaf7495e653a74eb4786846890) |

| Deployment | Address |
|---|---|
| ReceiptVault (Base Sepolia, UUPS proxy) | [`0xCDF6bdB3d70Eb86f8c5aC5a880c453a4eeA3bf50`](https://base-sepolia.blockscout.com/address/0xCDF6bdB3d70Eb86f8c5aC5a880c453a4eeA3bf50) |
| zkVerify aggregation contract (Base Sepolia) | [`0x0807C544D38aE7729f8798388d89Be6502A1e8A8`](https://base-sepolia.blockscout.com/address/0x0807C544D38aE7729f8798388d89Be6502A1e8A8), domain 2 |
| Circuit vkHash (`receipt_rsa2048`) | `0xdaed0392d385e69b68439cec05cc21183fad4ac8c04e7eacb16ced17123f9880` |
| Agent | <https://tremor-agent.agent-games-gatekeeper.workers.dev/api/agent> (config, accepted vkHashes, proven statement) |

The sandbox vault's key and FX timelocks are 10 minutes, set once before its first key and then locked; production vaults keep 24 hours.

## Verify it yourself

**In the browser.** Paste any payout transaction into the app's [Verify a payout](https://app.tremor.in/#verify) tab. Your browser decodes the `claim` calldata, recomputes the zkVerify statement leaf from the public inputs, and calls `verifyProofAggregation` on zkVerify's contract on Base. No trust in Tremor or the agent is needed.

**From a terminal** (Foundry's `cast`):

```bash
# the payout succeeded and moved USDC from the vault to the claimant
cast receipt 0xfa73d4cd4a065541ae5454f3a38f67d49201e19e3ec6282db38eadc3ac479d28 --rpc-url https://sepolia.base.org

# zkVerify published the root of aggregation 67329 (domain 2) on Base
cast call 0x0807C544D38aE7729f8798388d89Be6502A1e8A8 "proofsAggregations(uint256,uint256)(bytes32)" 2 67329 --rpc-url https://sepolia.base.org
# → 0x87c3c9da2cbcaf58eddfce3cf0097c3e6f56b6fca6bcd04e9f68da5fc9e803dd

# the vault accepts exactly this circuit's verification key
cast call 0xCDF6bdB3d70Eb86f8c5aC5a880c453a4eeA3bf50 "acceptedVk(bytes32)(bool)" 0xdaed0392d385e69b68439cec05cc21183fad4ac8c04e7eacb16ced17123f9880 --rpc-url https://sepolia.base.org
```

## Why zkVerify, and which proof type

- zkVerify verifies the proof once, cheaply, and publishes an aggregation root on Base. The vault then only checks a Merkle path, so a payout costs a normal transaction, not an on-chain SNARK verification.
- Proofs are UltraHonk ZK made with bb ≥ 5 and submitted as zkVerify's **`V5_0`** flavour, the one zkVerify's own verifier source calls sound for ZK.
  - It marks the older ZK flavours (`V0_84`, `V3_0`, `Legacy`) as deprecated and unsound, because of a pre-fix SmallSubgroupIPA bug: ["sound only from bb v5.0.0"](https://github.com/zkVerify/zkVerify/blob/0f1f24dad6c6/verifiers/ultrahonk/src/lib.rs#L132-L135) (`verifiers/ultrahonk/src/lib.rs`, 2026-11-02).
  - Runtime 2.1.0 rejects them.
- `V5_0` is live on the Volta testnet (runtime 2.1.0). zkVerify mainnet still reports runtime 2.0.0 (`state_getRuntimeVersion`, checked 2026-11-22), so a UltraHonk ZK proof on mainnet today can only use one of those deprecated flavours. That's why Tremor runs on **Volta → Base Sepolia**, and switches to mainnet by config once `specVersion ≥ 2001000`.
- We deliberately don't fall back to an unsound or non-private flavour.
- The statement leaf is `keccak(keccak("ultrahonk") ‖ vkHash ‖ versionHash ‖ keccak(pubs))`. The vkHash rule is confirmed against Volta's `vk_hash_ultrahonk` RPC, and the leaf against a real proof in the contract tests.

## Key decisions

- **DKIM over screenshots or OCR.** The merchant already signs the email; Tremor reuses that signature instead of trusting an image or a third-party attestor.
- **Prove in the browser.** The email never reaches a server. Only the proof and 9 public values do.
- **Hard rules in the contract, soft rules in the agent.** The vault enforces keys, caps, FX, payee and one-claim-per-email; the agent handles policy that needs judgement. A compromised agent can withhold, never redirect or inflate.
- **LLM explains, never decides money.** Amounts, payees and merchants come from the proof; the model writes explanations and can only flag.
- **Timelocks on keys and FX.** A new DKIM key or FX rate activates only after a delay, so a vault owner's change is visible before it can pay anything.
- **Sound proofs or none.** Testnet `V5_0` today rather than a deprecated flavour on mainnet.

## Trust assumptions (honest version)

- **DKIM key list.** Each vault's owner curates it. Keys activate after 24 h, the full modulus is stored on chain, and the web app re-checks it against DNS and the zk-email archive. The MVP merchants have no DNSSEC, so this can't be fully trustless today. A wrong key only costs the vault owner.
- **FX.** Non-USD receipts pay at the company's own policy rate, timelocked and public. There's no INR/USD oracle on Base.
- **Agent.** It decides soft policy only. The hard rules live in the contract.

## Limits

- DKIM proves the merchant sent the email. It doesn't prove business use, personal payment, or that the order wasn't refunded.
- A merchant could guess the customer from an unusual amount and date.
- Real merchant templates (Uber, Swiggy, Zomato, Amazon.in) are compiled in but still need checking against real receipts, so today only the Tremor test merchant (templates 100 and 101) pays. Everything from the total line to the end of the body must fit in 1,280 bytes; long HTML footers need a larger per-merchant circuit.
- The circuit proves the anchor + amount appear in the signed body, not that it's the *only* such line. If a merchant echoes customer-typed text into the email, the template anchor must include enough surrounding HTML that typed text can't reproduce it; that's checked per merchant at template time.
- Only relaxed/relaxed `rsa-sha256` DKIM is supported.
- Testnet until zkVerify mainnet enables runtime 2.1.0.

## Repository

```
circuits/     Noir: rplib (date, amount, templates, commit, sig), receipt_rsa2048, receipt_rsa1024, commit; vendored zk-email port
circuits/js   DKIM sign/verify, input builder, tests, prove.mjs, cli.mjs (CLI fallback), testnet-e2e.mjs
contracts/    ReceiptVault (Foundry, UUPS) + tests incl. fork tests against zkVerify's Base Sepolia contract
agent/        Cloudflare Worker + D1: API, pre-checks, policy engine, Kurier client, poller, settlement, sandbox endpoints
web/          tremor.in + app.tremor.in (React, Vite, Tailwind v4, Motion): in-browser DKIM + ZK proving, one-click demo,
              proof of payment, verify-a-payout, activity, guided tour
fixtures/     public/: emails signed by a TEST-ONLY CI key (never registered in any vault)
SPEC.md       full design, gates and evidence log
DEPLOY.md     testnet deployment runbook
```

## Run it

```bash
# circuits: compile (noir_wasm, no native nargo needed) and test
cd circuits/js && npm ci && node compile.mjs receipt_rsa2048 && node compile.mjs receipt_rsa1024 && node compile.mjs commit && npm test
node prove.mjs good_inr 100           # real UltraHonk ZK proof + local verify

# contracts
cd contracts && forge test

# agent
cd agent && npm ci && npx vitest run && npx tsc --noEmit

# web
cd web && npm ci && npm run dev       # needs circuits compiled; config via public/config.json

# CLI fallback: prove a receipt locally and write the claim body
node circuits/js/cli.mjs prove receipt.eml --identity receiptproof-identity.json --out claim.json
```

## Tests

**216 tests, all passing** (re-run 2026-11-22).

| Part | Count | Notes |
|---|---|---|
| Circuit + JS libs | 28 | 14 attack cases: tampered body/amount, wrong key, swapped `To`, moved/short/long amount, wrong template, `s+n` malleability, wrong header field, tampered SHA state, bad date, overflow. Also the browser verifier → circuit path and the 1024-bit variant |
| Contracts | 50 | Every revert path, a fuzz test, upgrades, sandbox registrar, configurable-then-locked timelocks, the leaf on a real proof's public inputs, and 4 fork tests against zkVerify's real aggregation contract on Base Sepolia |
| Agent | 138 | Schema (email rejected), every pre-check, a policy table, poller lifecycle and retries, the on-chain aggregation-root check, EIP-712, leaf, sample receipt → real circuit, sandbox registration, and a **local anvil end-to-end run**: real proof → agent → real `claim` tx → USDC paid, then DUPLICATE and PAYEE_MISMATCH rejected |
