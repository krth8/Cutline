import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setPlatform } from '../../../platform';
import { createFakePlatform } from '../../../testing/fakePlatform';
import type { LayoutProps, Row, TableSchema } from '../../types';
import { getLayout, layoutDefaults } from '../registry';
import './index';
import { CalendarLayout } from './CalendarLayout';
import { todayYmd } from './dates';

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
        { value: 's-todo', label: 'To do', color: '#336699' },
        { value: 's-done', label: 'Done', color: '#22aa55' },
      ],
    },
    { key: 'dueDate', name: 'Due', type: 'date', builtin: true },
    { key: 'cf_end', name: 'End', type: 'date', builtin: false },
  ],
});

const row = (id: string, due: string | null, extra: Record<string, unknown> = {}): Row => ({
  id,
  tableRef: 'tasks:p1',
  values: { name: id, status: 's-todo', dueDate: due, cf_end: null, ...extra },
  canEdit: true,
});

function setup(rows: Row[], over: Partial<LayoutProps> = {}, calendar: Record<string, unknown> = {}) {
  const actions = {
    updateRow: vi.fn(async () => {}),
    createRow: vi.fn(async (values: Record<string, unknown>) => row('new', String(values.dueDate ?? null))),
    deleteRows: vi.fn(async () => {}),
    reorder: vi.fn(async () => {}),
    openRow: vi.fn(),
    updateConfig: vi.fn(),
    loadChildren: vi.fn(async () => []),
  };
  const props: LayoutProps = {
    schema: schema(),
    view: { id: 'v1', tableRef: 'tasks:p1', name: 'Cal', layout: 'calendar', config: { query: {}, calendar: { dateColumn: 'dueDate', ...calendar } as never } },
    result: { rows, total: rows.length },
    loading: false,
    actions,
    ...over,
  };
  const utils = render(<CalendarLayout {...props} />);
  return { actions, props, ...utils };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 15, 12, 0)); // Sunday 15 Nov 2026, local
  setPlatform(createFakePlatform());
});
afterEach(() => {
  vi.useRealTimers();
  setPlatform(null);
  // @ts-expect-error test cleanup of the stub
  delete document.elementsFromPoint;
});

const bars = () => [...document.querySelectorAll<HTMLElement>('[data-testid=calendar-item]')];
const day = (d: string) => document.querySelector<HTMLElement>(`[data-testid=calendar-day][data-day="${d}"]`)!;

