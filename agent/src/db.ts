import { keccak256, stringToBytes } from "viem";
import type { ClaimStatus, Decision, ReasonCode } from "./types.js";

export interface ClaimRow {
  id: string;
  vault_id: string;
  nullifier: string;
  template_id: number;
  amount_minor: string;
  currency: number;
  sent_at: number;
  to_commit: string;
  recipient: string;
  decision: Decision;
  reasons: string; // JSON ReasonCode[]
  kurier_job: string | null;
  zkv_tx: string | null;
  aggregation_id: number | null;
  base_tx: string | null;
  created_at: number;
  updated_at: number;
  status: ClaimStatus;
  kurier_status: string | null;
  circuit: string;
  vk_hash: string;
  pubs: string; // JSON hex[9]
  proof: string | null;
  note: string | null;
  explanation: string | null;
  policy_hash: string | null;
  retries: number;
  submitted_at: number | null;
  agg_path: string | null;
  agg_leaf_count: number | null;
  agg_index: number | null;
  agg_leaf: string | null;
  agent_sig: string | null;
  error: string | null;
}

export interface VaultRow {
  id: string;
  address: string;
  policy_text: string;
  policy_json: string;
  policy_hash: string;
}

export interface KeyRow {
  pubkey_hash: string;
  domain: string;
  selector: string;
  bits: number;
  first_seen: number;
  source: string;
}

/** Statuses after which a nullifier may be claimed again (nothing was or will be paid). */
export const DEAD_STATUSES: readonly ClaimStatus[] = ["REJECTED", "FAILED"];
/** Statuses the cron poller works on. */
export const OPEN_STATUSES: readonly ClaimStatus[] = ["SUBMITTED", "AGGREGATED", "SETTLE_SENT"];

const UPDATABLE = new Set<keyof ClaimRow>([
  "decision", "reasons", "kurier_job", "zkv_tx", "aggregation_id", "base_tx", "status", "kurier_status", "proof",
  "explanation", "policy_hash", "retries", "submitted_at", "agg_path", "agg_leaf_count", "agg_index", "agg_leaf", "agent_sig", "error",
]);

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export class Repo {
  constructor(private db: D1Database) {}

  getVault(id: string) {
    return this.db.prepare("SELECT * FROM vaults WHERE id = ?").bind(id).first<VaultRow>();
  }

  listKeys() {
    return this.db.prepare("SELECT * FROM keys ORDER BY domain, selector").all<KeyRow>().then((r) => r.results);
  }

  getClaim(id: string) {
    return this.db.prepare("SELECT * FROM claims WHERE id = ?").bind(id).first<ClaimRow>();
  }

  getClaimByNullifier(nullifier: string) {
    return this.db.prepare("SELECT * FROM claims WHERE nullifier = ?").bind(nullifier).first<ClaimRow>();
  }

  /** Frees a nullifier held by a dead (rejected or failed) claim so it can be claimed again. */
  async releaseDeadNullifier(nullifier: string): Promise<void> {
    const ph = DEAD_STATUSES.map(() => "?").join(",");
    await this.db.prepare(`DELETE FROM claims WHERE nullifier = ? AND status IN (${ph})`).bind(nullifier, ...DEAD_STATUSES).run();
  }

  async insertClaim(row: ClaimRow): Promise<void> {
    const cols = Object.keys(row) as (keyof ClaimRow)[];
    await this.db
      .prepare(`INSERT INTO claims (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .bind(...cols.map((c) => row[c]))
      .run();
  }

  async updateClaim(id: string, patch: Partial<ClaimRow>, nowMs: number): Promise<void> {
    const cols = (Object.keys(patch) as (keyof ClaimRow)[]).filter((c) => UPDATABLE.has(c));
    if (!cols.length) return;
    await this.db
      .prepare(`UPDATE claims SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .bind(...cols.map((c) => patch[c] ?? null), nowMs, id)
      .run();
  }

  recent(limit = 50) {
    return this.db.prepare("SELECT * FROM claims ORDER BY created_at DESC LIMIT ?").bind(limit).all<ClaimRow>().then((r) => r.results);
  }

  openClaims(limit: number) {
    const ph = OPEN_STATUSES.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT * FROM claims WHERE status IN (${ph}) ORDER BY updated_at ASC LIMIT ?`)
      .bind(...OPEN_STATUSES, limit)
      .all<ClaimRow>()
      .then((r) => r.results);
  }

  /** Earlier approved (and not failed) claims by one employee, for per-day/per-month policy caps. */
  priorApproved(vaultId: string, toCommit: string, sinceSentAt: number) {
    return this.db
      .prepare(
        "SELECT template_id, amount_minor, currency, sent_at FROM claims WHERE vault_id = ? AND to_commit = ? AND sent_at >= ? AND decision = 'APPROVE' AND status NOT IN ('FAILED','SETTLE_FAILED')",
      )
      .bind(vaultId, toCommit, sinceSentAt)
      .all<{ template_id: number; amount_minor: string; currency: number; sent_at: number }>()
      .then((r) => r.results);
  }

  async submissionsToday(nowMs: number): Promise<number> {
    const r = await this.db.prepare("SELECT submissions FROM usage WHERE day = ?").bind(utcDay(nowMs)).first<{ submissions: number }>();
    return r?.submissions ?? 0;
  }

  /** Atomically takes one unit of today's Kurier submission budget. false = cap reached. */
  async tryConsumeSubmission(nowMs: number, cap: number): Promise<boolean> {
    const day = utcDay(nowMs);
    await this.db.prepare("INSERT OR IGNORE INTO usage (day, submissions) VALUES (?, 0)").bind(day).run();
    const r = await this.db.prepare("UPDATE usage SET submissions = submissions + 1 WHERE day = ? AND submissions < ?").bind(day, cap).run();
    return (r.meta?.changes ?? 0) === 1;
  }

  /**
   * Atomically counts one request from `ip` against today's `cap` for `bucket`. false = limit hit.
   * Stores keccak256(day ‖ ip), never the raw IP, and drops earlier days' rows.
   */
  async tryConsumeRate(bucket: string, ip: string, nowMs: number, cap: number): Promise<boolean> {
    const day = utcDay(nowMs);
    const client = keccak256(stringToBytes(`${day}|${ip}`));
    await this.db.prepare("DELETE FROM rate_limits WHERE day < ?").bind(day).run();
    await this.db.prepare("INSERT OR IGNORE INTO rate_limits (bucket, client, day, count) VALUES (?, ?, ?, 0)").bind(bucket, client, day).run();
    const r = await this.db
      .prepare("UPDATE rate_limits SET count = count + 1 WHERE bucket = ? AND client = ? AND day = ? AND count < ?")
      .bind(bucket, client, day, cap)
      .run();
    return (r.meta?.changes ?? 0) === 1;
  }

  async decisionCounts(nowMs: number): Promise<Record<string, number>> {
    const since = nowMs - 86_400_000;
    const r = await this.db
      .prepare("SELECT decision, COUNT(*) AS n FROM claims WHERE created_at >= ? GROUP BY decision")
      .bind(since)
      .all<{ decision: string; n: number }>();
    return Object.fromEntries(r.results.map((x) => [x.decision, x.n]));
  }
}

export function parseReasons(s: string): ReasonCode[] {
  try {
    return JSON.parse(s) as ReasonCode[];
  } catch {
    return [];
  }
}
