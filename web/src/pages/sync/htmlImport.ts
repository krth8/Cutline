/**
 * Legacy Docs HTML to editor content (PLAN.md 5.7, "Legacy import").
 *
 * The HTML is sanitised first, then parsed with the editor's own schema, so only nodes and marks the
 * editor knows can come out. This module belongs to the lazily loaded editor chunk.
 */
import { getSchema } from '@tiptap/core';
import { DOMParser as ProseMirrorParser, type Node as ProseMirrorNode, type Schema } from '@tiptap/pm/model';
import { prosemirrorToYXmlFragment } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { FRAGMENT_NAME, SlashStore, buildExtensions } from '../editor';

const REMOVED_ELEMENTS = [
  'script',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'link',
  'meta',
  'base',
  'form',
  'noscript',
  'template',
  'svg',
  'math',
  'audio',
  'video',
  'source',
];

const URL_ATTRIBUTES = ['href', 'src', 'xlink:href', 'action', 'formaction', 'poster', 'background'];
const SAFE_DATA_IMAGE = /^data:image\/(png|gif|jpe?g|webp);/i;

function isUnsafeUrl(value: string): boolean {
  // Browsers ignore control characters and spaces inside the scheme ("java\nscript:")
  // eslint-disable-next-line no-control-regex
  const compact = value.replace(/[\u0000- \u007f-\u009f]/g, '');
  if (/^(javascript|vbscript):/i.test(compact)) return true;
  if (/^data:/i.test(compact)) return !SAFE_DATA_IMAGE.test(compact);
  return false;
}

/** Remove scripts, event handlers, inline styles and dangerous URLs from a parsed document body. */
export function sanitizeBody(body: HTMLElement): void {
  body.querySelectorAll(REMOVED_ELEMENTS.join(',')).forEach((el) => el.remove());
  body.querySelectorAll('*').forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'style' || name === 'srcdoc' || name === 'data-bid') {
        el.removeAttribute(attr.name);
      } else if (URL_ATTRIBUTES.includes(name) && isUnsafeUrl(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  });
}

/**
 * The old editor wrote a to-do as `<div class="docs-todo [completed]"><input type="checkbox"><span>text</span></div>`
 * (the checked state is the `completed` class). Turn runs of them into task lists.
 */
export function convertTodos(body: HTMLElement): void {
  const doc = body.ownerDocument;
  for (const todo of [...body.querySelectorAll<HTMLElement>('.docs-todo')]) {
    const checkbox = todo.querySelector('input[type="checkbox"]');
    const checked = todo.classList.contains('completed') || !!checkbox?.hasAttribute('checked');

    const item = doc.createElement('li');
    item.setAttribute('data-type', 'taskItem');
    item.setAttribute('data-checked', checked ? 'true' : 'false');
    const paragraph = doc.createElement('p');
    for (const child of [...todo.childNodes]) {
      if (child === checkbox) continue;
      if ((child as Element).tagName === 'SPAN') paragraph.append(...(child as Element).childNodes);
      else paragraph.append(child);
    }
    item.append(paragraph);

    const before = todo.previousElementSibling;
    if (before && before.matches('ul[data-type="taskList"]')) {
      before.append(item);
      todo.remove();
    } else {
      const list = doc.createElement('ul');
      list.setAttribute('data-type', 'taskList');
      list.append(item);
      todo.replaceWith(list);
    }
  }
}

let schemaCache: Schema | null = null;

/** The schema of the page editor, built from its own extension list. */
function editorSchema(): Schema {
  schemaCache ??= getSchema(
    buildExtensions({
      doc: new Y.Doc(),
      user: { id: 'import', name: 'Import', color: '#888888' },
      slashStore: new SlashStore(),
    }),
  );
  return schemaCache;
}

/** Sanitise `html` and parse it into a ProseMirror document of the editor's schema. */
export function legacyHtmlToNode(html: string): ProseMirrorNode {
  const parsed = new DOMParser().parseFromString(html, 'text/html'); // inert: nothing runs
  sanitizeBody(parsed.body);
  convertTodos(parsed.body);
  return ProseMirrorParser.fromSchema(editorSchema()).parse(parsed.body);
}

/** Write the converted content into the document's fragment in one transaction. */
export function writeHtmlIntoDoc(doc: Y.Doc, html: string): void {
  const node = legacyHtmlToNode(html);
  doc.transact(() => {
    prosemirrorToYXmlFragment(node, doc.getXmlFragment(FRAGMENT_NAME));
  });
}
