import { getAddress, type Hex } from "viem";
import type { ClaimRow } from "./db.js";
import { signDecision } from "./eip712.js";
import { isFailureStatus, type JobStatus } from "./kurier.js";
import { statementLeaf } from "./leaf.js";
import type { Deps } from "./pipeline.js";

export interface PollSummary {
  examined: number;
  transitions: { id: string; from: string; to: string }[];
}

function pubsOf(c: ClaimRow): bigint[] {
  return (JSON.parse(c.pubs) as string[]).map((x) => BigInt(x));
}

/**
 * Cron poller (SPEC §8.2 steps 5–7). Walks open claims:
 * SUBMITTED (Kurier Queued → … → Aggregated + published on Base) → AGGREGATED → SETTLE_SENT → PAID.
 * A failed Kurier job is resubmitted once; a second failure ends in FAILED.
 */
export async function pollOnce(d: Deps): Promise<PollSummary> {
  const open = await d.repo.openClaims(d.cfg.pollBatch);
  const summary: PollSummary = { examined: open.length, transitions: [] };
  for (const c of open) {
    const before = c.status;
    try {
      if (c.status === "SUBMITTED") await stepSubmitted(c, d);
      if (c.status === "AGGREGATED") await stepSettle(c, d);
      else if (c.status === "SETTLE_SENT" && before === "SETTLE_SENT") await stepReceipt(c, d);
    } catch (e) {
      await d.repo.updateClaim(c.id, { error: `poll: ${(e as Error).message}`.slice(0, 300) }, d.now());
    }
    if (c.status !== before) summary.transitions.push({ id: c.id, from: before, to: c.status });
  }
  return summary;
}

async function set(c: ClaimRow, patch: Partial<ClaimRow>, d: Deps) {
  Object.assign(c, patch);
  await d.repo.updateClaim(c.id, patch, d.now());
}

async function failOrRetry(c: ClaimRow, d: Deps, why: string) {
  if (c.retries >= 1 || !c.proof || !d.submitter) {
    await set(c, { status: "FAILED", kurier_status: c.kurier_status, proof: null, error: why }, d);
    return;
  }
  if (!(await d.repo.tryConsumeSubmission(d.now(), d.cfg.maxSubmissionsPerDay))) {
    await set(c, { error: `${why}; retry deferred: daily submission cap` }, d); // try again next run
    return;
  }
  try {
    const r = await d.submitter.submit({ proof: c.proof as Hex, publicSignals: JSON.parse(c.pubs), vkHash: c.vk_hash as Hex });
    await set(c, { retries: c.retries + 1, kurier_job: r.jobId, kurier_status: "Queued", submitted_at: d.now(), error: `retry after: ${why}` }, d);
  } catch (e) {
    await set(c, { status: "FAILED", retries: c.retries + 1, proof: null, error: `${why}; retry submit failed: ${(e as Error).message}`.slice(0, 300) }, d);
  }
}

async function stepSubmitted(c: ClaimRow, d: Deps) {
  if (!d.submitter) return;
  if (!c.kurier_job) return failOrRetry(c, d, "submit error");
  let st: JobStatus;
  try {
    st = await d.submitter.status(c.kurier_job);
  } catch (e) {
    await set(c, { error: `status: ${(e as Error).message}`.slice(0, 300) }, d); // transient; next run
    return;
  }
  const patch: Partial<ClaimRow> = { kurier_status: st.status };
  if (st.txHash) patch.zkv_tx = st.txHash;
  if (st.aggregationId != null) patch.aggregation_id = st.aggregationId;
  await set(c, patch, d);

  if (isFailureStatus(st.status)) return failOrRetry(c, d, `kurier ${st.status}`);

  const ad = st.aggregationDetails;
  const published = st.aggregationPublished?.destinationTxHash;
  if (st.status !== "Aggregated" || !published || !ad?.merkleProof || ad.leafIndex == null || ad.numberOfLeaves == null || st.aggregationId == null) return;

  // Our leaf must be the one zkVerify aggregated (SPEC §7.1 step 8 [VERIFY]); otherwise claim() would revert.
  const local = statementLeaf(c.vk_hash as Hex, pubsOf(c));
  const remote = ad.leaf ?? st.statement ?? null;
  if (remote && remote.toLowerCase() !== local.toLowerCase()) {
    await set(c, { status: "SETTLE_FAILED", agg_leaf: remote, error: `LEAF_MISMATCH local=${local}` }, d);
    return;
  }
  await set(
    c,
    {
      status: "AGGREGATED",
      agg_path: JSON.stringify(ad.merkleProof),
      agg_leaf_count: ad.numberOfLeaves,
      agg_index: ad.leafIndex,
      agg_leaf: local,
    },
    d,
  );
}

async function stepSettle(c: ClaimRow, d: Deps) {
  if (!d.settler || !d.cfg.agentKey) return; // not configured: stays AGGREGATED
  const vault = await d.repo.getVault(c.vault_id);
  if (!vault) return set(c, { status: "SETTLE_FAILED", error: "vault row missing" }, d);
  const pubs = pubsOf(c);
  const deadline = BigInt(Math.floor(d.now() / 1000) + d.cfg.decisionTtlSeconds);
  const vaultAddr = getAddress(vault.address);
  // Signed only now, after zkVerify verified and aggregated the proof.
  const policyHash = (c.policy_hash ?? vault.policy_hash) as Hex;
  const agentSig = await signDecision(d.cfg.agentKey, d.cfg.chainId, vaultAddr, {
    vaultId: pubs[8]!,
    nullifier: pubs[1]!,
    amountMinor: pubs[3]!,
    policyHash,
    deadline,
  });
  const r = await d.settler.settle(vaultAddr, {
    pubs,
    vkHash: c.vk_hash as Hex,
    aggregationId: BigInt(c.aggregation_id!),
    path: JSON.parse(c.agg_path!) as Hex[],
    leafCount: BigInt(c.agg_leaf_count!),
    index: BigInt(c.agg_index!),
    policyHash,
    deadline,
    agentSig,
  });
  if (r.ok) await set(c, { status: "SETTLE_SENT", base_tx: r.txHash, agent_sig: agentSig }, d);
  else {
    // A vault revert that maps to a claim reason (e.g. OVER_CAP from a filled daily window) turns the
    // decision into REJECT with that reason; agent/aggregation errors keep the decision and are named.
    const patch: Partial<ClaimRow> = { status: "SETTLE_FAILED", agent_sig: agentSig, error: `simulate/send: ${r.error}` };
    if (r.reason) Object.assign(patch, { decision: "REJECT", reasons: JSON.stringify([r.reason]) });
    await set(c, patch, d);
  }
}

async function stepReceipt(c: ClaimRow, d: Deps) {
  if (!d.settler || !c.base_tx) return;
  const s = await d.settler.receiptStatus(c.base_tx as Hex);
  if (s === "success") await set(c, { status: "PAID", proof: null }, d);
  else if (s === "reverted") await set(c, { status: "SETTLE_FAILED", error: "claim tx reverted" }, d);
}
