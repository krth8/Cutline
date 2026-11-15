/**
 * The page view: breadcrumbs, icon, large title, page menu and the body slot.
 *
 * The body (the collaborative editor) is plugged in with `registerPageBody`, so this
 * view does not depend on it. States: loading, ready, archived, not available.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { getPage, PageApiError, type PageInfo, type SpaceKey } from '../api/pageTree';
import { getPlatform } from '../platform';
import { Backlinks } from './backlinks';
import { setHomePage, useHomePageId } from './home/homeStore';
import { buildRoute, navigate, type Route } from '../router';
import { Button, cx, Menu, Popover, type MenuItem } from '../ui';
import {
  consumeTitleFocus,
  createAndOpen,
  overviewRoute,
  pageRoute,
  spaceName,
  usePageStore,
} from './tree/space';
import { ancestorsOf } from './tree/treeModel';
import { MoveDialog } from './tree/MoveDialog';
import { HistoryDialog } from './history';
import './PageView.css';

// ---- the body slot ----

export interface PageBodyProps {
  pageId: string;
  editable: boolean;
}

let pageBody: ComponentType<PageBodyProps> | null = null;
const bodyListeners = new Set<() => void>();

/** Plug in the component that renders a page's content (replaces an earlier one). Returns an unregister function. */
export function registerPageBody(component: ComponentType<PageBodyProps>): () => void {
  pageBody = component;
  bodyListeners.forEach((fn) => fn());
  return () => {
    if (pageBody === component) {
      pageBody = null;
      bodyListeners.forEach((fn) => fn());
    }
  };
}

function usePageBody(): ComponentType<PageBodyProps> | null {
  return useSyncExternalStore(
    (fn) => {
      bodyListeners.add(fn);
      return () => {
        bodyListeners.delete(fn);
      };
    },
    () => pageBody,
    () => pageBody,
  );
}

// ---- icons ----

export const PAGE_ICONS = [
  '\u{1F4C4}', '\u{1F4DD}', '\u{1F4CB}', '\u{1F4CC}', '\u{1F4DA}', '\u{1F4D6}', '\u{1F5C2}\u{FE0F}', '\u{1F4C5}',
  '\u{1F3AC}', '\u{1F3A5}', '\u{1F39E}\u{FE0F}', '\u{1F3A8}', '\u{1F3AF}', '\u{1F680}', '\u{1F4A1}', '\u{1F527}',
  '\u{2705}', '\u{2B50}', '\u{1F525}', '\u{26A1}', '\u{1F4E6}', '\u{1F4AC}', '\u{1F4E3}', '\u{1F514}',
  '\u{1F465}', '\u{1F9E0}', '\u{1F50D}', '\u{1F512}', '\u{1F3E0}', '\u{1F30D}', '\u{1F4C8}', '\u{1F4B0}',
  '\u{1F3B5}', '\u{1F4F7}', '\u{1F4BB}', '\u{1F9EA}', '\u{1F331}', '\u{2764}\u{FE0F}', '\u{1F389}', '\u{26A0}\u{FE0F}',
];

// ---- small pieces ----

function CrumbLink({ to, children }: { to: Route; children: ReactNode }) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={buildRoute(to)} onClick={onClick} className="cl-crumbs__link">
      {children}
    </a>
  );
}

