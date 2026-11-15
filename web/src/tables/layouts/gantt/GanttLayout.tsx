import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { getPlatform } from '../../../platform';
import { ColorDot, cx } from '../../../ui';
import { projectsForCreate } from '../../store';
import type { LayoutProps, Row, View } from '../../types';
import { doneModel } from '../list/listHelpers';
import { fromDayIndex, toDayIndex, todayString } from './dates';
import {
  HEADER_HEIGHT,
  LIST_WIDTH,
  PX_PER_DAY,
  ROW_HEIGHT,
  SCALES,
  applyDrag,
  axisTicks,
  barRect,
  buildItems,
  computeRange,
  dateColumns,
  dayToX,
  deltaDays,
  dragPatch,
  isSingleDate,
  laneRange,
  readGanttConfig,
  rowColor,
  schedulePatch,
  spanOf,
  timelineWidth,
  visibleRange,
  weekendBlocks,
  xToDay,
  type DragMode,
  type GanttConfig,
  type GanttItem,
  type Scale,
  type Span,
  type Timeline,
} from './model';
import './gantt.css';

/** Pixels the pointer must travel before a press on a bar becomes a drag (below that it is a click). */
const DRAG_THRESHOLD = 4;

interface Drag {
  rowId: string;
  /** 'lane' = scheduling an unscheduled row by dragging in its lane. */
  mode: DragMode | 'lane';
  start: number;
  end: number;
}

type RowItem = Extract<GanttItem, { kind: 'row' }>;

/**
 * Gantt layout: a list of row titles on the left and a time axis on the right. Bars run from the start to
 * the end column; drag a bar to move it, drag an edge to resize it. Rows without dates are listed under
 * "Unscheduled" and get dates by dragging in their lane. Both panes are one scroll area, so they scroll
 * together; the title list sticks to the left edge. Only the rows in the vertical window are drawn.
 */
export function GanttLayout(props: LayoutProps) {
  const { schema, view } = props;
  const cfg = readGanttConfig(schema, view.config);
  if (!cfg) {
    return (
      <div className="cl-gantt" data-testid="gantt-layout">
        <p className="cl-gantt__empty" data-testid="gantt-no-dates">
          This table has no date column to draw bars from.
        </p>
      </div>
    );
  }
  return <GanttBody {...props} cfg={cfg} />;
}

