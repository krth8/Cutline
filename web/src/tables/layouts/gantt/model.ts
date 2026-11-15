// Pure Gantt logic: configuration, what a row's dates mean, pixel <-> day maths, drag results,
// the time axis and the flat list of rows to draw. No React in here.
import type { Column, QueryResult, Row, TableSchema, View } from '../../types';
import { rowInGroup } from '../list/listHelpers';
import {
  MONTH_NAMES,
  dayIndexToYmd,
  fromDayIndex,
  isWeekendIndex,
  mondayOnOrBefore,
  monthStartIndex,
  toDayIndex,
  yearStartIndex,
} from './dates';

export type Scale = 'day' | 'week' | 'month';
export const SCALES: Scale[] = ['day', 'week', 'month'];
export const PX_PER_DAY: Record<Scale, number> = { day: 36, week: 14, month: 5 };
export const ROW_HEIGHT = 32;
export const HEADER_HEIGHT = 48;
export const LIST_WIDTH = 280;

// ---------------------------------------------------------------- configuration

export interface GanttConfig {
  startColumn: string;
  endColumn: string;
  scale: Scale;
}

type Columns = Pick<GanttConfig, 'startColumn' | 'endColumn'>;

const isScale = (v: unknown): v is Scale => v === 'day' || v === 'week' || v === 'month';

/** Date columns a bar can be read from. */
export function dateColumns(schema: TableSchema): Column[] {
  return schema.columns.filter((c) => c.type === 'date');
}

/**
 * Start and end column for a new gantt: startDate and dueDate when the table has them, else the first two
 * editable date columns (then the first two date columns); with one date column both are that column.
 */
export function defaultColumns(schema: TableSchema): Columns | null {
  const dates = dateColumns(schema);
  const has = (key: string) => dates.some((c) => c.key === key);
  if (has('startDate') && has('dueDate')) return { startColumn: 'startDate', endColumn: 'dueDate' };
  const editable = dates.filter((c) => !c.readonly);
  const pool = editable.length >= 2 ? editable : dates;
  if (pool.length === 0) return null;
  const first = pool[0]!;
  return { startColumn: first.key, endColumn: (pool[1] ?? first).key };
}

/** The gantt settings of a view with missing or unknown values replaced by defaults. Null: no date column. */
export function readGanttConfig(schema: TableSchema, config: View['config']): GanttConfig | null {
  const defaults = defaultColumns(schema);
  if (!defaults) return null;
  const raw = (config.gantt ?? {}) as Partial<GanttConfig>;
  const valid = (key: unknown): key is string => typeof key === 'string' && dateColumns(schema).some((c) => c.key === key);
  return {
    startColumn: valid(raw.startColumn) ? raw.startColumn : defaults.startColumn,
    endColumn: valid(raw.endColumn) ? raw.endColumn : defaults.endColumn,
    scale: isScale(raw.scale) ? raw.scale : 'week',
  };
}

// ---------------------------------------------------------------- a row's dates

export interface Span {
  /** 'bar': two dates; 'marker': one date shown as a one-day bar; 'none': unscheduled. */
  kind: 'bar' | 'marker' | 'none';
  /** First and last day shown (day indexes, start <= end). */
  start: number;
  end: number;
  /** Day indexes as stored (null when empty). */
  rawStart: number | null;
  rawEnd: number | null;
}

const NO_SPAN: Span = { kind: 'none', start: 0, end: 0, rawStart: null, rawEnd: null };

/** With a single date column every bar is one day long and cannot be resized. */
export const isSingleDate = (cfg: Columns): boolean => cfg.startColumn === cfg.endColumn;

/** What the row's start and end values mean as a bar. Values that are not valid dates count as empty. */
export function spanOf(row: Row, cfg: Columns): Span {
  const a = toDayIndex(row.values[cfg.startColumn]);
  const b = isSingleDate(cfg) ? a : toDayIndex(row.values[cfg.endColumn]);
  if (a === null && b === null) return NO_SPAN;
  if (a !== null && b !== null) {
    return {
      kind: isSingleDate(cfg) ? 'marker' : 'bar',
      start: Math.min(a, b),
      end: Math.max(a, b),
      rawStart: a,
      rawEnd: b,
    };
  }
  const only = (a ?? b) as number;
  return { kind: 'marker', start: only, end: only, rawStart: a, rawEnd: b };
}

