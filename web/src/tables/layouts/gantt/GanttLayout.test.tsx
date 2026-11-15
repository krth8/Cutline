import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { setPlatform } from '../../../platform';
import { createFakePlatform } from '../../../testing/fakePlatform';
import type { LayoutProps, Row, TableSchema } from '../../types';
import { getLayout } from '../registry';
import './index';
import { GanttLayout } from './GanttLayout';
import { addDays, monthStartIndex, toDayIndex, todayString } from './dates';
import { PX_PER_DAY } from './model';

const schema = (withDates = true): TableSchema => ({
  ref: 'tasks:p1',
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
        { value: 's-doing', label: 'Doing', color: '#336699' },
        { value: 's-done', label: 'Done' },
      ],
    },
    ...(withDates
      ? [
          { key: 'startDate', name: 'Start date', type: 'date' as const, builtin: true },
          { key: 'dueDate', name: 'Due date', type: 'date' as const, builtin: true },
        ]
      : []),
  ],
});

const today = todayString();
const at = (n: number) => addDays(today, n) as string;

const row = (id: string, values: Record<string, unknown>, extra: Partial<Row> = {}): Row => ({
  id,
  tableRef: 'tasks:p1',
  values: { name: id, status: null, startDate: null, dueDate: null, ...values },
  canEdit: true,
  ...extra,
});

function setup(rows: Row[], over: Partial<LayoutProps> = {}, config: LayoutProps['view']['config'] = { query: {}, gantt: { startColumn: 'startDate', endColumn: 'dueDate', scale: 'day' } }) {
  const actions = {
    updateRow: vi.fn(async () => {}),
    createRow: vi.fn(async (values: Record<string, unknown>) => row('new', { name: values.name })),
    deleteRows: vi.fn(async () => {}),
    reorder: vi.fn(async () => {}),
    openRow: vi.fn(),
    updateConfig: vi.fn(),
    loadChildren: vi.fn(async (): Promise<Row[]> => []),
  };
  const props: LayoutProps = {
    schema: schema(),
    view: { id: 'v1', tableRef: 'tasks:p1', name: 'Gantt', layout: 'gantt', config },
    result: { rows, total: rows.length },
    loading: false,
    actions,
    ...over,
  };
  const utils = render(<GanttLayout {...props} />);
  return { actions, props, ...utils };
}

/** Pointer events on window, the way the layout listens to them while a drag is running. */
const pointerMove = (clientX: number) => fireEvent(window, new MouseEvent('pointermove', { clientX, bubbles: true }));
const pointerUp = (clientX: number) => fireEvent(window, new MouseEvent('pointerup', { clientX, bubbles: true }));
const press = (el: Element, clientX: number) => fireEvent(el, new MouseEvent('pointerdown', { clientX, button: 0, bubbles: true }));

beforeEach(() => {
  setPlatform(createFakePlatform());
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setPlatform(null);
});