function IconPicker({ icon, editable, onPick }: { icon: string | null; editable: boolean; onPick: (icon: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  if (!editable) {
    return icon ? (
      <span className="cl-page__icon" aria-hidden="true">
        {icon}
      </span>
    ) : null;
  }
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={cx('cl-page__icon', 'cl-page__icon-button', !icon && 'is-empty')}
        aria-label={icon ? 'Change icon' : 'Add icon'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {icon ?? <span className="cl-page__icon-add">Add icon</span>}
      </button>
      <Popover open={open} onOpenChange={setOpen} anchorRef={anchor} aria-label="Choose an icon" className="cl-iconpicker">
        <div className="cl-iconpicker__grid">
          {PAGE_ICONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className={cx('cl-iconpicker__item', emoji === icon && 'is-selected')}
              aria-label={`Icon ${emoji}`}
              onClick={() => {
                setOpen(false);
                onPick(emoji);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
        {icon ? (
          <button
            type="button"
            className="cl-iconpicker__remove"
            onClick={() => {
              setOpen(false);
              onPick(null);
            }}
          >
            Remove icon
          </button>
        ) : null}
      </Popover>
    </>
  );
}

const TITLE_DEBOUNCE_MS = 600;

function TitleField({
  value,
  editable,
  autoFocus,
  onCommit,
  onEnter,
}: {
  value: string;
  editable: boolean;
  autoFocus: boolean;
  onCommit: (title: string) => void;
  onEnter: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shown = draft ?? value;
  const committed = useRef(value);
  committed.current = value;

  useEffect(() => {
    if (!autoFocus) return;
    ref.current?.focus();
    ref.current?.select();
  }, [autoFocus]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [shown]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const flush = useCallback(
    (text: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (text.trim() !== committed.current.trim()) onCommit(text);
    },
    [onCommit],
  );

  if (!editable) return <h1 className="cl-page__title">{value || 'Untitled'}</h1>;
  return (
    <textarea
      ref={ref}
      className="cl-page__title cl-page__title-field"
      aria-label="Page title"
      placeholder="Untitled"
      rows={1}
      maxLength={300}
      value={shown}
      onChange={(e) => {
        const text = e.target.value.replace(/\n/g, ' ');
        setDraft(text);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => flush(text), TITLE_DEBOUNCE_MS);
      }}
      onBlur={(e) => {
        flush(e.target.value);
        setDraft(null);
      }}
      onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          flush(e.currentTarget.value);
          onEnter();
        }
      }}
    />
  );
}

// ---- the view ----

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; page: PageInfo }
  | { status: 'unavailable' }
  | { status: 'error' };

export type PageViewRoute = Extract<Route, { kind: 'mePage' | 'projectPage' }>;

function Skeleton() {
  return (
    <div className="cl-page__skeleton" data-testid="page-skeleton" aria-busy="true" aria-label="Loading page">
      <span className="cl-page__skeleton-title" />
      <span />
      <span />
      <span className="cl-page__skeleton-short" />
    </div>
  );
}

function PageViewInner({ space, pageId }: { space: SpaceKey; pageId: string }) {
  const platform = getPlatform();
  const { store, snap } = usePageStore(space);
  const Body = usePageBody();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [focusTitle] = useState(() => consumeTitleFocus(pageId));
  const homeId = useHomePageId();

  const load = useCallback(async () => {
    try {
      const page = await getPage(pageId);
      setState(page.space === space ? { status: 'ready', page } : { status: 'unavailable' });
    } catch (e) {
      if (e instanceof PageApiError && (e.status === 404 || e.status === 403)) setState({ status: 'unavailable' });
      else setState((s) => (s.status === 'ready' ? s : { status: 'error' }));
    }
  }, [pageId, space]);

  useEffect(() => {
    void load();
  }, [load]);

  // Changes by others: reload this page when it was touched (debounced), and after a reconnect
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 150);
    };
    const offs = [
      platform.live.on('page_changed', (msg) => {
        const touched = msg.pageId === pageId || (Array.isArray(msg.pageIds) && msg.pageIds.includes(pageId));
        if (!touched) return;
        if (msg.change === 'deleted') {
          if (timer) clearTimeout(timer);
          setState({ status: 'unavailable' });
        } else later();
      }),
      platform.live.on('resync', later),
    ];
    return () => {
      if (timer) clearTimeout(timer);
      offs.forEach((off) => off());
    };
  }, [platform, pageId, load]);

  const page = state.status === 'ready' ? state.page : null;
  const node = snap.model.byId.get(pageId)?.page;
  const title = node?.title ?? page?.title ?? '';
  const icon = node ? node.icon : (page?.icon ?? null);

  // The browser tab follows the page title
  useEffect(() => {
    const previous = document.title;
    if (page) document.title = `${title || 'Untitled'} - Cutline`;
    else if (state.status === 'unavailable') document.title = 'Page not available - Cutline';
    return () => {
      document.title = previous;
    };
  }, [page !== null, state.status, title]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.status === 'loading') return <Skeleton />;
  if (state.status === 'error') {
    return (
      <div className="cl-page__state" role="alert">
        <h1 className="cl-page__state-title">Could not load this page</h1>
        <Button onClick={() => void load()}>Try again</Button>
      </div>
    );
  }
  if (!page) {
    return (
      <div className="cl-page__state" role="alert">
        <h1 className="cl-page__state-title">This page is not available</h1>
        <p className="cl-page__state-detail">It may have been deleted, or you may not have access to it.</p>
        <CrumbLink to={overviewRoute(space)}>Back to {spaceName(space)}</CrumbLink>
      </div>
    );
  }

  const archived = page.archived;
  const editable = page.canEdit && !archived;
  const ancestors = archived ? [] : ancestorsOf(snap.model, pageId);

  const rename = (text: string) => {
    setState((s) => (s.status === 'ready' ? { status: 'ready', page: { ...s.page, title: text.trim() || 'Untitled' } } : s));
    void store.rename(pageId, text).then((ok) => {
      if (!ok) void load();
    });
  };

  const items: MenuItem[] = [];
  if (editable) {
    items.push({ id: 'add', label: 'Add subpage', onSelect: () => void createAndOpen(space, pageId) });
    // The Tasks page of a project cannot be moved or archived
    if (!page.system) {
      items.push({ id: 'move', label: 'Move to...', onSelect: () => setMoveOpen(true) });
      items.push({
        id: 'archive',
        label: 'Archive',
        danger: true,
        onSelect: () => {
          void store.archive(pageId).then(() => load());
        },
      });
    }
    items.push({ type: 'separator' });
  }
  // Any live personal page can be Home (the server refuses everything else)
  if (space === 'me' && page.canEdit && !archived && homeId !== pageId) {
    items.push({ id: 'set-home', label: 'Set as home', onSelect: () => void setHomePage(pageId) });
  }
  items.push({ id: 'history', label: 'History', onSelect: () => setHistoryOpen(true) });
  items.push({
    id: 'copy',
    label: 'Copy link',
    onSelect: () => {
      const url = `${window.location.origin}${buildRoute(pageRoute(space, pageId))}`;
      const clipboard = navigator.clipboard;
      if (!clipboard) {
        platform.toast('error', 'Could not copy the link');
        return;
      }
      clipboard.writeText(url).then(
        () => platform.toast('success', 'Link copied'),
        () => platform.toast('error', 'Could not copy the link'),
      );
    },
  });

  const focusBody = () => {
    const root = bodyRef.current;
    if (!root) return;
    const target = root.querySelector<HTMLElement>('[contenteditable="true"], textarea, input') ?? root;
    target.focus();
  };

  return (
    <article className="cl-page" data-testid="page-view" data-page-id={pageId}>
      <div className="cl-page__bar">
        <nav className="cl-crumbs" aria-label="Breadcrumb">
          <ol>
            <li>
              <CrumbLink to={overviewRoute(space)}>{spaceName(space)}</CrumbLink>
            </li>
            {ancestors.map((a) => (
              <li key={a.id}>
                <CrumbLink to={pageRoute(space, a.id)}>
                  {a.icon ? <span aria-hidden="true">{a.icon} </span> : null}
                  {a.title || 'Untitled'}
                </CrumbLink>
              </li>
            ))}
            <li aria-current="page" className="cl-crumbs__current">
              {title || 'Untitled'}
            </li>
          </ol>
        </nav>
        <Button
          ref={menuAnchor}
          variant="ghost"
          size="sm"
          aria-label="Page menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          &hellip;
        </Button>
        <Menu open={menuOpen} onOpenChange={setMenuOpen} anchorRef={menuAnchor} items={items} placement="bottom-end" aria-label="Page menu" />
        {historyOpen ? <HistoryDialog open pageId={pageId} canEdit={editable} onClose={() => setHistoryOpen(false)} /> : null}
        {moveOpen ? (
          <MoveDialog
            open
            onClose={() => setMoveOpen(false)}
            from={space}
            pageId={pageId}
            title={title}
            onMoved={(_info, destination) => navigate(pageRoute(destination, pageId))}
          />
        ) : null}
      </div>

      {archived ? (
        <div className="cl-page__banner" role="status">
          <span>This page is archived.</span>
          {page.canEdit ? (
            <span className="cl-page__banner-actions">
              <Button
                size="sm"
                onClick={() => {
                  void store.restore(pageId).then(() => load());
                }}
              >
                Restore
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  void store.deleteForever(pageId, title).then((deleted) => {
                    if (deleted) navigate(overviewRoute(space));
                  });
                }}
              >
                Delete forever
              </Button>
            </span>
          ) : null}
        </div>
      ) : null}

      <header className="cl-page__header">
        <IconPicker icon={icon} editable={editable} onPick={(next) => void store.setIcon(pageId, next).then((ok) => {
          if (!ok) void load();
        })} />
        <TitleField value={title} editable={editable} autoFocus={focusTitle} onCommit={rename} onEnter={focusBody} />
      </header>

      <div className="cl-page__body" ref={bodyRef} tabIndex={-1}>
        {Body ? <Body pageId={pageId} editable={editable} /> : <div className="cl-page__placeholder">The editor is not loaded</div>}
      </div>
      {archived ? null : <Backlinks kind="page" id={pageId} />}
    </article>
  );
}

/** Route view for `mePage` and `projectPage`. */
export function PageView({ route }: { route: PageViewRoute }) {
  const space: SpaceKey = route.kind === 'mePage' ? 'me' : `p:${route.projectId}`;
  return <PageViewInner key={`${space}/${route.pageId}`} space={space} pageId={route.pageId} />;
}