function GanttBody({ schema, view, result, loading, actions, cfg }: LayoutProps & { cfg: GanttConfig }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(600);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loaded, setLoaded] = useState<ReadonlyMap<string, Row[]>>(new Map());
  const [drag, setDrag] = useState<Drag | null>(null);
  const suppressClick = useRef(false);

  const groupBy = view.config.query.groupBy;
  const done = useMemo(() => doneModel(schema), [schema]);
  const today = toDayIndex(todayString()) as number;
  const single = isSingleDate(cfg);
  const startCol = schema.columns.find((c) => c.key === cfg.startColumn);
  const endCol = schema.columns.find((c) => c.key === cfg.endColumn);
  const columnsWritable = !startCol?.readonly && !endCol?.readonly;

  // ---- rows and time range
  const items = useMemo(
    () => buildItems({ result, groupBy, cfg, loaded, expanded }),
    [result, groupBy, cfg.startColumn, cfg.endColumn, loaded, expanded], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const spans = useMemo(() => {
    const map = new Map<string, Span>();
    for (const it of items) if (it.kind === 'row') map.set(it.id, spanOf(it.row, cfg));
    return map;
  }, [items, cfg.startColumn, cfg.endColumn]); // eslint-disable-line react-hooks/exhaustive-deps

  // The left edge only ever moves left, so bars do not jump while the user works
  const originRef = useRef<number | undefined>(undefined);
  const range = computeRange([...spans.values()], today, originRef.current);
  originRef.current = range.origin;
  const timeline: Timeline = { origin: range.origin, last: range.last, scale: cfg.scale, pxPerDay: PX_PER_DAY[cfg.scale] };
  const tlWidth = timelineWidth(timeline);
  const latest = useRef({ timeline, cfg, actions, spans });
  latest.current = { timeline, cfg, actions, spans };

  // ---- scrolling
  const visibleTimelineWidth = () => (scrollRef.current?.clientWidth ?? 1000) - LIST_WIDTH;
  const scrollToDay = useCallback((day: number, fraction = 0.3) => {
    const el = scrollRef.current;
    if (!el) return;
    const t = latest.current.timeline;
    el.scrollLeft = Math.max(0, dayToX(t, day) - (el.clientWidth - LIST_WIDTH) * fraction);
  }, []);

  const anchorDay = useRef<number | null>(null);
  const previous = useRef<{ origin: number; scale: Scale } | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const before = previous.current;
    previous.current = { origin: timeline.origin, scale: timeline.scale };
    if (!before) {
      scrollToDay(today); // first draw: show today
    } else if (before.scale !== timeline.scale) {
      if (anchorDay.current !== null) scrollToDay(anchorDay.current, 0.5);
      anchorDay.current = null;
    } else if (timeline.origin < before.origin) {
      el.scrollLeft += (before.origin - timeline.origin) * timeline.pxPerDay;
    }
  }, [timeline.origin, timeline.scale, timeline.pxPerDay, scrollToDay, today]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewHeight(el.clientHeight || 600);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setViewHeight(el.clientHeight || 600));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function setScale(scale: Scale) {
    if (scale === cfg.scale) return;
    const el = scrollRef.current;
    anchorDay.current = el ? timeline.origin + Math.floor((el.scrollLeft + visibleTimelineWidth() / 2) / timeline.pxPerDay) : null;
    actions.updateConfig({ gantt: { ...cfg, scale } as View['config']['gantt'] });
  }

  function setColumn(patch: Partial<GanttConfig>) {
    actions.updateConfig({ gantt: { ...cfg, ...patch } as View['config']['gantt'] });
  }

  // ---- subtasks
  const fetchChildren = useCallback((id: string) => {
    return latest.current.actions.loadChildren(id).then((rows) => {
      setLoaded((prev) => new Map(prev).set(id, rows));
    });
  }, []);

  function toggle(item: RowItem) {
    const open = expanded.has(item.id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
    if (!open && (item.row.childCount ?? 0) > 0 && !loaded.has(item.id)) fetchChildren(item.id).catch(() => undefined);
  }

  // Children fetched earlier are fetched again when the rows change (edits, live events)
  useEffect(() => {
    for (const id of expanded) if (loaded.has(id)) fetchChildren(id).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  // ---- dragging
  function canWrite(row: Row): boolean {
    return row.canEdit && columnsWritable;
  }

  /** Press on a bar (mode 'move') or one of its edges. A few pixels of travel turn the press into a drag. */
  function onBarPointerDown(e: ReactPointerEvent<HTMLElement>, row: Row, mode: DragMode) {
    if (e.button !== 0 || !canWrite(row)) return;
    e.stopPropagation();
    const span = latest.current.spans.get(row.id);
    if (!span || span.kind === 'none') return;
    const startX = e.clientX;
    let active = false;
    let next = { start: span.start, end: span.end };

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!active && Math.abs(dx) < DRAG_THRESHOLD) return;
      active = true;
      const t = latest.current.timeline;
      next = applyDrag(mode, span, deltaDays(dx, t.pxPerDay), { min: t.origin, max: t.last });
      setDrag({ rowId: row.id, mode, ...next });
    };
    const stop = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('keydown', onKey);
      setDrag(null);
    };
    const onUp = () => {
      stop();
      if (!active) return;
      suppressClick.current = true; // the click that follows a drag must not open the row
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      const patch = dragPatch(latest.current.cfg, mode, span, next);
      if (patch) latest.current.actions.updateRow(row.id, patch).catch(() => undefined);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') stop();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('keydown', onKey);
  }

  /** Press in the empty lane of a row without dates: drag out the dates, release to save them. */
  function onLanePointerDown(e: ReactPointerEvent<HTMLElement>, row: Row) {
    if (e.button !== 0 || !canWrite(row)) return;
    const lane = e.currentTarget;
    const startX = e.clientX;
    const dayAt = (clientX: number) => {
      const t = latest.current.timeline;
      const x = clientX - lane.getBoundingClientRect().left;
      return Math.max(t.origin, Math.min(t.last, xToDay(t, x)));
    };
    const fromDay = dayAt(startX);
    let active = false;
    let next = laneRange(fromDay, fromDay);

    const onMove = (ev: PointerEvent) => {
      if (!active && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return;
      active = true;
      next = laneRange(fromDay, dayAt(ev.clientX));
      setDrag({ rowId: row.id, mode: 'lane', ...next });
    };
    const stop = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('keydown', onKey);
      setDrag(null);
    };
    const onUp = () => {
      stop();
      if (!active) return;
      latest.current.actions.updateRow(row.id, schedulePatch(latest.current.cfg, next)).catch(() => undefined);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') stop();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('keydown', onKey);
  }

  // ---- drawing
  const { from, to } = visibleRange(scrollTop, viewHeight, items.length);
  const ticks = useMemo(() => axisTicks(timeline), [timeline.origin, timeline.last, timeline.scale]); // eslint-disable-line react-hooks/exhaustive-deps
  const weekends = useMemo(
    () => (cfg.scale === 'day' ? weekendBlocks(timeline.origin, timeline.last) : []),
    [cfg.scale, timeline.origin, timeline.last],
  );
  const bodyHeight = items.length * ROW_HEIGHT;

  function renderBar(item: RowItem, span: Span) {
    const preview = drag && drag.rowId === item.id ? drag : null;
    const start = preview ? preview.start : span.start;
    const end = preview ? preview.end : span.end;
    const rect = barRect(timeline, start, end);
    const row = item.row;
    const editable = canWrite(row);
    const isDone = done?.isDone(row) ?? false;
    const color = rowColor(schema, row, item.color);
    const title = String(row.values[schema.titleColumn] ?? '');
    const handleWidth = Math.max(3, Math.min(8, Math.floor(rect.width / 3)));
    const resizable = editable && !single;
    return (
      <div
        className={cx(
          'cl-gantt__bar',
          span.kind === 'marker' && 'is-marker',
          isDone && 'is-done',
          editable && 'is-editable',
          preview && 'is-dragging',
        )}
        data-testid="gantt-bar"
        data-row-id={row.id}
        data-kind={span.kind}
        data-start={fromDayIndex(start)}
        data-end={fromDayIndex(end)}
        style={{ left: rect.left, width: Math.max(rect.width, 4), ...(color ? { background: color } : {}) }}
        title={`${title}: ${fromDayIndex(start)} to ${fromDayIndex(end)}`}
        onPointerDown={(e) => onBarPointerDown(e, row, 'move')}
        onClick={() => {
          if (!suppressClick.current) actions.openRow(row.id);
        }}
      >
        {resizable && (
          <span
            className="cl-gantt__handle is-start"
            data-testid="gantt-handle-start"
            style={{ width: handleWidth }}
            onPointerDown={(e) => onBarPointerDown(e, row, 'start')}
          />
        )}
        {rect.width >= 70 && <span className="cl-gantt__bar-label">{title}</span>}
        {resizable && (
          <span
            className="cl-gantt__handle is-end"
            data-testid="gantt-handle-end"
            style={{ width: handleWidth }}
            onPointerDown={(e) => onBarPointerDown(e, row, 'end')}
          />
        )}
      </div>
    );
  }

  function renderLane(item: RowItem) {
    const span = spans.get(item.id) ?? spanOf(item.row, cfg);
    const preview = drag && drag.rowId === item.id ? drag : null;
    if (span.kind === 'none') {
      const rect = preview ? barRect(timeline, preview.start, preview.end) : null;
      return (
        <div
          className={cx('cl-gantt__lane', 'is-empty', canWrite(item.row) && 'is-schedulable')}
          data-testid="gantt-lane"
          data-row-id={item.id}
          onPointerDown={(e) => onLanePointerDown(e, item.row)}
        >
          {rect && (
            <div
              className="cl-gantt__bar is-dragging"
              data-testid="gantt-bar-preview"
              data-start={fromDayIndex(preview!.start)}
              data-end={fromDayIndex(preview!.end)}
              style={{ left: rect.left, width: rect.width, ...(rowColor(schema, item.row, item.color) ? { background: rowColor(schema, item.row, item.color) } : {}) }}
            />
          )}
        </div>
      );
    }
    return (
      <div className="cl-gantt__lane" data-testid="gantt-lane" data-row-id={item.id}>
        {renderBar(item, span)}
      </div>
    );
  }

  function renderListCell(item: GanttItem) {
    if (item.kind === 'group') {
      return (
        <div className="cl-gantt__cell is-group" data-testid="gantt-group">
          {item.color && <ColorDot color={item.color} />}
          <span className="cl-gantt__group-name">{item.label}</span>
          <span className="cl-gantt__count">{item.count}</span>
        </div>
      );
    }
    if (item.kind === 'unscheduled') {
      return (
        <div className="cl-gantt__cell is-group" data-testid="gantt-unscheduled">
          <span className="cl-gantt__group-name">Unscheduled</span>
          <span className="cl-gantt__count">{item.count}</span>
        </div>
      );
    }
    const title = String(item.row.values[schema.titleColumn] ?? '').trim();
    return (
      <div
        className={cx('cl-gantt__cell', done?.isDone(item.row) && 'is-done')}
        style={{ paddingLeft: 8 + item.depth * 16 }}
        data-testid="gantt-row"
        data-row-id={item.id}
      >
        {item.expandable ? (
          <button
            type="button"
            className="cl-gantt__expander"
            aria-label={`${item.expanded ? 'Collapse' : 'Expand'} ${title || 'row'}`}
            aria-expanded={item.expanded}
            data-testid="gantt-expand"
            onClick={() => toggle(item)}
          >
            {item.expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="cl-gantt__expander-gap" />
        )}
        <span className="cl-gantt__title" data-testid="gantt-row-title" title={title} onClick={() => actions.openRow(item.id)}>
          {title || 'Untitled'}
        </span>
      </div>
    );
  }

  const visible = items.slice(from, to);
  const todayX = dayToX(timeline, today) + timeline.pxPerDay / 2;
  const dates = dateColumns(schema);

  return (
    <div className="cl-gantt" data-testid="gantt-layout" data-scale={cfg.scale} aria-busy={loading || undefined}>
      <div className="cl-gantt__toolbar">
        <div className="cl-gantt__scales" role="group" aria-label="Time scale">
          {SCALES.map((s) => (
            <button
              key={s}
              type="button"
              className={cx('cl-gantt__scale', cfg.scale === s && 'is-active')}
              aria-pressed={cfg.scale === s}
              data-testid={`gantt-scale-${s}`}
              onClick={() => setScale(s)}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <button type="button" className="cl-gantt__today-btn" data-testid="gantt-today" onClick={() => scrollToDay(today, 0.4)}>
          Today
        </button>
        {dates.length > 1 && (
          <>
            <label className="cl-gantt__select">
              Start
              <select value={cfg.startColumn} data-testid="gantt-start-column" onChange={(e) => setColumn({ startColumn: e.target.value })}>
                {dates.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="cl-gantt__select">
              End
              <select value={cfg.endColumn} data-testid="gantt-end-column" onChange={(e) => setColumn({ endColumn: e.target.value })}>
                {dates.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {schema.capabilities.create && <QuickAdd schema={schema} view={view} actions={actions} />}
      </div>
      <div
        className="cl-gantt__scroll"
        ref={scrollRef}
        data-testid="gantt-scroll"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div className="cl-gantt__canvas" style={{ width: LIST_WIDTH + tlWidth }}>
          <div className="cl-gantt__head" style={{ height: HEADER_HEIGHT }}>
            <div className="cl-gantt__corner" style={{ width: LIST_WIDTH }}>
              {single ? `${startCol?.name ?? 'Date'}` : 'Name'}
            </div>
            <div className="cl-gantt__axis" style={{ width: tlWidth }} data-testid="gantt-axis">
              {ticks.top.map((t) => (
                <div key={`t${t.day}`} className="cl-gantt__tick is-top" style={{ left: t.left, width: t.width, height: HEADER_HEIGHT / 2 }}>
                  <span>{t.label}</span>
                </div>
              ))}
              {ticks.bottom.map((t) => (
                <div
                  key={`b${t.day}`}
                  className={cx('cl-gantt__tick', 'is-bottom', t.weekend && 'is-weekend')}
                  style={{ left: t.left, width: t.width, top: HEADER_HEIGHT / 2, height: HEADER_HEIGHT / 2 }}
                  data-testid="gantt-tick"
                  data-date={fromDayIndex(t.day)}
                >
                  <span>{t.label}</span>
                </div>
              ))}
              <div className="cl-gantt__today-flag" style={{ left: todayX }} />
            </div>
          </div>
          <div className="cl-gantt__body" style={{ height: bodyHeight }}>
            <div className="cl-gantt__list" style={{ width: LIST_WIDTH, height: bodyHeight }} data-testid="gantt-list">
              {visible.map((item, i) => (
                <div key={item.id} className="cl-gantt__line" style={{ top: (from + i) * ROW_HEIGHT, height: ROW_HEIGHT }}>
                  {renderListCell(item)}
                </div>
              ))}
              {items.length === 0 && !loading && <p className="cl-gantt__empty">No rows</p>}
            </div>
            <div className="cl-gantt__timeline" style={{ width: tlWidth, height: bodyHeight }} data-testid="gantt-timeline">
              {weekends.map((w) => (
                <div
                  key={w.day}
                  className="cl-gantt__weekend"
                  data-testid="gantt-weekend"
                  style={{ left: dayToX(timeline, w.day), width: w.days * timeline.pxPerDay }}
                />
              ))}
              <div className="cl-gantt__today-line" data-testid="gantt-today-line" style={{ left: todayX - 1 }} />
              {visible.map((item, i) => (
                <div
                  key={item.id}
                  className={cx('cl-gantt__line', item.kind !== 'row' && 'is-section')}
                  style={{ top: (from + i) * ROW_HEIGHT, height: ROW_HEIGHT }}
                >
                  {item.kind === 'row' && renderLane(item)}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** A title input in the toolbar: adds a row without dates (it lands in "Unscheduled"). */
function QuickAdd({ schema, view, actions }: Pick<LayoutProps, 'schema' | 'view' | 'actions'>) {
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const everything = view.tableRef === 'tasks:*';
  const projects = everything ? projectsForCreate() : [];

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = title.trim();
    if (!text) return;
    let opts: { projectId: string } | undefined;
    if (everything) {
      const chosen = projectId || projects[0]?.id;
      if (!chosen) {
        getPlatform().toast('error', 'You have no project to add a task to');
        return;
      }
      opts = { projectId: chosen };
    }
    actions.createRow({ [schema.titleColumn]: text }, opts).catch(() => undefined);
    setTitle('');
  }

  return (
    <form className="cl-gantt__add" onSubmit={submit} data-testid="gantt-add-form">
      <input
        className="cl-gantt__add-input"
        aria-label="New row"
        placeholder="+ New row"
        value={title}
        data-testid="gantt-add-input"
        onChange={(e) => setTitle(e.target.value)}
      />
      {projects.length > 1 && (
        <select aria-label="Project" value={projectId || projects[0]!.id} onChange={(e) => setProjectId(e.target.value)}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </form>
  );
}
