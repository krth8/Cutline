import { describe, expect, it } from 'vitest';
import type { Column } from '../../types';
import { parseTsv, planPaste, toTsv, type PasteInput } from './clipboard';

describe('tsv', () => {
  it('writes tabs and newlines between cells and rows', () => {
    expect(toTsv([['a', 'b'], ['c', '']])).toBe('a\tb\nc\t');
  });

  it('quotes cells with tabs, newlines and quotes, and reads them back', () => {
    const matrix = [['a\tb', 'say "hi"', 'x\ny'], ['', 'plain', '']];
    const text = toTsv(matrix);
    expect(text).toContain('"a\tb"');
    expect(parseTsv(text)).toEqual(matrix);
  });

  it('reads \\r\\n, ignores one trailing newline and keeps empty cells', () => {
    expect(parseTsv('a\tb\r\nc\td\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseTsv('a\t\tc')).toEqual([['a', '', 'c']]);
    expect(parseTsv('one')).toEqual([['one']]);
    expect(parseTsv('')).toEqual([]);
    expect(parseTsv('a\n\nb')).toEqual([['a'], [''], ['b']]);
  });
});

describe('planPaste', () => {
  const col = (key: string, type: Column['type'] = 'text'): Column => ({ key, name: key, type, builtin: false });
  const columns = [col('name'), col('n', 'number'), col('ro')];
  const base: PasteInput = {
    matrix: [['x']],
    order: ['r1', 'r2', 'r3'],
    start: { rowId: 'r1', col: 0 },
    columns,
    selected: new Set(),
    canEditRow: (id) => id !== 'r3',
    canEditColumn: (c) => c.key !== 'ro',
    parse: (c, t) => (c.type === 'number' ? (Number.isNaN(Number(t)) ? null : { value: Number(t) }) : { value: t }),
  };

  it('lays a block out from the focused cell and cuts it off at the last row', () => {
    const { updates, skipped } = planPaste({ ...base, matrix: [['A', '1'], ['B', '2'], ['C', '3']], start: { rowId: 'r2', col: 0 } });
    expect(updates).toEqual([{ rowId: 'r2', values: { name: 'A', n: 1 } }]);
    expect(skipped).toBe(2); // r3 cannot be edited: two cells
  });

  it('counts unparsable and read-only cells as skipped and cuts the block off at the last column', () => {
    const { updates, skipped } = planPaste({ ...base, matrix: [['A', 'oops', 'z', 'beyond']], start: { rowId: 'r1', col: 0 } });
    expect(updates).toEqual([{ rowId: 'r1', values: { name: 'A' } }]);
    expect(skipped).toBe(2);
  });

  it('one value goes to every selected row in the focused column', () => {
    const { updates, skipped } = planPaste({ ...base, matrix: [['5']], start: { rowId: 'r2', col: 1 }, selected: new Set(['r1', 'r2', 'r3']) });
    expect(updates).toEqual([{ rowId: 'r1', values: { n: 5 } }, { rowId: 'r2', values: { n: 5 } }]);
    expect(skipped).toBe(1);
  });

  it('a single value outside the selection goes to the focused cell only', () => {
    const { updates } = planPaste({ ...base, matrix: [['q']], start: { rowId: 'r1', col: 0 }, selected: new Set(['r2', 'r3']) });
    expect(updates).toEqual([{ rowId: 'r1', values: { name: 'q' } }]);
  });

  it('does nothing for an unknown start row or an empty paste', () => {
    expect(planPaste({ ...base, start: { rowId: 'zz', col: 0 } })).toEqual({ updates: [], skipped: 0 });
    expect(planPaste({ ...base, matrix: [] })).toEqual({ updates: [], skipped: 0 });
  });
});
