import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatform } from '../../platform';
import { createFakePlatform, type FakePlatform } from '../../testing/fakePlatform';
import type { Query, Row } from '../types';
import {
  createMemoryViewSource,
  projectsForCreate,
  resetStores,
  setViewSource,
  STORE_CONFIG,
  useTableSchema,
  useView,
  useViewQuery,
  type ViewDescriptor,
} from './index';
import { Backend, deferred, resultOf, rowOf, schemaOf } from './store.testutil';

let fake: FakePlatform;
let backend: Backend;

const flush = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const desc = (tableRef = 'tasks:p1', query: Query = {}, id = 'v1'): ViewDescriptor => ({
  id,
  tableRef,
  layout: 'table',
  config: { query },
});

/** A server holding `rows`; query and schema answer from it. */
function serve(rows: Row[], ref = 'tasks:p1') {
  const state = { rows };
  backend.on(`POST /api/tables/${ref}/query`, () => ({ body: resultOf(state.rows) }));
  backend.on(`GET /api/tables/${ref}/schema`, () => ({ body: schemaOf(ref) }));
  return state;
}

const queries = (ref = 'tasks:p1') => backend.count(`POST /api/tables/${ref}/query`);
const nameOf = (r: { current: { result: { rows: Row[] } | null } }, id: string) =>
  r.current.result?.rows.find((x) => x.id === id)?.values.name;

async function mount(d: ViewDescriptor = desc()) {
  const hook = renderHook(() => useViewQuery(d));
  await flush();
  return hook;
}

beforeEach(() => {
  vi.useFakeTimers();
  fake = createFakePlatform();
  setPlatform(fake);
  backend = new Backend(fake);
  setViewSource(createMemoryViewSource());
  resetStores();
});

afterEach(() => {
  resetStores();
  setViewSource(null);
  setPlatform(null);
  vi.useRealTimers();
});

describe('shared fetching', () => {
  it('fetches once for two hooks on the same view and shares the state', async () => {
    serve([rowOf('t1', 'One')]);
    const d = desc();
    const a = renderHook(() => useViewQuery(d));
    const b = renderHook(() => useViewQuery({ ...d, id: 'other-view', config: { query: {} } }));
    await flush();
    expect(queries()).toBe(1);
    expect(backend.count('GET /api/tables/tasks:p1/schema')).toBe(1);
    expect(a.result.current.result?.rows).toHaveLength(1);
    expect(b.result.current.result).toBe(a.result.current.result);
    expect(a.result.current.loading).toBe(false);
    expect(a.result.current.schema?.titleColumn).toBe('name');
  });

  it('gives different queries their own request', async () => {
    serve([rowOf('t1', 'One')]);
    await mount(desc('tasks:p1', {}));
    await mount(desc('tasks:p1', { search: 'x' }));
    expect(queries()).toBe(2);
  });

  it('treats queries that differ only in key order as the same', async () => {
    serve([rowOf('t1', 'One')]);
    await mount(desc('tasks:p1', { search: 'x', limit: 5 }));
    await mount(desc('tasks:p1', { limit: 5, search: 'x' }));
    expect(queries()).toBe(1);
  });

  it('useTableSchema shares the cached schema', async () => {
    serve([]);
    const a = renderHook(() => useTableSchema('tasks:p1'));
    const b = renderHook(() => useTableSchema('tasks:p1'));
    await flush();
    expect(backend.count('GET /api/tables/tasks:p1/schema')).toBe(1);
    expect(a.result.current.schema?.ref).toBe('tasks:p1');
    expect(b.result.current.schema).toBe(a.result.current.schema);
  });
});

