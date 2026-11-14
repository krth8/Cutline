// Bundles src/index.ts into ../static/dist/pages.js (+ pages.css for imported styles).
import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/index.ts'],
  outfile: '../static/dist/pages.js',
  bundle: true,
  format: 'iife',
  target: ['es2020', 'chrome100', 'firefox100', 'safari15'],
  jsx: 'automatic',
  minify: !watch,
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('Watching web/src ... (Ctrl+C to stop)');
} else {
  await build(options);
}
