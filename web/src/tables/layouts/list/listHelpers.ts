import type { Column, Row, TableSchema, View } from '../../types';
import { getCell } from '../../cells';
import { visibleColumns } from '../../viewColumns';

/** Option labels or values that count as "done" when the schema carries no `done` flags (a name match). */
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

function isDoneName(o: { value: string; label: string }): boolean {
  return DONE_NAME.test(o.label.trim()) || DONE_NAME.test(o.value.trim());
}

type Option = NonNullable<Column['options']>[number];

/**
 * The options that count as done. The server flags them (`done: true` or `false` on every option of the
 * status column); a schema without any flag falls back to the name guess.
 */
export function doneOptions(options: Option[]): Option[] {
  return options.some((o) => typeof o.done === 'boolean') ? options.filter((o) => o.done === true) : options.filter(isDoneName);
}

/**
 * How the checkbox maps to data: the status column's done option (by flag, else by name) and the first option
 * that is not done; else the first editable checkbox column; else undefined (the checkbox is disabled).
 */
export function doneModel(schema: TableSchema): DoneModel | undefined {
  const status = schema.columns.find((c) => c.key === 'status' && c.type === 'status') ?? schema.columns.find((c) => c.type === 'status');
  if (status) {
    const options = status.options ?? [];
    const doneList = doneOptions(options);
    const doneValues = new Set(doneList.map((o) => o.value));
    const done = doneList[0];
    const open = options.find((o) => !doneValues.has(o.value));
    if (done) {
      return {
        column: status,
        doneValue: done.value,
        openValue: open ? open.value : null,
        isDone: (row) => doneValues.has(row.values[status.key] as string),
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

/**
 * The width (px) of a secondary column's slot. Every row gives each secondary column the same slot, so the
 * values stand in columns down the list (a status under a status) instead of wherever the row's text ends.
 */
export function slotWidth(column: Column): number {
  switch (column.type) {
    case 'checkbox': return 28;
    case 'number': return column.config?.currency ? 120 : 72;
    case 'image': return 48;
    case 'date': return 96;
    case 'priority': return 84;
    case 'status': case 'select': return 124;
    case 'person': return 120;
    default: return 140;
  }
}

export function hasValue(column: Column, value: unknown): boolean {
  return !getCell(column.type).isEmpty(value);
}
