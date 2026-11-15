import { useCallback, useRef, useState, type ReactNode } from 'react';
import { Button, Menu, cx, type MenuItem } from '../../ui';
import { ProjectSelect, type AddProject } from '../addProject';
import type { LayoutEntry } from '../layouts/registry';
import type { Query, TableSchema, View } from '../types';
import { orderedColumns } from '../viewColumns';
import { ColumnsEditor, GroupEditor, SortEditor, SummariesEditor } from './editors';
import { FilterBuilder } from './FilterBuilder';
import { ChevronIcon, LayoutIcon, MoreIcon, PlusIcon } from './icons';
import { countConditions } from './queryModel';
import { SearchBox } from './SearchBox';
import { ToolbarPanel } from './ToolbarPopover';
import './toolbar.css';

/**
 * `page`: the toolbar of a view on its own page, always visible.
 * `embedded`: the view sits in a page; the controls are a compact strip that shows on hover or focus
 *   (CSS, and always on touch screens), and only options that are set show as chips.
 */
export type ToolbarVariant = 'page' | 'embedded';

export interface ToolbarProps {
  schema: TableSchema;
  view: View;
  layouts: LayoutEntry[];
  variant?: ToolbarVariant;
  /** Embedded in a page the user cannot edit: only search and the host's menu items remain. */
  readOnly?: boolean;
  /** The view's name (and row count) on the left of the first line. */
  heading: ReactNode;
  /** Replace keys of the query (filter, sort, groupBy, summaries, search); `undefined` removes a key. */
  onQuery(patch: { [K in keyof Query]?: Query[K] | undefined }): void;
  onColumns(columns: NonNullable<View['config']['columns']>): void;
  onLayout(name: string): void;
  /** Adds a row. With `add` (a `tasks:*` view) "New" first asks for the title and the project. */
  onNewRow?: ((title?: string, projectId?: string) => void) | undefined;
  add?: AddProject | undefined;
  /** Adds a "Trash" entry to the "..." menu. */
  onTrash?: (() => void) | undefined;
  /** Adds the "Nest subtasks" switch to the "..." menu. */
  nest?: { checked: boolean; onChange(checked: boolean): void } | undefined;
  /** Items the host adds at the end of the "..." menu (open as page, remove block). */
  menuItems?: MenuItem[] | undefined;
}

type PanelName = 'filter' | 'sort' | 'group' | 'columns' | 'summaries' | 'new';

const PANEL_LABELS: Record<Exclude<PanelName, 'new'>, string> = {
  filter: 'Filter',
  sort: 'Sort',
  group: 'Group',
  columns: 'Columns',
  summaries: 'Summaries',
};

