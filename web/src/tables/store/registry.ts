/**
 * The shared stores behind useViewQuery: one TableEntry per table ref (schema, reference
 * counted) holding one QueryEntry per distinct query. Components never fetch themselves; they
 * subscribe, and everything with the same ref + query shares one request.
 *
 * Refetch rules (PLAN.md D5): the server runs the query. A live event for the table, a schema
 * change or one of our own mutations schedules a refetch after STORE_CONFIG.refetchDelayMs;
 * several triggers inside that window make one request. At most one request per query is in
 * flight; if something asks for a refetch meanwhile, the running response is discarded and a
 * new request starts (latest wins). The old result stays visible until the new one arrives.
 */
import * as api from '../../api/tables';
import { getPlatform } from '../../platform';
import type { Query, QueryResult, TableSchema } from '../types';
import { applyOp, type Op } from './ops';

export const STORE_CONFIG = {
  /** Wait this long after a trigger before refetching; triggers in the window coalesce. */
  refetchDelayMs: 250,
  /** Keep a cache entry this long after its last subscriber left. */
  disposeDelayMs: 5000,
  /** `updateConfig` saves the view this long after the last change. */
  configSaveDelayMs: 400,
};

export const WATCH_SLOT = 'tables';

export function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/** JSON with sorted keys, so equal queries get equal keys. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Does a change in `eventRef` concern a table opened as `tableRef`? tasks:* sees every project, and vice versa. */
export function refMatches(eventRef: string, tableRef: string): boolean {
  if (eventRef === tableRef) return true;
  return eventRef.startsWith('tasks:') && tableRef.startsWith('tasks:') && (eventRef === 'tasks:*' || tableRef === 'tasks:*');
}

export interface QueryState {
  /** The last server result with pending optimistic changes applied; null until the first response. */
  result: QueryResult | null;
  /** A request is in flight. */
  loading: boolean;
  /** The last request failed (the previous result, if any, is kept). */
  error: Error | null;
  /** A result is shown but a refetch is scheduled or running, or the last refetch failed. */
  stale: boolean;
}

export interface SchemaState {
  schema: TableSchema | null;
  loading: boolean;
  error: Error | null;
}

export const INITIAL_QUERY_STATE: QueryState = { result: null, loading: true, error: null, stale: false };
export const INITIAL_SCHEMA_STATE: SchemaState = { schema: null, loading: true, error: null };

// ---- Pending optimistic ops (shared by all queries) ----

export const pendingOps: Op[] = [];
let opsVersion = 0;

// ---- Registry ----

const tables = new Map<string, TableEntry>();
let liveOff: Array<() => void> = [];
let lastWatch: string | null = null;

function allQueries(): QueryEntry[] {
  return [...tables.values()].flatMap((t) => [...t.queries.values()]);
}

export function addOp(op: Op): void {
  pendingOps.push(op);
  opsVersion++;
  for (const q of allQueries()) q.publish();
}

/** Remove an op (settled or rolled back), optionally folding its effect into the server results first. */
export function settleOp(op: Op, updateBase?: (q: QueryEntry) => QueryResult | null): void {
  const i = pendingOps.indexOf(op);
  if (i >= 0) pendingOps.splice(i, 1);
  opsVersion++;
  for (const q of allQueries()) {
    if (updateBase && q.base) q.base = updateBase(q);
    q.publish();
  }
}

/** Schedule a refetch of every active query whose table is affected by a change in one of `refs`. */
export function invalidate(refs: string[]): void {
  for (const t of tables.values()) {
    if (t.active > 0 && refs.some((r) => refMatches(r, t.ref))) t.scheduleQueries();
  }
}

function onActiveChange(): void {
  syncLive();
  syncWatch();
}

function syncLive(): void {
  const any = [...tables.values()].some((t) => t.active > 0);
  if (any && liveOff.length === 0) {
    const live = getPlatform().live;
    liveOff = [
      live.on('rows_changed', (msg) => {
        if (typeof msg?.tableRef !== 'string') return;
        for (const t of tables.values()) if (t.active > 0 && refMatches(msg.tableRef, t.ref)) t.scheduleQueries();
      }),
      // The user's rights in a project changed: the project options and visible rows of tasks:* change
      live.on('projects_changed', () => {
        const t = tables.get('tasks:*');
        if (t && t.active > 0) {
          t.scheduleSchema();
          t.scheduleQueries();
        }
      }),
      live.on('schema_changed', (msg) => {
        if (typeof msg?.tableRef !== 'string') return;
        for (const t of tables.values()) {
          if (t.active > 0 && refMatches(msg.tableRef, t.ref)) {
            t.scheduleSchema();
            t.scheduleQueries();
          }
        }
      }),
    ];
  } else if (!any && liveOff.length) {
    for (const off of liveOff) off();
    liveOff = [];
  }
}