// ---------------------------------------------------------------- pixels and days

export interface Timeline {
  /** Day index of the left edge. */
  origin: number;
  /** Day index of the last day shown. */
  last: number;
  scale: Scale;
  pxPerDay: number;
}

export const timelineWidth = (t: Timeline): number => (t.last - t.origin + 1) * t.pxPerDay;
export const dayToX = (t: Timeline, day: number): number => (day - t.origin) * t.pxPerDay;
/** The day under an x position (pixels from the left edge of the timeline). */
export const xToDay = (t: Timeline, x: number): number => t.origin + Math.floor(x / t.pxPerDay);

export function barRect(t: Timeline, start: number, end: number): { left: number; width: number } {
  return { left: dayToX(t, start), width: (end - start + 1) * t.pxPerDay };
}

/**
 * The range of days to show: from a month before the earliest date (or today) to two months after the
 * latest (and at least 120 days after today). `minOrigin` keeps the left edge from moving right.
 */
export function computeRange(spans: Span[], today: number, minOrigin?: number): { origin: number; last: number } {
  let lo = today;
  let hi = today;
  for (const s of spans) {
    if (s.kind === 'none') continue;
    lo = Math.min(lo, s.start);
    hi = Math.max(hi, s.end);
  }
  let origin = monthStartIndex(lo, -1);
  if (minOrigin !== undefined) origin = Math.min(origin, minOrigin);
  const last = Math.max(monthStartIndex(hi, 2) - 1, today + 120);
  return { origin, last };
}

// ---------------------------------------------------------------- dragging

export type DragMode = 'move' | 'start' | 'end';

/** Days a pointer travel of `dx` pixels is worth (snapped to whole days). */
export const deltaDays = (dx: number, pxPerDay: number): number => Math.round(dx / pxPerDay);

/**
 * The dates after dragging a bar by `delta` days. Moving keeps the length; resizing moves one edge and
 * the start can never pass the end. Everything stays inside [min, max] when bounds are given.
 */
export function applyDrag(
  mode: DragMode,
  span: { start: number; end: number },
  delta: number,
  bounds?: { min: number; max: number },
): { start: number; end: number } {
  let { start, end } = span;
  if (mode === 'move') {
    let d = delta;
    if (bounds) d = Math.max(bounds.min - start, Math.min(bounds.max - end, d));
    return { start: start + d, end: end + d };
  }
  if (mode === 'start') {
    start += delta;
    if (bounds) start = Math.max(bounds.min, start);
    return { start: Math.min(start, end), end };
  }
  end += delta;
  if (bounds) end = Math.min(bounds.max, end);
  return { start, end: Math.max(end, start) };
}

/** Dates for pressing at one day and releasing at another in an empty lane. */
export function laneRange(fromDay: number, toDay: number): { start: number; end: number } {
  return { start: Math.min(fromDay, toDay), end: Math.max(fromDay, toDay) };
}

/**
 * The row values to write after a drag, or null when nothing changed. Moving writes the dates the row has
 * (a one-date row keeps being a one-date row); resizing writes the dates that changed; with a single date
 * column only a move counts.
 */
export function dragPatch(
  cfg: Columns,
  mode: DragMode,
  span: Span,
  next: { start: number; end: number },
): Record<string, string> | null {
  const patch: Record<string, string> = {};
  if (isSingleDate(cfg)) {
    if (mode !== 'move' || next.start === span.start) return null;
    patch[cfg.startColumn] = fromDayIndex(next.start);
    return patch;
  }
  if (mode === 'move') {
    const shift = next.start - span.start;
    if (shift === 0) return null;
    if (span.rawStart !== null) patch[cfg.startColumn] = fromDayIndex(span.rawStart + shift);
    if (span.rawEnd !== null) patch[cfg.endColumn] = fromDayIndex(span.rawEnd + shift);
    return patch;
  }
  if (next.start !== span.rawStart) patch[cfg.startColumn] = fromDayIndex(next.start);
  if (next.end !== span.rawEnd) patch[cfg.endColumn] = fromDayIndex(next.end);
  return Object.keys(patch).length === 0 ? null : patch;
}

