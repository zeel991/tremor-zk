// Compile a Noir package with noir_wasm (no native nargo needed). Usage: node compile.mjs <pkg> [out]
import { compile_program, createFileManager } from '@noir-lang/noir_wasm';
import fs from 'fs'; import path from 'path';
const root = path.resolve(import.meta.dirname, '..');
const pkg = process.argv[2]; const out = process.argv[3] || path.join(root, 'target', `${pkg}.json`);
const t0 = Date.now();
const fm = createFileManager(root);
const res = await compile_program(fm, path.join(root, pkg), (e) => console.error(e), () => {});
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(res.program));
console.log(`${pkg}: compiled in ${(Date.now() - t0) / 1000}s, noir ${res.program.noir_version}, bytecode ${res.program.bytecode.length} b64 chars -> ${path.relative(root, out)}`);