describe('refetching', () => {
  it('coalesces events inside the debounce window into one request', async () => {
    serve([rowOf('t1', 'One')]);
    await mount();
    expect(queries()).toBe(1);
    fake.emit('rows_changed', { tableRef: 'tasks:p1', ids: ['t1'], change: 'updated' });
    await flush(100);
    fake.emit('rows_changed', { tableRef: 'tasks:p1', ids: ['t2'], change: 'created' });
    fake.emit('rows_changed', { tableRef: 'tasks:p1', ids: ['t1'], change: 'deleted' });
    await flush(100);
    expect(queries()).toBe(1);
    await flush(100);
    expect(queries()).toBe(2);
    await flush(1000);
    expect(queries()).toBe(2);
  });

  it('never has two requests in flight and discards the outdated answer (latest wins)', async () => {
    const state = serve([rowOf('t1', 'Old')]);
    const slow = deferred<{ body: unknown }>();
    const hook = await mount();
    let inFlight = 0;
    let maxInFlight = 0;
    let n = 0;
    backend.on('POST /api/tables/tasks:p1/query', () => {
      n++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const reply = n === 1 ? slow.promise : Promise.resolve({ body: resultOf(state.rows) });
      return reply.finally(() => inFlight--);
    });

    fake.emit('rows_changed', { tableRef: 'tasks:p1' });
    await flush(250); // request A (slow) is running
    expect(n).toBe(1);
    state.rows = [rowOf('t1', 'Newest')];
    fake.emit('rows_changed', { tableRef: 'tasks:p1' });
    await flush(250); // asks for another one: it must wait for A
    expect(n).toBe(1);
    slow.resolve({ body: resultOf([rowOf('t1', 'Outdated')]) });
    await flush(0);
    expect(nameOf(hook.result, 't1')).not.toBe('Outdated');
    expect(n).toBe(2);
    expect(nameOf(hook.result, 't1')).toBe('Newest');
    expect(maxInFlight).toBe(1);
  });

  it('keeps showing the previous result while refetching', async () => {
    const state = serve([rowOf('t1', 'Before')]);
    const hook = await mount();
    const gate = deferred<{ body: unknown }>();
    backend.on('POST /api/tables/tasks:p1/query', () => gate.promise);
    state.rows = [rowOf('t1', 'After')];
    fake.emit('rows_changed', { tableRef: 'tasks:p1' });
    await flush(250);
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.refreshing).toBe(true);
    expect(nameOf(hook.result, 't1')).toBe('Before');
    gate.resolve({ body: resultOf(state.rows) });
    await flush(0);
    expect(nameOf(hook.result, 't1')).toBe('After');
    expect(hook.result.current.refreshing).toBe(false);
  });

  it('keeps the previous result while a changed query loads', async () => {
    serve([rowOf('t1', 'One')]);
    let q: Query = {};
    const hook = renderHook(() => useViewQuery(desc('tasks:p1', q)));
    await flush();
    const gate = deferred<{ body: unknown }>();
    backend.on('POST /api/tables/tasks:p1/query', (c) => (c.body.search ? gate.promise : { body: resultOf([]) }));
    q = { search: 'z' };
    hook.rerender();
    await flush();
    expect(hook.result.current.loading).toBe(true);
    expect(nameOf(hook.result, 't1')).toBe('One');
    gate.resolve({ body: resultOf([rowOf('t9', 'Nine')]) });
    await flush();
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.result?.rows.map((r) => r.id)).toEqual(['t9']);
  });

  it('filters events: tasks:* hears every project, tasks:<id> only its own', async () => {
    serve([], 'tasks:p1');
    serve([], 'tasks:p2');
    serve([], 'tasks:*');
    await mount(desc('tasks:p1'));
    await mount(desc('tasks:p2'));
    await mount(desc('tasks:*'));
    const base = { p1: queries('tasks:p1'), p2: queries('tasks:p2'), all: queries('tasks:*') };

    fake.emit('rows_changed', { tableRef: 'tasks:p1' });
    await flush(300);
    expect([queries('tasks:p1'), queries('tasks:p2'), queries('tasks:*')]).toEqual([base.p1 + 1, base.p2, base.all + 1]);

    fake.emit('rows_changed', { tableRef: 'tasks:*' }); // everything under tasks:
    await flush(300);
    expect([queries('tasks:p1'), queries('tasks:p2'), queries('tasks:*')]).toEqual([base.p1 + 2, base.p2 + 1, base.all + 2]);

    fake.emit('rows_changed', { tableRef: 'tbl_other' });
    fake.emit('rows_changed', {});
    await flush(300);
    expect([queries('tasks:p1'), queries('tasks:p2'), queries('tasks:*')]).toEqual([base.p1 + 2, base.p2 + 1, base.all + 2]);
  });

  it('refetches the schema and the queries on schema_changed', async () => {
    serve([rowOf('t1', 'One')]);
    const hook = await mount();
    expect(hook.result.current.schema?.columns).toHaveLength(3);
    backend.on('GET /api/tables/tasks:p1/schema', () => ({
      body: { ...schemaOf('tasks:p1'), columns: [...schemaOf('tasks:p1').columns, { key: 'cf_1', name: 'Extra', type: 'text', builtin: false }] },
    }));
    fake.emit('schema_changed', { tableRef: 'tasks:p1' });
    await flush(300);
    expect(hook.result.current.schema?.columns).toHaveLength(4);
    expect(queries()).toBe(2);
  });
});

