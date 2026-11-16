import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Button } from '../../../../ui';
import { BarChart } from './BarChart';
import { ChartData, type ChartState } from './ChartData';
import { ChartSetup } from './ChartSetup';
import { DonutChart } from './DonutChart';
import { LineChart } from './LineChart';
import {
  DEFAULT_HEIGHT,
  MAX_HEIGHT,
  MIN_HEIGHT,
  addsUp,
  clampHeight,
  mergeOther,
  measureLabel,
  percents,
  type ChartAttrs,
} from './model';
import { DataTable, useElementSize } from './parts';
import './chart.css';

export interface ChartContentProps {
  attrs: ChartAttrs;
  /** The editor accepts changes: a click opens the settings, the bottom edge resizes, a deleted view can be removed. */
  editable: boolean;
  /** Open the settings right away (a node that was just inserted and has no view yet). */
  autoOpen: boolean;
  /** Identifies this chart across rebuilds of its node view (editor and position among the charts). */
  openKey?: string;
  /** Ids of the view blocks on this page; the picker lists them first. */
  pageViewIds(): string[];
  /** Write node attributes into the document. */
  setAttrs(patch: Partial<ChartAttrs>): void;
  /** Take the node out of the document. */
  removeNode(): void;
}

/** Charts whose settings are open, by `openKey`. */
const openKeys = new Set<string>();

const NO_ACCESS = "You don't have access to this view";

/**
 * A chart over a view: the frame (title, fixed height, settings, resize edge) and, inside it, whatever the
 * data allows: a skeleton, a quiet note, or the bar, line or donut. The frame has its height from the first
 * paint on, so nothing jumps when data arrives.
 */
