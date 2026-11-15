/**
 * Grid logic of the table layout without any React: the virtual window, the flat list of display
 * items (groups, rows, subtasks), selection, keyboard movement, drag-to-reorder positions, column
 * widths and order. Kept pure so it can be tested on its own.
 */
import { orderedColumns, type ViewColumn } from '../../viewColumns';
import type { Column, QueryResult, Row, TableSchema, View } from '../../types';

export const ROW_HEIGHT = 34;
export const LEAD_WIDTH = 64;
export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 800;

// ---- virtual window ----

export interface VirtualWindow {
  /** First item to render. */
  start: number;
  /** One past the last item to render. */
  end: number;
  /** Distance of the first rendered item from the top of the body, in pixels. */
  offset: number;
  /** Height of the whole body, in pixels. */
  total: number;
}

/** Which items of `count` equally tall items to render for a scroll position and a viewport height. */
export function virtualWindow(count: number, rowHeight: number, scrollTop: number, viewport: number, overscan = 8): VirtualWindow {
  if (count <= 0) return { start: 0, end: 0, offset: 0, total: 0 };
  const first = Math.min(count - 1, Math.max(0, Math.floor(scrollTop / rowHeight)));
  const visible = Math.ceil(Math.max(0, viewport) / rowHeight) + 1;
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end, offset: start * rowHeight, total: count * rowHeight };
}

/** The scroll position that makes item `index` fully visible, changing `scrollTop` as little as possible. */
export function scrollTopFor(index: number, rowHeight: number, scrollTop: number, viewport: number): number {
  const top = index * rowHeight;
  if (top < scrollTop) return top;
  if (top + rowHeight > scrollTop + viewport) return Math.max(0, top + rowHeight - viewport);
  return scrollTop;
}

// ---- display items ----

export const NO_GROUP = '\u0000none';

export type GridItem =
  | {
      kind: 'group';
      id: string;
      groupId: string;
      label: string;
      color?: string;
      count: number;
      collapsed: boolean;
      summaries?: Record<string, number | null>;
    }
  | { kind: 'row'; id: string; row: Row; depth: number; caret: 'none' | 'closed' | 'open'; loading: boolean }
  | { kind: 'addChild'; id: string; parentId: string; tableRef: string; depth: number }
  | { kind: 'quickAdd'; id: string };

export interface BuildInput {
  rows: Row[];
  groups: QueryResult['groups'] | undefined;
  groupBy: string | undefined;
  collapsed: ReadonlySet<string>;
  /** Rows whose children are shown. */
  expanded: ReadonlySet<string>;
  /** Loaded children by parent id. */
  children: ReadonlyMap<string, Row[]>;
  /** Children are loaded on demand (the query returns roots only), so rows with children get a caret. */
  nested: boolean;
  /** Parents whose children are being loaded. */
  loadingChildren: ReadonlySet<string>;
  /** Show the "add a subtask" line under expanded parents. */
  canAddChildren: boolean;
  /** Show the quick-add line at the end. */
  quickAdd: boolean;
}

export function groupIdOf(key: string | null): string {
  return key === null ? NO_GROUP : key;
}

/** The text a group key is compared with: the atoms of a cell value as strings. */
function atomsOf(value: unknown): string[] {
  if (value === null || value === undefined || value === '') return [];
  // A relation cell holds {id, label} objects; groups are keyed by the linked row's id
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined).map((v) => (typeof v === 'object' ? String((v as { id?: unknown }).id) : String(v)));
  return [String(value)];
}

/** Rows by group, in group order. A multi-value row lists under the first of its groups (as the server orders them). */
export function partitionRows(rows: Row[], groups: NonNullable<QueryResult['groups']>, groupBy: string): Map<string, Row[]> {
  const position = new Map<string, number>();
  groups.forEach((g, i) => position.set(groupIdOf(g.key), i));
  const out = new Map<string, Row[]>(groups.map((g) => [groupIdOf(g.key), []]));
  const fallback = groups.some((g) => g.key === null) ? NO_GROUP : groupIdOf(groups[0]?.key ?? null);
  for (const row of rows) {
    const atoms = atomsOf(row.values[groupBy]);
    let best = -1;
    let bestId = fallback;
    if (atoms.length === 0) {
      if (position.has(NO_GROUP)) bestId = NO_GROUP;
    } else {
      for (const a of atoms) {
        const p = position.get(a);
        if (p !== undefined && (best === -1 || p < best)) {
          best = p;
          bestId = a;
        }
      }
    }
    out.get(bestId)?.push(row);
  }
  return out;
}

