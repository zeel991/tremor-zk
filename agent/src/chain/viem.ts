import { createPublicClient, createWalletClient, getAbiItem, http, zeroHash, type Address, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia, foundry } from "viem/chains";
import { erc20Abi, multicall3Abi, vaultAbi } from "./abi.js";
import { decodeVaultError } from "./errors.js";
import type { ClaimArgs, DkimKeyView, MerchantView, SnapshotQuery, TxResult, VaultReader, VaultSettler, VaultSnapshot } from "./reader.js";

/**
 * Base and Base Sepolia, plus a local anvil chain (31337) for the end-to-end test. Anvil has no
 * Multicall3, so `multicall3` must be passed for 31337 (the e2e test deploys one).
 */
export function chainFor(chainId: number, multicall3?: Address): Chain {
  const known = [base, baseSepolia, foundry].find((c) => c.id === chainId);
  if (!known) throw new Error(`unsupported chain ${chainId}`);
  if (!multicall3) {
    if (!known.contracts?.multicall3) throw new Error(`chain ${chainId} needs MULTICALL3_ADDRESS`);
    return known;
  }
  return { ...known, contracts: { ...known.contracts, multicall3: { address: multicall3 } } };
}

type Pubs9 = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

export class ViemVaultReader implements VaultReader {
  private client;
  private chain: Chain;
  constructor(rpcUrl: string, chainId: number, multicall3?: Address) {
    this.chain = chainFor(chainId, multicall3);
    this.client = createPublicClient({ chain: this.chain, transport: http(rpcUrl) });
  }

  async aggregationRoot(zkv: Address, domainId: bigint, aggregationId: bigint): Promise<Hex> {
    return this.client.readContract({
      address: zkv,
      abi: [{ type: "function", name: "proofsAggregations", stateMutability: "view", inputs: [{ name: "domainId", type: "uint256" }, { name: "aggregationId", type: "uint256" }], outputs: [{ name: "", type: "bytes32" }] }] as const,
      functionName: "proofsAggregations",
      args: [domainId, aggregationId],
    });
  }

