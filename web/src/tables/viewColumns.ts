import type { Column, TableSchema, View } from './types';

export interface ViewColumn {
  column: Column;
  width?: number;
  hidden: boolean;
}

/**
 * Every column of the table in the view's display order: first the ones in `config.columns` (in that
 * order), then the columns the view does not mention (shown, in schema order). Unknown keys are dropped.
 */
export function orderedColumns(schema: TableSchema, config: View['config']): ViewColumn[] {
  const byKey = new Map(schema.columns.map((c) => [c.key, c]));
  const out: ViewColumn[] = [];
  const seen = new Set<string>();
  for (const entry of config.columns ?? []) {
    const column = byKey.get(entry.key);
    if (!column || seen.has(entry.key)) continue;
    seen.add(entry.key);
    out.push({ column, ...(entry.width !== undefined ? { width: entry.width } : {}), hidden: !!entry.hidden });
  }
  for (const column of schema.columns) {
    if (!seen.has(column.key)) out.push({ column, hidden: false });
  }
  return out;
}

/** The columns a layout should show, in order: `orderedColumns` without the hidden ones. */
export function visibleColumns(schema: TableSchema, config: View['config']): Column[] {
  return orderedColumns(schema, config)
    .filter((c) => !c.hidden)
    .map((c) => c.column);
}
