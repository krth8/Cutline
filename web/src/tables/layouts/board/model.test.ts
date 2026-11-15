import { describe, expect, it } from 'vitest';
import type { Column, QueryResult, Row, TableSchema } from '../../types';
import { buildLanes, cardColumnsOf, defaultGroupBy, dropPatch, NONE_KEY, quickAddValues, readBoardConfig, reorderTarget, toggleIn } from './model';

const status: Column = {
  key: 'status', name: 'Status', type: 'status', builtin: true,
  options: [{ value: 'todo', label: 'To do' }, { value: 'doing', label: 'Doing' }, { value: 'done', label: 'Done' }],
};
const assignees: Column = { key: 'assignees', name: 'Assignees', type: 'people', builtin: true, options: [{ value: 'u1', label: 'Ann' }] };
const name: Column = { key: 'name', name: 'Name', type: 'text', builtin: true };
const due: Column = { key: 'due', name: 'Due', type: 'date', builtin: true };
const schema: TableSchema = {
  ref: 'tasks:p', name: 'T', columns: [name, status, assignees, due], titleColumn: 'name',
  capabilities: { create: true, delete: true, hierarchy: false, editSchema: false },
};
const row = (id: string, values: Record<string, unknown>): Row => ({ id, tableRef: 'tasks:p', values, canEdit: true });

describe('board model', () => {
  it('prefers the status column for a new board', () => {
    expect(defaultGroupBy(schema)).toBe('status');
    expect(defaultGroupBy({ ...schema, columns: [name, assignees] })).toBe('assignees');
    expect(defaultGroupBy({ ...schema, columns: [name, due] })).toBeUndefined();
  });

  it('builds a lane per group and keeps options without rows, the empty lane last', () => {
    const result: QueryResult = {
      rows: [row('a', { status: 'todo' }), row('b', { status: null }), row('c', { status: 'todo' })],
      total: 3,
      groups: [
        { key: null, label: 'None', count: 1 },
        { key: 'todo', label: 'To do', count: 2, summaries: { cost: 5 } },
      ],
    };
    const lanes = buildLanes(status, result);
    expect(lanes.map((l) => l.id)).toEqual(['todo', 'doing', 'done', NONE_KEY]);
    expect(lanes[0]!.rows.map((r) => r.id)).toEqual(['a', 'c']);
    expect(lanes[0]!.summaries).toEqual({ cost: 5 });
    expect(lanes[1]).toMatchObject({ count: 0, rows: [], label: 'Doing' });
    expect(lanes[3]!.rows.map((r) => r.id)).toEqual(['b']);
  });

  it('turns a drop on another lane into a patch', () => {
    const r = row('a', { status: 'todo' });
    expect(dropPatch(status, r, 'todo', 'done')).toEqual({ status: 'done' });
    expect(dropPatch(status, r, 'todo', null)).toEqual({ status: null });
    expect(dropPatch(status, r, 'todo', 'todo')).toBeNull();
  });

  it('moves a card between lanes of a multi-value column', () => {
    const r = row('a', { assignees: ['u1', 'u2'] });
    expect(dropPatch(assignees, r, 'u1', 'u3')).toEqual({ assignees: ['u2', 'u3'] });
    expect(dropPatch(assignees, r, 'u1', null)).toEqual({ assignees: ['u2'] });
    expect(dropPatch(assignees, r, null, 'u2')).toEqual({ assignees: ['u1', 'u2'] });
  });

  it('computes the reorder call for a drop inside a lane', () => {
    const all = [row('a', {}), row('b', {}), row('c', {}), row('x', {})]; // a,b,c in the lane, x in the next one
    const lane = all.slice(0, 3);
    expect(reorderTarget(all, lane, 'c', 'a')).toEqual({ ids: ['c'], before: 'a' });
    expect(reorderTarget(all, lane, 'a', null)).toEqual({ ids: ['a'], before: 'x' });
    expect(reorderTarget(all.slice(0, 3), lane, 'a', null)).toEqual({ ids: ['a'] });
    expect(reorderTarget(all, lane, 'b', 'c')).toBeNull(); // already right before c
    expect(reorderTarget(all, lane, 'c', null)).toBeNull(); // already last
  });

  it('chooses card columns', () => {
    expect(cardColumnsOf(schema, { query: {} }, 'status').map((c) => c.key)).toEqual(['assignees', 'due']);
    const config = { query: {}, board: { groupBy: 'status', cardColumns: ['due', 'name', 'nope'] } };
    expect(cardColumnsOf(schema, config, 'status').map((c) => c.key)).toEqual(['due']);
    expect(cardColumnsOf(schema, { query: {}, columns: [{ key: 'due', hidden: true }] }, 'status').map((c) => c.key)).toEqual(['assignees']);
  });

  it('reads the stored board config and toggles collapsed lanes', () => {
    expect(readBoardConfig({ query: {} })).toEqual({ cardColumns: [], collapsed: [] });
    const stored = { query: {}, board: { groupBy: 'status', cardColumns: ['due'], collapsed: ['done'] } } as never;
    expect(readBoardConfig(stored)).toEqual({ groupBy: 'status', cardColumns: ['due'], collapsed: ['done'] });
    expect(toggleIn(['done'], 'todo')).toEqual(['done', 'todo']);
    expect(toggleIn(['done'], 'done')).toEqual([]);
  });

  it('builds the values of a quick add', () => {
    expect(quickAddValues(status, 'name', 'X', 'doing')).toEqual({ name: 'X', status: 'doing' });
    expect(quickAddValues(assignees, 'name', 'X', 'u1')).toEqual({ name: 'X', assignees: ['u1'] });
    expect(quickAddValues(status, 'name', 'X', null)).toEqual({ name: 'X' });
  });
});
