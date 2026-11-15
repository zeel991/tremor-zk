// Generates public CI fixtures signed by the committed TEST-ONLY CI key.
// That key must NEVER be registered in any vault: anyone can sign with it.
import crypto from 'node:crypto'; import fs from 'node:fs'; import path from 'node:path';
import { signEmail, dkimTxt } from './lib/dkim.mjs';

const dir = path.resolve(import.meta.dirname, '../../fixtures/public');
fs.mkdirSync(dir, { recursive: true });
const keyFile = path.join(dir, 'ci_dkim_TEST_ONLY.json');
let pem;
if (fs.existsSync(keyFile)) pem = JSON.parse(fs.readFileSync(keyFile)).privateKeyPem;
else {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 65537 });
  pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(keyFile, JSON.stringify({ WARNING: 'TEST-ONLY CI key. Public. Never register in a vault.', domain: 'ci.receiptproof.invalid', selector: 'ci', privateKeyPem: pem, txt: dkimTxt(pem) }, null, 2));
}
const filler = 'Thanks for your order at the ReceiptProof Test Merchant. This paragraph is padding so the amount lands after the first SHA-256 blocks and the partial-hash path is exercised.\n'.repeat(3);
const mk = (name, to, date, amountLine, extra = '') => {
  const { eml, dkimResult } = signEmail({
    headers: [['From', 'Test Merchant <receipts@ci.receiptproof.invalid>'], ['To', to], ['Subject', 'Your receipt'], ['Date', date], ['Message-ID', `<${name}@ci.receiptproof.invalid>`]],
    body: `Hello,\n\n${filler}\nOrder #RP-${name}\n${amountLine}\nPaid with card ending 4242.\n${extra}\nReceiptProof Test Merchant\n`,
    domain: 'ci.receiptproof.invalid', selector: 'ci', privateKey: pem,
  });
  fs.writeFileSync(path.join(dir, `${name}.eml`), eml);
  return dkimResult;
};
mk('good_inr', 'Alice Example <Alice@Example.com>', 'Sat, 15 Nov 2026 10:12:33 +0530', 'Amount paid: INR 1,249.50');
mk('good_usd', 'bob@example.com', 'Mon, 3 Nov 2026 08:00:00 GMT', 'Amount paid: USD 42.00');
mk('good_int', 'carol@example.org', '14 Nov 2026 23:59:59 -0800', 'Amount paid: INR 300 (incl. taxes)');
mk('bad_date', 'dave@example.org', 'Sat, 15 Nov 26 10:12:33 +0530', 'Amount paid: INR 10.00');
mk('two_dots', 'erin@example.org', 'Sat, 15 Nov 2026 10:12:33 +0000', 'Amount paid: INR 1.2.3');
mk('overflow', 'frank@example.org', 'Sat, 15 Nov 2026 10:12:33 +0000', 'Amount paid: INR 99999999999999');
// 1024-bit CI key: some merchants (e.g. amazon.in keys in the zk-email archive) still use 1024-bit RSA.
const key1024File = path.join(dir, 'ci_dkim_1024_TEST_ONLY.json');
let pem1024;
if (fs.existsSync(key1024File)) pem1024 = JSON.parse(fs.readFileSync(key1024File)).privateKeyPem;
else {
  pem1024 = crypto.generateKeyPairSync('rsa', { modulusLength: 1024, publicExponent: 65537 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(key1024File, JSON.stringify({ WARNING: 'TEST-ONLY CI key. Public. Never register in a vault.', domain: 'ci1024.receiptproof.invalid', selector: 'ci', privateKeyPem: pem1024, txt: dkimTxt(pem1024) }, null, 2));
}
{
  const { eml } = signEmail({
    headers: [['From', 'Test Merchant <receipts@ci1024.receiptproof.invalid>'], ['To', 'gita@example.in'], ['Subject', 'Your receipt'], ['Date', 'Fri, 14 Nov 2026 18:30:00 +0530'], ['Message-ID', '<good_1024@ci1024.receiptproof.invalid>']],
    body: `Hello,\n\n${filler}\nAmount paid: INR 2,999.00\nReceiptProof Test Merchant\n`, domain: 'ci1024.receiptproof.invalid', selector: 'ci', privateKey: pem1024,
  });
  fs.writeFileSync(path.join(dir, 'good_1024.eml'), eml);
}
console.log('fixtures in', dir, fs.readdirSync(dir));
