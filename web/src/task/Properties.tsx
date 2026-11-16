import { useEffect, useState } from 'react';
import { CellHost } from '../tables/cells';
import { hasValue } from '../tables/layouts/list/listHelpers';
import type { Column, Row } from '../tables/types';
import { formatDay } from './format';

/** Columns that are not properties: the name is the title, the description is replaced by the page body. */
const NOT_PROPERTIES = new Set(['name', 'description']);
/** Read-only system values: shown as a muted line under the properties, not as rows. */
const SYSTEM = new Set(['createdAt', 'createdBy']);

export function propertyColumns(columns: Column[]): Column[] {
  return columns.filter((c) => !NOT_PROPERTIES.has(c.key) && c.key !== 'project');
}

/** "Created by Anna · 15 Nov 2026" (parts that are not known are left out); empty when nothing is known. */
export function createdLine(columns: Column[], row: Row): string {
  const who = row.values.createdBy as string | null | undefined;
  const name = who ? columns.find((c) => c.key === 'createdBy')?.options?.find((o) => o.value === who)?.label : undefined;
  const when = formatDay(row.values.createdAt);
  if (!name && !when) return '';
  return [name ? `Created by ${name}` : 'Created', when].filter(Boolean).join(' · ');
}

function Property({ column, row, onChange }: { column: Column; row: Row; onChange: (key: string, value: unknown) => void }) {
  return (
    <div className="cl-props__row" data-column={column.key}>
      <span className="cl-props__label" title={column.name}>
        {column.name}
      </span>
      <div className="cl-props__value">
        <CellHost column={column} value={row.values[column.key]} row={row} onChange={(value) => onChange(column.key, value)} />
      </div>
    </div>
  );
}

/**
 * The properties of a row as one compact list: the ones that have a value come first, the empty ones sit behind
 * "Add property" so the panel is not a form full of dashes. A property stays in place once it has shown a value
 * (clearing it does not make it jump). Edits go through `onChange`, which the panel sends to the table API
 * (optimistic, rolled back with a toast on failure). Read-only system values end the list as a muted line.
 */
export function Properties({ columns, row, onChange }: { columns: Column[]; row: Row; onChange: (key: string, value: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<Set<string>>(() => new Set());
  const all = propertyColumns(columns).filter((c) => !SYSTEM.has(c.key));
  const filled = all.filter((c) => hasValue(c, row.values[c.key])).map((c) => c.key);
  const filledKey = filled.join('|');

  // Remember every property that has had a value, so editing one does not move it
  useEffect(() => {
    setShown((prev) => (filled.every((k) => prev.has(k)) ? prev : new Set([...prev, ...filled])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filledKey]);

  const visible = all.filter((c) => shown.has(c.key) || filled.includes(c.key));
  const empty = all.filter((c) => !visible.includes(c));
  const canAdd = row.canEdit && empty.length > 0;
  const footer = createdLine(columns, row);

  return (
    <div className="cl-props" data-testid="task-properties">
      {(canAdd && open ? all : visible).map((c) => (
        <Property key={c.key} column={c} row={row} onChange={onChange} />
      ))}
      {canAdd ? (
        <button
          type="button"
          className="cl-props__more"
          aria-expanded={open}
          title={open ? 'Hide the empty properties' : `Show the ${empty.length} empty ${empty.length === 1 ? 'property' : 'properties'}`}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Hide empty' : '＋ Add property'}
          {open ? null : <span className="cl-props__count">{empty.length}</span>}
        </button>
      ) : null}
      {footer ? (
        <p className="cl-props__footer" data-testid="task-created">
          {footer}
        </p>
      ) : null}
    </div>
  );
}