/** The flat list the grid draws: group headers, rows with their expanded children, add lines. */
export function buildItems(input: BuildInput): GridItem[] {
  const items: GridItem[] = [];

  const pushRow = (row: Row, depth: number) => {
    const known = input.children.get(row.id);
    const hasKids = (row.childCount ?? 0) > 0 || (known?.length ?? 0) > 0;
    const open = input.expanded.has(row.id);
    const caret = input.nested && (hasKids || open) ? (open ? 'open' : 'closed') : 'none';
    items.push({ kind: 'row', id: row.id, row, depth, caret, loading: input.loadingChildren.has(row.id) });
    if (input.nested && open) {
      for (const child of known ?? []) pushRow(child, depth + 1);
      if (input.canAddChildren) {
        items.push({ kind: 'addChild', id: `add:${row.id}`, parentId: row.id, tableRef: row.tableRef, depth: depth + 1 });
      }
    }
  };

  if (input.groups && input.groupBy) {
    const byGroup = partitionRows(input.rows, input.groups, input.groupBy);
    for (const g of input.groups) {
      const groupId = groupIdOf(g.key);
      const collapsed = input.collapsed.has(groupId);
      items.push({
        kind: 'group',
        id: `group:${groupId}`,
        groupId,
        label: g.label,
        ...(g.color ? { color: g.color } : {}),
        count: g.count,
        collapsed,
        ...(g.summaries ? { summaries: g.summaries } : {}),
      });
      if (!collapsed) for (const row of byGroup.get(groupId) ?? []) pushRow(row, 0);
    }
  } else {
    for (const row of input.rows) pushRow(row, 0);
  }
  if (input.quickAdd) items.push({ kind: 'quickAdd', id: 'quick-add' });
  return items;
}

/** Ids of the rows in display order (what keyboard movement and range selection walk through). */
export function rowOrder(items: readonly GridItem[]): string[] {
  const ids: string[] = [];
  for (const item of items) if (item.kind === 'row') ids.push(item.id);
  return ids;
}

// ---- selection ----

export interface Selection {
  ids: ReadonlySet<string>;
  /** The row a shift-click range starts from. */
  anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { ids: new Set(), anchor: null };

export function toggleSelection(sel: Selection, id: string): Selection {
  const ids = new Set(sel.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id };
}

/** Add every row between the anchor and `id` (inclusive). Without an anchor this selects just `id`. */
export function selectRange(sel: Selection, order: readonly string[], id: string): Selection {
  const to = order.indexOf(id);
  const from = sel.anchor === null ? -1 : order.indexOf(sel.anchor);
  if (to < 0) return sel;
  if (from < 0) return { ids: new Set([...sel.ids, id]), anchor: id };
  const [a, b] = from <= to ? [from, to] : [to, from];
  const ids = new Set(sel.ids);
  for (let i = a; i <= b; i++) ids.add(order[i]!);
  return { ids, anchor: sel.anchor };
}

export function selectAll(order: readonly string[]): Selection {
  return { ids: new Set(order), anchor: order[0] ?? null };
}

/** Drop ids that are no longer rows of the view. Returns the same object when nothing changed. */
export function pruneSelection(sel: Selection, existing: ReadonlySet<string>): Selection {
  let drop = false;
  for (const id of sel.ids) if (!existing.has(id)) drop = true;
  if (!drop) return sel;
  const ids = new Set([...sel.ids].filter((id) => existing.has(id)));
  return { ids, anchor: sel.anchor !== null && existing.has(sel.anchor) ? sel.anchor : null };
}

// ---- keyboard ----

export interface Cursor {
  rowId: string;
  col: number;
}

export type NavKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'PageUp' | 'PageDown';
export const NAV_KEYS: readonly string[] = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];

/** Where the cell cursor goes for a navigation key. Home/End go to the first/last column (with Ctrl: first/last row too). */
export function moveCursor(
  order: readonly string[],
  cursor: Cursor,
  key: NavKey,
  colCount: number,
  opts: { ctrl?: boolean; page?: number } = {},
): Cursor {
  if (order.length === 0 || colCount === 0) return cursor;
  const at = order.indexOf(cursor.rowId);
  if (at < 0) return { rowId: order[0]!, col: Math.min(Math.max(cursor.col, 0), colCount - 1) };
  const page = Math.max(1, opts.page ?? 10);
  const clampRow = (i: number) => Math.min(order.length - 1, Math.max(0, i));
  const clampCol = (c: number) => Math.min(colCount - 1, Math.max(0, c));
  let row = at;
  let col = cursor.col;
  switch (key) {
    case 'ArrowUp': row = clampRow(at - 1); break;
    case 'ArrowDown': row = clampRow(at + 1); break;
    case 'ArrowLeft': col = clampCol(col - 1); break;
    case 'ArrowRight': col = clampCol(col + 1); break;
    case 'PageUp': row = clampRow(at - page); break;
    case 'PageDown': row = clampRow(at + page); break;
    case 'Home': col = 0; if (opts.ctrl) row = 0; break;
    case 'End': col = colCount - 1; if (opts.ctrl) row = order.length - 1; break;
  }
  return { rowId: order[row]!, col };
}

// ---- reorder ----

export interface ReorderPlan {
  /** The rows to move, in display order. */
  ids: string[];
  /** Put them before this sibling; absent = at the end. */
  before?: string;
}

const sameParent = (a: Row, b: Row) => (a.parentId ?? null) === (b.parentId ?? null) && a.tableRef === b.tableRef;