describe('watching and disposal', () => {
  it('points the watch slot at the projects of the mounted views and releases it', async () => {
    fake.data.projects = [
      { id: 'p1', name: 'One', canTasks: true, isOwner: true },
      { id: 'p2', name: 'Two', canTasks: true, isOwner: false },
      { id: 'p3', name: 'Three', canTasks: false, isOwner: false },
    ];
    serve([], 'tasks:p1');
    serve([], 'tasks:*');
    const last = () => fake.watches[fake.watches.length - 1];
    expect(fake.watches).toHaveLength(0);

    const a = renderHook(() => useViewQuery(desc('tasks:p1')));
    await flush();
    expect(last()).toEqual({ slot: 'tables', target: { projects: ['p1'] } });

    const b = renderHook(() => useViewQuery(desc('tasks:*')));
    await flush();
    expect(last()).toEqual({ slot: 'tables', target: { projects: ['p1'], allTasks: true } });

    b.unmount();
    expect(last()).toEqual({ slot: 'tables', target: { projects: ['p1'] } });
    a.unmount();
    expect(last()).toEqual({ slot: 'tables', target: null });
  });

  it('tasks:* alone uses the all-tasks watch and does not list projects', async () => {
    serve([], 'tasks:*');
    const a = renderHook(() => useViewQuery(desc('tasks:*')));
    await flush();
    expect(fake.watches).toEqual([{ slot: 'tables', target: { allTasks: true } }]);
    a.unmount();
    expect(fake.watches[fake.watches.length - 1]!.target).toBeNull();
  });

  it('uses one watch call for two views of the same project', async () => {
    serve([]);
    const a = renderHook(() => useViewQuery(desc('tasks:p1', {}, 'a')));
    const b = renderHook(() => useViewQuery(desc('tasks:p1', { search: 'x' }, 'b')));
    await flush();
    expect(fake.watches).toHaveLength(1);
    a.unmount();
    expect(fake.watches).toHaveLength(1);
    b.unmount();
    expect(fake.watches).toHaveLength(2);
    expect(fake.watches[1]!.target).toBeNull();
  });

  it('stops listening to live events once nothing is mounted', async () => {
    serve([]);
    const hook = await mount();
    hook.unmount();
    fake.emit('rows_changed', { tableRef: 'tasks:p1' });
    await flush(1000);
    expect(queries()).toBe(1);
  });

  it('keeps the cache for a short while after the last subscriber left, then drops it', async () => {
    serve([rowOf('t1', 'One')]);
    const first = await mount();
    first.unmount();

    await flush(STORE_CONFIG.disposeDelayMs - 100);
    const again = renderHook(() => useViewQuery(desc()));
    expect(again.result.current.result?.rows).toHaveLength(1); // cached, shown at once
    await flush();
    expect(queries()).toBe(2); // and refreshed because it was unwatched in between
    again.unmount();

    await flush(STORE_CONFIG.disposeDelayMs + 100);
    const later = renderHook(() => useViewQuery(desc()));
    expect(later.result.current.result).toBeNull(); // dropped: starts from scratch
    expect(later.result.current.loading).toBe(true);
    await flush();
    expect(later.result.current.result?.rows).toHaveLength(1);
  });
});

