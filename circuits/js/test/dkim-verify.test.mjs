import test from 'node:test'; import assert from 'node:assert'; import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
import { parseEmail, verifyWithModulus, modulusFromTxt } from '../lib/dkim-verify.mjs';
import { FIX, CI_KEY, dkim } from './helpers.mjs';
const ci = JSON.parse(fs.readFileSync(path.join(FIX, 'ci_dkim_TEST_ONLY.json')));
test('browser verifier agrees with node verifier on all good fixtures', () => {
  const n = modulusFromTxt(ci.txt);
  for (const f of ['good_inr', 'good_usd', 'good_int']) {
    const p = parseEmail(fs.readFileSync(path.join(FIX, `${f}.eml`), 'latin1'));
    const r = verifyWithModulus(p, p.sigs[0], n);
    const ref = dkim(f);
    assert.equal(r.publicKey, ref.publicKey); assert.equal(r.signature, ref.signature);
    assert.deepEqual(Buffer.from(r.headers), ref.headers); assert.deepEqual(Buffer.from(r.body), ref.body);
  }
});
test('browser verifier rejects tampered body and wrong key', () => {
  const n = modulusFromTxt(ci.txt);
  const raw = fs.readFileSync(path.join(FIX, 'good_inr.eml'), 'latin1');
  const p = parseEmail(raw.replace('1,249.50', '9,249.50'));
  assert.throws(() => verifyWithModulus(p, p.sigs[0], n), /Body hash/);
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = BigInt('0x' + Buffer.from(publicKey.export({ format: 'jwk' }).n, 'base64url').toString('hex'));
  const p2 = parseEmail(raw);
  assert.throws(() => verifyWithModulus(p2, p2.sigs[0], other), /does not verify/);
});
test('LF-only .eml (as saved by some clients) still verifies', () => {
  const n = modulusFromTxt(ci.txt);
  const raw = fs.readFileSync(path.join(FIX, 'good_usd.eml'), 'latin1').replace(/\r\n/g, '\n');
  const p = parseEmail(raw); assert.ok(verifyWithModulus(p, p.sigs[0], n));
});
test('browser path end to end: Uint8Array verifier output -> buildInputs -> circuit', async () => {
  const { buildInputs } = await import('../lib/inputs.mjs');
  const { run, SALT, RECIPIENT } = await import('./helpers.mjs');
  const n = modulusFromTxt(ci.txt);
  const p = parseEmail(new Uint8Array(fs.readFileSync(path.join(FIX, 'good_inr.eml'))));
  const r = verifyWithModulus(p, p.sigs[0], n);
  assert.ok(r.headers instanceof Uint8Array && !Buffer.isBuffer(r.headers));
  const out = await run(buildInputs(r, { templateId: 100, salt: SALT, recipient: RECIPIENT, vaultId: 0 }).inputs);
  assert.equal(out[3], 124950n);
});
