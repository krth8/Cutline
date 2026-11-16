/**
 * Tells the server where this tab is, for the people panel of the Lounge tab ("Review: shot_010",
 * "Creative brief"). Sent again whenever the route or the open page's title changes.
 */
import { useEffect } from 'react';
import { getPlatform } from '../platform';
import { routeProjectId, type Route } from '../router';
import { usePageStore } from '../pages/tree/space';

/** The words for a place in a project; `pageTitle` is the title of the open page, when there is one. */
export function placeLabel(route: Route, pageTitle: string | null): string | null {
  switch (route.kind) {
    case 'review':
      return route.clip ? `Review: ${route.clip}` : 'Review';
    case 'lounge':
      return 'Lounge';
    case 'projectPages':
      return 'Dashboard';
    case 'projectTasks':
    case 'projectView':
      return 'Tasks';
    case 'projectPage':
      return pageTitle || 'A page';
    default:
      return null;
  }
}

export function usePlace(route: Route): void {
  const projectId = routeProjectId(route);
  const { snap } = usePageStore(projectId ? `p:${projectId}` : 'me');
  const pageId = route.kind === 'projectPage' ? route.pageId : null;
  const title = pageId ? (snap.model.byId.get(pageId)?.page.title ?? null) : null;
  const label = projectId ? placeLabel(route, title) : null;
  useEffect(() => {
    getPlatform().live.setPlace?.(projectId ? { projectId, label } : null);
  }, [projectId, label]);
}
