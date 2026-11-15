# ReceiptProof: specification

> An expense agent that pays only for receipts the merchant really sent.
> AI can fake any receipt image in seconds. It can't fake the merchant's email signature.

- **Status:** draft v1, 2026-11-15. Nothing is built.
- **Target:** zkVerify Agent Games 2026, Wildcard (deadline 2026-11-21), plus a Creator Track video of the build.
- **Owner:** VK-SENTINEL (@zeeast).

Items marked **[VERIFY]** are assumptions that have not been tested yet. Each one has a Day-1 gate in §13.

---

## 1. Problem

Expense reimbursement trusts a picture of a receipt. Generative AI made those pictures free to fake:
- AppZen reports AI-generated receipts went from none of the fraudulent receipts it flagged (March 2025) to about **71% (mid-May 2026)**.
- Emburse's June 2026 survey: **34%** of US and UK professionals admit using AI to fake a receipt.
- SAP Concur says reviewers can no longer rely on visual checks.
- Caveat: most of this data comes from expense-software vendors.

The fakes are small (AppZen: average about $101, median $32), sized to slip under auto-approval limits. So the answer can't be "a human looks harder".

Every real e-receipt from a major merchant (Uber, Amazon, Swiggy, Zomato, airlines, …) arrives with a **DKIM signature**: an RSA signature by the merchant's mail server over the email headers and a hash of the body. Checking that signature proves the merchant sent the email. The catch is that checking it normally means handing over the whole email: inbox address, home address, items bought, order history. Employees and privacy law (DPDP, GDPR) push back on that.

**ReceiptProof uses ZK to separate the two.** The employee proves *"Uber's mail server sent my inbox a receipt for ₹642 on 12 Nov"* and reveals nothing else. The raw email never leaves their device.

## 2. Why this is a strong ZK use case
Written for judges who will ask "why ZK?":

| Property | How ReceiptProof gets it | Without ZK |
|---|---|---|
| Authenticity | RSA-2048 DKIM verified in-circuit against the merchant's published key | Possible, but only by revealing the full email |
| Privacy | Only `merchant, amount, currency, date, category` leave the circuit; everything else is hidden | Impossible: the verifier needs the whole email to check the hash |
| Narrow, self-interested trust | Emails are signed by the merchant's own DKIM key. The one trusted input is the vault's `key → domain` list, and the vault owner is **the company paying**: a bad entry can only make that company overpay. Employees' privacy doesn't depend on it, entries are timelocked and public, and anyone can check them against DNS (§7.2) | Merge-to-Pay trusts a third-party attestor that can sign any claim privately, for both payer and payee |
| No double claims | Nullifier = `Poseidon(DKIM signature, employee salt)`, spent on-chain. The merchant can't compute it, so it can't link a claim to its customer | Needs a central database of seen receipts |
| Bound to the claimant | The proof commits to the recipient wallet and the employee's hidden inbox commitment | A stolen screenshot can be resubmitted |

**Contrast with Merge-to-Pay:**
- Its circuit proves an attestor's ECDSA signature over **public** GitHub data. Nothing is hidden, and the on-chain contract could `ecrecover` that signature directly.
- It also trusts an attestor the author runs.
- In ReceiptProof, ZK is the only way to get both authenticity and privacy.
- **Proof system:** Merge-to-Pay proves with bb 0.84 `--zk` and settles as UltraHonk `V0_84` ZK. zkVerify's own verifier source (2026-11-02) marks that flavor as deprecated, says it is sound only from bb v5.0.0, and rejects it from runtime 2.1.0. ReceiptProof uses bb ≥ 5 / `V5_0`, the flavor zkVerify says is sound. State this factually in the README. Don't claim anyone's proofs were forged.

## 3. Users and flows

### Roles
- **Company (funder):** deploys a vault, deposits USDC, writes a spending policy in plain English, and registers employees.
- **Employee (claimant):** submits receipts and gets USDC on Base.
- **Agent:** reads the facts the proof revealed, applies the policy, explains its decision, and settles.
- **Anyone, including judges:** can audit every payout from public data.

### Main flow
```
Employee                     Browser (local)                Agent (Worker)            zkVerify          Base
   |  drop .eml                  |                               |                       |                |
   |---------------------------->| parse, pick template          |                       |                |
   |                             | fetch DKIM key (archive/DNS)  |                       |                |
   |                             | build witness, prove (bb.js)  |                       |                |
   |                             |-- proof + public inputs ----->| check pubs, policy    |                |
   |                             |   (email never sent)          |-- submit (Kurier) --->| verify         |
   |                             |                               |<-- job: Finalized ----| aggregate ---->| root published
   |                             |                               | decision APPROVE      |                |
   |                             |                               |-- claim(pubs, path, sig) ------------->| vault checks leaf,
   |<-- status page: decision, zkVerify tx, Base payout ---------|                       |                | nullifier, caps → USDC
```

### Judge demo (must take under 2 minutes)
1. Open the live page and click **"Try with your own receipt"**. A sandbox vault funded by us pays small test amounts.
2. Gmail → open an Uber or Amazon receipt → ⋮ → **Show original** → **Download original** → drop the `.eml` on the page.
3. Watch it run: the proof is made locally (progress bar), the agent's decision and reasoning appear, the zkVerify tx link, then the Base payout tx.
4. A **"What the agent saw vs your email"** panel shows the 5 revealed fields next to a blurred preview of everything that stayed private.

Anyone can claim from the sandbox vault, with a per-merchant daily cap and a per-nullifier one-time payout. Abuse is bounded by the vault balance, kept around $20.