/** Layout switcher, filter, sort, group, columns, summaries, search, "New" and the "..." menu. */
export function Toolbar(props: ToolbarProps) {
  const { schema, view, layouts, variant = 'page', readOnly = false, heading, onQuery, onColumns, onLayout, onNewRow, add, onTrash, nest, menuItems } = props;
  const embedded = variant === 'embedded';
  const query = view.config.query ?? {};
  const hidden = orderedColumns(schema, view.config).filter((c) => c.hidden).length;

  const moreRef = useRef<HTMLButtonElement>(null);
  const layoutRef = useRef<HTMLButtonElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const [panel, setPanel] = useState<PanelName | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [layoutOpen, setLayoutOpen] = useState(false);

  const closePanel = useCallback(() => setPanel(null), []);
  const toggle = (name: PanelName, el: HTMLElement | null) => {
    anchorRef.current = el;
    setPanel((p) => (p === name ? null : name));
  };
  const fromMenu = (name: PanelName) => () => {
    anchorRef.current = moreRef.current;
    setPanel(name);
  };

  const counts: Record<Exclude<PanelName, 'new'>, number> = {
    filter: countConditions(query.filter),
    sort: query.sort?.length ?? 0,
    group: query.groupBy ? 1 : 0,
    columns: hidden,
    summaries: Object.keys(query.summaries ?? {}).length,
  };
  const optionNames = Object.keys(PANEL_LABELS) as Array<Exclude<PanelName, 'new'>>;
  const canEditOptions = !readOnly;

  // The "..." menu is a plain list: hosts and features add items here. Separators are dropped when they
  // would sit at the start, the end or twice in a row.
  const items: MenuItem[] = [];
  if (embedded && canEditOptions) {
    for (const name of optionNames) {
      items.push({
        id: name,
        label: counts[name] > 0 ? `${PANEL_LABELS[name]} (${counts[name]})` : PANEL_LABELS[name],
        testId: `menu-${name}`,
        onSelect: fromMenu(name),
      });
    }
    items.push({ type: 'separator' });
  }
  if (nest && canEditOptions) {
    items.push({ id: 'nest', label: 'Nest subtasks', testId: 'table-nest', checked: nest.checked, onSelect: () => nest.onChange(!nest.checked) });
  }
  if (onTrash && canEditOptions) items.push({ id: 'trash', label: 'Trash', testId: 'menu-trash', onSelect: onTrash });
  if (menuItems?.length) {
    if (items.length) items.push({ type: 'separator' });
    items.push(...menuItems);
  }
  const menu = items.filter((it, i) => !('type' in it) || (i > 0 && i < items.length - 1 && !('type' in items[i - 1]!)));

  const current = layouts.find((l) => l.name === view.layout);
  const pinned = panel !== null || moreOpen || layoutOpen || !!query.search;

  const optionButton = (name: Exclude<PanelName, 'new'>) => {
    const count = counts[name];
    // Embedded: only what is set shows (the rest lives in the "..." menu)
    if (embedded && count === 0) return null;
    return (
      <Button
        key={name}
        size="sm"
        variant="ghost"
        className={cx('cl-viewbar__opt', embedded && 'cl-viewbar__chip', count > 0 && 'is-set')}
        aria-haspopup="dialog"
        aria-expanded={panel === name}
        data-testid={`toolbar-${name}`}
        onClick={(e) => toggle(name, e.currentTarget)}
      >
        {PANEL_LABELS[name]}
        {count > 0 && <span className="cl-viewbar__count">{count}</span>}
      </Button>
    );
  };

  function submitNew(title: string) {
    setPanel(null);
    onNewRow?.(title, add?.projectId);
  }

  return (
    <div className={cx('cl-viewhead', `cl-viewhead--${variant}`)}>
      <div className="cl-viewhead__title">{heading}</div>
      <div
        className={cx('cl-viewbar', `cl-viewbar--${variant}`, pinned && 'is-pinned')}
        role="toolbar"
        aria-label="View options"
        data-testid="view-toolbar"
      >
        {!(embedded && readOnly) && (
          <div className="cl-viewbar__options">
            {embedded ? (
              <Button
                ref={layoutRef}
                size="sm"
                variant="ghost"
                className="cl-viewbar__layoutbtn"
                aria-haspopup="menu"
                aria-expanded={layoutOpen}
                aria-label={`Layout: ${current?.label ?? view.layout}`}
                data-testid="layout-switch"
                onClick={() => setLayoutOpen((o) => !o)}
              >
                <LayoutIcon name={view.layout} />
                {current?.label ?? view.layout}
                <ChevronIcon />
              </Button>
            ) : (
              <div className="cl-viewbar__layouts" role="group" aria-label="Layout">
                {layouts.map((l) => (
                  <Button
                    key={l.name}
                    size="sm"
                    variant="ghost"
                    className={cx('cl-viewbar__layout', view.layout === l.name && 'is-active')}
                    aria-pressed={view.layout === l.name}
                    data-testid={`layout-${l.name}`}
                    onClick={() => onLayout(l.name)}
                  >
                    <LayoutIcon name={l.name} />
                    <span className="cl-viewbar__layout-label">{l.label}</span>
                  </Button>
                ))}
              </div>
            )}
            {embedded && (
              <Menu
                open={layoutOpen}
                onOpenChange={setLayoutOpen}
                anchorRef={layoutRef}
                placement="bottom-start"
                aria-label="Layout"
                items={layouts.map((l) => ({
                  id: l.name,
                  label: l.label,
                  icon: <LayoutIcon name={l.name} />,
                  testId: `layout-${l.name}`,
                  onSelect: () => onLayout(l.name),
                }))}
              />
            )}
            {!embedded && <span className="cl-viewbar__sep" />}
            {optionNames.map(optionButton)}
          </div>
        )}
        <div className="cl-viewbar__actions">
          <SearchBox value={query.search ?? ''} onChange={(search) => onQuery({ search: search || undefined })} />
          {onNewRow && canEditOptions && (
            <Button
              size="sm"
              variant={embedded ? 'ghost' : 'primary'}
              className={cx(embedded && 'cl-viewbar__new')}
              aria-expanded={add ? panel === 'new' : undefined}
              data-testid="new-row"
              onClick={(e) => (add && add.projects.length > 0 ? toggle('new', e.currentTarget) : onNewRow())}
            >
              {embedded && <PlusIcon />}
              New
            </Button>
          )}
          {menu.length > 0 && (
            <>
              <Button
                ref={moreRef}
                size="sm"
                variant="ghost"
                className="cl-viewbar__icon-btn"
                aria-label="More"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                data-testid="toolbar-more"
                onClick={() => setMoreOpen((o) => !o)}
              >
                <MoreIcon />
              </Button>
              <Menu open={moreOpen} onOpenChange={setMoreOpen} anchorRef={moreRef} placement="bottom-end" aria-label="More view options" items={menu} />
            </>
          )}
        </div>
      </div>
      {panel && panel !== 'new' && (
        <ToolbarPanel open label={PANEL_LABELS[panel]} testId={panel} anchorRef={anchorRef} onClose={closePanel} wide={panel === 'filter'}>
          {panel === 'filter' && <FilterBuilder schema={schema} filter={query.filter} onChange={(filter) => onQuery({ filter })} />}
          {panel === 'sort' && <SortEditor schema={schema} sort={query.sort ?? []} onChange={(sort) => onQuery({ sort })} />}
          {panel === 'group' && <GroupEditor schema={schema} groupBy={query.groupBy} onChange={(groupBy) => onQuery({ groupBy })} />}
          {panel === 'columns' && <ColumnsEditor schema={schema} config={view.config} onChange={onColumns} />}
          {panel === 'summaries' && (
            <SummariesEditor schema={schema} summaries={query.summaries ?? {}} onChange={(summaries) => onQuery({ summaries })} />
          )}
        </ToolbarPanel>
      )}
      {panel === 'new' && add && (
        <ToolbarPanel open label="New row" testId="new-row" anchorRef={anchorRef} onClose={closePanel}>
          <NewRowForm add={add} onSubmit={submitNew} />
        </ToolbarPanel>
      )}
    </div>
  );
}

/** Title and project of a new row in a `tasks:*` view, asked for only once "New" was pressed. */
function NewRowForm({ add, onSubmit }: { add: AddProject; onSubmit(title: string): void }) {
  const [title, setTitle] = useState('');
  return (
    <form
      className="cl-viewbar__newform"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) onSubmit(title.trim());
      }}
    >
      <input
        className="cl-viewbar__newinput"
        autoFocus
        aria-label="Title of the new row"
        placeholder="Title"
        data-testid="new-row-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <ProjectSelect add={add} testId="new-row-project" />
      <Button size="sm" variant="primary" type="submit" data-testid="new-row-add" disabled={!title.trim()}>
        Add
      </Button>
    </form>
  );
}
