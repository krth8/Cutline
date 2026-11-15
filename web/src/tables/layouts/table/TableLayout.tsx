import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { getPlatform } from '../../../platform';
import * as tablesApi from '../../../api/tables';
import { cx } from '../../../ui';
import { getCell, isColumnEditable } from '../../cells';
import { projectsForCreate, refreshTable } from '../../store';
import type { Column, LayoutProps, Row } from '../../types';
import { orderedColumns } from '../../viewColumns';
import { AddRow } from './AddRow';
import { BulkBar } from './BulkBar';
import { parseTsv, planPaste, toTsv } from './clipboard';
import { ColumnForm, type ColumnFormMode, type ColumnFormValue } from './ColumnForm';
import { DataRow } from './DataRow';
import { MoveUnder } from './MoveUnder';
import {
  EMPTY_SELECTION,
  NAV_KEYS,
  ROW_HEIGHT,
  buildItems,
  formatSummary,
  gridColumns,
  gridTemplate,
  gridWidth,
  moveCursor,
  pruneSelection,
  readTableConfig,
  reorderPlan,
  reorderedColumnConfig,
  rowOrder,
  scrollTopFor,
  selectAll,
  selectRange,
  tableConfigPatch,
  toggleSelection,
  virtualWindow,
  type GridItem,
  type NavKey,
  type Selection,
} from './grid';
import { Header } from './Header';
import './table.css';

const HEADER_HEIGHT = 36;
const FOOTER_HEIGHT = 34;
/** The store keeps a children query for this long after it was read (store/registry.ts disposeDelayMs, plus a margin). */
const CHILD_CACHE_MS = 5200;
const ROW_MIME = 'application/x-cutline-row';

const EMPTY_SET: ReadonlySet<string> = new Set();

/** The cell host element under (or being) `el`, when it is not in editing mode. */
function idleCellHost(el: EventTarget | null): HTMLElement | null {
  if (!(el instanceof HTMLElement)) return null;
  const host = el.closest<HTMLElement>('.cl-cellhost');
  return host && !host.classList.contains('is-editing') && (el === host || el.closest('.is-editing') === null) ? host : null;
}

function posOf(host: HTMLElement, keys: readonly string[]): { rowId: string; col: number } | null {
  const rowId = host.closest<HTMLElement>('[data-row-id]')?.dataset.rowId;
  const key = host.closest<HTMLElement>('[data-col]')?.dataset.col;
  const col = key === undefined ? -1 : keys.indexOf(key);
  return rowId !== undefined && col >= 0 ? { rowId, col } : null;
}

/**
 * The table layout: a virtualised grid with inline editing, resizable and reorderable columns,
 * groups with summaries, subtasks, multi-select with bulk edit and delete, quick add, drag to
 * reorder, keyboard navigation and cell copy/paste. Draws and edits rows only; the query is the
 * toolbar's job.
 */
