import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'node:path';
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
export default {
  plugins: [nodePolyfills({ include: ['buffer', 'process', 'util', 'stream', 'events', 'crypto'] })],
  resolve: { alias: { '@rp': path.resolve(import.meta.dirname, 'src/rp') } },
  server: { port: 5180, headers: isolation, fs: { allow: ['..'] } },
  preview: { port: 5180, headers: isolation },
  optimizeDeps: { exclude: ['@aztec/bb.js', '@noir-lang/noirc_abi', '@noir-lang/acvm_js'] },
  build: { target: 'esnext' },
  worker: { format: 'es' },
};
