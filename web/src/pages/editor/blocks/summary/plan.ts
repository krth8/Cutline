/**
 * The request a summary sends and how its answer is read. Main bundle only (it uses the layouts' done
 * model, which pulls in the cells); the node in the editor chunk never imports this.
 */
import { doneModel } from '../../../../tables/layouts/list/listHelpers';
import type { Query, QueryResult, Row, TableSchema } from '../../../../tables/types';
import { FN_LABELS, fnFitsColumn, type SummaryFn } from './model';

/** What a summary asks of the server (the part added to the view's filter) and how it reads the answer. */
export type SummaryPlan =
  | { ok: true; extra: Query; read(result: QueryResult): number | string | null }
  | { ok: false; reason: string };

/**
 * Plan the request for `fn` over a table. Only the totals and the summaries are asked for (`limit: 0`
 * returns no rows), so the server does the counting and no row crosses the wire.
 *  - count: `total` of the filtered result.
 *  - the column functions: one `summaries` entry.
 *  - percentDone: with a status column, a count grouped by status (the groups sum to `total`) and the groups
 *    that `doneModel` calls done are added up; with a checkbox as done flag, the engine's `percentChecked`.
 */
export function planSummary(schema: TableSchema, fn: SummaryFn, column: string | null): SummaryPlan {
  if (fn === 'count') return { ok: true, extra: {}, read: (r) => r.total };
  if (fn === 'percentDone') {
    const model = doneModel(schema);
    if (!model) return { ok: false, reason: 'This table has no status or checkbox column to tell what is done' };
    const key = model.column.key;
    if (model.column.type === 'checkbox') {
      return { ok: true, extra: { summaries: { [key]: 'percentChecked' } }, read: (r) => r.summaries?.[key] ?? null };
    }
    return {
      ok: true,
      extra: { groupBy: key },
      read: (r) => {
        if (!r.total) return null;
        let done = 0;
        for (const g of r.groups ?? []) {
          if (g.key !== null && model.isDone({ id: '', tableRef: schema.ref, values: { [key]: g.key }, canEdit: false } as Row)) done += g.count;
        }
        return (100 * done) / r.total;
      },
    };
  }
  if (!column) return { ok: false, reason: 'Choose a column' };
  const col = schema.columns.find((c) => c.key === column);
  if (!col) return { ok: false, reason: 'This column no longer exists' };
  if (!fnFitsColumn(fn, col.type)) return { ok: false, reason: `${FN_LABELS[fn]} does not work on this column` };
  return { ok: true, extra: { summaries: { [column]: fn } }, read: (r) => r.summaries?.[column] ?? null };
}

/** The view's filter, search and hierarchy plus what the summary needs; sort, grouping and paging are dropped. */
export function summaryQuery(viewQuery: Query | undefined, extra: Query): Query {
  const q: Query = {};
  if (viewQuery?.filter) q.filter = viewQuery.filter;
  if (viewQuery?.search) q.search = viewQuery.search;
  if (viewQuery && 'parentId' in viewQuery) q.parentId = viewQuery.parentId ?? null;
  return { ...q, ...extra, limit: 0 };
}
