import { useState, type RefObject } from 'react';
import { useTableSchema } from '../../../../tables/store';
import { Button, Input, Popover } from '../../../../ui';
import { useViewAccess } from '../viewBlock/useViewAccess';
import { ViewPicker } from '../viewBlock/ViewPicker';
import { FN_LABELS, SUMMARY_FNS, cleanTarget, fnFitsColumn, isPercent, needsColumn, type SummaryAttrs, type SummaryFn } from './model';

export interface SummarySetupProps {
  open: boolean;
  onClose(): void;
  anchorRef: RefObject<HTMLElement | null>;
  variant: 'block' | 'inline';
  attrs: SummaryAttrs;
  pageViewIds(): string[];
  setAttrs(patch: Partial<SummaryAttrs>): void;
}

/**
 * The settings of a summary: which view, which function and column, and for the block a label and how to show
 * it. Every change is written to the node straight away, so there is nothing to confirm. Choosing a view opens
 * the view picker (the page's own view blocks first); the popover steps aside while the picker is open.
 */
export function SummarySetup({ open, onClose, anchorRef, variant, attrs, pageViewIds, setAttrs }: SummarySetupProps) {
  const [picking, setPicking] = useState(false);

  return (
    <>
      <Popover
        open={open && !picking}
        onOpenChange={(o) => !o && onClose()}
        anchorRef={anchorRef}
        aria-label="Summary settings"
        className="cl-summary-setup"
      >
        <div data-testid="summary-setup" className="cl-summary-setup__body">
          <div className="cl-summary-setup__field">
            <span className="cl-summary-setup__name">View</span>
            <ViewField viewId={attrs.viewId} onChoose={() => setPicking(true)} />
          </div>

          <label className="cl-summary-setup__field">
            <span className="cl-summary-setup__name">Show</span>
            <select
              className="cl-summary-setup__control"
              data-testid="summary-fn"
              value={attrs.fn}
              onChange={(e) => {
                const fn = e.target.value as SummaryFn;
                setAttrs({ fn, ...(needsColumn(fn) ? {} : { column: null }) });
              }}
            >
              {SUMMARY_FNS.map((fn) => (
                <option key={fn} value={fn}>
                  {FN_LABELS[fn]}
                </option>
              ))}
            </select>
          </label>

          {attrs.viewId && needsColumn(attrs.fn) && <ColumnField viewId={attrs.viewId} fn={attrs.fn} column={attrs.column} setAttrs={setAttrs} />}

          {variant === 'block' && (
            <>
              <label className="cl-summary-setup__field">
                <span className="cl-summary-setup__name">Label</span>
                <Input
                  className="cl-summary-setup__control"
                  data-testid="summary-label-input"
                  placeholder={FN_LABELS[attrs.fn]}
                  defaultValue={attrs.label}
                  onCommit={(label) => setAttrs({ label: label.trim() })}
                />
              </label>
              <label className="cl-summary-setup__field">
                <span className="cl-summary-setup__name">Display</span>
                <select
                  className="cl-summary-setup__control"
                  data-testid="summary-display"
                  value={attrs.display}
                  onChange={(e) => setAttrs({ display: e.target.value === 'progress' ? 'progress' : 'number' })}
                >
                  <option value="number">Number</option>
                  <option value="progress">Progress bar</option>
                </select>
              </label>
              {attrs.display === 'progress' && !isPercent(attrs.fn) && (
                <label className="cl-summary-setup__field">
                  <span className="cl-summary-setup__name">Target</span>
                  <Input
                    className="cl-summary-setup__control"
                    data-testid="summary-target"
                    inputMode="decimal"
                    placeholder="No target"
                    defaultValue={attrs.target ?? ''}
                    onCommit={(t) => setAttrs({ target: cleanTarget(t) })}
                  />
                </label>
              )}
            </>
          )}

          <div className="cl-summary-setup__actions">
            <Button size="sm" onClick={onClose} data-testid="summary-setup-done">
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
          setPicking(false);
          // A column of the old table means nothing in the new one
          setAttrs({ viewId: v.id, column: null });
        }}
      />
    </>
  );
}

/** The chosen view's name (or a prompt) on a button that opens the picker. */
function ViewField({ viewId, onChoose }: { viewId: string | null; onChoose(): void }) {
  return (
    <Button size="sm" variant="ghost" className="cl-summary-setup__control" data-testid="summary-pick-view" onClick={onChoose}>
      {viewId ? <NamedView viewId={viewId} /> : 'Choose a view'}
    </Button>
  );
}

function NamedView({ viewId }: { viewId: string }) {
  const access = useViewAccess(viewId);
  return <>{access.state === 'ready' ? access.view.name : access.state === 'gone' ? 'View deleted' : 'Change view'}</>;
}

/** The columns of the view's table the chosen function can read. */
function ColumnField({
  viewId,
  fn,
  column,
  setAttrs,
}: {
  viewId: string;
  fn: SummaryFn;
  column: string | null;
  setAttrs(patch: Partial<SummaryAttrs>): void;
}) {
  const access = useViewAccess(viewId);
  const schema = useTableSchema(access.state === 'ready' ? access.view.tableRef : null).schema;
  const columns = (schema?.columns ?? []).filter((c) => fnFitsColumn(fn, c.type));
  return (
    <label className="cl-summary-setup__field">
      <span className="cl-summary-setup__name">Column</span>
      <select
        className="cl-summary-setup__control"
        data-testid="summary-column"
        value={column ?? ''}
        onChange={(e) => setAttrs({ column: e.target.value || null })}
      >
        <option value="">Choose a column</option>
        {columns.map((c) => (
          <option key={c.key} value={c.key}>
            {c.name}
          </option>
        ))}
        {column && !columns.some((c) => c.key === column) && <option value={column}>{column}</option>}
      </select>
    </label>
  );
}
