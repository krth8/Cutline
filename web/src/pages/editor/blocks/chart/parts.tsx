/**
 * Pieces shared by the three renderers: the size of the box a chart fills, the hover/focus tooltip, the
 * props every mark gets (focusable, with an accessible name) and the visually hidden data table.
 */
import { useCallback, useEffect, useRef, useState, type FocusEvent, type MouseEvent, type RefObject } from 'react';
import { formatNumber, type Point } from './model';

export interface Size {
  width: number;
  height: number;
}

/** Shared by every renderer. */
export interface RendererProps {
  points: Point[];
  size: Size;
  /** Number of the measure, e.g. "Count" or "Sum of Estimate"; used in the tooltip. */
  measure: string;
  /** Counts never get ticks between whole numbers. */
  integer: boolean;
}

const FALLBACK: Size = { width: 560, height: 220 };

/** The inner size of an element, kept up to date with a ResizeObserver (a fixed fallback where there is none). */
export function useElementSize(ref: RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>(FALLBACK);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => {
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      if (w > 0 && h > 0) setSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

interface Tip {
  x: number;
  y: number;
  title: string;
  value: string;
}

/** The tooltip state of one chart and the props that make a mark show it on hover and on keyboard focus. */
export function useTooltip() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  const show = useCallback((el: Element, title: string, value: string, at?: { x: number; y: number }) => {
    const wrap = wrapRef.current?.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    if (!wrap) return;
    setTip({
      x: at ? at.x - wrap.left : box.left - wrap.left + box.width / 2,
      y: at ? at.y - wrap.top : box.top - wrap.top,
      title,
      value,
    });
  }, []);
  const hide = useCallback(() => setTip(null), []);

  /** Props for one mark: focusable, named, and showing the tooltip with the exact value. */
  const markProps = (p: Point, name: string, value: string) => ({
    tabIndex: 0,
    role: 'img' as const,
    'aria-label': name,
    'data-testid': 'chart-mark',
    'data-key': p.key ?? '',
    onMouseEnter: (e: MouseEvent<Element>) => show(e.currentTarget, p.full, value, { x: e.clientX, y: e.clientY }),
    onMouseMove: (e: MouseEvent<Element>) => show(e.currentTarget, p.full, value, { x: e.clientX, y: e.clientY }),
    onMouseLeave: hide,
    onFocus: (e: FocusEvent<Element>) => show(e.currentTarget, p.full, value),
    onBlur: hide,
  });

  return { wrapRef, tip, markProps };
}

/** The tooltip box, placed above the mark and kept inside the chart. */
export function TooltipBox({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const x = Math.min(Math.max(tip.x, 70), Math.max(70, width - 70));
  // Near the top of the chart there is no room above the mark: show the tooltip under it
  const below = tip.y < 52;
  return (
    <div
      className={`cl-chart__tip${below ? ' cl-chart__tip--below' : ''}`}
      role="tooltip"
      data-testid="chart-tip"
      style={{ left: x, top: below ? tip.y + 22 : tip.y - 8 }}
    >
      <span className="cl-chart__tip-title">{tip.title}</span>
      <span className="cl-chart__tip-value">{tip.value}</span>
    </div>
  );
}

/** The data as a table that only assistive technology sees: the text alternative of the chart. */
export function DataTable({
  caption,
  groupName,
  measure,
  points,
  percents,
}: {
  caption: string;
  groupName: string;
  measure: string;
  points: Point[];
  percents?: Array<number | null>;
}) {
  return (
    <table className="cl-chart__sr" data-testid="chart-table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">{groupName}</th>
          <th scope="col">{measure}</th>
          {percents && <th scope="col">Share</th>}
        </tr>
      </thead>
      <tbody>
        {points.map((p, i) => (
          <tr key={p.key ?? 'none'}>
            <th scope="row">{p.full}</th>
            <td>{p.value === null ? 'No value' : formatNumber(p.value)}</td>
            {percents && <td>{percents[i] === null || percents[i] === undefined ? '' : `${percents[i]}%`}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
