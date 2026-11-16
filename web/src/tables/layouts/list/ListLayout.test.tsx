import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setPlatform } from '../../../platform';
import { createFakePlatform } from '../../../testing/fakePlatform';
import type { LayoutProps, Row, TableSchema } from '../../types';
import { getLayout } from '../registry';
import './index';
import { ListLayout } from './ListLayout';
import { doneModel } from './listHelpers';

const schema = (ref = 'tasks:p1'): TableSchema => ({
  ref,
  name: 'Tasks',
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
        { value: 's-todo', label: 'To do' },
        { value: 's-doing', label: 'Doing' },
        { value: 's-done', label: 'Done' },
      ],
    },
    { key: 'dueDate', name: 'Due', type: 'date', builtin: true },
  ],
});

const row = (id: string, name: string, status: string | null, extra: Record<string, unknown> = {}): Row => ({
  id,
  tableRef: 'tasks:p1',
  values: { name, status, dueDate: null, ...extra },
  canEdit: true,
});

function setup(rows: Row[], over: Partial<LayoutProps> = {}) {
  const actions = {
    updateRow: vi.fn(async () => {}),
    createRow: vi.fn(async (values: Record<string, unknown>) => ({ ...row('new', String(values.name), null) })),
    deleteRows: vi.fn(async () => {}),
    reorder: vi.fn(async () => {}),
    openRow: vi.fn(),
    updateConfig: vi.fn(),
    loadChildren: vi.fn(async () => []),
  };
  const props: LayoutProps = {
    schema: schema(),
    view: { id: 'v1', tableRef: 'tasks:p1', name: 'List', layout: 'list', config: { query: {} } },
    result: { rows, total: rows.length },
    loading: false,
    actions,
    ...over,
  };
  const utils = render(<ListLayout {...props} />);
  return { actions, props, ...utils };
}

let ro: { cb: ResizeObserverCallback; el: Element | null } | null;

beforeEach(() => {
  setPlatform(createFakePlatform());
  ro = null;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: ResizeObserverCallback) {
        ro = { cb, el: null };
      }
      observe(el: Element) {
        if (ro) ro.el = el;
      }
      disconnect() {}
      unobserve() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  setPlatform(null);
});

const rows = () => [row('r1', 'Write script', 's-todo'), row('r2', 'Edit cut', 's-done')];

