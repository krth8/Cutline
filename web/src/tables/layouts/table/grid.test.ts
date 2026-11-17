import { describe, expect, it } from 'vitest';
import type { Column, Row, TableSchema, View } from '../../types';
import { orderedColumns } from '../../viewColumns';
import {
  EMPTY_SELECTION,
  NO_GROUP,
  buildItems,
  clampWidth,
  formatSummary,
  gridColumns,
  gridTemplate,
  moveColumn,
  moveCursor,
  partitionRows,
  pruneSelection,
  reorderPlan,
  reorderedColumnConfig,
  rowOrder,
  scrollTopFor,
  selectAll,
  selectRange,
  toggleSelection,
  virtualWindow,
} from './grid';

const row = (id: string, values: Record<string, unknown> = {}, extra: Partial<Row> = {}): Row => ({
  id,
  tableRef: 'tasks:p1',
  values,
  canEdit: true,
  ...extra,
});

const build = (over: Partial<Parameters<typeof buildItems>[0]> = {}) =>
  buildItems({
    rows: [],
    groups: undefined,
    groupBy: undefined,
    collapsed: new Set(),
    expanded: new Set(),
    children: new Map(),
    nested: false,
    loadingChildren: new Set(),
    canAddChildren: true,
    quickAdd: true,
    ...over,
  });

describe('virtualWindow', () => {
  it('renders only the rows in view plus an overscan', () => {
    const w = virtualWindow(2000, 34, 34 * 1000, 600, 8);
    expect(w.start).toBe(992);
    expect(w.end).toBe(1000 + Math.ceil(600 / 34) + 1 + 8);
    expect(w.offset).toBe(992 * 34);
    expect(w.total).toBe(2000 * 34);
    expect(w.end - w.start).toBeLessThan(50);
  });

  it('starts at the top and clamps at the end', () => {
    expect(virtualWindow(100, 10, 0, 50, 3)).toMatchObject({ start: 0, end: 9, offset: 0 });
    expect(virtualWindow(100, 10, 99999, 50, 3)).toMatchObject({ end: 100, start: 96 });
  });

  it('handles no rows', () => {
    expect(virtualWindow(0, 34, 500, 600)).toEqual({ start: 0, end: 0, offset: 0, total: 0 });
  });

  it('scrollTopFor scrolls the least that is needed', () => {
    expect(scrollTopFor(5, 10, 0, 100)).toBe(0); // already visible
    expect(scrollTopFor(20, 10, 0, 100)).toBe(110); // below: the item ends at the bottom
    expect(scrollTopFor(2, 10, 50, 100)).toBe(20); // above: the item is at the top
  });
});