export function TableLayout({ schema, view, result, loading, actions }: LayoutProps) {
  const query = view.config.query;
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [clientHeight, setClientHeight] = useState(600);
  const [liveWidths, setLiveWidths] = useState<Record<string, number>>({});
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [children, setChildren] = useState<ReadonlyMap<string, Row[]>>(() => new Map());
  const [loadingKids, setLoadingKids] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [sel, setSel] = useState<Selection>(EMPTY_SELECTION);
  const [drop, setDrop] = useState<{ id: string; side: 'before' | 'after' } | null>(null);
  const [addFocus, setAddFocus] = useState<string | null>(null);
  const [project, setProject] = useState('');
  const [colForm, setColForm] = useState<{ mode: ColumnFormMode; column?: Column } | null>(null);
  const [moving, setMoving] = useState<Row | null>(null);
  const dragIds = useRef<string[] | null>(null);
  const pendingFocus = useRef<{ rowId: string; key: string } | null>(null);

  const isAll = view.tableRef === 'tasks:*';
  const nested = schema.capabilities.hierarchy && query.parentId === null;
  const sorted = (query.sort?.length ?? 0) > 0;
  const canCreate = schema.capabilities.create;
  const projects = useMemo(() => (isAll ? projectsForCreate() : []), [isAll, schema]);
  const projectId = project || projects[0]?.id || '';

  const cols = useMemo(() => gridColumns(schema, view.config, liveWidths), [schema, view.config, liveWidths]);
  const colKeys = useMemo(() => cols.map((c) => c.column.key), [cols]);
  const items = useMemo(
    () =>
      buildItems({
        rows: result.rows,
        groups: result.groups,
        groupBy: query.groupBy,
        collapsed,
        expanded,
        children,
        nested,
        loadingChildren: loadingKids,
        canAddChildren: canCreate,
        quickAdd: canCreate,
      }),
    [result, query.groupBy, collapsed, expanded, children, nested, loadingKids, canCreate],
  );
  const order = useMemo(() => rowOrder(items), [items]);
  const rowsInOrder = useMemo(() => items.flatMap((i) => (i.kind === 'row' ? [i.row] : [])), [items]);
  const itemIndex = useMemo(() => new Map(items.map((it, i) => [it.id, i])), [items]);

  const bodyViewport = Math.max(ROW_HEIGHT, clientHeight - HEADER_HEIGHT - FOOTER_HEIGHT);
  const win = virtualWindow(items.length, ROW_HEIGHT, scrollTop, bodyViewport);

  // The latest values for handlers that must keep their identity
  const L = useRef({ actions, order, rowsInOrder, sel, expanded, children, cols, colKeys, schema, view, bodyViewport, itemIndex, scrollTop });
  L.current = { actions, order, rowsInOrder, sel, expanded, children, cols, colKeys, schema, view, bodyViewport, itemIndex, scrollTop };

  // ---- size of the scroll area ----
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setClientHeight(el.clientHeight || 600);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- children of expanded rows ----
  const refreshChildren = useCallback((parentIds: Iterable<string>) => {
    for (const id of parentIds) {
      L.current.actions.loadChildren(id).then(
        (rows) => setChildren((m) => new Map(m).set(id, rows)),
        () => {},
      );
    }
  }, []);

  useEffect(() => {
    if (L.current.expanded.size === 0) return;
    refreshChildren(L.current.expanded);
    // loadChildren may answer from a cache that is a few seconds old: ask once more after it ran out
    const timer = setTimeout(() => refreshChildren(L.current.expanded), CHILD_CACHE_MS);
    return () => clearTimeout(timer);
  }, [result, refreshChildren]);

  // Forget selected rows that no longer exist
  useEffect(() => {
    const existing = new Set(result.rows.map((r) => r.id));
    for (const list of children.values()) for (const r of list) existing.add(r.id);
    setSel((s) => pruneSelection(s, existing));
  }, [result, children]);

  const toggleExpand = useCallback(
    (id: string) => {
      const open = L.current.expanded.has(id);
      setExpanded((s) => {
        const next = new Set(s);
        if (open) next.delete(id);
        else next.add(id);
        return next;
      });
      if (open) return;
      setLoadingKids((s) => new Set(s).add(id));
      L.current.actions.loadChildren(id).then(
        (rows) => setChildren((m) => new Map(m).set(id, rows)),
        () => {},
      ).finally(() =>
        setLoadingKids((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        }),
      );
    },
    [],
  );

  // ---- editing ----
  const editRow = useCallback(
    (row: Row, key: string, value: unknown) => {
      const parent = row.parentId ?? null;
      if (parent && L.current.children.has(parent)) {
        setChildren((m) => {
          const list = m.get(parent);
          if (!list) return m;
          return new Map(m).set(parent, list.map((r) => (r.id === row.id ? { ...r, values: { ...r.values, [key]: value } } : r)));
        });
      }
      L.current.actions.updateRow(row.id, { [key]: value }).then(
        () => {
          if (parent && L.current.expanded.has(parent)) refreshChildren([parent]);
        },
        () => {},
      );
    },
    [refreshChildren],
  );

  const onSelectRow = useCallback((id: string, shift: boolean) => {
    setSel((s) => (shift ? selectRange(s, L.current.order, id) : toggleSelection(s, id)));
  }, []);

  const onOpen = useCallback((id: string) => L.current.actions.openRow(id), []);

  const onAddChild = useCallback(
    (row: Row) => {
      if (!L.current.expanded.has(row.id)) toggleExpand(row.id);
      setAddFocus(row.id);
    },
    [toggleExpand],
  );

  const createTop = (name: string) => {
    if (isAll && !projectId) {
      getPlatform().toast('error', 'You have no project to add a task to');
      return;
    }
    actions.createRow({ [schema.titleColumn]: name }, isAll ? { projectId } : undefined).catch(() => {});
  };

  const createChild = (parentId: string, tableRef: string, name: string) => {
    actions
      .createRow({ [schema.titleColumn]: name }, { parentId, ...(isAll ? { projectId: tableRef.replace(/^tasks:/, '') } : {}) })
      .then(
        () => refreshChildren([parentId]),
        () => {},
      );
  };

  // ---- selection, bulk edit, delete ----
  const selectedRows = (): Row[] => L.current.rowsInOrder.filter((r) => L.current.sel.ids.has(r.id));

  async function deleteSelected() {
    const ids = [...sel.ids];
    if (ids.length === 0) return;
    const ok = await getPlatform().confirm(`Delete ${ids.length} ${ids.length === 1 ? 'row' : 'rows'}? This cannot be undone.`, {
      danger: true,
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    const parents = new Set(selectedRows().flatMap((r) => (r.parentId ? [r.parentId] : [])));
    setSel(EMPTY_SELECTION);
    try {
      await actions.deleteRows(ids);
    } finally {
      refreshChildren([...parents].filter((p) => L.current.expanded.has(p)));
    }
  }

  function applyBulk(column: Column, value: unknown) {
    const rows = selectedRows();
    const editable = rows.filter((r) => r.canEdit);
    for (const r of editable) editRow(r, column.key, value);
    if (editable.length < rows.length) {
      getPlatform().toast('info', `${rows.length - editable.length} rows were skipped because you cannot edit them`);
    }
  }

  const bulkColumns = useMemo(() => cols.map((c) => c.column).filter((c) => isColumnEditable(c) && getCell(c.type).parseText), [cols]);
  const canDeleteRows = schema.capabilities.delete;

  // ---- focus and keyboard ----
  const findCellHost = (rowId: string, key: string): HTMLElement | null => {
    const rows = scroller.current?.querySelectorAll<HTMLElement>('[data-row-id]');
    if (!rows) return null;
    for (const r of rows) {
      if (r.dataset.rowId === rowId) return r.querySelector<HTMLElement>(`[data-col="${key}"] .cl-cellhost`);
    }
    return null;
  };

  const tryFocus = () => {
    const p = pendingFocus.current;
    if (!p) return;
    const el = findCellHost(p.rowId, p.key);
    if (el) {
      pendingFocus.current = null;
      el.focus({ preventScroll: true });
    }
  };
  useLayoutEffect(tryFocus);

  function focusCell(rowId: string, col: number) {
    const key = L.current.colKeys[col];
    const at = L.current.itemIndex.get(rowId);
    if (key === undefined || at === undefined) return;
    pendingFocus.current = { rowId, key };
    const top = scrollTopFor(at, ROW_HEIGHT, L.current.scrollTop, L.current.bodyViewport);
    if (top !== L.current.scrollTop) {
      if (scroller.current) scroller.current.scrollTop = top;
      setScrollTop(top);
    }
    tryFocus();
  }

  function onKeyDownCapture(e: KeyboardEvent<HTMLDivElement>) {
    const host = idleCellHost(e.target);
    if (!host) return;
    const mod = e.ctrlKey || e.metaKey;
    if (NAV_KEYS.includes(e.key)) {
      const pos = posOf(host, colKeys);
      if (!pos) return;
      e.preventDefault();
      e.stopPropagation();
      const page = Math.max(1, Math.floor(bodyViewport / ROW_HEIGHT) - 1);
      const next = moveCursor(order, pos, e.key as NavKey, colKeys.length, { ctrl: mod, page });
      focusCell(next.rowId, next.col);
    } else if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopPropagation();
      setSel(selectAll(order));
    } else if (e.key === 'Escape' && sel.ids.size > 0) {
      e.stopPropagation();
      setSel(EMPTY_SELECTION);
    } else if (e.key === ' ' && e.shiftKey) {
      const pos = posOf(host, colKeys);
      if (!pos) return;
      e.preventDefault();
      e.stopPropagation();
      onSelectRow(pos.rowId, false);
    }
  }

  // ---- copy and paste ----
  function onCopy(e: ClipboardEvent<HTMLDivElement>) {
    const host = idleCellHost(e.target);
    if (!host) return;
    const text = (row: Row, column: Column) => getCell(column.type).toText(row.values[column.key], column);
    let matrix: string[][];
    if (sel.ids.size > 0) {
      matrix = selectedRows().map((r) => cols.map((c) => text(r, c.column)));
    } else {
      const pos = posOf(host, colKeys);
      const row = pos && rowsInOrder.find((r) => r.id === pos.rowId);
      const column = pos && cols[pos.col]?.column;
      if (!row || !column) return;
      matrix = [[text(row, column)]];
    }
    e.clipboardData.setData('text/plain', toTsv(matrix));
    e.preventDefault();
  }

  function onPaste(e: ClipboardEvent<HTMLDivElement>) {
    const host = idleCellHost(e.target);
    const pos = host && posOf(host, colKeys);
    if (!pos) return;
    const matrix = parseTsv(e.clipboardData.getData('text/plain'));
    if (matrix.length === 0) return;
    e.preventDefault();
    const byId = new Map(rowsInOrder.map((r) => [r.id, r]));
    const { updates, skipped } = planPaste({
      matrix,
      order,
      start: pos,
      columns: cols.map((c) => c.column),
      selected: sel.ids,
      canEditRow: (id) => byId.get(id)?.canEdit === true,
      canEditColumn: (c) => isColumnEditable(c) && !!getCell(c.type).parseText,
      parse: (c, t) => getCell(c.type).parseText?.(t, c) ?? null,
    });
    for (const u of updates) {
      const row = byId.get(u.rowId);
      if (row) for (const [key, value] of Object.entries(u.values)) editRow(row, key, value);
    }
    if (skipped > 0) getPlatform().toast('info', `${skipped} pasted ${skipped === 1 ? 'value' : 'values'} could not be used`);
  }

  // ---- columns ----
  const onResize = useCallback(
    (key: string, width: number | null, commit: boolean) => {
      if (!commit) {
        if (width !== null) setLiveWidths((w) => ({ ...w, [key]: width }));
        return;
      }
      const cfg = readTableConfig(L.current.view.config);
      const widths = { ...(cfg.widths ?? {}) };
      if (width === null) delete widths[key];
      else widths[key] = Math.min(800, Math.max(60, Math.round(width)));
      setLiveWidths({});
      L.current.actions.updateConfig(tableConfigPatch({ ...cfg, widths }));
    },
    [],
  );

  const onMoveColumn = useCallback((key: string, target: string, side: 'before' | 'after') => {
    const { schema: s, view: v, actions: a } = L.current;
    a.updateConfig({ columns: reorderedColumnConfig(orderedColumns(s, v.config), key, target, side) });
  }, []);

  // ---- header: sort, hide, custom columns ----
  const onSortDir = useCallback((key: string, dir: 'asc' | 'desc') => {
    const q = L.current.view.config.query;
    L.current.actions.updateConfig({ query: { ...q, sort: [{ column: key, dir }] } });
  }, []);

  /** Click on a header: ascending, then descending, then no sort. */
  const onSort = useCallback((key: string) => {
    const q = L.current.view.config.query;
    const current = q.sort?.length === 1 && q.sort[0]!.column === key ? q.sort[0]!.dir : null;
    const { sort: _old, ...rest } = q;
    const next =
      current === null
        ? { ...rest, sort: [{ column: key, dir: 'asc' as const }] }
        : current === 'asc'
          ? { ...rest, sort: [{ column: key, dir: 'desc' as const }] }
          : rest;
    L.current.actions.updateConfig({ query: next });
  }, []);

  const onHide = useCallback((key: string) => {
    const { schema: s, view: v, actions: a } = L.current;
    const entries = orderedColumns(s, v.config).map((c) => ({
      key: c.column.key,
      ...(c.width !== undefined ? { width: c.width } : {}),
      ...(c.hidden || c.column.key === key ? { hidden: true } : {}),
    }));
    a.updateConfig({ columns: entries });
  }, []);

  /** Run a column API call, tell the user when the server says no, and reload the schema (our own change sends no event back). */
  async function columnCall(call: () => Promise<unknown>): Promise<void> {
    try {
      await call();
    } catch (e) {
      getPlatform().toast('error', e instanceof Error ? e.message : 'Could not change the column');
      throw e;
    }
    refreshTable(L.current.schema.ref);
  }

  async function submitColumn(form: { mode: ColumnFormMode; column?: Column }, v: ColumnFormValue): Promise<void> {
    const ref = schema.ref;
    const selectLike = v.type === 'select' || v.type === 'multiselect';
    if (form.mode === 'add') {
      const body = { name: v.name, type: v.type, ...(selectLike ? { options: v.options.map((label) => ({ label })) } : {}) };
      await columnCall(() => tablesApi.createColumn(ref, body as never));
    } else if (form.mode === 'rename' && form.column) {
      await columnCall(() => tablesApi.updateColumn(ref, form.column!.key, { name: v.name }));
    } else if (form.column) {
      // Options keep their value id when the label is unchanged
      const old = form.column.options ?? [];
      const options = v.options.map((label) => {
        const same = old.find((o) => o.label === label);
        return same ? { label, value: same.value } : { label };
      });
      const body = { type: v.type, ...(selectLike ? { options } : {}) };
      await columnCall(() => tablesApi.updateColumn(ref, form.column!.key, body as never));
    }
  }

  async function deleteColumn(column: Column) {
    const ok = await getPlatform().confirm(`Delete the column "${column.name}"? Its values are removed from every task.`, {
      danger: true,
      confirmLabel: 'Delete',
    });
    if (ok) await columnCall(() => tablesApi.deleteColumn(schema.ref, column.key)).catch(() => {});
  }

  // ---- drag to reorder rows ----
  const reorderable = !sorted && canCreate && rowsInOrder.length > 1;

  function onDragStart(e: DragEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    const handle = target.closest?.('[data-drag-handle]');
    const rowEl = handle?.closest<HTMLElement>('[data-row-id]');
    const id = rowEl?.dataset.rowId;
    if (!handle || !rowEl || id === undefined) return;
    dragIds.current = sel.ids.has(id) ? order.filter((x) => sel.ids.has(x)) : [id];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(ROW_MIME, id);
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.setDragImage(rowEl, 16, 12);
  }

  function dropPlan(e: DragEvent<HTMLElement>) {
    const ids = dragIds.current;
    const rowEl = (e.target as HTMLElement).closest?.<HTMLElement>('[data-row-id]');
    const id = rowEl?.dataset.rowId;
    if (!ids || !rowEl || id === undefined) return null;
    const rect = rowEl.getBoundingClientRect();
    const side: 'before' | 'after' = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    const plan = reorderPlan(rowsInOrder, ids, id, side);
    return plan ? { id, side, plan } : null;
  }

  function onBodyDragOver(e: DragEvent<HTMLDivElement>) {
    if (!dragIds.current) return;
    const hit = dropPlan(e);
    if (!hit) {
      if (drop) setDrop(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (drop?.id !== hit.id || drop.side !== hit.side) setDrop({ id: hit.id, side: hit.side });
  }

  function onScrollerDragOver(e: DragEvent<HTMLDivElement>) {
    // Scroll while a row is dragged near the top or bottom edge
    const el = scroller.current;
    if (!dragIds.current || !el) return;
    const rect = el.getBoundingClientRect();
    if (e.clientY < rect.top + HEADER_HEIGHT + 24) el.scrollTop -= 24;
    else if (e.clientY > rect.bottom - FOOTER_HEIGHT - 24) el.scrollTop += 24;
  }

  function onBodyDrop(e: DragEvent<HTMLDivElement>) {
    const hit = dropPlan(e);
    dragIds.current = null;
    setDrop(null);
    if (!hit) return;
    e.preventDefault();
    actions.reorder(hit.plan.ids, hit.plan.before).catch(() => {});
  }

  function onDragEnd() {
    dragIds.current = null;
    setDrop(null);
  }

  // ---- render ----
  const style = { '--cl-table-cols': gridTemplate(cols), '--cl-table-width': `${gridWidth(cols)}px`, '--cl-table-row-h': `${ROW_HEIGHT}px` } as CSSProperties;
  const allIds = order;
  const filtered = !!query.filter || !!query.search;
  const clearFilters = () => {
    const { filter: _f, search: _s, ...rest } = query;
    actions.updateConfig({ query: rest });
  };
  const allSelected = allIds.length > 0 && allIds.every((id) => sel.ids.has(id));
  const summaries = query.summaries ?? {};

  function renderItem(item: GridItem, index: number) {
    switch (item.kind) {
      case 'row':
        return (
          <DataRow
            key={item.id}
            row={item.row}
            depth={item.depth}
            caret={item.caret}
            loadingKids={item.loading}
            cols={cols}
            selected={sel.ids.has(item.id)}
            reorderable={reorderable}
            dropSide={drop?.id === item.id ? drop.side : null}
            canAddChild={nested && canCreate}
            index={index + 2}
            onSelect={onSelectRow}
            onToggle={toggleExpand}
            onEdit={editRow}
            onOpen={onOpen}
            onAddChild={onAddChild}
          />
        );
      case 'group':
        return (
          <div key={item.id} role="row" className={cx('cl-table__group', item.collapsed && 'is-collapsed')} data-testid="table-group" data-group={item.groupId}>
            <button
              type="button"
              className="cl-table__grouphead"
              data-testid="table-group-toggle"
              aria-expanded={!item.collapsed}
              onClick={() =>
                setCollapsed((s) => {
                  const next = new Set(s);
                  if (next.has(item.groupId)) next.delete(item.groupId);
                  else next.add(item.groupId);
                  return next;
                })
              }
            >
              <span className="cl-table__groupcaret">{item.collapsed ? '▸' : '▾'}</span>
              {item.color && <span className="cl-table__groupdot" style={{ background: item.color }} />}
              <span className="cl-table__grouplabel">{item.label}</span>
              <span className="cl-table__groupcount" data-testid="table-group-count">
                {item.count}
              </span>
            </button>
            {cols.slice(1).map((c) => (
              <div key={c.column.key} className="cl-table__summary" data-col={c.column.key}>
                {formatSummary(summaries[c.column.key], item.summaries?.[c.column.key])}
              </div>
            ))}
          </div>
        );
      case 'addChild':
        return (
          <AddRow
            key={item.id}
            testId="table-add-child"
            placeholder="Add subtask..."
            indent={item.depth * 20}
            autoFocus={addFocus === item.parentId}
            onFocused={() => setAddFocus(null)}
            onSubmit={(name) => createChild(item.parentId, item.tableRef, name)}
          />
        );
      case 'quickAdd':
        return (
          <AddRow
            key={item.id}
            testId="table-quick-add"
            placeholder="Add new row..."
            {...(isAll ? { projects, project: projectId, onProject: setProject } : {})}
            onSubmit={createTop}
          />
        );
    }
  }

  return (
    <div
      className="cl-table"
      data-testid="table-layout"
      style={style}
      aria-busy={loading || undefined}
      onKeyDownCapture={onKeyDownCapture}
      onCopy={onCopy}
      onPaste={onPaste}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      {sel.ids.size > 0 && (
        <BulkBar
          count={sel.ids.size}
          columns={bulkColumns}
          canDelete={canDeleteRows}
          {...(sel.ids.size === 1 && nested && actions.moveRow ? { onMove: () => setMoving(selectedRows()[0] ?? null) } : {})}
          onAll={() => setSel(selectAll(order))}
          onClear={() => setSel(EMPTY_SELECTION)}
          onDelete={() => void deleteSelected()}
          onApply={applyBulk}
        />
      )}
      <div
        ref={scroller}
        className="cl-table__scroll"
        data-testid="table-scroll"
        role="grid"
        aria-rowcount={items.length + 1}
        aria-colcount={cols.length + 1}
        aria-multiselectable="true"
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onDragOver={onScrollerDragOver}
      >
        <Header
          cols={cols}
          sort={query.sort}
          allSelected={allSelected}
          someSelected={sel.ids.size > 0}
          onSelectAll={(checked) => setSel(checked ? selectAll(order) : EMPTY_SELECTION)}
          onResize={onResize}
          onMoveColumn={onMoveColumn}
          onSort={onSort}
          onSortDir={onSortDir}
          onHide={onHide}
          canEditSchema={schema.capabilities.editSchema}
          onAddColumn={() => setColForm({ mode: 'add' })}
          onRenameColumn={(column) => setColForm({ mode: 'rename', column })}
          onChangeColumnType={(column) => setColForm({ mode: 'type', column })}
          onDeleteColumn={(column) => void deleteColumn(column)}
        />
        <div className="cl-table__body" style={{ height: win.total }} onDragOver={onBodyDragOver} onDrop={onBodyDrop}>
          <div className="cl-table__window" style={{ transform: `translateY(${win.offset}px)` }}>
            {items.slice(win.start, win.end).map((item, i) => renderItem(item, win.start + i))}
          </div>
        </div>
        {!loading && result.rows.length === 0 && filtered && (
          <div className="cl-table__empty" data-testid="table-empty-filtered">
            <span>{view.tableRef.startsWith('tasks:') ? 'No tasks match the filters' : 'No rows match the filters'}</span>
            <button type="button" className="cl-btn cl-btn--secondary cl-btn--sm" data-testid="table-clear-filters" onClick={clearFilters}>
              Clear filters
            </button>
          </div>
        )}
        <div className="cl-table__footer" role="row" data-testid="table-footer">
          <div className="cl-table__lead" />
          {cols.map((c) => (
            <div key={c.column.key} className="cl-table__summary" data-col={c.column.key} data-testid="table-summary">
              {formatSummary(summaries[c.column.key], result.summaries?.[c.column.key])}
            </div>
          ))}
        </div>
      </div>
      {colForm && (
        <ColumnForm
          mode={colForm.mode}
          {...(colForm.column ? { column: colForm.column } : {})}
          onSubmit={(v) => submitColumn(colForm, v)}
          onClose={() => setColForm(null)}
        />
      )}
      {moving && actions.moveRow && (
        <MoveUnder
          row={moving}
          candidates={[...rowsInOrder, ...[...children.values()].flat()]}
          titleKey={schema.titleColumn}
          onMove={async (parentId) => {
            await actions.moveRow!(moving.id, parentId);
            setSel(EMPTY_SELECTION);
            const touched = [...(moving.parentId ? [moving.parentId] : []), ...(parentId ? [parentId] : [])];
            refreshChildren(touched.filter((p) => L.current.expanded.has(p)));
          }}
          onClose={() => setMoving(null)}
        />
      )}
      <div className="cl-table__status">
        <span data-testid="table-count">
          {result.total} {result.total === 1 ? 'row' : 'rows'}
        </span>
        {loading && <span>Loading...</span>}
        {!loading && result.rows.length === 0 && !filtered && <span data-testid="table-empty">No rows.</span>}
        <span className="cl-table__spacer" />
        {schema.capabilities.hierarchy && (
          <label className="cl-table__nest">
            <input
              type="checkbox"
              data-testid="table-nest"
              checked={nested}
              onChange={(e) => {
                const next = { ...query };
                if (e.target.checked) next.parentId = null;
                else delete next.parentId;
                setExpanded(EMPTY_SET);
                actions.updateConfig({ query: next });
              }}
            />
            Nest subtasks
          </label>
        )}
      </div>
    </div>
  );
}