describe('list layout', () => {
  it('is registered as "list" with a secondaryColumns default', () => {
    expect(getLayout('list')?.component).toBe(ListLayout);
  });

  it('finds the done option by name and falls back to nothing', () => {
    const m = doneModel(schema())!;
    expect(m.doneValue).toBe('s-done');
    expect(m.openValue).toBe('s-todo');
    const s = schema();
    s.columns[1]!.options = [{ value: 'a', label: 'Alpha' }];
    expect(doneModel(s)).toBeUndefined();
  });

  it('shows checked rows struck through and secondary values', () => {
    setup([row('r1', 'Write script', 's-todo', { dueDate: '2026-06-20' }), row('r2', 'Edit cut', 's-done')]);
    const items = document.querySelectorAll('[data-row-id]');
    expect(items[0]!.getAttribute('data-done')).toBe('false');
    expect(items[1]!.getAttribute('data-done')).toBe('true');
    expect((within(items[1] as HTMLElement).getByTestId('list-check') as HTMLInputElement).checked).toBe(true);
    expect(items[0]!.querySelector('[data-column=status]')).toBeTruthy();
    expect(items[0]!.querySelector('[data-column=dueDate]')).toBeTruthy();
    expect(items[1]!.querySelector('[data-column=dueDate]')).toBeNull(); // empty values are left out
  });

  it('checking a row sets the done status, unchecking sets the first not-done option', async () => {
    const user = userEvent.setup();
    const { actions } = setup(rows());
    const boxes = screen.getAllByTestId('list-check');
    await user.click(boxes[0]!);
    expect(actions.updateRow).toHaveBeenCalledWith('r1', { status: 's-done' });
    await user.click(boxes[1]!);
    expect(actions.updateRow).toHaveBeenCalledWith('r2', { status: 's-todo' });
  });

  it('title click opens the row, double click edits it inline', async () => {
    const user = userEvent.setup();
    const { actions } = setup(rows());
    await user.click(screen.getByText('Write script'));
    expect(actions.openRow).toHaveBeenCalledWith('r1');
    await user.dblClick(screen.getByText('Edit cut'));
    const input = screen.getByLabelText('Title');
    await user.clear(input);
    await user.type(input, 'Final cut{Enter}');
    expect(actions.updateRow).toHaveBeenCalledWith('r2', { name: 'Final cut' });
  });

  it('F2 edits and Escape cancels', async () => {
    const user = userEvent.setup();
    const { actions } = setup(rows());
    const first = document.querySelector<HTMLElement>('[data-row-id=r1]')!;
    first.focus();
    await user.keyboard('{F2}');
    await user.type(screen.getByLabelText('Title'), 'xx{Escape}');
    expect(screen.queryByLabelText('Title')).toBeNull();
    expect(actions.updateRow).not.toHaveBeenCalled();
  });

  it('keyboard: arrows move, space toggles, enter opens', async () => {
    const user = userEvent.setup();
    const { actions } = setup(rows());
    document.querySelector<HTMLElement>('[data-row-id=r1]')!.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement?.getAttribute('data-row-id')).toBe('r2');
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement?.getAttribute('data-row-id')).toBe('r1');
    await user.keyboard(' ');
    expect(actions.updateRow).toHaveBeenCalledWith('r1', { status: 's-done' });
    await user.keyboard('{Enter}');
    expect(actions.openRow).toHaveBeenCalledWith('r1');
  });

  it('draws group headings when the view is grouped', () => {
    setup(rows(), {
      view: { id: 'v1', tableRef: 'tasks:p1', name: 'L', layout: 'list', config: { query: { groupBy: 'status' } } },
      result: {
        rows: rows(),
        total: 2,
        groups: [
          { key: 's-todo', label: 'To do', count: 1 },
          { key: 's-done', label: 'Done', count: 1 },
        ],
      },
    });
    const groups = screen.getAllByTestId('list-group');
    expect(groups.map((g) => g.textContent)).toEqual(['To do1', 'Done1']);
    const sections = document.querySelectorAll('.cl-list__section');
    expect(within(sections[0] as HTMLElement).getByText('Write script')).toBeTruthy();
    expect(within(sections[1] as HTMLElement).getByText('Edit cut')).toBeTruthy();
  });

  it('switches to the narrow layout below 420px and back', () => {
    setup(rows());
    const root = screen.getByTestId('list-layout');
    expect(root.getAttribute('data-narrow')).toBeNull();
    act(() => ro!.cb([{ contentRect: { width: 280 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(root.getAttribute('data-narrow')).toBe('true');
    expect(root.className).toContain('is-narrow');
    act(() => ro!.cb([{ contentRect: { width: 600 } } as ResizeObserverEntry], {} as ResizeObserver));
    expect(root.getAttribute('data-narrow')).toBeNull();
  });

  it('quick add creates a row in the current table', async () => {
    const user = userEvent.setup();
    const { actions } = setup(rows());
    await user.type(screen.getByTestId('list-new'), 'Grade{Enter}');
    expect(actions.createRow).toHaveBeenCalledWith({ name: 'Grade' }, undefined);
    expect((screen.getByTestId('list-new') as HTMLInputElement).value).toBe('');
  });

  it('quick add on tasks:* asks for a project', async () => {
    const user = userEvent.setup();
    setPlatform(
      createFakePlatform({
        projects: [
          { id: 'p1', name: 'One', canTasks: true, isOwner: true },
          { id: 'p2', name: 'Two', canTasks: true, isOwner: false },
          { id: 'p3', name: 'Read only', canTasks: false, isOwner: false },
        ],
      }),
    );
    const { actions } = setup([], { schema: schema('tasks:*') });
    expect(screen.queryByLabelText('Project for the new row')).toBeNull(); // only once the user starts adding
    await user.click(screen.getByTestId('list-new'));
    const select = screen.getByLabelText('Project for the new row') as HTMLSelectElement;
    expect([...select.options].map((o) => o.text)).toEqual(['One', 'Two']);
    fireEvent.change(select, { target: { value: 'p2' } });
    await user.type(screen.getByTestId('list-new'), 'Cue{Enter}');
    expect(actions.createRow).toHaveBeenCalledWith({ name: 'Cue' }, { projectId: 'p2' });
  });
});
