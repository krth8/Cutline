import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatform } from '../../../platform';
import { createFakePlatform, type FakePlatform } from '../../../testing/fakePlatform';
import { resetStores } from '../../store';
import { resultOf, rowOf, schemaOf } from '../../store/store.testutil';
import type { LayoutProps, QueryResult, Row, View } from '../../types';
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

function makeProps(rows: Row[], over: Partial<LayoutProps> = {}, config: Partial<View['config']> = {}): LayoutProps {
  return {
    schema: schemaOf('tasks:p1'),
    view: { id: 'v1', tableRef: 'tasks:p1', name: 'All', layout: 'table', config: { query: {}, ...config } },
    result: resultOf(rows),
    loading: false,
    actions: {
      updateRow: vi.fn().mockResolvedValue(undefined),
      createRow: vi.fn().mockImplementation(async (values) => rowOf('new', String(values.name))),
      deleteRows: vi.fn().mockResolvedValue(undefined),
      reorder: vi.fn().mockResolvedValue(undefined),
      openRow: vi.fn(),
      updateConfig: vi.fn(),
      loadChildren: vi.fn().mockResolvedValue([]),
    },
    ...over,
  };
}

const names = () => screen.queryAllByTestId('table-row').map((r) => r.querySelector('[data-col=name] .cl-table__title')?.textContent?.trim());

/** A drag event with pointer coordinates (jsdom has no DragEvent, so fireEvent drops clientX/clientY). */
function fireDrag(el: Element, type: string, init: { clientX?: number; clientY?: number; dataTransfer: unknown }) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clientX', { value: init.clientX ?? 0 });
  Object.defineProperty(ev, 'clientY', { value: init.clientY ?? 0 });
  Object.defineProperty(ev, 'dataTransfer', { value: init.dataTransfer });
  fireEvent(el, ev);
}
const manyRows = (n: number) => Array.from({ length: n }, (_, i) => rowOf(`t${i}`, `Task ${i}`));

describe('virtual window', () => {
  it('keeps only a window of 2,000 rows in the DOM and follows the scroll position', () => {
    render(<TableLayout {...makeProps(manyRows(2000))} />);
    const first = screen.getAllByTestId('table-row');
    expect(first.length).toBeGreaterThan(5);
    expect(first.length).toBeLessThan(60);
    expect(names()[0]).toBe('Task 0');

    const scroller = screen.getByTestId('table-scroll');
    scroller.scrollTop = 34 * 1500;
    fireEvent.scroll(scroller);
    expect(screen.queryAllByTestId('table-row').length).toBeLessThan(60);
    expect(names()).toContain('Task 1500');
    expect(names()).not.toContain('Task 0');
    // the body is as tall as all rows, so the scrollbar is right
    expect(screen.getByTestId('table-scroll').querySelector<HTMLElement>('.cl-table__body')!.style.height).toBe(`${34 * 2001}px`);
  });

  it('shows the row count and an empty note', () => {
    render(<TableLayout {...makeProps([])} />);
    expect(screen.getByTestId('table-count').textContent).toBe('0 rows');
    expect(screen.getByTestId('table-empty')).toBeTruthy();
  });
});

describe('editing and creating', () => {
  it('sends an edit of a cell through actions.updateRow', async () => {
    const props = makeProps([rowOf('t1', 'Alpha')]);
    render(<TableLayout {...props} />);
    const user = userEvent.setup();
    const cell = screen.getByTestId('table-row').querySelector('[data-col=name] .cl-cellhost')!;
    await user.click(cell);
    const input = await within(cell as HTMLElement).findByRole('textbox');
    await user.clear(input);
    await user.type(input, 'Gamma{Enter}');
    expect(props.actions.updateRow).toHaveBeenCalledWith('t1', { name: 'Gamma' });
  });

  it('quick add creates a row with the typed title and clears the field', async () => {
    const props = makeProps([rowOf('t1', 'Alpha')]);
    render(<TableLayout {...props} />);
    const user = userEvent.setup();
    const input = screen.getByTestId('table-quick-add');
    await user.type(input, 'Fresh{Enter}');
    expect(props.actions.createRow).toHaveBeenCalledWith({ name: 'Fresh' }, undefined);
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('asks for a project when the table is tasks:*', async () => {
    fake.data.projects = [
      { id: 'p1', name: 'One', canTasks: true, isOwner: true },
      { id: 'p2', name: 'Two', canTasks: true, isOwner: false },
      { id: 'p3', name: 'Read only', canTasks: false, isOwner: false },
    ];
    const base = makeProps([]);
    const props = makeProps([], { view: { ...base.view, tableRef: 'tasks:*' }, schema: schemaOf('tasks:*') });
    render(<TableLayout {...props} />);
    const user = userEvent.setup();
    const picker = screen.getByTestId('table-add-project') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.text)).toEqual(['One', 'Two']);
    await user.selectOptions(picker, 'p2');
    await user.type(screen.getByTestId('table-quick-add'), 'Cross{Enter}');
    expect(props.actions.createRow).toHaveBeenCalledWith({ name: 'Cross' }, { projectId: 'p2' });
  });
});