describe('gantt layout', () => {
  it('is registered as "gantt" with start and due date as defaults', () => {
    const entry = getLayout('gantt')!;
    expect(entry.component).toBe(GanttLayout);
    expect(typeof entry.defaults === 'function' ? entry.defaults(schema()) : entry.defaults).toEqual({
      gantt: { startColumn: 'startDate', endColumn: 'dueDate', scale: 'week' },
    });
  });

  it('draws a bar per dated row and lists rows without dates as unscheduled', () => {
    setup([row('a', { startDate: at(1), dueDate: at(3) }), row('b', { dueDate: at(5) }), row('c', {})]);
    const bars = screen.getAllByTestId('gantt-bar');
    expect(bars.map((b) => [b.dataset.rowId, b.dataset.start, b.dataset.end, b.dataset.kind])).toEqual([
      ['a', at(1), at(3), 'bar'],
      ['b', at(5), at(5), 'marker'],
    ]);
    expect(screen.getByTestId('gantt-unscheduled').textContent).toContain('Unscheduled');
    const titles = screen.getAllByTestId('gantt-row-title').map((t) => t.textContent);
    expect(titles).toEqual(['a', 'b', 'c']);
    expect(screen.getByTestId('gantt-today-line')).toBeTruthy();
    expect(screen.getAllByTestId('gantt-weekend').length).toBeGreaterThan(0);
  });

  it('opens a row by its title and by a click on its bar, but not after a drag', () => {
    const { actions } = setup([row('a', { startDate: at(1), dueDate: at(3) })]);
    fireEvent.click(screen.getByTestId('gantt-row-title'));
    expect(actions.openRow).toHaveBeenCalledWith('a');
    const bar = screen.getByTestId('gantt-bar');
    press(bar, 100);
    pointerUp(100);
    fireEvent.click(bar);
    expect(actions.openRow).toHaveBeenCalledTimes(2);
    expect(actions.updateRow).not.toHaveBeenCalled();
  });

  it('resizes with the right edge: one updateRow call with the new end date', () => {
    const { actions } = setup([row('a', { startDate: at(1), dueDate: at(3) })]);
    press(screen.getByTestId('gantt-handle-end'), 100);
    pointerMove(100 + 2 * PX_PER_DAY.day);
    expect(screen.getByTestId('gantt-bar').dataset.end).toBe(at(5)); // live preview
    pointerUp(100 + 2 * PX_PER_DAY.day);
    expect(actions.updateRow).toHaveBeenCalledTimes(1);
    expect(actions.updateRow).toHaveBeenCalledWith('a', { dueDate: at(5) });
  });

  it('never resizes the start past the end', () => {
    const { actions } = setup([row('a', { startDate: at(1), dueDate: at(3) })]);
    press(screen.getByTestId('gantt-handle-start'), 100);
    pointerMove(100 + 10 * PX_PER_DAY.day);
    pointerUp(100 + 10 * PX_PER_DAY.day);
    expect(actions.updateRow).toHaveBeenCalledWith('a', { startDate: at(3) });
  });

  it('moves a bar and keeps its length', () => {
    const { actions } = setup([row('a', { startDate: at(1), dueDate: at(3) })]);
    press(screen.getByTestId('gantt-bar'), 100);
    pointerMove(100 - PX_PER_DAY.day);
    pointerUp(100 - PX_PER_DAY.day);
    expect(actions.updateRow).toHaveBeenCalledTimes(1);
    expect(actions.updateRow).toHaveBeenCalledWith('a', { startDate: at(0), dueDate: at(2) });
  });

  it('drags a start out of a marker that only has an end date', () => {
    const { actions } = setup([row('a', { dueDate: at(4) })]);
    press(screen.getByTestId('gantt-handle-start'), 200);
    pointerMove(200 - 3 * PX_PER_DAY.day);
    pointerUp(200 - 3 * PX_PER_DAY.day);
    expect(actions.updateRow).toHaveBeenCalledWith('a', { startDate: at(1) });
  });

  it('schedules an unscheduled row by dragging in its lane', () => {
    const { actions } = setup([row('a', {})]);
    // jsdom has no layout: the lane starts at x = 0, so x / 36 days after the left edge of the timeline
    const origin = monthStartIndex(toDayIndex(today) as number, -1);
    const lane = screen.getByTestId('gantt-lane');
    press(lane, 10 * PX_PER_DAY.day + 5);
    pointerMove(14 * PX_PER_DAY.day + 5);
    expect(screen.getByTestId('gantt-bar-preview').dataset.start).toBeTruthy();
    pointerUp(14 * PX_PER_DAY.day + 5);
    expect(actions.updateRow).toHaveBeenCalledTimes(1);
    const [id, values] = actions.updateRow.mock.calls[0] as unknown as [string, Record<string, string>];
    expect(id).toBe('a');
    expect(values.startDate).toBe(addDays('1970-01-01', origin + 10));
    expect(values.dueDate).toBe(addDays('1970-01-01', origin + 14));
  });

  it('does not schedule on a plain click', () => {
    const { actions } = setup([row('a', {})]);
    const lane = screen.getByTestId('gantt-lane');
    press(lane, 100);
    pointerUp(100);
    expect(actions.updateRow).not.toHaveBeenCalled();
  });

  it('cannot drag rows the user may not edit', () => {
    const { actions } = setup([row('a', { startDate: at(1), dueDate: at(3) }, { canEdit: false }), row('b', {}, { canEdit: false })]);
    expect(screen.queryByTestId('gantt-handle-end')).toBeNull();
    press(screen.getByTestId('gantt-bar'), 100);
    pointerMove(300);
    pointerUp(300);
    press(screen.getAllByTestId('gantt-lane')[1]!, 100);
    pointerMove(300);
    pointerUp(300);
    expect(actions.updateRow).not.toHaveBeenCalled();
  });

  it('saves the scale in the gantt part of the view config', () => {
    const { actions } = setup([row('a', { startDate: at(1), dueDate: at(3) })]);
    fireEvent.click(screen.getByTestId('gantt-scale-month'));
    expect(actions.updateConfig).toHaveBeenCalledWith({ gantt: { startColumn: 'startDate', endColumn: 'dueDate', scale: 'month' } });
  });

  it('draws the scale from the config', () => {
    setup([row('a', { startDate: at(1), dueDate: at(3) })], {}, { query: {}, gantt: { startColumn: 'startDate', endColumn: 'dueDate', scale: 'week' } });
    expect(screen.getByTestId('gantt-layout').dataset.scale).toBe('week');
    expect(screen.queryAllByTestId('gantt-weekend')).toHaveLength(0);
    const bar = screen.getByTestId('gantt-bar');
    expect(parseFloat(bar.style.width)).toBe(3 * PX_PER_DAY.week);
  });

  it('shows group headings and colours bars by status', () => {
    setup(
      [row('a', { status: 's-doing', startDate: at(1), dueDate: at(3) }), row('b', { status: 's-done', startDate: at(2), dueDate: at(4) })],
      { result: { rows: [row('a', { status: 's-doing', startDate: at(1), dueDate: at(3) }), row('b', { status: 's-done', startDate: at(2), dueDate: at(4) })], total: 2, groups: [
        { key: 's-doing', label: 'Doing', count: 1 },
        { key: 's-done', label: 'Done', count: 1 },
      ] } },
      { query: { groupBy: 'status' }, gantt: { startColumn: 'startDate', endColumn: 'dueDate', scale: 'day' } },
    );
    expect(screen.getAllByTestId('gantt-group').map((g) => g.textContent)).toEqual(['Doing1', 'Done1']);
    const bars = screen.getAllByTestId('gantt-bar');
    expect(bars[0]!.style.background).toMatch(/rgb\(51, 102, 153\)|#336699/);
    expect(bars[1]!.className).toContain('is-done');
  });

  it('expands subtasks fetched with loadChildren', async () => {
    const parent = row('p', { startDate: at(1), dueDate: at(9) }, { childCount: 1 });
    const { actions } = setup([parent]);
    actions.loadChildren.mockResolvedValue([row('k', { startDate: at(2), dueDate: at(3) }, { parentId: 'p' })]);
    fireEvent.click(screen.getByTestId('gantt-expand'));
    expect(actions.loadChildren).toHaveBeenCalledWith('p');
    await screen.findAllByText('k');
    expect(screen.getAllByTestId('gantt-bar')).toHaveLength(2);
  });

  it('nests subtasks that are part of the result', () => {
    setup([row('p', { startDate: at(1), dueDate: at(9) }, { childCount: 1 }), row('k', { startDate: at(2), dueDate: at(3) }, { parentId: 'p' })]);
    expect(screen.getAllByTestId('gantt-row-title').map((t) => t.textContent)).toEqual(['p']);
    fireEvent.click(screen.getByTestId('gantt-expand'));
    const titles = screen.getAllByTestId('gantt-row-title').map((t) => t.textContent);
    expect(titles).toEqual(['p', 'k']);
  });

  it('draws only the rows in the window when there are many', () => {
    const many = Array.from({ length: 1000 }, (_, i) => row(`r${i}`, { startDate: at(i % 20), dueDate: at((i % 20) + 2) }));
    setup(many);
    const drawn = screen.getAllByTestId('gantt-bar').length;
    expect(drawn).toBeGreaterThan(5);
    expect(drawn).toBeLessThan(40);
    const scroll = screen.getByTestId('gantt-scroll');
    Object.defineProperty(scroll, 'scrollTop', { value: 32 * 500, configurable: true });
    fireEvent.scroll(scroll);
    const ids = screen.getAllByTestId('gantt-bar').map((b) => b.dataset.rowId);
    expect(ids).toContain('r505');
    expect(ids).not.toContain('r5');
  });

  it('adds a row from the toolbar', () => {
    const { actions } = setup([]);
    fireEvent.change(screen.getByTestId('gantt-add-input'), { target: { value: 'New thing' } });
    fireEvent.submit(screen.getByTestId('gantt-add-form'));
    expect(actions.createRow).toHaveBeenCalledWith({ name: 'New thing' }, undefined);
  });

  it('says so when the table has no date column', () => {
    setup([row('a', {})], { schema: schema(false) });
    expect(screen.getByTestId('gantt-no-dates')).toBeTruthy();
  });

  it('draws one-day bars without resize handles when the table has a single date column', () => {
    const s = schema(false);
    s.columns.push({ key: 'dueDate', name: 'Due date', type: 'date', builtin: true });
    const { actions } = setup([row('a', { dueDate: at(2) })], { schema: s }, { query: {} });
    expect(screen.queryByTestId('gantt-handle-end')).toBeNull();
    expect(within(screen.getByTestId('gantt-bar')).queryByTestId('gantt-handle-start')).toBeNull();
    press(screen.getByTestId('gantt-bar'), 100);
    pointerMove(100 + PX_PER_DAY.week * 3);
    pointerUp(100 + PX_PER_DAY.week * 3);
    expect(actions.updateRow).toHaveBeenCalledWith('a', { dueDate: at(5) });
  });
});
