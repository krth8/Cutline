// Relation columns end to end on the client: the store refetches when a linked table changes, the add-column
// dialog sends the relation config, and the filter builder picks a linked row.
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatform } from '../platform';
import { createFakePlatform, type FakePlatform } from '../testing/fakePlatform';
import { TableLayout } from './layouts/table/TableLayout';
import { resetStores, STORE_CONFIG, useViewQuery } from './store';
import { Backend, resultOf, rowOf, schemaOf } from './store/store.testutil';
import { FilterBuilder } from './toolbar/FilterBuilder';
import type { Column, Filter, LayoutProps, TableSchema, View } from './types';

let fake: FakePlatform;
let backend: Backend;

const RELATION: Column = {
  key: 'cf_rel',
  name: 'Tasks',
  type: 'relation',
  builtin: false,
  config: { target: 'tasks:p1', multiple: true, twoWay: false, targetName: 'Tasks' },
};

const shotsSchema = (): TableSchema => ({
  ...schemaOf('tbl_shots'),
  name: 'Shots',
  columns: [{ key: 'name', name: 'Name', type: 'text', builtin: true }, RELATION],
  capabilities: { create: true, delete: true, hierarchy: false, editSchema: true },
  space: { type: 'project', projectId: 'p1' },
});

beforeEach(() => {
  fake = createFakePlatform();
  setPlatform(fake);
  backend = new Backend(fake);
});
afterEach(() => {
  resetStores();
  setPlatform(null);
  vi.useRealTimers();
});

describe('store: linked tables', () => {
  it('a change in the target table refetches tables that show its titles, and only those', async () => {
    vi.useFakeTimers();
    backend.on('POST /api/tables/tbl_shots/query', () => ({ body: resultOf([]) }));
    backend.on('GET /api/tables/tbl_shots/schema', () => ({ body: shotsSchema() }));
    backend.on('POST /api/tables/tbl_plain/query', () => ({ body: resultOf([]) }));
    backend.on('GET /api/tables/tbl_plain/schema', () => ({ body: schemaOf('tbl_plain') }));
    const flush = (ms = 0) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    const mount = (ref: string) =>
      renderHook(() => useViewQuery({ id: ref, tableRef: ref, layout: 'table', config: { query: {} } }));
    mount('tbl_shots');
    mount('tbl_plain');
    await flush();
    const before = { shots: backend.count('POST /api/tables/tbl_shots/query'), plain: backend.count('POST /api/tables/tbl_plain/query') };

    // A task is renamed: tasks:p1 is the target of Shots.Tasks
    fake.emit('rows_changed', { tableRef: 'tasks:p1', ids: ['t1'], change: 'updated' });
    await flush(STORE_CONFIG.refetchDelayMs + 50);
    expect(backend.count('POST /api/tables/tbl_shots/query')).toBe(before.shots + 1);
    expect(backend.count('POST /api/tables/tbl_plain/query')).toBe(before.plain);
  });
});

