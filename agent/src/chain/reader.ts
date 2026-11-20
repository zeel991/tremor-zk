import type { Address, Hex } from "viem";
import type { ReasonCode } from "../types.js";

/** ReceiptVault.Window: a 24 h window opened by the first claim after the previous one expired. */
export interface VaultWindow {
  start: bigint;
  used: bigint;
}

/** Everything the pre-checks need from chain (ReceiptVault.claim steps 1–7 and 10). */
export interface VaultSnapshot {
  blockTimestamp: bigint; // chain time, so window/expiry checks match the contract
  vaultId: bigint;
  paused: boolean;
  vkAccepted: boolean;
  nullifierSpent: boolean;
  key: { domainHash: Hex; activatesAt: bigint; cancelled: boolean }; // dkimKey(pubs[0])
  merchant: { domainHash: Hex; maxPerClaim: bigint; maxPerDay: bigint; active: boolean }; // minor units
  merchantWindow: VaultWindow; // vault-wide, per template, minor units
  employee: Address; // zero address if not registered
  registeredAt: bigint;
  employeeWindow: VaultWindow; // per toCommit, USDC base units
  employeeDailyCap: bigint; // USDC base units
  fxRateE18: bigint; // rateAt(currency, sent_at); 0 when the contract would revert NoRate
  usdcBalance: bigint;
}

export interface SnapshotQuery {
  vkHash: Hex;
  pubkeyHash: bigint;
  nullifier: bigint;
  templateId: bigint;
  toCommit: bigint;
  currency: bigint;
  sentAt: bigint;
}

export interface MerchantView {
  templateId: number;
  domainHash: Hex;
  maxPerClaim: bigint;
  maxPerDay: bigint;
  active: boolean;
}

/** On-chain DKIM key entry (ReceiptVault.dkimKey struct), as served to the web app. */
export interface DkimKeyView {
  pubkeyHash: Hex; // 32-byte hex
  domainHash: Hex;
  domain: string;
  selector: string;
  modulus: Hex; // full RSA modulus, big-endian
  bits: number;
  activatesAt: bigint;
  cancelled: boolean;
  active: boolean; // !cancelled && block.timestamp >= activatesAt
}

export interface VaultReader {
  snapshot(vault: Address, q: SnapshotQuery): Promise<VaultSnapshot>;
  overview(vault: Address, templateIds: number[]): Promise<{ paused: boolean; usdcBalance: bigint; employeeDailyCap: bigint; merchants: MerchantView[] }>;
  /**
   * DKIM keys stored on chain. Candidate hashes are `knownHashes` (e.g. the D1 `keys` table) plus
   * every KeyProposed event since `logsFromBlock` (when given). Unknown hashes are dropped.
   */
  dkimKeys(vault: Address, knownHashes: bigint[], logsFromBlock?: bigint): Promise<DkimKeyView[]>;
  /** Root zkVerify published for (domainId, aggregationId) on this chain; zero bytes32 if not yet published. */
  aggregationRoot?(zkv: Address, domainId: bigint, aggregationId: bigint): Promise<Hex>;
}

export interface ClaimArgs {
  pubs: readonly bigint[];
  vkHash: Hex;
  aggregationId: bigint;
  path: Hex[];
  leafCount: bigint;
  index: bigint;
  policyHash: Hex;
  deadline: bigint;
  agentSig: Hex;
}

export type TxResult =
  | { ok: true; txHash: Hex }
  | { ok: false; error: string; errorName: string | null; reason: ReasonCode | null };

export interface VaultSettler {
  /** Simulates vault.claim from the relayer, then sends it only if the simulation passes. */
  settle(vault: Address, args: ClaimArgs): Promise<TxResult>;
  /** Sandbox only: simulates then sends registerFor(toCommit, wallet) from the relayer (= vault.registrar). */
  registerFor(vault: Address, toCommit: bigint, wallet: Address): Promise<TxResult>;
  receiptStatus(txHash: Hex): Promise<"success" | "reverted" | "pending">;
}
