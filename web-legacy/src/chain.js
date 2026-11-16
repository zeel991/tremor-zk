import { createPublicClient, http, decodeFunctionData, encodePacked, keccak256, toHex, formatUnits } from 'viem';
import { CONFIG } from './config.js';

export const VAULT_ABI = [
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [
    { name: 'pubs', type: 'uint256[9]' }, { name: 'vkHash', type: 'bytes32' }, { name: 'aggregationId', type: 'uint256' },
    { name: 'path', type: 'bytes32[]' }, { name: 'leafCount', type: 'uint256' }, { name: 'index', type: 'uint256' },
    { name: 'policyHash', type: 'bytes32' }, { name: 'deadline', type: 'uint64' }, { name: 'agentSig', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'versionHash', stateMutability: 'view', inputs: [], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'domainId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'zkv', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'acceptedVk', stateMutability: 'view', inputs: [{ type: 'bytes32' }], outputs: [{ type: 'bool' }] },
];
export const ZKV_ABI = [{ type: 'function', name: 'verifyProofAggregation', stateMutability: 'view', inputs: [
  { name: '_domainId', type: 'uint256' }, { name: '_aggregationId', type: 'uint256' }, { name: '_leaf', type: 'bytes32' },
  { name: '_merklePath', type: 'bytes32[]' }, { name: '_leafCount', type: 'uint256' }, { name: '_index', type: 'uint256' }], outputs: [{ type: 'bool' }] }];

export const client = () => createPublicClient({ transport: http(CONFIG.rpcUrl) });

/** SPEC 19.1 leaf, computed here independently of the agent and the contract. */
export function statementLeaf(pubs, vkHash, versionHash) {
  const pubsHash = keccak256(encodePacked(['uint256[9]'], [pubs.map(BigInt)]));
  return keccak256(encodePacked(['bytes32', 'bytes32', 'bytes32', 'bytes32'], [keccak256(toHex('ultrahonk')), vkHash, versionHash, pubsHash]));
}

/** Re-verify a payout from its Base transaction alone. Returns a list of explained steps. */
export async function verifyPayout(txHash) {
  const c = client(); const steps = [];
  const tx = await c.getTransaction({ hash: txHash });
  const { functionName, args } = decodeFunctionData({ abi: VAULT_ABI, data: tx.input });
  if (functionName !== 'claim') throw new Error('Not a ReceiptVault.claim transaction');
  const [pubs, vkHash, aggregationId, path, leafCount, index] = args;
  steps.push({ ok: true, title: 'Decoded the claim', detail: `vault ${tx.to}, ${pubs.length} public inputs, aggregation #${aggregationId}` });
  const receipt = await c.getTransactionReceipt({ hash: txHash });
  steps.push({ ok: receipt.status === 'success', title: 'Transaction succeeded on Base', detail: `block ${receipt.blockNumber}` });
  const [versionHash, domainId, zkv, accepted] = await Promise.all(['versionHash', 'domainId', 'zkv'].map((f) => c.readContract({ address: tx.to, abi: VAULT_ABI, functionName: f })).concat([c.readContract({ address: tx.to, abi: VAULT_ABI, functionName: 'acceptedVk', args: [vkHash] })]));
  steps.push({ ok: versionHash.toLowerCase() === CONFIG.versionHash, title: 'Vault expects zkVerify UltraHonk V5_0 (the sound ZK flavour)', detail: versionHash });
  steps.push({ ok: accepted, title: 'Proof was made with the ReceiptProof circuit key', detail: `vkHash ${vkHash}` });
  const leaf = statementLeaf(pubs, vkHash, versionHash);
  steps.push({ ok: true, title: 'Recomputed the zkVerify statement in your browser', detail: leaf });
  const included = await c.readContract({ address: zkv, abi: ZKV_ABI, functionName: 'verifyProofAggregation', args: [domainId, aggregationId, leaf, path, leafCount, index] });
  steps.push({ ok: included, title: 'zkVerify attests this exact statement was verified', detail: `aggregation contract ${zkv}, domain ${domainId}` });
  return { steps, pubs: pubs.map(String), ok: steps.every((s) => s.ok) };
}
export { formatUnits };