describe('selection and bulk actions', () => {
  it('selects rows, deletes them after a confirm and clears the selection', async () => {
    const props = makeProps([rowOf('a', 'A'), rowOf('b', 'B'), rowOf('c', 'C')]);
    render(<TableLayout {...props} />);
    const user = userEvent.setup();
    expect(screen.queryByTestId('table-bulk-bar')).toBeNull();
    const boxes = screen.getAllByTestId('table-select-row');
    await user.click(boxes[0]!);
    await user.click(boxes[2]!);
    expect(screen.getByTestId('table-bulk-count').textContent).toBe('2 selected');
    await user.click(screen.getByTestId('table-bulk-delete'));
    expect(fake.confirmations[0]?.message).toContain('Delete 2 rows');
    await waitFor(() => expect(props.actions.deleteRows).toHaveBeenCalledWith(['a', 'c']));
    expect(screen.queryByTestId('table-bulk-bar')).toBeNull();
  });

  it('does not delete when the confirm is declined', async () => {
    fake.confirmAnswer = false;
    const props = makeProps([rowOf('a', 'A')]);
    render(<TableLayout {...props} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('table-select-row'));
    await user.click(screen.getByTestId('table-bulk-delete'));
    await waitFor(() => expect(fake.confirmations).toHaveLength(1));
    expect(props.actions.deleteRows).not.toHaveBeenCalled();
  });

  it('shift-click selects a range and select-all ticks everything', async () => {
    const props = makeProps(manyRows(6));
    render(<TableLayout {...props} />);
    const user = userEvent.setup();
    const boxes = () => screen.getAllByTestId('table-select-row');
    await user.click(boxes()[1]!);
    await user.keyboard('{Shift>}');
    await user.click(boxes()[4]!);
    await user.keyboard('{/Shift}');
    expect(screen.getByTestId('table-bulk-count').textContent).toBe('4 selected');
    await user.click(screen.getByTestId('table-select-all'));
    expect(screen.getByTestId('table-bulk-count').textContent).toBe('6 selected');
  });

  it('sets a column for all selected rows', async () => {
    const props = makeProps([rowOf('a', 'A'), rowOf('b', 'B', {}, 'tasks:p1'), { ...rowOf('c', 'C'), canEdit: false }]);
    render(<TableLayout {...props} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('table-select-all'));
    await user.selectOptions(screen.getByTestId('table-bulk-column'), 'name');
    const host = within(screen.getByTestId('table-bulk-value')).getByText('', { selector: '.cl-cellhost' }).closest('.cl-cellhost')!;
    await user.click(host);
    const input = await within(screen.getByTestId('table-bulk-value')).findByRole('textbox');
    await user.type(input, 'Same{Enter}');
    expect(props.actions.updateRow).toHaveBeenCalledTimes(2);
    expect(props.actions.updateRow).toHaveBeenCalledWith('a', { name: 'Same' });
    expect(props.actions.updateRow).toHaveBeenCalledWith('b', { name: 'Same' });
    expect(fake.toasts[fake.toasts.length - 1]?.message).toContain('1 rows were skipped');
  });
});

