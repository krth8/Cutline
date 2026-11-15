/**
 * The content of the page list block: the pages the reader can read, most recently changed first, as links.
 * Main bundle. Refreshes when a page changes (live `page_changed`) and after a reconnect.
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { getPlatform } from '../../../../platform';
import { buildRoute, navigate, type Route } from '../../../../router';
import { LIMIT_CHOICES, recentPath, type PageListAttrs, type PageListScope } from './model';

interface RecentPage {
  id: string;
  title: string;
  icon: string | null;
  /** 'me' or 'p:<projectId>' */
  space: string;
  updatedAt: string | null;
  projectName: string | null;
}

export interface PageListContentProps {
  attrs: PageListAttrs;
  editable: boolean;
  setAttrs(patch: Partial<PageListAttrs>): void;
}

function routeOf(page: RecentPage): Route {
  return page.space === 'me'
    ? { kind: 'mePage', pageId: page.id }
    : { kind: 'projectPage', projectId: page.space.slice(2), pageId: page.id };
}

function ago(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days} d ago` : new Date(then).toLocaleDateString();
}

function Row({ page }: { page: RecentPage }) {
  const route = routeOf(page);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(route);
  };
  return (
    <li>
      <a className="cl-pagelist__item" href={buildRoute(route)} onClick={onClick}>
        <span className="cl-pagelist__icon" aria-hidden="true">
          {page.icon ?? '\u{1F4C4}'}
        </span>
        <span className="cl-pagelist__title">{page.title || 'Untitled'}</span>
        <span className="cl-pagelist__meta">
          {page.projectName ?? 'Personal'}
          {page.updatedAt ? ` · ${ago(page.updatedAt)}` : ''}
        </span>
      </a>
    </li>
  );
}

export function PageListContent({ attrs, editable, setAttrs }: PageListContentProps) {
  const [pages, setPages] = useState<RecentPage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const path = recentPath(attrs);
  const current = useRef(path);
  current.current = path;

  const load = useCallback(async () => {
    const asked = current.current;
    try {
      const res = await getPlatform().fetch(asked);
      if (current.current !== asked) return; // the attributes changed meanwhile
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPages(((await res.json()) as { pages: RecentPage[] }).pages);
      setFailed(false);
    } catch {
      if (current.current === asked) setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [path, load]);

  // Live: any page change, and a reconnect (events may have been missed)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 250);
    };
    const platform = getPlatform();
    const offs = [platform.live.on('page_changed', later), platform.live.on('resync', later)];
    return () => {
      if (timer) clearTimeout(timer);
      offs.forEach((off) => off());
    };
  }, [load]);

  const oneProject = attrs.scope.startsWith('p:');
  return (
    <div className="cl-pagelist" data-testid="page-list">
      {editable ? (
        <div className="cl-pagelist__settings">
          <select
            aria-label="Which pages"
            value={attrs.scope}
            onChange={(e) => setAttrs({ scope: e.target.value as PageListScope })}
          >
            <option value="all">All pages I can read</option>
            <option value="me">My personal space</option>
            {oneProject ? <option value={attrs.scope}>One project</option> : null}
          </select>
          <select aria-label="How many" value={attrs.limit} onChange={(e) => setAttrs({ limit: Number(e.target.value) })}>
            {[...new Set([...LIMIT_CHOICES, attrs.limit])]
              .sort((a, b) => a - b)
              .map((n) => (
                <option key={n} value={n}>
                  {n} pages
                </option>
              ))}
          </select>
        </div>
      ) : null}
      {pages === null ? (
        <div className="cl-pagelist__state" role="status">
          {failed ? 'Not available' : 'Loading...'}
        </div>
      ) : pages.length === 0 ? (
        <div className="cl-pagelist__state">No pages yet</div>
      ) : (
        <ul className="cl-pagelist__list" aria-label="Recently changed pages">
          {pages.map((p) => (
            <Row key={p.id} page={p} />
          ))}
        </ul>
      )}
    </div>
  );
}
