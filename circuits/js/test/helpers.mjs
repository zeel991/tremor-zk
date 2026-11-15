import fs from 'node:fs'; import path from 'node:path';
import { Noir } from '@noir-lang/noir_js';
import { parseAndVerify } from '../lib/dkim.mjs';
import { buildInputs } from '../lib/inputs.mjs';
const root = path.resolve(import.meta.dirname, '../..');
export const FIX = path.resolve(root, '../fixtures/public');
const ci = JSON.parse(fs.readFileSync(path.join(FIX, 'ci_dkim_TEST_ONLY.json')));
export const CI_KEY = ci.privateKeyPem;
let _receipt, _commit, _r1024;
export const receipt1024 = () => (_r1024 ??= new Noir(JSON.parse(fs.readFileSync(path.join(root, 'target/receipt_rsa1024.json')))));
export const CI_KEY_1024 = JSON.parse(fs.readFileSync(path.join(FIX, 'ci_dkim_1024_TEST_ONLY.json'))).privateKeyPem;
export const receipt = () => (_receipt ??= new Noir(JSON.parse(fs.readFileSync(path.join(root, 'target/receipt_rsa2048.json')))));
export const commit = () => (_commit ??= new Noir(JSON.parse(fs.readFileSync(path.join(root, 'target/commit.json')))));
export const dkim = (name) => parseAndVerify(fs.readFileSync(path.join(FIX, `${name}.eml`)), CI_KEY);
export const SALT = '0x1234567890abcdef1234567890abcdef';
export const RECIPIENT = '0x00000000000000000000000000000000000000aa';
export const inputsFor = (name, templateId = 100, extra = {}) => buildInputs(dkim(name), { templateId, salt: SALT, recipient: RECIPIENT, vaultId: 0, ...extra });
export async function run(inputs) { const { returnValue } = await receipt().execute(inputs); return returnValue.map((x) => BigInt(x)); }
export async function fails(inputs, re) {
  try { await receipt().execute(inputs); } catch (e) { if (re && !re.test(String(e.message || e))) throw new Error(`failed with unexpected error: ${e.message}`); return String(e.message); }
  throw new Error('expected circuit to fail but it passed');
}