/**
 * Keep the platform's watch slot on the mounted tables: tasks:<id> watches that project, tbl_<id> of a
 * project watches the table's project (known from its schema; a personal table needs no watch, its
 * events go straight to the owner's tabs), tasks:* switches on the server's all-tasks watch (every
 * project the user may see tasks of).
 */
function syncWatch(): void {
  const platform = getPlatform();
  const projects = new Set<string>();
  let allTasks = false;
  for (const t of tables.values()) {
    if (t.active === 0) continue;
    if (t.ref === 'tasks:*') allTasks = true;
    else if (t.ref.startsWith('tasks:')) projects.add(t.ref.slice('tasks:'.length));
    else if (t.schemaState.schema?.space?.type === 'project') projects.add(t.schemaState.schema.space.projectId);
  }
  const sorted = [...projects].sort();
  const key = sorted.length || allTasks ? `${allTasks ? '*;' : ''}${sorted.join(',')}` : null;
  if (key === lastWatch) return;
  lastWatch = key;
  platform.live.watch(
    WATCH_SLOT,
    key === null ? null : { ...(sorted.length ? { projects: sorted } : {}), ...(allTasks ? { allTasks: true } : {}) },
  );
}

export function getTable(ref: string): TableEntry {
  let t = tables.get(ref);
  if (!t) tables.set(ref, (t = new TableEntry(ref)));
  return t;
}

/** Refetch the schema and every active query of a table now (after this tab changed its columns; the server does not echo events to the sender). */
export function refreshTable(ref: string): void {
  const t = tables.get(ref);
  if (!t) return;
  t.fetchSchema();
  t.scheduleQueries();
}

export function peekTable(ref: string): TableEntry | undefined {
  return tables.get(ref);
}

/** Drop every cache, timer and subscription (tests, platform swaps). */
export function resetTableStores(): void {
  for (const t of tables.values()) t.destroy();
  tables.clear();
  pendingOps.length = 0;
  opsVersion++;
  for (const off of liveOff) off();
  liveOff = [];
  if (lastWatch !== null) {
    lastWatch = null;
    try {
      getPlatform().live.watch(WATCH_SLOT, null);
    } catch {
      /* no live module: nothing to release */
    }
  }
}

// ---- Entries ----

export class QueryEntry {
  base: QueryResult | null = null;
  state: QueryState = INITIAL_QUERY_STATE;
  subs = 0;
  private listeners = new Set<() => void>();
  private inFlight = false;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposeTimer: ReturnType<typeof setTimeout> | null = null;
  private error: Error | null = null;
  private destroyed = false;
  private memo: { base: QueryResult; version: number; out: QueryResult } | null = null;

  constructor(
    readonly table: TableEntry,
    readonly query: Query,
    readonly key: string,
    /** Replaces the table query request (single-row entries, see useRow). */
    private readonly fetcher?: () => Promise<QueryResult>,
  ) {}

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    this.subs++;
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.disposeTimer = null;
    this.table.addActive(1);
    if (this.subs === 1) this.fetchNow(); // also refreshes a cache that sat unwatched
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.listeners.delete(cb);
      this.subs--;
      if (this.subs === 0) {
        this.cancelTimer();
        this.disposeTimer = setTimeout(() => {
          if (this.subs === 0) this.table.removeQuery(this);
        }, STORE_CONFIG.disposeDelayMs);
      }
      this.table.addActive(-1);
    };
  }

  /** The cached result with pending optimistic ops applied; the same object while nothing changed. */
  private display(): QueryResult | null {
    if (!this.base) return null;
    if (this.memo && this.memo.base === this.base && this.memo.version === opsVersion) return this.memo.out;
    let out = this.base;
    for (const op of pendingOps) out = applyOp(out, op, this.query, this.table.ref);
    this.memo = { base: this.base, version: opsVersion, out };
    return out;
  }

  publish(): void {
    if (this.destroyed) return;
    const result = this.display();
    const stale = result !== null && (this.inFlight || this.timer !== null || this.error !== null);
    const s = this.state;
    if (s.result === result && s.loading === this.inFlight && s.error === this.error && s.stale === stale) return;
    this.state = { result, loading: this.inFlight, error: this.error, stale };
    for (const cb of [...this.listeners]) cb();
  }

  /** Refetch soon; triggers inside the window share one request. */
  schedule(): void {
    if (this.destroyed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fetchNow();
    }, STORE_CONFIG.refetchDelayMs);
    this.publish();
  }

  private cancelTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Start a request, or mark the running one as outdated so it is discarded and repeated. */
  fetchNow(): void {
    if (this.destroyed) return;
    this.cancelTimer();
    if (this.inFlight) {
      this.dirty = true;
      return;
    }
    void this.run();
  }

  private async run(): Promise<void> {
    this.inFlight = true;
    this.dirty = false;
    this.publish();
    let result: QueryResult | undefined;
    let error: Error | null = null;
    try {
      result = await (this.fetcher ? this.fetcher() : api.query(this.table.ref, this.query));
    } catch (e) {
      error = toError(e);
    }
    this.inFlight = false;
    if (this.destroyed) return;
    if (this.dirty) {
      void this.run(); // something changed while this request ran: its answer may be outdated
      return;
    }
    if (result) this.base = result;
    this.error = error;
    this.publish();
  }

  /** Resolves with the first result (immediately when cached); rejects on the first error without one. */
  ready(): Promise<QueryResult> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        if (this.state.result) resolve(this.state.result);
        else if (this.state.error) reject(this.state.error);
        else return false;
        return true;
      };
      if (check()) return;
      const off = this.subscribe(() => {
        if (check()) queueMicrotask(off);
      });
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.cancelTimer();
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    this.listeners.clear();
  }
}