export function ChartContent(props: ChartContentProps) {
  const { attrs, editable, autoOpen, setAttrs, removeNode } = props;
  const frameRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  // The settings stay open when the collaboration layer rebuilds the node view (it does when attributes change):
  // the open state is kept per `openKey` outside the component.
  const [open, setOpenState] = useState(() => !!props.openKey && openKeys.has(props.openKey));
  const setOpen = (value: boolean) => {
    if (props.openKey) {
      if (value) openKeys.add(props.openKey);
      else openKeys.delete(props.openKey);
    }
    setOpenState(value);
  };
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const size = useElementSize(bodyRef);
  const height = dragHeight ?? clampHeight(attrs.height) ?? DEFAULT_HEIGHT;

  // Settings are taller than the space under a chart near the bottom of the window: bring the chart up first
  useEffect(() => {
    const frame = frameRef.current;
    if (open && frame && frame.getBoundingClientRect().top + 540 > window.innerHeight) frame.scrollIntoView?.({ block: 'start' });
  }, [open]);

  useEffect(() => {
    if (autoOpen && editable) setOpen(true);
  }, [autoOpen, editable]);

  const note = (text: ReactNode, state: string, extra?: ReactNode) => (
    <div className="cl-chart__note" data-testid="chart-state" data-state={state}>
      <span>{text}</span>
      {extra}
    </div>
  );

  const renderBody = (state: ChartState): ReactNode => {
    switch (state.kind) {
      case 'none':
        return editable ? (
          note(
            'Choose a view to chart',
            'none',
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)} data-testid="chart-choose">
              Set up
            </Button>,
          )
        ) : (
          note('No view chosen', 'none')
        );
      case 'loading':
        return (
          <div className="cl-chart__skeleton" data-testid="chart-state" data-state="loading" aria-hidden="true">
            {[55, 80, 40, 65, 30].map((h, i) => (
              <span key={i} style={{ height: `${h}%` }} />
            ))}
          </div>
        );
      case 'denied':
        return note(NO_ACCESS, 'denied');
      case 'gone':
        return note(
          'View deleted',
          'gone',
          editable && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="chart-remove"
              onClick={(e) => {
                e.stopPropagation();
                removeNode();
              }}
            >
              Remove
            </Button>
          ),
        );
      case 'problem':
        return note(state.reason, 'problem');
      case 'error':
        return note(`Could not load this chart: ${state.message}`, 'error');
      case 'ready':
        break;
    }

    const measure = measureLabel(attrs.fn, state.measureColumn);
    if (state.total === 0 || state.points.length === 0) return note('No rows to chart', 'empty');
    if (!state.points.some((p) => p.value)) return note('Nothing to chart: every value is 0', 'empty');

    // A donut draws positive values only, at most eight slices
    const slices = attrs.type === 'donut' ? mergeOther(state.points.filter((p) => (p.value ?? 0) > 0)) : state.points;
    const shares = attrs.type === 'donut' && addsUp(attrs.fn);
    const caption = attrs.title.trim() || `${measure} by ${state.groupColumn.name}`;
    const common = { points: slices, size, measure, integer: attrs.fn === 'count' };
    return (
      <div className="cl-chart__ready" data-testid="chart-state" data-state="ready" data-type={attrs.type}>
        {attrs.type === 'bar' && <BarChart {...common} />}
        {attrs.type === 'line' && <LineChart {...common} />}
        {attrs.type === 'donut' && <DonutChart {...common} fn={attrs.fn} />}
        <DataTable
          caption={caption}
          groupName={state.groupColumn.name}
          measure={measure}
          points={state.points}
          percents={shares ? percents(state.points) : undefined}
        />
      </div>
    );
  };

  const onFrameClick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, [role=separator]')) return;
    setOpen(true);
  };

  return (
    <>
      <div
        ref={frameRef}
        className={`cl-chart${editable ? ' cl-chart--editable' : ''}`}
        data-testid="chart"
        data-type={attrs.type}
        style={{ height }}
        onClick={editable ? onFrameClick : undefined}
      >
        {(attrs.title.trim() || editable) && (
          <div ref={headRef} className="cl-chart__head">
            <span className="cl-chart__title" data-testid="chart-title">
              {attrs.title.trim()}
            </span>
            {editable && (
              <button
                type="button"
                className="cl-chart__gear"
                aria-label="Chart settings"
                data-testid="chart-settings-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(true);
                }}
              >
                ⚙
              </button>
            )}
          </div>
        )}
        <div ref={bodyRef} className="cl-chart__body">
          <ChartData viewId={attrs.viewId} attrs={attrs}>
            {renderBody}
          </ChartData>
        </div>
        {editable && <ResizeEdge height={height} frameRef={frameRef} onLive={setDragHeight} onDone={(h) => setAttrs({ height: h })} />}
      </div>
      {editable && (
        <ChartSetup open={open} onClose={() => setOpen(false)} anchorRef={headRef} attrs={attrs} pageViewIds={props.pageViewIds} setAttrs={setAttrs} />
      )}
    </>
  );
}

/** The bottom edge: drag (or use the arrow keys) to change the height; a double click goes back to the default. */
function ResizeEdge({
  height,
  frameRef,
  onLive,
  onDone,
}: {
  height: number;
  frameRef: React.RefObject<HTMLDivElement | null>;
  onLive(h: number | null): void;
  onDone(h: number | null): void;
}) {
  function start(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    const startHeight = frameRef.current?.getBoundingClientRect().height || height;
    let last = startHeight;
    const move = (ev: PointerEvent) => {
      last = clampHeight(startHeight + ev.clientY - startY) ?? startHeight;
      onLive(last);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      onLive(null);
      onDone(last);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  }
  function key(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.key === 'ArrowDown' ? 20 : e.key === 'ArrowUp' ? -20 : 0;
    if (!step) return;
    e.preventDefault();
    onDone(clampHeight(height + step));
  }
  return (
    <div
      className="cl-chart__resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the chart"
      aria-valuemin={MIN_HEIGHT}
      aria-valuemax={MAX_HEIGHT}
      aria-valuenow={height}
      tabIndex={0}
      data-testid="chart-resize"
      onPointerDown={start}
      onKeyDown={key}
      onDoubleClick={() => onDone(null)}
    />
  );
}
