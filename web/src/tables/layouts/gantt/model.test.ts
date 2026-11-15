import { describe, expect, it } from 'vitest';
import type { Row, TableSchema } from '../../types';
import { toDayIndex } from './dates';
import {
  PX_PER_DAY,
  applyDrag,
  axisTicks,
  barRect,
  buildItems,
  computeRange,
  dayToX,
  deltaDays,
  dragPatch,
  laneRange,
  readGanttConfig,
  rowColor,
  schedulePatch,
  spanOf,
  timelineWidth,
  visibleRange,
  weekendBlocks,
  xToDay,
  type Timeline,
} from './model';

const day = (s: string) => toDayIndex(s) as number;

const schema = (dateKeys: Array<[string, boolean?]> = [['startDate'], ['dueDate'], ['createdAt', true]]): TableSchema => ({
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
        { value: 's1', label: 'Doing', color: '#112233' },
        { value: 's2', label: 'Done' },
      ],
    },
    ...dateKeys.map(([key, readonly]) => ({ key, name: key, type: 'date' as const, builtin: true, ...(readonly ? { readonly } : {}) })),
  ],
});

const row = (id: string, values: Record<string, unknown>, extra: Partial<Row> = {}): Row => ({
  id,
  tableRef: 'tasks:p1',
  values: { name: id, startDate: null, dueDate: null, ...values },
  canEdit: true,
  ...extra,
});

const cfg = { startColumn: 'startDate', endColumn: 'dueDate' };
const tl = (scale: 'day' | 'week' | 'month' = 'day', origin = day('2030-01-01'), last = day('2030-03-31')): Timeline => ({
  origin,
  last,
  scale,
  pxPerDay: PX_PER_DAY[scale],
});

describe('configuration', () => {
  it('uses startDate and dueDate when the table has them', () => {
    expect(readGanttConfig(schema(), { query: {} })).toEqual({ startColumn: 'startDate', endColumn: 'dueDate', scale: 'week' });
  });
  it('falls back to the first two editable date columns', () => {
    const s = schema([['createdAt', true], ['begin'], ['finish']]);
    expect(readGanttConfig(s, { query: {} })).toMatchObject({ startColumn: 'begin', endColumn: 'finish' });
  });
  it('uses one column for both with a single date column (bars are one day, no resize)', () => {
    const s = schema([['dueDate']]);
    const c = readGanttConfig(s, { query: {} })!;
    expect(c.startColumn).toBe('dueDate');
    expect(c.endColumn).toBe('dueDate');
    const sp = spanOf(row('a', { dueDate: '2030-01-10' }), c);
    expect(sp).toMatchObject({ kind: 'marker', start: day('2030-01-10'), end: day('2030-01-10') });
    expect(dragPatch(c, 'end', sp, { start: sp.start, end: sp.end + 3 })).toBeNull();
    expect(dragPatch(c, 'move', sp, { start: sp.start + 2, end: sp.end + 2 })).toEqual({ dueDate: '2030-01-12' });
  });
  it('keeps saved values that exist and replaces unknown ones', () => {
    const c = readGanttConfig(schema(), { query: {}, gantt: { startColumn: 'dueDate', endColumn: 'gone', scale: 'month' } });
    expect(c).toEqual({ startColumn: 'dueDate', endColumn: 'dueDate', scale: 'month' });
  });
  it('has nothing to draw without a date column', () => {
    expect(readGanttConfig(schema([]), { query: {} })).toBeNull();
  });
});

describe('spanOf', () => {
  it('reads bars, one-date markers and unscheduled rows', () => {
    expect(spanOf(row('a', { startDate: '2030-01-02', dueDate: '2030-01-05' }), cfg)).toMatchObject({ kind: 'bar', start: day('2030-01-02'), end: day('2030-01-05') });
    expect(spanOf(row('a', { dueDate: '2030-01-05' }), cfg)).toMatchObject({ kind: 'marker', start: day('2030-01-05'), end: day('2030-01-05'), rawStart: null });
    expect(spanOf(row('a', { startDate: '2030-01-05' }), cfg)).toMatchObject({ kind: 'marker', rawEnd: null });
    expect(spanOf(row('a', {}), cfg).kind).toBe('none');
    expect(spanOf(row('a', { startDate: 'soon', dueDate: '' }), cfg).kind).toBe('none');
  });
  it('draws a start after the end as a bar between the two dates', () => {
    expect(spanOf(row('a', { startDate: '2030-01-09', dueDate: '2030-01-05' }), cfg)).toMatchObject({ start: day('2030-01-05'), end: day('2030-01-09') });
  });
});

