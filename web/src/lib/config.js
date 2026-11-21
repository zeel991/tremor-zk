// Runtime config: /config.json (deploy-time), falling back to local dev defaults.
const DEFAULTS = {
  agentUrl: import.meta.env.VITE_AGENT_URL || 'http://localhost:8787',
  network: 'Base Sepolia (zkVerify Volta)',
  chainId: 84532,
  rpcUrl: 'https://base-sepolia-rpc.publicnode.com',
  explorer: 'https://base-sepolia.blockscout.com',
  usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  zkvExplorer: 'https://zkverify-testnet.subscan.io',
  vaultId: 0,
  vaultAddress: null,
  zkvAggregation: '0x0807C544D38aE7729f8798388d89Be6502A1e8A8',
  domainId: 2,
  versionHash: '0x91ea9b035e570dfe3d6b0dff19fb13586dfdd5a9da15c14f49f7ce6b3b2bc589',
};
export let CONFIG = DEFAULTS;
export async function loadConfig() {
  try { const r = await fetch('/config.json', { cache: 'no-store' }); if (r.ok) CONFIG = { ...DEFAULTS, ...(await r.json()) }; } catch {}
  return CONFIG;
}
