import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatform, NAVIGATE_EVENT } from '../platform';
import { createFakePlatform, type FakePlatform } from '../testing/fakePlatform';
import { resetStores } from '../tables/store';
import { Backend, rowOf, type Call } from '../tables/store/store.testutil';
import type { Row, TableSchema } from '../tables/types';
import { TaskPanelHost } from './TaskPanel';

// The editor chunk needs a socket; the panel only has to hand it the right page
vi.mock('../pages/sync', () => ({
  CollabEditor: ({ pageId, readOnly, hideStatusBar }: { pageId: string; readOnly?: boolean; hideStatusBar?: boolean }) => (
    <div data-testid="collab" data-page-id={pageId} data-readonly={String(!!readOnly)} data-hide-status={String(!!hideStatusBar)} />
  ),
  SyncStatus: ({ status }: { status: string }) => <span className="cl-sync-status" data-status={status} />,
}));

const schema: TableSchema = {
  ref: 'tasks:p1',
  name: 'Project tasks',
  titleColumn: 'name',
  capabilities: { create: true, delete: true, hierarchy: true, editSchema: false },
  columns: [
    { key: 'name', name: 'Name', type: 'text', builtin: true },
    {
      key: 'status',
      name: 'Status',
      type: 'status',
      builtin: true,
      options: [
        { value: 'todo', label: 'To do', done: false },
        { value: 'done', label: 'Done', done: true },
      ],
    },
    { key: 'description', name: 'Description', type: 'longtext', builtin: true },
    { key: 'cf_note', name: 'Note', type: 'text', builtin: false },
    { key: 'cf_link', name: 'Link', type: 'url', builtin: false },
    { key: 'createdAt', name: 'Created', type: 'date', builtin: true, readonly: true },
    { key: 'createdBy', name: 'Created by', type: 'person', builtin: true, readonly: true, options: [{ value: 'u1', label: 'Test User' }] },
  ],
};

const task = (id: string, name: string, extra: Partial<Row> = {}, values: Record<string, unknown> = {}): Row => ({
  ...rowOf(id, name, { cf_note: 'first note', description: 'old text', createdAt: '2030-01-02', createdBy: 'u1', ...values }),
  ...extra,
});

let fake: FakePlatform;
let backend: Backend;
let rows: Record<string, Row>;
let comments: Array<Record<string, unknown>>;
let pageGets: string[];

function goto(url: string) {
  window.history.pushState({}, '', url);
  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT));
}
const taskParam = () => new URLSearchParams(window.location.search).get('task');

beforeEach(() => {
  fake = createFakePlatform();
  // Navigation really changes the URL, so the panel follows it
  fake.navigate = (route) => {
    fake.navigations.push(route);
    goto(route);
  };
  setPlatform(fake);
  resetStores();
  rows = { t1: task('t1', 'Parent task'), sub1: task('sub1', 'Child task', { parentId: 't1' }), t2: task('t2', 'Other') };
  comments = [{ id: 'c1', userId: 'u1', userName: 'Test User', text: 'First comment', createdAt: new Date().toISOString() }];
  pageGets = [];
  backend = new Backend(fake);
  backend
    .on('GET /api/tables/tasks:p1/schema', () => ({ body: schema }))
    .on('GET /api/tables/tasks:*/rows/', (c) => {
      const row = rows[c.path.split('/').pop()!];
      return row ? { body: row } : { status: 404, body: { detail: 'Row not found' } };
    })
    .on('GET /api/tables/tasks:p1/rows/', (c) => {
      const row = rows[c.path.split('/').pop()!];
      return row ? { body: row } : { status: 404, body: { detail: 'Row not found' } };
    })
    .on('POST /api/tables/tasks:p1/query', (c: Call) => {
      const kids = Object.values(rows).filter((r) => r.parentId === c.body?.parentId);
      return { body: { rows: kids, total: kids.length } };
    })
    .on('PATCH /api/tables/tasks:p1/rows/', (c) => {
      const id = c.path.split('/').pop()!;
      rows[id] = { ...rows[id]!, values: { ...rows[id]!.values, ...c.body.values } };
      return { body: rows[id] };
    })
    .on('GET /api/tasks/t1/page', (c) => {
      pageGets.push(c.path);
      return { body: { id: 'page-t1', canEdit: true } };
    })
    .on('GET /api/tasks/sub1/page', () => ({ body: { id: 'page-sub1', canEdit: true } }))
    .on('GET /api/tasks/t1/comments', () => ({ body: { comments } }))
    .on('GET /api/tasks/t1/checklist', () => ({ body: { items: [{ id: 'k1', text: 'Check me', isChecked: false }] } }))
    .on('GET /api/tasks/t1/clips', () => ({ body: { clips: [{ id: 5, baseName: 'shot_010', activeVersion: 2, thumbnail: null }] } }))
    .on('GET /api/tasks/sub1/comments', () => ({ body: { comments: [] } }))
    .on('GET /api/tasks/sub1/checklist', () => ({ body: { items: [] } }))
    .on('GET /api/tasks/sub1/clips', () => ({ body: { clips: [] } }));
  goto('/p/p1/pages?task=t1');
});