describe('groups, summaries and columns', () => {
  const grouped = (): LayoutProps => {
    const rows = [rowOf('a', 'A', { status: 'todo' }), rowOf('b', 'B', { status: 'done' }), rowOf('c', 'C', { status: 'todo' })];
    const result: QueryResult = {
      ...resultOf(rows),
      groups: [
        { key: 'todo', label: 'To do', count: 2, color: '#888', summaries: { name: 2 } },
        { key: 'done', label: 'Done', count: 1, summaries: { name: 1 } },
      ],
      summaries: { name: 3 },
    };
    return makeProps(rows, { result }, { query: { groupBy: 'status', summaries: { name: 'count' } } });
  };

  it('draws group headers with counts and summaries and collapses a group', async () => {
    render(<TableLayout {...grouped()} />);
    const user = userEvent.setup();
    const groups = screen.getAllByTestId('table-group');
    expect(groups).toHaveLength(2);
    expect(groups[0]!.textContent).toContain('To do');
    expect(within(groups[0]!).getByTestId('table-group-count').textContent).toBe('2');
    expect(names()).toEqual(['A', 'C', 'B']);
    await user.click(within(groups[0]!).getByTestId('table-group-toggle'));
    expect(names()).toEqual(['B']);
    await user.click(within(screen.getAllByTestId('table-group')[0]!).getByTestId('table-group-toggle'));
    expect(names()).toEqual(['A', 'C', 'B']);
  });

  it('shows summaries in the footer', () => {
    render(<TableLayout {...grouped()} />);
    expect(screen.getAllByTestId('table-summary')[0]!.textContent).toBe('Count 3');
  });

  it('saves a resized column in the layout config', () => {
    const props = makeProps([rowOf('a', 'A')]);
    render(<TableLayout {...props} />);
    const handle = screen.getAllByTestId('table-resize')[0]!;
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(props.actions.updateConfig).toHaveBeenCalledWith({ table: { widths: { name: 336 } } });
  });

  it('saves a column drag as the full column order', () => {
    const props = makeProps([rowOf('a', 'A')]);
    render(<TableLayout {...props} />);
    const headers = screen.getAllByRole('columnheader');
    const label = (i: number) => headers[i]!.querySelector('.cl-table__hlabel')!;
    const dataTransfer = { setData: vi.fn(), getData: vi.fn(), effectAllowed: '' };
    fireEvent.dragStart(label(3), { dataTransfer }); // Priority
    fireDrag(headers[1]!, 'dragover', { dataTransfer, clientX: -1 }); // before Name
    fireDrag(headers[1]!, 'drop', { dataTransfer });
    expect(props.actions.updateConfig).toHaveBeenCalledWith({ columns: [{ key: 'priority' }, { key: 'name' }, { key: 'status' }] });
  });
});

