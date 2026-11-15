// DKIM key resolution. The proof is only as good as "this modulus belongs to this domain", so we
// show every source we checked: live DNS (DNS-over-HTTPS), the zk-email key archive, and the vault's
// on-chain key list (the vault owner's timelocked list is what actually decides payouts, SPEC 7.2).
import { modulusFromTxt, modulusFromSpkiDer } from '@rp/dkim-verify.mjs';
import { CONFIG } from './config.js';

async function dns(domain, selector) {
  const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(`${selector}._domainkey.${domain}`)}&type=TXT`, { headers: { accept: 'application/dns-json' } });
  const j = await r.json();
  const txt = (j.Answer || []).filter((a) => a.type === 16).map((a) => a.data.replace(/"\s*"/g, '').replace(/"/g, '')).join('');
  return txt ? modulusFromTxt(txt) : null;
}
async function archive(domain, selector) {
  const r = await fetch(`https://archive.zk.email/api/key?domain=${encodeURIComponent(domain)}`);
  if (!r.ok) return null;
  const rows = await r.json();
  const row = (Array.isArray(rows) ? rows : []).filter((x) => x.selector === selector).sort((a, b) => String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')))[0];
  return row?.value ? modulusFromTxt(row.value) : null;
}
async function vault(domain, selector) {
  const r = await fetch(`${CONFIG.agentUrl}/api/vault/${CONFIG.vaultId}`);
  if (!r.ok) return null;
  const v = await r.json();
  // only keys the vault would accept right now: past the 24 h timelock and not cancelled
  const k = (v.dkimKeys || []).find((x) => x.domain === domain && x.selector === selector && x.modulus && x.active && !x.cancelled);
  if (!k) return null;
  const hex = k.modulus.replace(/^0x/, '');
  return BigInt('0x' + hex);
}

/** @returns {{modulus: bigint|null, sources: {name, status, modulus}[]}} */
export async function resolveKey(domain, selector) {
  const tries = [['On-chain vault list', vault], ['DNS (DNS-over-HTTPS)', dns], ['zk-email key archive', archive]];
  const sources = await Promise.all(tries.map(async ([name, fn]) => {
    try { const m = await fn(domain, selector); return { name, status: m ? 'found' : 'none', modulus: m }; }
    catch (e) { return { name, status: 'error', error: String(e.message || e), modulus: null }; }
  }));
  const found = sources.filter((s) => s.modulus);
  const distinct = new Set(found.map((s) => s.modulus.toString(16)));
  const onchain = sources[0].modulus;
  return { modulus: onchain ?? found[0]?.modulus ?? null, agree: distinct.size <= 1, sources };
}
export { modulusFromSpkiDer };
