import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Column, QueryResult, Row } from '../types';
import { CellHost, getCell, isColumnEditable } from './index';

const query = vi.hoisted(() => vi.fn());
const router = vi.hoisted(() => ({ openTask: vi.fn(), openCustomRow: vi.fn() }));
vi.mock('../../api/tables', () => ({ query, getRow: vi.fn() }));
vi.mock('../../router', () => ({ openTask: router.openTask, openCustomRow: router.openCustomRow }));

const col = (extra: Record<string, unknown> = {}, more: Partial<Column> = {}): Column => ({
  key: 'cf_1',
  name: 'Tasks',
  type: 'relation',
  builtin: false,
  config: { target: 'tasks:p1', multiple: true, ...extra },
  ...more,
});

const row = (id: string, name: string): Row => ({ id, tableRef: 'tasks:p1', values: { name }, canEdit: true });
const result = (...rows: Row[]): QueryResult => ({ rows, total: rows.length });
const ALPHA = { id: 't1', label: 'Alpha' };
const BRAVO = { id: 't2', label: 'Bravo' };
const CHARLIE = { id: 't3', label: 'Charlie' };

beforeEach(() => {
  query.mockReset();
  router.openTask.mockReset();
  router.openCustomRow.mockReset();
  query.mockResolvedValue(result(row('t1', 'Alpha'), row('t2', 'Bravo'), row('t3', 'Charlie')));
});

describe('relation display', () => {
  it('shows chips and opens a task from a chip without starting the editor', async () => {
    const user = userEvent.setup();
    render(<CellHost column={col()} value={[ALPHA, BRAVO]} onChange={vi.fn()} />);
    await user.click(screen.getAllByTestId('relation-chip')[1]!);
    expect(router.openTask).toHaveBeenCalledWith('t2');
    expect(screen.queryByTestId('relation-search')).toBeNull();
  });

  it('opens a row of a custom table in the row panel', async () => {
    const user = userEvent.setup();
    render(<CellHost column={col({ target: 'tbl_abc' })} value={[ALPHA]} />);
    await user.click(screen.getByTestId('relation-chip'));
    expect(router.openCustomRow).toHaveBeenCalledWith('tbl_abc', 't1');
  });

  it('says "Table deleted" and cannot be edited when the target is gone', async () => {
    const user = userEvent.setup();
    const column = col({ targetDeleted: true });
    render(<CellHost column={column} value={[]} />);
    expect(screen.getByText('Table deleted')).toBeTruthy();
    expect(isColumnEditable(column)).toBe(false);
    await user.click(screen.getByText('Table deleted'));
    expect(screen.queryByTestId('relation-search')).toBeNull();
  });

  it('a mirror column is read-only', () => {
    expect(isColumnEditable(col({ mirrorOf: { ref: 'tbl_x', key: 'cf_9' } }, { readonly: true }))).toBe(false);
  });

  it('compact cells show two chips and a count', () => {
    const Display = getCell('relation').Display;
    render(<Display column={col()} value={[ALPHA, BRAVO, CHARLIE]} compact />);
    expect(screen.getAllByTestId('relation-chip')).toHaveLength(2);
    expect(screen.getByText('+1')).toBeTruthy();
  });
});

describe('relation editor', () => {
  async function start(column: Column, value: unknown, extra: { row?: Row } = {}) {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CellHost column={column} value={value} onChange={onChange} {...extra} />);
    document.querySelector<HTMLElement>('.cl-cellhost')!.focus();
    await user.keyboard('{Enter}');
    await screen.findByTestId('relation-search');
    return { user, onChange };
  }
  const options = () => screen.getAllByTestId('relation-option').map((o) => o.textContent);

  it('lists the current links first, then the rows of the target table', async () => {
    await start(col(), [BRAVO]);
    await waitFor(() => expect(options()).toHaveLength(4));
    expect(options()).toEqual(['Clear all', '✓Bravo', 'Alpha', 'Charlie']);
    expect(query).toHaveBeenCalledWith('tasks:p1', { limit: 25 });
  });

  it('searches the target table with the typed text', async () => {
    const { user } = await start(col(), []);
    await user.type(screen.getByTestId('relation-search'), 'ch');
    await waitFor(() => expect(query).toHaveBeenCalledWith('tasks:p1', { search: 'ch', limit: 25 }));
  });

  it('multiple: Space toggles, Enter commits the chosen links', async () => {
    const { user, onChange } = await start(col(), [ALPHA]);
    await waitFor(() => expect(options()).toHaveLength(4));
    await user.keyboard('{ArrowDown}{ArrowDown}'); // Clear all -> Alpha -> Bravo
    await user.keyboard(' ');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith([ALPHA, { id: 't2', label: 'Bravo' }]);
  });

  it('multiple: Escape commits what was chosen (closing commits)', async () => {
    const { user, onChange } = await start(col(), [ALPHA]);
    await waitFor(() => expect(options()).toHaveLength(4));
    await user.keyboard('{ArrowDown}{ArrowDown} ');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('relation-search')).toBeNull());
    expect(onChange).toHaveBeenCalledWith([ALPHA, BRAVO]);
  });

  it('single: Enter picks the highlighted row and commits it', async () => {
    const { user, onChange } = await start(col({ multiple: false }), [ALPHA]);
    await waitFor(() => expect(options()).toHaveLength(4)); // None, Alpha, Bravo, Charlie
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith([BRAVO]);
  });

  it('single: Escape cancels', async () => {
    const { user, onChange } = await start(col({ multiple: false }), [ALPHA]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('relation-search')).toBeNull());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clear all empties the value', async () => {
    const { user, onChange } = await start(col(), [ALPHA, BRAVO]);
    await user.click(await screen.findByText('Clear all'));
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('never offers the row itself', async () => {
    await start(col(), [], { row: row('t1', 'Alpha') });
    await waitFor(() => expect(options()).toEqual(['Bravo', 'Charlie']));
  });
});

describe('relation registry', () => {
  it('toText joins the titles, isEmpty and compare follow the first title', () => {
    const def = getCell('relation');
    const c = col();
    expect(def.toText([ALPHA, BRAVO], c)).toBe('Alpha, Bravo');
    expect(def.isEmpty([])).toBe(true);
    expect(def.isEmpty([ALPHA])).toBe(false);
    expect(def.compare!([ALPHA], [BRAVO], c)).toBeLessThan(0);
    expect(def.compare!([], [BRAVO], c)).toBeGreaterThan(0);
  });
});