export class TableEntry {
  queries = new Map<string, QueryEntry>();
  active = 0;
  schemaState: SchemaState = INITIAL_SCHEMA_STATE;
  private schemaListeners = new Set<() => void>();
  private schemaInFlight = false;
  private schemaDirty = false;
  private schemaTimer: ReturnType<typeof setTimeout> | null = null;
  private disposeTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(readonly ref: string) {}

  addActive(delta: number): void {
    const was = this.active;
    this.active += delta;
    if (this.active > 0) {
      if (this.disposeTimer) clearTimeout(this.disposeTimer);
      this.disposeTimer = null;
    } else if (!this.disposeTimer) {
      this.disposeTimer = setTimeout(() => {
        this.disposeTimer = null;
        if (this.active === 0 && tables.get(this.ref) === this) {
          tables.delete(this.ref);
          this.destroy();
        }
      }, STORE_CONFIG.disposeDelayMs);
    }
    if ((was > 0) !== (this.active > 0)) onActiveChange();
    else syncWatch();
  }

  getQuery(query: Query, key: string, fetcher?: () => Promise<QueryResult>): QueryEntry {
    let q = this.queries.get(key);
    if (!q) this.queries.set(key, (q = new QueryEntry(this, query, key, fetcher)));
    return q;
  }

  removeQuery(q: QueryEntry): void {
    if (this.queries.get(q.key) === q) this.queries.delete(q.key);
    q.destroy();
  }

  scheduleQueries(): void {
    for (const q of this.queries.values()) if (q.subs > 0) q.schedule();
  }

  // ---- schema ----

  subscribeSchema(cb: () => void): () => void {
    this.schemaListeners.add(cb);
    this.addActive(1);
    if (this.schemaListeners.size === 1) this.fetchSchema();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.schemaListeners.delete(cb);
      this.addActive(-1);
    };
  }

  private setSchemaState(next: SchemaState): void {
    this.schemaState = next;
    for (const cb of [...this.schemaListeners]) cb();
  }

  scheduleSchema(): void {
    if (this.destroyed || this.schemaTimer) return;
    this.schemaTimer = setTimeout(() => {
      this.schemaTimer = null;
      this.fetchSchema();
    }, STORE_CONFIG.refetchDelayMs);
  }

  fetchSchema(): void {
    if (this.destroyed) return;
    if (this.schemaTimer) clearTimeout(this.schemaTimer);
    this.schemaTimer = null;
    if (this.schemaInFlight) {
      this.schemaDirty = true;
      return;
    }
    void this.runSchema();
  }

  private async runSchema(): Promise<void> {
    this.schemaInFlight = true;
    this.schemaDirty = false;
    if (!this.schemaState.loading) this.setSchemaState({ ...this.schemaState, loading: true });
    let schema: TableSchema | undefined;
    let error: Error | null = null;
    try {
      schema = await api.getSchema(this.ref);
    } catch (e) {
      error = toError(e);
    }
    this.schemaInFlight = false;
    if (this.destroyed) return;
    if (this.schemaDirty) {
      void this.runSchema();
      return;
    }
    this.setSchemaState({ schema: schema ?? this.schemaState.schema, loading: false, error });
    syncWatch(); // a custom table's project is only known now
  }

  destroy(): void {
    this.destroyed = true;
    if (this.schemaTimer) clearTimeout(this.schemaTimer);
    if (this.disposeTimer) clearTimeout(this.disposeTimer);
    for (const q of this.queries.values()) q.destroy();
    this.queries.clear();
    this.schemaListeners.clear();
  }
}
