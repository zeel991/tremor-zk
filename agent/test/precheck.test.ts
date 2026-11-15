import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes, zeroAddress, zeroHash } from "viem";
import type { VaultSnapshot } from "../src/chain/reader.js";
import { payoutUsdc, precheck, USD_RATE_E18, windowFits } from "../src/precheck.js";
import type { Pubs, ReasonCode } from "../src/types.js";
import { DOMAIN_UBER, goodPubs, goodSnapshot, NOW_S } from "./helpers.js";

function run(p: Partial<Pubs> = {}, s: Partial<VaultSnapshot> = {}, dbDuplicate = false, requestVaultId = 7n) {
  return precheck({ pubs: goodPubs(p), snap: goodSnapshot(s), dbDuplicate, requestVaultId });
}
const key = (o: Partial<VaultSnapshot["key"]>) => ({ key: { ...goodSnapshot().key, ...o } });
const merchant = (o: Partial<VaultSnapshot["merchant"]>) => ({ merchant: { ...goodSnapshot().merchant, ...o } });
const PAYOUT = payoutUsdc(64200n, 120n * 10n ** 18n); // 7,704,000 = $7.704

describe("pre-checks mirror ReceiptVault.claim (contracts/src/ReceiptVault.sol)", () => {
  it("passes a good claim", () => {
    expect(run()).toEqual([]);
  });

  const cases: [string, ReasonCode, () => ReasonCode[]][] = [
    ["whenNotPaused", "PAUSED", () => run({}, { paused: true })],
    ["1 VkNotAccepted", "BAD_PROOF", () => run({}, { vkAccepted: false })],
    ["2 WrongVault (on chain)", "BAD_PROOF", () => run({}, { vaultId: 9n })],
    ["2 vault id in proof ≠ request", "BAD_PROOF", () => run({ vaultId: 8n })],
    ["3 NullifierSpent", "DUPLICATE", () => run({}, { nullifierSpent: true })],
    ["3 nullifier live in D1", "DUPLICATE", () => run({}, {}, true)],
    ["4 UnknownKey (zero domain)", "UNKNOWN_KEY", () => run({}, key({ domainHash: zeroHash }))],
    ["4 UnknownKey (cancelled)", "UNKNOWN_KEY", () => run({}, key({ cancelled: true }))],
    ["4 KeyNotYetActive (24 h timelock)", "UNKNOWN_KEY", () => run({}, key({ activatesAt: NOW_S + 1n }))],
    ["4 MerchantInactive", "UNKNOWN_TEMPLATE", () => run({}, merchant({ active: false }))],
    ["4 KeyDomainMismatch", "UNKNOWN_KEY", () => run({}, key({ domainHash: keccak256(stringToBytes("evil.com")) }))],
    ["5 EmployeeNotRegistered", "NOT_EMPLOYEE", () => run({}, { employee: zeroAddress })],
    ["5 WrongPayee (other wallet)", "PAYEE_MISMATCH", () => run({ recipient: 0xdeadn })],
    ["5 WrongPayee (recipient > 160 bits)", "PAYEE_MISMATCH", () => run({ recipient: goodPubs().recipient + (1n << 160n) })],
    ["6 ReceiptInFuture", "FUTURE_DATED", () => run({ sentAt: NOW_S + 3601n })],
    ["6 ReceiptExpired", "STALE", () => run({ sentAt: NOW_S - 60n * 86400n - 1n }, { registeredAt: 0n })],
    ["6 ReceiptBeforeRegistration", "STALE", () => run({}, { registeredAt: NOW_S - 60n })],
    ["7 ExceedsPerClaimCap", "OVER_CAP", () => run({ amountMinor: 100001n })],
    ["7 ExceedsMerchantDailyCap (open window)", "OVER_CAP", () => run({}, { merchantWindow: { start: NOW_S - 100n, used: 300000n - 64199n } })],
    ["7 ExceedsEmployeeDailyCap (USDC)", "OVER_CAP", () => run({}, { employeeWindow: { start: NOW_S - 100n, used: 50_000_000n - PAYOUT + 1n } })],
    ["7 NoRate", "NO_FX_RATE", () => run({}, { fxRateE18: 0n })],
    ["7 ZeroPayout", "ZERO_PAYOUT", () => run({ amountMinor: 1n }, { fxRateE18: 10n ** 17n })],
    ["10 InsufficientVaultBalance", "VAULT_EMPTY", () => run({}, { usdcBalance: PAYOUT - 1n })],
    ["unknown template id (agent-side)", "UNKNOWN_TEMPLATE", () => run({ templateId: 55n })],
    ["currency differs from template (agent-side)", "BAD_PROOF", () => run({ currency: 840n })],
  ];
  it.each(cases)("%s → %s", (_name, code, fn) => {
    expect(fn()).toContain(code);
  });

  it("boundaries match the contract's comparisons", () => {
    expect(run({ sentAt: NOW_S + 3600n })).toEqual([]); // sentAt > now + 1h reverts, == passes
    expect(run({ sentAt: NOW_S - 60n * 86400n }, { registeredAt: 0n })).toEqual([]); // sentAt + 60d < now reverts
    expect(run({}, { registeredAt: goodPubs().sentAt })).toEqual([]); // sentAt < registeredAt reverts
    expect(run({}, key({ activatesAt: NOW_S }))).toEqual([]); // now < activatesAt reverts
    expect(run({ amountMinor: 100000n })).toEqual([]); // amount > maxPerClaim reverts
    expect(run({}, { usdcBalance: PAYOUT })).toEqual([]);
  });

  it("an expired daily window resets like _consume (start + 24h <= now)", () => {
    const full = { start: NOW_S - 86400n, used: 300000n };
    expect(run({}, { merchantWindow: full })).toEqual([]);
    expect(run({}, { merchantWindow: { ...full, start: NOW_S - 86399n } })).toContain("OVER_CAP");
    expect(windowFits({ start: 0n, used: 0n }, 5n, 5n, NOW_S)).toBe(true);
    expect(windowFits({ start: NOW_S, used: 1n }, 5n, 5n, NOW_S)).toBe(false);
  });

  it("USD (840) uses the contract's fixed 1e22 rate, even if rateAt was not read", () => {
    const usd = goodPubs({ templateId: 101n, currency: 840n, amountMinor: 500n });
    const snap = goodSnapshot({ fxRateE18: 0n, merchant: { domainHash: DOMAIN_UBER, maxPerClaim: 1000n, maxPerDay: 1000n, active: true } });
    expect(precheck({ pubs: usd, snap, dbDuplicate: false, requestVaultId: 7n })).toEqual([]);
    expect(payoutUsdc(500n, USD_RATE_E18)).toBe(5_000_000n); // $5.00 → 5e6 base units, 1:1
    expect(payoutUsdc(1n, 3n * 10n ** 17n)).toBe(0n); // rounds down
  });
});
