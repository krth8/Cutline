import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatform } from '../../../platform';
import { createFakePlatform, type FakePlatform } from '../../../testing/fakePlatform';
import { resetStores } from '../../store';
import { resultOf, rowOf, schemaOf } from '../../store/store.testutil';
import type { Column, LayoutProps, Query, Row, TableSchema, View } from '../../types';
import { TableLayout } from './TableLayout';

let fake: FakePlatform;

beforeEach(() => {
  fake = createFakePlatform();
  setPlatform(fake);
});
afterEach(() => {
  resetStores();
  setPlatform(null);
});

const CUSTOM: Column = { key: 'cf_1', name: 'Budget', type: 'number', builtin: false };

function schemaWith(editSchema: boolean, extra: Column[] = []): TableSchema {
  const base = schemaOf('tasks:p1');
  return { ...base, columns: [...base.columns, ...extra], capabilities: { ...base.capabilities, editSchema } };
}

function props(over: { schema?: TableSchema; query?: Query; rows?: Row[]; actions?: Partial<LayoutProps['actions']> } = {}): LayoutProps {
  const view: View = { id: 'v1', tableRef: 'tasks:p1', name: 'Tasks', layout: 'table', config: { query: over.query ?? {} } };
  return {
    schema: over.schema ?? schemaWith(true, [CUSTOM]),
    view,
    result: resultOf(over.rows ?? [rowOf('t1', 'One')]),
    loading: false,
    actions: {
      updateRow: vi.fn().mockResolvedValue(undefined),
      createRow: vi.fn(),
      deleteRows: vi.fn().mockResolvedValue(undefined),
      reorder: vi.fn().mockResolvedValue(undefined),
      openRow: vi.fn(),
      updateConfig: vi.fn(),
      loadChildren: vi.fn().mockResolvedValue([]),
      ...over.actions,
    },
  };
}

const menuFor = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(screen.getByLabelText(`Column menu for ${name}`));
  return screen.getByRole('menu');
};

describe('sort by header click', () => {
  it('cycles ascending, descending, none', async () => {
    const user = userEvent.setup();
    const p = props();
    const { rerender } = render(<TableLayout {...p} />);
    const label = () => screen.getAllByTestId('table-hlabel')[0]!;
    await user.click(label());
    expect(p.actions.updateConfig).toHaveBeenLastCalledWith({ query: { sort: [{ column: 'name', dir: 'asc' }] } });

    const asc = props({ query: { sort: [{ column: 'name', dir: 'asc' }] } });
    rerender(<TableLayout {...asc} />);
    await user.click(label());
    expect(asc.actions.updateConfig).toHaveBeenLastCalledWith({ query: { sort: [{ column: 'name', dir: 'desc' }] } });

    const desc = props({ query: { sort: [{ column: 'name', dir: 'desc' }] } });
    rerender(<TableLayout {...desc} />);
    await user.click(label());
    expect(desc.actions.updateConfig).toHaveBeenLastCalledWith({ query: {} });
  });
});

