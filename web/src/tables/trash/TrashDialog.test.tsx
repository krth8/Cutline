import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setPlatform } from '../../platform';
import { createFakePlatform, type FakePlatform } from '../../testing/fakePlatform';
import { TrashDialog } from './TrashDialog';

let fake: FakePlatform;
let items: Array<Record<string, unknown>>;

const item = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  tableRef: 'tasks:p1',
  deletedAt: '2030-01-02T10:00:00',
  deletedBy: 'u1',
  deletedByName: 'Ann',
  parentId: null,
  parentName: null,
  subtaskCount: 0,
  ...extra,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const calls = (method: string) => fake.fetchCalls.filter((c) => (c.init?.method ?? 'GET') === method);

beforeEach(() => {
  fake = createFakePlatform();
  setPlatform(fake);
  items = [item('a', 'Alpha', { subtaskCount: 2 }), item('b', 'Beta', { parentId: 'z', parentName: 'Zed' }), item('c', 'Gamma')];
  fake.routes['GET /api/tables/tasks%3Ap1/trash'] = () => json({ items });
  fake.routes['POST /api/tables/tasks%3Ap1/rows/restore'] = (_p: string, init?: RequestInit) => {
    const ids = JSON.parse(String(init?.body)).ids as string[];
    items = items.filter((i) => !ids.includes(i.id as string));
    return json({ restored: ids });
  };
  fake.routes['DELETE /api/tables/tasks%3Ap1/trash/c'] = () => {
    items = items.filter((i) => i.id !== 'c');
    return json({ success: true });
  };
  fake.routes['DELETE /api/tables/tasks%3Ap1/trash'] = () => {
    items = [];
    return json({ removed: 2 });
  };
});

afterEach(() => {
  cleanup();
  setPlatform(null);
});

function open() {
  return render(<TrashDialog tableRef="tasks:p1" open onClose={() => {}} />);
}

describe('TrashDialog', () => {
  it('lists the deleted tasks with who deleted them, the parent and the subtask count', async () => {
    open();
    const list = await screen.findByRole('list', { name: 'Deleted tasks' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('Alpha');
    expect(rows[0]!.textContent).toContain('by Ann');
    expect(rows[0]!.textContent).toContain('2 subtasks');
    expect(rows[1]!.textContent).toContain('subtask of Zed');
  });

  it('says so when the trash is empty', async () => {
    items = [];
    open();
    expect(await screen.findByText('The trash is empty.')).toBeTruthy();
  });

  it('restores one task from its row', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Restore Beta' }));
    await waitFor(() => expect(screen.queryByText('Beta')).toBeNull());
    expect(JSON.parse(String(calls('POST')[0]!.init?.body))).toEqual({ ids: ['b'] });
    expect(fake.toasts).toEqual([{ kind: 'success', message: 'Restored 1 task' }]);
  });

  it('restores a selection in one request', async () => {
    const user = userEvent.setup();
    open();
    const restore = await screen.findByRole('button', { name: 'Restore selected' });
    expect((restore as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Gamma' }));
    await user.click(screen.getByRole('button', { name: 'Restore selected (2)' }));
    await waitFor(() => expect(screen.queryByText('Alpha')).toBeNull());
    expect(JSON.parse(String(calls('POST')[0]!.init?.body))).toEqual({ ids: ['a', 'c'] });
    expect(screen.getByText('Beta')).toBeTruthy();
  });

  it('deletes forever only after a confirmation', async () => {
    const user = userEvent.setup();
    open();
    fake.confirmAnswer = false;
    await user.click(await screen.findByRole('button', { name: 'Delete Gamma forever' }));
    await waitFor(() => expect(fake.confirmations).toHaveLength(1));
    expect(calls('DELETE')).toHaveLength(0);
    fake.confirmAnswer = true;
    await user.click(screen.getByRole('button', { name: 'Delete Gamma forever' }));
    await waitFor(() => expect(screen.queryByText('Gamma')).toBeNull());
    expect(fake.confirmations[1]!.message).toContain('forever');
  });

  it('offers Empty trash to the project owner and empties it after a confirmation', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Empty trash' }));
    await screen.findByText('The trash is empty.');
    expect(fake.confirmations).toHaveLength(1);
    expect(calls('DELETE').map((c) => c.path)).toEqual(['/api/tables/tasks%3Ap1/trash']);
  });

  it('does not offer Empty trash to someone who is not owner or admin', async () => {
    fake.data.user = { id: 'u2', username: 'Bob', role: 'editor' };
    fake.data.projects = [{ id: 'p1', name: 'P', canTasks: true, isOwner: false }];
    open();
    await screen.findByRole('list', { name: 'Deleted tasks' });
    expect(screen.queryByRole('button', { name: 'Empty trash' })).toBeNull();
  });

  it('shows the error when the trash cannot be loaded', async () => {
    fake.routes['GET /api/tables/tasks%3Ap1/trash'] = () => json({ detail: 'Task access denied for this project' }, 403);
    open();
    expect((await screen.findByRole('alert')).textContent).toContain('Task access denied');
  });
});
