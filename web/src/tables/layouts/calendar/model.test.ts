import { describe, expect, it } from 'vitest';
import type { Row, TableSchema } from '../../types';
import { monthGrid, weekOf } from './dates';
import {
  createValues,
  defaultDateColumn,
  itemColor,
  itemPatch,
  itemsOnDay,
  layoutWeek,
  movedItem,
  readCalendarConfig,
  resizedItem,
  schedulePatch,
  splitRows,
} from './model';

const schema: TableSchema = {
  ref: 'tasks:p1',
  name: 'Tasks',
  titleColumn: 'name',
  capabilities: { create: true, delete: true, hierarchy: false, editSchema: false },
  columns: [
    { key: 'name', name: 'Name', type: 'text', builtin: true },
    { key: 'status', name: 'Status', type: 'status', builtin: true, options: [{ value: 's1', label: 'Doing', color: '#336699' }] },
    { key: 'dueDate', name: 'Due', type: 'date', builtin: true },
    { key: 'cf_end', name: 'End', type: 'date', builtin: false },
    { key: 'createdAt', name: 'Created', type: 'date', builtin: true, readonly: true },
  ],
};

const row = (id: string, due: string | null, end: string | null = null): Row => ({
  id,
  tableRef: 'tasks:p1',
  values: { name: id, status: 's1', dueDate: due, cf_end: end },
  canEdit: true,
});

const cfg = readCalendarConfig(schema, { query: {}, calendar: { dateColumn: 'dueDate', endColumn: 'cf_end' } })!;
const single = readCalendarConfig(schema, { query: {} })!;

describe('calendar config', () => {
  it('defaults to the first editable date column and month mode', () => {
    expect(defaultDateColumn(schema)?.key).toBe('dueDate');
    expect(single.dateColumn.key).toBe('dueDate');
    expect(single.endColumn).toBeUndefined();
    expect(single.mode).toBe('month');
  });

  it('ignores an end column that is unknown or the same as the date column and reads the mode', () => {
    expect(readCalendarConfig(schema, { query: {}, calendar: { dateColumn: 'dueDate', endColumn: 'dueDate' } })?.endColumn).toBeUndefined();
    expect(readCalendarConfig(schema, { query: {}, calendar: { dateColumn: 'dueDate', endColumn: 'zzz' } })?.endColumn).toBeUndefined();
    expect(readCalendarConfig(schema, { query: {}, calendar: { dateColumn: 'dueDate', mode: 'week' } as never })?.mode).toBe('week');
    expect(cfg.endColumn?.key).toBe('cf_end');
  });

  it('has no config without a date column', () => {
    expect(readCalendarConfig({ ...schema, columns: schema.columns.slice(0, 2) }, { query: {} })).toBeUndefined();
  });
});

