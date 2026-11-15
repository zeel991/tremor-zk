import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, encodeFunctionData, getAbiItem, type Abi, type Hex } from "viem";
import { vaultAbi } from "../src/chain/abi.js";
import { decodeRevertData, decodeVaultError, VAULT_ERROR_REASON } from "../src/chain/errors.js";
import { EMPLOYEE, goodPubs, VK_HASH } from "./helpers.js";
import { pubsToArray } from "../src/types.js";

const ARTIFACT = new URL("../../contracts/out/ReceiptVault.sol/ReceiptVault.json", import.meta.url).pathname;

function dummyArgs(inputs: readonly { type: string }[]): unknown[] {
  return inputs.map((i) => (i.type === "address" ? EMPLOYEE : i.type === "bytes32" ? VK_HASH : i.type === "bool" ? true : i.type.startsWith("uint") ? 7n : "0x"));
}

describe("ReceiptVault ABI (generated from contracts/out)", () => {
  it.skipIf(process.env.RP_SKIP_CROSS === "1")("matches the current Foundry artifact (run scripts/sync-abi.mjs after forge build)", () => {
    expect(existsSync(ARTIFACT), `missing ${ARTIFACT}: run forge build in contracts/`).toBe(true);
    const abi = JSON.parse(readFileSync(ARTIFACT, "utf8")).abi;
    expect(JSON.parse(JSON.stringify(vaultAbi))).toEqual(abi);
  });

  it("claim() takes policyHash and deadline before agentSig", () => {
    const item = getAbiItem({ abi: vaultAbi as Abi, name: "claim" }) as unknown as { inputs: readonly { name: string }[] };
    expect(item.inputs.map((i) => i.name)).toEqual(["pubs", "vkHash", "aggregationId", "path", "leafCount", "index", "policyHash", "deadline", "agentSig"]);
    const data = encodeFunctionData({
      abi: vaultAbi,
      functionName: "claim",
      args: [pubsToArray(goodPubs()), VK_HASH, 1n, [VK_HASH], 2n, 0n, VK_HASH, 123n, "0x1234"],
    });
    expect(data.startsWith("0x")).toBe(true);
  });

  it("every mapped error exists in the ABI, and every claim-path error is mapped", () => {
    const errors = (vaultAbi as Abi).filter((x) => x.type === "error").map((x) => (x as { name: string }).name);
    for (const name of Object.keys(VAULT_ERROR_REASON)) expect(errors).toContain(name);
    const claimPath = ["VkNotAccepted", "WrongVault", "NullifierSpent", "UnknownKey", "KeyNotYetActive", "MerchantInactive", "KeyDomainMismatch",
      "EmployeeNotRegistered", "WrongPayee", "ReceiptExpired", "ReceiptInFuture", "ReceiptBeforeRegistration", "ExceedsPerClaimCap",
      "ExceedsMerchantDailyCap", "NoRate", "ZeroPayout", "ExceedsEmployeeDailyCap", "ProofNotAggregated", "DecisionExpired", "BadAgentSignature",
      "InsufficientVaultBalance", "EnforcedPause"];
    for (const name of claimPath) expect(Object.keys(VAULT_ERROR_REASON)).toContain(name);
  });

  it.each(Object.entries(VAULT_ERROR_REASON))("decodes revert data for %s → %s", (name, reason) => {
    const item = getAbiItem({ abi: vaultAbi as Abi, name }) as unknown as { inputs: readonly { type: string }[] };
    const data = encodeErrorResult({ abi: vaultAbi, errorName: name as never, args: dummyArgs(item.inputs) as never });
    expect(decodeRevertData(data)).toMatchObject({ errorName: name, reason });
  });

  it("decodes the error out of a viem simulate failure; unknown data → null", () => {
    const data = encodeErrorResult({ abi: vaultAbi, errorName: "WrongPayee", args: [EMPLOYEE, 5n] });
    const cause = new ContractFunctionRevertedError({ abi: vaultAbi as Abi, data, functionName: "claim" });
    const err = new ContractFunctionExecutionError(cause, { abi: vaultAbi as Abi, functionName: "registerFor", args: [1n, EMPLOYEE], contractAddress: EMPLOYEE });
    expect(decodeVaultError(err)).toMatchObject({ errorName: "WrongPayee", reason: "PAYEE_MISMATCH" });
    expect(decodeRevertData("0xdeadbeef" as Hex)).toEqual({ errorName: null, reason: null });
    expect(decodeVaultError(new Error("rpc down"))).toEqual({ errorName: null, reason: null });
  });
});
