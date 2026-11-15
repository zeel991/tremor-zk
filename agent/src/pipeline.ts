import { getAddress, type Hex } from "viem";
import type { VaultReader, VaultSettler } from "./chain/reader.js";
import { Repo, type ClaimRow } from "./db.js";
import type { ProofSubmitter } from "./kurier.js";
import { precheck } from "./precheck.js";
import { evaluatePolicy, findRule, type NoteVerdict } from "./policy/evaluate.js";
import { explainDecision, judgeNote, type Llm } from "./policy/llm.js";
import { parsePolicy, policyHash, type Policy } from "./policy/schema.js";
import type { ClaimRequest } from "./schema.js";
import { templateById } from "./templates.js";
import { pubsFromArray, toHex32, type ClaimStatus, type Decision, type ReasonCode } from "./types.js";

export interface AgentConfig {
  chainId: number;
  vkHashes: Record<string, Hex>;
  maxSubmissionsPerDay: number;
  decisionTtlSeconds: number;
  pollBatch: number;
  agentKey?: Hex;
}

export interface Deps {
  repo: Repo;
  reader: VaultReader;
  submitter: ProofSubmitter | null;
  settler: VaultSettler | null;
  llm?: Llm;
  now: () => number; // ms
  newId: () => string;
  cfg: AgentConfig;
}

export type Step = { step: string; [k: string]: unknown };
export interface ClaimResponse {
  httpStatus: number;
  body: {
    claimId?: string;
    decision?: Decision;
    reasons?: ReasonCode[];
    status?: ClaimStatus;
    explanation?: string;
    kurierJob?: string | null;
    error?: string;
  };
}

const MONTH_LOOKBACK = 32 * 86400;

export function loadPolicy(policyJson: string, expectedHash: string): Policy {
  const p = parsePolicy(JSON.parse(policyJson));
  if (!p.ok) throw new Error(`stored policy invalid: ${p.errors.join("; ")}`);
  if (policyHash(p.policy).toLowerCase() !== expectedHash.toLowerCase()) throw new Error("stored policy_hash does not match policy_json");
  return p.policy;
}

/**
 * SPEC §8.2 per-claim pipeline: pre-checks → policy → Kurier submit → record.
 * No proof verification happens here (10 ms CPU budget); zkVerify verifies.
 */