  /** Two RPC round trips: one multicall for vault state + chain time, one for the USDC balance. */
  async snapshot(vault: Address, q: SnapshotQuery): Promise<VaultSnapshot> {
    const c = { address: vault, abi: vaultAbi } as const;
    const mc = this.chain.contracts!.multicall3!.address;
    const r = await this.client.multicall({
      allowFailure: true,
      contracts: [
        { address: mc, abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" },
        { ...c, functionName: "vaultId" },
        { ...c, functionName: "paused" },
        { ...c, functionName: "acceptedVk", args: [q.vkHash] },
        { ...c, functionName: "spent", args: [q.nullifier] },
        { ...c, functionName: "dkimKey", args: [q.pubkeyHash] },
        { ...c, functionName: "merchants", args: [q.templateId] },
        { ...c, functionName: "merchantWindow", args: [q.templateId] },
        { ...c, functionName: "employee", args: [q.toCommit] },
        { ...c, functionName: "registeredAt", args: [q.toCommit] },
        { ...c, functionName: "employeeWindow", args: [q.toCommit] },
        { ...c, functionName: "employeeDailyCap" },
        { ...c, functionName: "rateAt", args: [q.currency, q.sentAt] }, // reverts NoRate → failure
        { ...c, functionName: "usdc" },
      ],
    });
    const must = <T,>(i: number): T => {
      const x = r[i]!;
      if (x.status !== "success") throw new Error(`vault read ${i} failed`);
      return x.result as T;
    };
    const blockTimestamp = must<bigint>(0);
    const key = must<{ domainHash: Hex; activatesAt: bigint; cancelled: boolean }>(5);
    const [mDomain, maxPerClaim, maxPerDay, active] = must<readonly [Hex, bigint, bigint, boolean]>(6);
    const [mwStart, mwUsed] = must<readonly [bigint, bigint]>(7);
    const [ewStart, ewUsed] = must<readonly [bigint, bigint]>(10);
    const rate = r[12]!;
    const usdc = must<Address>(13);
    const usdcBalance = await this.client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [vault] });
    return {
      blockTimestamp,
      vaultId: must<bigint>(1),
      paused: must<boolean>(2),
      vkAccepted: must<boolean>(3),
      nullifierSpent: must<boolean>(4),
      key: { domainHash: key.domainHash, activatesAt: BigInt(key.activatesAt), cancelled: key.cancelled },
      merchant: { domainHash: mDomain, maxPerClaim: BigInt(maxPerClaim), maxPerDay: BigInt(maxPerDay), active },
      merchantWindow: { start: BigInt(mwStart), used: BigInt(mwUsed) },
      employee: must<Address>(8),
      registeredAt: BigInt(must<bigint | number>(9)),
      employeeWindow: { start: BigInt(ewStart), used: BigInt(ewUsed) },
      employeeDailyCap: BigInt(must<bigint>(11)),
      fxRateE18: rate.status === "success" ? (rate.result as bigint) : 0n,
      usdcBalance,
    };
  }

  async overview(vault: Address, templateIds: number[]) {
    const c = { address: vault, abi: vaultAbi } as const;
    const [paused, usdc, employeeDailyCap] = await this.client.multicall({
      allowFailure: false,
      contracts: [
        { ...c, functionName: "paused" },
        { ...c, functionName: "usdc" },
        { ...c, functionName: "employeeDailyCap" },
      ],
    });
    const usdcBalance = await this.client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [vault] });
    const ms = await this.client.multicall({
      allowFailure: false,
      contracts: templateIds.map((t) => ({ ...c, functionName: "merchants" as const, args: [BigInt(t)] as const })),
    });
    const merchants: MerchantView[] = ms.map(([domainHash, maxPerClaim, maxPerDay, active], i) => ({
      templateId: templateIds[i]!,
      domainHash: domainHash as Hex,
      maxPerClaim: BigInt(maxPerClaim),
      maxPerDay: BigInt(maxPerDay),
      active,
    }));
    return { paused, usdcBalance, employeeDailyCap: BigInt(employeeDailyCap), merchants };
  }

  async dkimKeys(vault: Address, knownHashes: bigint[], logsFromBlock?: bigint): Promise<DkimKeyView[]> {
    const hashes = new Set(knownHashes);
    if (logsFromBlock !== undefined) {
      const logs = await this.client.getLogs({
        address: vault,
        event: getAbiItem({ abi: vaultAbi, name: "KeyProposed" }),
        fromBlock: logsFromBlock,
        toBlock: "latest",
      });
      for (const l of logs) if (l.args.pubkeyHash !== undefined) hashes.add(l.args.pubkeyHash);
    }
    const list = [...hashes];
    if (!list.length) return [];
    const mc = this.chain.contracts!.multicall3!.address;
    const now = await this.client.readContract({ address: mc, abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" });
    const keys = await this.client.multicall({
      allowFailure: false,
      contracts: list.map((h) => ({ address: vault, abi: vaultAbi, functionName: "dkimKey" as const, args: [h] as const })),
    });
    const out: DkimKeyView[] = [];
    (keys as unknown as { domainHash: Hex; activatesAt: bigint; cancelled: boolean; domain: string; selector: string; modulus: Hex }[]).forEach((k, i) => {
      if (k.domainHash === zeroHash) return;
      const activatesAt = BigInt(k.activatesAt);
      out.push({
        pubkeyHash: `0x${list[i]!.toString(16).padStart(64, "0")}`,
        domainHash: k.domainHash,
        domain: k.domain,
        selector: k.selector,
        modulus: k.modulus,
        bits: ((k.modulus.length - 2) / 2) * 8,
        activatesAt,
        cancelled: k.cancelled,
        active: !k.cancelled && now >= activatesAt,
      });
    });
    return out;
  }
}

function failed(e: unknown, fallback: string): TxResult {
  const d = decodeVaultError(e);
  const err = e as { shortMessage?: string; message?: string };
  return { ok: false, errorName: d.errorName, reason: d.reason, error: (d.errorName ?? err.shortMessage ?? err.message ?? fallback).slice(0, 300) };
}

/** Relayer holds only gas. It cannot change what is paid: the vault checks proof, payee and agent signature. */
export class ViemVaultSettler implements VaultSettler {
  private pub;
  private wallet;
  constructor(rpcUrl: string, chainId: number, relayerKey: Hex, multicall3?: Address) {
    const chain = chainFor(chainId, multicall3);
    const account = privateKeyToAccount(relayerKey);
    this.pub = createPublicClient({ chain, transport: http(rpcUrl) });
    this.wallet = createWalletClient({ chain, transport: http(rpcUrl), account });
  }

  async settle(vault: Address, a: ClaimArgs): Promise<TxResult> {
    try {
      const { request } = await this.pub.simulateContract({
        account: this.wallet.account,
        address: vault,
        abi: vaultAbi,
        functionName: "claim",
        args: [a.pubs as unknown as Pubs9, a.vkHash, a.aggregationId, a.path, a.leafCount, a.index, a.policyHash, a.deadline, a.agentSig],
      });
      return { ok: true, txHash: await this.wallet.writeContract(request) };
    } catch (e) {
      return failed(e, "settle failed");
    }
  }

  async registerFor(vault: Address, toCommit: bigint, wallet: Address): Promise<TxResult> {
    try {
      const { request } = await this.pub.simulateContract({
        account: this.wallet.account,
        address: vault,
        abi: vaultAbi,
        functionName: "registerFor",
        args: [toCommit, wallet],
      });
      return { ok: true, txHash: await this.wallet.writeContract(request) };
    } catch (e) {
      return failed(e, "registerFor failed");
    }
  }

  async receiptStatus(txHash: Hex) {
    try {
      const r = await this.pub.getTransactionReceipt({ hash: txHash });
      return r.status;
    } catch {
      return "pending" as const;
    }
  }
}
