import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Hex } from "viem";
import type { ReasonCode } from "../types.js";
import { vaultAbi } from "./abi.js";

/**
 * ReceiptVault custom errors → agent reason codes. Errors that are not about the claim
 * itself (agent signature, aggregation, admin) map to null and are reported by name.
 */
export const VAULT_ERROR_REASON: Record<string, ReasonCode | null> = {
  VkNotAccepted: "BAD_PROOF",
  WrongVault: "BAD_PROOF",
  NullifierSpent: "DUPLICATE",
  UnknownKey: "UNKNOWN_KEY",
  KeyNotYetActive: "UNKNOWN_KEY",
  MerchantInactive: "UNKNOWN_TEMPLATE",
  KeyDomainMismatch: "UNKNOWN_KEY",
  EmployeeNotRegistered: "NOT_EMPLOYEE",
  WrongPayee: "PAYEE_MISMATCH",
  ReceiptExpired: "STALE",
  ReceiptInFuture: "FUTURE_DATED",
  ReceiptBeforeRegistration: "STALE",
  ExceedsPerClaimCap: "OVER_CAP",
  ExceedsMerchantDailyCap: "OVER_CAP",
  ExceedsEmployeeDailyCap: "OVER_CAP",
  NoRate: "NO_FX_RATE",
  ZeroPayout: "ZERO_PAYOUT",
  InsufficientVaultBalance: "VAULT_EMPTY",
  EnforcedPause: "PAUSED",
  ProofNotAggregated: null,
  DecisionExpired: null,
  BadAgentSignature: null,
};

export interface DecodedVaultError {
  errorName: string | null;
  reason: ReasonCode | null;
  args?: readonly unknown[];
}

export function decodeRevertData(data: Hex): DecodedVaultError {
  try {
    const r = decodeErrorResult({ abi: vaultAbi, data });
    return { errorName: r.errorName, reason: VAULT_ERROR_REASON[r.errorName] ?? null, args: r.args as readonly unknown[] | undefined };
  } catch {
    return { errorName: null, reason: null };
  }
}

/** Pulls the custom error out of a viem simulate/write error (decoded by viem, or raw revert data). */
export function decodeVaultError(e: unknown): DecodedVaultError {
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev?.data?.errorName) {
      const name = rev.data.errorName;
      return { errorName: name, reason: VAULT_ERROR_REASON[name] ?? null, args: rev.data.args as readonly unknown[] | undefined };
    }
    if (rev?.raw) return decodeRevertData(rev.raw);
  }
  return { errorName: null, reason: null };
}
