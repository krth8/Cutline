/**
 * Route view for `projectPages` (`/p/<id>/pages`): the project's front page. Every project has a dashboard
 * page (`system: 'dashboard'`), an ordinary page built from blocks that people can rearrange; it is shown
 * here like any page. A project without one (the list is still loading, or it could not be made) falls back
 * to the cards of its pages.
 */
import type { Route } from '../../router';
import { PageView } from '../PageView';
import { SpaceOverview } from './SpaceOverview';
import { usePageStore } from './space';

export const DASHBOARD = 'dashboard';

export function ProjectHome({ route }: { route: Extract<Route, { kind: 'projectPages' }> }) {
  const { snap } = usePageStore(`p:${route.projectId}`);
  let dashboard: string | null = null;
  for (const node of snap.model.byId.values()) {
    if (node.page.system === DASHBOARD) dashboard = node.page.id;
  }
  if (dashboard) {
    const { kind: _kind, ...rest } = route;
    return <PageView key={dashboard} route={{ ...rest, kind: 'projectPage', pageId: dashboard }} />;
  }
  if (snap.status !== 'ready' && snap.status !== 'error') {
    return (
      <div className="cl-page__skeleton" data-testid="project-home-loading" aria-busy="true" aria-label="Loading the project">
        <span className="cl-page__skeleton-title" />
        <span />
        <span className="cl-page__skeleton-short" />
      </div>
    );
  }
  return <SpaceOverview route={route} />;
}
