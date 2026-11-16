import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import path from 'node:path';

// COOP/COEP give bb.js SharedArrayBuffer (multithreaded proving).
const isolation = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };

export default defineConfig({
  plugins: [react(), tailwindcss(), nodePolyfills({ include: ['buffer', 'process', 'util', 'stream', 'events', 'crypto'] })],
  resolve: { alias: { '@rp': path.resolve(import.meta.dirname, 'src/rp') } },
  server: { port: 5181, headers: isolation },
  preview: { port: 5181, headers: isolation },
  optimizeDeps: { exclude: ['@aztec/bb.js', '@noir-lang/noirc_abi', '@noir-lang/acvm_js'] },
  build: { target: 'esnext' },
  worker: { format: 'es' },
});
