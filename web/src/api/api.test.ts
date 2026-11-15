import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPlatform } from '../platform';
import { createFakePlatform, type FakePlatform } from '../testing/fakePlatform';
import { ApiError, requestJson } from './http';
import * as tables from './tables';
import * as views from './views';

let fake: FakePlatform;
beforeEach(() => {
  fake = createFakePlatform();
  setPlatform(fake);
});
afterEach(() => setPlatform(null));

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });

describe('http', () => {
  it('throws ApiError with the server detail', async () => {
    fake.routes['/x'] = json({ detail: 'Invalid thing' }, 400);
    const e = await requestJson<any>('GET', '/x').catch((err: any) => err);
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(400);
    expect(e.message).toBe('Invalid thing');
  });

  it('joins validation messages and falls back to the status', async () => {
    fake.routes['/v'] = json({ detail: [{ msg: 'a' }, { msg: 'b' }] }, 422);
    fake.routes['/n'] = () => new Response('oops', { status: 502 });
    expect((await requestJson<any>('GET', '/v').catch((e: any) => e)).message).toBe('a; b');
    expect((await requestJson<any>('GET', '/n').catch((e: any) => e)).message).toBe('Request failed (HTTP 502)');
  });

  it('turns a network failure into status 0', async () => {
    fake.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
    const e = await requestJson<any>('GET', '/x').catch((err: any) => err);
    expect(e).toMatchObject({ status: 0, message: 'Failed to fetch' });
  });
});

describe('tables client', () => {
  it('encodes table refs and sends the documented bodies', async () => {
    fake.routes = {
      'GET /api/tables/tasks%3Ap1/schema': { ref: 'tasks:p1' },
      'POST /api/tables/tasks%3A*/query': { rows: [], total: 0 },
      'POST /api/tables/tasks%3A*/rows': { id: 't1' },
      'PATCH /api/tables/tasks%3Ap1/rows/a%2Fb': { id: 'a/b' },
      'DELETE /api/tables/tasks%3Ap1/rows/t1': { success: true },
      'POST /api/tables/tasks%3Ap1/rows/reorder': { success: true },
      'POST /api/tables/tasks%3Ap1/columns': { key: 'cf_1' },
      'PATCH /api/tables/tasks%3Ap1/columns/cf_1': { key: 'cf_1' },
      'DELETE /api/tables/tasks%3Ap1/columns/cf_1': { success: true },
    };
    await tables.getSchema('tasks:p1');
    await tables.query('tasks:*', { search: 's' });
    await tables.createRow('tasks:*', { values: { name: 'n' }, projectId: 'p1' });
    await tables.updateRow('tasks:p1', 'a/b', { name: 'n' });
    await tables.deleteRow('tasks:p1', 't1');
    await tables.reorderRows('tasks:p1', ['t1'], 't2');
    await tables.createColumn('tasks:p1', { name: 'X', type: 'text' });
    await tables.updateColumn('tasks:p1', 'cf_1', { name: 'Y' });
    await tables.deleteColumn('tasks:p1', 'cf_1');
    const bodies = fake.fetchCalls.map((c) => (c.init?.body ? JSON.parse(String(c.init.body)) : undefined));
    expect(bodies[1]).toEqual({ search: 's' });
    expect(bodies[2]).toEqual({ values: { name: 'n' }, projectId: 'p1' });
    expect(bodies[3]).toEqual({ values: { name: 'n' } });
    expect(bodies[5]).toEqual({ ids: ['t1'], before: 't2' });
  });
});

describe('views client', () => {
  it('uses the endpoints of the contract', async () => {
    fake.routes = {
      'GET /api/views/v1': { id: 'v1' },
      'POST /api/views': { id: 'v2' },
      'PATCH /api/views/v1': { id: 'v1' },
      'DELETE /api/views/v1': { success: true },
    };
    await views.getView('v1');
    await views.createView({ tableRef: 'tasks:p1', name: 'N', layout: 'table', config: { query: {} } });
    await views.updateView('v1', { config: { query: {} } });
    await views.deleteView('v1');
    expect(fake.fetchCalls.map((c) => `${c.init?.method ?? 'GET'} ${c.path}`)).toEqual([
      'GET /api/views/v1',
      'POST /api/views',
      'PATCH /api/views/v1',
      'DELETE /api/views/v1',
    ]);
  });
});
