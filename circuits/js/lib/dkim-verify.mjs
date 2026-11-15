// Isomorphic (browser + node) DKIM parse + verify for rsa-sha256 relaxed/relaxed.
// No node:crypto: SHA-256 from @noble/hashes, RSA via BigInt modexp + PKCS#1 v1.5 DigestInfo check.
import { sha256 } from '@noble/hashes/sha2.js';
import { canonBodyRelaxed, canonHeaderRelaxed } from './canon.mjs';

const enc = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff); // latin1
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (u8) => btoa(String.fromCharCode(...u8));
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
function modpow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }
const DIGESTINFO = '3031300d060960864801650304020105000420';

export function parseEmail(eml) {
  const raw = typeof eml === 'string' ? eml : Array.from(eml, (b) => String.fromCharCode(b)).join('');
  const norm = raw.includes('\r\n') ? raw : raw.replace(/\n/g, '\r\n');
  const sep = norm.indexOf('\r\n\r\n');
  if (sep < 0) throw new Error('Not an email: no header/body separator');
  const fields = [];
  for (const l of norm.slice(0, sep).split('\r\n')) { if (/^[ \t]/.test(l) && fields.length) fields[fields.length - 1] += '\r\n' + l; else fields.push(l); }
  const headers = fields.map((f) => { const i = f.indexOf(':'); return [f.slice(0, i), f.slice(i + 1)]; });
  const sigs = headers.filter(([n]) => n.toLowerCase() === 'dkim-signature').map(([n, v]) => {
    const tags = Object.fromEntries(v.split(';').map((t) => t.trim()).filter(Boolean).map((t) => { const i = t.indexOf('='); return [t.slice(0, i).trim(), t.slice(i + 1).replace(/\s+/g, '')]; }));
    return { name: n, value: v, tags };
  });
  return { raw: norm, headers, body: norm.slice(sep + 4), sigs };
}

/** Canonicalise for one DKIM-Signature. Returns the exact bytes the circuit sees. */
export function canonicalise(parsed, sig) {
  const { tags } = sig;
  if (tags.a !== 'rsa-sha256') throw new Error(`Unsupported DKIM algorithm ${tags.a}`);
  if ((tags.c || 'simple/simple') !== 'relaxed/relaxed') throw new Error(`Unsupported canonicalisation ${tags.c} (need relaxed/relaxed)`);
  const used = new Map(); const canon = [];
  for (const name of tags.h.split(':')) {
    const all = parsed.headers.filter(([n]) => n.toLowerCase() === name.toLowerCase().trim());
    const k = used.get(name) || 0; used.set(name, k + 1);
    const f = all[all.length - 1 - k];
    if (f) canon.push(canonHeaderRelaxed(f[0], f[1]));
  }
  const headerStr = canon.join('\r\n') + '\r\n' + canonHeaderRelaxed(sig.name, sig.value.replace(/(\bb=)[^;]*/, '$1'));
  const bodyStr = canonBodyRelaxed(parsed.body);
  return { headerBytes: enc(headerStr), bodyBytes: enc(bodyStr) };
}

/** Verify with a modulus (bigint). Returns a zkemail DKIMVerificationResult-shaped object. */
export function verifyWithModulus(parsed, sig, modulus) {
  const { headerBytes, bodyBytes } = canonicalise(parsed, sig);
  const bh = toB64(sha256(bodyBytes));
  if (bh !== sig.tags.bh) throw new Error('Body hash mismatch: the email body was modified');
  const sBytes = b64(sig.tags.b); const s = BigInt('0x' + hex(sBytes));
  if (s >= modulus) throw new Error('Signature out of range');
  const k = Math.ceil(modulus.toString(16).length / 2);
  const em = modpow(s, 65537n, modulus).toString(16).padStart(k * 2, '0');
  const want = '0001' + 'ff'.repeat(k - 3 - 19 - 32) + '00' + DIGESTINFO + hex(sha256(headerBytes));
  if (em !== want) throw new Error('DKIM signature does not verify with this key');
  return {
    publicKey: modulus, signature: s, headers: headerBytes, body: bodyBytes, bodyHash: bh,
    signingDomain: sig.tags.d, selector: sig.tags.s, algo: sig.tags.a, format: sig.tags.c, modulusLength: k * 8,
  };
}

/** Parse "p=" from a DKIM TXT record into a modulus (SPKI DER, RSA). */
export function modulusFromTxt(txt) {
  const p = /p=([^;]+)/.exec(txt.replace(/["\s]/g, ''))?.[1];
  if (!p) throw new Error('no p= in DKIM record');
  return modulusFromSpkiDer(b64(p));
}
export function modulusFromSpkiDer(der) {
  // walk DER: SEQ{ SEQ{alg}, BITSTRING{ SEQ{ INT n, INT e } } }  (also accepts bare RSAPublicKey)
  let i = 0;
  const len = () => { let l = der[i++]; if (l & 0x80) { const n = l & 0x7f; l = 0; for (let j = 0; j < n; j++) l = (l << 8) | der[i++]; } return l; };
  const ints = [];
  const walk = (end) => {
    while (i < end) {
      const tag = der[i++]; const l = len(); const start = i;
      if (tag === 0x30) walk(start + l);
      else if (tag === 0x03) { i++; walk(start + l); }
      else if (tag === 0x02) { ints.push(der.slice(start, start + l)); i = start + l; }
      else i = start + l;
      i = start + l;
    }
  };
  walk(der.length);
  const n = ints.find((x) => x.length >= 128);
  if (!n) throw new Error('RSA modulus not found');
  return BigInt('0x' + hex(n));
}
