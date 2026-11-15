import { useCallback, useState } from 'react';
import { getPlatform } from '../platform';
import { Input, cx } from '../ui';
import { getViewSource, toLayoutProps, useView } from './store';
import { getLayout, layoutDefaults, useLayouts } from './layouts/registry';
import { Toolbar } from './toolbar';
import { TrashDialog } from './trash';
import type { Query, View } from './types';
import './toolbar/toolbar.css';

/**
 * The frame around every layout: view name, toolbar (layout switcher, filter, sort, group, columns,
 * summaries, search, new row) and the layout component itself. Changes to the query and the columns go
 * through `actions.updateConfig` (debounced save); name and layout are saved straight away.
 */
export function ViewShell({ viewId, className }: { viewId: string; className?: string }) {
  const data = useView(viewId);
  const layouts = useLayouts();
  const { schema, view, actions } = data;
  const [trashOpen, setTrashOpen] = useState(false);

  const onQuery = useCallback(
    (patch: { [K in keyof Query]?: Query[K] | undefined }) => {
      const next: Record<string, unknown> = { ...(view?.config.query ?? {}), ...patch };
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
      actions.updateConfig({ query: next as Query });
    },
    [view, actions],
  );

  const onColumns = useCallback((columns: NonNullable<View['config']['columns']>) => actions.updateConfig({ columns }), [actions]);

  const save = useCallback(
    (patch: Parameters<ReturnType<typeof getViewSource>['update']>[1]) => {
      getViewSource()
        .update(viewId, patch)
        .catch((e: unknown) => getPlatform().toast('error', e instanceof Error ? e.message : 'Could not save the view'));
    },
    [viewId],
  );

  if (data.error && !view) {
    return (
      <div className={cx('cl-viewshell', className)} data-testid="view-shell">
        <p className="cl-viewshell__state cl-viewshell__state--error" role="alert">
          {data.error.message}
        </p>
      </div>
    );
  }
  if (!view || !schema) {
    return (
      <div className={cx('cl-viewshell', className)} data-testid="view-shell">
        <p className="cl-viewshell__state">Loading...</p>
      </div>
    );
  }

  const entry = getLayout(view.layout);
  const layoutProps = toLayoutProps(data);

  function switchLayout(name: string) {
    if (!schema || !view || name === view.layout) return;
    const target = getLayout(name);
    const missing = target ? layoutDefaults(target, schema, view.config) : {};
    save({ layout: name as View['layout'], ...(Object.keys(missing).length ? { config: missing } : {}) });
  }

  function newRow() {
    if (!schema || !view) return;
    const values = { [schema.titleColumn]: 'Untitled' };
    const opts = view.tableRef === 'tasks:*' ? projectOpts() : undefined;
    if (view.tableRef === 'tasks:*' && !opts) {
      getPlatform().toast('error', 'You have no project to add a task to');
      return;
    }
    actions.createRow(values, opts).catch(() => {
      /* the store has already shown the error */
    });
  }

  return (
    <div className={cx('cl-viewshell', className)} data-testid="view-shell" data-view-id={view.id}>
      <div className="cl-viewshell__head">
        <Input
          key={view.name}
          className="cl-viewshell__name"
          aria-label="View name"
          data-testid="view-name"
          defaultValue={view.name}
          onCommit={(name) => name.trim() && save({ name: name.trim() })}
        />
      </div>
      <Toolbar
        schema={schema}
        view={view}
        layouts={layouts}
        onQuery={onQuery}
        onColumns={onColumns}
        onLayout={switchLayout}
        onNewRow={schema.capabilities.create ? newRow : undefined}
        onTrash={canUseTrash(view.tableRef) ? () => setTrashOpen(true) : undefined}
      />
      {canUseTrash(view.tableRef) && (
        <TrashDialog tableRef={view.tableRef} open={trashOpen} onClose={() => setTrashOpen(false)} />
      )}
      <div className="cl-viewshell__body">
        {!entry ? (
          <p className="cl-viewshell__state">The {view.layout} layout is not available yet.</p>
        ) : data.error && !layoutProps ? (
          <p className="cl-viewshell__state cl-viewshell__state--error" role="alert">
            {data.error.message}
          </p>
        ) : !layoutProps ? (
          <p className="cl-viewshell__state">Loading...</p>
        ) : (
          <entry.component {...layoutProps} />
        )}
      </div>
    </div>
  );
}

/** For tasks:*, new rows need a project: the first one the user can add tasks to. */
function projectOpts(): { projectId: string } | undefined {
  const project = getPlatform()
    .projects()
    .find((p) => p.canTasks);
  return project ? { projectId: project.id } : undefined;
}

/** The trash of a tasks table is for people who can edit tasks there. */
function canUseTrash(tableRef: string): boolean {
  if (!tableRef.startsWith('tasks:')) return false;
  const platform = getPlatform();
  if (platform.user()?.role === 'viewer') return false;
  const projectId = tableRef.slice('tasks:'.length);
  return platform.projects().some((p) => p.canTasks && (projectId === '*' || p.id === projectId));
}