/** Values to write when an unscheduled row gets dates by dragging in its lane. */
export function schedulePatch(cfg: Columns, range: { start: number; end: number }): Record<string, string> {
  if (isSingleDate(cfg)) return { [cfg.startColumn]: fromDayIndex(range.start) };
  return { [cfg.startColumn]: fromDayIndex(range.start), [cfg.endColumn]: fromDayIndex(range.end) };
}

// ---------------------------------------------------------------- time axis

export interface Tick {
  label: string;
  left: number;
  width: number;
  /** Day index of the first day of the cell. */
  day: number;
  weekend?: boolean;
}

/** Header cells: a top band (months, or years in month scale) and a bottom band (days, weeks or months). */
export function axisTicks(t: Timeline): { top: Tick[]; bottom: Tick[] } {
  const top: Tick[] = [];
  const bottom: Tick[] = [];
  const px = t.pxPerDay;
  const cell = (from: number, to: number, label: string, extra: Partial<Tick> = {}): Tick => ({
    label,
    left: (Math.max(from, t.origin) - t.origin) * px,
    width: (Math.min(to, t.last + 1) - Math.max(from, t.origin)) * px,
    day: from,
    ...extra,
  });

  if (t.scale === 'month') {
    for (let y = yearStartIndex(t.origin); y <= t.last; y = yearStartIndex(y, 1)) {
      top.push(cell(y, yearStartIndex(y, 1), String(dayIndexToYmd(y).y)));
    }
    for (let m = t.origin; m <= t.last; m = monthStartIndex(m, 1)) {
      bottom.push(cell(m, monthStartIndex(m, 1), MONTH_NAMES[dayIndexToYmd(m).m - 1]!));
    }
    return { top, bottom };
  }
  for (let m = t.origin; m <= t.last; m = monthStartIndex(m, 1)) {
    const { y, m: mo } = dayIndexToYmd(m);
    top.push(cell(m, monthStartIndex(m, 1), `${MONTH_NAMES[mo - 1]} ${y}`));
  }
  if (t.scale === 'day') {
    for (let d = t.origin; d <= t.last; d++) {
      bottom.push(cell(d, d + 1, String(dayIndexToYmd(d).d), { weekend: isWeekendIndex(d) }));
    }
  } else {
    for (let d = mondayOnOrBefore(t.origin); d <= t.last; d += 7) {
      bottom.push(cell(d, d + 7, String(dayIndexToYmd(Math.max(d, t.origin)).d)));
    }
  }
  return { top, bottom };
}

/** Runs of weekend days in the range: first day and number of days (day scale shading). */
export function weekendBlocks(origin: number, last: number): Array<{ day: number; days: number }> {
  const blocks: Array<{ day: number; days: number }> = [];
  for (let d = origin; d <= last; d++) {
    if (!isWeekendIndex(d)) continue;
    const start = d;
    while (d + 1 <= last && isWeekendIndex(d + 1)) d++;
    blocks.push({ day: start, days: d - start + 1 });
  }
  return blocks;
}

// ---------------------------------------------------------------- colours

/** Bar colour: the colour of the row's status option, else the group colour, else undefined (theme accent). */
export function rowColor(schema: TableSchema, row: Row, groupColor?: string): string | undefined {
  const status = schema.columns.find((c) => c.key === 'status' && c.type === 'status') ?? schema.columns.find((c) => c.type === 'status');
  if (status) {
    const option = status.options?.find((o) => o.value === row.values[status.key]);
    if (option?.color) return option.color;
  }
  return groupColor;
}

// ---------------------------------------------------------------- rows to draw

export type GanttItem =
  | { kind: 'group'; id: string; label: string; color?: string; count: number }
  | { kind: 'unscheduled'; id: string; count: number }
  | {
      kind: 'row';
      id: string;
      row: Row;
      depth: number;
      expandable: boolean;
      expanded: boolean;
      color?: string;
      unscheduled: boolean;
    };

