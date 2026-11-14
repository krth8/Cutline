import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Avatar, DatePicker, Popover, cx } from '../../ui';
import type { Column } from '../types';
import type { CellDisplayProps, CellEditorProps } from './types';
import { MultiSelectDisplay, PeopleDisplay, PersonDisplay, Pill, SelectDisplay, DateDisplay } from './displays';
import { useSettle } from './editors';
import { addDaysISO, asArray, avatarFor, isISODate, nextMondayISO, parseDateText, today, type Option } from './util';
import './cells.css';

/** A ref whose target is the given anchor element, or the in-place element when none is given. */
function useAnchorRef(anchor: HTMLElement | null | undefined) {
  const selfRef = useRef<HTMLSpanElement>(null);
  const anchorRef = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return anchor ?? selfRef.current;
      },
    }),
    [anchor],
  );
  return { selfRef, anchorRef };
}

const DISPLAYS: Record<string, (p: CellDisplayProps) => ReactNode> = {
  select: SelectDisplay,
  status: SelectDisplay,
  priority: SelectDisplay,
  multiselect: MultiSelectDisplay,
  person: PersonDisplay,
  people: PeopleDisplay,
  date: DateDisplay,
};

function InPlaceDisplay({ column, value, row }: Pick<CellEditorProps, 'column' | 'value' | 'row'>) {
  const D = DISPLAYS[column.type];
  return D ? <>{D({ column, value, ...(row ? { row } : {}) })}</> : null;
}

type Item = { kind: 'clear' } | { kind: 'option'; option: Option };

interface PickerProps extends CellEditorProps {
  multi: boolean;
}

/**
 * Popover list for select, status, priority, person (single) and multiselect, people (multi).
 * Single: Enter or click picks and commits; Escape or a click outside cancels.
 * Multi: Space (or a click) toggles, Enter commits, Escape / Tab / a click outside commit too ("commits on close").
 * Typing filters; with text in the box, Enter picks the highlighted entry (multi: toggles it and clears the text).
 */
export function PickerEditor({ column, value, row, onCommit, onCancel, anchor, autoFocus = true, initialKey, multi }: PickerProps) {
  const { selfRef, anchorRef } = useAnchorRef(anchor);
  const { commit, cancel } = useSettle(onCommit, onCancel);
  const isPerson = column.type === 'person' || column.type === 'people';
  const listId = useId();
  const original = multi ? asArray(value) : typeof value === 'string' && value ? [value] : [];
  const [selected, setSelected] = useState<string[]>(original);
  const [query, setQuery] = useState(initialKey ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const items: Item[] = useMemo(() => {
    const opts = (column.options ?? []).filter((o) => o.label.toLowerCase().includes(q));
    return [...(q === '' ? [{ kind: 'clear' } as const] : []), ...opts.map((option) => ({ kind: 'option', option }) as const)];
  }, [column.options, q]);

  const firstOption = items.findIndex((i) => i.kind === 'option');
  const [active, setActive] = useState(() => {
    const current = !multi && original[0] ? (column.options ?? []).findIndex((o) => o.value === original[0]) : -1;
    return current >= 0 ? current + 1 : Math.max(firstOption, 0); // +1: the clear entry comes first
  });
  const activeIndex = Math.min(active, items.length - 1);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.is-active')?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, items]);

  function close() {
    if (multi) commit(selected);
    else cancel();
  }

  function toggle(v: string) {
    setSelected((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]));
  }

  function choose(item: Item | undefined) {
    if (!item) return;
    if (item.kind === 'clear') {
      if (multi) setSelected([]);
      else commit(null);
    } else if (multi) {
      toggle(item.option.value);
      if (query) {
        setQuery('');
        setActive(0);
      }
    } else commit(item.option.value);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((activeIndex + 1) % items.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((activeIndex - 1 + items.length) % items.length);
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
      case 'Tab': {
        // Do not trap Tab: report a result and let focus move on
        if (multi) commit(selected);
        else {
          const it = items[activeIndex];
          commit(q !== '' && it?.kind === 'option' ? it.option.value : (original[0] ?? null));
        }
        break;
      }
    }
  }

  return (
    <>
      <span ref={selfRef} className="cl-cell__anchor">
        <InPlaceDisplay column={column} value={value} row={row} />
      </span>
      <Popover open onOpenChange={(o) => !o && close()} anchorRef={anchorRef} role="listbox" aria-label={column.name} className="cl-picker">
        <input
          ref={inputRef}
          type="text"
          className="cl-picker__search"
          placeholder="Search..."
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={items[activeIndex] ? `${listId}-${activeIndex}` : undefined}
          aria-label={`Filter ${column.name}`}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div ref={listRef} id={listId} className="cl-picker__list" role="presentation">
          {items.map((item, i) => {
            const v = item.kind === 'option' ? item.option.value : null;
            const checked = v !== null && selected.includes(v);
            return (
              <div
                key={v ?? '__clear'}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={checked}
                className={cx('cl-picker__item', i === activeIndex && 'is-active', item.kind === 'clear' && 'cl-picker__item--clear')}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault() /* keep focus in the search box */}
                onClick={() => choose(item)}
              >
                {multi && item.kind === 'option' && (
                  <span className={cx('cl-picker__check', checked && 'is-checked')} aria-hidden="true">
                    {checked ? '✓' : ''}
                  </span>
                )}
                {item.kind === 'clear' ? (
                  <span className="cl-picker__clear">{multi ? 'Clear all' : 'None'}</span>
                ) : isPerson ? (
                  <>
                    <Avatar name={item.option.label} src={avatarFor(column as Column, item.option.value)} size={20} />
                    <span className="cl-picker__label">{item.option.label}</span>
                  </>
                ) : (
                  <Pill option={item.option} />
                )}
                {!multi && checked && (
                  <span className="cl-picker__tick" aria-hidden="true">
                    {'✓'}
                  </span>
                )}
              </div>
            );
          })}
          {items.length === 0 && <div className="cl-picker__none">No match</div>}
        </div>
      </Popover>
    </>
  );
}

