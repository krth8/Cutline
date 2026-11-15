/** A scriptable backend for the store tests: every request is logged, handlers may answer late. */
import type { FakePlatform } from '../../testing/fakePlatform';
import type { QueryResult, Row, TableSchema } from '../types';

export interface Call {
  method: string;
  path: string;
  body: any;
}

export type Reply = { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;
export type Handler = (call: Call) => Reply | undefined;

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
}
export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export const schemaOf = (ref: string): TableSchema => ({
  ref,
  name: 'Tasks',
  columns: [
    { key: 'name', name: 'Name', type: 'text', builtin: true },
    { key: 'status', name: 'Status', type: 'status', builtin: true },
    { key: 'priority', name: 'Priority', type: 'priority', builtin: true },
  ],
  titleColumn: 'name',
  capabilities: { create: true, delete: true, hierarchy: true, editSchema: false },
});

export const rowOf = (id: string, name: string, extra: Partial<Row['values']> = {}, ref = 'tasks:p1'): Row => ({
  id,
  tableRef: ref,
  parentId: null,
  childCount: 0,
  values: { name, status: 'todo', priority: 'low', ...extra },
  canEdit: true,
});

export const resultOf = (rows: Row[]): QueryResult => ({ rows, total: rows.length });

export class Backend {
  calls: Call[] = [];
  handlers: Handler[] = [];

  constructor(fake: FakePlatform) {
    fake.fetch = async (path, init) => {
      const call: Call = {
        method: (init?.method ?? 'GET').toUpperCase(),
        path: decodeURIComponent(path),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      this.calls.push(call);
      for (const h of [...this.handlers].reverse()) {
        const reply = h(call);
        if (reply !== undefined) {
          const r = await reply;
          return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
        }
      }
      return new Response(JSON.stringify({ detail: 'Not found' }), { status: 404 });
    };
  }

  /** Answer requests whose "METHOD path" starts with `prefix`. Later handlers win. */
  on(prefix: string, fn: (call: Call) => Reply): this {
    this.handlers.push((call) => (`${call.method} ${call.path}`.startsWith(prefix) ? fn(call) : undefined));
    return this;
  }

  count(prefix: string): number {
    return this.calls.filter((c) => `${c.method} ${c.path}`.startsWith(prefix)).length;
  }
}