describe('buildItems', () => {
  it('lists rows then the quick-add line', () => {
    const items = build({ rows: [row('a'), row('b')] });
    expect(items.map((i) => i.kind)).toEqual(['row', 'row', 'quickAdd']);
    expect(build({ rows: [row('a')], quickAdd: false }).map((i) => i.kind)).toEqual(['row']);
  });

  it('puts rows under their group in group order and skips collapsed groups', () => {
    const rows = [row('a', { s: 'x' }), row('b', { s: 'y' }), row('c', { s: 'x' }), row('d', { s: null })];
    const groups = [
      { key: 'y', label: 'Y', count: 1 },
      { key: 'x', label: 'X', count: 2, color: '#f00' },
      { key: null, label: 'None', count: 1 },
    ];
    const items = build({ rows, groups, groupBy: 's', quickAdd: false });
    expect(items.map((i) => (i.kind === 'group' ? `#${i.label}` : i.id))).toEqual(['#Y', 'b', '#X', 'a', 'c', '#None', 'd']);
    const collapsed = build({ rows, groups, groupBy: 's', quickAdd: false, collapsed: new Set(['x', NO_GROUP]) });
    expect(collapsed.map((i) => (i.kind === 'group' ? `#${i.label}` : i.id))).toEqual(['#Y', 'b', '#X', '#None']);
    const x = collapsed.find((i) => i.kind === 'group' && i.label === 'X');
    expect(x).toMatchObject({ collapsed: true, count: 2, color: '#f00' });
  });

  it('puts a multi-value row under the first of its groups', () => {
    const rows = [row('a', { tags: ['t2', 't1'] })];
    const groups = [
      { key: 't1', label: '1', count: 1 },
      { key: 't2', label: '2', count: 1 },
    ];
    const parts = partitionRows(rows, groups, 'tags');
    expect(parts.get('t1')!.map((r) => r.id)).toEqual(['a']);
    expect(parts.get('t2')).toEqual([]);
  });

  it('matches boolean group keys', () => {
    const groups = [
      { key: 'false', label: 'No', count: 1 },
      { key: 'true', label: 'Yes', count: 1 },
    ];
    const parts = partitionRows([row('a', { done: true }), row('b', { done: false })], groups, 'done');
    expect(parts.get('true')!.map((r) => r.id)).toEqual(['a']);
    expect(parts.get('false')!.map((r) => r.id)).toEqual(['b']);
  });

  it('shows carets only for nested views and lists loaded children with an add line', () => {
    const parent = row('p', {}, { childCount: 2 });
    const kids = [row('c1', {}, { parentId: 'p' }), row('c2', {}, { parentId: 'p' })];
    expect(build({ rows: [parent], quickAdd: false })[0]).toMatchObject({ caret: 'none' });
    expect(build({ rows: [parent], nested: true, quickAdd: false })[0]).toMatchObject({ caret: 'closed' });
    const open = build({ rows: [parent], nested: true, quickAdd: false, expanded: new Set(['p']), children: new Map([['p', kids]]) });
    expect(open.map((i) => i.kind)).toEqual(['row', 'row', 'row', 'addChild']);
    expect(open[0]).toMatchObject({ caret: 'open', depth: 0 });
    expect(open[1]).toMatchObject({ id: 'c1', depth: 1 });
    expect(open[3]).toMatchObject({ kind: 'addChild', parentId: 'p', depth: 1 });
    expect(rowOrder(open)).toEqual(['p', 'c1', 'c2']);
  });

  it('nests children of children and lets a parent without children open', () => {
    const p = row('p', {}, { childCount: 1 });
    const c = row('c', {}, { parentId: 'p', childCount: 1 });
    const g = row('g', {}, { parentId: 'c' });
    const items = build({
      rows: [p],
      nested: true,
      quickAdd: false,
      canAddChildren: false,
      expanded: new Set(['p', 'c']),
      children: new Map([['p', [c]], ['c', [g]]]),
    });
    expect(items.map((i) => `${i.id}:${i.kind === 'row' ? i.depth : '-'}`)).toEqual(['p:0', 'c:1', 'g:2']);
    const empty = build({ rows: [row('e')], nested: true, quickAdd: false, expanded: new Set(['e']) });
    expect(empty[0]).toMatchObject({ caret: 'open' });
  });
});

describe('selection', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];

  it('toggles single rows and remembers the anchor', () => {
    let s = toggleSelection(EMPTY_SELECTION, 'b');
    expect([...s.ids]).toEqual(['b']);
    expect(s.anchor).toBe('b');
    s = toggleSelection(s, 'd');
    s = toggleSelection(s, 'b');
    expect([...s.ids]).toEqual(['d']);
  });

  it('selects a range from the anchor, in either direction', () => {
    let s = selectRange(toggleSelection(EMPTY_SELECTION, 'b'), order, 'd');
    expect([...s.ids].sort()).toEqual(['b', 'c', 'd']);
    s = selectRange(toggleSelection(EMPTY_SELECTION, 'd'), order, 'a');
    expect([...s.ids].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a range without an anchor selects the row', () => {
    expect([...selectRange(EMPTY_SELECTION, order, 'c').ids]).toEqual(['c']);
  });

  it('selects all and prunes vanished rows', () => {
    const all = selectAll(order);
    expect(all.ids.size).toBe(5);
    const pruned = pruneSelection(all, new Set(['a', 'b']));
    expect([...pruned.ids]).toEqual(['a', 'b']);
    expect(pruneSelection(pruned, new Set(['a', 'b', 'z']))).toBe(pruned);
  });
});

