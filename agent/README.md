# ReceiptProof agent

Cloudflare Worker + D1 (free tier). It takes a proof and its 9 public inputs, checks them cheaply against the vault on Base, applies the company policy, sends the proof to zkVerify through Kurier, and once the proof is aggregated on Base calls `vault.claim` from a relayer that holds only gas. The Worker never verifies proofs itself (10 ms CPU budget); zkVerify does. Spec: `../SPEC.md` §8, §10, §11, §19.

## Endpoints (SPEC §8.1)

| Method | Path | Notes |
|---|---|---|
| POST | `/api/claim` | Body is exactly `{vaultId, circuit, proof, pubs, note?}`. Any other key gets a 400, so email bytes can't be sent. Send `Accept: application/x-ndjson` to stream the steps |
| GET | `/api/claim/:id` | Decision, reasons, explanation, Kurier job, zkVerify tx, aggregation, Base tx |
| GET | `/api/recent` | Last 50 claims, public fields only (no note, no proof; the employee appears as short-hex `to_commit`) |
| GET | `/api/vault/:id` | Policy text, JSON, hash, active merchants and caps, paused, USDC balance, and `dkimKeys`. Each key is read from the vault's `dkimKey(pubkeyHash)` struct: `{pubkeyHash, domain, selector, modulus (hex), bits, activatesAt, cancelled, active}`. Candidates come from the D1 `keys` table plus `KeyProposed` logs since `KEY_LOGS_FROM_BLOCK`. On a read error the field is `null`, never stale data |
| GET | `/api/agent` | Agent address, accepted VK hashes, statement |
| GET | `/health` | Liveness, today's Kurier submissions vs cap, decisions in the last 24 h |
| POST | `/api/sample-receipt` | `{to, amount?}` (plain email; 1–50 INR, default 49). Returns a fresh `.eml` (`message/rfc822`) from the test merchant (template 100), DKIM-signed with `SAMPLE_DKIM_PRIVATE_KEY`. Same bytes as `circuits/js/lib/dkim.mjs` `signEmail`. 5 per IP per day |
| POST | `/api/register` | `{vaultId: 0, toCommit, wallet}`. Sandbox only: the relayer (which must be the vault's `registrar`) simulates, then sends `registerFor`. Reverts map to 409 `ALREADY_REGISTERED`, 400 `NOT_SANDBOX`, 503 `RELAYER_NOT_REGISTRAR` / `PAUSED`. 3 per IP per day |

CORS allows only the origins listed in `ALLOWED_ORIGINS`. Rate limits are stored in D1 as `keccak256(day ‖ ip)`, never the raw IP.

## Pipeline

1. **Pre-checks** (`src/precheck.ts`) mirror `ReceiptVault.claim` steps 1–7 and 10 at chain time (`block.timestamp` via Multicall3), from one multicall plus one USDC balance read:
   - `whenNotPaused`, `acceptedVk`, `vaultId`, `spent`, and the nullifier in D1.
   - `dkimKey`: known, not cancelled, past `activatesAt`; merchant active; domain match.
   - Payee: `recipient >> 160 == 0` and equal to `employee`.
   - Date window: future first, then the 60-day expiry, then `registeredAt`.
   - `maxPerClaim`; `merchantWindow` against `maxPerDay` and `employeeWindow` against `employeeDailyCap`, both with the exact `_consume` reset rule.
   - `rateAt` (USD fixed at 1e22); payout = `mulDiv(amount, rate, 1e18)`; `ZeroPayout`; balance.
   - Any failure gives `REJECT` with reason codes and no Kurier spend. A revert at settlement is decoded with the ABI (`src/chain/errors.ts`) and mapped to the same codes.
2. **Policy** (`src/policy/`): a deterministic evaluator over the typed JSON rules gives `APPROVE`, `FLAG` or `REJECT`. The LLM only writes the explanation and judges whether a required note fits. Anything other than a clean "fits" means `FLAG`. `FLAG` and `REJECT` are never submitted.
3. **Submit** to Kurier as `ultrahonk` with `{version: "V5_0", variant: "ZK"}`, `vkRegistered: true`, `chainId`. Submissions are capped per UTC day (`MAX_SUBMISSIONS_PER_DAY`).
4. **Cron, every minute** (`src/poller.ts`): walks each job Queued → Valid → Submitted → IncludedInBlock → Finalized → AggregationPending → Aggregated and waits for `aggregationPublished.destinationTxHash`. A failed job, or a submit error, is resubmitted once; a second failure ends in `FAILED`. Before settling, the agent checks Kurier's leaf against its own (SPEC §19.1).
5. **Settle**: signs the EIP-712 `Decision` (SPEC §19.4) with deadline now + `DECISION_TTL_SECONDS`, simulates `claim(pubs, vkHash, aggregationId, path, leafCount, index, policyHash, deadline, agentSig)` from the relayer, then sends it. The next cron run checks the receipt and moves the claim to `PAID` or `SETTLE_FAILED`.

Claim statuses in D1: `REJECTED`, `FLAGGED`, `SUBMITTED`, `AGGREGATED`, `SETTLE_SENT`, `PAID`, `SETTLE_FAILED`, `FAILED`. A nullifier held by a `REJECTED` or `FAILED` claim can be claimed again; any other status blocks it as `DUPLICATE`.

## Policy

- `compilePolicy(text, llm)` turns plain English into JSON with the schema in `src/policy/schema.ts` (strict, so unknown keys are rejected) and returns `policyHash = keccak256(canonical JSON)`.
- The result is a proposal. A human approves it, then it is written to `vaults.policy_json` / `policy_hash`. There is no HTTP endpoint for this.
- The Worker checks the stored hash against the stored JSON before every evaluation.

## Config

Vars are in `wrangler.toml`; the `REPLACE` values are placeholders. Secrets, set with `wrangler secret put <NAME>`:

- `KURIER_API_KEY`: never logged. Kurier puts it in the URL path, so errors are scrubbed and never echoed.
- `AGENT_PRIVATE_KEY`: the EIP-712 decision signer. Must equal the vault's `agent`.
- `RELAYER_PRIVATE_KEY`: holds only gas. For the sandbox it must also be the vault's `registrar`.
- `SAMPLE_DKIM_PRIVATE_KEY`: PKCS8 PEM of the test domain's DKIM key (sandbox vault only). Its public key is published at `SAMPLE_DKIM_SELECTOR._domainkey.SAMPLE_DKIM_DOMAIN`.

For local dev, put them in `.dev.vars`, which is gitignored.

Setup, when ready (not done here): `wrangler d1 create receiptproof`, put the id in `wrangler.toml`, `npm run db:migrate:local` (or `--remote`), then insert the vault row with its approved policy.

## Tests

```
npm install
npm test          # vitest, 131 tests (RP_SKIP_CROSS=1 skips the ones that need ../contracts/out and ../circuits)
npm run typecheck
```

- Kurier is mocked with an injected `fetch`, and chain reads with a fake `VaultReader`/`VaultSettler`.
- D1 is a small shim over `node:sqlite` that runs the real migration.
- **Cross-package tests.**
  - `test/abi.test.ts` checks `src/chain/receiptVaultAbi.ts` against `../contracts/out`. Regenerate it with `node scripts/sync-abi.mjs` after `forge build`.
  - `test/sample.test.ts` checks that the Worker's signer is byte-identical to `dkim.mjs`. It then verifies the endpoint's `.eml` with `dkim-verify.mjs`, builds inputs with `inputs.mjs`, and executes the compiled `receipt_rsa2048` circuit with noir_js. Outputs [2]=100, [3]=paise and [4]=356 are asserted.
- **Local end-to-end test** (`test/e2e.anvil.test.ts`): runs when `anvil` and `forge` are on PATH, takes about 20 s, and only touches a local anvil process (chain 31337).
  - Builds the test-only mocks in `test/e2e/sol` (MockUSDC, MockZkVerifyAggregation, MiniMulticall3).
  - Deploys the real ReceiptVault artifact behind an ERC1967Proxy and configures vault 0.
  - Makes two real UltraHonk proofs with bb.js and drives the real viem reader and settler through `/api/register`, `/api/claim` and the poller to `PAID`.
  - Then checks the DUPLICATE and PAYEE_MISMATCH rejections. Kurier is mocked.
  - Run only this test with `npx vitest run test/e2e.anvil.test.ts`; skip it with `RP_SKIP_E2E=1`.
- The leaf test reproduces vkHash `0x8060…6dca` from the real 1,888-byte VK fixture (`test/fixtures/vk-v5.hex`) and checks the leaf against an independent `encodePacked` computation.

## Not done or not verified

- **Only run on anvil.** The real-chain reader and settler have run against local anvil only, never Base Sepolia. Kurier and the zkVerify aggregation contract were mocked there.
- **Kurier.** `V5_0` acceptance, the failure status names, and whether `aggregationDetails.leaf` / `statement` equals our leaf all need a first testnet submission (SPEC G1c).
- **zkverifyjs fallback.** `ZkVerifyJsSubmitter` is a stub. It needs a WebSocket and a substrate signer, so it would run from a CLI, not the Worker.
- **Free-plan CPU.** The 10 ms CPU limit hasn't been measured on Workers. ECDSA signing in the cron and viem's ABI encoding are the heaviest steps.
