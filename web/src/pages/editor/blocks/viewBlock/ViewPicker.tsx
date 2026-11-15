import { useEffect, useState } from 'react';
import { Button, Dialog } from '../../../../ui';
import { listViews, type ViewSummary } from './viewApi';

/** A dialog listing the views the user can open; choosing one shows it in the block. */
export function ViewPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose(): void;
  onPick(view: ViewSummary): void;
}) {
  const [views, setViews] = useState<ViewSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setViews(null);
    setFailed(false);
    setSearch('');
    listViews().then(
      (v) => !cancelled && setViews(v),
      () => !cancelled && setFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  const shown = (views ?? []).filter((v) => v.name.toLowerCase().includes(search.trim().toLowerCase()));

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
                  {v.layout} · {v.tableRef === 'tasks:*' ? 'all my projects' : 'project tasks'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
