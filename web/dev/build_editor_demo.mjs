// Bundles the editor demo for the browser check into ../static/dist/editor-demo/ (git-ignored).
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';

const out = '../static/dist/editor-demo';
mkdirSync(out, { recursive: true });
await build({
  entryPoints: ['dev/editorDemo.tsx'],
  outdir: out,
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  jsx: 'automatic',
  minify: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
});
writeFileSync(
  `${out}/index.html`,
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Editor demo</title><link rel="stylesheet" href="/static/css/main.css"><link rel="stylesheet" href="/static/dist/editor-demo/editorDemo.css">
<style>html,body{height:auto;overflow:auto;background:var(--bg-solid);color:var(--text)}#root{max-width:1100px;margin:0 auto;padding:24px}</style>
</head><body><div id="root"></div><script src="/static/dist/editor-demo/editorDemo.js"></script></body></html>`,
);
