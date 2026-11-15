import { Buffer } from 'buffer';
// Build circuit inputs for receipt_rsa2048 from a DKIM result (SPEC 5.3, 19.1).
import { generateEmailVerifierInputsFromDKIMResult } from '@zk-email/zkemail-nr';
import { TEMPLATES } from './templates.mjs';

export const MAX_HEADER = 1408;
export const MAX_BODY = 1280;

const LIMB_BITS = 120n;
export function toLimbs(x, bits) {
  const n = Math.ceil(bits / 120); const out = []; const mask = (1n << LIMB_BITS) - 1n;
  for (let i = 0; i < n; i++) { out.push('0x' + (x & mask).toString(16)); x >>= LIMB_BITS; }
  return out;
}
/** bignum >= v0.9 Barrett parameter: floor(2^(2k+6) / n). */
export function redcLimbs(modulus, bits) {
  return toLimbs((1n << BigInt(2 * bits + 6)) / modulus, bits);
}

function headerSequence(headers, name) {
  const s = headers.toString('latin1');
  const re = new RegExp(`(?:^|\\r\\n)(${name}:[^\\r\\n]*)`, 'i');
  const m = re.exec(s);
  if (!m) throw new Error(`header ${name} not found`);
  const index = m.index + (m[0].startsWith('\r\n') ? 2 : 0);
  return { index: String(index), length: String(m[1].length) };
}

function toAddressSequences(headers) {
  const s = headers.toString('latin1');
  const hs = headerSequence(headers, 'to');
  const start = +hs.index, end = start + +hs.length;
  const field = s.slice(start, end);
  const lt = field.lastIndexOf('<');
  let a, b;
  if (lt >= 0) { a = start + lt + 1; b = start + field.indexOf('>', lt); }
  else { a = start + 3; while (s[a] === ' ') a++; b = end; }
  return [hs, { index: String(a), length: String(b - a) }, s.slice(a, b)];
}

/**
 * @param dkimResult zkemail DKIMVerificationResult (publicKey/signature bigint, canonical headers/body)
 * @param o {templateId, salt (hex/dec string), recipient (0x address), vaultId}
 */
export function buildInputs(dkimIn, { templateId, salt, recipient, vaultId }) {
  // accept Uint8Array (browser verifier) or Buffer (node): zkemail-nr calls Buffer methods on these
  const dkimResult = { ...dkimIn, headers: Buffer.from(dkimIn.headers), body: Buffer.from(dkimIn.body) };
  const t = TEMPLATES[templateId];
  if (!t) throw new Error(`unknown template ${templateId}`);
  const bits = dkimResult.modulusLength;
  if (bits !== 2048 && bits !== 1024) throw new Error(`unsupported RSA key size ${bits} (need 1024 or 2048)`);
  const base = generateEmailVerifierInputsFromDKIMResult(dkimResult, {
    maxHeadersLength: MAX_HEADER, maxBodyLength: MAX_BODY, shaPrecomputeSelector: t.anchor,
  });
  if (+base.header.len > MAX_HEADER) throw new Error('header too long for circuit');
  base.pubkey.redc = redcLimbs(dkimResult.publicKey, bits);
  const bodyLen = +base.body.len;
  if (bodyLen > MAX_BODY) throw new Error(`body remainder ${bodyLen} > ${MAX_BODY}`);
  if (base.body.storage.length > MAX_BODY) base.body.storage = base.body.storage.slice(0, MAX_BODY);
  while (base.body.storage.length < MAX_BODY) base.body.storage.push('0');
  const rem = Buffer.from(base.body.storage.slice(0, bodyLen).map(Number));
  const ai = rem.indexOf(Buffer.from(t.anchor, 'latin1'));
  if (ai < 0) throw new Error('anchor not found in hashed body window');
  const amountStart = ai + t.anchor.length;
  let amountLen = 0;
  while (amountStart + amountLen < rem.length && /[0-9.,]/.test(String.fromCharCode(rem[amountStart + amountLen]))) amountLen++;
  const [toHdr, toAddr, toText] = toAddressSequences(dkimResult.headers);
  return {
    inputs: {
      header: base.header, body: base.body, pubkey: base.pubkey, signature: base.signature,
      body_hash_index: base.body_hash_index, dkim_header_sequence: base.dkim_header_sequence,
      partial_body_hash: base.partial_body_hash, partial_body_real_length: base.partial_body_real_length,
      date_sequence: headerSequence(dkimResult.headers, 'date'),
      to_header_sequence: toHdr, to_address_sequence: toAddr,
      template_id: String(templateId), amount_start: String(amountStart), amount_len: String(amountLen),
      salt: String(salt), recipient: BigInt(recipient).toString(), vault_id: String(vaultId),
    },
    circuit: bits === 1024 ? 'receipt_rsa1024' : 'receipt_rsa2048',
    meta: { toAddress: toText, amountText: rem.slice(amountStart, amountStart + amountLen).toString('latin1') },
  };
}
