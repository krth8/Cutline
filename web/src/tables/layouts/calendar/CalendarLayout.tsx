import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { getPlatform } from '../../../platform';
import { Popover, cx } from '../../../ui';
import { ProjectSelect, useAddProject } from '../../addProject';
import type { LayoutProps, Row, View } from '../../types';
import { doneModel } from '../list/listHelpers';
import {
  MONTH_NAMES,
  WEEKDAY_NAMES,
  addDays,
  addMonths,
  dayOfMonth,
  diffDays,
  monthGrid,
  monthTitle,
  sameMonth,
  startOfMonth,
  startOfWeek,
  todayYmd,
  weekOf,
  weekTitle,
  type Ymd,
} from './dates';
import {
  createValues,
  dateColumnsOf,
  itemColor,
  itemPatch,
  itemsOnDay,
  layoutWeek,
  movedItem,
  readCalendarConfig,
  resizedItem,
  schedulePatch,
  splitRows,
  type CalendarConfig,
  type CalendarItem,
  type CalendarMode,
  type Segment,
} from './model';
import './calendar.css';

/** Pixels the pointer must travel before a press becomes a drag (below that it is a click). */
const DRAG_THRESHOLD = 4;
const MAX_LANES: Record<CalendarMode, number> = { month: 3, week: 12 };

type DragKind = 'move' | 'resize' | 'schedule';

interface DragState {
  kind: DragKind;
  rowId: string;
  /** Day under the pointer when the press started (move). */
  grabDay: Ymd | null;
  over: Ymd | null;
  x: number;
  y: number;
}

/** The day cell under a point. Bars sit above the cells, so every element at the point is checked. */
function dayAt(x: number, y: number): Ymd | null {
  const stack = typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(x, y) : [];
  for (const el of stack) {
    const cell = el.closest<HTMLElement>('[data-day]');
    if (cell?.dataset.day) return cell.dataset.day;
  }
  return null;
}

/**
 * Calendar layout: month or week grid; a row sits on its date, or spans the days from its date to the
 * end column's date. Bars drag to another day (both dates move) and, with an end column, resize at the
 * right edge. Rows without a date wait in a side list and are dragged onto a day. A click on an empty
 * day adds a row there. Dates are plain 'YYYY-MM-DD' strings throughout.
 */
export function CalendarLayout({ schema, view, result, loading, actions }: LayoutProps) {
  const cfg = readCalendarConfig(schema, view.config);
  if (!cfg) {
    return (
      <div className="cl-cal" data-testid="calendar-layout">
        <p className="cl-cal__empty" data-testid="calendar-no-column">
          This table has no date column to build a calendar from.
        </p>
      </div>
    );
  }
  return <Calendar cfg={cfg} schema={schema} view={view} result={result} loading={loading} actions={actions} />;
}