describe('pixels and days', () => {
  it('maps days to x and back', () => {
    const t = tl('day');
    expect(dayToX(t, day('2030-01-01'))).toBe(0);
    expect(dayToX(t, day('2030-01-11'))).toBe(10 * 36);
    expect(xToDay(t, 0)).toBe(day('2030-01-01'));
    expect(xToDay(t, 35.9)).toBe(day('2030-01-01'));
    expect(xToDay(t, 36)).toBe(day('2030-01-02'));
    expect(timelineWidth(t)).toBe(90 * 36);
    for (const scale of ['day', 'week', 'month'] as const) {
      const s = tl(scale);
      for (let d = s.origin; d <= s.last; d += 7) expect(xToDay(s, dayToX(s, d) + 1)).toBe(d);
    }
  });
  it('gives a bar its inclusive width', () => {
    expect(barRect(tl('day'), day('2030-01-03'), day('2030-01-05'))).toEqual({ left: 72, width: 108 });
    expect(barRect(tl('month'), day('2030-01-03'), day('2030-01-03'))).toEqual({ left: 10, width: 5 });
  });
  it('snaps pointer travel to whole days', () => {
    expect(deltaDays(17, 36)).toBe(0);
    expect(deltaDays(18, 36)).toBe(1);
    expect(deltaDays(-55, 36)).toBe(-2);
    expect(deltaDays(30, 5)).toBe(6);
  });
  it('shows a month before the first date and two after the last', () => {
    const spans = [spanOf(row('a', { startDate: '2030-03-10', dueDate: '2030-03-20' }), cfg)];
    const r = computeRange(spans, day('2030-03-15'));
    expect(r.origin).toBe(day('2030-02-01'));
    expect(r.last).toBe(Math.max(day('2030-05-31'), day('2030-03-15') + 120));
    // the left edge never moves right
    expect(computeRange([], day('2030-03-15'), day('2029-11-01')).origin).toBe(day('2029-11-01'));
    expect(computeRange(spans, day('2030-03-15'), day('2030-06-01')).origin).toBe(day('2030-02-01'));
  });
});

describe('dragging', () => {
  const span = { start: day('2030-01-10'), end: day('2030-01-14') };
  it('moves a bar and keeps its length', () => {
    expect(applyDrag('move', span, 3)).toEqual({ start: day('2030-01-13'), end: day('2030-01-17') });
    expect(applyDrag('move', span, -12)).toEqual({ start: day('2029-12-29'), end: day('2030-01-02') });
  });
  it('resizes one edge', () => {
    expect(applyDrag('end', span, 2)).toEqual({ start: span.start, end: span.end + 2 });
    expect(applyDrag('start', span, -4)).toEqual({ start: span.start - 4, end: span.end });
  });
  it('never lets the start pass the end', () => {
    expect(applyDrag('start', span, 30)).toEqual({ start: span.end, end: span.end });
    expect(applyDrag('end', span, -30)).toEqual({ start: span.start, end: span.start });
  });
  it('stays inside the bounds and still keeps the length when moving', () => {
    const bounds = { min: day('2030-01-01'), max: day('2030-01-31') };
    expect(applyDrag('move', span, -100, bounds)).toEqual({ start: bounds.min, end: bounds.min + 4 });
    expect(applyDrag('move', span, 100, bounds)).toEqual({ start: bounds.max - 4, end: bounds.max });
    expect(applyDrag('start', span, -100, bounds).start).toBe(bounds.min);
    expect(applyDrag('end', span, 100, bounds).end).toBe(bounds.max);
  });
  it('orders the days of a lane drag whichever way it goes', () => {
    expect(laneRange(10, 14)).toEqual({ start: 10, end: 14 });
    expect(laneRange(14, 10)).toEqual({ start: 10, end: 14 });
    expect(laneRange(10, 10)).toEqual({ start: 10, end: 10 });
  });
});

