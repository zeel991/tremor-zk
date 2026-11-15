/**
 * Local end-to-end test against anvil (chainId 31337, local process only; never a public network).
 *
 * Real: anvil, ReceiptVault (contracts/out artifact) behind an ERC1967 proxy, the agent's viem reader
 * and settler, D1 SQL (node:sqlite shim), the receipt circuit (noir_js) and a real UltraHonk ZK proof
 * (bb.js, verifierTarget 'evm'), DKIM signing with the public CI test key.
 * Mocked: Kurier (statuses walk to Aggregated with our leaf) and the zkVerify aggregation contract
 * (test/e2e/sol MockZkVerifyAggregation: true only for an accepted (domain, aggregation, leaf)).
 *
 * Skipped unless `anvil` and `forge` are on PATH. Takes ~1 min (two real proofs).
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, keccak256, stringToBytes, toHex,
  type Abi, type Address, type Hex, type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { vaultAbi } from "../src/chain/abi.js";
import { handleRequest } from "../src/index.js";
import type { JobStatus, ProofSubmitter, SubmitInput } from "../src/kurier.js";
import { statementLeaf } from "../src/leaf.js";
import { pollOnce } from "../src/poller.js";
import { buildDeps } from "../src/index.js";
import { canonicalJson, policyHash, type Policy } from "../src/policy/schema.js";
import { rfc5322Date, sampleHeadersAndBody } from "../src/sample.js";
import type { Env } from "../src/types.js";
import { makeD1 } from "./helpers.js";

const RP = new URL("../../", import.meta.url).pathname; // receiptproof/
const SOL = new URL("./e2e/sol/", import.meta.url).pathname;
const has = (bin: string) => spawnSync("which", [bin]).status === 0;
const ENABLED = has("anvil") && has("forge") && process.env.RP_SKIP_E2E !== "1";

const VK_HASHES = JSON.parse(readFileSync(`${RP}circuits/vk-hashes.json`, "utf8")) as Record<string, Hex>;
const VK: Hex = VK_HASHES.receipt_rsa2048!;
const CI = JSON.parse(readFileSync(`${RP}fixtures/public/ci_dkim_TEST_ONLY.json`, "utf8")) as { domain: string; selector: string; privateKeyPem: string };
const VERSION_HASH: Hex = "0x91ea9b035e570dfe3d6b0dff19fb13586dfdd5a9da15c14f49f7ce6b3b2bc589";
const INR_RATE = 120n * 10n ** 18n; // USDC base units per paise × 1e18 (≈ ₹83/$)
const SALT = "0x1234567890abcdef1234567890abcdef";
const INBOX = "judge@example.com";
const AGG_ID = 42n;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
const artifact = (p: string) => {
  const j = JSON.parse(readFileSync(p, "utf8"));
  return { abi: j.abi as Abi, bytecode: j.bytecode.object as Hex };
};

let anvil: ChildProcess | undefined;
let rpc = "";
let keys: Hex[] = [];
let pub: PublicClient;
let addr: Record<string, Address> = {};
let env: Env;
let db: D1Database;
let anvilNowMs = 0;
const txs: Record<string, Hex> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lib: { signEmail: any; buildInputs: any; Noir: any; UltraHonkBackend: any; Barretenberg: any; circuit: any };

function startAnvil(): Promise<{ proc: ChildProcess; port: number; keys: Hex[] }> {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn("anvil", ["--port", String(port), "--chain-id", "31337", "--accounts", "6"], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`anvil did not start: ${out.slice(-500)}`)), 20000);
    proc.stdout!.on("data", (b: Buffer) => {
      out += b.toString();
      if (out.includes("Listening on")) {
        clearTimeout(t);
        const pk = [...out.split("Private Keys")[1]!.matchAll(/\(\d+\) (0x[0-9a-f]{64})/g)].map((m) => m[1] as Hex);
        resolve({ proc, port, keys: pk });
      }
    });
    proc.on("exit", (c) => reject(new Error(`anvil exited ${c}`)));
  });
}

async function send(key: Hex, to: Address, abi: Abi, functionName: string, args: unknown[], label: string): Promise<Hex> {
  const w = createWalletClient({ chain: foundry, transport: http(rpc), account: privateKeyToAccount(key) });
  const hash = await w.writeContract({ address: to, abi, functionName, args } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${label} reverted`);
  txs[label] = hash;
  return hash;
}

async function deploy(key: Hex, a: { abi: Abi; bytecode: Hex }, args: unknown[], label: string): Promise<Address> {
  const w = createWalletClient({ chain: foundry, transport: http(rpc), account: privateKeyToAccount(key) });
  const hash = await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args } as never);
  const r = await pub.waitForTransactionReceipt({ hash });
  txs[`deploy ${label}`] = hash;
  return getAddress(r.contractAddress!);
}

async function syncNow() {
  const b = await pub.getBlock({ blockTag: "latest" });
  anvilNowMs = Number(b.timestamp) * 1000;
  return b.timestamp;
}

/** A fresh CI-key-signed receipt to INBOX dated `atSec`, run through the circuit and proved for real. */
async function proveReceipt(atSec: bigint, recipient: Address, id: string, prove = true) {
  const { headers, body } = sampleHeadersAndBody({ to: INBOX, amountMinor: 4900, nowMs: Number(atSec) * 1000, id, domain: CI.domain });
  const { dkimResult } = lib.signEmail({ headers, body, domain: CI.domain, selector: CI.selector, privateKey: CI.privateKeyPem });
  const { inputs } = lib.buildInputs(dkimResult, { templateId: 100, salt: SALT, recipient, vaultId: 0 });
  const noir = new lib.Noir(lib.circuit);
  const { witness, returnValue } = await noir.execute(inputs);
  const outputs = (returnValue as string[]).map((x) => BigInt(x));
  if (!prove) return { outputs, modulus: dkimResult.publicKey as bigint };
  const api = await lib.Barretenberg.new({ threads: os.cpus().length, logger: () => {} });
  try {
    const be = new lib.UltraHonkBackend(lib.circuit.bytecode, api);
    const proof = await be.generateProof(witness, { verifierTarget: "evm" });
    expect(await be.verifyProof(proof, { verifierTarget: "evm" })).toBe(true);
    const vk = await be.getVerificationKey({ verifierTarget: "evm" });
    const vkHash = keccak256(new Uint8Array([3, ...vk]));
    return { outputs, modulus: dkimResult.publicKey as bigint, proof: toHex(proof.proof as Uint8Array), pubs: proof.publicInputs as Hex[], vkHash };
  } finally {
    await api.destroy();
  }
}