function Calendar({ cfg, schema, view, result, loading, actions }: LayoutProps & { cfg: CalendarConfig }) {
  const [anchor, setAnchor] = useState<Ymd>(() => todayYmd());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [creating, setCreating] = useState<Ymd | null>(null);
  const suppressClick = useRef(false);
  const today = todayYmd();
  const { mode } = cfg;

  const done = useMemo(() => doneModel(schema), [schema]);
  const split = useMemo(() => splitRows(result.rows, cfg), [result.rows, cfg.dateColumn.key, cfg.endColumn?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  const latest = useRef({ split, cfg, actions });
  latest.current = { split, cfg, actions };

  const canDrag = (row: Row, kind: DragKind) => {
    const col = kind === 'resize' ? cfg.endColumn : cfg.dateColumn;
    return row.canEdit && !!col && !col.readonly;
  };

  // The items as they would be if the current drag ended now (the bar follows the pointer)
  const shown = useMemo<CalendarItem[]>(() => {
    if (!drag || !drag.over || drag.kind === 'schedule') return split.items;
    return split.items.map((item) => {
      if (item.id !== drag.rowId) return item;
      if (drag.kind === 'resize') return resizedItem(item, drag.over!);
      return drag.grabDay ? movedItem(item, addDays(item.start, diffDays(drag.grabDay, drag.over!))) : item;
    });
  }, [split.items, drag]);

  const weeks = mode === 'month' ? monthGrid(anchor) : [weekOf(startOfWeek(anchor))];
  const layouts = weeks.map((days) => layoutWeek(shown, days, MAX_LANES[mode]));

  function saveCalendar(patch: { dateColumn?: string; endColumn?: string | null; mode?: CalendarMode }) {
    const next: Record<string, unknown> = {
      ...(view.config.calendar ?? {}),
      dateColumn: cfg.dateColumn.key,
      ...(cfg.endColumn ? { endColumn: cfg.endColumn.key } : {}),
      mode,
      ...patch,
    };
    if (next.endColumn === null || next.endColumn === next.dateColumn) delete next.endColumn;
    actions.updateConfig({ calendar: next as unknown as View['config']['calendar'] });
  }

  function step(dir: 1 | -1) {
    setAnchor((a) => (mode === 'month' ? addMonths(startOfMonth(a), dir) : addDays(a, 7 * dir)));
  }

  /** Starts tracking the pointer for a press; it becomes a drag after a few pixels. */
  function onPress(e: ReactPointerEvent<HTMLElement>, kind: DragKind, row: Row) {
    if (e.button !== 0 || !canDrag(row, kind)) return;
    if (kind === 'resize') e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const grabDay = kind === 'schedule' ? null : dayAt(startX, startY);
    let active = false;

    const onMove = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
      active = true;
      setDrag({ kind, rowId: row.id, grabDay, over: dayAt(ev.clientX, ev.clientY), x: ev.clientX, y: ev.clientY });
    };
    const stop = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('keydown', onKey);
      setDrag(null);
    };
    const onUp = (ev: PointerEvent) => {
      stop();
      if (!active) return;
      // The click that follows a drag must not open the row
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      const over = dayAt(ev.clientX, ev.clientY);
      if (!over) return;
      const cur = latest.current;
      let patch: Record<string, unknown> = {};
      if (kind === 'schedule') {
        patch = schedulePatch(cur.cfg, row, over);
      } else {
        const item = cur.split.items.find((i) => i.id === row.id);
        if (!item || !grabDay) return;
        const after = kind === 'resize' ? resizedItem(item, over) : movedItem(item, addDays(item.start, diffDays(grabDay, over)));
        patch = itemPatch(cur.cfg, item, after);
      }
      if (Object.keys(patch).length) cur.actions.updateRow(row.id, patch).catch(() => undefined);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') stop();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('keydown', onKey);
  }

  const open = (id: string) => {
    if (!suppressClick.current) actions.openRow(id);
  };
  const dragged = drag ? result.rows.find((r) => r.id === drag.rowId) : undefined;
  const dropDays = new Set<Ymd>();
  if (drag?.over) {
    if (drag.kind === 'schedule') dropDays.add(drag.over);
    else {
      const item = shown.find((i) => i.id === drag.rowId);
      if (item && drag.kind === 'move') for (let d = item.start; d <= item.end; d = addDays(d, 1)) dropDays.add(d);
    }
  }
  const canCreate = schema.capabilities.create && !cfg.dateColumn.readonly;
  const dates = dateColumnsOf(schema);
  const title = mode === 'month' ? monthTitle(anchor) : weekTitle(startOfWeek(anchor));

  return (
    <div className={cx('cl-cal', drag && 'is-dragging')} data-testid="calendar-layout" data-mode={mode} aria-busy={loading || undefined}>
      <div className="cl-cal__bar">
        <div className="cl-cal__nav">
          <button type="button" className="cl-cal__btn" data-testid="calendar-prev" aria-label={mode === 'month' ? 'Previous month' : 'Previous week'} onClick={() => step(-1)}>
            ‹
          </button>
          <button type="button" className="cl-cal__btn" data-testid="calendar-next" aria-label={mode === 'month' ? 'Next month' : 'Next week'} onClick={() => step(1)}>
            ›
          </button>
          <button type="button" className="cl-cal__btn" data-testid="calendar-today" onClick={() => setAnchor(todayYmd())}>
            Today
          </button>
          <h3 className="cl-cal__title" data-testid="calendar-title" aria-live="polite">
            {title}
          </h3>
        </div>
        <div className="cl-cal__tools">
          {dates.length > 1 && (
            <>
              <label className="cl-cal__select">
                Date
                <select data-testid="calendar-date-column" value={cfg.dateColumn.key} onChange={(e) => saveCalendar({ dateColumn: e.target.value })}>
                  {dates.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="cl-cal__select">
                Ends
                <select data-testid="calendar-end-column" value={cfg.endColumn?.key ?? ''} onChange={(e) => saveCalendar({ endColumn: e.target.value || null })}>
                  <option value="">None</option>
                  {dates
                    .filter((c) => c.key !== cfg.dateColumn.key)
                    .map((c) => (
                      <option key={c.key} value={c.key}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </label>
            </>
          )}
          <div className="cl-cal__modes" role="group" aria-label="Calendar range">
            {(['month', 'week'] as const).map((m) => (
              <button key={m} type="button" className="cl-cal__btn" data-testid={`calendar-mode-${m}`} aria-pressed={mode === m} onClick={() => saveCalendar({ mode: m })}>
                {m === 'month' ? 'Month' : 'Week'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="cl-cal__main">
        <div className="cl-cal__grid" data-testid="calendar-grid">
          <div className="cl-cal__weekdays" aria-hidden="true">
            {WEEKDAY_NAMES.map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
          {weeks.map((days, w) => {
            const lay = layouts[w]!;
            const style: CSSProperties = { gridTemplateRows: `24px repeat(${lay.lanes}, 24px) minmax(20px, 1fr)` };
            return (
              <div key={days[0]} className={cx('cl-cal__week', mode === 'week' && 'is-single')} style={style} data-testid="calendar-week">
                {days.map((day, i) => (
                  <div
                    key={day}
                    className={cx(
                      'cl-cal__day',
                      day === today && 'is-today',
                      mode === 'month' && !sameMonth(day, anchor) && 'is-outside',
                      dropDays.has(day) && 'is-drop',
                      canCreate && 'is-creatable',
                    )}
                    style={{ gridColumn: i + 1, gridRow: '1 / -1' }}
                    data-testid="calendar-day"
                    data-day={day}
                    data-today={day === today || undefined}
                    onClick={() => {
                      if (canCreate && !suppressClick.current) setCreating(day);
                    }}
                  >
                    <span className="cl-cal__num">
                      {dayOfMonth(day) === 1 && mode === 'month' ? `${dayOfMonth(day)} ${MONTH_NAMES[Number(day.slice(5, 7)) - 1]!.slice(0, 3)}` : dayOfMonth(day)}
                    </span>
                    {creating === day && <CreateInline day={day} schema={schema} view={view} cfg={cfg} actions={actions} onClose={() => setCreating(null)} />}
                  </div>
                ))}
                {lay.segments.map((seg) => (
                  <Bar
                    key={`${seg.item.id}:${days[0]}`}
                    seg={seg}
                    title={String(seg.item.row.values[schema.titleColumn] ?? '').trim() || 'Untitled'}
                    color={itemColor(schema, seg.item.row)}
                    isDone={!!done?.isDone(seg.item.row)}
                    draggable={canDrag(seg.item.row, 'move')}
                    resizable={!!cfg.endColumn && canDrag(seg.item.row, 'resize') && !seg.continuesAfter}
                    isDragged={drag?.rowId === seg.item.id && drag.kind !== 'schedule'}
                    onPress={onPress}
                    onOpen={() => open(seg.item.id)}
                  />
                ))}
                {lay.overflow.map((n, i) =>
                  n > 0 ? (
                    <MoreButton
                      key={days[i]}
                      day={days[i]!}
                      column={i + 1}
                      row={lay.lanes + 2}
                      count={n}
                      items={itemsOnDay(shown, days[i]!)}
                      titleColumn={schema.titleColumn}
                      onOpen={(id) => actions.openRow(id)}
                    />
                  ) : null,
                )}
              </div>
            );
          })}
        </div>

        <aside className="cl-cal__undated" data-testid="calendar-undated" aria-label="No date">
          <h4 className="cl-cal__undated-head">
            No date <span className="cl-cal__undated-count">{split.undated.length}</span>
          </h4>
          {split.undated.length === 0 && !loading && <p className="cl-cal__undated-empty">Every row has a date.</p>}
          <ul className="cl-cal__undated-list">
            {split.undated.map((row) => (
              <li
                key={row.id}
                className={cx('cl-cal__chip', canDrag(row, 'schedule') && 'is-draggable', done?.isDone(row) && 'is-done', drag?.rowId === row.id && 'is-dragged')}
                style={chipStyle(itemColor(schema, row))}
                data-testid="calendar-undated-item"
                data-row-id={row.id}
                tabIndex={0}
                onPointerDown={(e) => onPress(e, 'schedule', row)}
                onClick={() => open(row.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') actions.openRow(row.id);
                }}
              >
                {String(row.values[schema.titleColumn] ?? '').trim() || 'Untitled'}
              </li>
            ))}
          </ul>
        </aside>
      </div>

      {drag?.kind === 'schedule' && dragged && (
        <div className="cl-cal__ghost" style={{ left: drag.x + 8, top: drag.y + 8 }} aria-hidden="true">
          {String(dragged.values[schema.titleColumn] ?? '')}
        </div>
      )}
    </div>
  );
}

function chipStyle(color: string | undefined): CSSProperties | undefined {
  return color ? ({ '--cl-cal-color': color } as CSSProperties) : undefined;
}

interface BarProps {
  seg: Segment;
  title: string;
  color: string | undefined;
  isDone: boolean;
  draggable: boolean;
  resizable: boolean;
  isDragged: boolean;
  onPress: (e: ReactPointerEvent<HTMLElement>, kind: DragKind, row: Row) => void;
  onOpen: () => void;
}

/** One row on one week: a bar over the days it covers. */
function Bar({ seg, title, color, isDone, draggable, resizable, isDragged, onPress, onOpen }: BarProps) {
  const { row } = seg.item;
  return (
    <div
      className={cx(
        'cl-cal__bar-item',
        draggable && 'is-draggable',
        isDone && 'is-done',
        isDragged && 'is-dragged',
        seg.continuesBefore && 'is-cont-before',
        seg.continuesAfter && 'is-cont-after',
      )}
      style={{ gridColumn: `${seg.startCol + 1} / ${seg.endCol + 2}`, gridRow: seg.lane + 2, ...chipStyle(color) }}
      data-testid="calendar-item"
      data-row-id={row.id}
      data-start={seg.item.start}
      data-end={seg.item.end}
      tabIndex={0}
      title={title}
      onPointerDown={(e) => onPress(e, 'move', row)}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onOpen();
      }}
    >
      <span className="cl-cal__bar-title">{title}</span>
      {resizable && <span className="cl-cal__resize" data-testid="calendar-resize" aria-label="Resize" onPointerDown={(e) => onPress(e, 'resize', row)} onClick={(e) => e.stopPropagation()} />}
    </div>
  );
}

interface MoreProps {
  day: Ymd;
  column: number;
  row: number;
  count: number;
  items: CalendarItem[];
  titleColumn: string;
  onOpen: (id: string) => void;
}

/** "+N more" on a day; opens a popover with every row of that day. */
function MoreButton({ day, column, row, count, items, titleColumn, onOpen }: MoreProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="cl-cal__more"
        style={{ gridColumn: column, gridRow: row }}
        data-testid="calendar-more"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        +{count} more
      </button>
      <Popover open={open} onOpenChange={setOpen} anchorRef={ref} aria-label={`Rows on ${day}`} className="cl-cal__popover">
        <div data-testid="calendar-more-list">
          <div className="cl-cal__popover-head">{day}</div>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="cl-cal__popover-item"
              data-testid="calendar-more-item"
              onClick={() => {
                setOpen(false);
                onOpen(item.id);
              }}
            >
              {String(item.row.values[titleColumn] ?? '').trim() || 'Untitled'}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

interface CreateProps {
  day: Ymd;
  schema: LayoutProps['schema'];
  view: View;
  cfg: CalendarConfig;
  actions: LayoutProps['actions'];
  onClose: () => void;
}

/** Adds a row on one day: a title input (and a project choice for `tasks:*`). */
function CreateInline({ day, schema, view, cfg, actions, onClose }: CreateProps) {
  const [title, setTitle] = useState('');
  const add = useAddProject(view.id, view.tableRef);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    form.current?.querySelector('input')?.focus();
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = title.trim();
    if (!text) return onClose();
    let opts: { projectId: string } | undefined;
    if (view.tableRef === 'tasks:*') {
      const chosen = add.projectId;
      if (!chosen) {
        getPlatform().toast('error', 'You have no project to add a task to');
        return;
      }
      opts = { projectId: chosen };
    }
    actions.createRow(createValues(schema, cfg, text, day), opts).catch(() => undefined);
    onClose();
  }

  return (
    <form
      ref={form}
      className="cl-cal__create"
      data-testid="calendar-create"
      onSubmit={submit}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => {
        // Leaving the form with nothing typed closes it
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !title.trim()) onClose();
      }}
    >
      <input
        className="cl-cal__create-input"
        aria-label={`New row on ${day}`}
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      />
      <ProjectSelect add={add} className="cl-cal__create-project" />
    </form>
  );
}
