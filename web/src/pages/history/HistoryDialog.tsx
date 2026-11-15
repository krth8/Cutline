import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  createVersion,
  deleteVersion,
  getVersion,
  listVersions,
  renameVersion,
  restoreVersion,
  type PageVersion,
  type PageVersionWithState,
} from '../../api/history';
import { getPlatform } from '../../platform';
import { Button, cx, Dialog, Input } from '../../ui';
import { VersionPreview } from './VersionPreview';
import './history.css';

export interface HistoryDialogProps {
  pageId: string;
  /** Editors may save, name, delete and restore; readers only look. */
  canEdit: boolean;
  open: boolean;
  onClose: () => void;
  /** Called after a restore went through (the dialog closes itself too). */
  onRestored?: () => void;
}

const DAY_FORMAT: Intl.DateTimeFormatOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };

function dayLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, DAY_FORMAT);
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function title(v: PageVersion): string {
  if (v.name) return v.name;
  return v.kind === 'before_restore' ? 'Before restore' : 'Automatic';
}

/** Group versions (newest first) by calendar day, keeping their order. */
export function groupByDay(versions: PageVersion[]): Array<{ day: string; versions: PageVersion[] }> {
  const groups: Array<{ day: string; versions: PageVersion[] }> = [];
  for (const v of versions) {
    const day = dayLabel(v.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.versions.push(v);
    else groups.push({ day, versions: [v] });
  }
  return groups;
}

/** Page history: the versions grouped by day, a read-only preview of the selected one, and the actions. */
export function HistoryDialog({ pageId, canEdit, open, onClose, onRestored }: HistoryDialogProps) {
  const platform = getPlatform();
  const [versions, setVersions] = useState<PageVersion[] | null>(null);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PageVersionWithState | null>(null);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // An inline confirmation (a separate confirm overlay would open behind this dialog)
  const [confirming, setConfirming] = useState<'restore' | 'delete' | null>(null);

  const load = useCallback(async () => {
    try {
      setVersions(await listVersions(pageId));
      setError(false);
    } catch {
      setError(true);
    }
  }, [pageId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setConfirming(null);
    getVersion(pageId, selectedId).then(
      (v) => !cancelled && setDetail(v),
      () => !cancelled && platform.toast('error', 'Could not load that version'),
    );
    return () => {
      cancelled = true;
    };
  }, [pageId, selectedId, platform]);

  const groups = useMemo(() => groupByDay(versions ?? []), [versions]);
  const selected = versions?.find((v) => v.id === selectedId) ?? null;

  async function run(action: () => Promise<void>, failure: string) {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      platform.toast('error', e instanceof Error && e.message ? e.message : failure);
    } finally {
      setBusy(false);
    }
  }

  function saveNow(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    void run(async () => {
      const created = await createVersion(pageId, name);
      setNewName('');
      await load();
      setSelectedId(created.id);
      platform.toast('success', 'Version saved');
    }, 'Could not save the version');
  }

  function rename(v: PageVersion, name: string) {
    setRenaming(null);
    const clean = name.trim();
    if (!clean || clean === v.name) return;
    void run(async () => {
      await renameVersion(pageId, v.id, clean);
      await load();
    }, 'Could not rename the version');
  }

  function remove(v: PageVersion) {
    void run(async () => {
      setConfirming(null);
      await deleteVersion(pageId, v.id);
      setSelectedId(null);
      await load();
    }, 'Could not delete the version');
  }

  function restore(v: PageVersion) {
    void run(async () => {
      await restoreVersion(pageId, v.id);
      platform.toast('success', 'Version restored');
      onRestored?.();
      onClose();
    }, 'Could not restore the version');
  }

  return (
    <Dialog open={open} onClose={onClose} title="Page history" className="cl-history">
      {canEdit ? (
        <form className="cl-history__save" onSubmit={saveNow}>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name for the new version"
            aria-label="Version name"
            maxLength={120}
          />
          <Button type="submit" variant="primary" disabled={busy || !newName.trim()}>
            Save version now
          </Button>
        </form>
      ) : null}
      <div className="cl-history__layout">
        <nav className="cl-history__list" aria-label="Versions">
          {error ? <p className="cl-history__message">The history could not be loaded.</p> : null}
          {!error && versions === null ? <p className="cl-history__message">Loading...</p> : null}
          {versions && versions.length === 0 ? <p className="cl-history__message">No versions yet.</p> : null}
          {groups.map((group) => (
            <section key={group.day} className="cl-history__day">
              <h3 className="cl-history__dayhead">{group.day}</h3>
              <ul>
                {group.versions.map((v) => (
                  <li key={v.id}>
                    <button
                      type="button"
                      className={cx('cl-history__item', v.id === selectedId && 'is-selected')}
                      aria-pressed={v.id === selectedId}
                      onClick={() => setSelectedId(v.id)}
                    >
                      <span className="cl-history__time">{timeLabel(v.createdAt)}</span>
                      <span className={cx('cl-history__name', !v.name && 'is-muted')}>{title(v)}</span>
                      <span className="cl-history__editors">{v.editors.map((p) => p.name).join(', ')}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </nav>
        <div className="cl-history__view">
          {selected ? (
            <>
              <div className="cl-history__actions">
                <strong className="cl-history__selected">{title(selected)}</strong>
                {canEdit && confirming ? (
                  <>
                    <span role="alert" className="cl-history__confirm">
                      {confirming === 'restore'
                        ? 'Replace the page with this version? The current content is kept as a version, so you can undo this.'
                        : `Delete the version "${selected.name}"?`}
                    </span>
                    <Button size="sm" onClick={() => setConfirming(null)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant={confirming === 'delete' ? 'danger' : 'primary'}
                      disabled={busy}
                      onClick={() => (confirming === 'restore' ? restore(selected) : remove(selected))}
                    >
                      {confirming === 'restore' ? 'Restore' : 'Delete'}
                    </Button>
                  </>
                ) : canEdit ? (
                  <>
                    {renaming === selected.id ? (
                      <Input
                        autoFocus
                        defaultValue={selected.name ?? ''}
                        aria-label="New name"
                        maxLength={120}
                        onCommit={(value) => rename(selected, value)}
                        onCancel={() => setRenaming(null)}
                        onBlur={() => setRenaming(null)}
                      />
                    ) : (
                      <Button size="sm" disabled={busy} onClick={() => setRenaming(selected.id)}>
                        {selected.name ? 'Rename' : 'Name this version'}
                      </Button>
                    )}
                    {selected.name ? (
                      <Button size="sm" variant="danger" disabled={busy} onClick={() => setConfirming('delete')}>
                        Delete
                      </Button>
                    ) : null}
                    <Button size="sm" variant="primary" disabled={busy || !detail} onClick={() => setConfirming('restore')}>
                      Restore this version
                    </Button>
                  </>
                ) : null}
              </div>
              {detail && detail.id === selected.id ? (
                <VersionPreview state={detail.state} />
              ) : (
                <p className="cl-history__message">Loading...</p>
              )}
            </>
          ) : (
            <p className="cl-history__message">Select a version to see it.</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
