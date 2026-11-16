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

/** Order of the groups in the menu, by how often people need them; unknown groups follow in registration order. */
export const SLASH_GROUP_ORDER = ['Basic', 'Lists', 'Media', 'Views', 'Numbers', 'Extras', 'Advanced'];

function groupRank(group: string): number {
  const i = SLASH_GROUP_ORDER.indexOf(group);
  return i < 0 ? SLASH_GROUP_ORDER.length : i;
}

/** Items matching `query`: base items, then registry items; without a query they are grouped. */
export function slashItemsFor(query: string): SlashItem[] {
  const all = filterSlashItems([...BASE_SLASH_ITEMS, ...getRegisteredSlashItems()], query);
  if (query.trim()) return all;
  const groups = new Map<string, SlashItem[]>();
  for (const item of all) groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  return [...groups.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0])).flatMap(([, list]) => list);
}

const SLASH_KEY = new PluginKey('clSlash');

/** True while the slash suggestion is still active in the editor state. */
function suggestionActive(editor: Editor): boolean {
  const state = SLASH_KEY.getState(editor.state) as { active?: boolean } | undefined;
  return !!state?.active;
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
        pluginKey: SLASH_KEY,
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
            // Items are computed here, not taken from the (async) suggestion props: those are empty until a
            // fetch resolves, and the fetch is aborted when the plugin views are re-created.
            const items = slashItemsFor(props.query);
            const sameQuery = props.query === store.state.query && store.state.open;
            store.set({
              open: true,
              query: props.query,
              items,
              selected: sameQuery ? Math.min(store.state.selected, Math.max(0, items.length - 1)) : 0,
              rect: safeRect(props.clientRect),
              run: props.command,
            });
          };
          return {
            onStart: update,
            onUpdate: update,
            // Re-creating the plugin views (any plugin being registered or removed) also calls onExit while the
            // suggestion is still active; only a real exit closes the menu.
            onExit: (props) => {
              if (!suggestionActive(props.editor)) store.close();
            },
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
