# Deploy runbook (testnet: zkVerify Volta → Base Sepolia)

Every step below that creates an account, spends funds, deploys, or publishes needs the owner's explicit yes. Nothing here has been run.

## 0. What the owner provides
| Item | Why | Notes |
|---|---|---|
| Kurier **testnet** API key | Submit proofs to zkVerify Volta | Sign up at Kurier yourself. The key is stored only as the Worker secret `KURIER_API_KEY` |
| Deployer wallet with Base Sepolia ETH | Deploy the vault proxy + config txs | Faucet ETH; ~0.01 ETH is plenty |
| Relayer wallet with Base Sepolia ETH | Sends `claim` / `registerFor` | Holds only gas |
| Agent signing key | EIP-712 approvals | No funds needed |
| Test USDC on Base Sepolia | Fund the sandbox vault | Circle faucet; e.g. 20 USDC |
| Cloudflare account | Worker + D1 + Pages (free tier) | `wrangler login` is interactive, so you run it |
| Optional: a DNS name for the sample-receipt DKIM key | Lets the web app's DNS cross-check show ✓ | Not required: the vault's on-chain key list is the authority |

## 1. Generate the sandbox sample-receipt DKIM key (local, secret)
```bash
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out sample-dkim.pem   # keep out of git (*.pem is ignored)
```
- Its modulus is registered in the sandbox vault for the test-merchant domain (step 3).
- The PEM becomes the Worker secret `SAMPLE_DKIM_PRIVATE_KEY`.
- **Never** register the public CI keys in `fixtures/public/` in any vault: anyone can sign with them.

## 2. Deploy the vault (Base Sepolia) — needs your yes
```bash
cd contracts
forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC --broadcast   # env vars listed at the top of Deploy.s.sol
```
Constructor/initialize values:
- `vaultId = 0`
- zkv `0x0807C544D38aE7729f8798388d89Be6502A1e8A8`, `domainId = 2`
- `versionHash = 0x91ea9b035e570dfe3d6b0dff19fb13586dfdd5a9da15c14f49f7ce6b3b2bc589`
- agent = agent address; `employeeDailyCap` small, e.g. 2 USDC

## 3. Configure (owner txs) — needs your yes
- `setAcceptedVk` for both values in `circuits/vk-hashes.json`.
- `setMerchant(100, <sample domain>, 5000, 20000, true)`. That's ₹50 per claim and ₹200 per day, the SPEC 7.3 caps.
- `proposeKey(pubkeyHash, domain, selector, modulus)`:
  - Get `pubkeyHash` from output[0] of a proof made with the sample key: run `cli.mjs` with `--key-txt`, or the agent's sample endpoint locally.
  - The key activates after 24 h, so do this first.
- `queueFxRate(356, rateE18)`, which also activates after 24 h.
  - INR: `rateE18 = 1e6 / (100 * INR_per_USD) * 1e18`. At 84 INR/USD that's ≈ `119047619047619047619`.
- `setRegistrar(relayer)`.
- Deposit test USDC.

## 4. Agent Worker + D1 — needs your yes
```bash
cd agent
npx wrangler d1 create receiptproof          # put the id in wrangler.toml
npx wrangler d1 migrations apply receiptproof --remote
npx wrangler secret put KURIER_API_KEY
npx wrangler secret put AGENT_PRIVATE_KEY
npx wrangler secret put RELAYER_PRIVATE_KEY
npx wrangler secret put SAMPLE_DKIM_PRIVATE_KEY
npx wrangler deploy
```
Set the vars in `wrangler.toml`:
- `VK_HASHES`
- the chain and RPC
- the Kurier testnet URL and `chainId = 84532`
- `SAMPLE_DKIM_DOMAIN` / `SELECTOR`
- the CORS origin

Then insert the vault row and the compiled policy.

## 5. Register the VKs with Kurier
- Call `register-vk` once per circuit. **Assert** the returned hash equals `circuits/vk-hashes.json`.
- That is gate G2's first half. The second half is the first job's statement leaf matching the agent's computed leaf; the agent asserts this automatically.

## 6. Web (Cloudflare Pages) — needs your yes
- `cd web && npm run build`, then deploy `dist/` to Pages.
- `public/_headers` sets COOP/COEP.
- Put `public/config.json` with `agentUrl`, `vaultAddress` and `zkvExplorer` in the build.

## 7. First claim (G1c, G2) and the switch to mainnet (G5)
- Run the sample flow from a clean browser. Record the zkVerify tx, aggregation id and Base tx in README "Addresses" and `devlog/LOG.md`.
- When `state_getRuntimeVersion` on zkVerify mainnet reports `specVersion ≥ 2001000`, repeat steps 2–6 against Base mainnet:
  - zkv `0xCb47A3C3B9Eb2E549a3F2EA4729De28CafbB2b69`, domain 2
  - Kurier mainnet, `chainId 8453`
  - real USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
  - This also needs your yes.
