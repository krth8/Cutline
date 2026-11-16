import { addsUp, formatNumber, markName, percents, type ChartFn, type Point } from './model';
import { TooltipBox, useTooltip, type RendererProps } from './parts';

/** The path of a ring slice between two angles (radians, 0 = top, clockwise). */
export function arcPath(cx: number, cy: number, outer: number, inner: number, from: number, to: number): string {
  const end = Math.min(to, from + Math.PI * 2 - 0.0001);
  const pt = (r: number, a: number) => `${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`;
  const large = end - from > Math.PI ? 1 : 0;
  return `M${pt(outer, from)}A${outer} ${outer} 0 ${large} 1 ${pt(outer, end)}L${pt(inner, end)}A${inner} ${inner} 0 ${large} 0 ${pt(inner, from)}Z`;
}

/** Slices (already merged to at most eight), a total in the middle and a legend with values and percentages. */
export function DonutChart({ points, size, measure, fn }: RendererProps & { fn: ChartFn }) {
  const { wrapRef, tip, markProps } = useTooltip();
  const shares = addsUp(fn);
  const pct = shares ? percents(points) : points.map(() => null);
  const total = points.reduce((s, p) => s + Math.max(0, p.value ?? 0), 0);
  const wide = size.width >= 360;
  const diameter = Math.max(80, wide ? Math.min(size.height - 8, Math.floor(size.width * 0.5)) : Math.min(size.width - 8, Math.floor(size.height * 0.62)));
  const r = diameter / 2;
  const inner = r * 0.62;

  let angle = 0;
  const slices = points.map((p, i) => {
    const sweep = total > 0 ? (Math.max(0, p.value ?? 0) / total) * Math.PI * 2 : 0;
    const from = angle;
    angle += sweep;
    return { p, i, from, to: angle };
  });

  return (
    <div ref={wrapRef} className={`cl-chart__plot cl-chart__donut${wide ? ' cl-chart__donut--wide' : ''}`} data-testid="chart-plot">
      <svg width={diameter} height={diameter} role="group" aria-label={`Donut chart of ${measure}`} className="cl-chart__svg cl-chart__ring">
        {slices.map(({ p, i, from, to }) => (
          <g key={p.key ?? 'none'} className="cl-chart__mark">
            <path
              className="cl-chart__slice"
              d={arcPath(r, r, r - 1, inner, from, to)}
              fill={p.color}
              {...markProps(p, markName(p, pct[i] ?? null), valueText(p, pct[i] ?? null))}
            />
          </g>
        ))}
        <text className="cl-chart__total" x={r} y={shares ? r - 2 : r} textAnchor="middle" dominantBaseline="middle" data-testid="chart-total">
          {shares ? formatNumber(total) : ''}
        </text>
        {shares && (
          <text className="cl-chart__total-label" x={r} y={r + 16} textAnchor="middle">
            {measure.length > 18 ? 'Total' : measure}
          </text>
        )}
      </svg>
      <ul className="cl-chart__legend" data-testid="chart-legend">
        {points.map((p, i) => (
          <li key={p.key ?? 'none'} className="cl-chart__legend-item">
            <span className="cl-chart__swatch" style={{ background: p.color }} aria-hidden="true" />
            <span className="cl-chart__legend-label" title={p.full}>
              {p.label}
            </span>
            <span className="cl-chart__legend-value">{p.value === null ? '—' : formatNumber(p.value)}</span>
            {shares && <span className="cl-chart__legend-pct">{pct[i] === null ? '' : `${pct[i]}%`}</span>}
          </li>
        ))}
      </ul>
      <TooltipBox tip={tip} width={size.width} />
    </div>
  );
}

function valueText(p: Point, percent: number | null): string {
  const v = p.value === null ? 'No value' : formatNumber(p.value);
  return percent === null ? v : `${v} (${percent}%)`;
}
