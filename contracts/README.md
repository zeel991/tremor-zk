# ReceiptProof contracts

`ReceiptVault` pays USDC for a DKIM-signed merchant receipt that has been proven in Noir (UltraHonk) and aggregated by zkVerify. SPEC §7, §10 and §19 are the source of truth.

## Test

```sh
forge build
forge test -vv                               # unit tests + Base Sepolia fork test
forge test --no-match-contract ZkVerifyFork  # offline only
BASE_SEPOLIA_RPC_URL=<rpc> forge test --match-contract ZkVerifyFork
```

- **Unit tests** (`test/ReceiptVault.t.sol`) use a mock aggregator. The mock returns true only for the exact `(domainId, aggregationId, leaf, path, leafCount, index)` that the test registered. Each passing claim therefore also checks that the vault built the SPEC §19.1 leaf.
- **Fork test** (`test/ZkVerifyFork.t.sol`) reads the real zkVerify aggregation contract on Base Sepolia. Its fixture is `test/fixtures/zkv_base_sepolia_65470.json`:
  - Volta aggregation 65470, domain 2.
  - The path comes from `aggregate_statementPath`.
  - The root was posted on Base Sepolia in tx `0x99f0…a1b1`.

  The test checks that a real leaf returns `true`, and that a flipped leaf, a wrong index or a wrong aggregation id returns `false`. It also runs the vault's own `_verifyLeaf` call through a harness.

  The fixture leaf is a third-party **Groth16** statement. It shows that our call shape works against the real contract. It does **not** check our UltraHonk leaf formula.

The default fork RPC is `https://base-sepolia-rpc.publicnode.com`.

## Deploy (not run)

`script/Deploy.s.sol` deploys the implementation and the UUPS proxy, then configures the vault from env vars. The env vars are listed in the file header.

- The script reads no private key. The signer comes from forge CLI flags.
- Without `--broadcast` it only simulates.

## `claim` check order (SPEC §7.1)

`claim(pubs[9], vkHash, aggregationId, path, leafCount, index, policyHash, deadline, agentSig)` runs only when the vault is not paused. It then runs these checks in order. Each check has its own custom error.

1. `acceptedVk[vkHash]`. Error: `VkNotAccepted`.
2. `pubs[8] == vaultId`. Error: `WrongVault`.
3. `!spent[nullifier]`. Error: `NullifierSpent`.
4. The DKIM key is known, not cancelled, and past its 24 h activation. The merchant is active, and the key's domain equals the merchant's domain. Errors: `UnknownKey`, `KeyNotYetActive`, `MerchantInactive`, `KeyDomainMismatch`.
5. `to_commit` is registered, and `recipient` is exactly the registered wallet (a clean uint160). Errors: `EmployeeNotRegistered`, `WrongPayee`.
6. `sent_at ≤ now + 1 h`, `sent_at ≥ now − 60 d`, and `sent_at ≥ registeredAt[to_commit]`. Errors: `ReceiptInFuture`, `ReceiptExpired`, `ReceiptBeforeRegistration`.
7. Caps:
   - Per claim and per merchant per day, both in minor units. Errors: `ExceedsPerClaimCap`, `ExceedsMerchantDailyCap`.
   - FX lookup at `sent_at`. Errors: `NoRate`, `ZeroPayout`.
   - Per employee per day, in USDC. Error: `ExceedsEmployeeDailyCap`.
8. `zkv.verifyProofAggregation(domainId, aggregationId, leaf, …)`, where `leaf = keccak256(keccak256("ultrahonk") ‖ vkHash ‖ versionHash ‖ keccak256(pubs))`. Error: `ProofNotAggregated`.
9. The EIP-712 `Decision(vaultId, nullifier, amountMinor, policyHash, deadline)` is signed by `agent`, and `now ≤ deadline`. Errors: `DecisionExpired`, `BadAgentSignature`.
10. Mark the nullifier spent, then transfer `amount_minor × rate / 1e18` USDC to the recipient. Error: `InsufficientVaultBalance`.

## Trust assumptions

- **Vault owner.** The owner curates DKIM keys, merchants, employees, FX rates, the accepted VKs, the zkVerify parameters and the agent. The owner can also upgrade the contract (UUPS) and withdraw funds.
  - A bad key or rate costs only that owner's vault. Keys and rates are timelocked 24 h and evented.
  - The owner is fully trusted with the vault's own funds. Upgradeability means the owner could change any rule. Use a multisig.
- **zkVerify.** We trust that the aggregation contract only holds roots of statements whose proofs Volta or zkVerify verified, and that the relayer posts honest roots.
- **DKIM keys.** The contract cannot check `pubkeyHash == poseidon(modulus)`. It stores the full modulus so off-chain checkers can compare it with DNS and the archive (SPEC §7.2).
- **Agent.** The agent can only approve or withhold a claim. Amount, payee, merchant and vault come from the proof and the hard checks. A stolen agent key cannot redirect or inflate a payout. It can approve claims that the soft policy would reject, up to the caps.
- **Sandbox (`vaultId 0`).** Anyone can call `registerSelf`. It is first come, first served and cannot overwrite an existing entry. Drain is bounded by the merchant daily cap, the small balance and `pause`. Someone who front-runs a `registerSelf` can block that commitment but cannot receive its payouts, because `recipient` is bound in the proof.
- **Daily caps.** The window opens at the first claim after the previous window expired. It is not a true sliding window: up to 2× the cap can be paid inside one 24 h span.
