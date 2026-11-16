import { useRef, useState, type RefObject } from 'react';
import { getSchema } from '../../../../api/tables';
import { useTableSchema } from '../../../../tables/store';
import type { Column, TableSchema } from '../../../../tables/types';
import { Button, Input, Popover } from '../../../../ui';
import { useViewAccess } from '../viewBlock/useViewAccess';
import { ViewPicker } from '../viewBlock/ViewPicker';
import {
  BUCKETS,
  BUCKET_LABELS,
  CHART_FNS,
  CHART_TYPES,
  FN_LABELS,
  TYPE_LABELS,
  canGroupBy,
  canMeasure,
  needsColumn,
  type Bucket,
  type ChartAttrs,
  type ChartFn,
  type ChartType,
} from './model';

export interface ChartSetupProps {
  open: boolean;
  onClose(): void;
  anchorRef: RefObject<HTMLElement | null>;
  attrs: ChartAttrs;
  pageViewIds(): string[];
  setAttrs(patch: Partial<ChartAttrs>): void;
}

/** The column a new chart groups by: the status if the table has one, else the first column that can be grouped. */
export function defaultGroupBy(schema: Pick<TableSchema, 'columns'>): string | null {
  const columns = schema.columns.filter((c) => canGroupBy(c.type));
  return (columns.find((c) => c.type === 'status') ?? columns[0])?.key ?? null;
}

/**
 * The settings of a chart: view, type, what to group by (and the date bucket), what to measure and a title.
 * Every change is written to the node at once. Choosing a view opens the view picker (the page's own view
 * blocks first); the popover steps aside while the picker is open.
 */
export function ChartSetup({ open, onClose, anchorRef, attrs, pageViewIds, setAttrs }: ChartSetupProps) {
  const [picking, setPicking] = useState(false);
  // When the picker closes, the press that chose a view must not count as a press outside the reopened popover
  const pickedAt = useRef(0);
  const latest = useRef(attrs);
  latest.current = attrs;
  const access = useViewAccess(open ? attrs.viewId : null);
  const schema = useTableSchema(access.state === 'ready' ? access.view.tableRef : null).schema;
  const groupColumns = (schema?.columns ?? []).filter((c) => canGroupBy(c.type));
  const measureColumns = (schema?.columns ?? []).filter((c) => canMeasure(c.type));
  const groupColumn = schema?.columns.find((c) => c.key === attrs.groupBy);

  return (
    <>
      <Popover
        open={open && !picking}
        onOpenChange={(o) => !o && Date.now() - pickedAt.current > 400 && onClose()}
        anchorRef={anchorRef}
        aria-label="Chart settings"
        className="cl-chart-setup"
      >
        <div data-testid="chart-setup" className="cl-chart-setup__body">
          <div className="cl-chart-setup__field">
            <span className="cl-chart-setup__name">View</span>
            <Button size="sm" variant="ghost" className="cl-chart-setup__control" data-testid="chart-pick-view" onClick={() => setPicking(true)}>
              {attrs.viewId ? (access.state === 'ready' ? access.view.name : access.state === 'gone' ? 'View deleted' : 'Change view') : 'Choose a view'}
            </Button>
          </div>

          <label className="cl-chart-setup__field">
            <span className="cl-chart-setup__name">Chart type</span>
            <select
              className="cl-chart-setup__control"
              data-testid="chart-type"
              value={attrs.type}
              onChange={(e) => setAttrs({ type: e.target.value as ChartType })}
            >
              {CHART_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>

          <label className="cl-chart-setup__field">
            <span className="cl-chart-setup__name">Group by</span>
            <select
              className="cl-chart-setup__control"
              data-testid="chart-group"
              value={attrs.groupBy ?? ''}
              disabled={!attrs.viewId}
              onChange={(e) => setAttrs({ groupBy: e.target.value || null })}
            >
              <option value="">Choose a column</option>
              {groupColumns.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                </option>
              ))}
              {attrs.groupBy && schema && !groupColumns.some((c) => c.key === attrs.groupBy) && <option value={attrs.groupBy}>{attrs.groupBy}</option>}
            </select>
          </label>

          {groupColumn?.type === 'date' && (
            <label className="cl-chart-setup__field">
              <span className="cl-chart-setup__name">Date steps</span>
              <select
                className="cl-chart-setup__control"
                data-testid="chart-bucket"
                value={attrs.bucket}
                onChange={(e) => setAttrs({ bucket: e.target.value as Bucket })}
              >
                {BUCKETS.map((b) => (
                  <option key={b} value={b}>
                    {BUCKET_LABELS[b]}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="cl-chart-setup__field">
            <span className="cl-chart-setup__name">Measure</span>
            <select
              className="cl-chart-setup__control"
              data-testid="chart-fn"
              value={attrs.fn}
              onChange={(e) => {
                const fn = e.target.value as ChartFn;
                setAttrs({ fn, ...(needsColumn(fn) ? {} : { column: null }) });
              }}
            >
              {CHART_FNS.map((fn) => (
                <option key={fn} value={fn}>
                  {fn === 'count' ? 'Count of rows' : FN_LABELS[fn]}
                </option>
              ))}
            </select>
          </label>

          {needsColumn(attrs.fn) && (
            <label className="cl-chart-setup__field">
              <span className="cl-chart-setup__name">Number column</span>
              <select
                className="cl-chart-setup__control"
                data-testid="chart-column"
                value={attrs.column ?? ''}
                onChange={(e) => setAttrs({ column: e.target.value || null })}
              >
                <option value="">Choose a column</option>
                {measureColumns.map((c: Column) => (
                  <option key={c.key} value={c.key}>
                    {c.name}
                  </option>
                ))}
                {attrs.column && schema && !measureColumns.some((c) => c.key === attrs.column) && <option value={attrs.column}>{attrs.column}</option>}
              </select>
            </label>
          )}

          <label className="cl-chart-setup__field">
            <span className="cl-chart-setup__name">Title</span>
            <Input
              className="cl-chart-setup__control"
              data-testid="chart-title-input"
              placeholder="No title"
              defaultValue={attrs.title}
              onCommit={(title) => setAttrs({ title: title.trim() })}
            />
          </label>

          <div className="cl-chart-setup__actions">
            <Button size="sm" onClick={onClose} data-testid="chart-setup-done">
              Done
            </Button>
          </div>
        </div>
      </Popover>
      <ViewPicker
        open={open && picking}
        onClose={() => setPicking(false)}
        pinnedIds={picking ? pageViewIds() : []}
        onPick={(v) => {
          pickedAt.current = Date.now();
          setPicking(false);
          // The old table's columns mean nothing in the new one; start from a sensible grouping
          setAttrs({ viewId: v.id, groupBy: null, column: null });
          void getSchema(v.tableRef).then(
            (s) => {
              const key = defaultGroupBy(s);
              // Only when the person has not chosen a column in the meantime
              if (key && !latest.current.groupBy) setAttrs({ groupBy: key });
            },
            () => {},
          );
        }}
      />
    </>
  );
}
