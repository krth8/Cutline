import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../api/http';
import * as tablesApi from '../api/tables';
import { HistoryDialog } from '../pages/history';
import { CollabEditor, SyncStatus, type PageStatus } from '../pages/sync';
import { Backlinks } from '../pages/backlinks';
import { getPlatform } from '../platform';
import { closeTask, openTask, useTaskId } from '../router';
import { doneModel } from '../tables/layouts/list/listHelpers';
import { deleteRows, updateRow, useRow, useTableSchema } from '../tables/store';
import type { MenuItem } from '../ui';
import { Checklist } from './Checklist';
import { Clips } from './Clips';
import { Activity, Composer, useComments } from './Comments';
import { DoneToggle, PanelHeader, Title } from './PanelHeader';
import { PanelShell, PanelSkeleton, Unavailable } from './PanelShell';
import { Properties } from './Properties';
import { Subtasks } from './Subtasks';
import { getTaskPage } from './api';
import './task.css';

// Shared with the row panel
export { Title, Unavailable };

const isGone = (e: Error | null) => e instanceof ApiError && (e.status === 403 || e.status === 404);

/** Which table a task lives in (`tasks:<projectId>`), found through `tasks:*` because the URL only has the id. */
type Located = { id: string; state: 'loading' } | { id: string; state: 'ready'; ref: string } | { id: string; state: 'gone' } | { id: string; state: 'failed' };

function useLocate(taskId: string): { located: Located; retry: () => void } {
  const [located, setLocated] = useState<Located>({ id: taskId, state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLocated({ id: taskId, state: 'loading' });
    tablesApi.getRow('tasks:*', taskId).then(
      (row) => !cancelled && setLocated({ id: taskId, state: 'ready', ref: row.tableRef }),
      (e: unknown) => !cancelled && setLocated({ id: taskId, state: isGone(e instanceof Error ? e : null) ? 'gone' : 'failed' }),
    );
    return () => {
      cancelled = true;
    };
  }, [taskId, attempt]);
  // The result of the previous id is never shown for the new one
  const current: Located = located.id === taskId ? located : { id: taskId, state: 'loading' };
  return { located: current, retry: () => setAttempt((n) => n + 1) };
}

type PageState = { id: string; for: string } | 'failed' | null;

/** The task page (created on first use); the old description is imported by the editor. */
function useTaskPage(taskId: string): PageState {
  const [page, setPage] = useState<PageState>(null);
  useEffect(() => {
    let cancelled = false;
    setPage(null);
    getTaskPage(taskId).then(
      (p) => !cancelled && setPage({ id: p.id, for: taskId }),
      () => !cancelled && setPage('failed'),
    );
    return () => {
      cancelled = true;
    };
  }, [taskId]);
  return page;
}

/** The description: the task page in the collaborative editor, directly under the properties. */
function Body({ taskId, page, canEdit, onStatus }: { taskId: string; page: PageState; canEdit: boolean; onStatus: (s: PageStatus) => void }) {
  return (
    <section className="cl-task__body" aria-label="Description" data-testid="task-body">
      {page === 'failed' ? (
        <p className="cl-task__empty">The description could not be loaded.</p>
      ) : page && page.for === taskId ? (
        <CollabEditor key={page.id} pageId={page.id} readOnly={!canEdit} showStatus={false} onStatusChange={onStatus} placeholder="Add a description, or type / for blocks" />
      ) : (
        <div className="cl-skel cl-skel--line" aria-busy="true" />
      )}
    </section>
  );
}

/** The parents of a subtask, outermost first, each a link that opens that task. */
function Ancestors({ tableRef, parentId, depth = 0 }: { tableRef: string; parentId: string; depth?: number }) {
  const { row } = useRow(tableRef, parentId);
  if (!row) return null;
  return (
    <>
      {row.parentId && depth < 5 ? <Ancestors tableRef={tableRef} parentId={row.parentId} depth={depth + 1} /> : null}
      <button type="button" className="cl-task__crumb" onClick={() => openTask(row.id)} title={String(row.values.name ?? '')}>
        {String(row.values.name ?? 'Untitled')}
      </button>
    </>
  );
}