describe('errors', () => {
  it('reports a 403 on the query as the error state', async () => {
    backend.on('GET /api/tables/tasks:p1/schema', () => ({ body: schemaOf('tasks:p1') }));
    backend.on('POST /api/tables/tasks:p1/query', () => ({ status: 403, body: { detail: 'Task access denied for this project' } }));
    const hook = await mount();
    expect(hook.result.current.error?.message).toBe('Task access denied for this project');
    expect((hook.result.current.error as any).status).toBe(403);
    expect(hook.result.current.result).toBeNull();
    expect(hook.result.current.loading).toBe(false);
  });

  it('reports a 404 on the schema', async () => {
    backend.on('POST /api/tables/tasks:nope/query', () => ({ status: 404, body: { detail: 'Project not found' } }));
    backend.on('GET /api/tables/tasks:nope/schema', () => ({ status: 404, body: { detail: 'Project not found' } }));
    const hook = await mount(desc('tasks:nope'));
    expect(hook.result.current.error?.message).toBe('Project not found');
    expect(hook.result.current.schema).toBeNull();
  });

  it('keeps the last result when a refetch fails and recovers on the next one', async () => {
    const state = serve([rowOf('t1', 'One')]);
    const hook = await mount();
    backend.on('POST /api/tables/tasks:p1/query', () => ({ status: 500, body: { detail: 'boom' } }));
    fake.emit('rows_changed', { tableRef: 'tasks:p1' });
    await flush(300);
    expect(hook.result.current.error?.message).toBe('boom');
    expect(hook.result.current.refreshing).toBe(true);
    expect(nameOf(hook.result, 't1')).toBe('One');
    backend.on('POST /api/tables/tasks:p1/query', () => ({ body: resultOf(state.rows) }));
    hook.result.current.reload();
    await flush();
    expect(hook.result.current.error).toBeNull();
  });
});

