import { beforeEach, describe, expect, it, vi } from "vitest";
import { zeroAddress } from "viem";
import { handleRequest } from "../src/index.js";
import { statementLeaf } from "../src/leaf.js";
import { recoverDecisionSigner } from "../src/eip712.js";
import { handleClaim, type Deps } from "../src/pipeline.js";
import { pollOnce } from "../src/poller.js";
import { parseClaimRequest } from "../src/schema.js";
import { pubsToArray, type Env } from "../src/types.js";
import {
  AGENT_KEY, goodPubs, goodSnapshot, makeD1, makeDeps, mockReader, mockSettler, mockSubmitter, NOW_MS, POLICY, PROOF, pubsHex, seedVault, VAULT_ADDR, VK_HASH,
} from "./helpers.js";
import { agentAddress } from "../src/eip712.js";
import { policyHash } from "../src/policy/schema.js";

function req(over: Record<string, unknown> = {}, pubs = goodPubs()) {
  const r = parseClaimRequest(JSON.stringify({ vaultId: "7", circuit: "rsa2048", proof: PROOF, pubs: pubsHex(pubs), ...over }));
  if (!r.ok) throw new Error("bad test request");
  return r.value;
}

let db: D1Database;
let d: Deps;
let sub: ReturnType<typeof mockSubmitter>;
let settler: ReturnType<typeof mockSettler>;
beforeEach(async () => {
  db = makeD1();
  await seedVault(db);
  sub = mockSubmitter();
  settler = mockSettler();
  d = makeDeps(db, { submitter: sub, settler });
});

describe("POST /api/claim pipeline", () => {
  it("approves, submits to Kurier and records only public fields", async () => {
    const r = await handleClaim(req({ note: "airport" }), d);
    expect(r.httpStatus).toBe(202);
    expect(r.body.decision).toBe("APPROVE");
    expect(sub.submit).toHaveBeenCalledOnce();
    expect(sub.submit.mock.calls[0]![0]).toMatchObject({ vkHash: VK_HASH, publicSignals: pubsHex(goodPubs()) });
    const row = await d.repo.getClaim(r.body.claimId!);
    expect(row).toMatchObject({ status: "SUBMITTED", kurier_status: "Queued", decision: "APPROVE", policy_hash: policyHash(POLICY) });
    expect(await d.repo.submissionsToday(NOW_MS)).toBe(1);
  });

  it("pre-check failure → REJECT with reason, no Kurier spend", async () => {
    d.reader = mockReader(goodSnapshot({ employee: zeroAddress }));
    const r = await handleClaim(req(), d);
    expect(r.body).toMatchObject({ decision: "REJECT", reasons: ["NOT_EMPLOYEE"], status: "REJECTED" });
    expect(sub.submit).not.toHaveBeenCalled();
    expect(await d.repo.submissionsToday(NOW_MS)).toBe(0);
  });

  it("policy FLAG (note-required, LLM unsure) → held, no submission", async () => {
    d.llm = vi.fn(async () => '{"verdict":"unsure"}');
    const r = await handleClaim(req({ note: "misc" }, goodPubs({ templateId: 4n, amountMinor: 1000n })), d);
    expect(r.body).toMatchObject({ decision: "FLAG", reasons: ["NOTE_MISMATCH"], status: "FLAGGED" });
    expect(sub.submit).not.toHaveBeenCalled();
  });

  it("a live nullifier is a DUPLICATE; a rejected one can be claimed again", async () => {
    const first = await handleClaim(req(), d);
    const again = await handleClaim(req(), d);
    expect(again.body).toMatchObject({ decision: "REJECT", reasons: ["DUPLICATE"], claimId: first.body.claimId });
    expect(sub.submit).toHaveBeenCalledOnce();

    const p = goodPubs({ nullifier: 0x999n, templateId: 4n, amountMinor: 1000n });
    const noNote = await handleClaim(req({}, p), d);
    expect(noNote.body).toMatchObject({ decision: "REJECT", reasons: ["NOTE_REQUIRED"] });
    d.llm = async () => '{"verdict":"fits"}';
    const withNote = await handleClaim(req({ note: "printer toner" }, p), d);
    expect(withNote.body.decision).toBe("APPROVE");
  });

  it("enforces the daily submission cap (no Kurier call, nullifier not consumed)", async () => {
    d.cfg.maxSubmissionsPerDay = 2;
    for (const n of [1n, 2n]) expect((await handleClaim(req({}, goodPubs({ nullifier: n, amountMinor: 1000n })), d)).httpStatus).toBe(202);
    const third = await handleClaim(req({}, goodPubs({ nullifier: 3n, amountMinor: 1000n })), d);
    expect(third.httpStatus).toBe(429);
    expect(third.body.error).toBe("DAILY_SUBMISSION_CAP");
    expect(sub.submit).toHaveBeenCalledTimes(2);
    expect(await d.repo.getClaimByNullifier("0x" + "3".padStart(64, "0"))).toBeNull();
    // next UTC day the budget resets
    d.now = () => NOW_MS + 86_400_000;
    expect(await d.repo.tryConsumeSubmission(d.now(), 2)).toBe(true);
  });

  it("Kurier optimistic verify failure → REJECT BAD_PROOF and frees the nullifier", async () => {
    sub.submit.mockResolvedValueOnce({ jobId: "00000000-0000-4000-8000-0000000000ff", optimisticVerify: "failed" as const } as never);
    const r = await handleClaim(req(), d);
    expect(r.body).toMatchObject({ decision: "REJECT", reasons: ["BAD_PROOF"] });
  });
});

