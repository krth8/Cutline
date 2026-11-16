/**
 * Plain logic of the chart block (no React, no Tiptap, no platform): the attributes, which columns can be
 * charted, how a grouped query result becomes the marks of a chart, axis ticks at round numbers, label
 * shortening and the choice between vertical and horizontal bars. Used by the node (editor chunk) and by
 * the host (main bundle), so it stays free of anything that exists once per bundle.
 */
import type { Column, ColumnType, QueryResult } from '../../../../tables/types';
import { formatNumber } from '../summary/model';

export { formatNumber };

/** Node name in the document. */
export const CHART_BLOCK = 'chart';

export const CHART_TYPES = ['bar', 'line', 'donut'] as const;
export type ChartType = (typeof CHART_TYPES)[number];
export const TYPE_LABELS: Record<ChartType, string> = { bar: 'Bar', line: 'Line', donut: 'Donut' };

export const CHART_FNS = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type ChartFn = (typeof CHART_FNS)[number];
export const FN_LABELS: Record<ChartFn, string> = { count: 'Count', sum: 'Sum', avg: 'Average', min: 'Min', max: 'Max' };

export const BUCKETS = ['day', 'week', 'month'] as const;
export type Bucket = (typeof BUCKETS)[number];
export const BUCKET_LABELS: Record<Bucket, string> = { day: 'Day', week: 'Week', month: 'Month' };

export const MIN_HEIGHT = 160;
export const MAX_HEIGHT = 800;
export const DEFAULT_HEIGHT = 280;

/** The attributes of the node. */
export interface ChartAttrs {
  viewId: string | null;
  type: ChartType;
  /** Column key of the categories (the x axis, the slices). */
  groupBy: string | null;
  fn: ChartFn;
  /** The number column of sum, avg, min and max. */
  column: string | null;
  title: string;
  /** Pixels; null = the default. */
  height: number | null;
  /** Date group columns only. */
  bucket: Bucket;
}

export const DEFAULT_ATTRS: ChartAttrs = {
  viewId: null,
  type: 'bar',
  groupBy: null,
  fn: 'count',
  column: null,
  title: '',
  height: null,
  bucket: 'week',
};

export const cleanType = (v: unknown): ChartType => ((CHART_TYPES as readonly unknown[]).includes(v) ? (v as ChartType) : 'bar');
export const cleanFn = (v: unknown): ChartFn => ((CHART_FNS as readonly unknown[]).includes(v) ? (v as ChartFn) : 'count');
export const cleanBucket = (v: unknown): Bucket => ((BUCKETS as readonly unknown[]).includes(v) ? (v as Bucket) : 'week');
export function clampHeight(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(n)));
}

/** Column types a chart can group by (the same ones the query engine groups sensibly). */
const GROUPABLE: ColumnType[] = ['select', 'status', 'priority', 'person', 'multiselect', 'people', 'date', 'checkbox', 'number'];
export const canGroupBy = (type: ColumnType): boolean => GROUPABLE.includes(type);
/** Columns whose groups have a natural order (the chart then uses one colour and, for dates, fills gaps). */
export const isOrderedType = (type: ColumnType): boolean => type === 'date' || type === 'number';
/** Columns a sum, average, min or max can read. */
export const canMeasure = (type: ColumnType): boolean => type === 'number' || type === 'formula';
export const needsColumn = (fn: ChartFn): boolean => fn !== 'count';

// ---------------------------------------------------------------- colours

/** The categorical palette lives in chart.css as --cl-chart-1 .. --cl-chart-8 (dark and light variants). */
export const PALETTE_SIZE = 8;
export const paletteColor = (i: number): string => `var(--cl-chart-${(((i % PALETTE_SIZE) + PALETTE_SIZE) % PALETTE_SIZE) + 1})`;
export const NONE_COLOR = 'var(--cl-chart-none)';
export const OTHER_COLOR = 'var(--cl-chart-other)';

// ---------------------------------------------------------------- points