describe('what a drag writes', () => {
  const bar = spanOf(row('a', { startDate: '2030-01-10', dueDate: '2030-01-14' }), cfg);
  it('writes both dates for a move and only the changed one for a resize', () => {
    expect(dragPatch(cfg, 'move', bar, applyDrag('move', bar, 2))).toEqual({ startDate: '2030-01-12', dueDate: '2030-01-16' });
    expect(dragPatch(cfg, 'end', bar, applyDrag('end', bar, 3))).toEqual({ dueDate: '2030-01-17' });
    expect(dragPatch(cfg, 'start', bar, applyDrag('start', bar, -1))).toEqual({ startDate: '2030-01-09' });
  });
  it('writes nothing when the dates did not change', () => {
    expect(dragPatch(cfg, 'move', bar, applyDrag('move', bar, 0))).toBeNull();
    expect(dragPatch(cfg, 'start', bar, applyDrag('start', bar, 0))).toBeNull();
    expect(dragPatch(cfg, 'end', bar, applyDrag('end', bar, 0))).toBeNull();
  });
  it('clamps a resize at one day', () => {
    expect(dragPatch(cfg, 'end', bar, applyDrag('end', bar, -99))).toEqual({ dueDate: '2030-01-10' });
  });
  it('moves a one-date row without adding the other date', () => {
    const marker = spanOf(row('a', { dueDate: '2030-01-14' }), cfg);
    expect(dragPatch(cfg, 'move', marker, applyDrag('move', marker, 2))).toEqual({ dueDate: '2030-01-16' });
  });
  it('drags a start out of an end-only marker from its left edge', () => {
    const marker = spanOf(row('a', { dueDate: '2030-01-14' }), cfg);
    expect(dragPatch(cfg, 'start', marker, applyDrag('start', marker, -3))).toEqual({ startDate: '2030-01-11' });
  });
  it('drags an end out of a start-only marker from its right edge', () => {
    const marker = spanOf(row('a', { startDate: '2030-01-14' }), cfg);
    expect(dragPatch(cfg, 'end', marker, applyDrag('end', marker, 2))).toEqual({ dueDate: '2030-01-16' });
  });
  it('shifts both stored dates of an inverted row on a move', () => {
    const inverted = spanOf(row('a', { startDate: '2030-01-14', dueDate: '2030-01-10' }), cfg);
    expect(dragPatch(cfg, 'move', inverted, applyDrag('move', inverted, 1))).toEqual({ startDate: '2030-01-15', dueDate: '2030-01-11' });
  });
  it('schedules a row from a lane drag', () => {
    expect(schedulePatch(cfg, laneRange(day('2030-02-03'), day('2030-02-01')))).toEqual({ startDate: '2030-02-01', dueDate: '2030-02-03' });
    expect(schedulePatch({ startColumn: 'dueDate', endColumn: 'dueDate' }, laneRange(5, 8))).toEqual({ dueDate: '1970-01-06' });
  });
});

describe('scale changes', () => {
  it('keeps a day at the same place relative to the scale', () => {
    const d = day('2030-02-15');
    const xs = (['day', 'week', 'month'] as const).map((s) => dayToX(tl(s), d) / PX_PER_DAY[s]);
    expect(new Set(xs).size).toBe(1);
  });
  it('builds the axis for each scale', () => {
    const dayAxis = axisTicks(tl('day'));
    expect(dayAxis.top.map((t) => t.label)).toEqual(['Jan 2030', 'Feb 2030', 'Mar 2030']);
    expect(dayAxis.bottom).toHaveLength(90);
    expect(dayAxis.bottom.filter((t) => t.weekend)).toHaveLength(26);
    expect(dayAxis.top[0]).toMatchObject({ left: 0, width: 31 * 36 });

    const weekAxis = axisTicks(tl('week'));
    expect(weekAxis.bottom[0]).toMatchObject({ left: 0 }); // partial first week starts at the edge
    expect(weekAxis.bottom.map((t) => t.day).slice(1, 3)).toEqual([day('2030-01-07'), day('2030-01-14')]);

    const monthAxis = axisTicks(tl('month', day('2029-11-01'), day('2030-03-31')));
    expect(monthAxis.top.map((t) => t.label)).toEqual(['2029', '2030']);
    expect(monthAxis.bottom.map((t) => t.label)).toEqual(['Nov', 'Dec', 'Jan', 'Feb', 'Mar']);
    expect(monthAxis.top[0]).toMatchObject({ left: 0, width: 61 * 5 });
  });
  it('finds the weekends of a range', () => {
    const blocks = weekendBlocks(day('2030-01-01'), day('2030-01-14'));
    expect(blocks).toEqual([
      { day: day('2030-01-05'), days: 2 },
      { day: day('2030-01-12'), days: 2 },
    ]);
    expect(weekendBlocks(day('2030-01-06'), day('2030-01-06'))).toEqual([{ day: day('2030-01-06'), days: 1 }]);
  });
});

describe('colours', () => {
  it('uses the status colour, then the group colour', () => {
    const s = schema();
    expect(rowColor(s, row('a', { status: 's1' }), '#999999')).toBe('#112233');
    expect(rowColor(s, row('a', { status: 's2' }), '#999999')).toBe('#999999');
    expect(rowColor(s, row('a', {}))).toBeUndefined();
  });
});

