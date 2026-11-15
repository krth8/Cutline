/**
 * Optimistic row mutations (PLAN.md LayoutProps.actions). Each one adds an Op (shown at once in
 * every active query), sends the request, then either folds the server's answer into the cached
 * results or removes the Op (rollback) and shows a toast. Either way the affected queries are
 * refetched afterwards, because filters, sorts and groups may now give another answer.
 */
import * as api from '../../api/tables';
import { getPlatform } from '../../platform';
import type { QueryResult, Row } from '../types';
import { applyOp, type Op } from './ops';
import { addOp, cachedRows, invalidate, pendingOps, settleOp, toError, type QueryEntry } from './registry';

let seq = 0;
let tempCounter = 0;

/** Creations in flight, by temporary row id, so an edit of a just-created row waits for its real id. */
const creating = new Map<string, Promise<Row>>();

/** Per row: the highest patch seq already folded in, to ignore older answers that arrive late. */
const appliedSeq = new Map<string, number>();

export function resetMutations(): void {
  creating.clear();
  appliedSeq.clear();
}

function fail(e: unknown): Error {
  const err = toError(e);
  getPlatform().toast('error', err.message);
  return err;
}

function mapRow(result: QueryResult, rowId: string, fn: (row: Row) => Row): QueryResult {
  if (!result.rows.some((r) => r.id === rowId)) return result;
  return { ...result, rows: result.rows.map((r) => (r.id === rowId ? fn(r) : r)) };
}

export async function updateRow(ref: string, id: string, values: Record<string, unknown>): Promise<void> {
  const pendingCreate = creating.get(id);
  if (pendingCreate) {
    try {
      id = (await pendingCreate).id;
    } catch {
      return; // the creation failed and was reported; there is nothing to edit
    }
  }
  const op: Op = { kind: 'patch', seq: ++seq, rowId: id, values: { ...values } };
  addOp(op);
  try {
    const row = await api.updateRow(ref, id, values);
    // Wholesale replacement only when nothing else is pending for the row and this answer is
    // the newest applied; otherwise take just the keys this request set, so answers that
    // return out of order never undo a field set by a later request.
    const others = pendingOpsFor(id, op);
    const wholesale = !others && op.seq > (appliedSeq.get(id) ?? 0);
    if (wholesale) appliedSeq.delete(id);
    else appliedSeq.set(id, Math.max(op.seq, appliedSeq.get(id) ?? 0));
    settleOp(op, (q: QueryEntry) =>
      q.base
        ? mapRow(q.base, id, (r) =>
            wholesale
              ? row
              : { ...r, values: { ...r.values, ...Object.fromEntries(Object.keys(values).map((k) => [k, row.values[k]])) } },
          )
        : null,
    );
    invalidate([ref, row.tableRef]);
  } catch (e) {
    settleOp(op);
    fail(e);
    invalidate([ref]);
  }
}

function pendingOpsFor(rowId: string, except: Op): boolean {
  return pendingOps.some((o) => o !== except && o.kind === 'patch' && o.rowId === rowId);
}

/** Projects a row can be created in through tasks:* (the user can edit tasks there). */
export function projectsForCreate(): Array<{ id: string; name: string }> {
  return getPlatform()
    .projects()
    .filter((p) => p.canTasks)
    .map((p) => ({ id: p.id, name: p.name }));
}

export async function createRow(
  ref: string,
  values: Record<string, unknown>,
  opts: { parentId?: string; projectId?: string } = {},
): Promise<Row> {
  if (ref === 'tasks:*' && !opts.projectId) {
    throw fail(new Error('Choose a project for the new row'));
  }
  const temp: Row = {
    id: `tmp:${++tempCounter}`,
    tableRef: opts.projectId ? `tasks:${opts.projectId}` : ref,
    parentId: opts.parentId ?? null,
    childCount: 0,
    values: { ...values },
    canEdit: true,
  };
  const op: Op = { kind: 'create', seq: ++seq, ref, row: temp };
  const request = api.createRow(ref, {
    values,
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
  });
  creating.set(temp.id, request);
  addOp(op);
  try {
    const row = await request;
    // Queries that showed the temporary row get the real one at the same place
    settleOp(op, (q) => (q.base ? applyOp(q.base, { ...op, row }, q.query, q.table.ref) : null));
    invalidate([ref, row.tableRef]);
    return row;
  } catch (e) {
    settleOp(op);
    invalidate([ref]);
    throw fail(e);
  } finally {
    creating.delete(temp.id);
  }
}

