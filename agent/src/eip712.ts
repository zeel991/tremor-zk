import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** SPEC §19.4. */
export const DECISION_TYPES = {
  Decision: [
    { name: "vaultId", type: "uint256" },
    { name: "nullifier", type: "uint256" },
    { name: "amountMinor", type: "uint256" },
    { name: "policyHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

export interface DecisionMessage {
  vaultId: bigint;
  nullifier: bigint;
  amountMinor: bigint;
  policyHash: Hex;
  deadline: bigint;
}

export function decisionDomain(chainId: number, vault: Address) {
  return { name: "ReceiptVault", version: "1", chainId, verifyingContract: vault } as const;
}

/** Signs an APPROVE decision. The agent never signs anything else (SPEC §19.4). */
export async function signDecision(agentKey: Hex, chainId: number, vault: Address, msg: DecisionMessage): Promise<Hex> {
  const account = privateKeyToAccount(agentKey);
  return account.signTypedData({
    domain: decisionDomain(chainId, vault),
    types: DECISION_TYPES,
    primaryType: "Decision",
    message: msg,
  });
}

export async function recoverDecisionSigner(chainId: number, vault: Address, msg: DecisionMessage, signature: Hex): Promise<Address> {
  return recoverTypedDataAddress({
    domain: decisionDomain(chainId, vault),
    types: DECISION_TYPES,
    primaryType: "Decision",
    message: msg,
    signature,
  });
}

export function agentAddress(agentKey: Hex): Address {
  return privateKeyToAccount(agentKey).address;
}
