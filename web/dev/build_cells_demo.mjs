// Bundles web/dev/cells_entry.tsx into <outdir>/cells.js (+ cells.css). Usage: node dev/build_cells_demo.mjs <outdir>
import { build } from 'esbuild';

const outdir = process.argv[2];
if (!outdir) throw new Error('usage: node dev/build_cells_demo.mjs <outdir>');

await build({
  entryPoints: { cells: 'dev/cells_entry.tsx' },
  outdir,
  bundle: true,
  format: 'iife',
  target: ['chrome100'],
  jsx: 'automatic',
  sourcemap: false,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"development"' },
});
