import { useMemo, useState } from 'react';
import { CellHost } from '../tables/cells';
import { doneModel, hasValue } from '../tables/layouts/list/listHelpers';
import { openTask } from '../router';
import { toLayoutProps, useViewQuery, type ViewDescriptor } from '../tables/store';
import type { Column, Row } from '../tables/types';
import { cx } from '../ui';
import { Section } from './Section';

/**
 * The subtasks of a task as a compact list: done checkbox, title, assignees and due date. The rows come from an
 * unsaved view descriptor (parent = the task) run through the same store as any saved view, so they stay live.
 * "+" on the heading opens a quick add row that creates subtasks under the task; opening one swaps the panel to
 * that subtask (its breadcrumb leads back).
 */
export function Subtasks({ tableRef, taskId, count, canAdd }: { tableRef: string; taskId: string; count: number; canAdd: boolean }) {
  const descriptor = useMemo<ViewDescriptor>(
    () => ({
      id: `task-subtasks:${taskId}`,
      tableRef,
      layout: 'list',
      name: 'Subtasks',
      config: { query: { parentId: taskId }, list: { secondaryColumns: ['assignees', 'dueDate'] } },
    }),
    [tableRef, taskId],
  );
  const data = useViewQuery(descriptor);
  const layoutProps = toLayoutProps(data);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');

  const schema = layoutProps?.schema;
  const done = schema ? doneModel(schema) : undefined;
  const rows = layoutProps?.result.rows ?? [];
  const total = layoutProps ? layoutProps.result.total : count;
  const side = ['assignees', 'dueDate'].map((k) => schema?.columns.find((c) => c.key === k)).filter((c): c is Column => !!c);

  function toggle(row: Row) {
    if (!done || !row.canEdit) return;
    layoutProps?.actions.updateRow(row.id, { [done.column.key]: done.isDone(row) ? done.openValue : done.doneValue }).catch(() => {
      /* the store has rolled the change back and shown the error */
    });
  }

  function add() {
    const name = title.trim();
    if (!name || !layoutProps) return;
    setTitle('');
    layoutProps.actions.createRow({ [layoutProps.schema.titleColumn]: name }, { parentId: taskId }).catch(() => {
      /* the store shows the error */
    });
  }

  return (
    <Section
      title="Subtasks"
      count={total}
      testId="task-subtasks"
      forceOpen={adding}
      {...(canAdd ? { addLabel: 'Add subtask', onAdd: () => setAdding(true) } : {})}
    >
      {data.error && !layoutProps ? (
        <p className="cl-task__empty" role="alert">
          {data.error.message}
        </p>
      ) : !layoutProps ? (
        <div className="cl-skel cl-skel--line" aria-busy="true" />
      ) : (
        <ul className="cl-subtasks">
          {rows.map((row) => {
            const isDone = done?.isDone(row) ?? false;
            const name = String(row.values[layoutProps.schema.titleColumn] ?? '');
            return (
              <li key={row.id} className={cx('cl-subtask', isDone && 'is-done')} data-subtask-id={row.id}>
                <input
                  type="checkbox"
                  className="cl-subtask__check"
                  aria-label={isDone ? `Mark "${name}" as not done` : `Mark "${name}" as done`}
                  checked={isDone}
                  disabled={!done || !row.canEdit}
                  onChange={() => toggle(row)}
                />
                <button type="button" className="cl-subtask__title" title={name} onClick={() => openTask(row.id)}>
                  {name || 'Untitled'}
                </button>
                <span className="cl-subtask__side">
                  {side.map((c) =>
                    hasValue(c, row.values[c.key]) ? (
                      <span key={c.key} className="cl-subtask__value" data-column={c.key}>
                        <CellHost
                          column={c}
                          value={row.values[c.key]}
                          row={row}
                          compact
                          onChange={(value) => {
                            layoutProps.actions.updateRow(row.id, { [c.key]: value }).catch(() => {});
                          }}
                        />
                      </span>
                    ) : null,
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {adding && canAdd ? (
        <div className="cl-task__addrow">
          <input
            className="cl-task__addinput"
            placeholder="New subtask, then Enter"
            aria-label="New subtask"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            onBlur={() => !title.trim() && setAdding(false)}
          />
        </div>
      ) : null}
    </Section>
  );
}
