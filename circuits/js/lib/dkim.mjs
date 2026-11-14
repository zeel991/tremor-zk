// Minimal DKIM (rsa-sha256, relaxed/relaxed) signer + canonicaliser for test-domain receipts.
// Used for: public CI fixtures (committed CI key, never registered on-chain) and the sandbox
// "sample receipt" signer (secret key, server-side only).
import crypto from 'node:crypto';

export function canonBodyRelaxed(body) {
  let lines = body.replace(/\r?\n/g, '\r\n').split('\r\n');
  lines = lines.map((l) => l.replace(/[ \t]+/g, ' ').replace(/ +$/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.length ? lines.join('\r\n') + '\r\n' : '';
}

export function canonHeaderRelaxed(name, value) {
  return name.toLowerCase().trim() + ':' + value.replace(/\r?\n[ \t]+/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

/**
 * @param {{headers: [string,string][], body: string, domain: string, selector: string, privateKey: crypto.KeyObject|string}} o
 * @returns {{eml: string, dkimResult: object}} raw RFC 5322 message + zkemail-style DKIM result
 */
export function signEmail({ headers, body, domain, selector, privateKey }) {
  const cbody = canonBodyRelaxed(body);
  const bh = crypto.createHash('sha256').update(cbody).digest('base64');
  const signedNames = headers.map(([n]) => n.toLowerCase());
  const dkimValueNoSig = `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain}; s=${selector}; h=${signedNames.join(':')}; bh=${bh}; b=`;
  const canonHeaders = headers.map(([n, v]) => canonHeaderRelaxed(n, v)).join('\r\n') + '\r\n' + canonHeaderRelaxed('DKIM-Signature', dkimValueNoSig);
  const sig = crypto.sign('sha256', Buffer.from(canonHeaders), { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
  const b = sig.toString('base64');
  const raw = [`DKIM-Signature: ${dkimValueNoSig}${b}`, ...headers.map(([n, v]) => `${n}: ${v}`)].join('\r\n') + '\r\n\r\n' + body.replace(/\r?\n/g, '\r\n');
  const pub = crypto.createPublicKey(privateKey);
  const jwk = pub.export({ format: 'jwk' });
  const modulus = BigInt('0x' + Buffer.from(jwk.n, 'base64url').toString('hex'));
  return {
    eml: raw,
    dkimResult: {
      publicKey: modulus,
      signature: BigInt('0x' + sig.toString('hex')),
      headers: Buffer.from(canonHeaders),
      body: Buffer.from(cbody),
      bodyHash: bh,
      signingDomain: domain,
      selector,
      algo: 'rsa-sha256',
      format: 'relaxed/relaxed',
      modulusLength: jwk.n ? Buffer.from(jwk.n, 'base64url').length * 8 : 2048,
    },
  };
}

/** DNS TXT record value for a public key (p= is the SPKI DER, base64). */
export function dkimTxt(privateKey) {
  const der = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return `v=DKIM1; k=rsa; p=${der.toString('base64')}`;
}

/** Parse a raw relaxed/relaxed DKIM email and verify it against `publicKey` (KeyObject/PEM/{n} modulus bigint). */
export function parseAndVerify(eml, publicKey) {
  const raw = Buffer.isBuffer(eml) ? eml.toString('latin1') : eml;
  const sep = raw.indexOf('\r\n\r\n');
  if (sep < 0) throw new Error('no header/body separator');
  const headLines = raw.slice(0, sep).split('\r\n');
  const fields = [];
  for (const l of headLines) { if (/^[ \t]/.test(l) && fields.length) fields[fields.length - 1] += '\r\n' + l; else fields.push(l); }
  const parsed = fields.map((f) => { const i = f.indexOf(':'); return [f.slice(0, i), f.slice(i + 1)]; });
  const dk = parsed.find(([n]) => n.toLowerCase() === 'dkim-signature');
  if (!dk) throw new Error('no DKIM-Signature');
  const tags = Object.fromEntries(dk[1].split(';').map((t) => t.trim()).filter(Boolean).map((t) => { const i = t.indexOf('='); return [t.slice(0, i).trim(), t.slice(i + 1).replace(/\s+/g, '')]; }));
  if (tags.c !== 'relaxed/relaxed' || tags.a !== 'rsa-sha256') throw new Error(`unsupported DKIM c=${tags.c} a=${tags.a}`);
  const used = new Map();
  const canon = [];
  for (const name of tags.h.split(':')) {
    const all = parsed.filter(([n]) => n.toLowerCase() === name.toLowerCase());
    const k = used.get(name) || 0; used.set(name, k + 1);
    const f = all[all.length - 1 - k]; // bottom-up, RFC 6376 5.4.2
    if (f) canon.push(canonHeaderRelaxed(f[0], f[1]));
  }
  const dkNoB = dk[1].replace(/(\bb=)[^;]*/, '$1');
  const canonHeaders = canon.join('\r\n') + '\r\n' + canonHeaderRelaxed(dk[0], dkNoB);
  const body = canonBodyRelaxed(raw.slice(sep + 4));
  const bh = crypto.createHash('sha256').update(body, 'latin1').digest('base64');
  if (bh !== tags.bh) throw new Error('body hash mismatch');
  const key = typeof publicKey === 'bigint'
    ? crypto.createPublicKey({ key: { kty: 'RSA', n: Buffer.from(publicKey.toString(16).padStart(512, '0'), 'hex').toString('base64url'), e: 'AQAB' }, format: 'jwk' })
    : crypto.createPublicKey(publicKey);
  const sig = Buffer.from(tags.b, 'base64');
  if (!crypto.verify('sha256', Buffer.from(canonHeaders, 'latin1'), { key, padding: crypto.constants.RSA_PKCS1_PADDING }, sig)) throw new Error('DKIM signature invalid');
  const jwk = key.export({ format: 'jwk' });
  const nbuf = Buffer.from(jwk.n, 'base64url');
  return {
    publicKey: BigInt('0x' + nbuf.toString('hex')), signature: BigInt('0x' + sig.toString('hex')),
    headers: Buffer.from(canonHeaders, 'latin1'), body: Buffer.from(body, 'latin1'), bodyHash: bh,
    signingDomain: tags.d, selector: tags.s, algo: tags.a, format: tags.c, modulusLength: nbuf.length * 8,
  };
}
