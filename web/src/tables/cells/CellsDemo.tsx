import { useState } from 'react';
import { addDaysISO, today } from './util';
import { CellHost } from './CellHost';
import type { Column, ColumnType } from '../types';
import './cells-demo.css';

const STATUS = [
  { value: 'todo', label: 'To do', color: '#6b7280' },
  { value: 'doing', label: 'In progress', color: '#3b82f6' },
  { value: 'review', label: 'Review', color: '#f59e0b' },
  { value: 'done', label: 'Done', color: '#22c55e' },
];
const PRIORITY = [
  { value: 'low', label: 'Low', color: '#6b7280' },
  { value: 'medium', label: 'Medium', color: '#f59e0b' },
  { value: 'high', label: 'High', color: '#ef4444' },
];
const STAGES = ['Previz', 'Layout', 'Animation', 'Lighting', 'FX', 'Comp', 'Review'].map((s, i) => ({
  value: s,
  label: s,
  color: ['#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1'][i]!,
}));
const PEOPLE = ['Ada Lovelace', 'Grace Hopper', 'Alan Turing', 'Linus Torvalds', 'Margaret Hamilton', 'Dennis Ritchie'].map((n, i) => ({
  value: `u${i + 1}`,
  label: n,
}));

const col = (type: ColumnType, extra: Partial<Column> = {}): Column => ({ key: type, name: type, type, builtin: false, ...extra });

interface Spec {
  column: Column;
  filled: unknown;
  empty: unknown;
}

function specs(): Spec[] {
  const t = today();
  return [
    { column: col('text'), filled: 'Storyboard review', empty: null },
    { column: col('longtext'), filled: 'A longer note that wraps over several lines and gets clamped in the cell, with the full text in the tooltip.', empty: null },
    { column: col('number'), filled: 1234.5, empty: null },
    { column: col('checkbox'), filled: true, empty: false },
    { column: col('date', { name: 'Due' }), filled: addDaysISO(t, -3), empty: null },
    { column: col('select', { name: 'Stage', options: STAGES }), filled: 'Animation', empty: null },
    { column: col('multiselect', { options: STAGES }), filled: ['Layout', 'FX', 'Comp'], empty: [] },
    { column: col('status', { options: STATUS }), filled: 'doing', empty: null },
    { column: col('priority', { options: PRIORITY }), filled: 'high', empty: null },
    { column: col('person', { options: PEOPLE }), filled: 'u2', empty: null },
    { column: col('people', { options: PEOPLE }), filled: ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'], empty: [] },
    { column: col('url'), filled: 'https://example.com/some/long/path/to/a/resource', empty: null },
    { column: col('clip'), filled: { baseName: 'sh010_anim', version: 3 }, empty: null },
    { column: col('relation'), filled: ['r1', 'r2'], empty: [] },
    { column: col('formula'), filled: 42.5, empty: null },
  ];
}

function Cell({ column, initial, readOnly }: { column: Column; initial: unknown; readOnly?: boolean }) {
  const [value, setValue] = useState<unknown>(initial);
  return <CellHost column={column} value={value} {...(readOnly ? { readOnly } : {})} onChange={setValue} />;
}

/** Every column type in the states empty, filled and read-only, each cell live (for /dev/ui and the browser check). */
export function CellsDemo() {
  const rows = specs();
  return (
    <div className="cl-cellsdemo" data-testid="cells-demo">
      <div className="cl-cellsdemo__scroll" data-testid="cells-demo-scroll">
        <table className="cl-cellsdemo__table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Empty</th>
              <th>Filled</th>
              <th>Read-only</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ column, filled, empty }) => (
              <tr key={column.type} data-type={column.type}>
                <th scope="row">{column.type}</th>
                <td data-state="empty">
                  <Cell column={column} initial={empty} />
                </td>
                <td data-state="filled">
                  <Cell column={column} initial={filled} />
                </td>
                <td data-state="readonly">
                  <Cell column={column} initial={filled} readOnly />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