export async function handleClaim(req: ClaimRequest, d: Deps, onStep: (s: Step) => void = () => {}): Promise<ClaimResponse> {
  const nowMs = d.now();
  const vaultIdStr = req.vaultId.toString();
  const pubs = pubsFromArray(req.pubs);
  const pubsHex = req.pubs.map(toHex32);
  const nullifierHex = toHex32(pubs.nullifier);

  const vault = await d.repo.getVault(vaultIdStr);
  if (!vault) return { httpStatus: 404, body: { error: "UNKNOWN_VAULT" } };
  const vkHash = d.cfg.vkHashes[req.circuit];
  if (!vkHash || !/^0x[0-9a-fA-F]{64}$/.test(vkHash)) return { httpStatus: 503, body: { error: "VK_NOT_CONFIGURED" } };
  if (!d.submitter) return { httpStatus: 503, body: { error: "SUBMITTER_NOT_CONFIGURED" } };
  // Cheap early exit; the atomic check happens right before submission.
  if ((await d.repo.submissionsToday(nowMs)) >= d.cfg.maxSubmissionsPerDay) return { httpStatus: 429, body: { error: "DAILY_SUBMISSION_CAP" } };

  // 1. pre-checks
  onStep({ step: "precheck" });
  const existing = await d.repo.getClaimByNullifier(nullifierHex);
  const liveDuplicate = !!existing && existing.status !== "REJECTED" && existing.status !== "FAILED";
  let snap;
  try {
    snap = await d.reader.snapshot(getAddress(vault.address), {
      vkHash,
      pubkeyHash: pubs.pubkeyHash,
      nullifier: pubs.nullifier,
      templateId: pubs.templateId,
      toCommit: pubs.toCommit,
      currency: pubs.currency,
      sentAt: pubs.sentAt,
    });
  } catch {
    return { httpStatus: 502, body: { error: "CHAIN_UNAVAILABLE" } };
  }
  const preReasons = precheck({ pubs, requestVaultId: req.vaultId, snap, dbDuplicate: liveDuplicate });

  const tpl = templateById(pubs.templateId);
  const explainFacts = (decision: Decision, reasons: ReasonCode[]) => ({
    decision,
    reasons,
    merchant: tpl?.merchant ?? `template ${pubs.templateId}`,
    amountMinor: pubs.amountMinor,
    currency: Number(pubs.currency),
    sentAt: pubs.sentAt,
  });

  const baseRow = (): ClaimRow => ({
    id: d.newId(),
    vault_id: vaultIdStr,
    nullifier: nullifierHex,
    template_id: Number(pubs.templateId),
    amount_minor: pubs.amountMinor.toString(),
    currency: Number(pubs.currency),
    sent_at: Number(pubs.sentAt),
    to_commit: toHex32(pubs.toCommit),
    recipient: toHex32(pubs.recipient),
    decision: "REJECT",
    reasons: "[]",
    kurier_job: null,
    zkv_tx: null,
    aggregation_id: null,
    base_tx: null,
    created_at: nowMs,
    updated_at: nowMs,
    status: "REJECTED",
    kurier_status: null,
    circuit: req.circuit,
    vk_hash: vkHash,
    pubs: JSON.stringify(pubsHex),
    proof: null,
    note: req.note ?? null,
    explanation: null,
    policy_hash: vault.policy_hash,
    retries: 0,
    submitted_at: null,
    agg_path: null,
    agg_leaf_count: null,
    agg_index: null,
    agg_leaf: null,
    agent_sig: null,
    error: null,
  });

  const record = async (row: ClaimRow): Promise<boolean> => {
    if (existing && !liveDuplicate) await d.repo.releaseDeadNullifier(nullifierHex);
    try {
      await d.repo.insertClaim(row);
      return true;
    } catch {
      return false; // UNIQUE(nullifier): a concurrent claim won the race
    }
  };

  if (preReasons.length) {
    onStep({ step: "decision", decision: "REJECT", reasons: preReasons });
    const explanation = await explainDecision(undefined, explainFacts("REJECT", preReasons)); // no LLM spend on rejects
    if (liveDuplicate) return { httpStatus: 200, body: { decision: "REJECT", reasons: preReasons, explanation, claimId: existing!.id } };
    const row = { ...baseRow(), reasons: JSON.stringify(preReasons), explanation };
    if (!(await record(row))) return { httpStatus: 409, body: { decision: "REJECT", reasons: ["DUPLICATE"] } };
    return { httpStatus: 200, body: { claimId: row.id, decision: "REJECT", reasons: preReasons, status: "REJECTED", explanation } };
  }

  // 2. policy (deterministic; LLM only judges note fit and writes text)
  onStep({ step: "policy" });
  let policy: Policy;
  try {
    policy = loadPolicy(vault.policy_json, vault.policy_hash);
  } catch {
    return { httpStatus: 500, body: { error: "POLICY_INVALID" } };
  }
  const claimFacts = {
    templateId: Number(pubs.templateId),
    amountMinor: pubs.amountMinor,
    currency: Number(pubs.currency),
    sentAt: pubs.sentAt,
    note: req.note,
  };
  const ruleIdx = findRule(policy, claimFacts.templateId, claimFacts.currency);
  let noteVerdict: NoteVerdict | undefined;
  const rule = ruleIdx === null ? undefined : policy.rules[ruleIdx];
  if (rule?.noteRequired && req.note && req.note.trim()) {
    noteVerdict = d.llm ? await judgeNote(d.llm, req.note, rule.notePurpose ?? rule.category, rule.category) : "unsure";
  }
  const prior = (await d.repo.priorApproved(vaultIdStr, toHex32(pubs.toCommit), Number(pubs.sentAt) - MONTH_LOOKBACK)).map((p) => ({
    templateId: p.template_id,
    amountMinor: BigInt(p.amount_minor),
    currency: p.currency,
    sentAt: BigInt(p.sent_at),
  }));
  const ev = evaluatePolicy(policy, claimFacts, prior, noteVerdict);
  const explanation = await explainDecision(d.llm, explainFacts(ev.decision, ev.reasons));
  onStep({ step: "decision", decision: ev.decision, reasons: ev.reasons, explanation });

  if (ev.decision !== "APPROVE") {
    const status: ClaimStatus = ev.decision === "FLAG" ? "FLAGGED" : "REJECTED";
    const row = { ...baseRow(), decision: ev.decision, status, reasons: JSON.stringify(ev.reasons), explanation };
    if (!(await record(row))) return { httpStatus: 409, body: { decision: "REJECT", reasons: ["DUPLICATE"] } };
    return { httpStatus: 200, body: { claimId: row.id, decision: ev.decision, reasons: ev.reasons, status, explanation } };
  }

  // 3. reserve the nullifier, take submission budget, submit
  const row: ClaimRow = { ...baseRow(), decision: "APPROVE", status: "SUBMITTED", proof: req.proof, explanation };
  if (!(await record(row))) return { httpStatus: 409, body: { decision: "REJECT", reasons: ["DUPLICATE"] } };
  if (!(await d.repo.tryConsumeSubmission(nowMs, d.cfg.maxSubmissionsPerDay))) {
    await d.repo.updateClaim(row.id, { status: "REJECTED", decision: "REJECT", error: "DAILY_SUBMISSION_CAP" }, nowMs);
    await d.repo.releaseDeadNullifier(nullifierHex);
    return { httpStatus: 429, body: { error: "DAILY_SUBMISSION_CAP" } };
  }
  onStep({ step: "submit" });
  try {
    const r = await d.submitter.submit({ proof: req.proof as Hex, publicSignals: pubsHex, vkHash });
    if (r.optimisticVerify === "failed") {
      await d.repo.updateClaim(row.id, { status: "REJECTED", decision: "REJECT", reasons: '["BAD_PROOF"]', kurier_job: r.jobId, proof: null, error: "optimisticVerify failed" }, d.now());
      onStep({ step: "decision", decision: "REJECT", reasons: ["BAD_PROOF"] });
      return { httpStatus: 200, body: { claimId: row.id, decision: "REJECT", reasons: ["BAD_PROOF"], status: "REJECTED", kurierJob: r.jobId } };
    }
    await d.repo.updateClaim(row.id, { kurier_job: r.jobId, kurier_status: "Queued", submitted_at: d.now() }, d.now());
    onStep({ step: "submitted", kurierJob: r.jobId });
    return { httpStatus: 202, body: { claimId: row.id, decision: "APPROVE", reasons: [], status: "SUBMITTED", explanation, kurierJob: r.jobId } };
  } catch (e) {
    // Left SUBMITTED without a job: the poller treats it as a failed job and retries once.
    await d.repo.updateClaim(row.id, { kurier_status: "SubmitError", error: (e as Error).message.slice(0, 300) }, d.now());
    onStep({ step: "submit_error" });
    return { httpStatus: 202, body: { claimId: row.id, decision: "APPROVE", reasons: [], status: "SUBMITTED", explanation, kurierJob: null } };
  }
}

