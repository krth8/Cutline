/**
 * Plain logic of the summary block (no React, no Tiptap, no platform): which functions exist, which query
 * a summary sends, how its answer is read and how numbers are written. Used by the nodes (editor chunk)
 * and by the host (main bundle), so it must stay free of anything that exists once per bundle.
 */
import type { ColumnType } from '../../../../tables/types';

/** Node names in the document. */
export const SUMMARY_BLOCK = 'summary';
export const SUMMARY_INLINE = 'summaryInline';

/** The query engine's summary functions plus `percentDone` (share of rows whose status counts as done). */
export const SUMMARY_FNS = [
  'count',
  'countFilled',
  'countEmpty',
  'sum',
  'avg',
  'min',
  'max',
  'percentChecked',
  'percentDone',
] as const;
export type SummaryFn = (typeof SUMMARY_FNS)[number];
export type SummaryDisplay = 'number' | 'progress';

export const FN_LABELS: Record<SummaryFn, string> = {
  count: 'Count',
  countFilled: 'Filled',
  countEmpty: 'Empty',
  sum: 'Sum',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
  percentChecked: 'Percent checked',
  percentDone: 'Percent done',
};

/** The attributes of the block node; the inline node uses `viewId`, `fn` and `column` only. */
export interface SummaryAttrs {
  viewId: string | null;
  fn: SummaryFn;
  column: string | null;
  label: string;
  display: SummaryDisplay;
  target: number | null;
}

export const DEFAULT_ATTRS: SummaryAttrs = { viewId: null, fn: 'count', column: null, label: '', display: 'number', target: null };

export const isSummaryFn = (v: unknown): v is SummaryFn => (SUMMARY_FNS as readonly unknown[]).includes(v);

/** Functions that read one column. `count` and `percentDone` work on the rows (and the status) alone. */
export const needsColumn = (fn: SummaryFn): boolean => fn !== 'count' && fn !== 'percentDone';

/** Percent results: shown with a % sign and no decimals, and drawn against 100. */
export const isPercent = (fn: SummaryFn): boolean => fn === 'percentChecked' || fn === 'percentDone';

/** Whether the query engine accepts `fn` on a column of this type (the same rules as api/tables/query.py). */
export function fnFitsColumn(fn: SummaryFn, type: ColumnType): boolean {
  switch (fn) {
    case 'sum':
    case 'avg':
      return type === 'number' || type === 'formula';
    case 'min':
    case 'max':
      return type === 'number' || type === 'formula' || type === 'date';
    case 'percentChecked':
      return type === 'checkbox';
    default:
      return true;
  }
}

export const cleanFn = (v: unknown): SummaryFn => (isSummaryFn(v) ? v : 'count');
export const cleanDisplay = (v: unknown): SummaryDisplay => (v === 'progress' ? 'progress' : 'number');
export function cleanTarget(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

const NO_VALUE = '—';

/** Group digits with a thin no-break space, at most two decimals. */
export function formatNumber(n: number): string {
  const text = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, useGrouping: true }).format(n);
  return text.replace(/,/g, ' ');
}

/** The text of a result: a dash when there is none, whole percent, plain numbers, dates as they come. */
export function formatValue(fn: SummaryFn, value: number | string | null | undefined): string {
  if (value === null || value === undefined) return NO_VALUE;
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return NO_VALUE;
  return isPercent(fn) ? `${Math.round(value)}%` : formatNumber(value);
}

/** How far the bar is filled (0 to 1), or null when there is nothing to measure against. */
export function progressFraction(fn: SummaryFn, value: number | string | null, target: number | null): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const whole = isPercent(fn) ? 100 : target;
  if (!whole || whole <= 0) return null;
  return Math.min(1, Math.max(0, value / whole));
}

/** The text beside the bar: "42%", "12 / 20", or just the number. */
export function progressText(fn: SummaryFn, value: number | string | null, target: number | null): string {
  const text = formatValue(fn, value);
  return !isPercent(fn) && target && typeof value === 'number' ? `${text} / ${formatNumber(target)}` : text;
}
