import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { getPlatform } from '../../../platform';
import { ColorDot, cx } from '../../../ui';
import { getCell } from '../../cells';
import { projectsForCreate } from '../../store';
import { SUMMARY_LABELS } from '../../toolbar/queryModel';
import type { Column, LayoutProps, Query, Row, View } from '../../types';
import {
  boardColumnsOf,
  buildLanes,
  cardColumnsOf,
  defaultGroupBy,
  dropPatch,
  quickAddValues,
  readBoardConfig,
  reorderTarget,
  toggleIn,
  type BoardConfig,
  type BoardLane,
} from './model';
import './board.css';

/** Pixels the pointer must travel before a press on a card becomes a drag (below that it is a click). */
const DRAG_THRESHOLD = 4;

interface DragState {
  rowId: string;
  fromKey: string | null;
  x: number;
  y: number;
  overLane: string | null;
  beforeId: string | null;
}

/**
 * Board layout: one lane per group of the view's `groupBy` column. Cards drag between lanes (changes the
 * value) and within a lane (reorders, only while the view has no sort). Lanes fold away; the state is
 * kept in `view.config.board`.
 */
export function BoardLayout(props: LayoutProps) {
  const { schema, view, actions } = props;
  const groupByKey = view.config.query.groupBy;
  const column = boardColumnsOf(schema).find((c) => c.key === groupByKey);

  const queryRef = useRef<Query>(view.config.query);
  queryRef.current = view.config.query;

  // A board without a usable group column starts with the default one so that it shows lanes at once
  const fallbackGroup = column ? undefined : defaultGroupBy(schema);
  useEffect(() => {
    if (fallbackGroup) actions.updateConfig({ query: { ...queryRef.current, groupBy: fallbackGroup } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallbackGroup]);

  if (!column) {
    const choices = boardColumnsOf(schema);
    return (
      <div className="cl-board" data-testid="board-layout">
        <p className="cl-board__empty" data-testid="board-no-column">
          {choices.length
            ? 'Choose the column that makes up the board columns (Group in the toolbar).'
            : 'This table has no select, status, priority or person column to build a board from.'}
        </p>
      </div>
    );
  }
  return <BoardLanes key={column.key} {...props} column={column} />;
}

function BoardLanes({ column, schema, view, result, loading, actions }: LayoutProps & { column: Column }) {
  const board = readBoardConfig(view.config);
  const sorted = (view.config.query.sort ?? []).length > 0;
  const lanes = useMemo(() => buildLanes(column, result), [column, result]);
  const cardColumns = cardColumnsOf(schema, view.config, column.key);
  const [drag, setDrag] = useState<DragState | null>(null);
  const suppressClick = useRef(false);
  const latest = useRef({ lanes, result, sorted, column, actions });
  latest.current = { lanes, result, sorted, column, actions };

  const saveBoard = (patch: Partial<BoardConfig>) => {
    const next = { ...board, groupBy: column.key, ...patch };
    actions.updateConfig({ board: next as unknown as View['config']['board'] });
  };

  /** Starts tracking the pointer for a press on a card; the press turns into a drag after a few pixels. */
  function onCardPointerDown(e: ReactPointerEvent<HTMLElement>, row: Row, fromKey: string | null) {
    if (e.button !== 0 || !row.canEdit || column.readonly) return;
    if ((e.target as HTMLElement).closest('button, input, select, textarea, a')) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let active = false;

    // The lane under the pointer and the card it would be dropped in front of
    const locate = (x: number, y: number): Pick<DragState, 'overLane' | 'beforeId'> => {
      const laneEl = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-lane-id]');
      if (!laneEl) return { overLane: null, beforeId: null };
      const cards = [...laneEl.querySelectorAll<HTMLElement>('[data-card-id]')].filter((c) => c.dataset.cardId !== row.id);
      const next = cards.find((c) => {
        const r = c.getBoundingClientRect();
        return y < r.top + r.height / 2;
      });
      return { overLane: laneEl.dataset.laneId ?? null, beforeId: next?.dataset.cardId ?? null };
    };

    const onMove = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD) return;
      active = true;
      setDrag({ rowId: row.id, fromKey, x: ev.clientX, y: ev.clientY, ...locate(ev.clientX, ev.clientY) });
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
      const { overLane, beforeId } = locate(ev.clientX, ev.clientY);
      const cur = latest.current;
      const target = cur.lanes.find((l) => l.id === overLane);
      if (!target) return;
      if (target.key !== fromKey) {
        const patch = dropPatch(cur.column, row, fromKey, target.key);
        if (patch) cur.actions.updateRow(row.id, patch).catch(() => undefined);
      } else if (!cur.sorted) {
        const change = reorderTarget(cur.result.rows, target.rows, row.id, beforeId);
        if (change) cur.actions.reorder(change.ids, change.before).catch(() => undefined);
      }
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') stop();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('keydown', onKey);
  }

  const dragged = drag ? result.rows.find((r) => r.id === drag.rowId) : undefined;
  const summaryColumns = Object.entries(view.config.query.summaries ?? {});
  const columnName = (key: string) => schema.columns.find((c) => c.key === key)?.name ?? key;

  return (
    <div className={cx('cl-board', drag && 'is-dragging')} data-testid="board-layout" aria-busy={loading || undefined}>
      <div className="cl-board__bar">
        <CardFieldsMenu schema={schema} selected={cardColumns} skip={[schema.titleColumn, column.key]} onChange={(keys) => saveBoard({ cardColumns: keys })} />
      </div>
      <div className="cl-board__lanes">
        {lanes.map((lane) => {
          const collapsed = board.collapsed.includes(lane.id);
          const over = drag?.overLane === lane.id;
          const sameLane = !!drag && !sorted && over && drag.fromKey === lane.key;
          return (
            <section
              key={lane.id}
              className={cx('cl-board__lane', collapsed && 'is-collapsed', over && 'is-over')}
              data-testid="board-lane"
              data-lane-id={lane.id}
              data-lane-label={lane.label}
            >
              <header className="cl-board__lane-head">
                <button
                  type="button"
                  className="cl-board__fold"
                  aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${lane.label}`}
                  aria-expanded={!collapsed}
                  data-testid="board-fold"
                  onClick={() => saveBoard({ collapsed: toggleIn(board.collapsed, lane.id) })}
                >
                  {collapsed ? '▸' : '▾'}
                </button>
                {lane.color && <ColorDot color={lane.color} />}
                <span className="cl-board__lane-name">{lane.label}</span>
                <span className="cl-board__lane-count" data-testid="board-count">
                  {lane.count}
                </span>
              </header>
              {!collapsed && (
                <>
                  {summaryColumns.length > 0 && lane.summaries && (
                    <div className="cl-board__summaries" data-testid="board-summary">
                      {summaryColumns.map(([key, fn]) => (
                        <span key={key}>
                          {SUMMARY_LABELS[fn]} {columnName(key)}: {lane.summaries?.[key] ?? '-'}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="cl-board__cards">
                    {lane.rows.map((row) => (
                      <Card
                        key={row.id}
                        row={row}
                        lane={lane}
                        titleColumn={schema.titleColumn}
                        columns={cardColumns}
                        isDragged={drag?.rowId === row.id}
                        showDropBefore={sameLane && drag?.beforeId === row.id}
                        onPointerDown={onCardPointerDown}
                        onOpen={() => {
                          if (!suppressClick.current) actions.openRow(row.id);
                        }}
                      />
                    ))}
                    {sameLane && drag?.beforeId === null && <div className="cl-board__drop-end" />}
                    {lane.rows.length === 0 && !loading && <p className="cl-board__lane-empty">No cards</p>}
                  </div>
                  {schema.capabilities.create && <QuickAdd column={column} schema={schema} view={view} lane={lane} actions={actions} />}
                </>
              )}
            </section>
          );
        })}
      </div>
      {drag && dragged && (
        <div className="cl-board__ghost" style={{ left: drag.x + 8, top: drag.y + 8 }} aria-hidden="true">
          {String(dragged.values[schema.titleColumn] ?? '')}
        </div>
      )}
    </div>
  );
}

interface CardProps {
  row: Row;
  lane: BoardLane;
  titleColumn: string;
  columns: Column[];
  isDragged: boolean;
  showDropBefore: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>, row: Row, fromKey: string | null) => void;
  onOpen: () => void;
}

function Card({ row, lane, titleColumn, columns, isDragged, showDropBefore, onPointerDown, onOpen }: CardProps) {
  const title = String(row.values[titleColumn] ?? '').trim();
  return (
    <>
      {showDropBefore && <div className="cl-board__drop-line" />}
      <article
        className={cx('cl-board__card', isDragged && 'is-dragged', row.canEdit && 'is-draggable')}
        data-testid="board-card"
        data-card-id={row.id}
        tabIndex={0}
        onPointerDown={(e) => onPointerDown(e, row, lane.key)}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.target === e.currentTarget) onOpen();
        }}
      >
        <div className="cl-board__card-title">{title || 'Untitled'}</div>
        {columns.map((c) => {
          const def = getCell(c.type);
          const value = row.values[c.key];
          if (def.isEmpty(value)) return null;
          return (
            <div key={c.key} className="cl-board__field" title={c.name}>
              <def.Display column={c} value={value} row={row} compact />
            </div>
          );
        })}
      </article>
    </>
  );
}

interface QuickAddProps {
  column: Column;
  schema: LayoutProps['schema'];
  view: View;
  lane: BoardLane;
  actions: LayoutProps['actions'];
}

/** Adds a card to one lane: a title input; the new row gets the lane's value. */
function QuickAdd({ column, schema, view, lane, actions }: QuickAddProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState('');
  const projects = open && view.tableRef === 'tasks:*' ? projectsForCreate() : [];

  function close() {
    setOpen(false);
    setTitle('');
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = title.trim();
    if (!text) return close();
    let opts: { projectId: string } | undefined;
    if (view.tableRef === 'tasks:*') {
      const chosen = projectId || projects[0]?.id;
      if (!chosen) {
        getPlatform().toast('error', 'You have no project to add a task to');
        return;
      }
      opts = { projectId: chosen };
    }
    actions.createRow(quickAddValues(column, schema.titleColumn, text, lane.key), opts).catch(() => undefined);
    setTitle(''); // stay open for the next card
  }

  if (!open) {
    return (
      <button type="button" className="cl-board__add" data-testid="board-add" onClick={() => setOpen(true)}>
        + Add
      </button>
    );
  }
  return (
    <form className="cl-board__add-form" onSubmit={submit} data-testid="board-add-form">
      <input
        className="cl-board__add-input"
        autoFocus
        aria-label={`New card in ${lane.label}`}
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
        onBlur={() => !title.trim() && close()}
      />
      {projects.length > 1 && (
        <select className="cl-board__add-project" aria-label="Project" value={projectId || projects[0]!.id} onChange={(e) => setProjectId(e.target.value)}>
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

interface FieldsProps {
  schema: LayoutProps['schema'];
  selected: Column[];
  skip: string[];
  onChange: (keys: string[]) => void;
}

/** Which columns the cards show: a checkbox list in a disclosure. */
function CardFieldsMenu({ schema, selected, skip, onChange }: FieldsProps) {
  const chosen = new Set(selected.map((c) => c.key));
  const choices = schema.columns.filter((c) => !skip.includes(c.key));
  return (
    <details className="cl-board__fields" data-testid="board-fields">
      <summary>Card fields</summary>
      <div className="cl-board__fields-list">
        {choices.map((c) => (
          <label key={c.key}>
            <input
              type="checkbox"
              checked={chosen.has(c.key)}
              onChange={() => onChange(choices.filter((x) => (x.key === c.key ? !chosen.has(c.key) : chosen.has(x.key))).map((x) => x.key))}
            />
            {c.name}
          </label>
        ))}
      </div>
    </details>
  );
}
