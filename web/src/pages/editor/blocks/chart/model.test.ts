import { describe, expect, it } from 'vitest';
import type { Column, QueryResult } from '../../../../tables/types';
import {
  NONE_COLOR,
  OTHER_COLOR,
  bucketFullLabel,
  bucketLabel,
  buildPoints,
  chooseOrientation,
  compactNumber,
  labelPlan,
  markName,
  mergeOther,
  nextBucketKey,
  niceTicks,
  paletteColor,
  percents,
  truncate,
  type Point,
} from './model';
import { planChart } from './plan';
import { defaultGroupBy } from './ChartSetup';

const status: Column = {
  key: 'status',
  name: 'Status',
  type: 'status',
  builtin: true,
  options: [
    { value: 's1', label: 'To do', color: '#ff0000' },
    { value: 's2', label: 'Doing' },
  ],
};
const due: Column = { key: 'due', name: 'Due', type: 'date', builtin: true };
const schema = {
  ref: 't',
  name: 'T',
  titleColumn: 'name',
  capabilities: { create: true, delete: true, hierarchy: false, editSchema: true },
  columns: [{ key: 'name', name: 'Name', type: 'text' as const, builtin: true }, status, due, { key: 'pts', name: 'Points', type: 'number' as const, builtin: false }],
};

const pt = (label: string, value: number | null, key: string | null = label): Point => ({ key, label, full: label, value, color: 'x' });

describe('niceTicks', () => {
  it('uses round numbers, includes 0 and the whole range, and gives 3 to 5 ticks', () => {
    const cases: Array<[number, number, number[]]> = [
      [0, 12, [0, 5, 10, 15]],
      [0, 7, [0, 2, 4, 6, 8]],
      [0, 100, [0, 50, 100]],
      [0, 1200, [0, 500, 1000, 1500]],
      [0, 0.8, [0, 0.2, 0.4, 0.6, 0.8]],
    ];
    for (const [lo, hi, ticks] of cases) {
      const t = niceTicks(lo, hi);
      expect(t.ticks).toEqual(ticks);
      expect(t.min).toBe(0);
      expect(t.max).toBeGreaterThanOrEqual(hi);
      expect(t.ticks.length).toBeGreaterThanOrEqual(3);
      expect(t.ticks.length).toBeLessThanOrEqual(5);
    }
  });

  it('handles negatives, all zeros and integer-only counts', () => {
    expect(niceTicks(-30, 10).ticks).toEqual([-30, -20, -10, 0, 10]);
    expect(niceTicks(0, 0).ticks).toEqual([0, 0.5, 1]);
    expect(niceTicks(0, 1, 4, true).ticks).toEqual([0, 1]);
    expect(niceTicks(0, 3, 4, true).ticks).toEqual([0, 1, 2, 3]);
  });

  it('writes big numbers short', () => {
    expect(compactNumber(500)).toBe('500');
    expect(compactNumber(15000)).toBe('15k');
    expect(compactNumber(2500000)).toBe('2.5M');
  });
});

describe('Other', () => {
  const many = Array.from({ length: 11 }, (_, i) => pt(`g${i}`, i + 1));

  it('leaves 8 or fewer points alone', () => {
    const eight = many.slice(0, 8);
    expect(mergeOther(eight)).toBe(eight);
  });

  it('keeps the 7 largest in their order and adds up the rest as a grey Other at the end', () => {
    const merged = mergeOther(many);
    expect(merged).toHaveLength(8);
    expect(merged.slice(0, 7).map((p) => p.label)).toEqual(['g4', 'g5', 'g6', 'g7', 'g8', 'g9', 'g10']);
    const other = merged[7]!;
    expect(other).toMatchObject({ label: 'Other', key: '__other', color: OTHER_COLOR });
    expect(other.value).toBe(1 + 2 + 3 + 4);
  });
});

