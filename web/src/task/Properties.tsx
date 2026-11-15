import { CellHost } from '../tables/cells';
import type { Column, Row } from '../tables/types';

/** Columns that are not properties: the name is the title, the description is replaced by the page body. */
const NOT_PROPERTIES = new Set(['name', 'description']);

export function propertyColumns(columns: Column[]): Column[] {
  return columns.filter((c) => !NOT_PROPERTIES.has(c.key) && c.key !== 'project');
}

/**
 * Every column of the row's table as a label and a cell. Edits go through `onChange`, which the panel
 * sends to the table API (optimistic, rolled back with a toast on failure).
 */
export function Properties({ columns, row, onChange }: { columns: Column[]; row: Row; onChange: (key: string, value: unknown) => void }) {
  return (
    <div className="cl-props" data-testid="task-properties">
      {propertyColumns(columns).map((column) => (
        <div key={column.key} className="cl-props__row" data-column={column.key}>
          <span className="cl-props__label" title={column.name}>
            {column.name}
          </span>
          <div className="cl-props__value">
            <CellHost column={column} value={row.values[column.key]} row={row} onChange={(value) => onChange(column.key, value)} />
          </div>
        </div>
      ))}
    </div>
  );
}
