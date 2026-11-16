import { useMemo, type ReactNode } from 'react';
import { ApiError } from '../../../../api/http';
import { useTableSchema, useViewQuery } from '../../../../tables/store';
import type { TableSchema } from '../../../../tables/types';
import { useViewAccess, type ViewWithOwner } from '../viewBlock/useViewAccess';
import { planSummary, summaryQuery } from './plan';
import type { SummaryFn } from './model';

/** What a summary can be showing right now. */
export type SummaryState =
  | { kind: 'none' } // no view chosen yet
  | { kind: 'loading' }
  | { kind: 'ready'; value: number | string | null }
  | { kind: 'denied' } // no access to the view or its table
  | { kind: 'gone' } // the view was deleted
  | { kind: 'problem'; reason: string } // the settings do not fit the table (column removed, wrong type ...)
  | { kind: 'error'; message: string };

const isDenied = (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 403);
const isGone = (e: unknown) => e instanceof ApiError && e.status === 404;

/**
 * Resolves the value of one summary and hands it to `children`. Hooks cannot be skipped, so the work is split
 * in steps that each render the next one once their input exists: the view (access check, follows
 * `view_changed`), the table's schema, then the query through the row store. The store shares equal queries
 * between blocks, coalesces `rows_changed` events and refetches, so the number follows the data live.
 */
export function SummaryData(props: { viewId: string | null; fn: SummaryFn; column: string | null; children(state: SummaryState): ReactNode }) {
  const { viewId, fn, column, children } = props;
  if (!viewId) return <>{children({ kind: 'none' })}</>;
  return (
    <WithView viewId={viewId} fn={fn} column={column}>
      {children}
    </WithView>
  );
}

function WithView({ viewId, fn, column, children }: { viewId: string; fn: SummaryFn; column: string | null; children(state: SummaryState): ReactNode }) {
  const access = useViewAccess(viewId);
  switch (access.state) {
    case 'loading':
      return <>{children({ kind: 'loading' })}</>;
    case 'denied':
      return <>{children({ kind: 'denied' })}</>;
    case 'gone':
      return <>{children({ kind: 'gone' })}</>;
    case 'error':
      return <>{children({ kind: 'error', message: access.message })}</>;
    default:
      return (
        <WithSchema view={access.view} fn={fn} column={column}>
          {children}
        </WithSchema>
      );
  }
}

function WithSchema({ view, fn, column, children }: { view: ViewWithOwner; fn: SummaryFn; column: string | null; children(state: SummaryState): ReactNode }) {
  const schemaState = useTableSchema(view.tableRef);
  if (schemaState.error) return <>{children(failure(schemaState.error))}</>;
  if (!schemaState.schema) return <>{children({ kind: 'loading' })}</>;
  return (
    <WithResult view={view} schema={schemaState.schema} fn={fn} column={column}>
      {children}
    </WithResult>
  );
}

export function failure(e: Error): Extract<SummaryState, { kind: 'denied' | 'gone' | 'error' }> {
  if (isDenied(e)) return { kind: 'denied' };
  if (isGone(e)) return { kind: 'gone' };
  return { kind: 'error', message: e.message };
}

function WithResult({
  view,
  schema,
  fn,
  column,
  children,
}: {
  view: ViewWithOwner;
  schema: TableSchema;
  fn: SummaryFn;
  column: string | null;
  children(state: SummaryState): ReactNode;
}) {
  const plan = useMemo(() => planSummary(schema, fn, column), [schema, fn, column]);
  const query = useMemo(() => summaryQuery(view.config?.query, plan.ok ? plan.extra : {}), [view.config?.query, plan]);
  // A plan that does not fit the table asks for the plain count: the hook runs either way, the result is not shown
  const descriptor = useMemo(
    () => ({ id: view.id, tableRef: view.tableRef, layout: view.layout, name: view.name, config: { query } }),
    [view.id, view.tableRef, view.layout, view.name, query],
  );
  const data = useViewQuery(descriptor);

  if (!plan.ok) return <>{children({ kind: 'problem', reason: plan.reason })}</>;
  if (data.error && !data.result) return <>{children(failure(data.error))}</>;
  if (!data.result) return <>{children({ kind: 'loading' })}</>;
  return <>{children({ kind: 'ready', value: plan.read(data.result) })}</>;
}
