/**
 * Optimistic changes. A change is an Op kept in one list shared by every query of every table;
 * what a query shows is its last server result with all pending ops applied on top. Rolling a
 * change back is therefore just removing its op: later ops on the same row stay in place.
 */
import type { Query, QueryResult, Row } from '../types';

export type Op =
  | { kind: 'patch'; seq: number; rowId: string; values: Record<string, unknown> }
  | { kind: 'delete'; seq: number; ids: string[] }
  | { kind: 'create'; seq: number; ref: string; row: Row }
  | { kind: 'reorder'; seq: number; ids: string[]; before?: string };

/** A created row is shown at the end only where that cannot be wrong: no filter, group, search or paging. */
export function canInsertRow(query: Query, row: Row): boolean {
  if (query.filter || query.groupBy || query.search || query.limit != null || query.offset != null) return false;
  if (query.parentId === undefined) return true;
  return (row.parentId ?? null) === query.parentId;
}

export function moveRows(rows: Row[], ids: string[], before?: string): Row[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const moved = ids.map((id) => byId.get(id));
  if (moved.some((r) => !r)) return rows;
  if (before !== undefined && !byId.has(before)) return rows;
  const movedSet = new Set(ids);
  if (before !== undefined && movedSet.has(before)) return rows;
  const rest = rows.filter((r) => !movedSet.has(r.id));
  const at = before === undefined ? rest.length : rest.findIndex((r) => r.id === before);
  return [...rest.slice(0, at), ...(moved as Row[]), ...rest.slice(at)];
}

/** Apply one op to a result. Returns the same object when the op changes nothing there. */
export function applyOp(result: QueryResult, op: Op, query: Query, ref: string): QueryResult {
  switch (op.kind) {
    case 'patch': {
      if (!result.rows.some((r) => r.id === op.rowId)) return result;
      return {
        ...result,
        rows: result.rows.map((r) => (r.id === op.rowId ? { ...r, values: { ...r.values, ...op.values } } : r)),
      };
    }
    case 'delete': {
      const gone = new Set(op.ids);
      const rows = result.rows.filter((r) => !gone.has(r.id));
      if (rows.length === result.rows.length) return result;
      return { ...result, rows, total: Math.max(0, result.total - (result.rows.length - rows.length)) };
    }
    case 'create': {
      if (op.ref !== ref || !canInsertRow(query, op.row)) return result;
      return { ...result, rows: [...result.rows, op.row], total: result.total + 1 };
    }
    case 'reorder': {
      const rows = moveRows(result.rows, op.ids, op.before);
      return rows === result.rows ? result : { ...result, rows };
    }
  }
}
