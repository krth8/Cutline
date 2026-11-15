import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { SpaceKey } from '../../api/pageTree';
import { navigate } from '../../router';
import type { SidebarSectionProps } from '../../shell/registry';
import { Button, cx, Menu, type MenuItem } from '../../ui';
import { setHomePage, useHomePageId } from '../home/homeStore';
import { ArchivedDialog } from './ArchivedList';
import { MoveDialog } from './MoveDialog';
import {
  canEditSpace,
  createAndOpen,
  activePageId,
  openPage,
  pageRoute,
  spaceKeyOf,
  usePageStore,
} from './space';
import { getPageStore } from './pageStore';
import {
  ancestorsOf,
  canDrop,
  planDrop,
  planMoveToTop,
  visibleRows,
  type DropPosition,
  type VisibleRow,
} from './treeModel';
import { useExpanded } from './useExpanded';
import './tree.css';

/** The page being dragged and the space it comes from, so another space's tree can accept the drop. */
let dragging: { space: SpaceKey; id: string } | null = null;

/** A small house: marks the page Home shows. */
function HomeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2 7.5 8 2.5l6 5M3.5 6.5V13.5h9V6.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function DocIcon() {
  return (
    <svg className="cl-tree__doc" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/** The icon of a project's Tasks page: a checked box. */
export function TasksIcon() {
  return (
    <svg className="cl-tree__doc cl-tree__tasks" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" data-testid="tasks-icon">
      <rect x="2" y="2" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path d="M5 8.2l2.1 2.1L11 6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Where in a row the pointer is: top quarter = before, bottom quarter = after, else inside. */
export function dropPositionAt(clientY: number, rect: { top: number; height: number }): DropPosition {
  const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  if (ratio < 0.25) return 'before';
  if (ratio > 0.75) return 'after';
  return 'inside';
}

function RenameInput({ initial, onCommit, onCancel }: { initial: string; onCommit: (title: string) => void; onCancel: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false); // commit/cancel happen once; blur after Enter or Escape must not repeat them
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(ref.current?.value ?? initial);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      className="cl-tree__rename"
      aria-label="Page title"
      defaultValue={initial}
      maxLength={300}
      draggable={false}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

/** The page tree of one space, shown in the sidebar under the space's entry. */
export function PageTree({ space, route }: SidebarSectionProps) {
  const key: SpaceKey = spaceKeyOf(space);
  const { store, snap } = usePageStore(key);
  const expanded = useExpanded(key);
  const canEdit = canEditSpace(key);
  const activeId = activePageId(key, route);
  const { model } = snap;
  const homeId = useHomePageId();

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string } | null>(null);
  const [drop, setDrop] = useState<{ id: string; position: DropPosition } | null>(null);
  const [tailActive, setTailActive] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [moving, setMoving] = useState<{ from: SpaceKey; id: string; destination?: SpaceKey } | null>(null);
  const [moveTarget, setMoveTarget] = useState(false);
  const dragId = useRef<string | null>(null);
  const menuAnchor = useRef<HTMLElement | null>(null);
  const rowEls = useRef(new Map<string, HTMLElement>());

  const rows = useMemo(() => visibleRows(model, expanded.ids), [model, expanded.ids]);

  // The open page's ancestors are expanded (once per page and parent, so collapsing one by hand sticks)
  const expandedFor = useRef('');
  useEffect(() => {
    if (!activeId || snap.status !== 'ready') return;
    const node = model.byId.get(activeId);
    if (!node) return;
    const signature = `${activeId}:${node.page.parentId}`;
    if (expandedFor.current === signature) return;
    expandedFor.current = signature;
    expanded.open(ancestorsOf(model, activeId).map((p) => p.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, model, snap.status]);

  const tabbableId = rows.some((r) => r.node.page.id === focusId)
    ? focusId
    : rows.some((r) => r.node.page.id === activeId)
      ? activeId
      : (rows[0]?.node.page.id ?? null);

  function focusRow(id: string) {
    setFocusId(id);
    rowEls.current.get(id)?.focus();
  }

  function onRowKeyDown(e: KeyboardEvent<HTMLElement>, row: VisibleRow, index: number) {
    if (e.target !== e.currentTarget) return; // keys inside the rename field or a button are theirs
    const { node } = row;
    const id = node.page.id;
    const isOpen = expanded.ids.has(id);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (rows[index + 1]) focusRow(rows[index + 1]!.node.page.id);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (rows[index - 1]) focusRow(rows[index - 1]!.node.page.id);
        break;
      case 'Home':
        e.preventDefault();
        focusRow(rows[0]!.node.page.id);
        break;
      case 'End':
        e.preventDefault();
        focusRow(rows[rows.length - 1]!.node.page.id);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (node.children.length && !isOpen) expanded.set(id, true);
        else if (node.children.length) focusRow(node.children[0]!.page.id);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (node.children.length && isOpen) expanded.set(id, false);
        else if (node.page.parentId && model.byId.has(node.page.parentId)) focusRow(node.page.parentId);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        openPage(key, id);
        break;
      case 'F2':
        if (canEdit) {
          e.preventDefault();
          setRenamingId(id);
        }
        break;
    }
  }

  async function addSubpage(parentId: string | null) {
    if (parentId) expanded.set(parentId, true);
    await createAndOpen(key, parentId);
  }

  function openMenu(id: string, anchor: HTMLElement) {
    menuAnchor.current = anchor;
    setMenu({ id });
  }

  function menuItems(id: string): MenuItem[] {
    const node = model.byId.get(id);
    if (!node) return [];
    const items: MenuItem[] = [
      { id: 'rename', label: 'Rename', onSelect: () => setTimeout(() => setRenamingId(id), 0) },
      { id: 'add', label: 'Add subpage', onSelect: () => void addSubpage(id) },
    ];
    // The Tasks page stays where it is: no move, no archive
    if (node.page.system) return items;
    if (node.page.parentId && model.byId.has(node.page.parentId)) {
      items.push({
        id: 'top',
        label: 'Move to top level',
        onSelect: () => {
          const plan = planMoveToTop(model, id);
          if (plan) void store.move(id, plan.parentId, plan.sortOrder);
        },
      });
    }
    items.push({ id: 'move', label: 'Move to...', onSelect: () => setMoving({ from: key, id }) });
    // Any personal page can be Home
    if (key === 'me' && id !== homeId) items.push({ id: 'set-home', label: 'Set as home', onSelect: () => void setHomePage(id) });
    items.push({ type: 'separator' }, { id: 'archive', label: 'Archive', danger: true, onSelect: () => void store.archive(id) });
    return items;
  }

  // ---- drag and drop ----

  function onDragStart(e: DragEvent<HTMLElement>, id: string) {
    dragId.current = id;
    dragging = { space: key, id };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }

  function onDragOver(e: DragEvent<HTMLElement>, id: string) {
    const dragged = dragId.current;
    if (!dragged || !canDrop(model, dragged, id)) {
      if (drop) setDrop(null);
      return; // no preventDefault: the pointer shows "not allowed"
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const position = dropPositionAt(e.clientY, e.currentTarget.getBoundingClientRect());
    if (drop?.id !== id || drop.position !== position) setDrop({ id, position });
  }

  function onDrop(e: DragEvent<HTMLElement>, id: string) {
    const dragged = dragId.current;
    e.preventDefault();
    const position = dropPositionAt(e.clientY, e.currentTarget.getBoundingClientRect());
    endDrag();
    if (!dragged) return;
    const plan = planDrop(model, dragged, id, position, expanded.ids);
    if (!plan) return;
    if (plan.parentId) expanded.set(plan.parentId, true);
    void store.move(dragged, plan.parentId, plan.sortOrder);
  }

  function endDrag() {
    dragId.current = null;
    dragging = null;
    setDrop(null);
    setTailActive(false);
  }

  function onTailDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    const dragged = dragId.current;
    endDrag();
    if (!dragged) return;
    const plan = planMoveToTop(model, dragged);
    if (plan) void store.move(dragged, plan.parentId, plan.sortOrder);
  }

  // ---- rendering ----

  function renderRow(row: VisibleRow, index: number) {
    const { node, depth } = row;
    const page = node.page;
    const id = page.id;
    const title = page.title || 'Untitled';
    const hasChildren = node.children.length > 0;
    const isOpen = expanded.ids.has(id);
    const renaming = renamingId === id;
    const dropHere = drop?.id === id ? drop.position : null;
    return (
      <div
        key={id}
        ref={(el) => {
          if (el) rowEls.current.set(id, el);
          else rowEls.current.delete(id);
        }}
        role="treeitem"
        aria-label={title}
        aria-level={depth + 1}
        aria-expanded={hasChildren ? isOpen : undefined}
        aria-selected={id === activeId}
        data-page-id={id}
        tabIndex={id === tabbableId ? 0 : -1}
        draggable={canEdit && !renaming && !page.system}
        className={cx(
          'cl-tree__row',
          id === activeId && 'is-active',
          dropHere && `is-drop-${dropHere}`,
          menu?.id === id && 'is-menu-open',
        )}
        style={{ paddingLeft: 4 + depth * 14 }}
        onClick={() => {
          setFocusId(id);
          if (!renaming) openPage(key, id);
        }}
        onDoubleClick={() => canEdit && setRenamingId(id)}
        onKeyDown={(e) => onRowKeyDown(e, row, index)}
        onFocus={(e) => e.target === e.currentTarget && setFocusId(id)}
        onContextMenu={(e: MouseEvent<HTMLElement>) => {
          if (!canEdit) return;
          e.preventDefault();
          openMenu(id, e.currentTarget);
        }}
        onDragStart={(e) => onDragStart(e, id)}
        onDragOver={(e) => onDragOver(e, id)}
        onDrop={(e) => onDrop(e, id)}
        onDragEnd={endDrag}
      >
        {hasChildren ? (
          <button
            type="button"
            tabIndex={-1}
            className={cx('cl-tree__chevron', isOpen && 'is-open')}
            aria-label={isOpen ? `Collapse ${title}` : `Expand ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              expanded.toggle(id);
            }}
          >
            &#9656;
          </button>
        ) : (
          <span className="cl-tree__chevron-spacer" aria-hidden="true" />
        )}
        <span className="cl-tree__icon" aria-hidden="true">
          {page.icon ?? (page.system ? <TasksIcon /> : <DocIcon />)}
        </span>
        {renaming ? (
          <RenameInput
            initial={page.title}
            onCommit={(value) => {
              setRenamingId(null);
              rowEls.current.get(id)?.focus();
              if (value.trim() && value.trim() !== page.title) void store.rename(id, value);
            }}
            onCancel={() => {
              setRenamingId(null);
              rowEls.current.get(id)?.focus();
            }}
          />
        ) : (
          <span className="cl-tree__title">{title}</span>
        )}
        {key === 'me' && id === homeId && !renaming ? (
          <span className="cl-tree__home" role="img" aria-label="Home page" title="Your Home page">
            <HomeIcon />
          </span>
        ) : null}
        {canEdit && !renaming ? (
          <span className="cl-tree__actions">
            <button
              type="button"
              tabIndex={-1}
              className="cl-tree__action"
              aria-label={`Add subpage to ${title}`}
              title="Add subpage"
              onClick={(e) => {
                e.stopPropagation();
                void addSubpage(id);
              }}
            >
              +
            </button>
            <button
              type="button"
              tabIndex={-1}
              className="cl-tree__action"
              aria-label={`Actions for ${title}`}
              aria-haspopup="menu"
              title="More"
              onClick={(e) => {
                e.stopPropagation();
                openMenu(id, e.currentTarget);
              }}
            >
              &hellip;
            </button>
          </span>
        ) : null}
      </div>
    );
  }

  let body;
  if (snap.status === 'error' && rows.length === 0) {
    body = (
      <div className="cl-tree__note" role="status">
        Could not load pages.{' '}
        <button type="button" className="cl-tree__link" onClick={() => void store.refresh()}>
          Retry
        </button>
      </div>
    );
  } else if (snap.status !== 'ready' && rows.length === 0) {
    body = (
      <div className="cl-tree__skeleton" aria-hidden="true" data-testid="tree-skeleton">
        <span />
        <span />
        <span />
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <div className="cl-tree__empty">
        <div className="cl-tree__note">No pages yet.</div>
        {canEdit ? (
          <Button size="sm" onClick={() => void addSubpage(null)}>
            New page
          </Button>
        ) : null}
      </div>
    );
  } else {
    body = (
      <>
        <div
          className="cl-tree__rows"
          role="tree"
          aria-label="Pages"
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
          }}
        >
          {rows.map(renderRow)}
          {canEdit ? (
            <div
              className={cx('cl-tree__tail', tailActive && 'is-drop-active')}
              data-testid="tree-tail"
              onDragOver={(e) => {
                if (!dragId.current) return;
                e.preventDefault();
                if (!tailActive) setTailActive(true);
                if (drop) setDrop(null);
              }}
              onDragLeave={() => setTailActive(false)}
              onDrop={onTailDrop}
            />
          ) : null}
        </div>
        {canEdit ? (
          <button type="button" className="cl-tree__new" onClick={() => void addSubpage(null)}>
            <span aria-hidden="true">+</span> New page
          </button>
        ) : null}
      </>
    );
  }

  return (
    <div
      className={cx('cl-tree', moveTarget && 'is-move-target')}
      data-space={key}
      onDragOver={(e) => {
        // A page from another space's tree: dropping asks to move it here
        if (!canEdit || !dragging || dragging.space === key) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!moveTarget) setMoveTarget(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMoveTarget(false);
      }}
      onDrop={(e) => {
        setMoveTarget(false);
        if (!canEdit || !dragging || dragging.space === key) return;
        e.preventDefault();
        setMoving({ from: dragging.space, id: dragging.id, destination: key });
        dragging = null;
      }}
    >
      {body}
      <button type="button" className="cl-tree__archived" onClick={() => setArchivedOpen(true)}>
        Archived
      </button>
      <ArchivedDialog space={key} open={archivedOpen} onClose={() => setArchivedOpen(false)} />
      {moving ? (
        <MoveDialog
          open
          onClose={() => setMoving(null)}
          from={moving.from}
          pageId={moving.id}
          title={getPageStore(moving.from).snapshot().model.byId.get(moving.id)?.page.title ?? ''}
          {...(moving.destination ? { initialDestination: moving.destination } : {})}
          onMoved={(_info, destination, movedIds) => {
            // The open page went along: follow it to its new place
            const open = activePageId(moving.from, route);
            if (open && movedIds.includes(open)) navigate(pageRoute(destination, open));
          }}
        />
      ) : null}
      <Menu
        open={menu !== null}
        onOpenChange={(open) => !open && setMenu(null)}
        anchorRef={menuAnchor}
        items={menu ? menuItems(menu.id) : []}
        placement="bottom-start"
        aria-label="Page actions"
      />
    </div>
  );
}