describe('date buckets', () => {
  it('writes day, week and month keys as short labels, with the year when asked', () => {
    expect(bucketLabel('2026-11-09', 'day')).toBe('Nov 9');
    expect(bucketLabel('2026-11-09', 'week', true)).toBe('Nov 9, 2026');
    expect(bucketLabel('2026-11', 'month')).toBe('Nov');
    expect(bucketLabel('2026-11', 'month', true)).toBe('Nov 2026');
    expect(bucketLabel('garbage', 'day')).toBe('garbage');
    expect(bucketFullLabel('2026-11-09', 'week')).toBe('Week of Nov 9, 2026');
    expect(bucketFullLabel('2026-11', 'month')).toBe('Nov 2026');
  });

  it('steps to the next bucket across month and year ends', () => {
    expect(nextBucketKey('2026-12-31', 'day')).toBe('2027-01-01');
    expect(nextBucketKey('2026-12-28', 'week')).toBe('2027-01-04');
    expect(nextBucketKey('2026-12', 'month')).toBe('2027-01');
    expect(nextBucketKey('nope', 'day')).toBeNull();
  });

  const dated = (keys: Array<string | null>, counts: number[]): QueryResult => ({
    rows: [],
    total: counts.reduce((a, b) => a + b, 0),
    groups: keys.map((key, i) => ({ key, label: key ?? 'No value', count: counts[i]! })),
  });

  it('fills the weeks nobody has a row in, keeps "No value" last, and uses one colour', () => {
    const points = buildPoints(dated(['2026-11-02', '2026-11-16', null], [3, 2, 1]), due, { fn: 'count', column: null, bucket: 'week' });
    expect(points.map((p) => [p.label, p.value])).toEqual([
      ['Nov 2', 3],
      ['Nov 9', 0],
      ['Nov 16', 2],
      ['No value', 1],
    ]);
    expect(points[0]!.color).toBe(paletteColor(0));
    expect(points[1]!.color).toBe(paletteColor(0));
    expect(points[3]!.color).toBe(NONE_COLOR);
    expect(points[1]!.full).toBe('Week of Nov 9, 2026');
  });

  it('shows the year when the dates span years, and fills gaps of a sum with 0 but of an average with nothing', () => {
    const result: QueryResult = {
      rows: [],
      total: 2,
      groups: [
        { key: '2026-12', label: '2026-12', count: 1, summaries: { pts: 4 } },
        { key: '2027-02', label: '2027-02', count: 1, summaries: { pts: 6 } },
      ],
    };
    const sum = buildPoints(result, due, { fn: 'sum', column: 'pts', bucket: 'month' });
    expect(sum.map((p) => [p.label, p.value])).toEqual([['Dec 2026', 4], ['Jan 2027', 0], ['Feb 2027', 6]]);
    const avg = buildPoints(result, due, { fn: 'avg', column: 'pts', bucket: 'month' });
    expect(avg.map((p) => p.value)).toEqual([4, null, 6]);
  });
});

describe('points from groups', () => {
  const result: QueryResult = {
    rows: [],
    total: 6,
    groups: [
      { key: 's1', label: 'To do', color: '#ff0000', count: 3, summaries: { pts: 9 } },
      { key: 's2', label: 'Doing', count: 2, summaries: { pts: null } },
      { key: null, label: 'No value', count: 1, summaries: { pts: 0 } },
    ],
  };

  it('takes the option colour, then the palette by position; the empty group is neutral', () => {
    const points = buildPoints(result, status, { fn: 'count', column: null, bucket: 'week' });
    expect(points.map((p) => [p.label, p.value, p.color])).toEqual([
      ['To do', 3, '#ff0000'],
      ['Doing', 2, paletteColor(1)],
      ['No value', 1, NONE_COLOR],
    ]);
  });

  it('reads the measure from the per-group summary', () => {
    const points = buildPoints(result, status, { fn: 'sum', column: 'pts', bucket: 'week' });
    expect(points.map((p) => p.value)).toEqual([9, null, 0]);
  });

  it('wraps around the palette and names marks for assistive technology', () => {
    expect(paletteColor(8)).toBe(paletteColor(0));
    expect(markName(pt('Done', 12))).toBe('Done: 12');
    expect(markName(pt('Done', null))).toBe('Done: no value');
    expect(markName(pt('Done', 12), 40)).toBe('Done: 12 (40%)');
  });

  it('percentages add up to 100', () => {
    const p = percents([pt('a', 1), pt('b', 1), pt('c', 1)]);
    expect(p.reduce((a, b) => a! + b!, 0)).toBe(100);
    expect(percents([pt('a', 0)])).toEqual([null]);
  });
});

