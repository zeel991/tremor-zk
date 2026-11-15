import { zeroAddress, zeroHash, type Hex } from "viem";
import type { VaultSnapshot, VaultWindow } from "./chain/reader.js";
import { SUPPORTED_CURRENCIES, templateById } from "./templates.js";
import type { Pubs, ReasonCode } from "./types.js";

// ReceiptVault constants
export const MAX_RECEIPT_AGE = 60n * 86400n;
export const MAX_FUTURE_SKEW = 3600n;
export const WINDOW = 86400n;
export const USD = 840n;
export const USD_RATE_E18 = 10n ** 22n; // 1 cent = 1e4 USDC base units, fixed in the contract
export const MAX_AMOUNT_MINOR = 10n ** 12n; // SPEC §19.1

export interface PrecheckInput {
  pubs: Pubs;
  requestVaultId: bigint;
  snap: VaultSnapshot;
  /** A live (non-rejected, non-failed) claim with this nullifier already exists in D1. */
  dbDuplicate: boolean;
}

/** Math.mulDiv(amount, rate, 1e18), rounded down (ReceiptVault._applyCaps). */
export function payoutUsdc(amountMinor: bigint, fxRateE18: bigint): bigint {
  return (amountMinor * fxRateE18) / 10n ** 18n;
}

/** Mirrors ReceiptVault._consume without writing: would `amount` fit in this window at `now`? */
export function windowFits(w: VaultWindow, amount: bigint, cap: bigint, now: bigint): boolean {
  const used = now >= w.start + WINDOW ? 0n : w.used;
  return used + amount <= cap;
}

/**
 * Cheap checks mirroring ReceiptVault.claim steps 1–7 and 10 (`whenNotPaused`, `_checkKeyAndMerchant`,
 * `_checkPayee`, `_checkWindow`, `_applyCaps`, `_pay` balance), evaluated at chain time
 * `snap.blockTimestamp`. Unlike the contract, which stops at the first revert, this returns every
 * failing reason. Steps 8 (aggregation) and 9 (agent signature) can only fail later, at settlement.
 * The first block adds agent-side range checks that the circuit already guarantees.
 */
export function precheck({ pubs, requestVaultId, snap, dbDuplicate }: PrecheckInput): ReasonCode[] {
  const out = new Set<ReasonCode>();
  const now = snap.blockTimestamp;
  const tpl = templateById(pubs.templateId);

  // agent-side ranges (circuit-constrained; a mismatch means the proof cannot be valid)
  if (pubs.vaultId !== requestVaultId) out.add("BAD_PROOF");
  if (pubs.amountMinor >= MAX_AMOUNT_MINOR || pubs.amountMinor === 0n) out.add("BAD_PROOF");
  if (!SUPPORTED_CURRENCIES.has(Number(pubs.currency))) out.add("BAD_PROOF");
  if (!tpl) out.add("UNKNOWN_TEMPLATE");
  else if (BigInt(tpl.currency) !== pubs.currency) out.add("BAD_PROOF");

  // whenNotPaused
  if (snap.paused) out.add("PAUSED");
  // 1. VkNotAccepted
  if (!snap.vkAccepted) out.add("BAD_PROOF");
  // 2. WrongVault
  if (pubs.vaultId !== snap.vaultId) out.add("BAD_PROOF");
  // 3. NullifierSpent (+ D1)
  if (snap.nullifierSpent || dbDuplicate) out.add("DUPLICATE");
  // 4. _checkKeyAndMerchant
  const keyKnown = snap.key.domainHash !== zeroHash && !snap.key.cancelled;
  if (!keyKnown) out.add("UNKNOWN_KEY"); // UnknownKey
  else if (now < snap.key.activatesAt) out.add("UNKNOWN_KEY"); // KeyNotYetActive
  if (!snap.merchant.active) out.add("UNKNOWN_TEMPLATE"); // MerchantInactive
  else if (keyKnown && (snap.merchant.domainHash as Hex).toLowerCase() !== snap.key.domainHash.toLowerCase()) out.add("UNKNOWN_KEY"); // KeyDomainMismatch
  // 5. _checkPayee
  if (snap.employee.toLowerCase() === zeroAddress) out.add("NOT_EMPLOYEE");
  else if (pubs.recipient >> 160n !== 0n || BigInt(snap.employee) !== pubs.recipient) out.add("PAYEE_MISMATCH");
  // 6. _checkWindow (future first, then expiry, then registration; registeredAt survives revocation)
  if (pubs.sentAt > now + MAX_FUTURE_SKEW) out.add("FUTURE_DATED");
  else if (pubs.sentAt + MAX_RECEIPT_AGE < now) out.add("STALE");
  if (pubs.sentAt < snap.registeredAt) out.add("STALE");
  // 7. _applyCaps
  if (pubs.amountMinor > snap.merchant.maxPerClaim) out.add("OVER_CAP"); // ExceedsPerClaimCap
  if (!windowFits(snap.merchantWindow, pubs.amountMinor, snap.merchant.maxPerDay, now)) out.add("OVER_CAP"); // ExceedsMerchantDailyCap
  const rate = pubs.currency === USD ? USD_RATE_E18 : snap.fxRateE18;
  let payout: bigint | null = null;
  if (rate === 0n) out.add("NO_FX_RATE");
  else {
    payout = payoutUsdc(pubs.amountMinor, rate);
    if (payout === 0n) out.add("ZERO_PAYOUT");
    else if (!windowFits(snap.employeeWindow, payout, snap.employeeDailyCap, now)) out.add("OVER_CAP"); // ExceedsEmployeeDailyCap
  }
  // 10. _pay: InsufficientVaultBalance
  if (payout !== null && snap.usdcBalance < payout) out.add("VAULT_EMPTY");

  return [...out];
}
