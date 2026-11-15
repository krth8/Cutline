import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Popover } from './Popover';
import { cx, type Placement } from './hooks';
import './menu.css';

export type MenuItem =
  | { type: 'separator' }
  | {
      id: string;
      label: string;
      icon?: ReactNode;
      disabled?: boolean;
      danger?: boolean;
      /** Marks a toggle (shown with a check mark when on). */
      checked?: boolean;
      /** Stable hook for tests. */
      testId?: string;
      /** Renders the item as a link that opens in a new tab; `onSelect` still runs when it is chosen. */
      href?: string;
      onSelect: () => void;
    };

export interface MenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchorRef: RefObject<HTMLElement | null>;
  items: MenuItem[];
  placement?: Placement;
  'aria-label'?: string;
}

type ActionItem = Extract<MenuItem, { id: string }>;

/**
 * A menu of actions. Arrow keys / Home / End move, typing a letter jumps to the
 * next matching label, Enter or Space selects, Escape and Tab close it.
 */
export function Menu({ open, onOpenChange, anchorRef, items, placement, ...aria }: MenuProps) {
  const actions = items.filter((i): i is ActionItem => 'id' in i);
  const enabled = actions.filter((a) => !a.disabled);
  const [activeId, setActiveId] = useState<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const typeahead = useRef({ text: '', at: 0 });

  // Start on the first enabled item whenever the menu opens
  useEffect(() => {
    if (open) setActiveId(enabled[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open && activeId) itemRefs.current.get(activeId)?.focus();
  }, [open, activeId]);

  function move(delta: number | 'first' | 'last') {
    if (!enabled.length) return;
    const current = enabled.findIndex((a) => a.id === activeId);
    let next: number;
    if (delta === 'first') next = 0;
    else if (delta === 'last') next = enabled.length - 1;
    else next = (current + delta + enabled.length) % enabled.length;
    setActiveId(enabled[next]!.id);
  }

  function select(item: ActionItem) {
    if (item.disabled) return;
    onOpenChange(false);
    item.onSelect();
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        return;
      case 'Home':
        e.preventDefault();
        move('first');
        return;
      case 'End':
        e.preventDefault();
        move('last');
        return;
      case 'Tab':
        onOpenChange(false);
        return;
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== ' ') {
      const now = Date.now();
      const t = typeahead.current;
      t.text = now - t.at > 700 ? e.key.toLowerCase() : t.text + e.key.toLowerCase();
      t.at = now;
      const from = Math.max(0, enabled.findIndex((a) => a.id === activeId));
      const ordered = [...enabled.slice(from + (t.text.length === 1 ? 1 : 0)), ...enabled.slice(0, from + 1)];
      const hit = ordered.find((a) => a.label.toLowerCase().startsWith(t.text));
      if (hit) setActiveId(hit.id);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={onOpenChange}
      anchorRef={anchorRef}
      {...(placement ? { placement } : {})}
      role="menu"
      {...(aria['aria-label'] ? { 'aria-label': aria['aria-label'] } : {})}
      className="cl-menu"
    >
      <div onKeyDown={onKeyDown}>
        {items.map((item, i) =>
          'id' in item ? (
            <MenuEntry
              key={item.id}
              item={item}
              active={item.id === activeId}
              register={(el) => {
                if (el) itemRefs.current.set(item.id, el);
                else itemRefs.current.delete(item.id);
              }}
              onHover={() => !item.disabled && setActiveId(item.id)}
              onChoose={() => select(item)}
            />
          ) : (
            <div key={`sep${i}`} role="separator" className="cl-menu__separator" />
          ),
        )}
      </div>
    </Popover>
  );
}

function MenuEntry({
  item,
  active,
  register,
  onHover,
  onChoose,
}: {
  item: ActionItem;
  active: boolean;
  register: (el: HTMLElement | null) => void;
  onHover: () => void;
  onChoose: () => void;
}) {
  const common = {
    role: item.checked === undefined ? 'menuitem' : 'menuitemcheckbox',
    ...(item.checked === undefined ? {} : { 'aria-checked': item.checked }),
    tabIndex: active ? 0 : -1,
    className: cx('cl-menu__item', item.danger && 'cl-menu__item--danger', active && 'is-active'),
    'data-testid': item.testId,
    onMouseEnter: onHover,
  };
  const content = (
    <>
      {(item.icon || item.checked !== undefined) && (
        <span className="cl-menu__icon">{item.icon ?? (item.checked ? '✓' : '')}</span>
      )}
      {item.label}
    </>
  );
  if (item.href && !item.disabled) {
    return (
      <a ref={register} href={item.href} target="_blank" rel="noopener" {...common} onClick={onChoose}>
        {content}
      </a>
    );
  }
  return (
    <button
      ref={register}
      type="button"
      {...common}
      disabled={item.disabled}
      aria-disabled={item.disabled || undefined}
      onClick={onChoose}
    >
      {content}
    </button>
  );
}