describe('labels and layout', () => {
  it('switches to horizontal bars for many categories or long labels, not for a few short ones', () => {
    const short = ['Todo', 'Doing', 'Done'];
    expect(chooseOrientation(short, 600)).toBe('vertical');
    expect(chooseOrientation(short, 280)).toBe('vertical');
    expect(chooseOrientation(Array.from({ length: 9 }, (_, i) => `c${i}`), 900)).toBe('horizontal');
    expect(chooseOrientation(['Waiting for client feedback', 'Internal review', 'Ready to ship', 'Archived'], 400)).toBe('horizontal');
    expect(chooseOrientation(['A', 'B'], 100)).toBe('vertical');
  });

  it('truncates with an ellipsis and plans flat, shortened or slanted labels', () => {
    expect(truncate('Waiting for client', 10)).toBe('Waiting f…');
    expect(truncate('Short', 10)).toBe('Short');
    expect(labelPlan(['Todo', 'Done'], 100)).toMatchObject({ rotate: false, stride: 1 });
    expect(labelPlan(['Waiting for client'], 50)).toMatchObject({ rotate: false, maxChars: 7 });
    const crowded = labelPlan(['Waiting for client'], 12);
    expect(crowded).toMatchObject({ rotate: true, maxChars: 14 });
    expect(crowded.stride).toBe(2);
  });
});

describe('planning', () => {
  const attrs = { groupBy: 'status', fn: 'count' as const, column: null, bucket: 'week' as const };

  it('count: groupBy only; a date column adds the bucket; a measure adds one summary', () => {
    const count = planChart(schema, attrs);
    expect(count.ok && count.extra).toEqual({ groupBy: 'status' });
    const byDate = planChart(schema, { ...attrs, groupBy: 'due', bucket: 'month' });
    expect(byDate.ok && byDate.extra).toEqual({ groupBy: 'due', groupBucket: 'month' });
    const sum = planChart(schema, { ...attrs, fn: 'sum', column: 'pts' });
    expect(sum.ok && sum.extra).toEqual({ groupBy: 'status', summaries: { pts: 'sum' } });
  });

  it('names the setting to fix', () => {
    expect(planChart(schema, { ...attrs, groupBy: null })).toMatchObject({ ok: false, reason: 'Group by: choose a column' });
    expect(planChart(schema, { ...attrs, groupBy: 'gone' })).toMatchObject({ ok: false });
    expect((planChart(schema, { ...attrs, groupBy: 'name' }) as { reason: string }).reason).toMatch(/^Group by: Name cannot be charted/);
    expect((planChart(schema, { ...attrs, fn: 'avg' }) as { reason: string }).reason).toBe('Measure: choose a number column');
    expect((planChart(schema, { ...attrs, fn: 'avg', column: 'status' }) as { reason: string }).reason).toBe('Measure: Status is not a number column.');
    expect((planChart(schema, { ...attrs, fn: 'avg', column: 'removed' }) as { reason: string }).reason).toMatch(/^Measure: this column no longer exists/);
  });

  it('a new chart groups by the status, else the first column that can be grouped', () => {
    expect(defaultGroupBy(schema)).toBe('status');
    expect(defaultGroupBy({ columns: [schema.columns[0]!, due] })).toBe('due');
    expect(defaultGroupBy({ columns: [schema.columns[0]!] })).toBeNull();
  });
});