describe("cron poller", () => {
  async function submitted() {
    const r = await handleClaim(req(), d);
    return { id: r.body.claimId!, job: r.body.kurierJob! };
  }
  const aggregated = (leaf?: string) => ({
    status: "Aggregated",
    txHash: "0x" + "aa".repeat(32),
    aggregationId: 65470,
    aggregationDetails: { merkleProof: ["0x" + "01".repeat(32)], leafIndex: 3, numberOfLeaves: 8, leaf },
    aggregationPublished: { destinationChainId: 84532, destinationTxHash: "0x" + "bb".repeat(32) },
  });

  it("walks Queued → … → Aggregated, settles with a signed decision, then PAID", async () => {
    const { id, job } = await submitted();
    for (const s of ["Valid", "Submitted", "IncludedInBlock", "Finalized", "AggregationPending"]) {
      sub.setStatus(job, { status: s });
      await pollOnce(d);
      expect(await d.repo.getClaim(id)).toMatchObject({ status: "SUBMITTED", kurier_status: s });
    }
    expect(settler.settle).not.toHaveBeenCalled();

    // Aggregated but not yet published on Base → wait
    sub.setStatus(job, { ...aggregated(), aggregationPublished: null });
    await pollOnce(d);
    expect((await d.repo.getClaim(id))!.status).toBe("SUBMITTED");

    const leaf = statementLeaf(VK_HASH, pubsToArray(goodPubs()));
    sub.setStatus(job, aggregated(leaf));
    const s = await pollOnce(d);
    expect(s.transitions).toEqual([{ id, from: "SUBMITTED", to: "SETTLE_SENT" }]);
    const row = (await d.repo.getClaim(id))!;
    expect(row).toMatchObject({ status: "SETTLE_SENT", aggregation_id: 65470, agg_index: 3, agg_leaf_count: 8, agg_leaf: leaf });
    const args = settler.settle.mock.calls[0]![1]!;
    const deadline = BigInt(NOW_MS / 1000 + 3600);
    expect(args).toMatchObject({ vkHash: VK_HASH, aggregationId: 65470n, leafCount: 8n, index: 3n, policyHash: policyHash(POLICY), deadline });
    expect(args.pubs).toEqual(pubsToArray(goodPubs()));

    // the signature the vault will check recovers to the agent
    const signer = await recoverDecisionSigner(84532, VAULT_ADDR, { vaultId: 7n, nullifier: 0x1234n, amountMinor: 64200n, policyHash: policyHash(POLICY), deadline }, args.agentSig);
    expect(signer).toBe(agentAddress(AGENT_KEY));

    await pollOnce(d);
    expect(await d.repo.getClaim(id)).toMatchObject({ status: "PAID", proof: null, base_tx: "0x" + "ee".repeat(32) });
  });

  it("a failed job is retried exactly once, then FAILED", async () => {
    const { id, job } = await submitted();
    sub.setStatus(job, { status: "Failed" });
    await pollOnce(d);
    const retried = (await d.repo.getClaim(id))!;
    expect(retried).toMatchObject({ status: "SUBMITTED", retries: 1 });
    expect(retried.kurier_job).not.toBe(job);
    expect(sub.submit).toHaveBeenCalledTimes(2);

    sub.setStatus(retried.kurier_job!, { status: "AggregationFailed" });
    await pollOnce(d);
    expect(await d.repo.getClaim(id)).toMatchObject({ status: "FAILED", proof: null });
    expect(sub.submit).toHaveBeenCalledTimes(2);
    await pollOnce(d); // no longer open
    expect(sub.status).toHaveBeenCalledTimes(2);
  });

  it("a submit error at claim time is retried once by the poller", async () => {
    sub.submit.mockRejectedValueOnce(new Error("HTTP 500"));
    const r = await handleClaim(req(), d);
    expect(r.body.kurierJob).toBeNull();
    await pollOnce(d);
    expect(await d.repo.getClaim(r.body.claimId!)).toMatchObject({ status: "SUBMITTED", retries: 1, kurier_status: "Queued" });
  });

  it("does not settle when Kurier's leaf differs from ours", async () => {
    const { id, job } = await submitted();
    sub.setStatus(job, aggregated("0x" + "cd".repeat(32)));
    await pollOnce(d);
    expect((await d.repo.getClaim(id))!.status).toBe("SETTLE_FAILED");
    expect(settler.settle).not.toHaveBeenCalled();
  });

  it("a failed simulation is recorded as SETTLE_FAILED with the vault error mapped to a reason", async () => {
    const { id, job } = await submitted();
    settler.settle.mockResolvedValueOnce({ ok: false, error: "ExceedsMerchantDailyCap", errorName: "ExceedsMerchantDailyCap", reason: "OVER_CAP" });
    sub.setStatus(job, aggregated());
    await pollOnce(d);
    expect(await d.repo.getClaim(id)).toMatchObject({ status: "SETTLE_FAILED", base_tx: null, decision: "REJECT", reasons: '["OVER_CAP"]' });
  });

  it("agent/aggregation reverts keep the decision and record the error name", async () => {
    const { id, job } = await submitted();
    settler.settle.mockResolvedValueOnce({ ok: false, error: "ProofNotAggregated", errorName: "ProofNotAggregated", reason: null });
    sub.setStatus(job, aggregated());
    await pollOnce(d);
    const row = (await d.repo.getClaim(id))!;
    expect(row).toMatchObject({ status: "SETTLE_FAILED", decision: "APPROVE" });
    expect(row.error).toContain("ProofNotAggregated");
  });
});

