import { useCallback, useState } from 'react';
import { getPlatform } from '../platform';
import { viewExportItem } from '../export';
import { Input, cx, type MenuItem } from '../ui';
import { useAddProject } from './addProject';
import { getViewSource, toLayoutProps, useView } from './store';
import { getLayout, layoutDefaults, useLayouts } from './layouts/registry';
import { Toolbar, type ToolbarVariant } from './toolbar';
import { TrashDialog } from './trash';
import type { Query, View } from './types';
import './toolbar/toolbar.css';


/** Layouts with their own "+ New" at the end of the rows: the toolbar's New would be a second way to do the same. */
const INLINE_ADD: ReadonlySet<string> = new Set(['table', 'list', 'board', 'gallery', 'gantt']);
/**
 * The frame around every layout: view name, toolbar (layout switcher, filter, sort, group, columns,
 * summaries, search, new row) and the layout component itself. Changes to the query and the columns go
 * through `actions.updateConfig` (debounced save); name and layout are saved straight away.
 */
export function ViewShell({
  viewId,
  className,
  variant = 'page',
  editable = true,
  menuItems,
}: {
  viewId: string;
  className?: string;
  /** `page`: the view on its own page (toolbar always shown). `embedded`: inside a page (controls on hover). */
  variant?: ToolbarVariant;
  /** Embedded in a page that cannot be edited: no controls except search and the host's menu items. */
  editable?: boolean;
  /** Items the host adds to the "..." menu (open as page, remove block). */
  menuItems?: MenuItem[];
}) {
  const data = useView(viewId);
  const layouts = useLayouts();
  const { schema, view, actions } = data;
  const [trashOpen, setTrashOpen] = useState(false);
  const add = useAddProject(viewId, view?.tableRef ?? '');

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

  /** `title`/`projectId` come from the "New" form of a tasks:* view; otherwise the row starts as "Untitled". */
  function newRow(title?: string, projectId?: string) {
    if (!schema || !view) return;
    const values = { [schema.titleColumn]: title || 'Untitled' };
    let opts: { projectId: string } | undefined;
    if (view.tableRef === 'tasks:*') {
      const chosen = projectId || add.projectId;
      if (!chosen) {
        getPlatform().toast('error', 'You have no project to add a task to');
        return;
      }
      opts = { projectId: chosen };
    }
    actions.createRow(values, opts).catch(() => {
      /* the store has already shown the error */
    });
  }

  const readOnly = variant === 'embedded' && !editable;
  const nestable = schema.capabilities.hierarchy && !readOnly;
  const nested = view.config.query?.parentId === null;
  const total = data.result?.total;

  function toggleNest(on: boolean) {
    onQuery({ parentId: on ? null : undefined });
  }

  const nameInput = (
    <Input
      key={view.name}
      className="cl-viewhead__input"
      style={{ width: `${Math.max(5, view.name.length) + 2}ch` }}
      aria-label="View name"
      data-testid={variant === 'embedded' ? 'viewblock-name' : 'view-name'}
      defaultValue={view.name}
      readOnly={readOnly}
      onCommit={(name) => name.trim() && name.trim() !== view.name && save({ name: name.trim() })}
    />
  );

  return (
    <div className={cx('cl-viewshell', `cl-viewshell--${variant}`, className)} data-testid="view-shell" data-view-id={view.id}>
      <Toolbar
        schema={schema}
        view={view}
        layouts={layouts}
        variant={variant}
        readOnly={readOnly}
        heading={
          <>
            {variant === 'page' ? (
              <div className="cl-viewhead__name" role="heading" aria-level={1}>{nameInput}</div>
            ) : (
              <div className="cl-viewhead__name" role="heading" aria-level={2}>{nameInput}</div>
            )}
            {total !== undefined && (
              <span className="cl-viewhead__count" data-testid="view-count">
                {total}
              </span>
            )}
          </>
        }
        onQuery={onQuery}
        onColumns={onColumns}
        onLayout={switchLayout}
        onNewRow={schema.capabilities.create && !INLINE_ADD.has(view.layout) ? newRow : undefined}
        add={view.tableRef === 'tasks:*' ? add : undefined}
        onTrash={canUseTrash(view.tableRef) ? () => setTrashOpen(true) : undefined}
        nest={nestable ? { checked: nested, onChange: toggleNest } : undefined}
        menuItems={[...(menuItems ?? []), viewExportItem(view)]}
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

/** The trash of a tasks table is for people who can edit tasks there. */
function canUseTrash(tableRef: string): boolean {
  if (!tableRef.startsWith('tasks:')) return false;
  const platform = getPlatform();
  if (platform.user()?.role === 'viewer') return false;
  const projectId = tableRef.slice('tasks:'.length);
  return platform.projects().some((p) => p.canTasks && (projectId === '*' || p.id === projectId));
}