afterEach(() => {
  resetStores();
  setPlatform(null);
  goto('/');
});

describe('task panel', () => {
  it('opens from the route and shows title, properties, body, clips, subtasks, checklist and the activity stream', async () => {
    render(<TaskPanelHost />);
    const title = (await screen.findByLabelText('Task name')) as HTMLInputElement;
    expect(title.value).toBe('Parent task');

    const props = await screen.findByTestId('task-properties');
    expect(within(props).getByText('Status')).toBeTruthy();
    expect(within(props).getByText('Note')).toBeTruthy();
    // Created and Created by are one muted line, not rows
    expect(within(props).queryByText('Created by')).toBeNull();
    expect(within(props).getByTestId('task-created').textContent).toBe('Created by Test User · Jan 2, 2030');
    // The name is the title and the description is the page body, so neither is a property
    expect(within(props).queryByText('Name')).toBeNull();
    expect(within(props).queryByText('Description')).toBeNull();

    expect((await screen.findByTestId('collab')).getAttribute('data-page-id')).toBe('page-t1');
    expect(await screen.findByText('shot_010')).toBeTruthy();
    expect(await screen.findByText('Child task')).toBeTruthy();
    expect(await screen.findByText('Check me')).toBeTruthy();
    expect(await screen.findByText('First comment')).toBeTruthy();
  });

  it('renders nothing without ?task= and closes by removing the parameter on Escape and on the close button', async () => {
    goto('/p/p1/pages');
    const { container } = render(<TaskPanelHost />);
    expect(screen.queryByTestId('task-panel')).toBeNull();
    expect(container.innerHTML).toBe('');

    act(() => goto('/p/p1/pages?task=t1&x=1'));
    await screen.findByLabelText('Task name');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(taskParam()).toBeNull());
    expect(window.location.search).toBe('?x=1');

    act(() => goto('/dev/view/v1?task=t1'));
    await screen.findByLabelText('Task name');
    await userEvent.click(screen.getByLabelText('Close task'));
    expect(window.location.pathname + window.location.search).toBe('/dev/view/v1');
  });

  it('shows "This task is not available" without a toast when the task cannot be read', async () => {
    goto('/p/p1/pages?task=nope');
    render(<TaskPanelHost />);
    expect(await screen.findByText('This task is not available')).toBeTruthy();
    expect(fake.toasts).toEqual([]);
  });

  it('edits a property through the table API and keeps it', async () => {
    render(<TaskPanelHost />);
    const props = await screen.findByTestId('task-properties');
    const cell = within(props).getByText('first note');
    await userEvent.click(cell);
    const input = within(props).getByRole('textbox');
    await userEvent.clear(input);
    await userEvent.type(input, 'second note{Enter}');
    await waitFor(() => expect(backend.calls.some((c) => c.method === 'PATCH' && c.body.values.cf_note === 'second note')).toBe(true));
    expect(await within(props).findByText('second note')).toBeTruthy();
    expect(fake.toasts).toEqual([]);
  });

  it('rolls a failed property edit back and shows a toast', async () => {
    backend.on('PATCH /api/tables/tasks:p1/rows/t1', () => ({ status: 400, body: { detail: 'Nope' } }));
    render(<TaskPanelHost />);
    const props = await screen.findByTestId('task-properties');
    await userEvent.click(within(props).getByText('first note'));
    const input = within(props).getByRole('textbox');
    await userEvent.clear(input);
    await userEvent.type(input, 'lost{Enter}');
    await waitFor(() => expect(fake.toasts).toEqual([{ kind: 'error', message: 'Nope' }]));
    expect(await within(props).findByText('first note')).toBeTruthy();
    expect(within(props).queryByText('lost')).toBeNull();
  });

  it('follows a change made by someone else (rows_changed) without a reload', async () => {
    render(<TaskPanelHost />);
    const props = await screen.findByTestId('task-properties');
    await within(props).findByText('first note');
    rows.t1 = task('t1', 'Renamed elsewhere', {}, { cf_note: 'from another user' });
    act(() => fake.emit('rows_changed', { tableRef: 'tasks:p1', ids: ['t1'], change: 'updated' }));
    expect(await within(props).findByText('from another user', {}, { timeout: 3000 })).toBeTruthy();
    expect((screen.getByLabelText('Task name') as HTMLInputElement).value).toBe('Renamed elsewhere');
  });

  it('opens a subtask in the panel and leads back through the breadcrumb', async () => {
    render(<TaskPanelHost />);
    await userEvent.click(await screen.findByText('Child task'));
    expect(taskParam()).toBe('sub1');
    await waitFor(() => expect((screen.getByLabelText('Task name') as HTMLInputElement).value).toBe('Child task'));
    expect((await screen.findByTestId('collab')).getAttribute('data-page-id')).toBe('page-sub1');
    const crumbs = screen.getByRole('navigation', { name: 'Parent tasks' });
    await userEvent.click(within(crumbs).getByText('Parent task'));
    expect(taskParam()).toBe('t1');
    await waitFor(() => expect((screen.getByLabelText('Task name') as HTMLInputElement).value).toBe('Parent task'));
  });

  it('adds a subtask under the task with the quick add row', async () => {
    backend.on('POST /api/tables/tasks:p1/rows', (c) => {
      const row = task('sub2', c.body.values.name, { parentId: c.body.parentId });
      rows.sub2 = row;
      return { body: row };
    });
    render(<TaskPanelHost />);
    await screen.findByText('Child task');
    const section = screen.getByTestId('task-subtasks');
    await userEvent.click(within(section).getByLabelText('Add subtask'));
    await userEvent.type(within(section).getByLabelText(/new/i), 'New child{Enter}');
    await waitFor(() => expect(backend.calls.some((c) => c.method === 'POST' && c.path.endsWith('/rows') && c.body.parentId === 't1')).toBe(true));
  });

  it('adds a comment at once, deletes it after a confirm and reloads when someone else comments', async () => {
    backend
      .on('POST /api/tasks/t1/comments', (c) => {
        const comment = { id: 'c2', userId: 'u1', userName: 'Test User', text: c.body.text, createdAt: new Date().toISOString() };
        comments = [...comments, comment];
        return { body: { comment } };
      })
      .on('DELETE /api/tasks/t1/comments/c2', () => ({ body: { success: true } }));
    render(<TaskPanelHost />);
    const section = await screen.findByTestId('task-comments');
    await within(section).findByText('First comment');
    await userEvent.type(screen.getByLabelText('Add a comment'), 'Second one{Enter}');
    expect(await within(section).findByText('Second one')).toBeTruthy();
    await waitFor(() => expect(backend.count('POST /api/tasks/t1/comments')).toBe(1));

    comments = [...comments, { id: 'c3', userId: 'u2', userName: 'Someone', text: 'Live comment', createdAt: new Date().toISOString() }];
    act(() => fake.emit('task_comments_changed', { taskId: 't1' }));
    expect(await within(section).findByText('Live comment')).toBeTruthy();

    const own = section.querySelector<HTMLElement>('[data-comment-id="c2"]')!;
    await userEvent.click(within(own).getByLabelText('Delete comment'));
    await waitFor(() => expect(backend.count('DELETE /api/tasks/t1/comments/c2')).toBe(1));
    expect(fake.confirmations[0]?.message).toBe('Delete this comment?');
  });

  it('rolls a failed comment back with a toast', async () => {
    backend.on('POST /api/tasks/t1/comments', () => ({ status: 500, body: { detail: 'boom' } }));
    render(<TaskPanelHost />);
    const section = await screen.findByTestId('task-comments');
    await within(section).findByText('First comment');
    await userEvent.type(screen.getByLabelText('Add a comment'), 'Will fail{Enter}');
    await waitFor(() => expect(fake.toasts).toEqual([{ kind: 'error', message: 'Failed to add comment' }]));
    expect(within(section).queryByText('Will fail', { selector: '.cl-comment__text' })).toBeNull();
  });

  it('shows the body read-only when the task cannot be edited', async () => {
    rows.t1 = task('t1', 'Parent task', { canEdit: false });
    render(<TaskPanelHost />);
    expect((await screen.findByTestId('collab')).getAttribute('data-readonly')).toBe('true');
  });

  it('turns into the unavailable state when the task is deleted by someone else', async () => {
    render(<TaskPanelHost />);
    await screen.findByLabelText('Task name');
    delete rows.t1;
    act(() => fake.emit('rows_changed', { tableRef: 'tasks:p1', ids: ['t1'], change: 'deleted' }));
    expect(await screen.findByText('This task is not available', {}, { timeout: 3000 })).toBeTruthy();
    expect(fake.toasts).toEqual([]);
  });

  it('collapses empty properties behind "Add property" and reveals them on request', async () => {
    render(<TaskPanelHost />);
    const props = await screen.findByTestId('task-properties');
    await within(props).findByText('Note');
    // Link has no value: no row of dashes for it
    expect(within(props).queryByText('Link')).toBeNull();
    const more = within(props).getByRole('button', { name: /Add property/ });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(more);
    expect(within(props).getByText('Link')).toBeTruthy();
    await userEvent.click(within(props).getByRole('button', { name: 'Hide empty' }));
    expect(within(props).queryByText('Link')).toBeNull();
  });

  it('shows no add-property control to someone who cannot edit', async () => {
    rows.t1 = task('t1', 'Parent task', { canEdit: false });
    render(<TaskPanelHost />);
    const props = await screen.findByTestId('task-properties');
    await within(props).findByText('Note');
    expect(within(props).queryByRole('button', { name: /Add property/ })).toBeNull();
    expect((screen.getByLabelText('Task name') as HTMLInputElement).readOnly).toBe(true);
  });

  it('has a done toggle that sets the done status and back to the first open one', async () => {
    render(<TaskPanelHost />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Mark as done' }));
    await waitFor(() => expect(backend.calls.some((c) => c.method === 'PATCH' && c.body.values.status === 'done')).toBe(true));
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Mark as not done' }));
    await waitFor(() => expect(backend.calls.some((c) => c.method === 'PATCH' && c.body.values.status === 'todo')).toBe(true));
  });

  it('shows sections without items as a small add button, and no empty Activity', async () => {
    goto('/p/p1/pages?task=sub1');
    render(<TaskPanelHost />);
    await screen.findByDisplayValue('Child task');
    for (const id of ['task-subtasks', 'task-checklist', 'task-clips']) {
      const section = await screen.findByTestId(id);
      expect(section.classList.contains('is-empty')).toBe(true);
      expect(section.querySelector('.cl-sec__body')).toBeNull();
    }
    expect(screen.queryByTestId('task-comments')).toBeNull();
    expect(screen.queryByText('No comments yet')).toBeNull();
    expect(screen.queryByText('No clips linked')).toBeNull();
    // The add action is still there, and opens the add row
    await userEvent.click(within(screen.getByTestId('task-checklist')).getByLabelText('Add checklist item'));
    expect(screen.getByLabelText('Add a checklist item')).toBeTruthy();
  });

  it('sends the comment on Enter and Ctrl+Enter, and breaks the line on Shift+Enter', async () => {
    backend.on('POST /api/tasks/t1/comments', (c) => ({
      body: { comment: { id: 'n1', userId: 'u1', userName: 'Test User', text: c.body.text, createdAt: new Date().toISOString() } },
    }));
    render(<TaskPanelHost />);
    const box = (await screen.findByLabelText('Add a comment')) as HTMLTextAreaElement;
    await userEvent.type(box, 'one{Shift>}{Enter}{/Shift}two');
    expect(backend.count('POST /api/tasks/t1/comments')).toBe(0);
    expect(box.value).toBe('one\ntwo');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(backend.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/comments'))[0]?.body.text).toBe('one\ntwo'));
    expect(box.value).toBe('');
  });

  it('labels the panel as a region and moves focus in, then back to the row when it closes', async () => {
    const row = document.createElement('div');
    row.tabIndex = 0;
    row.dataset.rowId = 't1';
    document.body.appendChild(row);
    row.focus();
    render(<TaskPanelHost />);
    const panel = await screen.findByRole('complementary', { name: 'Task' });
    await waitFor(() => expect(document.activeElement).toBe(panel));
    await userEvent.click(await screen.findByLabelText('Close task'));
    await waitFor(() => expect(document.activeElement).toBe(row));
    row.remove();
  });

  it('keeps the page usable: no scrim, and another task swaps in without closing', async () => {
    render(<TaskPanelHost />);
    await screen.findByDisplayValue('Parent task');
    expect(screen.queryByTestId('task-scrim')).toBeNull();
    act(() => goto('/p/p1/pages?task=t2'));
    await waitFor(() => expect((screen.getByLabelText('Task name') as HTMLInputElement).value).toBe('Other'));
    expect(screen.getAllByTestId('task-panel')).toHaveLength(1);
  });

  it('toggles the wide reading mode', async () => {
    render(<TaskPanelHost />);
    await screen.findByDisplayValue('Parent task');
    await userEvent.click(screen.getByLabelText('Wide view'));
    expect(screen.getByTestId('task-panel').className).toContain('is-wide');
    await userEvent.click(screen.getByLabelText('Narrow view'));
    expect(screen.getByTestId('task-panel').className).not.toContain('is-wide');
  });

  it('puts History in the more-actions menu and hides the editor status bar', async () => {
    render(<TaskPanelHost />);
    expect((await screen.findByTestId('collab')).getAttribute('data-hide-status')).toBe('true');
    await userEvent.click(await screen.findByLabelText('More actions'));
    expect(await screen.findByRole('menuitem', { name: 'History' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Delete task' })).toBeTruthy();
  });
});
