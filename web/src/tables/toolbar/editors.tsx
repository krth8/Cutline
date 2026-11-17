import { Button } from '../../ui';
import type { Query, TableSchema, View } from '../types';
import { orderedColumns } from '../viewColumns';
import { GROUPABLE, SORTABLE_EXCLUDED, SUMMARY_LABELS, summariesFor } from './queryModel';

type Sort = NonNullable<Query['sort']>;

/** Sort rules in priority order: column, direction, remove. */
export function SortEditor({ schema, sort, onChange }: { schema: TableSchema; sort: Sort; onChange: (sort: Sort | undefined) => void }) {
  const columns = schema.columns.filter((c) => !SORTABLE_EXCLUDED.has(c.type));
  const emit = (next: Sort) => onChange(next.length ? next : undefined);
  const free = columns.find((c) => !sort.some((s) => s.column === c.key));
  return (
    <div className="cl-sort" data-testid="sort-editor">
      {sort.length === 0 && <p className="cl-filter__none">Not sorted. Rows are in their own order.</p>}
      {sort.map((rule, i) => (
        <div key={i} className="cl-filter__row" data-testid="sort-row">
          <select
            className="cl-filter__select"
            aria-label="Sort column"
            value={rule.column}
            onChange={(e) => emit(sort.map((r, j) => (j === i ? { ...r, column: e.target.value } : r)))}
          >
            {columns.map((c) => (
              <option key={c.key} value={c.key}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            className="cl-filter__select"
            aria-label="Sort direction"
            value={rule.dir}
            onChange={(e) => emit(sort.map((r, j) => (j === i ? { ...r, dir: e.target.value as 'asc' | 'desc' } : r)))}
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          <button type="button" className="cl-filter__remove" aria-label="Remove sort" onClick={() => emit(sort.filter((_, j) => j !== i))}>
            {'×'}
          </button>
        </div>
      ))}
      <Button size="sm" variant="ghost" disabled={!free} onClick={() => free && emit([...sort, { column: free.key, dir: 'asc' }])}>
        + Add sort
      </Button>
    </div>
  );
}

/** One column to group by, or none. */
export function GroupEditor({ schema, groupBy, onChange }: { schema: TableSchema; groupBy: string | undefined; onChange: (key: string | undefined) => void }) {
  const columns = schema.columns.filter((c) => GROUPABLE.has(c.type));
  return (
    <div className="cl-group" data-testid="group-editor">
      <label className="cl-filter__mode">
        Group by
        <select
          className="cl-filter__select"
          aria-label="Group by"
          value={groupBy ?? ''}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          <option value="">None</option>
          {columns.map((c) => (
            <option key={c.key} value={c.key}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/** Show or hide columns and move them up or down. Writes the complete `config.columns` list. */
export function ColumnsEditor({
  schema,
  config,
  onChange,
}: {
  schema: TableSchema;
  config: View['config'];
  onChange: (columns: NonNullable<View['config']['columns']>) => void;
}) {
  const list = orderedColumns(schema, config);
  const emit = (next: typeof list) =>
    onChange(next.map((c) => ({ key: c.column.key, ...(c.width !== undefined ? { width: c.width } : {}), ...(c.hidden ? { hidden: true } : {}) })));
  const move = (i: number, delta: number) => {
    const next = [...list];
    const [item] = next.splice(i, 1);
    next.splice(i + delta, 0, item!);
    emit(next);
  };
  return (
    <div className="cl-colpicker" data-testid="columns-editor">
      {list.map((c, i) => (
        <div key={c.column.key} className="cl-columns__row" data-testid="column-row" data-key={c.column.key}>
          <label className="cl-columns__label">
            <input
              type="checkbox"
              checked={!c.hidden}
              disabled={c.column.key === schema.titleColumn}
              onChange={() => emit(list.map((x, j) => (j === i ? { ...x, hidden: !x.hidden } : x)))}
            />
            {c.column.name}
          </label>
          <button type="button" className="cl-columns__move" aria-label={`Move ${c.column.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
            {'↑'}
          </button>
          <button
            type="button"
            className="cl-columns__move"
            aria-label={`Move ${c.column.name} down`}
            disabled={i === list.length - 1}
            onClick={() => move(i, 1)}
          >
            {'↓'}
          </button>
        </div>
      ))}
    </div>
  );
}

/** One summary function per column (shown in group headers and the footer of layouts that support it). */
export function SummariesEditor({
  schema,
  summaries,
  onChange,
}: {
  schema: TableSchema;
  summaries: NonNullable<Query['summaries']>;
  onChange: (summaries: Query['summaries'] | undefined) => void;
}) {
  const set = (key: string, fn: string) => {
    const next = { ...summaries };
    if (fn) next[key] = fn as NonNullable<Query['summaries']>[string];
    else delete next[key];
    onChange(Object.keys(next).length ? next : undefined);
  };
  return (
    <div className="cl-summaries" data-testid="summaries-editor">
      {schema.columns.map((c) => (
        <label key={c.key} className="cl-filter__row cl-summaries__row">
          <span className="cl-summaries__name">{c.name}</span>
          <select className="cl-filter__select" aria-label={`Summary of ${c.name}`} value={summaries[c.key] ?? ''} onChange={(e) => set(c.key, e.target.value)}>
            <option value="">None</option>
            {summariesFor(c.type).map((fn) => (
              <option key={fn} value={fn}>
                {SUMMARY_LABELS[fn]}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}
