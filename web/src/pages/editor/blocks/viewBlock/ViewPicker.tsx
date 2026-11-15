import { useEffect, useState } from 'react';
import { listTables, type CustomTable } from '../../../../api/tables';
import { Button, Dialog } from '../../../../ui';
import type { PageContext } from './model';
import { listViews, spaceOf, type ViewSummary } from './viewApi';

/**
 * A dialog listing the views the user can open; choosing one shows it in the block. With a page `context`
 * and `onPickTable` it also lists the custom tables of the page's space: choosing one starts a new view on it.
 */
export function ViewPicker({
  open,
  onClose,
  onPick,
  onPickTable,
  context,
  pinnedIds = [],
}: {
  open: boolean;
  onClose(): void;
  onPick(view: ViewSummary): void;
  onPickTable?(table: CustomTable): void;
  context?: PageContext | null;
  /** Views to list first, marked "on this page" (the view blocks of the page being edited). */
  pinnedIds?: string[];
}) {
  const [views, setViews] = useState<ViewSummary[] | null>(null);
  const [tables, setTables] = useState<CustomTable[]>([]);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setViews(null);
    setFailed(false);
    setSearch('');
    setTables([]);
    listViews().then(
      (v) => !cancelled && setViews(v),
      () => !cancelled && setFailed(true),
    );
    if (context && onPickTable) {
      // The tables are an extra: when they cannot be listed the views are still shown
      spaceOf(context)
        .then((space) => listTables(space))
        .then(
          (t) => !cancelled && setTables(t),
          () => undefined,
        );
    }
    return () => {
      cancelled = true;
    };
  }, [open, context, onPickTable]);

  const needle = search.trim().toLowerCase();
  const shownTables = tables.filter((t) => t.name.toLowerCase().includes(needle));
  const pinned = new Set(pinnedIds);
  const shown = (views ?? [])
    .filter((v) => v.name.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Pick a view"
      className="cl-viewpicker"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <input
        className="cl-viewpicker__search"
        type="search"
        placeholder="Search views"
        aria-label="Search views"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {shownTables.length > 0 && (
        <>
          <h4 className="cl-viewpicker__heading">Tables of this space</h4>
          <ul className="cl-viewpicker__list" data-testid="view-picker-tables">
            {shownTables.map((t) => (
              <li key={t.ref}>
                <button type="button" className="cl-viewpicker__item" data-table-ref={t.ref} onClick={() => onPickTable?.(t)}>
                  <span className="cl-viewpicker__name">{t.name}</span>
                  <span className="cl-viewpicker__meta">new view of this table</span>
                </button>
              </li>
            ))}
          </ul>
          <h4 className="cl-viewpicker__heading">Views</h4>
        </>
      )}
      {failed ? (
        <p className="cl-viewpicker__state">Could not load the views.</p>
      ) : !views ? (
        <p className="cl-viewpicker__state">Loading...</p>
      ) : shown.length === 0 ? (
        <p className="cl-viewpicker__state">{views.length ? 'No view matches.' : 'There are no views to pick yet.'}</p>
      ) : (
        <ul className="cl-viewpicker__list" data-testid="view-picker-list">
          {shown.map((v) => (
            <li key={v.id}>
              <button type="button" className="cl-viewpicker__item" data-view-id={v.id} onClick={() => onPick(v)}>
                <span className="cl-viewpicker__name">{v.name}</span>
                <span className="cl-viewpicker__meta">
                  {v.layout} · {v.tableRef === 'tasks:*' ? 'all my projects' : v.tableRef.startsWith('tbl_') ? 'table' : 'project tasks'}
                  {pinned.has(v.id) ? ' · on this page' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
