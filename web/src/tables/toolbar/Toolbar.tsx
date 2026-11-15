import { useRef, useState } from 'react';
import { Button, Menu, cx } from '../../ui';
import type { LayoutEntry } from '../layouts/registry';
import type { Query, TableSchema, View } from '../types';
import { orderedColumns } from '../viewColumns';
import { ColumnsEditor, GroupEditor, SortEditor, SummariesEditor } from './editors';
import { FilterBuilder } from './FilterBuilder';
import { countConditions } from './queryModel';
import { SearchBox } from './SearchBox';
import { ToolbarPopover } from './ToolbarPopover';
import './toolbar.css';

export interface ToolbarProps {
  schema: TableSchema;
  view: View;
  layouts: LayoutEntry[];
  /** Replace keys of the query (filter, sort, groupBy, summaries, search); `undefined` removes a key. */
  onQuery(patch: { [K in keyof Query]?: Query[K] | undefined }): void;
  onColumns(columns: NonNullable<View['config']['columns']>): void;
  onLayout(name: string): void;
  onNewRow?: (() => void) | undefined;
  /** Adds a "Trash" entry to the overflow menu. */
  onTrash?: (() => void) | undefined;
}

/** Layout switcher, filter, sort, group, columns, summaries, search and "New". */
export function Toolbar({ schema, view, layouts, onQuery, onColumns, onLayout, onNewRow, onTrash }: ToolbarProps) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const query = view.config.query ?? {};
  const hidden = orderedColumns(schema, view.config).filter((c) => c.hidden).length;
  return (
    <div className="cl-toolbar" role="toolbar" aria-label="View options" data-testid="view-toolbar">
      <div className="cl-toolbar__layouts" role="group" aria-label="Layout">
        {layouts.map((l) => (
          <Button
            key={l.name}
            size="sm"
            variant="ghost"
            className={cx('cl-toolbar__layout', view.layout === l.name && 'is-active')}
            aria-pressed={view.layout === l.name}
            data-testid={`layout-${l.name}`}
            onClick={() => onLayout(l.name)}
          >
            {l.label}
          </Button>
        ))}
      </div>
      <span className="cl-toolbar__sep" />
      <ToolbarPopover label="Filter" testId="filter" count={countConditions(query.filter)} panelClassName="cl-toolbar__panel--wide">
        <FilterBuilder schema={schema} filter={query.filter} onChange={(filter) => onQuery({ filter })} />
      </ToolbarPopover>
      <ToolbarPopover label="Sort" testId="sort" count={query.sort?.length ?? 0}>
        <SortEditor schema={schema} sort={query.sort ?? []} onChange={(sort) => onQuery({ sort })} />
      </ToolbarPopover>
      <ToolbarPopover label="Group" testId="group" count={query.groupBy ? 1 : 0}>
        <GroupEditor schema={schema} groupBy={query.groupBy} onChange={(groupBy) => onQuery({ groupBy })} />
      </ToolbarPopover>
      <ToolbarPopover label="Columns" testId="columns" count={hidden}>
        <ColumnsEditor schema={schema} config={view.config} onChange={onColumns} />
      </ToolbarPopover>
      <ToolbarPopover label="Summaries" testId="summaries" count={Object.keys(query.summaries ?? {}).length}>
        <SummariesEditor schema={schema} summaries={query.summaries ?? {}} onChange={(summaries) => onQuery({ summaries })} />
      </ToolbarPopover>
      <span className="cl-toolbar__spacer" />
      <SearchBox value={query.search ?? ''} onChange={(search) => onQuery({ search: search || undefined })} />
      {onTrash && (
        <>
          <Button
            ref={moreRef}
            size="sm"
            variant="ghost"
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            data-testid="toolbar-more"
            onClick={() => setMoreOpen((o) => !o)}
          >
            &#8943;
          </Button>
          <Menu
            open={moreOpen}
            onOpenChange={setMoreOpen}
            anchorRef={moreRef}
            placement="bottom-end"
            aria-label="More view options"
            items={[{ id: 'trash', label: 'Trash', onSelect: onTrash }]}
          />
        </>
      )}
      {onNewRow && (
        <Button size="sm" variant="primary" data-testid="new-row" onClick={onNewRow}>
          New
        </Button>
      )}
    </div>
  );
}
