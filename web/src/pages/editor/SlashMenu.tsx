import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cx } from '../../ui';
import type { SlashStore } from './extensions/slash';

/** The popup list of the slash menu, driven by the store the Suggestion plugin fills. */
export function SlashMenu({ store }: { store: SlashStore }) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const listRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);

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
  }, [state.open, state.rect, state.items.length]);

  useEffect(() => {
    listRef.current?.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest' });
  }, [state.selected, state.items]);

  if (!state.open) return null;

  let lastGroup = '';
  return (
    <div
      ref={listRef}
      className="cl-slash"
      role="listbox"
      aria-label="Insert block"
      style={place ? { left: place.left, top: place.top } : { visibility: 'hidden' }}
      // Keep the focus (and the selection) in the editor
      onMouseDown={(e) => e.preventDefault()}
    >
      {state.items.length === 0 && <div className="cl-slash__empty">No matching blocks</div>}
      {state.items.map((item, i) => {
        const heading = !state.query.trim() && item.group !== lastGroup ? item.group : null;
        lastGroup = item.group;
        return (
          <div key={item.id ?? item.title}>
            {heading && <div className="cl-slash__group">{heading}</div>}
            <button
              type="button"
              role="option"
              aria-selected={i === state.selected}
              className={cx('cl-slash__item', i === state.selected && 'is-active')}
              onMouseEnter={() => store.set({ selected: i })}
              onClick={() => store.choose(item)}
            >
              <span className="cl-slash__icon" aria-hidden="true">
                {item.icon ?? item.title.slice(0, 1)}
              </span>
              <span className="cl-slash__text">
                <span className="cl-slash__title">{item.title}</span>
                <span className="cl-slash__desc">{item.description}</span>
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
