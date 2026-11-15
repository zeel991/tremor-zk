// Circuit behaviour + attack tests (SPEC 5.6). Each case executes the real compiled circuit.
import test from 'node:test'; import assert from 'node:assert'; import crypto from 'node:crypto';
import { inputsFor, run, fails, commit, dkim, SALT, RECIPIENT } from './helpers.mjs';
import { buildInputs, redcLimbs, toLimbs } from '../lib/inputs.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));
const fromLimbs = (l) => l.reduce((acc, v, i) => acc + (BigInt(v) << BigInt(120 * i)), 0n);

test('happy path INR: amount, currency, UTC date, outputs order', async () => {
  const { inputs } = inputsFor('good_inr');
  const out = await run(inputs);
  assert.equal(out.length, 9);
  assert.equal(out[2], 100n); assert.equal(out[3], 124950n); assert.equal(out[4], 356n);
  assert.equal(out[5], BigInt(Date.parse('2026-11-15T10:12:33+05:30') / 1000));
  assert.equal(out[7], BigInt(RECIPIENT)); assert.equal(out[8], 0n);
});
test('happy path USD with GMT zone and no display name', async () => {
  const out = await run(inputsFor('good_usd', 101).inputs);
  assert.equal(out[3], 4200n); assert.equal(out[4], 840n);
  assert.equal(out[5], BigInt(Date.parse('2026-11-03T08:00:00Z') / 1000));
});
test('integer amount, no weekday, negative zone', async () => {
  const out = await run(inputsFor('good_int').inputs);
  assert.equal(out[3], 30000n);
  assert.equal(out[5], BigInt(Date.parse('2026-11-14T23:59:59-08:00') / 1000));
});
test('to_commit equals the standalone commit circuit (case-insensitive)', async () => {
  const out = await run(inputsFor('good_inr').inputs);
  const addr = Array.from(Buffer.from('alice@example.com')).map(String);
  while (addr.length < 124) addr.push('0');
  const { returnValue } = await commit().execute({ addr: { storage: addr, len: '17' }, salt: SALT });
  assert.equal(BigInt(returnValue), out[6]);
});
test('nullifier and to_commit change with salt; nullifier stable per email+salt', async () => {
  const a = await run(inputsFor('good_inr').inputs);
  const b = await run(inputsFor('good_inr').inputs);
  const c = await run(inputsFor('good_inr', 100, { salt: '0x99' }).inputs);
  assert.equal(a[1], b[1]); assert.notEqual(a[1], c[1]); assert.notEqual(a[6], c[6]);
  assert.equal(a[0], c[0]);
});
test('recipient and vault are bound into public outputs', async () => {
  const o = await run(inputsFor('good_inr', 100, { recipient: '0x00000000000000000000000000000000000000bb', vaultId: 7 }).inputs);
  assert.equal(o[7], 0xbbn); assert.equal(o[8], 7n);
});

