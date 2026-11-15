import type { Hex } from "viem";

export interface Env {
  DB: D1Database;
  AI?: Ai;
  // vars
  KURIER_BASE_URL: string;
  CHAIN_ID: string;
  RPC_URL: string;
  MULTICALL3_ADDRESS?: string; // only for chains without the canonical Multicall3 (local anvil)
  KEY_LOGS_FROM_BLOCK?: string; // optional: also discover DKIM keys from KeyProposed events since this block
  ZKV_AGGREGATION: string;
  ZKV_DOMAIN_ID: string;
  VK_HASHES: string;
  ALLOWED_ORIGINS: string;
  MAX_SUBMISSIONS_PER_DAY: string;
  DECISION_TTL_SECONDS: string;
  AI_MODEL: string;
  POLL_BATCH: string;
  // secrets (never logged)
  KURIER_API_KEY?: string;
  AGENT_PRIVATE_KEY?: string;
  RELAYER_PRIVATE_KEY?: string;
  SAMPLE_DKIM_PRIVATE_KEY?: string; // PKCS8 PEM
  SAMPLE_DKIM_DOMAIN: string;
  SAMPLE_DKIM_SELECTOR: string;
  SAMPLE_RECEIPTS_PER_IP_PER_DAY: string;
  REGISTRATIONS_PER_IP_PER_DAY: string;
}

export type Decision = "APPROVE" | "FLAG" | "REJECT";

/**
 * SPEC §8.3 reason codes, plus NO_FX_RATE (contract `NoRate`, SPEC §19.5) and ZERO_PAYOUT
 * (contract `ZeroPayout`: amount × rate rounds to 0 USDC).
 */
export const REASON_CODES = [
  "BAD_PROOF",
  "UNKNOWN_KEY",
  "UNKNOWN_TEMPLATE",
  "NOT_EMPLOYEE",
  "PAYEE_MISMATCH",
  "DUPLICATE",
  "STALE",
  "FUTURE_DATED",
  "OVER_CAP",
  "CATEGORY_NOT_ALLOWED",
  "NOTE_REQUIRED",
  "NOTE_MISMATCH",
  "VAULT_EMPTY",
  "PAUSED",
  "NO_FX_RATE",
  "ZERO_PAYOUT",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** Claim lifecycle in D1. Kurier's own job status is kept separately in `kurier_status`. */
export type ClaimStatus =
  | "REJECTED" // pre-check or policy REJECT, nothing submitted
  | "FLAGGED" // policy FLAG, held for human review, nothing submitted
  | "SUBMITTED" // Kurier job open; poller walks it
  | "AGGREGATED" // Kurier says Aggregated and published on Base; ready to settle
  | "SETTLE_SENT" // vault.claim tx broadcast
  | "PAID" // tx mined successfully
  | "SETTLE_FAILED" // simulate or tx reverted, or leaf mismatch
  | "FAILED"; // Kurier job failed twice (one retry used)

/** The 9 public inputs, SPEC §19.1, as bigints. */
export interface Pubs {
  pubkeyHash: bigint;
  nullifier: bigint;
  templateId: bigint;
  amountMinor: bigint;
  currency: bigint;
  sentAt: bigint;
  toCommit: bigint;
  recipient: bigint;
  vaultId: bigint;
}

export function pubsToArray(p: Pubs): readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint] {
  return [p.pubkeyHash, p.nullifier, p.templateId, p.amountMinor, p.currency, p.sentAt, p.toCommit, p.recipient, p.vaultId];
}

export function pubsFromArray(a: readonly bigint[]): Pubs {
  if (a.length !== 9) throw new Error("expected 9 public inputs");
  const [pubkeyHash, nullifier, templateId, amountMinor, currency, sentAt, toCommit, recipient, vaultId] = a as bigint[];
  return { pubkeyHash, nullifier, templateId, amountMinor, currency, sentAt, toCommit, recipient, vaultId } as Pubs;
}

export function toHex32(x: bigint): Hex {
  return `0x${x.toString(16).padStart(64, "0")}` as Hex;
}
