// Pure board logic: columns from groups, what a drop changes, where a reordered card goes.
import type { Column, QueryResult, Row, TableSchema, View } from '../../types';
import { visibleColumns } from '../../viewColumns';

/** Column types a board can be split by (one lane per option). */
export const BOARD_TYPES: ReadonlySet<string> = new Set(['select', 'status', 'priority', 'person', 'multiselect', 'people']);
const MULTI_TYPES: ReadonlySet<string> = new Set(['multiselect', 'people']);

/** Collapsed-state key of the lane for rows without a value. */
export const NONE_KEY = '__none__';

export interface BoardLane {
  /** Group key (option value); null = rows without a value. */
  key: string | null;
  /** Stable id: the key, or NONE_KEY. */
  id: string;
  label: string;
  color?: string;
  count: number;
  summaries?: Record<string, number | null>;
  rows: Row[];
}

/** The `board` part of the view config, with the keys this layout stores in it. */
export interface BoardConfig {
  groupBy?: string;
  cardColumns: string[];
  /** Lane ids (NONE_KEY for the empty lane) that are folded away. */
  collapsed: string[];
}

export function readBoardConfig(config: View['config']): BoardConfig {
  const raw = (config.board ?? {}) as Partial<BoardConfig>;
  return {
    ...(raw.groupBy ? { groupBy: raw.groupBy } : {}),
    cardColumns: Array.isArray(raw.cardColumns) ? raw.cardColumns : [],
    collapsed: Array.isArray(raw.collapsed) ? raw.collapsed : [],
  };
}

/** The columns the board can split by. */
export function boardColumnsOf(schema: TableSchema): Column[] {
  return schema.columns.filter((c) => BOARD_TYPES.has(c.type));
}

/** The column a new board splits by: status if there is one, else the first suitable column. */
export function defaultGroupBy(schema: TableSchema): string | undefined {
  const usable = boardColumnsOf(schema);
  return (usable.find((c) => c.type === 'status') ?? usable[0])?.key;
}

export const isMulti = (column: Column): boolean => MULTI_TYPES.has(column.type);

function atomsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return value === null || value === undefined || value === '' ? [] : [String(value)];
}

export function inLane(value: unknown, key: string | null): boolean {
  const atoms = atomsOf(value);
  return key === null ? atoms.length === 0 : atoms.includes(key);
}

/**
 * The lanes of the board: one per group of the query result, plus a lane for every option of the column
 * that the server left out (so an empty option still shows). The lane without a value comes last.
 */
export function buildLanes(column: Column, result: QueryResult): BoardLane[] {
  const lanes: BoardLane[] = [];
  const seen = new Set<string | null>();
  const add = (key: string | null, label: string, color: string | undefined, count: number | undefined, summaries?: BoardLane['summaries']) => {
    seen.add(key);
    const rows = result.rows.filter((r) => inLane(r.values[column.key], key));
    lanes.push({
      key,
      id: key === null ? NONE_KEY : key,
      label,
      ...(color ? { color } : {}),
      count: count ?? rows.length,
      ...(summaries ? { summaries } : {}),
      rows,
    });
  };
  for (const g of result.groups ?? []) add(g.key, g.label, g.color, g.count, g.summaries);
  for (const o of column.options ?? []) {
    if (!seen.has(o.value)) add(o.value, o.label, o.color, undefined);
  }
  // The empty lane goes last whatever the server order was
  const none = lanes.findIndex((l) => l.key === null);
  if (none >= 0 && none !== lanes.length - 1) lanes.push(...lanes.splice(none, 1));
  return lanes;
}

/**
 * The values to patch when a card moves from one lane to another, or null when nothing changes.
 * Multi-value columns lose the source lane's value and gain the target's.
 */
export function dropPatch(column: Column, row: Row, from: string | null, to: string | null): Record<string, unknown> | null {
  if (from === to) return null;
  if (isMulti(column)) {
    const next = atomsOf(row.values[column.key]).filter((v) => v !== from);
    if (to !== null && !next.includes(to)) next.push(to);
    return { [column.key]: next };
  }
  return { [column.key]: to };
}

/** Where a card dropped in its own lane goes: the `reorder` arguments, or null when the order stays. */
export function reorderTarget(
  allRows: Row[],
  laneRows: Row[],
  draggedId: string,
  beforeId: string | null,
): { ids: string[]; before?: string } | null {
  const others = laneRows.filter((r) => r.id !== draggedId);
  const at = beforeId === null ? others.length : others.findIndex((r) => r.id === beforeId);
  if (at < 0) return null;
  const next = [...others.slice(0, at).map((r) => r.id), draggedId, ...others.slice(at).map((r) => r.id)];
  if (next.join('\n') === laneRows.map((r) => r.id).join('\n')) return null;
  if (beforeId !== null) return { ids: [draggedId], before: beforeId };
  // End of the lane: before the row that follows the lane's last card in the result, or the very end
  const last = others[others.length - 1];
  const rest = allRows.filter((r) => r.id !== draggedId);
  const following = last ? rest[rest.indexOf(last) + 1] : undefined;
  return following ? { ids: [draggedId], before: following.id } : { ids: [draggedId] };
}

/** Columns shown on a card: the chosen ones, else the view's visible columns; never the title or lane column. */
export function cardColumnsOf(schema: TableSchema, config: View['config'], groupBy: string | undefined): Column[] {
  const board = readBoardConfig(config);
  const skip = new Set([schema.titleColumn, groupBy]);
  const byKey = new Map(schema.columns.map((c) => [c.key, c]));
  const chosen = board.cardColumns.map((k) => byKey.get(k)).filter((c): c is Column => !!c && !skip.has(c.key));
  if (board.cardColumns.length) return chosen;
  return visibleColumns(schema, config).filter((c) => !skip.has(c.key));
}

export function toggleIn(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** The new lane value typed into quick add: the lane's key as the column stores it. */
export function quickAddValues(column: Column, titleColumn: string, title: string, key: string | null): Record<string, unknown> {
  const values: Record<string, unknown> = { [titleColumn]: title };
  if (key !== null) values[column.key] = isMulti(column) ? [key] : key;
  return values;
}
