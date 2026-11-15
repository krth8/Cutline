/**
 * Loads the editor chunk on demand, so the main bundle does not carry Tiptap.
 *
 * Production: web/build.mjs builds `editorChunk.ts` as an ES module (static/dist/pages-editor.js plus
 * pages-editor.css) and turns the `import('./editorChunk')` below into a runtime import of that URL.
 * The chunk gets React, Yjs and the block registry and the blocks' hosts from `window.__clShared` (set below) so there is
 * exactly one copy of each. Tests and the dev builds simply bundle it.
 */
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as React from 'react';
import * as ReactDom from 'react-dom';
import * as AwarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import * as summaryHost from '../editor/blocks/summary/host';
import * as clipEmbedHost from '../editor/blocks/clipEmbed/host';
import * as mentionHost from '../editor/blocks/mention/host';
import * as viewBlockHost from '../editor/blocks/viewBlock/host';
import * as editorRegistry from '../editor/registry';

export type EditorChunk = typeof import('./editorChunk');

declare const __CL_LAZY_EDITOR__: boolean | undefined;
const lazy = typeof __CL_LAZY_EDITOR__ !== 'undefined' && __CL_LAZY_EDITOR__;

if (lazy) {
  (window as unknown as { __clShared: Record<string, unknown> }).__clShared = {
    react: React,
    'react/jsx-runtime': ReactJsxRuntime,
    'react-dom': ReactDom,
    yjs: Y,
    'y-protocols/awareness': AwarenessProtocol,
    'editor-registry': editorRegistry,
    'view-block-host': viewBlockHost,
    'summary-host': summaryHost,
    'clip-embed-host': clipEmbedHost,
    'mention-host': mentionHost,
  };
}

let loading: Promise<EditorChunk> | null = null;

function loadStyles(href: string): Promise<void> {
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => resolve(); // unstyled is better than no editor
    document.head.appendChild(link);
  });
}

/** The editor chunk (Editor component and HTML conversion). Loads once; a failed load can be retried. */
export function loadEditor(): Promise<EditorChunk> {
  if (!loading) {
    const styles = lazy ? loadStyles('/static/dist/pages-editor.css') : Promise.resolve();
    loading = Promise.all([import('./editorChunk'), styles]).then(
      ([chunk]) => chunk,
      (error) => {
        loading = null;
        throw error;
      },
    );
  }
  return loading;
}
