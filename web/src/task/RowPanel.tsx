import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../api/http';
import { getPlatform } from '../platform';
import { closeCustomRow, useCustomRow } from '../router';
import { deleteRows, updateRow, useRow, useTableSchema } from '../tables/store';
import { useEscape } from '../ui/hooks';
import { Properties } from './Properties';
import { Title, Unavailable } from './TaskPanel';
import './task.css';
import './rowPanel.css';

const isGone = (e: Error | null) => e instanceof ApiError && (e.status === 403 || e.status === 404);

function RowContent({ tableRef, rowId }: { tableRef: string; rowId: string }) {
  const { row, loading, error } = useRow(tableRef, rowId);
  const { schema } = useTableSchema(tableRef);

  if (isGone(error)) return <Unavailable message="This row is not available" onClose={closeCustomRow} />;
  if (!row || !schema) {
    if (error) return <Unavailable message="Could not load this row" onClose={closeCustomRow} />;
    return <div className="cl-task__state">{loading || !schema ? 'Loading...' : null}</div>;
  }

  const save = (values: Record<string, unknown>) => {
    updateRow(tableRef, row.id, values).catch(() => {
      /* the store has rolled the change back and shown the error */
    });
  };

  async function remove() {
    const ok = await getPlatform().confirm('Are you sure you want to delete this row? This cannot be undone.', {
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    closeCustomRow();
    await deleteRows(tableRef, [rowId]);
  }

  return (
    <>
      <header className="cl-task__header">
        <div className="cl-task__titlerow">
          <Title row={row} canEdit={row.canEdit} onSave={(name) => save({ [schema.titleColumn]: name })} label="Row name" />
          {row.canEdit && schema.capabilities.delete ? (
            <button type="button" className="cl-task__iconbtn cl-task__danger" aria-label="Delete row" title="Delete row" onClick={() => void remove()}>
              &#128465;
            </button>
          ) : null}
          <button type="button" className="cl-task__iconbtn" aria-label="Close row" title="Close (Esc)" onClick={closeCustomRow}>
            &times;
          </button>
        </div>
        <p className="cl-rowpanel__table">{schema.name}</p>
      </header>
      <div className="cl-task__scroll">
        <div className="cl-task__main">
          <Properties columns={schema.columns} row={row} onChange={(key, value) => save({ [key]: value })} />
        </div>
      </div>
    </>
  );
}

function Panel({ tableRef, rowId }: { tableRef: string; rowId: string }) {
  const swallowEscape = useRef(false);

  // Escape closes the panel, unless it was meant for a field: that first Escape only leaves the field
  useEscape(true, () => {
    if (swallowEscape.current) {
      swallowEscape.current = false;
      const active = document.activeElement as HTMLElement | null;
      if (active && active.matches('input, textarea, select, [contenteditable]')) active.blur();
      return;
    }
    closeCustomRow();
  });

  return createPortal(
    <>
      <div className="cl-task__scrim" data-testid="row-scrim" onMouseDown={closeCustomRow} />
      <aside
        className="cl-task cl-rowpanel"
        role="dialog"
        aria-label="Row"
        aria-modal="false"
        data-testid="row-panel"
        data-row-id={rowId}
        onKeyDownCapture={(e) => {
          if (e.key !== 'Escape') return;
          const target = e.target as HTMLElement;
          swallowEscape.current = !!target.closest('.is-editing, input, textarea, select, [contenteditable]');
          setTimeout(() => (swallowEscape.current = false), 0);
        }}
      >
        <RowContent key={`${tableRef}:${rowId}`} tableRef={tableRef} rowId={rowId} />
      </aside>
    </>,
    document.body,
  );
}

/**
 * The side panel of a row of a custom table: shown over whatever route is open while the URL has
 * `?row=<tableRef>:<rowId>`. It shows the title and every column as a property; a custom row has no
 * body, comments or subtasks.
 */
export function RowPanelHost() {
  const target = useCustomRow();
  if (!target || !getPlatform().user()) return null;
  return <Panel tableRef={target.ref} rowId={target.id} />;
}
