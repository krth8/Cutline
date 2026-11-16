import { CHAR_WIDTH, compactNumber, formatNumber, labelPlan, markName, niceTicks, truncate } from './model';
import { TooltipBox, useTooltip, type RendererProps } from './parts';

const TICK_PAD = 8;
const SIDE = 14;

/** A line through the groups in their order (dates, numbers, options), with a point per group and the same light axis as the bars. */
export function LineChart({ points, size, measure, integer }: RendererProps) {
  const { wrapRef, tip, markProps } = useTooltip();
  const values = points.map((p) => p.value ?? 0);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), size.height < 220 ? 3 : 4, integer);
  const tickWidth = Math.max(...ticks.ticks.map((t) => compactNumber(t).length)) * CHAR_WIDTH;
  const left = Math.ceil(tickWidth) + TICK_PAD + 4;
  const right = 12;
  const top = 20;
  const n = points.length;
  const span = Math.max(20, size.width - left - right - SIDE * 2);
  const step = n > 1 ? span / (n - 1) : span;
  const plan = labelPlan(points.map((p) => p.label), step);
  const bottom = plan.rotate ? 12 + Math.ceil(plan.maxChars * CHAR_WIDTH * 0.64) : 26;
  const plotW = size.width - left - right;
  const plotH = Math.max(40, size.height - top - bottom);
  const y = (v: number) => top + plotH * (1 - (v - ticks.min) / (ticks.max - ticks.min));
  const xAt = (i: number) => left + SIDE + (n > 1 ? step * i : span / 2);
  const color = 'var(--cl-chart-1)';
  const showValues = n <= 14 && step >= 30;

  // One path per run of points that have a value: a missing value breaks the line
  const segments: string[] = [];
  let run = '';
  points.forEach((p, i) => {
    if (p.value === null) {
      if (run) segments.push(run);
      run = '';
    } else {
      run += `${run ? 'L' : 'M'}${xAt(i).toFixed(1)} ${y(p.value).toFixed(1)}`;
    }
  });
  if (run) segments.push(run);

  return (
    <div ref={wrapRef} className="cl-chart__plot" data-testid="chart-plot">
      <svg width={size.width} height={size.height} role="group" aria-label={`Line chart of ${measure}`} className="cl-chart__svg">
        {ticks.ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? 'cl-chart__axis' : 'cl-chart__grid'} x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} />
            <text className="cl-chart__tick" x={left - TICK_PAD} y={y(t)} textAnchor="end" dominantBaseline="middle">
              {compactNumber(t)}
            </text>
          </g>
        ))}
        {segments.map((d) => (
          <path key={d} className="cl-chart__line" d={d} stroke={color} fill="none" />
        ))}
        {points.map((p, i) => {
          const cx = xAt(i);
          const label = i % plan.stride === 0 && (
            <text
              className="cl-chart__label"
              x={plan.rotate ? cx + 4 : cx}
              y={top + plotH + (plan.rotate ? 12 : 16)}
              textAnchor={plan.rotate ? 'end' : 'middle'}
              transform={plan.rotate ? `rotate(-40 ${cx + 4} ${top + plotH + 12})` : undefined}
            >
              {truncate(p.label, plan.maxChars)}
            </text>
          );
          return (
            <g key={p.key ?? 'none'} className="cl-chart__mark">
              {p.value !== null && <circle className="cl-chart__dot" cx={cx} cy={y(p.value)} r={4} fill={color} />}
              {p.value !== null && showValues && (
                <text className="cl-chart__value" x={cx} y={y(p.value) - 9} textAnchor="middle">
                  {compactNumber(p.value)}
                </text>
              )}
              {label}
              <rect
                className="cl-chart__hit"
                x={cx - Math.max(step, 24) / 2}
                y={top}
                width={Math.max(step, 24)}
                height={plotH}
                {...markProps(p, markName(p), p.value === null ? 'No value' : formatNumber(p.value))}
              />
            </g>
          );
        })}
      </svg>
      <TooltipBox tip={tip} width={size.width} />
    </div>
  );
}