/** The trail above the title: the project, then the parent tasks. */
function Crumbs({ tableRef, parentId, projectName }: { tableRef: string; parentId: string | null | undefined; projectName: string | undefined }) {
  return (
    <nav className="cl-task__trail" aria-label="Parent tasks">
      {projectName ? <span className="cl-task__crumb is-static">{projectName}</span> : null}
      {parentId ? <Ancestors tableRef={tableRef} parentId={parentId} /> : null}
    </nav>
  );
}

function TaskContent({ taskId, tableRef }: { taskId: string; tableRef: string }) {
  const platform = getPlatform();
  const { row, error } = useRow(tableRef, taskId);
  const { schema } = useTableSchema(tableRef);
  const page = useTaskPage(taskId);
  const comments = useComments(taskId);
  const [status, setStatus] = useState<PageStatus | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const projectId = tableRef.replace(/^tasks:/, '');
  const projectName = platform.projects().find((p) => p.id === projectId)?.name;
  const done = useMemo(() => {
    const model = schema ? doneModel(schema) : undefined;
    return model && model.column.type === 'status' ? model : undefined;
  }, [schema]);

  if (isGone(error)) return <Unavailable message="This task is not available" onClose={closeTask} />;
  if (!row || !schema) {
    if (error) return <Unavailable message="Could not load this task" onClose={closeTask} />;
    return <PanelSkeleton label="Loading task" />;
  }

  const save = (values: Record<string, unknown>) => {
    updateRow(tableRef, row.id, values).catch(() => {
      /* the store has rolled the change back and shown the error */
    });
  };

  async function remove() {
    const ok = await platform.confirm('Delete this task and its subtasks? They go to the Trash and can be restored.', {
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    closeTask();
    await deleteRows(tableRef, [taskId]);
  }

  const pageReady = page && page !== 'failed' && page.for === taskId ? page : null;
  const menu: MenuItem[] = [
    { id: 'history', label: 'History', disabled: !pageReady, onSelect: () => setHistoryOpen(true) },
    ...(row.canEdit && schema.capabilities.delete
      ? ([{ type: 'separator' }, { id: 'delete', label: 'Delete task', danger: true, onSelect: () => void remove() }] as MenuItem[])
      : []),
  ];

  return (
    <>
      <PanelHeader
        crumbs={<Crumbs tableRef={tableRef} parentId={row.parentId} projectName={projectName} />}
        done={done ? <DoneToggle model={done} row={row} onChange={(key, value) => save({ [key]: value })} /> : null}
        title={<Title row={row} canEdit={row.canEdit} onSave={(name) => save({ name })} />}
        status={pageReady && status ? <SyncStatus status={status} /> : null}
        menu={menu}
        closeLabel="Close task"
      />
      <div className="cl-task__scroll">
        <div className="cl-task__main">
          <Properties columns={schema.columns} row={row} onChange={(key, value) => save({ [key]: value })} />
          <Body taskId={taskId} page={page} canEdit={row.canEdit} onStatus={setStatus} />
          <Subtasks tableRef={tableRef} taskId={taskId} count={row.childCount ?? 0} canAdd={row.canEdit && schema.capabilities.create} />
          <Checklist taskId={taskId} canEdit={row.canEdit} />
          <Clips taskId={taskId} projectId={projectId} canEdit={row.canEdit} />
          <Backlinks kind="task" id={taskId} />
          <Activity state={comments} />
        </div>
      </div>
      <Composer state={comments} />
      {historyOpen && pageReady ? <HistoryDialog open pageId={pageReady.id} canEdit={row.canEdit} onClose={() => setHistoryOpen(false)} /> : null}
    </>
  );
}

function Panel({ taskId }: { taskId: string }) {
  const { located, retry } = useLocate(taskId);

  let body;
  if (located.state === 'ready') body = <TaskContent key={located.id} taskId={located.id} tableRef={located.ref} />;
  else if (located.state === 'gone') body = <Unavailable message="This task is not available" onClose={closeTask} />;
  else if (located.state === 'failed') body = <Unavailable message="Could not load this task" onClose={closeTask} onRetry={retry} />;
  else body = <PanelSkeleton label="Loading task" />;

  return (
    <PanelShell label="Task" testId="task-panel" idAttr="data-task-id" rowId={taskId} onClose={closeTask}>
      {body}
    </PanelShell>
  );
}

/** The side panel: shown beside whatever route is open while the URL has `?task=<id>`. */
export function TaskPanelHost() {
  const taskId = useTaskId();
  if (!taskId || !getPlatform().user()) return null;
  return <Panel taskId={taskId} />;
}
