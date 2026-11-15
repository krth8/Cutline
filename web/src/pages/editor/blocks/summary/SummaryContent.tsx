import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Tooltip } from '../../../../ui';
import { SummaryData, type SummaryState } from './SummaryData';
import { SummarySetup } from './SummarySetup';
import { FN_LABELS, formatValue, progressFraction, progressText, type SummaryAttrs } from './model';
import './summary.css';

export interface SummaryContentProps {
  /** `block`: label and number or progress bar on their own line. `inline`: only the number, inside a sentence. */
  variant: 'block' | 'inline';
  attrs: SummaryAttrs;
  /** The editor accepts changes: a click opens the setup, a deleted view can be removed. */
  editable: boolean;
  /** Open the setup right away (a node that was just inserted and has no view yet). */
  autoOpen: boolean;
  /** Ids of the view blocks on this page; the picker lists them first. */
  pageViewIds(): string[];
  /** Write node attributes into the document. */
  setAttrs(patch: Partial<SummaryAttrs>): void;
  /** Take the node out of the document. */
  removeNode(): void;
}

const NO_ACCESS = "You don't have access to this view";

/** Text and tooltip of a state that has no number to show. */
function placeholder(state: SummaryState, editable: boolean): { text: string; tip?: string } {
  switch (state.kind) {
    case 'none':
      return { text: editable ? 'Set up' : '—', ...(editable ? {} : { tip: 'No view chosen' }) };
    case 'denied':
      return { text: '—', tip: NO_ACCESS };
    case 'gone':
      return { text: 'View deleted' };
    case 'problem':
      return { text: '—', tip: state.reason };
    case 'error':
      return { text: '—', tip: `Could not load this number: ${state.message}` };
    default:
      return { text: '—' };
  }
}

/** One number (or progress bar) of a view's summary, with the setup popover for whoever may edit it. */
export function SummaryContent(props: SummaryContentProps) {
  const { variant, attrs, editable, autoOpen, setAttrs, removeNode } = props;
  const anchor = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (autoOpen && editable) setOpen(true);
  }, [autoOpen, editable]);

  const label = attrs.label.trim() || FN_LABELS[attrs.fn];
  const progress = variant === 'block' && attrs.display === 'progress';

  /** The part that depends on the data: the number or bar, or what stands in for it. */
  const renderValue = (state: SummaryState): ReactNode => {
    const gone = state.kind === 'gone';
    let value: ReactNode;
    if (state.kind === 'loading') {
      value = <span className="cl-summary__skeleton" aria-hidden="true" />;
    } else if (state.kind === 'ready') {
      const fraction = progress ? progressFraction(attrs.fn, state.value, attrs.target) : null;
      value = (
        <>
          {progress && (
            <span
              className="cl-summary__bar"
              role="progressbar"
              aria-label={label}
              aria-valuemin={0}
              aria-valuemax={100}
              {...(fraction === null ? {} : { 'aria-valuenow': Math.round(fraction * 100) })}
              data-testid="summary-bar"
            >
              <span className="cl-summary__fill" style={{ width: `${(fraction ?? 0) * 100}%` }} />
            </span>
          )}
          <span className="cl-summary__value" data-testid="summary-value">
            {progress ? progressText(attrs.fn, state.value, attrs.target) : formatValue(attrs.fn, state.value)}
          </span>
        </>
      );
    } else {
      const { text, tip } = placeholder(state, editable);
      const node = (
        <span className={`cl-summary__value cl-summary__value--quiet${state.kind === 'none' ? ' cl-summary__value--action' : ''}`} data-testid="summary-value">
          {text}
        </span>
      );
      value = tip ? <Tooltip content={tip}>{node}</Tooltip> : node;
    }
    const removeButton =
      gone && editable ? (
        <Button
          size="sm"
          variant="ghost"
          data-testid="summary-remove"
          onClick={(e) => {
            e.stopPropagation();
            removeNode();
          }}
        >
          Remove
        </Button>
      ) : null;
    // `display: contents`: the slot only carries the state, the layout sees its children
    return (
      <span className="cl-summary__slot" data-testid="summary-state" data-state={state.kind}>
        {value}
        {removeButton}
      </span>
    );
  };

  const editProps = editable
    ? {
        role: 'button',
        tabIndex: 0,
        'aria-label': `Edit summary: ${label}`,
        onClick: () => setOpen(true),
        onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            setOpen(true);
          }
        },
      }
    : {};
  const data = (
    <SummaryData viewId={attrs.viewId} fn={attrs.fn} column={attrs.column}>
      {renderValue}
    </SummaryData>
  );
  const setRef = (el: HTMLElement | null) => {
    anchor.current = el;
  };

  return (
    <>
      {variant === 'inline' ? (
        <span
          ref={setRef}
          className={`cl-summary cl-summary--inline${editable ? ' cl-summary--editable' : ''}`}
          data-testid="summary-inline"
          {...editProps}
        >
          {data}
        </span>
      ) : (
        <div
          ref={setRef}
          className={`cl-summary cl-summary--block${editable ? ' cl-summary--editable' : ''}`}
          data-testid="summary-block"
          {...editProps}
        >
          <div className="cl-summary__label" data-testid="summary-label">
            {label}
          </div>
          <div className={`cl-summary__row${progress ? ' cl-summary__row--progress' : ''}`}>{data}</div>
        </div>
      )}
      {editable && (
        <SummarySetup
          open={open}
          onClose={() => setOpen(false)}
          anchorRef={anchor}
          variant={variant}
          attrs={attrs}
          pageViewIds={props.pageViewIds}
          setAttrs={setAttrs}
        />
      )}
    </>
  );
}
