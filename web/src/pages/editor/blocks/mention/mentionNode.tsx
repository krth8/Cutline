/**
 * The `mention` node (PLAN.md 5.8): an inline atom that points at a person, task, page or clip, written with
 * `@`. This file is bundled into the editor chunk: it uses the chunk's Tiptap and gets everything else (the
 * chip and menu components, search, router, platform) through ./host, which the chunk build turns into the
 * main bundle's module.
 */
import { Node, type Editor } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { NodeViewWrapper, ReactNodeViewRenderer, ReactRenderer, type NodeViewProps } from '@tiptap/react';
import Suggestion from '@tiptap/suggestion';
import { getEditorPageId } from '../pageFiles';
import * as host from './host';
import { EMPTY_RESULT, flattenResult, isMentionKind, MENTION, type MentionAttrs, type MentionItem, type MentionSearchResult } from './model';

function MentionView({ node }: NodeViewProps) {
  const { kind, id, label } = node.attrs as MentionAttrs;
  return (
    <NodeViewWrapper as="span" className="cl-mention-node" contentEditable={false}>
      <host.MentionChip kind={kind} id={id} label={label} />
    </NodeViewWrapper>
  );
}

// ---- the @ menu ----

const SEARCH_DELAY_MS = 120;
const MAX_QUERY = 60;
const CLOSED: host.MentionMenuState = { open: false, query: '', result: EMPTY_RESULT, loading: false, selected: 0, rect: null };

/** The state of the open menu, as an external store the React popup subscribes to (like the slash menu's). */
export class MentionStore implements host.MentionMenuStore {
  private state: host.MentionMenuState = CLOSED;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;
  private items: MentionItem[] = [];
  private pick: ((item: MentionItem) => void) | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.state;

  private set(next: Partial<host.MentionMenuState>) {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((l) => l());
  }

  /** The menu is open (or its query changed): look the query up, a moment after the last keystroke. */
  update(query: string, rect: DOMRect | null, search: (q: string) => Promise<MentionSearchResult>, pick: (item: MentionItem) => void) {
    const changed = !this.state.open || query !== this.state.query;
    this.pick = pick;
    this.set({ open: true, query, rect });
    if (!changed) return;
    const seq = ++this.seq;
    if (this.timer) clearTimeout(this.timer);
    this.set({ loading: true });
    this.timer = setTimeout(() => {
      search(query.slice(0, MAX_QUERY)).then(
        (result) => {
          if (seq !== this.seq) return; // a newer query is on its way
          this.items = flattenResult(result);
          this.set({ result, loading: false, selected: 0 });
        },
        () => {
          if (seq === this.seq) this.set({ result: EMPTY_RESULT, loading: false });
        },
      );
    }, SEARCH_DELAY_MS);
  }

  close() {
    this.seq++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.items = [];
    this.pick = null;
    this.state = CLOSED;
    this.listeners.forEach((l) => l());
  }

  select(index: number) {
    this.set({ selected: index });
  }
  choose(item: MentionItem) {
    this.pick?.(item);
  }
  move(delta: number) {
    const n = this.items.length;
    if (n) this.set({ selected: (this.state.selected + delta + n) % n });
  }
  current(): MentionItem | undefined {
    return this.items[this.state.selected];
  }
  get hasItems() {
    return this.items.length > 0;
  }
}

function safeRect(fn: (() => DOMRect | null) | null | undefined): DOMRect | null {
  try {
    return fn?.() ?? null;
  } catch {
    return null; // no layout (tests): the menu is placed by its fallback
  }
}

/** Put the chosen target where "@query" was, followed by a space. */
function insertMention(editor: Editor, range: { from: number; to: number }, item: MentionItem): void {
  const attrs: MentionAttrs = { kind: item.kind, id: item.id, label: item.label };
  editor
    .chain()
    .focus()
    .insertContentAt(range, [{ type: MENTION, attrs }, { type: 'text', text: ' ' }])
    .run();
}

