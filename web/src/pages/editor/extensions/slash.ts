import { Extension, type Editor, type Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import { filterSlashItems } from '../filter';
import { getRegisteredSlashItems, type SlashItem } from '../registry';
import { BASE_SLASH_ITEMS } from '../baseSlash';

export interface SlashState {
  open: boolean;
  query: string;
  /** Matching items in display order (grouped). */
  items: SlashItem[];
  selected: number;
  /** Viewport rectangle of the typed "/", for positioning. */
  rect: DOMRect | null;
}

const CLOSED: SlashState = { open: false, query: '', items: [], selected: 0, rect: null };

/** A tiny external store the React menu subscribes to. */
export class SlashStore {
  state: SlashState = CLOSED;
  private listeners = new Set<() => void>();
  private run: ((item: SlashItem) => void) | null = null;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.state;

  set(next: Partial<SlashState> & { run?: (item: SlashItem) => void }) {
    const { run, ...rest } = next;
    if (run) this.run = run;
    this.state = { ...this.state, ...rest };
    this.listeners.forEach((l) => l());
  }
  close() {
    this.state = CLOSED;
    this.run = null;
    this.listeners.forEach((l) => l());
  }
  choose(item: SlashItem) {
    this.run?.(item);
  }
  move(delta: number) {
    const n = this.state.items.length;
    if (n) this.set({ selected: (this.state.selected + delta + n) % n });
  }
}

function safeRect(fn: (() => DOMRect | null) | null | undefined): DOMRect | null {
  try {
    return fn?.() ?? null;
  } catch {
    return null; // no layout (tests): the menu is then placed by the caller's fallback
  }
}

/** Items matching `query`: base items, then registry items; without a query they are grouped. */
export function slashItemsFor(query: string): SlashItem[] {
  const all = filterSlashItems([...BASE_SLASH_ITEMS, ...getRegisteredSlashItems()], query);
  if (query.trim()) return all;
  const groups = new Map<string, SlashItem[]>();
  for (const item of all) groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  return [...groups.values()].flat();
}

export const SlashCommand = Extension.create<{ store: SlashStore }>({
  name: 'clSlashCommand',

  addOptions() {
    return { store: new SlashStore() };
  },

  addProseMirrorPlugins() {
    const store = this.options.store;
    return [
      Suggestion<SlashItem, SlashItem>({
        editor: this.editor,
        pluginKey: new PluginKey('clSlash'),
        char: '/',
        allowSpaces: false,
        startOfLine: false,
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => slashItemsFor(query),
        command: ({ editor, range, props }) => props.run(editor as Editor, range as Range),
        render: () => {
          const update = (props: {
            query: string;
            items: SlashItem[];
            clientRect?: (() => DOMRect | null) | null;
            command: (i: SlashItem) => void;
          }) => {
            const sameQuery = props.query === store.state.query && store.state.open;
            store.set({
              open: true,
              query: props.query,
              items: props.items,
              selected: sameQuery ? Math.min(store.state.selected, Math.max(0, props.items.length - 1)) : 0,
              rect: safeRect(props.clientRect),
              run: props.command,
            });
          };
          return {
            onStart: update,
            onUpdate: update,
            onExit: () => store.close(),
            onKeyDown: ({ event }) => {
              if (event.isComposing || !store.state.open) return false;
              switch (event.key) {
                case 'ArrowDown':
                  store.move(1);
                  return true;
                case 'ArrowUp':
                  store.move(-1);
                  return true;
                case 'Enter':
                case 'Tab': {
                  const item = store.state.items[store.state.selected];
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
      }),
    ];
  },
});
