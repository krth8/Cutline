// Bundles web/dev/store_entry.tsx into <outdir>/store.js (+ store.css). Usage: node dev/build_store_demo.mjs <outdir>
import { build } from 'esbuild';

const outdir = process.argv[2];
if (!outdir) throw new Error('usage: node dev/build_store_demo.mjs <outdir>');

await build({
  entryPoints: { store: 'dev/store_entry.tsx' },
  outdir,
  bundle: true,
  format: 'iife',
  target: ['chrome100'],
  jsx: 'automatic',
  sourcemap: false,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"development"' },
});