/**
 * What to send to `reorder` when `dragIds` are dropped before/after `targetId`. `rows` are all rows in
 * display order. The API only orders siblings (same parent, same table), so anything else gives null,
 * as does a drop that would not change the order.
 */
export function reorderPlan(rows: readonly Row[], dragIds: readonly string[], targetId: string, side: 'before' | 'after'): ReorderPlan | null {
  const target = rows.find((r) => r.id === targetId);
  const drag = new Set(dragIds);
  const dragged = rows.filter((r) => drag.has(r.id));
  if (!target || dragged.length === 0 || drag.has(targetId)) return null;
  if (!dragged.every((r) => sameParent(r, target))) return null;
  const siblings = rows.filter((r) => sameParent(r, target));
  const rest = siblings.filter((r) => !drag.has(r.id));
  const at = rest.findIndex((r) => r.id === targetId);
  const insertAt = side === 'before' ? at : at + 1;
  const before = rest[insertAt];
  const next = [...rest.slice(0, insertAt), ...dragged, ...rest.slice(insertAt)].map((r) => r.id);
  if (next.join('\n') === siblings.map((r) => r.id).join('\n')) return null;
  return { ids: dragged.map((r) => r.id), ...(before ? { before: before.id } : {}) };
}

// ---- columns ----

export interface TableConfig {
  /** Column widths in pixels by column key. */
  widths?: Record<string, number>;
}

/** The table layout's part of the view config (`view.config.table`). */
export function readTableConfig(config: View['config']): TableConfig {
  const raw = (config as unknown as { table?: TableConfig }).table;
  return raw && typeof raw === 'object' ? raw : {};
}

export function tableConfigPatch(table: TableConfig): Partial<View['config']> {
  return { table } as unknown as Partial<View['config']>;
}

export function defaultWidth(column: Column, isTitle: boolean): number {
  if (isTitle) return 320;
  switch (column.type) {
    case 'checkbox': return 90;
    case 'number': return 110;
    case 'date': return 140;
    case 'longtext': return 260;
    case 'people': case 'multiselect': case 'url': case 'clip': return 180;
    default: return 160;
  }
}

export function clampWidth(width: number): number {
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));
}

export interface GridColumn {
  column: Column;
  width: number;
  isTitle: boolean;
}

/** The columns to draw: visible ones in view order, with their widths (layout config, then view column width, then a default). */
export function gridColumns(schema: TableSchema, config: View['config'], live: Record<string, number> = {}): GridColumn[] {
  const widths = readTableConfig(config).widths ?? {};
  return orderedColumns(schema, config)
    .filter((c) => !c.hidden)
    .map((c) => {
      const isTitle = c.column.key === schema.titleColumn;
      const w = live[c.column.key] ?? widths[c.column.key] ?? c.width ?? defaultWidth(c.column, isTitle);
      return { column: c.column, width: clampWidth(w), isTitle };
    });
}

export function gridTemplate(columns: readonly GridColumn[]): string {
  return [`${LEAD_WIDTH}px`, ...columns.map((c) => `${c.width}px`)].join(' ');
}

export function gridWidth(columns: readonly GridColumn[]): number {
  return LEAD_WIDTH + columns.reduce((sum, c) => sum + c.width, 0);
}

/** Move `key` before/after `target` in a list of column keys. */
export function moveColumn(keys: readonly string[], key: string, target: string, side: 'before' | 'after'): string[] {
  if (key === target) return [...keys];
  const rest = keys.filter((k) => k !== key);
  const at = rest.indexOf(target);
  if (at < 0 || !keys.includes(key)) return [...keys];
  rest.splice(side === 'before' ? at : at + 1, 0, key);
  return rest;
}

/** `config.columns` after moving a column: the full list in the new order, keeping widths and hidden flags. */
export function reorderedColumnConfig(
  all: readonly ViewColumn[],
  key: string,
  target: string,
  side: 'before' | 'after',
): NonNullable<View['config']['columns']> {
  const byKey = new Map(all.map((c) => [c.column.key, c]));
  return moveColumn(all.map((c) => c.column.key), key, target, side).map((k) => {
    const c = byKey.get(k)!;
    return { key: k, ...(c.width !== undefined ? { width: c.width } : {}), ...(c.hidden ? { hidden: true } : {}) };
  });
}

// ---- summaries ----

export const SUMMARY_LABELS: Record<string, string> = {
  count: 'Count',
  countEmpty: 'Empty',
  countFilled: 'Filled',
  sum: 'Sum',
  avg: 'Average',
  min: 'Min',
  max: 'Max',
  percentChecked: 'Checked',
};

/** Text of a summary value in a footer or group header ('' for no value). */
export function formatSummary(fn: string | undefined, value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  const label = fn ? SUMMARY_LABELS[fn] : undefined;
  const num = fn === 'percentChecked' ? `${Math.round(value)}%` : String(Math.round(value * 100) / 100);
  return label ? `${label} ${num}` : num;
}
