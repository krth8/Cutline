import { CHAR_WIDTH, chooseOrientation, compactNumber, formatNumber, labelPlan, markName, niceTicks, truncate } from './model';
import { TooltipBox, useTooltip, type RendererProps } from './parts';

const TICK_PAD = 8;

/** Bars: vertical, or sideways when there are many categories or long labels. Value labels, a light axis with round ticks. */
export function BarChart({ points, size, measure, integer }: RendererProps) {
  const { wrapRef, tip, markProps } = useTooltip();
  const values = points.map((p) => p.value ?? 0);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), size.height < 220 ? 3 : 4, integer);
  const horizontal = chooseOrientation(points.map((p) => p.label), size.width) === 'horizontal';
  const common = { points, size, ticks, measure, markProps };
  return (
    <div ref={wrapRef} className="cl-chart__plot" data-orientation={horizontal ? 'horizontal' : 'vertical'} data-testid="chart-plot">
      {horizontal ? <Sideways {...common} /> : <Upright {...common} />}
      <TooltipBox tip={tip} width={size.width} />
    </div>
  );
}

interface Inner extends Pick<RendererProps, 'points' | 'size' | 'measure'> {
  ticks: ReturnType<typeof niceTicks>;
  markProps: ReturnType<typeof useTooltip>['markProps'];
}

function Upright({ points, size, ticks, measure, markProps }: Inner) {
  const tickWidth = Math.max(...ticks.ticks.map((t) => compactNumber(t).length)) * CHAR_WIDTH;
  const left = Math.ceil(tickWidth) + TICK_PAD + 4;
  const right = 8;
  const top = 20;
  const plotW = Math.max(40, size.width - left - right);
  const slot = plotW / points.length;
  const plan = labelPlan(points.map((p) => p.label), slot);
  const bottom = plan.rotate ? 12 + Math.ceil(plan.maxChars * CHAR_WIDTH * 0.64) : 26;
  const plotH = Math.max(40, size.height - top - bottom);
  const y = (v: number) => top + plotH * (1 - (v - ticks.min) / (ticks.max - ticks.min));
  const zero = y(0);
  const barW = Math.min(slot * 0.7, 64);

  return (
    <svg width={size.width} height={size.height} role="group" aria-label={`Bar chart of ${measure}`} className="cl-chart__svg">
      {ticks.ticks.map((t) => (
        <g key={t}>
          <line className={t === 0 ? 'cl-chart__axis' : 'cl-chart__grid'} x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} />
          <text className="cl-chart__tick" x={left - TICK_PAD} y={y(t)} textAnchor="end" dominantBaseline="middle">
            {compactNumber(t)}
          </text>
        </g>
      ))}
      {points.map((p, i) => {
        const cx = left + slot * i + slot / 2;
        const v = p.value;
        const top0 = v === null ? zero : Math.min(y(v), zero);
        const h = v === null ? 0 : Math.max(v === 0 ? 0 : 1, Math.abs(y(v) - zero));
        const valueText = v === null ? '' : compactNumber(v);
        const showValue = v !== null && slot >= valueText.length * CHAR_WIDTH + 4;
        return (
          <g key={p.key ?? 'none'} className="cl-chart__mark">
            <rect className="cl-chart__bar" x={cx - barW / 2} y={top0} width={barW} height={h} rx={2} fill={p.color} />
            {showValue && (
              <text className="cl-chart__value" x={cx} y={(v ?? 0) >= 0 ? top0 - 5 : top0 + h + 12} textAnchor="middle">
                {valueText}
              </text>
            )}
            <rect
              className="cl-chart__hit"
              x={left + slot * i}
              y={top}
              width={slot}
              height={plotH}
              {...markProps(p, markName(p), p.value === null ? 'No value' : formatNumber(p.value))}
            />
            {i % plan.stride === 0 &&
              (plan.rotate ? (
                <text className="cl-chart__label" x={cx + 4} y={top + plotH + 12} textAnchor="end" transform={`rotate(-40 ${cx + 4} ${top + plotH + 12})`}>
                  {truncate(p.label, plan.maxChars)}
                </text>
              ) : (
                <text className="cl-chart__label" x={cx} y={top + plotH + 16} textAnchor="middle">
                  {truncate(p.label, plan.maxChars)}
                </text>
              ))}
          </g>
        );
      })}
    </svg>
  );
}

const ROW = 22;

function Sideways({ points, size, ticks, measure, markProps }: Inner) {
  const longest = Math.max(...points.map((p) => p.label.length));
  const labelW = Math.min(Math.ceil(longest * CHAR_WIDTH) + 12, Math.floor(size.width * 0.4), 190);
  const maxChars = Math.max(3, Math.floor((labelW - 12) / CHAR_WIDTH));
  const right = 46;
  const top = 4;
  const bottom = 24;
  const height = Math.max(size.height, top + bottom + points.length * ROW);
  const plotW = Math.max(40, size.width - labelW - right);
  const plotH = height - top - bottom;
  const row = plotH / points.length;
  const x = (v: number) => labelW + plotW * ((v - ticks.min) / (ticks.max - ticks.min));
  const zero = x(0);
  const barH = Math.min(row * 0.7, 20);

  return (
    <svg width={size.width} height={height} role="group" aria-label={`Bar chart of ${measure}`} className="cl-chart__svg">
      {ticks.ticks.map((t) => (
        <g key={t}>
          <line className={t === 0 ? 'cl-chart__axis' : 'cl-chart__grid'} x1={x(t)} x2={x(t)} y1={top} y2={top + plotH} />
          <text className="cl-chart__tick" x={x(t)} y={top + plotH + 15} textAnchor="middle">
            {compactNumber(t)}
          </text>
        </g>
      ))}
      {points.map((p, i) => {
        const cy = top + row * i + row / 2;
        const v = p.value;
        const x0 = v === null ? zero : Math.min(x(v), zero);
        const w = v === null ? 0 : Math.max(v === 0 ? 0 : 1, Math.abs(x(v) - zero));
        return (
          <g key={p.key ?? 'none'} className="cl-chart__mark">
            <rect className="cl-chart__bar" x={x0} y={cy - barH / 2} width={w} height={barH} rx={2} fill={p.color} />
            {v !== null && (
              <text className="cl-chart__value" x={(v >= 0 ? x0 + w : x0) + (v >= 0 ? 5 : -5)} y={cy} textAnchor={v >= 0 ? 'start' : 'end'} dominantBaseline="middle">
                {compactNumber(v)}
              </text>
            )}
            <text className="cl-chart__label" x={labelW - 8} y={cy} textAnchor="end" dominantBaseline="middle">
              {truncate(p.label, maxChars)}
            </text>
            <rect
              className="cl-chart__hit"
              x={0}
              y={top + row * i}
              width={size.width}
              height={row}
              {...markProps(p, markName(p), p.value === null ? 'No value' : formatNumber(p.value))}
            />
          </g>
        );
      })}
    </svg>
  );
}