describe('buildItems', () => {
  const none = new Map<string, Row[]>();
  const open = new Set<string>();
  const ids = (items: ReturnType<typeof buildItems>) => items.map((i) => (i.kind === 'row' ? i.id : i.kind));

  it('puts rows without dates in an Unscheduled section at the end', () => {
    const rows = [row('plain', {}), row('bar', { startDate: '2030-01-02', dueDate: '2030-01-03' }), row('end', { dueDate: '2030-01-09' })];
    const items = buildItems({ result: { rows, total: 3 }, cfg, loaded: none, expanded: open });
    expect(ids(items)).toEqual(['bar', 'end', 'unscheduled', 'plain']);
    expect(items.find((i) => i.kind === 'unscheduled')).toMatchObject({ count: 1 });
  });
  it('nests subtasks under their parent, shown only when expanded', () => {
    const rows = [
      row('parent', { startDate: '2030-01-02', dueDate: '2030-01-09' }, { childCount: 2 }),
      row('c1', { startDate: '2030-01-02', dueDate: '2030-01-03' }, { parentId: 'parent' }),
      row('c2', {}, { parentId: 'parent' }),
    ];
    const collapsed = buildItems({ result: { rows, total: 3 }, cfg, loaded: none, expanded: open });
    expect(ids(collapsed)).toEqual(['parent']);
    expect(collapsed[0]).toMatchObject({ expandable: true, expanded: false, depth: 0 });
    const expanded = buildItems({ result: { rows, total: 3 }, cfg, loaded: none, expanded: new Set(['parent']) });
    expect(ids(expanded)).toEqual(['parent', 'c1', 'c2']);
    expect(expanded[1]).toMatchObject({ depth: 1, unscheduled: false });
  });
  it('adds children fetched with loadChildren under an expanded parent without duplicating', () => {
    const rows = [row('parent', { startDate: '2030-01-02', dueDate: '2030-01-09' }, { childCount: 1 })];
    const kid = row('kid', { startDate: '2030-01-03', dueDate: '2030-01-04' }, { parentId: 'parent' });
    const loaded = new Map([['parent', [kid]]]);
    expect(ids(buildItems({ result: { rows, total: 1 }, cfg, loaded, expanded: new Set(['parent']) }))).toEqual(['parent', 'kid']);
    const both = [...rows, kid];
    expect(ids(buildItems({ result: { rows: both, total: 2 }, cfg, loaded, expanded: new Set(['parent']) }))).toEqual(['parent', 'kid']);
  });
  it('keeps an undated parent with a dated subtask in the schedule', () => {
    const rows = [row('p', {}, { childCount: 1 }), row('k', { dueDate: '2030-01-03' }, { parentId: 'p' })];
    expect(ids(buildItems({ result: { rows, total: 2 }, cfg, loaded: none, expanded: open }))).toEqual(['p']);
  });
  it('groups rows under headings and gathers unscheduled rows of all groups at the end', () => {
    const rows = [
      row('a', { status: 's1', startDate: '2030-01-02', dueDate: '2030-01-03' }),
      row('b', { status: 's2', startDate: '2030-01-02', dueDate: '2030-01-03' }),
      row('c', { status: 's1' }),
      row('d', { status: 's2' }),
    ];
    const result = {
      rows,
      total: 4,
      groups: [
        { key: 's1', label: 'Doing', count: 2 },
        { key: 's2', label: 'Done', count: 2 },
      ],
    };
    const items = buildItems({ result, groupBy: 'status', cfg, loaded: none, expanded: open });
    expect(items.map((i) => (i.kind === 'group' ? `group:${i.label}` : i.kind === 'row' ? i.id : i.kind))).toEqual([
      'group:Doing',
      'a',
      'group:Done',
      'b',
      'unscheduled',
      'c',
      'd',
    ]);
  });
  it('copes with a parent cycle', () => {
    const rows = [row('x', {}, { parentId: 'y' }), row('y', {}, { parentId: 'x' })];
    expect(() => buildItems({ result: { rows, total: 2 }, cfg, loaded: none, expanded: new Set(['x', 'y']) })).not.toThrow();
  });
});

describe('windowing', () => {
  it('draws only the rows in view plus a margin', () => {
    expect(visibleRange(0, 320, 1000, 32, 6)).toEqual({ from: 0, to: 16 });
    expect(visibleRange(3200, 320, 1000, 32, 6)).toEqual({ from: 94, to: 116 });
    expect(visibleRange(31500, 320, 1000, 32, 6)).toEqual({ from: 978, to: 1000 });
    expect(visibleRange(0, 320, 0)).toEqual({ from: 0, to: 0 });
    expect(visibleRange(99999, 320, 10)).toEqual({ from: 10, to: 10 });
  });
});