describe('optimistic mutations', () => {
  const patchPath = 'PATCH /api/tables/tasks:p1/rows/t1';

  it('updateRow shows the change at once, keeps the server row and refetches', async () => {
    const state = serve([rowOf('t1', 'One')]);
    const hook = await mount();
    const gate = deferred<{ body: unknown }>();
    backend.on(patchPath, () => gate.promise);

    let done!: Promise<void>;
    act(() => {
      done = hook.result.current.actions.updateRow('t1', { name: 'Renamed' });
    });
    expect(nameOf(hook.result, 't1')).toBe('Renamed'); // before any response
    state.rows = [rowOf('t1', 'Renamed from server')];
    gate.resolve({ body: rowOf('t1', 'Renamed from server') });
    await flush();
    await done;
    expect(nameOf(hook.result, 't1')).toBe('Renamed from server');
    expect(queries()).toBe(1);
    await flush(300);
    expect(queries()).toBe(2); // refetch scheduled after the success
    expect(backend.calls.find((c) => c.method === 'PATCH')!.body).toEqual({ values: { name: 'Renamed' } });
  });

  it('patches the row in every active query of the table', async () => {
    serve([rowOf('t1', 'One')]);
    const a = await mount(desc('tasks:p1', {}));
    const b = await mount(desc('tasks:p1', { search: 'o' }));
    backend.on(patchPath, () => new Promise(() => {}));
    act(() => void a.result.current.actions.updateRow('t1', { name: 'X' }));
    expect(nameOf(a.result, 't1')).toBe('X');
    expect(nameOf(b.result, 't1')).toBe('X');
  });

  it('rolls back a failed update and shows a toast', async () => {
    serve([rowOf('t1', 'One')]);
    const hook = await mount();
    const gate = deferred<{ status: number; body: unknown }>();
    backend.on(patchPath, () => gate.promise);
    let done!: Promise<void>;
    act(() => {
      done = hook.result.current.actions.updateRow('t1', { name: 'Nope' });
    });
    expect(nameOf(hook.result, 't1')).toBe('Nope');
    gate.resolve({ status: 400, body: { detail: 'Invalid name' } });
    await flush();
    await done;
    expect(nameOf(hook.result, 't1')).toBe('One');
    expect(fake.toasts).toEqual([{ kind: 'error', message: 'Invalid name' }]);
  });

  it('a later edit survives when an earlier one on the same row fails', async () => {
    serve([rowOf('t1', 'One')]);
    const hook = await mount();
    const first = deferred<{ status: number; body: unknown }>();
    let n = 0;
    backend.on(patchPath, (c) => {
      n++;
      return n === 1 ? first.promise : { body: rowOf('t1', 'One', { status: c.body.values.status }) };
    });
    act(() => void hook.result.current.actions.updateRow('t1', { name: 'Bad name' }));
    act(() => void hook.result.current.actions.updateRow('t1', { status: 'done' }));
    await flush();
    expect(hook.result.current.result?.rows[0]!.values).toMatchObject({ name: 'Bad name', status: 'done' });
    first.resolve({ status: 400, body: { detail: 'No' } });
    await flush();
    expect(hook.result.current.result?.rows[0]!.values).toMatchObject({ name: 'One', status: 'done' });
  });

  it('edits to different fields survive answers that return out of order', async () => {
    const state = serve([rowOf('t1', 'One')]);
    const hook = await mount();
    const a = deferred<{ body: unknown }>();
    const b = deferred<{ body: unknown }>();
    let n = 0;
    backend.on(patchPath, () => (++n === 1 ? a.promise : b.promise));
    act(() => void hook.result.current.actions.updateRow('t1', { name: 'A' }));
    act(() => void hook.result.current.actions.updateRow('t1', { status: 'done' }));
    state.rows = [rowOf('t1', 'A', { status: 'done' })];
    // The server handled A then B, but B's answer arrives first
    b.resolve({ body: rowOf('t1', 'A', { status: 'done' }) });
    await flush();
    expect(hook.result.current.result?.rows[0]!.values).toMatchObject({ name: 'A', status: 'done' });
    // A's answer is older: it knows nothing of B's status
    a.resolve({ body: rowOf('t1', 'A', { status: 'todo' }) });
    await flush();
    expect(hook.result.current.result?.rows[0]!.values).toMatchObject({ name: 'A', status: 'done' });
    await flush(300);
    expect(hook.result.current.result?.rows[0]!.values).toMatchObject({ name: 'A', status: 'done' });
  });

  it('createRow adds a temporary row, swaps in the real one and refetches', async () => {
    const state = serve([rowOf('t1', 'One')]);
    const hook = await mount();
    const gate = deferred<{ body: unknown }>();
    backend.on('POST /api/tables/tasks:p1/rows', () => gate.promise);
    let created!: Promise<Row>;
    act(() => {
      created = hook.result.current.actions.createRow({ name: 'Fresh' }, { parentId: undefined });
    });
    expect(hook.result.current.result?.rows.map((r) => r.values.name)).toEqual(['One', 'Fresh']);
    expect(hook.result.current.result?.total).toBe(2);
    expect(hook.result.current.result?.rows[1]!.id).toMatch(/^tmp:/);
    state.rows = [rowOf('t1', 'One'), rowOf('t2', 'Fresh')];
    gate.resolve({ body: rowOf('t2', 'Fresh') });
    await flush();
    expect((await created).id).toBe('t2');
    expect(hook.result.current.result?.rows.map((r) => r.id)).toEqual(['t1', 't2']);
    await flush(300);
    expect(queries()).toBe(2);
  });

  it('createRow sends parentId and projectId, and does not insert where it could be wrong', async () => {
    serve([rowOf('t1', 'One')], 'tasks:*');
    const hook = await mount(desc('tasks:*', { filter: { column: 'status', op: 'eq', value: 'done' } }));
    backend.on('POST /api/tables/tasks:*/rows', () => ({ body: rowOf('t5', 'Sub') }));
    await act(async () => {
      await hook.result.current.actions.createRow({ name: 'Sub' }, { parentId: 't1', projectId: 'p1' });
    });
    expect(backend.calls.find((c) => c.method === 'POST' && c.path.endsWith('/rows'))!.body).toEqual({
      values: { name: 'Sub' },
      parentId: 't1',
      projectId: 'p1',
    });
    expect(hook.result.current.result?.rows.map((r) => r.id)).toEqual(['t1']); // filtered view: the refetch decides
  });

  it('createRow on tasks:* without a projectId rejects with a clear error and sends nothing', async () => {
    serve([rowOf('t1', 'One')], 'tasks:*');
    const hook = await mount(desc('tasks:*'));
    await act(async () => {
      await expect(hook.result.current.actions.createRow({ name: 'X' })).rejects.toThrow(/project/i);
    });
    expect(backend.calls.some((c) => c.method === 'POST' && c.path.endsWith('/rows'))).toBe(false);
    expect(fake.toasts[fake.toasts.length - 1]?.kind).toBe('error');
  });

  it('projectsForCreate lists the projects where the user can edit tasks', () => {
    fake.data.projects = [
      { id: 'p1', name: 'One', canTasks: true, isOwner: true },
      { id: 'p3', name: 'Three', canTasks: false, isOwner: false },
    ];
    expect(projectsForCreate()).toEqual([{ id: 'p1', name: 'One' }]);
  });

  it('createRow removes the temporary row, toasts and rejects on failure', async () => {
    serve([rowOf('t1', 'One')]);
    const hook = await mount();
    backend.on('POST /api/tables/tasks:p1/rows', () => ({ status: 403, body: { detail: 'Task access denied for this project' } }));
    let error: unknown;
    await act(async () => {
      await hook.result.current.actions.createRow({ name: 'X' }).catch((e) => (error = e));
    });
    expect((error as Error).message).toBe('Task access denied for this project');
    expect(hook.result.current.result?.rows.map((r) => r.id)).toEqual(['t1']);
    expect(fake.toasts).toEqual([{ kind: 'error', message: 'Task access denied for this project' }]);
  });

  it('an edit of a row that is still being created waits for its real id', async () => {
    serve([]);
    const hook = await mount();
    const gate = deferred<{ body: unknown }>();
    backend.on('POST /api/tables/tasks:p1/rows', () => gate.promise);
    backend.on('PATCH /api/tables/tasks:p1/rows/t7', () => ({ body: rowOf('t7', 'Edited') }));
    let tempId = '';
    act(() => {
      void hook.result.current.actions.createRow({ name: 'New' });
    });
    tempId = hook.result.current.result!.rows[0]!.id;
    act(() => void hook.result.current.actions.updateRow(tempId, { name: 'Edited' }));
    gate.resolve({ body: rowOf('t7', 'New') });
    await flush();
    expect(backend.calls.some((c) => c.method === 'PATCH' && c.path.endsWith('/rows/t7'))).toBe(true);
    expect(backend.calls.some((c) => c.path.includes('tmp:'))).toBe(false);
  });

  it('deleteRows removes at once and rolls back the rows that failed', async () => {
    serve([rowOf('t1', 'One'), rowOf('t2', 'Two'), rowOf('t3', 'Three')]);
    const hook = await mount();
    const gate = deferred<{ body: unknown }>();
    backend.on('DELETE /api/tables/tasks:p1/rows/t1', () => gate.promise);
    backend.on('DELETE /api/tables/tasks:p1/rows/t2', () => ({ status: 403, body: { detail: 'Task access denied' } }));
    let done!: Promise<void>;
    act(() => {
      done = hook.result.current.actions.deleteRows(['t1', 't2']);
    });
    expect(hook.result.current.result?.rows.map((r) => r.id)).toEqual(['t3']);
    expect(hook.result.current.result?.total).toBe(1);
    gate.resolve({ body: { success: true } });
    await flush();
    await done;
    expect(hook.result.current.result?.rows.map((r) => r.id)).toEqual(['t2', 't3']); // t1 gone for good, t2 restored
    expect(fake.toasts[0]).toEqual({ kind: 'error', message: 'Task access denied' });
    expect(fake.toasts[1]).toMatchObject({ kind: 'success', message: 'Deleted 1 task', actionLabel: 'Undo' }); // only t1 went
  });

  describe('undo of a delete', () => {
    it('offers Undo for 8 seconds; Undo shows the rows again at once, restores them and refetches', async () => {
      const state = serve([rowOf('t1', 'One'), rowOf('t2', 'Two'), rowOf('t3', 'Three')]);
      const hook = await mount();
      backend.on('DELETE /api/tables/tasks:p1/rows/', () => ({ body: { success: true } }));
      await act(async () => {
        await hook.result.current.actions.deleteRows(['t1', 't2']);
      });
      state.rows = [rowOf('t3', 'Three')];
      await flush(STORE_CONFIG.refetchDelayMs);
      expect(hook.result.current.result?.rows.map((r) => r.id)).toEqual(['t3']);
      expect(fake.toasts).toEqual([
        { kind: 'success', message: 'Deleted 2 tasks', actionLabel: 'Undo', durationMs: 8000, onAction: expect.any(Function) },
      ]);

      const gate = deferred<{ body: unknown }>();
      backend.on('POST /api/tables/tasks:p1/rows/restore', () => gate.promise);
      act(() => fake.toasts[0]!.onAction!());
      // re-inserted before the server has answered
      expect(hook.result.current.result?.rows.map((r) => r.id).sort()).toEqual(['t1', 't2', 't3']);
      state.rows = [rowOf('t1', 'One'), rowOf('t2', 'Two'), rowOf('t3', 'Three')];
      gate.resolve({ body: { restored: ['t1', 't2'] } });
      await flush(STORE_CONFIG.refetchDelayMs);
      const restore = backend.calls.find((c) => c.path === '/api/tables/tasks:p1/rows/restore');
      expect(restore?.body).toEqual({ ids: ['t1', 't2'] });
      expect(hook.result.current.result?.rows.map((r) => r.id)).toEqual(['t1', 't2', 't3']); // no duplicates after the refetch
      expect(fake.toasts).toHaveLength(1);
    });

    it('takes the rows out again and says so when the restore fails', async () => {
      serve([rowOf('t1', 'One'), rowOf('t2', 'Two')]);
      const hook = await mount();
      backend.on('DELETE /api/tables/tasks:p1/rows/t1', () => ({ body: { success: true } }));
      backend.on('POST /api/tables/tasks:p1/rows/restore', () => ({ status: 404, body: { detail: 'Row not found in the trash' } }));
      await act(async () => {
        await hook.result.current.actions.deleteRows(['t1']);
      });
      await act(async () => fake.toasts[0]!.onAction!());
      expect(fake.toasts[1]).toEqual({ kind: 'error', message: 'Row not found in the trash' });
    });

    it('shows no Undo when nothing was deleted', async () => {
      serve([rowOf('t1', 'One')]);
      const hook = await mount();
      backend.on('DELETE /api/tables/tasks:p1/rows/t1', () => ({ status: 403, body: { detail: 'No' } }));
      await act(async () => {
        await hook.result.current.actions.deleteRows(['t1']);
      });
      expect(fake.toasts.map((t) => t.kind)).toEqual(['error']);
    });
  });

  it('reorder moves at once and rolls back on failure', async () => {
    serve([rowOf('t1', 'One'), rowOf('t2', 'Two'), rowOf('t3', 'Three')]);
    const hook = await mount();
    const gate = deferred<{ status: number; body: unknown }>();
    backend.on('POST /api/tables/tasks:p1/rows/reorder', () => gate.promise);
    let done!: Promise<void>;
    act(() => {
      done = hook.result.current.actions.reorder(['t3'], 't1');
    });
    expect(hook.result.current.result?.rows.map((r) => r.id)).toEqual(['t3', 't1', 't2']);
    gate.resolve({ status: 400, body: { detail: 'Cannot reorder' } });
    await flush();
    await done;
    expect(hook.result.current.result?.rows.map((r) => r.id)).toEqual(['t1', 't2', 't3']);
    expect(fake.toasts[0]).toEqual({ kind: 'error', message: 'Cannot reorder' });
  });

  it('reorder keeps the new order on success and sends {ids, before}', async () => {
    serve([rowOf('t1', 'One'), rowOf('t2', 'Two')]);
    const hook = await mount();
    backend.on('POST /api/tables/tasks:p1/rows/reorder', () => ({ body: { success: true } }));
    await act(async () => {
      await hook.result.current.actions.reorder(['t2']); // to the end: no `before`
      await hook.result.current.actions.reorder(['t2'], 't1');
    });
    const bodies = backend.calls.filter((c) => c.path.endsWith('/reorder')).map((c) => c.body);
    expect(bodies).toEqual([{ ids: ['t2'] }, { ids: ['t2'], before: 't1' }]);
    expect(hook.result.current.result?.rows.map((r) => r.id)).toEqual(['t2', 't1']);
  });

  it('loadChildren queries the children through the store and caches them', async () => {
    serve([rowOf('t1', 'Parent')]);
    const hook = await mount(desc('tasks:p1', { parentId: null, sort: [{ column: 'name', dir: 'asc' }] }));
    backend.on('POST /api/tables/tasks:p1/query', (c) =>
      c.body.parentId === 't1' ? { body: resultOf([{ ...rowOf('c1', 'Child'), parentId: 't1' }]) } : { body: resultOf([rowOf('t1', 'Parent')]) },
    );
    let rows: Row[] = [];
    await act(async () => {
      const p = hook.result.current.actions.loadChildren('t1');
      await vi.advanceTimersByTimeAsync(0);
      rows = await p;
    });
    expect(rows.map((r) => r.id)).toEqual(['c1']);
    const childCalls = backend.calls.filter((c) => c.body?.parentId === 't1');
    expect(childCalls).toHaveLength(1);
    expect(childCalls[0]!.body).toEqual({ parentId: 't1', sort: [{ column: 'name', dir: 'asc' }] });
    await act(async () => {
      rows = await hook.result.current.actions.loadChildren('t1');
    });
    expect(rows).toHaveLength(1);
    expect(backend.calls.filter((c) => c.body?.parentId === 't1')).toHaveLength(1);
  });

  it('loadChildren rejects when the query fails', async () => {
    serve([rowOf('t1', 'Parent')]);
    const hook = await mount();
    backend.on('POST /api/tables/tasks:p1/query', () => ({ status: 404, body: { detail: 'Row not found' } }));
    let error: unknown;
    await act(async () => {
      const p = hook.result.current.actions.loadChildren('gone').catch((e) => (error = e));
      await vi.advanceTimersByTimeAsync(0);
      await p;
    });
    expect((error as Error).message).toBe('Row not found');
  });

  it('openRow adds task=<id> to the current route', async () => {
    serve([]);
    const hook = await mount();
    window.history.pushState({}, '', '/p/p1/pages?x=1');
    act(() => hook.result.current.actions.openRow('t1'));
    expect(fake.navigations).toEqual(['/p/p1/pages?task=t1']);
    window.history.pushState({}, '', '/');
  });
});