describe('column header menu', () => {
  it('a builtin column offers sort and hide only', async () => {
    const user = userEvent.setup();
    render(<TableLayout {...props()} />);
    const menu = await menuFor(user, 'Status');
    const labels = within(menu).getAllByRole('menuitem').map((i) => i.textContent);
    expect(labels).toEqual(['Sort ascending', 'Sort descending', 'Hide']);
  });

  it('a custom column offers rename, change type and delete to people who may edit the schema', async () => {
    const user = userEvent.setup();
    render(<TableLayout {...props()} />);
    const menu = await menuFor(user, 'Budget');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual([
      'Sort ascending',
      'Sort descending',
      'Hide',
      'Rename',
      'Change type',
      'Delete',
    ]);
  });

  it('a custom column has no schema actions without editSchema, and there is no add button', async () => {
    const user = userEvent.setup();
    render(<TableLayout {...props({ schema: schemaWith(false, [CUSTOM]) })} />);
    expect(screen.queryByTestId('table-add-column')).toBeNull();
    const menu = await menuFor(user, 'Budget');
    expect(within(menu).queryByText('Rename')).toBeNull();
    expect(within(menu).queryByText('Delete')).toBeNull();
  });

  it('sort descending and hide write the view config', async () => {
    const user = userEvent.setup();
    const p = props();
    render(<TableLayout {...p} />);
    await user.click(within(await menuFor(user, 'Status')).getByText('Sort descending'));
    expect(p.actions.updateConfig).toHaveBeenLastCalledWith({ query: { sort: [{ column: 'status', dir: 'desc' }] } });
    await user.click(within(await menuFor(user, 'Status')).getByText('Hide'));
    const call = (p.actions.updateConfig as ReturnType<typeof vi.fn>).mock.calls.slice(-1)[0]![0] as { columns: Array<{ key: string; hidden?: boolean }> };
    expect(call.columns.find((c) => c.key === 'status')?.hidden).toBe(true);
    expect(call.columns.find((c) => c.key === 'name')?.hidden).toBeUndefined();
  });

  it('rename calls the column API', async () => {
    const user = userEvent.setup();
    fake.routes['PATCH /api/tables/tasks%3Ap1/columns/cf_1'] = { ...CUSTOM, name: 'Cost' };
    fake.routes['/api/tables/tasks%3Ap1/schema'] = schemaWith(true, [{ ...CUSTOM, name: 'Cost' }]);
    render(<TableLayout {...props()} />);
    await user.click(within(await menuFor(user, 'Budget')).getByText('Rename'));
    const input = screen.getByTestId('column-form-name');
    await user.clear(input);
    await user.type(input, 'Cost');
    await user.click(screen.getByTestId('column-form-submit'));
    await waitFor(() => expect(fake.fetchCalls.some((c) => c.init?.method === 'PATCH' && c.path.endsWith('/columns/cf_1'))).toBe(true));
    const call = fake.fetchCalls.find((c) => c.init?.method === 'PATCH')!;
    expect(JSON.parse(String(call.init!.body))).toEqual({ name: 'Cost' });
  });

  it('delete asks first and does nothing when declined', async () => {
    const user = userEvent.setup();
    fake.confirmAnswer = false;
    render(<TableLayout {...props()} />);
    await user.click(within(await menuFor(user, 'Budget')).getByText('Delete'));
    await waitFor(() => expect(fake.confirmations).toHaveLength(1));
    expect(fake.confirmations[0]!.message).toContain('Budget');
    expect(fake.fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(false);
  });

  it('delete calls the column API once confirmed', async () => {
    const user = userEvent.setup();
    fake.routes['DELETE /api/tables/tasks%3Ap1/columns/cf_1'] = { success: true };
    render(<TableLayout {...props()} />);
    await user.click(within(await menuFor(user, 'Budget')).getByText('Delete'));
    await waitFor(() => expect(fake.fetchCalls.some((c) => c.init?.method === 'DELETE')).toBe(true));
  });
});

describe('add a column', () => {
  it('sends name and type, with the options of a select', async () => {
    const user = userEvent.setup();
    fake.routes['POST /api/tables/tasks%3Ap1/columns'] = { key: 'cf_9', name: 'Phase', type: 'select', builtin: false, options: [] };
    render(<TableLayout {...props()} />);
    await user.click(screen.getByTestId('table-add-column'));
    await user.type(screen.getByTestId('column-form-name'), 'Phase');
    expect(screen.queryByTestId('column-form-options')).toBeNull();
    await user.selectOptions(screen.getByTestId('column-form-type'), 'select');
    await user.type(screen.getByTestId('column-form-options'), 'Plan{enter}Build');
    await user.click(screen.getByTestId('column-form-submit'));
    await waitFor(() => expect(fake.fetchCalls.some((c) => c.init?.method === 'POST')).toBe(true));
    const call = fake.fetchCalls.find((c) => c.init?.method === 'POST')!;
    expect(JSON.parse(String(call.init!.body))).toEqual({ name: 'Phase', type: 'select', options: [{ label: 'Plan' }, { label: 'Build' }] });
    await waitFor(() => expect(screen.queryByTestId('column-form-name')).toBeNull()); // the dialog closed
  });

  it('keeps the form open and shows the server message when the server refuses', async () => {
    const user = userEvent.setup();
    fake.routes['POST /api/tables/tasks%3Ap1/columns'] = () => new Response(JSON.stringify({ detail: 'Only owners can change the schema' }), { status: 403 });
    render(<TableLayout {...props()} />);
    await user.click(screen.getByTestId('table-add-column'));
    await user.type(screen.getByTestId('column-form-name'), 'X');
    await user.click(screen.getByTestId('column-form-submit'));
    await waitFor(() => expect(fake.toasts.slice(-1)[0]?.message).toBe('Only owners can change the schema'));
    expect(screen.getByTestId('column-form-name')).toBeTruthy();
  });
});

describe('empty state', () => {
  it('with a filter says so and Clear filters removes filter and search', async () => {
    const user = userEvent.setup();
    const p = props({
      rows: [],
      query: { filter: { column: 'status', op: 'eq', value: 'x' }, search: 'abc', sort: [{ column: 'name', dir: 'asc' }] },
    });
    render(<TableLayout {...p} />);
    expect(screen.getByText('No tasks match the filters')).toBeTruthy();
    await user.click(screen.getByTestId('table-clear-filters'));
    expect(p.actions.updateConfig).toHaveBeenLastCalledWith({ query: { sort: [{ column: 'name', dir: 'asc' }] } });
  });

  it('without a filter says there is nothing yet and offers a new row', () => {
    render(<TableLayout {...props({ rows: [] })} />);
    expect(screen.getByTestId('table-empty').textContent).toContain('No tasks yet');
    expect(screen.getByTestId('table-empty-new').textContent).toBe('New task');
    expect(screen.queryByTestId('table-clear-filters')).toBeNull();
  });
});

describe('move under another row', () => {
  it('is offered for one selected row and calls moveRow', async () => {
    const user = userEvent.setup();
    const moveRow = vi.fn().mockResolvedValue(undefined);
    const rows = [rowOf('t1', 'One'), rowOf('t2', 'Two')];
    render(<TableLayout {...props({ rows, query: { parentId: null }, actions: { moveRow } })} />);
    await user.click(screen.getAllByRole('checkbox', { name: /select row/i })[0]!);
    await user.click(screen.getByTestId('table-bulk-move'));
    await user.selectOptions(screen.getByTestId('move-under-select'), 't2');
    await user.click(screen.getByTestId('move-under-submit'));
    await waitFor(() => expect(moveRow).toHaveBeenCalledWith('t1', 't2'));
  });
});