describe('keyboard and clipboard', () => {
  it('arrow keys move between cells and rows', async () => {
    render(<TableLayout {...makeProps([rowOf('a', 'A'), rowOf('b', 'B')])} />);
    const cell = (row: number, col: string) => screen.getAllByTestId('table-row')[row]!.querySelector<HTMLElement>(`[data-col=${col}] .cl-cellhost`)!;
    cell(0, 'name').focus();
    fireEvent.keyDown(cell(0, 'name'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cell(0, 'status'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cell(1, 'status'));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(cell(1, 'name'));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(cell(0, 'name'));
  });

  it('Ctrl+A selects all rows and Escape clears them', () => {
    render(<TableLayout {...makeProps([rowOf('a', 'A'), rowOf('b', 'B')])} />);
    const cell = screen.getAllByTestId('table-row')[0]!.querySelector<HTMLElement>('[data-col=name] .cl-cellhost')!;
    cell.focus();
    fireEvent.keyDown(cell, { key: 'a', ctrlKey: true });
    expect(screen.getByTestId('table-bulk-count').textContent).toBe('2 selected');
    fireEvent.keyDown(cell, { key: 'Escape' });
    expect(screen.queryByTestId('table-bulk-bar')).toBeNull();
  });

  it('copies the focused cell as text', () => {
    render(<TableLayout {...makeProps([rowOf('a', 'Alpha')])} />);
    const cell = screen.getByTestId('table-row').querySelector<HTMLElement>('[data-col=name] .cl-cellhost')!;
    const setData = vi.fn();
    fireEvent.copy(cell, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith('text/plain', 'Alpha');
  });

  it('pastes tab-separated text from the focused cell', () => {
    const props = makeProps([rowOf('a', 'A'), rowOf('b', 'B')]);
    render(<TableLayout {...props} />);
    const cell = screen.getAllByTestId('table-row')[0]!.querySelector<HTMLElement>('[data-col=name] .cl-cellhost')!;
    fireEvent.paste(cell, { clipboardData: { getData: () => 'X\nY' } });
    expect(props.actions.updateRow).toHaveBeenCalledWith('a', { name: 'X' });
    expect(props.actions.updateRow).toHaveBeenCalledWith('b', { name: 'Y' });
  });
});

describe('subtasks', () => {
  const parent: Row = { ...rowOf('p', 'Parent'), childCount: 1 };
  const child: Row = { ...rowOf('c1', 'Child'), parentId: 'p' };

  it('expands a row through loadChildren and adds a subtask', async () => {
    const props = makeProps([parent], {}, { query: { parentId: null } });
    (props.actions.loadChildren as ReturnType<typeof vi.fn>).mockResolvedValue([child]);
    render(<TableLayout {...props} />);
    const user = userEvent.setup();
    await user.click(screen.getByTestId('table-expand'));
    await waitFor(() => expect(names()).toEqual(['Parent', 'Child']));
    expect(props.actions.loadChildren).toHaveBeenCalledWith('p');
    expect(screen.getAllByTestId('table-row')[1]!.getAttribute('data-depth')).toBe('1');

    await user.type(screen.getByTestId('table-add-child'), 'Second{Enter}');
    expect(props.actions.createRow).toHaveBeenCalledWith({ name: 'Second' }, { parentId: 'p' });

    await user.click(screen.getAllByTestId('table-expand')[0]!);
    expect(names()).toEqual(['Parent']);
  });

  it('shows no carets when the view is flat, and the toggle nests it', async () => {
    const props = makeProps([parent]);
    render(<TableLayout {...props} />);
    expect(screen.queryByTestId('table-expand')).toBeNull();
    await userEvent.setup().click(screen.getByTestId('table-nest'));
    expect(props.actions.updateConfig).toHaveBeenCalledWith({ query: { parentId: null } });
  });

  it('opens a row in the task panel', async () => {
    const props = makeProps([rowOf('a', 'A')]);
    render(<TableLayout {...props} />);
    await userEvent.setup().click(screen.getByTestId('table-open-row'));
    expect(props.actions.openRow).toHaveBeenCalledWith('a');
  });
});

describe('drag to reorder', () => {
  function drag(props: LayoutProps, from: number, to: number, y: number) {
    render(<TableLayout {...props} />);
    const rows = screen.getAllByTestId('table-row');
    const handle = rows[from]!.querySelector('[data-drag-handle]')!;
    const dataTransfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireDrag(handle, 'dragstart', { dataTransfer });
    const target = rows[to]!;
    target.getBoundingClientRect = () => ({ top: 0, height: 34, bottom: 34, left: 0, right: 100, width: 100, x: 0, y: 0, toJSON: () => ({}) });
    fireDrag(target, 'dragover', { dataTransfer, clientY: y });
    fireDrag(target, 'drop', { dataTransfer, clientY: y });
  }

  it('sends the new position to actions.reorder when the view is not sorted', () => {
    const props = makeProps([rowOf('a', 'A'), rowOf('b', 'B'), rowOf('c', 'C')]);
    drag(props, 2, 0, 5);
    expect(props.actions.reorder).toHaveBeenCalledWith(['c'], 'a');
  });

  it('drops after the lower half of a row', () => {
    const props = makeProps([rowOf('a', 'A'), rowOf('b', 'B'), rowOf('c', 'C')]);
    drag(props, 0, 1, 30);
    expect(props.actions.reorder).toHaveBeenCalledWith(['a'], 'c');
  });

  it('has no drag handles while the view is sorted', () => {
    const props = makeProps([rowOf('a', 'A'), rowOf('b', 'B')], {}, { query: { sort: [{ column: 'name', dir: 'asc' }] } });
    render(<TableLayout {...props} />);
    expect(document.querySelector('[data-drag-handle]')).toBeNull();
    act(() => {});
  });
});
