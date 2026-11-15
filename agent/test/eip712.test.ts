import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentAddress, recoverDecisionSigner, signDecision } from "../src/eip712.js";
import { AGENT_KEY, VAULT_ADDR } from "./helpers.js";

const msg = {
  vaultId: 7n,
  nullifier: 0x1234n,
  amountMinor: 64200n,
  policyHash: ("0x" + "11".repeat(32)) as Hex,
  deadline: 1794470400n,
} as const;

describe("EIP-712 Decision (SPEC §19.4)", () => {
  it("signature recovers to the agent address", async () => {
    const sig = await signDecision(AGENT_KEY, 84532, VAULT_ADDR, msg);
    const signer = await recoverDecisionSigner(84532, VAULT_ADDR, msg, sig);
    expect(signer).toBe(privateKeyToAccount(AGENT_KEY).address);
    expect(agentAddress(AGENT_KEY)).toBe(signer);
  });

  it("is bound to amount, chain and vault", async () => {
    const sig = await signDecision(AGENT_KEY, 84532, VAULT_ADDR, msg);
    const agent = agentAddress(AGENT_KEY);
    expect(await recoverDecisionSigner(84532, VAULT_ADDR, { ...msg, amountMinor: 64201n }, sig)).not.toBe(agent);
    expect(await recoverDecisionSigner(8453, VAULT_ADDR, msg, sig)).not.toBe(agent);
    expect(await recoverDecisionSigner(84532, getAddress("0x3333333333333333333333333333333333333333"), msg, sig)).not.toBe(agent);
  });
});