describe('calendar layout', () => {
  it('is registered and defaults to the first date column', () => {
    const entry = getLayout('calendar')!;
    expect(entry.component).toBe(CalendarLayout);
    expect(layoutDefaults(entry, schema(), { query: {} })).toEqual({ calendar: { dateColumn: 'dueDate', mode: 'month' } });
  });

  it('shows November 2026 with today marked and rows on their day', () => {
    setup([row('a', '2026-11-10'), row('b', '2026-11-10'), row('c', null)]);
    expect(screen.getByTestId('calendar-title').textContent).toBe('November 2026');
    expect(document.querySelectorAll('[data-testid=calendar-day]')).toHaveLength(42);
    expect(day('2026-11-15').getAttribute('data-today')).toBe('true');
    expect(document.querySelectorAll('[data-today]')).toHaveLength(1);
    expect(bars().map((b) => b.dataset.start)).toEqual(['2026-11-10', '2026-11-10']);
    expect(screen.getAllByTestId('calendar-undated-item').map((e) => e.textContent)).toEqual(['c']);
  });

  it('draws a row with an end column as a span and dims done rows', () => {
    setup([row('a', '2026-11-10', { cf_end: '2026-11-12' }), row('b', '2026-11-11', { status: 's-done' })], {}, { endColumn: 'cf_end' });
    const [a, b] = bars();
    expect(a!.dataset.end).toBe('2026-11-12');
    expect(a!.style.gridColumn).toBe('2 / 5');
    expect(b!.className).toContain('is-done');
    expect(a!.className).not.toContain('is-done');
    expect(screen.getAllByTestId('calendar-resize')).toHaveLength(2);
  });

  it('has no resize handle without an end column', () => {
    setup([row('a', '2026-11-10')]);
    expect(screen.queryByTestId('calendar-resize')).toBeNull();
  });

  it('navigates and saves only the mode in the view config', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { actions } = setup([]);
    await user.click(screen.getByTestId('calendar-next'));
    expect(screen.getByTestId('calendar-title').textContent).toBe('December 2026');
    await user.click(screen.getByTestId('calendar-today'));
    expect(screen.getByTestId('calendar-title').textContent).toBe('November 2026');
    expect(actions.updateConfig).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('calendar-mode-week'));
    expect(actions.updateConfig).toHaveBeenCalledWith({ calendar: { dateColumn: 'dueDate', mode: 'week' } });
  });

  it('shows one week in week mode', () => {
    setup([row('a', '2026-11-12')], {}, { mode: 'week' });
    expect(document.querySelectorAll('[data-testid=calendar-day]')).toHaveLength(7);
    expect(screen.getByTestId('calendar-title').textContent).toBe('9 - 15 Nov 2026');
  });

  it('opens a row on click', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { actions } = setup([row('a', '2026-11-10')]);
    await user.click(bars()[0]!);
    expect(actions.openRow).toHaveBeenCalledWith('a');
  });

  it('shows +N more and lists every row of the day in a popover', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { actions } = setup(['a', 'b', 'c', 'd', 'e'].map((id) => row(id, '2026-11-10')));
    expect(bars()).toHaveLength(3);
    const more = screen.getByTestId('calendar-more');
    expect(more.textContent).toBe('+2 more');
    await user.click(more);
    const items = screen.getAllByTestId('calendar-more-item');
    expect(items.map((i) => i.textContent)).toEqual(['a', 'b', 'c', 'd', 'e']);
    await user.click(items[4]!);
    expect(actions.openRow).toHaveBeenCalledWith('e');
  });

  it('creates a row on the clicked day', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { actions } = setup([]);
    await user.click(day('2026-11-20'));
    const input = within(screen.getByTestId('calendar-create')).getByRole('textbox');
    await user.type(input, 'Plan{Enter}');
    expect(actions.createRow).toHaveBeenCalledWith({ name: 'Plan', dueDate: '2026-11-20' }, undefined);
    expect(screen.queryByTestId('calendar-create')).toBeNull();
  });

  it('asks for a project on tasks:*', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    setPlatform(
      createFakePlatform({
        projects: [
          { id: 'p1', name: 'One', canTasks: true, isOwner: true },
          { id: 'p2', name: 'Two', canTasks: true, isOwner: false },
        ],
      }),
    );
    const { actions } = setup([], { view: { id: 'v1', tableRef: 'tasks:*', name: 'Cal', layout: 'calendar', config: { query: {} } } });
    await user.click(day('2026-11-20'));
    await user.selectOptions(screen.getByLabelText('Project'), 'p2');
    await user.type(within(screen.getByTestId('calendar-create')).getByRole('textbox'), 'X{Enter}');
    expect(actions.createRow).toHaveBeenCalledWith({ name: 'X', dueDate: '2026-11-20' }, { projectId: 'p2' });
  });

  describe('dragging', () => {
    /** Pretend the pointer is over a given day cell (jsdom has no layout). */
    function over(d: string) {
      document.elementsFromPoint = () => [day(d)];
    }
    const move = (x: number, y: number) => act(() => void window.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y })));
    const up = (x: number, y: number) => act(() => void window.dispatchEvent(new MouseEvent('pointerup', { clientX: x, clientY: y })));

    it('moving a bar writes the new date only', () => {
      const { actions } = setup([row('a', '2026-11-10')]);
      over('2026-11-10');
      fireEvent.pointerDown(bars()[0]!, { button: 0, clientX: 10, clientY: 10 });
      over('2026-11-19');
      move(60, 10);
      up(60, 10);
      expect(actions.updateRow).toHaveBeenCalledWith('a', { dueDate: '2026-11-19' });
    });

    it('moving a span keeps its length and grabbing a later day offsets the move', () => {
      const { actions } = setup([row('a', '2026-11-10', { cf_end: '2026-11-12' })], {}, { endColumn: 'cf_end' });
      over('2026-11-11'); // grabbed in the middle
      fireEvent.pointerDown(bars()[0]!, { button: 0, clientX: 10, clientY: 10 });
      over('2026-11-20');
      move(60, 10);
      up(60, 10);
      expect(actions.updateRow).toHaveBeenCalledWith('a', { dueDate: '2026-11-19', cf_end: '2026-11-21' });
    });

    it('dragging the right edge changes only the end', () => {
      const { actions } = setup([row('a', '2026-11-10', { cf_end: '2026-11-12' })], {}, { endColumn: 'cf_end' });
      over('2026-11-12');
      fireEvent.pointerDown(screen.getByTestId('calendar-resize'), { button: 0, clientX: 10, clientY: 10 });
      over('2026-11-17');
      move(60, 10);
      up(60, 10);
      expect(actions.updateRow).toHaveBeenCalledWith('a', { cf_end: '2026-11-17' });
    });

    it('a press that barely moves is a click, not a drag', () => {
      const { actions } = setup([row('a', '2026-11-10')]);
      over('2026-11-10');
      fireEvent.pointerDown(bars()[0]!, { button: 0, clientX: 10, clientY: 10 });
      move(11, 11);
      up(11, 11);
      expect(actions.updateRow).not.toHaveBeenCalled();
    });

    it('dropping an undated row on a day schedules it', () => {
      const { actions } = setup([row('u', null)]);
      fireEvent.pointerDown(screen.getByTestId('calendar-undated-item'), { button: 0, clientX: 10, clientY: 10 });
      over('2026-11-24');
      move(80, 80);
      up(80, 80);
      expect(actions.updateRow).toHaveBeenCalledWith('u', { dueDate: '2026-11-24' });
    });

    it('does not drag rows the user cannot edit', () => {
      const { actions } = setup([{ ...row('a', '2026-11-10'), canEdit: false }]);
      over('2026-11-10');
      fireEvent.pointerDown(bars()[0]!, { button: 0, clientX: 10, clientY: 10 });
      over('2026-11-19');
      move(60, 10);
      up(60, 10);
      expect(actions.updateRow).not.toHaveBeenCalled();
    });
  });

  it('says so when the table has no date column', () => {
    const s = schema();
    s.columns = s.columns.slice(0, 2);
    setup([], { schema: s });
    expect(screen.getByTestId('calendar-no-column')).toBeTruthy();
  });

  it('today in the test clock is the local day', () => {
    expect(todayYmd()).toBe('2026-11-15');
  });
});