describe('useView', () => {
  const view: ViewDescriptor = { id: 'v1', tableRef: 'tasks:p1', layout: 'table', config: { query: {} } };

  it('loads the view from the source and the data for it', async () => {
    serve([rowOf('t1', 'One')]);
    setViewSource(createMemoryViewSource([view]));
    const hook = renderHook(() => useView('v1'));
    expect(hook.result.current.view).toBeNull();
    await flush();
    expect(hook.result.current.view?.tableRef).toBe('tasks:p1');
    expect(hook.result.current.result?.rows).toHaveLength(1);
  });

  it('reports a missing view', async () => {
    const hook = renderHook(() => useView('nope'));
    await flush();
    expect(hook.result.current.error?.message).toBe('View not found');
    expect(hook.result.current.loading).toBe(false);
  });

  it('updateConfig applies at once, requeries when the query changed and saves once after the debounce', async () => {
    serve([rowOf('t1', 'One')]);
    const source = createMemoryViewSource([view]);
    const update = vi.spyOn(source, 'update');
    setViewSource(source);
    const hook = renderHook(() => useView('v1'));
    await flush();
    expect(queries()).toBe(1);

    act(() => hook.result.current.actions.updateConfig({ query: { search: 'a' } }));
    await flush(100);
    act(() => hook.result.current.actions.updateConfig({ query: { search: 'ab' }, columns: [{ key: 'name', width: 200 }] }));
    expect(hook.result.current.view?.config.query).toEqual({ search: 'ab' }); // local, immediately
    await flush(100);
    expect(update).not.toHaveBeenCalled(); // still inside the debounce
    // The query ran for the new config right away (one per distinct query)
    expect(backend.calls.filter((c) => c.body?.search === 'ab')).toHaveLength(1);

    await flush(STORE_CONFIG.configSaveDelayMs);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('v1', { config: { query: { search: 'ab' }, columns: [{ key: 'name', width: 200 }] } });
    expect((await source.get('v1')).config.query).toEqual({ search: 'ab' });
    expect(hook.result.current.view?.config.query).toEqual({ search: 'ab' });
  });

  it('does not requery when only layout settings change', async () => {
    serve([rowOf('t1', 'One')]);
    setViewSource(createMemoryViewSource([view]));
    const hook = renderHook(() => useView('v1'));
    await flush();
    act(() => hook.result.current.actions.updateConfig({ columns: [{ key: 'name', hidden: true }] }));
    await flush(1000);
    expect(queries()).toBe(1);
  });

  it('saves a pending change when unmounted', async () => {
    serve([]);
    const source = createMemoryViewSource([view]);
    const update = vi.spyOn(source, 'update');
    setViewSource(source);
    const hook = renderHook(() => useView('v1'));
    await flush();
    act(() => hook.result.current.actions.updateConfig({ list: { secondaryColumns: ['status'] } }));
    hook.unmount();
    expect(update).toHaveBeenCalledWith('v1', { config: { list: { secondaryColumns: ['status'] } } });
  });

  it('follows changes made elsewhere to the view', async () => {
    serve([]);
    const source = createMemoryViewSource([view]);
    setViewSource(source);
    renderHook(() => useView('v1'));
    await flush();
    act(() => source.set({ ...view, config: { query: { search: 'remote' } } }));
    await flush();
    expect(backend.calls.some((c) => c.body?.search === 'remote')).toBe(true);
  });
});
