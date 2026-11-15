import type { Column, Row, TableSchema, View } from '../../types';
import { getCell } from '../../cells';
import { visibleColumns } from '../../viewColumns';

/** Option labels or values that count as "done". The schema has no done flag, so this is a name match. */
const DONE_NAME = /^(done|completed?|finished|closed)$/i;

export interface DoneModel {
  /** The column the checkbox writes to. */
  column: Column;
  /** Value written when the box is checked. */
  doneValue: unknown;
  /** Value written when the box is cleared. */
  openValue: unknown;
  isDone(row: Row): boolean;
}

function isDoneOption(o: { value: string; label: string }): boolean {
  return DONE_NAME.test(o.label.trim()) || DONE_NAME.test(o.value.trim());
}

/**
 * How the checkbox maps to data: the status column's "done" option (found by name) and the first option
 * that is not done; else the first editable checkbox column; else undefined (the checkbox is disabled).
 */
export function doneModel(schema: TableSchema): DoneModel | undefined {
  const status = schema.columns.find((c) => c.key === 'status' && c.type === 'status') ?? schema.columns.find((c) => c.type === 'status');
  if (status) {
    const options = status.options ?? [];
    const done = options.find(isDoneOption);
    const open = options.find((o) => !isDoneOption(o));
    if (done) {
      return {
        column: status,
        doneValue: done.value,
        openValue: open ? open.value : null,
        isDone: (row) => row.values[status.key] === done.value,
      };
    }
  }
  const box = schema.columns.find((c) => c.type === 'checkbox' && !c.readonly);
  if (box) return { column: box, doneValue: true, openValue: false, isDone: (row) => row.values[box.key] === true };
  return undefined;
}

/** Columns shown on the right of a row: `list.secondaryColumns` when set, else the first visible ones. */
export function secondaryColumns(schema: TableSchema, config: View['config'], limit = 3): Column[] {
  const byKey = new Map(schema.columns.map((c) => [c.key, c]));
  const chosen = config.list?.secondaryColumns ?? [];
  if (chosen.length) {
    return chosen.map((k) => byKey.get(k)).filter((c): c is Column => !!c && c.key !== schema.titleColumn);
  }
  return visibleColumns(schema, config)
    .filter((c) => c.key !== schema.titleColumn && c.type !== 'longtext')
    .slice(0, limit);
}

/** Whether a row belongs to a group (same rule the server uses for group keys). */
export function rowInGroup(value: unknown, key: string | null): boolean {
  const atoms = Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value];
  if (key === null) return atoms.length === 0;
  if (typeof value === 'boolean') return String(value) === key;
  return atoms.some((a) => String(a) === key);
}

export function hasValue(column: Column, value: unknown): boolean {
  return !getCell(column.type).isEmpty(value);
}
