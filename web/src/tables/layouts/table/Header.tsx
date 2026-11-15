import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { cx, Menu, type MenuItem } from '../../../ui';
import type { Column, Query } from '../../types';
import type { GridColumn } from './grid';

export interface HeaderProps {
  cols: readonly GridColumn[];
  sort: Query['sort'];
  allSelected: boolean;
  someSelected: boolean;
  onSelectAll(checked: boolean): void;
  /** A column was resized: `width` null = back to the default; `commit` false while the pointer is still down. */
  onResize(key: string, width: number | null, commit: boolean): void;
  /** A column was dropped before/after another one. */
  onMoveColumn(key: string, target: string, side: 'before' | 'after'): void;
  /** A header was clicked: the caller cycles ascending, descending, none. */
  onSort(key: string): void;
  /** Sort by one column in a given direction (header menu). */
  onSortDir(key: string, dir: 'asc' | 'desc'): void;
  onHide(key: string): void;
  /** The schema can be edited (project owner or admin): custom columns get Rename, Change type and Delete, and "+" shows. */
  canEditSchema: boolean;
  onAddColumn(): void;
  onRenameColumn(column: Column): void;
  onChangeColumnType(column: Column): void;
  onDeleteColumn(column: Column): void;
}

const COLUMN_MIME = 'application/x-cutline-column';

/** The sticky header row: select-all box, column titles (drag to reorder) and resize handles. */
export function Header({
  cols,
  sort,
  allSelected,
  someSelected,
  onSelectAll,
  onResize,
  onMoveColumn,
  onSort,
  onSortDir,
  onHide,
  canEditSchema,
  onAddColumn,
  onRenameColumn,
  onChangeColumnType,
  onDeleteColumn,
}: HeaderProps) {
  const [menu, setMenu] = useState<string | null>(null);
  const menuAnchor = useRef<HTMLElement | null>(null);

  function menuItems(column: Column): MenuItem[] {
    const items: MenuItem[] = [
      { id: 'asc', label: 'Sort ascending', onSelect: () => onSortDir(column.key, 'asc') },
      { id: 'desc', label: 'Sort descending', onSelect: () => onSortDir(column.key, 'desc') },
    ];
    if (column.key !== 'name') items.push({ id: 'hide', label: 'Hide', onSelect: () => onHide(column.key) });
    // Builtin columns only sort and hide; custom ones can be changed by people who may edit the schema
    if (!column.builtin && canEditSchema) {
      items.push(
        { type: 'separator' },
        { id: 'rename', label: 'Rename', onSelect: () => onRenameColumn(column) },
        { id: 'type', label: 'Change type', onSelect: () => onChangeColumnType(column) },
        { id: 'delete', label: 'Delete', danger: true, onSelect: () => onDeleteColumn(column) },
      );
    }
    return items;
  }

  const [drop, setDrop] = useState<{ key: string; side: 'before' | 'after' } | null>(null);
  const dragKey = useRef<string | null>(null);
  const check = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (check.current) check.current.indeterminate = someSelected && !allSelected;
  }, [someSelected, allSelected]);

  function startResize(e: PointerEvent<HTMLElement>, c: GridColumn) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startWidth = c.width;
    let width = startWidth;
    const move = (ev: globalThis.PointerEvent) => {
      width = startWidth + ev.clientX - startX;
      onResize(c.column.key, width, false);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      onResize(c.column.key, width, true);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function resizeKey(e: KeyboardEvent<HTMLElement>, c: GridColumn) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      onResize(c.column.key, c.width + (e.key === 'ArrowRight' ? 16 : -16), true);
    }
  }

  function overHeader(e: DragEvent<HTMLElement>, c: GridColumn) {
    if (!dragKey.current) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const side = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    if (drop?.key !== c.column.key || drop.side !== side) setDrop({ key: c.column.key, side });
  }

  return (
    <div role="row" className={cx('cl-table__header', canEditSchema && 'has-add')} data-testid="table-header">
      <div role="columnheader" className="cl-table__lead">
        <input
          ref={check}
          type="checkbox"
          className="cl-table__check"
          data-testid="table-select-all"
          aria-label="Select all rows"
          checked={allSelected}
          onChange={(e) => onSelectAll(e.target.checked)}
        />
      </div>
      {cols.map((c) => {
        const sortIndex = sort?.findIndex((s) => s.column === c.column.key) ?? -1;
        const sorted = sortIndex >= 0 ? sort![sortIndex]! : null;
        return (
          <div
            key={c.column.key}
            role="columnheader"
            aria-sort={sorted ? (sorted.dir === 'asc' ? 'ascending' : 'descending') : undefined}
            className={cx('cl-table__hcell', drop?.key === c.column.key && `is-drop-${drop.side}`)}
            data-col={c.column.key}
            onDragOver={(e) => overHeader(e, c)}
            onDragLeave={() => setDrop((d) => (d?.key === c.column.key ? null : d))}
            onDrop={(e) => {
              const key = dragKey.current;
              dragKey.current = null;
              const side = drop?.side ?? 'before';
              setDrop(null);
              if (key && key !== c.column.key) {
                e.preventDefault();
                onMoveColumn(key, c.column.key, side);
              }
            }}
          >
            <span
              className="cl-table__hlabel cl-table__hsort"
              draggable
              title={`Sort by ${c.column.name}`}
              data-testid="table-hlabel"
              onClick={() => onSort(c.column.key)}
              onDragStart={(e) => {
                dragKey.current = c.column.key;
                e.dataTransfer.setData(COLUMN_MIME, c.column.key);
                e.dataTransfer.setData('text/plain', c.column.name);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnd={() => {
                dragKey.current = null;
                setDrop(null);
              }}
            >
              {c.column.name}
            </span>
            {sorted && (
              <span className="cl-table__sort" aria-hidden="true">
                {sorted.dir === 'asc' ? '↑' : '↓'}
              </span>
            )}
            <button
              type="button"
              className="cl-table__hmenu"
              aria-label={`Column menu for ${c.column.name}`}
              aria-haspopup="menu"
              aria-expanded={menu === c.column.key}
              data-testid="table-hmenu"
              onClick={(e) => {
                menuAnchor.current = e.currentTarget;
                setMenu(c.column.key);
              }}
            >
              &#9662;
            </button>
            <span
              className="cl-table__resize"
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize ${c.column.name}`}
              tabIndex={0}
              data-testid="table-resize"
              onPointerDown={(e) => startResize(e, c)}
              onKeyDown={(e) => resizeKey(e, c)}
              onDoubleClick={() => onResize(c.column.key, null, true)}
            />
          </div>
        );
      })}
      {canEditSchema && (
        <button type="button" className="cl-table__hadd" aria-label="Add column" title="Add column" data-testid="table-add-column" onClick={onAddColumn}>
          +
        </button>
      )}
      <Menu
        open={menu !== null}
        onOpenChange={(open) => !open && setMenu(null)}
        anchorRef={menuAnchor}
        items={menu ? menuItems(cols.find((c) => c.column.key === menu)?.column ?? cols[0]!.column) : []}
        placement="bottom-start"
        aria-label="Column actions"
      />
    </div>
  );
}