describe('moveCursor', () => {
  const order = ['r1', 'r2', 'r3', 'r4'];
  const at = (rowId: string, col: number) => ({ rowId, col });

  it('moves one cell and stops at the edges', () => {
    expect(moveCursor(order, at('r2', 1), 'ArrowDown', 3)).toEqual(at('r3', 1));
    expect(moveCursor(order, at('r2', 1), 'ArrowUp', 3)).toEqual(at('r1', 1));
    expect(moveCursor(order, at('r1', 0), 'ArrowUp', 3)).toEqual(at('r1', 0));
    expect(moveCursor(order, at('r4', 2), 'ArrowDown', 3)).toEqual(at('r4', 2));
    expect(moveCursor(order, at('r1', 0), 'ArrowLeft', 3)).toEqual(at('r1', 0));
    expect(moveCursor(order, at('r1', 2), 'ArrowRight', 3)).toEqual(at('r1', 2));
    expect(moveCursor(order, at('r1', 0), 'ArrowRight', 3)).toEqual(at('r1', 1));
  });

  it('Home/End go to the row ends, with Ctrl to the grid corners', () => {
    expect(moveCursor(order, at('r3', 1), 'Home', 3)).toEqual(at('r3', 0));
    expect(moveCursor(order, at('r3', 1), 'End', 3)).toEqual(at('r3', 2));
    expect(moveCursor(order, at('r3', 1), 'Home', 3, { ctrl: true })).toEqual(at('r1', 0));
    expect(moveCursor(order, at('r3', 1), 'End', 3, { ctrl: true })).toEqual(at('r4', 2));
  });

  it('pages by the given number of rows and clamps', () => {
    expect(moveCursor(order, at('r1', 1), 'PageDown', 3, { page: 2 })).toEqual(at('r3', 1));
    expect(moveCursor(order, at('r1', 1), 'PageDown', 3, { page: 20 })).toEqual(at('r4', 1));
    expect(moveCursor(order, at('r4', 1), 'PageUp', 3, { page: 3 })).toEqual(at('r1', 1));
  });

  it('starts at the first row when the cursor row is gone, and ignores an empty grid', () => {
    expect(moveCursor(order, at('zz', 5), 'ArrowDown', 3)).toEqual(at('r1', 2));
    expect(moveCursor([], at('r1', 0), 'ArrowDown', 3)).toEqual(at('r1', 0));
  });
});

describe('reorderPlan', () => {
  const rows = [row('a'), row('b'), row('c'), row('d')];

  it('drops before a row', () => {
    expect(reorderPlan(rows, ['d'], 'b', 'before')).toEqual({ ids: ['d'], before: 'b' });
  });

  it('drops after a row: before the next sibling, or at the end', () => {
    expect(reorderPlan(rows, ['a'], 'b', 'after')).toEqual({ ids: ['a'], before: 'c' });
    expect(reorderPlan(rows, ['a'], 'd', 'after')).toEqual({ ids: ['a'] });
  });

  it('moves several rows in display order', () => {
    expect(reorderPlan(rows, ['c', 'a'], 'd', 'after')).toEqual({ ids: ['a', 'c'] });
    expect(reorderPlan(rows, ['c', 'a'], 'b', 'before')).toEqual({ ids: ['a', 'c'], before: 'b' });
  });

  it('gives nothing for a drop that changes nothing, onto itself, or across parents', () => {
    expect(reorderPlan(rows, ['b'], 'c', 'before')).toBeNull();
    expect(reorderPlan(rows, ['b'], 'a', 'after')).toBeNull();
    expect(reorderPlan(rows, ['b'], 'b', 'after')).toBeNull();
    const mixed = [row('a'), row('k', {}, { parentId: 'a' }), row('b')];
    expect(reorderPlan(mixed, ['k'], 'b', 'before')).toBeNull();
    expect(reorderPlan(mixed, ['b'], 'a', 'before')).toEqual({ ids: ['b'], before: 'a' });
    const other = [row('a'), row('x', {}, { tableRef: 'tasks:p2' })];
    expect(reorderPlan(other, ['a'], 'x', 'after')).toBeNull();
  });
});