export const SelectEditor = (p: CellEditorProps) => <PickerEditor {...p} multi={false} />;
export const MultiSelectEditor = (p: CellEditorProps) => <PickerEditor {...p} multi />;

// ---- date -------------------------------------------------------------------------

export function DateEditor({ column, value, row, onCommit, onCancel, anchor, autoFocus = true, initialKey }: CellEditorProps) {
  const { selfRef, anchorRef } = useAnchorRef(anchor);
  const { commit, cancel } = useSettle(onCommit, onCancel);
  const original = isISODate(value) ? value : null;
  const [text, setText] = useState(initialKey ?? original ?? '');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const now = today();
  const typed = parseDateText(text, now);

  useEffect(() => {
    const el = inputRef.current;
    if (!el || !autoFocus) return;
    el.focus();
    if (initialKey !== undefined) el.setSelectionRange(el.value.length, el.value.length);
    else el.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (typed === undefined) setInvalid(true);
      else commit(typed);
    } else if (e.key === 'Tab') {
      if (typed === undefined) cancel();
      else commit(typed);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      panelRef.current?.querySelector<HTMLElement>('.cl-datepicker [tabindex="0"]')?.focus();
    }
  }

  const quick: Array<[string, string | null]> = [
    ['Today', now],
    ['Tomorrow', addDaysISO(now, 1)],
    ['Next week', nextMondayISO(now)],
    ['Clear', null],
  ];

  return (
    <>
      <span ref={selfRef} className="cl-cell__anchor">
        <InPlaceDisplay column={column} value={value} row={row} />
      </span>
      <Popover open onOpenChange={(o) => !o && cancel()} anchorRef={anchorRef} role="dialog" aria-label={column.name} className="cl-datepop">
        <div ref={panelRef}>
          <input
            ref={inputRef}
            type="text"
            className={cx('cl-input', 'cl-datepop__input', invalid && 'cl-input--invalid')}
            placeholder="YYYY-MM-DD"
            aria-label={`${column.name} date`}
            aria-invalid={invalid || undefined}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setInvalid(false);
            }}
            onKeyDown={onKeyDown}
          />
          <div className="cl-datepop__quick">
            {quick.map(([label, v]) => (
              <button
                key={label}
                type="button"
                className="cl-datepop__chip"
                title={v ?? undefined}
                onClick={() => commit(v)}
              >
                {label}
              </button>
            ))}
          </div>
          <DatePicker value={typeof typed === 'string' ? typed : original} onChange={(v) => commit(v)} clearable={false} showToday={false} />
        </div>
      </Popover>
    </>
  );
}
