import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import { getAddress, keccak256, stringToBytes, zeroAddress, type Address, type Hex } from "viem";
import type { ClaimArgs, DkimKeyView, TxResult, VaultReader, VaultSettler, VaultSnapshot } from "../src/chain/reader.js";
import { Repo } from "../src/db.js";
import type { JobStatus, ProofSubmitter, SubmitInput } from "../src/kurier.js";
import type { Deps } from "../src/pipeline.js";
import { canonicalJson, policyHash, type Policy } from "../src/policy/schema.js";
import { pubsToArray, toHex32, type Pubs } from "../src/types.js";

/** Minimal D1 over node:sqlite, so tests run the real migration SQL. */
export function makeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url).pathname;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(dir + f, "utf8"));
  const norm = (p: unknown[]) => p.map((x) => (x === undefined ? null : x)) as (string | number | bigint | null)[];
  const stmt = (sql: string, params: unknown[] = []): unknown => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    first: async (col?: string) => {
      const r = db.prepare(sql).get(...norm(params)) as Record<string, unknown> | undefined;
      if (!r) return null;
      return col ? r[col] : { ...r };
    },
    all: async () => ({ results: db.prepare(sql).all(...norm(params)).map((r) => ({ ...(r as object) })), success: true, meta: {} }),
    run: async () => {
      const r = db.prepare(sql).run(...norm(params));
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return { prepare: (sql: string) => stmt(sql), exec: async (sql: string) => db.exec(sql) } as unknown as D1Database;
}

export const NOW_MS = Date.parse("2026-11-12T08:00:00Z"); // Thursday
export const NOW_S = BigInt(NOW_MS / 1000);
export const VAULT_ADDR: Address = getAddress("0x1111111111111111111111111111111111111111");
export const EMPLOYEE: Address = getAddress("0x2222222222222222222222222222222222222222");
export const VK_HASH: Hex = "0x806073cafcaee81e9803c622546730931813769bf9eef8126a95e8c318cd6dca";
export const DOMAIN_UBER: Hex = keccak256(stringToBytes("uber.com"));
export const AGENT_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

export const POLICY: Policy = {
  version: 1,
  timezoneOffsetMinutes: 330,
  rules: [
    { category: "meals", currency: 356, maxPerDay: 150000, weekdays: ["MON", "TUE", "WED", "THU", "FRI"], noteRequired: false },
    { category: "transport", templateIds: [1], currency: 356, maxPerClaim: 80000, noteRequired: false },
    { category: "shopping", templateIds: [4], currency: 356, maxPerMonth: 300000, noteRequired: true, notePurpose: "office supplies" },
    { category: "test", currency: 356, maxPerClaim: 5000, noteRequired: false },
  ],
};

export function goodPubs(over: Partial<Pubs> = {}): Pubs {
  return {
    pubkeyHash: 0xabcn,
    nullifier: 0x1234n,
    templateId: 1n,
    amountMinor: 64200n,
    currency: 356n,
    sentAt: NOW_S - 3600n,
    toCommit: 0x77n,
    recipient: BigInt(EMPLOYEE),
    vaultId: 7n,
    ...over,
  };
}

export function pubsHex(p: Pubs): string[] {
  return pubsToArray(p).map(toHex32);
}

export function goodSnapshot(over: Partial<VaultSnapshot> = {}): VaultSnapshot {
  return {
    blockTimestamp: NOW_S,
    vaultId: 7n,
    paused: false,
    vkAccepted: true,
    nullifierSpent: false,
    key: { domainHash: DOMAIN_UBER, activatesAt: NOW_S - 86400n, cancelled: false },
    merchant: { domainHash: DOMAIN_UBER, maxPerClaim: 100000n, maxPerDay: 300000n, active: true },
    merchantWindow: { start: 0n, used: 0n },
    employee: EMPLOYEE,
    registeredAt: NOW_S - 30n * 86400n,
    employeeWindow: { start: 0n, used: 0n },
    employeeDailyCap: 50_000_000n, // $50
    fxRateE18: 120n * 10n ** 18n, // 1 paisa = 120 USDC base units (≈ ₹83/USD)
    usdcBalance: 20_000_000n,
    ...over,
  };
}

export async function seedVault(db: D1Database, policy: Policy = POLICY, id = "7") {
  await db
    .prepare("INSERT INTO vaults (id, address, policy_text, policy_json, policy_hash) VALUES (?, ?, ?, ?, ?)")
    .bind(id, VAULT_ADDR, "Meals up to ₹1,500 per day on working days...", canonicalJson(policy), policyHash(policy))
    .run();
}

export function mockReader(snap: VaultSnapshot = goodSnapshot()) {
  return {
    snapshot: vi.fn(async () => snap),
    overview: vi.fn(async () => ({ paused: false, usdcBalance: snap.usdcBalance, employeeDailyCap: snap.employeeDailyCap, merchants: [] })),
    dkimKeys: vi.fn(async (_v: Address, _h: bigint[], _b?: bigint): Promise<DkimKeyView[]> => []),
  } satisfies VaultReader;
}

export function mockSubmitter() {
  let n = 0;
  const statuses = new Map<string, JobStatus>();
  const s = {
    submit: vi.fn(async (_input: SubmitInput) => {
      n++;
      const jobId = `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
      return { jobId, optimisticVerify: "success" as const };
    }),
    status: vi.fn(async (jobId: string) => statuses.get(jobId) ?? { jobId, status: "Queued" }),
    setStatus(jobId: string, st: Partial<JobStatus>) {
      statuses.set(jobId, { jobId, status: "Queued", ...st });
    },
  };
  return s satisfies ProofSubmitter;
}

export function mockSettler() {
  return {
    settle: vi.fn(async (_vault: Address, _args: ClaimArgs): Promise<TxResult> => ({ ok: true as const, txHash: ("0x" + "ee".repeat(32)) as Hex })),
    registerFor: vi.fn(async (_vault: Address, _toCommit: bigint, _wallet: Address): Promise<TxResult> => ({ ok: true as const, txHash: ("0x" + "fa".repeat(32)) as Hex })),
    receiptStatus: vi.fn(async (_tx: Hex) => "success" as const),
  } satisfies VaultSettler;
}

export function makeDeps(db: D1Database, over: Partial<Deps> = {}): Deps {
  let id = 0;
  return {
    repo: new Repo(db),
    reader: mockReader(),
    submitter: mockSubmitter(),
    settler: mockSettler(),
    llm: undefined,
    now: () => NOW_MS,
    newId: () => `aaaaaaaa-0000-4000-8000-${(++id).toString().padStart(12, "0")}`,
    cfg: { chainId: 84532, vkHashes: { rsa2048: VK_HASH, rsa1024: VK_HASH }, maxSubmissionsPerDay: 5, decisionTtlSeconds: 3600, pollBatch: 10, agentKey: AGENT_KEY },
    ...over,
  };
}

export const PROOF: Hex = `0x${"ab".repeat(9536)}`;
export { zeroAddress };