export interface BuildInput {
  result: QueryResult;
  groupBy?: string;
  cfg: Columns;
  /** Children fetched with loadChildren, by parent id. */
  loaded: ReadonlyMap<string, Row[]>;
  expanded: ReadonlySet<string>;
}

interface Section {
  id: string;
  label: string | null;
  color?: string;
  count: number;
  rows: Row[];
}

/**
 * The rows in drawing order. Sections follow the groups of the result (one section when not grouped).
 * A row whose parent is in the same section nests under it; children fetched with loadChildren nest under
 * their expanded parent. Top-level rows with no dates (and no dated subtasks) are collected in one
 * "Unscheduled" section at the end.
 */
export function buildItems({ result, groupBy, cfg, loaded, expanded }: BuildInput): GanttItem[] {
  const items: GanttItem[] = [];
  const unscheduled: Array<{ root: Row; color?: string; childrenOf: (id: string) => Row[] }> = [];

  const sections: Section[] =
    result.groups && groupBy
      ? result.groups.map((g) => ({
          id: g.key ?? '(none)',
          label: g.label,
          color: g.color,
          count: g.count,
          rows: result.rows.filter((r) => rowInGroup(r.values[groupBy], g.key)),
        }))
      : [{ id: 'all', label: null, count: result.rows.length, rows: result.rows }];

  for (const section of sections) {
    const ids = new Set(section.rows.map((r) => r.id));
    const kids = new Map<string, Row[]>();
    const roots: Row[] = [];
    for (const r of section.rows) {
      if (r.parentId && ids.has(r.parentId)) {
        const list = kids.get(r.parentId) ?? [];
        list.push(r);
        kids.set(r.parentId, list);
      } else roots.push(r);
    }
    const childrenOf = (id: string): Row[] => {
      const own = kids.get(id) ?? [];
      const extra = (loaded.get(id) ?? []).filter((c) => !own.some((o) => o.id === c.id));
      return [...own, ...extra];
    };
    const isScheduled = (row: Row, seen = new Set<string>()): boolean => {
      if (spanOf(row, cfg).kind !== 'none') return true;
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return childrenOf(row.id).some((c) => isScheduled(c, seen));
    };

    const shown: Row[] = [];
    for (const r of roots) {
      if (isScheduled(r)) shown.push(r);
      else unscheduled.push({ root: r, color: section.color, childrenOf });
    }
    if (shown.length === 0) continue;
    if (section.label !== null) {
      items.push({ kind: 'group', id: `group:${section.id}`, label: section.label, color: section.color, count: section.count });
    }
    for (const r of shown) pushRow(items, r, 0, section.color, childrenOf, expanded, false, new Set());
  }

  if (unscheduled.length) {
    items.push({ kind: 'unscheduled', id: 'unscheduled', count: unscheduled.length });
    for (const u of unscheduled) pushRow(items, u.root, 0, u.color, u.childrenOf, expanded, true, new Set());
  }
  return items;
}

function pushRow(
  items: GanttItem[],
  row: Row,
  depth: number,
  color: string | undefined,
  childrenOf: (id: string) => Row[],
  expanded: ReadonlySet<string>,
  unscheduled: boolean,
  seen: Set<string>,
): void {
  if (seen.has(row.id)) return;
  seen.add(row.id);
  const children = childrenOf(row.id);
  const open = expanded.has(row.id);
  items.push({
    kind: 'row',
    id: row.id,
    row,
    depth,
    expandable: (row.childCount ?? 0) > 0 || children.length > 0,
    expanded: open,
    ...(color ? { color } : {}),
    unscheduled,
  });
  if (open) for (const c of children) pushRow(items, c, depth + 1, color, childrenOf, expanded, unscheduled, seen);
}

// ---------------------------------------------------------------- windowing

/** The slice of rows to draw for a scroll position (with a few rows of margin). */
export function visibleRange(
  scrollTop: number,
  viewHeight: number,
  count: number,
  rowHeight = ROW_HEIGHT,
  overscan = 6,
): { from: number; to: number } {
  const from = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const to = Math.min(count, Math.ceil((scrollTop + viewHeight) / rowHeight) + overscan);
  return { from: Math.min(from, count), to: Math.max(Math.min(from, count), to) };
}
