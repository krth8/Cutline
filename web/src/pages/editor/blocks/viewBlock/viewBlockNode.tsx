/**
 * The Tiptap node of the view block (PLAN.md 5.8). This file is bundled into the editor chunk: it uses the
 * chunk's Tiptap and gets everything else (the React content, API calls, the platform) through ./host, which
 * the chunk build turns into the main bundle's module.
 */
import { Node, type Editor } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import { NodeViewWrapper, ReactNodeViewRenderer, useEditorState, type NodeViewProps } from '@tiptap/react';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { getEditorContext } from './context';
import * as host from './host';
import { clampHeight, findNewDuplicates, VIEW_BLOCK } from './model';

function ViewBlockNodeView({ node, editor, updateAttributes, deleteNode }: NodeViewProps) {
  const editable = useEditorState({ editor, selector: (s) => s.editor.isEditable });
  const { viewId, height, copyOf } = node.attrs as { viewId: string | null; height: number | null; copyOf: string | null };
  return (
    <NodeViewWrapper className="cl-viewblock-node" contentEditable={false} data-view-block="">
      <host.ViewBlockContent
        viewId={viewId}
        copying={!!copyOf && !viewId}
        height={clampHeight(height)}
        editable={editable}
        context={getEditorContext(editor) ?? null}
        setAttrs={(attrs) => updateAttributes(attrs)}
        removeBlock={() => deleteNode()}
      />
    </NodeViewWrapper>
  );
}

const copyKey = new PluginKey('viewBlockCopies');
/** Set on the transaction that writes the finished copy's id, so it is not mistaken for a new duplicate. */
const COPY_DONE = 'viewBlockCopyDone';

/** Position of the first view block that matches `test`, or -1. */
function findBlock(state: EditorState, test: (attrs: Record<string, any>) => boolean): number {
  let found = -1;
  state.doc.descendants((n, pos) => {
    if (found < 0 && n.type.name === VIEW_BLOCK && test(n.attrs)) found = pos;
    return found < 0;
  });
  return found;
}

function randomToken(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Copies of a view block: when a change this client made adds a block whose view is already in the
 * document (paste, "Duplicate" in the block menu), the new block is cut loose from the original view
 * (`viewId` null, `copyOf` = the original, a token), and this client then asks the server for a copy of the
 * view and writes its id into the block. Other clients show the block as "copying" meanwhile. Changes that
 * come from the network or from undo (Yjs origin) are never treated as copies.
 */
function copyPlugin(editor: Editor): Plugin {
  const pending = new Set<string>(); // tokens this client is responsible for
  const running = new Set<string>();

  function finish(view: EditorView, token: string, attrs: object | null) {
    const pos = findBlock(view.state, (a) => a.copyToken === token);
    if (pos < 0) return; // the block was removed meanwhile
    const node = view.state.doc.nodeAt(pos)!;
    const tr = view.state.tr;
    if (attrs) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
    else tr.delete(pos, pos + node.nodeSize);
    tr.setMeta(COPY_DONE, true);
    view.dispatch(tr);
  }

  function start(view: EditorView, token: string, source: string) {
    if (running.has(token)) return;
    running.add(token);
    const ctx = getEditorContext(editor);
    const result = ctx ? host.copyViewForPaste(source, ctx) : Promise.resolve(source);
    result
      .then(
        (newId) => finish(view, token, { viewId: newId, copyOf: null, copyToken: null }),
        (e: unknown) => {
          host.showError(e instanceof Error ? `Could not copy the view: ${e.message}` : 'Could not copy the view');
          finish(view, token, null);
        },
      )
      .finally(() => {
        running.delete(token);
        pending.delete(token);
      });
  }

  return new Plugin({
    key: copyKey,
    appendTransaction(transactions, oldState, newState) {
      if (!transactions.some((t) => t.docChanged)) return null;
      if (transactions.some((t) => t.getMeta(ySyncPluginKey) || t.getMeta(COPY_DONE))) return null;
      const mapping = new Mapping();
      for (const t of transactions) t.mapping.maps.forEach((m) => mapping.appendMap(m));
      const copies = findNewDuplicates(oldState.doc, newState.doc, mapping);
      if (!copies.length) return null;
      const tr = newState.tr;
      for (const { pos, id } of copies) {
        const token = randomToken();
        pending.add(token);
        tr.setNodeMarkup(pos, undefined, { ...newState.doc.nodeAt(pos)!.attrs, viewId: null, copyOf: id, copyToken: token });
      }
      return tr;
    },
    view() {
      return {
        update(view) {
          if (!pending.size) return;
          view.state.doc.descendants((n) => {
            const token = n.attrs.copyToken as string | null;
            if (n.type.name === VIEW_BLOCK && token && pending.has(token) && n.attrs.copyOf) start(view, token, n.attrs.copyOf);
          });
        },
      };
    },
    props: {
      // Backspace or Delete on a selected view block asks before the view goes with it
      handleKeyDown(view, event) {
        if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
        const sel = view.state.selection;
        if (!(sel instanceof NodeSelection) || sel.node.type.name !== VIEW_BLOCK || !editor.isEditable) return false;
        event.preventDefault();
        const node = sel.node;
        void host.confirmAndDeleteViewOf(node.attrs.viewId, getEditorContext(editor) ?? null).then((ok) => {
          if (!ok) return;
          const pos = findBlock(view.state, (a) => (node.attrs.copyToken ? a.copyToken === node.attrs.copyToken : a.viewId === node.attrs.viewId));
          if (pos >= 0) view.dispatch(view.state.tr.delete(pos, pos + node.nodeSize));
        });
        return true;
      },
    },
  });
}

/** An atom block that shows one view (a row of the `views` table) inside the page. */
export const ViewBlock = Node.create({
  name: VIEW_BLOCK,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false, // moving goes through the block handle; a draggable wrapper would break text selection in the view

  addAttributes() {
    return {
      viewId: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-view-id') || null,
        renderHTML: (attrs: Record<string, any>) => (attrs.viewId ? { 'data-view-id': attrs.viewId } : {}),
      },
      height: {
        default: null,
        parseHTML: (el: HTMLElement) => clampHeight(el.getAttribute('data-height')),
        renderHTML: (attrs: Record<string, any>) => (attrs.height ? { 'data-height': String(attrs.height) } : {}),
      },
      // Only while a copy is being made (see copyPlugin); never written to HTML
      copyOf: { default: null, rendered: false },
      copyToken: { default: null, rendered: false },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-view-block]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', { 'data-view-block': '', ...HTMLAttributes }];
  },

  addNodeView() {
    // Everything inside the block belongs to the view (inputs, drags, clicks); ProseMirror only sees the frame
    return ReactNodeViewRenderer(ViewBlockNodeView, {
      stopEvent: ({ event }) => {
        const t = event.target as HTMLElement | null;
        return !!t?.closest?.('.cl-viewblock');
      },
    });
  },

  addProseMirrorPlugins() {
    return [copyPlugin(this.editor)];
  },
});
