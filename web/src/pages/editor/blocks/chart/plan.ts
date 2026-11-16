/**
 * The request a chart sends and how its answer is read. Main bundle only (the node in the editor chunk never
 * imports this). One grouped query: the view's filter and search, `groupBy` the chosen column (with
 * `groupBucket` for dates), the measure as a per-group summary, and `limit: 0` so no row crosses the wire.
 */
import type { Column, Query, QueryResult, TableSchema } from '../../../../tables/types';
import { summaryQuery } from '../summary/plan';
import { buildPoints, canGroupBy, canMeasure, needsColumn, type ChartAttrs, type Point } from './model';

export type ChartPlan =
  | { ok: true; extra: Query; groupColumn: Column; measureColumn: Column | null; read(result: QueryResult): Point[] }
  | { ok: false; reason: string };

/** Check the settings against the table's columns and plan the request; the reason names the setting to fix. */
export function planChart(schema: TableSchema, attrs: Pick<ChartAttrs, 'groupBy' | 'fn' | 'column' | 'bucket'>): ChartPlan {
  if (!attrs.groupBy) return { ok: false, reason: 'Group by: choose a column' };
  const groupColumn = schema.columns.find((c) => c.key === attrs.groupBy);
  if (!groupColumn) return { ok: false, reason: 'Group by: this column no longer exists. Choose another one.' };
  if (!canGroupBy(groupColumn.type)) return { ok: false, reason: `Group by: ${groupColumn.name} cannot be charted. Choose another column.` };

  let measureColumn: Column | null = null;
  if (needsColumn(attrs.fn)) {
    if (!attrs.column) return { ok: false, reason: 'Measure: choose a number column' };
    measureColumn = schema.columns.find((c) => c.key === attrs.column) ?? null;
    if (!measureColumn) return { ok: false, reason: 'Measure: this column no longer exists. Choose another one.' };
    if (!canMeasure(measureColumn.type)) return { ok: false, reason: `Measure: ${measureColumn.name} is not a number column.` };
  }

  const extra: Query = { groupBy: groupColumn.key };
  if (groupColumn.type === 'date') extra.groupBucket = attrs.bucket;
  if (measureColumn) extra.summaries = { [measureColumn.key]: attrs.fn as 'sum' | 'avg' | 'min' | 'max' };
  return { ok: true, extra, groupColumn, measureColumn, read: (result) => buildPoints(result, groupColumn, attrs) };
}

/** The view's filter, search and hierarchy plus the grouping; the view's own sort, grouping and paging are dropped. */
export const chartQuery = summaryQuery;
