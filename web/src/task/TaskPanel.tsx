import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../api/http';
import * as tablesApi from '../api/tables';
import { HistoryDialog } from '../pages/history';
import { CollabEditor } from '../pages/sync';
import { getPlatform } from '../platform';
import { closeTask, openTask, useTaskId } from '../router';
import { deleteRows, updateRow, useRow, useTableSchema } from '../tables/store';
import type { Column, Row } from '../tables/types';
import { useEscape } from '../ui/hooks';
import { Backlinks } from '../pages/backlinks';
import { Checklist } from './Checklist';
import { Clips } from './Clips';
import { Comments } from './Comments';
import { Properties } from './Properties';
import { Subtasks } from './Subtasks';
import { getTaskPage } from './api';
import './task.css';

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

/** The task page (created on first use) in the collaborative editor; the old description is imported by the editor. */
function Body({ taskId, canEdit }: { taskId: string; canEdit: boolean }) {
  const [page, setPage] = useState<{ id: string; for: string } | 'failed' | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
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
  return (
    <section className="cl-task__section cl-task__body" aria-label="Description" data-testid="task-body">
      {page === 'failed' ? (
        <p className="cl-task__empty">The description could not be loaded.</p>
      ) : page && page.for === taskId ? (
        <>
          <CollabEditor key={page.id} pageId={page.id} readOnly={!canEdit} placeholder="Add a description, or type / for blocks" />
          <button type="button" className="cl-task__history" onClick={() => setHistoryOpen(true)}>
            History
          </button>
          {historyOpen ? <HistoryDialog open pageId={page.id} canEdit={canEdit} onClose={() => setHistoryOpen(false)} /> : null}
        </>
      ) : (
        <p className="cl-task__empty">Loading...</p>
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
      <span className="cl-task__crumbsep" aria-hidden="true">
        /
      </span>
    </>
  );
}

function Title({ row, canEdit, onSave }: { row: Row; canEdit: boolean; onSave: (name: string) => void }) {
  const name = String(row.values.name ?? '');
  const [draft, setDraft] = useState(name);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(name);
  }, [name]);
  function finish() {
    focused.current = false;
    const text = draft.trim();
    if (!text) setDraft(name);
    else if (text !== name) onSave(text);
  }
  return (
    <input
      className="cl-task__title"
      aria-label="Task name"
      placeholder="Task name"
      value={draft}
      readOnly={!canEdit}
      onFocus={() => (focused.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={finish}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') {
          setDraft(name);
          focused.current = false;
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/** What a task shows about its creation. The server keeps no change log yet, so this is the whole activity. */
function Activity({ columns, row }: { columns: Column[]; row: Row }) {
  const who = row.values.createdBy as string | null | undefined;
  const label = columns.find((c) => c.key === 'createdBy')?.options?.find((o) => o.value === who)?.label;
  const created = row.values.createdAt as string | null | undefined;
  const when = created ? new Date(created) : null;
  if (!who && !when) return null;
  return (
    <section className="cl-task__section" aria-label="Activity" data-testid="task-activity">
      <h3 className="cl-task__heading">Activity</h3>
      <p className="cl-task__activity">
        Created{label ? ` by ${label}` : ''}
        {when && !Number.isNaN(when.getTime()) ? ` on ${when.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
      </p>
    </section>
  );
}

function Unavailable({ message, onClose, onRetry }: { message: string; onClose: () => void; onRetry?: () => void }) {
  return (
    <div className="cl-task__state" data-testid="task-unavailable">
      <p>{message}</p>
      <div className="cl-task__statebtns">
        {onRetry ? (
          <button type="button" className="cl-task__link" onClick={onRetry}>
            Try again
          </button>
        ) : null}
        <button type="button" className="cl-task__link" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

function TaskContent({ taskId, tableRef }: { taskId: string; tableRef: string }) {
  const platform = getPlatform();
  const { row, loading, error } = useRow(tableRef, taskId);
  const { schema } = useTableSchema(tableRef);
  const projectId = tableRef.replace(/^tasks:/, '');

  if (isGone(error)) return <Unavailable message="This task is not available" onClose={closeTask} />;
  if (!row || !schema) {
    if (error) return <Unavailable message="Could not load this task" onClose={closeTask} />;
    return <div className="cl-task__state">{loading || !schema ? 'Loading...' : null}</div>;
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

  return (
    <>
      <header className="cl-task__header">
        <div className="cl-task__top">
          <nav className="cl-task__crumbs" aria-label="Parent tasks" hidden={!row.parentId}>
            {row.parentId ? <Ancestors tableRef={tableRef} parentId={row.parentId} /> : null}
          </nav>
        </div>
        <div className="cl-task__titlerow">
          <Title row={row} canEdit={row.canEdit} onSave={(name) => save({ name })} />
          {row.canEdit && schema.capabilities.delete ? (
            <button type="button" className="cl-task__iconbtn cl-task__danger" aria-label="Delete task" title="Delete task" onClick={() => void remove()}>
              &#128465;
            </button>
          ) : null}
          <button type="button" className="cl-task__iconbtn" aria-label="Close task" title="Close (Esc)" onClick={closeTask}>
            &times;
          </button>
        </div>
      </header>
      <div className="cl-task__scroll">
        <div className="cl-task__main">
          <Properties columns={schema.columns} row={row} onChange={(key, value) => save({ [key]: value })} />
          <Body taskId={taskId} canEdit={row.canEdit} />
          <Clips taskId={taskId} projectId={projectId} canEdit={row.canEdit} />
          <Subtasks tableRef={tableRef} taskId={taskId} count={row.childCount ?? 0} />
          <Checklist taskId={taskId} canEdit={row.canEdit} />
          <Backlinks kind="task" id={taskId} />
        </div>
        <div className="cl-task__side">
          <Comments taskId={taskId} />
          <Activity columns={schema.columns} row={row} />
        </div>
      </div>
    </>
  );
}

function Panel({ taskId }: { taskId: string }) {
  const { located, retry } = useLocate(taskId);
  const swallowEscape = useRef(false);

  // Escape closes the panel, unless it was meant for a field or an open editor: that first Escape only leaves it.
  // useEscape keeps the order with popovers and dialogs (the innermost layer gets the key).
  useEscape(true, () => {
    if (swallowEscape.current) {
      swallowEscape.current = false;
      const active = document.activeElement as HTMLElement | null;
      if (active && active.matches('input, textarea, select, [contenteditable]')) active.blur();
      return;
    }
    closeTask();
  });

  let body;
  if (located.state === 'ready') body = <TaskContent key={located.id} taskId={located.id} tableRef={located.ref} />;
  else if (located.state === 'gone') body = <Unavailable message="This task is not available" onClose={closeTask} />;
  else if (located.state === 'failed') {
    body = <Unavailable message="Could not load this task" onClose={closeTask} onRetry={retry} />;
  } else body = <div className="cl-task__state">Loading...</div>;

  return createPortal(
    <>
      <div className="cl-task__scrim" data-testid="task-scrim" onMouseDown={closeTask} />
      <aside
        className="cl-task"
        role="dialog"
        aria-label="Task"
        aria-modal="false"
        data-testid="task-panel"
        data-task-id={taskId}
        onKeyDownCapture={(e) => {
          if (e.key !== 'Escape') return;
          const target = e.target as HTMLElement;
          swallowEscape.current = !!target.closest('.is-editing, input, textarea, select, [contenteditable]');
          setTimeout(() => (swallowEscape.current = false), 0);
        }}
      >
        {body}
      </aside>
    </>,
    document.body,
  );
}

/** The side panel: shown over whatever route is open while the URL has `?task=<id>`. */
export function TaskPanelHost() {
  const taskId = useTaskId();
  if (!taskId || !getPlatform().user()) return null;
  return <Panel taskId={taskId} />;
}