describe('add a relation column', () => {
  function layoutProps(): LayoutProps {
    const view: View = { id: 'v1', tableRef: 'tbl_shots', name: 'Shots', layout: 'table', config: { query: {} } };
    return {
      schema: shotsSchema(),
      view,
      result: resultOf([rowOf('r1', 'Shot 1', {}, 'tbl_shots')]),
      loading: false,
      actions: {
        updateRow: vi.fn().mockResolvedValue(undefined),
        createRow: vi.fn(),
        deleteRows: vi.fn().mockResolvedValue(undefined),
        reorder: vi.fn().mockResolvedValue(undefined),
        openRow: vi.fn(),
        updateConfig: vi.fn(),
        loadChildren: vi.fn().mockResolvedValue([]),
      },
    };
  }

  it('offers Relation with a table picker and the two switches, and sends the config', async () => {
    const user = userEvent.setup();
    backend.on('GET /api/tables?space=p:p1', () => ({
      body: { tables: [{ id: 'tbl_shots', ref: 'tbl_shots', name: 'Shots' }, { id: 'tbl_assets', ref: 'tbl_assets', name: 'Assets' }] },
    }));
    backend.on('POST /api/tables/tbl_shots/columns', (call) => ({ body: { key: 'cf_new', builtin: false, ...call.body } }));
    render(<TableLayout {...layoutProps()} />);
    await user.click(screen.getByTestId('table-add-column'));
    await user.type(screen.getByTestId('column-form-name'), 'Linked assets');
    expect(screen.queryByTestId('column-form-target')).toBeNull();
    await user.selectOptions(screen.getByTestId('column-form-type'), 'relation');

    const target = await screen.findByTestId('column-form-target');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Assets' })).toBeTruthy());
    expect(Array.from((target as HTMLSelectElement).options).map((o) => o.textContent)).toEqual([
      'Choose a table...',
      'Tasks',
      'Shots',
      'Assets',
    ]);
    // A table must be chosen first
    expect((screen.getByTestId('column-form-submit') as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(target, 'tbl_assets');
    await user.click(screen.getByTestId('column-form-multiple')); // off: a single link
    await user.click(screen.getByTestId('column-form-twoway')); // on
    await user.click(screen.getByTestId('column-form-submit'));

    await waitFor(() => expect(backend.count('POST /api/tables/tbl_shots/columns')).toBe(1));
    const call = backend.calls.find((c) => c.method === 'POST' && c.path.endsWith('/columns'))!;
    expect(call.body).toEqual({ name: 'Linked assets', type: 'relation', config: { target: 'tbl_assets', multiple: false, twoWay: true } });
  });

  it('a table of a personal space offers personal tables and the tasks of projects with task access', async () => {
    const user = userEvent.setup();
    fake.data.projects = [
      { id: 'pa', name: 'Alpha', canTasks: true, isOwner: true },
      { id: 'pb', name: 'Beta', canTasks: false, isOwner: false },
    ];
    backend.on('GET /api/tables?space=me', () => ({ body: { tables: [{ id: 'tbl_mine', ref: 'tbl_mine', name: 'Mine' }] } }));
    const props = layoutProps();
    props.schema = { ...shotsSchema(), ref: 'tbl_mine', space: { type: 'personal' } };
    render(<TableLayout {...props} />);
    await user.click(screen.getByTestId('table-add-column'));
    await user.selectOptions(screen.getByTestId('column-form-type'), 'relation');
    const target = await screen.findByTestId('column-form-target');
    await waitFor(() => expect((target as HTMLSelectElement).options.length).toBeGreaterThan(1));
    expect(Array.from((target as HTMLSelectElement).options).map((o) => o.textContent)).toEqual(['Choose a table...', 'Mine', 'Tasks of Alpha']);
  });
});

describe('filter builder: contains a linked row', () => {
  it('shows the title of the filtered row and picks another with the relation editor', async () => {
    const user = userEvent.setup();
    backend.on('GET /api/tables/tasks:p1/rows/t1', () => ({ body: rowOf('t1', 'Alpha') }));
    backend.on('POST /api/tables/tasks:p1/query', () => ({ body: resultOf([rowOf('t1', 'Alpha'), rowOf('t2', 'Bravo')]) }));
    const onChange = vi.fn();
    const filter: Filter = { column: 'cf_rel', op: 'contains', value: 't1' };
    render(<FilterBuilder schema={shotsSchema()} filter={filter} onChange={onChange} />);
    expect(await screen.findByText('Alpha')).toBeTruthy();

    await user.click(screen.getByText('Alpha').closest('.cl-cellhost') as HTMLElement);
    await user.click(await screen.findByText('Bravo'));
    expect(onChange).toHaveBeenLastCalledWith({ and: [{ column: 'cf_rel', op: 'contains', value: 't2' }] });
  });

  it('offers contains, is empty and is not empty for a relation column', async () => {
    render(<FilterBuilder schema={shotsSchema()} filter={{ column: 'cf_rel', op: 'empty' }} onChange={vi.fn()} />);
    const ops = Array.from((screen.getByLabelText('Operator') as HTMLSelectElement).options).map((o) => o.value);
    expect(ops).toEqual(['contains', 'empty', 'notEmpty']);
  });
});
