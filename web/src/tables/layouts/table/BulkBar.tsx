import { useState } from 'react';
import { Button } from '../../../ui';
import { CellHost } from '../../cells';
import type { Column } from '../../types';

export interface BulkBarProps {
  count: number;
  /** Columns that can be set for all selected rows. */
  columns: readonly Column[];
  onAll(): void;
  onClear(): void;
  onDelete(): void;
  onApply(column: Column, value: unknown): void;
  canDelete: boolean;
}

/** What an unset cell holds for a column type (the starting value of the bulk editor). */
function emptyValue(column: Column): unknown {
  if (column.type === 'checkbox') return false;
  return column.type === 'multiselect' || column.type === 'people' ? [] : null;
}

/** Shown while rows are selected: count, select all / clear, set one column for all of them, delete. */
export function BulkBar({ count, columns, onAll, onClear, onDelete, onApply, canDelete }: BulkBarProps) {
  const [key, setKey] = useState('');
  const column = columns.find((c) => c.key === key);
  return (
    <div className="cl-table__bulk" data-testid="table-bulk-bar" role="toolbar" aria-label="Selected rows">
      <span className="cl-table__bulkcount" data-testid="table-bulk-count">
        {count} selected
      </span>
      <Button size="sm" variant="ghost" onClick={onAll}>
        All
      </Button>
      <Button size="sm" variant="ghost" onClick={onClear}>
        Clear
      </Button>
      <span className="cl-table__bulksep" />
      <label className="cl-table__bulklabel">
        Set
        <select
          className="cl-table__select"
          aria-label="Column to set"
          data-testid="table-bulk-column"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        >
          <option value="">column...</option>
          {columns.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {column && (
        <span className="cl-table__bulkvalue" data-testid="table-bulk-value">
          <CellHost
            key={column.key}
            column={column}
            value={emptyValue(column)}
            onChange={(value) => {
              onApply(column, value);
              setKey('');
            }}
          />
        </span>
      )}
      <span className="cl-table__spacer" />
      {canDelete && (
        <Button size="sm" variant="danger" data-testid="table-bulk-delete" onClick={onDelete}>
          Delete
        </Button>
      )}
    </div>
  );
}
