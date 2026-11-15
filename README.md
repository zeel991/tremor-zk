# ReceiptProof

**Expense receipts that prove themselves.** An expense agent that pays a receipt only when a zero-knowledge proof shows the merchant's own DKIM email signature covers that total. zkVerify verifies the proof, and a vault on Base pays USDC. The email never leaves the employee's browser.

Built for zkVerify Agent Games 2026 (Wildcard).

> **Status (2026-11-15):** circuit, contracts, agent and web app are built and tested locally (see [Tests](#tests)). Not yet deployed: deploying, funding and the first on-chain claim each wait for the owner's go-ahead. Addresses will be listed here once they exist.

## The problem
- Generative AI fakes receipt images in seconds. Expense-audit vendors report AI-generated receipts as a fast-growing share of fraud.
- A photo or PDF can't prove where it came from. The emailed receipt can: Uber, Swiggy, Zomato and Amazon sign every mail with DKIM, an RSA signature over the headers and the body hash.
- Showing that email to your employer reveals everything else in it: address, items, card digits, inbox.

## What ReceiptProof proves, and what stays private
The Noir circuit (`circuits/receipt_rsa2048`, plus a 1024-bit variant) proves all of these at once:

| Proven | How |
|---|---|
| The email is signed by the merchant's DKIM key | RSA-2048 PKCS#1 v1.5 over the canonicalised header (zk-email), with `signature < modulus` |
| The signed body contains the merchant's total line | Body hash in the signed `bh=` tag; partial SHA-256 for the prefix; the template anchor bytes sit immediately before the amount |
| The amount | Parsed in-circuit (`1,249.50` → 124950 paise); the next byte must end the number |
| When it was sent | The signed `Date:` header, RFC 5322, parsed to Unix time with its zone |
| Which inbox it went to | `To:` address, lower-cased, committed as `Poseidon2(addr, salt)` |
| It's claimed once | Salted nullifier `Pedersen(signature, salt)`: the merchant can't recompute it |
| Who gets paid, which vault | `recipient` and `vault_id` are public outputs, so a stolen proof is useless |

**Public outputs:** `pubkey_hash, nullifier, template_id, amount_minor, currency, sent_at, to_commit, recipient, vault_id`.

**Never leaves the browser:** headers, body, order details, card digits, your inbox address, your salt, the RSA signature.

The agent's API refuses any field other than `{vaultId, circuit, proof, pubs, note?}`, and a test enforces this.

## Why zkVerify, and which proof type
- Proofs are UltraHonk ZK made with bb ≥ 5. They are submitted as zkVerify's **`V5_0`** flavour, the one zkVerify's own verifier source calls sound for ZK.
  - It marks the older ZK flavours (`V0_84`, `V3_0`, `Legacy`) as deprecated and unsound, because of a pre-fix SmallSubgroupIPA bug.
  - Runtime 2.1.0 rejects them.
- `V5_0` is live on the Volta testnet (runtime 2.1.0). zkVerify mainnet was still on 2.0.0 as of 2026-11-15. So ReceiptProof runs on **Volta → Base Sepolia** and switches to mainnet by config once `specVersion ≥ 2001000`.
- We deliberately don't fall back to an unsound or non-private flavour.
- The vault checks the zkVerify aggregation on Base. The leaf is `keccak(keccak("ultrahonk") ‖ vkHash ‖ versionHash ‖ keccak(pubs))`. The vkHash rule is confirmed against Volta's `vk_hash_ultrahonk` RPC.

## How a claim flows
1. **Register.** The employee's browser computes `to_commit` with the same Noir code as the circuit. The company registers it to the employee's wallet; in the sandbox, a relayer does this so judges need no gas.
2. **Prove.** Drop the receipt `.eml`. The browser verifies DKIM with the key from the vault's on-chain list, cross-checked against DNS and the zk-email archive. Then it proves in a Web Worker (~2 s native, ~11 s single-threaded in a browser).
3. **Agent.**
   - Cheap on-chain pre-checks first: key, payee, window, caps, FX, nullifier.
   - Then the company's plain-English policy, compiled once into typed rules and evaluated deterministically.
   - The LLM only writes explanations and judges whether a note fits, with FLAG on doubt. It never sets amounts, payees or merchants.
4. **zkVerify.** The proof is submitted through Kurier with `{version: V5_0, variant: ZK}`, then aggregated to Base.
5. **Vault.** `claim()` re-checks everything in 10 ordered steps, each with its own custom error, then pays USDC. A stolen agent key can only approve or withhold; it can't redirect or inflate a payout.

## Verify a payout yourself
Paste any payout transaction into the web app's *Verify a payout* panel. Your browser:
1. decodes the `claim` calldata;
2. recomputes the zkVerify statement leaf from the public inputs;
3. calls zkVerify's aggregation contract on Base, `verifyProofAggregation`.

No trust in us or the agent is needed.

## Trust assumptions (honest version)
- **DKIM key list.** Each vault's owner curates it.
  - Keys activate after 24 h, the full modulus is stored on-chain, and the web app re-checks it against DNS and the zk-email archive.
  - The MVP merchants have no DNSSEC, so this can't be fully trustless today.
  - A wrong key only costs the vault owner.
- **FX.** Non-USD receipts pay at the company's own policy rate, which is timelocked 24 h and public. There's no INR/USD oracle on Base.
- **Agent.** It decides soft policy only. The hard rules live in the contract.

## Limits
- DKIM proves the merchant sent the email. It doesn't prove business use, personal payment, or that the order wasn't refunded.
- A merchant could guess the customer from an unusual amount and date.
- The real merchant templates (Uber, Swiggy, Zomato, Amazon.in) are compiled in as placeholders until checked against real receipts.
  - The test merchant (templates 100 and 101) is fully exercised.
  - Everything from the total line to the end of the body must fit in 1,280 bytes. Long HTML footers need a larger per-merchant circuit.
- The circuit proves the anchor + amount appear in the signed body, not that it's the *only* such line. If a merchant echoes customer-typed text (e.g. delivery notes) into the email, a template's anchor must include enough surrounding HTML that typed text can't reproduce it. That's checked per merchant at template time (G4).
- Only relaxed/relaxed `rsa-sha256` DKIM is supported.
- Testnet until zkVerify mainnet enacts runtime 2.1.0.

## Repository
```
circuits/   Noir: rplib (date, amount, templates, commit, sig), receipt_rsa2048, receipt_rsa1024, commit; vendored zk-email port
circuits/js lib (DKIM sign/verify, input builder), tests, prove.mjs, cli.mjs (CLI fallback)
contracts/  ReceiptVault (Foundry, UUPS) + tests incl. a fork test against zkVerify's Base Sepolia contract
agent/      Cloudflare Worker + D1: API, pre-checks, policy engine, Kurier client, poller, settlement, sandbox endpoints
web/        Vite app: in-browser DKIM + ZK proving, privacy panel, verify-a-payout, live feed
fixtures/   public/: emails signed by a TEST-ONLY CI key (never registered in any vault); private/ is gitignored
SPEC.md     full design, gates, evidence log
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
| Part | Count | Notes |
|---|---|---|
| Circuit + JS libs | 28 | 14 attack cases: tampered body/amount, wrong key, swapped `To`, moved/short/long amount, wrong template, `s+n` malleability, wrong header field, tampered SHA state, bad date, overflow. Also the browser verifier → circuit path and the 1024-bit variant |
| Contracts | 46 | Every revert path, a fuzz test, upgrades, sandbox registrar, the leaf on a real proof's public inputs, and 4 fork tests against zkVerify's real aggregation contract on Base Sepolia (aggregation 65470) |
| Agent | 136 | Schema (email rejected), every pre-check, a policy table, poller lifecycle and retries, EIP-712, leaf, sample receipt → real circuit, sandbox registration, and a **local anvil end-to-end run**: real proof → agent → real `claim` tx → USDC paid, then DUPLICATE and PAYEE_MISMATCH rejected (Kurier and the aggregator mocked) |
