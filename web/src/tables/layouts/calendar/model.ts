import type { Column, Row, TableSchema, View } from '../../types';
import { addDays, diffDays, normalizeYmd, type Ymd } from './dates';

export type CalendarMode = 'month' | 'week';

export interface CalendarConfig {
  dateColumn: Column;
  /** Set only when the view names a second, different date column. */
  endColumn?: Column;
  mode: CalendarMode;
}

/** The date columns a calendar can be built on (read-only ones are shown but cannot be dragged). */
export function dateColumnsOf(schema: TableSchema): Column[] {
  return schema.columns.filter((c) => c.type === 'date');
}

/** The default date column: the first date column the user can edit, else the first date column. */
export function defaultDateColumn(schema: TableSchema): Column | undefined {
  const all = dateColumnsOf(schema);
  return all.find((c) => !c.readonly) ?? all[0];
}

/** Reads `view.config.calendar` against the schema; undefined when the table has no date column. */
export function readCalendarConfig(schema: TableSchema, config: View['config']): CalendarConfig | undefined {
  const saved = (config.calendar ?? {}) as { dateColumn?: string; endColumn?: string; mode?: string };
  const dates = dateColumnsOf(schema);
  const dateColumn = dates.find((c) => c.key === saved.dateColumn) ?? defaultDateColumn(schema);
  if (!dateColumn) return undefined;
  const endColumn = dates.find((c) => c.key === saved.endColumn && c.key !== dateColumn.key);
  return { dateColumn, ...(endColumn ? { endColumn } : {}), mode: saved.mode === 'week' ? 'week' : 'month' };
}

/** A row placed on the calendar: first and last day, both included. */
export interface CalendarItem {
  id: string;
  row: Row;
  start: Ymd;
  end: Ymd;
}

export interface Split {
  items: CalendarItem[];
  undated: Row[];
}

/** Rows with a start date become items (a missing end, or one before the start, means a single day); the rest are undated. */
export function splitRows(rows: Row[], cfg: Pick<CalendarConfig, 'dateColumn' | 'endColumn'>): Split {
  const items: CalendarItem[] = [];
  const undated: Row[] = [];
  for (const row of rows) {
    const start = normalizeYmd(row.values[cfg.dateColumn.key]);
    if (!start) {
      undated.push(row);
      continue;
    }
    const end = cfg.endColumn ? normalizeYmd(row.values[cfg.endColumn.key]) : null;
    items.push({ id: row.id, row, start, end: end && end > start ? end : start });
  }
  return { items, undated };
}

export interface Segment {
  item: CalendarItem;
  /** Column of the first and last day inside the week (0..6). */
  startCol: number;
  endCol: number;
  /** True when the item began before this week / goes on after it. */
  continuesBefore: boolean;
  continuesAfter: boolean;
  lane: number;
}

export interface WeekLayout {
  segments: Segment[];
  /** Number of lanes that are shown (at most `maxLanes`). */
  lanes: number;
  /** Per day of the week: items that did not fit in the visible lanes. */
  overflow: number[];
}

/**
 * Places the items that touch a week into lanes (rows of bars). Earlier and longer items come first so
 * spans keep a steady lane; items in a lane at or beyond `maxLanes` are left out of `segments` and
 * counted in `overflow` for each day they cover.
 */
export function layoutWeek(items: CalendarItem[], days: Ymd[], maxLanes: number): WeekLayout {
  const first = days[0]!;
  const last = days[days.length - 1]!;
  const touching = items.filter((i) => i.start <= last && i.end >= first);
  touching.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : diffDays(b.start, b.end) - diffDays(a.start, a.end)));
  const laneEnds: number[] = []; // last occupied column per lane
  const segments: Segment[] = [];
  const overflow = days.map(() => 0);
  for (const item of touching) {
    const startCol = item.start < first ? 0 : diffDays(first, item.start);
    const endCol = item.end > last ? days.length - 1 : diffDays(first, item.end);
    let lane = laneEnds.findIndex((e) => e < startCol);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = endCol;
    if (lane >= maxLanes) {
      for (let c = startCol; c <= endCol; c++) overflow[c]! += 1;
      continue;
    }
    segments.push({ item, startCol, endCol, continuesBefore: item.start < first, continuesAfter: item.end > last, lane });
  }
  return { segments, lanes: Math.min(laneEnds.length, maxLanes), overflow };
}

/** All items on a day, in start order (what the "+N more" popover lists). */
export function itemsOnDay(items: CalendarItem[], day: Ymd): CalendarItem[] {
  return items.filter((i) => i.start <= day && i.end >= day).sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

/** The item moved so that it starts on `start` (length kept). */
export function movedItem(item: CalendarItem, start: Ymd): CalendarItem {
  return { ...item, start, end: addDays(start, diffDays(item.start, item.end)) };
}

/** The item with its last day set to `end` (never before the start). */
export function resizedItem(item: CalendarItem, end: Ymd): CalendarItem {
  return { ...item, end: end < item.start ? item.start : end };
}

/**
 * Values to write for a changed item: the start column when it moved, and the end column (when the view
 * has one) when the end changed or the start moved on a row that has an end value.
 */
export function itemPatch(cfg: Pick<CalendarConfig, 'dateColumn' | 'endColumn'>, before: CalendarItem, after: CalendarItem): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (after.start !== before.start) patch[cfg.dateColumn.key] = after.start;
  if (cfg.endColumn) {
    const hadEnd = normalizeYmd(before.row.values[cfg.endColumn.key]) !== null;
    // A row without an end value stays without one unless it now spans more than its start day
    if (hadEnd ? after.end !== before.end : after.end !== after.start) patch[cfg.endColumn.key] = after.end;
  }
  return patch;
}

/** Values to write when an undated row is dropped on a day: the date, and an end that is not before it. */
export function schedulePatch(cfg: Pick<CalendarConfig, 'dateColumn' | 'endColumn'>, row: Row, day: Ymd): Record<string, unknown> {
  const patch: Record<string, unknown> = { [cfg.dateColumn.key]: day };
  if (cfg.endColumn) {
    const end = normalizeYmd(row.values[cfg.endColumn.key]);
    if (end && end < day) patch[cfg.endColumn.key] = day;
  }
  return patch;
}

/** Values for a row created by clicking a day. */
export function createValues(schema: TableSchema, cfg: Pick<CalendarConfig, 'dateColumn'>, title: string, day: Ymd): Record<string, unknown> {
  return { [schema.titleColumn]: title, [cfg.dateColumn.key]: day };
}

/** The colour of the row's status, when the schema has a status column with coloured options. */
export function itemColor(schema: TableSchema, row: Row): string | undefined {
  const col = schema.columns.find((c) => c.key === 'status' && c.type === 'status') ?? schema.columns.find((c) => c.type === 'status');
  if (!col) return undefined;
  const value = row.values[col.key];
  return col.options?.find((o) => o.value === value)?.color;
}
