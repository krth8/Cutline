// Bundles src/index.ts into ../static/dist/pages.js (+ pages.css for imported styles), and the page
// editor (Tiptap, the biggest part) into its own file, ../static/dist/pages-editor.js (+ .css), which
// the main bundle loads on demand (src/pages/sync/loadEditor.ts).
//
// pages.js stays a classic script (IIFE) because static/index.html loads it with <script defer>. The
// editor chunk is an ES module that the script imports at run time; it does not bundle its own React or
// Yjs but takes the main bundle's copies from window.__clShared (two copies would break hooks and Yjs).
import { build, context } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const watch = process.argv.includes('--watch');
const here = path.dirname(fileURLToPath(import.meta.url));
const registryFile = path.join(here, 'src/pages/editor/registry');

const EDITOR_CHUNK_URL = '/static/dist/pages-editor.js';
const SHARED = new Set(['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'yjs', 'y-protocols/awareness']);

/** Main bundle: `./editorChunk` is not bundled, it is imported from its URL when first needed. */
const lazyEditorImport = {
  name: 'lazy-editor-import',
  setup(b) {
    b.onResolve({ filter: /(^|\/)editorChunk$/ }, () => ({ path: EDITOR_CHUNK_URL, external: true }));
  },
};

/** Editor chunk: modules that must exist once per page come from the main bundle. */
const sharedFromMainBundle = {
  name: 'shared-from-main-bundle',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (SHARED.has(args.path)) return { path: args.path, namespace: 'cl-shared' };
      // The block registry is state (blocks other packages registered): one instance, in the main bundle
      if (args.path.startsWith('.') && path.resolve(args.resolveDir, args.path) === registryFile) {
        return { path: 'editor-registry', namespace: 'cl-shared' };
      }
      return undefined;
    });
    b.onLoad({ filter: /.*/, namespace: 'cl-shared' }, (args) => ({
      contents: `module.exports = window.__clShared[${JSON.stringify(args.path)}];`,
      loader: 'js',
    }));
  },
};

const common = {
  bundle: true,
  target: ['es2020', 'chrome100', 'firefox100', 'safari15'],
  jsx: 'automatic',
  minify: !watch,
  sourcemap: true,
  logLevel: 'info',
};
const mode = { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' };

const mainOptions = {
  ...common,
  entryPoints: ['src/index.ts'],
  outfile: '../static/dist/pages.js',
  format: 'iife',
  plugins: [lazyEditorImport],
  define: { ...mode, __CL_LAZY_EDITOR__: 'true' },
};

const editorOptions = {
  ...common,
  entryPoints: ['src/pages/sync/editorChunk.ts'],
  outfile: '../static/dist/pages-editor.js',
  format: 'esm',
  plugins: [sharedFromMainBundle],
  define: mode,
};

if (watch) {
  const contexts = await Promise.all([context(mainOptions), context(editorOptions)]);
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('Watching web/src ... (Ctrl+C to stop)');
} else {
  await Promise.all([build(mainOptions), build(editorOptions)]);
}
