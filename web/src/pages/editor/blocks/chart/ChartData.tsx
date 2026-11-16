import { useMemo, type ReactNode } from 'react';
import { useTableSchema, useViewQuery } from '../../../../tables/store';
import type { Column, TableSchema } from '../../../../tables/types';
import { useViewAccess, type ViewWithOwner } from '../viewBlock/useViewAccess';
import { failure } from '../summary/SummaryData';
import type { ChartAttrs, Point } from './model';
import { chartQuery, planChart } from './plan';

/** What a chart can be showing right now. */
export type ChartState =
  | { kind: 'none' } // no view chosen yet
  | { kind: 'loading' }
  | { kind: 'ready'; points: Point[]; total: number; groupColumn: Column; measureColumn: Column | null }
  | { kind: 'denied' } // no access to the view or its table
  | { kind: 'gone' } // the view was deleted
  | { kind: 'problem'; reason: string } // the settings do not fit the table (column removed, wrong type ...)
  | { kind: 'error'; message: string };

type DataAttrs = Pick<ChartAttrs, 'groupBy' | 'fn' | 'column' | 'bucket'>;

/**
 * Resolves the data of one chart and hands it to `children`. Same steps as the summary: the view (access
 * check, follows `view_changed`), the table's schema, then one grouped query through the row store, which
 * shares equal queries between blocks and refetches on `rows_changed`.
 */
export function ChartData(props: { viewId: string | null; attrs: DataAttrs; children(state: ChartState): ReactNode }) {
  const { viewId, attrs, children } = props;
  if (!viewId) return <>{children({ kind: 'none' })}</>;
  return (
    <WithView viewId={viewId} attrs={attrs}>
      {children}
    </WithView>
  );
}

function WithView({ viewId, attrs, children }: { viewId: string; attrs: DataAttrs; children(state: ChartState): ReactNode }) {
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
        <WithSchema view={access.view} attrs={attrs}>
          {children}
        </WithSchema>
      );
  }
}

function WithSchema({ view, attrs, children }: { view: ViewWithOwner; attrs: DataAttrs; children(state: ChartState): ReactNode }) {
  const schemaState = useTableSchema(view.tableRef);
  if (schemaState.error) return <>{children(failure(schemaState.error))}</>;
  if (!schemaState.schema) return <>{children({ kind: 'loading' })}</>;
  return (
    <WithResult view={view} schema={schemaState.schema} attrs={attrs}>
      {children}
    </WithResult>
  );
}

function WithResult({
  view,
  schema,
  attrs,
  children,
}: {
  view: ViewWithOwner;
  schema: TableSchema;
  attrs: DataAttrs;
  children(state: ChartState): ReactNode;
}) {
  const { groupBy, fn, column, bucket } = attrs;
  const plan = useMemo(() => planChart(schema, { groupBy, fn, column, bucket }), [schema, groupBy, fn, column, bucket]);
  const query = useMemo(() => chartQuery(view.config?.query, plan.ok ? plan.extra : {}), [view.config?.query, plan]);
  // A plan that does not fit the table asks for the plain count: the hook runs either way, the result is not shown
  const descriptor = useMemo(
    () => ({ id: view.id, tableRef: view.tableRef, layout: view.layout, name: view.name, config: { query } }),
    [view.id, view.tableRef, view.layout, view.name, query],
  );
  const data = useViewQuery(descriptor);

  if (!plan.ok) return <>{children({ kind: 'problem', reason: plan.reason })}</>;
  if (data.error && !data.result) return <>{children(failure(data.error))}</>;
  if (!data.result) return <>{children({ kind: 'loading' })}</>;
  return (
    <>
      {children({
        kind: 'ready',
        points: plan.read(data.result),
        total: data.result.total,
        groupColumn: plan.groupColumn,
        measureColumn: plan.measureColumn,
      })}
    </>
  );
}