describe('placement', () => {
  it('splits rows into dated items and undated rows', () => {
    const { items, undated } = splitRows([row('a', '2026-11-10'), row('b', null), row('c', '2026-11-10', '2026-11-12'), row('d', '2026-11-10', '2026-11-08')], cfg);
    expect(items.map((i) => [i.id, i.start, i.end])).toEqual([
      ['a', '2026-11-10', '2026-11-10'],
      ['c', '2026-11-10', '2026-11-12'],
      ['d', '2026-11-10', '2026-11-10'], // end before start is a single day
    ]);
    expect(undated.map((r) => r.id)).toEqual(['b']);
    // Without an end column the end value is ignored
    expect(splitRows([row('c', '2026-11-10', '2026-11-12')], single).items[0]!.end).toBe('2026-11-10');
  });

  it('puts a one-day item in its column', () => {
    const lay = layoutWeek(splitRows([row('a', '2026-11-11')], cfg).items, weekOf('2026-11-09'), 3);
    expect(lay.segments).toHaveLength(1);
    expect(lay.segments[0]).toMatchObject({ startCol: 2, endCol: 2, lane: 0, continuesBefore: false, continuesAfter: false });
    expect(lay.lanes).toBe(1);
  });

  it('cuts a span at the week boundaries and marks the continuation', () => {
    const items = splitRows([row('a', '2026-11-12', '2026-11-18')], cfg).items;
    const weeks = monthGrid('2026-11-15');
    const w2 = layoutWeek(items, weeks[1]!, 3); // 2 - 8 Nov is weeks[1]? weeks[0] is 26 Oct - 1 Nov
    expect(weeks[2]![0]).toBe('2026-11-09');
    const w9 = layoutWeek(items, weeks[2]!, 3); // 9 - 15 Nov
    const w16 = layoutWeek(items, weeks[3]!, 3); // 16 - 22 Nov
    expect(w2.segments).toHaveLength(0);
    expect(w9.segments[0]).toMatchObject({ startCol: 3, endCol: 6, continuesBefore: false, continuesAfter: true });
    expect(w16.segments[0]).toMatchObject({ startCol: 0, endCol: 2, continuesBefore: true, continuesAfter: false });
    expect(layoutWeek(items, weeks[4]!, 3).segments).toHaveLength(0);
  });

  it('stacks overlapping items in lanes and reuses a lane once it is free', () => {
    const items = splitRows([row('long', '2026-11-09', '2026-11-12'), row('b', '2026-11-10'), row('c', '2026-11-13')], cfg).items;
    const lay = layoutWeek(items, weekOf('2026-11-09'), 3);
    const lane = (id: string) => lay.segments.find((s) => s.item.id === id)!.lane;
    expect(lane('long')).toBe(0);
    expect(lane('b')).toBe(1);
    expect(lane('c')).toBe(0);
    expect(lay.lanes).toBe(2);
  });

  it('counts what does not fit as overflow on the day', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => row(id, '2026-11-10'));
    rows.push(row('wide', '2026-11-10', '2026-11-11'));
    const items = splitRows(rows, cfg).items;
    const lay = layoutWeek(items, weekOf('2026-11-09'), 3);
    expect(lay.segments).toHaveLength(3);
    expect(lay.lanes).toBe(3);
    // 6 items on Tuesday, 3 shown; the wide one is longest so it is shown first
    expect(lay.overflow).toEqual([0, 3, 0, 0, 0, 0, 0]);
    expect(lay.segments.some((s) => s.item.id === 'wide')).toBe(true);
    expect(itemsOnDay(items, '2026-11-11').map((i) => i.id)).toEqual(['wide']);
    expect(itemsOnDay(items, '2026-11-10')).toHaveLength(6);
  });

  it('overflow of a span adds to every day it covers', () => {
    const rows = [row('s', '2026-11-09', '2026-11-11'), row('t', '2026-11-09', '2026-11-11'), row('a', '2026-11-09'), row('b', '2026-11-10')];
    const lay = layoutWeek(splitRows(rows, cfg).items, weekOf('2026-11-09'), 2);
    expect(lay.segments.map((s) => s.item.id).sort()).toEqual(['s', 't']);
    expect(lay.overflow).toEqual([1, 1, 0, 0, 0, 0, 0]);
  });
});

describe('edits', () => {
  const item = splitRows([row('a', '2026-11-10', '2026-11-12')], cfg).items[0]!;

  it('moves both dates and keeps the length', () => {
    const after = movedItem(item, '2026-12-30');
    expect([after.start, after.end]).toEqual(['2026-12-30', '2027-01-01']);
    expect(itemPatch(cfg, item, after)).toEqual({ dueDate: '2026-12-30', cf_end: '2027-01-01' });
  });

  it('resize changes only the end and never goes before the start', () => {
    expect(itemPatch(cfg, item, resizedItem(item, '2026-11-20'))).toEqual({ cf_end: '2026-11-20' });
    expect(resizedItem(item, '2026-11-01').end).toBe('2026-11-10');
    expect(itemPatch(cfg, item, resizedItem(item, '2026-11-12'))).toEqual({});
  });

  it('moving a single-day row writes only the date; resizing it writes an end', () => {
    const one = splitRows([row('a', '2026-11-10')], cfg).items[0]!;
    expect(itemPatch(cfg, one, movedItem(one, '2026-11-14'))).toEqual({ dueDate: '2026-11-14' });
    expect(itemPatch(cfg, one, resizedItem(one, '2026-11-12'))).toEqual({ cf_end: '2026-11-12' });
    expect(itemPatch(single, one, movedItem(one, '2026-11-14'))).toEqual({ dueDate: '2026-11-14' });
  });

  it('scheduling writes the date, and fixes an end that would be before it', () => {
    expect(schedulePatch(cfg, row('u', null), '2026-11-14')).toEqual({ dueDate: '2026-11-14' });
    expect(schedulePatch(cfg, row('u', null, '2026-11-01'), '2026-11-14')).toEqual({ dueDate: '2026-11-14', cf_end: '2026-11-14' });
    expect(schedulePatch(cfg, row('u', null, '2026-11-20'), '2026-11-14')).toEqual({ dueDate: '2026-11-14' });
  });

  it('creates with the title and the clicked day', () => {
    expect(createValues(schema, cfg, 'New', '2026-11-14')).toEqual({ name: 'New', dueDate: '2026-11-14' });
  });

  it('takes the colour from the status option', () => {
    expect(itemColor(schema, row('a', null))).toBe('#336699');
    expect(itemColor({ ...schema, columns: [schema.columns[0]!] }, row('a', null))).toBeUndefined();
  });
});