/** One mark of a chart: a bar, a point of the line or a slice. */
export interface Point {
  /** The group's key; null for the empty group, `__other` for the merged slice. */
  key: string | null;
  /** Short text for an axis or a legend. */
  label: string;
  /** Longer text for a tooltip and the accessible name ("Week of Nov 9, 2026"). */
  full: string;
  /** null: the group has no value for the measure (an average of nothing). */
  value: number | null;
  color: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_KEY = /^(\d{4})-(\d{2})$/;

/** The text of a date bucket's key: "Nov 9" (day, week; the week's Monday) or "Nov" (month), with the year when asked. */
export function bucketLabel(key: string, bucket: Bucket, withYear = false): string {
  if (bucket === 'month') {
    const m = MONTH_KEY.exec(key);
    if (!m) return key;
    const name = MONTHS[Number(m[2]) - 1] ?? key;
    return withYear ? `${name} ${m[1]}` : name;
  }
  const m = DAY_KEY.exec(key);
  if (!m) return key;
  const name = `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
  return withYear ? `${name}, ${m[1]}` : name;
}

/** The tooltip text of a bucket: a week is named by its Monday. */
export function bucketFullLabel(key: string, bucket: Bucket): string {
  const text = bucketLabel(key, bucket, true);
  return bucket === 'week' && DAY_KEY.test(key) ? `Week of ${text}` : text;
}

/** The key that follows `key` in the same bucket size, or null when the key is not a date key. */
export function nextBucketKey(key: string, bucket: Bucket): string | null {
  if (bucket === 'month') {
    const m = MONTH_KEY.exec(key);
    if (!m) return null;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1)); // month index = this month's number, so this is the next month
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const m = DAY_KEY.exec(key);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (bucket === 'week' ? 7 : 1)));
  return d.toISOString().slice(0, 10);
}

const MAX_FILLED = 200;

/**
 * The marks of the chart from a grouped query result. Groups keep the server's order (option order, ascending
 * dates, "No value" last). Colours: the group's own (status and select options), else the palette by position,
 * else one colour for ordered columns (dates, numbers). Date groups get the missing days, weeks or months
 * between the first and the last, so the x axis does not hide gaps.
 */
export function buildPoints(result: QueryResult, column: Column, attrs: Pick<ChartAttrs, 'fn' | 'column' | 'bucket'>): Point[] {
  const groups = result.groups ?? [];
  const isDate = column.type === 'date';
  const ordered = isOrderedType(column.type);
  const years = new Set(groups.map((g) => (g.key && /^\d{4}/.test(g.key) ? g.key.slice(0, 4) : '')).filter(Boolean));
  const withYear = years.size > 1;
  const read = (g: { count: number; summaries?: Record<string, number | null> }): number | null =>
    attrs.fn === 'count' ? g.count : (attrs.column ? g.summaries?.[attrs.column] : null) ?? null;

  let colorIndex = 0;
  const points: Point[] = groups.map((g) => {
    let label = g.label || (g.key ?? 'No value');
    let full = label;
    if (isDate && g.key !== null) {
      label = bucketLabel(g.key, attrs.bucket, withYear);
      full = bucketFullLabel(g.key, attrs.bucket);
    }
    const color = g.key === null ? NONE_COLOR : g.color ? g.color : ordered ? paletteColor(0) : paletteColor(colorIndex);
    if (g.key !== null) colorIndex++;
    return { key: g.key, label, full, value: read(g), color };
  });

  return isDate ? fillDateGaps(points, attrs, withYear) : points;
}

function fillDateGaps(points: Point[], attrs: Pick<ChartAttrs, 'fn' | 'bucket'>, withYear: boolean): Point[] {
  const dated = points.filter((p) => p.key !== null);
  const empty = points.filter((p) => p.key === null);
  if (dated.length < 2) return points;
  const byKey = new Map(dated.map((p) => [p.key as string, p]));
  const first = dated[0]!.key as string;
  const last = dated[dated.length - 1]!.key as string;
  const filled: Point[] = [];
  let key: string | null = first;
  while (key !== null && key <= last && filled.length <= MAX_FILLED) {
    filled.push(
      byKey.get(key) ?? {
        key,
        label: bucketLabel(key, attrs.bucket, withYear),
        full: bucketFullLabel(key, attrs.bucket),
        value: attrs.fn === 'count' || attrs.fn === 'sum' ? 0 : null,
        color: paletteColor(0),
      },
    );
    key = nextBucketKey(key, attrs.bucket);
  }
  // Unparseable keys or too many buckets: show what the server sent
  if (key === null || filled.length > MAX_FILLED || filled.length < dated.length) return points;
  return [...filled, ...empty];
}

export const MAX_SLICES = 8;

/** At most `max` slices: the largest stay (in their order), the rest are added up as "Other" (last, grey). */
export function mergeOther(points: Point[], max = MAX_SLICES): Point[] {
  if (points.length <= max) return points;
  const ranked = points.map((p, i) => ({ p, i })).sort((a, b) => (b.p.value ?? 0) - (a.p.value ?? 0) || a.i - b.i);
  const keep = new Set(ranked.slice(0, max - 1).map((r) => r.i));
  const rest = points.filter((_, i) => !keep.has(i));
  const other: Point = {
    key: '__other',
    label: 'Other',
    full: 'Other',
    value: rest.reduce((sum, p) => sum + (p.value ?? 0), 0),
    color: OTHER_COLOR,
  };
  return [...points.filter((_, i) => keep.has(i)), other];
}

/** Whether percentages and a total mean something: only for counts and sums. */
export const addsUp = (fn: ChartFn): boolean => fn === 'count' || fn === 'sum';

/** "Count" or "Sum of Estimate". */
export function measureLabel(fn: ChartFn, column: Column | undefined | null): string {
  return fn === 'count' || !column ? FN_LABELS[fn] : `${FN_LABELS[fn]} of ${column.name}`;
}

/** Accessible name of one mark: "Done: 12". */
export function markName(p: Point, percent?: number | null): string {
  const value = p.value === null ? 'no value' : formatNumber(p.value);
  return percent === null || percent === undefined ? `${p.full}: ${value}` : `${p.full}: ${value} (${percent}%)`;
}

// ---------------------------------------------------------------- axis

export interface Ticks {
  ticks: number[];
  min: number;
  max: number;
}

/**
 * Axis ticks at round numbers (1, 2, 5 times a power of ten) that include 0 and the whole data range,
 * about `target` of them. With `integer` the step is never below 1, so a count never gets a tick at 0.5.
 */
export function niceTicks(dataMin: number, dataMax: number, target = 4, integer = false): Ticks {
  let lo = Math.min(0, dataMin);
  let hi = Math.max(0, dataMax);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (hi === lo) hi = lo + 1;
  const raw = (hi - lo) / Math.max(1, target);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const unit = raw / pow;
  let step = (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * pow;
  if (integer) step = Math.max(1, step);
  const start = Math.floor(lo / step + 1e-9) * step;
  const end = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let t = start; t <= end + step / 1e6; t += step) ticks.push(Number(t.toPrecision(12)));
  return { ticks, min: ticks[0]!, max: ticks[ticks.length - 1]! };
}

/** A short number for an axis: 1200 -> "1.2k", 2500000 -> "2.5M". */
export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  const trim = (v: number) => String(Number(v.toFixed(1)));
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e4) return `${trim(n / 1e3)}k`;
  return formatNumber(n);
}

// ---------------------------------------------------------------- labels

/** Average width of a character of the 11 px labels. */
export const CHAR_WIDTH = 6.2;

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** Bars run sideways when there are many categories or when the labels would not fit under vertical bars. */
export function chooseOrientation(labels: string[], width: number): 'vertical' | 'horizontal' {
  const n = labels.length;
  if (n > 8) return 'horizontal';
  if (n < 3) return 'vertical';
  const longest = Math.max(...labels.map((l) => l.length));
  const slot = (width - 56) / n;
  return slot < CHAR_WIDTH * Math.min(longest, 14) ? 'horizontal' : 'vertical';
}

export interface LabelPlan {
  /** Draw the labels at an angle. */
  rotate: boolean;
  /** Longest text shown before the ellipsis. */
  maxChars: number;
  /** Show every nth label (1 = all). */
  stride: number;
}

/** How the category labels fit under `slot` pixels each: flat if they fit, else shortened and slanted, thinned out when crowded. */
export function labelPlan(labels: string[], slot: number): LabelPlan {
  const longest = Math.max(1, ...labels.map((l) => l.length));
  const fits = Math.floor((slot - 4) / CHAR_WIDTH);
  if (longest <= fits) return { rotate: false, maxChars: longest, stride: 1 };
  if (fits >= 3) return { rotate: false, maxChars: fits, stride: 1 };
  // Slanted text needs about 14 px of height per label
  return { rotate: true, maxChars: 14, stride: Math.max(1, Math.ceil(14 / Math.max(1, slot))) };
}

/** Percent of the total for each point (whole numbers; the last takes the rounding remainder so they add up to 100). */
export function percents(points: Point[]): Array<number | null> {
  const total = points.reduce((s, p) => s + Math.max(0, p.value ?? 0), 0);
  if (total <= 0) return points.map(() => null);
  const raw = points.map((p) => (100 * Math.max(0, p.value ?? 0)) / total);
  const out = raw.map((v) => Math.floor(v));
  let left = 100 - out.reduce((s, v) => s + v, 0);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (left <= 0) break;
    if (raw[i]! > 0) {
      out[i]!++;
      left--;
    }
  }
  return out;
}