describe('columns', () => {
  const col = (key: string, type: Column['type'] = 'text'): Column => ({ key, name: key, type, builtin: true });
  const schema: TableSchema = {
    ref: 'tasks:p1',
    name: 'Tasks',
    columns: [col('name'), col('status', 'status'), col('due', 'date'), col('n', 'number')],
    titleColumn: 'name',
    capabilities: { create: true, delete: true, hierarchy: true, editSchema: true },
  };
  const config = (extra: Record<string, unknown> = {}): View['config'] => ({ query: {}, ...extra }) as View['config'];

  it('uses layout widths, then view widths, then defaults, and clamps', () => {
    const cols = gridColumns(schema, config({ columns: [{ key: 'due', width: 200 }], table: { widths: { status: 90, n: 5 } } }));
    expect(Object.fromEntries(cols.map((c) => [c.column.key, c.width]))).toEqual({ due: 200, name: 320, status: 90, n: 60 });
    expect(cols.find((c) => c.column.key === 'name')!.isTitle).toBe(true);
  });

  it('live widths win while resizing and hidden columns are left out', () => {
    const cols = gridColumns(schema, config({ columns: [{ key: 'status', hidden: true }] }), { name: 500 });
    expect(cols.map((c) => c.column.key)).toEqual(['name', 'due', 'n']);
    expect(cols[0]!.width).toBe(500);
    expect(gridTemplate(cols)).toBe('44px minmax(500px, 1fr) 140px 110px'); // the title takes the spare room
  });

  it('clampWidth keeps widths in range', () => {
    expect(clampWidth(10)).toBe(60);
    expect(clampWidth(5000)).toBe(800);
    expect(clampWidth(123.6)).toBe(124);
  });

  it('moveColumn puts a key before or after another', () => {
    const keys = ['a', 'b', 'c', 'd'];
    expect(moveColumn(keys, 'a', 'c', 'before')).toEqual(['b', 'a', 'c', 'd']);
    expect(moveColumn(keys, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd']);
    expect(moveColumn(keys, 'd', 'a', 'before')).toEqual(['d', 'a', 'b', 'c']);
    expect(moveColumn(keys, 'b', 'b', 'after')).toEqual(keys);
    expect(moveColumn(keys, 'b', 'zz', 'after')).toEqual(keys);
  });

  it('reorderedColumnConfig lists every column and keeps widths and hidden flags', () => {
    const all = orderedColumns(schema, config({ columns: [{ key: 'status', hidden: true }, { key: 'name', width: 250 }] }));
    const out = reorderedColumnConfig(all, 'n', 'status', 'before');
    expect(out).toEqual([{ key: 'n' }, { key: 'status', hidden: true }, { key: 'name', width: 250 }, { key: 'due' }]);
  });
});

describe('formatSummary', () => {
  it('labels numbers by function and leaves missing values empty', () => {
    expect(formatSummary('sum', 12)).toBe('Sum 12');
    expect(formatSummary('avg', 2.3456)).toBe('Average 2.35');
    expect(formatSummary('percentChecked', 66.6)).toBe('Checked 67%');
    expect(formatSummary('count', 0)).toBe('Count 0');
    expect(formatSummary('sum', null)).toBe('');
    expect(formatSummary(undefined, undefined)).toBe('');
    expect(formatSummary(undefined, 4)).toBe('4');
  });
});