describe("HTTP surface", () => {
  const env = (db: D1Database) =>
    ({
      DB: db, KURIER_BASE_URL: "https://api-testnet.kurier.xyz/api/v1", CHAIN_ID: "84532", RPC_URL: "http://127.0.0.1:1", SAMPLE_DKIM_DOMAIN: "", SAMPLE_DKIM_SELECTOR: "", SAMPLE_RECEIPTS_PER_IP_PER_DAY: "5", REGISTRATIONS_PER_IP_PER_DAY: "3",
      ZKV_AGGREGATION: zeroAddress, ZKV_DOMAIN_ID: "2", VK_HASHES: JSON.stringify({ rsa2048: VK_HASH }), ALLOWED_ORIGINS: "https://receiptproof.pages.dev",
      MAX_SUBMISSIONS_PER_DAY: "5", DECISION_TTL_SECONDS: "3600", AI_MODEL: "x", POLL_BATCH: "10", AGENT_PRIVATE_KEY: AGENT_KEY,
    }) as Env;
  const ctx = { waitUntil: (p: Promise<unknown>) => void p, passThroughOnException: () => {} } as unknown as ExecutionContext;
  const f = () => ({ reader: () => mockReader(), submitter: () => sub, settler: () => settler, now: () => NOW_MS });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request("https://agent.example/api/claim", { method: "POST", headers: { "content-type": "application/json", origin: "https://receiptproof.pages.dev", ...headers }, body: JSON.stringify(body) });

  it("rejects a body carrying email bytes with 400 and stores nothing", async () => {
    const res = await handleRequest(post({ vaultId: "7", circuit: "rsa2048", proof: PROOF, pubs: pubsHex(goodPubs()), email: "DKIM-Signature: v=1; a=rsa-sha256; d=uber.com" }), env(db), ctx, f());
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("INVALID_REQUEST");
    expect(sub.submit).not.toHaveBeenCalled();
    expect(await d.repo.recent()).toHaveLength(0);
  });

  it("serves claim, recent (without note/proof), agent, health and CORS", async () => {
    const res = await handleRequest(post({ vaultId: "7", circuit: "rsa2048", proof: PROOF, pubs: pubsHex(goodPubs()), note: "secret-note" }), env(db), ctx, f());
    expect(res.status).toBe(202);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://receiptproof.pages.dev");
    const { claimId } = (await res.json()) as { claimId: string };

    const one = await handleRequest(new Request(`https://agent.example/api/claim/${claimId}`), env(db), ctx, f());
    const oneBody = await one.text();
    expect(one.status).toBe(200);
    expect(oneBody).not.toContain("secret-note");
    const recent = await (await handleRequest(new Request("https://agent.example/api/recent"), env(db), ctx, f())).text();
    expect(JSON.parse(recent).claims).toHaveLength(1);
    expect(recent).not.toContain("secret-note");
    expect(recent).not.toContain("abababab");

    const agent = (await (await handleRequest(new Request("https://agent.example/api/agent"), env(db), ctx, f())).json()) as { agent: string };
    expect(agent.agent).toBe(agentAddress(AGENT_KEY));
    const health = (await (await handleRequest(new Request("https://agent.example/health"), env(db), ctx, f())).json()) as { usage: { submissionsToday: number } };
    expect(health.usage.submissionsToday).toBe(1);
    const vault = (await (await handleRequest(new Request("https://agent.example/api/vault/7"), env(db), ctx, f())).json()) as { policyHash: string };
    expect(vault.policyHash).toBe(policyHash(POLICY));

    const pre = await handleRequest(new Request("https://agent.example/api/claim", { method: "OPTIONS", headers: { origin: "https://evil.example" } }), env(db), ctx, f());
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("streams NDJSON steps when asked", async () => {
    const res = await handleRequest(post({ vaultId: "7", circuit: "rsa2048", proof: PROOF, pubs: pubsHex(goodPubs()) }, { accept: "application/x-ndjson" }), env(db), ctx, f());
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as { step: string });
    expect(lines.map((l) => l.step)).toEqual(["precheck", "policy", "decision", "submit", "submitted", "result"]);
  });
});
