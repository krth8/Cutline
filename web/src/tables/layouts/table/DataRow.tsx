import { memo, type MouseEvent } from 'react';
import { cx } from '../../../ui';
import { CellHost } from '../../cells';
import type { Row } from '../../types';
import type { GridColumn } from './grid';

export interface DataRowProps {
  row: Row;
  depth: number;
  caret: 'none' | 'closed' | 'open';
  loadingKids: boolean;
  cols: readonly GridColumn[];
  selected: boolean;
  /** Rows can be dragged to a new place (the view is not sorted). */
  reorderable: boolean;
  /** Where a row being dragged would land relative to this one. */
  dropSide: 'before' | 'after' | null;
  /** The "add subtask" button is shown. */
  canAddChild: boolean;
  /** 1-based position in the grid, for assistive technology. */
  index: number;
  onSelect(id: string, shift: boolean): void;
  onToggle(id: string): void;
  onEdit(row: Row, key: string, value: unknown): void;
  onOpen(id: string): void;
  onAddChild(row: Row): void;
}

/** One data row of the grid: select box and drag handle, then a cell per column. */
export const DataRow = memo(function DataRow(p: DataRowProps) {
  const { row } = p;
  return (
    <div
      role="row"
      aria-rowindex={p.index}
      aria-selected={p.selected}
      className={cx('cl-table__row', p.selected && 'is-selected', p.dropSide && `is-drop-${p.dropSide}`, p.depth > 0 && 'is-child')}
      data-testid="table-row"
      data-row-id={row.id}
      data-depth={p.depth}
    >
      <div role="gridcell" className="cl-table__lead">
        {p.reorderable && row.canEdit ? (
          <span className="cl-table__grip" draggable data-drag-handle title="Drag to reorder" aria-hidden="true">
            &#8942;&#8942;
          </span>
        ) : (
          <span className="cl-table__grip cl-table__grip--off" aria-hidden="true" />
        )}
        <input
          type="checkbox"
          className="cl-table__check"
          data-testid="table-select-row"
          aria-label="Select row"
          checked={p.selected}
          onChange={() => {}}
          onClick={(e: MouseEvent<HTMLInputElement>) => p.onSelect(row.id, e.shiftKey)}
        />
      </div>
      {p.cols.map((c) => {
        const cell = (
          <CellHost
            column={c.column}
            value={row.values[c.column.key]}
            row={row}
            onChange={(value) => p.onEdit(row, c.column.key, value)}
          />
        );
        if (!c.isTitle) {
          return (
            <div key={c.column.key} role="gridcell" className="cl-table__cell" data-col={c.column.key}>
              {cell}
            </div>
          );
        }
        return (
          <div
            key={c.column.key}
            role="gridcell"
            className="cl-table__cell cl-table__cell--title"
            data-col={c.column.key}
            style={p.depth > 0 ? { paddingLeft: p.depth * 20 } : undefined}
          >
            {p.caret === 'none' ? (
              <span className="cl-table__caret cl-table__caret--off" />
            ) : (
              <button
                type="button"
                className={cx('cl-table__caret', p.caret === 'open' && 'is-open')}
                data-testid="table-expand"
                aria-expanded={p.caret === 'open'}
                aria-label={p.caret === 'open' ? 'Hide subtasks' : 'Show subtasks'}
                onClick={() => p.onToggle(row.id)}
              >
                {p.loadingKids ? '…' : '▸'}
              </button>
            )}
            <div className="cl-table__title">{cell}</div>
            <span className="cl-table__rowtools">
              {p.canAddChild && row.canEdit && (
                <button
                  type="button"
                  className="cl-table__tool"
                  data-testid="table-add-subtask"
                  title="Add subtask"
                  aria-label="Add subtask"
                  onClick={() => p.onAddChild(row)}
                >
                  +
                </button>
              )}
              <button
                type="button"
                className="cl-table__tool"
                data-testid="table-open-row"
                title="Open details"
                aria-label="Open details"
                onClick={() => p.onOpen(row.id)}
              >
                &#8599;
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
});