// ---- attacks ----
test('ATTACK flipped body byte -> body hash mismatch', async () => {
  const { inputs } = inputsFor('good_inr'); const i = clone(inputs);
  i.body.storage[5] = String((+i.body.storage[5] + 1) % 256);
  await fails(i);
});
test('ATTACK edited amount digit -> body hash mismatch', async () => {
  const { inputs } = inputsFor('good_inr'); const i = clone(inputs);
  i.body.storage[+i.amount_start] = '9';
  await fails(i);
});
test('ATTACK wrong DKIM key (attacker key presented as merchant key)', async () => {
  const { inputs } = inputsFor('good_inr'); const i = clone(inputs);
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const n = BigInt('0x' + Buffer.from(publicKey.export({ format: 'jwk' }).n, 'base64url').toString('hex'));
  i.pubkey.modulus = toLimbs(n, 2048); i.pubkey.redc = redcLimbs(n, 2048);
  await fails(i);
});
test('ATTACK email signed by attacker key: proves, but pubkey_hash differs (vault rejects unknown key)', async () => {
  const good = await run(inputsFor('good_inr').inputs);
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const { signEmail } = await import('../lib/dkim.mjs');
  const { dkimResult } = signEmail({ headers: [['From', 'x@ci.receiptproof.invalid'], ['To', 'alice@example.com'], ['Date', 'Sat, 15 Nov 2026 10:12:33 +0530']],
    body: 'Amount paid: INR 99999.00\n', domain: 'ci.receiptproof.invalid', selector: 'ci', privateKey });
  const forged = await run(buildInputs(dkimResult, { templateId: 100, salt: SALT, recipient: RECIPIENT, vaultId: 0 }).inputs);
  assert.notEqual(forged[0], good[0]);
});
test('ATTACK To header swapped -> DKIM signature fails', async () => {
  const { inputs } = inputsFor('good_inr'); const i = clone(inputs);
  const at = +i.to_address_sequence.index; i.header.storage[at] = String('m'.charCodeAt(0));
  await fails(i);
});
test('ATTACK amount pointer moved off the anchor -> anchor mismatch', async () => {
  const { inputs } = inputsFor('good_inr'); const i = clone(inputs);
  i.amount_start = String(+i.amount_start + 2); i.amount_len = '3';
  await fails(i, /anchor mismatch|not terminated|start with a digit/);
});
test('ATTACK amount truncated (claim 1,249.5 / 1,249) -> not terminated', async () => {
  const { inputs } = inputsFor('good_inr'); const i = clone(inputs);
  i.amount_len = String(+i.amount_len - 1); await fails(i);
  i.amount_len = String(+i.amount_len - 2); await fails(i);
});
test('ATTACK amount extended into trailing bytes -> bad character', async () => {
  const { inputs } = inputsFor('good_inr'); const i = clone(inputs);
  i.amount_len = String(+i.amount_len + 1); await fails(i, /bad character/);
});
test('ATTACK USD template on an INR receipt -> anchor mismatch', async () => {
  const { inputs } = inputsFor('good_inr'); const i = clone(inputs);
  i.template_id = '101'; await fails(i, /anchor mismatch/);
});
test('ATTACK unknown template id', async () => {
  const { inputs } = inputsFor('good_inr'); const i = clone(inputs);
  i.template_id = '7'; await fails(i, /unknown template/);
});
test('ATTACK signature malleability s+n -> rejected', async () => {
  const { inputs } = inputsFor('good_inr'); const i = clone(inputs);
  const n = fromLimbs(i.pubkey.modulus), s = fromLimbs(i.signature);
  i.signature = toLimbs(s + n, 2048).slice(0, 18);
  await fails(i);
});
test('ATTACK date_sequence pointed at another header -> field name check', async () => {
  const { inputs } = inputsFor('good_inr'); const i = clone(inputs);
  i.date_sequence = { ...i.to_header_sequence }; await fails(i);
});
test('ATTACK partial SHA state tampered -> body hash mismatch', async () => {
  const { inputs } = inputsFor('good_inr'); const i = clone(inputs);
  i.partial_body_hash[0] = String((+i.partial_body_hash[0] + 1) >>> 0); await fails(i);
});
test('malformed date (2-digit year) rejected', async () => { await fails(inputsFor('bad_date').inputs, /date/); });
test('two decimal points rejected', async () => {
  const { inputs } = inputsFor('two_dots'); const i = clone(inputs); i.amount_len = '5'; await fails(i, /two decimal points/);
});
test('amount overflow rejected', async () => { await fails(inputsFor('overflow').inputs, /too large/); });
test('fixtures verify with an independent DKIM check (node crypto)', () => {
  for (const f of ['good_inr', 'good_usd', 'good_int']) assert.equal(dkim(f).modulusLength, 2048);
});

test('1024-bit variant: proves amount; pubkey_hash differs from 2048 key', async () => {
  const { receipt1024, CI_KEY_1024 } = await import('./helpers.mjs');
  const { parseAndVerify } = await import('../lib/dkim.mjs');
  const fs = await import('node:fs'); const path = await import('node:path');
  const { FIX } = await import('./helpers.mjs');
  const d = parseAndVerify(fs.readFileSync(path.join(FIX, 'good_1024.eml')), CI_KEY_1024);
  assert.equal(d.modulusLength, 1024);
  const b = buildInputs(d, { templateId: 100, salt: SALT, recipient: RECIPIENT, vaultId: 0 });
  assert.equal(b.circuit, 'receipt_rsa1024');
  const { returnValue } = await receipt1024().execute(b.inputs);
  const out = returnValue.map(BigInt);
  assert.equal(out[3], 299900n); assert.equal(out[5], BigInt(Date.parse('2026-11-14T18:30:00+05:30') / 1000));
  const i = JSON.parse(JSON.stringify(b.inputs)); i.body.storage[+i.amount_start] = '8';
  await assert.rejects(receipt1024().execute(i));
});
