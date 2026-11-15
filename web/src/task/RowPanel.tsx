import { ApiError } from '../api/http';
import { getPlatform } from '../platform';
import { closeCustomRow, useCustomRow } from '../router';
import { deleteRows, updateRow, useRow, useTableSchema } from '../tables/store';
import type { MenuItem } from '../ui';
import { PanelHeader, Title } from './PanelHeader';
import { PanelShell, PanelSkeleton, Unavailable } from './PanelShell';
import { Properties } from './Properties';
import './task.css';

const isGone = (e: Error | null) => e instanceof ApiError && (e.status === 403 || e.status === 404);

function RowContent({ tableRef, rowId }: { tableRef: string; rowId: string }) {
  const { row, error } = useRow(tableRef, rowId);
  const { schema } = useTableSchema(tableRef);

  if (isGone(error)) return <Unavailable message="This row is not available" onClose={closeCustomRow} />;
  if (!row || !schema) {
    if (error) return <Unavailable message="Could not load this row" onClose={closeCustomRow} />;
    return <PanelSkeleton label="Loading row" />;
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

  const projectId = schema.space?.type === 'project' ? schema.space.projectId : null;
  const projectName = projectId ? getPlatform().projects().find((p) => p.id === projectId)?.name : undefined;
  const menu: MenuItem[] = row.canEdit && schema.capabilities.delete ? [{ id: 'delete', label: 'Delete row', danger: true, onSelect: () => void remove() }] : [];

  return (
    <>
      <PanelHeader
        crumbs={
          <nav className="cl-task__trail" aria-label="Table">
            {projectName ? <span className="cl-task__crumb is-static">{projectName}</span> : null}
            <span className="cl-task__crumb is-static">{schema.name}</span>
          </nav>
        }
        title={<Title row={row} canEdit={row.canEdit} onSave={(name) => save({ [schema.titleColumn]: name })} label="Row name" />}
        menu={menu}
        closeLabel="Close row"
      />
      <div className="cl-task__scroll">
        <div className="cl-task__main">
          <Properties columns={schema.columns} row={row} onChange={(key, value) => save({ [key]: value })} />
        </div>
      </div>
    </>
  );
}

/**
 * The side panel of a row of a custom table: shown beside whatever route is open while the URL has
 * `?row=<tableRef>:<rowId>`. It has the task panel's frame, header and property list; a custom row has no
 * body, comments or subtasks.
 */
export function RowPanelHost() {
  const target = useCustomRow();
  if (!target || !getPlatform().user()) return null;
  return (
    <PanelShell label="Row" testId="row-panel" idAttr="data-row-id" rowId={target.id} onClose={closeCustomRow}>
      <RowContent key={`${target.ref}:${target.id}`} tableRef={target.ref} rowId={target.id} />
    </PanelShell>
  );
}
