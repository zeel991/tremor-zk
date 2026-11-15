import { parseAbi } from "viem";
import { receiptVaultAbi } from "./receiptVaultAbi.js";

/** The real ReceiptVault ABI, generated from the Foundry artifact (scripts/sync-abi.mjs). */
export const vaultAbi = receiptVaultAbi;

export const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
/** Multicall3 helper, so pre-checks use chain time (block.timestamp) like the contract. */
export const multicall3Abi = parseAbi(["function getCurrentBlockTimestamp() view returns (uint256)"]);
