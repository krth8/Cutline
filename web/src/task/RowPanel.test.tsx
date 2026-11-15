import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NAVIGATE_EVENT, setPlatform } from '../platform';
import { createFakePlatform, type FakePlatform } from '../testing/fakePlatform';
import { resetStores } from '../tables/store';
import { Backend, rowOf } from '../tables/store/store.testutil';
import type { Row, TableSchema } from '../tables/types';
import { RowPanelHost } from './RowPanel';

const REF = 'tbl_t1';

const schema: TableSchema = {
  ref: REF,
  name: 'Shots',
  titleColumn: 'name',
  capabilities: { create: true, delete: true, hierarchy: false, editSchema: true },
  space: { type: 'project', projectId: 'p1' },
  columns: [
    { key: 'name', name: 'Name', type: 'text', builtin: true },
    { key: 'cf_note', name: 'Notes', type: 'text', builtin: false },
    { key: 'cf_done', name: 'Finished', type: 'checkbox', builtin: false },
    { key: 'createdAt', name: 'Created', type: 'date', builtin: true, readonly: true },
  ],
};

const row = (id: string, name: string, canEdit = true): Row => ({
  ...rowOf(id, name, { cf_note: 'first note', cf_done: false, createdAt: '2030-01-02' }, REF),
  canEdit,
});

let fake: FakePlatform;
let backend: Backend;
let rows: Record<string, Row>;

function goto(url: string) {
  window.history.pushState({}, '', url);
  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT));
}

beforeEach(() => {
  fake = createFakePlatform();
  fake.navigate = (route) => {
    fake.navigations.push(route);
    goto(route);
  };
  setPlatform(fake);
  resetStores();
  rows = { r1: row('r1', 'Shot 010'), ro: row('ro', 'Read only', false) };
  backend = new Backend(fake);
  backend
    .on(`GET /api/tables/${REF}/schema`, () => ({ body: schema }))
    .on(`GET /api/tables/${REF}/rows/`, (c) => {
      const found = rows[c.path.split('/').pop()!];
      return found ? { body: found } : { status: 404, body: { detail: 'Row not found' } };
    })
    .on(`PATCH /api/tables/${REF}/rows/`, (c) => {
      const id = c.path.split('/').pop()!;
      rows[id] = { ...rows[id]!, values: { ...rows[id]!.values, ...c.body.values } };
      return { body: rows[id] };
    })
    .on(`DELETE /api/tables/${REF}/rows/`, (c) => {
      delete rows[c.path.split('/').pop()!];
      return { body: { success: true } };
    });
  goto(`/p/p1/page/x?row=${REF}:r1`);
});

afterEach(() => {
  resetStores();
  setPlatform(null);
  goto('/');
});

describe('row panel of a custom table', () => {
  it('shows the title and every other column as a property, with no body, comments or subtasks', async () => {
    render(<RowPanelHost />);
    expect(((await screen.findByLabelText('Row name')) as HTMLInputElement).value).toBe('Shot 010');
    const props = await screen.findByTestId('task-properties');
    expect(within(props).getByText('Notes')).toBeTruthy();
    expect(within(props).getByText('Finished')).toBeTruthy();
    expect(within(props).getByText('Created')).toBeTruthy();
    expect(within(props).queryByText('Name')).toBeNull(); // the name is the title
    expect(screen.getByText('Shots')).toBeTruthy(); // the table's name
    expect(screen.queryByTestId('task-body')).toBeNull();
    expect(screen.queryByTestId('task-activity')).toBeNull();
  });

  it('renders nothing without ?row= and does not react to ?task=', () => {
    goto('/p/p1/pages?task=t1');
    const { container } = render(<RowPanelHost />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByTestId('row-panel')).toBeNull();
  });

  it('edits a property and the title through the table API', async () => {
    render(<RowPanelHost />);
    const props = await screen.findByTestId('task-properties');
    await userEvent.click(within(props).getByText('first note'));
    const input = within(props).getByRole('textbox');
    await userEvent.clear(input);
    await userEvent.type(input, 'second note{Enter}');
    await waitFor(() => expect(backend.calls.some((c) => c.method === 'PATCH' && c.body.values.cf_note === 'second note')).toBe(true));
    expect(await within(props).findByText('second note')).toBeTruthy();

    const title = screen.getByLabelText('Row name');
    await userEvent.clear(title);
    await userEvent.type(title, 'Shot 020{Enter}');
    await waitFor(() => expect(backend.calls.some((c) => c.method === 'PATCH' && c.body.values.name === 'Shot 020')).toBe(true));
    expect(fake.toasts).toEqual([]);
  });

  it('follows a change made by someone else (rows_changed)', async () => {
    render(<RowPanelHost />);
    const props = await screen.findByTestId('task-properties');
    await within(props).findByText('first note');
    rows.r1 = { ...rows.r1!, values: { ...rows.r1!.values, cf_note: 'from another user' } };
    act(() => fake.emit('rows_changed', { tableRef: REF, ids: ['r1'], change: 'updated', project: 'p1' }));
    expect(await within(props).findByText('from another user', {}, { timeout: 3000 })).toBeTruthy();
  });

  it('closes by removing only the row parameter, on the button and on Escape', async () => {
    goto(`/p/p1/page/x?a=1&row=${REF}:r1`);
    render(<RowPanelHost />);
    await screen.findByLabelText('Row name');
    await userEvent.click(screen.getByLabelText('Close row'));
    expect(window.location.pathname + window.location.search).toBe('/p/p1/page/x?a=1');

    act(() => goto(`/p/p1/page/x?row=${REF}:r1`));
    await screen.findByLabelText('Row name');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  it('deletes a row after a confirm and closes', async () => {
    render(<RowPanelHost />);
    await userEvent.click(await screen.findByLabelText('Delete row'));
    await waitFor(() => expect(backend.count(`DELETE /api/tables/${REF}/rows/r1`)).toBe(1));
    expect(fake.confirmations[0]?.opts?.danger).toBe(true);
    expect(window.location.search).toBe('');
  });

  it('a read-only row has no delete button and a read-only title', async () => {
    goto(`/p/p1/page/x?row=${REF}:ro`);
    render(<RowPanelHost />);
    const title = (await screen.findByLabelText('Row name')) as HTMLInputElement;
    expect(title.readOnly).toBe(true);
    expect(screen.queryByLabelText('Delete row')).toBeNull();
  });

  it('shows "not available" without a toast when the row cannot be read', async () => {
    goto(`/p/p1/page/x?row=${REF}:nope`);
    render(<RowPanelHost />);
    expect(await screen.findByText('This row is not available')).toBeTruthy();
    expect(fake.toasts).toEqual([]);
  });
});