/** Kurier stand-in: each status() call advances one step; the last step carries our leaf. */
function kurierMock(leafFor: (pubs: Hex[]) => Hex) {
  const seq = ["Queued", "Valid", "Submitted", "IncludedInBlock", "Finalized", "AggregationPending", "Aggregated"];
  const jobs = new Map<string, { step: number; pubs: Hex[] }>();
  const calls: SubmitInput[] = [];
  const m: ProofSubmitter & { calls: SubmitInput[] } = {
    calls,
    async submit(i) {
      calls.push(i);
      const jobId = `00000000-0000-4000-8000-${String(calls.length).padStart(12, "0")}`;
      jobs.set(jobId, { step: 0, pubs: i.publicSignals });
      return { jobId, optimisticVerify: "success" };
    },
    async status(jobId): Promise<JobStatus> {
      const j = jobs.get(jobId)!;
      j.step = Math.min(j.step + 1, seq.length - 1);
      const status = seq[j.step]!;
      if (status !== "Aggregated") return { jobId, status };
      return {
        jobId,
        status,
        txHash: "0x" + "ab".repeat(32),
        aggregationId: Number(AGG_ID),
        aggregationDetails: { leaf: leafFor(j.pubs), merkleProof: [], leafIndex: 0, numberOfLeaves: 1 },
        aggregationPublished: { destinationChainId: 31337, destinationTxHash: "0x" + "cd".repeat(32) },
      };
    },
  };
  return m;
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const POLICY: Policy = { version: 1, timezoneOffsetMinutes: 0, rules: [{ category: "test", currency: 356, maxPerClaim: 5000, noteRequired: false }] };

describe.skipIf(!ENABLED)("e2e on local anvil (chainId 31337)", () => {
  let kurier: ReturnType<typeof kurierMock>;
  let pubkeyHash: bigint, toCommit: bigint, modulus: bigint;
  let employee: Address, stranger: Address;
  const f = () => ({ submitter: () => kurier, now: () => anvilNowMs });
  const req = (method: string, path: string, body?: unknown) =>
    handleRequest(
      new Request(`http://agent.local${path}`, { method, headers: { "content-type": "application/json", "cf-connecting-ip": "127.0.0.1" }, body: body ? JSON.stringify(body) : undefined }),
      env,
      ctx,
      f(),
    );

  beforeAll(async () => {
    execFileSync("forge", ["build", "--root", SOL], { stdio: "ignore" });
    const vaultArt = `${RP}contracts/out/ReceiptVault.sol/ReceiptVault.json`;
    expect(existsSync(vaultArt), "run forge build in contracts/").toBe(true);
    lib = {
      ...(await load(`${RP}circuits/js/lib/dkim.mjs`)),
      ...(await load(`${RP}circuits/js/lib/inputs.mjs`)),
      ...(await load(`${RP}circuits/js/node_modules/@noir-lang/noir_js/lib/index.mjs`)),
      ...(await load(`${RP}circuits/js/node_modules/@aztec/bb.js/dest/node/index.js`)),
      circuit: JSON.parse(readFileSync(`${RP}circuits/target/receipt_rsa2048.json`, "utf8")),
    };

    const a = await startAnvil();
    anvil = a.proc;
    keys = a.keys;
    rpc = `http://127.0.0.1:${a.port}`;
    pub = createPublicClient({ chain: foundry, transport: http(rpc) }) as PublicClient;
    const [owner, agent, relayer, emp, other] = keys.map((k) => privateKeyToAccount(k).address);
    employee = emp!;
    stranger = other!;
    addr = { owner: owner!, agent: agent!, relayer: relayer! };

    // pubkeyHash and toCommit come from the circuit itself (outputs [0] and [6])
    const probe = await proveReceipt(1794700000n, employee, "probe000-0000", false);
    pubkeyHash = probe.outputs[0]!;
    toCommit = probe.outputs[6]!;
    modulus = probe.modulus;

    const mocks = `${SOL}out/E2EMocks.sol/`;
    addr.usdc = await deploy(keys[0]!, artifact(`${mocks}MockUSDC.json`), [], "MockUSDC");
    addr.zkv = await deploy(keys[0]!, artifact(`${mocks}MockZkVerifyAggregation.json`), [], "MockZkVerifyAggregation");
    addr.multicall = await deploy(keys[0]!, artifact(`${mocks}MiniMulticall3.json`), [], "MiniMulticall3");
    addr.impl = await deploy(keys[0]!, artifact(vaultArt), [], "ReceiptVault impl");
    const init = encodeFunctionData({
      abi: vaultAbi,
      functionName: "initialize",
      args: [addr.owner!, addr.usdc, 0n, addr.zkv, 2n, VERSION_HASH, addr.agent!, 50_000_000n],
    });
    addr.vault = await deploy(keys[0]!, artifact(`${RP}contracts/out/ERC1967Proxy.sol/ERC1967Proxy.json`), [addr.impl, init], "ERC1967Proxy (vault 0)");

    const v = vaultAbi as Abi;
    await send(keys[0]!, addr.vault, v, "setAcceptedVk", [VK, true], "setAcceptedVk");
    await send(keys[0]!, addr.vault, v, "setMerchant", [100n, CI.domain, 5000n, 20000n, true], "setMerchant 100");
    await send(keys[0]!, addr.vault, v, "setRegistrar", [addr.relayer], "setRegistrar");
    await send(keys[0]!, addr.vault, v, "proposeKey", [pubkeyHash, CI.domain, CI.selector, toHex(modulus, { size: 256 })], "proposeKey");
    await send(keys[0]!, addr.vault, v, "queueFxRate", [356n, INR_RATE], "queueFxRate INR");
    const usdcAbi = artifact(`${mocks}MockUSDC.json`).abi;
    await send(keys[0]!, addr.usdc, usdcAbi, "mint", [addr.vault, 20_000_000n], "mint 20 USDC to vault");
    await pub.request({ method: "evm_increaseTime" as never, params: [86400 + 120] as never });
    await pub.request({ method: "evm_mine" as never, params: [] as never });
    await syncNow();

    db = makeD1();
    await db
      .prepare("INSERT INTO vaults (id, address, policy_text, policy_json, policy_hash) VALUES ('0', ?, ?, ?, ?)")
      .bind(addr.vault, "Sandbox: test merchant up to ₹50 per claim.", canonicalJson(POLICY), policyHash(POLICY))
      .run();
    env = {
      DB: db, KURIER_BASE_URL: "http://kurier.invalid", CHAIN_ID: "31337", RPC_URL: rpc, MULTICALL3_ADDRESS: addr.multicall, KEY_LOGS_FROM_BLOCK: "0",
      ZKV_AGGREGATION: addr.zkv, ZKV_DOMAIN_ID: "2", VK_HASHES: JSON.stringify({ rsa2048: VK }), ALLOWED_ORIGINS: "",
      MAX_SUBMISSIONS_PER_DAY: "10", DECISION_TTL_SECONDS: "3600", AI_MODEL: "x", POLL_BATCH: "10",
      AGENT_PRIVATE_KEY: keys[1], RELAYER_PRIVATE_KEY: keys[2], KURIER_API_KEY: undefined,
      SAMPLE_DKIM_DOMAIN: "", SAMPLE_DKIM_SELECTOR: "", SAMPLE_RECEIPTS_PER_IP_PER_DAY: "5", REGISTRATIONS_PER_IP_PER_DAY: "3",
    } as Env;
    kurier = kurierMock((pubs) => statementLeaf(VK, pubs.map((x) => BigInt(x))));
  }, 240_000);

  afterAll(() => {
    anvil?.kill("SIGTERM");
    // eslint-disable-next-line no-console
    console.log("[e2e] contracts:", JSON.stringify(addr), "\n[e2e] txs:", JSON.stringify(txs, null, 1));
  });

  it("GET /api/vault/0 serves the on-chain DKIM key with its full modulus", async () => {
    const res = await req("GET", "/api/vault/0");
    const body = (await res.json()) as { dkimKeys: { domain: string; selector: string; modulus: string; bits: number; active: boolean; cancelled: boolean; pubkeyHash: string }[] };
    expect(body.dkimKeys).toHaveLength(1);
    const k = body.dkimKeys[0]!;
    expect(k).toMatchObject({ domain: CI.domain, selector: CI.selector, bits: 2048, active: true, cancelled: false });
    expect(BigInt(k.modulus)).toBe(modulus);
    expect(BigInt(k.pubkeyHash)).toBe(pubkeyHash);
  });

  it("POST /api/register relays registerFor on chain", async () => {
    const res = await req("POST", "/api/register", { vaultId: 0, toCommit: toHex(toCommit), wallet: employee });
    const body = (await res.json()) as { txHash: Hex };
    expect(res.status).toBe(202);
    txs["registerFor (agent relayer)"] = body.txHash;
    expect((await pub.waitForTransactionReceipt({ hash: body.txHash })).status).toBe("success");
    expect(await pub.readContract({ address: addr.vault!, abi: vaultAbi, functionName: "employee", args: [toCommit] })).toBe(employee);
    const again = await req("POST", "/api/register", { vaultId: 0, toCommit: toHex(toCommit), wallet: stranger });
    expect(again.status).toBe(409); // AlreadyRegistered decoded from the simulation revert
  });

  let claimBody: { vaultId: string; circuit: string; proof: Hex; pubs: Hex[] };
  let nullifier: bigint;

  it("real proof → pre-checks on chain → APPROVE → Kurier (mock) → poller settles via claim → PAID", async () => {
    const sentAt = await syncNow(); // >= registeredAt (same or later block)
    const p = await proveReceipt(sentAt, employee, "e2e00001-real");
    expect(p.vkHash).toBe(VK); // the bb.js VK is the one the vault accepts
    expect(p.pubs!.map((x) => BigInt(x))).toEqual(p.outputs);
    expect(p.outputs[3]).toBe(4900n);
    nullifier = p.outputs[1]!;
    claimBody = { vaultId: "0", circuit: "rsa2048", proof: p.proof!, pubs: p.pubs! };

    const before = (await pub.readContract({ address: addr.usdc!, abi: artifact(`${SOL}out/E2EMocks.sol/MockUSDC.json`).abi, functionName: "balanceOf", args: [employee] })) as bigint;
    const res = await req("POST", "/api/claim", claimBody);
    const body = (await res.json()) as { claimId: string; decision: string; reasons: string[] };
    expect(res.status).toBe(202);
    expect(body).toMatchObject({ decision: "APPROVE", reasons: [] });
    expect(kurier.calls).toHaveLength(1);
    expect(kurier.calls[0]).toMatchObject({ vkHash: VK, publicSignals: p.pubs });

    // the agent's leaf is the contract's leaf; the mock aggregator accepts exactly that leaf
    const leaf = statementLeaf(VK, p.outputs);
    const onchainLeaf = await pub.readContract({ address: addr.vault!, abi: vaultAbi, functionName: "statementLeaf", args: [p.outputs as never, VK] });
    expect(onchainLeaf).toBe(leaf);
    await send(keys[0]!, addr.zkv!, artifact(`${SOL}out/E2EMocks.sol/MockZkVerifyAggregation.json`).abi, "accept", [2n, AGG_ID, leaf], "zkv mock accept(leaf)");

    const deps = () => buildDeps(env, f());
    let status = "";
    for (let i = 0; i < 12 && status !== "PAID"; i++) {
      await syncNow();
      await pollOnce(deps());
      status = (await deps().repo.getClaim(body.claimId))!.status;
    }
    const row = (await deps().repo.getClaim(body.claimId))!;
    expect(row.status).toBe("PAID");
    txs["claim (agent relayer)"] = row.base_tx as Hex;

    const payout = (4900n * INR_RATE) / 10n ** 18n; // 588,000 = $0.588
    const after = (await pub.readContract({ address: addr.usdc!, abi: artifact(`${SOL}out/E2EMocks.sol/MockUSDC.json`).abi, functionName: "balanceOf", args: [employee] })) as bigint;
    expect(after - before).toBe(payout);
    expect(await pub.readContract({ address: addr.vault!, abi: vaultAbi, functionName: "spent", args: [nullifier] })).toBe(true);
    // eslint-disable-next-line no-console
    console.log(`[e2e] employee USDC ${before} → ${after} (+${payout}); claim tx ${row.base_tx}`);
  }, 180_000);

  it("the same proof again → REJECT DUPLICATE, no Kurier call", async () => {
    await syncNow();
    const res = await req("POST", "/api/claim", claimBody);
    const body = (await res.json()) as { decision: string; reasons: string[] };
    expect(body.decision).toBe("REJECT");
    expect(body.reasons).toContain("DUPLICATE");
    expect(kurier.calls).toHaveLength(1);
  });

  it("a real proof paying a different wallet → REJECT PAYEE_MISMATCH only, no Kurier call", async () => {
    const sentAt = await syncNow();
    const p = await proveReceipt(sentAt, stranger, "e2e00002-payee");
    const res = await req("POST", "/api/claim", { vaultId: "0", circuit: "rsa2048", proof: p.proof, pubs: p.pubs });
    const body = (await res.json()) as { decision: string; reasons: string[] };
    expect(body).toMatchObject({ decision: "REJECT", reasons: ["PAYEE_MISMATCH"] });
    expect(kurier.calls).toHaveLength(1);
  }, 180_000);
});
