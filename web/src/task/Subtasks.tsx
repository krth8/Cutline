import { useMemo } from 'react';
import { getLayout } from '../tables/layouts/registry';
import { toLayoutProps, useViewQuery, type ViewDescriptor } from '../tables/store';
import type { LayoutProps } from '../tables/types';
import '../tables/layouts/list'; // registers the list layout

/**
 * The subtasks of a task as an embedded list view: an unsaved view descriptor (list layout, parent = the task)
 * run through the same store and layout as any saved view. Quick add creates rows under the task; opening a
 * row opens that subtask in the panel (the panel's breadcrumb leads back).
 */
export function Subtasks({ tableRef, taskId, count }: { tableRef: string; taskId: string; count: number }) {
  const descriptor = useMemo<ViewDescriptor>(
    () => ({
      id: `task-subtasks:${taskId}`,
      tableRef,
      layout: 'list',
      name: 'Subtasks',
      config: { query: { parentId: taskId }, list: { secondaryColumns: ['status', 'assignees', 'dueDate'] } },
    }),
    [tableRef, taskId],
  );
  const data = useViewQuery(descriptor);
  const layoutProps = toLayoutProps(data);
  const List = getLayout('list')?.component;

  // Every row created here belongs under the task
  const actions = useMemo<LayoutProps['actions']>(
    () => ({ ...data.actions, createRow: (values, opts) => data.actions.createRow(values, { ...opts, parentId: taskId }) }),
    [data.actions, taskId],
  );

  return (
    <section className="cl-task__section" aria-label="Subtasks" data-testid="task-subtasks">
      <h3 className="cl-task__heading">
        Subtasks <span className="cl-task__count">({layoutProps ? layoutProps.result.total : count})</span>
      </h3>
      {!List ? null : layoutProps ? (
        <List {...layoutProps} actions={actions} />
      ) : data.error ? (
        <p className="cl-task__empty" role="alert">
          {data.error.message}
        </p>
      ) : (
        <p className="cl-task__empty">Loading...</p>
      )}
    </section>
  );
}
