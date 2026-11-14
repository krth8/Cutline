/**
 * Routes of the app (PLAN.md 5.3): parse a URL into a typed Route and build it back.
 *
 * The URL is the source of truth. The legacy page decides which top tab is
 * shown from the same routes (static/js/features/routes.js); this module only
 * covers what the bundle needs: the shell, the page views and links.
 */
import { useMemo, useSyncExternalStore } from 'react';
import { getPlatform, NAVIGATE_EVENT } from './platform';

/** Optional on every route: the task panel opens over the current route. */
interface WithTask {
  task?: string;
}

export type Route =
  | ({ kind: 'home' } & WithTask)
  | ({ kind: 'me' } & WithTask)
  | ({ kind: 'mePage'; pageId: string } & WithTask)
  | ({ kind: 'projectPages'; projectId: string } & WithTask)
  | ({ kind: 'projectPage'; projectId: string; pageId: string } & WithTask)
  | ({ kind: 'review'; projectId: string; clip?: string; v?: string; session?: string } & WithTask)
  /** A path that is none of the above (e.g. /dev/ui). Carries the original path + query. */
  | { kind: 'notFound'; path: string };

export type RouteKind = Route['kind'];

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null; // malformed %-escape
  }
}

/** Parse "/p/abc/pages?task=t1" (or a full URL) into a Route. Unknown paths give `notFound`. */
export function parseRoute(url: string): Route {
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://cutline.invalid');
  } catch {
    return { kind: 'notFound', path: url };
  }
  const notFound: Route = { kind: 'notFound', path: parsed.pathname + parsed.search };
  // "/a/b/" and "/a/b" are the same route; "/" gives no segments
  const decoded = parsed.pathname
    .split('/')
    .filter((s) => s !== '')
    .map(decode);
  if (decoded.some((s) => s === null)) return notFound;
  const seg = decoded as string[];

  const q = parsed.searchParams;
  const task = q.get('task') || undefined;
  const withTask = <T extends object>(route: T): T & WithTask => (task ? { ...route, task } : route);

  if (seg.length === 0) return withTask({ kind: 'home' as const });
  if (seg[0] === 'me') {
    if (seg.length === 1) return withTask({ kind: 'me' as const });
    if (seg.length === 3 && seg[1] === 'page') return withTask({ kind: 'mePage' as const, pageId: seg[2]! });
    return notFound;
  }
  if (seg[0] === 'p' && seg.length >= 3) {
    const projectId = seg[1]!;
    if (seg.length === 3 && seg[2] === 'pages') return withTask({ kind: 'projectPages' as const, projectId });
    if (seg.length === 4 && seg[2] === 'page') {
      return withTask({ kind: 'projectPage' as const, projectId, pageId: seg[3]! });
    }
    if (seg.length === 3 && seg[2] === 'review') {
      const route: Route = { kind: 'review', projectId };
      for (const key of ['clip', 'v', 'session'] as const) {
        const value = q.get(key);
        if (value) route[key] = value;
      }
      return withTask(route);
    }
  }
  return notFound;
}

const enc = encodeURIComponent;

/** The URL (path + query) of a route. `parseRoute(buildRoute(r))` gives `r` back. */
export function buildRoute(route: Route): string {
  if (route.kind === 'notFound') return route.path;
  let path: string;
  const query = new URLSearchParams();
  switch (route.kind) {
    case 'home':
      path = '/';
      break;
    case 'me':
      path = '/me';
      break;
    case 'mePage':
      path = `/me/page/${enc(route.pageId)}`;
      break;
    case 'projectPages':
      path = `/p/${enc(route.projectId)}/pages`;
      break;
    case 'projectPage':
      path = `/p/${enc(route.projectId)}/page/${enc(route.pageId)}`;
      break;
    case 'review':
      path = `/p/${enc(route.projectId)}/review`;
      if (route.clip) query.set('clip', route.clip);
      if (route.v) query.set('v', route.v);
      if (route.session) query.set('session', route.session);
      break;
  }
  if (route.task) query.set('task', route.task);
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

/** The project a route belongs to, or null for home / personal space. */
export function routeProjectId(route: Route): string | null {
  switch (route.kind) {
    case 'projectPages':
    case 'projectPage':
    case 'review':
      return route.projectId;
    default:
      return null;
  }
}

/** Go to a route (pushState through the platform, so history and listeners stay consistent). */
export function navigate(route: Route): void {
  getPlatform().navigate(buildRoute(route));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener('popstate', listener);
  window.addEventListener(NAVIGATE_EVENT, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(NAVIGATE_EVENT, listener);
  };
}

const currentUrl = () => window.location.pathname + window.location.search;

/** The current route; re-renders on pushState navigation and back/forward. */
export function useRoute(): Route {
  const url = useSyncExternalStore(subscribe, currentUrl, currentUrl);
  return useMemo(() => parseRoute(url), [url]);
}
