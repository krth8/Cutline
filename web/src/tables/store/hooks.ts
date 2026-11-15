/**
 * React bindings of the store (PLAN.md 5.6, LayoutProps).
 *
 *   useTableSchema(ref)          the cached schema of a table
 *   useViewQuery(descriptor)     schema + result + actions for a view you already hold
 *   useView(viewId)              the same, with the view loaded from / saved to the ViewSource
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import * as api from '../../api/tables';
import { getPlatform } from '../../platform';
import { buildRoute, parseRoute } from '../../router';
import type { LayoutProps, Query, QueryResult, Row, TableSchema, View } from '../types';
import * as mutations from './mutations';
import {
  getTable,
  INITIAL_QUERY_STATE,
  INITIAL_SCHEMA_STATE,
  peekTable,
  STORE_CONFIG,
  stableStringify,
  toError,
  type QueryState,
  type SchemaState,
} from './registry';
import { getViewSource, type ViewDescriptor } from './viewSource';

// ---- schema ----

export function useTableSchema(ref: string | null): SchemaState {
  const subscribe = useCallback(
    (cb: () => void) => (ref ? getTable(ref).subscribeSchema(cb) : () => {}),
    [ref],
  );
  const getSnapshot = useCallback(() => (ref ? (peekTable(ref)?.schemaState ?? INITIAL_SCHEMA_STATE) : INITIAL_SCHEMA_STATE), [ref]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---- query ----

/** One shared, reference-counted query; the state of the entry for `ref` + `query`. */
function useQueryState(ref: string | null, query: Query): QueryState {
  const key = stableStringify(query);
  const queryRef = useRef(query);
  queryRef.current = query;
  const subscribe = useCallback(
    (cb: () => void) => (ref ? getTable(ref).getQuery(queryRef.current, key).subscribe(cb) : () => {}),
    [ref, key],
  );
  const getSnapshot = useCallback(
    () => (ref ? (peekTable(ref)?.queries.get(key)?.state ?? INITIAL_QUERY_STATE) : INITIAL_QUERY_STATE),
    [ref, key],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ---- single row ----

export interface RowState {
  /** The row with pending optimistic changes applied; null before the first answer and after a delete. */
  row: Row | null;
  /** No answer yet. */
  loading: boolean;
  /** The last request failed (an ApiError with status 403 or 404 means the row is gone or not readable). */
  error: Error | null;
}

/** An empty-looking query that never accepts optimistic creates (a limit stops them) and keys the entry. */
const ROW_QUERY: Query = { limit: 1, offset: 0 };

/**
 * One row of a table by id. It lives in the same registry as view queries: optimistic edits show at
 * once, `rows_changed` and `schema_changed` refetch it, and the live watch follows the mounted table.
 */
export function useRow(ref: string | null, rowId: string | null): RowState {
  const active = ref !== null && rowId !== null;
  const key = `row:${rowId}`;
  const fetcher = useCallback(
    async (): Promise<QueryResult> => ({ rows: [await api.getRow(ref!, rowId!)], total: 1 }),
    [ref, rowId],
  );
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const subscribe = useCallback(
    (cb: () => void) => (active ? getTable(ref!).getQuery(ROW_QUERY, key, () => fetcherRef.current()).subscribe(cb) : () => {}),
    [active, ref, key],
  );
  const getSnapshot = useCallback(
    () => (active ? (peekTable(ref!)?.queries.get(key)?.state ?? INITIAL_QUERY_STATE) : INITIAL_QUERY_STATE),
    [active, ref, key],
  );
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useMemo(
    () => ({ row: state.result?.rows[0] ?? null, loading: active && state.result === null && state.error === null, error: state.error }),
    [state, active],
  );
}

export interface ViewQueryData {
  schema: TableSchema | null;
  /** Null only while `useView` is still loading the view. */
  view: View | null;
  /** The last result; while the query changed and the new one is on its way, the previous one stays. */
  result: QueryResult | null;
  /** No result for the current query has arrived yet. */
  loading: boolean;
  /** A result is shown but a refetch is scheduled, running or failed. */
  refreshing: boolean;
  error: Error | null;
  actions: LayoutProps['actions'];
  /** Refetch now (e.g. a "retry" button after an error). */
  reload(): void;
}

/** The data part of LayoutProps once everything it needs has arrived, else null. */
export function toLayoutProps(data: ViewQueryData): LayoutProps | null {
  if (!data.schema || !data.view || !data.result) return null;
  return { schema: data.schema, view: data.view, result: data.result, loading: data.loading, actions: data.actions };
}

const viewOf = (d: ViewDescriptor): View => ({ id: d.id, tableRef: d.tableRef, name: d.name ?? '', layout: d.layout, config: d.config });

function openRow(id: string): void {
  const route = parseRoute(window.location.pathname + window.location.search);
  if (route.kind === 'notFound') {
    const url = new URL(window.location.href);
    url.searchParams.set('task', id);
    getPlatform().navigate(url.pathname + url.search);
  } else {
    getPlatform().navigate(buildRoute({ ...route, task: id }));
  }
}

function useViewData(descriptor: ViewDescriptor | null, updateConfig: (patch: Partial<View['config']>) => void): ViewQueryData {
  const ref = descriptor?.tableRef ?? null;
  const query = descriptor?.config.query ?? EMPTY_QUERY;
  const queryState = useQueryState(ref, query);
  const schemaState = useTableSchema(ref);

  // Keep showing the previous result while a changed query loads (no flicker)
  const retained = useRef<{ ref: string | null; result: QueryResult | null }>({ ref, result: null });
  if (retained.current.ref !== ref) retained.current = { ref, result: null };
  if (queryState.result) retained.current.result = queryState.result;
  const result = queryState.result ?? retained.current.result;

  const latest = useRef({ ref, query, updateConfig });
  latest.current = { ref, query, updateConfig };

  const actions = useMemo<LayoutProps['actions']>(
    () => ({
      updateRow: (id, values) => mutations.updateRow(latest.current.ref!, id, values),
      createRow: (values, opts) => mutations.createRow(latest.current.ref!, values, opts),
      deleteRows: (ids) => mutations.deleteRows(latest.current.ref!, ids),
      reorder: (ids, before) => mutations.reorder(latest.current.ref!, ids, before),
      openRow,
      updateConfig: (patch) => latest.current.updateConfig(patch),
      loadChildren: (parentId) => loadChildren(latest.current.ref!, latest.current.query, parentId),
      moveRow: (id, parentId) => mutations.moveRow(latest.current.ref!, id, parentId),
    }),
    [],
  );

  const reload = useCallback(() => {
    const { ref: r, query: q } = latest.current;
    if (r) getTable(r).getQuery(q, stableStringify(q)).fetchNow();
  }, []);

  return {
    schema: schemaState.schema,
    view: descriptor ? viewOf(descriptor) : null,
    result,
    loading: queryState.result === null && queryState.error === null && ref !== null,
    refreshing: queryState.stale,
    error: queryState.error ?? schemaState.error,
    actions,
    reload,
  };
}

const EMPTY_QUERY: Query = {};

/** Children of a row, fetched through the store (shared, cached for a while, patched by mutations). */
async function loadChildren(ref: string, viewQuery: Query, parentId: string): Promise<Row[]> {
  const query: Query = { ...(viewQuery.sort ? { sort: viewQuery.sort } : {}), parentId };
  const entry = getTable(ref).getQuery(query, stableStringify(query));
  const result = await entry.ready();
  return result.rows;
}

/** Everything except loading and saving the view: for a view you already hold (and tests). */
export function useViewQuery(
  descriptor: ViewDescriptor,
  options: { updateConfig?: (patch: Partial<View['config']>) => void } = {},
): ViewQueryData & { view: View } {
  const data = useViewData(descriptor, options.updateConfig ?? noop);
  return data as ViewQueryData & { view: View };
}

const noop = () => {};

// ---- useView ----

type Config = View['config'];

export function useView(viewId: string): ViewQueryData {
  const source = getViewSource();
  const [remote, setRemote] = useState<{ id: string; descriptor: ViewDescriptor | null; error: Error | null }>({
    id: viewId,
    descriptor: null,
    error: null,
  });
  // Config changes not yet confirmed by the source (waiting for the debounce, or being saved)
  const [overlay, setOverlay] = useState<Partial<Config>>({});
  const unsaved = useRef<Partial<Config>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(
    (id: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      const patch = unsaved.current;
      if (Object.keys(patch).length === 0) return;
      unsaved.current = {};
      const settle = () =>
        setOverlay((o) => Object.fromEntries(Object.entries(o).filter(([k, v]) => (patch as Record<string, unknown>)[k] !== v)) as Partial<Config>);
      source.update(id, { config: patch }).then(settle, (e) => {
        settle();
        getPlatform().toast('error', toError(e).message);
      });
    },
    [source],
  );

  useEffect(() => {
    let cancelled = false;
    setRemote({ id: viewId, descriptor: null, error: null });
    setOverlay({});
    const off = source.subscribe(viewId, (d) => {
      if (!cancelled) setRemote({ id: viewId, descriptor: d, error: null });
    });
    source.get(viewId).then(
      (d) => {
        if (!cancelled) setRemote((r) => (r.descriptor ? r : { id: viewId, descriptor: d, error: null }));
      },
      (e) => {
        if (!cancelled) setRemote({ id: viewId, descriptor: null, error: toError(e) });
      },
    );
    return () => {
      cancelled = true;
      off();
      flush(viewId); // do not lose the last change
    };
  }, [viewId, source, flush]);

  const updateConfig = useCallback(
    (patch: Partial<Config>) => {
      unsaved.current = { ...unsaved.current, ...patch };
      setOverlay((o) => ({ ...o, ...patch }));
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => flush(viewId), STORE_CONFIG.configSaveDelayMs);
    },
    [viewId, flush],
  );

  const descriptor = useMemo<ViewDescriptor | null>(() => {
    const d = remote.id === viewId ? remote.descriptor : null;
    return d ? { ...d, config: { ...d.config, ...overlay } } : null;
  }, [remote, viewId, overlay]);

  const data = useViewData(descriptor, updateConfig);
  return remote.error && remote.id === viewId ? { ...data, error: remote.error, loading: false } : data;
}