function suggestionPlugin(editor: Editor): Plugin {
  const store = new MentionStore();
  const pluginKey = new PluginKey('clMention');
  return Suggestion<MentionItem, MentionItem>({
    editor,
    pluginKey,
    char: '@',
    allowSpaces: true, // task and page names have spaces; the menu hides itself when a spaced query finds nothing
    startOfLine: false,
    allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
    items: () => [], // the menu runs its own (delayed, server-side) search
    command: () => undefined,
    render: () => {
      let renderer: ReactRenderer | null = null;
      const cleanup = () => {
        store.close();
        renderer?.destroy();
        renderer?.element.remove();
        renderer = null;
      };
      editor.on('destroy', cleanup);
      const apply = (props: { query: string; range: { from: number; to: number }; clientRect?: (() => DOMRect | null) | null }) => {
        store.update(
          props.query,
          safeRect(props.clientRect),
          (q) => host.searchMentions(q, getEditorPageId(editor)),
          (item) => insertMention(editor, props.range, item),
        );
      };
      return {
        onStart: (props) => {
          renderer?.destroy();
          renderer?.element.remove();
          renderer = new ReactRenderer(host.MentionMenu, { editor, props: { store } });
          document.body.appendChild(renderer.element);
          apply(props);
        },
        onUpdate: (props) => apply(props),
        onExit: () => {
          // Registering or removing any other plugin re-creates every plugin view and calls this too, while the
          // suggestion is still active: then the menu stays as it is (the next keystroke updates it)
          if (!editor.isDestroyed && pluginKey.getState(editor.view.state)?.active) return;
          cleanup();
        },
        onKeyDown: ({ event }) => {
          if (event.isComposing || !store.getSnapshot().open) return false;
          switch (event.key) {
            case 'ArrowDown':
              if (!store.hasItems) return false;
              store.move(1);
              return true;
            case 'ArrowUp':
              if (!store.hasItems) return false;
              store.move(-1);
              return true;
            case 'Enter':
            case 'Tab': {
              const item = store.current();
              if (!item) return false;
              store.choose(item);
              return true;
            }
            default:
              return false;
          }
        },
      };

    },
  });
}

// ---- pasting a link ----

const pasteKey = new PluginKey('clMentionPaste');

/** After a pasted link became a chip, store the target's current name in it (the link had none). */
function fillLabel(editor: Editor, attrs: Pick<MentionAttrs, 'kind' | 'id'>): void {
  void host.resolveMention(attrs.kind, attrs.id).then((resolved) => {
    if (!resolved?.ok || !resolved.title || editor.isDestroyed) return;
    const tr = editor.state.tr;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === MENTION && node.attrs.kind === attrs.kind && node.attrs.id === attrs.id && !node.attrs.label) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, label: resolved.title });
      }
    });
    if (tr.docChanged) editor.view.dispatch(tr);
  });
}

/** A pasted Cutline link to a page or task (and nothing else) becomes a chip. Over a selection it stays a link. */
function pastePlugin(editor: Editor): Plugin {
  return new Plugin({
    key: pasteKey,
    props: {
      handlePaste(view, event) {
        const text = event.clipboardData?.getData('text/plain');
        if (!text || !view.editable || !view.state.selection.empty) return false;
        if (view.state.selection.$from.parent.type.spec.code) return false;
        const target = host.parseMentionLink(text);
        if (!target) return false;
        const node = view.state.schema.nodes[MENTION]?.create({ ...target, label: '' });
        if (!node) return false;
        view.dispatch(view.state.tr.replaceSelectionWith(node, false).scrollIntoView());
        fillLabel(editor, target);
        return true;
      },
    },
  });
}

/** An inline atom that points at a person, task, page or clip. */
export const Mention = Node.create({
  name: MENTION,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  priority: 1100, // its paste handler goes before the link extension's

  addAttributes() {
    return {
      kind: {
        default: 'task',
        parseHTML: (el: HTMLElement) => {
          const kind = el.getAttribute('data-kind');
          return isMentionKind(kind) ? kind : 'task';
        },
        renderHTML: (attrs: Record<string, any>) => ({ 'data-kind': attrs.kind }),
      },
      id: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-id') ?? '',
        renderHTML: (attrs: Record<string, any>) => ({ 'data-id': attrs.id }),
      },
      label: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-label') ?? el.textContent ?? '',
        renderHTML: (attrs: Record<string, any>) => ({ 'data-label': attrs.label }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-mention]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', { 'data-mention': '', ...HTMLAttributes }, `@${node.attrs.label}`];
  },

  renderText({ node }) {
    return `@${node.attrs.label}`;
  },

  addNodeView() {
    return ReactNodeViewRenderer(MentionView, { as: 'span' });
  },

  addProseMirrorPlugins() {
    return [suggestionPlugin(this.editor), pastePlugin(this.editor)];
  },
});