/** How long the "Deleted N tasks" toast offers Undo. */
export const UNDO_TOAST_MS = 8000;

/** Only the tasks tables have a trash so far (custom tables adopt it by being added here). */
function hasTrash(ref: string): boolean {
  return ref.startsWith('tasks:');
}

function deletedMessage(ref: string, count: number): string {
  const noun = ref.startsWith('tasks:') ? 'task' : 'row';
  return `Deleted ${count} ${noun}${count === 1 ? '' : 's'}`;
}

export async function deleteRows(ref: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const removed = cachedRows(ids); // kept so an undo can show the rows again at once
  const op: Op = { kind: 'delete', seq: ++seq, ids: [...ids] };
  addOp(op);
  const outcomes = await Promise.allSettled(ids.map((id) => api.deleteRow(ref, id)));
  const done = ids.filter((_, i) => outcomes[i]!.status === 'fulfilled');
  const failed = outcomes.find((o): o is PromiseRejectedResult => o.status === 'rejected');
  // Rows that were deleted leave the cached results; rows that were not come back
  const gone: Op = { kind: 'delete', seq: op.seq, ids: done };
  settleOp(op, (q) => (q.base && done.length ? applyOp(q.base, gone, q.query, q.table.ref) : q.base));
  if (failed) fail(failed.reason);
  if (done.length && hasTrash(ref)) {
    const rows = removed.filter((r) => done.includes(r.id));
    getPlatform().toast('success', deletedMessage(ref, done.length), {
      actionLabel: 'Undo',
      durationMs: UNDO_TOAST_MS,
      onAction: () => void restoreRows(ref, done, rows),
    });
  }
  invalidate([ref]);
}

/**
 * Bring deleted rows back from the trash. `rows` (what the views showed before the delete) are put back
 * at once; the queries are refetched afterwards, which puts them where the server says they belong.
 */
export async function restoreRows(ref: string, ids: string[], rows: Row[] = []): Promise<void> {
  const ops: Op[] = rows.map((row) => ({ kind: 'create', seq: ++seq, ref, row }));
  for (const op of ops) addOp(op);
  try {
    const restored = await api.restoreRows(ref, ids);
    for (const op of ops) {
      settleOp(op, (q) => (q.base && op.kind === 'create' ? applyOp(q.base, op, q.query, q.table.ref) : q.base));
    }
    if (restored.length < ids.length) getPlatform().toast('error', 'Some tasks could not be restored');
  } catch (e) {
    for (const op of ops) settleOp(op);
    fail(e);
  }
  invalidate([ref]);
}

export async function reorder(ref: string, ids: string[], before?: string): Promise<void> {
  const op: Op = { kind: 'reorder', seq: ++seq, ids: [...ids], ...(before ? { before } : {}) };
  addOp(op);
  try {
    await api.reorderRows(ref, ids, before);
    settleOp(op, (q) => (q.base ? applyOp(q.base, op, q.query, q.table.ref) : null));
  } catch (e) {
    settleOp(op);
    fail(e);
  }
  invalidate([ref]);
}

/** Move a row under another parent (or to the top level). Not optimistic: queries are refetched when it is done. */
export async function moveRow(ref: string, id: string, parentId: string | null): Promise<void> {
  try {
    const row = await api.moveRow(ref, id, parentId);
    invalidate([ref, row.tableRef]);
  } catch (e) {
    invalidate([ref]);
    throw fail(e);
  }
}