**Lowering friction for judges:**
- **A 20-second looping GIF** next to the drop zone shows exactly where "Download original" is in Gmail and Outlook.
- **"Run with our sample receipt."** On each click the agent mints a **fresh** receipt email (current `Date:`, the visitor's chosen wallet in `To`, a random order ID) and signs it with our **test domain's** DKIM key. The test domain is the only key we hold, and it can only be used against the demo vault.
  - It runs the full pipeline (local proof → agent decision → zkVerify mainnet → Base `claim`) on a **demo vault that accepts only the test-domain key**.
  - Each sample is a new email with a fresh salt and registration, so the one-time code and the `sent_at >= registeredAt` rule both pass, and every run pays a fixed $0.10.
  - The page labels it "sample: our own test domain, not a real merchant".
- **Fallback if browser proving is too slow** on the judge's machine: `npx receiptproof prove receipt.eml` runs the same circuit with native `bb` locally and prints the proof for upload. The email still never leaves the machine.

## 4. What the proof reveals and hides

**Public outputs of the circuit, in this order. The order is part of the zkVerify statement.**

| # | Name | Type | Meaning |
|---|---|---|---|
| 0 | `pubkey_hash` | Field | Poseidon hash of the DKIM RSA modulus limbs. The vault maps it to a merchant domain (§7) |
| 1 | `nullifier` | Field | Pedersen(DKIM signature limbs, `salt`) via zkemail's `blinded_nullifier`, with `signature < modulus` constrained so `s + n` can't mint a second nullifier. Unique per email, because `to_commit` pins the email to one inbox and salt. Without `salt` the merchant, who knows the signature, can't recompute it and link the claim to its customer |
| 2 | `template_id` | Field | Which merchant template parsed the body (§5.3) |
| 3 | `amount_minor` | Field | Total in minor units (paise or cents) |
| 4 | `currency` | Field | ISO-4217 numeric (356 INR, 840 USD) |
| 5 | `sent_at` | Field | Unix seconds parsed from the signed `Date:` header |
| 6 | `to_commit` | Field | Poseidon(lowercased `To` address bytes, `salt`): ties the receipt to the employee's inbox without revealing it |
| 7 | `recipient` | Field | Payout address (160-bit). Bound into the proof so a copied proof can't redirect funds |
| 8 | `vault_id` | Field | Which vault this claim is for (stops one proof being reused across companies) |

**Private witness (never leaves the browser):**
- full header and body
- RSA signature and modulus
- body-hash index
- partial-SHA state
- template field offsets
- `To` address
- `salt`

`salt` is a per-employee secret set at registration. The company stores `to_commit` for each employee, so it knows *which employee* a commitment belongs to. Nobody on-chain learns the inbox address.

**Not proven (stated in the README):**
- that the purchase was for business use; the policy agent and audit handle that
- that the employee paid with their own card
- that the order wasn't later refunded

## 5. Circuit (Noir, zkemail.nr)

### 5.1 Toolchain (revised 2026-11-15 after the buildability check, §18)
**Decision: Noir `1.0.0` + bb / bb.js `≥ 5.0.0` (measured with `@aztec/bb.js 5.3.0`), UltraHonk ZK, `verifierTarget: 'evm'` (keccak). zkVerify statement version `V5_0`.**

**Why not bb 0.84** (zk-email's pin, and what Merge-to-Pay uses):
- zkVerify's verifier source marks the ZK flavor of `V0_84`, `V3_0` and `Legacy` as **deprecated and unsound**. It "carries the pre-fix Barretenberg SmallSubgroupIPA (sound only from bb v5.0.0)" (`verifiers/ultrahonk/src/lib.rs`, commit `0f1f24da`, 2026-11-02).
- Runtime 2.1.0 rejects those proofs, and zkverifyjs says ZK proofs on 2.1.0+ must be `V5_0`.
- bb.js 0.84's WASM has no ZK UltraHonk prover at all, only plain, which doesn't hide the witness. A browser proof made with it would not be private.

**What the switch needs (done and measured in §18):**
- **zk-email port to Noir 1.0:** `zkemail.nr` v2.0.0 doesn't compile on Noir ≥ beta.9. Port it with:
  - zkPassport's maintained forks `zkpassport/noir_rsa v0.12.1` and `zkpassport/noir-bignum v0.11.0-1`
  - `sha256 v0.3.0`, `poseidon v0.4.0`, `nodash v0.46.0`, `noir_base64 v0.5.1`
  - About 15 mechanical source fixes (BoundedVec getters, `u32` lengths and indices, the `Poseidon2` import, bool OR), with inline lib tests moved out.
  - This is a vendored fork in `circuits/vendor/zkemail`.
- **Barrett parameter change:** bignum v0.11 defines `redc = floor(2^(2·bits + 6) / n)`; the old value was `2^(2·bits)`. The input generator must recompute `redc`. Otherwise witness solving fails inside RSA, as it did in the first attempt.
- **Compiling:** use native `nargo 1.0.0`. If compiling with `noir_wasm`, vendored libraries need nested `x.nr` modules moved to `x/mod.nr`, because of a path-resolution bug in noir_wasm.
- **Input generation:** keep `@zk-email/zkemail-nr@2.0.0`'s `generateEmailVerifierInputs` (it doesn't depend on the Noir version), then apply the `redc` fix.

**Network consequence:**
- `V5_0` is live on the **Volta testnet** (runtime `2001000`, i.e. 2.1.0) but **not yet on mainnet**, which runs `2000000` (2.0.0) as of 2026-11-15. No mainnet enactment date is announced.
- So: build and demo on **Volta → Base Sepolia**, with mainnet behind a config switch. It goes live the moment mainnet reports `specVersion ≥ 2001000`. See §7.1 step 8 and §13.

### 5.2 Two circuit variants
- `receipt_rsa2048`: most merchants (e.g. `uber.com` selector `s1` is 2048-bit, per archive.zk.email on 2026-11-15).
- `receipt_rsa1024`: some merchants still use 1024-bit keys (e.g. `amazon.in` keys in the archive start `MIGfMA0…`, i.e. 1024-bit). **[VERIFY]** which key current amazon.in mail uses.

Each variant has its own VK, registered once with Kurier. The vault accepts both VK hashes.

### 5.3 Constraints, per proof
1. `pubkey.verify_dkim_signature(header, signature)`, using zkemail's RSA over the canonicalised header.
2. `constrain_header_field` for `DKIM-Signature` → extract `bh=` → base64-decode the signed body hash.
3. Body hash check via **partial SHA**: the body is hashed outside the circuit up to the 64-byte block before the anchor; `partial_sha256_var_end` finishes it in-circuit; assert equal to `bh`. **Only the prefix can be skipped: everything from the anchor's block to the end of the body must fit in `MAX_BODY`** (1280 bytes in the built circuit). Real merchant HTML after the total can be long, so the per-merchant body size is part of G4 (built 2026-11-15).
4. `pubkey_hash = Poseidon(modulus limbs)`.
5. `nullifier = blinded_nullifier(signature, salt)` (Pedersen, zkemail) **and** `signature < modulus` (bignum `validate_in_field`; attack test `s+n`). The same `salt` feeds `to_commit` (step 7), so one inbox has exactly one nullifier per email.
6. **`Date:` header:** `constrain_header_field("date")`, then parse RFC 5322 `DD Mon YYYY HH:MM:SS ±ZZZZ` into Unix seconds in-circuit (fixed-format parser, assert ranges).
7. **`To:` header:** `get_email_address(header, "to")`, lowercase, then `to_commit = Poseidon(addr bytes packed, salt)`.
8. **Template match on the RAW signed body bytes** (built 2026-11-15; no soft-break decoding, which saved ~38k constraints):
   - Anchors are stored in their quoted-printable form (e.g. `Total =E2=82=B9`). Matching raw bytes is sound because the body hash covers them as-is; a soft line break inside an anchor only makes the proof fail.
   - Assert `body[a-len(anchor) .. a] == ANCHOR[template_id]` immediately before the amount, so the amount can't be a suffix of a larger number.
   - Parse digits with optional `,` thousands separators and one `.` into `amount_minor`. Assert the digit window is followed by a terminator.
   - Assert `template_id` is in the compiled template table.
9. `recipient` and `vault_id` are passed through as public inputs with no constraints. They're bound because they're part of the proven statement.

### 5.4 Merchant templates
Small, compiled into the circuit, and versioned. The MVP is 3 merchants:

| id | Merchant | DKIM domain | Anchor (to confirm on real mail) | Category |
|---|---|---|---|---|
| 1 | Uber trips | uber.com | `Total` … `₹` | travel |
| 2 | Swiggy / Zomato order | swiggy.in / zomato.com | `Grand Total` / `Total paid` | meals |
| 3 | Amazon order | amazon.in | `Order Total:` | supplies |

**[VERIFY]** the exact anchors and quoted-printable encoding against 2–3 real emails per merchant. Templates are the riskiest part of the circuit, because merchants change their HTML.

### 5.5 Size budget (measured, §18)
- Header ≤ 1408 bytes. The body from the anchor's 64-byte block to the end ≤ 1280 bytes; the prefix before it is partial-hashed outside the circuit.
- **Measured** on the zk-email 2048-bit DKIM circuit at exactly these sizes (Noir 1.0, bb.js 5.3 WASM, ZK, Apple M5):

  | Threads | Prove | Verify | Peak memory |
  |---|---|---|---|
  | 10 | **3.0 s** | 1.1 s | about 1.0 GB |
  | 4 | **3.7 s** | 1.3 s | about 1.0 GB |

  - Proof: 9,536 bytes. VK: 1,888 bytes, the same size as zkVerify's v5 test vector.
- **Measured in a real browser** (2026-11-15; the Claude desktop in-app Chromium, `crossOriginIsolated = true`, a production Vite build of noir_js 1.0 + bb.js 5.3, same circuit and inputs):

  | Threads | Witness | Prove | Verify |
  |---|---|---|---|
  | 1 | 0.17 s | **9.55 s** | 2.75 s, `true` |

  - The proof was the same 9,536 bytes.
  - Multithreaded runs hung at "Creating 4 worker threads" in this quick Vite setup. That's a bundling issue with bb.js's nested thread workers, to be fixed in `web/`. So 9.5 s is the **single-thread worst case** on this machine.
- **Our full circuit** adds the template parser, date parser, `to_commit` and the nullifier. Estimate about +30–50% constraints, so about 15 s single-threaded in a browser on this machine. That's an estimate; slower laptops will be proportionally slower.
- **Phones:** about 1 GB of WASM memory may fail on some mobile browsers. Desktop is the supported path, and the CLI is the fallback.

### 5.5b Full circuit, measured (built 2026-11-15)
| Where | Threads | Witness | Prove | Verify |
|---|---|---|---|---|
| Node, bb.js 5.3 WASM (Apple M-series) | 10 | 0.32 s | **1.8 s** | 0.6 s |
| Node | 4 | 0.32 s | 2.2 s | 0.8 s |
| Node | 1 | 0.33 s | 6.3 s | 1.9 s |
| In-app Chromium, background pane, worker | 1 | 0.3–2 s | **10.8 s** | 3.1 s |

- Proof 9,920 bytes, VK 1,888 bytes, 9 public inputs. Both variants measured: rsa2048 and rsa1024 prove in ~1.7 s at 10 threads.
- VK hashes (`circuits/vk-hashes.json`): rsa2048 `0xdaed0392…9880` (**confirmed by Volta's `vk_hash_ultrahonk` RPC**), rsa1024 `0x69d3c79b…7e32`.
- In the in-app browser the bb.js thread pool never starts (nested workers), so the web app falls back to one thread after 12 s. Multithreaded proving in desktop Chrome is **not yet verified** (Claude in Chrome was not connected).

### 5.6 Circuit tests (`nargo test` + JS)
- **Happy path:** each template with a fixture email.
- **Attacks:**
  - one flipped byte in the body
  - flipped amount digit
  - wrong DKIM key
  - header `To` swapped
  - an anchor that is present but in an unsigned part
  - a soft-line-break trick that splits the amount
  - amount overflow
  - malformed date
- **Fixtures:**
  - Real merchant emails contain PII and **must never be committed**. They stay in `fixtures/private/`, which is gitignored.
  - Public CI uses emails signed by **our own test domain's DKIM key** (`receiptproof-test.<our domain>`), which exercises the same code paths.

## 6. Proving client (browser)

- Static app on **Cloudflare Pages** (free).
- Served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, so bb.js can use multithreaded WASM.
- **Steps:**
  1. Parse the `.eml` locally.
  2. Detect the merchant and template from `From` and the DKIM `d=`.
  3. Fetch the key:
     - Primary source: `archive.zk.email/api/key?domain=<d>`, matched by selector.
     - Cross-check: a DNS-over-HTTPS `TXT <selector>._domainkey.<d>` lookup.
     - If the two disagree, show a warning and stop.
  4. Build inputs with `@zk-email/zkemail-nr` (`shaPrecomputeSelector` = the template anchor).
  5. Prove with bb.js, then show the proof and public inputs.
- **The email never leaves the tab.** Only `{proof, public inputs, template_id, circuit variant}` are POSTed to the agent. The page says this in plain words and links the network tab.
- The employee's `salt` is stored in `localStorage` at registration, with an export as a recovery file. If it's lost, the employee re-registers.

## 7. Contracts (Base mainnet, Solidity 0.8.x)

### 7.1 `ReceiptVault`
One per company. A UUPS proxy, like Merge-to-Pay, so verifier parameters can rotate.

```solidity
struct Merchant { bytes32 domainHash; uint64 maxPerClaim; uint64 maxPerDay; bool active; }
mapping(uint256 pubkeyHash => bytes32 domainHash) public dkimKey;      // set by owner, see 7.2
mapping(uint256 templateId => Merchant) public merchants;
mapping(uint256 toCommit  => address) public employee;                  // registered employees
mapping(uint256 nullifier => bool) public spent;
mapping(bytes32 vkHash => bool) public acceptedVk;                       // rsa1024 + rsa2048
address public agent;                                                    // decision signer
IZkVerifyAggregation public zkv;  uint256 public domainId; bytes32 public versionHash;

function claim(uint256[9] calldata pubs, bytes32 vkHash, uint256 aggregationId,
               bytes32[] calldata path, uint256 leafCount, uint256 index,
               bytes calldata agentSig) external;
```

**`claim` checks, in order. Every failure has its own custom error:**
1. `acceptedVk[vkHash]`.
2. `pubs[8] == vaultId`.
3. `!spent[pubs[1]]`.
4. `dkimKey[pubs[0]] == merchants[pubs[2]].domainHash` and `merchants[pubs[2]].active`.
5. `employee[pubs[6]] != address(0)` and `address(uint160(pubs[7])) == employee[pubs[6]]`. The payout can only go to the wallet the company registered for that inbox.
6. `pubs[5]` is within the claim window (≤ 60 days old, not in the future + 1 h), **and `pubs[5] >= registeredAt[pubs[6]]`**.
   - If an employee loses their salt and re-registers, the new salt gives new nullifiers. This rule stops them re-claiming receipts from before re-registration.
7. Amount ≤ `maxPerClaim`, plus a per-employee daily rolling cap.
8. **zkVerify leaf**:
   ```
   leaf = keccak256(keccak256("ultrahonk") ‖ vkHash ‖ versionHash ‖ keccak256(pubs as 9×32 bytes))
   ```
   `zkv.verifyProofAggregation(domainId, aggregationId, leaf, path, leafCount, index)` must be true.
   - **`versionHash` (V5_0):** `0x91ea9b035e570dfe3d6b0dff19fb13586dfdd5a9da15c14f49f7ce6b3b2bc589` = `sha256("ultrahonk:v5.0")`. Read from the pallet source and recomputed locally; they match.
   - **`vkHash`:** `keccak256(0x03 ‖ vk)`, i.e. the V5_0 enum index byte followed by the raw 1,888-byte VK, with **no** SCALE length prefix.
     - **Verified on a live node:** Volta's `vk_hash_ultrahonk` RPC with `{"V5_0": "0x<our vk>"}` returned `0x806073cafcaee81e9803c622546730931813769bf9eef8126a95e8c318cd6dca`, the same as our local computation.
     - With the length prefix it would be `0xd020…9235`, which is wrong.
     - Kurier's `register-vk` response should return the same value. Assert it.
   - The leaf formula matches Merge-to-Pay's working escrow (their payout was replayed on a Base fork) and the pallet's `compute_statement_hash`.
   - **Aggregation contracts.** Both exist (`eth_getCode`, 245-byte proxies) and both are active. `AggregationPosted`-style logs read on 2026-11-15:
     - **Base mainnet** (chain 8453): `0xCb47A3C3B9Eb2E549a3F2EA4729De28CafbB2b69`, **`domainId = 2`**, aggregation ids 149380+.
     - **Base Sepolia** (chain 84532, fed by Volta): `0x0807C544D38aE7729f8798388d89Be6502A1e8A8`, **`domainId = 2`** (verified from logs). Aggregation ids 65468+ match Volta's domain 2 `next.id = 65473` read from `aggregate.domains`.
   - **[VERIFY]** the full leaf by matching our first real job's `statement` against our locally computed leaf. No UltraHonk submission was found in the last 3,000 Volta blocks to test against.
9. `agentSig` is an EIP-712 signature by `agent` over `(vaultId, nullifier, decision=APPROVE, amount, policyHash)`:
   - The agent approves the soft policy (category rules, notes) but **can't change the amount, the payee or the merchant**, because those come from the proof.
   - The hard rules (steps 1–8) hold even if the agent key is stolen.
10. Mark spent, update the daily total, and `USDC.transfer(recipient, payout)`.
    - **Same currency:** USD receipts pay 1:1.
    - **Other currencies:** paid at the **policy FX rate**, part of the signed policy, like the monthly reimbursement rate companies already set.
    - **Rate guards:**
      - Changes are **timelocked 24 h**, emitted as events, and shown on the claim page before the employee submits.
      - The payout is the proven amount × the rate in force at `sent_at`.
    - **Why not a price feed:** Chainlink has no INR/USD feed on Base (its reference directory, 2026-11-15, lists 193 Base feeds and the only fiat ones are EUR and GBP). An owner-set rate is the company's own pricing of its own money, not a third-party oracle.

**Other functions:**
- `deposit`
- `withdraw` (owner)
- `setMerchant`, `setDkimKey`, `registerEmployee`, `revokeEmployee`, `setAgent`, `setVerifierParams`
- `pause`

Every function emits an event.

### 7.2 Trust in DKIM keys (honest section)
**Why there is a list at all.**
- A proof can't establish on its own that a modulus belongs to `uber.com`. That needs DNS.
- Proving DNS needs DNSSEC, and none of the MVP merchants have it: `dig DS` on 2026-11-15 returned nothing for uber.com, amazon.in, swiggy.in and zomato.com.
- So **some** party must vouch for "this key is Uber's". zk-email's own registries have the same property.

**Who that party is: the company that pays.**
- A wrong entry lets employees claim against a fake key, which costs **only the vault owner**.
- It can't touch anyone's privacy or any other vault.
- That makes it self-interested trust, not third-party trust. Merge-to-Pay's attestor is different: it's a third party, and its signature decides payouts for *both* the funder and the payee.

**Making the list checkable:**
- `proposeKey(pubkeyHash, domain, selector, modulusBytes)` stores the full modulus, so anyone can compare it to DNS or archive.zk.email. The key **becomes active only after 24 h**. During that window anyone can see it and the owner can cancel it.
- The page re-checks every active key against live DNS and the archive daily, and shows ✅ or ⚠.
- The sandbox vault (`vaultId 0`) uses the same timelock, with keys pre-loaded before launch.

**Rotated keys:** an old receipt signed by a retired key still verifies if the key was recorded. The 60-day claim window limits exposure.

**Future work (named, not built):** read keys from a shared on-chain registry so companies don't each curate one, or use DNSSEC proofs for domains that adopt it.

### 7.3 Sandbox vault for judges
- Same contract, `vaultId = 0`, with **open registration**: `registerSelf(toCommit)` lets anyone self-register an inbox commitment to their own wallet.
- Low caps (₹50 per claim, ₹200 per day overall per merchant).
- Funded with about $20 USDC.
- The production vault keeps registration owner-only.

### 7.4 Contract tests (Hardhat, Base fork)
- A real zkVerify aggregation fixture once we have one; until then a mock aggregator.
- Every revert path.
- Double claim, wrong vault, wrong payee, an expired claim, cap overflow, a forged agent signature, a revoked employee, a paused vault.
- Upgrade safety.

## 8. Agent (Cloudflare Worker + D1, free tier)

### 8.1 Endpoints
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/claim` | `{vaultId, circuit, proof, pubs, note?}`. Validates, submits, returns `claimId` (also streams NDJSON steps) |
| GET | `/api/claim/:id` | Status: decision, reasons, Kurier job, zkVerify tx, aggregation, Base tx |
| GET | `/api/recent` | Last 50 claims (public fields only) |
| GET | `/api/vault/:id` | Policy text, policy hash, merchants, caps, balance, DKIM keys |
| GET | `/api/agent` | Agent address, accepted VK hashes, the proof statement in plain English |
| GET | `/health` | Liveness + daily usage |

### 8.2 Pipeline per claim
1. **Pre-checks (cheap, before paying for verification):**
   - public input count and ranges
   - `vaultId` exists
   - nullifier not spent (read on-chain + D1)
   - key known
   - employee registered
   - date window and caps
   - Each failure → `REJECT` with a reason code, and **no Kurier spend**.
2. **No local verify in the Worker.** A free-plan Worker has a 10 ms CPU budget per request, and verification took about 1.1 s even natively in WASM. The agent relies on zkVerify's verification, and Kurier's `optimisticVerify` gives an early signal.
3. **Policy decision:** see 8.3.
4. **Submit:** Kurier `POST /submit-proof` with `{proofType: "ultrahonk", proofOptions: {version: "V5_0", variant: "ZK"}, vkRegistered: true, publicSignals, chainId}` to request aggregation on Base.
   - Kurier's schema (v1.36.0) leaves `proofOptions` untyped, and its docs' UltraHonk examples omit it.
   - **What is known (2026-11-15):** Kurier testnet's `/api/v1/version` reports `runtimeSpecVersion: 2001000`, so it is on Volta 2.1.0. Production reports `2000000`.
   - **[VERIFY]** with the first testnet submission that it accepts `version: "V5_0"`. This needs a Kurier testnet API key.
   - **`chainId`:** zkVerify's contract-address page lists Base = `8453` and Base Sepolia = `84532`, and Kurier's field is an integer chain id. Use `84532` on Volta.
   - **Fallback:** submit directly with `zkverifyjs` ≥ 3.4.0, which has `UltrahonkVersion.V5_0`, gates it on runtime ≥ 2.1.0, and has V5_0 VK types for `vk_hash`. Call `verify().ultrahonk({version: V5_0, variant: ZK})` with aggregation domain `2`, from an agent account funded with test VFY.
5. **Poll:** a Cron Trigger every minute walks open jobs through `Queued → Valid → Submitted → IncludedInBlock → Finalized → AggregationPending → Aggregated` and `aggregationPublished.destinationTxHash`. Failed jobs get `ERROR` and are retried at most once.
6. **Settle:** once the aggregation is on Base, the agent sends `claim(...)` from a relayer wallet that holds only gas. The call is simulated first.
7. **Record:** D1 rows, plus status updates to the page.

### 8.3 Policy engine
- Company policy is plain English, for example:
  > "Meals up to ₹1,500 per day on working days. Uber within the city up to ₹800 per ride, any day. Amazon only for office supplies, up to ₹3,000 per month, needs a note."
- **Compile once:** an LLM turns the text into a **typed JSON rule set** (merchant/category → caps, days, note required). A human approves the JSON. Its hash becomes the `policyHash` signed into every decision.
- **Per claim:** rules are evaluated **deterministically** on the revealed fields. The LLM only:
  - writes the human-readable explanation
  - when a note is required, judges whether the employee's note fits the category (`FLAG` if unsure, never `APPROVE` on uncertainty)
- **Decisions:**
  - `APPROVE` (sign + settle)
  - `FLAG` (human review in the dashboard, no payout)
  - `REJECT` (reason code)
- **Model:** Workers AI free tier for the explanation; a Claude model if the quality is clearly better. The LLM output never sets the amount, the payee or the merchant.
- **Reason codes:**
  - `BAD_PROOF`
  - `UNKNOWN_KEY`
  - `UNKNOWN_TEMPLATE`
  - `NOT_EMPLOYEE`
  - `PAYEE_MISMATCH`
  - `DUPLICATE`
  - `STALE`
  - `FUTURE_DATED`
  - `OVER_CAP`
  - `CATEGORY_NOT_ALLOWED`
  - `NOTE_REQUIRED`
  - `NOTE_MISMATCH`
  - `VAULT_EMPTY`
  - `PAUSED`

### 8.4 Storage (D1)
- `claims(id, vault_id, nullifier UNIQUE, template_id, amount_minor, currency, sent_at, to_commit, recipient, decision, reasons, kurier_job, zkv_tx, aggregation_id, base_tx, created_at, updated_at)`
- `vaults(id, address, policy_text, policy_json, policy_hash)`
- `keys(pubkey_hash, domain, selector, bits, first_seen, source)`
- **No email content is ever stored. There is nothing to store, because it never arrives.**

## 9. Public page
- **Live feed:** merchant logo, amount, decision, and links (zkVerify explorer, Basescan). There are no names; the employee shows as `to_commit` short-hex.
- **"Try it" flow:** §3, with the privacy panel.
- **"Verify a payout yourself":** paste a Base tx and the page recomputes the leaf from the event's public inputs, checks it against the zkVerify aggregation contract, and explains each step.
- **"What this proves / what it doesn't":** mirrors §4.

## 10. Security and abuse
| Threat | Mitigation |
|---|---|
| Faked receipt image / LLM-written email | No DKIM signature from the merchant key → the proof fails |
| Edited real email (amount changed) | Body hash mismatch → the proof fails |
| Same receipt claimed twice, or at two companies | Nullifier spent per vault; `vault_id` binds the proof. The cross-company case is detectable if vaults share a nullifier registry (future) |
| Receipt forwarded from a friend's inbox | `to_commit` must match the claimant's registered inbox + salt |
| Proof stolen from the mempool or our API | `recipient` is bound into the proof, and the vault pays only the registered wallet |
| Agent key compromise | Hard rules are on-chain; the agent can only approve or withhold, never redirect or inflate |
| Malicious DKIM key added | Owner-only, double-sourced, evented, visible in the UI (§7.2) |
| Drain of the sandbox vault | Tiny caps, per-nullifier one-shot, small balance, pause |
| Kurier/zkVerify spend griefing | All cheap pre-checks run before submission; daily submission cap |
| PII leakage | Email processed only in the browser; the server receives proof + 9 fields |
| Merchant links a claim to its customer | Nullifier includes the employee salt, so the merchant can't recompute it. **Residual:** a unique amount + date + merchant can still hint at the customer to that merchant. Stated in Limits |
| Lost salt used to re-claim old receipts | `sent_at >= registeredAt` for the re-registered commitment |
| FX manipulation by the owner | Policy rate timelocked 24 h, public, shown before submit. It only affects the owner's own payouts |
| Fake key slipped into the list | 24 h activation delay, full modulus on-chain, daily DNS/archive re-check shown in the UI (§7.2) |

## 11. Hosting and cost (free tier only)
| Part | Where | Cost |
|---|---|---|
| Frontend | Cloudflare Pages | free |
| Agent API + cron + DB | Cloudflare Worker + D1 | free tier |
| Proving | User's browser (fallback: CLI on our machine for the video) | free |
| zkVerify | Kurier mainnet | **[VERIFY]** pricing / key. A mainnet key may need VFY. Open question |
| Base | Vault deploy + claims | about $1–3 gas total at current Base fees **[VERIFY]** |
| Demo funds | Sandbox vault USDC | about $20, from the owner wallet (your yes needed) |

## 12. Repository layout
```
receiptproof/
  SPEC.md                 this file
  README.md               judge-facing: problem, demo, what ZK proves, limits, addresses
  circuits/
    receipt_rsa2048/      Noir package (main.nr, templates.nr, date.nr, amount.nr)
    receipt_rsa1024/
    test/                 nargo tests + JS witness tests
  web/                    Pages app: eml parsing, key fetch, input-gen, bb.js prover, UI
  agent/                  Worker: API, cron, Kurier client, policy engine, settlement
  contracts/              ReceiptVault, deploy scripts, fork tests
  fixtures/
    public/               test-domain signed emails (committed)
    private/              real receipts (gitignored)
  devlog/                 video plan, capture.sh, LOG.md, footage/ (gitignored)
```

## 13. Plan and gates

### Day 1 (Nov 15): kill-or-commit gates
| Gate | Pass condition | Status |
|---|---|---|
| G1a circuit toolchain | zk-email 2048 compiles on Noir 1.0 and proves ZK with bb ≥ 5 | ✅ **Passed locally** (§18) |
| G1b zkVerify's own verifier | Our proof passes zkVerify's `ultrahonk_verifier v0.4.0` (the crate the V5_0 runtime runs) | ⏳ **Ready to run, not run.** The harness and test data are in the scratchpad (`uhv/examples/ours.rs`, which checks upstream's vector, our proof, and three tamper cases). `cargo run` was denied again by this session's auto-mode, so you run one command (§18) |
| G1c on chain | VK registers, and one proof reaches `Finalized` on **Volta** with `V5_0` ZK (Kurier testnet, or zkverifyjs) | ⏳ Needs a Kurier testnet key or test VFY. Kurier testnet already runs on 2.1.0 |
| G2 leaf | Locally computed leaf == the job's `statement` (vkHash rule + V5_0 version hash from §7.1) | ◐ **vkHash verified live** (Volta RPC = local). Version hash read from source and recomputed. Base Sepolia domain = 2 verified. The full-leaf match waits on G1c |
| G3 speed | Full circuit proves in a desktop browser in < 60 s | ✅ **Base circuit: 9.55 s single-threaded in a real browser**, verify `true`. The full circuit is estimated at ~15 s. Multithread bundling is to be fixed |
| G4 template | Uber receipt: anchor + amount extracted from the real `.eml` after soft-break removal | ⏳ Needs a real receipt from you |
| G5 mainnet | Mainnet `specVersion ≥ 2001000` (V5_0 enacted) | ❌ Not yet. Rechecked 2026-11-15: still `2000000`; `system.authorizedUpgrade` is empty; all 22 open referenda are treasury spends (MediumSpender track), not upgrades. Mainnet also has `sudo`, so an upgrade could land without a referendum. Watch daily |

**If mainnet hasn't enacted 2.1.0 by submission:**
- Submit on Volta → Base Sepolia with test USDC.
- The README explains it: the only sound ZK flavor is not yet on mainnet, and zkVerify's own source marks the mainnet-available ZK flavors as unsound.
- Do **not** fall back to a `V0_84`/`V3_0` ZK flavor (unsound per zkVerify), or to Plain (not private).

### Later days
- **Day 2:** the full circuit (date, `to_commit`, template table, nullifier) and the attack tests.
- **Day 3:** the vault contract + fork tests. Deploy to Base mainnet (**your yes**). Register VKs and keys.
- **Day 4:** the agent Worker (pre-checks, Kurier, cron, policy compile + decide, settle) and an end-to-end run with a real receipt, giving the first real payout.
- **Day 5:** the web app (try-it flow, privacy panel, verify-a-payout, live feed) and the sandbox vault funded (**your yes**).
- **Day 6:** README, limits, a demo pass from a clean browser, the video assembled, the submission drafted (**your OK before submitting or posting**).

## 14. Acceptance criteria (the "beats Merge-to-Pay" bar)
1. At least 3 real receipts from at least 2 merchants proven with `V5_0` ZK, verified on zkVerify, and paid by the vault, with every link public:
   - on **mainnet + Base**, if runtime 2.1.0 is enacted by submission time
   - otherwise on **Volta + Base Sepolia**, with the reason stated in the README (§13 G5)
2. A judge with any Uber receipt completes the sandbox flow from a clean browser in under 2 minutes (excluding proving time, which is shown).
3. Attack tests pass:
   - In the circuit: tampered body, tampered amount, wrong key.
   - In the contract: replay, wrong payee, wrong vault, over cap, forged agent signature.
4. The server never receives email bytes: a test asserts the request schema, and the README shows a network capture.
5. The README has these sections: problem, demo, what is proven, what is *not*, trust assumptions (DKIM key list, policy FX rate, agent), addresses, how to verify a payout yourself.
6. **Real users beyond us:** at least 2 people other than the owner claim a real receipt through a non-sandbox vault (e.g. a team vault for our own expenses). Merge-to-Pay's only payout went from the funding wallet to itself.
7. The sample-receipt button runs end to end on mainnet from a clean browser, and the CLI fallback produces a proof the agent accepts.
8. **Test parity or better:** ≥ 40 circuit + agent tests and ≥ 15 contract fork tests, including every attack in §5.6 and §7.4. Merge-to-Pay has 49 + 17.

## 17. Limits (copied into the README)
- **DKIM proves the merchant sent the email**, not that the purchase was business use, that the employee paid personally, or that it wasn't refunded later. The policy agent and normal audit cover these.
- **Key list:** curated by each vault's owner, timelocked and publicly checkable (§7.2). There's no DNSSEC on the MVP merchants, so it can't be fully trustless today.
- **FX:** non-USD receipts pay at the company's timelocked policy rate. There's no on-chain INR/USD feed on Base.
- **Merchant-side hints:** the merchant can't compute the nullifier, but it sees amount + date + merchant on-chain and could guess the customer for unusual amounts.
- **Anchor uniqueness:** the proof shows the anchor + amount occur in the signed body, not that it is the only occurrence. Anchors for merchants that echo customer-typed text must include surrounding HTML that typed text cannot reproduce (escaped by the merchant). Checked per merchant at G4.
- **Templates:** each merchant's email layout is compiled into the circuit. When a merchant changes its HTML, that template needs a new circuit version.
- **Proving cost:** browser proving time is shown honestly. The native CLI is the fallback.
- **One agent instance** and a daily submission cap to bound zkVerify fees.

## 15. Creator Track video
The beats follow the build (see `devlog/VIDEO_PLAN.md`, to be updated for ReceiptProof):
1. Hook: generate a fake receipt with AI in 10 s, which passes a visual check.
2. "But it has no signature": show DKIM in a real email.
3. ZK in one picture: "prove it's signed, reveal only the total".
4. The circuit failing on a tampered amount (on screen).
5. The first mainnet verification.
6. The first USDC payout.
7. The privacy panel.
8. The limits.
9. Try it yourself, with `#AgentGames @ZKVProtocol`.

## 16. Open questions for the owner
1. Kurier mainnet key: reuse an existing one, or get a new one? Who pays VFY fees?
2. Funding: about $20 USDC + gas for the sandbox vault from your wallet. Confirm before Day 3.
3. Real receipts for fixtures and the demo: yours (Uber, Swiggy, Amazon)? They stay local and gitignored.
4. The test DKIM domain: which domain can we add a DKIM TXT record to?
5. The policy FX rate for INR receipts (timelocked, §7.1). Use the RBI reference rate at launch?
6. Two other people (teammates or friends) willing to claim one real receipt each from a small team vault, for acceptance criterion 6.

## 18. Buildability check (2026-11-15)
Every row is labelled by what kind of evidence backs it. "Ran" means it was executed this session. "Read" means taken from source or docs. "Open" means not yet checked.

| # | Claim | Evidence | Result |
|---|---|---|---|
| 1 | zk-email 2048 DKIM circuit compiles on Noir beta.5 (its pin) | **Ran:** noir_wasm 1.0.0-beta.5 compile | ✅ |
| 2 | bb.js 0.84 can make **ZK** UltraHonk in the browser | **Read:** bb.js 0.84 API has only `acirProveUltraKeccakHonk` (plain) | ❌ So the browser path must move to bb 5 |
| 3 | zkVerify accepts the old ZK flavors long-term | **Read:** pallet source + zkverifyjs README: V0_84/V3_0/Legacy ZK deprecated as unsound, rejected on runtime ≥ 2.1.0 | ❌ So target `V5_0` |
| 4 | zk-email compiles on Noir 1.0 | **Ran:** after the port (`spike/zkemail-noir1-port.patch`, zkPassport rsa/bignum forks) | ✅ |
| 5 | DKIM verification solves on the ported circuit | **Ran:** witness 0.2 s on zk-email's `email-good.eml`, after the `redc` fix | ✅ |
| 6 | ZK proof with bb.js 5.3 WASM, `evm` target | **Ran:** prove 2.25 s (512/1024 sizes), 3.0 s (spec sizes 1408/1280), verify true | ✅ |
| 7 | Proof/VK format matches zkVerify V5 | **Read:** zkVerify's v5 README requires bb ≥ 5.0.0, Noir ≥ beta.22, `-t evm`; our VK is 1,888 bytes, the same as their v5 test VK. **Ran:** Volta's `vk_hash_ultrahonk` RPC accepted our VK as `V5_0`. **Not run:** their Rust verifier on our proof (cargo denied twice; `spike/g1b/run.sh` is ready) | ⚠ Likely; G1b confirms |
| 8 | V5_0 live on mainnet | **Ran** (rechecked): `state_getRuntimeVersion`: mainnet 2000000, Volta 2001000. Mainnet `authorizedUpgrade` empty; 22 open referenda, all treasury spends | ❌ mainnet, ✅ testnet |
| 9 | V5_0 version hash | **Read** pallet constant + **Ran** sha256("ultrahonk:v5.0") | ✅ `0x91ea…c589` |
| 10 | Settlement contracts exist | **Ran:** `eth_getCode` on Base `0xCb47…2b69`, Base Sepolia `0x0807…e8A8`, Base USDC | ✅ |
| 11 | Kurier accepts `version: V5_0` | **Read:** Kurier schema leaves `proofOptions` untyped. **Ran:** Kurier testnet `/version` → `runtimeSpecVersion 2001000`, production → `2000000` | ⚠ Open until the first submission (needs a key). Fallback zkverifyjs 3.4.0 has `V5_0` (**read** in its package source) |
| 12 | Max public inputs ≥ 9 | **Read:** zkVerify docs: UltraHonk max 32 | ✅ |
| 13 | Salted nullifier primitive exists | **Read:** zkemail lib `blinded_nullifier(signature, nonce)` | ✅ |
| 14 | DKIM keys retrievable | **Ran:** archive.zk.email API for uber.com (2048-bit), amazon.in (1024-bit) | ✅ |
| 15 | No DNSSEC on merchant domains | **Ran:** `dig DS` empty for uber.com, amazon.in, swiggy.in, zomato.com | Confirms the §7.2 design |
| 16 | No INR/USD feed on Base | **Ran:** Chainlink Base directory: 193 feeds, the only fiat ones EUR and GBP | Confirms the §7.1 design |
| 17 | Merchant templates (anchor, amount, QP) | No real receipts available yet | ⚠ Open (G4) |
| 18 | Date parser, template parser in Noir | Not built; ordinary fixed-format byte parsing | ⚠ Open, low risk |
| 19 | Worker free tier fits the agent | **Read:** 10 ms CPU per request, so no in-Worker proof verify; the rest is I/O | ✅ with the §8.2 change |
| 20 | vkHash rule (`keccak(0x03 ‖ vk)`, no length prefix) | **Ran:** Volta node RPC `vk_hash_ultrahonk({V5_0: vk})` = local `0x8060…6dca` | ✅ verified on a live node |
| 21 | Base Sepolia aggregation domain | **Ran:** logs on `0x0807…e8A8` carry `domainId 2` with ids 65468–65471, matching Volta `aggregate.domains[2].next.id = 65473` | ✅ `domainId = 2` (same as Base mainnet, also seen in logs) |
| 22 | Kurier `chainId` values | **Read:** zkVerify contract-address page: Base 8453, Base Sepolia 84532 | ✅ (confirmed for real at G1c) |
| 23 | ZK proving in a real browser | **Ran:** in-app Chromium, cross-origin isolated, production Vite build: witness 0.17 s, prove 9.55 s (1 thread), verify `true` | ✅ G3 for the base circuit; multithread bundling still open |
| 24 | Full statement leaf | Not run: no UltraHonk submission found in the last 3,000 Volta blocks to compare against | ⚠ Open until G1c |

**Verdict:** buildable.
- The two hardest unknowns are resolved by running them:
  - Private (ZK) DKIM proofs in WASM in seconds.
  - A proof format that zkVerify's sound verifier targets.
- What's left is integration work plus three external dependencies:
  - Kurier/zkverifyjs on Volta (G1c)
  - your real receipts (G4)
  - mainnet enacting runtime 2.1.0 (G5, outside our control)

**Blocked in this session (needs your permission):**
- Downloading the native `nargo`/`bb` release binaries. Not needed: the npm/WASM path works.
- `cargo run` of zkVerify's `ultrahonk_verifier` for G1b, denied twice by this session's auto-mode. To run it yourself:
  ```
  receiptproof/spike/g1b/run.sh
  ```
  - It clones `zkVerify/ultrahonk_verifier` at `610d689` (v0.4.0) and verifies upstream's ZK vector plus our proof.
  - It also checks that a flipped public input, a flipped proof byte, and verifying as Plain are all rejected.
  - **Pass:** `ours ZK: Ok(())` and three `true` lines.

**Recheck log (2026-11-15, second pass):** rows 7, 8 and 11 were updated, and rows 20–24 added. Gates moved:
- G2 → partial (vkHash verified live)
- G3 → passed
- G5 → still blocked, with no upgrade authorized on mainnet.

## 19. Interfaces frozen for the build (2026-11-15)
All parts (circuit, contracts, agent, web) build against this section. A change here must be made in every part at once.

### 19.1 Public inputs (9 × 32-byte BN254 field elements, in this order)
| # | Name | Encoding |
|---|---|---|
| 0 | `pubkey_hash` | `poseidon_large(modulus limbs)` from zkemail (`hash.nr`); 1024-bit keys use `poseidon_large_padded_1024` |
| 1 | `nullifier` | `blinded_nullifier(signature, salt)` = Pedersen(sig limbs ‖ salt) from zkemail; unique per (email signature, salt); `signature < modulus` constrained |
| 2 | `template_id` | uint, see 19.3 |
| 3 | `amount_minor` | uint, amount in minor units (paise, cents), `< 10^12` |
| 4 | `currency` | ISO 4217 numeric: `356` INR, `840` USD |
| 5 | `sent_at` | Unix seconds from the signed `Date:` header |
| 6 | `to_commit` | `Poseidon2([to_addr packed 31 bytes/field × 4, len, salt])` |
| 7 | `recipient` | EVM address as uint160 |
| 8 | `vault_id` | uint |

- `to_commit` is computed off-chain by the same Noir code: the web app runs the small `commit` circuit (`circuits/commit`) with `noir_js.execute` and reads its return value. There is no second JS hash implementation to drift.
- Statement leaf (contract, agent and web all use this):
  ```
  leaf = keccak256(abi.encodePacked(keccak256("ultrahonk"), vkHash, versionHash, keccak256(abi.encodePacked(uint256[9] pubs))))
  ```
  - `versionHash = 0x91ea9b035e570dfe3d6b0dff19fb13586dfdd5a9da15c14f49f7ce6b3b2bc589`
  - `vkHash = keccak256(0x03 ‖ vk)`

### 19.2 zkVerify aggregation contract
```solidity
interface IZkVerifyAggregation {
  function verifyProofAggregation(uint256 _domainId, uint256 _aggregationId, bytes32 _leaf,
    bytes32[] calldata _merklePath, uint256 _leafCount, uint256 _index) external view returns (bool);
}
```
- Base Sepolia: `0x0807C544D38aE7729f8798388d89Be6502A1e8A8`, domain `2`.
- Base: `0xCb47A3C3B9Eb2E549a3F2EA4729De28CafbB2b69`, domain `2`.

### 19.3 Templates (compiled into the circuit)
| id | Merchant | Currency | Status |
|---|---|---|---|
| 1 | Uber (India) | 356 | anchor **[VERIFY]** with a real receipt (G4) |
| 2 | Swiggy | 356 | **[VERIFY]** |
| 3 | Zomato | 356 | **[VERIFY]** |
| 4 | Amazon.in | 356 | **[VERIFY]** |
| 100 | ReceiptProof Test Merchant (our DKIM test domain) | 356 | live; used by the sample-receipt button and public CI |
| 101 | ReceiptProof Test Merchant USD | 840 | live; tests the 1:1 path |

### 19.4 Agent decision (EIP-712)
- Domain: `{name: "ReceiptVault", version: "1", chainId, verifyingContract: vault}`
- Type: `Decision(uint256 vaultId,uint256 nullifier,uint256 amountMinor,bytes32 policyHash,uint64 deadline)`
- The agent signs only to approve. The contract checks `block.timestamp <= deadline`.

### 19.5 FX
- `fxRateE18[currency]` = USDC base units (6 decimals) per **one minor unit**, scaled by 1e18. USD cents give `1e4 * 1e18`.
- Each rate change is queued with `effectiveAt = now + 24h`. The payout uses the newest rate with `effectiveAt <= sent_at`. If none exists, the claim reverts with `NoRate`.
- Payout is `amount_minor * rate / 1e18`, rounded down.
