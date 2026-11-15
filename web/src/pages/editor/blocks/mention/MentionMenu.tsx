/**
 * The popup of the `@` menu: People, Tasks, Pages and Clips, with the keyboard-selected entry highlighted.
 * Same look and mechanics as the slash menu (it reuses its classes); runs in the main bundle.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cx } from '../../../../ui';
import { kindIcon, SECTIONS, type MentionItem, type MentionSearchResult } from './model';

/** What the menu shows; the node in the editor chunk owns the store and fills it. */
export interface MentionMenuState {
  open: boolean;
  query: string;
  result: MentionSearchResult;
  loading: boolean;
  /** Index into the flat list (People, Tasks, Pages, Clips). */
  selected: number;
  rect: DOMRect | null;
}

export interface MentionMenuStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): MentionMenuState;
  select(index: number): void;
  choose(item: MentionItem): void;
}

export function MentionMenu({ store }: { store: MentionMenuStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const listRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const count = SECTIONS.reduce((n, s) => n + state.result[s.key].length, 0);

  useLayoutEffect(() => {
    if (!state.open) {
      setPlace(null);
      return;
    }
    if (!state.rect) {
      setPlace({ left: 8, top: 8 });
      return;
    }
    const menuHeight = Math.min(320, listRef.current?.offsetHeight || 320);
    const below = state.rect.bottom + 6;
    const fitsBelow = below + menuHeight < window.innerHeight || state.rect.top < menuHeight + 12;
    setPlace({
      left: Math.max(8, Math.min(state.rect.left, window.innerWidth - 300)),
      top: fitsBelow ? below : state.rect.top - menuHeight - 6,
    });
  }, [state.open, state.rect, count]);

  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest' });
  }, [state.selected, count]);

  // A query with a space and nothing found is just text that follows an "@": stay out of the way
  if (!state.open || (count === 0 && /\s/.test(state.query))) return null;

  let index = -1;
  return (
    <div
      ref={listRef}
      className="cl-slash cl-mention-menu"
      role="listbox"
      aria-label="Mention"
      data-testid="mention-menu"
      style={place ? { left: place.left, top: place.top } : { visibility: 'hidden' }}
      // Keep the focus (and the selection) in the editor
      onMouseDown={(e) => e.preventDefault()}
    >
      {count === 0 && <div className="cl-slash__empty">{state.loading ? 'Searching...' : 'No matches'}</div>}
      {SECTIONS.map(({ key, title }) => {
        const items = state.result[key];
        if (!items.length) return null;
        return (
          <div key={key} role="group" aria-label={title}>
            <div className="cl-slash__group">{title}</div>
            {items.map((item) => {
              index += 1;
              const at = index;
              return (
                <button
                  key={`${item.kind}:${item.id}`}
                  type="button"
                  role="option"
                  aria-selected={at === state.selected}
                  className={cx('cl-slash__item', at === state.selected && 'is-active')}
                  onMouseEnter={() => store.select(at)}
                  onClick={() => store.choose(item)}
                >
                  <span className="cl-slash__icon" aria-hidden="true">
                    {kindIcon(item.kind, item.icon)}
                  </span>
                  <span className="cl-slash__text">
                    <span className="cl-slash__title">{item.label || 'Untitled'}</span>
                    {item.projectName ? <span className="cl-slash__desc">{item.projectName}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
