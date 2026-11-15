import { beforeEach, describe, expect, it } from "vitest";
import { getAddress, zeroAddress } from "viem";
import { handleRequest } from "../src/index.js";
import type { Env } from "../src/types.js";
import { EMPLOYEE, makeD1, mockReader, mockSettler, mockSubmitter, POLICY, seedVault, VAULT_ADDR, VK_HASH } from "./helpers.js";

let db: D1Database;
let settler: ReturnType<typeof mockSettler>;
const env = () =>
  ({
    DB: db, KURIER_BASE_URL: "x", CHAIN_ID: "84532", RPC_URL: "http://127.0.0.1:1", ZKV_AGGREGATION: zeroAddress, ZKV_DOMAIN_ID: "2",
    VK_HASHES: JSON.stringify({ rsa2048: VK_HASH }), ALLOWED_ORIGINS: "", MAX_SUBMISSIONS_PER_DAY: "5", DECISION_TTL_SECONDS: "3600",
    AI_MODEL: "x", POLL_BATCH: "10", SAMPLE_DKIM_DOMAIN: "", SAMPLE_DKIM_SELECTOR: "", SAMPLE_RECEIPTS_PER_IP_PER_DAY: "5", REGISTRATIONS_PER_IP_PER_DAY: "3",
  }) as Env;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const call = (body: unknown, ip = "203.0.113.9", withSettler = true) =>
  handleRequest(
    new Request("https://agent.example/api/register", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify(body) }),
    env(),
    ctx,
    { reader: () => mockReader(), submitter: () => mockSubmitter(), settler: () => (withSettler ? settler : null), now: () => Date.parse("2026-11-15T10:00:00Z") },
  );
const good = { vaultId: 0, toCommit: "0x" + "12".repeat(31), wallet: EMPLOYEE.toLowerCase() };

beforeEach(async () => {
  db = makeD1();
  await seedVault(db, POLICY, "0");
  settler = mockSettler();
});

describe("POST /api/register (sandbox only)", () => {
  it("relays registerFor(toCommit, wallet) on the vault-0 address", async () => {
    const res = await call(good);
    expect(res.status).toBe(202);
    expect(settler.registerFor).toHaveBeenCalledWith(VAULT_ADDR, BigInt(good.toCommit), getAddress(EMPLOYEE));
    expect(((await res.json()) as { txHash: string }).txHash).toBe("0x" + "fa".repeat(32));
  });

  it("rejects vaultId ≠ 0, extra fields, zero/invalid wallet, zero or out-of-field toCommit", async () => {
    expect((await call({ ...good, vaultId: 7 })).status).toBe(400);
    expect(((await (await call({ ...good, vaultId: "7" })).json()) as { error: string }).error).toBe("NOT_SANDBOX");
    expect((await call({ ...good, email: "x" })).status).toBe(400);
    expect((await call({ ...good, wallet: zeroAddress })).status).toBe(400);
    expect((await call({ ...good, wallet: "0x1234" })).status).toBe(400);
    expect((await call({ ...good, toCommit: "0x0" })).status).toBe(400);
    expect((await call({ ...good, toCommit: "0x" + "ff".repeat(32) })).status).toBe(400);
    expect(settler.registerFor).not.toHaveBeenCalled();
  });

  it.each([
    ["AlreadyRegistered", 409, "ALREADY_REGISTERED"],
    ["NotSandbox", 400, "NOT_SANDBOX"],
    ["NotRegistrar", 503, "RELAYER_NOT_REGISTRAR"],
    ["EnforcedPause", 503, "PAUSED"],
    [null, 502, "REGISTER_FAILED"],
  ] as const)("maps simulation revert %s → %i %s", async (errorName, status, error) => {
    settler.registerFor.mockResolvedValueOnce({ ok: false, error: "x", errorName, reason: null });
    const res = await call(good);
    expect(res.status).toBe(status);
    expect(((await res.json()) as { error: string }).error).toBe(error);
  });

  it("rate-limits per IP per day and needs a relayer", async () => {
    for (let i = 0; i < 3; i++) expect((await call(good)).status).toBe(202);
    expect((await call(good)).status).toBe(429);
    expect((await call(good, "198.51.100.2")).status).toBe(202);
    expect((await call(good, "198.51.100.3", false)).status).toBe(503);
  });
});
