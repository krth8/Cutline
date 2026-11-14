import { Extension, getSchema, type AnyExtension, type Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import Highlight from '@tiptap/extension-highlight';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { Callout } from './extensions/callout';
import { ImageNode } from './extensions/image';
import { EditorKeys } from './extensions/keys';
import { MarkdownPaste } from './extensions/markdownPaste';
import { SlashCommand, type SlashStore } from './extensions/slash';
import { scanUnknownNodes, unsupportedNode } from './extensions/unsupported';
import { getRegisteredBlocks } from './registry';

/** The Y.XmlFragment that holds the document content; the server reads this name. */
export const FRAGMENT_NAME = 'default';

export interface EditorUser {
  id: string;
  name: string;
  color: string;
}

export interface BuildOptions {
  doc: Y.Doc;
  awareness?: Awareness | undefined;
  user: EditorUser;
  placeholder?: string | undefined;
  slashStore: SlashStore;
}

function caretElement(user: Record<string, any>): HTMLElement {
  const caret = document.createElement('span');
  caret.className = 'cl-caret';
  caret.style.setProperty('--cl-caret-color', String(user.color ?? '#888'));
  const label = document.createElement('span');
  label.className = 'cl-caret__label';
  label.textContent = String(user.name ?? '');
  caret.appendChild(label);
  return caret;
}

/** Blocks registered by other work packages: their nodes plus the shortcuts they declared. */
function registryExtensions(): AnyExtension[] {
  return getRegisteredBlocks().flatMap((block) => {
    const out: AnyExtension[] = [block.node];
    const shortcuts = block.shortcuts;
    if (shortcuts) {
      out.push(
        Extension.create({
          name: `${block.name}Shortcuts`,
          addKeyboardShortcuts() {
            return Object.fromEntries(
              Object.entries(shortcuts).map(([key, fn]) => [key, ({ editor }: { editor: Editor }) => fn(editor)]),
            );
          },
        }),
      );
    }
    return out;
  });
}

/** The full extension list: base schema, registry blocks, unknown-node placeholders, collaboration. */
export function buildExtensions(opts: BuildOptions): AnyExtension[] {
  const base: AnyExtension[] = [
    StarterKit.configure({
      undoRedo: false, // undo and redo come from the Yjs binding (they only undo the local user's changes)
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https' },
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Highlight,
    ImageNode,
    Callout,
    Markdown,
    MarkdownPaste,
    EditorKeys,
    SlashCommand.configure({ store: opts.slashStore }),
    Placeholder.configure({
      showOnlyCurrent: true,
      includeChildren: false,
      placeholder: ({ node, editor }) => {
        if (node.type.name === 'heading') return `Heading ${node.attrs.level}`;
        if (node.type.name !== 'paragraph') return '';
        // The whole document is one empty paragraph: show the page-level hint
        if (editor.state.doc.childCount === 1) return opts.placeholder ?? "Type '/' for blocks";
        return "Type '/' for blocks";
      },
    }),
    ...registryExtensions(),
    Collaboration.configure({ document: opts.doc, field: FRAGMENT_NAME }),
  ];
  if (opts.awareness) {
    base.push(
      CollaborationCaret.configure({
        provider: { awareness: opts.awareness },
        user: { name: opts.user.name, color: opts.user.color, id: opts.user.id },
        render: caretElement,
      }),
    );
  }

  // Node types found in the document that this editor does not know get a placeholder node
  // with the same name and attributes, so their data survives.
  const schema = getSchema(base);
  const unknown = scanUnknownNodes(opts.doc.getXmlFragment(FRAGMENT_NAME), (name) => name in schema.nodes);
  for (const [name, info] of unknown) base.push(unsupportedNode(name, info));
  return base;
}
