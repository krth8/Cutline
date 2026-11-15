import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../../api/tables';
import { getPlatform } from '../../platform';
import { Button, Dialog } from '../../ui';
import { invalidate } from '../store/registry';
import './trash.css';

/** Tasks stay in the trash this many days before the server deletes them for good. */
export const TRASH_DAYS = 30;

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function noun(count: number): string {
  return `${count} task${count === 1 ? '' : 's'}`;
}

function describe(item: api.TrashItem, showProject: boolean): string {
  const parts = [`Deleted ${when(item.deletedAt)}${item.deletedByName ? ` by ${item.deletedByName}` : ''}`];
  if (item.parentName) parts.push(`subtask of ${item.parentName}`);
  if (item.subtaskCount > 0) parts.push(`${item.subtaskCount} subtask${item.subtaskCount === 1 ? '' : 's'}`);
  if (showProject && item.projectName) parts.push(item.projectName);
  return parts.join(' · ');
}

/** Whether the user may empty the trash of this table: the owner of its project, or an admin. */
export function canEmptyTrash(ref: string): boolean {
  const platform = getPlatform();
  if (!ref.startsWith('tasks:') || ref === 'tasks:*') return false;
  if (platform.user()?.role === 'admin') return true;
  return platform.projects().some((p) => `tasks:${p.id}` === ref && p.isOwner);
}

/**
 * The deleted rows of a table: restore (one or a selection), delete forever, and empty the trash.
 * Looks like the archived pages dialog. Rows are deleted for good after TRASH_DAYS days.
 */
export function TrashDialog({ tableRef, open, onClose }: { tableRef: string; open: boolean; onClose: () => void }) {
  const [items, setItems] = useState<api.TrashItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const showProject = tableRef === 'tasks:*';

  const load = useCallback(async () => {
    try {
      setItems(await api.listTrash(tableRef));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the trash');
    }
  }, [tableRef]);

  useEffect(() => {
    if (!open) return;
    setItems(null);
    setSelected(new Set());
    void load();
  }, [open, load]);

  const ids = useMemo(() => new Set((items ?? []).map((i) => i.id)), [items]);
  const chosen = [...selected].filter((id) => ids.has(id));

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      getPlatform().toast('error', e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
      setSelected(new Set());
      await load();
      invalidate([tableRef]);
    }
  }

  const restore = (rowIds: string[]) =>
    run(async () => {
      const restored = await api.restoreRows(tableRef, rowIds);
      getPlatform().toast('success', `Restored ${noun(restored.length)}`);
    });

  const deleteForever = (item: api.TrashItem) =>
    run(async () => {
      const ok = await getPlatform().confirm(`Delete "${item.name}" forever? This cannot be undone.`, {
        danger: true,
        confirmLabel: 'Delete forever',
      });
      if (ok) await api.purgeRow(tableRef, item.id);
    });

  const empty = () =>
    run(async () => {
      const ok = await getPlatform().confirm('Empty the trash? Every task in it is deleted forever. This cannot be undone.', {
        danger: true,
        confirmLabel: 'Empty trash',
      });
      if (ok) await api.emptyTrash(tableRef);
    });

  const footer = (
    <>
      {canEmptyTrash(tableRef) && items && items.length > 0 ? (
        <Button variant="danger" disabled={busy} onClick={() => void empty()}>
          Empty trash
        </Button>
      ) : null}
      <Button disabled={busy || chosen.length === 0} onClick={() => void restore(chosen)}>
        {chosen.length > 0 ? `Restore selected (${chosen.length})` : 'Restore selected'}
      </Button>
      <Button onClick={onClose}>Close</Button>
    </>
  );

  return (
    <Dialog open={open} onClose={onClose} title="Trash" footer={footer}>
      {error ? (
        <p className="cl-trash__empty" role="alert">
          {error}
        </p>
      ) : items === null ? (
        <p className="cl-trash__empty">Loading...</p>
      ) : items.length === 0 ? (
        <p className="cl-trash__empty">The trash is empty.</p>
      ) : (
        <>
          <p className="cl-trash__hint">Deleted tasks are kept for {TRASH_DAYS} days.</p>
          <ul className="cl-trash" aria-label="Deleted tasks">
            {items.map((item) => (
              <li key={item.id} className="cl-trash__row" data-row-id={item.id}>
                <input
                  type="checkbox"
                  aria-label={`Select ${item.name}`}
                  checked={selected.has(item.id)}
                  onChange={() => toggle(item.id)}
                />
                <span className="cl-trash__text">
                  <span className="cl-trash__title">{item.name}</span>
                  <span className="cl-trash__meta">{describe(item, showProject)}</span>
                </span>
                <span className="cl-trash__actions">
                  <Button size="sm" disabled={busy} onClick={() => void restore([item.id])} aria-label={`Restore ${item.name}`}>
                    Restore
                  </Button>
                  <Button size="sm" variant="danger" disabled={busy} onClick={() => void deleteForever(item)} aria-label={`Delete ${item.name} forever`}>
                    Delete forever
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
