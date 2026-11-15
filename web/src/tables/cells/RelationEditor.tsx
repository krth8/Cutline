import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { query as queryTable } from '../../api/tables';
import { Popover, cx } from '../../ui';
import type { Row } from '../types';
import { RelationDisplay } from './displays';
import { useSettle } from './editors';
import { useAnchorRef } from './pickers';
import { asLinks, relationConfig, type RelationLink } from './relation';
import type { CellEditorProps } from './types';
import './cells.css';
import './relation.css';

const PAGE = 25;
const SEARCH_DELAY_MS = 180;

const titleOf = (row: Row): string => {
  const name = row.values.name;
  return typeof name === 'string' && name.trim() ? name : 'Untitled';
};

type Item = { kind: 'clear' } | { kind: 'link'; link: RelationLink };

/**
 * Popover for a relation cell: a search box over the rows of the target table (the table query API with
 * `search`), the current links first. Multiple: Space or a click toggles, Enter commits, Escape, Tab and a
 * click outside commit too. Single: Enter or a click picks and commits, Escape cancels. Typing filters;
 * with text in the box Enter picks the highlighted row.
 */
export function RelationEditor({ column, value, row, onCommit, onCancel, anchor, autoFocus = true, initialKey }: CellEditorProps) {
  const config = relationConfig(column);
  const multi = config.multiple;
  const { selfRef, anchorRef } = useAnchorRef(anchor);
  const { commit, cancel } = useSettle(onCommit, onCancel);
  const listId = useId();
  const original = useMemo(() => asLinks(value), [value]);
  const [selected, setSelected] = useState<RelationLink[]>(multi ? original : original.slice(0, 1));
  const [text, setText] = useState(initialKey ?? '');
  const [found, setFound] = useState<RelationLink[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const q = text.trim();

  // Search the target table (debounced; a newer search wins)
  useEffect(() => {
    const target = config.target;
    if (!target) return;
    let current = true;
    const timer = setTimeout(
      () => {
        queryTable(target, { ...(q ? { search: q } : {}), limit: PAGE })
          .then((result) => {
            if (!current) return;
            setFailed(false);
            setFound(result.rows.filter((r) => !(r.id === row?.id && target === row?.tableRef)).map((r) => ({ id: r.id, label: titleOf(r) })));
          })
          .catch(() => current && setFailed(true));
      },
      found === null ? 0 : SEARCH_DELAY_MS,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, config.target]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items: Item[] = useMemo(() => {
    const lower = q.toLowerCase();
    const current = selected.filter((l) => l.label.toLowerCase().includes(lower));
    const ids = new Set(selected.map((l) => l.id));
    const rest = (found ?? []).filter((l) => !ids.has(l.id));
    return [...(q === '' && selected.length > 0 ? [{ kind: 'clear' } as const] : []), ...[...current, ...rest].map((link) => ({ kind: 'link', link }) as const)];
  }, [selected, found, q]);

  const activeIndex = Math.min(active, Math.max(items.length - 1, 0));
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.is-active')?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, items]);

  const isSelected = (id: string) => selected.some((l) => l.id === id);

  function close() {
    if (multi) commit(selected);
    else cancel();
  }

  function choose(item: Item | undefined) {
    if (!item) return;
    if (item.kind === 'clear') {
      if (multi) setSelected([]);
      else commit([]);
      return;
    }
    if (!multi) {
      commit([item.link]);
      return;
    }
    setSelected((s) => (s.some((l) => l.id === item.link.id) ? s.filter((l) => l.id !== item.link.id) : [...s, item.link]));
    if (text) {
      setText('');
      setActive(0);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((activeIndex + 1) % Math.max(items.length, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((activeIndex - 1 + items.length) % Math.max(items.length, 1));
        break;
      case 'Enter':
        e.preventDefault();
        if (multi && q === '') commit(selected);
        else choose(items[activeIndex]);
        break;
      case ' ':
        if (multi && q === '') {
          e.preventDefault();
          choose(items[activeIndex]);
        }
        break;
      case 'Tab':
        if (multi) commit(selected);
        else cancel();
        break;
    }
  }

  return (
    <>
      <span ref={selfRef} className="cl-cell__anchor">
        <RelationDisplay column={column} value={value} />
      </span>
      <Popover open onOpenChange={(o) => !o && close()} anchorRef={anchorRef} role="listbox" aria-label={column.name} className="cl-picker cl-relpicker">
        <input
          ref={inputRef}
          type="text"
          className="cl-picker__search"
          placeholder={config.targetName ? `Search ${config.targetName}...` : 'Search...'}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={items[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          aria-label={`Search ${column.name}`}
          data-testid="relation-search"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div ref={listRef} id={listId} className="cl-picker__list" role="presentation">
          {items.map((item, i) => {
            const checked = item.kind === 'link' && isSelected(item.link.id);
            return (
              <div
                key={item.kind === 'link' ? item.link.id : '__clear'}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={checked}
                className={cx('cl-picker__item', i === activeIndex && 'is-active', item.kind === 'clear' && 'cl-picker__item--clear')}
                data-testid="relation-option"
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault() /* keep focus in the search box */}
                onClick={() => choose(item)}
              >
                {multi && item.kind === 'link' && (
                  <span className={cx('cl-picker__check', checked && 'is-checked')} aria-hidden="true">
                    {checked ? '✓' : ''}
                  </span>
                )}
                {item.kind === 'clear' ? (
                  <span className="cl-picker__clear">{multi ? 'Clear all' : 'None'}</span>
                ) : (
                  <span className="cl-picker__label">{item.link.label || 'Untitled'}</span>
                )}
                {!multi && checked && (
                  <span className="cl-picker__tick" aria-hidden="true">
                    {'✓'}
                  </span>
                )}
              </div>
            );
          })}
          {failed && <div className="cl-picker__none">Could not load rows</div>}
          {!failed && found === null && items.length === 0 && <div className="cl-picker__none">Searching...</div>}
          {!failed && found !== null && items.length === 0 && <div className="cl-picker__none">No match</div>}
        </div>
      </Popover>
    </>
  );
}
