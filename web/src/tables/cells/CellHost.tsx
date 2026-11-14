import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from '../../ui';
import type { Column, Row } from '../types';
import { getCell, isColumnEditable } from './registry';
import './cells.css';

export interface CellHostProps {
  column: Column;
  value: unknown;
  row?: Row;
  readOnly?: boolean;
  /** Called with the new value when an edit is committed and actually changed something. */
  onChange?: (value: unknown) => void;
  compact?: boolean;
  className?: string;
  /** Called when editing starts or ends (layouts use it to stop drag handling, for example). */
  onEditingChange?: (editing: boolean) => void;
}

const sameValue = (a: unknown, b: unknown) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Type-to-edit applies to these; pickers also accept it (the character becomes filter text). */
const TYPEABLE = new Set(['text', 'longtext', 'number', 'url', 'clip', 'date', 'select', 'status', 'priority', 'multiselect', 'person', 'people']);

/**
 * One cell that switches between its display and its editor. Click, Enter or F2 starts editing,
 * typing a character starts editing with that character. Checkboxes toggle directly.
 */
export function CellHost({ column, value, row, readOnly, onChange, compact, className, onEditingChange }: CellHostProps) {
  const def = getCell(column.type);
  const editable = !readOnly && isColumnEditable(column) && (row ? row.canEdit : true);
  const [editing, setEditing] = useState<{ initialKey?: string } | null>(null);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const wasEditing = useRef(false);

  useEffect(() => {
    onEditingChange?.(editing !== null);
    // Focus lost with the editor: bring it back to the cell (not when the user moved on, e.g. Tab or a click elsewhere)
    if (editing === null && wasEditing.current) {
      const active = document.activeElement;
      if (!active || active === document.body) el?.focus();
    }
    wasEditing.current = editing !== null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const start = (initialKey?: string) => {
    if (editable && column.type !== 'checkbox') setEditing(initialKey === undefined ? {} : { initialKey });
  };

  function commit(next: unknown) {
    setEditing(null);
    if (!sameValue(next, value)) onChange?.(next);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (editing || e.target !== e.currentTarget) return;
    if (column.type === 'checkbox') {
      if (editable && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault();
        onChange?.(value !== true);
      }
      return;
    }
    if (e.key === 'Enter' || e.key === 'F2') {
      if (!editable) return;
      e.preventDefault();
      start();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (editable && !def.isEmpty(value)) {
        e.preventDefault();
        commit(Array.isArray(value) ? [] : null);
      }
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && TYPEABLE.has(column.type) && editable) {
      e.preventDefault();
      start(e.key);
    }
  }

  const Editor = def.Editor;
  const Display = def.Display;

  return (
    <div
      ref={setEl}
      className={cx('cl-cellhost', editing && 'is-editing', !editable && 'is-readonly', className)}
      tabIndex={editing ? -1 : 0}
      data-column={column.key}
      onClick={() => !editing && start()}
      onKeyDown={onKeyDown}
    >
      {editing ? (
        <Editor
          column={column}
          value={value}
          {...(row ? { row } : {})}
          anchor={el}
          {...(editing.initialKey !== undefined ? { initialKey: editing.initialKey } : {})}
          onCommit={commit}
          onCancel={() => setEditing(null)}
        />
      ) : (
        <Display
          column={column}
          value={value}
          {...(row ? { row } : {})}
          {...(compact ? { compact } : {})}
          {...(editable && column.type === 'checkbox' ? { onToggle: (next: boolean) => onChange?.(next) } : {})}
        />
      )}
    </div>
  );
}
