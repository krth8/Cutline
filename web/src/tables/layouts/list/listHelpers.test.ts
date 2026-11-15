import { describe, expect, it } from 'vitest';
import type { Row, TableSchema } from '../../types';
import { doneModel } from './listHelpers';

const schemaWith = (options: Array<{ value: string; label: string; done?: boolean }>): TableSchema => ({
  ref: 'tasks:p1',
  name: 'Tasks',
  titleColumn: 'name',
  capabilities: { create: true, delete: true, hierarchy: true, editSchema: false },
  columns: [
    { key: 'name', name: 'Name', type: 'text', builtin: true },
    { key: 'status', name: 'Status', type: 'status', builtin: true, options },
  ],
});
const row = (status: string): Row => ({ id: 'r', tableRef: 'tasks:p1', values: { status }, canEdit: true });

describe('doneModel with the done flag', () => {
  it('prefers the flag over the name', () => {
    const model = doneModel(
      schemaWith([
        { value: 'a', label: 'Backlog', done: false },
        { value: 'b', label: 'Done', done: false }, // named like the guess, but switched off
        { value: 'c', label: 'Approved', done: true },
        { value: 'd', label: 'Shipped', done: true },
      ]),
    )!;
    expect(model.doneValue).toBe('c');
    expect(model.openValue).toBe('a');
    expect([model.isDone(row('b')), model.isDone(row('c')), model.isDone(row('d'))]).toEqual([false, true, true]);
  });

  it('falls back to the name guess when no option carries a flag', () => {
    const model = doneModel(schemaWith([{ value: 'a', label: 'Open' }, { value: 'b', label: 'Completed' }]))!;
    expect(model.doneValue).toBe('b');
    expect(model.isDone(row('b'))).toBe(true);
    expect(model.isDone(row('a'))).toBe(false);
  });

  it('has no status model when the flags say nothing is done', () => {
    expect(doneModel(schemaWith([{ value: 'a', label: 'Open', done: false }]))).toBeUndefined();
  });
});
